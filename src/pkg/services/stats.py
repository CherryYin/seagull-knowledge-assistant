"""Knowledge stats service — increment counters and query rankings."""

import logging
from datetime import datetime, timezone

from sqlalchemy import Integer, case, func, literal_column, or_, select, text, union_all
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from pkg.db import async_session
from pkg.models.category import Category
from pkg.models.note import Note
from pkg.models.source import Source
from pkg.models.stats import KnowledgeStats

logger = logging.getLogger(__name__)


async def increment_stats(
    item_ids: list[str],
    item_type: str,
    field: str,
) -> None:
    """Atomically increment a counter for multiple items.

    Uses INSERT ... ON CONFLICT DO UPDATE SET field = field + 1.
    Failures are silently logged (non-critical path).
    """
    if not item_ids:
        return

    valid_fields = {"search_count", "retrieval_count", "reference_count"}
    if field not in valid_fields:
        logger.warning("increment_stats called with invalid field: %s", field)
        return

    try:
        async with async_session() as session:
            now = datetime.now(timezone.utc)
            for item_id in item_ids:
                stmt = pg_insert(KnowledgeStats).values(
                    item_id=item_id,
                    item_type=item_type,
                    search_count=1 if field == "search_count" else 0,
                    retrieval_count=1 if field == "retrieval_count" else 0,
                    reference_count=1 if field == "reference_count" else 0,
                    last_accessed_at=now,
                )
                stmt = stmt.on_conflict_do_update(
                    constraint="knowledge_stats_pkey",
                    set_={
                        field: getattr(KnowledgeStats, field) + 1,
                        "last_accessed_at": now,
                    },
                )
                await session.execute(stmt)
            await session.commit()
    except Exception:
        logger.warning("Failed to increment stats for %s", item_ids, exc_info=True)


async def increment_stats_mixed(
    items: list[tuple[str, str]],
    field: str,
) -> None:
    """Increment a counter for items of mixed types.

    Args:
        items: list of (item_id, item_type) tuples.
        field: counter field name.
    """
    if not items:
        return

    # Group by type for efficiency
    by_type: dict[str, list[str]] = {}
    for item_id, item_type in items:
        by_type.setdefault(item_type, []).append(item_id)

    for item_type, ids in by_type.items():
        await increment_stats(ids, item_type, field)


async def get_knowledge_rankings(
    user_id: str,
    sort_by: str = "total_count",
    item_type: str | None = None,
    title: str | None = None,
    limit: int = 50,
    offset: int = 0,
) -> tuple[list[dict], int]:
    """Query knowledge stats ranked by the specified counter.

    Returns (items, total_count).
    """
    valid_sort = {"search_count", "retrieval_count", "reference_count", "total_count"}
    if sort_by not in valid_sort:
        sort_by = "total_count"

    async with async_session() as session:
        # Build a UNION of notes and sources with their titles and categories
        # to JOIN against knowledge_stats
        total_expr = (
            KnowledgeStats.search_count
            + KnowledgeStats.retrieval_count
            + KnowledgeStats.reference_count
        ).label("total_count")

        # Base query: stats joined with item info
        # We need title and category from notes/sources tables
        # Use subqueries to get title + category_id for each item

        note_info = (
            select(
                Note.id.label("item_id"),
                literal_column("'note'").label("item_type"),
                Note.title.label("title"),
                Note.category_id.label("category_id"),
            )
            .where(Note.user_id == user_id)
        ).subquery("note_info")

        source_info = (
            select(
                Source.id.label("item_id"),
                literal_column("'source'").label("item_type"),
                Source.title.label("title"),
                Source.category_id.label("category_id"),
            )
            .where(or_(Source.user_id == user_id, Source.is_shared == True))
        ).subquery("source_info")

        # UNION ALL of note and source info
        item_info = union_all(
            select(note_info), select(source_info)
        ).subquery("item_info")

        # Main query: LEFT JOIN stats onto item_info so items with 0 counts appear too
        search_col = func.coalesce(KnowledgeStats.search_count, 0).label("search_count")
        retrieval_col = func.coalesce(KnowledgeStats.retrieval_count, 0).label("retrieval_count")
        reference_col = func.coalesce(KnowledgeStats.reference_count, 0).label("reference_count")
        total_col = (
            func.coalesce(KnowledgeStats.search_count, 0)
            + func.coalesce(KnowledgeStats.retrieval_count, 0)
            + func.coalesce(KnowledgeStats.reference_count, 0)
        ).label("total_count")
        last_access_col = KnowledgeStats.last_accessed_at.label("last_accessed_at")

        base = (
            select(
                item_info.c.item_id,
                item_info.c.item_type,
                item_info.c.title,
                item_info.c.category_id,
                search_col,
                retrieval_col,
                reference_col,
                total_col,
                last_access_col,
            )
            .outerjoin(
                KnowledgeStats,
                (KnowledgeStats.item_id == item_info.c.item_id)
                & (KnowledgeStats.item_type == item_info.c.item_type),
            )
        )

        # Filters
        if item_type:
            base = base.where(item_info.c.item_type == item_type)

        if title:
            escaped = title.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
            base = base.where(item_info.c.title.ilike(f"%{escaped}%"))

        # Count total
        count_stmt = select(func.count()).select_from(base.subquery())
        total = (await session.execute(count_stmt)).scalar() or 0

        # Sort
        sort_map = {
            "search_count": search_col,
            "retrieval_count": retrieval_col,
            "reference_count": reference_col,
            "total_count": total_col,
        }
        order_col = sort_map[sort_by]
        base = base.order_by(order_col.desc(), item_info.c.title).offset(offset).limit(limit)

        rows = (await session.execute(base)).all()

        # Resolve category names
        cat_ids = {r.category_id for r in rows if r.category_id is not None}
        cat_map: dict[int, str] = {}
        if cat_ids:
            cat_rows = await session.execute(
                select(Category).where(Category.id.in_(cat_ids))
            )
            cat_map = {c.id: c.name for c in cat_rows.scalars()}

        items = []
        for r in rows:
            items.append({
                "item_id": r.item_id,
                "item_type": r.item_type,
                "title": r.title,
                "category_name": cat_map.get(r.category_id),
                "search_count": r.search_count,
                "retrieval_count": r.retrieval_count,
                "reference_count": r.reference_count,
                "total_count": r.total_count,
                "last_accessed_at": r.last_accessed_at,
            })

        return items, total
