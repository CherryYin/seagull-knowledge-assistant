from pkg.services.foundation.web_source_roles import (
    WEB_ROLE_ARTICLE,
    WEB_ROLE_COLLECTION_DIRECTORY,
    WEB_ROLE_COLLECTION_FEED,
    WEB_ROLE_PAGE,
    apply_web_source_role,
    infer_web_source_role,
)


def test_infer_web_source_role_supports_explicit_and_legacy_metadata():
    assert infer_web_source_role("web", {}) == WEB_ROLE_PAGE
    assert infer_web_source_role("web", {"rss_enabled": "true"}) == WEB_ROLE_COLLECTION_FEED
    assert infer_web_source_role("web", {"web_directory_enabled": True}) == WEB_ROLE_COLLECTION_DIRECTORY
    assert infer_web_source_role("web", {"feed_source_id": "src-feed"}) == WEB_ROLE_ARTICLE
    assert infer_web_source_role("pdf", {}) is None


def test_apply_web_source_role_keeps_legacy_parent_reference():
    metadata = apply_web_source_role(
        {"feed_source_id": "src-feed"},
        role=WEB_ROLE_ARTICLE,
        origin="rss",
        collection_source_id="src-feed",
    )

    assert metadata["web_role"] == WEB_ROLE_ARTICLE
    assert metadata["origin"] == "rss"
    assert metadata["collection_source_id"] == "src-feed"
    assert metadata["feed_source_id"] == "src-feed"
