import asyncio
import base64
import json
import logging
import re
import tempfile
from dataclasses import dataclass
from functools import lru_cache
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

logger = logging.getLogger(__name__)


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


async def _split_audio(audio_path: Path, output_pattern: Path) -> list[Path]:
    await run_media_command(
        [
            "ffmpeg",
            "-hide_banner",
            "-nostdin",
            "-loglevel",
            "error",
            "-i",
            str(audio_path),
            "-f",
            "segment",
            "-segment_time",
            str(max(settings.MEDIA_TRANSCRIPTION_CHUNK_SECONDS, 30)),
            "-reset_timestamps",
            "1",
            "-c",
            "copy",
            "-y",
            str(output_pattern),
        ],
        timeout=settings.MEDIA_PROCESSING_VIDEO_TIMEOUT_SECONDS,
    )
    return sorted(output_pattern.parent.glob("audio-*.mp3"))


async def _audio_duration_ms(audio_path: Path) -> int:
    stdout, _ = await run_media_command(
        [
            "ffprobe",
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            str(audio_path),
        ],
        timeout=settings.MEDIA_PROCESSING_VIDEO_TIMEOUT_SECONDS,
    )
    return max(round(float(stdout.decode("utf-8").strip() or "0") * 1000), 1)


def _response_value(value, name: str, default=None):
    if isinstance(value, dict):
        return value.get(name, default)
    return getattr(value, name, default)


def _subtitle_timestamp_ms(value: str) -> int:
    hours, minutes, rest = value.replace(".", ",").split(":")
    seconds, milliseconds = rest.split(",")
    return (
        int(hours) * 3_600_000
        + int(minutes) * 60_000
        + int(seconds) * 1000
        + int(milliseconds.ljust(3, "0")[:3])
    )


def parse_srt_transcript(content: str) -> list[TranscriptSegment]:
    segments = []
    blocks = re.split(r"\r?\n\s*\r?\n", content.strip())
    for block in blocks:
        lines = [line.strip() for line in block.splitlines() if line.strip()]
        timing_index = next((index for index, line in enumerate(lines) if "-->" in line), None)
        if timing_index is None:
            continue
        start_value, end_value = [part.strip().split(" ", 1)[0] for part in lines[timing_index].split("-->", 1)]
        text = " ".join(lines[timing_index + 1 :]).strip()
        if not text:
            continue
        segments.append(
            TranscriptSegment(
                start_ms=_subtitle_timestamp_ms(start_value),
                end_ms=_subtitle_timestamp_ms(end_value),
                text=re.sub(r"<[^>]+>", "", text).strip(),
            )
        )
    return segments


async def extract_embedded_subtitles(payload: bytes, suffix: str) -> VideoTranscript | None:
    with tempfile.TemporaryDirectory(prefix="pkg-video-subtitles-") as tmpdir:
        video_path = Path(tmpdir) / f"input{suffix or '.mp4'}"
        video_path.write_bytes(payload)
        stdout, _ = await run_media_command(
            [
                "ffprobe",
                "-v",
                "error",
                "-select_streams",
                "s",
                "-show_entries",
                "stream=index,codec_name:stream_tags=language,title",
                "-of",
                "json",
                str(video_path),
            ],
            timeout=settings.MEDIA_PROCESSING_VIDEO_TIMEOUT_SECONDS,
        )
        streams = json.loads(stdout or b"{}").get("streams") or []
        preferred_language = settings.MEDIA_TRANSCRIPTION_LANGUAGE.strip().casefold()
        streams.sort(
            key=lambda stream: (
                0
                if preferred_language
                and str((stream.get("tags") or {}).get("language") or "").casefold()
                == preferred_language
                else 1
            )
        )
        for stream in streams:
            try:
                subtitle_bytes, _ = await run_media_command(
                    [
                        "ffmpeg",
                        "-hide_banner",
                        "-nostdin",
                        "-loglevel",
                        "error",
                        "-i",
                        str(video_path),
                        "-map",
                        f"0:{stream['index']}",
                        "-f",
                        "srt",
                        "-",
                    ],
                    timeout=settings.MEDIA_PROCESSING_VIDEO_TIMEOUT_SECONDS,
                )
            except (ValueError, TimeoutError):
                continue
            segments = parse_srt_transcript(subtitle_bytes.decode("utf-8", errors="replace"))
            if not segments:
                continue
            tags = stream.get("tags") or {}
            language = tags.get("language") or "unknown"
            codec = stream.get("codec_name") or "subtitle"
            return VideoTranscript(
                text="\n".join(segment.text for segment in segments),
                model=f"embedded-subtitle:{codec}:{language}",
                segments=segments,
            )
    return None


@lru_cache(maxsize=2)
def _local_whisper_model(
    model_name: str,
    device: str,
    compute_type: str,
    cpu_threads: int,
    workers: int,
    cache_dir: str,
):
    from faster_whisper import WhisperModel

    return WhisperModel(
        model_name,
        device=device,
        compute_type=compute_type,
        cpu_threads=max(cpu_threads, 1),
        num_workers=max(workers, 1),
        download_root=cache_dir,
    )


def _local_whisper_transcribe(
    audio_paths: list[str],
    durations_ms: list[int],
) -> VideoTranscript:
    model = _local_whisper_model(
        settings.MEDIA_LOCAL_TRANSCRIPTION_MODEL,
        settings.MEDIA_LOCAL_TRANSCRIPTION_DEVICE,
        settings.MEDIA_LOCAL_TRANSCRIPTION_COMPUTE_TYPE,
        settings.MEDIA_LOCAL_TRANSCRIPTION_CPU_THREADS,
        settings.MEDIA_LOCAL_TRANSCRIPTION_WORKERS,
        str(settings.MEDIA_LOCAL_TRANSCRIPTION_CACHE_DIR),
    )
    text_parts = []
    transcript_segments = []
    offset_ms = 0
    for audio_path, duration_ms in zip(audio_paths, durations_ms):
        segments, _ = model.transcribe(
            audio_path,
            language=settings.MEDIA_TRANSCRIPTION_LANGUAGE.strip() or None,
            beam_size=5,
            vad_filter=True,
        )
        for segment in segments:
            text = str(segment.text or "").strip()
            if not text:
                continue
            text_parts.append(text)
            transcript_segments.append(
                TranscriptSegment(
                    start_ms=offset_ms + max(round(float(segment.start) * 1000), 0),
                    end_ms=offset_ms + max(round(float(segment.end) * 1000), 1),
                    text=text,
                )
            )
        offset_ms += duration_ms
    return VideoTranscript(
        text="\n".join(text_parts),
        model=f"faster-whisper:{settings.MEDIA_LOCAL_TRANSCRIPTION_MODEL}",
        segments=transcript_segments,
    )


async def _transcribe_with_faster_whisper(
    audio_chunks: list[Path],
    durations_ms: list[int],
) -> VideoTranscript:
    return await asyncio.to_thread(
        _local_whisper_transcribe,
        [str(path) for path in audio_chunks],
        durations_ms,
    )


async def _transcribe_with_remote(
    audio_chunks: list[Path],
    durations_ms: list[int],
) -> VideoTranscript:
    api_key = settings.MEDIA_TRANSCRIPTION_API_KEY
    api_base = settings.MEDIA_TRANSCRIPTION_API_BASE
    if settings.MEDIA_TRANSCRIPTION_PROTOCOL == "openai_chat_audio":
        api_key = api_key or settings.QWEN_API_KEY
        api_base = api_base or settings.QWEN_API_BASE
    if not api_key:
        raise ValueError("Video transcription is enabled but MEDIA_TRANSCRIPTION_API_KEY is empty")
    client = AsyncOpenAI(base_url=api_base or None, api_key=api_key)
    text_parts = []
    segments = []
    offset_ms = 0
    for audio_chunk, duration_ms in zip(audio_chunks, durations_ms):
        if settings.MEDIA_TRANSCRIPTION_PROTOCOL == "openai_chat_audio":
            encoded = base64.b64encode(audio_chunk.read_bytes()).decode("ascii")
            response = await client.chat.completions.create(
                model=settings.MEDIA_TRANSCRIPTION_MODEL,
                messages=[
                    {
                        "role": "user",
                        "content": [
                            {
                                "type": "input_audio",
                                "input_audio": {
                                    "data": f"data:audio/mpeg;base64,{encoded}",
                                    "format": "mp3",
                                },
                            }
                        ],
                    }
                ],
                stream=False,
            )
            choices = getattr(response, "choices", None) or []
            message = getattr(choices[0], "message", None) if choices else None
            chunk_text = str(getattr(message, "content", "") or "").strip()
            response_segments = []
        else:
            with audio_chunk.open("rb") as audio_file:
                response = await client.audio.transcriptions.create(
                    model=settings.MEDIA_TRANSCRIPTION_MODEL,
                    file=audio_file,
                    response_format="verbose_json",
                    timestamp_granularities=["segment"],
                )
            chunk_text = str(_response_value(response, "text", "") or "").strip()
            response_segments = _response_value(response, "segments", []) or []
        if chunk_text:
            text_parts.append(chunk_text)
        if response_segments:
            for item in response_segments:
                segment_text = str(_response_value(item, "text", "") or "").strip()
                if not segment_text:
                    continue
                start = float(_response_value(item, "start", 0) or 0)
                end = float(_response_value(item, "end", start) or start)
                segments.append(
                    TranscriptSegment(
                        start_ms=offset_ms + max(0, round(start * 1000)),
                        end_ms=offset_ms + max(round(end * 1000), round(start * 1000) + 1),
                        text=segment_text,
                    )
                )
        elif chunk_text:
            segments.append(
                TranscriptSegment(
                    start_ms=offset_ms,
                    end_ms=offset_ms + duration_ms,
                    text=chunk_text,
                )
            )
        offset_ms += duration_ms
    text = "\n".join(text_parts).strip()
    return VideoTranscript(text=text, model=settings.MEDIA_TRANSCRIPTION_MODEL, segments=segments)


async def transcribe_video(payload: bytes, suffix: str) -> VideoTranscript | None:
    if not settings.MEDIA_TRANSCRIPTION_ENABLED:
        return None
    providers = [
        value.strip()
        for value in settings.MEDIA_TRANSCRIPTION_PROVIDER_ORDER.split(",")
        if value.strip()
    ]
    errors = []
    if "embedded_subtitles" in providers:
        try:
            transcript = await extract_embedded_subtitles(payload, suffix)
            if transcript is not None:
                return transcript
        except Exception as exc:
            logger.warning("Embedded subtitle extraction failed: %s", exc)
            errors.append(f"embedded_subtitles: {exc}")

    with tempfile.TemporaryDirectory(prefix="pkg-video-transcript-") as tmpdir:
        video_path = Path(tmpdir) / f"input{suffix or '.mp4'}"
        audio_path = Path(tmpdir) / "audio.mp3"
        chunk_pattern = Path(tmpdir) / "audio-%04d.mp3"
        video_path.write_bytes(payload)
        await _extract_audio(video_path, audio_path)
        audio_chunks = await _split_audio(audio_path, chunk_pattern)
        durations_ms = [await _audio_duration_ms(path) for path in audio_chunks]
        for provider in providers:
            if provider == "embedded_subtitles":
                continue
            try:
                if provider == "faster_whisper":
                    transcript = await _transcribe_with_faster_whisper(
                        audio_chunks,
                        durations_ms,
                    )
                elif provider == "remote":
                    transcript = await _transcribe_with_remote(audio_chunks, durations_ms)
                else:
                    continue
                if transcript.text.strip():
                    return transcript
            except Exception as exc:
                logger.warning("Video transcription provider %s failed: %s", provider, exc)
                errors.append(f"{provider}: {exc}")
    if errors:
        raise ValueError("All video transcription providers failed: " + "; ".join(errors))
    return VideoTranscript(text="", model="none", segments=[])


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
