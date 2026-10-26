import io
import json
import struct
import wave
from decimal import Decimal
from datetime import datetime, timezone
import shutil

import httpx
import pytest

from pkg.services.application.podcast_tts import (
    AudioOutcomeUnknown,
    DOWNLOAD_HOST,
    canonical_wav,
    audio_download_url,
    synthesize_qwen,
    assemble_mp3,
    retry_after_seconds,
)


def wav_fixture():
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as target:
        target.setnchannels(1)
        target.setsampwidth(2)
        target.setframerate(24000)
        target.writeframes(b"\x00\x00" * 2400)
    return buffer.getvalue()


def test_only_the_known_oversized_pcm_header_is_repaired_without_changing_audio():
    original = wav_fixture()
    assert canonical_wav(original) == (original, Decimal("0.100"))
    placeholder = bytearray(original)
    struct.pack_into("<I", placeholder, 4, 0x7FFFFFFF)
    struct.pack_into("<I", placeholder, 40, 0x7FFFFFFF)
    assert canonical_wav(bytes(placeholder))[0] == original
    truncated = bytearray(original)
    struct.pack_into("<I", truncated, 40, 100)
    with pytest.raises(ValueError):
        canonical_wav(bytes(truncated))
    with pytest.raises(ValueError):
        canonical_wav(original[:-1])
    invalid_format = bytearray(original)
    struct.pack_into("<H", invalid_format, 22, 2)
    with pytest.raises(ValueError):
        canonical_wav(bytes(invalid_format))


@pytest.mark.parametrize(
    "value",
    [
        "http://127.0.0.1/audio",
        "https://example.com/audio",
        f"https://evil.{DOWNLOAD_HOST}/x",
        f"https://user@{DOWNLOAD_HOST}/x",
        f"https://{DOWNLOAD_HOST}:8080/x",
        f"https://{DOWNLOAD_HOST}/x#fragment",
        "file:///etc/passwd",
    ],
)
def test_download_rejects_arbitrary_hosts_credentials_ports_and_schemes(value):
    with pytest.raises(ValueError):
        audio_download_url(value)


@pytest.mark.asyncio
@pytest.mark.parametrize("spoken_text", ["", "a" * 301, "😀" * 151])
async def test_oversized_segments_are_rejected_before_any_provider_request(spoken_text):
    calls = []

    def respond(request):
        calls.append(request)
        raise AssertionError("Oversized text must never reach the provider")

    with pytest.raises(ValueError, match="Invalid TTS segment"):
        await synthesize_qwen(spoken_text, "Cherry", "private-fixture", transport=httpx.MockTransport(respond))
    assert calls == []


@pytest.mark.asyncio
async def test_native_request_download_and_usage_do_not_forward_the_api_key_to_oss():
    calls = []

    def respond(request):
        calls.append(request)
        if request.method == "POST":
            assert request.headers["Authorization"] == "Bearer private-fixture"
            assert json.loads(request.content)["input"] == {
                "text": "这是一段口播",
                "voice": "Eldric Sage",
                "language_type": "Chinese",
            }
            return httpx.Response(
                200,
                json={
                    "request_id": "abc-123",
                    "output": {
                        "audio": {"url": f"http://{DOWNLOAD_HOST}/audio.wav?signature=private"}
                    },
                    "usage": {"characters": 12},
                },
            )
        assert request.url.scheme == "https"
        assert "Authorization" not in request.headers
        return httpx.Response(200, content=wav_fixture())

    result = await synthesize_qwen(
        "这是一段口播", "Eldric Sage", "private-fixture", transport=httpx.MockTransport(respond)
    )
    assert result.characters == 12 and result.request_id == "abc-123"
    assert result.duration == Decimal("0.100")
    assert len(calls) == 2


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "failure", ["timeout", "rejected", "redirect", "invalid-json", "untrusted-url"]
)
async def test_provider_failures_never_automatically_retry_or_expose_secrets(failure):
    calls = []

    def respond(request):
        calls.append(request)
        if failure == "timeout":
            raise httpx.ReadTimeout("private-fixture", request=request)
        if failure == "rejected":
            return httpx.Response(429, json={"code": "private-fixture"})
        if failure == "redirect":
            return httpx.Response(302, headers={"Location": "https://example.com"})
        if failure == "invalid-json":
            return httpx.Response(200, text="private-fixture")
        return httpx.Response(200, json={"output": {"audio": {"url": "https://127.0.0.1/private"}}})

    with pytest.raises(AudioOutcomeUnknown) as error:
        await synthesize_qwen(
            "Script", "Cherry", "private-fixture", transport=httpx.MockTransport(respond)
        )
    assert "private-fixture" not in str(error.value)
    assert len(calls) == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("failure,stage,code,status", [
    ("connect-timeout", "provider_request", "connect_timeout", None),
    ("read-timeout", "provider_request", "read_timeout", None),
    ("http-error", "provider_response", "rate_limited", 429),
    ("invalid-json", "provider_response", "validation_error", 200),
    ("download-timeout", "audio_download", "read_timeout", None),
    ("download-http", "audio_download", "http_error", 403),
    ("invalid-wav", "audio_validation", "validation_error", 200),
    ("unsafe-url", "audio_url", "validation_error", 200),
])
async def test_failure_diagnostics_preserve_stage_status_request_id_and_known_usage(failure, stage, code, status):
    calls = []
    request_id = "dfc71fd3-a822-91bb-9064-c27dd80d8233"

    def respond(request):
        calls.append(request)
        if request.method == "POST":
            if failure == "connect-timeout":
                raise httpx.ConnectTimeout("private-fixture", request=request)
            if failure == "read-timeout":
                raise httpx.ReadTimeout("private-fixture", request=request)
            if failure == "http-error":
                return httpx.Response(429, json={"request_id": request_id, "message": "private-fixture"})
            if failure == "invalid-json":
                return httpx.Response(200, headers={"x-request-id": request_id}, text="private-fixture")
            return httpx.Response(200, json={"request_id": request_id, "usage": {"characters": 12}, "output": {"audio": {
                "url": "https://127.0.0.1/private-fixture" if failure == "unsafe-url" else f"https://{DOWNLOAD_HOST}/audio.wav?signature=private-fixture",
            }}})
        if failure == "download-timeout":
            raise httpx.ReadTimeout("private-fixture", request=request)
        if failure == "download-http":
            return httpx.Response(403, text="private-fixture")
        return httpx.Response(200, content=b"private-fixture")

    with pytest.raises(AudioOutcomeUnknown) as error:
        await synthesize_qwen("private-script", "Cherry", "private-fixture", transport=httpx.MockTransport(respond))
    diagnostic = error.value.diagnostic
    assert (diagnostic.stage, diagnostic.code, diagnostic.http_status) == (stage, code, status)
    assert diagnostic.elapsed_ms >= 0
    assert diagnostic.provider_request_id == (None if failure in {"connect-timeout", "read-timeout"} else request_id)
    assert error.value.characters == (12 if stage in {"audio_url", "audio_download", "audio_validation"} else None)
    assert "private-fixture" not in str(error.value) + repr(diagnostic)
    assert "private-script" not in str(error.value) + repr(diagnostic)
    assert len(calls) == (2 if stage in {"audio_download", "audio_validation"} else 1)


@pytest.mark.parametrize("value,expected", [
    ("30", 30), ("0", 0), (" 120 ", 120), ("604800", 604800),
    ("604801", None), ("999999999999999", None), ("-1", None), ("1.5", None),
    (None, None), ("private-fixture", None), ("9" * 129, None),
    ("Sun, 18 Oct 2026 08:00:30 GMT", 30),
    ("Sun, 18 Oct 2026 07:59:00 GMT", 0),
    ("Sun, 18 Oct 2026 08:00:30", None),
])
def test_retry_after_is_bounded_seconds_or_http_date_without_retaining_header_text(value, expected):
    assert retry_after_seconds(value, now=datetime(2026, 10, 18, 8, tzinfo=timezone.utc)) == expected


@pytest.mark.asyncio
@pytest.mark.parametrize("status,body,headers,expected_code,provider_code,wait", [
    (429, {"code": "Throttling.RateQuota"}, {"Retry-After": "30"}, "rate_limited", "Throttling.RateQuota", 30),
    (429, {"code": "Throttling.AllocationQuota"}, {}, "rate_limited", "Throttling.AllocationQuota", None),
    (429, {"code": "AllocationQuota.FreeTierOnly"}, {}, "rate_limited", "AllocationQuota.FreeTierOnly", None),
    (429, "private-fixture", {"Retry-After": "0"}, "rate_limited", None, 0),
    (429, {"code": "private-fixture"}, {"Retry-After": "private-fixture"}, "rate_limited", None, None),
    (200, {"code": "Throttling.RateQuota"}, {"Retry-After": "30"}, "rate_limited", "Throttling.RateQuota", 30),
    (400, {"code": "InvalidParameter"}, {}, "http_error", "InvalidParameter", None),
    (200, {"code": "InvalidParameter"}, {}, "provider_error", "InvalidParameter", None),
    (503, {"code": ["private-fixture"]}, {}, "http_error", None, None),
])
async def test_provider_rejections_capture_safe_codes_and_retry_after_without_retrying(
    status, body, headers, expected_code, provider_code, wait,
):
    calls = []

    def respond(request):
        calls.append(request)
        if isinstance(body, dict):
            return httpx.Response(status, headers=headers, json={
                **body, "message": "private-fixture private-script", "request_id": "abc-123",
            })
        return httpx.Response(status, headers=headers, text=body)

    with pytest.raises(AudioOutcomeUnknown) as error:
        await synthesize_qwen("private-script", "Cherry", "private-fixture", transport=httpx.MockTransport(respond))
    diagnostic = error.value.diagnostic
    assert diagnostic.stage == "provider_response"
    assert diagnostic.http_status == status
    assert diagnostic.code == expected_code
    assert diagnostic.provider_error_code == provider_code
    assert diagnostic.retry_after_seconds == wait
    assert "private-fixture" not in repr(diagnostic) + str(error.value)
    assert "private-script" not in repr(diagnostic) + str(error.value)
    assert len(calls) == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("error_type", [httpx.ReadError, httpx.ConnectError, httpx.RemoteProtocolError, httpx.ProxyError])
async def test_network_exception_types_are_preserved_without_messages_or_false_rate_limit(error_type):
    calls = []

    def respond(request):
        calls.append(request)
        raise error_type("private-fixture private-script", request=request)

    with pytest.raises(AudioOutcomeUnknown) as error:
        await synthesize_qwen("private-script", "Cherry", "private-fixture", transport=httpx.MockTransport(respond))
    diagnostic = error.value.diagnostic
    assert diagnostic.code == "network_error"
    assert diagnostic.exception_type == error_type.__name__
    assert diagnostic.http_status is None and diagnostic.provider_error_code is None
    assert diagnostic.retry_after_seconds is None
    assert "private-fixture" not in repr(diagnostic) + str(error.value)
    assert "private-script" not in repr(diagnostic) + str(error.value)
    assert len(calls) == 1


@pytest.mark.asyncio
@pytest.mark.skipif(not shutil.which("ffmpeg"), reason="Requires local ffmpeg")
async def test_segments_assemble_to_a_strictly_decodable_mp3_without_provider_calls():
    payload, duration = await assemble_mp3([wav_fixture(), wav_fixture()])
    assert len(payload) > 0 and duration == Decimal("0.200")
    assert payload[:3] == b"ID3" or payload[0] == 255
