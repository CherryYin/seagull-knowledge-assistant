# Personal Glean：一个人的AI知识平台

## 一、产品定位

### 不是什么

这不是一个"更好的笔记软件"，不是一个"带AI的Obsidian"，也不是一个"缩小版的企业Glean"。

### 是什么

这是一个**以AI智能体为主要交互界面的个人知识操作系统**。

Glean解决的是"1000人的企业里，知识散落在50个SaaS系统中找不到"的问题。Personal Glean解决的是"1个人的大脑里，知识散落在笔记、对话、代码、文档、浏览记录中用不起来"的问题。

核心差异：

| 维度 | Glean（企业版） | Personal Glean |
|------|---------------|----------------|
| 用户数 | 数千人 | 1人 + 他的AI智能体群 |
| 数据源 | 50+ SaaS系统 | 个人笔记 + 对话记录 + 代码仓库 + 浏览/阅读 + 项目文档 |
| 知识图谱 | Enterprise Graph + Personal Graph | 只有Personal Graph，但更深更密 |
| 权限模型 | 复杂的多角色ACL | 无（或仅公开/私有两档） |
| 交互方式 | 搜索框 + AI助手 | **AI智能体为主入口**，可视化为辅 |
| 核心价值 | 跨系统找到知识 | **将知识转化为行动** |

最后一行是关键区别。企业Glean的价值止步于"帮你找到答案"。Personal Glean要做到"帮你用知识完成任务"——因为你只有一个人，AI智能体必须从"知识检索工具"升级为"知识驱动的工作伙伴"。

---

## 二、整体架构

```
┌─────────────────────────────────────────────────────────────────────┐
│                         交互层                                      │
│                                                                     │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌───────────────────┐  │
│  │ 对话界面  │  │ 可视化   │  │ CLI终端   │  │ API（供外部调用）  │  │
│  │ (Web/App) │  │ (图谱/   │  │          │  │                   │  │
│  │          │  │  仪表盘)  │  │          │  │                   │  │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └─────┬─────────────┘  │
│       └──────────────┴─────────────┴──────────────┘                 │
│                              │                                      │
├──────────────────────────────┼──────────────────────────────────────┤
│                              ▼                                      │
│                      智能体编排层                                    │
│                                                                     │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │                    Orchestrator Agent                        │   │
│  │                    （中央编排智能体）                          │   │
│  │                                                              │   │
│  │  接收用户意图 → 分解任务 → 调度专项Agent → 汇总结果          │   │
│  └──────┬───────────┬───────────┬───────────┬──────────────────┘   │
│         │           │           │           │                       │
│         ▼           ▼           ▼           ▼                       │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────────┐          │
│  │ Retriever│ │ Writer   │ │ Analyst  │ │ Connector    │          │
│  │ Agent    │ │ Agent    │ │ Agent    │ │ Agent        │          │
│  │          │ │          │ │          │ │              │          │
│  │ 知识检索  │ │ 知识写入  │ │ 知识分析  │ │ 外部数据采集  │          │
│  │ 多策略   │ │ 模板化   │ │ 洞察发现  │ │ 持续同步     │          │
│  │ 路由     │ │ 元数据   │ │ 盲区检测  │ │              │          │
│  │          │ │ 自动补全  │ │ 趋势识别  │ │              │          │
│  └────┬─────┘ └────┬─────┘ └────┬─────┘ └──────┬───────┘          │
│       └─────────────┴────────────┴──────────────┘                   │
│                              │                                      │
├──────────────────────────────┼──────────────────────────────────────┤
│                              ▼                                      │
│                       知识引擎层                                     │
│                                                                     │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │                   Retrieval Router                           │   │
│  │                                                              │   │
│  │  意图分析 → 检索策略选择 → 多路召回 → 融合排序               │   │
│  └──────┬───────────┬───────────┬──────────────────────────────┘   │
│         │           │           │                                   │
│         ▼           ▼           ▼                                   │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐                           │
│  │ SQL查询  │ │ pgvector │ │ AGE      │                           │
│  │ 确定性   │ │ 语义检索  │ │ 图谱遍历  │                           │
│  │ 检索     │ │          │ │          │                           │
│  └──────────┘ └──────────┘ └──────────┘                           │
│                              │                                      │
├──────────────────────────────┼──────────────────────────────────────┤
│                              ▼                                      │
│                       数据层                                        │
│                                                                     │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │                    PostgreSQL 单实例                          │   │
│  │                                                              │   │
│  │  关系表（documents/entities）                                 │   │
│  │  + pgvector（语义向量）                                       │   │
│  │  + Apache AGE（知识图谱）                                     │   │
│  │  + 对话记忆表（conversations/memory）                         │   │
│  │  + 任务日志表（agent_tasks）                                  │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                              │                                      │
│                              ▼                                      │
│                    Markdown文件系统（备份/导出/人类阅读）             │
│                                                                     │
├──────────────────────────────┼──────────────────────────────────────┤
│                              ▼                                      │
│                       连接器层                                      │
│                                                                     │
│  ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐ ┌────────────────┐   │
│  │本地文件 │ │Git仓库 │ │浏览器  │ │Claude  │ │ RSS/Newsletter │   │
│  │Markdown│ │代码+文档│ │书签+   │ │对话历史│ │ 订阅内容       │   │
│  │        │ │        │ │阅读    │ │        │ │                │   │
│  └────────┘ └────────┘ └────────┘ └────────┘ └────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 三、智能体系统设计

### 3.1 设计哲学：确定性编排 + 语义执行

直接借鉴Route B架构的核心原则：

```
Glean的智能体：  完全模型驱动（model-driven orchestration）
                 LLM决定调用哪个工具、什么顺序、如何组合
                 灵活但不可预测

Personal Glean： 确定性编排 + 语义执行
                 编排逻辑（调用哪个Agent、什么顺序）是确定性的规则
                 每个Agent内部的理解和生成用LLM
                 可预测且可调试
```

**为什么不照搬Glean的纯模型驱动方案：**

Glean面对的是企业级的多样化查询，无法预判所有查询模式，所以必须让模型自己决定工具编排。但Personal Glean只服务一个人，你的查询模式是可以被归纳和预判的。用确定性规则处理已知模式（覆盖80%场景），只在未知模式时才退化到模型自主编排（剩余20%）。这保证了常见操作的稳定性和可调试性。

### 3.2 Orchestrator Agent（中央编排器）

#### 职责

接收用户的自然语言输入，识别意图类别，路由到对应的专项Agent或Agent组合。

#### 意图分类与路由规则

```yaml
# orchestrator_rules.yaml - 确定性路由规则

intent_routes:
  # ====== 知识检索类 ======
  - pattern: "找|搜索|查找|有没有|关于.*的笔记"
    route: retriever_agent
    mode: search

  - pattern: ".*和.*有什么关系|.*是怎么演进的|.*影响了什么"
    route: retriever_agent
    mode: graph_traversal

  - pattern: "类似.*的|像.*一样的"
    route: retriever_agent
    mode: semantic_similarity

  # ====== 知识写入类 ======
  - pattern: "记录|记住|保存|写一篇|整理"
    route: writer_agent

  - pattern: "把.*整理成|从inbox中整理"
    route: writer_agent
    mode: organize

  # ====== 知识分析类 ======
  - pattern: "总结|分析|对比|趋势|盲区|我最近"
    route: analyst_agent

  - pattern: "知识库.*状态|有多少|统计"
    route: analyst_agent
    mode: dashboard

  # ====== 外部采集类 ======
  - pattern: "抓取|采集|订阅|同步|导入"
    route: connector_agent

  # ====== 复合任务 ======
  - pattern: "基于我的知识.*写一篇|结合.*和.*生成"
    route: [retriever_agent, writer_agent]  # 先检索再写入
    mode: composite

  - pattern: "研究.*并记录|调研.*整理成"
    route: [connector_agent, writer_agent]  # 先采集再写入
    mode: composite

  # ====== 兜底 ======
  - pattern: ".*"
    route: orchestrator_llm_fallback  # 无法匹配时，让LLM判断
```

#### 编排流程

```
用户输入
    │
    ▼
┌───────────────────────────┐
│  规则匹配（确定性）         │
│  遍历orchestrator_rules   │
│  找到第一个匹配的pattern    │
└───────────┬───────────────┘
            │
      ┌─────┴─────┐
      │匹配成功？   │
      └─┬───────┬──┘
        │       │
      是│       │否
        │       │
        ▼       ▼
   按route    LLM意图分析
   调度Agent  （兜底方案）
        │       │
        └───┬───┘
            ▼
    Agent执行 → 结果返回给用户
            │
            ▼
    记录到agent_tasks表（可审计）
```

### 3.3 Retriever Agent（知识检索智能体）

这是使用频率最高的Agent，直接对接上一版方案中设计的知识引擎层。

#### 能力

```python
class RetrieverAgent:
    """知识检索智能体"""

    def execute(self, query: str, mode: str = "auto") -> RetrievalResult:
        """
        mode:
          - "search": 确定性检索优先（SQL过滤 → abstract评估 → 全文加载）
          - "semantic_similarity": 向量检索优先
          - "graph_traversal": 图谱遍历优先
          - "auto": 让LLM分析查询后选择最优策略
        """

        if mode == "auto":
            mode = self.analyze_query_intent(query)

        if mode == "search":
            # 1. 提取查询中的结构化线索
            filters = self.extract_filters(query)
            # 2. SQL确定性检索
            candidates = self.sql_search(filters)
            # 3. 如果候选太多或太少，补充向量检索
            if len(candidates) > 20 or len(candidates) == 0:
                candidates = self.vector_search(query, pre_filter=filters)
            # 4. 用LLM阅读abstract重排序
            ranked = self.llm_rerank(query, candidates)
            # 5. 加载top-k全文
            return self.load_full_content(ranked[:5])

        elif mode == "graph_traversal":
            # 1. 识别查询中的实体
            entities = self.extract_entities(query)
            # 2. 构造Cypher查询
            cypher = self.build_cypher(query, entities)
            # 3. 执行图谱遍历
            graph_results = self.execute_cypher(cypher)
            # 4. 加载相关文档全文
            return self.load_full_content(graph_results)

        elif mode == "semantic_similarity":
            # 1. 向量检索
            results = self.vector_search(query)
            # 2. 加载全文
            return self.load_full_content(results[:5])
```

#### 检索增强：上下文扩展

检索到目标文档后，自动通过图谱关系扩展上下文：

```python
def expand_context(self, doc_id: str, depth: int = 1) -> list:
    """通过图谱关系扩展检索结果的上下文"""

    # 获取直接关联的文档（1跳）
    related = cypher_query("""
        MATCH (d:Document {id: $doc_id})-[r]->(related)
        RETURN related.id, type(r) AS relation, r.context
        UNION
        MATCH (d:Document {id: $doc_id})<-[r]-(related)
        RETURN related.id, type(r) AS relation, r.context
    """, doc_id=doc_id)

    # 根据关系类型决定是否需要加载关联文档
    # DERIVED_FROM/SUPERSEDES：加载（理解演进脉络）
    # APPLIES同一概念的其他文档：加载abstract（提供对比视角）
    # REFERENCES：仅标注，不加载（避免context膨胀）

    context_docs = []
    for r in related:
        if r.relation in ('DERIVED_FROM', 'SUPERSEDES'):
            context_docs.append(self.load_abstract(r.id))
        elif r.relation == 'APPLIES':
            context_docs.append(self.load_abstract(r.id))

    return context_docs
```

### 3.4 Writer Agent（知识写入智能体）

#### 能力

```python
class WriterAgent:
    """知识写入智能体"""

    def capture_quick(self, raw_input: str) -> str:
        """
        快速捕获模式：用户说了一段话，AI自动生成inbox笔记
        最低摩擦，3个必填字段自动生成
        """
        doc_id = generate_id()  # kb-YYYYMMDD-NNN

        # LLM从用户输入中提取标题
        title = self.llm_extract_title(raw_input)

        doc = {
            'id': doc_id,
            'title': title,
            'doc_type': 'inbox',
            'content': raw_input,
            'status': 'seed'
        }

        self.save_to_db(doc)
        self.export_to_markdown(doc)
        return f"已捕获到inbox: {title}"

    def organize_inbox(self, doc_id: str) -> str:
        """
        整理模式：把inbox文档升级为正式文档
        AI辅助生成完整的frontmatter + 图谱关系
        """
        doc = self.load_document(doc_id)

        # LLM分析内容，建议元数据
        suggestions = self.llm_suggest_metadata(doc['content'])
        # 返回：type, domain, tags, abstract, 建议的entities和relations

        # 在知识库中搜索可能相关的现有文档
        related_docs = self.retriever.vector_search(doc['content'], top_k=5)

        # LLM建议图谱关系
        graph_suggestions = self.llm_suggest_relations(doc, related_docs)

        # 展示建议，等待用户确认/修改
        return {
            'metadata_suggestions': suggestions,
            'graph_suggestions': graph_suggestions,
            'related_docs': related_docs
        }

    def write_from_conversation(self, conversation_context: str, instruction: str) -> str:
        """
        对话沉淀模式：从一段AI对话中提炼知识写入知识库
        这是Personal Glean最重要的写入路径之一
        """
        # LLM从对话中提炼核心知识点
        knowledge_points = self.llm_extract_knowledge(conversation_context)

        # 检查是否与现有文档重复或需要合并
        for point in knowledge_points:
            existing = self.retriever.vector_search(point['content'], top_k=3)
            if self.is_duplicate(point, existing):
                # 建议合并到现有文档
                point['action'] = 'merge'
                point['merge_target'] = existing[0]['id']
            else:
                point['action'] = 'create_new'

        return knowledge_points  # 返回给用户确认
```

#### 对话沉淀——最关键的写入场景

你和Claude的每次深度对话（比如这次关于知识库架构的讨论）都在产生高价值的知识。但这些知识目前只存在于对话历史中，无法被结构化检索和复用。Writer Agent的`write_from_conversation`就是解决这个问题的。

```
场景：你和Claude讨论完知识库架构后

你说："把这次对话的核心结论整理到知识库里"

Writer Agent的工作流：
1. 读取对话上下文
2. LLM提炼出3-5个核心知识点：
   - "个人知识库vs企业知识库vs Glean的三种范式对比"
   - "abstract字段作为检索杠杆的设计原理"
   - "PostgreSQL统一栈（pgvector + AGE）的选型理由"
3. 对每个知识点，搜索知识库中是否已有相关文档
4. 发现"知识库架构"相关的文档已存在 → 建议merge
5. 发现"Glean分析"是新知识 → 建议create_new
6. 生成完整的Markdown文档（含frontmatter + graph关系）
7. 展示给你确认 → 你说OK → 写入PostgreSQL + 导出Markdown + 更新AGE图谱
```

### 3.5 Analyst Agent（知识分析智能体）

#### 能力

```python
class AnalystAgent:
    """知识分析智能体——发现你自己看不到的模式"""

    def weekly_digest(self) -> str:
        """
        每周知识摘要：你这周学了什么、想了什么、有什么新关联
        """
        # 1. 查询本周新增/更新的文档
        recent = self.sql_query("""
            SELECT * FROM documents
            WHERE updated_at > now() - interval '7 days'
            ORDER BY updated_at DESC
        """)

        # 2. 查询本周新增的图谱关系
        new_edges = self.cypher_query("""
            MATCH ()-[r]->()
            WHERE r.created_at > datetime() - duration('P7D')
            RETURN r
        """)

        # 3. LLM生成周报
        return self.llm_generate_digest(recent, new_edges)

    def detect_blind_spots(self) -> str:
        """
        盲区检测：哪些领域长期没有新知识输入？
        哪些概念只被提到一次就再也没出现？
        """
        # 1. 按domain统计最近60天的文档新增数
        domain_activity = self.sql_query("""
            SELECT unnest(domains) AS domain,
                   COUNT(*) FILTER (WHERE created_at > now() - interval '60 days') AS recent_count,
                   COUNT(*) AS total_count
            FROM documents
            GROUP BY domain
        """)

        # 2. 找到孤立实体（只有1条关系的节点）
        isolated = self.cypher_query("""
            MATCH (e:Entity)
            WHERE size([(e)-[]-() | 1]) <= 1
            RETURN e.id, e.name, e.entity_type
        """)

        # 3. 找到过期知识（status=mature但超过180天未更新）
        stale = self.sql_query("""
            SELECT id, title, updated_at
            FROM documents
            WHERE status = 'mature'
              AND updated_at < now() - interval '180 days'
        """)

        return self.llm_analyze_gaps(domain_activity, isolated, stale)

    def discover_hidden_connections(self) -> str:
        """
        隐性关联发现：通过向量相似度找到图谱中尚未建立关系、
        但在语义上高度相关的文档对
        """
        # 1. 对每篇文档，找到向量最相似的top-5文档
        # 2. 过滤掉已经在图谱中有直接关系的文档对
        # 3. 剩下的就是"语义相关但尚未建立关系"的候选

        candidates = self.sql_query("""
            WITH similarities AS (
                SELECT a.doc_id AS doc_a, b.doc_id AS doc_b,
                       1 - (a.abstract_vec <=> b.abstract_vec) AS sim
                FROM doc_embeddings a
                CROSS JOIN LATERAL (
                    SELECT doc_id, abstract_vec
                    FROM doc_embeddings
                    WHERE doc_id != a.doc_id
                    ORDER BY abstract_vec <=> a.abstract_vec
                    LIMIT 5
                ) b
                WHERE 1 - (a.abstract_vec <=> b.abstract_vec) > 0.75
            )
            SELECT s.doc_a, s.doc_b, s.sim,
                   da.title AS title_a, db.title AS title_b
            FROM similarities s
            JOIN documents da ON s.doc_a = da.id
            JOIN documents db ON s.doc_b = db.id
            WHERE NOT EXISTS (
                -- 排除图谱中已有直接关系的文档对
                SELECT 1 FROM cypher('knowledge_graph', $$
                    MATCH (a:Document {id: $doc_a})-[]-(b:Document {id: $doc_b})
                    RETURN 1
                $$, doc_a => s.doc_a, doc_b => s.doc_b) AS (x agtype)
            )
            ORDER BY s.sim DESC
            LIMIT 10
        """)

        # LLM分析每对候选，建议应该建立什么关系
        return self.llm_suggest_connections(candidates)

    def concept_evolution_timeline(self, entity_id: str) -> str:
        """
        概念演进时间线：一个核心概念在你的思考中是如何发展的
        """
        timeline = self.cypher_query("""
            MATCH (e:Entity {id: $entity_id})<-[r]-(d:Document)
            RETURN d.id, d.title, d.doc_type, type(r) AS relation,
                   r.context, d.created_at
            ORDER BY d.created_at
        """, entity_id=entity_id)

        return self.llm_generate_timeline(entity_id, timeline)
```

### 3.6 Connector Agent（外部数据采集智能体）

#### 连接器设计

Personal Glean不需要Glean的100+连接器，但需要覆盖个人知识的核心来源：

```yaml
connectors:
  # === 本地文件 ===
  local_markdown:
    type: file_watcher
    source: ~/knowledge-base/
    trigger: file_change
    action: sync_to_db
    description: "监控Markdown文件变更，自动同步到PostgreSQL"

  # === 代码仓库 ===
  git_repos:
    type: git
    source:
      - ~/projects/renogy-cs-system/
      - ~/projects/property-ai/
    trigger: scheduled (daily)
    extract:
      - README.md
      - docs/**/*.md
      - CHANGELOG.md
      - 关键代码文件的注释和docstring
    action: sync_as_reference_docs

  # === AI对话历史 ===
  claude_conversations:
    type: api
    source: claude.ai conversation export
    trigger: manual or scheduled
    action: writer_agent.write_from_conversation
    description: "导出Claude对话 → Writer Agent提炼知识点 → 入库"

  # === 浏览器书签/阅读 ===
  browser_bookmarks:
    type: browser_extension
    source: Chrome bookmarks + reading list
    trigger: on_bookmark
    extract:
      - url
      - title
      - 用户标注的笔记
      - 页面摘要（LLM生成）
    action: sync_as_reference_docs

  # === RSS/Newsletter ===
  rss_feeds:
    type: rss
    source:
      - https://anthropic.com/blog/rss
      - https://aws.amazon.com/blogs/machine-learning/feed/
      # ... 其他订阅
    trigger: scheduled (daily)
    filter: LLM判断是否与已有知识领域相关
    action: sync_as_inbox (仅采集相关内容，避免信息过载)
```

#### 采集质量控制

Glean可以无差别索引所有企业数据，因为企业数据天然有边界。但个人数据源（特别是浏览器和RSS）是无边界的，不加控制会导致知识库被噪音淹没。

```python
class ConnectorAgent:

    def quality_gate(self, incoming_doc: dict) -> str:
        """
        每条采集的外部数据都要过质量关
        返回: 'accept' | 'inbox' | 'reject'
        """
        # 1. 与现有知识域的相关性检查
        relevance = self.check_domain_relevance(incoming_doc)
        if relevance < 0.3:
            return 'reject'  # 与已有知识领域无关，丢弃

        # 2. 重复检查
        duplicates = self.retriever.vector_search(
            incoming_doc['abstract'], top_k=3
        )
        if self.is_semantic_duplicate(incoming_doc, duplicates):
            return 'reject'  # 已有类似内容

        # 3. 质量检查（LLM判断是否有实质性知识价值）
        quality = self.llm_assess_quality(incoming_doc)
        if quality == 'high':
            return 'accept'  # 直接入库
        elif quality == 'medium':
            return 'inbox'   # 放入inbox待整理
        else:
            return 'reject'
```

---

## 四、对话记忆系统

### 4.1 为什么需要独立的记忆层

Glean有Enterprise Memory——Agent执行任务后积累的流程知识。Personal Glean同样需要一个记忆层，但定位不同：

| 维度 | 知识库（documents表） | 对话记忆（memory表） |
|------|---------------------|---------------------|
| 内容 | 经过整理的、结构化的知识 | 对话中的碎片、偏好、决策记录 |
| 持久性 | 长期 | 中期（有衰减机制） |
| 准确性要求 | 高（是知识资产） | 中（是上下文线索） |
| 示例 | "Route B架构的三层设计" | "用户倾向于确定性方案而非概率性方案" |

### 4.2 数据模型

```sql
-- ============================================================
-- 对话记忆表
-- ============================================================
CREATE TABLE memory (
    id           SERIAL PRIMARY KEY,
    memory_type  TEXT NOT NULL,     -- preference|decision|fact|pattern
    content      TEXT NOT NULL,     -- 记忆内容
    source       TEXT,              -- 来源（对话ID、文档ID等）
    confidence   FLOAT DEFAULT 0.8, -- 置信度，随时间衰减
    created_at   TIMESTAMPTZ DEFAULT now(),
    last_used    TIMESTAMPTZ DEFAULT now(),
    use_count    INT DEFAULT 0
);

CREATE INDEX idx_memory_type ON memory (memory_type);

-- 记忆的向量嵌入，用于语义检索
CREATE TABLE memory_embeddings (
    memory_id  INT PRIMARY KEY REFERENCES memory(id) ON DELETE CASCADE,
    vec        vector(1536)
);

CREATE INDEX idx_memory_vec ON memory_embeddings
    USING hnsw (vec vector_cosine_ops);


-- ============================================================
-- 智能体任务日志
-- ============================================================
CREATE TABLE agent_tasks (
    id           SERIAL PRIMARY KEY,
    agent_type   TEXT NOT NULL,     -- retriever|writer|analyst|connector
    input_query  TEXT,
    strategy     TEXT,              -- 使用的检索策略
    docs_accessed TEXT[],           -- 访问了哪些文档
    result_summary TEXT,            -- 结果摘要
    duration_ms  INT,
    created_at   TIMESTAMPTZ DEFAULT now()
);
```

### 4.3 记忆的生命周期

```python
class MemoryManager:

    def extract_from_conversation(self, conversation: str) -> list:
        """从对话中自动提取记忆"""
        memories = self.llm_extract_memories(conversation)
        # 示例提取结果：
        # - preference: "用户偏好确定性架构而非概率性AI编排"
        # - decision: "知识库选择PostgreSQL统一栈而非多组件拼装"
        # - pattern: "用户经常从Glean的企业级方案中提取原则降维到个人场景"
        return memories

    def recall(self, query: str, top_k: int = 5) -> list:
        """根据当前查询，召回相关记忆"""
        # 语义检索相关记忆
        results = vector_search(query, table='memory_embeddings', top_k=top_k)

        # 更新使用计数和最后使用时间
        for r in results:
            update_memory_usage(r.memory_id)

        return results

    def decay(self):
        """每周运行：降低长期未使用记忆的置信度"""
        execute_sql("""
            UPDATE memory
            SET confidence = confidence * 0.95
            WHERE last_used < now() - interval '30 days'
        """)

        # 置信度低于0.3的记忆归档
        execute_sql("""
            UPDATE memory
            SET memory_type = 'archived'
            WHERE confidence < 0.3
        """)
```

---

## 五、与Glean的架构对照

| 架构层 | Glean | Personal Glean | 设计差异的理由 |
|-------|-------|---------------|-------------|
| **连接器** | 100+原生连接器，持续爬取 | 5-8个轻量连接器，按需同步 | 个人数据源有限，不需要大规模连接器基础设施 |
| **知识图谱** | Enterprise Graph（ML自动构建） | AGE图谱（frontmatter声明 + AI辅助补全） | 个人知识量不足以支撑ML自动构建高质量图谱，人工声明+AI辅助更准确 |
| **个性化** | Personal Graph（用户行为学习） | 对话记忆系统（memory表） | 只有一个用户，不需要"个性化"，需要的是"记忆延续" |
| **权限** | 实时权限镜像（<300ms） | 无（或公开/私有两档） | 一个人不需要ACL |
| **搜索** | 混合检索 + 个性化排序 | 确定性路由 + 向量兜底 | 可预测性优先于智能性 |
| **智能体** | 纯模型驱动编排 | 确定性规则编排 + LLM执行 | 已知模式用规则，未知模式用模型——Route B哲学 |
| **AI交互** | 搜索框 + 聊天 | **智能体为主入口** | 个人场景中"行动"比"搜索"更重要 |
| **记忆** | Enterprise Memory（Agent积累） | 对话记忆（自动提取 + 衰减） | 企业需要组织级流程知识，个人需要认知偏好记忆 |
| **定价** | $1000+/agent/月 | 自托管，仅基础设施成本 | 个人场景最大的约束是运维精力而非预算 |

---

## 六、典型使用场景

### 场景1：日常知识检索

```
你：  "我之前关于确定性执行的设计原则用在哪些项目里了？"

Orchestrator：识别意图 → graph_traversal模式 → 调度Retriever Agent

Retriever Agent：
  1. 识别实体：ent-deterministic-execution
  2. Cypher查询：MATCH (e)<-[:APPLIES]-(d)-[:BELONGS_TO]->(p) ...
  3. 返回结果：
     - Route B架构 → Renogy项目（客服系统业务逻辑层）
     - 维保系统架构 → 物业管理项目（VBA引擎wrapper）
  4. 加载两篇文档的abstract提供上下文

回复："确定性执行原则在两个项目中被应用过：
      1. Renogy客服系统——业务逻辑层完全使用确定性规则引擎...
      2. 物业管理维保系统——AI作为VBA引擎的wrapper..."
```

### 场景2：对话知识沉淀

```
你：  "把今天关于知识库架构的讨论整理到知识库里"

Orchestrator：识别意图 → 调度Writer Agent

Writer Agent：
  1. 读取对话上下文（本次关于知识库的完整讨论）
  2. LLM提炼出4个核心知识点：
     a. 三种知识库范式对比（个人/企业/Glean）
     b. abstract字段作为检索杠杆的设计
     c. PostgreSQL统一栈选型理由
     d. Personal Glean的智能体编排哲学
  3. 搜索知识库 → 发现已有"知识库设计"相关文档
  4. 建议：a→更新现有文档, b/c/d→创建新文档
  5. 自动生成frontmatter + graph关系
  6. 展示给你确认

你：  "OK，第2点和第3点合并成一篇"

Writer Agent：合并并写入 → 同步到PostgreSQL → 导出Markdown → 更新AGE图谱
```

### 场景3：隐性关联发现

```
[每周自动运行，Analyst Agent推送]

Analyst Agent：
  "本周发现2条潜在关联：

   1. 你在'Glean Enterprise Graph分析'中讨论的知识图谱权限模型，
      和你3个月前写的'多租户SaaS数据隔离方案'在概念上高度相似
      （向量相似度0.82），但两者之间没有建立图谱关系。
      建议：建立RELATED_CONCEPT关系？

   2. 'LangGraph vs Strands Agents对比'中你偏好Strands的理由
      （语义工具选择），和'Route B架构'中偏好确定性执行的理由
      存在张力——前者倾向model-driven，后者倾向rule-driven。
      这可能是一个值得深入思考的架构权衡。
      建议：写一篇concept文档探讨这个张力？"
```

### 场景4：为客户准备方案

```
你：  "我要给一个电商客户准备AI客服方案，帮我从知识库里找相关的"

Orchestrator：复合意图 → 调度Retriever Agent + Analyst Agent

Retriever Agent：
  1. SQL: domain contains 'ecommerce' AND type IN ('architecture','case-study')
  2. 图谱: MATCH (d)-[:BELONGS_TO]->(p:Entity {entity_type:'project'})
           WHERE 'ecommerce' IN d.domains
  3. 返回Renogy项目的全部架构文档 + 案例复盘

Analyst Agent：
  1. 生成知识汇总："你在电商AI客服领域有以下积累..."
  2. 识别可复用的组件和需要定制的部分
  3. 生成建议大纲

回复："基于你的知识库，我整理了以下可用于新方案的资产：
      - 可直接复用：Route B三层架构设计、DSL编译器方案
      - 需要适配：四层RAG质量控制（需按客户产品线调整）
      - 知识缺口：该客户的产品线数据、竞品客服体验分析
      要我帮你生成一份方案大纲吗？"
```

---

## 七、技术栈总览

```
数据层：     PostgreSQL 16 + pgvector + Apache AGE
后端API：    FastAPI (Python)
智能体框架：  自建（确定性规则编排 + LLM调用层）
LLM：        Claude API（主模型）
Embedding：  text-embedding-3-small 或 bge-m3
前端：       React + react-force-graph + react-markdown
CLI：        Python Click/Typer（命令行快速操作）
部署：       Docker Compose（单机）
文件备份：    Git仓库（Markdown导出）
```

---

## 八、与纯Glean方案的成本对比

```
Glean企业版：
  - 起步价约 $10-30/用户/月（搜索功能）
  - Agent功能 $1000+/agent/月
  - 数百人企业年费轻松达到 $500K+

Personal Glean自托管：
  - VPS：$5-20/月（2核4G足够）
  - Claude API：$20-50/月（按实际调用量）
  - Embedding API：$5-10/月（或本地模型免费）
  - 域名+SSL：$10/年
  - 总计：$30-80/月

投入的主要不是钱，是时间：
  - 初始搭建：2-3天
  - 日常维护：<1小时/周（大部分自动化）
  - 持续迭代：根据需要
```

---

## 九、演进路线

```
阶段0：基础积累（现在开始）
  └─ 规范Markdown写作习惯（特别是frontmatter和abstract）
  └─ 积累50+篇结构化笔记
  └─ 这个阶段不需要任何基础设施

阶段1：数据库上线（50篇+）
  └─ 启动PostgreSQL + pgvector
  └─ 跑通sync_pipeline
  └─ Retriever Agent基础版（SQL + 向量检索）
  └─ CLI界面

阶段2：图谱上线（100篇+）
  └─ 启用Apache AGE
  └─ 补充历史文档的graph字段
  └─ Retriever Agent增加图谱遍历能力
  └─ Writer Agent基础版（quick capture + organize）

阶段3：智能体完整化（200篇+）
  └─ Orchestrator Agent + 规则路由
  └─ Analyst Agent（周报 + 盲区检测）
  └─ 对话记忆系统
  └─ Web前端（图谱可视化 + 文档阅读）

阶段4：连接器扩展（按需）
  └─ Git仓库连接器
  └─ 浏览器书签连接器
  └─ 对话历史采集
  └─ 质量控制门禁

每个阶段在前一个阶段稳定运行2-4周后再推进。
不要跳阶段。
```
