"""Action Agent — a model-driven agent (Strands) that consumes knowledge to complete tasks.

Unlike the RetrieverAgent which is a deterministic search service,
the ActionAgent is a full LLM agent that autonomously decides how to
use the knowledge base tools to answer questions, draft documents,
support decisions, and create plans.

Architecture philosophy: model-driven orchestration (the LLM decides
which tools to call, in what order, and how to combine results).
"""
from strands import Agent

from pkg.services.llm import create_model
from pkg.services.tools import (
    knowledge_stats,
    list_notes,
    list_sources,
    read_note,
    read_source,
    search_knowledge,
)

SYSTEM_PROMPT = """\
你是一个个人知识助手（Action Agent），你能够访问用户的个人知识库，帮助他们完成各种日常事务。

## 你的身份
你是用户知识的延伸。用户多年来积累了笔记(notes)和原始资料(sources)，你的职责是充分利用这些知识来协助他们完成任务。

## 你的能力
你可以通过工具访问知识库：
- **搜索知识** (search_knowledge): 语义搜索或结构化检索
- **阅读笔记** (read_note): 读取笔记的完整内容
- **阅读资料** (read_source): 读取原始资料的完整内容
- **浏览笔记** (list_notes): 按领域/标签/项目浏览笔记
- **浏览资料** (list_sources): 按类型浏览原始资料
- **知识统计** (knowledge_stats): 了解知识库的规模和覆盖范围

## 工作原则

### 1. 知识驱动，而非凭空创造
- 回答问题时，**先搜索知识库**，基于用户已有的笔记和资料来回答
- 如果知识库中有相关内容，优先引用它，而不是生成通用回答
- 在输出中明确标注引用来源：[来源: note-id] 或 [来源: source-id]

### 2. 主动探索，不要浅尝辄止
- 如果第一次搜索结果不够，换个角度再搜索
- 如果搜到了笔记摘要，对于关键笔记要用 read_note 读取完整内容
- 多个相关笔记之间可能有关联，注意综合它们

### 3. 诚实标注知识缺口
- 如果知识库中没有足够的相关内容，明确告诉用户
- 区分"知识库中记录的事实"和"你基于知识库内容做的推断"
- 不要假装知识库中有某些内容

### 4. 输出结构化、可行动
- 回答要有结构（标题、列表、分节）
- 如果是行动计划，要具体到可执行的步骤
- 如果是决策分析，要列出各选项的优劣
- 如果是文档草稿，要有清晰的章节结构

### 5. 用用户的语言
- 用户的笔记体现了他们的思考方式和常用术语
- 在回答中采用相同的概念和术语，让回答对用户来说自然、亲切
"""

# All tools available to the agent
TOOLS = [
    search_knowledge,
    read_note,
    read_source,
    list_notes,
    list_sources,
    knowledge_stats,
]


def create_action_agent(callback_handler=None) -> Agent:
    """Create a new Action Agent instance.

    Args:
        callback_handler: Strands callback handler. Defaults to PrintingCallbackHandler.
            Pass None to suppress output (for API usage).
    """
    model = create_model()

    kwargs = {
        "model": model,
        "tools": TOOLS,
        "system_prompt": SYSTEM_PROMPT,
    }
    if callback_handler is not None:
        kwargs["callback_handler"] = callback_handler

    return Agent(**kwargs)
