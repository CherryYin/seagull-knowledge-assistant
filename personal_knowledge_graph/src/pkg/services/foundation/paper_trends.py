import math
import re
from collections import Counter
from datetime import datetime, timedelta, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from pkg.models.paper_discovery import PaperDiscoveryProfile, PaperTrendSnapshot
from pkg.schemas.connector import ExternalPaper
from pkg.services.paper_providers.semantic_scholar import search_semantic_scholar
from pkg.services.foundation.paper_query_builder import build_paper_query_bundle


_STOPWORDS = {
    "the",
    "a",
    "an",
    "of",
    "for",
    "to",
    "and",
    "or",
    "with",
    "in",
    "on",
    "by",
    "using",
    "based",
    "from",
    "via",
}


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _tokenize(text: str) -> list[str]:
    return [
        token.lower()
        for token in re.findall(r"[A-Za-z][A-Za-z0-9_-]{2,}", text or "")
        if token.lower() not in _STOPWORDS
    ]


def _paper_text(paper: ExternalPaper) -> str:
    parts = [paper.title or "", paper.abstract or "", " ".join(paper.fields_of_study or [])]
    return " ".join(parts)


def extract_trend_terms(papers: list[ExternalPaper], *, top_k: int = 20, min_count: int = 2) -> Counter:
    counter: Counter = Counter()
    for paper in papers:
        counter.update(_tokenize(_paper_text(paper)))
    filtered = Counter({term: count for term, count in counter.items() if count >= min_count})
    return Counter(dict(filtered.most_common(top_k)))


def score_trend_terms(current_window: Counter, baseline_window: Counter, *, min_count: int = 2) -> list[dict]:
    scored: list[dict] = []
    for term, current_count in current_window.items():
        if current_count < min_count:
            continue
        baseline_count = baseline_window.get(term, 0)
        growth_rate = (current_count + 1) / (baseline_count + 1)
        score = growth_rate * math.log1p(current_count)
        scored.append(
            {
                "term": term,
                "count": current_count,
                "baseline_count": baseline_count,
                "growth_rate": growth_rate,
                "score": score,
            }
        )
    scored.sort(key=lambda item: (item["score"], item["count"]), reverse=True)
    return scored


async def collect_trend_corpus(
    profile: PaperDiscoveryProfile,
    *,
    current_days: int = 7,
    baseline_days: int = 30,
    limit_per_query: int | None = None,
) -> tuple[list[ExternalPaper], list[ExternalPaper], list[str]]:
    bundle = build_paper_query_bundle(profile)
    queries = bundle.primary_queries[:1] or bundle.expanded_queries[:1]
    if not queries:
        return [], [], []

    current_year = str(_utc_now().year)
    baseline_year = str(max(1900, (_utc_now() - timedelta(days=baseline_days)).year))
    current_papers: list[ExternalPaper] = []
    baseline_papers: list[ExternalPaper] = []
    query_texts: list[str] = []
    per_query_limit = limit_per_query or profile.max_results

    for query_spec in queries:
        query_texts.append(query_spec.query)
        current_papers.extend(await search_semantic_scholar(query=query_spec.query, limit=per_query_limit, year=current_year))
        baseline_papers.extend(await search_semantic_scholar(query=query_spec.query, limit=per_query_limit, year=baseline_year))

    return current_papers, baseline_papers, query_texts


async def upsert_paper_trend_snapshot(
    session: AsyncSession,
    *,
    user_id: str,
    profile_id: int | None,
    provider: str,
    scope_key: str,
    window_start: datetime,
    window_end: datetime,
    term: str,
    topic: str | None,
    count: int,
    baseline_count: int | None,
    growth_rate: float | None,
    score: float | None,
    metadata: dict | None = None,
) -> PaperTrendSnapshot:
    rows = await session.execute(
        select(PaperTrendSnapshot).where(
            PaperTrendSnapshot.user_id == user_id,
            PaperTrendSnapshot.provider == provider,
            PaperTrendSnapshot.scope_key == scope_key,
            PaperTrendSnapshot.window_start == window_start,
            PaperTrendSnapshot.window_end == window_end,
            PaperTrendSnapshot.term == term,
        )
    )
    item = rows.scalar_one_or_none()
    if item:
        item.topic = topic
        item.count = count
        item.baseline_count = baseline_count
        item.growth_rate = growth_rate
        item.score = score
        item.metadata_ = metadata
        return item
    item = PaperTrendSnapshot(
        user_id=user_id,
        profile_id=profile_id,
        provider=provider,
        scope_key=scope_key,
        window_start=window_start,
        window_end=window_end,
        topic=topic,
        term=term,
        count=count,
        baseline_count=baseline_count,
        growth_rate=growth_rate,
        score=score,
        metadata_=metadata,
    )
    session.add(item)
    return item


async def find_paper_trends(
    session: AsyncSession,
    *,
    profile: PaperDiscoveryProfile,
    current_days: int = 7,
    baseline_days: int = 30,
    top_k: int = 10,
    commit: bool = False,
) -> list[PaperTrendSnapshot]:
    current_papers, baseline_papers, query_texts = await collect_trend_corpus(
        profile,
        current_days=current_days,
        baseline_days=baseline_days,
    )
    current_terms = extract_trend_terms(current_papers, top_k=max(top_k * 2, 10))
    baseline_terms = extract_trend_terms(baseline_papers, top_k=max(top_k * 2, 10), min_count=1)
    scored_terms = score_trend_terms(current_terms, baseline_terms)[:top_k]

    now = _utc_now().replace(tzinfo=None)
    window_start = (now - timedelta(days=current_days))
    scope_key = f"profile:{profile.id}:queries:{'|'.join(query_texts[:3])}" if query_texts else f"profile:{profile.id}"
    snapshots: list[PaperTrendSnapshot] = []
    for term_info in scored_terms:
        snapshot = await upsert_paper_trend_snapshot(
            session,
            user_id=profile.user_id,
            profile_id=profile.id,
            provider=profile.provider,
            scope_key=scope_key,
            window_start=window_start,
            window_end=now,
            term=term_info["term"],
            topic=None,
            count=term_info["count"],
            baseline_count=term_info["baseline_count"],
            growth_rate=term_info["growth_rate"],
            score=term_info["score"],
            metadata={"queries": query_texts, "current_days": current_days, "baseline_days": baseline_days},
        )
        snapshots.append(snapshot)
    if commit:
        await session.commit()
    return snapshots
