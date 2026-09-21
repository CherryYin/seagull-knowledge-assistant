from __future__ import annotations

import asyncio
import base64
from dataclasses import dataclass
from datetime import datetime, timezone
import io
import ipaddress
import re
import socket
from typing import Any
from urllib.parse import urlsplit

import httpx
from PIL import Image, UnidentifiedImageError

from pkg.models.application.asset import Asset
from pkg.services.application.blog_generation import export_wechat_html

WECHAT_API_BASE = "https://api.weixin.qq.com"
MAX_INLINE_IMAGE_BYTES = 5_000_000
MAX_INLINE_IMAGE_PIXELS = 24_000_000
INLINE_IMAGE_PATTERN = re.compile(r'(<img\b[^>]*?\bsrc=")([^"]+)("[^>]*>)', re.IGNORECASE)


class WechatPublishingError(RuntimeError):
    pass


@dataclass(frozen=True)
class WechatDraftReceipt:
    media_id: str
    sent_at: datetime


def _required_config(config: dict[str, Any], key: str, label: str) -> str:
    value = str(config.get(key) or "").strip()
    if not value:
        raise WechatPublishingError(f"WeChat credential requires {label}")
    return value


def _wechat_error(payload: dict[str, Any], *, operation: str) -> WechatPublishingError:
    code = payload.get("errcode")
    message = str(payload.get("errmsg") or "unknown error")
    friendly = {
        40013: "AppID is invalid",
        40125: "AppSecret is invalid",
        40164: "the PKG server IP is not in the WeChat API allowlist",
        48001: "this Official Account is not authorized to use the requested API",
    }.get(code)
    detail = friendly or message
    return WechatPublishingError(f"WeChat {operation} failed ({code}): {detail}")


async def _response_json(response: httpx.Response, *, operation: str) -> dict[str, Any]:
    try:
        response.raise_for_status()
        payload = response.json()
    except (httpx.HTTPError, ValueError) as exc:
        raise WechatPublishingError(f"WeChat {operation} request failed") from exc
    if not isinstance(payload, dict):
        raise WechatPublishingError(f"WeChat {operation} returned an invalid response")
    if payload.get("errcode") not in (None, 0):
        raise _wechat_error(payload, operation=operation)
    return payload


def _normalize_image(payload: bytes) -> tuple[bytes, str, str]:
    if len(payload) > MAX_INLINE_IMAGE_BYTES:
        raise WechatPublishingError("Inline image exceeds the 5 MB upload limit")
    try:
        with Image.open(io.BytesIO(payload)) as image:
            if image.width * image.height > MAX_INLINE_IMAGE_PIXELS:
                raise WechatPublishingError("Inline image dimensions are too large")
            image.load()
            if image.mode in {"RGBA", "LA"} or "transparency" in image.info:
                normalized = image.convert("RGBA")
                output = io.BytesIO()
                normalized.save(output, format="PNG", optimize=True)
                return output.getvalue(), "image/png", "article-image.png"
            normalized = image.convert("RGB")
            output = io.BytesIO()
            normalized.save(output, format="JPEG", quality=90, optimize=True)
            return output.getvalue(), "image/jpeg", "article-image.jpg"
    except (UnidentifiedImageError, OSError) as exc:
        raise WechatPublishingError("Inline image is not a valid supported image") from exc


def _decode_data_image(source: str) -> bytes:
    match = re.fullmatch(r"data:image/(?:png|jpeg|jpg|gif|webp);base64,([A-Za-z0-9+/=\s]+)", source, re.IGNORECASE)
    if not match:
        raise WechatPublishingError("Inline data image must be a base64 PNG, JPEG, GIF, or WebP image")
    try:
        payload = base64.b64decode(match.group(1), validate=True)
    except ValueError as exc:
        raise WechatPublishingError("Inline data image is not valid base64") from exc
    return payload


async def _ensure_public_image_url(source: str) -> None:
    parsed = urlsplit(source)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise WechatPublishingError("Inline image URLs must use public HTTP or HTTPS URLs")
    try:
        literal_ip = ipaddress.ip_address(parsed.hostname)
    except ValueError:
        literal_ip = None
    if literal_ip is not None:
        if not literal_ip.is_global:
            raise WechatPublishingError("Inline image URL resolves to a private or non-public address")
        return
    try:
        addresses = await asyncio.wait_for(
            asyncio.to_thread(
                socket.getaddrinfo,
                parsed.hostname,
                parsed.port or (443 if parsed.scheme == "https" else 80),
            ),
            timeout=3,
        )
    except (socket.gaierror, TimeoutError) as exc:
        raise WechatPublishingError("Inline image host could not be resolved") from exc
    for address in addresses:
        ip = ipaddress.ip_address(address[4][0])
        if not ip.is_global:
            raise WechatPublishingError("Inline image URL resolves to a private or non-public address")


async def _load_inline_image(source: str, client: httpx.AsyncClient) -> tuple[bytes, str, str]:
    if source.startswith("data:image/"):
        return _normalize_image(_decode_data_image(source))
    await _ensure_public_image_url(source)
    try:
        response = await client.get(
            source,
            headers={"User-Agent": "Seagull-WeChat-Publisher/1.0"},
            follow_redirects=False,
        )
        response.raise_for_status()
    except httpx.HTTPError as exc:
        raise WechatPublishingError("Inline image download failed") from exc
    if 300 <= response.status_code < 400:
        raise WechatPublishingError("Inline image redirects are not allowed")
    content_length = response.headers.get("content-length")
    if content_length:
        try:
            declared_size = int(content_length)
        except ValueError as exc:
            raise WechatPublishingError("Inline image response has an invalid Content-Length") from exc
        if declared_size < 0:
            raise WechatPublishingError("Inline image response has an invalid Content-Length")
        if declared_size > MAX_INLINE_IMAGE_BYTES:
            raise WechatPublishingError("Inline image exceeds the 5 MB upload limit")
    return _normalize_image(response.content)


async def _upload_inline_image(
    source: str,
    *,
    access_token: str,
    client: httpx.AsyncClient,
) -> str:
    payload, content_type, filename = await _load_inline_image(source, client)
    response = await client.post(
        f"{WECHAT_API_BASE}/cgi-bin/media/uploadimg",
        params={"access_token": access_token},
        files={"media": (filename, payload, content_type)},
    )
    result = await _response_json(response, operation="inline image upload")
    uploaded_url = str(result.get("url") or "").strip()
    if not uploaded_url:
        raise WechatPublishingError("WeChat inline image response did not include url")
    return uploaded_url


async def _upload_content_images(content: str, *, access_token: str, client: httpx.AsyncClient) -> str:
    sources = list(dict.fromkeys(match.group(2) for match in INLINE_IMAGE_PATTERN.finditer(content)))
    replacements: dict[str, str] = {}
    for source in sources:
        replacements[source] = await _upload_inline_image(source, access_token=access_token, client=client)
    return INLINE_IMAGE_PATTERN.sub(
        lambda match: f'{match.group(1)}{replacements.get(match.group(2), match.group(2))}{match.group(3)}',
        content,
    )


async def create_wechat_draft(
    asset: Asset,
    *,
    app_secret: str,
    config: dict[str, Any],
    author: str | None = None,
    digest: str | None = None,
    content_source_url: str | None = None,
    thumb_media_id: str | None = None,
    rendered_diagrams: dict[str, str] | None = None,
    client: httpx.AsyncClient | None = None,
) -> WechatDraftReceipt:
    app_id = _required_config(config, "app_id", "AppID")
    cover_media_id = (thumb_media_id or str(config.get("default_thumb_media_id") or "")).strip()
    if not cover_media_id:
        raise WechatPublishingError("WeChat credential requires a default cover media ID")
    resolved_author = (author or str(config.get("author") or "")).strip()
    resolved_digest = (digest or asset.brief or "").strip()[:120]
    resolved_source_url = (content_source_url or str(config.get("content_source_url") or "")).strip()
    content = export_wechat_html(asset, rendered_diagrams=rendered_diagrams)
    if not content.strip():
        raise WechatPublishingError("Asset has no content to send to WeChat")

    owns_client = client is None
    http_client = client or httpx.AsyncClient(timeout=30)
    try:
        token_response = await http_client.get(
            f"{WECHAT_API_BASE}/cgi-bin/token",
            params={"grant_type": "client_credential", "appid": app_id, "secret": app_secret},
        )
        token_payload = await _response_json(token_response, operation="access token")
        access_token = str(token_payload.get("access_token") or "").strip()
        if not access_token:
            raise WechatPublishingError("WeChat access token response did not include access_token")

        content = await _upload_content_images(content, access_token=access_token, client=http_client)

        article = {
            "title": asset.title.strip(),
            "author": resolved_author,
            "digest": resolved_digest,
            "content": content,
            "content_source_url": resolved_source_url,
            "thumb_media_id": cover_media_id,
            "need_open_comment": 0,
            "only_fans_can_comment": 0,
        }
        draft_response = await http_client.post(
            f"{WECHAT_API_BASE}/cgi-bin/draft/add",
            params={"access_token": access_token},
            json={"articles": [article]},
        )
        draft_payload = await _response_json(draft_response, operation="draft creation")
        media_id = str(draft_payload.get("media_id") or "").strip()
        if not media_id:
            raise WechatPublishingError("WeChat draft response did not include media_id")
        return WechatDraftReceipt(media_id=media_id, sent_at=datetime.now(timezone.utc))
    finally:
        if owns_client:
            await http_client.aclose()
