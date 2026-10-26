# Project 首版设计

日期：2026-10-12。状态：设计提案，尚未实现。分支：`project_adding`。

本文覆盖 PKG、Gateway、Seagull UI 和 Harness 的协作契约。文档放在可纳入版本控制的服务目录；本地 `docs/` 当前被 Git 排除，不作为本次设计的交付位置。

## 1. 目标与验收场景

Project 是围绕一个明确目标，横向组织材料、知识、行动、交付物和会话的工作上下文，不是新的目录、租户或知识库。

核心场景：用户建立“完成 Agent Memory 技术选型”，关联论文 Source、阅读 Note、比较 Wiki、阅读／实验 Todo 和研究简报 Asset。隔几天重新打开，能知道：

1. 这件事为什么做、什么结果算完成。
2. 哪些材料和结论已经有了。
3. 哪些行动尚未完成、下一步是什么。
4. 哪些交付物待审阅或存在前置条件阻塞。
5. 如何带着选定上下文继续工作，而不重复解释背景。

首版验证的是“减少工作散落和上下文重复”，不是增加新的内容生成能力。

## 2. 领域边界

| 概念 | 首版含义 | 不承担的职责 |
| --- | --- | --- |
| Project | 有目标与完成标准的一件持续推进的事 | 领域分类、用户权限隔离、所有内容的父目录 |
| Todo / Task | 具体行动；UI 可称 Task，存储继续复用 CalendarReminder | Agent Run、另一套任务状态机 |
| Source | 外部材料 | 项目专属副本 |
| Note / Wiki | 用户写作、结论和可复用知识 | 自动变成项目内私有内容 |
| Asset | 持续编辑、审阅、交付的内容对象 | 改名为 Artifact，或由 Project 目标替代 Intent |
| Chat Session | 已有会话及其执行记录 | Project 本身、项目级无限上下文 |
| Agent Run | 一次执行及其状态 | Todo 是否完成、Project 是否完成 |

Source → Note、Wiki 引用、Asset 的 Evidence／Claim／Block 等既有关系不变。Project 额外关联这些对象；添加一个 Note 不自动添加其全部 Sources，添加一个 Asset 不自动添加其全部证据。

### 已确认的现状

- Asset 已有独立的创作、优化和交付生命周期；全局诊断接口为 `/assets/analytics`。
- Todo / Completed 页面使用 CalendarReminder；目前日期必填，关联笔记通过 CalendarReminderNote，重复事项通过 CalendarReminderCompletion 逐次完成。
- Note 的 `project` 是可选文本，不是 Project 实体外键。
- Chat 持久化记录中已有逐消息的 Workflow、对象上下文、执行状态和保存回执；Project 不应覆盖这些信息。
- Agent Memory 类型已有 `project` scope，但不能据此认为已经存在真实 Project、所有权校验或自动上下文绑定。

## 3. 首版范围与明确不做

首版包含：Project CRUD／归档、已有对象关联与反向入口、现有 Todo 接入、无日期的一次性行动、Project 页面、受控的继续工作入口、Dashboard 的 Asset 项目筛选。

首版不做：子项目、无限嵌套任务、任务依赖、甘特图、团队权限、项目预算、自动项目规划 Agent、自动关闭任务、自动生成长期记忆、全量 Journey 遥测、音频或播客。

没有 Project 的所有原有操作继续可用。Project 不成为新增 Source、Note、Todo 或 Asset 的必填项。

## 4. 数据模型

### 4.1 Project

建议 `projects`：

| 字段 | 含义 |
| --- | --- |
| `id` | 稳定 ID，例如 `project-<uuid>` |
| `user_id` | PKG 所有者 |
| `title` | 非空名称，最多 200 字符 |
| `goal` | 非空目标，最多 4,000 字符 |
| `completion_criteria` | 完成标准，最多 4,000 字符；创建时可留空，关闭时提醒补充 |
| `status` | `active` / `completed`，由用户显式决定 |
| `archived_at` | 可空；归档不丢失原来的 active / completed 状态 |
| `revision` | 单调递增的项目内容／关联修订号，用于条件更新与上下文快照 |
| `created_at` / `updated_at` / `completed_at` | 真实时间戳；重新打开时清除当前 completed_at |

用户界面展示“进行中／已完成／已归档”。归档与完成不是同一件事；关联对象后续变化也不自动重新打开 Project。任务未全部完成时可以关闭，但必须展示未完成行动并由用户确认。

归档项目可查看，修改目标、关联、下一步或创建项目行动前须恢复；这些写入返回 409 并提供恢复入口。归档不冻结原对象，从原有日历完成 Todo 或编辑 Note / Asset 仍然允许，也不产生假项目历史。

目标是 Project 的目标，不是每个 Asset 的 Intent。首版不增加截止日期、优先级或复杂健康评分。

### 4.2 ProjectResource：引用已有对象

所有材料、知识、交付物、会话均采用多对多引用，不复制对象，不改变原所有者。首版不设 Asset 的“主项目”：资源主归属不是当前痛点，避免再维护一份与关联表可能矛盾的数据。

建议 `project_resources`：`id`、`project_id`、`resource_type`、`source_id` / `note_id` / `wiki_id` / `asset_id` / `chat_session_id`、`reason`、`created_at`。

- `resource_type` 是封闭枚举：`source`、`note`、`wiki`、`asset`、`chat_session`。
- 五个目标外键中恰有一个非空，并与类型匹配，使用数据库 CHECK 约束。
- 每个目标外键都是真实外键，删除目标只级联移除关联，不删除 Project 或其他对象。
- 每种目标具有 `(project_id, target_id)` 唯一约束；重复添加返回已有关系，不产生重复资源。
- API 使用统一的 `{resource_type, resource_id}`；具体外键细节不泄漏给 UI。
- `reason` 是可选的“为什么关联”，不是复制的正文或模型总结。
- 所有读写校验 Project 和目标属于当前用户；不通过 ID 是否存在泄漏他人资源。

这是一个限定五种对象的关联模型，不建设通用图关系引擎。分组由类型决定：材料（Source）、知识（Note / Wiki）、交付物（Asset）、会话（Chat）。

### 4.3 Todo：扩展而不是另建 Task 表

继续使用 `calendar_reminders`，增加：

- `project_id`：可空 FK；一条 Todo 至多属于一个 Project。项目删除时 SET NULL，Todo 仍独立存在。
- `date`：允许空；空日期只允许 `recurrence=once`，表示未安排日期的行动，不能填“今天”伪造日程。
- `completed_at`：一次性 Todo 的可空完成时间；完成时写入，重新打开时清除。旧已完成记录保持未知，不拿 updated_at 补造完成时间。

首版行动状态仍只有“待完成／已完成”，不伪造现有模型并不支持的“进行中／阻塞”。重复提醒继续逐 occurrence 完成，不能用一个全局 is_done 表示整个重复任务结束。

项目 Tasks 分成“一次性行动”和“重复提醒”。任务完成数量只统计一次性行动；重复提醒按用户选定日期范围展示 occurrence，不进入项目完成分母。

日期兼容规则：

- 现有日历／Home 日期范围查询继续排除未安排日期的行动；Project Tasks 显式包含它们。
- 保持既有 `/calendar/reminders` 默认的有日期查询语义，增加显式 `include_unscheduled`，默认 false。
- Home 的 Todo 区增加独立“未安排日期”入口，显式请求无日期行动；移出／删除 Project 后仍可找到它们，不把它们混入今日日程。include_unscheduled=true 时，无日期对象不应用日程日期范围过滤，调用端必须单独分组。
- 更新 API 区分未提供 date 和显式 date=null；日期字符串还需验证真实日期，不仅匹配格式。
- 重复事项必须有起始日期；once → recurring 时没有日期则 422，不能隐式补日期。
- 有日期的一次性 Todo 仍出现在日历；在任一入口完成，另一个入口同步，不产生第二份任务。
- 已完成页增加独立的“未安排日期”视图，不把旧的按日程日期分组偷偷改成按完成时间分组；缺少完成时间显示未知。
- 未安排日期的已完成视图用真实 completed_at 筛选完成日期；旧的未知时间记录单列，不纳入某一天／周的完成数量。
- 项目移除／归档不取消重复提醒。UI 明示其仍按原日程出现，用户可单独调整。

现有提醒逻辑集中在 API 路由中。扩展时将相关业务提取到共享服务，日历与 Project 复用同一创建、编辑、关联笔记和完成逻辑，不在两个路由各实现一套。

### 4.4 TodoResource：行动与具体对象的关系

P2b 使用 `todo_resources`：`reminder_id`、`role=context|result`、类型对应的 Source/Note/Asset FK、说明、关联时间。同一 Todo、role 和目标唯一，数据库检查保证只有一个匹配类型的目标。

- 关联属于 Todo，不通过 ProjectResource 间接持有，以避免移出／移动项目或移除项目资源时静默丢失任务材料与成果。此决定替代原先按项目清除任务关系的设计。
- 写入从 Project Tasks 发起，验证同一用户所有权、任务项目归属、Project revision 和归档状态；全局 Todo 提供只读关联查询。
- `context` 允许 Source / Note / Asset，表示做这件事需要什么；`result` 只允许 Note / Asset，表示用户明确指定的行动成果。不自动完成任务，不等同于成品采用。
- result 仅用于一次性行动，重复提醒模板不代表某次 occurrence 的成果。已有成果时转为重复提醒须先显式移除成果关联，不能悄悄改变其含义。
- CalendarReminderNote 与旧 note_ids 保持原行为和原有引用；不把历史关联笔记自动推断为 context 或 result。显式角色关联另行展示，允许同一 Note 同时作为 context 和 result。
- 添加任务材料／成果时，在同一事务内补充当前 ProjectResource；任一目标不可用时不部分保存。删除任务关联不删除正文，也不移除 ProjectResource。
- 移动 Todo 前确认来源、目标、下一步清除影响和资源保留规则；校验两端 revision，按 Project ID 排序加锁。Todo 日程、完成状态、旧笔记、显式材料与成果全部保留，同时补充目标项目资源引用，原项目资源引用保留。
- 移出或删除 Project 后，Todo 与显式资源关系仍在；Home 的未排期 Todo 可展开查看。删除 Todo 或原资源时，仅对应的 TodoResource 通过 FK 清理。
- 不同入口的写入都必须使用同一服务。不得靠 UI 缓存把资源视为已经持久化关联。

API：项目任务 `/projects/{id}/tasks/{reminder_id}/resources` 支持 GET/POST，单个关联支持 revision-checked DELETE；`/projects/{id}/task-results` 分页汇总当前成员任务的显式成果；`/calendar/reminders/{id}/resources` 提供全局只读查询。Overview 的最近成果按关联时间排序，可来自未完成任务，不冒充完整活动记录或采用遥测。

## 5. 页面与关键操作

### 导航

增加 `Projects` 工作入口与 `/projects`、`/projects/:id`。它是个人工作组织能力，不是管理员工具；首版默认可用，无项目时有轻量空态，不强制入门向导。

Source、Note、Wiki、Asset 详情提供“关联项目”与“所在项目”；Todo 提供可选项目字段。项目页面进入对象详情时保留返回项目入口，不新建另一套对象编辑器。

从项目里的 Source 创建 Note、从任务发起写作等操作可带入当前 Project，并在保存前展示“同时加入此项目”的选项。一个对象属于多个项目时不能擅自选主项目；从全局入口创建时不自动推断归属，也不沿来源链自动继承全部项目。

### Project 详情

| 标签 | 内容与主操作 |
| --- | --- |
| Overview | 目标、完成标准、置顶的下一步 Todo、待审阅／未完成摘要、继续工作、完成／归档 |
| Tasks | 一次性行动列表、无日期行动、已完成行动；重复提醒独立按日期范围展示；复用完成动作 |
| Knowledge | Source / Note / Wiki 分组，搜索与添加已有对象、关联原因、打开原对象、移除关联 |
| Outputs | Asset 列表及真实状态；进入原创作页，查看项目内 Asset 功能卡点 |
| Sessions | 相关会话列表、继续匹配项目上下文的会话、查看历史；不拼接为单一无限对话 |

Overview 的“最近更新”只展示已有关联对象的更新时间，不称为完整项目活动历史。首版没有自动生成的项目总结，也没有凭资源数量计算的项目完成率。

“下一步”是用户选择的一条本项目未完成、一次性的 Todo（Project 可增加可空 next_reminder_id，删除／完成／移出时清空）。这是导航便利，不是第二份任务状态。

### 添加已有对象

材料选择器复用 Library；Asset、Todo、会话使用各自列表。展示类型和真实状态，支持分页与多选。首版批量最多 50 个，原子校验所有权；其中任何目标不可用则不部分保存，UI 明示需要重新选择。

关联后的资源再打开时取原对象最新状态；Project 不冻结成一份旧知识副本。失去对象或关联时展示可恢复说明，不把缺失内容显示为空成功。

## 6. Project 上下文与 Agent

首版不用新“项目经理 Agent”。“继续工作”允许选择现有 Workflow、可选 Todo、关联资源，以及是否使用已有项目记忆。

### 发起前可见、受限的上下文

- UI 展示发送给模型的项目目标、完成标准、行动与材料清单，让用户确认。
- PKG 校验 Project 与资源关联，再生成只读快照：`project_id`、`project_revision`、生成时间、可选 `reminder_id`、选定 refs 及其版本／更新时间。
- 首版最多选 20 个资源；每个摘要最多 1,000 字符，整个上下文最多 20,000 字符。超限明确截断，不默默漏掉材料；这些是输入大小上限，不宣称精确 Token 用量。
- 不自动附带全部正文、图片提示词、私有下载 URL 或所有历史聊天。Source / Note / Wiki / Asset 可按选择加入摘要；会话首版仅关联，不自动拼接消息。
- Project 全部资源可检索和仅发送选定 refs 是两个概念。未实现项目检索过滤前，明确现有工具仍可检索用户知识库，不把提示词约定称为强制隔离。

### 保存与会话恢复

- Project 是附加上下文，不替代现有 Workflow 和 Asset owner／object_ref。
- 新增可选的逐消息 `project_context` 字段，保存 Project ID、任务 ID、修订和选定 refs；旧消息无需迁移。再次执行时重新读取最新项目状态，旧记录保留当时快照。
- P3a 同时在 `ChatSession.project_context` 保留经 PKG 确认的执行快照，使空会话／刷新／直接 URL 恢复不依赖浏览器导航状态。逐消息快照位于 `metadata.project_context`，历史与失败消息可查看记录，但不将失败记录称为模型实际使用证据。
- 默认从 Project 创建新会话；恢复仅有项目关联但最后执行上下文不同的会话时提示“查看历史或新开会话”，不能凭多对多会话关联自动切换执行 scope。
- 会话所属 PKG 记录建立后才关联 Project。关联失败保留已创建会话并允许重试，不删除原会话。
- P3a 的新项目会话由 PKG 在同一事务内建立 ChatSession、ProjectResource 和执行快照；客户端 session_id 加 launch_fingerprint 使响应丢失重试不重复创建。确认过期时不留下孤立会话。后续跨服务保存仍遵循回执与补关联规则。
- 保存 Note / Wiki / Asset 仍是显式用户动作，可勾选“同时加入当前 Project／作为本 Todo 结果”。创建对象和关联应尽量在同一 PKG 事务中完成。
- 对无法在同事务保存的跨服务步骤，先保存对象回执，再执行幂等关联；关联失败显示“对象已保存，关联待重试”，重试只补关联，不再次生成对象。
- Agent Run 完成、对象保存或导出成功都不自动关闭 Todo 或 Project。

### 项目记忆

既有 `project` scope 只作为可选能力接入。`scopeId` 必须是当前用户真实 Project ID，Gateway 在 recall、preview、propose 和 accept 等入口验证，不能仅相信任意字符串。

项目正文不是自动获准长期记忆；候选仍须用户确认。所有历史 project scope 字符串在人工确认前保持旧数据，不自动按名称合并成新 Project，不跨项目召回。

## 7. API 与服务边界

以下为拟议契约，不表示接口已经存在。浏览器仍经 Gateway，Harness-to-PKG 仍通过 Gateway，不新增直连后端或独立鉴权。

| API | 职责 |
| --- | --- |
| `GET/POST /projects` | 当前用户的列表与创建；列表分页，状态／归档筛选 |
| `GET/PATCH /projects/{id}` | 项目详情与条件编辑；修改须带 `base_revision` |
| `POST /projects/{id}/archive` / `restore` | 显式归档／恢复；带 base_revision |
| `GET /projects/{id}/overview` | 一次性任务数量、日期明确的重复提醒摘要、待审阅与交付物诊断摘要 |
| `GET/POST /projects/{id}/resources` | 分页关联列表／批量幂等添加；写入带 base_revision |
| `DELETE /projects/{id}/resources/{link_id}` | 只移除关系；带 base_revision，不删除对象 |
| `GET/POST /projects/{id}/todos` | 复用 Reminder 的列表／创建；明确区分一次性和重复 occurrence |
| `PATCH /calendar/reminders/{id}` | 复用编辑、完成、安排日期及归属项目；不建立另一套完成接口 |
| `PUT /projects/{id}/todos/{todo_id}/resources` | 原子替换任务的 context/result；复用笔记关联规则 |
| `POST /projects/{id}/context-preview` | 验证选定 refs 并返回受限上下文；不调用模型、不写长期记忆 |
| `POST /projects/{id}/context-session` | P3a 已实现：确认 fingerprint，原子建立独立项目会话、关联及执行快照；支持同 session_id 幂等重试 |
| `PUT /projects/{id}/context-session/{session_id}` | P3a 已实现：确认更新同项目的执行快照，不重写旧消息或更换执行项目 |
| `POST /projects/{id}/saved-result` | P3b 已实现：将已保存 Note／Asset／Wiki 显式关联项目，可同时关联一次性 Todo 的 Note／Asset result；原子写入，响应丢失重试不重复建关联 |
| `GET /assets/analytics?project_id=...` | P4 已实现：验证项目所有权，对全部直接关联 Asset 去重统计，分页仅影响卡点列表；返回确认后的项目范围 |

Project 删除不是首版主入口，先提供归档。若之后提供永久删除，只删除 Project、其资源关系及项目级任务关系；Todo 的 project_id 置空，所有知识、Asset、会话和记忆均不得级联删除。记忆失去有效项目时不召回，清理由用户另行确认。

所有关系变更推进 Project revision；对象正文修改和 Todo 完成不推进 Project revision，快照同时记录目标更新时间。修改 next_reminder_id 与 Todo 的跨项目移动需锁定相关 Project，并在单事务内清理下一步指针。条件编辑冲突返回 409，UI 保留草稿、允许刷新重试，不静默覆盖另一标签页。

新增／移入 Todo、替换任务资源等项目关系写入同样要求 base_revision。跨项目移动同时校验起点与终点修订；原有全局 Todo 完成不增加项目条件写入要求。所有新增列表接口必须分页并返回 total，Overview 的计数查询独立于明细分页，避免读取第一页就当作全部项目内容。

| 服务 | 负责 |
| --- | --- |
| PKG | Project、关联、Todo、所有权、目标解析、上下文快照与状态统计；Alembic 迁移与测试 |
| Seagull UI | Project 页面、选择器、跨入口导航、显式确认、错误恢复、同步 TS 契约 |
| Gateway | 浏览器认证、会话所有权、Project context／memory scope 校验、幂等跨服务恢复 |
| Harness 插件 | 接收和读取验证后的执行上下文，保持现有提案与显式保存边界 |
| Worker | 首版不增加 Project 定时任务或自动总结任务 |

## 8. 统计与状态的诚实边界

- 项目资源计数按唯一关系计数；跨项目引用允许重复出现在不同项目，但不能把项目计数相加当作全库对象数。
- Project 的 Todo 完成数不是 Project 完成率。Project 完成由用户对照目标确认。
- 对 Asset 复用已有 12 区功能诊断，不再单独实现一套；project_id 过滤的是匹配全部关联 Assets，不受关联列表分页影响。
- 一个 Source 的处理失败、Note 待审阅、Todo 未完成、Asset 导出阻塞分别展示，不混成一个“卡住”状态。
- 没有记录的停顿原因、人工补救、Token、等待耗时和采用情况仍是未知；关联 Project 不会补出历史遥测。
- Overview 任一部分请求失败显示“该区数据不可用”，不把失败转换为零；返回含时间戳与统计范围，重复提醒必须有明确日期范围。

## 9. 兼容与迁移

1. 新增 Project 与资源关系表，再扩展 Reminder；现有对象不要求自动加入 Project。
2. `Note.project` 保留原文本及查询契约，不改成 FK，也不因其名称自动创建 Project。
3. 提供后续可选的旧文本分组预览；用户确认目标 Project 后批量关联，原文字段保留。重名不是身份，不能自动跨用户合并。
4. CalendarReminderNote 与旧 note_id 兼容行为继续维持；不能用 ProjectResource 替换笔记来源关系。
5. Chat 旧消息、新旧 Context、保存回执可混合读取；历史项目记忆不被自动重写。
6. 修改 Reminder 的可空日期后审计所有排序、过期计算、循环日期展开、返回 schema、Home／Calendar／Completed 入口。迁移前后跑原有提醒回归。
7. 不改归档 `web/` 客户端，不直接修改上游 Harness 子模块。服务契约改动同时更新 PKG、Gateway、UI 和相关插件。

## 10. 实施顺序与退出标准

下面均为拟议待做，不表示已实现。每阶段先有服务级验证，再做相关跨服务验证。

### P1：项目与已有对象关联

- [x] Project / ProjectResource schema、Alembic、所有权与唯一性约束、条件更新。
- [x] 项目列表／详情、Knowledge / Outputs / Sessions、已有对象选择器与反向入口。
- [x] 创建、关联、移除、完成、归档、恢复的完整 UI 错误恢复。

P1 已实现；服务测试覆盖所有权、条件更新、关联原子性、目标删除与迁移往返；浏览器回归覆盖生命周期、409 保留输入、分页、反向入口与归档只读。PostgreSQL 独立临时 schema 测试验证并发编辑／关联只允许一个同 revision 写入成功；通过 `SEAGULL_PROJECT_POSTGRES_TEST=1 .venv/bin/python -m pytest tests/test_projects_postgres.py -q` 显式运行。部署前须应用数据库迁移并重启 PKG API。

退出标准：同一 Source / Note / Asset 能被两个项目引用；移除关联不删除内容；其他用户的对象无法关联；离开后重开仍能恢复项目材料与目标。先使用现有对象，不扩生成能力。

### P2：复用 Todo，把“下一步”接起来

- [x] 提取共享 Reminder 服务，增加可空日期、project_id 与真实 completed_at。
- [x] 项目行动、重复提醒独立视图、下一步指针；已有 Todo 可加入项目，移出项目保留任务与笔记。
- [x] Calendar / Home / Completed 与项目页面同步；无日期任务可完成、可安排日期。
- [x] TodoResource 的显式 context/result 关联与跨项目移动确认 UI。
- [x] Overview 的待办预览、下一步导航与分页最近成果；未知状态提供重试，不显示虚假零值。

P2a 行动闭环已实现：Tasks 分页与全量一次性行动计数，Overview 的用户指定下一步，独立的重复 occurrence 列表；全局 Todo 完成会同步并清理下一步，不自动完成 Project。任务笔记仍复用 CalendarReminderNote，加入项目时在同一事务内补充 Note 项目引用；移出项目不删除笔记或原有任务引用。已有已完成记录不回填完成时间。项目归属变更校验 revision，归档项目的 Tasks 只读，但 Calendar／Home 的原任务仍可完成。部署前应用 `a7b8c9d0e3f4` 迁移并重启 PKG；降级前必须安排所有无日期任务，迁移不会伪造日期或丢弃任务。

P2b 已实现任务材料／成果闭环、显式跨项目移动和总览最近成果。部署前应用 `b8c9d0e1f2a3` 并重启 PKG；降级前须显式移除所有 TodoResource 关联，迁移不会静默丢弃它们。Agent 工作流上下文与成果自动保存仍在 P3，不在此阶段接入。

退出标准：从项目完成一个有日期的 Todo，日历立即同步；无日期行动不伪装为今天；重复提醒只完成指定 occurrence；移出项目不丢失 Todo 与笔记；旧提醒回归通过。

### P3：受控继续工作与交付关联

- [x] P3a：Context preview、会话与逐消息 project_context、Gateway 执行 scope 验证；既有 Harness prompt/Workflow/Owner 契约保持兼容。
- [x] P3a：复用现有 Workflow，Project／Task 的继续工作入口、独立会话、预览确认、过期阻断与恢复。
- [x] P3b：保存后通过回执选择关联 Project／Todo 结果，关联失败可幂等补救；Chat 与 History 均可操作。
- [ ] 项目记忆只在有效项目与用户确认边界内使用，旧 scope 保持兼容。

P3a 部署需应用 `c9d0e1f2a3b4`，重启 PKG API 和 Gateway；不需要重启 Harness／Worker。源材料摘要来自 Source description、Note abstract／短 content、Wiki summary／短 content、Asset brief／outline，不发送完整 Draft、附件 URI 或聊天历史。fingerprint 覆盖选定目标状态、时间、摘要和任务状态，生成时间不参与 fingerprint；项目、任务或材料改变后须重新预览确认。项目执行关闭记忆召回，工具仍可检索完整用户知识库；这不是项目检索隔离，也不是项目记忆上线。

P3b 复用现有两类关联表，不增加迁移；P3a 已部署的环境只需重启 PKG API。保存产物与关联是两次独立确认：回执保留真实对象 ID，关联失败只重试关联；刷新会话后仍可从回执补关联。默认目的地来自该条消息的快照，用户可选择其他项目或仅关联项目，不改变会话执行 scope。Note／Asset 支持一次性 Todo 成果，Wiki 草稿仅关联 Project，不自动发布为 Stable。接口在同一事务内添加缺失 ProjectResource／TodoResource；已有完整关联的重试不重复推进 revision，但仍校验用户、资源、归档和任务当前归属。缺失关联遇到 revision 冲突须显式刷新确认。完成、采用与关联保持独立；Chat 回执写入失败时可在当前页面只补写回执，页面关闭前须先确认回执持久化，这不等同于跨刷新幂等的内容创建 API。

退出标准：发送前可检查上下文；旧消息仍可读；在不同项目新开会话不会误带另一个项目记忆；对象保存成功但关联失败时重试不会重复创建对象；Run 完成不自动关闭任务。

### P4：诊断与真实使用验证

- [x] Dashboard Asset Diagnostics 增加可选 Project 筛选，Project Outputs 按需复用相同诊断。
- [ ] 对 2–3 个真实项目做连续使用验证，记录“是否减少重复背景输入、能否迅速找到下一步”。

退出标准：项目筛选覆盖全部关联 Assets，分页不影响计数；未记录指标继续显示未知；用户隔几天重新进入项目能恢复推进。

诊断范围保存在 Dashboard 的 `project_id` URL 参数中，切换标签与刷新保留；切换项目或返回全局会重置诊断子筛选和卡点页码。可搜索、分页选择 active／completed 项目，也可切换到 archived 项目只读查看。统计只包含当前用户直接关联的 Asset，同一 Asset 被多个项目引用时，各项目各计一次，全局仍计一次；不沿着 Note、Todo 或 Chat 反推 Asset，不把关系数量当采用率或完成率。Asset 类型、状态与功能筛选复用原接口。旧 API 未确认 scope、404 或加载失败均显示不可用，不显示全局数值或假零值。用户复盘目前仍是全局补充视角，项目范围下隐藏，避免混算。无需新迁移，只需重启 PKG API。

真实使用验证仍待用户完成，不以自动测试代替：选 2–3 个已有项目，每个至少做一次「选下一步 → 确认上下文 → 工作 → 保存 → 显式关联成果」，隔几天再进入。每次记录「找到下一步是否困难、重复输入了哪些背景、哪一步需要手动补救、产物是否采用及原因」；耗时只写实际记录或明确标记估计，没记录就保持未知。根据这些反馈再决定是否增加项目记忆或任务状态，不预先扩展任务模型。

## 11. 验证矩阵与设计确认点

| 风险 | 必须验证 |
| --- | --- |
| 数据与权限 | 跨用户 Project / target / Todo / Session／memory 拒绝；重复关联幂等；五种 FK 约束 |
| 生命周期 | 归档保留内容；目标删除只清关系；移除关联不删除 Todo；关闭项目不取消提醒 |
| 并发 | 两个标签页条件编辑产生 409；批量添加原子；任务移动和下一步指针不留下跨项目引用 |
| 日期与任务 | once 无日期、日期校验、重复事项缺日期拒绝、occurrence 完成／撤销、旧完成时间未知 |
| 上下文 | 20 个 refs／20,000 字符限额、过期或移除关联重新确认、旧消息兼容、scope 切换明确 |
| 错误补救 | 保存对象与关联的部分失败、重试不重复创建、401／404／409／422 可恢复提示 |
| 统计 | 多项目同资源去重、全量 Asset 统计、不混算重复 occurrence／任务数、不把加载失败记零 |

建议按上述默认设计推进。实现前重点确认三项用户体验选择：

1. **无日期行动进入首版**，而不是强迫每个 Todo 安排今天。
2. **知识／Asset 可跨项目引用；Todo 单项目归属**，不引入主项目与引用项目两套资源关系。
3. **Project 先组织工作，不自动管理工作**：完成由用户决定，上下文与保存均可检查和确认。

后续若真实使用证明需要 Task 的进行中状态、独立详情或子任务，再演进动作模型；不能只因为出现 Project 一词就提前重建整套任务系统。
