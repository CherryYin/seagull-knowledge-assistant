# Personal Knowledge Graph

[中文](README.md) | [English](README.en.md)

三层架构的个人知识挖掘系统，将 Markdown 笔记和原始资料转化为可搜索、可对话的知识库。

## 架构概览

```
L1 Sources (原始资料)  →  L2 Notes (结构化笔记)  →  L3 Insights (洞察) [planned]
         ↓                        ↓
    向量嵌入 + 全文索引        向量嵌入 + 结构化元数据
         ↓                        ↓
              ┌─────────────────────┐
              │   Retriever Agent   │  (确定性检索: SQL / 向量 / 混合)
              └─────────┬───────────┘
                        ↓
              ┌─────────────────────┐
              │    Action Agent     │  (模型驱动: Strands Agent + LLM)
              └─────────────────────┘
```

- **Retriever Agent** — 确定性检索层，支持 SQL 过滤、向量语义搜索和混合检索
- **Action Agent** — 基于 Strands Agents 的 LLM Agent，自主调用知识库工具完成复杂任务

## 技术栈

| 层 | 技术 |
|---|---|
| 后端框架 | FastAPI + Uvicorn |
| 数据库 | PostgreSQL 16 + pgvector |
| ORM | SQLAlchemy (async) + 
 |
| 嵌入模型 | Qwen `text-embedding-v4` (DashScope cloud API) |
| LLM | Azure OpenAI / 通义千问 (可切换) |
| Agent 框架 | Strands Agents |
| CLI | Typer + Rich |
| 前端 | React 19 + TypeScript + Tailwind CSS + Vite |

## 快速开始

### 1. 启动基础服务

```bash
docker compose up -d
```

这会启动 PostgreSQL 和 MinIO。默认地址：

- PostgreSQL: `localhost:5433`
- MinIO API: `http://127.0.0.1:9000`
- MinIO Console: `http://127.0.0.1:9001`

### 2. 安装 Python 依赖

```bash
python -m venv .venv
source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -e ".[dev]"
```

### 3. 配置环境变量

```bash
cp .env.example .env
# 编辑 `.env`，填入你的对话模型和 embedding API Key
```

`docker-compose.yml` 会从 `.env` 读取 PostgreSQL / MinIO 凭据，不再把默认密码直接写进仓库文件。

主要配置项：

| 变量 | 说明 | 默认值 |
|---|---|---|
| `LLM_PROVIDER` | LLM 提供商 (`azure` / `qwen`) | `qwen` |
| `QWEN_API_KEY` | 通义千问对话 API Key | — |
| `EMBEDDING_API_BASE` | Embedding API Base URL，默认走 DashScope OpenAI-compatible 接口 | `https://dashscope.aliyuncs.com/compatible-mode/v1` |
| `EMBEDDING_API_KEY` | Embedding API Key，可与对话模型使用不同账号/套餐 | — |
| `AZURE_OPENAI_API_KEY` | Azure OpenAI Key | — |
| `EMBEDDING_MODEL` | 嵌入模型 | `text-embedding-v4` |
| `DATABASE_URL` | 数据库连接 | `postgresql+asyncpg://...localhost:5433/knowledge_graph` |
| `POSTGRES_PASSWORD` | 本地 PostgreSQL 密码（供 Docker Compose 使用） | `local-dev-postgres-password` |
| `MINIO_ENDPOINT` | MinIO / S3-compatible endpoint | `http://127.0.0.1:9000` |
| `MINIO_ROOT_PASSWORD` | 本地 MinIO root 密码（供 Docker Compose 使用） | `local-dev-minio-password` |
| `MINIO_BUCKET` | 上传文件存储桶 | `knowledge-graph` |

### 4. 初始化数据库

```bash
alembic upgrade head
```

### 5. 导入知识

将 Markdown 文件放入 `data/sources/`（原始资料）和 `data/notes/`（笔记），然后同步：

```bash
pkg sync

```

## CLI 使用

```bash
# 同步 Markdown 文件到数据库
pkg sync

# 搜索知识库
pkg search "知识图谱"
pkg search "embedding" --mode vector --top-k 10

# 快速添加笔记 / 资料
pkg add-note "会议纪要" --content "..." --tags meeting
pkg add-source "论文标题" --source-type article --url "https://..."

# 查看统计
pkg stats

# 与知识库对话（单轮）
pkg ask "帮我总结关于三层架构的设计思路"

# 交互式多轮对话
pkg chat

# 启动 API 服务
pkg serve
```

## API

启动服务后访问 `http://localhost:8000/docs` 查看完整 API 文档。

主要端点：

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/health` | 健康检查 |
| `GET` | `/sources` | 列出资料 |
| `POST` | `/sources/upload` | 上传资料文件到 MinIO |
| `GET` | `/sources/{id}/file` | 打开资料原文件 |
| `GET` | `/notes` | 列出笔记 |
| `POST` | `/notes/upload` | 上传笔记文件到 MinIO |
| `GET` | `/notes/{id}/file` | 打开笔记原文件 |
| `GET` | `/search` | 搜索知识库 |
| `POST` | `/action` | 调用 Action Agent |

## 前端

```bash
cd web
npm install
npm run dev
```

访问 `http://localhost:5173`。

## 项目结构

```
src/pkg/
├── api/              # FastAPI 路由
│   ├── app.py        # 应用入口
│   ├── sources.py    # 资料 CRUD
│   ├── notes.py      # 笔记 CRUD
│   ├── search.py     # 搜索接口
│   └── action.py     # Action Agent 接口
├── models/           # SQLAlchemy 模型
├── schemas/          # Pydantic schemas
├── services/
│   ├── embedding.py      # 嵌入服务
│   ├── retriever.py      # 确定性检索 Agent
│   ├── action_agent.py   # 模型驱动 Action Agent
│   ├── llm.py            # LLM 客户端
│   ├── storage.py        # MinIO / object storage 服务
│   ├── sync_pipeline.py  # Markdown 同步管道
│   └── tools.py          # Agent 工具定义
├── cli.py            # Typer CLI
├── config.py         # 配置管理
└── db.py             # 数据库连接
web/                  # React 前端
data/
├── sources/          # 原始资料 (Markdown)
└── notes/            # 结构化笔记 (Markdown)
```

## License

Private project.
