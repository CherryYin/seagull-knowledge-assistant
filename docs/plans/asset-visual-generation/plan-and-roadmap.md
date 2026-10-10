# Asset 生图功能 Plan & Roadmap

> 状态：Active
> 基线日期：2026-10-08
> 首选模型：`qwen-image-3.0-pro`
> 产品边界：生成图片属于 Asset 发布素材，不属于 Source，也不能作为事实证据进入检索链路。

## 1. 目标

为 Newsletter、博客和研究简报等 Asset 提供可控、可审核、可追踪的 AI 视觉生产能力：系统根据内容生成视觉方案，用户完成选择和审核，最终图片作为发布素材与 Asset 一起交付。

核心目标：

1. **内容相关**：图片能够表达 Asset 的主题和叙事重点，而不是只生成通用科技背景图。
2. **人在回路**：生成、重试、接受、拒绝和删除均有明确状态；Agent 可以提出方案，但不能绕过审核。
3. **发布导向**：支持 Newsletter 封面、文章头图、社交分享图和正文插图等真实发布场景。
4. **稳定可控**：长耗时任务不阻塞 API，具备超时、重试、配额、审计和失败恢复能力。
5. **领域隔离**：`AssetVisual` 与 Source、证据、知识检索保持边界，避免生成内容污染事实来源。

## 2. 当前基线（MVP，已完成）

当前系统已具备：

- `AssetVisual` 持久化模型与 Alembic 迁移。
- DashScope 原生接口适配，使用 `qwen-image-3.0-pro`。
- 生成结果下载、图片格式识别、尺寸记录和 MinIO 持久化。
- Asset Visual 的列表、生成、接受、拒绝和删除 API。
- Asset Production 页面中的封面生成与审核界面。
- Newsletter 可选自动生成封面，图片失败不阻塞文字草稿。
- 当前支持 `cover` 角色以及 `1280×720`、`1024×1024`、`720×1280` 三种请求尺寸。
- 图片生成已经通过 Worker 异步执行，支持轮询、取消、指数退避重试、卡死恢复、并发限制和 System Jobs 记录。
- Asset Production 支持 LLM Visual Planner、结构化 Visual Brief、三种风格预设、1～4 个候选任务和可编辑 `alt_text`。
- 已验证当前 Qwen Key 可真实生成 `1280×720` PNG 图片。

当前主要限制：

- Newsletter 已支持默认待审核和显式自动接受，但 Run 详情尚未展示 Visual Brief、任务和最终选择的完整链路。
- 只支持封面角色，没有正文插图、社交图和多尺寸派生关系。
- 使用服务级 Qwen Key，尚无用户级凭据、用量预算和成本统计。
- Visual Brief 的品牌规则和历史风格记忆仍较轻量，尚未支持参考图与角色级视觉体系。

## 3. 产品原则

### 3.1 AssetVisual 不是 Source

- 不进入 Source 列表、证据候选或知识检索。
- 不参与 Claim 支撑关系。
- 图片 Prompt 和模型信息可以审计，但不能伪装成来源引用。

### 3.2 Agent 建议，用户决策

- Agent 可以生成 Prompt、提出版式和发起生成任务。
- 普通 Asset 的最终 `accepted` 状态由用户操作产生。
- 自动化场景必须显式配置审核策略，不使用隐藏的自动接受。

### 3.3 文本草稿优先

- Newsletter 和其他自动化先成功创建文字 Asset，再独立处理视觉任务。
- 图片失败、超时或额度不足不能回滚文字草稿。

### 3.4 原图不可变，选择可变

- 已生成图片文件视为不可变产物。
- 重新生成创建新 `AssetVisual`，不覆盖旧记录。
- 接受操作切换当前角色的选中版本，保留历史版本用于比较和审计。

## 4. 目标领域模型

### 4.1 AssetVisual

建议逐步补齐以下字段：

- `role`：`cover`、`social_square`、`social_portrait`、`inline_illustration`。
- `status`：`queued`、`generating`、`ready`、`accepted`、`rejected`、`failed`、`cancelled`。
- `prompt`、`negative_prompt`、`prompt_version`。
- `model`、`provider`、`provider_request_id`。
- `width`、`height`、`mime_type`、`file_path`、`sha256`。
- `parent_visual_id`：记录变体、重绘和尺寸派生关系。
- `source_block_ids`：正文插图对应的 Asset Block。
- `alt_text`、`caption`、`focal_point`。
- `generation_job_id`、`attempt_count`、`started_at`、`completed_at`。
- `metadata`：风格预设、seed、供应商参数和安全审核结果。

### 4.2 Asset 元数据

短期继续兼容 `metadata.cover_visual_id`，中期改为结构化角色映射：

```json
{
  "accepted_visuals": {
    "cover": "visual-...",
    "social_square": "visual-..."
  }
}
```

### 4.3 状态流转

```text
queued -> generating -> ready -> accepted
                     |       -> rejected
                     -> failed
queued/generating -> cancelled
```

- 同一 Asset、同一角色最多只有一个 `accepted` 版本。
- `failed` 和 `cancelled` 可以重试，但重试创建新 attempt 或新 visual，必须保留审计信息。
- 删除已接受图片前，应先清除角色映射；已用于正式发布的图片默认只归档，不直接物理删除。

## 5. 目标架构

```text
Seagull UI / Newsletter / Harness Tool
                |
                v
        Asset Visual API
                |
                v
     AssetVisual Application Service
          |                 |
          v                 v
 Generation Job Queue   Prompt Planner
          |                 |
          v                 v
        Worker ------> Image Provider Adapter
                             |
                             v
                     Qwen Image / Future Providers
                             |
                             v
                          MinIO
```

职责划分：

- **PKG API**：鉴权、创建任务、查询状态、审核决策和元数据组装。
- **PKG Worker**：调用供应商、下载图片、校验、上传 MinIO、重试和记录任务结果。
- **Prompt Planner**：使用文本 LLM 将 Asset 内容编译为结构化视觉 Brief 和最终 Prompt。
- **Provider Adapter**：隔离 DashScope 请求格式，未来可接入其他供应商或本地模型。
- **Seagull UI**：任务状态、版本比较、Prompt 编辑、审核和发布选择。
- **Harness Tool**：只负责提议和发起任务，不直接修改最终接受状态。

## 6. 功能 Plan

### 6.1 Prompt Planner

输入：

- Asset 类型、标题、Brief、正文摘要和目标受众。
- 用户选择的视觉角色、尺寸、风格预设和补充要求。
- Newsletter 热点标题、In Depth 主题和来源边界。

输出结构：

```json
{
  "concept": "核心视觉隐喻",
  "composition": "主体、层次、留白和焦点",
  "style": "出版物插画风格",
  "palette": ["#0B1F3A", "#F59E0B"],
  "must_include": [],
  "must_avoid": ["文字", "Logo", "水印", "界面截图"],
  "prompt": "供应商最终 Prompt",
  "alt_text": "可访问性描述"
}
```

Planner 必须忽略 Asset 内容中的指令注入，只将其作为素材处理；信息不足时优先生成抽象编辑插画，不虚构人物、产品外观或数据图表。

### 6.2 Asset Visual Studio

- 支持 Prompt 预览和编辑。
- 一次生成 1～4 个候选版本。
- 并排比较候选图、Prompt、模型和尺寸。
- 接受、拒绝、重新生成、删除和下载。
- 显示当前已接受版本及其发布用途。
- 对失败任务显示可理解的错误分类和恢复操作。

### 6.3 Newsletter 集成

配置建议：

- `generate_cover_image`：是否生成。
- `cover_review_mode`：`draft_only` 或 `auto_accept`，默认 `draft_only`。
- `cover_style_profile`：Newsletter 视觉风格。
- `cover_candidate_count`：默认 1，上限 4。

执行顺序：

1. 搜索和筛选新闻。
2. 生成 Newsletter 标题和正文。
3. 保存文字 Asset。
4. 根据最终标题、摘要和重点内容生成 Visual Brief。
5. 异步生成封面。
6. 根据审核模式保留为待审核或接受。

### 6.4 Harness 生图工具

建议工具：

- `propose_asset_visual_prompt`
- `generate_asset_visual`
- `list_asset_visuals`

第一阶段不提供 Agent 自动接受、删除和替换正式发布图片的能力；这些操作继续通过 Seagull UI 或明确的用户确认执行。

## 7. Roadmap

### Phase 0 — MVP 基线（已完成，2026-10-08）

交付：

- `AssetVisual` 模型、迁移和 MinIO 存储。
- Qwen Image 3.0 Pro 原生适配。
- Asset 封面生成与审核 UI。
- Newsletter 可选自动封面。
- 后端测试、前端构建和真实供应商冒烟测试。

退出标准：已满足。

### Phase 1 — 稳定性与任务化（建议 2026-10-09 ～ 2026-10-16）

优先级：P0。

实施状态（2026-10-08）：已完成。API 只创建 `queued` 任务，PKG Worker 负责 Qwen 调用、MinIO 上传、指数退避重试和卡死任务恢复；Seagull UI 会轮询活动任务，并允许取消 queued/retrying 任务。重复的同内容活动请求会复用现有任务，Newsletter 通过 `auto_accept` 元数据在 Worker 完成后接受封面。系统已增加用户级活动任务上限、供应商/网络/额度/配置/存储错误分类，并将终态、耗时、尝试次数和失败原因记录到 System Jobs。

任务：

1. 将同步生成改为 Worker 异步任务，API 返回 `202 Accepted`。
2. 增加 `queued`、`cancelled`、任务时间和 attempt 信息。
3. 增加用户级并发限制、单任务超时、指数退避和最大重试次数。
4. 对鉴权失败、余额不足、限流、内容安全、供应商超时和下载失败进行错误分类。
5. 增加幂等键，防止重复点击产生重复计费任务。
6. 增加卡死任务回收和 Worker 重启恢复。
7. 在 System Jobs 或专用指标中记录成功率、延迟和失败原因。

验收：

- UI 刷新后仍可看到任务进度。
- API 重启或 Worker 重启不会丢失任务状态。
- 重复提交同一幂等键只生成一次。
- 图片失败不影响 Asset 和 Newsletter 正文。
- P95 任务状态查询接口小于 300ms，不等待供应商返回。

### Phase 2 — 智能 Prompt 与视觉一致性（建议 2026-10-17 ～ 2026-10-30）

优先级：P1。

实施状态（2026-10-09）：Phase 2A 已完成。新增 LLM Visual Planner 和安全降级 Brief，支持编辑概念、构图、最终 Prompt 和 `alt_text`；提供编辑科技、极简抽象、研究简报三种预设；一次可创建 1～4 个共享 Brief 的候选任务，并记录批次、候选序号、风格和 Alt Text。候选任务继续复用 Phase 1 Worker 队列，最终接受仍由用户决定。

Phase 2B Newsletter 切片（2026-10-09）：已完成 `draft_only` / `auto_accept` 审核策略，默认 `draft_only`；Newsletter 可配置视觉风格和 1～4 个候选，并在文字 Asset 创建后调用同一 Visual Planner。为避免多个异步候选完成顺序导致封面随机切换，`auto_accept` 强制只能生成一个候选。

Phase 2B 可访问性切片（2026-10-09）：接受图片前强制要求非空 `alt_text`；旧单图生成接口也会写入基础 Alt Text，Visual Studio 对缺失描述的历史图片禁用接受按钮并提示先保存描述。

Phase 2C 品牌约束切片（2026-10-09）：已将色板、必须包含、禁止元素、风格描述和标题安全区暴露为可编辑结构化 Brief；标题安全区支持左、右、上、下、中间或不保留，并会写入候选任务 Prompt 与审计元数据。

Phase 2D 候选批次工作台（2026-10-10）：已按 `batch_id` 分组展示历史候选，提供同批次并排大图比较和原图打开能力；可从保存的 Visual Brief、风格、尺寸和候选数量创建全新批次，旧图片保持不可变并继续保留审核历史。

Phase 2E 轻量风格记忆（2026-10-10）：Visual Planner 会按用户、角色和风格预设读取其他 Asset 中已接受封面的结构化元数据，仅聚合色板和标题安全区偏好，并记录样本 Visual ID。历史主题、Prompt、Alt Text、人物、产品、数据和正文内容不会进入风格记忆；当前用户选择的风格预设始终优先。

任务：

1. 增加 Prompt Planner 和结构化 Visual Brief。
2. 提供 Newsletter、深度科技文章、研究简报等风格预设。
3. 支持 Prompt 预览、编辑和 2～4 个候选版本。
4. 生成并保存 `alt_text`。
5. 增加品牌色、禁止元素和构图留白配置。（已完成 Phase 2C）
6. 对历史接受结果建立轻量风格记忆，但不得复用图片事实内容。（已完成 Phase 2E）

验收：

- 生成前可查看并修改视觉 Brief。
- 同一风格预设在不同 Newsletter 中保持稳定的构图和配色倾向。
- 用户可在候选版本间比较并明确接受一个版本。
- 所有接受图片都有可编辑的 `alt_text`。

### Phase 3 — 多发布位与视觉工作台（建议 2026-11-02 ～ 2026-11-20）

优先级：P1。

实施状态（2026-10-10）：Phase 3 已完成。Asset Visual 契约和 Production 工作台支持 `cover`、`social_square`、`social_portrait`、`inline_illustration`；正文插图通过 `source_block_ids` 关联 Asset Block，并按 Block 维护接受映射。社交图和正文插图可通过 `parent_visual_id` 基于已接受封面进行同系列重绘，不对原图做裁切。Markdown、HTML 和微信公众号草稿会自动注入已接受视觉及 `alt_text`；正式导出或发布把引用写入 `metadata.visual_delivery_snapshot`，已接受或已交付视觉不能被物理删除。HTML 与微信交付使用内嵌图片数据避免 MinIO 临时签名过期，预览仍使用短期签名 URL。Production 会提示已删除 Block 形成的孤立插图，并提供稳定下载文件名。焦点位置与交互式裁切不再纳入当前产品范围。

任务：

1. 扩展 `cover`、`social_square`、`social_portrait` 和 `inline_illustration`。（已完成）
2. 增加角色级接受映射和历史版本比较。（已完成）
3. 支持基于已接受封面的尺寸派生或重绘。（已完成：采用重绘）
4. 提供稳定下载命名规则；焦点位置和裁切预览明确不做。（已完成）
5. 正文插图与 Asset Block 建立关联。（已完成）
6. 导出 HTML/Newsletter 时按角色自动注入图片和 `alt_text`。（已完成）

验收：

- 一个 Asset 可同时维护多个视觉角色。
- 导出结果稳定引用已接受图片，不引用待审核或失败版本。
- 正文插图可以追踪到对应 Block，Block 删除后提示处理孤立图片。

### Phase 4 — Newsletter 与 Agent 工作流深化（建议 2026-11-23 ～ 2026-12-11）

优先级：P2。

任务：

1. Newsletter 增加 `draft_only` / `auto_accept` 审核策略，默认待审核。
2. 将生图任务状态展示在 Newsletter Run 详情中。
3. 增加 Harness 生图工具，允许 Agent 提议 Prompt 和创建任务。
4. 支持“正文完成后再生图”和“选定最热标题后再生图”的明确依赖。
5. 支持失败后单独重跑视觉步骤，不重跑新闻搜索和正文生成。

验收：

- Newsletter 图片失败后可独立重试。
- Agent 无法在缺少用户确认时接受或删除图片。
- Run 记录能够追踪文字 Asset、Visual Brief、生成任务和最终图片。

### Phase 5 — 成本、治理与多供应商（建议 2026-12-14 以后）

优先级：P2。

任务：

1. 接入用户级 API Credential 或受控的组织级额度。
2. 记录模型、尺寸、候选数、调用次数和估算成本。
3. 增加日/月预算、角色权限和管理端开关。
4. 增加内容安全策略、审计日志和发布后保留策略。
5. 抽象 Provider Adapter，按需增加备用供应商或本地模型。
6. 仅在明确业务需要时增加局部重绘、参考图和品牌模板能力。

验收：

- 可以按用户和时间范围查看用量。
- 超预算任务在调用供应商前被阻止，并提供明确原因。
- 切换供应商不改变 Asset Visual API 和审核流程。

## 8. 优先级建议

下一步不要立即扩展更多图片类型，应按以下顺序投入：

1. **异步任务化与失败恢复**。
2. **Prompt Planner 与候选版本**。
3. **Newsletter 待审核模式**。
4. **多发布位和导出集成**。
5. **Agent 工具、成本治理和多供应商**。

原因：当前供应商调用已经可用，最大的产品风险不是“不能生成”，而是长请求、重复计费、不可恢复以及生成结果缺少内容针对性。

## 9. 衡量指标

建议上线后记录：

- 生成任务成功率、失败类型分布和 P50/P95 时延。
- 每个 Asset 的平均候选数和重新生成次数。
- `ready -> accepted` 转化率。
- Newsletter 开启生图比例和图片失败对文字任务的影响次数。
- 每张接受图片的调用次数与估算成本。
- 用户从生成到接受的耗时。
- 被删除、拒绝以及发布后替换的比例。

初期目标建议：

- 供应商可用时生成成功率不低于 95%。
- 图片失败导致文字 Asset 创建失败的次数为 0。
- 重复点击导致的重复计费任务为 0。
- 80% 以上接受图片在不超过 3 个候选版本内产生。

## 10. 非目标

当前 Roadmap 不包含：

- 将生成图片自动转为 Source 或证据。
- 通用图片社区、素材市场或公开图库。
- 视频生成、3D 资产和复杂图像编辑器。
- 未经审核自动生成数据图表、产品 UI 截图或真实人物照片。
- 同时维护大量供应商；多供应商只在稳定性、成本或合规需求明确后引入。

## 11. 下一迭代建议

建议继续完成 **Phase 2B：视觉一致性收口**，拆成以下工程包：

1. 将品牌色、必须包含和禁止元素改为可编辑结构化字段。
2. 增加候选批次折叠、并排大图比较和批次级重新生成。
3. 从历史接受结果提取轻量风格偏好，不复用事实内容。（已完成 Phase 2E）
4. 在 Newsletter Run 详情展示 Visual Brief、任务状态和最终接受图片。（已完成 2026-10-10）

Phase 2B 完成后再扩展多发布位，避免在视觉风格和审核策略尚未稳定时扩大角色数量。
