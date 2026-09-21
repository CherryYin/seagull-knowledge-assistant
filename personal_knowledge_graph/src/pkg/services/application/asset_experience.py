from copy import deepcopy
from typing import Any


EXPERIENCE_METADATA_KEY = "asset_experience_v1"
EXPERIENCE_VERSION = 1

STYLE_PROFILES: dict[str, dict[str, Any]] = {
    "editorial_story": {
        "id": "editorial_story",
        "version": EXPERIENCE_VERSION,
        "label": "Editorial Story",
        "description": "Narrative, evidence-led editorial writing with strong openings and natural transitions.",
        "generation": {
            "narrative_mode": "editorial",
            "evidence_density": "balanced",
            "paragraph_rhythm": "varied",
            "preferred_block_roles": ["hero", "narrative", "evidence", "pull_quote", "conclusion"],
        },
        "presentation": {"theme": "editorial", "content_width": "760px", "typography": "serif", "accent": "#8b5e3c"},
        "diagram_policy": {"preferred_format": "mermaid", "default_kind": "flowchart", "max_high_level_nodes": 12},
    },
    "executive_brief": {
        "id": "executive_brief",
        "version": EXPERIENCE_VERSION,
        "label": "Executive Brief",
        "description": "Decision-first structure with compact findings, risks, and actionable recommendations.",
        "generation": {
            "narrative_mode": "decision_first",
            "evidence_density": "high",
            "paragraph_rhythm": "compact",
            "preferred_block_roles": ["executive_summary", "metric", "key_finding", "risk", "recommendation"],
        },
        "presentation": {"theme": "executive", "content_width": "920px", "typography": "sans", "accent": "#38bdf8"},
        "diagram_policy": {"preferred_format": "mermaid", "default_kind": "flowchart", "max_high_level_nodes": 12},
    },
    "visual_digest": {
        "id": "visual_digest",
        "version": EXPERIENCE_VERSION,
        "label": "Visual Digest",
        "description": "Scannable cards, numbers, concise summaries, and visual storytelling for quick reading.",
        "generation": {
            "narrative_mode": "visual_digest",
            "evidence_density": "balanced",
            "paragraph_rhythm": "short",
            "preferred_block_roles": ["hero", "metric", "feature_card", "diagram", "next_read"],
        },
        "presentation": {"theme": "digest", "content_width": "1040px", "typography": "sans", "accent": "#c026d3"},
        "diagram_policy": {"preferred_format": "mermaid", "default_kind": "flowchart", "max_high_level_nodes": 10},
    },
    "knowledge_atlas": {
        "id": "knowledge_atlas",
        "version": EXPERIENCE_VERSION,
        "label": "Knowledge Atlas",
        "description": "Concept-first structure with definitions, relationships, comparisons, and exploration paths.",
        "generation": {
            "narrative_mode": "knowledge_map",
            "evidence_density": "high",
            "paragraph_rhythm": "structured",
            "preferred_block_roles": ["definition", "concept_map", "comparison", "evidence", "open_question"],
        },
        "presentation": {"theme": "atlas", "content_width": "980px", "typography": "mono", "accent": "#15803d"},
        "diagram_policy": {"preferred_format": "mermaid", "default_kind": "flowchart", "max_high_level_nodes": 12},
    },
}

DEFAULT_STYLE_BY_ASSET_TYPE = {
    "blog_post": "editorial_story",
    "research_brief": "executive_brief",
    "knowledge_pack": "knowledge_atlas",
    "newsletter_issue": "visual_digest",
    "topic_report": "executive_brief",
}


def default_style_profile_id(asset_type: str) -> str:
    return DEFAULT_STYLE_BY_ASSET_TYPE.get(asset_type, "editorial_story")


def resolve_asset_experience(asset_type: str, style_profile_id: str | None = None) -> dict[str, Any]:
    resolved_id = style_profile_id or default_style_profile_id(asset_type)
    profile = STYLE_PROFILES.get(resolved_id)
    if profile is None:
        raise ValueError(f"Unknown Asset Style Profile: {resolved_id}")
    result = deepcopy(profile)
    result["asset_type"] = asset_type
    return result


def experience_from_metadata(metadata: dict | None, *, asset_type: str) -> dict[str, Any]:
    raw = (metadata or {}).get(EXPERIENCE_METADATA_KEY)
    if isinstance(raw, dict) and raw.get("id") in STYLE_PROFILES:
        return deepcopy(raw)
    return resolve_asset_experience(asset_type)


def apply_asset_experience(metadata: dict, *, asset_type: str, style_profile_id: str | None = None) -> dict:
    updated = deepcopy(metadata)
    updated[EXPERIENCE_METADATA_KEY] = resolve_asset_experience(asset_type, style_profile_id)
    return updated


def list_style_profiles() -> list[dict[str, Any]]:
    return [deepcopy(STYLE_PROFILES[key]) for key in STYLE_PROFILES]
