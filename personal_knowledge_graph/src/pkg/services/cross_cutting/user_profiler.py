"""User profiler — automatically generates user profiles from usage patterns.

Analyzes activity logs, notes, and sources to build a structured user profile
containing interests, knowledge levels, and behavioral preferences.
Stores the result in UserMemory for injection into the agent system prompt.
"""
import json
import logging
from collections import Counter
from datetime import datetime, timedelta, timezone

from sqlalchemy import select

from pkg.db import async_session
from pkg.models.chat_session import ChatSession
from pkg.models.foundation.note import Note
from pkg.models.foundation.source import Source
from pkg.models.user import ActivityLog, User, UserMemory

PRODUCTION_MEMORY_KEY = "production_memory"

logger = logging.getLogger(__name__)

PROFILE_MEMORY_KEY = "user_profile"
ACTIVITY_PROFILE_MEMORY_TYPE = "activity_profile"
EXPLICIT_PROFILE_MEMORY_TYPE = "profile"
EXPLICIT_PREFERENCE_MEMORY_TYPE = "preference"


def classify_user_memory_type(key: str, value: dict | None = None) -> str:
    normalized_key = (key or "").strip().lower()
    payload = value if isinstance(value, dict) else {}

    if normalized_key == PROFILE_MEMORY_KEY:
        return ACTIVITY_PROFILE_MEMORY_TYPE

    preference_markers = {
        "preference",
        "preferences",
        "setting",
        "settings",
        "style",
        "tone",
    }
    if any(marker in normalized_key for marker in preference_markers):
        return EXPLICIT_PREFERENCE_MEMORY_TYPE

    if any(marker in payload for marker in ["discovery_preferences", "writing_preferences", "interaction_preferences"]):
        return EXPLICIT_PREFERENCE_MEMORY_TYPE

    profile_markers = {
        "profile",
        "identity",
        "about_me",
        "about-me",
        "bio",
    }
    if any(marker in normalized_key for marker in profile_markers):
        return EXPLICIT_PROFILE_MEMORY_TYPE

    return EXPLICIT_PROFILE_MEMORY_TYPE


def _utc_now_naive() -> datetime:
    """Return UTC now matching the project's timestamp-without-timezone columns."""
    return datetime.now(timezone.utc).replace(tzinfo=None)

_PROFILE_SYSTEM_PROMPT = """\
你是一个用户行为分析师。根据以下用户的使用数据，生成一份结构化的用户画像。

请严格输出如下 JSON 格式（不要包含 markdown 代码块标记）：
{
  "interests": [
    {"domain": "领域名称", "depth": "beginner|intermediate|advanced", "recent_focus": "最近关注的具体方向"}
  ],
  "knowledge_level": {
    "领域名称": "beginner|intermediate|advanced"
  },
  "behavior": {
    "primary_usage": "用户主要使用场景（如 deep_research/quick_qa/note_taking/learning）",
    "active_hours": "活跃时间段（如 morning/afternoon/evening/night）",
    "content_preference": "偏好的内容形式描述",
    "interaction_style": "交互风格描述"
  },
  "summary": "一句话总结用户特征"
}

分析要点：
1. 从搜索词和对话主题推断兴趣领域
2. 从笔记类型和标签分布判断知识深度
3. 从资料类型判断学习偏好
4. 从活动时间判断使用习惯
5. 如果数据不足以判断某个维度，使用合理的默认值而不是留空
"""


async def generate_user_profile(user_id: str) -> dict | None:
    """Generate a user profile from usage patterns and store in UserMemory.

    Returns the profile dict on success, or None if insufficient data.
    """
    # 1. Collect data
    activities = await _get_recent_activities(user_id, days=30)
    note_stats = await _get_note_stats(user_id)
    source_stats = await _get_source_stats(user_id)
    chat_stats = await _get_chat_stats(user_id, days=30)
    production_summary = await _get_production_memory_summary(user_id)

    # Check if we have enough data to generate a meaningful profile
    total_signals = (
        len(activities.get("search_queries", []))
        + len(activities.get("chat_topics", []))
        + note_stats.get("total", 0)
        + source_stats.get("total", 0)
        + production_summary.get("total_events", 0)
    )
    if total_signals < 3:
        logger.info("User %s has insufficient data (%d signals) for profiling", user_id, total_signals)
        return None

    # 2. Format aggregated data as text for LLM
    summary_text = _format_activity_summary(
        activities,
        note_stats,
        source_stats,
        chat_stats,
        production_summary=production_summary,
    )

    # 3. Call LLM
    profile = await _llm_generate_profile(summary_text)
    if not profile:
        return None

    profile["_explanations"] = _build_profile_explanations(
        activities,
        note_stats,
        source_stats,
        chat_stats,
        production_summary,
        profile,
    )

    # 4. Store in UserMemory
    await _upsert_user_memory(user_id, PROFILE_MEMORY_KEY, profile)

    logger.info("Generated user profile for %s", user_id)
    return profile


async def profile_all_users() -> int:
    """Generate profiles for all active users. Returns count of profiles generated."""
    async with async_session() as session:
        result = await session.execute(
            select(User.id).where(User.is_active.is_(True))
        )
        user_ids = [row[0] for row in result]

    count = 0
    for user_id in user_ids:
        try:
            profile = await generate_user_profile(user_id)
            if profile:
                count += 1
        except Exception:
            logger.exception("Failed to generate profile for user %s", user_id)

    logger.info("Profiled %d / %d active users", count, len(user_ids))
    return count


# ---------------------------------------------------------------------------
# Data collection helpers
# ---------------------------------------------------------------------------

async def _get_recent_activities(user_id: str, days: int = 30) -> dict:
    """Collect recent activity logs grouped by type."""
    cutoff = _utc_now_naive() - timedelta(days=days)

    async with async_session() as session:
        stmt = (
            select(ActivityLog)
            .where(ActivityLog.user_id == user_id, ActivityLog.created_at >= cutoff)
            .order_by(ActivityLog.created_at.desc())
            .limit(200)
        )
        result = await session.execute(stmt)
        logs = list(result.scalars())

    search_queries: list[str] = []
    chat_topics: list[str] = []
    hours: list[int] = []

    for log in logs:
        hours.append(log.created_at.hour if log.created_at else 12)
        detail = log.detail or {}
        if log.action == "search":
            query = detail.get("query", "")
            if query:
                search_queries.append(query)
        elif log.action == "chat":
            task = detail.get("task", "")
            if task:
                chat_topics.append(task[:100])

    # Determine active hours bucket
    hour_counter = Counter(hours)
    if hour_counter:
        peak_hour = hour_counter.most_common(1)[0][0]
        if 5 <= peak_hour < 12:
            active_period = "morning"
        elif 12 <= peak_hour < 17:
            active_period = "afternoon"
        elif 17 <= peak_hour < 21:
            active_period = "evening"
        else:
            active_period = "night"
    else:
        active_period = "unknown"

    return {
        "search_queries": search_queries[:50],
        "chat_topics": chat_topics[:50],
        "active_period": active_period,
        "total_activities": len(logs),
    }


async def _get_note_stats(user_id: str) -> dict:
    """Get aggregated stats about user's notes."""
    async with async_session() as session:
        stmt = select(Note).where(Note.user_id == user_id)
        result = await session.execute(stmt)
        notes = list(result.scalars())

    if not notes:
        return {"total": 0, "domains": {}, "tags": {}, "types": {}}

    domain_counter: Counter = Counter()
    tag_counter: Counter = Counter()
    type_counter: Counter = Counter()

    for note in notes:
        type_counter[note.note_type] += 1
        for d in (note.domains or []):
            domain_counter[d] += 1
        for t in (note.tags or []):
            tag_counter[t] += 1

    return {
        "total": len(notes),
        "domains": dict(domain_counter.most_common(10)),
        "tags": dict(tag_counter.most_common(15)),
        "types": dict(type_counter),
    }


async def _get_source_stats(user_id: str) -> dict:
    """Get aggregated stats about user's sources."""
    async with async_session() as session:
        stmt = select(Source).where(Source.user_id == user_id)
        result = await session.execute(stmt)
        sources = list(result.scalars())

    if not sources:
        return {"total": 0, "types": {}, "titles": []}

    type_counter: Counter = Counter()
    titles: list[str] = []

    for src in sources:
        type_counter[src.source_type] += 1
        titles.append(src.title)

    return {
        "total": len(sources),
        "types": dict(type_counter),
        "titles": titles[:20],
    }


async def _get_chat_stats(user_id: str, days: int = 30) -> dict:
    """Get recent chat session titles and frequency."""
    cutoff = _utc_now_naive() - timedelta(days=days)

    async with async_session() as session:
        stmt = (
            select(ChatSession)
            .where(ChatSession.user_id == user_id, ChatSession.updated_at >= cutoff)
            .order_by(ChatSession.updated_at.desc())
            .limit(50)
        )
        result = await session.execute(stmt)
        sessions = list(result.scalars())

    return {
        "total": len(sessions),
        "titles": [s.title for s in sessions if s.title and s.title != "New Session"],
    }


async def _get_production_memory_summary(user_id: str) -> dict:
    async with async_session() as session:
        result = await session.execute(
            select(UserMemory).where(UserMemory.user_id == user_id, UserMemory.key == PRODUCTION_MEMORY_KEY)
        )
        memory = result.scalar_one_or_none()

    value = dict((memory.value or {}) if memory else {})
    events = list(value.get("events") or [])
    if not events:
        return {"total_events": 0, "event_types": {}, "asset_types": {}, "recent_titles": [], "channels": []}

    event_counter: Counter = Counter()
    asset_type_counter: Counter = Counter()
    recent_titles: list[str] = []
    channels: list[str] = []

    for event in events[:20]:
        if not isinstance(event, dict):
            continue
        event_type = str(event.get("event_type") or "unknown")
        asset_type = str(event.get("asset_type") or "unknown")
        title = str(event.get("title") or "").strip()
        detail = event.get("detail") or {}
        channel = str((detail or {}).get("channel") or "").strip() if isinstance(detail, dict) else ""

        event_counter[event_type] += 1
        asset_type_counter[asset_type] += 1
        if title and title not in recent_titles:
          recent_titles.append(title)
        if channel and channel not in channels:
          channels.append(channel)

    return {
        "total_events": len(events),
        "event_types": dict(event_counter),
        "asset_types": dict(asset_type_counter),
        "recent_titles": recent_titles[:8],
        "channels": channels[:8],
    }


# ---------------------------------------------------------------------------
# Formatting and LLM
# ---------------------------------------------------------------------------

def _format_activity_summary(
    activities: dict,
    note_stats: dict,
    source_stats: dict,
    chat_stats: dict,
    *,
    production_summary: dict | None = None,
) -> str:
    """Format collected data into a text summary for the LLM."""
    parts: list[str] = []

    parts.append("## 活动概览")
    parts.append(f"- 最近30天总活动数: {activities['total_activities']}")
    parts.append(f"- 活跃时间段: {activities['active_period']}")

    production_summary = production_summary or {}
    if production_summary.get("total_events", 0) > 0:
        parts.append(f"\n## Production Memory（共 {production_summary['total_events']} 条事件）")
        if production_summary.get("event_types"):
            parts.append(f"- 事件类型分布: {production_summary['event_types']}")
        if production_summary.get("asset_types"):
            parts.append(f"- 资产类型分布: {production_summary['asset_types']}")
        if production_summary.get("channels"):
            parts.append(f"- 发布/导出渠道: {production_summary['channels']}")
        if production_summary.get("recent_titles"):
            parts.append("- 最近涉及的资产:")
            for title in production_summary["recent_titles"][:5]:
                parts.append(f"  - {title}")

    if activities["search_queries"]:
        parts.append("\n## 搜索记录（最近）")
        for q in activities["search_queries"][:20]:
            parts.append(f"- {q}")

    if activities["chat_topics"]:
        parts.append("\n## 对话主题（最近）")
        for t in activities["chat_topics"][:20]:
            parts.append(f"- {t}")

    if chat_stats["titles"]:
        parts.append("\n## 对话会话标题")
        for title in chat_stats["titles"][:15]:
            parts.append(f"- {title}")

    if note_stats["total"] > 0:
        parts.append(f"\n## 笔记统计（共 {note_stats['total']} 条）")
        if note_stats["domains"]:
            parts.append(f"- 领域分布: {note_stats['domains']}")
        if note_stats["tags"]:
            parts.append(f"- 标签分布: {note_stats['tags']}")
        if note_stats["types"]:
            parts.append(f"- 类型分布: {note_stats['types']}")

    if source_stats["total"] > 0:
        parts.append(f"\n## 资料统计（共 {source_stats['total']} 条）")
        if source_stats["types"]:
            parts.append(f"- 类型分布: {source_stats['types']}")
        if source_stats["titles"]:
            parts.append("- 资料标题（部分）:")
            for title in source_stats["titles"][:10]:
                parts.append(f"  - {title}")

    return "\n".join(parts)


def _build_profile_explanations(
    activities: dict,
    note_stats: dict,
    source_stats: dict,
    chat_stats: dict,
    production_summary: dict,
    profile: dict | None = None,
) -> dict:
    top_searches = activities.get("search_queries", [])[:5]
    top_topics = activities.get("chat_topics", [])[:5]
    top_domains = list((note_stats.get("domains") or {}).keys())[:5]
    top_note_types = list((note_stats.get("types") or {}).keys())[:5]
    top_source_types = list((source_stats.get("types") or {}).keys())[:5]
    top_production_events = list((production_summary.get("event_types") or {}).keys())[:5]
    top_production_asset_types = list((production_summary.get("asset_types") or {}).keys())[:5]
    top_production_channels = list((production_summary.get("channels") or []))[:5]

    profile = profile or {}
    interest_entries = []
    for item in profile.get("interests") or []:
        domain = str(item.get("domain") or "").strip()
        if not domain:
            continue
        interest_entries.append({
            "value": domain,
            "signals": [
                *([f"note_domain:{domain}"] if domain in (note_stats.get("domains") or {}) else []),
                *[f"search:{query}" for query in top_searches[:2]],
                *[f"chat:{topic}" for topic in top_topics[:2]],
            ],
            "reason": f"{domain} 这个兴趣主要参考笔记领域分布、搜索词和近期对话主题。",
        })

    knowledge_entries = []
    for domain, depth in (profile.get("knowledge_level") or {}).items():
        knowledge_entries.append({
            "value": f"{domain}:{depth}",
            "signals": [
                *([f"note_domain:{domain}"] if domain in (note_stats.get("domains") or {}) else []),
                *[f"note_type:{note_type}" for note_type in top_note_types[:3]],
            ],
            "reason": f"{domain} 的知识深度结合领域覆盖与笔记类型进行估计。",
        })

    behavior_entries = []
    for key, value in (profile.get("behavior") or {}).items():
        behavior_entries.append({
            "value": f"{key}:{value}",
            "signals": [
                f"active_period:{activities.get('active_period', 'unknown')}",
                *[f"source_type:{source_type}" for source_type in top_source_types[:3]],
                *[f"chat_title:{title}" for title in (chat_stats.get("titles") or [])[:2]],
            ],
            "reason": f"{key} 主要依据活跃时间、资料类型和最近对话模式推断。",
        })

    return {
        "summary": {
            "signals": [
                *[f"search:{query}" for query in top_searches[:3]],
                *[f"chat:{topic}" for topic in top_topics[:3]],
                *[f"production_event:{event_type}" for event_type in top_production_events[:2]],
            ],
            "reason": "综合最近搜索、对话主题与内容积累生成整体画像。",
        },
        "interests": {
            "signals": [
                *[f"note_domain:{domain}" for domain in top_domains[:5]],
                *[f"search:{query}" for query in top_searches[:3]],
            ],
            "reason": "兴趣领域主要来自笔记领域分布与高频搜索主题。",
            "items": interest_entries,
        },
        "knowledge_level": {
            "signals": [
                *[f"note_type:{note_type}" for note_type in top_note_types[:5]],
                *[f"note_domain:{domain}" for domain in top_domains[:5]],
            ],
            "reason": "知识深度主要根据笔记规模、领域覆盖和笔记类型推断。",
            "items": knowledge_entries,
        },
        "behavior": {
            "signals": [
                f"active_period:{activities.get('active_period', 'unknown')}",
                *[f"source_type:{source_type}" for source_type in top_source_types[:5]],
                *[f"chat_title:{title}" for title in (chat_stats.get("titles") or [])[:3]],
                *[f"production_asset_type:{asset_type}" for asset_type in top_production_asset_types[:3]],
                *[f"production_channel:{channel}" for channel in top_production_channels[:3]],
            ],
            "reason": "行为偏好来自活跃时间、资料类型、最近对话工作方式，以及近期生产/发布行为。",
            "items": behavior_entries,
        },
    }


async def _llm_generate_profile(summary_text: str) -> dict | None:
    """Call LLM to generate structured profile JSON from activity summary."""
    from pkg.services.cross_cutting.llm import create_async_client
    client, model = create_async_client()

    try:
        response = await client.chat.completions.create(
            model=model,
            messages=[
                {"role": "system", "content": _PROFILE_SYSTEM_PROMPT},
                {"role": "user", "content": summary_text},
            ],
            temperature=0.3,
        )
        raw = response.choices[0].message.content or ""
    except Exception:
        logger.exception("LLM profile generation failed")
        return None

    # Parse JSON from response (strip markdown code fences if present)
    raw = raw.strip()
    if raw.startswith("```"):
        raw = raw.split("\n", 1)[1] if "\n" in raw else raw[3:]
        if raw.endswith("```"):
            raw = raw[:-3]
        raw = raw.strip()

    try:
        profile = json.loads(raw)
    except json.JSONDecodeError:
        logger.warning("Failed to parse profile JSON: %s", raw[:200])
        return None

    # Add metadata
    profile["_generated_at"] = datetime.now(timezone.utc).isoformat()

    return profile


# ---------------------------------------------------------------------------
# Storage
# ---------------------------------------------------------------------------

async def _upsert_user_memory(user_id: str, key: str, value: dict) -> None:
    """Upsert a UserMemory entry."""
    async with async_session() as session:
        result = await session.execute(
            select(UserMemory).where(UserMemory.user_id == user_id, UserMemory.key == key)
        )
        mem = result.scalar_one_or_none()
        if mem:
            mem.memory_type = classify_user_memory_type(key, value)
            mem.value = value
        else:
            mem = UserMemory(
                user_id=user_id,
                key=key,
                memory_type=classify_user_memory_type(key, value),
                value=value,
            )
            session.add(mem)
        await session.commit()
