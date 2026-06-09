from math import log1p

from sqlalchemy.ext.asyncio import AsyncSession

from pkg.services.foundation.discovery_profile import candidate_preference_signals

HIGH_QUALITY_DOMAINS = {
    "acm.org",
    "arxiv.org",
    "developer.mozilla.org",
    "docs.github.com",
    "github.com",
    "ieee.org",
    "nature.com",
    "openai.com",
    "pytorch.org",
    "sciencedirect.com",
    "springer.com",
    "stanford.edu",
}

LOW_QUALITY_DOMAIN_HINTS = ("medium.com", "substack.com")


async def score_candidate(session: AsyncSession, *, user_id: str, candidate: dict, profile: dict) -> tuple[float, list[str]]:
    score = float(candidate.get("base_score") or 0)
    why: list[str] = []
    payload = candidate.get("payload") or {}

    if candidate.get("source") == "trend":
        score += 20
        why.append("Recent connector trend")
    elif candidate.get("source") == "external_web_search":
        score += 16
        why.append("Imported from external web search")
    else:
        score += 8
        why.append("Recently found in connector search")
    if candidate.get("source") == "rss_article":
        score += 14
        why.append("Recent RSS article")
    if candidate.get("source") == "web_source":
        score += 10
        why.append("Recent web/article source")

    if candidate["provider"] == "github":
        stars = int(payload.get("stars") or 0)
        score += min(log1p(stars) * 3, 30)
        if stars:
            why.append(f"GitHub popularity: {stars} stars")
        if payload.get("star_growth_7d"):
            why.append(f"Growing this week: +{payload['star_growth_7d']} stars")
    if candidate["provider"] == "arxiv":
        citations = int(payload.get("citation_count") or 0)
        score += min(log1p(citations) * 4, 25)
        if citations:
            why.append(f"Citation signal: {citations} citations")
    if candidate["provider"] == "rss":
        why.append("From a followed RSS feed")
    if candidate["provider"] == "web":
        why.append("From saved web knowledge")

    credibility_score, credibility_reason = _credibility_score(candidate)
    score += credibility_score
    if credibility_reason:
        why.append(credibility_reason)

    preference_score, preference_reason = _feedback_preference_score(candidate, profile)
    score += preference_score
    if preference_reason:
        why.append(preference_reason)

    fine_grained_score, fine_grained_reasons = _fine_grained_preference_score(candidate, profile)
    score += fine_grained_score
    why.extend(fine_grained_reasons)

    matched = _profile_matches(candidate, profile)
    if matched:
        score += 18 + len(matched) * 2
        why.append("Matches profile interests: " + ", ".join(matched[:4]))

    memory_score, memory_reasons = await _memory_similarity_score(session, user_id=user_id, candidate=candidate)
    score += memory_score
    why.extend(memory_reasons)

    if not candidate.get("source_id"):
        score += 5
        why.append("Novel item not yet saved as a source")

    return round(score, 3), why[:6]


async def _memory_similarity_score(session: AsyncSession, *, user_id: str, candidate: dict) -> tuple[float, list[str]]:
    from pkg.services.foundation.discovery import retrieve_for_query

    summary = candidate_summary(candidate)
    query = candidate.get("title") or summary
    if not query:
        return 0.0, []
    try:
        matches = await retrieve_for_query(session, user_id=user_id, query=query, limit=2)
    except Exception:
        return 0.0, []
    if not matches:
        return 0.0, []
    titles = [getattr(match.node, "title", None) for match in matches if getattr(match, "node", None) is not None]
    titles = [title for title in titles if title]
    if not titles:
        return 0.5, ["Close to existing memory"]
    return 0.75, [f"Similar to memory: {titles[0]}"]


def _profile_matches(candidate: dict, profile: dict) -> list[str]:
    query_text = " ".join(
        str(part or "") for part in [candidate.get("title"), candidate_summary(candidate), candidate_url(candidate)]
    ).lower()
    reasons: list[str] = []
    for raw_interest in profile.get("interests") or []:
        if isinstance(raw_interest, dict):
            values = [raw_interest.get("domain"), raw_interest.get("recent_focus"), raw_interest.get("topic")]
        else:
            values = [raw_interest]
        for value in values:
            interest = str(value or "").strip().lower()
            if interest and interest in query_text:
                reasons.append(interest)
    goals = [str(value).strip().lower() for value in profile.get("active_goals") or [] if str(value).strip()]
    for goal in goals[:2]:
        if goal and goal in query_text:
            reasons.append(goal)
    return list(dict.fromkeys(reasons))[:4]


def _credibility_score(candidate: dict) -> tuple[float, str | None]:
    payload = candidate.get("payload") or {}
    provider = candidate.get("provider")
    score = 0.0
    reason = None
    if provider == "web":
        domain = _domain_from_url(candidate_url(candidate) or "")
        if _is_high_quality_domain(domain):
            score += 2.5
            reason = f"Trusted domain ({domain})"
        elif domain:
            score += 0.75
            reason = f"HTTPS source ({domain})"
        if any(hint in domain for hint in LOW_QUALITY_DOMAIN_HINTS):
            score -= 0.75
    elif provider in {"openalex", "crossref", "semantic_scholar"}:
        citations = float(payload.get("citation_count") or 0)
        score += 2.0 + min(log1p(citations), 4.0)
        reason = f"Cited paper ({int(citations)} citations)" if citations >= 10 else "Paper indexed by academic provider"
    return score, reason


def _feedback_preference_score(candidate: dict, profile: dict) -> tuple[float, str | None]:
    feedback = dict(profile.get("discovery_feedback") or {})
    provider_feedback = dict(feedback.get(candidate.get("provider")) or {})
    keeps = int(provider_feedback.get("keep") or 0) + int(provider_feedback.get("save") or 0)
    dismisses = int(provider_feedback.get("dismiss") or 0)
    delta = keeps - dismisses
    if delta > 0:
        score = min(delta * 2.0, 10.0)
        return score, "Boosted by your keep/save history"
    if delta < 0:
        score = max(delta * 2.0, -10.0)
        return score, "Downranked by your dismiss history"
    return 0.0, None


def _fine_grained_preference_score(candidate: dict, profile: dict) -> tuple[float, list[str]]:
    preferences = profile.get("discovery_preferences") if isinstance(profile.get("discovery_preferences"), dict) else {}
    score = 0.0
    reasons: list[str] = []
    for group, values in candidate_preference_signals(candidate).items():
        group_prefs = preferences.get(group) if isinstance(preferences.get(group), dict) else {}
        for value in values[:8]:
            stats = group_prefs.get(value) if isinstance(group_prefs.get(value), dict) else {}
            delta = int(stats.get("keep") or 0) + int(stats.get("save") or 0) - int(stats.get("dismiss") or 0)
            label = group[:-1] if group.endswith("s") else group
            if delta > 0:
                score += min(delta * 1.5, 6.0)
                reasons.append(f"Matches kept {label}: {value}")
            elif delta < 0:
                score -= min(abs(delta) * 1.5, 6.0)
                reasons.append(f"Downranked dismissed {label}: {value}")
    return score, list(dict.fromkeys(reasons))[:2]


def candidate_url(candidate: dict) -> str | None:
    payload = candidate.get("payload") or {}
    return payload.get("html_url") or payload.get("entry_url") or payload.get("url")


def candidate_summary(candidate: dict) -> str | None:
    payload = candidate.get("payload") or {}
    summary = payload.get("abstract") or payload.get("description") or payload.get("summary") or payload.get("raw_content")
    if isinstance(summary, str) and len(summary) > 700:
        return summary[:700].rstrip() + "…"
    return summary


def _domain_from_url(url: str) -> str:
    from urllib.parse import urlparse

    if not url:
        return ""
    parsed = urlparse(url if "://" in url else f"https://{url}")
    host = (parsed.netloc or "").lower().split("@")[ -1].split(":")[0]
    return host[4:] if host.startswith("www.") else host


def _is_high_quality_domain(domain: str) -> bool:
    if not domain:
        return False
    return any(domain == trusted or domain.endswith(f".{trusted}") for trusted in HIGH_QUALITY_DOMAINS)
