# 第一阶段验收记录

2026-11-16，工作区版本；未提交、未部署。本次补齐真实模型驱动的图表任务验收，并修正模型适配器将空的可选图表字段序列化为对象时的兼容处理。

## 数据库集成

使用一次性 `postgres:16-alpine` 容器，加载 `scripts/seed/postgres.sql`，使用 `ro_analyst` 账号；MySQL 使用既有测试连接。

运行 `tests/integration/*.test.ts`：**19 项通过，0 失败，0 跳过**。真实 PostgreSQL 控制连接取消测试约 2.14 秒完成，MySQL 对应测试约 2.06 秒完成。

已覆盖：

- SELECT、结果存储、只读权限、工作区视图创建/查询/删除、生产环境限制、EXPLAIN、查询预算。
- 控制连接取消运行中的查询，取消后继续使用同一会话。
- SQL 错误和行数截断后继续查询。
- PostgreSQL 正常查询、错误、流式提前结束及 EXPLAIN 后，协议事务状态均回到 `I`（idle）。查询执行时 `transaction_read_only` 为 `on`。

复现可使用 README 的 Docker 集成测试步骤。将 `DATA_AGENT_TEST_PG` 指向真实 PostgreSQL，并确保 `DATA_AGENT_TEST_PGLITE` 未设为 `1`。PGlite 的并发取消限制仍存在，不能用其跳过结果替代上述验收。

## 浏览器与实际文件

使用 ego-browser 专用测试空间，运行当前 `web/index.html` 和实际 HTTP API。数据通过 `DbSession` 从上述 PostgreSQL 的 `sales` 表查询，由 `ArtifactService` 编译并持久化；关闭数据库会话后，从历史记录读取图表。

| 验收项 | 观察结果 |
| --- | --- |
| 柱状图 → 折线图 | 页面 ECharts series 类型变为 `line` |
| PNG 下载 | 柱状图和折线图分别保存成功，均为 2738×600；文件哈希不同；直接查看折线 PNG，图形和中文标题正确 |
| SVG 下载 | 成功保存 SVG，包含中文标题；下载时当前图形为折线 |
| 图表 CSV | UTF-8 BOM、CRLF；投影列 `region,total`，包括 `US,560.74` |
| 原始结果 CSV | 通过结果抽屉下载，包含 `region,orders,total` 和 `US,3,560.74` |
| 数值引用 | 点击 `#cell[region=US]`，显示精确字符串值 `560.74`、原始 SQL、执行时间、结果 ID 和快照行 |
| 热力图 | 3 列×4 行，9 个数据点；3 个缺失格保留空白，提示缺失不是 0 |
| 展开数据 | 热力图数据表显示 9 条记录；展开时 PNG 仍可下载 |
| 历史重载 | 最终仍为 2 张图；旧 ECharts 实例的 `isDisposed()` 为 `true` |
| 导出审计 | 记录图表 CSV 和原始结果 CSV 的请求，各包含会话、所有者和行数；不把本地图片导出计入服务器审计 |

本地证据保存在 `.tmp/acceptance-20261112/`（被 Git 忽略）：`bar.png`、`line.png`、`line.svg`、`heatmap.png`、`chart.csv`、`result.csv`、`downloads.json`、`ui-checks.json`、`lifecycle.json`、`exports.ndjson`。浏览器脚本同目录保存；需要运行中的本地测试服务及当前任务空间，不能直接用旧空间 ID 重放。

浏览器自动滚动在嵌套聊天区域中曾无法定位可见按钮；显式滚动后完成检查。另一次历史重载断言发生在异步请求完成前，改为等待旧图表实际释放后通过。这两项属于验收脚本的定位/等待问题，本轮没有修改产品代码。

## 真实模型端到端

使用隔离的临时服务数据目录和 PGlite PostgreSQL wire-protocol 数据库，先调用 `POST /v1/model/test` 验证模型渠道，再提交自然语言目标；模型渠道为本机 pi 凭据中已配置的 `grok-envision/grok-4.7`，未输出或写入 API 密钥。完整链路 **通过**：

- 模型完成 `catalog_search`、`object_describe`、`query_execute`，按 `region` 汇总 `sales`，并主动调用 `chart_create`。
- 任务状态为 `succeeded`，5 turns、1 个查询、1 个柱状图产物；SSE 包含成功的 `chart_create` 和终态事件。
- 产物可从任务、`GET /v1/artifacts/{id}` 和会话产物列表读取；图表快照 4 个点，结果未截断，ECharts option 已持久化。
- 模型答案引用 `art_…#cell[region=US]`；通过引用 API 解析回精确字符串 `560.74`、对应快照行和原始 SQL。
- 模型未创建视图或数据集；退款率最高的 LATAM（50%）和金额最高的 US（560.74）与种子数据一致。

验收过程中发现并修复了两个模型边界问题：模型适配器可能把未使用的 `y`/`series` 序列化为空字段，或把与 `x` 相同的字段重复作为 `series`；`normalizeChartSpec` 现在将这些值归一化为未提供，并有回归测试。第一次使用 DeepSeek 渠道的调用被服务商以 `402 Insufficient Balance` 拒绝；这属于外部账户余额限制，不是应用失败。随后使用可用的 Grok 渠道完成上述验收。


## 覆盖范围

本记录现在同时包含预置历史/浏览器链路和真实模型驱动链路。前者验证存储、HTTP、导出与控制台恢复；后者验证自然语言目标到 SQL、图表工具、引用和持久化的实际模型选择。两者均不替代 Doris/StarRocks 真实服务兼容验收或生产运行治理。

