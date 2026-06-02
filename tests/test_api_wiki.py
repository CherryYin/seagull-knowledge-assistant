from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from pkg.api.wiki import create_wiki_draft_from_memory, list_wiki_page_memories, upsert_wiki_page_memory
from pkg.models.memory import MemoryNode
from pkg.schemas.wiki import WikiFromMemoryRequest, WikiPageMemoryCreate


class TestCreateWikiPage:
    @patch("pkg.api.wiki.get_embedding_service")
    def test_success(self, mock_embedding_service, client, mock_session):
        emb_svc = MagicMock()
        emb_svc.embed_text = AsyncMock(return_value=[0.1, 0.2])
        mock_embedding_service.return_value = emb_svc

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
        mock_session.add.assert_called()
        mock_session.commit.assert_awaited()
        mock_session.refresh.assert_awaited()


class TestGetWikiPage:
    def test_success(self, client, mock_session, fake_user):
        wiki = _make_wiki("wiki-1", fake_user.id)
        mock_session.get.return_value = wiki

        resp = client.get("/wiki/wiki-1")

        assert resp.status_code == 200
        assert resp.json()["id"] == "wiki-1"

    def test_not_found_for_other_user(self, client, mock_session):
        wiki = _make_wiki("wiki-1", "other-user")
        mock_session.get.return_value = wiki

        resp = client.get("/wiki/wiki-1")

        assert resp.status_code == 404


class TestUpsertWikiSource:
    def test_success(self, client, mock_session, fake_user):
        wiki = _make_wiki("wiki-1", fake_user.id)
        source = MagicMock(spec=[])
        source.id = "src-1"
        source.user_id = fake_user.id
        source.is_shared = False
        rows = MagicMock()
        rows.scalar_one_or_none.return_value = None
        mock_session.get.side_effect = [wiki, source]
        mock_session.execute.return_value = rows

        resp = client.post(
            "/wiki/wiki-1/sources",
            json={
                "source_id": "src-1",
                "relevance_summary": "This source supports the PKG memory tree design.",
                "key_points": ["Memory Tree"],
                "supporting_claims": ["Use topic-relative source summaries"],
                "cited_chunk_ids": [1, 2],
                "confidence_score": 0.8,
            },
        )

        assert resp.status_code == 201
        mock_session.add.assert_called()
        mock_session.commit.assert_awaited()
        assert "src-1" in wiki.derived_from_sources


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


class TestCreateWikiDraftFromMemory:
    @pytest.mark.asyncio
    @patch("pkg.api.wiki.persist_wiki_page", new_callable=AsyncMock)
    async def test_success(self, mock_persist, mock_session, fake_user):
        memory = MemoryNode(
            id="mem-topic-ai",
            user_id=fake_user.id,
            node_type="topic",
            scope_id="ai",
            level="topic",
            title="Topic Memory - AI Coding",
            summary="AI coding summary",
            content="# AI Coding\n\nStable conclusions.",
            child_node_ids=[],
            derived_from_notes=["note-1"],
            derived_from_sources=["src-1"],
            derived_from_chunks=[],
            metadata_={},
            confidence_score=0.8,
        )
        wiki = _make_wiki("wiki-ai-coding", fake_user.id)
        wiki.title = "AI Coding"
        wiki.tags = ["draft", "from-memory", "topic-memory"]
        mock_session.get.return_value = memory
        mock_persist.return_value = wiki

        result = await create_wiki_draft_from_memory(
            WikiFromMemoryRequest(memory_node_id="mem-topic-ai", title="AI Coding"),
            user=fake_user,
            session=mock_session,
        )

        assert result.id == "wiki-ai-coding"
        mock_persist.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_rejects_non_topic_memory(self, mock_session, fake_user):
        memory = MagicMock(spec=[])
        memory.id = "mem-source-src-1"
        memory.user_id = fake_user.id
        memory.node_type = "source"
        mock_session.get.return_value = memory

        with pytest.raises(Exception) as exc_info:
            await create_wiki_draft_from_memory(
                WikiFromMemoryRequest(memory_node_id="mem-source-src-1"),
                user=fake_user,
                session=mock_session,
            )
        assert getattr(exc_info.value, "status_code") == 422


class TestWikiMemoryEvidence:
    @pytest.mark.asyncio
    async def test_upsert_success(self, mock_session, fake_user):
        wiki = _make_wiki("wiki-1", fake_user.id)
        memory = MemoryNode(
            id="mem-topic-ai",
            user_id=fake_user.id,
            node_type="topic",
            scope_id="ai",
            level="topic",
            title="Topic Memory - AI",
            summary="summary",
            content="content",
            child_node_ids=[],
            derived_from_notes=["note-1"],
            derived_from_sources=["src-1"],
            derived_from_chunks=[],
            metadata_={},
            confidence_score=0.8,
        )
        rows = MagicMock()
        rows.scalar_one_or_none.return_value = None
        mock_session.get.side_effect = [wiki, memory]
        mock_session.execute.return_value = rows

        result = await upsert_wiki_page_memory(
            "wiki-1",
            WikiPageMemoryCreate(
                memory_node_id="mem-topic-ai",
                relevance_summary="This memory supports the wiki synthesis.",
                key_points=["AI"],
                supporting_claims=["Topic memory summarizes source evidence"],
                confidence_score=0.8,
            ),
            user=fake_user,
            session=mock_session,
        )

        assert result.memory_node_id == "mem-topic-ai"
        assert "src-1" in wiki.derived_from_sources
        assert "note-1" in wiki.derived_from_notes
        mock_session.add.assert_called_once()
        mock_session.commit.assert_awaited_once()
        mock_session.refresh.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_rejects_other_user_memory(self, mock_session, fake_user):
        wiki = _make_wiki("wiki-1", fake_user.id)
        memory = MagicMock(spec=[])
        memory.id = "mem-topic-other"
        memory.user_id = "other-user"
        mock_session.get.side_effect = [wiki, memory]

        with pytest.raises(Exception) as exc_info:
            await upsert_wiki_page_memory(
                "wiki-1",
                WikiPageMemoryCreate(memory_node_id="mem-topic-other", relevance_summary="Relevant"),
                user=fake_user,
                session=mock_session,
            )
        assert getattr(exc_info.value, "status_code") == 404

    @pytest.mark.asyncio
    async def test_list_success(self, mock_session, fake_user):
        wiki = _make_wiki("wiki-1", fake_user.id)
        evidence = MagicMock(spec=[])
        evidence.id = 1
        evidence.wiki_id = "wiki-1"
        evidence.memory_node_id = "mem-topic-ai"
        rows = MagicMock()
        rows.scalars.return_value = [evidence]
        mock_session.get.return_value = wiki
        mock_session.execute.return_value = rows

        result = await list_wiki_page_memories("wiki-1", user=fake_user, session=mock_session)

        assert result == [evidence]


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
    wiki.needs_recompile = False
    wiki.stale_reason = None
    wiki.stale_triggered_at = None
    wiki.last_compiled_at = datetime(2026, 1, 1, tzinfo=timezone.utc)
    wiki.created_at = datetime(2026, 1, 1, tzinfo=timezone.utc)
    wiki.updated_at = datetime(2026, 1, 1, tzinfo=timezone.utc)
    return wiki
