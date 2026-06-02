from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from pkg.models.memory import MemoryNode
from pkg.models.review import ReviewSuggestion
from pkg.models.user import UserMemory
from pkg.services.user_profiler import PROFILE_MEMORY_KEY

LOW_CONFIDENCE_FACT_THRESHOLD = 0.55


def _utc_now_naive() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


async def ensure_phase_b_review_suggestions(
    session: AsyncSession,
    *,
    user_id: str,
    include_low_confidence_facts: bool = True,
    include_profile_suggestions: bool = True,
    limit: int = 50,
) -> tuple[int, int]:
    created = 0
    skipped = 0
    remaining = limit

    if include_low_confidence_facts and remaining > 0:
        made, missed = await _ensure_low_confidence_fact_suggestions(session, user_id=user_id, limit=remaining)
        created += made
        skipped += missed
        remaining -= made

    if include_profile_suggestions and remaining > 0:
        made, missed = await _ensure_profile_suggestions(session, user_id=user_id, limit=remaining)
        created += made
        skipped += missed

    await session.commit()
    return created, skipped


async def apply_review_suggestion(session: AsyncSession, suggestion: ReviewSuggestion) -> None:
    if suggestion.suggestion_type == "low_confidence_fact":
        node = await session.get(MemoryNode, suggestion.target_id)
        if node and node.user_id == suggestion.user_id:
            metadata = dict(node.metadata_ or {})
            metadata["status"] = "active"
            metadata["low_confidence_reviewed_at"] = _utc_now_naive().isoformat()
            node.metadata_ = metadata
            if node.confidence_score is None or node.confidence_score < LOW_CONFIDENCE_FACT_THRESHOLD:
                node.confidence_score = LOW_CONFIDENCE_FACT_THRESHOLD
    elif suggestion.suggestion_type == "profile_update":
        profile = await _get_profile_memory(session, suggestion.user_id)
        if profile:
            current = dict(profile.value or {})
            current.setdefault("_reviewed_suggestions", [])
            current["_reviewed_suggestions"].append(suggestion.proposed_value or {})
            current["_last_profile_suggestion_applied_at"] = _utc_now_naive().isoformat()
            profile.value = current


async def _ensure_low_confidence_fact_suggestions(
    session: AsyncSession,
    *,
    user_id: str,
    limit: int,
) -> tuple[int, int]:
    rows = await session.execute(
        select(MemoryNode)
        .where(MemoryNode.user_id == user_id)
        .where(MemoryNode.confidence_score.is_not(None))
        .where(MemoryNode.confidence_score < LOW_CONFIDENCE_FACT_THRESHOLD)
        .order_by(MemoryNode.confidence_score.asc(), MemoryNode.updated_at.desc())
        .limit(limit)
    )
    created = 0
    skipped = 0
    for node in rows.scalars():
        metadata = node.metadata_ or {}
        if metadata.get("status") in {"archived", "rejected", "merged"}:
            skipped += 1
            continue
        existing = await _has_open_suggestion(
            session,
            user_id=user_id,
            suggestion_type="low_confidence_fact",
            target_type="memory_node",
            target_id=node.id,
        )
        if existing:
            skipped += 1
            continue
        session.add(
            ReviewSuggestion(
                user_id=user_id,
                suggestion_type="low_confidence_fact",
                target_type="memory_node",
                target_id=node.id,
                title=f"Review low-confidence memory: {node.title}",
                summary=node.summary or node.content[:500],
                proposed_value={"action": "confirm_memory", "confidence_score": LOW_CONFIDENCE_FACT_THRESHOLD},
                evidence={
                    "memory_node_id": node.id,
                    "node_type": node.node_type,
                    "level": node.level,
                    "confidence_score": node.confidence_score,
                    "derived_from_notes": node.derived_from_notes or [],
                    "derived_from_sources": node.derived_from_sources or [],
                },
                metadata_={"source": "memory_confidence_scan", "threshold": LOW_CONFIDENCE_FACT_THRESHOLD},
            )
        )
        created += 1
    return created, skipped


async def _ensure_profile_suggestions(
    session: AsyncSession,
    *,
    user_id: str,
    limit: int,
) -> tuple[int, int]:
    profile = await _get_profile_memory(session, user_id)
    if not profile:
        return 0, 0

    existing = await _has_open_suggestion(
        session,
        user_id=user_id,
        suggestion_type="profile_update",
        target_type="user_profile",
        target_id=PROFILE_MEMORY_KEY,
    )
    if existing:
        return 0, 1

    value = profile.value or {}
    suggestions = _profile_candidates(value)[:limit]
    if suggestions:
        session.add(
            ReviewSuggestion(
                user_id=user_id,
                suggestion_type="profile_update",
                target_type="user_profile",
                target_id=PROFILE_MEMORY_KEY,
                title="Review generated user profile quality",
                summary="; ".join(candidate["summary"] for candidate in suggestions),
                proposed_value={"suggestions": [candidate["proposed_value"] for candidate in suggestions]},
                evidence={"profile_key": PROFILE_MEMORY_KEY, "generated_at": value.get("_generated_at")},
                metadata_={"source": "profile_quality_scan", "suggestion_count": len(suggestions)},
            )
        )
    return 1 if suggestions else 0, 0 if suggestions else 1


async def _get_profile_memory(session: AsyncSession, user_id: str) -> UserMemory | None:
    row = await session.execute(select(UserMemory).where(UserMemory.user_id == user_id, UserMemory.key == PROFILE_MEMORY_KEY))
    return row.scalar_one_or_none()


async def _has_open_suggestion(
    session: AsyncSession,
    *,
    user_id: str,
    suggestion_type: str,
    target_type: str,
    target_id: str,
) -> bool:
    row = await session.execute(
        select(ReviewSuggestion.id)
        .where(ReviewSuggestion.user_id == user_id)
        .where(ReviewSuggestion.suggestion_type == suggestion_type)
        .where(ReviewSuggestion.target_type == target_type)
        .where(ReviewSuggestion.target_id == target_id)
        .where(ReviewSuggestion.status.in_(["pending", "accepted"]))
        .limit(1)
    )
    return row.scalar_one_or_none() is not None


def _profile_candidates(profile: dict) -> list[dict]:
    candidates: list[dict] = []
    interests = profile.get("interests") if isinstance(profile.get("interests"), list) else []
    if not interests:
        candidates.append({
            "title": "Review missing profile interests",
            "summary": "The generated user profile has no explicit interests. Add or regenerate interests before using it for personalization.",
            "proposed_value": {"field": "interests", "issue": "missing", "suggested_action": "regenerate_or_edit_profile"},
        })
    behavior = profile.get("behavior") if isinstance(profile.get("behavior"), dict) else {}
    if not behavior.get("primary_usage"):
        candidates.append({
            "title": "Review missing primary usage",
            "summary": "The profile is missing primary_usage, which weakens discovery and agent personalization.",
            "proposed_value": {"field": "behavior.primary_usage", "issue": "missing", "suggested_action": "confirm_primary_usage"},
        })
    summary = profile.get("summary")
    if not summary or len(str(summary).strip()) < 12:
        candidates.append({
            "title": "Review weak profile summary",
            "summary": "The profile summary is empty or too short to be useful as durable context.",
            "proposed_value": {"field": "summary", "issue": "weak", "suggested_action": "rewrite_summary"},
        })
    return candidates
