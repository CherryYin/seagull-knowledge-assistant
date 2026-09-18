# DeepSeek Knowledge Lab

基于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的个人知识 agent 实验平台。

对接 [Personal Knowledge Graph (PKG / Seagull)](../personal_knowledge_graph) 的知识 API，构建**知识获取 → 消费 → 产出**的实验闭环。

## 核心能力

- **知识检索**：通过 `pkg_search` 工具在 PKG 中搜索 sources、notes、memory nodes 和 wiki
- **深度阅读**：`pkg_read_note` / `pkg_read_source` 获取完整内容
- **知识产出**：Agent 结果默认留在 Harness Session；用户在 Seagull 明确点击保存后才写回 PKG
- **实验对比**：同一任务用不同 prompt/策略/模型跑，Harness 的 Trajectory View 完整记录每一步
- **回放复现**：支持 fork/replay，从同一分叉点尝试不同策略

## 快速开始

### 前置条件

1. Node.js >= 22.19.0
2. PKG 后端运行中（`http://localhost:8000`）
3. DeepSeek API Key
4. PKG PostgreSQL 可访问（Stage C shadow write）

### 安装 & 启动

```bash
# 1. 配置 API Key
cp .dsh/.env.example .dsh/.env
# 编辑 .dsh/.env，填入 DEEPSEEK_API_KEY

# 2. 安装 dsh（首次）
npm install

# 3. 安装 web/headless profile 的本地插件依赖
npm run profiles:install

# 4. 验证两个 profile 可以完成配置组装
npm run profiles:check

# 5. 启动 DeepSeek Harness Web UI
npm run dev
# 或：npx @deepseek-ai/dsh web --profile knowledge-agent
```

打开 `http://127.0.0.1:3080`，在聊天框中输入任务即可开始实验。

### 一键启动完整平台

在本目录运行：

```bash
npm run stack:check   # 首次运行先检查环境
npm run stack:start   # PostgreSQL/MinIO、PKG API/Worker、Harness、BFF、Seagull
npm run stack:status  # 查看各进程状态
npm run stack:logs    # 汇总跟踪日志，Ctrl-C 只退出日志查看
npm run stack:stop    # 停止应用进程和 Docker 基础设施
```

启动完成后访问 Seagull `http://127.0.0.1:5173`；Harness 调试界面位于
`http://127.0.0.1:3080`。PID 保存到 `.dsh/run/dev-stack/`，日志保存到
`.dsh/logs/dev-stack/`。

在 Monorepo 中也可以直接使用根目录的 `scripts/dev-stack.sh`：

```bash
../scripts/dev-stack.sh restart --skip-worker
../scripts/dev-stack.sh stop --keep-infra
../scripts/dev-stack.sh logs harness
```

### 注册 pkg-client 插件

```bash
dsh plugin add ./plugins/pkg-client
```

## 目录结构

```
deepseek-knowledge-lab/
├── plugins/pkg-client/     # PKG API 客户端插件（Cordis）
│   └── src/index.ts        # 插件源码：10 个 agent 工具
├── experiments/            # 实验模板
│   ├── 01-summarize-source.md   # 总结质量 A/B
│   ├── 02-research-topic.md     # 深度研究 pipeline
│   ├── 03-wiki-refresh.md       # 知识消费→产出闭环
│   └── 04-compare-models.md     # 跨模型对比
├── config/
│   ├── cordis.patch.yml    # 插件注入配置
│   └── settings.yaml       # 模型/参数/系统提示词
├── .dsh/.env.example       # 环境变量模板
├── AGENTS.md               # Workspace profile
└── README.md               # 本文件
```

## Agent 工具列表

| 工具名 | 功能 | 对应 PKG API |
|--------|------|-------------|
| `pkg_search` | 搜索知识库（sql/vector/hybrid） | `POST /api/search` |
| `pkg_read_note` | 读取笔记全文 | `GET /api/notes/:id` |
| `pkg_list_notes` | 浏览笔记列表 | `GET /api/notes` |
| `pkg_read_source` | 读取知识源全文 | `GET /api/sources/:id` |
| `pkg_list_sources` | 浏览知识源列表 | `GET /api/sources` |
| `pkg_knowledge_stats` | 知识库统计 | `GET /api/dashboard` |

`pkg-client` 对 Agent 仅暴露 6 个读取/检索工具。PKG 知识统一通过 `pkg_search` 的 hybrid 模式检索；保存笔记、Writing Document 或其他持久化操作由 Seagull UI 的显式用户动作发起。

## 实验工作流

1. 在 `experiments/` 中选择一个实验模板
2. 按 Variant A 的 prompt 在 dsh UI 中启动 agent
3. 观察 Trajectory View 中的工具调用和推理过程
4. Fork → 用 Variant B 的 prompt 重跑
5. 对比两次运行的轨迹、产出质量和 token 消耗
6. 记录结论，优化 PKG 中的 workflow 模板

## 配置

- `PKG_GATEWAY_URL`：Harness 的 PKG 工具代理地址，默认 `http://127.0.0.1:4000/internal/pkg`
- `HARNESS_SERVICE_TOKEN`：Harness 调用 BFF 内部 PKG Proxy 的服务密钥；非回环部署必须显式设置至少 32 字符的随机值，本地默认 token 仅允许 loopback Gateway
- `PKG_DATABASE_URL`：Harness Session 与 Agent Memory 使用的 PostgreSQL 连接串；必须是 `postgresql://` 格式
- `AGENT_MEMORY_DATABASE_URL`：可选的 Agent Memory 独立连接串；未设置时 BFF 使用 `PKG_DATABASE_URL`
- `AGENT_MEMORY_DATABASE_SCHEMA`：Agent Memory 表所在 schema，默认 `public`
- 模型和参数在 `config/settings.yaml` 中配置，或在 dsh UI 中实时修改

当前 Session 持久化已完成 Stage E：PostgreSQL 是唯一 writer，JSONL Shadow 已关闭，旧 JSONL 仅作为只读迁移归档。

Agent Memory 首次切换 PostgreSQL 前执行：

```bash
npm run agent-memory:migrate-postgres        # dry-run
npm run agent-memory:migrate-postgres -- --apply
npm run smoke:agent-memory-postgres
```

迁移使用 `public.harness_agent_memory_state`（或配置 schema）按用户保存独立 JSONB 领域状态，并通过行级锁支持多 BFF 实例。原 `.dsh/agent-memory.json` 不会被迁移脚本删除。
