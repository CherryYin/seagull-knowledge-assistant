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
from contextvars import ContextVar
from datetime import datetime

from strands import Agent
from strands.agent.conversation_manager import SummarizingConversationManager
from strands.event_loop._retry import ModelRetryStrategy

from pkg.config import settings
from pkg.services.llm import create_model
from pkg.services.tools import (
    ask_human,
    knowledge_stats,
    list_notes,
    list_sources,
    read_note,
    read_source,
    search_knowledge,
)
from pkg.services.tools_document import process_document
from pkg.services.tools_web import web_search

logger = logging.getLogger(__name__)

# ContextVar to pass user_id to agent tools without changing Strands function signatures.
# Set by the API layer before invoking the agent; read by tools.py functions.
current_user_id: ContextVar[str | None] = ContextVar("current_user_id", default=None)

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
- **文档生成** (process_document): 将 markdown 内容保存为文件。**当用户要求撰写报告、分析、方案等文档时**，你先用 markdown 格式撰写内容，然后调用此工具保存为 md 文件（默认格式）。也支持 docx/xlsx/pptx 格式。
- **网络搜索** (web_search): 搜索互联网获取实时信息。当知识库中没有足够信息，或用户需要最新资讯时使用。
- **询问用户** (ask_human): 向用户提问并等待回复。当需要用户确认方向、选择选项或补充信息时使用。调用后必须停止当前回复，等待用户回答。

## 工作原则

### 0. 先思考，再行动
- 收到任务后，先花几秒钟思考整体策略
- 简要说明你打算怎么做（搜什么、为什么搜、预期找到什么），再开始调用工具
- 避免盲目搜索——想清楚搜什么关键词、用什么搜索模式
- 如果任务复杂，把它拆分成小步骤，逐步执行

### 1. 知识驱动，而非凭空创造
- 回答问题时，**先搜索知识库**，基于用户已有的笔记和资料来回答
- 如果知识库中有相关内容，优先引用它，而不是生成通用回答
- 如果知识库不够，用 web_search 搜索互联网补充

### 2. 必须标注引用来源
使用了任何知识或网络搜索结果后，**必须**在回答末尾添加引用列表，格式如下：

**知识库来源**（使用搜索结果中返回的原始 ID）：
- `[来源: note-xxx]` — 引用的笔记
- `[来源: src-xxx]` — 引用的资料（注意前缀是 `src-`，不是 `source-`）

**网络来源**（使用 web_search 返回的 URL）：
- `[网络: 标题](URL)` — 引用的网页

示例：
```
... 正文内容 ...

---
**引用**
- [来源: note-20260401-investment-strategy] 投资策略笔记
- [来源: src-20260315-graham-chapter5] 证券分析第五章
- [网络: Python 3.12 Release Notes](https://docs.python.org/3/whatsnew/3.12.html)
```

即使只引用了一条来源也要列出。没有使用任何来源时不需要添加引用列表。

### 3. 主动探索，不要浅尝辄止
- 如果第一次搜索结果不够，换个角度再搜索（换关键词、换搜索模式）
- 如果搜到了笔记摘要，对于关键笔记要用 read_note 读取完整内容
- 多个相关笔记之间可能有关联，注意综合它们

### 4. 诚实标注知识缺口
- 如果知识库中没有足够的相关内容，明确告诉用户
- 区分"知识库中记录的事实"和"你基于知识库内容做的推断"
- 不要假装知识库中有某些内容

### 5. 输出结构化、可行动
- 回答要有结构（标题、列表、分节）
- 如果是行动计划，要具体到可执行的步骤
- 如果是决策分析，要列出各选项的优劣
- 如果是文档草稿，要有清晰的章节结构

### 6. 写文档时使用工具
- 当用户要求"写一份报告"、"撰写分析"、"起草方案"等需要产出文档的任务时：
  1. 先用 search_knowledge 或 web_search 收集素材
  2. 你自己用 markdown 格式撰写完整内容
  3. 调用 process_document(content=你写的markdown, format="md") 保存为文件
- 不要把写内容的工作交给 process_document，它只负责格式转换
- 不要在回复中直接写几千字的长文——那是 process_document 的工作

### 7. 用用户的语言
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


async def build_system_prompt(
    custom_append: str = "",
    enabled_skills: list[str] | None = None,
) -> str:
    """Build the system prompt with dynamic runtime context.

    Args:
        custom_append: User-defined instructions appended at the end.
        enabled_skills: If not None, only include these skills in the prompt.
    """
    from pkg.services.skills import format_skills_for_prompt, load_skills_merged

    today = datetime.now().strftime("%Y-%m-%d")
    kb_stats = await _get_cached_kb_stats()
    base = _SYSTEM_PROMPT_TEMPLATE.format(today=today, kb_stats=kb_stats)

    skills = await load_skills_merged(settings.skills_dir)
    if enabled_skills is not None:
        skills = [s for s in skills if s.name in enabled_skills]
    skills_section = format_skills_for_prompt(skills)

    # Inject user memory if available
    user_memory_section = await _get_user_memory_section()

    prompt = base + skills_section + user_memory_section

    if custom_append and custom_append.strip():
        prompt += f"\n\n## 用户自定义指令\n{custom_append.strip()}\n"

    return prompt


async def _get_user_memory_section() -> str:
    """Load current user's memory entries and format as a system prompt section."""
    user_id = current_user_id.get()
    if not user_id:
        return ""

    try:
        import json
        from sqlalchemy import select

        from pkg.db import async_session
        from pkg.models.user import UserMemory

        async with async_session() as session:
            result = await session.execute(
                select(UserMemory).where(UserMemory.user_id == user_id)
            )
            memories = list(result.scalars())

        if not memories:
            return ""

        lines = ["\n\n## 用户记忆\n"]
        for mem in memories:
            val = json.dumps(mem.value, ensure_ascii=False) if isinstance(mem.value, dict) else str(mem.value)
            lines.append(f"- **{mem.key}**: {val}")
        return "\n".join(lines) + "\n"
    except Exception:
        logger.warning("Failed to load user memory for system prompt", exc_info=True)
        return ""


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
    web_search,
    ask_human,
]


def _get_tool_name(tool) -> str:
    """Extract tool name from a Strands tool (decorated function or callable)."""
    return getattr(tool, "tool_name", None) or getattr(tool, "__name__", "unknown")


# ---------------------------------------------------------------------------
# Agent factory
# ---------------------------------------------------------------------------
async def create_action_agent(callback_handler=None, profile=None, model_id=None, provider_id=None) -> Agent:
    """Create a new Action Agent instance (async).

    Args:
        callback_handler: Strands callback handler. Defaults to PrintingCallbackHandler.
            Pass None to suppress output (for API usage).
        profile: Optional AgentProfile instance to customize the agent behavior.
        model_id: Override model ID (takes priority over profile.model_id).
        provider_id: LLM provider ID from the registry.
    """
    from pkg.services.skills import load_skill_tools, load_skills_merged

    effective_model_id = model_id or (profile.model_id if profile else None)
    model = create_model(
        model_id=effective_model_id,
        provider_id=provider_id,
        temperature=profile.temperature if profile else None,
    )
    system_prompt = await build_system_prompt(
        custom_append=profile.system_prompt_append if profile else "",
        enabled_skills=profile.enabled_skills if profile else None,
    )

    # Merge base tools with dynamically loaded skill tools
    skills = await load_skills_merged(settings.skills_dir)
    if profile and profile.enabled_skills is not None:
        skills = [s for s in skills if s.name in profile.enabled_skills]
    skill_tools = load_skill_tools(settings.skills_dir, skills)

    all_tools = list(_BASE_TOOLS) + skill_tools
    if profile and profile.enabled_tools is not None:
        enabled_set = set(profile.enabled_tools)
        all_tools = [t for t in all_tools if _get_tool_name(t) in enabled_set]

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
