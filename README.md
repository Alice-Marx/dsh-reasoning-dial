# dsh-reasoning-dial

Give **any custom API model** a reasoning-level dial.

[中文说明](./README.zh.md) · [Changelog](./CHANGELOG.md)

## The problem

DeepSeek Harness ships an Off / Low / Medium / High / XHigh / Max reasoning dial, but it is
only offered for models whose catalog entry declares `reasoningEfforts`. Built-in routes
(DeepSeek, the `opencode-go` catalog) declare it; a custom API provider you add yourself —
StepFun `step-3.x` / `step-5`, a reseller key, any OpenAI-compatible gateway — usually does
not, so:

- the model picker shows **no reasoning-level control at all**
- you cannot change the level, and the model silently runs at its own default

This plugin treats the dial as **ordinary settings data** instead of a built-in capability:

| Where | What it decides |
|---|---|
| `llm-pi-ai.providers.<name>.models[].reasoningEfforts` | which levels this model offers (**this is what makes the dropdown appear**) |
| `agent-default-model.reasoningEffort` | the level currently in effect |

## What 0.3.0 fixes

0.2.x **could not write at all on a current host**. `dsh-settings` changed its service
generation: it no longer exposes `get()/read()`, and instead publishes
`describe() -> [{ ns, revision, value, user, base, applies }]` with
`mutate()/update()/replace()` for writes. 0.2.x probed `get || read` to decide whether the
service existed, concluded "no settings service", and every `reasoning_declare` call failed —
so a third-party Step key never received `reasoningEfforts` and never got a dial.

0.3.0:

1. **Both host generations**: `describe()` first, `get()/read()` as a fallback, and the probe
   result is reported as `settingsAccess` so the next host change is a diagnostic, not a
   silent "no dial".
2. **Write path**: `mutate()` path-ops first, nested `update()` patch as fallback,
   one automatic retry on `SETTINGS_CONFLICT` after re-reading the revision.
3. **`off` semantics**: writes `off: null` ("supported, send nothing") instead of
   `off: "off"`, which would put `reasoning_effort: "off"` on the wire.
4. **Read-back verification**: after a write the namespace and the host's
   `resolveModelInfo` are read again, reporting `dialEfforts` (what the picker actually renders)
   and `hostEfforts`.
5. **`reasoning_patch`**: renders the paste-ready `cordis.patch.yml` YAML without writing; a
   failing `reasoning_declare` returns the same snippet.
6. **Batch and dry run**: `models: [...]` and `dryRun: true`.
7. **Default ladder narrowed to `off,low,medium,high`**: `xhigh`/`max` appear only when you
   name them (host rule), so providers that never heard of `Max` no longer get a fake option.

## Install

**UI** — Settings → Plugins → Add plugin, pick this directory.

**CLI**

    dsh plugin add <path-to-this-directory>

**Manual** — copy/link into `<profile>/node_modules/`, add
`"dsh-reasoning-dial"` to `dsh.profile.bundles` and to `dependencies`.

Then confirm the `reasoning-dial` row is enabled under Settings → Plugins.

## Tools

### `reasoning_scan` — diagnose

Lists every model in every custom provider with its state: `inherit` (not declared — *this is
why the dropdown is missing*), `absent`, `none`, `levels`. Each model also reports
`source` (`declared` / `catalog` / `none`), `dialEfforts` (what the picker will render),
`hostEfforts`, `api` and `apiKeyEnv`. Top-level `settingsAccess` and
`layers[].settingsVia / settingsError` answer "why can't it write". Read-only, no network.

### `reasoning_declare` — the main operation

    {
      "provider": "stepfun",
      "model": "step-3.7-flash",
      "mode": "levels",                    // levels | none | inherit
      "levels": ["off", "low", "medium", "high"],
      "wire": { "high": "high" },          // optional per-level wire spelling
      "dryRun": false                      // optional: report only, write nothing
    }

- `mode=levels` — declare the offered levels; the dropdown appears
- `mode=none` — declare a non-reasoning model (`reasoningEfforts: false`)
- `mode=inherit` — drop the declaration, fall back to the catalog
- `models: ["a","b"]` — declare several models at once
- `wire` — level → wire value. Default is the level name itself (OpenAI style); override it
  for a gateway that wants something else. `wire: { "off": "none" }` sends
  `reasoning_effort: "none"` for Off, while the default `off: null` sends no field at all.

### `reasoning_select` — pick the active level

    { "provider": "stepfun", "model": "step-3.7-flash", "effort": "high" }

`effort` is one of `off / minimal / low / medium / high / xhigh / max`, or `inherit` to
`unset` the field. The chosen level is verified against the host's supported list; an
unsupported one returns a `warning`.

### `reasoning_probe` — does the provider honour it?

One minimal prompt at two levels, compared. Separates "declared but ignored" from "actually
effective". Sends real requests; disable it with `allowProbe: false`.

### `reasoning_patch` — YAML only

Renders the `reasoningEfforts` block for manual `cordis.patch.yml` editing. Writes nothing.

## Settings

| Key | Default | Meaning |
|---|---|---|
| `namespaces` | `llm-pi-ai` | comma-separated settings namespaces that hold custom providers |
| `levels` | `off,low,medium,high` | default ladder (`xhigh`/`max` must be named) |
| `wireMode` | `identity` | level → wire default: `identity` or `lower` |
| `autoDeclare` | `false` | backfill the default ladder at boot for undeclared models |
| `allowProbe` | `true` | allow `reasoning_probe` to send real requests |
| `agentTools` | `true` | register the tools |
| `readProfileConfig` | `true` | fall back to parsing the profile `cordis.patch.yml` when settings cannot answer |

## Typical flow

    1. reasoning_scan                       # what is inherit, and is settingsAccess sane
    2. reasoning_declare provider=stepfun model=step-3.7-flash
    3. refresh the model picker              # patchReload: live applies without a restart
    4. reasoning_select effort=high
    5. reasoning_probe                       # optional: is the level really honoured

### StepFun note (measured)

`api.stepfun.com` (`step_plan/v1` and `v1` alike) accepts `reasoning_effort` without
validating the enum — any string returns 200 — and its models think by default (responses
always carry `reasoning_content`). So the dial appears, selects and never errors, but the
effect on thinking depth is not stable (low vs high reasoning length is noise-level).
Whether `Off` really stops thinking is decided by the provider; use `reasoning_probe` to
observe it rather than treating the dial as a switch.

## Tests

    npm test        # = node --test test/plugin.test.mjs

`test/plugin.test.mjs` runs everything against a mock host — both settings generations
(`describe()` and `get()`), `SETTINGS_CONFLICT` retry, `update()` fallback, `dryRun`, batch
declaration, `off: null` semantics, `xhigh/max` visibility, selection verification and
`unset`. No running Harness required.

## Limits

1. **A declaration is a claim about the wire, not magic.** The plugin only writes settings; it
   cannot make a provider support a parameter. If the gateway ignores `reasoning_effort`, the
   dial appears but does nothing — verify with `reasoning_probe`.
2. **Writes go through the host settings service**, which lands in the profile
   `cordis.patch.yml` via the host `configEditor`. `settingsAccess` reports the interface it
   found; if a future host changes it again the tools say which method is missing instead of
   failing silently.
3. **Write granularity**: a path-op replaces a whole array, so each save rewrites that
   provider's entire `models` array. The plugin reads, patches and writes back, preserving
   fields it does not understand.
4. No credential is read or changed; nothing outside the configured namespaces is written.

## License

MIT
