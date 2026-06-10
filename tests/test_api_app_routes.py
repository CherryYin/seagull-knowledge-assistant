from pkg.api.app import app


def test_assets_routes_are_registered():
    paths = {route.path for route in app.routes}

    assert "/assets" in paths
    assert "/assets/{asset_id}" in paths
    assert "/assets/{asset_id}/generate-outline" in paths
    assert "/assets/{asset_id}/generate-draft" in paths
    assert "/assets/{asset_id}/attach-references" in paths
    assert "/assets/{asset_id}/check-readiness" in paths
    assert "/assets/{asset_id}/export/markdown" in paths
    assert "/assets/{asset_id}/publish-feedback" in paths
    assert "/assets/{asset_id}/feedback-to-note" in paths
