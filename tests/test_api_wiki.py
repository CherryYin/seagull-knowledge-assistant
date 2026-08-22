from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import HTTPException

from pkg.api.wiki import compile_wiki_page
from pkg.schemas.wiki import WikiCompileRequest


@pytest.mark.asyncio
async def test_create_wiki_mining_run_rejects_pkg_local_execution_when_disabled(
    monkeypatch,
    mock_session,
    fake_user,
):
    from pkg.api.wiki import create_wiki_mining_run
    from pkg.schemas.wiki import WikiMiningRunCreate

    monkeypatch.setattr("pkg.api.wiki.settings.PKG_WIKI_MINING_ENABLED", False)
    mining = AsyncMock()

    with patch("pkg.api.wiki.run_wiki_mining", mining):
        with pytest.raises(HTTPException) as exc_info:
            await create_wiki_mining_run(
                WikiMiningRunCreate(),
                user=fake_user,
                session=mock_session,
            )

    assert exc_info.value.status_code == 410
    assert "Harness workflow mine-wiki-candidates" in exc_info.value.detail
    mining.assert_not_awaited()


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


class TestCloneWikiDraft:
    @pytest.mark.asyncio
    async def test_clone_stable_wiki_as_draft(self, mock_session, fake_user):
        from pkg.api.wiki import clone_wiki_page_as_draft
        from pkg.schemas.wiki import WikiCloneDraftRequest

        wiki = _make_wiki("wiki-1", fake_user.id)
        wiki.tags = ["wiki-stable"]
        mock_session.get.return_value = wiki

        result = await clone_wiki_page_as_draft(
            "wiki-1",
            WikiCloneDraftRequest(),
            user=fake_user,
            session=mock_session,
        )

        assert result.title == "Personal Knowledge Graph Draft"
        assert "wiki-draft" in result.tags

    @pytest.mark.asyncio
    async def test_create_wiki_update_draft_from_memory(self, mock_session, fake_user):
        from pkg.api.wiki import create_wiki_update_draft_from_memory
        from pkg.schemas.wiki import WikiUpdateDraftFromMemoryRequest

        wiki = type("WikiObj", (), {
            "id": "wiki-ai-agent",
            "user_id": fake_user.id,
            "title": "AI AGENT",
            "summary": "AI agent page summary",
            "content": "# AI AGENT\n\n## Risks\n\nCurrent risk guidance.\n\n## Tooling\n\nCurrent tooling guidance.",
        })()
        memory = type("MemoryObj", (), {
            "id": "mem-1",
            "user_id": fake_user.id,
            "title": "Source Memory - APIKey compatibility",
            "summary": "Compatibility note",
            "content": "Any-site API keys may have compatibility risk in Pi Agent.",
        })()

        article = type("ArticleObj", (), {
            "id": 11,
            "run_id": 1,
            "user_id": fake_user.id,
            "title": "Update AI AGENT from memory",
            "page_type": "topic",
            "summary": "Compatibility note",
            "content": "draft",
            "evidence_refs": [],
            "metadata_": {"origin": "wiki_update_draft", "target_wiki_id": "wiki-ai-agent"},
            "status": "draft",
            "reviewer_note": None,
            "created_at": datetime(2026, 6, 16, tzinfo=timezone.utc),
            "updated_at": datetime(2026, 6, 16, tzinfo=timezone.utc),
        })()

        mock_session.get.side_effect = [wiki, memory]
        mock_session.refresh = AsyncMock(side_effect=lambda obj: None)
        mock_session.flush = AsyncMock(side_effect=lambda: None)

        def fake_add(obj):
            if hasattr(obj, "title") and hasattr(obj, "content"):
                article.run_id = obj.run_id
                article.title = obj.title
                article.summary = obj.summary
                article.content = obj.content
                article.metadata_ = obj.metadata_
                article.status = obj.status
            else:
                obj.id = 1

        mock_session.add.side_effect = fake_add

        result = await create_wiki_update_draft_from_memory(
            WikiUpdateDraftFromMemoryRequest(wiki_id="wiki-ai-agent", memory_node_id="mem-1", section="Risks"),
            user=fake_user,
            session=mock_session,
        )

        assert result.status == "draft"
        assert result.run_id == 1
        assert result.metadata_["origin"] == "wiki_update_draft"
        assert result.metadata_["target_wiki_id"] == "wiki-ai-agent"
        assert result.metadata_["suggested_section"] == "Risks"
        assert "# Wiki Refresh Proposal: AI AGENT" in result.content
        assert "## Current Wiki Summary" in result.content
        assert "AI agent page summary" in result.content
        assert "## Relevant Existing Content" in result.content
        assert "Current risk guidance." in result.content
        assert "## New Evidence" in result.content
        assert "Compatibility note" in result.content
        assert "## Proposed Update" in result.content
        assert "without drifting away from the existing wiki topic" in result.content
        mock_session.commit.assert_awaited()

    @pytest.mark.asyncio
    async def test_create_wiki_update_draft_from_source(self, mock_session, fake_user):
        from pkg.api.wiki import create_wiki_update_draft_from_source
        from pkg.schemas.wiki import WikiUpdateDraftFromSourceRequest

        wiki = type("WikiObj", (), {
            "id": "wiki-ai-agent",
            "user_id": fake_user.id,
            "title": "AI AGENT",
            "summary": "AI agent page summary",
            "content": "# AI AGENT\n\n## Risks\n\nCurrent risk guidance.",
        })()
        source = type("SourceObj", (), {
            "id": "src-1",
            "user_id": fake_user.id,
            "title": "API key compatibility",
            "raw_content": "Any-site API keys may have compatibility risk in Pi Agent.",
        })()
        article = type("ArticleObj", (), {
            "id": 12,
            "run_id": 1,
            "user_id": fake_user.id,
            "title": "Update AI AGENT from source",
            "page_type": "topic",
            "summary": source.title,
            "content": "draft",
            "evidence_refs": [],
            "metadata_": {"origin": "wiki_update_draft", "target_wiki_id": wiki.id},
            "status": "draft",
            "reviewer_note": None,
            "created_at": datetime(2026, 8, 22, tzinfo=timezone.utc),
            "updated_at": datetime(2026, 8, 22, tzinfo=timezone.utc),
        })()

        mock_session.get.side_effect = [wiki, source]
        mock_session.refresh = AsyncMock(side_effect=lambda obj: None)
        mock_session.flush = AsyncMock(side_effect=lambda: None)

        def fake_add(obj):
            if hasattr(obj, "title") and hasattr(obj, "content"):
                article.run_id = obj.run_id
                article.title = obj.title
                article.summary = obj.summary
                article.content = obj.content
                article.evidence_refs = obj.evidence_refs
                article.metadata_ = obj.metadata_
                article.status = obj.status
            else:
                obj.id = 1

        mock_session.add.side_effect = fake_add

        result = await create_wiki_update_draft_from_source(
            WikiUpdateDraftFromSourceRequest(wiki_id=wiki.id, source_id=source.id, section="Risks"),
            user=fake_user,
            session=mock_session,
        )

        assert result.status == "draft"
        assert result.metadata_["trigger_type"] == "source"
        assert result.metadata_["trigger_id"] == source.id
        assert result.evidence_refs[0]["ref_type"] == "source"
        assert "API key compatibility" in result.content
        assert "Current risk guidance." in result.content
        mock_session.commit.assert_awaited()

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


class TestCompileWikiPage:
    @pytest.mark.asyncio
    async def test_uses_only_explicit_notes_and_sources(self, mock_session, fake_user):
        note = type(
            "NoteObj",
            (),
            {"id": "note-1", "title": "Explicit Note", "content": "Note evidence", "abstract": None},
        )()
        source = type(
            "SourceObj",
            (),
            {
                "id": "src-1",
                "title": "Explicit Source",
                "raw_content": "Source evidence",
                "user_id": fake_user.id,
                "is_shared": False,
            },
        )()
        note_rows = MagicMock()
        note_rows.scalars.return_value = [note]
        source_rows = MagicMock()
        source_rows.scalars.return_value = [source]
        mock_session.execute.side_effect = [note_rows, source_rows]

        completion = type(
            "CompletionObj",
            (),
            {"choices": [type("ChoiceObj", (), {"message": type("MessageObj", (), {"content": "# Explicit Wiki\n\nCompiled."})()})()]},
        )()
        llm_client = MagicMock()
        llm_client.chat.completions.create = AsyncMock(return_value=completion)
        wiki = _make_wiki("wiki-explicit", fake_user.id)

        with (
            patch("pkg.api.wiki.create_async_client", return_value=(llm_client, "test-model")),
            patch("pkg.api.wiki.persist_wiki_page", new_callable=AsyncMock, return_value=wiki) as persist,
        ):
            result = await compile_wiki_page(
                WikiCompileRequest(
                    title="Explicit Wiki",
                    note_ids=[note.id],
                    source_ids=[source.id],
                ),
                user=fake_user,
                session=mock_session,
            )

        assert result is wiki
        prompt = llm_client.chat.completions.create.await_args.kwargs["messages"][1]["content"]
        assert "## Note: Explicit Note" in prompt
        assert "## Source: Explicit Source" in prompt
        assert "Memory Tree Context" not in prompt
        persisted = persist.await_args.kwargs["body"]
        assert persisted.derived_from_notes == [note.id]
        assert persisted.derived_from_sources == [source.id]
        assert persisted.open_questions == []


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


class TestListWikiUpdateDrafts:
    @pytest.mark.asyncio
    async def test_success(self, mock_session, fake_user):
        from pkg.api.wiki import list_wiki_update_drafts

        article = type("ArticleObj", (), {
            "id": 11,
            "run_id": 1,
            "user_id": fake_user.id,
            "title": "Update AI AGENT from memory",
            "page_type": "topic",
            "summary": "Compatibility note",
            "content": "draft",
            "evidence_refs": [],
            "metadata_": {"origin": "wiki_update_draft", "target_wiki_id": "wiki-ai-agent", "suggested_section": "Risks"},
            "status": "draft",
            "reviewer_note": None,
            "created_at": datetime(2026, 6, 16, tzinfo=timezone.utc),
            "updated_at": datetime(2026, 6, 16, tzinfo=timezone.utc),
        })()
        rows = MagicMock()
        rows.scalars.return_value = [article]
        mock_session.execute.return_value = rows

        result = await list_wiki_update_drafts("wiki-ai-agent", user=fake_user, session=mock_session)

        assert len(result) == 1
        assert result[0].metadata_["target_wiki_id"] == "wiki-ai-agent"


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
    wiki.needs_recompile = False
    wiki.stale_reason = None
    wiki.stale_triggered_at = None
    wiki.last_compiled_at = datetime(2026, 1, 1, tzinfo=timezone.utc)
    wiki.created_at = datetime(2026, 1, 1, tzinfo=timezone.utc)
    wiki.updated_at = datetime(2026, 1, 1, tzinfo=timezone.utc)
    return wiki
