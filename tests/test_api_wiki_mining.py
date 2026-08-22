from unittest.mock import AsyncMock, patch

import pytest


def test_pkg_local_wiki_mining_and_update_draft_routes_are_removed():
    from pkg.api.app import app

    retired_prefixes = ("/wiki/mining", "/wiki/update-drafts")
    assert not any(route.path.startswith(retired_prefixes) for route in app.routes)


class TestWikiMiningAPI:
    @pytest.mark.asyncio
    async def test_get_run_not_found(self, mock_session, fake_user):
        from pkg.api.wiki import get_wiki_mining_run

        with patch("pkg.api.wiki.get_wiki_mining_run_detail", new=AsyncMock(return_value=(None, [], []))):
            with pytest.raises(Exception) as exc_info:
                await get_wiki_mining_run(99, user=fake_user, session=mock_session)
            assert getattr(exc_info.value, "status_code", None) == 404
