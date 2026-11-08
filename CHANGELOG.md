# Changelog

## 0.3.0

修复「第三方 API key（StepFun / 自建网关等）接进来后，推理等级拨盘完全不出现」的根因，
并把声明结果变成可验证的。

### Fixed

- **新宿主上完全无法写入**。`dsh-settings` 的服务代际已换成
  `describe() / mutate() / update() / replace()`，不再提供 `get() / read()`。
  0.2.x 以 `get||read` 判定可读，于是把 settings 服务判成「不存在」，
  `reasoning_declare` 永远返回「宿主没有暴露可读写的 settings 服务」，
  自定义 provider 永远拿不到 `reasoningEfforts`。
  现在 `describe()` 优先、旧 `get()/read()` 兜底，工具输出里直接报告探测形状。
- **写入路径**：优先 `mutate()` 的 path-op，没有 `mutate` 时退回 `update()` 的嵌套 patch；
  遇到 `SETTINGS_CONFLICT`（宿主 revision 已被别处改动）自动重读 revision 重试一次。
- **`off` 档语义**：默认写 `off: null`（宿主读作「支持，且不发送任何字段」），
  不再写 `off: "off"`（那会让线上真的收到 `reasoning_effort: "off"`）。
- **`dialEfforts` 计算**：按宿主 `resolveModelReasoning` + pi-ai
  `getSupportedThinkingLevels` 的实际规则推导——未写出的档位会被钉成 `null`（不可选），
  只有 `off: null` 例外，`xhigh`/`max` 必须显式写出才出现。
- **patch 缓存**：写入后立刻失效，避免下一次 scan 读到旧 YAML。

### Added

- `reasoning_scan` 输出 `settingsAccess`、`layers[].settingsVia / settingsRevision /
  settingsApplies / settingsError`，以及每个模型的 `source`（declared / catalog / none）、
  `api`、`apiKeyEnv`、`dialEfforts`。
- `reasoning_declare` 支持 `models: string[]` 批量声明与 `dryRun: true` 预演；
  失败结果附带可直接粘贴的 `cordis.patch.yml` YAML 片段。
- 新工具 `reasoning_patch`：只生成 YAML，不写任何设置。
- `reasoning_select` 写后回读校验，档位不被模型支持时给出 `warning`；
  `effort=inherit` 走 `unset` 而不是写占位值。
- `test/plugin.test.mjs`：15 条用例，mock 宿主的 `describe()` / `get()` 两代接口，
  覆盖写入、冲突重试、`update()` 兜底、批量、预演、`off` 语义、`xhigh/max` 可见性、
  选档校验与 `unset`。`npm test` 即可跑。

### Changed

- 默认阶梯从 `off,low,medium,high,max` 收敛为 `off,low,medium,high`：`max` 只在显式声明时
  出现，避免给不认这一档的供应商造出一个假选项。
- `wireMode` 去掉 `none`（它会产出空字符串，宿主直接拒收）；要「不发送字段」请用
  `reasoningEfforts: false`（`mode=none`）或 `off: null`。
- `package.json` 增加 `scripts.test`。

### Compatibility

- 宿主 `dsh-settings` 两代接口都能跑；旧宿主走 `get()/read() + update()` 路径。
- 只在 `llm-pi-ai`（可配置多个）与 `agent-default-model` 两个命名空间内读写，
  不触碰凭据，不改 `providers` 里未识别的字段（整体读改写，其余字段原样保留）。

## 0.2.1

- 从 profile 的 `cordis.patch.yml` 读取自定义 provider 目录，修复「只声明在 patch 里的
  provider 一个都扫不到」。

## 0.2.0

- 首个公开版本：`reasoning_scan` / `reasoning_declare` / `reasoning_select` /
  `reasoning_probe`，把 `reasoningEfforts` 当成普通设置数据读写。
