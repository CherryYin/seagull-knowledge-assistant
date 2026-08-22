from pkg.api.app import app


def test_assets_routes_are_registered():
    paths = {route.path for route in app.routes}
    methods_by_path = {route.path: getattr(route, "methods", set()) for route in app.routes}

    assert "/assets" in paths
    assert "/assets/newsletter/recent-sources" in paths
    assert "/assets/{asset_id}" in paths
    assert "DELETE" in methods_by_path["/assets/{asset_id}"]
    assert "/assets/{asset_id}/generate-outline" in paths
    assert "/assets/{asset_id}/generate-draft" in paths
    assert "/assets/{asset_id}/attach-references" in paths
    assert "/assets/{asset_id}/check-readiness" in paths
    assert "/assets/{asset_id}/export/markdown" in paths
    assert "/assets/{asset_id}/publish-feedback" in paths
    assert "/assets/{asset_id}/feedback-to-note" in paths


def test_legacy_agent_persistence_routes_are_not_registered():
    paths = {route.path for route in app.routes}

    assert "/knowledge/save-document" not in paths
    assert "/knowledge/remember" not in paths
    assert "/knowledge/summarize-daily" not in paths
