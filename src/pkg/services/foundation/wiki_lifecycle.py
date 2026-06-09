from __future__ import annotations

from pkg.models.foundation.wiki import WikiPage


WIKI_STABLE_TAG = "wiki-stable"
WIKI_DRAFT_TAG = "wiki-draft"
WIKI_COMPILED_TAG = "wiki-compiled"


def get_wiki_role(page: WikiPage) -> str:
    tags = set(page.tags or [])
    if WIKI_DRAFT_TAG in tags:
        return "draft"
    return "stable"


def get_wiki_compile_origin(page: WikiPage) -> str | None:
    tags = set(page.tags or [])
    if "from-memory" in tags:
        return "from-memory"
    if WIKI_COMPILED_TAG in tags:
        return "compiled"
    return None
