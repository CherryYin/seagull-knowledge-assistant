from unittest.mock import AsyncMock, patch

import httpx
import pytest

from pkg.services.foundation.web_extractor import WebPageFetchError, _extract_text, _extract_title, _format_readable_text, fetch_web_page


class TestWebExtractorFallback:
    def test_extracts_title_and_readable_text_without_optional_dependency(self):
        html = """
        <html>
          <head><title>Dynamic workflows in Claude Code</title><style>.x{}</style></head>
          <body>
            <script>ignored()</script>
            <main>
              <h1>Introducing dynamic workflows</h1>
              <p>Claude Code now supports dynamic workflows for agentic tasks.</p>
            </main>
          </body>
        </html>
        """

        assert _extract_title(html, url="https://example.com") == "Dynamic workflows in Claude Code"
        text = _extract_text(html, url="https://example.com")
        assert "Introducing dynamic workflows" in text
        assert "Claude Code now supports dynamic workflows" in text
        assert "Introducing dynamic workflows\n\nClaude Code now supports" in text
        assert "ignored" not in text

    def test_format_readable_text_preserves_paragraph_breaks(self):
        text = _format_readable_text("Title\n\nFirst paragraph line.\ncontinues.\n\nSecond paragraph.")

        assert text == "Title\n\nFirst paragraph line. continues.\n\nSecond paragraph."

    def test_claude_blog_fallback_keeps_article_and_removes_page_chrome(self):
        html = """
        <html><head><title>Introducing dynamic workflows | Claude</title></head><body>
          <nav>Meet Claude Products Pricing Contact sales Try Claude</nav>
          <main>
            <div>Blog / Introducing dynamic workflows in Claude Code</div>
            <h1>Introducing dynamic workflows in Claude Code</h1>
            <div>Category Product announcements</div>
            <p>Today we're introducing dynamic workflows in Claude Code, helping Claude take on the most challenging tasks end-to-end.</p>
            <h2>Dynamic workflows in action</h2>
            <p>Early access users and teams inside Anthropic have been using dynamic workflows.</p>
            <h2>FAQ</h2>
            <p>No items found.</p>
          </main>
          <footer>Related posts Contact sales Cookie settings</footer>
        </body></html>
        """

        text = _extract_text(html, url="https://claude.com/blog/introducing-dynamic-workflows-in-claude-code")

        assert text.startswith("Introducing dynamic workflows in Claude Code")
        assert "Today we're introducing dynamic workflows" in text
        assert "\n\nDynamic workflows in action\n\n" in text
        assert "Meet Claude Products" not in text
        assert "Related posts" not in text
        assert "Cookie settings" not in text
        assert "No items found" not in text

    def test_docs_fallback_prefers_main_article_and_filters_api_navigation_noise(self):
        html = """
        <html><head><title>transforms.api • Overview • Palantir</title></head><body>
          <header>API Reference Search User Documentation Send feedback</header>
          <nav>Index Libraries Transforms REST API Python transforms-python transforms.api Overview</nav>
          <main>
            <article>
              <h1>transforms.api</h1>
              <p>The Transforms Python API provides classes and decorators for constructing a Pipeline.</p>
              <h2>Functions</h2>
              <p>configure modifies the configuration of a Spark transform.</p>
              <p>transform_df registers the wrapped compute function as a DataFrame transform.</p>
            </article>
          </main>
          <aside>BooleanParam Check ComputeBackend ContainerTransform</aside>
          <footer>© 2026 Palantir Technologies Inc. All rights reserved. Cookies Statement Privacy Statement Terms of Use Cookie Settings</footer>
        </body></html>
        """

        text = _extract_text(html, url="https://www.palantir.com/docs/foundry/ontology/transforms/api")

        assert text is not None
        assert text.startswith("transforms.api")
        assert "The Transforms Python API provides classes and decorators" in text
        assert "configure modifies the configuration" in text
        assert "API Reference Search" not in text
        assert "Index Libraries Transforms" not in text
        assert "Cookies Statement" not in text
        assert "All rights reserved" not in text


class TestFetchWebPage:
    @pytest.mark.asyncio
    async def test_rejects_non_http_url(self):
        with pytest.raises(WebPageFetchError, match="http"):
            await fetch_web_page("file:///tmp/a.html")

    @pytest.mark.asyncio
    async def test_fetches_html_and_records_metadata(self):
        url = "https://claude.com/blog/introducing-dynamic-workflows-in-claude-code"
        html = """
        <html><head><title>Introducing dynamic workflows in Claude Code</title></head>
        <body><article><p>Dynamic workflows article content.</p></article></body></html>
        """
        response = httpx.Response(
            200,
            content=html.encode(),
            headers={"content-type": "text/html; charset=utf-8", "last-modified": "Wed, 28 May 2026 00:00:00 GMT"},
            request=httpx.Request("GET", url),
        )

        with patch("pkg.services.foundation.web_extractor.httpx.AsyncClient") as mock_client_cls:
            mock_client = AsyncMock()
            mock_client.get.return_value = response
            mock_client_cls.return_value.__aenter__.return_value = mock_client
            mock_client_cls.return_value.__aexit__ = AsyncMock(return_value=False)

            result = await fetch_web_page(url)

        assert result.final_url == url
        assert result.title == "Introducing dynamic workflows in Claude Code"
        assert "Dynamic workflows article content" in result.text
        assert result.metadata["web_fetch_status"] == "fetched"
        assert result.metadata["web_fetch_status_code"] == 200
        assert result.metadata["web_fetch_updated_at"] == "Wed, 28 May 2026 00:00:00 GMT"

    @pytest.mark.asyncio
    async def test_http_error_preserves_status(self):
        url = "https://example.com/missing"
        response = httpx.Response(404, request=httpx.Request("GET", url))

        with patch("pkg.services.foundation.web_extractor.httpx.AsyncClient") as mock_client_cls:
            mock_client = AsyncMock()
            mock_client.get.return_value = response
            mock_client_cls.return_value.__aenter__.return_value = mock_client
            mock_client_cls.return_value.__aexit__ = AsyncMock(return_value=False)

            with pytest.raises(WebPageFetchError, match="HTTP 404"):
                await fetch_web_page(url)
