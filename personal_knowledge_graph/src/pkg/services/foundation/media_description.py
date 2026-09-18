import asyncio
import base64
import io
import logging
import tempfile
from pathlib import Path

from PIL import Image, ImageOps

from pkg.services.cross_cutting.llm import create_async_client
from pkg.services.foundation.media_tools import run_media_command


logger = logging.getLogger(__name__)

MEDIA_DESCRIPTION_PROMPT = """Describe this saved media for a personal knowledge search index.

Return one factual paragraph in the primary language suggested by the media or title. Include the
main subject, setting, visible text, notable objects, actions, style, and likely purpose when they
are observable. Do not invent identities, events, locations, or intent. Do not add headings,
markdown, confidence scores, or explanations."""


def _prepare_image(payload: bytes) -> tuple[bytes, str]:
    with Image.open(io.BytesIO(payload)) as image:
        image = ImageOps.exif_transpose(image)
        image.thumbnail((1600, 1600))
        if image.mode not in {"RGB", "L"}:
            background = Image.new("RGB", image.size, "white")
            if image.mode == "RGBA":
                background.paste(image, mask=image.getchannel("A"))
            else:
                background.paste(image.convert("RGB"))
            image = background
        elif image.mode == "L":
            image = image.convert("RGB")
        output = io.BytesIO()
        image.save(output, format="JPEG", quality=85, optimize=True)
        return output.getvalue(), "image/jpeg"


async def _extract_video_contact_sheet(payload: bytes, suffix: str) -> tuple[bytes, str]:
    with tempfile.TemporaryDirectory(prefix="pkg-media-description-") as tmpdir:
        video_path = Path(tmpdir) / f"input{suffix or '.mp4'}"
        sheet_path = Path(tmpdir) / "contact-sheet.jpg"
        video_path.write_bytes(payload)
        command = [
            "ffmpeg",
            "-hide_banner",
            "-nostdin",
            "-loglevel",
            "error",
            "-i",
            str(video_path),
            "-vf",
            "fps=1/10,scale=640:-2,tile=3x2",
            "-frames:v",
            "1",
            "-q:v",
            "3",
            "-y",
            str(sheet_path),
        ]
        await run_media_command(command, timeout=90)
        if not sheet_path.exists():
            await run_media_command(
                [
                    "ffmpeg",
                    "-hide_banner",
                    "-nostdin",
                    "-loglevel",
                    "error",
                    "-i",
                    str(video_path),
                    "-frames:v",
                    "1",
                    "-vf",
                    "scale=640:-2",
                    "-q:v",
                    "3",
                    "-y",
                    str(sheet_path),
                ],
                timeout=90,
            )
        if not sheet_path.exists():
            raise ValueError("No representative video frames could be extracted")
        return sheet_path.read_bytes(), "image/jpeg"


async def prepare_media_preview(payload: bytes, *, source_type: str, filename: str) -> tuple[bytes, str]:
    if source_type == "image":
        return await asyncio.to_thread(_prepare_image, payload)
    if source_type == "video":
        return await _extract_video_contact_sheet(payload, Path(filename).suffix.lower())
    raise ValueError("Description generation is available only for image and video Sources")


def _extract_response_text(response) -> str:
    choices = getattr(response, "choices", None) or []
    if not choices:
        return ""
    message = getattr(choices[0], "message", None)
    content = getattr(message, "content", None) if message is not None else None
    if isinstance(content, str):
        return content.strip()
    if isinstance(content, list):
        parts = []
        for item in content:
            text = item.get("text") if isinstance(item, dict) else getattr(item, "text", None)
            if isinstance(text, str):
                parts.append(text)
        return "\n".join(parts).strip()
    return ""


async def generate_media_description(
    payload: bytes,
    *,
    source_type: str,
    filename: str,
    title: str,
) -> tuple[str, str]:
    preview, content_type = await prepare_media_preview(payload, source_type=source_type, filename=filename)
    client, model = create_async_client()
    encoded = base64.b64encode(preview).decode("ascii")
    response = await client.chat.completions.create(
        model=model,
        messages=[
            {"role": "system", "content": MEDIA_DESCRIPTION_PROMPT},
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": f"Saved media title: {title}"},
                    {"type": "image_url", "image_url": {"url": f"data:{content_type};base64,{encoded}"}},
                ],
            },
        ],
        temperature=0.1,
        max_tokens=500,
        timeout=120,
    )
    description = _extract_response_text(response)
    if not description:
        raise ValueError("The configured LLM returned an empty media description")
    return description[:8000], model
