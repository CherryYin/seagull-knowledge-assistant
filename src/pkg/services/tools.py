"""Strands tools that give the Action Agent access to the knowledge base.

Each tool manages its own DB session so it works cleanly within
the Strands model-driven agent loop.
"""
import asyncio
from strands import tool


def _clamp_int(value: int, minimum: int, maximum: int) -> int:
    return max(minimum, min(maximum, value))


def _safe_text(value: str | None) -> str:
    return value or ""


def _make_snippet(text: str, query: str, max_chars: int = 500) -> str:
    """Return a compact snippet centered on the first query term match."""
    text = " ".join(_safe_text(text).split())
    if not text:
        return ""

    terms = [term.lower() for term in query.split() if term.strip()]
    lowered = text.lower()
    hit_positions = [lowered.find(term) for term in terms if lowered.find(term) >= 0]
    center = min(hit_positions) if hit_positions else 0
    start = max(0, center - max_chars // 3)
    end = min(len(text), start + max_chars)
    snippet = text[start:end]
    if start > 0:
        snippet = "…" + snippet
    if end < len(text):
        snippet += "…"
    return snippet


def _build_query_variants(query: str, max_queries: int) -> list[str]:
    """Build lightweight multi-query variants without an extra LLM call."""
    variants: list[str] = []
    normalized = " ".join(query.split())
    if normalized:
        variants.append(normalized)

    separators = ["，", ",", "；", ";", "、", " and ", " or ", " vs ", " versus "]
    fragments = [normalized]
    for separator in separators:
        next_fragments: list[str] = []
        for fragment in fragments:
            next_fragments.extend(part.strip() for part in fragment.split(separator) if part.strip())
        fragments = next_fragments or fragments

    for fragment in fragments:
        if fragment and fragment not in variants:
            variants.append(fragment)

    keywords = [token.strip("：:,.，。！？!?()[]（）【】\"'") for token in normalized.split()]
    keywords = [token for token in keywords if len(token) >= 2]
    if len(keywords) >= 2:
        keyword_query = " ".join(keywords[:6])
        if keyword_query not in variants:
            variants.append(keyword_query)

    return variants[:max_queries]


def _summarize_text_extractive(text: str, focus: str = "", max_chars: int = 900) -> str:
    """Small extractive summarizer used by navigation tools."""
    text = " ".join(_safe_text(text).split())
    if not text:
        return "(无内容)"

    if focus:
        snippet = _make_snippet(text, focus, max_chars=max_chars)
        if snippet:
            return snippet
    return text[:max_chars] + ("…" if len(text) > max_chars else "")


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
async def agentic_rag(
    question: str,
    search_depth: int = 3,
    top_k: int = 5,
    open_top_n: int = 3,
    mode: str = "hybrid",
) -> str:
    """Iteratively search, inspect, and summarize personal notes and sources.

    This is the preferred retrieval tool for broad, exploratory, or multi-hop
    questions. It follows an agentic RAG pattern inspired by recent Agentic-RAG
    paper designs: issue several targeted searches, deduplicate evidence, open
    the most promising notes/sources, and return a compact evidence brief with
    IDs that can be cited or read in full.

    Args:
        question: User question or research topic.
        search_depth: Number of query variants to try (1-5).
        top_k: Results per search query (1-10).
        open_top_n: Number of best unique items to inspect (1-5).
        mode: Retrieval mode: "auto", "sql", "vector", or "hybrid".
    """
    from pkg.db import async_session
    from pkg.models.note import Note
    from pkg.models.source import Source
    from pkg.services.retriever import RetrieverAgent
    from pkg.services.stats import increment_stats_mixed

    allowed_modes = {"auto", "sql", "vector", "hybrid"}
    mode = mode if mode in allowed_modes else "hybrid"
    search_depth = _clamp_int(search_depth, 1, 5)
    top_k = _clamp_int(top_k, 1, 10)
    open_top_n = _clamp_int(open_top_n, 1, 5)
    query_variants = _build_query_variants(question, search_depth)

    async with async_session() as session:
        retriever = RetrieverAgent(session, user_id=_get_user_id())
        ranked: dict[tuple[str, str], dict] = {}
        trace: list[str] = []

        for query in query_variants:
            results = await retriever.search(query=query, mode=mode, top_k=top_k)
            trace.append(f"search({mode}, {query!r}) -> {len(results)} hits")
            for rank, result in enumerate(results, start=1):
                result_type = "note" if result.type == "note" else "source"
                key = (result_type, result.id)
                rank_bonus = 1 / (rank + 1)
                score = float(result.score) + rank_bonus
                current = ranked.get(key)
                if current is None or score > current["score"]:
                    ranked[key] = {
                        "id": result.id,
                        "type": result_type,
                        "raw_type": result.type,
                        "title": result.title,
                        "score": score,
                        "retrieval_score": float(result.score),
                        "abstract": result.abstract,
                        "preview": result.content_preview,
                        "matched_query": query,
                    }

        best_items = sorted(ranked.values(), key=lambda item: item["score"], reverse=True)
        best_items = best_items[:open_top_n]

        opened: list[dict] = []
        for item in best_items:
            if item["type"] == "note":
                note = await session.get(Note, item["id"])
                if not note:
                    continue
                full_text = "\n\n".join(
                    part for part in [note.abstract, note.content] if part
                )
                opened.append({
                    **item,
                    "metadata": (
                        f"类型: {note.note_type}; 领域: {', '.join(note.domains or [])}; "
                        f"标签: {', '.join(note.tags or [])}"
                    ),
                    "summary": _summarize_text_extractive(full_text, question),
                })
            else:
                source = await session.get(Source, item["id"])
                if not source:
                    continue
                opened.append({
                    **item,
                    "metadata": f"类型: {source.source_type}; URL: {source.url or 'N/A'}",
                    "summary": _summarize_text_extractive(source.raw_content, question),
                })

    if not opened:
        return (
            "未找到足够相关的知识库证据。\n\n"
            "## 检索轨迹\n" + "\n".join(f"- {step}" for step in trace)
        )

    await increment_stats_mixed(
        [(item["id"], item["type"]) for item in opened],
        "retrieval_count",
    )

    lines = [
        "# Agentic RAG 证据简报",
        "",
        "## 检索策略",
        "- 将问题拆成多个查询变体，组合语义/结构化检索结果。",
        "- 对候选结果去重、按相关性与排名加权，再打开高价值条目抽取证据。",
        "",
        "## 检索轨迹",
    ]
    lines.extend(f"- {step}" for step in trace)
    lines.extend(["", "## 关键证据"])

    for index, item in enumerate(opened, start=1):
        lines.append(f"### {index}. [{item['type'].upper()}] {item['title']}")
        lines.append(f"- ID: {item['id']}")
        lines.append(f"- 相关度: {item['retrieval_score']:.2f}")
        lines.append(f"- 命中查询: {item['matched_query']}")
        lines.append(f"- 元数据: {item['metadata']}")
        if item.get("abstract"):
            lines.append(f"- 摘要: {item['abstract']}")
        elif item.get("preview"):
            lines.append(f"- 预览: {item['preview']}")
        lines.append(f"- 证据片段: {item['summary']}")
        lines.append("")

    lines.extend([
        "## 使用建议",
        "- 回答时优先引用上面的 ID；需要完整上下文时继续调用 read_note/read_source。",
        "- 如果证据分散或不足，换用更具体的关键词再次调用 agentic_rag。",
    ])
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
