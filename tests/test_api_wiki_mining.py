def test_pkg_local_wiki_mining_and_update_draft_routes_are_removed():
    from pkg.api.app import app

    retired_prefixes = ("/wiki/mining", "/wiki/update-drafts")
    assert not any(route.path.startswith(retired_prefixes) for route in app.routes)
