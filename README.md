<p align="center">
  <img src="assets/seagull.png" alt="Seagull Logo" width="180" />
</p>

<h1 align="center">Seagull — Personal Knowledge Graph</h1>

<p align="center">
  三层架构的个人知识挖掘系统，将 Markdown 笔记、PDF 文档、网页等原始资料转化为可搜索、可对话的智能知识库。
</p>

<p align="center">
  <a href="README.md">中文</a> | <a href="README.en.md">English</a>
</p>

## 架构概览

```
L1 Sources (原始资料)  →  L2 Notes (结构化笔记)  →  L3 Insights (洞察) [planned]
         ↓                        ↓
   向量嵌入 + 分块嵌入         向量嵌入 + 结构化元数据
   + 全文索引                  + 全文索引
         ↓                        ↓
              ┌─────────────────────┐
              │   Retriever Agent   │  (确定性检索: SQL / 向量 / 混合)
              └─────────┬───────────┘
                        ↓
              ┌─────────────────────┐
              │    Action Agent     │  (模型驱动: Strands Agent + LLM)
              │   9 个内置工具       │
              │   + 动态加载 Skills  │
              └─────────────────────┘
```

- **Retriever Agent** — 确定性检索层，支持 SQL 过滤、向量语义搜索和混合检索
- **Action Agent** — 基于 Strands Agents 的 LLM Agent，自主调用知识库工具完成复杂任务

## 核心特性

- **多格式文档摄入** — 支持 PDF、DOCX、PPTX、XLSX、HTML、图片，自动 OCR 识别扫描件（Tesseract / RapidOCR）
- **智能分块与嵌入** — 长文档自动分块（512 字符，64 字符重叠），每个块独立嵌入，支持细粒度语义检索
- **三模式搜索** — 向量语义搜索、SQL 结构化过滤、混合检索，自动选择最优模式
- **AI Agent 对话** — 支持多轮对话，Agent 可自主搜索知识库、读取文档、处理文件、搜索互联网
- **Web 搜索** — 集成 Tavily API，Agent 可实时检索互联网信息
- **Skills 系统** — 可复用的 prompt 模板（20+ 内置 skill），支持自定义 Python 工具扩展
- **文件存储** — MinIO / S3 兼容对象存储，支持文件上传和预签名 URL 下载
- **多轮会话持久化** — 对话历史存储在数据库中，支持会话管理和历史回放
- **Agent Profile** — 用户可创建多个 Agent 配置（自定义指令、模型选择、工具/技能白名单、temperature），在对话中自由切换

## 技术栈

| 层 | 技术 |
|---|---|
| 后端框架 | FastAPI + Uvicorn |
| 数据库 | PostgreSQL 16 + pgvector (HNSW 索引) |
| ORM | SQLAlchemy 2.0 (async) + Alembic |
| 嵌入模型 | Qwen `text-embedding-v4` (1024 维) |
| LLM | Azure OpenAI / 通义千问 (可切换) |
| Agent 框架 | Strands Agents |
| 文档解析 | Docling (PDF/DOCX/PPTX/XLSX) + Tesseract OCR |
| Web 搜索 | Tavily API |
| 文件存储 | MinIO (S3 兼容) |
| CLI | Typer + Rich |
| 前端 | React 19 + TypeScript + Tailwind CSS 4 + Vite |

## 快速开始

### 1. 启动基础服务

```bash
docker compose up -d
```

启动 PostgreSQL 和 MinIO：

- PostgreSQL: `localhost:5433`
- MinIO API: `http://127.0.0.1:9000`
- MinIO Console: `http://127.0.0.1:9001`

### 2. 安装依赖

```bash
python -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]"
```

Tesseract OCR（可选，用于扫描件识别）：

```bash
sudo apt install tesseract-ocr tesseract-ocr-eng tesseract-ocr-chi-sim libtesseract-dev
```

### 3. 配置环境变量

```bash
cp .env.example .env
```

主要配置项：

| 变量 | 说明 | 默认值 |
|---|---|---|
| `LLM_PROVIDER` | LLM 提供商 (`azure` / `qwen`) | `qwen` |
| `QWEN_API_KEY` | 通义千问 API Key | — |
| `MINIMAX_API_KEY` | MiniMax API Key | — |
| `LLM_PROVIDERS` | OpenAI-compatible 多模型提供方 JSON 配置 | `[]` |
| `MANUAL_LLM_MODELS` | 手动注册模型列表（用于不支持 `/models` 的 provider） | `[]` |
| `EMBEDDING_API_KEY` | Embedding API Key | — |
| `EMBEDDING_MODEL` | 嵌入模型 | `text-embedding-v4` |
| `TAVILY_API_KEY` | Tavily Web 搜索 API Key | — |
| `AZURE_OPENAI_API_KEY` | Azure OpenAI Key（使用 Azure 时） | — |
| `DATABASE_URL` | 数据库连接 | `postgresql+asyncpg://...localhost:5433/knowledge_graph` |
| `POSTGRES_PASSWORD` | PostgreSQL 密码（Docker Compose 使用） | — |
| `MINIO_ENDPOINT` | MinIO 端点 | `http://127.0.0.1:9000` |
| `MINIO_ROOT_PASSWORD` | MinIO 密码（Docker Compose 使用） | — |
| `DOCLING_OCR_ENGINE` | OCR 引擎 (`tesseract` / `rapidocr`) | `tesseract` |
| `CHUNK_SIZE` | 分块大小（字符） | `512` |
| `CHUNK_OVERLAP` | 分块重叠（字符） | `64` |
| `ALLOWED_MODELS` | 用户可选的 LLM 模型列表（JSON 数组） | `["qwen-plus","qwen-max","qwen-turbo"]` |
| `JWT_SECRET_KEY` | JWT 签名密钥（至少 32 字符） | — |
| `ADMIN_INIT_PASSWORD` | 管理员初始密码 | — |

### 4. 初始化数据库

```bash
alembic upgrade head
```

### 5. 导入知识

将文件放入 `data/sources/`（原始资料）和 `data/notes/`（笔记），支持 Markdown 和二进制文档（PDF、DOCX 等）：

```bash
pkg sync
```

### 6. 启动服务

**后端 API:**

```bash
# 方式一：使用 CLI 命令（推荐开发时使用，自带 hot reload）
pkg serve

# 方式二：直接使用 uvicorn
uvicorn pkg.api.app:app --host 127.0.0.1 --port 8000 --reload
```

后端默认运行在 `http://localhost:8000`，Swagger 文档在 `http://localhost:8000/docs`。

**前端:**

```bash
cd web
npm install    # 首次运行或依赖变更时
npm run dev
```

前端默认运行在 `http://localhost:8005`，已配置代理转发 `/api` 请求到后端。联调脚本会让前后端都监听 `0.0.0.0`，方便从服务器外部访问。

**一键联调（前后端一起跑）:**

```bash
npm run install:web   # 首次运行或前端依赖变更时
npm run dev:all       # 前台同时启动前后端
npm run dev:all-bg    # 后台同时启动前后端
npm run dev:status    # 查看后台前后端状态与最近日志
npm run dev:stop      # 停止后台前后端进程
```

后台联跑日志默认写入：

- `tmp/dev/backend.log`
- `tmp/dev/frontend.log`

## CLI 使用

```bash
pkg sync                                          # 同步文件到数据库
pkg search "知识图谱"                              # 搜索知识库
pkg search "embedding" --mode vector --top-k 10   # 向量搜索
pkg add-note "会议纪要" --content "..." --tags meeting   # 添加笔记
pkg add-source "论文标题" --source-type article    # 添加资料
pkg stats                                          # 查看统计
pkg ask "帮我总结关于三层架构的设计思路"            # 单轮问答
pkg chat                                           # 多轮对话
pkg skills                                         # 列出可用 skills
pkg serve                                          # 启动 API 服务
```

## Agent 工具

Action Agent 拥有以下内置工具，可根据任务自主选择调用：

| 工具 | 说明 |
|---|---|
| `search_knowledge` | 语义/结构化搜索知识库 |
| `read_note` | 读取笔记全文 |
| `read_source` | 读取资料全文 |
| `list_notes` | 按领域/标签/项目浏览笔记 |
| `list_sources` | 按类型浏览资料 |
| `knowledge_stats` | 知识库统计信息 |
| `process_document` | 文档处理（PDF/DOCX/XLSX/PPTX 操作） |
| `web_search` | 互联网搜索（Tavily） |

此外，Agent 还会动态加载 `skills/` 目录下的 Skill 工具。

## API 端点

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/health` | 健康检查 |
| `GET/POST` | `/sources` | 资料列表 / 创建 |
| `POST` | `/sources/upload` | 上传资料文件 |
| `GET` | `/sources/{id}` | 获取资料详情 |
| `GET` | `/sources/{id}/file` | 下载资料原文件 |
| `GET/POST` | `/notes` | 笔记列表 / 创建 |
| `PATCH` | `/notes/{id}` | 更新笔记 |
| `POST` | `/notes/upload` | 上传笔记文件 |
| `POST` | `/search` | 搜索知识库 |
| `POST` | `/action` | 调用 Action Agent |
| `POST` | `/action/stream` | 流式调用 Action Agent |
| `GET/POST` | `/chat-sessions` | 会话管理 |
| `GET/PATCH/DELETE` | `/chat-sessions/{id}` | 会话详情/更新/删除 |
| `GET/POST` | `/agent-profiles` | Agent Profile 管理 |
| `GET/PATCH/DELETE` | `/agent-profiles/{id}` | Profile 详情/更新/删除 |
| `POST` | `/agent-profiles/{id}/set-default` | 设为默认 Profile |
| `GET` | `/agent-profiles/available-tools` | 可用工具列表 |
| `GET` | `/agent-profiles/allowed-models` | 可选模型列表 |
| `GET/POST` | `/skills` | Skills 管理 |
| `POST` | `/sync` | 触发文件同步 |

## 项目结构

```
src/pkg/
├── api/                    # FastAPI 路由
│   ├── app.py              # 应用入口 & 中间件
│   ├── sources.py          # 资料 CRUD + 文件上传
│   ├── notes.py            # 笔记 CRUD + 文件上传
│   ├── search.py           # 搜索 + 同步接口
│   ├── action.py           # Action Agent 接口（同步/流式）
│   ├── chat_sessions.py    # 多轮对话会话管理
│   ├── agent_profiles.py   # Agent Profile CRUD
│   └── skills.py           # Skills CRUD
├── models/                 # SQLAlchemy 模型
│   ├── source.py           # Source + SourceEmbedding + SourceChunk
│   ├── note.py             # Note + NoteEmbedding
│   ├── chat_session.py     # ChatSession
│   ├── agent_profile.py    # AgentProfile
│   └── skill.py            # Skill
├── schemas/                # Pydantic 验证模型
├── services/
│   ├── retriever.py        # 检索 Agent (SQL/向量/混合)
│   ├── action_agent.py     # Action Agent + 系统提示词
│   ├── llm.py              # LLM 客户端工厂 (Azure/Qwen)
│   ├── embedding.py        # 嵌入服务（批量自动分片）
│   ├── chunking.py         # 文档分块
│   ├── document_extractor.py  # Docling 文档提取 + OCR
│   ├── storage.py          # MinIO 对象存储
│   ├── sync_pipeline.py    # 文件同步管道
│   ├── tools.py            # 知识库工具（搜索/读取/统计）
│   ├── tools_web.py        # Web 搜索工具（Tavily）
│   ├── tools_document.py   # 文档处理工具
│   └── skills.py           # Skill 加载与展开
├── cli.py                  # Typer CLI
├── config.py               # 配置管理
└── db.py                   # 数据库连接
web/                        # React 前端
├── src/pages/              # 页面：Chat, Search, Notes, Sources, Skills, Profiles
├── src/components/         # 组件：ChatMessage, SearchResultCard, Layout
└── src/lib/                # API 客户端, 工具函数
skills/                     # Skill 模板（20+ 内置）
data/
├── sources/                # 原始资料
└── notes/                  # 结构化笔记
```

## License

Private project.
