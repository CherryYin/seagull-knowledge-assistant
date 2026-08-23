<p align="center">
  <img src="assets/seagull.png" alt="Seagull Logo" width="180" />
</p>

<h1 align="center">Seagull — Personal Knowledge Graph</h1>

<p align="center">
  一个面向个人研究与知识运营的知识图谱工作台，把 Markdown、PDF、网页、RSS、GitHub、arXiv 和新闻等资料转成可搜索、可追踪、可编排的知识资产。
</p>

<p align="center">
  <a href="README.md">中文</a> | <a href="README.en.md">English</a>
</p>

## 项目定位

Seagull 不是单纯的“资料库”或“聊天工具”，而是一个把原始信息持续沉淀为长期知识资产的系统：

- `Sources`：原始资料，来自本地文件、网页、RSS、GitHub、arXiv、新闻等
- `Notes`：基于资料整理出的结构化笔记
- `Wiki`：围绕主题持续编译的知识页与更新草稿
- `Assets`：面向输出的内容资产，例如 digest、博客草稿、可下载文档
- `Agent Workflows`：由 DeepSeek Harness 执行的总结、整理、研究和发布工作流

系统目标是：**稳定知识存储 + 确定性检索 + Harness 驱动工作流 + 可审计的知识沉淀**。

## 当前核心能力

### 1. 多来源知识摄入

- 导入 Markdown、PDF、DOCX、PPTX、XLSX、HTML、图片等文件
- 直接创建网页型 `source`，当正文留空时自动抓取并抽取可读内容
- 将博客索引页或站点目录作为 `web directory` 导入，自动发现并创建子文章来源
- 搜索并导入 GitHub 仓库、arXiv 论文、新闻结果
- 拉取 RSS 订阅并生成摘要

### 2. 检索与知识组织

- SQL 过滤、向量检索、混合检索
- 文档分块、嵌入与细粒度语义召回
- Sources、Notes、Wiki、Assets 之间可追踪引用与 provenance
- Review Suggestions 帮助识别值得回顾和整理的知识项
- Discover / Paper Discovery 帮助发现外部候选资料

### 3. Harness Agent 与工作流

- Agent Chat、Session、Workflow、Preset、Skill 和运行轨迹由 DeepSeek Harness 承担
- Harness 通过受认证的 PKG API 搜索 Sources、Notes、Wiki 和 Assets
- Seagull UI 提供统一入口，并由共享网关校验 PKG 用户与 Harness Session 所有权
- Agent 输出默认保留在 Harness；只有用户明确 Keep / Save / Publish 后才写回 PKG
- PKG 仅保留轻量 `/action/complete`，用于 Note AI direct completion，不加载工具或创建 Agent Run

### 4. Wiki / 资产 / 调度能力

- Wiki 页面创建、更新、克隆草稿、编译及 Source provenance
- Wiki mining：从近期知识材料中挖掘概念、证据和候选文章草稿
- Wiki suggestions：为已有 wiki 提供增量更新建议
- Assets：生成内容资产并提供下载/详情页
- Digest / Blog generation：基于时间窗口内资料与用户视角生成输出草稿
- System Jobs：观察后台任务、失败信息和运行状态
- 定时任务：支持 RSS 抓取、连接器趋势、发现流程、清理与维护任务
- 定时新闻抓取：可按固定关键词每日搜索过去 24 小时新闻，并按语言批量导入为 news sources

## 典型使用流程

1. 导入资料：上传文件、保存网页、订阅 RSS、搜索导入 GitHub/arXiv/新闻
2. 检索与整理：通过 Search、Notes、Review 页面进行初步归档
3. 让 Agent 工作：在统一 Seagull UI 中调用 Harness 完成总结、研究和转换
4. 沉淀主题知识：把候选概念与资料编译成 Wiki 页面与更新草稿
5. 对外输出：生成 Digest、博客草稿、导出文档等资产

## 主要页面

前端当前包含这些核心页面：

- `Sources` / `Source Detail`：资料管理与查看
- `Notes` / `Note Detail`：笔记整理与导出
- `Search`：统一检索入口
- `Chat`：由 Harness 驱动的 Agent 对话与工作流入口
- `Discover` / `Review` / `Paper Discovery`：发现与回顾
- `Wiki` / `Wiki Discovery` / `Wiki Suggestions` / `Wiki Rules`：Wiki 编译与挖掘
- `Assets` / `Digest` / `Writing`：知识资产与输出页
- `System Jobs`：后台任务观测
- `Settings` / `User Profile` / `Admin Users`：配置与管理

## 技术栈

| 层 | 技术 |
|---|---|
| 后端框架 | FastAPI + Uvicorn |
| 数据库 | PostgreSQL + pgvector |
| ORM | SQLAlchemy 2.0 (async) + Alembic |
| 检索 | SQL 过滤 + Embedding + Hybrid Retrieval |
| LLM / Embedding | OpenAI-compatible providers, Azure OpenAI, Qwen, MiniMax 等 |
| Agent Runtime | DeepSeek Harness（独立运行时） |
| 文档解析 | Docling + OCR（RapidOCR / Tesseract） |
| 文件存储 | MinIO / S3-compatible storage |
| 前端 | React 19 + TypeScript + Vite |
| 测试 | Pytest |

## 快速开始

### 1. 启动基础设施

```bash
docker compose up -d
```

默认会启动：

- PostgreSQL：`localhost:5433`
- MinIO API：`http://127.0.0.1:9000`
- MinIO Console：`http://127.0.0.1:9001`

### 2. 安装依赖

```bash
python -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]"
```

前端依赖：

```bash
cd web
npm install
```

### 3. 配置环境变量

```bash
cp .env.example .env
```

建议至少配置：

| 变量 | 说明 |
|---|---|
| `DATABASE_URL` | 后端数据库连接 |
| `DATABASE_URL_SYNC` | Alembic / 同步场景连接 |
| `JWT_SECRET_KEY` | JWT 签名密钥 |
| `ADMIN_INIT_PASSWORD` | 管理员初始化密码 |
| `MINIO_ENDPOINT` / `MINIO_ACCESS_KEY` / `MINIO_SECRET_KEY` | 对象存储配置 |
| `EMBEDDING_API_KEY` | 向量嵌入所需密钥 |
| `LLM_PROVIDER` | 默认 LLM provider |
| `QWEN_API_KEY` / `AZURE_OPENAI_API_KEY` / `MINIMAX_API_KEY` | 对应模型提供方密钥 |
| `LLM_PROVIDERS` | OpenAI-compatible provider 注册表 |
| `TAVILY_API_KEY` | Discover / Web 搜索能力 |
| `NEWSAPI_API_KEY` | 新闻连接器 |
| `NEWS_AUTO_SEARCH_ENABLED` | 是否启用每日新闻自动搜索 |
| `NEWS_AUTO_SEARCH_QUERY` | 每日新闻检索关键词，默认 `AI, LLM, Agent, workflow` |
| `NEWS_AUTO_SEARCH_WINDOW_HOURS` | 检索回看时间窗，默认 `24` 小时 |
| `NEWS_AUTO_SEARCH_EN_LIMIT` / `NEWS_AUTO_SEARCH_ZH_LIMIT` | 英文 / 中文新闻每日导入上限 |
| `NEWS_AUTO_SEARCH_DAILY_TIME_UTC` | 每日执行时间（UTC），默认 `01:30` |
| `SEMANTIC_SCHOLAR_API_KEY` / `OPENALEX_API_KEY` | 学术与论文发现 |

> 不要把真实 `.env` 提交到仓库。仓库已忽略 `.env`，请自行保管和轮换密钥。

### 4. 初始化数据库

```bash
alembic upgrade head
```

### 5. 启动服务

后端：

```bash
pkg serve
```

`pkg serve` 默认以单进程模式运行；开发时需要热重载可使用 `pkg serve --reload`。

周期任务由独立 Worker 进程运行：

```bash
pkg worker
```

可用 `pkg worker --poll-interval 30` 调整检查间隔，或通过
`KG_DISABLE_BACKGROUND_TASKS=1` 显式禁用 Worker。

前端：

```bash
cd web
npm run dev
```

## 常用开发命令

```bash
# 后端测试
.venv/bin/python -m pytest

# 运行指定测试
.venv/bin/python -m pytest tests/test_connectors.py

# Python 文件快速语法检查
python -m py_compile src/pkg/api/app.py

# 数据库迁移
alembic upgrade head
```

## 关键后端模块

- `src/pkg/api/app.py`：FastAPI 应用与路由装配
- `src/pkg/api/completion.py`：Note AI 使用的轻量 direct completion
- `src/pkg/api/sources.py` / `src/pkg/api/notes.py` / `src/pkg/api/wiki.py`：资料、笔记、Wiki 主接口
- `src/pkg/api/connectors.py`：GitHub、arXiv、新闻等连接器接口
- `src/pkg/api/system_jobs.py`：后台任务观测接口
- `src/pkg/services/foundation/retriever.py`：SQL / vector / hybrid 知识检索
- `src/pkg/services/foundation/web_extractor.py`：网页抽取
- `src/pkg/services/foundation/web_directory.py`：网页目录发现与子文章导入
- `src/pkg/services/foundation/wiki_concept_discovery.py`：Wiki 概念发现与候选推荐
- `src/pkg/services/cross_cutting/scheduler.py`：调度能力

## API 概览

当前主要路由分组包括：

- `/auth`
- `/sources`
- `/notes`
- `/search`
- `/action/complete`
- `/chat-sessions`
- `/assets`
- `/wiki`
- `/connectors`
- `/calendar/reminders`
- `/review`
- `/discovery`
- `/paper-discovery`
- `/system/jobs`
- `/models`

## 适合谁用

Seagull 适合这些场景：

- 持续收集和整理研究资料的个人研究者
- 同时管理网页、论文、RSS、GitHub 信息流的技术从业者
- 希望把零散输入沉淀成长期知识库、主题 Wiki 和写作资产的人
- 想要在个人知识库上运行可控 Agent 工作流的开发者

> Agent Runtime 不在 PKG 内运行。交互式 Agent 能力由 `deepseek-knowledge-lab` 中的 DeepSeek Harness 提供。

## 开发说明

- 保持改动聚焦，优先修根因
- 数据模型变化需同步 Alembic migration
- API schema 变化需同步前端 client 和页面
- 涉及 Agent 工具、工作流、连接器、后台任务的变更，请同步更新 `AGENTS.md`
- 项目文档请放在 `docs/` 下的主题目录中

## License

如需开源/内部分发策略，请按你的实际仓库策略补充许可证说明。
