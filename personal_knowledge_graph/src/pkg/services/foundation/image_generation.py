from dataclasses import dataclass
from io import BytesIO
from urllib.parse import urlsplit

import httpx
from PIL import Image

from pkg.config import settings


@dataclass(frozen=True)
class GeneratedImage:
    payload: bytes
    content_type: str
    width: int
    height: int
    provider_request_id: str | None
    source_host: str | None


async def generate_qwen_image(*, prompt: str, size: str) -> GeneratedImage:
    if not settings.QWEN_IMAGE_ENABLED:
        raise ValueError("Qwen image generation is disabled")
    if not settings.QWEN_API_KEY.strip():
        raise ValueError("QWEN_API_KEY is not configured")

    request_payload = {
        "model": settings.QWEN_IMAGE_MODEL,
        "input": {
            "messages": [
                {
                    "role": "user",
                    "content": [{"text": prompt}],
                }
            ]
        },
        "parameters": {"size": size, "n": 1},
    }
    headers = {
        "Authorization": f"Bearer {settings.QWEN_API_KEY}",
        "Content-Type": "application/json",
    }
    timeout = httpx.Timeout(settings.QWEN_IMAGE_TIMEOUT)
    async with httpx.AsyncClient(timeout=timeout, follow_redirects=True) as client:
        response = await client.post(settings.QWEN_IMAGE_API_BASE, headers=headers, json=request_payload)
        response.raise_for_status()
        body = response.json()
        output = body.get("output") or {}
        choices = output.get("choices") or []
        content = ((choices[0].get("message") or {}).get("content") or []) if choices else []
        image_url = next((item.get("image") for item in content if isinstance(item, dict) and item.get("image")), None)
        if not image_url:
            raise ValueError("Qwen image generation returned no image URL")
        image_response = await client.get(image_url)
        image_response.raise_for_status()

    payload = image_response.content
    with Image.open(BytesIO(payload)) as image:
        width, height = image.size
        image_format = (image.format or "PNG").lower()
    content_type = (image_response.headers.get("content-type") or "").split(";", 1)[0].strip().lower()
    if not content_type.startswith("image/"):
        content_type = f"image/{image_format}"
    return GeneratedImage(
        payload=payload,
        content_type=content_type,
        width=width,
        height=height,
        provider_request_id=body.get("request_id"),
        source_host=urlsplit(image_url).hostname,
    )
