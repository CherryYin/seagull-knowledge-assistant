"""Tests for RSS fetch metadata handling."""

from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest

from pkg.services.foundation.rss_fetcher import _is_single_topic_feed, _rss_filter_reason, fetch_single_feed


class TestFeedTypeDetection:
    def test_latest_feed_with_different_topic_ids_is_collection(self):
        entries = [
            {"link": "https://linux.do/t/topic/2078023"},
            {"link": "https://linux.do/t/topic/2077996"},
            {"link": "https://linux.do/t/topic/2078060"},
        ]

        assert _is_single_topic_feed(entries) is False

    def test_topic_feed_with_same_topic_id_is_single_topic(self):
        entries = [
            {"link": "https://linux.do/t/some-title/2078023/1"},
            {"link": "https://linux.do/t/some-title/2078023/2"},
            {"link": "https://linux.do/t/some-title/2078023/3"},
        ]

        assert _is_single_topic_feed(entries) is True


class TestRssLowValueFilter:
    def test_filters_non_technical_daily_topic(self):
        reason = _rss_filter_reason("今天有佬友去垃圾桶寻宝么？", "纯日常闲聊，没有技术信息。")

        assert reason == "non_technical_daily_topic"

    def test_keeps_technical_topic_even_with_community_word(self):
        reason = _rss_filter_reason(
            "社区 API 风控怎么解决",
            "讨论 API 调用、风控策略、自动化检测和服务端架构。",
        )

        assert reason is None


class TestFetchSingleFeedMetadata:
    @pytest.mark.asyncio
    async def test_does_not_send_conditional_headers_by_default(self):
        feed_source = MagicMock()
        feed_source.id = "feed-1"
        feed_source.url = "https://example.com/latest.rss"
        feed_source.content_hash = ""
        feed_source.category_id = 1
        feed_source.user_id = "user-1"
        feed_source.metadata_ = {
            "rss_enabled": "true",
            "etag": "abc",
            "last_modified": "Wed, 29 Apr 2026 00:00:00 GMT",
        }

        session = AsyncMock()
        session.execute.return_value = []
        response = httpx.Response(
            200,
            content=b"""
            <rss version="2.0"><channel><title>Example</title>
            <item><title>New item</title><link>https://example.com/a</link><guid>a</guid></item>
            <item><title>New item 2</title><link>https://example.com/b</link><guid>b</guid></item>
            </channel></rss>
            """,
            request=httpx.Request("GET", feed_source.url),
        )

        with patch("pkg.services.foundation.rss_fetcher.httpx.AsyncClient") as mock_client_cls:
            mock_client = AsyncMock()
            mock_client.get.return_value = response
            mock_client_cls.return_value.__aenter__.return_value = mock_client
            mock_client_cls.return_value.__aexit__ = AsyncMock(return_value=False)
            with patch("pkg.api.sources.persist_source", new_callable=AsyncMock):
                await fetch_single_feed(feed_source, session)

        headers = mock_client.get.await_args_list[0].kwargs["headers"]
        assert "If-None-Match" not in headers
        assert "If-Modified-Since" not in headers

    @pytest.mark.asyncio
    async def test_commits_not_modified_status(self):
        feed_source = MagicMock()
        feed_source.id = "feed-1"
        feed_source.url = "https://example.com/latest.rss"
        feed_source.metadata_ = {"rss_enabled": "true", "etag": "abc"}

        session = AsyncMock()
        response = httpx.Response(304, request=httpx.Request("GET", feed_source.url))

        with patch("pkg.services.foundation.rss_fetcher.httpx.AsyncClient") as mock_client_cls:
            mock_client = AsyncMock()
            mock_client.get.return_value = response
            mock_client_cls.return_value.__aenter__.return_value = mock_client
            mock_client_cls.return_value.__aexit__ = AsyncMock(return_value=False)

            count = await fetch_single_feed(feed_source, session)

        assert count == 0
        assert feed_source.metadata_["last_fetch_status"] == "not_modified"
        assert feed_source.metadata_["http_status"] == 304
        assert "last_fetch_at" in feed_source.metadata_
        session.commit.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_commits_http_error_status(self):
        feed_source = MagicMock()
        feed_source.id = "feed-1"
        feed_source.url = "https://example.com/latest.rss"
        feed_source.metadata_ = {"rss_enabled": "true"}

        session = AsyncMock()
        response = httpx.Response(503, request=httpx.Request("GET", feed_source.url))

        with patch("pkg.services.foundation.rss_fetcher.httpx.AsyncClient") as mock_client_cls:
            mock_client = AsyncMock()
            mock_client.get.return_value = response
            mock_client_cls.return_value.__aenter__.return_value = mock_client
            mock_client_cls.return_value.__aexit__ = AsyncMock(return_value=False)

            count = await fetch_single_feed(feed_source, session)

        assert count == 0
        assert feed_source.metadata_["last_fetch_status"] == "error"
        assert feed_source.metadata_["http_status"] == 503
        assert "last_fetch_at" in feed_source.metadata_
        session.commit.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_filters_low_value_collection_entries_before_persist(self):
        feed_source = MagicMock()
        feed_source.id = "feed-1"
        feed_source.url = "https://example.com/latest.rss"
        feed_source.content_hash = ""
        feed_source.category_id = 1
        feed_source.user_id = "user-1"
        feed_source.metadata_ = {"rss_enabled": "true"}

        session = AsyncMock()
        session.execute.return_value = []
        feed_xml = """
            <rss version="2.0"><channel><title>Example</title>
            <item><title>今天有佬友去垃圾桶寻宝么？</title><link>https://example.com/a</link><guid>a</guid><description>纯日常闲聊，没有技术信息。</description></item>
            <item><title>Python API 性能优化</title><link>https://example.com/b</link><guid>b</guid><description>讨论 Python API 架构、缓存和数据库优化。</description></item>
            </channel></rss>
            """
        response = httpx.Response(
            200,
            content=feed_xml.encode("utf-8"),
            request=httpx.Request("GET", feed_source.url),
        )

        with patch("pkg.services.foundation.rss_fetcher.httpx.AsyncClient") as mock_client_cls:
            mock_client = AsyncMock()
            mock_client.get.return_value = response
            mock_client_cls.return_value.__aenter__.return_value = mock_client
            mock_client_cls.return_value.__aexit__ = AsyncMock(return_value=False)
            with patch("pkg.api.sources.persist_source", new_callable=AsyncMock) as mock_persist:
                count = await fetch_single_feed(feed_source, session)

        assert count == 1
        assert feed_source.metadata_["last_filtered_count"] == 1
        mock_persist.assert_awaited_once()
