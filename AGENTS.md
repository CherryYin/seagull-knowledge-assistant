# AGENTS.md

DeepSeek Knowledge Lab — 基于 DeepSeek Harness 的个人知识 agent 实验平台。

## 项目定位

用 DeepSeek Harness 作为 agent 运行时，对接 personal_knowledge_graph (PKG/Seagull) 的知识 API，构建**知识获取 → 消费 → 产出**的 agent 实验闭环。可在同一任务上对比不同 prompt/策略/模型的表现，记录全流程轨迹。

## 目录结构

```
deepseek-knowledge-lab/
├── plugins/            # deepseek-harness 插件（Cordis 插件系统）
│   └── pkg-client/     # PKG 知识 API 客户端插件
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

## PKG API 对接要点

- PKG 是 FastAPI 服务，默认运行在 `http://localhost:8000`
- 用户认证由 Seagull BFF 统一处理：浏览器登录 PKG 后，BFF 按 Harness Session 绑定当前用户 JWT
- `pkg-client` 通过 BFF `/internal/pkg/*` 调用 PKG，并从工具执行上下文读取 Harness Session ID；禁止把用户名、密码或 JWT 写入 Prompt/工具参数
- `pkg-client` 的 Agent 工具面必须保持只读；PKG 写入由 Seagull UI 的显式用户动作负责
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
