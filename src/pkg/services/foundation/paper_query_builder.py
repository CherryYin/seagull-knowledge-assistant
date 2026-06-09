import re

from pkg.models.paper_discovery import PaperDiscoveryProfile
from pkg.schemas.paper_discovery import PaperQueryBundle, PaperQuerySpec


_SEPARATORS = ["，", ",", "；", ";", "、", " and ", " or ", " vs ", " versus "]
_STOPWORDS = {"the", "a", "an", "of", "for", "to", "and", "or", "with", "in", "on", "by"}


def _normalize_text(value: str | None) -> str:
    return " ".join((value or "").split()).strip()


def _normalize_list(values: list | None) -> list[str]:
    normalized: list[str] = []
    for value in values or []:
        item = _normalize_text(str(value))
        if item and item not in normalized:
            normalized.append(item)
    return normalized


def _extract_goal_terms(goal_prompt: str | None, *, max_terms: int = 8) -> list[str]:
    normalized = _normalize_text(goal_prompt)
    if not normalized:
        return []

    fragments = [normalized]
    for separator in _SEPARATORS:
        next_fragments: list[str] = []
        for fragment in fragments:
            next_fragments.extend(part.strip() for part in fragment.split(separator) if part.strip())
        fragments = next_fragments or fragments

    candidates: list[str] = []
    for fragment in fragments:
        cleaned = fragment.strip("：:,.，。！？!?()[]（）【】\"'")
        if cleaned and cleaned not in candidates:
            candidates.append(cleaned)

    if len(candidates) < max_terms:
        tokens = [token.strip("：:,.，。！？!?()[]（）【】\"'") for token in normalized.split()]
        keywords = [token for token in tokens if len(token) >= 3 and token.lower() not in _STOPWORDS]
        for keyword in keywords:
            if keyword not in candidates:
                candidates.append(keyword)
            if len(candidates) >= max_terms:
                break
    return candidates[:max_terms]


def _build_base_terms(profile: PaperDiscoveryProfile) -> list[str]:
    explicit_terms = _normalize_list(profile.include_terms)
    goal_terms = _extract_goal_terms(profile.goal_prompt)
    combined: list[str] = []
    for term in [*explicit_terms, *goal_terms]:
        if term and term not in combined:
            combined.append(term)
    return combined


def _build_negative_terms(profile: PaperDiscoveryProfile) -> list[str]:
    return _normalize_list(profile.exclude_terms)


def _build_date_filters(profile: PaperDiscoveryProfile) -> dict:
    if not profile.time_window_days:
        return {}
    return {"time_window_days": profile.time_window_days}


def _build_query_text(*, terms: list[str], negative_terms: list[str], authors: list[str], venues: list[str], fields: list[str]) -> str:
    parts: list[str] = []
    if terms:
        if len(terms) == 1:
            parts.append(terms[0])
        else:
            parts.append(" AND ".join(f'({term})' if " " in term else term for term in terms))
    for author in authors:
        parts.append(f'author:"{author}"')
    for venue in venues:
        parts.append(f'venue:"{venue}"')
    for field in fields:
        parts.append(f'field:"{field}"')
    for term in negative_terms:
        parts.append(f'-{term}' if " " not in term else f'-"{term}"')
    return " ".join(parts).strip()


def _build_expanded_variants(base_terms: list[str]) -> list[list[str]]:
    variants: list[list[str]] = []
    if len(base_terms) >= 2:
        variants.append(base_terms[:2])
    if len(base_terms) >= 3:
        variants.append(base_terms[:3])
    for term in base_terms:
        variants.append([term])

    deduped: list[list[str]] = []
    seen: set[tuple[str, ...]] = set()
    for variant in variants:
        key = tuple(variant)
        if variant and key not in seen:
            seen.add(key)
            deduped.append(variant)
    return deduped


def build_paper_query_bundle(profile: PaperDiscoveryProfile) -> PaperQueryBundle:
    base_terms = _build_base_terms(profile)
    negative_terms = _build_negative_terms(profile)
    authors = _normalize_list(profile.preferred_authors)
    venues = _normalize_list(profile.preferred_venues)
    fields = _normalize_list(profile.preferred_fields)
    date_filters = _build_date_filters(profile)

    primary_query = _build_query_text(
        terms=base_terms,
        negative_terms=negative_terms,
        authors=authors,
        venues=venues,
        fields=fields,
    )

    bundle = PaperQueryBundle(
        profile_name=profile.name,
        mode=profile.mode,
        provider=profile.provider,
        negative_terms=negative_terms,
        author_filters=authors,
        field_filters=fields,
        venue_filters=venues,
        date_filters=date_filters,
    )

    if primary_query:
        bundle.primary_queries.append(
            PaperQuerySpec(
                label="primary",
                query=primary_query,
                provider=profile.provider,
                rationale="Combined query from explicit profile terms and goal prompt.",
                filters=date_filters,
            )
        )

    for index, terms in enumerate(_build_expanded_variants(base_terms), start=1):
        query = _build_query_text(
            terms=terms,
            negative_terms=negative_terms,
            authors=authors,
            venues=venues,
            fields=fields,
        )
        if not query:
            continue
        if bundle.primary_queries and query == bundle.primary_queries[0].query:
            continue
        bundle.expanded_queries.append(
            PaperQuerySpec(
                label=f"expanded_{index}",
                query=query,
                provider=profile.provider,
                rationale=f"Variant focused on {', '.join(terms)}.",
                filters=date_filters,
            )
        )

    if profile.mode in {"trend", "hybrid"} and base_terms:
        trend_seed = base_terms[:2] if len(base_terms) >= 2 else base_terms
        trend_query = " ".join(trend_seed + ["trend", "emerging"]).strip()
        bundle.trend_queries.append(
            PaperQuerySpec(
                label="trend_seed",
                query=trend_query,
                provider=profile.provider,
                rationale="Seed query for trend expansion around the main topic.",
                filters=date_filters,
            )
        )

    return bundle
