from pkg.api.app import app


def test_assets_routes_are_registered():
    paths = {route.path for route in app.routes}
    methods_by_path = {route.path: getattr(route, "methods", set()) for route in app.routes}

    assert "/assets" in paths
    assert "/assets/newsletter/recent-sources" not in paths
    assert "/assets/{asset_id}" in paths
    assert "DELETE" in methods_by_path["/assets/{asset_id}"]
    assert "/assets/{asset_id}/generate-outline" not in paths
    assert "/assets/{asset_id}/generate-draft" not in paths
    assert "/assets/{asset_id}/attach-references" in paths
    assert "/assets/{asset_id}/check-readiness" in paths
    assert "/assets/{asset_id}/export/markdown" in paths
    assert "/assets/{asset_id}/publish-feedback" in paths
    assert "/assets/{asset_id}/publish/wechat-draft" in paths
    assert "/assets/{asset_id}/preview/wechat" in paths
    wechat_preview_methods = set().union(
        *(getattr(route, "methods", set()) for route in app.routes if route.path == "/assets/{asset_id}/preview/wechat")
    )
    assert {"GET", "POST"}.issubset(wechat_preview_methods)
    assert "/assets/{asset_id}/feedback-to-note" in paths


def test_legacy_agent_persistence_routes_are_not_registered():
    paths = {route.path for route in app.routes}

    assert "/knowledge/save-document" not in paths
    assert "/knowledge/remember" not in paths
    assert "/knowledge/summarize-daily" not in paths


def test_wechat_cover_upload_route_is_registered():
    methods_by_path = {route.path: getattr(route, "methods", set()) for route in app.routes}

    path = "/auth/me/api-credentials/{credential_id}/wechat-cover"
    assert path in methods_by_path
    assert "POST" in methods_by_path[path]


def test_wiki_compile_route_is_not_registered():
    paths = {route.path for route in app.routes}

    assert "/wiki/compile" not in paths
