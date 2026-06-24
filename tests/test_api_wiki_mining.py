from datetime import datetime, timezone
from unittest.mock import AsyncMock, patch

import pytest

from pkg.models.foundation.wiki import WikiArticleDraft, WikiInsightCandidate, WikiMiningRun


class TestWikiMiningAPI:
    @pytest.mark.asyncio
    @patch("pkg.api.wiki.run_wiki_mining", new_callable=AsyncMock)
    async def test_create_run(self, mock_run, mock_session, fake_user):
        from pkg.api.wiki import create_wiki_mining_run
        from pkg.schemas.wiki import WikiMiningRunCreate

        run = WikiMiningRun(
            id=1,
            user_id=fake_user.id,
            status="completed",
            window_start=datetime(2026, 6, 1, tzinfo=timezone.utc),
            window_end=datetime(2026, 6, 8, tzinfo=timezone.utc),
            metadata_={"input_summary": {"new_sources": 1}},
            created_at=datetime(2026, 6, 8, tzinfo=timezone.utc),
            updated_at=datetime(2026, 6, 8, tzinfo=timezone.utc),
        )
        insight = WikiInsightCandidate(
            id=1,
            run_id=1,
            user_id=fake_user.id,
            insight_type="new_insight",
            title="Memory theme grows",
            summary="Recent inputs suggest a durable theme.",
            evidence_refs=[{"ref_type": "source", "ref_id": "src-1", "title": "Source 1", "excerpt": "excerpt"}],
            metadata_={},
            status="pending",
            reviewer_note=None,
            created_at=datetime(2026, 6, 8, tzinfo=timezone.utc),
            updated_at=datetime(2026, 6, 8, tzinfo=timezone.utc),
        )
        article = WikiArticleDraft(
            id=1,
            run_id=1,
            user_id=fake_user.id,
            title="Knowledge Candidate",
            page_type="topic",
            summary="Candidate summary",
            content="# Knowledge Candidate",
            evidence_refs=[{"ref_type": "source", "ref_id": "src-1", "title": "Source 1", "excerpt": "excerpt"}],
            metadata_={},
            status="candidate",
            reviewer_note=None,
            created_at=datetime(2026, 6, 8, tzinfo=timezone.utc),
            updated_at=datetime(2026, 6, 8, tzinfo=timezone.utc),
        )
        mock_run.return_value = type("MiningResult", (), {"run": run, "insights": [insight], "articles": [article]})()

        result = await create_wiki_mining_run(WikiMiningRunCreate(window_days=2), user=fake_user, session=mock_session)

        assert result.run.id == 1
        assert result.insights[0].evidence_refs[0].ref_id == "src-1"
        assert result.articles[0].status == "candidate"
        mock_run.assert_awaited_once()
        assert mock_run.await_args.kwargs["window_days"] == 2

    @pytest.mark.asyncio
    async def test_get_run_not_found(self, mock_session, fake_user):
        from pkg.api.wiki import get_wiki_mining_run

        with patch("pkg.api.wiki.get_wiki_mining_run_detail", new=AsyncMock(return_value=(None, [], []))):
            with pytest.raises(Exception) as exc_info:
                await get_wiki_mining_run(99, user=fake_user, session=mock_session)
            assert getattr(exc_info.value, "status_code", None) == 404
