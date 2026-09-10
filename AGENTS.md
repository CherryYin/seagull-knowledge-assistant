# AGENTS.md

DeepSeek Knowledge Lab — 基于 DeepSeek Harness 的个人知识 agent 实验平台。

## 项目定位

用 DeepSeek Harness 作为 agent 运行时，对接 personal_knowledge_graph (PKG/Seagull) 的知识 API，构建**知识获取 → 消费 → 产出**的 agent 实验闭环。可在同一任务上对比不同 prompt/策略/模型的表现，记录全流程轨迹。

## 目录结构

```
deepseek-knowledge-lab/
├── plugins/            # deepseek-harness 插件与 Lab 运行时模块
│   ├── pkg-client/     # PKG 知识 API 客户端插件
│   └── agent-memory/   # Harness Agent Memory 领域存储（由 BFF 调用）
├── experiments/        # 实验任务模板（Markdown prompt + 配置）
├── config/             # dsh 配置文件
│   ├── cordis.patch.yml   # 插件补丁，注入 pkg-client 等自定义插件
│   └── settings.yaml      # 运行时设置（模型、参数等）
├── docs/               # 项目文档
├── .dsh/               # dsh 本地状态，包含 .env（API key 等）
└── AGENTS.md           # 本文件
```

## 核心工作流

1. **知识获取**：agent 通过 pkg-client 插件调用 PKG 的 `/api/search`、`/api/notes`、`/api/sources` 等接口检索知识。
2. **知识消费**：agent 阅读、分析、关联检索到的知识片段。
3. **知识产出**：agent 结果保留在 Harness Session/Workflow；用户在 Seagull UI 明确 Keep/Save/Publish 后才写回 PKG。
4. **实验追踪**：DeepSeek Harness 的 Trajectory View 记录完整执行轨迹，可 replay/fork/对比。
5. **长期记忆**：Agent Memory Candidate 由用户确认后才激活，默认保存在 Harness/Lab 所有的 PostgreSQL 独立表，不写入 PKG 知识实体；文件后端只用于隔离测试或显式本地回退。
6. **Asset 生产**：Seagull 先确认 Intent，再要求用户完成 Evidence 与 Claim Gate，之后才启动 `draft-asset` 生成初稿。初稿只能使用已接受 Evidence、已接受 Claim 或保留 Hypothesis，不得在写作阶段静默引入新检索结果；需要补证时必须返回 Evidence 流程。Web 搜索结果必须引用真实 URL，未导入 PKG 前不得伪装成 `[Source: id]`。Agent 只生成草稿和 Session Context，不自动创建或发布 PKG Asset。
7. **Asset Block 修订**：`revise-asset-block` preset 可针对单个 Block 澄清修改意图并检索证据，最终只能通过 `propose_asset_block_patch` 返回结构化候选补丁；候选 `claimRefs` 只能引用 Accepted Claim 或保留 Hypothesis。Seagull 展示 Diff，用户确认后只更新本地编辑态，仍需显式保存才写入 PKG。
8. **Asset Evidence**：`collect-asset-evidence` preset 围绕已确认 Intent 检索并通过 `propose_asset_evidence` 返回候选；工具本身不写 PKG，用户在 Seagull Evidence Board 确认后才保存或接受证据。
9. **Asset Claims**：`analyze-asset-claims` preset 只引用 Workspace Evidence，通过 `propose_asset_claims` 返回 Agent 署名的 Candidate Claim；接受、编辑、拒绝或保留为假设必须在 Seagull Claim Gate 完成。
10. **Asset 整篇优化**：`revise-asset-document` preset 在当前 Intent 已确认、Evidence 与 Claim 决策已完成后使用；Contribution 与 Knowledge Candidate 可为优化提供上下文，但不阻塞正文润色。Agent 通过 `propose_asset_document_patch` 返回完整文档替换候选，Seagull 校验 Workspace revision、文档签名与 Claim 引用；用户确认后仅应用到本地编辑态，仍需显式保存才写入 PKG。后续优化轮次会携带最新确定性质量审计和上一轮记录，只有应用并保存后才计为完成一轮。
11. **PDF Source Mind Map**：`generate-source-mind-map` preset 只接收 Source Metadata、Source basis、最多 40 个章节摘要和 80 个均匀抽样的 Chunk 摘要；禁止传入整篇 PDF 原文。Agent 必须直接通过 `propose_source_mind_map` 返回目标 18–28、最多 32 个节点的结构化候选，不得在工具参数中回显输入摘要；事实节点只能引用输入中提供的 Chunk，Chunk 归属与引文真实性由 PKG 基于当前 Source 验证，且候选仍需用户确认，不能直接创建或覆盖正式 Map。Selected Branch Expansion 还必须保持当前 `map_id`、`base_version`、`target_node_id`，Proposal 根只作为现有节点锚点，确认后只在该锚点下安全合并后代。

## PKG API 对接要点

- PKG 是 FastAPI 服务，默认运行在 `http://localhost:8000`
- 用户认证由 Seagull BFF 统一处理：浏览器登录 PKG 后，BFF 按 Harness Session 绑定当前用户 JWT
- `pkg-client` 通过 BFF `/internal/pkg/*` 调用 PKG，并从工具执行上下文读取 Harness Session ID；禁止把用户名、密码或 JWT 写入 Prompt/工具参数
- `pkg-web-search` 将 `web_search` 注册为 Harness 工具，并通过 `pkg-client`、BFF Session 认证和 PKG `/discovery/web-search/preview` 复用 PKG 的 Tavily 搜索；该接口只返回结果，不自动写入 Discovery 或其他 PKG 实体
- Chat 模型目录、平台默认模型和 Session 模型选择归 Harness；Seagull 通过 BFF 的 `/api/harness/models` 与 `/api/harness/model-settings` 使用 `llm.models`、`settings.update` 和 `session.selectModel`，不得再从 PKG `/knowledge/models` 驱动 Chat Agent
- `pkg-client` 的 Agent 工具面必须保持只读；PKG 写入由 Seagull UI 的显式用户动作负责
- Asset 自动检索遵循“PKG 优先、Web 补缺”；Web 结果不会自动导入 PKG，只有用户显式保存的最终 Asset 才进入耐久知识层
- 核心接口：
  - `POST /api/search` — 知识检索（支持 sql/vector/hybrid 模式）
  - `GET/POST /api/notes` — 笔记 CRUD
  - `GET /api/sources` — 知识源列表
  - `GET /api/wiki` — wiki 页面

## 开发约定

- 插件使用 TypeScript，遵循 Cordis 插件规范
- 实验模板用 Markdown，包含任务描述、预期输入输出、评估标准
- 配置变更通过 `cordis.patch.yml` 而非直接修改 bundle
- 不在本 repo 中提交 `.dsh/.env`（含 API key）
- 保持 AGENTS.md 更新当插件、工具或实验流程有变更时

## 运行

```bash
# 启动 PKG 后端（在 personal_knowledge_graph 目录）
docker compose up -d
pkg serve

# 启动 DeepSeek Harness Web UI（在本 repo）
npm run dev
```
