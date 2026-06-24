from datetime import datetime, timezone
from unittest.mock import AsyncMock, patch

import pytest

from pkg.models.foundation.wiki import WikiArticleDraft, WikiInsightCandidate


class TestWikiCandidateReviewAPI:
    @pytest.mark.asyncio
    async def test_update_insight_status(self, mock_session, fake_user):
        from pkg.api.wiki import update_wiki_insight_candidate_status
        from pkg.schemas.wiki import WikiInsightCandidateStatusUpdate

        insight = WikiInsightCandidate(
            id=1,
            run_id=1,
            user_id=fake_user.id,
            insight_type="new_insight",
            title="Insight",
            summary="Summary",
            evidence_refs=[{"ref_type": "source", "ref_id": "src-1", "title": "Source 1", "excerpt": "excerpt"}],
            metadata_={},
            status="pending",
            reviewer_note=None,
            created_at=datetime(2026, 6, 8, tzinfo=timezone.utc),
            updated_at=datetime(2026, 6, 8, tzinfo=timezone.utc),
        )
        mock_session.get.return_value = insight

        result = await update_wiki_insight_candidate_status(
            1,
            WikiInsightCandidateStatusUpdate(status="accepted", reviewer_note="useful"),
            user=fake_user,
            session=mock_session,
        )

        assert result.status == "accepted"
        assert result.reviewer_note == "useful"
        mock_session.commit.assert_awaited()

    @pytest.mark.asyncio
    @patch("pkg.api.wiki.persist_wiki_page", new_callable=AsyncMock)
    async def test_accept_article_as_wiki_draft(self, mock_persist, mock_session, fake_user):
        from pkg.api.wiki import update_wiki_article_draft_status
        from pkg.schemas.wiki import WikiArticleDraftStatusUpdate

        article = WikiArticleDraft(
            id=2,
            run_id=1,
            user_id=fake_user.id,
            title="Candidate Article",
            page_type="topic",
            summary="Candidate summary",
            content="# Candidate Article",
            evidence_refs=[
                {"ref_type": "source", "ref_id": "src-1", "title": "Source 1", "excerpt": "excerpt"},
                {"ref_type": "note", "ref_id": "note-1", "title": "Note 1", "excerpt": "excerpt"},
            ],
            metadata_={},
            status="candidate",
            reviewer_note=None,
            created_at=datetime(2026, 6, 8, tzinfo=timezone.utc),
            updated_at=datetime(2026, 6, 8, tzinfo=timezone.utc),
        )
        wiki = type("WikiObj", (), {"id": "wiki-candidate-1"})()
        mock_persist.return_value = wiki
        mock_session.get.return_value = article

        result = await update_wiki_article_draft_status(
            2,
            WikiArticleDraftStatusUpdate(status="accepted", reviewer_note="promote"),
            user=fake_user,
            session=mock_session,
        )

        assert result.status == "accepted"
        assert result.metadata_["accepted_wiki_id"] == "wiki-candidate-1"
        mock_persist.assert_awaited()

    @pytest.mark.asyncio
    async def test_merge_article_placeholder(self, mock_session, fake_user):
        from pkg.api.wiki import merge_wiki_article_candidate
        from pkg.schemas.wiki import WikiCandidateMergeAction

        article = WikiArticleDraft(
            id=3,
            run_id=1,
            user_id=fake_user.id,
            title="Candidate Article",
            page_type="topic",
            summary="Candidate summary",
            content="# Candidate Article",
            evidence_refs=[],
            metadata_={},
            status="candidate",
            reviewer_note=None,
            created_at=datetime(2026, 6, 8, tzinfo=timezone.utc),
            updated_at=datetime(2026, 6, 8, tzinfo=timezone.utc),
        )
        mock_session.get.return_value = article

        result = await merge_wiki_article_candidate(
            3,
            WikiCandidateMergeAction(target_wiki_id="wiki-1", reviewer_note="merge later"),
            user=fake_user,
            session=mock_session,
        )

        assert result.status == "merged"
        assert result.metadata_["merge_target_wiki_id"] == "wiki-1"

    @pytest.mark.asyncio
    async def test_convert_article_to_note_placeholder(self, mock_session, fake_user):
        from pkg.api.wiki import convert_wiki_article_candidate_to_note

        article = WikiArticleDraft(
            id=4,
            run_id=1,
            user_id=fake_user.id,
            title="Candidate Article",
            page_type="topic",
            summary="Candidate summary",
            content="# Candidate Article",
            evidence_refs=[],
            metadata_={},
            status="candidate",
            reviewer_note=None,
            created_at=datetime(2026, 6, 8, tzinfo=timezone.utc),
            updated_at=datetime(2026, 6, 8, tzinfo=timezone.utc),
        )
        mock_session.get.return_value = article

        result = await convert_wiki_article_candidate_to_note(4, user=fake_user, session=mock_session)

        assert result.article_id == 4
        assert result.status == "placeholder"
        assert result.note_title == "Candidate Article"

    @pytest.mark.asyncio
    async def test_mark_article_applied(self, mock_session, fake_user):
        from pkg.api.wiki import update_wiki_article_draft_status
        from pkg.schemas.wiki import WikiArticleDraftStatusUpdate

        article = WikiArticleDraft(
            id=5,
            run_id=1,
            user_id=fake_user.id,
            title="Update Draft",
            page_type="topic",
            summary="summary",
            content="content",
            evidence_refs=[],
            metadata_={"origin": "wiki_update_draft", "target_wiki_id": "wiki-1"},
            status="draft",
            reviewer_note=None,
            created_at=datetime(2026, 6, 8, tzinfo=timezone.utc),
            updated_at=datetime(2026, 6, 8, tzinfo=timezone.utc),
        )
        mock_session.get.return_value = article
        mock_session.refresh = AsyncMock(side_effect=lambda obj: None)

        result = await update_wiki_article_draft_status(
            5,
            WikiArticleDraftStatusUpdate(status="applied", reviewer_note="copied into wiki"),
            user=fake_user,
            session=mock_session,
        )

        assert result.status == "applied"
        assert result.reviewer_note == "copied into wiki"
        mock_session.commit.assert_awaited()

    @pytest.mark.asyncio
    async def test_delete_update_draft(self, mock_session, fake_user):
        from pkg.api.wiki import delete_wiki_update_draft

        article = WikiArticleDraft(
            id=6,
            run_id=1,
            user_id=fake_user.id,
            title="Update Draft",
            page_type="topic",
            summary="summary",
            content="content",
            evidence_refs=[],
            metadata_={"origin": "wiki_update_draft", "target_wiki_id": "wiki-1"},
            status="draft",
            reviewer_note=None,
            created_at=datetime(2026, 6, 8, tzinfo=timezone.utc),
            updated_at=datetime(2026, 6, 8, tzinfo=timezone.utc),
        )
        mock_session.get.return_value = article

        await delete_wiki_update_draft(6, user=fake_user, session=mock_session)

        mock_session.delete.assert_awaited_once_with(article)
        mock_session.commit.assert_awaited()
