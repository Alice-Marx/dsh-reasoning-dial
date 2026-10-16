/**
 * Host plugin of dsh-reasoning-dial for DeepSeek Harness.
 *
 * Problem it solves
 * ----------------
 * DSH ships an Off/Low/Medium/High/XHigh/Max reasoning dial, but it is only
 * offered for models whose catalog entry declares `reasoningEfforts`. Custom
 * API providers you add under `llm-pi-ai` usually ship with the field absent,
 * so the picker silently offers nothing and the dial cannot be set.
 *
 * Where the catalog actually lives
 * --------------------------------
 * A provider can be declared in EITHER of two places, and both feed the same
 * resolved view the picker reads:
 *
 *   1. the profile's cordis.patch.yml (`- id: llm-pi-ai` -> config.providers)
 *   2. the settings store (`ctx.settings.get('llm-pi-ai')`)
 *
 * 0.1.0 only read (2) and therefore reported an empty list on installs where
 * every custom provider is declared in (1) — which is the default. 0.1.1 reads
 * both and merges them, settings winning per provider, so discovery works on
 * either layout.
 *
 * What this plugin does
 * ---------------------
 * It treats the reasoning dial as plain settings data instead of a built-in
 * capability:
 *
 *   - discovers every provider/model from config + settings
 *   - writes `reasoningEfforts` onto any model entry you name
 *   - writes `agent-default-model.reasoningEffort` to pick the active level
 *   - optionally probes the model live to see whether the level is honoured
 *
 * The declaration is a *claim about the wire*, not magic: `reasoningEfforts`
 * maps a level to the exact spelling your provider expects (`low -> "low"`, or
 * `low -> "reasoning_effort=low"`, whatever your gateway wants). The plugin
 * never invents a spelling — it defaults to the identity mapping and lets you
 * override every entry.
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
const DEFAULT_LADDER = ['off', 'low', 'medium', 'high', 'max']
/** Settings namespace / patch entry that owns custom-API providers. */
const DEFAULT_NAMESPACE = 'llm-pi-ai'
/** Settings entry that carries the session default route. */
const DEFAULT_MODEL_ENTRY = 'agent-default-model'

export const Config = z.object({
  namespaces: z.string().default(DEFAULT_NAMESPACE).description('逗号分隔的设置命名空间列表，自定义 API provider 就住在这些命名空间里（默认 llm-pi-ai）。要同时管多个就写 "llm-pi-ai, llm-my-gateway"。'),
  levels: z.string().default(DEFAULT_LADDER.join(',')).description('默认提供哪些档位，逗号分隔，按升级顺序排列。可用值：off / minimal / low / medium / high / xhigh / max。至少要有 off 之外的一档，否则官方校验会拒收。'),
  wireMode: z.string().default('identity').description('档位到线上字段值的映射方式：identity = 直接送档位名本身（OpenAI 风格，最常用）；lower = 转小写；none = 只送档位不送额外字段。自定义网关需要特殊拼写时，用 reasoning_declare 的 wire 参数逐档覆盖。'),
  autoDeclare: z.boolean().default(false).description('启动时自动给所有还没声明 reasoningEfforts 的自定义模型补上默认档位。关着更安全：默认只在你要的时候写。'),
  allowProbe: z.boolean().default(true).description('允许 reasoning_probe 真的向模型发一条最小请求来验证档位是否生效。关掉后该工具只做静态检查、不发任何网络请求。'),
  agentTools: z.boolean().default(true).description('向 Agent 注册 reasoning_* 工具。'),
  readProfileConfig: z.boolean().default(true).description('除了 settings 存储，也读取本 profile 的 cordis.patch.yml 里同名 entry 的 config.providers。自定义 provider 常常只声明在 patch 里，关掉这个会漏掉它们。'),
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

/**
 * Resolve the settings document out of whatever shape the service returned.
 * The host may hand back the section directly, or a `{ value, revision }`
 * envelope, or a `{ user, revision }` pair. All three are accepted so a host
 * upgrade cannot break the plugin.
 */
function unwrapSettings(payload) {
  if (!isPlainObject(payload)) return { root: null, revision: null }
  const revision = payload.revision ?? payload.value?.revision ?? null
  const root = payload.user ?? payload.value ?? payload
  return { root: isPlainObject(root) ? root : null, revision }
}

/** Walk a settings path through plain objects only (mirrors the host walker). */
function readAt(root, path) {
  let current = root
  for (const key of path) {
    if (!isPlainObject(current)) return undefined
    current = current[key]
  }
  return current
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

/** Normalised level -> wire spelling list, escalation order. */
function declaredLevelsOf(entry) {
  if (effortsModeOf(entry) !== 'levels') return []
  const efforts = entry.reasoningEfforts
  const out = []
  for (const level of ALL_LEVELS) {
    if (!(level in efforts)) continue
    const wire = efforts[level]
    out.push({ level, wire: typeof wire === 'string' ? wire : '' })
  }
  return out
}

/**
 * The rules the pi-ai adapter enforces on apply, reported *before* a write so
 * we never persist something the host would refuse: a levels dict must declare
 * at least one level beyond `off`, and every non-off level needs a wire value.
 */
function validateEntry(entry) {
  if (effortsModeOf(entry) !== 'levels') return null
  const declared = declaredLevelsOf(entry)
  let hasBeyondOff = false
  for (const { level, wire } of declared) {
    if (level === 'off') continue
    hasBeyondOff = true
    if (!wire) return { kind: 'effortsWireMissing', level }
  }
  if (!hasBeyondOff) return { kind: 'effortsOffOnly' }
  return null
}

/** Immutable draft update: set the reasoning disposition of one entry. */
function withEfforts(entry, mode, levels, wireMode) {
  if (mode === 'inherit') {
    const { reasoningEfforts: _dropped, ...rest } = entry
    return rest
  }
  if (mode === 'none') return { ...entry, reasoningEfforts: false }
  const spelling = wire => {
    if (wireMode === 'none') return ''
    if (wireMode === 'lower') return String(wire).toLowerCase()
    return String(wire)
  }
  const efforts = {}
  for (const level of sortLevels(levels)) efforts[level] = spelling(level)
  return { ...entry, reasoningEfforts: efforts }
}

// ---------------------------------------------------------------------------
// Profile config layer (0.1.1)
//
// A provider declared in the profile's cordis.patch.yml never appears in the
// settings store, so a settings-only read reports nothing. We locate the
// owning profile from our own install path and parse the patch for the same
// namespace, then merge. Parsing is best-effort: without a YAML parser we
// simply skip the layer and say so in the scan output.
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

async function profileProviders() {
  if (patchCache !== null) return patchCache
  patchCache = { providers: {}, reason: 'not-attempted' }
  try {
    const dir = profileDirOf()
    if (!dir) { patchCache.reason = 'profile-dir-unresolved'; return patchCache }
    const file = `${dir}\\cordis.patch.yml`
    let raw
    try { raw = await readFile(file, 'utf8') } catch {
      patchCache.reason = `no patch file at ${file}`
      return patchCache
    }
    try {
      const YAML = await import('yaml')
      patchCache.providers = providersFromPatch(YAML.parse(raw))
      patchCache.reason = 'ok'
    } catch (error) {
      // Reported, never guessed: a half-parsed patch would be worse than none.
      patchCache.reason = `yaml-unavailable: ${String(error?.message ?? error).slice(0, 120)}`
    }
  } catch (error) {
    patchCache.reason = `error: ${String(error?.message ?? error).slice(0, 120)}`
  }
  return patchCache
}

// ---------------------------------------------------------------------------
// Settings access. Feature-detected so an unfamiliar host build degrades to a
// clear "cannot write" report instead of a crash.
// ---------------------------------------------------------------------------

function settingsService(ctx) {
  const service = ctx?.settings
  if (!service) return null
  const canRead = typeof service.get === 'function' || typeof service.read === 'function'
  const canWrite = typeof service.mutate === 'function' || typeof service.update === 'function'
  return canRead && canWrite ? service : null
}

async function readSettings(ctx, entryId) {
  const service = settingsService(ctx)
  if (!service) return { root: null, revision: null, available: false }
  for (const method of ['get', 'read']) {
    if (typeof service[method] !== 'function') continue
    try {
      const payload = await service[method](entryId)
      const { root, revision } = unwrapSettings(payload)
      return { root, revision, available: true }
    } catch { /* try the next accessor */ }
  }
  return { root: null, revision: null, available: true }
}

async function writeModels(ctx, entryId, path, entries, revision) {
  const service = settingsService(ctx)
  if (!service) throw new Error('宿主没有暴露可读写的 settings 服务')
  const op = { op: 'set', path: [...path, 'models'], value: entries }
  if (typeof service.mutate === 'function') return await service.mutate(entryId, [op], revision)
  if (typeof service.update === 'function') {
    let patch = { models: entries }
    for (const key of [...path].reverse()) patch = { [key]: patch }
    return await service.update(entryId, patch, revision)
  }
  throw new Error('settings 服务没有 mutate/update')
}

function namespacesOf(config) {
  return splitList(config?.namespaces, [DEFAULT_NAMESPACE])
}

function levelsOf(config) {
  return sortLevels(splitList(config?.levels, DEFAULT_LADDER))
}

function wireModeOf(config) {
  const mode = text(config?.wireMode) ?? 'identity'
  return ['identity', 'lower', 'none'].includes(mode) ? mode : 'identity'
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
   * Merged provider view for one namespace: the profile patch supplies the
   * base, the settings store overrides it per provider (the same precedence
   * the host's resolved view uses).
   */
  async function mergedProviders(entryId) {
    const { root, revision, available } = await readSettings(ctx, entryId)
    const fromSettings = isPlainObject(root?.providers) ? root.providers : {}
    const patch = config?.readProfileConfig === false
      ? { providers: {}, reason: 'disabled' }
      : await profileProviders()
    const merged = {}
    for (const [name, section] of Object.entries(patch.providers)) merged[name] = section
    for (const [name, section] of Object.entries(fromSettings)) merged[name] = section
    return {
      providers: merged,
      revision,
      settingsAvailable: available,
      settingsProviders: Object.keys(fromSettings).length,
      patchProviders: Object.keys(patch.providers).length,
      patchReason: patch.reason,
    }
  }

  /** Every model in every configured namespace, merged with host route info. */
  async function collect() {
    const { available, routes } = await discoverRoutes(ctx)
    const routeKey = route => `${route.provider}/${route.model}`
    const byKey = new Map(routes.map(route => [routeKey(route), route]))
    const out = []
    const layers = []
    for (const entryId of namespacesOf(config)) {
      const { providers, revision, settingsAvailable, settingsProviders, patchProviders, patchReason } =
        await mergedProviders(entryId)
      layers.push({
        namespace: entryId,
        settingsAvailable,
        settingsProviders,
        patchProviders,
        patchReason,
        mergedProviders: Object.keys(providers).length,
      })
      for (const [providerName, section] of Object.entries(providers)) {
        const entries = modelsArrayOf(section?.models)
        const seen = new Set()
        for (const entry of entries) {
          seen.add(entry.id)
          const route = byKey.get(`${providerName}/${entry.id}`)
          out.push({
            namespace: entryId,
            provider: providerName,
            model: entry.id,
            name: typeof entry.name === 'string' && entry.name ? entry.name : entry.id,
            routeKnown: Boolean(route),
            hostReasoningKnown: route?.reasoningKnown ?? false,
            hostEfforts: route?.reasoningEfforts ?? [],
            declared: declaredLevelsOf(entry),
            mode: effortsModeOf(entry),
            issue: validateEntry(entry),
          })
        }
        // Routes the host knows but the namespace does not list.
        for (const [key, route] of byKey) {
          if (!key.startsWith(`${providerName}/`)) continue
          if (seen.has(route.model)) continue
          out.push({
            namespace: entryId,
            provider: providerName,
            model: route.model,
            name: route.name,
            routeKnown: true,
            hostReasoningKnown: route.reasoningKnown,
            hostEfforts: route.reasoningEfforts,
            declared: [],
            mode: 'absent',
            issue: null,
          })
        }
      }
    }
    return { routesAvailable: available, layers, models: out, namespaces: namespacesOf(config) }
  }

  /** Rewrite one provider's whole `models` array with a patched entry. */
  async function patchEntry(entryId, providerName, patch) {
    const { providers, revision } = await mergedProviders(entryId)
    const section = providers[providerName]
    if (!isPlainObject(section)) {
      throw new Error(`命名空间 ${entryId} 下没有 provider「${providerName}」（已合并 settings 与 profile patch 两个来源）`)
    }
    const entries = modelsArrayOf(section.models)
    const index = entries.findIndex(entry => entry.id === patch.model)
    if (index < 0) throw new Error(`provider「${providerName}」下没有模型「${patch.model}」`)
    entries[index] = patch.entry
    const issue = validateEntry(entries[index])
    if (issue) throw new Error(`修改后的声明不合法：${JSON.stringify(issue)}`)
    const written = await writeModels(ctx, entryId, ['providers', providerName], entries, revision)
    return { ok: true, revision: written?.revision ?? revision ?? null, entry: entries[index] }
  }

  return [
    {
      name: 'reasoning_scan',
      description:
        '列出所有自定义 API provider 里的模型，以及每个模型当前的推理等级声明状态（inherit=没声明所以没有下拉框 / none=明确声明不推理 / levels=已声明可选档位），同时附上宿主 LLM 服务报告的原始能力。想搞清楚"为什么这个模型没有推理等级"就用这个。只读，不写任何设置，不发任何网络请求。',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      output: JSON_OUTPUT,
      timeoutMs: 30_000,
      async execute() {
        try {
          const result = await collect()
          const missing = result.models.filter(m => m.mode === 'inherit' || m.mode === 'absent')
          return {
            ok: true,
            ...result,
            availableLevels: levels(),
            hint: result.models.length === 0
              ? `一个模型都没发现。诊断：settings 里有 ${result.layers[0]?.settingsProviders ?? 0} 个 provider，profile patch 里有 ${result.layers[0]?.patchProviders ?? 0} 个（原因：${result.layers[0]?.patchReason ?? '?'}）。patch 有 provider 但模型为空说明 YAML 解析失败；两个都是 0 说明命名空间 ${DEFAULT_NAMESPACE} 下确实没有自定义 provider。`
              : missing.length
                ? `${missing.length} 个模型还没声明 reasoningEfforts，所以模型选择器不给它们推理档位。用 reasoning_declare 补上即可。`
                : '所有列出的模型都已声明推理等级。',
          }
        } catch (error) {
          return { ok: false, error: String(error?.message ?? error) }
        }
      },
    },
    {
      name: 'reasoning_declare',
      description:
        '给任意自定义 API 模型声明推理等级（写 settings 里的 llm-pi-ai.providers.<provider>.models[].reasoningEfforts），让官方的 Off/Low/Medium/High/XHigh/Max 拨盘对它生效。mode=levels 声明可选档位；mode=none 明确声明该模型不推理（选择器不再提供思考档位）；mode=inherit 删除声明交回默认。wire 参数可逐档覆盖线上拼写，比如 {"low":"reasoning_effort=low"} —— 默认用档位名本身（OpenAI 风格）。这是让"任何自定义 API 模型都能设置推理等级"的核心操作。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          provider: { type: 'string', description: '自定义 provider 名，llm-pi-ai.providers 下的键，例如 stepfun。' },
          model: { type: 'string', description: '模型 id，必须已存在于该 provider 的 models 数组里。' },
          mode: { type: 'string', description: 'levels | none | inherit', enum: ['levels', 'none', 'inherit'] },
          levels: { type: 'array', items: { type: 'string' }, description: 'mode=levels 时提供哪些档位，例如 ["off","low","medium","high","max"]。省略则用插件默认阶梯。' },
          wire: { type: 'object', additionalProperties: { type: 'string' }, description: '可选：档位 -> 线上字段值 的覆盖映射，例如 {"low":"reasoning_effort=low"}。未列出的档位按 wireMode 处理。' },
          namespace: { type: 'string', description: '可选：设置命名空间，默认取配置里的第一个（通常是 llm-pi-ai）。' },
        },
        required: ['provider', 'model'],
      },
      output: JSON_OUTPUT,
      timeoutMs: 30_000,
      async execute(args) {
        const provider = text(args?.provider)
        const model = text(args?.model)
        if (!provider || !model) return { ok: false, error: 'provider 和 model 必填' }
        const mode = ['levels', 'none', 'inherit'].includes(args?.mode) ? args.mode : 'levels'
        const entryId = text(args?.namespace) ?? namespacesOf(config)[0]
        try {
          const { providers } = await mergedProviders(entryId)
          const entries = modelsArrayOf(providers[provider]?.models)
          const current = entries.find(entry => entry.id === model)
          if (!current) {
            const known = Object.keys(providers)
            return {
              ok: false,
              error: `provider「${provider}」下没有模型「${model}」。当前可见 provider：${known.join(', ') || '(无)'}`,
            }
          }

          let next
          if (mode === 'inherit') {
            next = withEfforts(current, 'inherit')
          } else if (mode === 'none') {
            next = withEfforts(current, 'none')
          } else {
            const chosen = Array.isArray(args?.levels) && args.levels.length
              ? sortLevels(args.levels.filter(l => ALL_LEVELS.includes(l)))
              : levels()
            if (chosen.length < 2) {
              return { ok: false, error: 'levels 模式至少要声明 off 之外的一档，否则官方适配器会拒收' }
            }
            next = withEfforts(current, 'levels', chosen, wireMode())
            const overrides = isPlainObject(args?.wire) ? args.wire : {}
            for (const [level, value] of Object.entries(overrides)) {
              if (!ALL_LEVELS.includes(level)) continue
              next.reasoningEfforts[level] = String(value)
            }
          }
          const result = await patchEntry(entryId, provider, { model, entry: next })
          return {
            ok: true,
            ...result,
            declared: declaredLevelsOf(next),
            mode: effortsModeOf(next),
            note: '已写入 settings（会覆盖 profile patch 里的同名声明）。重启或刷新会话后，模型选择器的推理等级下拉框就会出现。',
          }
        } catch (error) {
          return { ok: false, error: String(error?.message ?? error) }
        }
      },
    },
    {
      name: 'reasoning_select',
      description:
        '设置当前生效的推理等级：写 agent-default-model 的 provider / model / reasoningEffort，让之后的会话默认走这一档。等价于在模型选择器里选好模型再选推理等级，但可以用脚本一次到位。传 effort=inherit 可删除该字段交回模型默认档。',
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
          return { ok: false, error: `effort 必须是 ${[...ALL_LEVELS, 'inherit'].join(' / ')}` }
        }
        const provider = text(args?.provider)
        const model = text(args?.model)
        try {
          const { root, revision } = await readSettings(ctx, DEFAULT_MODEL_ENTRY)
          const current = isPlainObject(root) ? root : {}
          const next = {
            provider: provider ?? current.provider,
            model: model ?? current.model,
          }
          if (!next.provider || !next.model) {
            return { ok: false, error: '当前没有默认模型，必须同时提供 provider 和 model' }
          }
          if (effort === 'inherit') delete next.reasoningEffort
          else next.reasoningEffort = effort

          const service = settingsService(ctx)
          if (!service) return { ok: false, error: '宿主没有暴露可读写的 settings 服务' }
          const written = typeof service.mutate === 'function'
            ? await service.mutate(DEFAULT_MODEL_ENTRY, [{ op: 'set', path: [], value: next }], revision)
            : await service.update(DEFAULT_MODEL_ENTRY, next, revision)
          return {
            ok: true,
            applied: next,
            revision: written?.revision ?? revision ?? null,
            note: '新设置对之后创建的会话生效；当前会话可能仍用旧档位。',
          }
        } catch (error) {
          return { ok: false, error: String(error?.message ?? error) }
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
            return { ok: false, effort, ms: Date.now() - started, error: String(error?.message ?? error) }
          }
        }

        const results = []
        for (const effort of ladder) results.push(await runOnce(effort))
        const bothOk = results.every(r => r.ok)
        return {
          ok: true,
          provider,
          model,
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
            state.error = String(error?.message ?? error)
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
    state.error = String(error?.message ?? error)
    ctx.logger.warn(`reasoning-dial: 工具注册失败 — ${state.error}`)
  }

  // Optional convenience: backfill declarations at startup when asked to.
  if (config?.autoDeclare) {
    void backfill(ctx, config).catch(error => {
      ctx.logger.warn(`reasoning-dial: 自动声明失败 — ${String(error?.message ?? error)}`)
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
    ctx.logger.info(`reasoning-dial: 为 ${pending.length} 个自定义模型补声明了默认推理阶梯`)
  }
}
