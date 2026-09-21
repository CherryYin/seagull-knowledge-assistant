import base64
import hashlib
import io
import json
from datetime import datetime, timezone

import httpx
import pytest
from PIL import Image

from pkg.models.application.asset import Asset
from pkg.services.application.wechat_publishing import (
    WechatPublishingError,
    _load_inline_image,
    create_wechat_draft,
)


def _asset(*, draft_content: str = "## Main\n\nUseful content with [source](https://example.com/read)") -> Asset:
    return Asset(
        id="asset-1",
        user_id="user-1",
        asset_type="blog_post",
        status="ready_to_export",
        title="A WeChat Draft",
        brief="A concise summary",
        draft_content=draft_content,
        reference_notes="- Source: src-1",
        source_refs=["src-1"],
        note_refs=[],
        wiki_refs=[],
        metadata_={},
        created_at=datetime.now(timezone.utc),
        updated_at=datetime.now(timezone.utc),
    )


def _png_data_url() -> str:
    output = io.BytesIO()
    Image.new("RGB", (4, 4), color=(40, 120, 200)).save(output, format="PNG")
    return "data:image/png;base64," + base64.b64encode(output.getvalue()).decode("ascii")


@pytest.mark.asyncio
async def test_create_wechat_draft_requests_token_and_creates_draft():
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        if request.url.path == "/cgi-bin/token":
            return httpx.Response(200, json={"access_token": "token-1", "expires_in": 7200})
        if request.url.path == "/cgi-bin/draft/add":
            return httpx.Response(200, json={"media_id": "draft-media-1"})
        return httpx.Response(404)

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        receipt = await create_wechat_draft(
            _asset(),
            app_secret="app-secret",
            config={"app_id": "wx-app", "default_thumb_media_id": "cover-media", "author": "Seagull"},
            client=client,
        )

    assert receipt.media_id == "draft-media-1"
    assert len(requests) == 2
    assert requests[0].url.params["appid"] == "wx-app"
    payload = json.loads(requests[1].content)
    article = payload["articles"][0]
    assert article["thumb_media_id"] == "cover-media"
    assert article["author"] == "Seagull"
    assert article["title"] == "A WeChat Draft"
    assert "Useful content" in article["content"]
    assert 'href="https://example.com/read"' in article["content"]
    assert "\\1" not in article["content"]
    assert "EDITORIAL STORY" in article["content"]
    assert "<script" not in article["content"]


@pytest.mark.asyncio
async def test_create_wechat_draft_surfaces_wechat_api_error_without_secret():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"errcode": 40125, "errmsg": "invalid appsecret"})

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        with pytest.raises(WechatPublishingError) as exc:
            await create_wechat_draft(
                _asset(),
                app_secret="sensitive-secret",
                config={"app_id": "wx-app", "default_thumb_media_id": "cover-media"},
                client=client,
            )

    assert "AppSecret is invalid" in str(exc.value)
    assert "sensitive-secret" not in str(exc.value)


@pytest.mark.asyncio
async def test_create_wechat_draft_uploads_inline_data_images_and_replaces_urls():
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        if request.url.path == "/cgi-bin/token":
            return httpx.Response(200, json={"access_token": "token-1"})
        if request.url.path == "/cgi-bin/media/uploadimg":
            return httpx.Response(200, json={"url": "https://mmbiz.qpic.cn/uploaded-image"})
        if request.url.path == "/cgi-bin/draft/add":
            return httpx.Response(200, json={"media_id": "draft-media-1"})
        return httpx.Response(404)

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        receipt = await create_wechat_draft(
            _asset(draft_content=f"![diagram]({_png_data_url()})"),
            app_secret="secret",
            config={"app_id": "wx-app", "default_thumb_media_id": "cover-media"},
            client=client,
        )

    assert receipt.media_id == "draft-media-1"
    assert [request.url.path for request in requests] == [
        "/cgi-bin/token",
        "/cgi-bin/media/uploadimg",
        "/cgi-bin/draft/add",
    ]
    article = json.loads(requests[-1].content)["articles"][0]
    assert 'src="https://mmbiz.qpic.cn/uploaded-image"' in article["content"]
    assert "data:image" not in article["content"]


@pytest.mark.asyncio
async def test_create_wechat_draft_replaces_rendered_mermaid_with_uploaded_image():
    requests: list[httpx.Request] = []
    mermaid_source = "flowchart LR\n  Capture --> Curate\n  Curate --> Publish"
    source_hash = hashlib.sha256(mermaid_source.encode("utf-8")).hexdigest()

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        if request.url.path == "/cgi-bin/token":
            return httpx.Response(200, json={"access_token": "token-1"})
        if request.url.path == "/cgi-bin/media/uploadimg":
            return httpx.Response(200, json={"url": "https://mmbiz.qpic.cn/rendered-mermaid"})
        if request.url.path == "/cgi-bin/draft/add":
            return httpx.Response(200, json={"media_id": "draft-media-1"})
        return httpx.Response(404)

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        await create_wechat_draft(
            _asset(draft_content=f"```mermaid\n{mermaid_source}\n```"),
            app_secret="secret",
            config={"app_id": "wx-app", "default_thumb_media_id": "cover-media"},
            rendered_diagrams={source_hash: _png_data_url()},
            client=client,
        )

    article = json.loads(requests[-1].content)["articles"][0]
    assert 'src="https://mmbiz.qpic.cn/rendered-mermaid"' in article["content"]
    assert "flowchart LR" not in article["content"]
    assert "language-mermaid" not in article["content"]
    assert "data:image" not in article["content"]


@pytest.mark.asyncio
async def test_create_wechat_draft_rejects_private_inline_image_urls():
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/cgi-bin/token":
            return httpx.Response(200, json={"access_token": "token-1"})
        return httpx.Response(500)

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        with pytest.raises(WechatPublishingError) as exc:
            await create_wechat_draft(
                _asset(draft_content="![diagram](http://127.0.0.1/internal.png)"),
                app_secret="secret",
                config={"app_id": "wx-app", "default_thumb_media_id": "cover-media"},
                client=client,
            )

    assert "private or non-public address" in str(exc.value)


@pytest.mark.asyncio
async def test_load_inline_image_rejects_invalid_content_length(monkeypatch: pytest.MonkeyPatch):
    async def allow_public_url(source: str) -> None:
        assert source == "https://images.example.com/diagram.png"

    monkeypatch.setattr(
        "pkg.services.application.wechat_publishing._ensure_public_image_url",
        allow_public_url,
    )

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, headers={"content-length": "unknown"}, content=b"not-used")

    async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
        with pytest.raises(WechatPublishingError) as exc:
            await _load_inline_image("https://images.example.com/diagram.png", client)

    assert "invalid Content-Length" in str(exc.value)
