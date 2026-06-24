from datetime import datetime, timezone
from unittest.mock import AsyncMock, MagicMock
import json

import pytest

from pkg.models.foundation.memory import MemoryNode
from pkg.models.foundation.note import Note
from pkg.models.foundation.source import Source
from pkg.models.foundation.wiki import WikiPage
from pkg.services.foundation.wiki_concept_discovery import discover_knowledge_entities
from pkg.services.foundation.wiki_mining import run_wiki_mining


@pytest.mark.asyncio
async def test_run_wiki_mining_generates_insights_and_article():
    now = datetime(2026, 6, 8, tzinfo=timezone.utc)
    source = Source(
        id="src-1",
        user_id="user-1",
        is_shared=False,
        category_id=1,
        title="LLM memory architecture",
        source_type="web",
        url="https://example.com/llm-memory",
        content_hash=None,
        raw_content="LLM memory architecture connects wiki, sources, and review loops.",
        file_path=None,
        ingested_at=now,
        metadata_={},
    )
    note = Note(
        id="note-1",
        user_id="user-1",
        category_id=1,
        title="Wiki review note",
        note_type="summary",
        domains=[],
        tags=[],
        abstract="Need a better wiki review loop.",
        content="The review loop should connect sources and wiki candidates.",
        project=None,
        status="seed",
        confidence="medium",
        source_ids=["src-1"],
        file_path=None,
        word_count=20,
        expires_at=None,
        kept_at=None,
        created_at=now,
        updated_at=now,
    )
    memory = MemoryNode(
        id="mem-1",
        user_id="user-1",
        node_type="topic",
        scope_id="wiki-review",
        level="topic",
        title="Wiki review memory",
        summary="Stable review knowledge",
        content="Knowledge tree nodes can guide wiki mining.",
        child_node_ids=[],
        derived_from_notes=["note-1"],
        derived_from_sources=["src-1"],
        derived_from_chunks=[],
        metadata_={},
        confidence_score=0.8,
        created_at=now,
        updated_at=now,
    )
    wiki = WikiPage(
        id="wiki-1",
        user_id="user-1",
        title="Wiki Review",
        page_type="topic",
        summary="How wiki review works",
        content="Existing stable context for review and knowledge mining.",
        domains=[],
        tags=[],
        derived_from_notes=["note-1"],
        derived_from_sources=["src-1"],
        open_questions=[],
        confidence_score=0.8,
        needs_recompile=False,
        stale_reason=None,
        stale_triggered_at=None,
        last_compiled_at=now,
        created_at=now,
        updated_at=now,
    )

    rows = []
    for scalars in ([source], [note], [memory], [source], [note], [memory], [wiki]):
        result = MagicMock()
        result.scalars.return_value = scalars
        rows.append(result)

    session = AsyncMock()
    session.execute = AsyncMock(side_effect=rows)
    session.flush = AsyncMock(side_effect=lambda: None)
    session.commit = AsyncMock()
    session.refresh = AsyncMock()
    session.add = MagicMock(side_effect=lambda obj: setattr(obj, "id", getattr(obj, "id", None) or len(session.add.mock_calls)))

    result = await run_wiki_mining(session, user_id="user-1")

    assert result.run.status == "completed"
    assert len(result.insights) >= 1
    assert len(result.articles) >= 1
    assert result.insights[0].evidence_refs
    assert result.articles[0].evidence_refs
    session.commit.assert_awaited()


@pytest.mark.asyncio
async def test_run_wiki_mining_discovers_knowledge_entity_candidates():
    now = datetime(2026, 6, 8, tzinfo=timezone.utc)
    source = Source(
        id="src-hybrid",
        user_id="user-1",
        is_shared=False,
        category_id=1,
        title="Hybrid Retrieval Architecture",
        source_type="web",
        url="https://example.com/hybrid-retrieval",
        content_hash=None,
        raw_content=(
            "## Hybrid Retrieval\n"
            "Hybrid Retrieval is a retrieval method that combines semantic search and keyword filters. "
            "**Evidence Ref** keeps claims traceable."
        ),
        file_path=None,
        ingested_at=now,
        metadata_={},
    )
    note = Note(
        id="note-hybrid",
        user_id="user-1",
        category_id=1,
        title="Hybrid Retrieval Notes",
        note_type="summary",
        domains=[],
        tags=[],
        abstract="Hybrid retrieval should be reusable wiki knowledge.",
        content="Hybrid retrieval uses `MemoryNode` evidence and source filters.",
        project=None,
        status="seed",
        confidence="medium",
        source_ids=["src-hybrid"],
        file_path=None,
        word_count=20,
        expires_at=None,
        kept_at=None,
        created_at=now,
        updated_at=now,
    )
    memory = MemoryNode(
        id="mem-hybrid",
        user_id="user-1",
        node_type="topic",
        scope_id="hybrid-retrieval",
        level="topic",
        title="Topic Memory - Hybrid Retrieval",
        summary="Hybrid retrieval connects semantic search with structured filters.",
        content="Hybrid retrieval appears in topic memory as a durable concept.",
        child_node_ids=[],
        derived_from_notes=["note-hybrid"],
        derived_from_sources=["src-hybrid"],
        derived_from_chunks=[],
        metadata_={},
        confidence_score=0.8,
        created_at=now,
        updated_at=now,
    )

    rows = []
    for scalars in ([source], [note], [memory], [source], [note], [memory], []):
        result = MagicMock()
        result.scalars.return_value = scalars
        rows.append(result)

    session = AsyncMock()
    session.execute = AsyncMock(side_effect=rows)
    session.flush = AsyncMock(side_effect=lambda: None)
    session.commit = AsyncMock()
    session.refresh = AsyncMock()
    session.add = MagicMock(side_effect=lambda obj: setattr(obj, "id", getattr(obj, "id", None) or len(session.add.mock_calls)))

    result = await run_wiki_mining(session, user_id="user-1")

    concept_insights = [
        insight
        for insight in result.insights
        if (insight.metadata_ or {}).get("candidate_kind") == "knowledge_entity"
    ]
    concept_articles = [
        article
        for article in result.articles
        if (article.metadata_ or {}).get("origin") == "wiki_concept_discovery"
    ]

    assert concept_insights
    assert concept_insights[0].metadata_["canonical_name"] == "hybrid retrieval"
    assert concept_insights[0].metadata_["entity_type"] == "method"
    assert concept_insights[0].evidence_refs
    assert concept_articles
    assert concept_articles[0].page_type == "concept"
    assert concept_articles[0].metadata_["candidate_kind"] == "knowledge_entity"
    assert result.run.metadata_["concept_discovery"]["candidate_count"] >= 1


@pytest.mark.asyncio
async def test_concept_discovery_llm_refinement_can_reject_noise(monkeypatch):
    class Record:
        record_type = "source"
        record_id = "src-1"
        title = "Hybrid Retrieval Architecture"
        text = "Hybrid Retrieval is a retrieval method that combines semantic search and keyword filters."

    class FakeCompletions:
        async def create(self, **_kwargs):
            message = MagicMock()
            message.content = '{"entities":[{"canonical_name":"hybrid retrieval","display_name":"Hybrid Retrieval","entity_type":"method","definition":"A retrieval method combining semantic and keyword search.","aliases":["hybrid search"],"should_keep":true,"wiki_recommendation":"new_concept_wiki","confidence":0.9,"reason":"Reusable retrieval method."},{"canonical_name":"retrieval architecture","display_name":"Retrieval Architecture","entity_type":"concept","definition":"","aliases":[],"should_keep":false,"wiki_recommendation":"ignore","confidence":0.2,"reason":"Too broad."}]}'
            choice = MagicMock()
            choice.message = message
            response = MagicMock()
            response.choices = [choice]
            return response

    class FakeClient:
        chat = MagicMock()

    FakeClient.chat.completions = FakeCompletions()

    monkeypatch.setattr(
        "pkg.services.cross_cutting.llm.create_async_client",
        lambda model_id=None, provider_id=None: (FakeClient(), "test-model"),
    )

    candidates = await discover_knowledge_entities(None, user_id="user-1", records=[Record()], use_llm=True)

    names = [candidate.canonical_name for candidate in candidates]
    assert "hybrid retrieval" in names
    assert "retrieval architecture" not in names
    refined = next(candidate for candidate in candidates if candidate.canonical_name == "hybrid retrieval")
    assert refined.entity_type == "method"
    assert refined.definition == "A retrieval method combining semantic and keyword search."
    assert refined.signals["llm_refined"] is True


@pytest.mark.asyncio
async def test_concept_discovery_llm_payload_contains_domain_context(monkeypatch):
    captured: dict[str, object] = {}

    class Record:
        record_type = "source"
        record_id = "src-1"
        title = "Hybrid Retrieval for Agent Memory Systems"
        text = "Hybrid Retrieval is a retrieval method for agent memory systems. Retrieval architecture is too broad."

    class FakeCompletions:
        async def create(self, **kwargs):
            captured["messages"] = kwargs.get("messages")
            message = MagicMock()
            message.content = '{"entities":[{"canonical_name":"hybrid retrieval","display_name":"Hybrid Retrieval","entity_type":"method","definition":"A retrieval method for agent memory systems.","aliases":[],"should_keep":true,"wiki_recommendation":"new_concept_wiki","confidence":0.92,"reason":"Fits the domain context."},{"canonical_name":"retrieval architecture","display_name":"Retrieval Architecture","entity_type":"concept","definition":"","aliases":[],"should_keep":false,"wiki_recommendation":"ignore","confidence":0.2,"reason":"Too generic for the target domain."}]}'
            choice = MagicMock()
            choice.message = message
            response = MagicMock()
            response.choices = [choice]
            return response

    class FakeClient:
        chat = MagicMock()

    FakeClient.chat.completions = FakeCompletions()

    monkeypatch.setattr(
        "pkg.services.cross_cutting.llm.create_async_client",
        lambda model_id=None, provider_id=None: (FakeClient(), "test-model"),
    )

    candidates = await discover_knowledge_entities(None, user_id="user-1", records=[Record()], use_llm=True)

    assert candidates
    messages = captured["messages"]
    assert isinstance(messages, list)
    payload = json.loads(messages[1]["content"])
    assert "target_domain_context" in payload
    assert payload["target_domain_context"]
    assert any("Hybrid Retrieval" in str(item) or "Agent Memory Systems" in str(item) for item in payload["target_domain_context"])
    names = [candidate.canonical_name for candidate in candidates]
    assert "hybrid retrieval" in names
    assert "retrieval architecture" not in names
