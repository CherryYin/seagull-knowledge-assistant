"""Strands tools that give the Action Agent access to the knowledge base.

Each tool manages its own DB session so it works cleanly within
the Strands model-driven agent loop.
"""
import asyncio
from strands import tool


def _get_user_id() -> str | None:
    """Get the current user ID from the context variable (set by API layer)."""
    from pkg.services.action_agent import current_user_id
    return current_user_id.get()


@tool
async def search_knowledge(query: str, mode: str = "vector", top_k: int = 5) -> str:
    """Search the personal knowledge base using semantic or structured search.

    Use this tool to find relevant notes and sources from the user's knowledge base.
    Returns a list of matching items with titles, abstracts, and relevance scores.

    Args:
        query: The search query — can be a question, topic, or keywords.
        mode: Search strategy. "vector" for semantic similarity, "sql" for keyword/field match, "hybrid" for both combined.
        top_k: Maximum number of results to return (1-20).
    """
    from pkg.db import async_session
    from pkg.services.retriever import RetrieverAgent

    async with async_session() as session:
        retriever = RetrieverAgent(session, user_id=_get_user_id())
        results = await retriever.search(query=query, mode=mode, top_k=top_k)

    if not results:
        return "未找到相关内容。知识库中可能没有与此查询相关的笔记或资料。"

    # Track retrieval hits per item
    from pkg.services.stats import increment_stats_mixed
    items = []
    for r in results:
        itype = "note" if r.type == "note" else "source"
        items.append((r.id, itype))
    await increment_stats_mixed(items, "retrieval_count")

    lines = [f"找到 {len(results)} 条相关结果：\n"]
    for i, r in enumerate(results, 1):
        lines.append(f"### {i}. [{r.type.upper()}] {r.title}")
        lines.append(f"   ID: {r.id}")
        lines.append(f"   相关度: {r.score:.2f}")
        if r.abstract:
            lines.append(f"   摘要: {r.abstract}")
        if r.content_preview:
            lines.append(f"   内容片段: {r.content_preview}")
        lines.append("")
    return "\n".join(lines)


@tool
async def read_note(note_id: str) -> str:
    """Read the full content of a specific note from the knowledge base.

    Use this after search_knowledge to get the complete text of a note you need.
    Returns the full note content including metadata.

    Args:
        note_id: The note ID (e.g., "note-20260407-sample-architecture-thinking").
    """
    from pkg.db import async_session
    from pkg.models.note import Note

    async with async_session() as session:
        note = await session.get(Note, note_id)

    if not note:
        return f"笔记 {note_id} 不存在。请检查ID是否正确。"

    # Track retrieval
    from pkg.services.stats import increment_stats
    await increment_stats([note_id], "note", "retrieval_count")

    parts = [
        f"# {note.title}",
        f"类型: {note.note_type} | 状态: {note.status} | 置信度: {note.confidence}",
    ]
    if note.domains:
        parts.append(f"领域: {', '.join(note.domains)}")
    if note.tags:
        parts.append(f"标签: {', '.join(note.tags)}")
    if note.project:
        parts.append(f"项目: {note.project}")
    if note.abstract:
        parts.append(f"\n## 摘要\n{note.abstract}")
    parts.append(f"\n## 正文\n{note.content or '(无内容)'}")
    if note.source_ids:
        parts.append(f"\n## 引用来源\n{', '.join(note.source_ids)}")
    return "\n".join(parts)


@tool
async def read_source(source_id: str) -> str:
    """Read the full content of a source (raw material) from the knowledge base.

    Use this to access original articles, PDFs, or conversation records.

    Args:
        source_id: The source ID (e.g., "src-20260407-karpathy-llm-wiki").
    """
    from pkg.db import async_session
    from pkg.models.source import Source

    async with async_session() as session:
        source = await session.get(Source, source_id)

    if not source:
        return f"资料 {source_id} 不存在。请检查ID是否正确。"

    # Track retrieval
    from pkg.services.stats import increment_stats
    await increment_stats([source_id], "source", "retrieval_count")

    parts = [
        f"# {source.title}",
        f"类型: {source.source_type}",
    ]
    if source.url:
        parts.append(f"URL: {source.url}")
    parts.append(f"\n## 内容\n{source.raw_content or '(无内容)'}")
    return "\n".join(parts)


@tool
async def list_notes(
    domain: str = "",
    tag: str = "",
    project: str = "",
    note_type: str = "",
    limit: int = 20,
) -> str:
    """List notes in the knowledge base with optional filtering.

    Use this to browse the knowledge base or find notes by category.
    Returns a summary list (not full content — use read_note for that).

    Args:
        domain: Filter by knowledge domain (e.g., "AI", "architecture").
        tag: Filter by tag (e.g., "knowledge-mining", "LLM").
        project: Filter by project name.
        note_type: Filter by type: "architecture", "case-study", "concept", "how-to", "inbox".
        limit: Maximum number of notes to list (1-50).
    """
    from sqlalchemy import select, func
    from pkg.db import async_session
    from pkg.models.note import Note

    async with async_session() as session:
        stmt = select(Note)
        user_id = _get_user_id()
        if user_id:
            stmt = stmt.where(Note.user_id == user_id)
        if domain:
            stmt = stmt.where(Note.domains.any(domain))
        if tag:
            stmt = stmt.where(Note.tags.any(tag))
        if project:
            stmt = stmt.where(Note.project == project)
        if note_type:
            stmt = stmt.where(Note.note_type == note_type)
        stmt = stmt.order_by(Note.updated_at.desc()).limit(limit)

        rows = await session.execute(stmt)
        notes = list(rows.scalars())

    if not notes:
        return "未找到符合条件的笔记。"

    lines = [f"找到 {len(notes)} 条笔记：\n"]
    for n in notes:
        domains_str = ", ".join(n.domains) if n.domains else ""
        tags_str = ", ".join(n.tags) if n.tags else ""
        lines.append(f"- **{n.title}** (id: {n.id})")
        lines.append(f"  类型: {n.note_type} | 领域: {domains_str} | 标签: {tags_str}")
        if n.abstract:
            lines.append(f"  摘要: {n.abstract[:100]}...")
        lines.append("")
    return "\n".join(lines)


@tool
async def list_sources(source_type: str = "", limit: int = 20) -> str:
    """List source materials in the knowledge base.

    Use this to browse available raw materials (articles, PDFs, conversations, etc.).

    Args:
        source_type: Filter by type: "pdf", "article", "conversation", "video", "web", "code".
        limit: Maximum number of sources to list (1-50).
    """
    from sqlalchemy import select
    from pkg.db import async_session
    from pkg.models.source import Source

    async with async_session() as session:
        stmt = select(Source)
        user_id = _get_user_id()
        if user_id:
            from sqlalchemy import or_
            stmt = stmt.where(or_(Source.user_id == user_id, Source.is_shared == True))
        if source_type:
            stmt = stmt.where(Source.source_type == source_type)
        stmt = stmt.order_by(Source.ingested_at.desc()).limit(limit)

        rows = await session.execute(stmt)
        sources = list(rows.scalars())

    if not sources:
        return "未找到符合条件的资料。"

    lines = [f"找到 {len(sources)} 条资料：\n"]
    for s in sources:
        lines.append(f"- **{s.title}** (id: {s.id})")
        lines.append(f"  类型: {s.source_type}")
        if s.url:
            lines.append(f"  URL: {s.url}")
        lines.append("")
    return "\n".join(lines)


@tool
async def knowledge_stats() -> str:
    """Get statistics about the knowledge base.

    Returns counts of notes and sources, broken down by type and domain.
    Use this to understand the scope and coverage of the user's knowledge.
    """
    from sqlalchemy import select, func
    from pkg.db import async_session
    from pkg.models.note import Note
    from pkg.models.source import Source

    async with async_session() as session:
        user_id = _get_user_id()
        note_q = select(func.count()).select_from(Note)
        source_q = select(func.count()).select_from(Source)
        if user_id:
            from sqlalchemy import or_
            note_q = note_q.where(Note.user_id == user_id)
            source_q = source_q.where(or_(Source.user_id == user_id, Source.is_shared == True))

        note_count = (await session.execute(note_q)).scalar() or 0
        source_count = (await session.execute(source_q)).scalar() or 0

        type_q = select(Note.note_type, func.count()).group_by(Note.note_type)
        if user_id:
            type_q = type_q.where(Note.user_id == user_id)
        note_types = await session.execute(type_q)
        type_breakdown = {row[0]: row[1] for row in note_types}

    lines = [
        "## 知识库统计",
        f"- 笔记总数 (L2): {note_count}",
        f"- 资料总数 (L1): {source_count}",
    ]
    if type_breakdown:
        lines.append("\n### 笔记类型分布")
        for t, c in type_breakdown.items():
            lines.append(f"- {t}: {c}")
    return "\n".join(lines)


@tool
def ask_human(question: str, options: list[str] | None = None) -> str:
    """向用户提出问题并等待回复。在以下情况时使用此工具：

    - 研究方向需要用户确认或选择
    - 找到多个可能的路径需要用户决定
    - 需要用户补充关键信息才能继续
    - 中间成果需要用户审阅反馈

    调用此工具后你必须立即停止当前回复，等待用户在下一条消息中回答。

    Args:
        question: 要向用户提出的问题。应包含当前进展摘要和具体选项。
        options: 可选的选项列表，前端将以按钮形式展示供用户快速选择。
    """
    return (
        f"[WAITING_FOR_HUMAN]\n"
        f"{question}\n\n"
        f"---\n"
        f"（请在下方输入你的回复，我将继续执行。）"
    )
