# Personal Glean + LLM Wiki：完整的知识挖掘架构

## 一、先回到knowledge mining的本质

你之前提到的knowledge mining方向，本质上是在追问一个问题：

> **散落的、原始的、未经加工的信息，如何自动地变成可复用的、结构化的、有洞察力的知识？**

这个过程在传统数据挖掘里有一个标准的pipeline：

```
Raw Data → Cleansing → Transformation → Pattern Discovery → Insights
原始数据 → 清洗 → 转换 → 模式发现 → 洞察
```

但在知识领域，这个pipeline一直没有真正跑通。原因是"清洗"和"转换"这两步在知识场景下需要**理解语义**——而在LLM出现之前，机器无法做到这一点。所以传统的knowledge mining工具（比如各种自动摘要、实体抽取、主题建模）都停留在很浅的层次，产出的"知识"对人类来说价值有限。

LLM的出现真正解锁了这个pipeline。Karpathy的LLM Wiki本质上是**用LLM把knowledge mining的pipeline跑通了**：

```
Raw sources → LLM读取理解 → 实体抽取/概念提炼 → 综合到wiki页面 → 持续迭代
   ↓             ↓                ↓                  ↓              ↓
原始数据      语义清洗          模式发现           知识结构化      洞察累积
```

这就是为什么Karpathy的方案让你产生熟悉感——它实际上就是**LLM时代的knowledge mining**，只不过Karpathy从"个人知识库"这个用户场景切入，把这个pipeline包装成了一个具体的用法。

但Karpathy的方案有意保持极简，没有把knowledge mining的全部潜力展开。如果把它和Personal Glean的思路结合，能形成一个真正完整的knowledge mining系统。

---

## 二、关键洞察：Wiki是知识库缺失的"综合层"

回顾之前所有方案的演进：

```
方案演进史：

v1: Markdown + JSON
    └─ 问题：只有原始笔记，没有综合

v2: PostgreSQL + pgvector + AGE
    └─ 问题：能精细检索原始笔记，但每次查询都在重新综合

v3: Personal Glean完整版
    └─ 问题：智能体多了、检索强了，但综合工作仍然在query-time

Karpathy LLM Wiki:
    └─ 洞察：综合应该在ingest-time完成，wiki就是综合产物的载体
```

**Personal Glean一直缺的就是这个综合层。** 我之前设计的所有Agent（Retriever/Writer/Analyst）都在做"基于原始笔记的实时操作"，而Karpathy的wiki提供了一个"已经综合好的、持续维护的中间层"——它本质上是知识的compile结果。

如果把这两个思路结合，就形成了一个三层结构：

```
┌──────────────────────────────────────────────────┐
│  L3: Wiki层（Karpathy模式）                       │
│       LLM综合产生的、按主题组织的知识              │
│       "我对X的所有理解被综合在一个页面里"         │
├──────────────────────────────────────────────────┤
│  L2: Notes层（Personal Glean模式）                │
│       原子化笔记，保留写作上下文                  │
│       "我在某天因为某个具体问题写下的某个思考"    │
├──────────────────────────────────────────────────┤
│  L1: Sources层                                    │
│       原始资料：文章、PDF、对话记录、代码、网页    │
└──────────────────────────────────────────────────┘
```

这三层不是简单的"上层包含下层"，而是**三种不同形态的知识，服务于三种不同的使用场景**：

| 层 | 形态 | 主要读者 | 使用场景 |
|----|------|---------|---------|
| L1 Sources | 原始文本 | 偶尔回溯 | 验证、引用、深度溯源 |
| L2 Notes | 原子化笔记 | 你自己 + AI检索 | 复用过去的具体思考 |
| L3 Wiki | 综合性页面 | 你 + AI + 外部 | "我对X的整体理解是什么" |

---

## 三、三层架构的核心价值：双向流动

加入Wiki层后，整个系统最有意思的不是"多了一层"，而是**层与层之间的双向流动**。这是单纯Karpathy方案做不到的：

```
        ┌─────────────────────────────────────┐
        │           L3: Wiki层                 │
        │                                     │
        │   综合页面 ←──────── compile ──────┐│
        │   ↓                                ││
        │   topic-X.md  concept-Y.md  ...    ││
        └────────┬────────────────────────────┘│
                 │                             │
        ingest时↓ 综合         ↑extract时 提炼  │
                 │                             │
        ┌────────▼─────────────────────────────┴┐
        │           L2: Notes层                 │
        │                                       │
        │   原子化笔记 ──── 链接 ────→ 实体/概念 │
        │   ↓                                   │
        │   note-001.md  note-002.md  ...       │
        └────────┬──────────────────────────────┘
                 │
        ingest时↓ 写入         ↑回溯时 引用
                 │
        ┌────────▼──────────────────────────────┐
        │           L1: Sources层                │
        │                                        │
        │   article-01.pdf  conversation-02.md   │
        └────────────────────────────────────────┘
```

### 流动方向1：自下而上的compile（这是Karpathy方案的核心）

```
新源进入L1
   ↓
LLM读取并提炼
   ↓
更新L2的相关笔记（如果是与已有思考相关的输入）
   ↓
更新L3的相关wiki页面（综合性的主题理解）
```

### 流动方向2：自上而下的extract（Personal Glean独有）

```
你在L2写了一篇新的原创笔记（比如新的架构设计）
   ↓
LLM分析这篇笔记，识别其中的核心概念和实体
   ↓
找到L3中相关的wiki页面，更新它们
   ↓
新增L2笔记中的洞察会被反映到L3的综合理解中
```

### 流动方向3：横向的cross-link

```
L3的wiki页面之间通过"主题关联"互相链接
L2的笔记之间通过"思考线索"互相链接
L3和L2之间通过"哪些笔记构成了这个wiki页面"互相链接
```

**这是和knowledge mining最深的连接**——传统数据挖掘的产出是单向的（raw → insight），而这个三层架构实现了**知识的双向compile和decompile**：你既可以从原始资料综合出wiki，也可以从wiki追溯到具体的笔记和原始来源。

---

## 四、整体架构

```
┌──────────────────────────────────────────────────────────────────┐
│                          交互层                                  │
│   Claude Code对话 │ Web浏览器 │ CLI │ Obsidian编辑器             │
└────────────────────────────────┬─────────────────────────────────┘
                                 │
┌────────────────────────────────▼─────────────────────────────────┐
│                       智能体编排层                                │
│                                                                  │
│   ┌────────────────────────────────────────────────────────┐    │
│   │              Orchestrator Agent                          │    │
│   │              确定性规则路由 + LLM兜底                     │    │
│   └────┬────────┬────────┬────────┬────────┬───────────────┘    │
│        │        │        │        │        │                    │
│        ▼        ▼        ▼        ▼        ▼                    │
│  ┌────────┐ ┌──────┐ ┌────────┐ ┌──────┐ ┌──────────┐          │
│  │Retriever│ │Writer│ │Compiler│ │Linter│ │Connector │          │
│  │  Agent  │ │Agent │ │ Agent  │ │ Agent│ │  Agent   │          │
│  │         │ │      │ │   ★    │ │  ★   │ │          │          │
│  │ 检索    │ │ 写入 │ │ 综合   │ │ 健康 │ │ 外部采集 │          │
│  │         │ │      │ │ wiki   │ │ 检查 │ │          │          │
│  └────┬────┘ └───┬──┘ └────┬───┘ └───┬──┘ └─────┬────┘          │
│       │          │         │         │          │                │
└───────┼──────────┼─────────┼─────────┼──────────┼────────────────┘
        │          │         │         │          │
┌───────▼──────────▼─────────▼─────────▼──────────▼────────────────┐
│                       数据层                                     │
│                                                                  │
│   ┌──────────────────────────────────────────────────────────┐  │
│   │           PostgreSQL（统一后端）                          │  │
│   │                                                          │  │
│   │   ┌──────────┐  ┌──────────┐  ┌──────────────────────┐  │  │
│   │   │  L1表    │  │  L2表    │  │  L3表                │  │  │
│   │   │ sources  │  │  notes   │  │  wiki_pages          │  │  │
│   │   │          │  │          │  │                      │  │  │
│   │   │ +元数据  │  │ +元数据  │  │ +综合元数据          │  │  │
│   │   │          │  │ +图谱关系│  │ +引用的notes         │  │  │
│   │   │          │  │          │  │ +引用的sources       │  │  │
│   │   └──────────┘  └──────────┘  └──────────────────────┘  │  │
│   │                                                          │  │
│   │   pgvector：三层各自的向量索引                           │  │
│   │   Apache AGE：跨层的图谱（包含三层节点和它们的关系）       │  │
│   └──────────────────────────────────────────────────────────┘  │
│                              │                                   │
│                              ▼                                   │
│              Markdown文件系统（导出/备份/编辑入口）              │
│         /sources/  /notes/  /wiki/  各自的目录结构              │
└──────────────────────────────────────────────────────────────────┘
```

新增的两个核心Agent：

- **Compiler Agent**：负责把L1+L2的内容综合到L3的wiki页面（这是Karpathy方案的核心能力）
- **Linter Agent**：负责定期健康检查，找矛盾、找过期、找盲区（Karpathy方案的lint操作）

---

## 五、数据模型扩展

在之前的PostgreSQL方案基础上，新增Wiki层的数据表：

```sql
-- ============================================================
-- L1: 原始资料表
-- ============================================================
CREATE TABLE sources (
    id            TEXT PRIMARY KEY,         -- "src-20260404-001"
    title         TEXT NOT NULL,
    source_type   TEXT NOT NULL,            -- pdf|article|conversation|video|web|code
    url           TEXT,                     -- 原始URL（如有）
    content_hash  TEXT,                     -- SHA-256，检测变更
    raw_content   TEXT,                     -- 原始全文（如适合存储）
    file_path     TEXT,                     -- 本地文件路径
    ingested_at   TIMESTAMPTZ DEFAULT now(),
    metadata      JSONB                     -- 灵活的元数据（作者、日期等）
);

CREATE INDEX idx_sources_type ON sources (source_type);
CREATE INDEX idx_sources_hash ON sources (content_hash);


-- ============================================================
-- L2: 原子化笔记表（保留之前的documents表，重命名为notes）
-- ============================================================
CREATE TABLE notes (
    id           TEXT PRIMARY KEY,           -- "note-20260404-001"
    title        TEXT NOT NULL,
    note_type    TEXT NOT NULL,              -- architecture|case-study|concept|how-to|inbox
    domains      TEXT[] NOT NULL DEFAULT '{}',
    tags         TEXT[] NOT NULL DEFAULT '{}',
    abstract     TEXT,
    content      TEXT,
    project      TEXT,
    status       TEXT DEFAULT 'seed',
    confidence   TEXT DEFAULT 'medium',
    -- 新增：来源追踪
    source_ids   TEXT[] DEFAULT '{}',        -- 引用了哪些L1原始资料
    file_path    TEXT,
    word_count   INT,
    created_at   TIMESTAMPTZ DEFAULT now(),
    updated_at   TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_notes_domains ON notes USING GIN (domains);
CREATE INDEX idx_notes_tags ON notes USING GIN (tags);
CREATE INDEX idx_notes_sources ON notes USING GIN (source_ids);


-- ============================================================
-- L3: Wiki页面表（新增）
-- ============================================================
CREATE TABLE wiki_pages (
    id              TEXT PRIMARY KEY,         -- "wiki-deterministic-execution"
    title           TEXT NOT NULL,
    page_type       TEXT NOT NULL,            -- entity|concept|topic|comparison
    content         TEXT NOT NULL,            -- 综合后的wiki内容
    summary         TEXT,                     -- 一句话摘要

    -- 来源追踪：这个wiki页面综合了哪些notes和sources
    derived_from_notes    TEXT[] DEFAULT '{}',
    derived_from_sources  TEXT[] DEFAULT '{}',

    -- 维护元数据
    last_compiled_at  TIMESTAMPTZ,             -- 上次综合的时间
    compile_version   INT DEFAULT 1,           -- 版本号，每次重新综合+1
    needs_recompile   BOOLEAN DEFAULT FALSE,   -- 是否需要重新综合（依赖的note/source有更新）

    -- 质量元数据
    open_questions    TEXT[],                  -- 已知的开放问题
    contradictions    JSONB,                   -- 已识别的矛盾点
    confidence_score  FLOAT,                   -- 综合质量评分

    created_at      TIMESTAMPTZ DEFAULT now(),
    updated_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_wiki_type ON wiki_pages (page_type);
CREATE INDEX idx_wiki_needs_recompile ON wiki_pages (needs_recompile)
    WHERE needs_recompile = TRUE;


-- ============================================================
-- 三层各自的向量嵌入
-- ============================================================
CREATE TABLE source_embeddings (
    source_id   TEXT PRIMARY KEY REFERENCES sources(id) ON DELETE CASCADE,
    title_vec   vector(1536),
    summary_vec vector(1536)
);

CREATE TABLE note_embeddings (
    note_id       TEXT PRIMARY KEY REFERENCES notes(id) ON DELETE CASCADE,
    abstract_vec  vector(1536),
    title_vec     vector(1536)
);

CREATE TABLE wiki_embeddings (
    wiki_id    TEXT PRIMARY KEY REFERENCES wiki_pages(id) ON DELETE CASCADE,
    summary_vec vector(1536),
    content_vec vector(1536)
);

-- HNSW索引...（省略）


-- ============================================================
-- AGE图谱中的节点类型
-- ============================================================
-- 在AGE图谱中现在有三类节点：
--   :Source节点（对应sources表）
--   :Note节点（对应notes表）
--   :WikiPage节点（对应wiki_pages表）
--   :Entity节点（独立的概念/实体节点，可以是任何层引用的对象）
--
-- 关系类型新增：
--   (:Source)-[:CITED_BY]->(:Note)         源被笔记引用
--   (:Source)-[:COMPILED_INTO]->(:WikiPage) 源被综合到wiki
--   (:Note)-[:COMPILED_INTO]->(:WikiPage)   笔记被综合到wiki
--   (:WikiPage)-[:DISCUSSES]->(:Entity)     wiki讨论某实体
--   (:WikiPage)-[:RELATES_TO]->(:WikiPage)  wiki间的主题关联
--   (:Note)-[:CONTRIBUTED_TO]->(:WikiPage)  笔记的洞察贡献给了wiki
```

---

## 六、Compiler Agent详细设计

这是新架构最关键的Agent。它负责把L1+L2的内容综合到L3的wiki中。

### 6.1 触发时机

Compiler Agent在三种情况下被触发：

```yaml
triggers:
  # 触发1: 新source进入时（Karpathy模式）
  - event: source_ingested
    action: incremental_compile
    description: |
      读取新source，找到与之相关的wiki页面（通过实体匹配/向量相似度），
      用LLM增量更新这些页面，同时考虑是否需要新建wiki页面

  # 触发2: 新note写入时（Personal Glean独有）
  - event: note_created_or_updated
    action: extract_and_compile
    description: |
      分析note的内容，识别其中的核心概念，
      找到对应的wiki页面，把note中的新洞察整合进去
      （这是note→wiki的反向流动）

  # 触发3: 定期重新综合
  - event: scheduled (weekly)
    action: full_recompile
    description: |
      检查标记为needs_recompile=true的wiki页面，重新综合
      （当依赖的多个note/source累积变化后触发）

  # 触发4: 用户主动请求
  - event: user_command
    action: targeted_compile
    description: |
      用户说"为X主题综合一个wiki页面"或"重新综合Y页面"
```

### 6.2 增量综合的核心算法

当新内容进入时，不是重写整个wiki页面，而是**增量更新**：

```python
class CompilerAgent:

    def incremental_compile(self, new_content_id: str, content_type: str):
        """
        新内容进入时的增量综合
        content_type: 'source' | 'note'
        """
        # 1. 加载新内容
        new_content = self.load_content(new_content_id, content_type)

        # 2. 提取新内容中涉及的实体和主题
        entities = self.llm_extract_entities(new_content)
        # 例如：["确定性执行", "DSL编译", "Route B架构"]

        # 3. 找到这些实体对应的现有wiki页面
        affected_pages = self.find_wiki_pages_for_entities(entities)

        # 4. 对每个受影响的wiki页面，做增量更新
        for page in affected_pages:
            self.update_wiki_page(page, new_content)

        # 5. 检查是否有实体没有对应的wiki页面（需要新建）
        new_entities = [e for e in entities if not self.has_wiki_page(e)]
        for entity in new_entities:
            if self.should_create_wiki_page(entity):
                self.create_wiki_page(entity, new_content)

    def update_wiki_page(self, page: dict, new_content: dict):
        """
        增量更新一个wiki页面
        关键设计：不是重写，而是让LLM在现有基础上做最小修改
        """
        prompt = f"""
        你正在维护一个wiki页面。这是当前页面内容：

        ===现有内容===
        {page['content']}
        ===现有内容结束===

        现在有新的输入需要整合到这个页面中：

        ===新输入===
        来源：{new_content['title']}（{new_content['type']}）
        内容：{new_content['content']}
        ===新输入结束===

        请按以下原则更新wiki页面：

        1. 如果新输入与现有内容一致 → 添加为额外的支持证据，引用新来源
        2. 如果新输入扩展了现有内容 → 在合适的位置补充新信息
        3. 如果新输入与现有内容矛盾 → 在页面的"contradictions"部分标记，
           保留两个观点，注明各自的来源
        4. 如果新输入引入了新概念 → 在合适的section添加，并建议建立新的wiki页面链接
        5. 保持页面的整体结构稳定，不要无端重组

        输出：
        - updated_content: 更新后的完整页面内容
        - changes_summary: 这次更新做了什么改变
        - new_open_questions: 新输入引发的开放问题（如有）
        - new_contradictions: 新发现的矛盾（如有）
        - suggested_new_pages: 建议新建的wiki页面（如有）
        """

        result = self.llm_call(prompt)

        # 更新数据库
        self.save_wiki_update(page['id'], result)

        # 更新图谱关系
        self.update_graph_edges(page['id'], new_content['id'])

        # 触发依赖检查
        self.mark_related_pages_for_recompile(page['id'])
```

### 6.3 综合质量控制

借鉴评论区tomjwxf提到的epistemic integrity思路，但简化到个人场景可承受的程度：

```python
class CompilerAgent:

    def quality_check(self, wiki_page: dict) -> dict:
        """
        每次综合后做质量检查
        """
        return {
            # 来源覆盖度：综合是否引用了所有相关来源
            'source_coverage': self.check_source_coverage(wiki_page),

            # 内部一致性：综合内部是否有自相矛盾
            'internal_consistency': self.llm_check_consistency(wiki_page),

            # 来源忠实度：综合是否真的反映了来源的内容（而非LLM的幻觉）
            'source_fidelity': self.llm_check_fidelity(wiki_page),

            # 综合深度：是否只是简单罗列，还是真正做了综合
            'synthesis_depth': self.llm_assess_depth(wiki_page)
        }

    def detect_drift(self, wiki_page: dict) -> bool:
        """
        检测wiki页面是否相对于源已经"漂移"了
        通过对比当前wiki内容和重新从源综合的版本
        """
        fresh_synthesis = self.compile_from_scratch(wiki_page['derived_from_notes'],
                                                    wiki_page['derived_from_sources'])
        drift_score = self.semantic_diff(wiki_page['content'], fresh_synthesis)
        return drift_score > 0.3
```

---

## 七、新的检索流程：三层联动

加入Wiki层后，AI检索的流程变得更聪明。同一个问题在不同情况下应该查询不同的层：

### 检索决策树

```
用户查询
   │
   ▼
┌──────────────────────────────────┐
│ 这是什么类型的问题？               │
└────┬───────┬────────┬────────────┘
     │       │        │
     ▼       ▼        ▼
"我对X的    "我之前    "X是怎么
理解是     在某个     和Y产生
什么？"    项目里     联系的？"
           做过Y"
     │       │        │
     ▼       ▼        ▼
   读L3      读L2       读L3+图谱
   (wiki    (notes)    遍历
   页面)              
   
   综合        具体         关系
   理解        实例         推理
```

### 三种典型查询模式

**模式A：综合性问题 → 直接读Wiki（最高效）**

```
你：  "我对确定性执行原则的整体理解是什么？"

Retriever Agent：
  1. 识别：综合性问题，应该查L3
  2. SQL: SELECT * FROM wiki_pages WHERE id = 'wiki-deterministic-execution'
  3. 直接返回wiki页面内容

回复：直接呈现wiki页面（已经是综合好的）

效率：1次SQL查询 + 0次LLM综合调用
对比之前方案：要加载5-10篇相关notes + 1次大型LLM综合调用
```

**模式B：具体经验问题 → 读Notes**

```
你：  "我在Renogy项目中具体是怎么应用确定性执行的？"

Retriever Agent：
  1. 识别：具体经验问题，应该查L2
  2. SQL + 图谱混合查询：
     找到project=renogy AND tags包含'deterministic-execution'的notes
  3. 加载这些notes的全文

回复：呈现具体的笔记内容（保留写作时的所有上下文）
```

**模式C：探索性问题 → 三层联动**

```
你：  "确定性执行原则和Glean的model-driven架构存在什么张力？我之前是怎么思考的？"

Retriever Agent：
  1. 识别：跨主题的探索性问题
  2. 查L3找到两个wiki页面：
     - wiki-deterministic-execution
     - wiki-model-driven-orchestration
  3. 通过图谱找到同时引用这两个概念的L2 notes
  4. 加载相关notes获取具体的思考脉络
  5. LLM综合三层信息生成回答

回复：基于wiki的整体理解 + 基于notes的具体思考过程
```

---

## 八、与之前所有方案的对照

| 维度 | v1 Markdown+JSON | v2 PG统一栈 | v3 Personal Glean | v4 LLM Wiki | **v5 三层架构（本方案）** |
|------|------------------|------------|-------------------|-------------|--------------------------|
| **存储层数** | 1层（笔记） | 1层（笔记） | 1层（笔记） | 2层（源+wiki） | **3层（源+笔记+wiki）** |
| **综合时机** | query-time | query-time | query-time | ingest-time | **ingest-time（增量）** |
| **原创思考保留** | ★★★★★ | ★★★★★ | ★★★★★ | ★ | **★★★★★** |
| **外部资料综合** | ★ | ★ | ★ | ★★★★★ | **★★★★★** |
| **图谱推理** | ★ | ★ | ★★★★ | ★ | **★★★★★** |
| **运维复杂度** | 极低 | 中 | 高 | 极低 | **高** |
| **检索效率** | 中 | 高 | 高 | 高（直接读wiki） | **极高** |
| **可追溯性** | 中 | 中 | 高 | 低 | **极高（三层互链）** |

**v5的核心优势：综合了所有方案的长处。**

- 保留v1-v3的原创思考记录能力（L2 notes层）
- 吸收v4的ingest-time综合洞察（L3 wiki层）
- 通过PG+AGE实现跨层的精确检索和图谱推理
- 三层互链让任何wiki页面都可以被追溯到具体的note和source

**代价：** 这是所有方案中最复杂的。它不是给"今天就要开始用"的人准备的，而是给"知识已经积累了相当规模、明确感受到现有方案瓶颈"的人准备的。

---

## 九、与你之前knowledge mining构想的对应

回到最初的问题——这个方案和你之前想做的knowledge mining有多接近？

我的判断是：**几乎就是同一件事，只是从不同角度切入。**

### 传统knowledge mining的pipeline

```
原始数据收集
    ↓
数据清洗（去噪、格式化）
    ↓
特征/实体抽取
    ↓
模式发现（聚类、关联规则、主题建模）
    ↓
知识表示（知识图谱、本体）
    ↓
洞察生成
    ↓
持续维护和更新
```

### 三层架构对应

| Knowledge Mining步骤 | 三层架构中的对应组件 |
|---------------------|---------------------|
| 原始数据收集 | Connector Agent → L1 sources表 |
| 数据清洗 | Connector Agent的quality_gate + LLM预处理 |
| 实体抽取 | Compiler Agent的llm_extract_entities |
| 模式发现 | Analyst Agent的discover_hidden_connections |
| 知识表示 | L3 wiki_pages + AGE图谱 |
| 洞察生成 | Compiler Agent的综合 + Analyst Agent的分析 |
| 持续维护 | Linter Agent + 增量compile机制 |

**每一步在LLM时代都有了新的实现路径。** 而且这个方案有几个传统knowledge mining做不到的事：

1. **个性化的knowledge mining**：传统方案是面向公共数据的（论文库、新闻库），这个方案是面向个人知识的，包括你的原创思考
2. **双向compile**：传统方案只能从原始数据生成洞察，这个方案可以从洞察追溯到原始数据
3. **持续演进**：传统方案是batch处理，这个方案是incremental的，每个新输入都触发增量更新
4. **人机协同**：传统方案是全自动的（人是消费者），这个方案保留了人的主导地位（人是创造者，AI是协作者）

---

## 十、演进路径建议

我必须再次强调：**这是一个长期演进的目标架构，不是今天就要搭建的**。建议的渐进路径：

```
阶段0（现在）：
  └─ 用Karpathy的纯wiki方案处理外部资料
  └─ 用最简单的Markdown+frontmatter记录原创思考
  └─ 不碰数据库

阶段1（积累200+笔记 + 50+外部源后）：
  └─ 引入PostgreSQL + pgvector
  └─ 把L1 sources和L2 notes放进数据库
  └─ Retriever Agent上线（SQL+向量检索）
  └─ 此时还没有L3 wiki层，只是把前两层数据库化

阶段2（明确感受到"重复综合"的痛点后）：
  └─ 引入L3 wiki_pages表
  └─ Compiler Agent上线（先支持手动触发的综合）
  └─ 选择最常被反复查询的几个主题，手动建立wiki页面

阶段3（wiki页面达到20+后）：
  └─ Compiler Agent增量综合上线
  └─ 引入Apache AGE做跨层图谱
  └─ Linter Agent上线，定期健康检查

阶段4（按需）：
  └─ Web前端可视化
  └─ Analyst Agent的高级分析能力
  └─ 多智能体编排

每个阶段在前一阶段稳定运行2-4周后再推进。
```

---

## 十一、最关键的反思

写完这个方案后，我想说一个更重要的判断：

**你之前问"加入wiki层会怎样"，这个问题的答案不仅仅是"架构变成三层"，而是揭示了一个更深的事实：你真正想做的不是"搭建一个知识库"，而是"构建一个个人版的knowledge mining系统"。**

这两件事的差别在于野心：

- "搭建知识库"是工具层面的事——选个软件、定个格式、开始写笔记
- "构建knowledge mining系统"是基础设施层面的事——它要持续运转、自动产生洞察、跨越多年累积价值

Karpathy的方案是前者的极致简化版（小而美），Personal Glean完整版加上Wiki层是后者的完整形态（大而全）。

你需要诚实地判断：**你真的需要后者吗？**

判断标准：

```
如果你的目标是：
  - 帮助自己工作得更高效                              → 前者就够了
  - 复用过去的设计模式和决策                          → 前者+轻量PG即可
  - 让AI智能体能够基于你的知识为客户提供方案          → 前者+轻量PG即可

如果你的目标是：
  - 把knowledge mining作为一个"产品方向"来探索       → 需要后者
  - 验证"个人版Glean"作为商业方案的可能性             → 需要后者
  - 把自己的知识库作为对外能力展示的一部分            → 需要后者
```

**前两类目标的最佳起点是Karpathy方案，最多再加上轻量的PG。**

**第三类目标的最佳起点也是Karpathy方案+轻量PG**——但要意识到你在为更长远的演进做准备，每一步设计决策都要考虑"未来加入Wiki层和Compiler Agent时会怎样"。

我的最终建议：把这份三层架构文档作为**北极星**，但**不要**直接朝着它搭建。从Karpathy方案开始，让真实的使用驱动演进。当你某天在使用中真切感受到"我需要wiki层"或"我需要图谱推理"时，再看这份文档，按图索骥地添加对应的能力。

不要为想象中的需求构建系统。**让需求从使用中浮现，再用最小的代价满足它**。这是所有可持续系统的共同规律。
