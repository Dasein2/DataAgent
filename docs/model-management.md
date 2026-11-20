# 独立模型管理与服务器部署

Data Agent 使用 pi SDK 调用模型，但**不依赖 pi CLI 的个人配置目录**。网页「模型配置」里的「模型管理」是项目自己的渠道管理器。它参考了 pi 的渠道/模型结构，以及 [pi-web](https://github.com/agegr/pi-web) 的草稿编辑、模型发现和最小请求测试流程；存储与权限边界由本项目独立管理。

## 首次配置

1. 打开「模型配置 → 新建渠道」。填写唯一渠道标识、显示名称、API 协议和 Base URL。
2. 填写 API key；本地 Ollama / vLLM 等无鉴权服务可选「本地 / 无鉴权服务」（适配器可能仍发送占位 key，上游需忽略它）。
3. 添加一个或多个模型。ID 必须与接口接受的标识一致；显示名称、上下文窗口、最大输出和思考/图片能力可以分别配置。
4. 也可以点「从接口获取」读取上游模型列表，**勾选**需要的模型后加入草稿。发现列表只报告模型 ID/名称，不猜测上下文或思考能力，请核对默认参数。
5. 点「测试草稿」发送一次最小请求。测试不保存配置，也不切换默认模型。
6. 「保存渠道」，选择模型与思考强度，然后「设为默认」。新建会话使用新配置，已有会话保留原模型和凭证快照。

支持 `openai-completions`、`openai-responses`、`anthropic-messages`、`google-generative-ai`。OAuth 登录、Bedrock/Vertex 的环境身份等不是此编辑器管理的凭证类型，仍可使用已有兼容配置路径。

### 编辑与删除

- 一个渠道可保存多个模型，渠道之间的密钥完全隔离。
- API key 留空 = 保持不变；勾选清除 = 删除该渠道保存的 key。
- 修改地址或协议后必须重新输入或清除已有 key / 私有请求头，避免凭证被无意发到新服务器。
- 私有请求头用 JSON 输入；留空保持，`{}` 清空。它们不会回显或进入配置导出。
- 「复制渠道」复制模型与端点配置，**不复制已有凭证**。副本需要新标识和自己的密钥。
- 当前默认渠道不能直接删除；先切换到其他渠道。当前默认模型也不能直接从列表移除。
- 未保存更改在切换编辑对象时会有确认提示。

### 聊天输入框与会话级模型

- 输入框下方的模型按钮只切换**当前会话**，不会修改全局默认模型，也不会改变其他已打开会话。搜索支持渠道名、模型名与模型 ID；可收藏模型，并用方向键、Enter、Esc 操作选择器。
- 模型切换只允许在任务空闲时进行。渠道凭证缺失、模型不存在或切换失败时保持原选择，不会自动换用其他渠道的凭证。
- 选择上下文容量更小的模型，或当前上下文达到目标容量的 80% 时，会先显示确认提示。提示使用 SDK 的当前上下文估算，而非累计 Tokens；用量未知时明确标注未知。达到/超过目标容量时，下次请求可能自动压缩历史或失败。切换本身不删除原始对话。
- 会话选择保存在历史快照中，刷新页面、恢复连接或重启服务后继续使用所选渠道和模型。管理员后来修改凭证只影响新建/主动切换/重连的运行时，其他活跃会话保留原凭证快照。
- 普通账号可为自己的会话选择管理员已配置的模型；不能新增渠道、查看凭证或修改全局默认。会话接口不要求开启全局模型编辑权限。

输入框使用 Enter 发送、Shift + Enter 换行（保留 Ctrl/⌘ + Enter 发送），支持中文输入法组合输入及自动增高。分析运行中可点击用户消息的「复制」「编辑重发」；编辑仅回填草稿，不中断任务、不改写旧消息。任务结束后发送修改后的草稿会追加新消息。取消编辑会恢复之前的草稿。模型回答边生成边渲染 Markdown，支持复制 Markdown 原文和单独复制代码块；上翻阅读历史时不会强制滚动到底部。

### 高级兼容性

渠道和模型可配置 `compat` JSON（目前支持标量配置项，如 `supportsDeveloperRole`、`supportsReasoningEffort`、`maxTokensField`、`thinkingFormat`）。模型可额外配置 `thinkingLevelMap`，例如：

```json
{"minimal": null, "low": "low", "high": "high", "xhigh": "xhigh", "max": "max"}
```

只有上游真的支持时才声明扩展档位。SDK 会把不支持的档位限制到模型的可用范围。这里只描述已验证的兼容差异，不自动推测。

## 持久化与迁移

所有文件都位于 `DATA_AGENT_DATA_DIR`：

| 文件 | 内容 |
| --- | --- |
| `model-providers.json` | 项目渠道与模型定义，无 key、无私有请求头 |
| `model-provider-secrets.json` | 项目渠道的 key 和私有请求头，按渠道隔离 |
| `model-settings.json` | 默认 provider/model/thinking 及旧式单模型覆盖 |
| `model-key.json` | 兼容旧式编辑器保存的 key，不与新渠道凭证混用 |
| `pi/models.json` | SDK 的生成目录，非配置源；不含项目渠道凭证 |

设置 `DATA_AGENT_PROFILE_SECRET_KEY` 时，项目渠道凭证使用 AES-256-GCM 加密；未设置时以 0600 明文文件保存。0600 在 Windows 或部分挂载文件系统不保证权限隔离，生产应设置加密主密钥，并配置磁盘/目录访问权限。

迁移服务器时备份整个 data 卷和加密主密钥；**主密钥不要与备份公开放在一起，也不要随意更换**。仅复制加密文件而丢失主密钥会导致凭证不可用。

「导出配置 JSON」不包含凭证，可用于共享非敏感模型定义。导入不会覆盖同名渠道；修改标识后再导入。多渠道文件按条导入，如果中途失败，界面明确显示已导入数量。需要完整迁移凭证时使用服务端 data 卷备份，而不是导出按钮。

存储文件损坏时不会静默覆盖为空。请先恢复文件或加密主密钥。

## 可选 pi 导入

- 开发环境保留原来的 pi 只读集成。
- 「从 pi 迁移渠道」把某个自定义渠道复制到一个新项目标识，包含可读取的字面量 key。导入后保存为项目自己的配置，不再依赖 pi 文件；不会写回 `~/.pi/agent/`。
- `!command` / `$ENV` 形式的凭证表达式不会通过网页执行；导入此类配置后需要自行输入字面量凭证。OAuth 凭证不复制。
- `DATA_AGENT_PI_IMPORT=0` 完全关闭外部 pi models/settings/auth 的读取。生产环境默认关闭，开发环境默认开启。

独立渠道定义优先于同名 pi 渠道。它不会借用同名 pi/.env 的 key；项目渠道仅使用它自己保存的凭证。

## 推荐服务器配置

```dotenv
NODE_ENV=production
DATA_AGENT_REQUIRE_AUTH=1
DATA_AGENT_ADMIN_PASSWORD=<仅首次启动使用，至少 8 个字符>
DATA_AGENT_PROFILE_SECRET_KEY=<独立生成并妥善保管的加密主密钥>
DATA_AGENT_ALLOW_MODEL_EDIT=1
DATA_AGENT_PI_IMPORT=0
DATA_AGENT_DATA_DIR=/data
```

不必设置 `DATA_AGENT_MODEL_PROVIDER` / `DATA_AGENT_MODEL_ID` / key。初始可无模型凭证启动，进入网页后添加渠道并设为默认。

这些是**服务器全局配置**。账号模式下只有管理员可访问模型管理；普通用户共用已配置的模型，但看不到其他账号的连接或分析历史。关闭账号模式时，可继续用 `DATA_AGENT_API_TOKEN`；启用模型编辑后，持有该 token 的客户端可以修改全局配置。账号初始化、密码重置及 HTTPS 部署说明见 [README](../README.md#account-login-and-private-connections)。

Docker Compose 已挂载 `/data`，无需挂载任何个人 pi 目录。请在 `.env.prod` 设置上述变量；非生产环境仍可用 `.env` 固定模型，旧式单模型编辑 API 继续兼容。

## HTTP API

以下路由均需服务认证；写入、测试草稿、模型发现、pi 导入需要 `DATA_AGENT_ALLOW_MODEL_EDIT=1`。读取不回显任何凭证。

| Method | Path | 用途 |
| --- | --- | --- |
| GET | `/v1/model/providers` | 独立渠道目录、默认模型、凭证状态 |
| PUT | `/v1/model/providers/:id` | 校验并保存一个完整渠道；key 可省略/null/新值 |
| DELETE | `/v1/model/providers/:id` | 删除非默认渠道及凭证 |
| POST | `/v1/model/providers/:id/test` | `{config, modelId}` 测试草稿，不保存 |
| POST | `/v1/model/providers/:id/discover` | 用草稿配置读取模型列表 |
| POST | `/v1/model/import-pi` | `{sourceId, targetId}` 一次性复制自定义 pi 渠道 |
| POST | `/v1/model/select` | `{provider, modelId, thinkingLevel?}` 设置默认模型并持久化 |
| GET | `/v1/sessions/:id/models` | 会话所有者可见的模型目录，不含密钥、端点或操作系统路径 |
| POST | `/v1/sessions/:id/model` | `{provider, modelId, thinkingLevel?}` 仅切换该会话；忙碌时返回 409 |

最后两个接口属于会话操作：按会话所有者鉴权，普通账号也可调用，不受 `DATA_AGENT_ALLOW_MODEL_EDIT` 限制。

保存示例：

```json
{
  "name": "团队网关",
  "api": "openai-completions",
  "baseUrl": "https://gateway.example.com/v1",
  "apiKey": "<write-only>",
  "models": [
    {"id": "team-model", "reasoning": true, "contextWindow": 128000, "maxTokens": 16384}
  ]
}
```

发现模型超时 10 秒，响应限制 2 MB，拒绝重定向；草稿测试超时 20 秒。测试会产生少量真实模型费用（浏览器 QA 与自动测试均使用本地假上游）。
