from __future__ import annotations

import json
import re
from datetime import datetime, timedelta, timezone
from typing import Iterable

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from pkg.models.discovery import DiscoveryItem
from pkg.models.foundation.source import Source
from pkg.models.paper_discovery import PaperDiscoveryProfile
from pkg.models.user import UserSettings
from pkg.schemas.application.asset import (
    AssetCreate,
    AssetProvenance,
    NewsletterAutomationConfig,
    NewsletterAutomationRunResult,
    NewsletterAutomationRunSnapshot,
    NewsletterAutomationUpdate,
)
from pkg.services.application.assets import create_asset
from pkg.services.cross_cutting.user_settings import get_user_settings_dict

NEWSLETTER_SETTING_KEY = "newsletter_automation"
NEWSLETTER_PAPER_PROFILE_NAME = "Newsletter Automation Papers"
PAPER_PROVIDERS = {"arxiv", "openalex", "semantic_scholar", "crossref"}
NEWS_PROVIDERS = {"news", "rss", "web"}


def is_newsletter_due(config: NewsletterAutomationConfig, now: datetime) -> bool:
    if not config.enabled or config.frequency == "manual":
        return False
    current = _ensure_utc(now)
    last_run_at = config.last_run_at or config.last_generated_at
    last_run = _ensure_utc(last_run_at) if last_run_at else None
    if current.hour < config.hour_utc:
        return False
    if config.frequency == "daily":
        return last_run is None or last_run.date() < current.date()
    if current.weekday() != config.weekday_utc:
        return False
    return last_run is None or last_run.date() < current.date()


async def get_newsletter_config(session: AsyncSession, *, user_id: str) -> NewsletterAutomationConfig:
    settings = await get_user_settings_dict(session, user_id)
    raw = settings.get(NEWSLETTER_SETTING_KEY)
    if not isinstance(raw, dict):
        return NewsletterAutomationConfig()
    return NewsletterAutomationConfig.model_validate(raw)


async def update_newsletter_config(
    session: AsyncSession,
    *,
    user_id: str,
    body: NewsletterAutomationUpdate,
) -> NewsletterAutomationConfig:
    current = await get_newsletter_config(session, user_id=user_id)
    updated = NewsletterAutomationConfig(
        **body.model_dump(),
        config_revision=current.config_revision + 1,
        last_generated_at=current.last_generated_at,
        last_asset_id=current.last_asset_id,
        last_run_at=current.last_run_at,
        last_run_status=current.last_run_status,
        last_run_reason=current.last_run_reason,
        last_news_count=current.last_news_count,
        last_paper_count=current.last_paper_count,
    )
    await _save_newsletter_config(session, user_id=user_id, config=updated)
    return updated


async def generate_newsletter(
    session: AsyncSession,
    *,
    user_id: str,
    force: bool = False,
    now: datetime | None = None,
) -> NewsletterAutomationRunResult:
    current = _ensure_utc(now or datetime.now(timezone.utc))
    config = await get_newsletter_config(session, user_id=user_id)
    run_snapshot = _newsletter_run_snapshot(config)
    if not force and not is_newsletter_due(config, current):
        return NewsletterAutomationRunResult(
            status="skipped",
            reason="not_due",
            config_revision=config.config_revision,
            config_snapshot=run_snapshot,
        )

    cutoff = current - timedelta(days=config.lookback_days)
    database_cutoff = cutoff.replace(tzinfo=None)
    source_rows = await session.execute(
        select(Source)
        .where(Source.user_id == user_id, Source.ingested_at >= database_cutoff)
        .order_by(Source.ingested_at.desc())
        .limit(max((config.max_news_items + config.max_paper_items) * 8, 50))
    )
    sources = list(source_rows.scalars())
    discovery_rows = await session.execute(
        select(DiscoveryItem)
        .where(
            DiscoveryItem.user_id == user_id,
            DiscoveryItem.created_at >= database_cutoff,
            DiscoveryItem.status != "dismissed",
        )
        .order_by(DiscoveryItem.created_at.desc())
        .limit(max(config.max_paper_items * 8, 40))
    )
    discoveries = list(discovery_rows.scalars())

    news_sources = _take_matching(
        (source for source in sources if _source_kind(source) == "news"),
        config.topics,
        config.max_news_items,
    )
    paper_sources = _take_matching(
        (source for source in sources if _source_kind(source) == "paper"),
        config.topics,
        config.max_paper_items,
    )
    remaining_papers = max(config.max_paper_items - len(paper_sources), 0)
    paper_discoveries = _take_matching(
        (
            item
            for item in discoveries
            if _discovery_kind(item) == "paper" and not item.source_id
        ),
        config.topics,
        remaining_papers,
    )

    if not news_sources and not paper_sources and not paper_discoveries:
        updated = config.model_copy(update={
            "last_run_at": current,
            "last_run_status": "skipped",
            "last_run_reason": "no_matching_items",
            "last_news_count": 0,
            "last_paper_count": 0,
        })
        await _save_newsletter_config(session, user_id=user_id, config=updated)
        return NewsletterAutomationRunResult(
            status="skipped",
            reason="no_matching_items",
            config_revision=config.config_revision,
            config_snapshot=run_snapshot,
        )

    title = f"{config.name} · {current.date().isoformat()}"
    draft = build_newsletter_markdown(
        title=title,
        config=config,
        news_sources=news_sources,
        paper_sources=paper_sources,
        paper_discoveries=paper_discoveries,
        generated_at=current,
    )
    source_refs = [source.id for source in [*news_sources, *paper_sources]]
    asset = await create_asset(
        session,
        user_id=user_id,
        body=AssetCreate(
            title=title,
            brief=f"Automated technology newsletter covering the previous {config.lookback_days} day(s).",
            draft_content=draft,
            asset_type="newsletter_issue",
            status="draft",
            source_refs=source_refs,
            style_notes=config.style_notes or None,
            metadata={
                "audience": config.audience or None,
                "delivery_format": config.delivery_format,
                "generation_mode": "newsletter_automation",
                "newsletter_automation": {
                    "config_revision": config.config_revision,
                    "config_snapshot": run_snapshot.model_dump(mode="json"),
                    "generated_at": current.isoformat(),
                    "lookback_days": config.lookback_days,
                    "topics": config.topics,
                    "news_count": len(news_sources),
                    "paper_count": len(paper_sources) + len(paper_discoveries),
                    "discovery_refs": [item.id for item in paper_discoveries],
                },
            },
            provenance=AssetProvenance(origin_type="user", action="save"),
        ),
    )
    news_count = len(news_sources)
    paper_count = len(paper_sources) + len(paper_discoveries)
    updated = config.model_copy(update={
        "last_generated_at": current,
        "last_asset_id": asset.id,
        "last_run_at": current,
        "last_run_status": "generated",
        "last_run_reason": None,
        "last_news_count": news_count,
        "last_paper_count": paper_count,
    })
    await _save_newsletter_config(session, user_id=user_id, config=updated)
    return NewsletterAutomationRunResult(
        status="generated",
        news_count=news_count,
        paper_count=paper_count,
        config_revision=config.config_revision,
        config_snapshot=run_snapshot,
        asset=asset,
    )


def _newsletter_run_snapshot(config: NewsletterAutomationConfig) -> NewsletterAutomationRunSnapshot:
    return NewsletterAutomationRunSnapshot(
        config_revision=config.config_revision,
        enabled=config.enabled,
        name=config.name,
        topics=config.topics,
        frequency=config.frequency,
        hour_utc=config.hour_utc,
        weekday_utc=config.weekday_utc,
        lookback_days=config.lookback_days,
        max_news_items=config.max_news_items,
        max_paper_items=config.max_paper_items,
        delivery_format=config.delivery_format,
        audience=config.audience,
        style_notes=config.style_notes,
    )


def build_newsletter_markdown(
    *,
    title: str,
    config: NewsletterAutomationConfig,
    news_sources: list[Source],
    paper_sources: list[Source],
    paper_discoveries: list[DiscoveryItem],
    generated_at: datetime,
) -> str:
    topics = ", ".join(config.topics) if config.topics else "configured technology sources"
    lines = [
        f"# {title}",
        "",
        "## Editor’s Note",
        f"This reviewable draft was generated from newly collected material about {topics}. Verify relevance and wording before publishing.",
        "",
        "## Featured Items",
        "",
        "### Technology News",
    ]
    lines.extend(_source_feature_lines(news_sources) or ["- No matching technology news was collected in this window."])
    lines.extend(["", "### Research Papers"])
    lines.extend(_source_feature_lines(paper_sources))
    lines.extend(_discovery_feature_lines(paper_discoveries))
    if not paper_sources and not paper_discoveries:
        lines.append("- No matching paper information was collected in this window.")
    lines.extend([
        "",
        "## Why It Matters",
        "The selected items provide a starting point for identifying meaningful developments, emerging research directions, and material changes that deserve further review.",
        "",
        "## Further Reading",
    ])
    links = [*_source_link_lines(news_sources), *_source_link_lines(paper_sources), *_discovery_link_lines(paper_discoveries)]
    lines.extend(links or ["- No external reading links are available."])
    lines.extend(["", "## Evidence Notes"])
    lines.extend([f"- [Source: {source.id}] {_clean_text(source.title)}" for source in [*news_sources, *paper_sources]])
    lines.extend([f"- [Discovery: {item.id}] {_clean_text(item.title)}" for item in paper_discoveries])
    lines.extend([
        "",
        "## Review Notes",
        f"Generated automatically at {generated_at.isoformat()} from a {config.lookback_days}-day collection window. Claims, ordering, and editorial emphasis require explicit user review before export or publication.",
    ])
    return "\n".join(lines).strip()


def _take_matching(items: Iterable, topics: list[str], limit: int) -> list:
    if limit <= 0:
        return []
    normalized_topics = [topic.strip().lower() for topic in topics if topic.strip()]
    selected = []
    for item in items:
        searchable = _searchable_text(item).lower()
        if normalized_topics and not any(topic in searchable for topic in normalized_topics):
            continue
        selected.append(item)
        if len(selected) >= limit:
            break
    return selected


def _source_kind(source: Source) -> str | None:
    metadata = source.metadata_ or {}
    if metadata.get("connector") == "arxiv" or metadata.get("arxiv_id"):
        return "paper"
    if metadata.get("kind") == "news" or metadata.get("feed_source_id") or metadata.get("content_source") in {"rss", "page", "web_directory"}:
        return "news"
    return None


def _discovery_kind(item: DiscoveryItem) -> str | None:
    payload = item.payload or {}
    if item.provider in PAPER_PROVIDERS or payload.get("item_type") == "paper":
        return "paper"
    if item.provider in NEWS_PROVIDERS or payload.get("item_type") in {"news", "article"}:
        return "news"
    return None


def _searchable_text(item) -> str:
    if isinstance(item, Source):
        return " ".join([item.title or "", item.raw_content or "", json.dumps(item.metadata_ or {}, ensure_ascii=False)])
    return " ".join([item.title or "", item.summary or "", json.dumps(item.payload or {}, ensure_ascii=False)])


def _source_feature_lines(items: list[Source]) -> list[str]:
    return [f"- **{_clean_text(item.title)}** — {_source_summary(item)} [Source: {item.id}]" for item in items]


def _discovery_feature_lines(items: list[DiscoveryItem]) -> list[str]:
    return [f"- **{_clean_text(item.title)}** — {_clean_text(item.summary or 'Paper candidate awaiting review.')} [Discovery: {item.id}]" for item in items]


def _source_link_lines(items: list[Source]) -> list[str]:
    return [f"- [{_clean_link_text(item.title)}]({url})" for item in items if (url := _safe_url(item.url))]


def _discovery_link_lines(items: list[DiscoveryItem]) -> list[str]:
    return [f"- [{_clean_link_text(item.title)}]({url})" for item in items if (url := _safe_url(item.url))]


def _source_summary(source: Source) -> str:
    metadata = source.metadata_ or {}
    description = metadata.get("description")
    if isinstance(description, str) and description.strip():
        return _clean_text(description)[:280]
    content = re.sub(r"^#+\s+", "", source.raw_content or "", flags=re.MULTILINE)
    return _clean_text(content)[:280] or "Collected item awaiting editorial review."


def _clean_text(value: str) -> str:
    return re.sub(r"\s+", " ", value).strip()


def _clean_link_text(value: str) -> str:
    return _clean_text(value).replace("[", "\\[").replace("]", "\\]")


def _safe_url(value: str | None) -> str | None:
    if not value:
        return None
    normalized = value.strip()
    return normalized if normalized.startswith(("https://", "http://")) else None


def _ensure_utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


async def _save_newsletter_config(session: AsyncSession, *, user_id: str, config: NewsletterAutomationConfig) -> None:
    obj = await session.get(UserSettings, user_id)
    settings = dict(obj.settings) if obj and isinstance(obj.settings, dict) else {}
    settings[NEWSLETTER_SETTING_KEY] = config.model_dump(mode="json")
    if config.topics:
        settings["news_auto_search_query"] = " OR ".join(
            f'"{topic}"' if " " in topic else topic
            for topic in config.topics
        )
    if obj is None:
        obj = UserSettings(user_id=user_id, settings=settings)
        session.add(obj)
    else:
        obj.settings = settings
    await _sync_newsletter_paper_profile(session, user_id=user_id, config=config)
    await session.commit()


async def _sync_newsletter_paper_profile(
    session: AsyncSession,
    *,
    user_id: str,
    config: NewsletterAutomationConfig,
) -> None:
    row = await session.execute(
        select(PaperDiscoveryProfile).where(
            PaperDiscoveryProfile.user_id == user_id,
            PaperDiscoveryProfile.name == NEWSLETTER_PAPER_PROFILE_NAME,
        )
    )
    profile = row.scalar_one_or_none()
    values = {
        "description": "Managed by Assets Newsletter Automation.",
        "goal_prompt": f"Find recent research for {config.name}.",
        "mode": "hybrid",
        "provider": "openalex",
        "schedule": "daily",
        "is_enabled": config.enabled and config.max_paper_items > 0,
        "max_results": max(config.max_paper_items * 3, 10),
        "discovery_window_days": 365,
        "time_window_days": config.lookback_days,
        "include_terms": config.topics,
        "exclude_terms": [],
        "preferred_authors": [],
        "preferred_venues": [],
        "preferred_fields": [],
        "preferred_arxiv_categories": [],
        "seed_paper_ids": [],
    }
    if profile is None:
        session.add(PaperDiscoveryProfile(user_id=user_id, name=NEWSLETTER_PAPER_PROFILE_NAME, **values))
        return
    for key, value in values.items():
        setattr(profile, key, value)
