import re
import tempfile
from dataclasses import dataclass
from pathlib import Path

from openai import AsyncOpenAI
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from pkg.config import settings
from pkg.models.foundation.source import Source, SourceMedia, SourceMediaSegment
from pkg.services.cross_cutting.embedding import get_embedding_service
from pkg.services.cross_cutting.storage import get_storage_service
from pkg.services.foundation.media_description import generate_media_description
from pkg.services.foundation.media_tools import run_media_command


@dataclass(frozen=True, slots=True)
class TranscriptSegment:
    start_ms: int
    end_ms: int
    text: str


@dataclass(frozen=True, slots=True)
class VideoTranscript:
    text: str
    model: str
    segments: list[TranscriptSegment]


@dataclass(frozen=True, slots=True)
class VideoSegmentWindow:
    start_ms: int
    end_ms: int
    transcript: str | None


async def _extract_audio(video_path: Path, audio_path: Path) -> None:
    await run_media_command(
        [
            "ffmpeg",
            "-hide_banner",
            "-nostdin",
            "-loglevel",
            "error",
            "-i",
            str(video_path),
            "-vn",
            "-ac",
            "1",
            "-ar",
            "16000",
            "-c:a",
            "mp3",
            "-b:a",
            "64k",
            "-y",
            str(audio_path),
        ],
        timeout=settings.MEDIA_PROCESSING_VIDEO_TIMEOUT_SECONDS,
    )


def _response_value(value, name: str, default=None):
    if isinstance(value, dict):
        return value.get(name, default)
    return getattr(value, name, default)


async def transcribe_video(payload: bytes, suffix: str) -> VideoTranscript | None:
    if not settings.MEDIA_TRANSCRIPTION_ENABLED:
        return None
    if not settings.MEDIA_TRANSCRIPTION_API_KEY:
        raise ValueError("Video transcription is enabled but MEDIA_TRANSCRIPTION_API_KEY is empty")

    with tempfile.TemporaryDirectory(prefix="pkg-video-transcript-") as tmpdir:
        video_path = Path(tmpdir) / f"input{suffix or '.mp4'}"
        audio_path = Path(tmpdir) / "audio.mp3"
        video_path.write_bytes(payload)
        await _extract_audio(video_path, audio_path)
        client = AsyncOpenAI(
            base_url=settings.MEDIA_TRANSCRIPTION_API_BASE or None,
            api_key=settings.MEDIA_TRANSCRIPTION_API_KEY,
        )
        with audio_path.open("rb") as audio_file:
            response = await client.audio.transcriptions.create(
                model=settings.MEDIA_TRANSCRIPTION_MODEL,
                file=audio_file,
                response_format="verbose_json",
                timestamp_granularities=["segment"],
            )

    text = str(_response_value(response, "text", "") or "").strip()
    segments = []
    for item in _response_value(response, "segments", []) or []:
        segment_text = str(_response_value(item, "text", "") or "").strip()
        if not segment_text:
            continue
        start = float(_response_value(item, "start", 0) or 0)
        end = float(_response_value(item, "end", start) or start)
        segments.append(
            TranscriptSegment(
                start_ms=max(0, round(start * 1000)),
                end_ms=max(round(end * 1000), round(start * 1000) + 1),
                text=segment_text,
            )
        )
    return VideoTranscript(text=text, model=settings.MEDIA_TRANSCRIPTION_MODEL, segments=segments)


async def _detect_scene_points(video_path: Path) -> list[int]:
    _, stderr_bytes = await run_media_command(
        [
            "ffmpeg",
            "-hide_banner",
            "-nostdin",
            "-i",
            str(video_path),
            "-filter:v",
            f"select='gt(scene,{settings.MEDIA_VIDEO_SCENE_THRESHOLD})',showinfo",
            "-f",
            "null",
            "-",
        ],
        timeout=settings.MEDIA_PROCESSING_VIDEO_TIMEOUT_SECONDS,
    )
    stderr = stderr_bytes.decode("utf-8", errors="replace")
    return sorted(
        {
            round(float(match) * 1000)
            for match in re.findall(r"pts_time:([0-9]+(?:\.[0-9]+)?)", stderr)
        }
    )


def _segment_boundaries(duration_ms: int, scene_points: list[int]) -> list[int]:
    segment_ms = max(settings.MEDIA_VIDEO_SEGMENT_SECONDS, 5) * 1000
    boundaries = {0, duration_ms}
    boundaries.update(point for point in scene_points if 0 < point < duration_ms)
    cursor = segment_ms
    while cursor < duration_ms:
        boundaries.add(cursor)
        cursor += segment_ms
    ordered = sorted(boundaries)
    max_segments = max(settings.MEDIA_VIDEO_MAX_SEGMENTS, 1)
    if len(ordered) - 1 <= max_segments:
        return ordered
    step = (len(ordered) - 1) / max_segments
    selected = [ordered[round(index * step)] for index in range(max_segments)]
    selected.append(duration_ms)
    return sorted(set(selected))


def build_video_segment_windows(
    duration_seconds: float | None,
    scene_points: list[int],
    transcript_segments: list[TranscriptSegment],
    transcript_text: str,
) -> list[VideoSegmentWindow]:
    duration_ms = max(round((duration_seconds or 0) * 1000), 1)
    if transcript_segments:
        duration_ms = max(duration_ms, max(segment.end_ms for segment in transcript_segments))
    boundaries = _segment_boundaries(duration_ms, scene_points)
    windows = []
    for start_ms, end_ms in zip(boundaries, boundaries[1:]):
        text_parts = [
            segment.text
            for segment in transcript_segments
            if segment.start_ms < end_ms and segment.end_ms > start_ms
        ]
        windows.append(
            VideoSegmentWindow(
                start_ms=start_ms,
                end_ms=end_ms,
                transcript=" ".join(text_parts).strip() or None,
            )
        )
    if transcript_text and windows and not any(window.transcript for window in windows):
        windows[0] = VideoSegmentWindow(
            start_ms=windows[0].start_ms,
            end_ms=windows[0].end_ms,
            transcript=transcript_text,
        )
    return windows


async def _extract_keyframe(video_path: Path, timestamp_ms: int, output_path: Path) -> bytes:
    await run_media_command(
        [
            "ffmpeg",
            "-hide_banner",
            "-nostdin",
            "-loglevel",
            "error",
            "-ss",
            f"{timestamp_ms / 1000:.3f}",
            "-i",
            str(video_path),
            "-frames:v",
            "1",
            "-vf",
            "scale=640:-2",
            "-q:v",
            "3",
            "-y",
            str(output_path),
        ],
        timeout=settings.MEDIA_PROCESSING_VIDEO_TIMEOUT_SECONDS,
    )
    return output_path.read_bytes()


async def detect_video_scenes(payload: bytes, suffix: str) -> list[int]:
    with tempfile.TemporaryDirectory(prefix="pkg-video-scenes-") as tmpdir:
        video_path = Path(tmpdir) / f"input{suffix or '.mp4'}"
        video_path.write_bytes(payload)
        return await _detect_scene_points(video_path)


async def process_video_segments(
    session: AsyncSession,
    source: Source,
    media: SourceMedia,
    payload: bytes,
    filename: str,
) -> None:
    suffix = Path(filename).suffix.lower()
    transcript_segments: list[TranscriptSegment] = []
    if media.transcript_status not in {"completed", "disabled"}:
        transcript = await transcribe_video(payload, suffix)
        if transcript is None:
            media.transcript_status = "disabled"
        else:
            media.transcript = transcript.text
            media.transcript_model = transcript.model
            media.transcript_status = "completed"
            transcript_segments = transcript.segments
        media.processing_stage = "transcript"
        await session.commit()

    if media.segment_count > 0:
        return

    scene_points = await detect_video_scenes(payload, suffix)
    windows = build_video_segment_windows(
        media.duration_seconds,
        scene_points,
        transcript_segments,
        media.transcript or "",
    )
    storage = get_storage_service()
    embedding_service = get_embedding_service()
    existing_rows = await session.execute(
        select(SourceMediaSegment).where(SourceMediaSegment.source_id == source.id)
    )
    existing_by_index = {segment.segment_index: segment for segment in existing_rows.scalars()}

    with tempfile.TemporaryDirectory(prefix="pkg-video-segments-") as tmpdir:
        video_path = Path(tmpdir) / f"input{suffix or '.mp4'}"
        video_path.write_bytes(payload)
        for index, window in enumerate(windows):
            segment = existing_by_index.get(index)
            if segment is None:
                segment = SourceMediaSegment(
                    source_id=source.id,
                    segment_index=index,
                    start_ms=window.start_ms,
                    end_ms=window.end_ms,
                    transcript=window.transcript,
                )
                session.add(segment)
            keyframe_path = Path(tmpdir) / f"segment-{index}.jpg"
            keyframe = await _extract_keyframe(
                video_path,
                window.start_ms + max((window.end_ms - window.start_ms) // 2, 1),
                keyframe_path,
            )
            if not segment.thumbnail_path:
                segment.thumbnail_path = await storage.upload_bytes(
                    object_key=(
                        f"sources/{source.id}/derived/v{media.processing_version}/segments/"
                        f"{index:04d}.jpg"
                    ),
                    data=keyframe,
                    content_type="image/jpeg",
                )
            if settings.MEDIA_VIDEO_SEGMENT_CAPTIONS_ENABLED and not segment.caption:
                segment.caption, _ = await generate_media_description(
                    keyframe,
                    source_type="image",
                    filename=f"segment-{index}.jpg",
                    title=f"{source.title} at {window.start_ms / 1000:.1f}s",
                )
            embedding_text = "\n".join(
                value for value in (segment.transcript, segment.caption) if value
            )
            if embedding_text and segment.embedding is None:
                segment.embedding = await embedding_service.embed_text(embedding_text)
            await session.commit()

    media.segment_count = len(windows)
    media.processing_stage = "segments"
    await session.commit()
