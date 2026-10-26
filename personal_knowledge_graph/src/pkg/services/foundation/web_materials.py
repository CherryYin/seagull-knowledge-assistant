import hashlib
from datetime import datetime, timezone

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from pkg.models.foundation.source import Source
from pkg.schemas.discovery import DiscoveryWebSaveRequest, DiscoveryWebSaveResult
from pkg.schemas.source import SourceRead
from pkg.services.foundation.source_review import mark_explicitly_saved
from pkg.services.foundation.web_source_roles import WEB_ROLE_PAGE, apply_web_source_role


async def save_web_materials(
    session: AsyncSession, *, user_id: str, body: DiscoveryWebSaveRequest
) -> DiscoveryWebSaveResult:
    selected = {}
    for item in body.items:
        selected.setdefault(item.url, item)
    existing = (
        await session.scalars(
            select(Source)
            .where(Source.user_id == user_id, Source.url.in_(selected))
            .order_by(Source.ingested_at, Source.id)
        )
    ).all()
    by_url = {}
    for source in existing:
        by_url.setdefault(source.url, source)
    saved = []
    created = 0
    for url, item in sorted(selected.items()):
        if url in by_url:
            saved.append(SourceRead.model_validate(by_url[url]))
            continue
        source_id = "src-web-search-" + hashlib.sha256(f"{user_id}:{url}".encode()).hexdigest()[:32]
        raw_content = "\n\n".join(
            part
            for part in (
                item.title,
                item.summary,
                f"URL: {url}",
                f"Published (search provider, unverified): {item.published_at}"
                if item.published_at
                else None,
                "Search summary only; not full-page content or fact verification.",
            )
            if part
        ).replace("\x00", "")
        metadata = mark_explicitly_saved(
            apply_web_source_role(
                {
                    "connector": "web_search",
                    "discovery_query": body.query,
                    "source_name": item.source_name,
                    "published_at": item.published_at,
                    "content_scope": "search_summary",
                    "fact_check_status": "unverified",
                },
                role=WEB_ROLE_PAGE,
                origin="web_search",
            ),
            saved_at=datetime.now(timezone.utc).isoformat(),
        )
        inserted = (
            await session.execute(
                insert(Source.__table__)
                .values(
                    id=source_id,
                    user_id=user_id,
                    category_id=1,
                    title=item.title,
                    source_type="web",
                    url=url,
                    description=(item.summary or "")[:8000] or None,
                    raw_content=raw_content,
                    content_hash=hashlib.sha256(raw_content.encode()).hexdigest(),
                    metadata=metadata,
                )
                .on_conflict_do_nothing(index_elements=["id"])
                .returning(Source.id)
            )
        ).scalar_one_or_none()
        source = await session.get(Source, source_id)
        if source is None or source.user_id != user_id or source.url != url:
            raise HTTPException(status_code=409, detail="Web material identity conflict")
        created += inserted is not None
        saved.append(SourceRead.model_validate(source))
    await session.commit()
    return DiscoveryWebSaveResult(items=saved, created=created, reused=len(saved) - created)
