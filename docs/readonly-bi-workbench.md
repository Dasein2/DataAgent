# 只读 BI 工作台：使用与运维

本次改造以 `4213793` 为基线，源数据仍然严格只读。新增的是发现、查询保护、已保存结果的分析和 BI 表达能力，而不是任意 DDL/DML 通道。

## 1. 日常工作流

1. 在左侧「数据库资产」点击 ＋ 添加连接，填写分组并保存，同一分组的连接会集中展示。用连接下的「新会话」建立分析会话。侧栏支持搜索和收起，收起状态保存在当前浏览器。在高级设置中可记录 IANA 分析时区（如 `Asia/Shanghai`）；它不会偷偷修改数据库 session timezone。
2. 右侧「目录」按数据库（Doris、MySQL、StarRocks）或 Schema（PostgreSQL）分组，默认只展开当前库或默认 Schema。组名旁显示当前连接账号可见的表数（含外部表，不含视图和序列），与展开状态、分页和类型筛选无关；点「刷新目录」重新统计。展开后分批加载对象，可筛选表或视图。搜索会查询连接允许访问的范围，不受已展开目录限制；结果标明名称、注释或字段命中。点击对象可查看字段、概览和已声明的出向外键。断开后，同一页面内已经加载的内容可作为该会话的临时目录快照查看；刷新页面不会保留快照。
3. 提问后，Agent 先利用已有上下文，必要时查看相关表结构和有界样例；明确的问题直接分析，不要求例行确认。发现会影响结果且不能从现有资料确定的业务选择时，显示追问卡片，说明影响并提供有依据的选项。可点选或展开「其他／补充」纠正，之后沿用已获取的上下文继续。可查看工具证据、耗时和剩余查询/轮次。`LIMIT` 只限制返回行，不是扫描成本保证。
4. 在“结果”或报告的结果链接中打开宽屏工作台：50/100/200/500 行分页、跳行、显示列、列类型、页内排序/过滤、完整 SQL 和复制。页内操作**不是全结果计算**。
5. 列统计扫描已保存结果，不再读源库。其范围为已保存行，不是源表统计。去重有封顶、数值统计有近似标记，候选频次不是准确全局 top-K。
6. 使用“本地 SQL 分析”对表 `data` 显式聚合、过滤、排序或 TopN。它生成新结果，不修改原结果或源数据。完整且有界结果可以固定为本地快照。
7. 图表存入不可变 artifact；“图表工作台”集中展示。报告引用可点击查看准确值、来源行、SQL、执行时间。归档只隐藏工作清单，不破坏引用；修改标题生成新版本。
8. 点击连接下的会话即可查看保存的报告、结果和图表。找不到对应连接的会话仍可在「未关联历史」查看。需要继续查询时，在聊天顶部点击「恢复分析」建立连接。恢复后接续原会话，旧查询的事务快照与中断任务不会恢复。

快捷键：`Ctrl/⌘ K` 打开命令面板，方向键/Enter 选择，Esc 关闭 dialog。页头支持明暗主题；窄屏自动重排。前端采用同源原生 ES modules，无 CDN、额外前端构建或运行时 UI 框架。

### 业务资料与会话上下文

- 建立连接后，打开右侧 **业务资料**，新建、编辑或删除 Markdown 文档，例如 GMV 计算规则、事件字段含义或业务过滤条件。
- 点击输入框旁的 **业务上下文**，勾选文档并 **应用到会话**。后续问题继续使用这份选用快照，无需重复上传或勾选。运行中的任务不会切换版本。
- **设为连接默认**只影响同一连接的新会话。新会话读取未删除默认文档的最新版；**恢复分析**则恢复原会话选用的版本（包括空选用）。连接范围按调用方、数据库目标、登录账号和连接路径区分。
- 编辑或删除文档不会改动已有快照，工作台会标注「有新版」或「库中已删除」。重新应用时加载当前勾选项的最新版，并移除未选用项。删除资料库文档不等于删除历史会话中的文档快照、回答或结果。
- 单篇约 2,000 tokens，选用合计约 8,000 tokens（按 UTF-8 大小粗估，实际用量由模型分词决定）。正文会随分析请求发给已配置的模型；不要保存凭证或不应发送给模型的敏感资料。业务资料只提供分析参考，不改变工具授权和数据库只读策略。

**API**：以 `/v1/sessions/{id}/business-context` 为基路径，需要归属当前调用方的活跃会话。`GET` 返回文档摘要、会话选用项、默认 ID 和预算；`POST` 用 `{name, content}` 新建；`GET/PUT/DELETE /{fileId}` 读取、替换或删除文档。`PUT /selection` 用 `{ids:[...]}` 替换本会话选用（`[]` 清空），`PUT /defaults` 保存同一连接的默认 ID。共享 bearer token 的部署应让可信网关覆盖客户端的 `X-Caller-Id`，不要将自报调用方 ID 当作独立鉴权。

## 2. 工具与只读边界

支持执行计划的会话有 20 个通用工具。有可写工作区时加 3 个。各连接按实际能力提供工具。

| 范围 | 工具 |
| --- | --- |
| 按需澄清 | `ask_user`，先了解相关数据，再对无法确定且影响结果的业务选择主动追问；不强制每任务调用。支持点选或「其他／补充」自由回答 |
| 发现 | `session_info`, `catalog_search`, `catalog_overview`, `object_describe`（`objects` 数组，1–20 个表/视图）, `data_profile` |
| 源查询 | `query_execute`, `query_explain` |
| 保存结果 | `result_read`（`mode=rows` 读行，`mode=summary` 看统计）, `result_transform` |
| 本地快照 | `snapshot_create`, `snapshot_list`, `snapshot_drop` |
| 受控工作区 | `dataset_create`, `dataset_list`, `dataset_drop` |
| BI | `chart_create` |
| 任务与图表管理 | `job_get`, `job_cancel`, `chart_list`, `chart_archive`, `chart_revise` |

已经保存的行和列足以回答，就在本地继续分析；存量不足或需要新鲜数据才重新查源。只有后续源库 SQL 需要引用中间对象时才创建工作区数据集。管理工具始终可用；模型只在用户要求时取消 SQL、改名或归档/恢复图表。工具可见性不授予权限：工作区访问、会话归属和只读检查不变。

`GET /v1/tools` 返回服务目录；加 `?session_id=…` 则返回当前调用方活跃会话实际给模型的工具。工作台按当前会话显示。通过 `POST /v1/tasks/{id}/answer` 回答待确认的口径并继续原任务，具体请求格式见 [HTTP API](../README.md#http-api)。

- 模型没有 Bash、任意文件或系统操作工具，也看不到连接凭证。
- 源 SQL 在固定连接上串行；只有元数据使用独立完成只读验证的连接。有界并发不等于复用一个连接并行查询。
- 工作区仍由服务根据 SELECT 生成限定 DDL；生产只允许视图。没有新增源表写入能力。没有工作区也能查询、本地分析及制图。
- 已声明外键和命名推测关系分别标注。声明约束也不代表 JOIN 不会因过滤、重复、历史口径而改变基数，使用前仍需验证。
- `data_profile` 默认 head sample，披露样本行数和偏差；生产拒绝可能全表排序的 random sample。采样消耗查询预算。

## 3. 成本预检与复用

`query_execute` 的参数示例（工具调用，不是单独的 HTTP SQL 执行端点）：

```json
{"sql":"SELECT region, SUM(amount) AS total FROM public.sales WHERE created_at >= '2025-01-01' GROUP BY region", "dry_run":true}
```

- `off`：不自动预检；显式 dry_run 仍检查计划。
- `warn`（默认）：返回成本估算、未知/不支持说明和告警，执行仍受 SQL guard、超时、行/字节和预算约束。
- `enforce`：估算超阈值、未知或不支持时拒绝执行。不能因为计划不可用就把查询当作便宜查询。
- 预检本身消耗查询预算；默认预检后再执行一次 SELECT 通常使用两个预算槽。
- PostgreSQL 汇总 Scan 节点估算，MySQL 递归读取 JSON scan estimates；各引擎成本单位不能横向比较。过滤后估算行数、nested loops、函数、缓存和统计误差都可能使真实工作量不同。**这是规划保护，不是严格物理扫描上限，也不是资源治理器。** 生产仍需要资源组、只读副本和数据库 statement timeout。
- `EXPLAIN ANALYZE` 必须通过 `query_explain(analyze=true)` 显式请求，因为它会执行查询；不能塞进 `query_execute` 绕过策略。

`reuse=true` 显式接受会话内近期结果。键包含**原始精确 SQL 和行数上限**，不会小写字符串、删除注释/hints 或丢掉 LIMIT；对已知易变/会话函数和未知函数保守禁用。返回原执行时间、缓存年龄和 `cached`，不是一次新查询。需要最新源数据时不要开启。

缓存按会话身份隔离，不跨账号复用；元数据可显式刷新。元数据缓存默认 5 分钟，结果复用窗口默认 60 秒，TTL 设 0 可禁用。只读也不能保证用户自定义函数没有副作用；数据库 grants/只读事务和批准视图仍是安全边界。

## 4. 精确本地分析与 lineage

本地只接受 PostgreSQL 方言单条 SELECT/WITH，输入关系为 `data` 和合法 CTE，函数采用分析函数白名单；不开放外部 schema、catalog、任意函数、文件、网络、扩展或用户 DDL/DML。独立进程中执行 PGlite，主进程一次执行一个、最多容纳 8 个执行/排队请求，20 秒终止；SQL statement timeout 为 5 秒、work_mem 为 8 MB、Node heap 为 256 MB。heap 参数不是整个 WASM/进程的 OS 内存硬限制，服务器还应配置容器/进程内存限制。

默认最多 100,000 行、64 MiB、100 列；输入和输出都检查上限。默认拒绝行/字节截断输入，本地分析也拒绝带有截断标记的单元格。显式 `allow_partial` 只接受行/字节不完整，不恢复丢失数据；派生结果仍保留不完整标记，不能据此制完整图。

```sql
-- 精确 numeric 求和与显式排序
SELECT category, SUM(amount) AS total
FROM data
GROUP BY category
ORDER BY total DESC;
```

```sql
-- 显式 TopN + Other，不由图表偷偷删点或聚合
WITH grouped AS (
  SELECT category, SUM(amount) AS total
  FROM data WHERE amount IS NOT NULL GROUP BY category
), ranked AS (
  SELECT category, total, ROW_NUMBER() OVER (ORDER BY total DESC, category) AS rn
  FROM grouped
)
SELECT CASE WHEN rn <= 10 THEN category ELSE 'Other' END AS category,
       SUM(total) AS total
FROM ranked
GROUP BY CASE WHEN rn <= 10 THEN category ELSE 'Other' END
ORDER BY total DESC;
```

> 此例明确排除 amount 为 NULL 的行；若缺失值需单独报告，请另外保留缺失组，不把缺失当 0。若原类别可能真的叫 Other，请改用不会冲突的标签或额外分组键。日期文本需要显式 `::date` / `::timestamp` 转型；它不会替你猜时区和日期类型。

numeric/int8 解码保留十进制字符串，测试覆盖 `9007199254740993.30`，不会经 JS number 二次计算。但源库 float/double 的固有误差不会被修复。图表坐标可用浮点，引用/CSV 保持原快照文本。派生结果含 `lineage.parent_result_id`、操作 SQL 和完整性；artifact source 也保留父链及分析时区。逐级读取父结果可追溯到源 SQL。

快照仅是对已保存结果的命名固定，不触发源抽取、不刷新数据；每会话最多 20 个。模型统一用 `result_transform` 跑本地 SQL：`source: {kind: "result", id: "res_…"}` 或 `source: {kind: "snapshot", id: "snp_…"}`。快照必须完整，不支持 `allow_partial=true`。取消固定不删除原结果。查询执行时间不等于源数据水位，不提供跨查询一致性快照保证。

## 5. 图表约束

支持 `bar`, `line`, `area`, `heatmap`, `table`, `pie`, `donut`, `scatter`, `kpi`。

- 不隐式聚合、补零、删点、按字符串排序或给多系列柱图偷偷堆叠。
- `value_sort=asc|desc` 为明确的单系列数值排序。系列 `stack=none|stacked|percent` 必须明确；百分比模式只改变显示坐标，原值/引用不变。
- 饼/环图最多 20 类、类别唯一、非负且总量为正。TopN + Other 放在源 SQL 或 `result_transform` 中。
- KPI 恰好一行；散点需要数值 x/y/value、坐标键唯一。多个点可能有相同坐标时先明确聚合/重塑，不默默合并。
- 默认最多 30 个系列、20,000 输入行和 3,600 点/格；不完整结果拒绝制图。
- 标题修改产生 revision，不替换原证据；归档不释放任务 artifact 配额。归档清单状态持久化为 sidecar，可在索引丢失后重建；直接引用仍可解析。
- CSV/PNG/SVG 导出动作审计写入 `data/audit/exports.ndjson`。PNG/SVG 在浏览器生成，动作记录不是文件送达证明。图片是图形表达，精确数值请以引用或 CSV 为准。

## 6. 新增 HTTP 接口

沿用 Bearer token 和 caller ownership 校验；`X-Caller-Id` 是受信客户端在共享 token 下的分区标识，不是独立身份认证。公网多租户部署应在反向代理/认证层绑定身份，不能允许互不信任客户端自由冒用同一 token 和 caller id。

| Method | Path | 说明 |
| --- | --- | --- |
| GET | `/v1/sessions/{sid}/catalog/scopes?refresh=true` | 当前会话允许的库/Schema、默认分组及每组可见表数；统计失败时 `table_counts` 为 `null`，目录仍可浏览 |
| GET | `/v1/sessions/{sid}/catalog/objects?schema=public&type=table&limit=50&offset=0` | 分页浏览；也可省略 `schema`、用 `search` 跨可访问范围搜索名称、字段或注释。`nextOffset` 为 `null` 表示无下一页 |
| GET | `/v1/sessions/{sid}/catalog?search=amount&columns=true&refresh=true` | 兼容旧客户端：目录/字段搜索，最多 200 对象 |
| GET | `/v1/sessions/{sid}/object?schema=public&name=sales` | 对象、字段、键和索引 |
| GET | `/v1/sessions/{sid}/datasets` | 会话拥有的工作区数据集 |
| GET | `/v1/results/{rid}?offset=200&limit=100&columns=category,amount` | 已保存结果分页和唯一列名投影 |
| GET | `/v1/results/{rid}/summary` | 有界已保存行统计 |
| POST | `/v1/results/{rid}/transform` | `{sql, allow_partial?}`，返回 `{result}` |
| GET / POST | `/v1/sessions/{sid}/snapshots` | list / `{result_id, name}` |
| DELETE | `/v1/sessions/{sid}/snapshots/{id}` | 取消固定 |
| POST | `/v1/sessions/{sid}/snapshots/{id}/query` | `{sql}`，返回派生结果 |
| POST | `/v1/artifacts/{id}/archive` | `{archived:true/false}` |
| POST | `/v1/artifacts/{id}/export-action` | `{format:"png"/"svg"}` |

HTTP 错误包含 `error.code/message/details`。例如 `QUERY_COST_EXCEEDED` 指向过滤/分区裁剪，`RESULT_ROW_LIMIT` 指向本地/存储上限，`SESSION_UNAVAILABLE` 需要恢复连接，不能盲目重复同一调用。

## 7. 配置默认值

完整示例见 `.env.example`。

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `DATA_AGENT_METADATA_CONCURRENCY` | 2 | 每会话独立元数据连接，限制 1–4，排队上限 64 |
| `DATA_AGENT_METADATA_TTL_MS` | 300000 | 元数据 TTL，0 关闭 |
| `DATA_AGENT_RESULT_CACHE_TTL_MS` | 60000 | 显式复用窗口，0 关闭 |
| `DATA_AGENT_PREFLIGHT` | warn | off / warn / enforce |
| `DATA_AGENT_MAX_ESTIMATED_SCAN_ROWS` | 5000000 | 计划估算阈值 |
| `DATA_AGENT_MAX_ESTIMATED_COST` | 1000000 | 引擎自己的成本阈值 |
| `DATA_AGENT_MAX_LOCAL_ROWS` | 100000 | 本地输入/输出行上限 |
| `DATA_AGENT_MAX_LOCAL_BYTES` | 67108864 | 本地输入/输出字节上限 |
| `DATA_AGENT_MAX_SESSION_BYTES` | 1073741824 | 会话结果存储上限（含派生、失败结果；不是整个 dataDir 磁盘配额） |
| `DATA_AGENT_MAX_CHART_SERIES` | 30 | 图表系列上限 |
| `DATA_AGENT_RETENTION_DAYS` | 0 | 默认不自动清理；正整数开启非活跃历史会话清理 |
| `DATA_AGENT_COLUMN_MASKS` | [] | 精确输出列名 partial/hash/deny 规则 |

每个 live session 最多占用 1 个源连接和配置的元数据连接，另有取消控制连接及 SSH 开销；按 `MAX_SESSIONS` 规划数据库连接总量。服务按单进程数据目录设计；不要把多个写服务指向同一个目录，进程内队列/配额锁不是分布式锁。

保留策略默认关闭。启用后，基于会话最后使用/创建时间，每 30 秒清理超过期限且不在 live map 中的历史会话及其结果、artifact、snapshot、conversation、workspace 文件。主动 purge 也会删除本地证据，已有引用会失效；这与归档不同。审计文件不跟随会话证据自动删除，请单独制定审计轮转/保留策略。运行数据建议放加密磁盘并限制目录权限，定期备份。

列名脱敏在保存结果及 profile 样本输出前执行：`deny` 输出 NULL，`partial` 保留两端，`hash` 使用会话盐。**它不是列级访问控制**：别名、表达式和源 SQL 文本可绕过基于输出名的匹配；旧保存结果也不会被追溯修改。敏感 SQL 字面量仍可能出现在结果 SQL/审计中。生产应使用数据库 grants、RLS、批准视图和合规的模型出口策略。

## 8. 验证与上线

```bash
npm run check
npm run build
npm test
npm run test:integration:local
```

本地集成脚本只启动 PGlite PostgreSQL 协议 fixture，默认不会误用 MySQL DSN；`--all` 可额外启用显式设置的 MySQL 测试 DSN。真实数据库集成使用 `DATA_AGENT_TEST_PG` / `DATA_AGENT_TEST_MYSQL` 和 `npm run test:integration`。

上线前还需在目标引擎/版本及只读账号下验证计划、取消、连接数、延迟、资源组、时区和授权策略。PGlite multiplex 单 backend 不能验证真实 PostgreSQL 取消控制连接；MySQL/Doris/StarRocks 真实服务器测试需要可用环境。此次没有声称实测延迟/token 降低或全引擎生产认证，验收记录见路线图文档。
