/**
 * Host plugin of dsh-reasoning-dial for DeepSeek Harness.
 *
 * Problem it solves
 * ----------------
 * DSH ships an Off/Low/Medium/High/XHigh/Max reasoning dial, but it is only
 * offered for models whose catalog entry declares \`reasoningEfforts\`. Custom
 * API providers you add under \`llm-pi-ai\` usually ship with the field absent,
 * so the picker silently offers nothing and the dial cannot be set.
 *
 * Where the catalog actually lives
 * --------------------------------
 * A provider can be declared in EITHER of two places, and both feed the same
 * resolved view the picker reads:
 *
 *   1. the profile's cordis.patch.yml (\`- id: llm-pi-ai\` -> config.providers)
 *   2. the settings service (namespace id \`llm-pi-ai\`)
 *
 * 0.1.x read only (2). 0.2.x read (2) as a document and (1) as YAML. 0.3.0
 * reads (2) through whatever accessor the host actually exposes and treats (1)
 * as a fallback only — see "Host compatibility" below.
 *
 * Host compatibility (this is what broke 0.2.1)
 * ---------------------------------------------
 * \`dsh-settings\` used to expose \`get()/read()\` plus \`mutate()/update()\`. The
 * current host exposes \`describe()\` (an array of \`{ ns, revision, value, user,
 * base, applies }\`) plus \`mutate()/update()/replace()\`, and no document
 * accessor at all. A 0.2.x install therefore decided the settings service was
 * absent, could never write, and every custom provider (a third-party Step /
 * OpenCode / gateway key, for example) stayed without a dial. 0.3.0 feature-
 * detects both shapes, reports which one it found, and refuses to guess.
 *
 * What this plugin does
 * ---------------------
 * It treats the reasoning dial as plain settings data instead of a built-in
 * capability:
 *
 *   - discovers every provider/model from the effective settings value + patch
 *   - writes \`reasoningEfforts\` onto any model entry you name
 *   - writes \`agent-default-model.reasoningEffort\` to pick the active level
 *   - optionally probes the model live to see whether the level is honoured
 *   - reports, per model, where the host's knowledge came from (catalog vs
 *     declaration) and which levels the picker will actually render
 *
 * Wire semantics that are easy to get wrong
 * -----------------------------------------
 * \`reasoningEfforts\` maps a level to the exact spelling your provider expects.
 * Three host rules matter and are enforced here before a write:
 *
 *   - a non-\`off\` level needs a non-empty wire string; \`null\` means "the model
 *     does not offer this level" and an empty string is invalid
 *   - \`off: null\` is the correct "Off means send nothing" declaration; writing
 *     \`off: "off"\` would put \`reasoning_effort: "off"\` on the wire
 *   - \`xhigh\`/\`max\` are only offered when they are named explicitly; every
 *     other level is offered unless it is pinned to \`null\`
 *
 * It never writes outside the configured settings namespaces and never touches
 * credentials.
 */
import z from '@deepseek-ai/schemastery'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

/** Cordis plugin name; equals the entry id in cordis.patch.yml. */
export const name = 'reasoning-dial'
/** The dial needs the LLM service (routes) and the settings service (writes). */
export const inject = ['tools', 'llm', 'settings']

/** Every level the host picker understands, in escalation order. */
const ALL_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
/** What a fresh declaration starts from: the OpenAI-style ladder. */
const DEFAULT_LADDER = ['off', 'low', 'medium', 'high']
/** Settings namespace / patch entry that owns custom-API providers. */
const DEFAULT_NAMESPACE = 'llm-pi-ai'
/** Settings entry that carries the session default route. */
const DEFAULT_MODEL_ENTRY = 'agent-default-model'

export const Config = z.object({
  namespaces: z.string().default(DEFAULT_NAMESPACE).description('逗号分隔的设置命名空间列表，自定义 API provider 就住在这些命名空间里（默认 llm-pi-ai）。要同时管多个就写 "llm-pi-ai, llm-my-gateway"。'),
  levels: z.string().default(DEFAULT_LADDER.join(',')).description('默认提供哪些档位，逗号分隔，按升级顺序排列。可用值：off / minimal / low / medium / high / xhigh / max。至少要有 off 之外的一档，否则官方校验会拒收。xhigh / max 只有明确写出来才会出现在选择器里。'),
  wireMode: z.string().default('identity').description('档位到线上字段值的映射方式：identity = 直接送档位名本身（OpenAI 风格，最常用）；lower = 转小写。off 永远写成 null（= 不发送任何字段），要送具体值请用 reasoning_declare 的 wire.off 覆盖。'),
  autoDeclare: z.boolean().default(false).description('启动时自动给所有还没声明 reasoningEfforts 的自定义模型补上默认档位。关着更安全：默认只在你要的时候写。'),
  allowProbe: z.boolean().default(true).description('允许 reasoning_probe 真的向模型发一条最小请求来验证档位是否生效。关掉后该工具只做静态检查、不发任何网络请求。'),
  agentTools: z.boolean().default(true).description('向 Agent 注册 reasoning_* 工具。'),
  readProfileConfig: z.boolean().default(true).description('当 settings 服务读不到 provider 时，退回读取本 profile 的 cordis.patch.yml 里同名 entry 的 config.providers。settings 可用时以 settings 的生效值为准，避免读到旧 YAML。'),
}).description('推理等级万能拨盘')

// ---------------------------------------------------------------------------
// Small helpers. Everything here is pure or settings-only; no network.
// ---------------------------------------------------------------------------

const text = value => (typeof value === 'string' && value.trim() ? value.trim() : null)

function splitList(value, fallback) {
  const items = String(value ?? '')
    .split(/[,，\s]+/)
    .map(item => item.trim())
    .filter(Boolean)
  const kept = items.filter(item => ALL_LEVELS.includes(item))
  return kept.length ? [...new Set(kept)] : fallback
}

/** Levels in escalation order, regardless of how the caller listed them. */
function sortLevels(levels) {
  return ALL_LEVELS.filter(level => levels.includes(level))
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function messageOf(error) {
  return String(error?.message ?? error).slice(0, 240)
}

/**
 * Drop keys whose value is `undefined`. Tool results are transported as JSON,
 * and an undefined member makes the transport reject the whole payload instead
 * of omitting a field.
 */
function compact(value) {
  if (Array.isArray(value)) return value.map(compact)
  if (!isPlainObject(value)) return value
  const out = {}
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined) continue
    out[key] = compact(item)
  }
  return out
}

/**
 * Resolve a settings document out of the legacy accessor shapes. The host used
 * to hand back the section directly, or a `{ value, revision }` envelope, or a
 * `{ user, revision }` pair. All three stay accepted so an older host build
 * keeps working through the same code path.
 */
function unwrapSettings(payload) {
  if (!isPlainObject(payload)) return { root: null, revision: null }
  const revision = payload.revision ?? payload.value?.revision ?? null
  const root = payload.user ?? payload.value ?? payload
  return { root: isPlainObject(root) ? root : null, revision }
}

/** Coerce a stored `models` value into editable entries. */
function modelsArrayOf(value) {
  if (!Array.isArray(value)) return []
  return value
    .filter(item => isPlainObject(item) && typeof item.id === 'string' && item.id.length > 0)
    .map(item => ({ ...item }))
}

/** How one entry's reasoning disposition currently reads. */
function effortsModeOf(entry) {
  const efforts = entry?.reasoningEfforts
  if (efforts === undefined) return 'inherit'
  if (efforts === false) return 'none'
  if (isPlainObject(efforts)) return 'levels'
  return 'inherit'
}

/**
 * Normalised level -> wire value list, escalation order. `wire` is a string
 * when the host sends a value and `null` when the level is pinned unsupported
 * (only legal for `off`, where it means "send nothing at all").
 */
function declaredLevelsOf(entry) {
  if (effortsModeOf(entry) !== 'levels') return []
  const efforts = entry.reasoningEfforts
  const out = []
  for (const level of ALL_LEVELS) {
    if (!Object.prototype.hasOwnProperty.call(efforts, level)) continue
    const wire = efforts[level]
    out.push({ level, wire: typeof wire === 'string' ? wire : null })
  }
  return out
}

/**
 * The levels the picker will render for one entry, mirroring pi-ai's
 * `getSupportedThinkingLevels`: a level whose wire is `null` is withheld,
 * `xhigh`/`max` only appear when named, every other level is offered by
 * default. `hostEfforts` is what the host reports today, used for the
 * undeclared (catalog) case.
 */
function supportedEfforts(entry, hostEfforts = []) {
  const mode = effortsModeOf(entry)
  if (mode === 'none') return ['off']
  if (mode !== 'levels') return [...hostEfforts]
  const efforts = entry.reasoningEfforts
  return ALL_LEVELS.filter(level => {
    if (!Object.prototype.hasOwnProperty.call(efforts, level)) return false
    const wire = efforts[level]
    // `off: null` is the one declaration that stays offered: the adapter drops
    // the key, which pi-ai reads as "supported, send nothing". Every other
    // unlisted level is pinned to null and disappears from the picker.
    if (level === 'off') return wire === null || typeof wire === 'string'
    return typeof wire === 'string' && wire.length > 0
  })
}

/**
 * The rules the pi-ai adapter enforces on apply, reported before a write so
 * we never persist something the host would refuse: a levels dict must declare
 * at least one level beyond `off`, every non-off level needs a non-empty wire
 * value, and `off` may only be `null` (send nothing) or a non-empty string.
 */
function validateEntry(entry) {
  if (effortsModeOf(entry) !== 'levels') return null
  const declared = declaredLevelsOf(entry)
  let hasBeyondOff = false
  for (const { level, wire } of declared) {
    if (level === 'off') {
      if (wire === '') return { kind: 'effortsWireMissing', level }
      continue
    }
    hasBeyondOff = true
    if (wire === null || wire === '') return { kind: 'effortsWireMissing', level }
  }
  if (!hasBeyondOff) return { kind: 'effortsOffOnly' }
  return null
}

/**
 * Immutable draft update: set the reasoning disposition of one entry.
 *
 * `overrides` is the per-level wire override map, applied after the ladder:
 * a string replaces the wire value, `null` drops the level (unsupported), and
 * an empty string is ignored so a blank form field never becomes invalid data.
 */
function withEfforts(entry, mode, levels, wireMode, overrides = {}) {
  if (mode === 'inherit') {
    const { reasoningEfforts: _dropped, ...rest } = entry
    return rest
  }
  if (mode === 'none') return { ...entry, reasoningEfforts: false }
  const spelling = level => (wireMode === 'lower' ? String(level).toLowerCase() : String(level))
  const efforts = {}
  for (const level of sortLevels(levels)) {
    // `off: null` is the host's "supported, send nothing" spelling.
    efforts[level] = level === 'off' ? null : spelling(level)
  }
  for (const [level, value] of Object.entries(overrides)) {
    if (!ALL_LEVELS.includes(level)) continue
    if (value === null) {
      if (level === 'off') efforts.off = null
      else delete efforts[level]
      continue
    }
    if (typeof value !== 'string' || value.length === 0) continue
    efforts[level] = value
  }
  return { ...entry, reasoningEfforts: efforts }
}

/** The YAML a user can paste into the profile patch when writing is impossible. */
function patchSnippet(provider, model, entry) {
  const lines = [
    '# profile cordis.patch.yml -> - id: ' + DEFAULT_NAMESPACE + ' -> config.providers.' + provider + '.models',
    '# model: ' + model,
  ]
  const efforts = entry?.reasoningEfforts
  if (efforts === false) lines.push('reasoningEfforts: false')
  else if (isPlainObject(efforts)) {
    lines.push('reasoningEfforts:')
    for (const level of ALL_LEVELS) {
      if (!Object.prototype.hasOwnProperty.call(efforts, level)) continue
      const wire = efforts[level]
      lines.push('  ' + level + ': ' + (wire === null ? 'null' : JSON.stringify(String(wire))))
    }
  }
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Profile config layer (fallback)
//
// A provider declared in the profile's cordis.patch.yml is not necessarily in
// the settings document, so the patch stays a discovery source. The settings
// service is authoritative when it answers, because its `value` is already the
// effective configuration (base + profile patch); the patch parse exists for
// hosts whose settings surface is missing, and is cached only until we write.
// ---------------------------------------------------------------------------

/**
 * `<profile>/node_modules/<pkg>/.dsh-plugin/index.mjs` -> `<profile>`
 *
 * Tail layout:  ... <profile> / node_modules / <pkg> / .dsh-plugin / index.mjs
 * `.dsh-plugin` sits three entries above the profile, so the profile is the
 * slice ending two before it.
 */
function profileDirOf() {
  try {
    const here = fileURLToPath(import.meta.url)          // .../.dsh-plugin/index.mjs
    const parts = here.split(/[\\/]+/)
    const at = parts.lastIndexOf('.dsh-plugin')
    if (at < 4) return null
    return parts.slice(0, at - 2).join('\\')
  } catch { return null }
}

/** `{ <providerName>: section }` from every matching patch entry. */
function providersFromPatch(doc) {
  const out = {}
  for (const entry of Array.isArray(doc) ? doc : []) {
    if (!isPlainObject(entry) || entry.id !== DEFAULT_NAMESPACE) continue
    const providers = entry?.config?.providers
    if (isPlainObject(providers)) Object.assign(out, providers)
  }
  return out
}

/** Profile patch layer, plus why it is empty when it is. */
let patchCache = null

/** Drop the cached patch parse: called after every successful write. */
function invalidatePatch() {
  patchCache = null
}

async function profileProviders() {
  if (patchCache !== null) return patchCache
  patchCache = { providers: {}, reason: 'not-attempted' }
  try {
    const dir = profileDirOf()
    if (!dir) { patchCache.reason = 'profile-dir-unresolved'; return patchCache }
    const file = dir + '\\cordis.patch.yml'
    let raw
    try { raw = await readFile(file, 'utf8') } catch {
      patchCache.reason = 'no patch file at ' + file
      return patchCache
    }
    try {
      const YAML = await import('yaml')
      patchCache.providers = providersFromPatch(YAML.parse(raw))
      patchCache.reason = 'ok'
    } catch (error) {
      // Reported, never guessed: a half-parsed patch would be worse than none.
      patchCache.reason = 'yaml-unavailable: ' + messageOf(error).slice(0, 120)
    }
  } catch (error) {
    patchCache.reason = 'error: ' + messageOf(error).slice(0, 120)
  }
  return patchCache
}

// ---------------------------------------------------------------------------
// Settings access (0.3.0)
//
// Two host generations exist:
//
//   legacy : get(ns) / read(ns)                      + mutate/update
//   current: describe() -> [{ ns, revision, value, user, base, applies }]
//                                                     + mutate/update/replace
//
// Everything below feature-detects instead of assuming, and reports the shape
// it found so a future host change surfaces as a diagnostic rather than as a
// silent "no dial".
// ---------------------------------------------------------------------------

function settingsAccess(ctx) {
  const service = ctx?.settings
  const has = method => typeof service?.[method] === 'function'
  return {
    service: Boolean(service),
    describe: has('describe'),
    document: has('get') || has('read'),
    mutate: has('mutate'),
    update: has('update'),
    replace: has('replace'),
  }
}

function settingsService(ctx) {
  const access = settingsAccess(ctx)
  const readable = access.describe || access.document
  const writable = access.mutate || access.update
  return access.service && readable && writable ? ctx.settings : null
}

/**
 * One namespace's current state. `value` is the effective configuration the
 * host resolved (base + profile patch) and `user` is only what the profile
 * patch says — the same split `settings.describe()` publishes.
 */
async function readNamespace(ctx, ns) {
  const access = settingsAccess(ctx)
  const service = ctx?.settings
  const blank = {
    ns, available: false, via: 'none', value: null, user: null,
    revision: null, applies: null, missing: false, error: null,
  }
  if (!service || (!access.describe && !access.document)) {
    return { ...blank, error: '宿主没有可读的 settings 服务' }
  }
  if (access.describe) {
    try {
      const rows = await service.describe()
      const row = Array.isArray(rows) ? rows.find(item => item && item.ns === ns) : null
      if (row) {
        return {
          ns,
          available: true,
          via: 'describe',
          value: isPlainObject(row.value) ? row.value : null,
          user: isPlainObject(row.user) ? row.user : null,
          revision: row.revision ?? null,
          applies: typeof row.applies === 'string' ? row.applies : null,
          missing: false,
          error: null,
        }
      }
      return {
        ...blank,
        available: true,
        via: 'describe',
        missing: true,
        error: 'profile 里没有 id 为「' + ns + '」的插件条目（settings.describe() 没列出它）',
      }
    } catch (error) {
      blank.describeError = messageOf(error)
    }
  }
  for (const method of ['get', 'read']) {
    if (typeof service[method] !== 'function') continue
    try {
      const payload = await service[method](ns)
      const { root, revision } = unwrapSettings(payload)
      if (root) {
        return {
          ns, available: true, via: method, value: root, user: root,
          revision, applies: null, missing: false, error: null,
        }
      }
    } catch { /* try the next accessor */ }
  }
  return { ...blank, available: true, error: blank.describeError ?? '命名空间没有可读值' }
}

/** Whether an error is the host's optimistic-concurrency refusal. */
function isConflict(error) {
  const code = error?.code ?? error?.name
  if (code === 'SETTINGS_CONFLICT' || code === 'SettingsConflictError') return true
  return /changed since it was read|SETTINGS_CONFLICT/i.test(String(error?.message ?? ''))
}

/**
 * Run a settings write, re-reading the revision and retrying exactly once when
 * the host reports a conflict. A second conflict is a real race with another
 * editor and is reported instead of looped on.
 */
async function writeWithRevision(ctx, ns, attempt) {
  const first = (await readNamespace(ctx, ns)).revision
  try {
    return await attempt(first)
  } catch (error) {
    if (!isConflict(error)) throw error
    const retryRevision = (await readNamespace(ctx, ns)).revision
    return await attempt(retryRevision)
  }
}

/** Rewrite one provider's whole `models` array with a patched entry. */
async function writeModels(ctx, ns, providerName, entries) {
  const service = settingsService(ctx)
  if (!service) throw new Error('宿主没有暴露可读写的 settings 服务（describe/get + mutate/update 都不存在）')
  const path = ['providers', providerName, 'models']
  const written = await writeWithRevision(ctx, ns, revision => {
    if (typeof service.mutate === 'function') {
      return service.mutate(ns, [{ op: 'set', path, value: entries }], revision)
    }
    return service.update(ns, { providers: { [providerName]: { models: entries } } }, revision)
  })
  invalidatePatch()
  return written
}

/** Apply ordered form edits to the default-model entry. */
async function writeSelection(ctx, ops, patch) {
  const service = settingsService(ctx)
  if (!service) throw new Error('宿主没有暴露可读写的 settings 服务（describe/get + mutate/update 都不存在）')
  const written = await writeWithRevision(ctx, DEFAULT_MODEL_ENTRY, revision => {
    if (typeof service.mutate === 'function') return service.mutate(DEFAULT_MODEL_ENTRY, ops, revision)
    return service.update(DEFAULT_MODEL_ENTRY, patch, revision)
  })
  invalidatePatch()
  return written
}

function namespacesOf(config) {
  return splitList(config?.namespaces, [DEFAULT_NAMESPACE])
}

function levelsOf(config) {
  return sortLevels(splitList(config?.levels, DEFAULT_LADDER))
}

function wireModeOf(config) {
  return text(config?.wireMode) === 'lower' ? 'lower' : 'identity'
}

// ---------------------------------------------------------------------------
// Route discovery through the official LLM service (read-only).
// ---------------------------------------------------------------------------

/** Exact provider/model routes the host publishes, with reasoning metadata. */
async function discoverRoutes(ctx) {
  if (typeof ctx?.llm?.listProviders !== 'function') return { available: false, routes: [] }
  let providers
  try { providers = ctx.llm.listProviders() } catch { return { available: false, routes: [] } }
  const routes = []
  for (const entry of Array.isArray(providers) ? providers : []) {
    const provider = text(typeof entry === 'string' ? entry : entry?.id)
    if (!provider) continue
    let models
    try { models = await ctx.llm.listModels(provider) } catch { continue }
    for (const listed of Array.isArray(models) ? models : []) {
      const model = text(listed?.id ?? listed?.model)
      if (!model) continue
      let resolved = listed
      try { resolved = await ctx.llm.resolveModelInfo(provider, model) } catch { /* keep the listing */ }
      const reasoning = resolved?.reasoning
      const efforts = Array.isArray(reasoning?.efforts)
        ? reasoning.efforts.map(item => text(item?.id ?? item)).filter(Boolean)
        : []
      routes.push({
        provider,
        model,
        name: text(resolved?.name ?? listed?.name) || model,
        inputModalities: Array.isArray(resolved?.inputModalities) ? resolved.inputModalities : [],
        reasoningKnown: reasoning !== undefined && reasoning !== null,
        reasoningEfforts: [...new Set(efforts)],
        ...(text(reasoning?.defaultEffort) ? { defaultReasoningEffort: text(reasoning.defaultEffort) } : {}),
      })
    }
  }
  return { available: true, routes }
}

/** One host route's reasoning state, or null when the route is unknown. */
async function routeOf(ctx, provider, model) {
  if (typeof ctx?.llm?.resolveModelInfo !== 'function') return null
  try {
    const resolved = await ctx.llm.resolveModelInfo(provider, model)
    if (!resolved) return null
    const efforts = Array.isArray(resolved.reasoning?.efforts)
      ? resolved.reasoning.efforts.map(item => text(item?.id ?? item)).filter(Boolean)
      : []
    return { efforts: [...new Set(efforts)], known: resolved.reasoning !== undefined && resolved.reasoning !== null }
  } catch { return null }
}

// ---------------------------------------------------------------------------
// Agent tools
// ---------------------------------------------------------------------------

const JSON_OUTPUT = {
  schema: { type: 'object', additionalProperties: true },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 1) }],
}

function buildTools({ ctx, config }) {
  const levels = () => levelsOf(config)
  const wireMode = () => wireModeOf(config)

  /**
   * Merged provider view for one namespace. The settings value is the host's
   * effective configuration and wins; the profile patch only fills in when the
   * settings service cannot answer (or is disabled by configuration).
   */
  async function mergedProviders(entryId) {
    const namespace = await readNamespace(ctx, entryId)
    const fromValue = isPlainObject(namespace.value?.providers) ? namespace.value.providers : {}
    const fromUser = isPlainObject(namespace.user?.providers) ? namespace.user.providers : {}
    const patch = config?.readProfileConfig === false
      ? { providers: {}, reason: 'disabled' }
      : await profileProviders()
    const merged = { ...patch.providers, ...fromValue }
    return {
      providers: merged,
      namespace,
      settingsProviders: Object.keys(fromValue).length,
      userProviders: Object.keys(fromUser).length,
      patchProviders: Object.keys(patch.providers).length,
      patchReason: patch.reason,
    }
  }

  /** Every model in every configured namespace, merged with host route info. */
  async function collect() {
    const { available, routes } = await discoverRoutes(ctx)
    const routeKey = route => route.provider + '/' + route.model
    const byKey = new Map(routes.map(route => [routeKey(route), route]))
    const out = []
    const layers = []
    for (const entryId of namespacesOf(config)) {
      const {
        providers, namespace, settingsProviders, userProviders, patchProviders, patchReason,
      } = await mergedProviders(entryId)
      layers.push({
        namespace: entryId,
        settingsVia: namespace.via,
        settingsRevision: namespace.revision,
        settingsApplies: namespace.applies,
        settingsProviders,
        userProviders,
        patchProviders,
        patchReason,
        mergedProviders: Object.keys(providers).length,
        ...(namespace.error ? { settingsError: namespace.error } : {}),
      })
      for (const [providerName, section] of Object.entries(providers)) {
        const route = section && typeof section === 'object' ? section : {}
        const entries = modelsArrayOf(route.models)
        const seen = new Set()
        const push = (model, entry) => {
          const host = byKey.get(providerName + '/' + model)
          const mode = entry ? effortsModeOf(entry) : 'absent'
          const declared = entry ? declaredLevelsOf(entry) : []
          out.push({
            namespace: entryId,
            provider: providerName,
            api: text(route.api),
            apiKeyEnv: text(route.apiKeyEnv),
            model,
            name: text(entry?.name) || host?.name || model,
            routeKnown: Boolean(host),
            mode,
            source: mode === 'levels' ? 'declared' : (host?.reasoningKnown ? 'catalog' : 'none'),
            declared,
            issue: entry ? validateEntry(entry) : null,
            hostReasoningKnown: host?.reasoningKnown ?? false,
            hostEfforts: host?.reasoningEfforts ?? [],
            dialEfforts: supportedEfforts(entry, host?.reasoningEfforts ?? []),
          })
        }
        for (const entry of entries) {
          seen.add(entry.id)
          push(entry.id, entry)
        }
        // Routes the host knows but the namespace does not list.
        for (const [key, host] of byKey) {
          if (!key.startsWith(providerName + '/')) continue
          if (seen.has(host.model)) continue
          push(host.model, null)
        }
      }
    }
    return { routesAvailable: available, layers, models: out, namespaces: namespacesOf(config) }
  }

  /** Rewrite one provider's models array with a patched entry. */
  async function patchEntry(entryId, providerName, patch) {
    const { providers } = await mergedProviders(entryId)
    const section = providers[providerName]
    if (!isPlainObject(section)) {
      throw new Error('命名空间 ' + entryId + ' 下没有 provider「' + providerName + '」（已合并 settings 与 profile patch 两个来源）')
    }
    const entries = modelsArrayOf(section.models)
    const index = entries.findIndex(entry => entry.id === patch.model)
    if (index < 0) throw new Error('provider「' + providerName + '」下没有模型「' + patch.model + '」')
    entries[index] = patch.entry
    const issue = validateEntry(entries[index])
    if (issue) throw new Error('修改后的声明不合法：' + JSON.stringify(issue))
    const written = await writeModels(ctx, entryId, providerName, entries)
    return { ok: true, revision: written?.revision ?? null, entry: entries[index] }
  }

  /** Resolve the target list of a declare call: one `model` or a `models` batch. */
  function targetsOf(args) {
    const many = Array.isArray(args?.models)
      ? args.models.map(item => text(item)).filter(Boolean)
      : []
    const one = text(args?.model)
    if (many.length) return [...new Set([...many, ...(one ? [one] : [])])]
    return one ? [one] : []
  }

  /** One declaration: read, patch, validate, write, then read back and verify. */
  async function declareOne({ entryId, provider, model, mode, levels: chosenLevels, wire, dryRun }) {
    const { providers } = await mergedProviders(entryId)
    const section = providers[provider]
    if (!isPlainObject(section)) {
      const known = Object.keys(providers)
      return {
        ok: false,
        provider,
        model,
        error: '命名空间 ' + entryId + ' 下没有 provider「' + provider + '」。当前可见 provider：' + (known.join(', ') || '(无)'),
        settingsAccess: settingsAccess(ctx),
      }
    }
    const entries = modelsArrayOf(section.models)
    const current = entries.find(entry => entry.id === model)
    if (!current) {
      return {
        ok: false,
        provider,
        model,
        error: 'provider「' + provider + '」下没有模型「' + model + '」。它现有的模型：' + (entries.map(e => e.id).join(', ') || '(无)'),
      }
    }

    let next
    if (mode === 'inherit') {
      next = withEfforts(current, 'inherit')
    } else if (mode === 'none') {
      next = withEfforts(current, 'none')
    } else {
      const ladder = Array.isArray(chosenLevels) && chosenLevels.length
        ? sortLevels(chosenLevels.filter(level => ALL_LEVELS.includes(level)))
        : levels()
      if (ladder.filter(level => level !== 'off').length === 0) {
        return { ok: false, provider, model, error: 'levels 模式至少要声明 off 之外的一档，否则官方适配器会拒收' }
      }
      next = withEfforts(current, 'levels', ladder, wireMode(), isPlainObject(wire) ? wire : {})
    }

    const issue = validateEntry(next)
    if (issue) {
      return {
        ok: false, provider, model,
        error: '修改后的声明不合法：' + JSON.stringify(issue),
        patchSnippet: patchSnippet(provider, model, next),
      }
    }

    if (dryRun) {
      return {
        ok: true,
        dryRun: true,
        provider,
        model,
        mode: effortsModeOf(next),
        declared: declaredLevelsOf(next),
        dialEfforts: supportedEfforts(next),
        writePath: ['providers', provider, 'models'],
        patchSnippet: patchSnippet(provider, model, next),
      }
    }

    const written = await patchEntry(entryId, provider, { model, entry: next })
    const after = await readNamespace(ctx, entryId)
    const stored = modelsArrayOf(after.value?.providers?.[provider]?.models).find(entry => entry.id === model)
    const host = await routeOf(ctx, provider, model)
    return {
      ok: true,
      provider,
      model,
      mode: effortsModeOf(stored ?? next),
      declared: declaredLevelsOf(stored ?? next),
      dialEfforts: supportedEfforts(stored ?? next, host?.efforts ?? []),
      hostEfforts: host?.efforts ?? [],
      revision: written?.revision ?? after.revision ?? null,
      settingsVia: after.via,
      applies: after.applies,
      note: after.applies === 'live'
        ? '已写入 settings（patchReload: live），模型选择器会在下一次刷新时出现这些档位。'
        : '已写入 settings；若选择器还没变化，刷新会话或重启应用后生效。',
    }
  }

  return [
    {
      name: 'reasoning_scan',
      description:
        '列出所有自定义 API provider 里的模型，以及每个模型当前的推理等级状态（inherit=没声明所以没有下拉框 / none=明确声明不推理 / levels=已声明可选档位），并说明宿主是"内置目录已知"还是"靠插件声明"。同时报告宿主 settings 服务实际暴露的读写方法，排查"为什么拨盘不出现"时第一个看这个。只读，不写任何设置，不发任何网络请求。',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      output: JSON_OUTPUT,
      timeoutMs: 30_000,
      async execute() {
        try {
          const result = await collect()
          // Only a model with no offerable level is actually a problem: a route
          // the host catalog already describes keeps its dial without any
          // declaration from us.
          const silent = result.models.filter(model => model.dialEfforts.length === 0)
          const silentDeclarable = silent.filter(model => model.routeKnown)
          const access = settingsAccess(ctx)
          const layer = result.layers[0]
          return {
            ok: true,
            settingsAccess: access,
            ...result,
            availableLevels: levels(),
            hint: result.models.length === 0
              ? '一个模型都没发现。诊断：settings 里有 ' + (layer?.settingsProviders ?? 0) + ' 个 provider（读取方式 ' + (layer?.settingsVia ?? '?') + '，错误：' + (layer?.settingsError ?? '无') + '），profile patch 里有 ' + (layer?.patchProviders ?? 0) + ' 个（原因：' + (layer?.patchReason ?? '?') + '）。两边都是 0 说明命名空间 ' + DEFAULT_NAMESPACE + ' 下确实没有自定义 provider。'
              : silent.length
                ? silentDeclarable.length + ' 个模型没有任何可选项，所以模型选择器不给它们推理档位（其余 ' + (silent.length - silentDeclarable.length) + ' 个是宿主路由里没列出的模型）。用 reasoning_declare 给要用的那批补上即可。'
                : '所有列出的模型都有可选档位。',
          }
        } catch (error) {
          return { ok: false, error: messageOf(error) }
        }
      },
    },
    {
      name: 'reasoning_declare',
      description:
        '给任意自定义 API 模型声明推理等级（写 settings 里的 llm-pi-ai.providers.<provider>.models[].reasoningEfforts），让官方的 Off/Low/Medium/High/XHigh/Max 拨盘对它生效。mode=levels 声明可选档位；mode=none 明确声明该模型不推理；mode=inherit 删除声明交回默认。off 档默认写成 null（= 不发任何字段），要送具体值用 wire 覆盖。wire 可逐档覆盖线上拼写，例如 {"high":"high","off":"none"}。传 models 数组可一次声明多个模型；dryRun=true 只回显将写入的内容和 YAML 片段，不落盘。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          provider: { type: 'string', description: '自定义 provider 名，llm-pi-ai.providers 下的键，例如 stepfun。' },
          model: { type: 'string', description: '模型 id，必须已存在于该 provider 的 models 数组里。' },
          models: { type: 'array', items: { type: 'string' }, description: '可选：一次声明多个模型 id（与 model 二选一或并用）。' },
          mode: { type: 'string', description: 'levels | none | inherit', enum: ['levels', 'none', 'inherit'] },
          levels: { type: 'array', items: { type: 'string' }, description: 'mode=levels 时提供哪些档位，例如 ["off","low","medium","high"]。省略则用插件默认阶梯。' },
          wire: { type: 'object', additionalProperties: { type: 'string' }, description: '可选：档位 -> 线上字段值 的覆盖映射，例如 {"low":"low","off":"none"}。未列出的档位按 wireMode 处理。' },
          namespace: { type: 'string', description: '可选：设置命名空间，默认取配置里的第一个（通常是 llm-pi-ai）。' },
          dryRun: { type: 'boolean', description: '可选：true 时只回显将写入的内容和可粘贴的 YAML，不写任何设置。' },
        },
        required: ['provider'],
      },
      output: JSON_OUTPUT,
      timeoutMs: 30_000,
      async execute(args) {
        const provider = text(args?.provider)
        if (!provider) return { ok: false, error: 'provider 必填' }
        const targets = targetsOf(args)
        if (targets.length === 0) return { ok: false, error: 'model 或 models 至少给一个' }
        const mode = ['levels', 'none', 'inherit'].includes(args?.mode) ? args.mode : 'levels'
        const entryId = text(args?.namespace) ?? namespacesOf(config)[0]
        const results = []
        for (const model of targets) {
          try {
            results.push(await declareOne({
              entryId, provider, model, mode,
              levels: args?.levels,
              wire: args?.wire,
              dryRun: args?.dryRun === true,
            }))
          } catch (error) {
            const after = await mergedProviders(entryId)
            const current = modelsArrayOf(after.providers?.[provider]?.models).find(entry => entry.id === model)
            results.push({
              ok: false,
              provider,
              model,
              error: messageOf(error),
              ...(current
                ? { patchSnippet: patchSnippet(provider, model, withEfforts(current, mode, levels(), wireMode(), isPlainObject(args?.wire) ? args.wire : {})) }
                : {}),
              settingsAccess: settingsAccess(ctx),
            })
          }
        }
        const failed = results.filter(item => !item.ok)
        const first = results[0] ?? {}
        return compact({
          ok: failed.length === 0,
          provider,
          dryRun: Boolean(args?.dryRun),
          ...(targets.length === 1
            ? {
              model: first.model,
              mode: first.mode,
              declared: first.declared,
              dialEfforts: first.dialEfforts,
              hostEfforts: first.hostEfforts,
              revision: first.revision,
              applies: first.applies,
              settingsVia: first.settingsVia,
            }
            : {}),
          results,
          ...(failed.length ? { errors: failed.map(item => ({ model: item.model, error: item.error })) } : {}),
          ...(first.note ? { note: first.note } : {}),
        })
      },
    },
    {
      name: 'reasoning_select',
      description:
        '设置当前生效的推理等级：写 agent-default-model 的 provider / model / reasoningEffort，让之后的会话默认走这一档。等价于在模型选择器里选好模型再选推理等级，但可以用脚本一次到位；写完后会用宿主返回的模型能力回读校验这一档是否真的被支持。传 effort=inherit 可删除该字段交回模型默认档。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          provider: { type: 'string', description: '可选：要切到的 provider。省略则只改当前 provider 的推理等级。' },
          model: { type: 'string', description: '可选：要切到的模型。省略则只改当前模型的推理等级。' },
          effort: { type: 'string', description: 'off | minimal | low | medium | high | xhigh | max | inherit。inherit 表示删除设置、用模型自带默认档。' },
        },
        required: ['effort'],
      },
      output: JSON_OUTPUT,
      timeoutMs: 30_000,
      async execute(args) {
        const effort = text(args?.effort)
        if (!effort || (!ALL_LEVELS.includes(effort) && effort !== 'inherit')) {
          return { ok: false, error: 'effort 必须是 ' + [...ALL_LEVELS, 'inherit'].join(' / ') }
        }
        const provider = text(args?.provider)
        const model = text(args?.model)
        try {
          const namespace = await readNamespace(ctx, DEFAULT_MODEL_ENTRY)
          if (namespace.missing) {
            return {
              ok: false,
              error: 'profile 里没有 id 为「' + DEFAULT_MODEL_ENTRY + '」的插件条目',
              settingsAccess: settingsAccess(ctx),
            }
          }
          const current = isPlainObject(namespace.value) ? namespace.value : {}
          const next = {
            provider: provider ?? current.provider,
            model: model ?? current.model,
          }
          if (!next.provider || !next.model) {
            return { ok: false, error: '当前没有默认模型，必须同时提供 provider 和 model' }
          }
          const ops = [
            { op: 'set', path: ['provider'], value: next.provider },
            { op: 'set', path: ['model'], value: next.model },
            effort === 'inherit'
              ? { op: 'unset', path: ['reasoningEffort'] }
              : { op: 'set', path: ['reasoningEffort'], value: effort },
          ]
          const patch = effort === 'inherit'
            ? { provider: next.provider, model: next.model }
            : { provider: next.provider, model: next.model, reasoningEffort: effort }
          const written = await writeSelection(ctx, ops, patch)
          const after = await readNamespace(ctx, DEFAULT_MODEL_ENTRY)
          const applied = isPlainObject(after.value)
            ? {
              provider: text(after.value.provider),
              model: text(after.value.model),
              ...(text(after.value.reasoningEffort) ? { reasoningEffort: text(after.value.reasoningEffort) } : {}),
            }
            : next
          const supported = await routeOf(ctx, applied.provider, applied.model)
          const chosen = applied.reasoningEffort
          const unsupported = Boolean(chosen && supported && supported.efforts.length > 0 && !supported.efforts.includes(chosen))
          return compact({
            ok: true,
            requested: { provider: next.provider, model: next.model, reasoningEffort: effort === 'inherit' ? null : effort },
            applied,
            revision: written?.revision ?? after.revision ?? null,
            settingsVia: after.via,
            hostEfforts: supported?.efforts ?? [],
            ...(unsupported
              ? { warning: '模型 ' + applied.provider + '/' + applied.model + ' 当前只支持 ' + supported.efforts.join(' / ') + '，' + chosen + ' 会在请求时报 UNSUPPORTED_REASONING_EFFORT。先用 reasoning_declare 声明这一档。' }
              : {}),
            note: '新设置对之后创建的会话生效；当前会话可能仍用旧档位。',
          })
        } catch (error) {
          return compact({ ok: false, error: messageOf(error), settingsAccess: settingsAccess(ctx) })
        }
      },
    },
    {
      name: 'reasoning_probe',
      description:
        '实测某个模型到底吃不吃推理等级：用同一句最小提示词，分别以你指定的两档（默认 low 和 high）各请求一次，比较返回内容的差异与是否报错。能区分"声明了但线上忽略"和"真的生效"。会真的发网络请求（可在插件设置里用 allowProbe 关掉）。只用于诊断，不修改任何设置。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          provider: { type: 'string', description: 'provider 名。' },
          model: { type: 'string', description: '模型 id。' },
          low: { type: 'string', description: '低档，默认 low。' },
          high: { type: 'string', description: '高档，默认 high。' },
          prompt: { type: 'string', description: '可选：自定义探针提示词。默认用一句需要思考才能答对的小问题。' },
        },
        required: ['provider', 'model'],
      },
      output: JSON_OUTPUT,
      timeoutMs: 120_000,
      async execute(args) {
        if (config?.allowProbe === false) {
          return { ok: false, error: '插件设置里 allowProbe=false，已禁止发探测请求' }
        }
        const provider = text(args?.provider)
        const model = text(args?.model)
        if (!provider || !model) return { ok: false, error: 'provider 和 model 必填' }
        if (typeof ctx?.llm?.stream !== 'function') {
          return { ok: false, error: '宿主的 llm 服务没有 stream()，无法探测' }
        }
        const prompt = text(args?.prompt)
          ?? 'Answer with one integer only: how many prime numbers are there between 20 and 40?'
        const ladder = [text(args?.low) ?? 'low', text(args?.high) ?? 'high']
        const supported = await routeOf(ctx, provider, model)

        const runOnce = async effort => {
          const started = Date.now()
          try {
            const stream = ctx.llm.stream({
              provider,
              model,
              ...(effort ? { reasoningEffort: effort } : {}),
              messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
              maxTokens: 256,
            })
            let answer = ''
            let finish = 'unknown'
            for await (const chunk of stream) {
              if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') answer += chunk.text
              if (chunk?.type === 'finish' && chunk.finishReason) finish = chunk.finishReason
            }
            return { ok: true, effort, ms: Date.now() - started, chars: answer.length, finish, sample: answer.slice(0, 200) }
          } catch (error) {
            return { ok: false, effort, ms: Date.now() - started, error: messageOf(error) }
          }
        }

        const results = []
        for (const effort of ladder) results.push(await runOnce(effort))
        const bothOk = results.every(r => r.ok)
        return {
          ok: true,
          provider,
          model,
          hostEfforts: supported?.efforts ?? [],
          results,
          verdict: !bothOk
            ? '至少一档请求失败：该模型/线路可能不接受 reasoningEffort 参数，或档位拼写不对。'
            : results[0].chars === results[1].chars
              ? '两档都成功但返回长度一致 —— 无法据此判断档位是否生效，请换一个更依赖思考的提示词再试。'
              : '两档返回不同，说明该模型大概率接受推理等级参数。',
          note: '探测只发最小请求；不同档位的真实差异需要更长任务才能看出来。',
        }
      },
    },
    {
      name: 'reasoning_patch',
      description:
        '不写任何设置，直接给出一段可粘贴进 profile cordis.patch.yml 的 reasoningEfforts YAML（用于 settings 服务不可用、或你想手工管理该文件的情况）。同时回显该模型当前的状态，方便对照。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          provider: { type: 'string', description: 'provider 名。' },
          model: { type: 'string', description: '模型 id。' },
          levels: { type: 'array', items: { type: 'string' }, description: '可选：档位列表，默认用插件阶梯。' },
          wire: { type: 'object', additionalProperties: { type: 'string' }, description: '可选：逐档线上拼写覆盖。' },
          mode: { type: 'string', description: 'levels | none | inherit', enum: ['levels', 'none', 'inherit'] },
          namespace: { type: 'string', description: '可选：命名空间，默认 llm-pi-ai。' },
        },
        required: ['provider', 'model'],
      },
      output: JSON_OUTPUT,
      timeoutMs: 30_000,
      async execute(args) {
        const provider = text(args?.provider)
        const model = text(args?.model)
        if (!provider || !model) return { ok: false, error: 'provider 和 model 必填' }
        const entryId = text(args?.namespace) ?? namespacesOf(config)[0]
        try {
          const { providers } = await mergedProviders(entryId)
          const entries = modelsArrayOf(providers?.[provider]?.models)
          const current = entries.find(entry => entry.id === model)
          if (!current) return { ok: false, error: 'provider「' + provider + '」下没有模型「' + model + '」' }
          const mode = ['levels', 'none', 'inherit'].includes(args?.mode) ? args.mode : 'levels'
          const ladder = Array.isArray(args?.levels) && args.levels.length ? args.levels : levels()
          const next = withEfforts(current, mode, ladder, wireMode(), isPlainObject(args?.wire) ? args.wire : {})
          return {
            ok: true,
            provider,
            model,
            current: { mode: effortsModeOf(current), declared: declaredLevelsOf(current) },
            next: { mode: effortsModeOf(next), declared: declaredLevelsOf(next) },
            dialEfforts: supportedEfforts(next),
            yaml: patchSnippet(provider, model, next),
          }
        } catch (error) {
          return { ok: false, error: messageOf(error) }
        }
      },
    },
  ]
}

// ---------------------------------------------------------------------------
// Plugin entry
// ---------------------------------------------------------------------------

export function apply(ctx, config = {}) {
  if (config?.agentTools === false) {
    ctx.logger.info('reasoning-dial: agent tools disabled by settings')
    return
  }

  const state = { registered: 0, error: null }
  if (typeof ctx?.inject !== 'function') {
    ctx.logger.warn('reasoning-dial: 宿主没有 ctx.inject，插件不注册工具')
    return
  }

  // Register once the host's `tools` service is up. Optional: without it the
  // plugin simply contributes nothing and never fails the boot.
  try {
    ctx.inject(['tools'], toolCtx => {
      toolCtx.effect(() => {
        const tools = buildTools({ ctx, config })
        const disposers = tools.map(tool => {
          try { return toolCtx.tools.register(tool) } catch (error) {
            state.error = messageOf(error)
            return null
          }
        })
        state.registered = disposers.filter(Boolean).length
        return () => {
          state.registered = 0
          for (const disposer of disposers) { try { disposer?.() } catch { /* already gone */ } }
        }
      }, 'reasoning-dial: agent tools')
    })
  } catch (error) {
    state.error = messageOf(error)
    ctx.logger.warn('reasoning-dial: 工具注册失败 — ' + state.error)
  }

  // Optional convenience: backfill declarations at startup when asked to.
  if (config?.autoDeclare) {
    void backfill(ctx, config).catch(error => {
      ctx.logger.warn('reasoning-dial: 自动声明失败 — ' + messageOf(error))
    })
  }
}

/**
 * Startup backfill: declare the default ladder on every custom model that has
 * no declaration yet. Only runs when autoDeclare is on, because a wrong
 * declaration is worse than none — it makes the picker offer a level the
 * provider silently ignores.
 */
async function backfill(ctx, config) {
  const tools = buildTools({ ctx, config })
  const scan = tools.find(tool => tool.name === 'reasoning_scan')
  const declare = tools.find(tool => tool.name === 'reasoning_declare')
  if (!scan || !declare) return
  const result = await scan.execute({})
  if (!result?.ok) return
  const pending = result.models.filter(model => model.mode === 'inherit' || model.mode === 'absent')
  for (const model of pending) {
    if (!model.provider || !model.model) continue
    await declare.execute({ provider: model.provider, model: model.model, mode: 'levels' })
  }
  if (pending.length) {
    ctx.logger.info('reasoning-dial: 为 ' + pending.length + ' 个自定义模型补声明了默认推理阶梯')
  }
}
