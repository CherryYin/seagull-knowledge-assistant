from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Literal

from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from pkg.models.foundation.note import Note
from pkg.models.foundation.source import Source
from pkg.models.foundation.wiki import WikiArticleDraft, WikiInsightCandidate, WikiMiningRun, WikiPage
from pkg.services.foundation.wiki_concept_discovery import (
    KnowledgeEntityCandidate,
    discover_knowledge_entities,
)
from pkg.services.foundation.wiki_templates import build_wiki_template

InsightType = Literal["new_insight", "connection", "contradiction", "open_question"]


@dataclass
class MiningRecord:
    record_type: str
    record_id: str
    title: str
    text: str
    created_at: datetime | None
    updated_at: datetime | None


@dataclass
class MiningEvidenceRef:
    ref_type: str
    ref_id: str
    title: str
    excerpt: str

    def to_dict(self) -> dict:
        return {
            "ref_type": self.ref_type,
            "ref_id": self.ref_id,
            "title": self.title,
            "excerpt": self.excerpt,
        }


@dataclass
class MiningInsight:
    insight_type: InsightType
    title: str
    summary: str
    evidence_refs: list[dict]
    metadata: dict


@dataclass
class MiningArticle:
    title: str
    summary: str
    content: str
    page_type: str
    evidence_refs: list[dict]
    metadata: dict
    status: str = "candidate"


@dataclass
class WikiMiningResult:
    run: WikiMiningRun
    insights: list[WikiInsightCandidate]
    articles: list[WikiArticleDraft]


async def run_wiki_mining(
    session: AsyncSession,
    *,
    user_id: str,
    window_days: int = 2,
    max_new_items: int = 24,
    max_related_items: int = 12,
) -> WikiMiningResult:
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    window_end = now
    window_start = now - timedelta(days=window_days)

    new_records = await _load_new_records(
        session,
        user_id=user_id,
        window_start=window_start,
        window_end=window_end,
        limit=max_new_items,
    )
    related_records = await _load_related_records(
        session,
        user_id=user_id,
        inputs=new_records,
        limit=max_related_items,
    )

    concept_candidates = await discover_knowledge_entities(
        session,
        user_id=user_id,
        records=new_records + related_records,
    )
    mined_insights = _mine_insights(new_records, related_records)
    mined_insights.extend(_concept_to_insight(candidate) for candidate in concept_candidates)
    mined_articles = _draft_articles(mined_insights, new_records, related_records)
    mined_articles.extend(
        _concept_to_article(candidate)
        for candidate in concept_candidates
        if candidate.should_create_article
    )

    run = WikiMiningRun(
        user_id=user_id,
        status="completed",
        window_start=window_start,
        window_end=window_end,
        metadata_={
            "window_days": window_days,
            "input_summary": {
                "new_sources": sum(1 for record in new_records if record.record_type == "source"),
                "new_notes": sum(1 for record in new_records if record.record_type == "note"),
                "related_sources": sum(1 for record in related_records if record.record_type == "source"),
                "related_notes": sum(1 for record in related_records if record.record_type == "note"),
                "related_wiki_pages": sum(1 for record in related_records if record.record_type == "wiki"),
            },
            "input_refs": {
                "new": [_record_ref(record) for record in new_records],
                "related": [_record_ref(record) for record in related_records],
            },
            "concept_discovery": {
                "enabled": True,
                "candidate_count": len(concept_candidates),
                "article_draft_count": sum(1 for candidate in concept_candidates if candidate.should_create_article),
                "llm_refinement_used": any(candidate.signals.get("llm_refined") for candidate in concept_candidates),
            },
        },
    )
    session.add(run)
    await session.flush()

    insight_rows: list[WikiInsightCandidate] = []
    for insight in mined_insights:
        row = WikiInsightCandidate(
            run_id=run.id,
            user_id=user_id,
            insight_type=insight.insight_type,
            title=insight.title,
            summary=insight.summary,
            evidence_refs=insight.evidence_refs,
            metadata_=insight.metadata,
            status="pending",
        )
        session.add(row)
        insight_rows.append(row)

    article_rows: list[WikiArticleDraft] = []
    for article in mined_articles:
        row = WikiArticleDraft(
            run_id=run.id,
            user_id=user_id,
            title=article.title,
            page_type=article.page_type,
            summary=article.summary,
            content=article.content,
            evidence_refs=article.evidence_refs,
            metadata_=article.metadata,
            status=article.status,
        )
        session.add(row)
        article_rows.append(row)

    await session.commit()
    await session.refresh(run)
    for row in insight_rows:
        await session.refresh(row)
    for row in article_rows:
        await session.refresh(row)
    return WikiMiningResult(run=run, insights=insight_rows, articles=article_rows)


async def list_wiki_mining_runs(session: AsyncSession, *, user_id: str, limit: int = 20, offset: int = 0) -> tuple[list[WikiMiningRun], int]:
    count_rows = await session.execute(select(WikiMiningRun).where(WikiMiningRun.user_id == user_id))
    total = len(list(count_rows.scalars()))
    rows = await session.execute(
        select(WikiMiningRun)
        .where(WikiMiningRun.user_id == user_id)
        .order_by(WikiMiningRun.created_at.desc(), WikiMiningRun.id.desc())
        .offset(offset)
        .limit(limit)
    )
    return list(rows.scalars()), total


async def get_wiki_mining_run_detail(session: AsyncSession, *, user_id: str, run_id: int) -> tuple[WikiMiningRun | None, list[WikiInsightCandidate], list[WikiArticleDraft]]:
    run = await session.get(WikiMiningRun, run_id)
    if not run or run.user_id != user_id:
        return None, [], []
    insight_rows = await session.execute(
        select(WikiInsightCandidate)
        .where(WikiInsightCandidate.run_id == run_id, WikiInsightCandidate.user_id == user_id)
        .order_by(WikiInsightCandidate.id.asc())
    )
    article_rows = await session.execute(
        select(WikiArticleDraft)
        .where(WikiArticleDraft.run_id == run_id, WikiArticleDraft.user_id == user_id)
        .order_by(WikiArticleDraft.id.asc())
    )
    return run, list(insight_rows.scalars()), list(article_rows.scalars())


async def _load_new_records(
    session: AsyncSession,
    *,
    user_id: str,
    window_start: datetime,
    window_end: datetime,
    limit: int,
) -> list[MiningRecord]:
    records: list[MiningRecord] = []

    source_rows = await session.execute(
        select(Source)
        .where(Source.user_id == user_id, Source.ingested_at >= window_start, Source.ingested_at <= window_end)
        .order_by(Source.ingested_at.desc())
        .limit(limit)
    )
    records.extend(_source_to_record(source) for source in source_rows.scalars())

    note_rows = await session.execute(
        select(Note)
        .where(
            Note.user_id == user_id,
            or_(Note.created_at >= window_start, Note.updated_at >= window_start),
            Note.created_at <= window_end,
        )
        .order_by(Note.updated_at.desc())
        .limit(limit)
    )
    records.extend(_note_to_record(note) for note in note_rows.scalars())

    records.sort(key=lambda record: record.updated_at or record.created_at or window_start, reverse=True)
    return records[:limit]


async def _load_related_records(
    session: AsyncSession,
    *,
    user_id: str,
    inputs: list[MiningRecord],
    limit: int,
) -> list[MiningRecord]:
    if not inputs:
        return []

    keywords = _keywords("\n".join(record.title + "\n" + record.text[:400] for record in inputs))[:8]
    if not keywords:
        return []

    patterns = [f"%{keyword}%" for keyword in keywords]
    related: list[MiningRecord] = []
    seen: set[tuple[str, str]] = {(record.record_type, record.record_id) for record in inputs}

    source_rows = await session.execute(
        select(Source)
        .where(
            Source.user_id == user_id,
            or_(*[Source.title.ilike(pattern) for pattern in patterns]),
        )
        .order_by(Source.ingested_at.desc())
        .limit(limit)
    )
    for source in source_rows.scalars():
        key = ("source", source.id)
        if key not in seen:
            related.append(_source_to_record(source))
            seen.add(key)

    note_rows = await session.execute(
        select(Note)
        .where(
            Note.user_id == user_id,
            or_(*[Note.title.ilike(pattern) for pattern in patterns]),
        )
        .order_by(Note.updated_at.desc())
        .limit(limit)
    )
    for note in note_rows.scalars():
        key = ("note", note.id)
        if key not in seen:
            related.append(_note_to_record(note))
            seen.add(key)

    wiki_rows = await session.execute(
        select(WikiPage)
        .where(
            WikiPage.user_id == user_id,
            or_(*[WikiPage.title.ilike(pattern) for pattern in patterns]),
        )
        .order_by(WikiPage.updated_at.desc())
        .limit(limit)
    )
    for wiki in wiki_rows.scalars():
        key = ("wiki", wiki.id)
        if key not in seen:
            related.append(
                MiningRecord(
                    record_type="wiki",
                    record_id=wiki.id,
                    title=wiki.title,
                    text="\n\n".join(part for part in [wiki.summary or "", wiki.content or ""] if part),
                    created_at=wiki.created_at,
                    updated_at=wiki.updated_at,
                )
            )
            seen.add(key)

    related.sort(key=lambda record: record.updated_at or record.created_at or datetime.min, reverse=True)
    return related[:limit]


def _mine_insights(new_records: list[MiningRecord], related_records: list[MiningRecord]) -> list[MiningInsight]:
    combined = new_records + related_records
    if not combined:
        return []

    evidence_pool = [_record_to_evidence(record) for record in combined]
    insights: list[MiningInsight] = []

    grouped = _group_by_keyword(combined)
    for keyword, records in grouped[:6]:
        evidence_refs = [ref.to_dict() for ref in [_record_to_evidence(record) for record in records[:3]]]
        insight_type: InsightType = "new_insight"
        title = f"{keyword.title()} recent movement"
        summary = f"Recent materials suggest {keyword} is becoming a reusable theme across {len(records)} items."
        if len({record.record_type for record in records}) >= 2:
            insight_type = "connection"
            title = f"{keyword.title()} connects multiple layers"
            summary = f"{keyword} appears across evidence, notes, and knowledge nodes, which makes it a strong candidate topic."
        if any("not" in record.text.lower() or "但是" in record.text or "however" in record.text.lower() for record in records):
            insight_type = "contradiction"
            title = f"{keyword.title()} has conflicting signals"
            summary = f"Recent records mention differing interpretations around {keyword}; it likely needs review before stabilization."
        elif any("?" in record.text or "待" in record.text or "todo" in record.text.lower() for record in records):
            insight_type = "open_question"
            title = f"{keyword.title()} remains open"
            summary = f"The latest material raises unanswered questions about {keyword} that deserve a candidate article section."
        insights.append(
            MiningInsight(
                insight_type=insight_type,
                title=title,
                summary=summary,
                evidence_refs=evidence_refs,
                metadata={
                    "keyword": keyword,
                    "record_refs": [_record_ref(record) for record in records[:5]],
                    "claims": _build_claims_for_insight(title=title, summary=summary, evidence_refs=evidence_refs),
                },
            )
        )

    if len(insights) < 3:
        for record in combined[: 3 - len(insights)]:
            insights.append(
                MiningInsight(
                    insight_type="new_insight",
                    title=f"Capture {record.title}",
                    summary=f"{record.title} should be folded into the knowledge base as a candidate synthesis topic.",
                    evidence_refs=[_record_to_evidence(record).to_dict()],
                    metadata={
                        "record_refs": [_record_ref(record)],
                        "claims": _build_claims_for_insight(
                            title=f"Capture {record.title}",
                            summary=f"{record.title} should be folded into the knowledge base as a candidate synthesis topic.",
                            evidence_refs=[_record_to_evidence(record).to_dict()],
                        ),
                    },
                )
            )

    if len(insights) > 10:
        insights = insights[:10]

    if evidence_pool and insights:
        for insight in insights:
            if not insight.evidence_refs:
                insight.evidence_refs = [evidence_pool[0].to_dict()]
    return insights


def _draft_articles(
    insights: list[MiningInsight],
    new_records: list[MiningRecord],
    related_records: list[MiningRecord],
) -> list[MiningArticle]:
    if not insights:
        return []

    primary = insights[:4]
    title_seed = primary[0].metadata.get("keyword") if primary and primary[0].metadata else None
    article_title = f"{str(title_seed).title()} Knowledge Candidate" if title_seed else "Knowledge Candidate Article"
    summary = "A human-readable synthesis of recent inputs, related history, and candidate insights for review."
    evidence_refs = []
    for insight in primary:
        evidence_refs.extend(insight.evidence_refs[:2])
    deduped_refs = []
    seen: set[tuple[str, str]] = set()
    for ref in evidence_refs:
        key = (str(ref.get("ref_type")), str(ref.get("ref_id")))
        if key in seen:
            continue
        seen.add(key)
        deduped_refs.append(ref)

    inferred_page_type = _infer_page_type(primary)
    sections = [line for line in build_wiki_template(article_title, inferred_page_type).split("\n")]
    sections.extend(["", summary, "", "## Candidate Insights"])
    for insight in primary:
        sections.append(f"- **{insight.title}**: {insight.summary}")
    sections.extend([
        "",
        "## Recent Inputs",
    ])
    for record in new_records[:6]:
        sections.append(f"- {record.record_type}: {record.title}")
    if related_records:
        sections.extend(["", "## Related Context"])
        for record in related_records[:6]:
            sections.append(f"- {record.record_type}: {record.title}")
    sections.extend(["", "## Review Notes", "- Confirm the strongest claim and keep evidence links attached."])

    return [
        MiningArticle(
            title=article_title,
            summary=summary,
            content="\n".join(sections),
            page_type=inferred_page_type,
            evidence_refs=deduped_refs,
            metadata={
                "insight_titles": [insight.title for insight in primary],
                "input_refs": [_record_ref(record) for record in new_records[:8]],
                "related_refs": [_record_ref(record) for record in related_records[:8]],
                "claims": _build_claims_for_article(primary, deduped_refs),
            },
        )
    ]


def _concept_to_insight(candidate: KnowledgeEntityCandidate) -> MiningInsight:
    return MiningInsight(
        insight_type="connection" if candidate.signals.get("layer_count", 0) >= 2 else "new_insight",
        title=f"{candidate.display_name} is a discovered concept",
        summary=(
            f"{candidate.display_name} appears as a reusable {candidate.entity_type} across "
            f"{candidate.signals.get('unique_record_count', 0)} records and is recommended for "
            f"{candidate.recommendation.replace('_', ' ')}."
        ),
        evidence_refs=candidate.evidence_refs,
        metadata={
            "origin": "wiki_concept_discovery",
            "candidate_kind": "knowledge_entity",
            "canonical_name": candidate.canonical_name,
            "display_name": candidate.display_name,
            "entity_type": candidate.entity_type,
            "definition": candidate.definition,
            "aliases": candidate.aliases,
            "signals": candidate.signals,
            "recommendation": candidate.recommendation,
            "related_wiki_ids": candidate.related_wiki_ids,
            "related_memory_ids": candidate.related_memory_ids,
            "record_refs": candidate.record_refs,
            "claims": _build_claims_for_insight(
                title=f"{candidate.display_name} is a discovered concept",
                summary=candidate.definition,
                evidence_refs=candidate.evidence_refs,
            ),
        },
    )


def _concept_to_article(candidate: KnowledgeEntityCandidate) -> MiningArticle:
    title = candidate.display_name
    sections = [line for line in build_wiki_template(title, "concept").split("\n")]
    sections.extend(
        [
            "",
            "## Discovery Summary",
            candidate.definition,
            "",
            "## Evidence",
        ]
    )
    for ref in candidate.evidence_refs[:5]:
        sections.append(f"- {ref.get('ref_type')}: {ref.get('title')} — {ref.get('excerpt', '')}")
    sections.extend(
        [
            "",
            "## Aliases",
            *[f"- {alias}" for alias in candidate.aliases[:8]],
            "",
            "## Review Notes",
            "- Confirm the definition and decide whether this should remain a concept page or be merged into a broader topic wiki.",
        ]
    )
    return MiningArticle(
        title=title,
        summary=candidate.definition,
        content="\n".join(sections),
        page_type="concept",
        evidence_refs=candidate.evidence_refs,
        metadata={
            "origin": "wiki_concept_discovery",
            "candidate_kind": "knowledge_entity",
            "canonical_name": candidate.canonical_name,
            "display_name": candidate.display_name,
            "entity_type": candidate.entity_type,
            "aliases": candidate.aliases,
            "signals": candidate.signals,
            "recommendation": candidate.recommendation,
            "related_wiki_ids": candidate.related_wiki_ids,
            "related_memory_ids": candidate.related_memory_ids,
            "source_candidate_refs": candidate.record_refs,
        },
        status="candidate",
    )


def _build_claims_for_insight(*, title: str, summary: str, evidence_refs: list[dict]) -> list[dict]:
    return [
        {
            "text": summary or title,
            "status": "supported" if evidence_refs else "weak",
            "evidence_refs": evidence_refs[:3],
        }
    ]


def _build_claims_for_article(insights: list[MiningInsight], evidence_refs: list[dict]) -> list[dict]:
    claims: list[dict] = []
    for index, insight in enumerate(insights[:5]):
        refs = insight.evidence_refs[:2] or evidence_refs[:2]
        claims.append(
            {
                "text": insight.summary,
                "status": "supported" if refs else "weak",
                "evidence_refs": refs,
                "source_insight_title": insight.title,
                "rank": index + 1,
            }
        )
    return claims


def _infer_page_type(insights: list[MiningInsight]) -> str:
    keywords = " ".join(str(item.metadata.get("keyword", "")) for item in insights if item.metadata)
    lowered = keywords.lower()
    if any(word in lowered for word in ["compare", "versus", "vs", "tradeoff"]):
        return "comparison"
    if any(word in lowered for word in ["project", "roadmap", "milestone"]):
        return "project"
    if any(word in lowered for word in ["concept", "framework", "principle", "pattern"]):
        return "concept"
    if any(word in lowered for word in ["company", "tool", "person", "product", "entity"]):
        return "entity"
    return "topic"


def _source_to_record(source: Source) -> MiningRecord:
    return MiningRecord(
        record_type="source",
        record_id=source.id,
        title=source.title,
        text="\n\n".join(part for part in [source.title, source.raw_content or ""] if part),
        created_at=source.ingested_at,
        updated_at=source.ingested_at,
    )


def _note_to_record(note: Note) -> MiningRecord:
    return MiningRecord(
        record_type="note",
        record_id=note.id,
        title=note.title,
        text="\n\n".join(part for part in [note.title, note.abstract or "", note.content or ""] if part),
        created_at=note.created_at,
        updated_at=note.updated_at,
    )


def _record_to_evidence(record: MiningRecord) -> MiningEvidenceRef:
    excerpt = " ".join(record.text.split())[:240]
    return MiningEvidenceRef(ref_type=record.record_type, ref_id=record.record_id, title=record.title, excerpt=excerpt)


def _record_ref(record: MiningRecord) -> dict:
    return {"type": record.record_type, "id": record.record_id, "title": record.title}


def _keywords(text: str) -> list[str]:
    import re

    words = re.findall(r"[A-Za-z][A-Za-z0-9_-]{2,}|[\u4e00-\u9fff]{2,}", text.lower())
    stop = {
        "the", "and", "for", "with", "from", "this", "that", "knowledge", "source", "note", "wiki",
        "memory", "topic", "candidate", "article", "recent", "summary", "content", "一个", "这个", "知识", "内容",
    }
    seen: set[str] = set()
    result: list[str] = []
    for word in words:
        if word in stop or word in seen:
            continue
        seen.add(word)
        result.append(word)
    return result


def _group_by_keyword(records: list[MiningRecord]) -> list[tuple[str, list[MiningRecord]]]:
    keyword_map: dict[str, list[MiningRecord]] = {}
    for record in records:
        for keyword in _keywords(record.title + "\n" + record.text[:300])[:5]:
            keyword_map.setdefault(keyword, []).append(record)
    ranked = sorted(keyword_map.items(), key=lambda item: (len(item[1]), item[0]), reverse=True)
    return ranked
