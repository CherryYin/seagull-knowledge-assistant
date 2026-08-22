from datetime import datetime, timezone

import pytest

from pkg.models.foundation.note import Note
from pkg.models.foundation.source import Source
from pkg.models.foundation.wiki import WikiPage


class TestWikiReferenceResolveAPI:
    @pytest.mark.asyncio
    async def test_resolve_references(self, mock_session, fake_user):
        from pkg.api.wiki import resolve_wiki_references
        from pkg.schemas.reference import ReferenceResolveRequest

        now = datetime(2026, 6, 8, tzinfo=timezone.utc)
        source = Source(
            id="src-1",
            user_id=fake_user.id,
            is_shared=False,
            category_id=1,
            title="Source 1",
            source_type="web",
            url="https://example.com",
            content_hash=None,
            raw_content="content",
            file_path=None,
            ingested_at=now,
            metadata_={},
        )
        note = Note(
            id="note-1",
            user_id=fake_user.id,
            category_id=1,
            title="Note 1",
            note_type="inbox",
            domains=[],
            tags=[],
            abstract=None,
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
        wiki = WikiPage(
            id="wiki-1",
            user_id=fake_user.id,
            title="Wiki 1",
            page_type="topic",
            summary="summary",
            content="content",
            domains=[],
            tags=[],
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

        async def fake_get(model, ident):
            mapping = {
                (Source, "src-1"): source,
                (Note, "note-1"): note,
                (WikiPage, "wiki-1"): wiki,
            }
            return mapping.get((model, ident))

        mock_session.get.side_effect = fake_get

        result = await resolve_wiki_references(
            ReferenceResolveRequest(
                refs=[
                    {"ref_type": "source", "ref_id": "src-1", "excerpt": "excerpt"},
                    {"ref_type": "note", "ref_id": "note-1"},
                    {"ref_type": "memory", "ref_id": "mem-1"},
                    {"ref_type": "wiki", "ref_id": "wiki-1"},
                ]
            ),
            user=fake_user,
            session=mock_session,
        )

        assert len(result.items) == 4
        assert result.items[0].title == "Source 1"
        assert result.items[0].href == "/sources/src-1"
        assert result.items[2].title == "mem-1"
        assert result.items[2].href is None
        assert result.items[3].status == "stable"
