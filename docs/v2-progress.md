# V2 优化实施记录

## 2026-09-28：收口决策（当前有效）

- 首页「Start research」改接既有 `clarify-asset-intent`：用户输入话题后进入新 Chat Session，自动开始 Intent 澄清；若召回相关的已确认记忆，先让用户勾选再发给 Agent；无记忆则直接开始。澄清只生成候选 Intent，不自动搜索、创建、保存或发布 Asset。用户应用提案返回 `/assets/new`，之后沿用原有确认 Intent → Evidence/Claim → Agent 草稿流程。
- 记忆预览/按次选择保留给 Asset Intent 与 Asset 草稿。预览失败可显式选择「不用记忆继续」，以 `memory_ids: []` 发送，避免回退成不透明的自动召回。普通 Chat 行为不变。记忆只能影响个性化角度，不视作事实证据。
- 撤下 V2 单独的 `research-topic` 首页路径及其前端研究计划、公开检索预览、站内线索、手工 Source ID/短引文检查、回答转 Asset 等交互；对应的实验性测试和插件限定也撤回。原有 Asset 知识检索、Evidence/Claim 门禁及其他功能保持不变。Agent 外部搜索返回的摘要仍不能冒充已核验原文；不要宣称新入口自动完成外部证据核验。
- 历史记录与迁移不销毁：用户已执行过 Alembic 升级，PKG 保留可选 `research_state` 字段、迁移和相关读取能力以兼容既有会话，不再有新路径写入；旧研究的 Harness Session Context 只读兼容，不再新建。上线前仍需核对真实 Gateway/Harness、搜索供应商及浏览器登录态；模拟测试不等于联调通过。
- 澄清研究方向时，Intent 工作流要求 Agent 使用结构化 `ask_user_question` 提供可选项，不把未选择的编号正文当作用户决定；浏览器用例覆盖多选并提交。Harness 是否遵循提示词仍需真实联调。
- 验证：前端构建、Gateway 6 条测试、PKG Chat Session 定向 30 条、三个 Harness 插件测试文件、首页/Intent/旧会话 9 条模拟 Gateway 浏览器测试及 `git diff --check` 均通过。另一个既有 Asset 生成端到端用例在阅读页断言 `Decision document` 精确文本时失败，实际页面显示 `Decision document · Executive Brief`；该用例的生成和保存阶段已通过，阅读页断言尚待独立处理。未重启服务或用真实账号验证。


此文档记录 `v2-improvement` 分支每轮的目标、取舍、验证与未完成事项；产品需求与验收标准见 [V2 路线图](v2-improvement.md)。记录代码实际完成情况，不把计划中的功能写成已交付。

## 2026-09-24：启动第一轮（V2-01 的入口切片）

### 目标

让用户从首页输入一个话题，直接进入已有研究工作流，能够先审阅问题再发送；不要求先上传文件或打开 Discover。继续使用现有 Chat Session 保存与 Agent Memory 召回能力，不新增平行的研究数据库。

### 决策与兼容原则

- 现有 Sources、Notes、Wiki、Discover、Chat、Assets、日历及其 API 不下架；首页新增主入口而非禁用旧模块。模块开关会拦截深链，不能当作单纯隐藏导航的工具。
- 首轮只打通话题入口与研究发送，明确标注它不是完整的 V2-01：PKG 的研究状态、可恢复工作区以及与 Asset 的关系仍需单独实现。
- 长期记忆仅按现有已确认 Agent Memory 的调用链进入对话。用户画像的选择、预览、关闭及跨服务组装属于 V2-02，未实现前不能宣称「可控的个人上下文研究」。
- Agent 的研究结果仍须用户确认才能保存；研究偏好与外部证据分开。旧链接和现有数据保持可用。

### 交付与验证

- 状态：入口切片已完成；V2-01 整体仍在进行中。
- `seagull-ui/src/pages/HomePage.tsx`：增加话题输入框，不依赖先导入资料；原有首页功能和模块入口不变。
- `seagull-ui/src/pages/ChatPage.tsx`：接收话题跳转并默认打开 Deep Research，预填研究工作流提示但不自动发送；发送前可编辑。实际发送走现有 Chat Session，用户仍自行决定是否保存回答。
- `seagull-ui/src/lib/agent-workflows.ts`：研究话题时优先检索个人知识，再在工具可用时搜索公开来源；提示词明确禁止把个人记忆当作事实证据，或将私人上下文发送到外部检索。
- `seagull-ui/e2e/critical-flows.spec.ts`：新增首页发起研究、未自动发送、研究模式、会话刷新后结果可恢复的模拟端到端测试。
- 验证：`npm --prefix seagull-ui run build` 通过；研究入口及原有知识保存流程的 2 条 Playwright 用例通过。构建有既存的代码块体积警告，未在本轮扩大范围处理。
- 限制：Playwright 使用模拟 Gateway；尚未验证真实 Harness 的网页检索或模型输出质量。刷新后对话消息可恢复，但完整研究状态机和模式持久化仍未交付。

### 下一轮建议

先补 V2-02 的「本次个人上下文」只读预览、移除和关闭能力，串联 PKG 用户画像与已确认 Agent Memory，再补 V2-01 的可恢复研究工作区和真实环境集成验证。未完成这些工作前不把本轮描述为「完整的个性化研究」。

## 2026-09-24：第二轮（V2-02 的已确认记忆切片）

### 目标与取舍

让用户在发送话题研究之前看见相关的**已确认 Agent Memory**，选择本次使用哪些，或全部跳过；未改动普通 Chat 默认召回行为。本轮只处理 Harness/Lab 所有的已确认记忆，**不把 PKG 的自动推断画像混同于已确认事实**。

### 已交付

- `deepseek-knowledge-lab/plugins/agent-memory/src/index.js`：增加不修改最后使用时间、不创建召回审计的预览；发送时按当前用户、有效状态和作用域重新筛选所选 ID，空列表表示本次不用记忆。未提供选择时保持旧聊天的自动召回行为。
- `bff/src/index.js`：增加认证的预览端点，以及 Chat 请求的记忆 ID 上限和输入校验；只接受后端查到的当前用户有效记忆，不能靠浏览器上传的文本伪造长期记忆。
- `seagull-ui/src/pages/ChatPage.tsx`：研究话题首次发送先展示记忆预览，可逐条取消或全部跳过，再显式发送；预览失败时暂停研究并提示检查 Gateway。更改研究问题会要求重新预览。
- `seagull-ui/src/lib/api/agent-memory.ts`、`seagull-ui/src/lib/api/harness.ts`：同步预览和选择契约；原有非研究会话仍可不传 `memory_ids`。

### 验证

- `npm --prefix seagull-ui run build` 通过，存在原有的大块资源告警。
- Agent Memory Store 单测通过；`npm --prefix bff test` 的 6 条测试通过；3 条相关 Playwright 用例通过（模拟 Gateway）。覆盖预览无审计、用户与作用域隔离、空选择不注入、旧 Chat 行为和首页研究入口。

### 尚未交付

- PKG 用户画像、相关 Notes/待办的按话题选择与「推断/明确」分层；用户当前仅能选择已确认 Agent Memory。研究上下文快照、刷新后的模式持续、与 Asset 的耐久研究工作区仍未完成。
- 真实 Harness/PKG 联调尚未执行。提示词声明「不把私人记忆发送至外部搜索」并不等于工具层的强制隐私保证；下一轮必须在外部检索调用边界核查并限制数据外发。

### 运行时 404 修复

- 有用户反馈 `Memory preview failed: 404: {"detail":"Not Found"}`。旧 Gateway 没有 `/api/harness/memory-preview` 时会将请求转发至 PKG，导致该 404；新 UI 与旧 Gateway 版本不匹配时，需要重启 Gateway 并确认 `VITE_API_URL` 指向 Gateway。
- 原实现允许在预览失败后选择「不使用记忆」，但旧 Gateway 可能忽略 `memory_ids: []`，仍自动召回记忆。因此取消这个不安全的回退：预览失败时研究发送保持暂停，页面提示检查/重启 Gateway；增加模拟旧 Gateway 404 的 UI 回归测试。
- 验证：`npm --prefix seagull-ui run build` 通过；3 条相关 Playwright 用例通过，其中 404 场景确认未调用 Chat。BFF 6 条测试和 Agent Memory Store 测试此前已通过。
- 本机实际服务经沙箱外只读检查：前端 `VITE_API_URL=http://127.0.0.1:4000` 正确，旧 Gateway 进程于 2026-09-23 启动，预览请求确实返回 PKG 的 404。2026-09-24 只重启了 Gateway；无凭证请求新路由返回预期的 401，Gateway/PKG/Harness/UI 健康检查均为 200。旧服务的 PID 文件缺失导致 `dev-stack.sh status` 曾显示「stopped」，实际监听情况以端口探测为准；未使用浏览器凭证进行真实用户会话验证。

## 2026-09-24：Research 结果显式保存为 Asset 草稿

- 首页发起的新 `research-topic` 会话保留「保存为个人 Note」，并增加「Save as Asset Draft」；研究完成后**不会自动生成 Asset**。旧会话即使持久化的保存目标只有 Note，只要运行状态为 completed 且结果已验证，也可显式保存为 Asset；失败、停止、未验证的结果仍不可保存。
- 保存时复用现有引用解析和 Asset 创建 API，创建 `research_brief`、`draft` 状态的可审阅草稿；优先使用 `## Question` 后的问题作标题，记录工作流和 Chat session provenance。成功后可从消息的「Open Asset」直接打开；刷新后依靠持久化的保存回执继续访问。
- 验证：`npm --prefix seagull-ui run build` 通过（已有大资源块提示）；定向 Playwright 3 条通过，覆盖首页研究→保存前无 Asset→草稿类型/来源/会话来源→刷新后打开、旧会话兼容及不合格运行禁止保存；`git diff --check` 通过。
- 边界：这是研究结果到**草稿**的显式转换，不代表引文已逐项核验或达到发布质量；Web 外部引用不会自动变成 PKG Source。真实 Gateway/Harness 与用户凭证下的端到端验证尚未完成。

## 2026-09-28：V2-01 研究会话恢复切片

- 首页话题研究在尚未发送时，将研究话题与可编辑提示词写入用户隔离的 Harness Session Context。刷新当前会话可恢复编辑内容和 Deep Research 模式；空会话不再因为没有消息就被丢弃。
- 研究发送后刷新，继续从 Session Context 或已保存的消息运行契约恢复 `research-topic` 模式。后续追问仍走 Deep Research；**每次新研究提问仍需先预览并选择本次记忆**，不会因为刷新而跳过确认。失败后的「Retry run」仅将原问题放回输入框、等待重新预览和选择记忆，不再绕过预览自动召回；确认发送前不会清空旧消息。原有 Asset 生成 Session Context 仍按原流程恢复；非研究会话不因此自动变成研究会话。
- 验证：Session Context Store 5 条测试、Gateway 6 条测试、定向 Playwright 用例覆盖首页发送、发送前刷新、完成后追问、失败后安全重试、旧 Gateway 404 和 Asset Intent 回归；前端构建与 `git diff --check` 通过。Playwright/Gateway 测试在允许本地 HTTP 监听的环境运行。
- **仍非完整 V2-01**：当前是会话提示词与运行模式的恢复，不是 PKG 持久化的研究状态机或可核验 Asset 工作区；运行中的 Harness 任务刷新后不能承诺无损继续。真实搜索、逐项证据定位、研究计划与文章生成仍未交付；请勿将「保存研究回复为 Asset 草稿」称为完成研究到成稿。

## 2026-09-28：V2-01 PKG 研究会话状态切片

- 给 PKG Chat Session 增加有类型约束的 `research_state`（原始问题、准备中／运行中／待输入／待审阅／失败／停止、可选的已保存 Asset ID）和 Alembic 增量迁移。首页创建研究会话时就记录原问题，发送前写入运行中状态和消息，结束时保存结果状态；通过用户的显式 Asset 保存动作关联已有资产，不预创建 Asset。
- Chat 顶部显示最新研究状态；刷新时如读到运行中状态，清楚标记「中断，结果尚未确认」，重试先回填原问题，再重新预览和选择本次记忆。History 可找回尚未发送但已创建的研究会话；非研究 Session 仍按原有流程。Gateway 继续代理 PKG 用户认证，不增加新的 Harness 写入通道。
- 验证：PKG 相关 schema/API/model 测试 28 条、前端构建、9 条相关 Playwright（模拟 Gateway）通过；`alembic heads` 与 `git diff --check` 已检查。部署时需在 PKG 启动新版代码前应用 `alembic upgrade head`，本轮未对用户数据库执行迁移。
- **范围与下一步**：这只是 Chat Session 的最后已知状态，不是 Agent 研究任务自动续跑，更不是 Asset Evidence/Claim 的已核验证据。真实运行中刷新的重试需依赖 Harness 会话仍可用或 Gateway 的缺失会话恢复能力；后续须验证真实检索和失败路径，并进入研究计划、证据原文定位、可审阅产出的实现。

## 2026-09-28：V2-03 研究计划与公开检索预览切片

- 研究会话可编辑研究目标与比较维度，保存到 PKG Chat Session 的 `research_state.plan`；用户须主动填写公开查询并点击「Preview public sources」，才会调用现有只读网页预览接口。返回的标题、链接、摘要和检索时间保留在计划中，明确标记为**未核验线索**，不自动导入 Source 或生成 Asset。当前没有自动生成安全公开搜索词。
- 研究发送附带当前计划；修改计划后未保存时阻止发送，改动查询并保存会撤销旧批准；预览失败也不会批准查询。`pkg-web-search` 在研究会话调用外部搜索前核对 PKG 中已批准的查询，未批准或不完全一致即拒绝。非研究会话的工具行为不变；不能据此声称 Harness 的其他外部工具均已受到保护。
- 验证：前端构建、PKG 定向 schema/API/model 30 条测试、网页搜索插件测试、模拟 Gateway 的研究计划与检索失败 Playwright 2 条用例通过；`git diff --check` 通过。用户已执行先前的 `alembic upgrade head`，此切片只复用既有 JSONB，**无新迁移**。
- **未完成**：真实 Gateway/Harness 与外部搜索供应商未做带用户凭证的联调；外网原文定位、逐项证据核验、自动安全查询生成和完整 V2-03 仍待实现。检索摘要不能充当已核验的文章事实。

## 2026-09-28：V2-03 站内知识线索审阅切片

- 展开研究计划时，Seagull 使用当前研究问题调用用户认证的 PKG Library 搜索，展示最多五条可打开的 Source、Note 或 Wiki 匹配项及摘要；失败可重试，库中无资料也不阻断研究。不把站内搜索结果复制进公开网页查询、自动发送给 Agent 或写成已核验证据。此预览仅保存在当前页面；刷新后再检索，不增加迁移。
- 安全边界：匹配摘要只是个人上下文线索，不是某项结论的原文定位或事实验证。现有网页抓取器接收任意 URL，不直接用它新建研究原文核验接口；后续必须先设计安全的外网 URL/重定向约束，再做逐项结论与原文核对。
- 验证：前端构建通过；模拟 Gateway 的 Playwright 覆盖站内匹配、独立的公开查询、内部检索失败重试，以及未批准时仍可继续研究。本机 Gateway、PKG、Harness 健康接口返回 200，但未使用用户凭证对真实 Harness 和搜索供应商做完整联调，不将健康检查等同功能验收。

## 2026-09-28：V2-04 已保存 Source 文本定位切片

- 在研究计划的外部线索上，用户可主动填写已保存的 Web Source ID 和从原网页选出的短引文。Seagull 经用户认证读取该 Source，只在 URL 与预览线索一致且引文存在于 `raw_content` 时显示命中的 Source 文本片段、导入时间及可打开的 Source 链接。URL 不同、正文缺失、引文未命中或 Source 不可访问均显示「未定位」；查询公开网页和写入 Source 都不会由此动作触发。
- **这不是自动核验事实或实时原文**：对照的是可编辑的用户知识库快照，不能证明网页当前内容、引文语义能支持研究结论，也不等于用户已核验。检查结果不持久化；刷新后必须重新检查。目前没有逐条结论到 Evidence/Claim 的绑定，也没有可直接对任意外部网页安全抓取的服务端接口。
- 验证：前端构建通过；模拟 Gateway 的 Playwright 覆盖命中、URL 不符、引文缺失、无权读取及外部检索失败；`git diff --check` 通过。无 API 契约或数据库迁移变更；真实用户凭证与真实外网原文仍未联调。

## 2026-09-28：Memory Preview 故障排查与 Gateway 恢复

- 用户报告预览失败时，Seagull 只显示泛化的 Gateway 错误。排查发现运行中的 Gateway 后来已停止监听 4000 端口；PKG、Harness、Seagull 仍在运行。历史日志有预览请求，但缺少失败状态或异常详情，无法从现有日志断定用户当时请求的准确失败原因。
- 只读检查确认独立 PostgreSQL Agent Memory 表存在、状态版本有效且可完成无用户数据的预览读取。**不要**对既有记忆迁移执行 `--replace`：迁移 dry-run 检出一条冲突，表明现有状态与旧文件不一致，不能覆盖当前数据。
- UI 按登录失效、404 旧 Gateway、5xx 记忆存储失败和连接故障分别提示，仍在失败时暂停研究；Gateway 对预览异常只记请求 ID、异常类别和状态码，不记录查询或私人记忆。
- 单独启动离线 Gateway，未重启其他服务；健康接口返回 200，未认证的预览返回预期 401，独立 Agent Memory 只读预览成功。前端构建、Gateway 测试和模拟 Gateway 的三条浏览器用例通过；仍需用户在浏览器刷新后用实际登录态确认成功预览。该检查**不能证明**先前错误只有一个原因。

## 2026-09-28：首页 Chat 发起 Asset 时研究问题无法选择

- 用户在首页 Chat 中创建 Asset 时，Agent 有时以 Markdown 正文列出备选研究问题，而没有调用 Harness 的结构化 `ask_user_question`；此前 Seagull 只为后者提供选项卡，因此正文里的备选问题无法直接选择。
- 在完成的 Asset 澄清/草拟消息和话题研究消息中，只对明确标有「研究问题／研究方向／Open Questions／Research Questions」的编号或项目符号问句展示多选面板。点击后仅将所选问题写入可编辑的 Chat 输入框，用户再次发送才继续原工作流；不自动保存、生成或发布 Asset。刷新后可以从持久化消息重新选择。
- 对 `draft-asset` 工作流中尚待选题、没有正式 H1 草稿的回复，不再标记为可保存的 Asset 结果；即使历史会话曾误标为 validated，也不提供保存动作。结构化 `ask_user_question` 仍使用既有 QuestionCard，不转换为普通文本问题。
- 验证：前端构建、模拟 Gateway 的首页 Chat 选题→刷新恢复→继续生成 Asset，以及 Intent Agent 原有流程的 Playwright 用例通过。**V2-04 的逐条 Claim 原文核验仍未完成**，本轮先解决用户实际遇到的研究选题交互阻塞。
