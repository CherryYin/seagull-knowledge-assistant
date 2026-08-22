from unittest.mock import AsyncMock, MagicMock

import pytest

from pkg.models.application.asset import Asset
from pkg.services.application.production_memory import record_asset_production_event


@pytest.mark.asyncio
async def test_record_asset_production_event_creates_memory():
    session = AsyncMock()
    scalar_result = MagicMock()
    scalar_result.scalar_one_or_none.return_value = None
    session.execute.return_value = scalar_result
    session.add = MagicMock()

    asset = Asset(
        id="asset-1",
        user_id="user-1",
        asset_type="blog_post",
        status="draft",
        title="Draft",
        brief=None,
        outline=None,
        draft_content=None,
        reference_notes=None,
        editor_feedback=None,
        source_refs=[],
        note_refs=[],
        wiki_refs=[],
        export_format=None,
        exported_at=None,
        published_at=None,
        metadata_={},
    )

    memory = await record_asset_production_event(session, user_id="user-1", asset=asset, event_type="asset_generated")

    assert memory.key == "production_memory"
    assert memory.value["events"][0]["event_type"] == "asset_generated"
