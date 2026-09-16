from collections.abc import Mapping


WEB_ROLE_PAGE = "page"
WEB_ROLE_COLLECTION_FEED = "collection_feed"
WEB_ROLE_COLLECTION_DIRECTORY = "collection_directory"
WEB_ROLE_ARTICLE = "article"
WEB_SOURCE_ROLES = {
    WEB_ROLE_PAGE,
    WEB_ROLE_COLLECTION_FEED,
    WEB_ROLE_COLLECTION_DIRECTORY,
    WEB_ROLE_ARTICLE,
}


def _is_true(value: object) -> bool:
    return value is True or str(value).strip().lower() == "true"


def infer_web_source_role(source_type: str, metadata: Mapping[str, object] | None) -> str | None:
    if source_type not in {"web", "article"}:
        return None

    metadata = metadata or {}
    explicit_role = str(metadata.get("web_role") or "").strip()
    if explicit_role in WEB_SOURCE_ROLES:
        return explicit_role
    if metadata.get("collection_source_id") or metadata.get("feed_source_id"):
        return WEB_ROLE_ARTICLE
    if _is_true(metadata.get("rss_enabled")):
        return WEB_ROLE_COLLECTION_FEED
    if _is_true(metadata.get("web_directory_enabled")) or _is_true(metadata.get("web_directory")):
        return WEB_ROLE_COLLECTION_DIRECTORY
    if source_type == "web":
        return WEB_ROLE_PAGE
    return None


def apply_web_source_role(
    metadata: Mapping[str, object] | None,
    *,
    role: str,
    origin: str | None = None,
    collection_source_id: str | None = None,
) -> dict:
    if role not in WEB_SOURCE_ROLES:
        raise ValueError(f"Unknown Web Source role: {role}")
    result = dict(metadata or {})
    result["web_role"] = role
    if origin:
        result["origin"] = origin
    if collection_source_id:
        result["collection_source_id"] = collection_source_id
    return result
