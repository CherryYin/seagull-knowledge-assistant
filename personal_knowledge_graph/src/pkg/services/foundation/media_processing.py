import asyncio
import io
import json
import logging
import tempfile
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path

from PIL import Image, ImageOps
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from pkg.config import settings
from pkg.db import async_session
from pkg.models.foundation.source import Source, SourceMedia, SourceMediaSegment
from pkg.services.cross_cutting.storage import get_storage_service
from pkg.services.cross_cutting.system_jobs import record_system_job
from pkg.services.foundation.media_description import generate_media_description
from pkg.services.foundation.media_tools import run_media_command
from pkg.services.foundation.media_video import process_video_segments

logger = logging.getLogger(__name__)


@dataclass(frozen=True, slots=True)
class MediaDerivatives:
    mime_type: str | None
    file_size: int
    width: int | None
    height: int | None
    duration_seconds: float | None
    thumbnail: bytes


def _image_derivatives(payload: bytes) -> MediaDerivatives:
    with Image.open(io.BytesIO(payload)) as image:
        mime_type = Image.MIME.get(image.format or "")
        image = ImageOps.exif_transpose(image)
        width, height = image.size
        image.thumbnail((640, 640))
        if image.mode != "RGB":
            background = Image.new("RGB", image.size, "white")
            if image.mode == "RGBA":
                background.paste(image, mask=image.getchannel("A"))
            else:
                background.paste(image.convert("RGB"))
            image = background
        output = io.BytesIO()
        image.save(output, format="JPEG", quality=82, optimize=True)
        return MediaDerivatives(
            mime_type=mime_type,
            file_size=len(payload),
            width=width,
            height=height,
            duration_seconds=None,
            thumbnail=output.getvalue(),
        )


async def _video_derivatives(payload: bytes, suffix: str) -> MediaDerivatives:
    with tempfile.TemporaryDirectory(prefix="pkg-media-processing-") as tmpdir:
        video_path = Path(tmpdir) / f"input{suffix or '.mp4'}"
        thumbnail_path = Path(tmpdir) / "thumbnail.jpg"
        video_path.write_bytes(payload)
        probe_stdout, _ = await run_media_command(
            [
                "ffprobe",
                "-v",
                "error",
                "-select_streams",
                "v:0",
                "-show_entries",
                "stream=width,height:format=duration,format_name",
                "-of",
                "json",
                str(video_path),
            ],
            timeout=settings.MEDIA_PROCESSING_VIDEO_TIMEOUT_SECONDS,
        )
        details = json.loads(probe_stdout or b"{}")
        stream = (details.get("streams") or [{}])[0]
        format_details = details.get("format") or {}
        duration = float(format_details["duration"]) if format_details.get("duration") else None
        await run_media_command(
            [
                "ffmpeg",
                "-hide_banner",
                "-nostdin",
                "-loglevel",
                "error",
                "-ss",
                "1",
                "-i",
                str(video_path),
                "-frames:v",
                "1",
                "-vf",
                "scale=640:-2",
                "-q:v",
                "3",
                "-y",
                str(thumbnail_path),
            ],
            timeout=settings.MEDIA_PROCESSING_VIDEO_TIMEOUT_SECONDS,
        )
        if not thumbnail_path.exists():
            raise ValueError("Video thumbnail generation failed")
        format_name = str(format_details.get("format_name") or "").split(",", 1)[0]
        return MediaDerivatives(
            mime_type=f"video/{format_name}" if format_name else None,
            file_size=len(payload),
            width=int(stream["width"]) if stream.get("width") else None,
            height=int(stream["height"]) if stream.get("height") else None,
            duration_seconds=duration,
            thumbnail=thumbnail_path.read_bytes(),
        )


async def build_media_derivatives(
    payload: bytes,
    *,
    source_type: str,
    filename: str,
) -> MediaDerivatives:
    if source_type == "image":
        return await asyncio.to_thread(_image_derivatives, payload)
    if source_type == "video":
        suffix = Path(filename).suffix.lower()
        return await _video_derivatives(payload, suffix)
    raise ValueError("Media processing is available only for image and video Sources")


async def queue_media_processing(
    session: AsyncSession,
    source: Source,
    *,
    force: bool = False,
) -> SourceMedia:
    media = await session.get(SourceMedia, source.id)
    if media is None:
        media = SourceMedia(
            source_id=source.id,
            processing_status="pending",
            processing_version=1,
            processing_attempts=0,
            transcript_status="pending" if source.source_type == "video" else "not_applicable",
            processing_stage="queued",
        )
        session.add(media)
    elif force:
        media.processing_status = "pending"
        media.next_retry_at = None
        media.error_message = None
        if source.source_type == "video" and media.transcript_status == "disabled":
            media.transcript_status = "pending"
    return media


async def process_source_media(source_id: str) -> None:
    async with async_session() as session:
        source = await session.get(Source, source_id)
        media = await session.get(SourceMedia, source_id)
        if (
            source is None
            or media is None
            or source.source_type not in {"image", "video"}
            or not source.file_path
        ):
            return
        media.processing_status = "processing"
        media.processing_attempts += 1
        media.next_retry_at = None
        media.error_message = None
        await session.commit()

        storage = get_storage_service()
        try:
            payload = await storage.get_object(source.file_path)
            filename = str(
                (source.metadata_ or {}).get("original_filename")
                or Path(source.file_path).name
            )
            if not media.thumbnail_path or media.width is None or media.height is None:
                derivatives = await build_media_derivatives(
                    payload,
                    source_type=source.source_type,
                    filename=filename,
                )
                media.thumbnail_path = await storage.upload_bytes(
                    object_key=(
                        f"sources/{source.id}/derived/v{media.processing_version}/thumbnail.jpg"
                    ),
                    data=derivatives.thumbnail,
                    content_type="image/jpeg",
                )
                media.mime_type = derivatives.mime_type
                media.file_size = derivatives.file_size
                media.width = derivatives.width
                media.height = derivatives.height
                media.duration_seconds = derivatives.duration_seconds
                media.processing_stage = "derivatives"
                await session.commit()
            if not media.caption:
                caption, caption_model = await generate_media_description(
                    payload,
                    source_type=source.source_type,
                    filename=filename,
                    title=source.title,
                )
                media.caption = caption
                media.caption_model = caption_model
                media.processing_stage = "caption"
                await session.commit()
            if source.source_type == "video":
                await process_video_segments(session, source, media, payload, filename)
            media.processing_stage = "indexing"
            media.processing_status = "completed"
            media.processed_at = datetime.now(timezone.utc).replace(tzinfo=None)
            media.error_message = None
            from pkg.api.sources import upsert_source_embeddings

            media_index_text = "\n".join(
                value for value in (media.caption, media.transcript) if value
            )
            await upsert_source_embeddings(session, source, media_caption=media_index_text)
            media.processing_stage = "completed"
            await session.commit()
        except Exception as exc:
            await session.rollback()
            media = await session.get(SourceMedia, source_id)
            if media is None:
                return
            media.error_message = str(exc)[:2000]
            if media.processing_attempts < settings.MEDIA_PROCESSING_MAX_ATTEMPTS:
                media.processing_status = "retrying"
                retry_multiplier = 2 ** max(media.processing_attempts - 1, 0)
                retry_delay = settings.MEDIA_PROCESSING_RETRY_DELAY_SECONDS * retry_multiplier
                media.next_retry_at = (
                    datetime.now(timezone.utc).replace(tzinfo=None)
                    + timedelta(seconds=retry_delay)
                )
            else:
                media.processing_status = "failed"
                media.next_retry_at = None
            await session.commit()
            logger.exception("Media processing failed for source %s", source_id)
            raise


async def run_media_processing_step() -> dict:
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    async with async_session() as session:
        rows = await session.execute(
            select(SourceMedia.source_id)
            .where(
                or_(
                    SourceMedia.processing_status == "pending",
                    (SourceMedia.processing_status == "retrying")
                    & (SourceMedia.next_retry_at <= now),
                )
            )
            .order_by(SourceMedia.created_at.asc())
            .limit(settings.MEDIA_PROCESSING_BATCH_SIZE)
        )
        source_ids = list(rows.scalars())
    for source_id in source_ids:
        await process_source_media(source_id)
    return {"queued": len(source_ids), "processed_source_ids": source_ids}


async def media_processing_loop() -> None:
    while True:
        try:
            if not settings.MEDIA_PROCESSING_ENABLED:
                await asyncio.sleep(max(settings.MEDIA_PROCESSING_INTERVAL_SECONDS, 1))
                continue
            now = datetime.now(timezone.utc).replace(tzinfo=None)
            async with async_session() as session:
                rows = await session.execute(
                    select(SourceMedia.source_id)
                    .where(
                        or_(
                            SourceMedia.processing_status == "pending",
                            (SourceMedia.processing_status == "retrying")
                            & (SourceMedia.next_retry_at <= now),
                        )
                    )
                    .order_by(SourceMedia.created_at.asc())
                    .limit(settings.MEDIA_PROCESSING_BATCH_SIZE)
                )
                source_ids = list(rows.scalars())
            if source_ids:
                async with record_system_job(
                    job_type="media_processing",
                    title="Media derivative processing",
                    metadata={"source_ids": source_ids},
                ):
                    for source_id in source_ids:
                        await process_source_media(source_id)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("Media processing loop iteration failed")
        await asyncio.sleep(max(settings.MEDIA_PROCESSING_INTERVAL_SECONDS, 1))


async def delete_media_derivatives(
    media: SourceMedia | None,
    segments: list[SourceMediaSegment] | None = None,
) -> None:
    if media is None:
        return
    paths = [media.thumbnail_path]
    paths.extend(segment.thumbnail_path for segment in segments or [])
    for path in paths:
        if not path:
            continue
        try:
            await get_storage_service().delete_object(path)
        except Exception:
            logger.warning("Failed to delete media derivative %s", path, exc_info=True)
