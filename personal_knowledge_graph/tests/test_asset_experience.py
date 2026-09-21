from datetime import datetime, timezone

from pkg.models.application.asset import Asset
from pkg.services.application.asset_experience import (
    EXPERIENCE_METADATA_KEY,
    apply_asset_experience,
    default_style_profile_id,
    experience_from_metadata,
    list_style_profiles,
)
from pkg.services.application.blog_generation import export_html


def _asset(*, style_profile_id: str, draft_content: str = "## Introduction\n\nHello") -> Asset:
    metadata = apply_asset_experience({}, asset_type="blog_post", style_profile_id=style_profile_id)
    return Asset(
        id="asset-1",
        user_id="user-1",
        asset_type="blog_post",
        status="draft",
        title="Styled Asset",
        brief="brief",
        draft_content=draft_content,
        source_refs=[],
        note_refs=[],
        wiki_refs=[],
        metadata_=metadata,
        created_at=datetime.now(timezone.utc),
        updated_at=datetime.now(timezone.utc),
    )


def test_style_profile_catalog_exposes_four_versioned_profiles():
    profiles = list_style_profiles()

    assert [profile["id"] for profile in profiles] == [
        "editorial_story",
        "executive_brief",
        "visual_digest",
        "knowledge_atlas",
    ]
    assert all(profile["version"] == 1 for profile in profiles)
    assert all(profile["diagram_policy"]["preferred_format"] == "mermaid" for profile in profiles)


def test_asset_type_defaults_resolve_to_expected_style_profiles():
    assert default_style_profile_id("blog_post") == "editorial_story"
    assert default_style_profile_id("research_brief") == "executive_brief"
    assert default_style_profile_id("knowledge_pack") == "knowledge_atlas"
    assert default_style_profile_id("newsletter_issue") == "visual_digest"


def test_asset_experience_snapshot_round_trips_from_metadata():
    metadata = apply_asset_experience({}, asset_type="topic_report", style_profile_id="knowledge_atlas")

    assert metadata[EXPERIENCE_METADATA_KEY]["asset_type"] == "topic_report"
    assert experience_from_metadata(metadata, asset_type="topic_report")["id"] == "knowledge_atlas"


def test_export_html_applies_style_theme_and_mermaid_runtime():
    asset = _asset(
        style_profile_id="visual_digest",
        draft_content="## Flow\n\n```mermaid\nflowchart LR\n  A --> B\n```",
    )

    rendered = export_html(asset)

    assert 'data-style-profile="visual_digest"' in rendered
    assert "--accent:#c026d3" in rendered
    assert "mermaid@11.15.0" in rendered
    assert "code.language-mermaid" in rendered
    assert 'class="asset-hero"' in rendered
    assert 'class="asset-body"' in rendered
    assert '[data-style-profile="visual_digest"] h2' in rendered


def test_export_html_profiles_have_distinct_composition_rules():
    editorial = export_html(_asset(style_profile_id="editorial_story"))
    executive = export_html(_asset(style_profile_id="executive_brief"))
    atlas = export_html(_asset(style_profile_id="knowledge_atlas"))

    assert "::first-letter" in editorial
    assert "text-transform:uppercase" in executive
    assert "counter-increment:atlas-section" in atlas
