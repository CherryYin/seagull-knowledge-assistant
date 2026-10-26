import json
import math
import re
import struct
import tempfile
import time
import wave
from dataclasses import dataclass
from datetime import datetime, timezone
from decimal import Decimal
from email.utils import parsedate_to_datetime
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

import httpx

from pkg.services.foundation.media_tools import run_media_command
from pkg.services.application.podcast_policy import SEGMENT_UTF16_LIMIT


ENDPOINT = "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation"
DOWNLOAD_HOST = "dashscope-result-bj.oss-cn-beijing.aliyuncs.com"
RATE_LIMIT_CODES = frozenset({"Throttling", "Throttling.RateQuota", "Throttling.AllocationQuota"})
PROVIDER_ERROR_CODES = RATE_LIMIT_CODES | frozenset({
    "AllocationQuota.FreeTierOnly", "Arrearage", "InsufficientBalance", "InvalidApiKey",
    "AccessDenied", "InvalidParameter", "InvalidParameterValue", "InternalError", "ServiceUnavailable",
})
MAX_RETRY_AFTER_SECONDS = 604800


@dataclass(frozen=True)
class AudioFailure:
    stage: str
    code: str
    elapsed_ms: int
    http_status: int | None = None
    provider_request_id: str | None = None
    exception_type: str | None = None
    provider_error_code: str | None = None
    retry_after_seconds: int | None = None


class AudioOutcomeUnknown(RuntimeError):
    def __init__(self, message="Audio outcome requires manual review; no automatic retry", *, diagnostic: AudioFailure | None = None, characters: int | None = None):
        super().__init__(message)
        self.diagnostic = diagnostic
        self.characters = characters


def provider_request_id(value):
    return value if isinstance(value, str) and re.fullmatch(r"[a-fA-F0-9-]{1,80}", value) else None


def retry_after_seconds(value, *, now=None):
    if not isinstance(value, str) or len(value) > 128:
        return None
    value = value.strip()
    if re.fullmatch(r"[0-9]{1,8}", value):
        seconds = int(value)
    else:
        try:
            deadline = parsedate_to_datetime(value)
            if deadline.tzinfo is None:
                return None
            seconds = max(0, math.ceil((deadline - (now or datetime.now(timezone.utc))).total_seconds()))
        except (TypeError, ValueError, OverflowError):
            return None
    return seconds if seconds <= MAX_RETRY_AFTER_SECONDS else None


def diagnose_audio_failure(error, stage, elapsed_ms, *, http_status=None, request_id=None,
                           provider_code=None, retry_after=None):
    if isinstance(error, AudioOutcomeUnknown) and error.diagnostic is not None:
        return error.diagnostic
    provider_code = provider_code if isinstance(provider_code, str) and provider_code in PROVIDER_ERROR_CODES else None
    if http_status == 429 or provider_code in RATE_LIMIT_CODES:
        code = "rate_limited"
    elif isinstance(error, httpx.ConnectTimeout):
        code = "connect_timeout"
    elif isinstance(error, httpx.ReadTimeout):
        code = "read_timeout"
    elif isinstance(error, httpx.WriteTimeout):
        code = "write_timeout"
    elif isinstance(error, httpx.PoolTimeout):
        code = "pool_timeout"
    elif isinstance(error, (httpx.TimeoutException, TimeoutError)):
        code = "timeout"
    elif isinstance(error, httpx.HTTPStatusError):
        code = "http_error"
    elif isinstance(error, httpx.RequestError):
        code = "network_error"
    elif provider_code is not None:
        code = "provider_error"
    else:
        code = "validation_error" if isinstance(error, ValueError) else "local_error"
    exception_type = next((kind.__name__ for kind in (
        httpx.ConnectTimeout, httpx.ReadTimeout, httpx.WriteTimeout, httpx.PoolTimeout,
        httpx.RemoteProtocolError, httpx.LocalProtocolError, httpx.ConnectError,
        httpx.ReadError, httpx.WriteError, httpx.CloseError, httpx.ProxyError,
        httpx.UnsupportedProtocol, httpx.HTTPStatusError, httpx.RequestError,
        TimeoutError, ValueError,
    ) if isinstance(error, kind)), None)
    return AudioFailure(
        stage, code, max(0, elapsed_ms), http_status, provider_request_id(request_id),
        exception_type, provider_code, retry_after_seconds(retry_after),
    )


@dataclass
class ProviderAudio:
    original: bytes
    wav: bytes
    duration: Decimal
    request_id: str | None
    characters: int | None


def canonical_wav(payload: bytes) -> tuple[bytes, Decimal]:
    if len(payload) < 46 or len(payload) > 16 * 1024 * 1024:
        raise ValueError("Invalid audio size")
    if (
        payload[:4] != b"RIFF"
        or payload[8:20] != b"WAVEfmt \x10\x00\x00\x00"
        or payload[36:40] != b"data"
    ):
        raise ValueError("Unsupported WAV layout")
    if (
        struct.unpack_from("<HHIIHH", payload, 20) != (1, 1, 24000, 48000, 2, 16)
        or (len(payload) - 44) % 2
    ):
        raise ValueError("Unsupported or incomplete PCM frames")
    riff_size, data_size = (
        struct.unpack_from("<I", payload, 4)[0],
        struct.unpack_from("<I", payload, 40)[0],
    )
    if (riff_size, data_size) != (len(payload) - 8, len(payload) - 44):
        if riff_size < 0x7FFF0000 or data_size < 0x7FFF0000:
            raise ValueError("Truncated or corrupt WAV")
        repaired = bytearray(payload)
        struct.pack_into("<I", repaired, 4, len(payload) - 8)
        struct.pack_into("<I", repaired, 40, len(payload) - 44)
        payload = bytes(repaired)
    return payload, (Decimal(len(payload) - 44) / 48000).quantize(Decimal("0.001"))


def audio_download_url(value: str) -> str:
    parsed = urlsplit(value)
    if (
        parsed.scheme not in {"http", "https"}
        or parsed.hostname != DOWNLOAD_HOST
        or parsed.username
        or parsed.password
        or parsed.port not in {None, 443}
        or not parsed.path
        or parsed.fragment
    ):
        raise ValueError("Untrusted audio download URL")
    return urlunsplit(("https", parsed.netloc, parsed.path, parsed.query, ""))


async def _limited_body(response: httpx.Response, limit: int) -> bytes:
    chunks = []
    size = 0
    async for chunk in response.aiter_bytes():
        size += len(chunk)
        if size > limit:
            raise ValueError("Provider response exceeded size limit")
        chunks.append(chunk)
    return b"".join(chunks)


async def synthesize_qwen(text: str, voice: str, secret: str, *, transport=None) -> ProviderAudio:
    if not text or sum(2 if ord(character) > 0xFFFF else 1 for character in text) > SEGMENT_UTF16_LIMIT:
        raise ValueError("Invalid TTS segment")
    started = time.monotonic()
    stage, http_status, request_id, characters = "provider_request", None, None, None
    provider_code, retry_after = None, None
    try:
        async with httpx.AsyncClient(
            timeout=httpx.Timeout(300, connect=15, write=20, pool=10),
            follow_redirects=False,
            transport=transport,
        ) as client:
            async with client.stream(
                "POST",
                ENDPOINT,
                headers={"Authorization": f"Bearer {secret}"},
                json={
                    "model": "qwen3-tts-flash",
                    "input": {"text": text, "voice": voice, "language_type": "Chinese"},
                },
            ) as response:
                stage, http_status = "provider_response", response.status_code
                retry_after = response.headers.get("retry-after")
                started = time.monotonic()
                request_id = provider_request_id(response.headers.get("x-request-id"))
                payload = await _limited_body(response, 1024 * 1024)
                try:
                    body = json.loads(payload)
                except ValueError:
                    response.raise_for_status()
                    raise
                if isinstance(body, dict):
                    request_id = provider_request_id(body.get("request_id")) or request_id
                    provider_code = body.get("code")
                response.raise_for_status()
                if not isinstance(body, dict) or body.get("code"):
                    raise ValueError("Invalid provider response")
                usage = body.get("usage")
                characters = usage.get("characters") if isinstance(usage, dict) else None
                if type(characters) is not int or characters < 0:
                    characters = None
            stage, started = "audio_url", time.monotonic()
            url = audio_download_url(body.get("output", {}).get("audio", {}).get("url", ""))
            stage, http_status, started = "audio_download", None, time.monotonic()
            provider_code, retry_after = None, None
            async with client.stream("GET", url) as response:
                http_status = response.status_code
                retry_after = response.headers.get("retry-after")
                response.raise_for_status()
                original = await _limited_body(response, 16 * 1024 * 1024)
        stage, started = "audio_validation", time.monotonic()
        normalized, duration = canonical_wav(original)
        return ProviderAudio(original, normalized, duration, request_id, characters)
    except Exception as error:
        raise AudioOutcomeUnknown(
            diagnostic=diagnose_audio_failure(
                error, stage, int((time.monotonic() - started) * 1000), http_status=http_status,
                request_id=request_id, provider_code=provider_code, retry_after=retry_after,
            ),
            characters=characters,
        ) from None


async def assemble_mp3(segments: list[bytes]) -> tuple[bytes, Decimal]:
    if not segments:
        raise ValueError("No audio segments")
    pcm = []
    total = 0
    for payload in segments:
        normalized, _duration = canonical_wav(payload)
        total += len(normalized) - 44
        if total > 96 * 1024 * 1024:
            raise ValueError("Episode exceeds assembly size limit")
        pcm.append(normalized[44:])
    frames = b"".join(pcm)
    with tempfile.TemporaryDirectory(prefix="pkg-podcast-") as directory:
        source = Path(directory) / "episode.wav"
        output = Path(directory) / "episode.mp3"
        with wave.open(str(source), "wb") as target:
            target.setnchannels(1)
            target.setsampwidth(2)
            target.setframerate(24000)
            target.writeframes(frames)
        await run_media_command(
            [
                "ffmpeg",
                "-hide_banner",
                "-nostdin",
                "-loglevel",
                "error",
                "-xerror",
                "-i",
                str(source),
                "-c:a",
                "libmp3lame",
                "-b:a",
                "128k",
                "-y",
                str(output),
            ],
            timeout=120,
        )
        await run_media_command(
            [
                "ffmpeg",
                "-hide_banner",
                "-nostdin",
                "-loglevel",
                "error",
                "-xerror",
                "-i",
                str(output),
                "-f",
                "null",
                "-",
            ],
            timeout=120,
        )
        result = output.read_bytes()
        if not result:
            raise ValueError("Empty audio output")
        return result, (Decimal(len(frames)) / 48000).quantize(Decimal("0.001"))
