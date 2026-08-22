from datetime import datetime, timezone

from pkg.models.application.asset import Asset
from pkg.models.foundation.note import Note
from pkg.models.foundation.source import Source
from pkg.models.foundation.wiki import WikiPage
from pkg.services.application.blog_generation import GenerationContext, render_generation_context


def test_render_generation_context_groups_raw_stable_and_candidate_wiki():
    now = datetime(2026, 6, 8, tzinfo=timezone.utc)
    asset = Asset(
        id="asset-1",
        user_id="user-1",
        asset_type="blog_post",
        status="draft",
        title="Blog",
        brief="brief",
        source_refs=["src-1"],
        note_refs=["note-1"],
        wiki_refs=["wiki-stable", "wiki-draft"],
        metadata_={"opinion_notes": "take", "style_notes": "clear"},
    )
    source = Source(
        id="src-1",
        user_id="user-1",
        is_shared=False,
        category_id=1,
        title="Source 1",
        source_type="web",
        url=None,
        content_hash=None,
        raw_content="raw",
        file_path=None,
        ingested_at=now,
        metadata_={},
    )
    note = Note(
        id="note-1",
        user_id="user-1",
        category_id=1,
        title="Note 1",
        note_type="inbox",
        domains=[],
        tags=[],
        abstract="abstract",
        content="content",
        project=None,
        status="seed",
        confidence="medium",
        source_ids=[],
        file_path=None,
        word_count=None,
        expires_at=None,
        kept_at=None,
        created_at=now,
        updated_at=now,
    )
    stable_wiki = WikiPage(
        id="wiki-stable",
        user_id="user-1",
        title="Stable Wiki",
        page_type="topic",
        summary="summary",
        content="content",
        domains=[],
        tags=["wiki-stable"],
        derived_from_notes=[],
        derived_from_sources=[],
        open_questions=[],
        confidence_score=0.8,
        needs_recompile=False,
        stale_reason=None,
        stale_triggered_at=None,
        last_compiled_at=now,
        created_at=now,
        updated_at=now,
    )
    draft_wiki = WikiPage(
        id="wiki-draft",
        user_id="user-1",
        title="Draft Wiki",
        page_type="topic",
        summary="summary",
        content="content",
        domains=[],
        tags=["wiki-draft"],
        derived_from_notes=[],
        derived_from_sources=[],
        open_questions=[],
        confidence_score=0.8,
        needs_recompile=False,
        stale_reason=None,
        stale_triggered_at=None,
        last_compiled_at=now,
        created_at=now,
        updated_at=now,
    )

    context = GenerationContext(
        asset=asset,
        sources=[source],
        notes=[note],
        stable_wiki_pages=[stable_wiki],
        candidate_wiki_pages=[draft_wiki],
    )

    rendered = render_generation_context(context)

    assert "# Raw Evidence" in rendered
    assert "# Stable Wiki Context" in rendered
    assert "# Candidate Wiki Context" in rendered
    assert "## Editorial Brief" in rendered
    assert "## Author Point of View" in rendered
