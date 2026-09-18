"""Suggest wiki recompiles from new notes or sources."""

import re
from dataclasses import dataclass
from datetime import datetime, timezone

from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from pkg.models.foundation.note import Note
from pkg.models.foundation.source import Source
from pkg.models.foundation.wiki import WikiPage, WikiRecompileSuggestion


MIN_WIKI_RECOMPILE_SCORE = 3


@dataclass
class TriggerPayload:
    trigger_type: str
    trigger_id: str
    title: str
    text: str
    source_ids: list[str]
    note_ids: list[str]


async def suggest_wiki_recompile_for_trigger(
    session: AsyncSession,
    *,
    user_id: str,
    trigger_type: str,
    trigger_id: str,
    limit: int = 5,
) -> list[WikiRecompileSuggestion]:
    payload = await _load_trigger_payload(
        session,
        user_id=user_id,
        trigger_type=trigger_type,
        trigger_id=trigger_id,
    )
    if payload is None:
        return []

    candidates = await _find_candidate_wikis(session, user_id=user_id, payload=payload, limit=limit)
    suggestions: list[WikiRecompileSuggestion] = []
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    for wiki, score, matched_terms in candidates:
        if score < MIN_WIKI_RECOMPILE_SCORE:
            continue
        existing = await _get_existing_pending_suggestion(
            session,
            wiki_id=wiki.id,
            trigger_type=trigger_type,
            trigger_id=trigger_id,
        )
        reason = _build_reason(payload, wiki, matched_terms, score)
        metadata = {
            "score": score,
            "matched_terms": matched_terms[:20],
        }
        if existing:
            existing.reason = reason
            existing.evidence_preview = _preview(payload.text)
            existing.metadata_ = metadata
            suggestion = existing
        else:
            suggestion = WikiRecompileSuggestion(
                user_id=user_id,
                wiki_id=wiki.id,
                trigger_type=trigger_type,
                trigger_id=trigger_id,
                reason=reason,
                evidence_preview=_preview(payload.text),
                status="pending",
                metadata_=metadata,
            )
            session.add(suggestion)
        wiki.needs_recompile = True
        wiki.stale_reason = reason
        wiki.stale_triggered_at = wiki.stale_triggered_at or suggestion.created_at or now
        suggestions.append(suggestion)
    return suggestions


async def _load_trigger_payload(
    session: AsyncSession,
    *,
    user_id: str,
    trigger_type: str,
    trigger_id: str,
) -> TriggerPayload | None:
    if trigger_type == "source":
        source = await session.get(Source, trigger_id)
        if not source or source.user_id != user_id:
            return None
        return TriggerPayload(
            trigger_type=trigger_type,
            trigger_id=trigger_id,
            title=source.title,
            text="\n\n".join(part for part in [source.title, source.raw_content or ""] if part),
            source_ids=[source.id],
            note_ids=[],
        )
    if trigger_type == "note":
        note = await session.get(Note, trigger_id)
        if not note or note.user_id != user_id:
            return None
        return TriggerPayload(
            trigger_type=trigger_type,
            trigger_id=trigger_id,
            title=note.title,
            text="\n\n".join(part for part in [note.title, note.abstract or "", note.content or ""] if part),
            source_ids=note.source_ids or [],
            note_ids=[note.id],
        )
    return None


async def _find_candidate_wikis(
    session: AsyncSession,
    *,
    user_id: str,
    payload: TriggerPayload,
    limit: int,
) -> list[tuple[WikiPage, int, list[str]]]:
    stmt = select(WikiPage).where(WikiPage.user_id == user_id)
    clauses = []
    if payload.source_ids:
        clauses.append(WikiPage.derived_from_sources.overlap(payload.source_ids))
    if payload.note_ids:
        clauses.append(WikiPage.derived_from_notes.overlap(payload.note_ids))

    keywords = _keywords(payload.title + "\n" + payload.text[:4000])
    for keyword in keywords[:12]:
        pattern = f"%{_escape_like(keyword)}%"
        clauses.append(or_(WikiPage.title.ilike(pattern), WikiPage.summary.ilike(pattern)))

    if clauses:
        stmt = stmt.where(or_(*clauses))
    stmt = stmt.order_by(WikiPage.updated_at.desc()).limit(max(limit * 4, limit))
    rows = await session.execute(stmt)
    wikis = list(rows.scalars())

    scored: list[tuple[WikiPage, int, list[str]]] = []
    payload_words = set(keywords)
    for wiki in wikis:
        wiki_text = " ".join(
            [wiki.title or "", wiki.summary or "", " ".join(wiki.tags or []), " ".join(wiki.domains or [])]
        )
        wiki_words = set(_keywords(wiki_text))
        matched_terms = sorted(payload_words & wiki_words)
        score = len(matched_terms)
        if payload.source_ids and set(payload.source_ids) & set(wiki.derived_from_sources or []):
            score += 8
            matched_terms.append("shared source")
        if payload.note_ids and set(payload.note_ids) & set(wiki.derived_from_notes or []):
            score += 8
            matched_terms.append("shared note")
        if wiki.title.lower() in payload.text.lower():
            score += 5
            matched_terms.append("wiki title")
        scored.append((wiki, score, matched_terms))

    scored.sort(key=lambda item: item[1], reverse=True)
    return scored[:limit]


async def _get_existing_pending_suggestion(
    session: AsyncSession,
    *,
    wiki_id: str,
    trigger_type: str,
    trigger_id: str,
) -> WikiRecompileSuggestion | None:
    stmt = select(WikiRecompileSuggestion).where(
        WikiRecompileSuggestion.wiki_id == wiki_id,
        WikiRecompileSuggestion.trigger_type == trigger_type,
        WikiRecompileSuggestion.trigger_id == trigger_id,
        WikiRecompileSuggestion.status == "pending",
    )
    rows = await session.execute(stmt)
    return rows.scalar_one_or_none()


def _build_reason(payload: TriggerPayload, wiki: WikiPage, matched_terms: list[str], score: int) -> str:
    terms = ", ".join(matched_terms[:8]) or "related metadata"
    return (
        f"{payload.trigger_type} `{payload.title}` may update wiki `{wiki.title}` "
        f"because it shares {terms}. Relevance score: {score}."
    )


def _preview(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()[:800]


def _keywords(text: str) -> list[str]:
    words = re.findall(r"[A-Za-z][A-Za-z0-9_-]{2,}|[\u4e00-\u9fff]{2,}", text.lower())
    stop = {
        "the", "and", "for", "with", "from", "this", "that", "into", "about", "source", "memory",
        "note", "wiki", "summary", "content", "一个", "这个", "以及", "如果", "可以", "进行",
    }
    seen: set[str] = set()
    result: list[str] = []
    for word in words:
        if word in stop or word in seen:
            continue
        seen.add(word)
        result.append(word)
    return result[:80]


def _escape_like(value: str) -> str:
    return value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
