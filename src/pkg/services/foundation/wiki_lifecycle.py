from __future__ import annotations

from pkg.models.foundation.wiki import WikiPage


WIKI_STABLE_TAG = "wiki-stable"
WIKI_DRAFT_TAG = "wiki-draft"
WIKI_COMPILED_TAG = "wiki-compiled"
WIKI_LIFECYCLE_STATUSES = {"draft", "stable", "archived"}


def get_wiki_role(page: WikiPage) -> str:
    lifecycle_status = getattr(page, "lifecycle_status", None)
    if lifecycle_status in WIKI_LIFECYCLE_STATUSES:
        return lifecycle_status
    tags = set(page.tags or [])
    if WIKI_DRAFT_TAG in tags:
        return "draft"
    return "stable"


def synchronize_wiki_lifecycle_tags(tags: list[str] | None, lifecycle_status: str) -> list[str]:
    synchronized = [tag for tag in (tags or []) if tag not in {WIKI_DRAFT_TAG, WIKI_STABLE_TAG}]
    if lifecycle_status == "draft":
        return [*synchronized, WIKI_DRAFT_TAG]
    if lifecycle_status == "stable":
        return [*synchronized, WIKI_STABLE_TAG]
    return synchronized


def get_wiki_compile_origin(page: WikiPage) -> str | None:
    tags = set(page.tags or [])
    if "from-memory" in tags:
        return "from-memory"
    if WIKI_COMPILED_TAG in tags:
        return "compiled"
    return None
