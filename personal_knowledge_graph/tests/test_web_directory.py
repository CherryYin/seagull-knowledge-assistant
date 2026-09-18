import hashlib
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from pkg.services.foundation.web_directory import discover_article_links, import_web_directory_articles
from pkg.services.foundation.web_extractor import WebPageFetchResult


def test_discover_article_links_keeps_same_blog_articles_only():
    html = """
    <a href="/blog/introducing-dynamic-workflows-in-claude-code">Dynamic workflows</a>
    <a href="https://claude.com/blog/new-in-claude-managed-agents">Managed Agents</a>
    <a href="/pricing">Pricing</a>
    <a href="/blog">Blog home</a>
    <a href="https://example.com/blog/other">Other domain</a>
    <a href="/blog/introducing-dynamic-workflows-in-claude-code#comments">Duplicate</a>
    """

    links = discover_article_links(html, directory_url="https://claude.com/blog")

    assert links == [
        "https://claude.com/blog/introducing-dynamic-workflows-in-claude-code",
        "https://claude.com/blog/new-in-claude-managed-agents",
    ]


def test_discover_article_links_supports_docs_subpages_with_noise_filtered():
    html = """
    <a href="/docs/foundry/ontology/object-types">Object types</a>
    <a href="/docs/foundry/ontology/action-types">Action types</a>
    <a href="/docs/foundry/ontology#top">Anchor only</a>
    <a href="/docs/foundry/ontology/overview">Overview page</a>
    <a href="/docs/foundry/platform/ontology-sdk">Sibling docs page</a>
    <a href="/docs/foundry/ontology/page/2">Pagination</a>
    <a href="https://www.palantir.com/docs/foundry/ontology/object-types">Duplicate absolute</a>
    <a href="https://www.palantir.com/blog">Blog</a>
    """

    links = discover_article_links(html, directory_url="https://www.palantir.com/docs/foundry/ontology")

    assert links == [
        "https://www.palantir.com/docs/foundry/ontology/object-types",
        "https://www.palantir.com/docs/foundry/ontology/action-types",
    ]


def test_discover_article_links_prefers_main_content_over_nav_noise():
    html = """
    <nav>
      <a href="/docs/foundry/ontology/overview">Overview</a>
      <a href="/docs/foundry/ontology/object-types">Object types nav</a>
    </nav>
    <main>
      <article>
        <a href="/docs/foundry/ontology/object-types">Object types body</a>
        <a href="/docs/foundry/ontology/action-types">Action types body</a>
      </article>
    </main>
    <footer>
      <a href="/docs/foundry/ontology/next">Next</a>
    </footer>
    """

    links = discover_article_links(html, directory_url="https://www.palantir.com/docs/foundry/ontology")

    assert links == [
        "https://www.palantir.com/docs/foundry/ontology/object-types",
        "https://www.palantir.com/docs/foundry/ontology/action-types",
    ]


@pytest.mark.asyncio
async def test_import_web_directory_articles_persists_children():
    session = AsyncMock()
    parent = MagicMock()
    parent.id = "src-claude-blog"
    parent.user_id = "user-1"
    parent.category_id = 1
    parent.url = "https://claude.com/blog"
    empty_rows = MagicMock()
    empty_rows.scalar_one_or_none.return_value = None
    session.execute.return_value = empty_rows

    page = WebPageFetchResult(
        url="https://claude.com/blog/introducing-dynamic-workflows-in-claude-code",
        final_url="https://claude.com/blog/introducing-dynamic-workflows-in-claude-code",
        title="Introducing dynamic workflows in Claude Code",
        text="Article body",
        metadata={"web_fetch_status": "fetched"},
    )

    persisted = []

    async def fake_persist_source(**kwargs):
        persisted.append(kwargs)

    with (
        patch(
            "pkg.services.foundation.web_directory.fetch_directory_article_links",
            new=AsyncMock(return_value=[page.final_url]),
        ),
        patch("pkg.services.foundation.web_directory.fetch_web_page", new=AsyncMock(return_value=page)),
        patch("pkg.api.sources.persist_source", new=AsyncMock(side_effect=fake_persist_source)),
    ):
        result = await import_web_directory_articles(session, parent, limit=10)

    assert result.discovered == 1
    assert result.imported == 1
    assert result.updated == 0
    assert result.skipped == 0
    body = persisted[0]["body"]
    assert body.title == "Introducing dynamic workflows in Claude Code"
    assert body.metadata["feed_source_id"] == "src-claude-blog"
    assert body.metadata["content_source"] == "web_directory"
    assert body.metadata["web_role"] == "article"
    assert body.metadata["origin"] == "web_directory"
    assert body.metadata["collection_source_id"] == "src-claude-blog"
    assert body.metadata["review_status"] == "imported_reviewable"


@pytest.mark.asyncio
async def test_import_web_directory_articles_skips_same_updated_article():
    session = AsyncMock()
    parent = MagicMock()
    parent.id = "src-claude-blog"
    parent.user_id = "user-1"
    parent.category_id = 1
    parent.url = "https://claude.com/blog"

    article_url = "https://claude.com/blog/introducing-dynamic-workflows-in-claude-code"
    page = WebPageFetchResult(
        url=article_url,
        final_url=article_url,
        title="Introducing dynamic workflows in Claude Code",
        text="Article body",
        metadata={"web_fetch_status": "fetched", "web_fetch_updated_at": "2026-05-28T00:00:00Z"},
    )
    existing = MagicMock()
    existing.content_hash = hashlib.sha256(page.text.encode()).hexdigest()
    existing.metadata_ = {
        "feed_source_id": "src-claude-blog",
        "article_url": article_url,
        "web_fetch_updated_at": "2026-05-28T00:00:00Z",
    }
    existing_rows = MagicMock()
    existing_rows.scalar_one_or_none.return_value = existing
    session.execute.return_value = existing_rows

    with (
        patch("pkg.services.foundation.web_directory.fetch_directory_article_links", new=AsyncMock(return_value=[article_url])),
        patch("pkg.services.foundation.web_directory.fetch_web_page", new=AsyncMock(return_value=page)),
        patch("pkg.api.sources.persist_source", new=AsyncMock()) as mock_persist,
        patch("pkg.services.foundation.rss_fetcher._update_source_content", new=AsyncMock()) as mock_update,
    ):
        result = await import_web_directory_articles(session, parent, limit=10)

    assert result.discovered == 1
    assert result.imported == 0
    assert result.updated == 0
    assert result.skipped == 1
    mock_persist.assert_not_called()
    mock_update.assert_not_called()


@pytest.mark.asyncio
async def test_import_web_directory_articles_updates_changed_article_when_updated_at_is_unchanged():
    session = AsyncMock()
    parent = MagicMock()
    parent.id = "src-claude-blog"
    parent.user_id = "user-1"
    parent.category_id = 1
    parent.url = "https://claude.com/blog"

    article_url = "https://claude.com/blog/introducing-dynamic-workflows-in-claude-code"
    page = WebPageFetchResult(
        url=article_url,
        final_url=article_url,
        title="Introducing dynamic workflows in Claude Code",
        text="New article body",
        metadata={"web_fetch_status": "fetched", "web_fetch_updated_at": "2026-05-28T00:00:00Z"},
    )
    existing = MagicMock()
    existing.title = "Old title"
    existing.content_hash = "old-hash"
    existing.metadata_ = {
        "feed_source_id": "src-claude-blog",
        "article_url": article_url,
        "web_fetch_updated_at": "2026-05-28T00:00:00Z",
    }
    existing_rows = MagicMock()
    existing_rows.scalar_one_or_none.return_value = existing
    session.execute.return_value = existing_rows

    with (
        patch("pkg.services.foundation.web_directory.fetch_directory_article_links", new=AsyncMock(return_value=[article_url])),
        patch("pkg.services.foundation.web_directory.fetch_web_page", new=AsyncMock(return_value=page)),
        patch("pkg.api.sources.persist_source", new=AsyncMock()) as mock_persist,
        patch("pkg.services.foundation.rss_fetcher._update_source_content", new=AsyncMock()) as mock_update,
    ):
        result = await import_web_directory_articles(session, parent, limit=10)

    assert result.discovered == 1
    assert result.imported == 0
    assert result.updated == 1
    assert result.skipped == 0
    assert existing.title == "Introducing dynamic workflows in Claude Code"
    assert existing.metadata_["web_fetch_updated_at"] == "2026-05-28T00:00:00Z"
    mock_persist.assert_not_called()
    mock_update.assert_awaited_once_with(existing, "New article body", session)
