from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import HTTPException

class TestCreateWikiPage:
    def test_success(self, client, fake_user):
        wiki = _make_wiki("wiki-1", fake_user.id)
        wiki.derived_from_sources = ["src-1"]

        with patch("pkg.api.wiki.persist_wiki_page", new=AsyncMock(return_value=wiki)) as persist:
            resp = client.post(
                "/wiki",
                json={
                    "title": "Personal Knowledge Graph",
                    "page_type": "topic",
                    "summary": "PKG overview",
                    "content": "# Personal Knowledge Graph\n\nCurrent understanding.",
                    "derived_from_sources": ["src-1"],
                },
            )

        assert resp.status_code == 201
        assert resp.json()["derived_from_sources"] == ["src-1"]
        persist.assert_awaited_once()


class TestGetWikiPage:
    def test_success(self, client, mock_session, fake_user):
        wiki = _make_wiki("wiki-1", fake_user.id)
        mock_session.get.return_value = wiki

        resp = client.get("/wiki/wiki-1")

        assert resp.status_code == 200

    def test_not_found_for_other_user(self, client, mock_session):
        wiki = _make_wiki("wiki-1", "other-user")
        mock_session.get.return_value = wiki

        resp = client.get("/wiki/wiki-1")

        assert resp.status_code == 404


class TestCloneWikiDraft:
    @pytest.mark.asyncio
    async def test_clone_stable_wiki_as_draft(self, mock_session, fake_user):
        from pkg.api.wiki import clone_wiki_page_as_draft
        from pkg.schemas.wiki import WikiCloneDraftRequest

        wiki = _make_wiki("wiki-1", fake_user.id)
        wiki.tags = ["wiki-stable"]
        draft = _make_wiki("wiki-draft-1", fake_user.id)
        draft.title = "Personal Knowledge Graph Draft"
        draft.lifecycle_status = "draft"
        draft.tags = ["wiki-draft", "from-stable-wiki"]
        mock_session.get.return_value = wiki

        with patch("pkg.api.wiki.persist_wiki_page", new=AsyncMock(return_value=draft)) as persist:
            result = await clone_wiki_page_as_draft(
                "wiki-1",
                WikiCloneDraftRequest(),
                user=fake_user,
                session=mock_session,
            )

        assert result.title == "Personal Knowledge Graph Draft"
        assert "wiki-draft" in result.tags
        assert persist.await_args.kwargs["body"].lifecycle_status == "draft"


class TestPublishWikiDraft:
    @pytest.mark.asyncio
    async def test_preview_returns_warnings_without_publishing(self, mock_session, fake_user):
        from pkg.api.wiki import publish_wiki_page
        from pkg.schemas.wiki import WikiPublishRequest

        wiki = _make_wiki("wiki-1", fake_user.id)
        wiki.lifecycle_status = "draft"
        wiki.tags = ["wiki-draft"]
        wiki.derived_from_sources = []
        wiki.open_questions = ["What changes next?"]
        wiki.confidence_score = 0.5
        mock_session.get.return_value = wiki

        result = await publish_wiki_page(
            "wiki-1",
            WikiPublishRequest(base_revision=1),
            user=fake_user,
            session=mock_session,
        )

        assert result.published is False
        assert len(result.warnings) == 3
        assert wiki.lifecycle_status == "draft"
        mock_session.commit.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_confirm_promotes_current_revision_to_stable(self, mock_session, fake_user):
        from pkg.api.wiki import publish_wiki_page
        from pkg.schemas.wiki import WikiPublishRequest

        wiki = _make_wiki("wiki-1", fake_user.id)
        wiki.lifecycle_status = "draft"
        wiki.tags = ["wiki-draft", "asset-promotion"]
        wiki.derived_from_sources = ["source-1"]
        mock_session.get.return_value = wiki

        result = await publish_wiki_page(
            "wiki-1",
            WikiPublishRequest(base_revision=1, confirm=True),
            user=fake_user,
            session=mock_session,
        )

        assert result.published is True
        assert wiki.lifecycle_status == "stable"
        assert wiki.stable_revision == 1
        assert wiki.stable_at is not None
        assert "wiki-stable" in wiki.tags
        assert "wiki-draft" not in wiki.tags
        mock_session.commit.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_rejects_stale_publish_preview(self, mock_session, fake_user):
        from pkg.api.wiki import publish_wiki_page
        from pkg.schemas.wiki import WikiPublishRequest

        wiki = _make_wiki("wiki-1", fake_user.id)
        wiki.lifecycle_status = "draft"
        wiki.content_revision = 3
        mock_session.get.return_value = wiki

        with pytest.raises(HTTPException) as exc_info:
            await publish_wiki_page(
                "wiki-1",
                WikiPublishRequest(base_revision=2, confirm=True),
                user=fake_user,
                session=mock_session,
            )

        assert exc_info.value.status_code == 409
        assert exc_info.value.detail["current_revision"] == 3

class TestListWikiPages:
    def test_success(self, client, mock_session, fake_user):
        count = MagicMock()
        count.scalar.return_value = 1
        rows = MagicMock()
        rows.scalars.return_value = [_make_wiki("wiki-1", fake_user.id)]
        mock_session.execute.side_effect = [count, rows]

        resp = client.get("/wiki")

        assert resp.status_code == 200
        assert resp.json()["total"] == 1
        assert resp.json()["items"][0]["id"] == "wiki-1"


class TestWikiSuggestionStatusFlow:
    @pytest.mark.asyncio
    async def test_accept_marks_wiki_stale(self, mock_session, fake_user):
        from pkg.api.wiki import update_wiki_suggestion_status
        from pkg.models.wiki import WikiRecompileSuggestion
        from pkg.schemas.wiki import WikiSuggestionStatusUpdate

        suggestion = WikiRecompileSuggestion(
            id=1,
            user_id=fake_user.id,
            wiki_id="wiki-1",
            trigger_type="memory",
            trigger_id="mem-1",
            reason="Memory changed",
            evidence_preview="preview",
            status="pending",
            metadata_={},
            created_at=datetime(2026, 1, 1, tzinfo=timezone.utc),
            updated_at=datetime(2026, 1, 1, tzinfo=timezone.utc),
        )
        wiki = _make_wiki("wiki-1", fake_user.id)
        mock_session.get.side_effect = [suggestion, wiki]
        execute_result = MagicMock()
        execute_result.scalar_one_or_none.return_value = None
        mock_session.execute.return_value = execute_result

        result = await update_wiki_suggestion_status(
            1,
            WikiSuggestionStatusUpdate(status="accepted", reviewer_note="reviewed"),
            user=fake_user,
            session=mock_session,
        )

        assert result.status == "accepted"
        assert result.reviewed_at is not None
        assert wiki.needs_recompile is True
        assert wiki.stale_reason == "Memory changed"
        mock_session.commit.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_apply_clears_wiki_stale(self, mock_session, fake_user):
        from pkg.api.wiki import update_wiki_suggestion_status
        from pkg.models.wiki import WikiRecompileSuggestion
        from pkg.schemas.wiki import WikiSuggestionStatusUpdate

        suggestion = WikiRecompileSuggestion(
            id=1,
            user_id=fake_user.id,
            wiki_id="wiki-1",
            trigger_type="memory",
            trigger_id="mem-1",
            reason="Memory changed",
            evidence_preview="preview",
            status="accepted",
            metadata_={},
            created_at=datetime(2026, 1, 1, tzinfo=timezone.utc),
            updated_at=datetime(2026, 1, 1, tzinfo=timezone.utc),
        )
        wiki = _make_wiki("wiki-1", fake_user.id)
        wiki.needs_recompile = True
        wiki.stale_reason = "Memory changed"
        wiki.stale_triggered_at = datetime(2026, 1, 1, tzinfo=timezone.utc)
        mock_session.get.side_effect = [suggestion, wiki]
        execute_result = MagicMock()
        execute_result.scalar_one_or_none.return_value = None
        mock_session.execute.return_value = execute_result

        result = await update_wiki_suggestion_status(
            1,
            WikiSuggestionStatusUpdate(status="applied"),
            user=fake_user,
            session=mock_session,
        )

        assert result.status == "applied"
        assert result.applied_at is not None
        assert wiki.needs_recompile is False
        assert wiki.stale_reason is None
        assert wiki.stale_triggered_at is None

    @pytest.mark.asyncio
    async def test_dismiss_keeps_distinct_status(self, mock_session, fake_user):
        from pkg.api.wiki import update_wiki_suggestion_status
        from pkg.models.wiki import WikiRecompileSuggestion
        from pkg.schemas.wiki import WikiSuggestionStatusUpdate

        suggestion = WikiRecompileSuggestion(
            id=1,
            user_id=fake_user.id,
            wiki_id="wiki-1",
            trigger_type="memory",
            trigger_id="mem-1",
            reason="Memory changed",
            evidence_preview="preview",
            status="pending",
            metadata_={},
            created_at=datetime(2026, 1, 1, tzinfo=timezone.utc),
            updated_at=datetime(2026, 1, 1, tzinfo=timezone.utc),
        )
        wiki = _make_wiki("wiki-1", fake_user.id)
        mock_session.get.side_effect = [suggestion, wiki]
        execute_result = MagicMock()
        execute_result.scalar_one_or_none.return_value = None
        mock_session.execute.return_value = execute_result

        result = await update_wiki_suggestion_status(
            1,
            WikiSuggestionStatusUpdate(status="dismissed"),
            user=fake_user,
            session=mock_session,
        )

        assert result.status == "dismissed"
        assert result.reviewed_at is not None
        assert wiki.needs_recompile is False

    @pytest.mark.asyncio
    async def test_conflicting_target_status_returns_409(self, mock_session, fake_user):
        from pkg.api.wiki import update_wiki_suggestion_status
        from pkg.models.wiki import WikiRecompileSuggestion
        from pkg.schemas.wiki import WikiSuggestionStatusUpdate

        suggestion = WikiRecompileSuggestion(
            id=48,
            user_id=fake_user.id,
            wiki_id="wiki-1",
            trigger_type="memory",
            trigger_id="mem-1",
            reason="Memory changed",
            evidence_preview="preview",
            status="pending",
            metadata_={},
            created_at=datetime(2026, 1, 1, tzinfo=timezone.utc),
            updated_at=datetime(2026, 1, 1, tzinfo=timezone.utc),
        )
        mock_session.get.return_value = suggestion
        execute_result = MagicMock()
        execute_result.scalar_one_or_none.return_value = 99
        mock_session.execute.return_value = execute_result

        with pytest.raises(HTTPException) as exc_info:
            await update_wiki_suggestion_status(
                48,
                WikiSuggestionStatusUpdate(status="rejected"),
                user=fake_user,
                session=mock_session,
            )

        assert exc_info.value.status_code == 409
        assert "same trigger" in exc_info.value.detail


def _make_wiki(wiki_id: str, user_id: str):
    wiki = MagicMock(spec=[])
    wiki.id = wiki_id
    wiki.user_id = user_id
    wiki.title = "Personal Knowledge Graph"
    wiki.page_type = "topic"
    wiki.summary = "PKG overview"
    wiki.content = "# Personal Knowledge Graph"
    wiki.domains = []
    wiki.tags = []
    wiki.derived_from_notes = []
    wiki.derived_from_sources = []
    wiki.open_questions = []
    wiki.confidence_score = 0.8
    wiki.lifecycle_status = "stable"
    wiki.content_revision = 1
    wiki.stable_at = datetime(2026, 1, 1, tzinfo=timezone.utc)
    wiki.stable_revision = 1
    wiki.needs_recompile = False
    wiki.stale_reason = None
    wiki.stale_triggered_at = None
    wiki.last_compiled_at = datetime(2026, 1, 1, tzinfo=timezone.utc)
    wiki.created_at = datetime(2026, 1, 1, tzinfo=timezone.utc)
    wiki.updated_at = datetime(2026, 1, 1, tzinfo=timezone.utc)
    return wiki
