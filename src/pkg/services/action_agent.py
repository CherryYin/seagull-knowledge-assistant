"""Action Agent — a model-driven agent (Strands) that consumes knowledge to complete tasks.

Unlike the RetrieverAgent which is a deterministic search service,
the ActionAgent is a full LLM agent that autonomously decides how to
use the knowledge base tools to answer questions, draft documents,
support decisions, and create plans.

Architecture philosophy: model-driven orchestration (the LLM decides
which tools to call, in what order, and how to combine results).

Enhancements inspired by pi-mono/coding-agent:
- Context compaction via SummarizingConversationManager
- Auto-retry with exponential backoff via ModelRetryStrategy
- Dynamic system prompt with runtime context (date, KB stats)
"""
import asyncio
import logging
import time
from datetime import datetime

from strands import Agent
from strands.agent.conversation_manager import SummarizingConversationManager
from strands.event_loop._retry import ModelRetryStrategy

from pkg.config import settings
from pkg.services.llm import create_model
from pkg.services.tools import (
    knowledge_stats,
    list_notes,
    list_sources,
    read_note,
    read_source,
    search_knowledge,
)
from pkg.services.tools_document import process_document

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Compaction prompt (inspired by pi-mono's structured summarization)
# ---------------------------------------------------------------------------
COMPACTION_PROMPT = """\
你是一个对话摘要专家。请将以下对话历史压缩为结构化摘要。

输出格式要求：
- 你必须以第三人称撰写结构化摘要。
- 你不得以对话方式回应。
- 你不得直接与用户对话。
- 不要假设工具执行失败，除非明确说明。

## 已完成的目标
- 列出已经回答的问题或完成的任务

## 关键决策和发现
- 列出重要的知识库查询结果
- 列出用户确认的关键信息

## 引用的知识
- 列出已读取的笔记ID和资料ID
- 简述每个引用的核心内容

## 当前上下文
- 用户最近关注的话题
- 尚未完成的任务或待回答的问题
"""

# ---------------------------------------------------------------------------
# Static parts of the system prompt
# ---------------------------------------------------------------------------
_SYSTEM_PROMPT_TEMPLATE = """\
你是一个个人知识助手（Action Agent），你能够访问用户的个人知识库，帮助他们完成各种日常事务。

## 当前上下文
- 当前日期: {today}
- {kb_stats}

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
- **文档处理** (process_document): 处理PDF、Word、Excel、PPT文档，或协作撰写文档。当用户需要创建、编辑、合并文档时，主动使用此工具。

## 工作原则

### 0. 先思考，再行动
- 收到任务后，先花几秒钟思考整体策略
- 简要说明你打算怎么做（搜什么、为什么搜、预期找到什么），再开始调用工具
- 避免盲目搜索——想清楚搜什么关键词、用什么搜索模式
- 如果任务复杂，把它拆分成小步骤，逐步执行

### 1. 知识驱动，而非凭空创造
- 回答问题时，**先搜索知识库**，基于用户已有的笔记和资料来回答
- 如果知识库中有相关内容，优先引用它，而不是生成通用回答
- 在输出中明确标注引用来源：[来源: note-id] 或 [来源: source-id]

### 2. 主动探索，不要浅尝辄止
- 如果第一次搜索结果不够，换个角度再搜索（换关键词、换搜索模式）
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

# ---------------------------------------------------------------------------
# Knowledge-base stats cache (avoid hitting DB on every request)
# ---------------------------------------------------------------------------
_stats_cache: dict = {"text": "", "expires": 0.0}
_STATS_CACHE_TTL = 300  # 5 minutes


async def _get_cached_kb_stats() -> str:
    """Return a one-line knowledge base summary, cached for 5 minutes."""
    now = time.time()
    if _stats_cache["expires"] > now and _stats_cache["text"]:
        return _stats_cache["text"]

    try:
        from pkg.db import async_session
        from sqlalchemy import func, select

        from pkg.models.note import Note
        from pkg.models.source import Source

        async with async_session() as session:
            note_count = (
                await session.execute(select(func.count()).select_from(Note))
            ).scalar() or 0
            source_count = (
                await session.execute(select(func.count()).select_from(Source))
            ).scalar() or 0

        text = f"知识库当前包含 {note_count} 条笔记和 {source_count} 条资料。"
    except Exception:
        logger.warning("Failed to fetch KB stats for system prompt", exc_info=True)
        text = "知识库统计暂时不可用。"

    _stats_cache["text"] = text
    _stats_cache["expires"] = now + _STATS_CACHE_TTL
    return text


async def build_system_prompt() -> str:
    """Build the system prompt with dynamic runtime context."""
    from pkg.services.skills import format_skills_for_prompt, load_skills_merged

    today = datetime.now().strftime("%Y-%m-%d")
    kb_stats = await _get_cached_kb_stats()
    base = _SYSTEM_PROMPT_TEMPLATE.format(today=today, kb_stats=kb_stats)

    skills = await load_skills_merged(settings.skills_dir)
    skills_section = format_skills_for_prompt(skills)

    return base + skills_section


# ---------------------------------------------------------------------------
# All tools available to the agent
# ---------------------------------------------------------------------------
_BASE_TOOLS = [
    search_knowledge,
    read_note,
    read_source,
    list_notes,
    list_sources,
    knowledge_stats,
    process_document,
]


# ---------------------------------------------------------------------------
# Agent factory
# ---------------------------------------------------------------------------
async def create_action_agent(callback_handler=None) -> Agent:
    """Create a new Action Agent instance (async).

    Args:
        callback_handler: Strands callback handler. Defaults to PrintingCallbackHandler.
            Pass None to suppress output (for API usage).
    """
    from pkg.services.skills import load_skill_tools, load_skills_merged

    model = create_model()
    system_prompt = await build_system_prompt()

    # Merge base tools with dynamically loaded skill tools
    skills = await load_skills_merged(settings.skills_dir)
    skill_tools = load_skill_tools(settings.skills_dir, skills)
    all_tools = _BASE_TOOLS + skill_tools

    conversation_manager = SummarizingConversationManager(
        summary_ratio=settings.COMPACTION_SUMMARY_RATIO,
        preserve_recent_messages=settings.COMPACTION_PRESERVE_RECENT,
        summarization_system_prompt=COMPACTION_PROMPT,
    )

    retry_strategy = ModelRetryStrategy(
        max_attempts=settings.LLM_RETRY_MAX_ATTEMPTS,
        initial_delay=settings.LLM_RETRY_INITIAL_DELAY,
        max_delay=settings.LLM_RETRY_MAX_DELAY,
    )

    kwargs = {
        "model": model,
        "tools": all_tools,
        "system_prompt": system_prompt,
        "conversation_manager": conversation_manager,
        "retry_strategy": retry_strategy,
    }
    if callback_handler is not None:
        kwargs["callback_handler"] = callback_handler

    return Agent(**kwargs)


def create_action_agent_sync(callback_handler=None) -> Agent:
    """Sync wrapper for CLI usage."""
    return asyncio.run(create_action_agent(callback_handler=callback_handler))
