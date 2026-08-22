from unittest.mock import AsyncMock, patch

import pytest


def test_pkg_local_wiki_mining_creation_route_is_removed():
    from pkg.api.app import app

    assert not any(
        route.path == "/wiki/mining/runs" and "POST" in (route.methods or set())
        for route in app.routes
    )


class TestWikiMiningAPI:
    @pytest.mark.asyncio
    async def test_get_run_not_found(self, mock_session, fake_user):
        from pkg.api.wiki import get_wiki_mining_run

        with patch("pkg.api.wiki.get_wiki_mining_run_detail", new=AsyncMock(return_value=(None, [], []))):
            with pytest.raises(Exception) as exc_info:
                await get_wiki_mining_run(99, user=fake_user, session=mock_session)
            assert getattr(exc_info.value, "status_code", None) == 404
