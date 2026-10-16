# dsh-reasoning-dial

让**任意自定义 API 模型**都能设置推理等级。

## 它解决什么问题

DSH 自带 Off / Low / Medium / High / XHigh / Max 推理档位，但这个拨盘**只对目录里声明了
`reasoningEfforts` 的模型出现**。内置的 DeepSeek 路线声明了；你自己加的自定义 API
provider（StepFun、各种 GPT 兼容网关、自建网关……）全都**不带这个字段**，于是：

- 模型选择器里根本没有推理等级下拉框
- 你想调也调不了，只能吃模型自带的默认档

本插件把推理等级当成**普通设置数据**来读写，不再依赖内置能力声明：

| 设置位置 | 作用 |
|---|---|
| `llm-pi-ai.providers.<名>.models[].reasoningEfforts` | 声明这个模型有哪些档位可选（**决定下拉框出不出现**） |
| `agent-default-model.reasoningEffort` | 当前生效的那一档 |

## 安装

插件是个标准 DSH bundle。三种方式任选：

**方式 1 — 官方界面（推荐）**
`设置 → 插件 → 添加插件`，选择本目录（含 `package.json` 的这一层）。

**方式 2 — CLI**
```bash
dsh plugin add F:\harness\DeepSeekharness\workstation\dsh-reasoning-dial
```

**方式 3 — 手动挂载**
把本目录软链/复制到
`F:\DeepSeek_harness\.dsh\profiles\desktop\node_modules\` 下，
再在 `profiles\desktop\package.json` 的 `dsh.profile.bundles` 里加一行
`"dsh-reasoning-dial"`，并加一条同名 dependency。

装完在 `设置 → 插件` 里确认 `reasoning-dial` 这一行是启用状态。

## 四个工具

装好后 Agent 侧会多出四个工具（也可以让 Agent 替你调）：

### `reasoning_scan` — 体检
列出所有自定义 provider 里的模型，以及每个模型的声明状态：

- `inherit` — 没声明 → **这就是你没有下拉框的原因**
- `none` — 明确声明不推理
- `levels` — 已声明，附档位和线上拼写

同时附上宿主 LLM 服务报告的原始能力（`hostEfforts`），方便交叉验证。
只读，不发网络请求。

### `reasoning_declare` — 核心操作
给任意自定义模型声明推理等级：

```jsonc
{
  "provider": "gptcodex",
  "model": "my-custom-model",
  "mode": "levels",              // levels | none | inherit
  "levels": ["off","low","medium","high","max"],
  "wire": { "low": "reasoning_effort=low" }   // 可选，逐档覆盖线上拼写
}
```

- `mode=levels` — 声明可选档位，下拉框立刻出现
- `mode=none` — 明确这个模型不推理（选择器不再提供思考档位）
- `mode=inherit` — 删掉声明，交回默认
- `wire` — 关键：**档位到线上字段值的映射**。默认用档位名本身（OpenAI 风格）。你的网关如果要别的拼写，在这里逐档覆盖。

### `reasoning_select` — 选档
写 `agent-default-model`，一次到位：

```jsonc
{ "provider": "gptcodex", "model": "my-custom-model", "effort": "high" }
```

`effort` 可以是 `off / minimal / low / medium / high / xhigh / max`，
或 `inherit`（删除设置、用模型默认档）。

### `reasoning_probe` — 实测
同一句最小提示词，分别以低档和高档各请求一次，比较结果。
用来区分「声明了但线上忽略」和「真的生效」。会真的发请求，可在设置里关掉。

## 插件设置

| 项 | 默认 | 说明 |
|---|---|---|
| `namespaces` | `llm-pi-ai` | 逗号分隔。自定义 provider 住在哪些设置命名空间里 |
| `levels` | `off,low,medium,high,max` | 默认提供哪些档位 |
| `wireMode` | `identity` | 档位→线上值的默认映射：`identity`（原样）/ `lower`（转小写）/ `none` |
| `autoDeclare` | `false` | 启动时自动给未声明的模型补默认阶梯。**默认关**：错误声明比不声明更糟 |
| `allowProbe` | `true` | 是否允许 `reasoning_probe` 发真实请求 |
| `agentTools` | `true` | 是否注册这四个工具 |

## 使用流程

```
1. reasoning_scan                       # 看哪些模型是 inherit
2. reasoning_declare  (provider/model)   # 补声明
3. 重启会话 / 刷新模型选择器              # 下拉框出现
4. reasoning_select  effort=high         # 选档
5. reasoning_probe                       # 可选：验证线上真的吃这一档
```

## 已知边界（重要）

1. **声明是"关于线上的声明"，不是魔法。** 插件只写设置，不会让你的供应商
   凭空支持某个参数。如果网关不认 `reasoning_effort`，下拉框会出现但选了没效果 ——
   先用 `reasoning_probe` 验证。
2. **本插件写的是 host 侧 settings 服务。** 它按读到的接口形状做了特性探测
   （`get`/`read` 读取，`mutate`/`update` 写入），但 host 侧 settings 的确切签名
   是按官方客户端插件的用法推断的。如果启动后工具报
   `宿主没有暴露可读写的 settings 服务`，说明该签名不匹配，把报错发我即可。
3. **写粒度**：设置的 path-op 只能整体替换数组，所以每次保存都是重写该
   provider 的整个 `models` 数组。插件会先读再改再写，未识别的字段原样保留。
4. 不改动任何凭据，不写配置命名空间以外的任何设置。

## 许可

MIT
