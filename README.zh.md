# dsh-reasoning-dial

让**任意自定义 API 模型**都能设置推理等级。

## 它解决什么问题

DSH 自带 Off / Low / Medium / High / XHigh / Max 推理档位，但这个拨盘**只对目录里声明了
`reasoningEfforts` 的模型出现**。内置路线（DeepSeek / opencode-go 目录里的模型）声明了；
你自己加的第三方 API provider（StepFun 的 step-3.x / step-5、各种 GPT 兼容网关、自建网关……）
大多**不带这个字段**，于是：

- 模型选择器里根本没有推理等级下拉框
- 你想调也调不了，只能吃模型自带的默认档

本插件把推理等级当成**普通设置数据**来读写，不再依赖内置能力声明：

| 设置位置 | 作用 |
|---|---|
| `llm-pi-ai.providers.<名>.models[].reasoningEfforts` | 声明这个模型有哪些档位可选（**决定下拉框出不出现**） |
| `agent-default-model.reasoningEffort` | 当前生效的那一档 |

## 0.3.0 修了什么（重要）

0.2.x 在**新宿主上完全写不进去**：宿主 `dsh-settings` 的服务代际换了 ——
不再有 `get()/read()`，改成 `describe()` 返回
`[{ ns, revision, value, user, base, applies }]`，写入是
`mutate()/update()/replace()`。0.2.x 用 `get||read` 判定「可读」，
于是在新宿主上直接判定「没有 settings 服务」，`reasoning_declare` 永远失败，
stepfun 之类的自定义 provider 也就永远拿不到 `reasoningEfforts`。

0.3.0 做的改动：

1. **两代宿主都认**：`describe()` 优先，`get()/read()` 兜底；工具输出里直接报告探测到的形状
   （`settingsAccess`），下次宿主再变一眼就能看出来。
2. **写路径适配 `mutate()`**：用 path-op（`providers.<p>.models` / `reasoningEffort`），
   没有 `mutate` 时退回 `update()` 的嵌套 patch；遇到 `SETTINGS_CONFLICT` 自动重读
   revision 重试一次。
3. **`off` 语义修正**：默认写 `off: null`（= 不发送任何字段），不再写 `off: "off"`
   （那会把 `reasoning_effort: "off"` 发上线）。
4. **写后回读校验**：声明完立刻重读命名空间并用宿主 `resolveModelInfo` 回读，
   告诉你 `dialEfforts`（选择器真正会渲染的档位）与 `hostEfforts`。
5. **新增 `reasoning_patch`**：不写设置，只吐出可粘贴进 `cordis.patch.yml` 的 YAML；
   settings 不可用时 `reasoning_declare` 的失败结果里也会附这段 YAML。
6. **批量 / 预演**：`models: [...]` 一次声明多个；`dryRun: true` 只回显不落盘。
7. **默认阶梯收敛为 `off,low,medium,high`**：`xhigh`/`max` 只有你明确写出来才会出现在
   选择器里（宿主规则），不会再出现「选了 Max 但供应商根本没这个概念」。

## 安装

插件是个标准 DSH bundle。三种方式任选：

**方式 1 — 官方界面（推荐）**
`设置 → 插件 → 添加插件`，选择本目录（含 `package.json` 的这一层）。

**方式 2 — CLI**

    dsh plugin add F:\everyAI\dsh-reasoning-dial

**方式 3 — 手动挂载**
把本目录软链/复制到 `.dsh\profiles\desktop\node_modules\` 下，再在
`profiles\desktop\package.json` 的 `dsh.profile.bundles` 里加一行
`"dsh-reasoning-dial"`，并加一条同名 dependency。

装完在 `设置 → 插件` 里确认 `reasoning-dial` 这一行是启用状态。

## 五个工具

### `reasoning_scan` — 体检

列出所有自定义 provider 里的模型，以及每个模型的声明状态：

- `inherit` — 没声明 → **这就是你没有下拉框的原因**
- `absent` — 宿主有这个路由，但 provider 的 models 里没列它
- `none` — 明确声明不推理
- `levels` — 已声明，附档位和线上拼写

每个模型还会带上：

| 字段 | 含义 |
|---|---|
| `source` | `declared`（插件声明）/ `catalog`（宿主内置目录已知）/ `none` |
| `dialEfforts` | 选择器**真正会渲染**的档位（按宿主规则算过） |
| `hostEfforts` | 宿主 LLM 服务当前报告的档位 |
| `api` / `apiKeyEnv` | 该 provider 的协议与环境变量名（不读、不回显密钥） |

顶层 `settingsAccess` 与 `layers[].settingsVia / settingsError` 就是「为什么写不进去」的答案。
只读，不发网络请求。

### `reasoning_declare` — 核心操作

    {
      "provider": "stepfun",
      "model": "step-3.7-flash",
      "mode": "levels",                    // levels | none | inherit
      "levels": ["off", "low", "medium", "high"],
      "wire": { "high": "high" },          // 可选，逐档覆盖线上拼写
      "dryRun": false                      // 可选，true 只回显
    }

- `mode=levels` — 声明可选档位，下拉框立刻出现
- `mode=none` — 明确这个模型不推理（选择器不再提供思考档位）
- `mode=inherit` — 删掉声明，交回默认
- `models: ["a","b"]` — 一次声明多个模型
- `wire` — 关键：**档位到线上字段值的映射**。默认用档位名本身（OpenAI 风格）。
  你的网关要别的拼写就在这覆盖；`wire: { "off": "none" }` 表示 off 档发送
  `reasoning_effort: "none"`（默认 `off: null` = 不发字段）。

### `reasoning_select` — 选档

写 `agent-default-model`，一次到位：

    { "provider": "stepfun", "model": "step-3.7-flash", "effort": "high" }

`effort` 可以是 `off / minimal / low / medium / high / xhigh / max`，或 `inherit`
（`unset` 掉字段、用模型默认档）。写完会回读校验：这一档不在宿主支持列表里时直接给出
`warning`。

### `reasoning_probe` — 实测

同一句最小提示词，分别以低档和高档各请求一次，比较结果。用来区分「声明了但线上忽略」
和「真的生效」。会真的发请求，可在设置里关掉。

### `reasoning_patch` — 只出 YAML

不写任何设置，直接给出可粘贴进 `cordis.patch.yml` 的 `reasoningEfforts` 片段，
用于手工管理配置、或 settings 服务不可用时。

## 插件设置

| 项 | 默认 | 说明 |
|---|---|---|
| `namespaces` | `llm-pi-ai` | 逗号分隔。自定义 provider 住在哪些设置命名空间里 |
| `levels` | `off,low,medium,high` | 默认提供哪些档位（`xhigh`/`max` 需显式写出） |
| `wireMode` | `identity` | 档位→线上值的默认映射：`identity`（原样）/ `lower`（转小写） |
| `autoDeclare` | `false` | 启动时自动给未声明的模型补默认阶梯。**默认关**：错误声明比不声明更糟 |
| `allowProbe` | `true` | 是否允许 `reasoning_probe` 发真实请求 |
| `agentTools` | `true` | 是否注册这些工具 |
| `readProfileConfig` | `true` | settings 读不到 provider 时退回解析 profile 的 `cordis.patch.yml` |

## 使用流程

    1. reasoning_scan                        # 看哪些模型是 inherit，settingsAccess 是否正常
    2. reasoning_declare provider=stepfun model=step-3.7-flash
    3. 刷新模型选择器                        # 下拉框出现（patchReload: live 时无需重启）
    4. reasoning_select effort=high          # 选档
    5. reasoning_probe                       # 可选：验证线上真的吃这一档

### StepFun（step-3.x / step-5）实测备注

`api.stepfun.com` 的 `step_plan/v1` 与 `v1` 两个 baseURL 都接受 `reasoning_effort` 字段
（不校验枚举：任意字符串都返回 200），并且**默认就带思考**（响应里始终有
`reasoning_content`）。所以：

- 拨盘能出现、能选、请求不会报错；
- 档位对思考深度的实际影响不稳定（低/高档的 reasoning 字符数差异属噪声量级）；
- `Off` 能不能真的关掉思考由供应商侧决定，声明做不到这一点 —— 用 `reasoning_probe`
  观察即可，别把它当开关。

## 自测

    npm test        # = node --test test/plugin.test.mjs

`test/plugin.test.mjs` 用一个 mock 宿主跑通全部路径：`describe()` 代际、`get()` 旧代际、
`SETTINGS_CONFLICT` 重试、`update()` 兜底、`dryRun`、批量、`off: null` 语义、
`xhigh/max` 仅在显式声明时出现、选档校验与 `unset`。不需要 DSH 在跑。

## 已知边界（重要）

1. **声明是"关于线上的声明"，不是魔法。** 插件只写设置，不会让你的供应商凭空支持某个参数。
   如果网关不认 `reasoning_effort`，下拉框会出现但选了没效果 —— 先用 `reasoning_probe` 验证。
2. **写的是宿主 settings 服务**，落盘位置就是 profile 的 `cordis.patch.yml`（host 侧
   `configEditor` 负责合并）。`settingsAccess` 会报告探测到的接口形状；如果哪天宿主再换接口，
   工具会直接说清楚缺哪个方法，而不是静默失败。
3. **写粒度**：path-op 只能整体替换数组，所以每次保存都会重写该 provider 的整个
   `models` 数组。插件先读再改再写，未识别字段原样保留。
4. 不改动任何凭据，不写配置命名空间以外的任何设置。

## 许可

MIT
