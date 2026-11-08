/**
 * Host-free test suite for dsh-reasoning-dial.
 *
 * The plugin talks to three host services (settings, llm, tools). This file
 * builds a faithful mock of them — including BOTH settings generations — so the
 * write path, the conflict retry, the off/level semantics and the diagnostics
 * can be verified without a running Harness.
 *
 * Run with:  node --test test/
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

// ---------------------------------------------------------------------------
// schemastery stub: the plugin only builds a Config descriptor from it and
// never reads it back, so a chainable builder is enough.
// ---------------------------------------------------------------------------
const stubDir = mkdtempSync(join(tmpdir(), 'dial-stub-'))
const stubFile = join(stubDir, 'schemastery.mjs')
writeFileSync(stubFile, [
  'const chain = () => {',
  '  const node = {}',
  '  for (const method of ["default", "description", "required", "volatile", "dict", "inner", "const"]) {',
  '    node[method] = () => node',
  '  }',
  '  node.toJSON = () => ({})',
  '  return node',
  '}',
  'export default new Proxy({}, { get: () => chain })',
  '',
].join('\n'))

const hooks = await import('node:module')
if (typeof hooks.registerHooks === 'function') {
  hooks.registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === '@deepseek-ai/schemastery') {
        return { url: pathToFileURL(stubFile).href, shortCircuit: true }
      }
      return nextResolve(specifier, context)
    },
  })
} else {
  throw new Error('node >= 22.15 is required for module.registerHooks')
}

const plugin = await import(pathToFileURL(new URL('../.dsh-plugin/index.mjs', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')).href)

// ---------------------------------------------------------------------------
// A miniature Harness: settings namespaces + llm routes + tool registry.
// ---------------------------------------------------------------------------
const clone = value => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)))

function mergeDeep(under, over) {
  if (!over || typeof over !== 'object' || Array.isArray(over)) return clone(over)
  const out = under && typeof under === 'object' && !Array.isArray(under) ? clone(under) : {}
  for (const [key, value] of Object.entries(over)) out[key] = mergeDeep(out[key], value)
  return out
}

function setAt(root, path, value) {
  if (path.length === 0) return clone(value)
  const [head, ...rest] = path
  const out = root && typeof root === 'object' && !Array.isArray(root) ? clone(root) : {}
  out[head] = rest.length === 0 ? clone(value) : setAt(out[head], rest, value)
  return out
}

function unsetAt(root, path) {
  if (path.length === 0) return undefined
  const [head, ...rest] = path
  if (!root || typeof root !== 'object') return root
  const out = clone(root)
  if (rest.length === 0) delete out[head]
  else out[head] = unsetAt(out[head], rest)
  return out
}

/** Mirror of pi-ai's getSupportedThinkingLevels, used by the mock llm route. */
function supportedFrom(efforts) {
  if (!efforts || typeof efforts !== 'object') return []
  const levels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
  return levels.filter(level => {
    const wire = efforts[level]
    if (wire === null) return false
    if (level === 'xhigh' || level === 'max') return wire !== undefined
    return true
  })
}

/**
 * @param options.mode 'describe' (current host), 'legacy' (get()+update()),
 *   'no-write' (describe only, to prove the refusal) or 'write-only'.
 * @param options.knownHostReasoning routes the host already knows, e.g.
 *   { 'opencode-go/deepseek-v4-pro': ['off', 'high'] }.
 */
function makeHost({ mode = 'describe', namespaces = {}, knownHostReasoning = {}, failWrites = 0 } = {}) {
  const state = {}
  for (const [ns, entry] of Object.entries(namespaces)) {
    state[ns] = {
      revision: entry.revision ?? 1,
      base: clone(entry.base ?? {}),
      value: clone(entry.value ?? {}),
      user: clone(entry.user ?? entry.value ?? {}),
    }
  }
  const calls = { mutate: [], update: [], describe: 0 }
  let remainingFailures = failWrites

  const settings = {}
  if (mode === 'describe' || mode === 'no-write') {
    settings.describe = () => {
      calls.describe += 1
      return Object.entries(state).map(([ns, row]) => ({
        ns,
        revision: row.revision,
        value: clone(row.value),
        user: clone(row.user),
        base: {},
        applies: 'live',
      }))
    }
  }
  if (mode === 'legacy') {
    settings.get = ns => (state[ns] ? { value: clone(state[ns].value), revision: state[ns].revision } : undefined)
  }
  const writable = mode !== 'no-write'
  if (writable && mode !== 'legacy') {
    settings.mutate = async (ns, ops, revision) => {
      const row = state[ns]
      if (!row) throw new Error('No configurable plugin entry "' + ns + '"')
      if (revision !== undefined && revision !== row.revision) {
        const error = new Error('settings namespace "' + ns + '" changed since it was read (expected revision ' + revision + ', now ' + row.revision + ')')
        error.code = 'SETTINGS_CONFLICT'
        throw error
      }
      if (remainingFailures > 0) {
        remainingFailures -= 1
        const error = new Error('settings namespace "' + ns + '" changed since it was read (expected revision ' + revision + ', now ' + (row.revision + 1) + ')')
        error.code = 'SETTINGS_CONFLICT'
        throw error
      }
      calls.mutate.push({ ns, ops: clone(ops), revision })
      let user = clone(row.user)
      for (const op of ops) {
        user = op.op === 'set' ? setAt(user, op.path, op.value) : unsetAt(user, op.path)
      }
      row.user = user
      row.value = mergeDeep(row.base, user)
      row.revision += 1
      return { revision: row.revision }
    }
  }
  if (writable) {
    settings.update = async (ns, patch, revision) => {
      const row = state[ns]
      if (!row) throw new Error('No configurable plugin entry "' + ns + '"')
      if (revision !== undefined && revision !== row.revision) {
        const error = new Error('settings namespace "' + ns + '" changed since it was read')
        error.code = 'SETTINGS_CONFLICT'
        throw error
      }
      calls.update.push({ ns, patch: clone(patch), revision })
      row.user = mergeDeep(row.user, patch)
      row.value = mergeDeep(row.base, row.user)
      row.revision += 1
      return { revision: row.revision }
    }
  }

  const modelEntry = (provider, model) => {
    const models = state['llm-pi-ai']?.value?.providers?.[provider]?.models
    return Array.isArray(models) ? models.find(entry => entry?.id === model) : undefined
  }

  const llm = {
    listProviders: () => ['llm-pi-ai', 'agent-default-model'].includes('llm-pi-ai') ? Object.keys(state['llm-pi-ai']?.value?.providers ?? {}) : [],
    listModels: async provider => (state['llm-pi-ai']?.value?.providers?.[provider]?.models ?? []).map(entry => ({ id: entry.id, name: entry.name })),
    resolveModelInfo: async (provider, model) => {
      const known = knownHostReasoning[provider + '/' + model]
      const entry = modelEntry(provider, model)
      if (known) {
        return { name: entry?.name ?? model, reasoning: { efforts: known.map(id => ({ id, name: id })) } }
      }
      if (entry && entry.reasoningEfforts && typeof entry.reasoningEfforts === 'object') {
        return { name: entry.name ?? model, reasoning: { efforts: supportedFrom(entry.reasoningEfforts).map(id => ({ id, name: id })) } }
      }
      return { name: entry?.name ?? model }
    },
  }

  return { settings, llm, state, calls }
}

/** Load the plugin against one mock host and return its registered tools. */
function load(host, config = {}) {
  const tools = new Map()
  const ctx = {
    settings: host.settings,
    llm: host.llm,
    logger: { info() {}, warn() {} },
    inject(_services, callback) {
      callback({
        tools: {
          register(tool) {
            tools.set(tool.name, tool)
            return () => tools.delete(tool.name)
          },
        },
        effect(run) { return run() },
      })
    },
  }
  plugin.apply(ctx, config)
  return tools
}

const stepfunNamespace = () => ({
  value: {
    providers: {
      stepfun: {
        apiKeyEnv: 'STEPFUN_API_KEY',
        api: 'openai-completions',
        baseURL: 'https://api.stepfun.com/step_plan/v1',
        models: [
          { id: 'step-3.7-flash', name: 'step-3.7-flash', contextWindow: 262144 },
          { id: 'step-5-preview', name: 'step-5-preview', contextWindow: 1024000 },
        ],
      },
    },
  },
})

const defaultModelNamespace = (value = { provider: 'stepfun', model: 'step-3.7-flash' }) => ({ value })

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

test('scan reads the current host through describe() and reports the access shape', async () => {
  const host = makeHost({
    namespaces: {
      'llm-pi-ai': stepfunNamespace(),
      'agent-default-model': defaultModelNamespace(),
    },
  })
  const tools = load(host)
  const result = await tools.get('reasoning_scan').execute({})

  assert.equal(result.ok, true)
  assert.equal(result.settingsAccess.describe, true)
  assert.equal(result.settingsAccess.document, false)
  assert.equal(result.settingsAccess.mutate, true)
  assert.equal(result.layers[0].settingsVia, 'describe')
  assert.equal(result.layers[0].settingsProviders, 1)
  assert.deepEqual(result.models.map(model => model.model), ['step-3.7-flash', 'step-5-preview'])
  assert.equal(result.models[0].mode, 'inherit')
  assert.equal(result.models[0].api, 'openai-completions')
  assert.deepEqual(result.models[0].dialEfforts, [])
})

test('scan still works on the legacy get()/read() host generation', async () => {
  const host = makeHost({
    mode: 'legacy',
    namespaces: { 'llm-pi-ai': stepfunNamespace(), 'agent-default-model': defaultModelNamespace() },
  })
  const result = await load(host).get('reasoning_scan').execute({})
  assert.equal(result.layers[0].settingsVia, 'get')
  assert.equal(result.layers[0].settingsProviders, 1)
  assert.equal(result.models.length, 2)
})

// ---------------------------------------------------------------------------
// Declaration
// ---------------------------------------------------------------------------

test('declare writes the ladder with off=null and reads it back', async () => {
  const host = makeHost({
    namespaces: { 'llm-pi-ai': stepfunNamespace(), 'agent-default-model': defaultModelNamespace() },
  })
  const tools = load(host)
  const result = await tools.get('reasoning_declare').execute({ provider: 'stepfun', model: 'step-3.7-flash' })

  assert.equal(result.ok, true)
  assert.equal(host.calls.mutate.length, 1)
  assert.deepEqual(host.calls.mutate[0].ops[0].path, ['providers', 'stepfun', 'models'])
  const written = host.calls.mutate[0].ops[0].value.find(entry => entry.id === 'step-3.7-flash')
  assert.deepEqual(written.reasoningEfforts, { off: null, low: 'low', medium: 'medium', high: 'high' })
  assert.deepEqual(result.dialEfforts, ['off', 'low', 'medium', 'high'])
  assert.equal(result.settingsVia, 'describe')

  // The untouched sibling keeps its shape.
  const other = host.calls.mutate[0].ops[0].value.find(entry => entry.id === 'step-5-preview')
  assert.equal(other.reasoningEfforts, undefined)

  const after = await tools.get('reasoning_scan').execute({})
  const flash = after.models.find(model => model.model === 'step-3.7-flash')
  assert.equal(flash.mode, 'levels')
  assert.equal(flash.source, 'declared')
  assert.deepEqual(flash.dialEfforts, ['off', 'low', 'medium', 'high'])
})

test('declare retries exactly once on SETTINGS_CONFLICT', async () => {
  const host = makeHost({
    namespaces: { 'llm-pi-ai': stepfunNamespace(), 'agent-default-model': defaultModelNamespace() },
    failWrites: 1,
  })
  const result = await load(host).get('reasoning_declare').execute({ provider: 'stepfun', model: 'step-3.7-flash' })
  assert.equal(result.ok, true)
  assert.equal(host.calls.mutate.length, 1)
})

test('declare falls back to update() on a host without mutate()', async () => {
  const host = makeHost({
    mode: 'legacy',
    namespaces: { 'llm-pi-ai': stepfunNamespace(), 'agent-default-model': defaultModelNamespace() },
  })
  const result = await load(host).get('reasoning_declare').execute({ provider: 'stepfun', model: 'step-3.7-flash' })
  assert.equal(result.ok, true)
  assert.equal(host.calls.update.length, 1)
  assert.deepEqual(host.calls.update[0].patch.providers.stepfun.models[0].reasoningEfforts, {
    off: null, low: 'low', medium: 'medium', high: 'high',
  })
})

test('declare refuses to write when the host exposes no write path, and hands back YAML', async () => {
  const host = makeHost({
    mode: 'no-write',
    namespaces: { 'llm-pi-ai': stepfunNamespace(), 'agent-default-model': defaultModelNamespace() },
  })
  const result = await load(host).get('reasoning_declare').execute({ provider: 'stepfun', model: 'step-3.7-flash' })
  assert.equal(result.ok, false)
  assert.match(result.errors[0].error, /settings 服务|settings/)
  assert.equal(result.results[0].settingsAccess.mutate, false)
})

test('dryRun reports the payload and the paste-ready YAML without writing', async () => {
  const host = makeHost({
    namespaces: { 'llm-pi-ai': stepfunNamespace(), 'agent-default-model': defaultModelNamespace() },
  })
  const result = await load(host).get('reasoning_declare').execute({
    provider: 'stepfun', model: 'step-3.7-flash', dryRun: true,
  })
  assert.equal(result.ok, true)
  assert.equal(result.dryRun, true)
  assert.equal(host.calls.mutate.length, 0)
  assert.match(result.results[0].patchSnippet, /off: null/)
  assert.match(result.results[0].patchSnippet, /high: "high"/)
})

test('a batch declaration covers every listed model', async () => {
  const host = makeHost({
    namespaces: { 'llm-pi-ai': stepfunNamespace(), 'agent-default-model': defaultModelNamespace() },
  })
  const result = await load(host).get('reasoning_declare').execute({
    provider: 'stepfun', models: ['step-3.7-flash', 'step-5-preview'],
  })
  assert.equal(result.ok, true)
  assert.equal(result.results.length, 2)
  assert.equal(host.calls.mutate.length, 2)
  const last = host.calls.mutate[1].ops[0].value
  assert.ok(last.every(entry => entry.reasoningEfforts && entry.reasoningEfforts.high === 'high'))
})

test('mode=none declares a non-reasoning model and mode=inherit removes the field', async () => {
  const host = makeHost({
    namespaces: { 'llm-pi-ai': stepfunNamespace(), 'agent-default-model': defaultModelNamespace() },
  })
  const tools = load(host)
  const none = await tools.get('reasoning_declare').execute({
    provider: 'stepfun', model: 'step-audio', mode: 'none',
  })
  assert.equal(none.ok, false) // not a model of this provider
  const declaredNone = await tools.get('reasoning_declare').execute({
    provider: 'stepfun', model: 'step-3.7-flash', mode: 'none',
  })
  assert.equal(declaredNone.ok, true)
  assert.deepEqual(host.calls.mutate.at(-1).ops[0].value[0].reasoningEfforts, false)

  const inherited = await tools.get('reasoning_declare').execute({
    provider: 'stepfun', model: 'step-3.7-flash', mode: 'inherit',
  })
  assert.equal(inherited.ok, true)
  assert.equal(host.calls.mutate.at(-1).ops[0].value[0].reasoningEfforts, undefined)
})

test('wire overrides replace the spelling and xhigh/max only appear when named', async () => {
  const host = makeHost({
    namespaces: { 'llm-pi-ai': stepfunNamespace(), 'agent-default-model': defaultModelNamespace() },
  })
  const tools = load(host)
  const overridden = await tools.get('reasoning_declare').execute({
    provider: 'stepfun',
    model: 'step-3.7-flash',
    levels: ['off', 'low', 'high'],
    wire: { off: 'none', high: 'HIGH' },
  })
  assert.equal(overridden.ok, true)
  assert.deepEqual(host.calls.mutate.at(-1).ops[0].value[0].reasoningEfforts, { off: 'none', low: 'low', high: 'HIGH' })
  assert.deepEqual(overridden.dialEfforts, ['off', 'low', 'high'])

  const withMax = await tools.get('reasoning_declare').execute({
    provider: 'stepfun', model: 'step-3.7-flash', levels: ['off', 'low', 'high', 'max'],
  })
  assert.deepEqual(withMax.dialEfforts, ['off', 'low', 'high', 'max'])
})

test('a declaration that the host would refuse is rejected before the write', async () => {
  const host = makeHost({
    namespaces: { 'llm-pi-ai': stepfunNamespace(), 'agent-default-model': defaultModelNamespace() },
  })
  const result = await load(host).get('reasoning_declare').execute({
    provider: 'stepfun', model: 'step-3.7-flash', levels: ['off'],
  })
  assert.equal(result.ok, false)
  assert.match(result.errors[0].error, /off 之外/)
  assert.equal(host.calls.mutate.length, 0)
})

// ---------------------------------------------------------------------------
// Selection of the active level
// ---------------------------------------------------------------------------

test('select writes the default-model namespace and verifies the level', async () => {
  const host = makeHost({
    namespaces: {
      'llm-pi-ai': stepfunNamespace(),
      'agent-default-model': defaultModelNamespace({ provider: 'stepfun', model: 'step-3.7-flash' }),
    },
    knownHostReasoning: { 'stepfun/step-3.7-flash': ['off', 'low', 'medium', 'high'] },
  })
  const result = await load(host).get('reasoning_select').execute({ effort: 'high' })
  assert.equal(result.ok, true)
  assert.equal(result.applied.reasoningEffort, 'high')
  const ops = host.calls.mutate.at(-1).ops
  assert.deepEqual(ops.map(op => op.op + ':' + op.path.join('.')), ['set:provider', 'set:model', 'set:reasoningEffort'])
  assert.equal(result.warning, undefined)
})

test('select warns when the chosen level is not offered by the model', async () => {
  const host = makeHost({
    namespaces: {
      'llm-pi-ai': stepfunNamespace(),
      'agent-default-model': defaultModelNamespace({ provider: 'stepfun', model: 'step-3.7-flash' }),
    },
    knownHostReasoning: { 'stepfun/step-3.7-flash': ['off', 'low', 'high'] },
  })
  const result = await load(host).get('reasoning_select').execute({ effort: 'max' })
  assert.equal(result.ok, true)
  assert.match(result.warning, /UNSUPPORTED_REASONING_EFFORT/)
})

test('select inherit unsets the field instead of writing a placeholder', async () => {
  const host = makeHost({
    namespaces: {
      'llm-pi-ai': stepfunNamespace(),
      'agent-default-model': defaultModelNamespace({ provider: 'stepfun', model: 'step-3.7-flash', reasoningEffort: 'high' }),
    },
  })
  const result = await load(host).get('reasoning_select').execute({ effort: 'inherit' })
  assert.equal(result.ok, true)
  assert.equal(result.applied.reasoningEffort, undefined)
  assert.deepEqual(host.calls.mutate.at(-1).ops.at(-1), { op: 'unset', path: ['reasoningEffort'] })
})

// ---------------------------------------------------------------------------
// Patch snippet tool
// ---------------------------------------------------------------------------

test('reasoning_patch never writes and renders the exact YAML block', async () => {
  const host = makeHost({
    namespaces: { 'llm-pi-ai': stepfunNamespace(), 'agent-default-model': defaultModelNamespace() },
  })
  const result = await load(host).get('reasoning_patch').execute({ provider: 'stepfun', model: 'step-3.7-flash' })
  assert.equal(result.ok, true)
  assert.equal(host.calls.mutate.length, 0)
  assert.deepEqual(result.current.mode, 'inherit')
  assert.match(result.yaml, /reasoningEfforts:/)
  assert.match(result.yaml, /low: "low"/)
})
