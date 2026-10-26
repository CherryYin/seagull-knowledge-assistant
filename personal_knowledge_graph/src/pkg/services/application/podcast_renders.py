import asyncio
import hashlib
import logging
import time
import uuid
from dataclasses import asdict
from datetime import datetime, timedelta, timezone
from decimal import Decimal

from fastapi import HTTPException
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from pkg.config import settings
from pkg.db import async_session
from pkg.models.application.asset import Asset
from pkg.models.application.podcast import AssetAudioRender, AssetAudioSegment, AssetAudioAttempt
from pkg.models.user_api_credential import UserApiCredential
from pkg.schemas.application.podcast import (
    PodcastAudioPreflightRequest,
    PodcastAudioRenderRequest,
    PodcastAudioRenderRead,
    PodcastAudioAttemptRead,
    PodcastAudioAbandonRequest,
)
from pkg.services.application.podcast_audio import preflight_podcast_audio, reserved_characters
from pkg.services.application.podcast_policy import (
    MINIMUM_PRICE,
    PRICE_POLICY_ID,
    SEGMENTATION_VERSION,
    audio_execution_available,
)
from pkg.services.application.podcasts import _owned_config, _digest, get_podcast_draft
from pkg.services.application.podcast_tts import AudioOutcomeUnknown, synthesize_qwen, assemble_mp3, diagnose_audio_failure
from pkg.services.cross_cutting.credentials_crypto import decrypt_secret
from pkg.services.cross_cutting.storage import get_storage_service


logger = logging.getLogger(__name__)
ACTIVE = ("queued", "generating", "assembling", "outcome_unknown")


def _can_abandon(render):
    if render.status not in {"outcome_unknown", "failed", "canceled"}:
        return False
    return not (
        render.status == "outcome_unknown"
        and render.completed_at is None
        and render.lease_expires_at is not None
        and render.lease_expires_at > datetime.now(timezone.utc)
    )


async def _owned_asset(session, user_id, asset_id, *, lock=False):
    query = select(Asset).where(Asset.id == asset_id, Asset.user_id == user_id)
    asset = (await session.execute(query.with_for_update() if lock else query)).scalar_one_or_none()
    if asset is None:
        raise HTTPException(status_code=404, detail="Asset not found")
    if asset.asset_type != "podcast":
        raise HTTPException(status_code=409, detail="Asset is not a podcast")
    return asset


async def _render_read(session, render):
    segments = list(
        (
            await session.scalars(
                select(AssetAudioSegment).where(AssetAudioSegment.render_id == render.id)
            )
        ).all()
    )
    attempts = list(
        (
            await session.scalars(
                select(AssetAudioAttempt).where(AssetAudioAttempt.render_id == render.id)
            )
        ).all()
    )
    segment_positions = {segment.id: segment.position for segment in segments}
    attempts.sort(key=lambda attempt: (segment_positions[attempt.segment_id], attempt.attempt_number))
    return PodcastAudioRenderRead(
        id=render.id,
        asset_id=render.asset_id,
        script_approval_id=render.script_approval_id,
        input_hash=render.input_hash,
        status=render.status,
        budget_limit=render.budget_limit,
        currency=render.currency,
        estimated_cost=(render.config_snapshot or {}).get("estimated_cost"),
        duration_seconds=render.duration_seconds,
        file_sha256=render.file_sha256,
        segment_count=len(segments),
        ready_segment_count=sum(segment.status == "ready" for segment in segments),
        attempt_count=len(attempts),
        reported_characters=sum(attempt.billable_characters for attempt in attempts)
        if attempts and all(attempt.billable_characters is not None for attempt in attempts)
        else None,
        reported_cost=sum((attempt.reported_cost for attempt in attempts), Decimal("0"))
        if attempts and all(attempt.reported_cost is not None for attempt in attempts)
        else None,
        error_message=render.error_message,
        can_abandon=_can_abandon(render),
        abandonment=render.abandonment,
        failure_details=render.failure_details,
        attempts=[PodcastAudioAttemptRead(
            id=attempt.id, segment_position=segment_positions[attempt.segment_id],
            status=attempt.status, error_code=attempt.error_code,
            provider_request_id=attempt.provider_request_id,
            billable_characters=attempt.billable_characters,
            started_at=attempt.started_at, completed_at=attempt.completed_at,
            failure_details=attempt.failure_details,
        ) for attempt in attempts],
        created_at=render.created_at,
        completed_at=render.completed_at,
    )


async def list_audio_renders(session: AsyncSession, *, user_id: str, asset_id: str):
    await _owned_asset(session, user_id, asset_id)
    renders = list(
        (
            await session.scalars(
                select(AssetAudioRender)
                .where(AssetAudioRender.asset_id == asset_id)
                .order_by(AssetAudioRender.created_at.desc(), AssetAudioRender.id.desc())
                .limit(20)
            )
        ).all()
    )
    return [await _render_read(session, render) for render in renders]


async def create_audio_render(
    session: AsyncSession, *, user_id: str, asset_id: str, body: PodcastAudioRenderRequest
):
    await _owned_config(session, user_id=user_id, asset_id=asset_id, for_update=True)
    request_hash = _digest(body.model_dump(mode="json"))
    existing = (
        await session.scalars(
            select(AssetAudioRender).where(
                AssetAudioRender.asset_id == asset_id,
                AssetAudioRender.idempotency_key == body.idempotency_key,
            )
        )
    ).one_or_none()
    if existing:
        if existing.config_snapshot.get("request_hash") != request_hash:
            raise HTTPException(
                status_code=409, detail="Idempotency key belongs to different audio authorization"
            )
        return await _render_read(session, existing)
    if not audio_execution_available():
        raise HTTPException(
            status_code=503,
            detail="Audio execution disabled, pricing policy expired, or ffmpeg unavailable",
        )
    if body.price_per_10k_characters is None or body.price_per_10k_characters < MINIMUM_PRICE:
        raise HTTPException(
            status_code=409,
            detail="Check your account price; it cannot be below the current safety pricing floor",
        )
    credential = (
        await session.scalars(
            select(UserApiCredential)
            .where(UserApiCredential.id == body.credential_id, UserApiCredential.user_id == user_id)
            .with_for_update(read=True)
        )
    ).one_or_none()
    if credential is None:
        raise HTTPException(status_code=404, detail="Audio credential not found")
    report = await preflight_podcast_audio(
        session,
        user_id=user_id,
        asset_id=asset_id,
        body=PodcastAudioPreflightRequest.model_validate(
            body.model_dump(include=set(PodcastAudioPreflightRequest.model_fields))
        ),
    )
    if report.execution_fingerprint != body.execution_fingerprint or not report.checks_passed:
        raise HTTPException(
            status_code=409,
            detail="Audio preflight changed or has blockers; run it again before authorizing",
        )
    render_id = "podcast-audio-" + uuid.uuid4().hex
    render = AssetAudioRender(
        id=render_id,
        asset_id=asset_id,
        script_approval_id=report.script_approval_id,
        idempotency_key=body.idempotency_key,
        input_hash=report.input_hash,
        budget_limit=body.budget_limit,
        currency="CNY",
        status="queued",
        config_snapshot={
            **report.configuration.model_dump(mode="json"),
            "request_hash": request_hash,
            "credential_id": credential.id,
            "credential_fingerprint": hashlib.sha256(
                credential.secret_encrypted.encode()
            ).hexdigest(),
            "price_per_10k_characters": str(body.price_per_10k_characters),
            "estimated_cost": str(report.estimated_cost),
            "execution_fingerprint": report.execution_fingerprint,
            "pricing_policy_id": PRICE_POLICY_ID,
            "segmentation_version": report.segmentation_version,
            "authorized_by": user_id,
            "authorized_at": datetime.now(timezone.utc).isoformat(),
            "text_authorized": True,
            "billing_uncertainty_acknowledged": True,
        },
    )
    session.add(render)
    for segment in report.segments:
        session.add(
            AssetAudioSegment(
                id="podcast-segment-" + uuid.uuid4().hex,
                render_id=render_id,
                position=segment.position,
                spoken_text=segment.spoken_text,
                input_hash=segment.text_hash,
                status="queued",
            )
        )
    await session.flush()
    await session.refresh(render)
    result = await _render_read(session, render)
    await session.commit()
    return result


async def cancel_audio_render(
    session: AsyncSession, *, user_id: str, asset_id: str, render_id: str
):
    await _owned_asset(session, user_id, asset_id, lock=True)
    render = (
        await session.scalars(
            select(AssetAudioRender)
            .where(AssetAudioRender.id == render_id, AssetAudioRender.asset_id == asset_id)
            .with_for_update()
        )
    ).one_or_none()
    if render is None:
        raise HTTPException(status_code=404, detail="Audio task not found")
    if render.status not in {"queued", "generating", "assembling", "canceled", "outcome_unknown"}:
        raise HTTPException(status_code=409, detail="Audio task is already terminal")
    if render.status == "queued":
        render.status = "canceled"
        render.completed_at = datetime.now(timezone.utc)
        segments = (
            await session.scalars(
                select(AssetAudioSegment).where(AssetAudioSegment.render_id == render.id)
            )
        ).all()
        for segment in segments:
            segment.status = "canceled"
    elif render.status not in {"canceled", "outcome_unknown"}:
        render.status = "outcome_unknown"
        render.error_message = "停止后续请求；当前调用可能已计费，需核查服务商记录，不能自动重试。"
        await session.execute(
            update(AssetAudioAttempt)
            .where(AssetAudioAttempt.render_id == render.id, AssetAudioAttempt.status == "started")
            .values(status="outcome_unknown", error_code="user_stop")
        )
        await session.execute(
            update(AssetAudioSegment)
            .where(
                AssetAudioSegment.render_id == render.id, AssetAudioSegment.status == "generating"
            )
            .values(status="outcome_unknown")
        )
    await session.flush()
    result = await _render_read(session, render)
    await session.commit()
    return result


async def abandon_audio_render(
    session: AsyncSession, *, user_id: str, asset_id: str, render_id: str,
    body: PodcastAudioAbandonRequest,
):
    await _owned_config(session, user_id=user_id, asset_id=asset_id, for_update=True)
    render = (
        await session.scalars(
            select(AssetAudioRender)
            .where(AssetAudioRender.id == render_id, AssetAudioRender.asset_id == asset_id)
            .with_for_update()
            .execution_options(populate_existing=True)
        )
    ).one_or_none()
    if render is None:
        raise HTTPException(status_code=404, detail="Audio task not found")
    if render.status == "abandoned":
        return await _render_read(session, render)
    if not _can_abandon(render):
        raise HTTPException(
            status_code=409,
            detail="只能结束已停止的失败或结果未知任务；处理中或尚有有效执行租约的任务请先停止并等待。",
        )
    now = datetime.now(timezone.utc)
    render.abandonment = {
        "abandoned_by": user_id,
        "abandoned_at": now.isoformat(),
        "previous_status": render.status,
        **body.model_dump(mode="json"),
    }
    render.status = "abandoned"
    render.completed_at = render.completed_at or now
    await session.flush()
    result = await _render_read(session, render)
    await session.commit()
    return result


async def download_audio_render(
    session: AsyncSession, *, user_id: str, asset_id: str, render_id: str
):
    await _owned_asset(session, user_id, asset_id)
    render = (
        await session.scalars(
            select(AssetAudioRender).where(
                AssetAudioRender.asset_id == asset_id, AssetAudioRender.id == render_id
            )
        )
    ).one_or_none()
    if render is None:
        raise HTTPException(status_code=404, detail="Audio task not found")
    if render.status != "ready" or not render.file_path or not render.file_sha256:
        raise HTTPException(status_code=409, detail="Audio file is not ready")
    payload = await get_storage_service().get_object(render.file_path)
    if hashlib.sha256(payload).hexdigest() != render.file_sha256:
        raise HTTPException(status_code=409, detail="Audio integrity check failed")
    return payload


async def _fenced(session, render_id, token):
    render = (
        await session.scalars(
            select(AssetAudioRender).where(AssetAudioRender.id == render_id).with_for_update()
        )
    ).one_or_none()
    if (
        render is None
        or render.status not in {"generating", "assembling"}
        or render.lease_token != token
        or render.lease_expires_at <= datetime.now(timezone.utc)
    ):
        raise RuntimeError("Audio task no longer owns its execution lease")
    render.lease_expires_at = datetime.now(timezone.utc) + timedelta(seconds=900)
    return render


async def recover_expired_audio(session_factory=async_session):
    async with session_factory() as session:
        expired = (
            await session.scalars(
                select(AssetAudioRender)
                .where(
                    AssetAudioRender.status.in_(["generating", "assembling"]),
                    AssetAudioRender.lease_expires_at < datetime.now(timezone.utc),
                )
                .with_for_update(skip_locked=True)
            )
        ).all()
        for render in expired:
            render.status = "outcome_unknown"
            render.error_message = "执行租约已失效；可能已经调用或计费，不会自动续跑或重试。"
            await session.execute(
                update(AssetAudioSegment)
                .where(
                    AssetAudioSegment.render_id == render.id,
                    AssetAudioSegment.status == "generating",
                )
                .values(status="outcome_unknown")
            )
            attempts = (
                await session.scalars(
                    select(AssetAudioAttempt).where(
                        AssetAudioAttempt.render_id == render.id,
                        AssetAudioAttempt.status == "started",
                    )
                )
            ).all()
            for attempt in attempts:
                attempt.status = "outcome_unknown"
                attempt.error_code = "lease_expired"
        await session.commit()


async def process_one_audio_render(session_factory=async_session):
    await recover_expired_audio(session_factory)
    if not audio_execution_available():
        return False
    async with session_factory() as session:
        render = (
            await session.scalars(
                select(AssetAudioRender)
                .where(AssetAudioRender.status == "queued")
                .order_by(AssetAudioRender.created_at)
                .with_for_update(skip_locked=True)
                .limit(1)
            )
        ).one_or_none()
        if render is None:
            return False
        token = uuid.uuid4().hex
        render.status = "generating"
        render.lease_token = token
        render.lease_expires_at = datetime.now(timezone.utc) + timedelta(seconds=900)
        render.started_at = datetime.now(timezone.utc)
        render_id, asset_id = render.id, render.asset_id
        await session.commit()
    posted = False
    stage, stage_started, current_attempt_id, audio = "task_validation", time.monotonic(), None, None
    try:
        async with session_factory() as session:
            segments = list(
                (
                    await session.scalars(
                        select(AssetAudioSegment)
                        .where(AssetAudioSegment.render_id == render_id)
                        .order_by(AssetAudioSegment.position)
                    )
                ).all()
            )
        storage = get_storage_service()
        for segment in segments:
            stage, stage_started, current_attempt_id, audio = "input_validation", time.monotonic(), None, None
            async with session_factory() as session:
                asset = await _owned_asset(
                    session, render.config_snapshot["authorized_by"], asset_id, lock=True
                )
                render = await _fenced(session, render_id, token)
                draft = await get_podcast_draft(session, user_id=asset.user_id, asset_id=asset_id)
                if (
                    not audio_execution_available()
                    or render.config_snapshot["pricing_policy_id"] != PRICE_POLICY_ID
                    or render.config_snapshot["segmentation_version"] != SEGMENTATION_VERSION
                    or Decimal(render.config_snapshot["price_per_10k_characters"]) < MINIMUM_PRICE
                    or draft.input_hash != render.input_hash
                    or draft.approval_status != "current"
                    or draft.approval_issues
                ):
                    raise RuntimeError("Audio inputs or execution policy changed")
                stage, stage_started = "credential_validation", time.monotonic()
                credential = (
                    await session.scalars(
                        select(UserApiCredential)
                        .where(
                            UserApiCredential.id == render.config_snapshot["credential_id"],
                            UserApiCredential.user_id == asset.user_id,
                        )
                        .with_for_update(read=True)
                    )
                ).one_or_none()
                if (
                    credential is None
                    or not credential.is_enabled
                    or credential.provider != "qwen"
                    or (credential.config or {}).get("region", "cn-beijing") != "cn-beijing"
                    or hashlib.sha256(credential.secret_encrypted.encode()).hexdigest()
                    != render.config_snapshot["credential_fingerprint"]
                ):
                    raise RuntimeError("Audio credential changed or is unavailable")
                secret = decrypt_secret(credential.secret_encrypted)
                persisted = await session.get(AssetAudioSegment, segment.id)
                if (
                    persisted.status != "queued"
                    or hashlib.sha256(persisted.spoken_text.encode()).hexdigest()
                    != persisted.input_hash
                ):
                    raise RuntimeError("Audio segment is not safe to submit")
                attempt_id = "podcast-attempt-" + uuid.uuid4().hex
                session.add(
                    AssetAudioAttempt(
                        id=attempt_id,
                        render_id=render_id,
                        segment_id=segment.id,
                        attempt_number=1,
                        status="started",
                    )
                )
                persisted.status = "generating"
                await session.commit()
            posted = True
            current_attempt_id = attempt_id
            stage, stage_started = "provider_request", time.monotonic()
            audio = await synthesize_qwen(
                segment.spoken_text, render.config_snapshot["voice_id"], secret
            )
            secret = ""
            stage, stage_started = "usage_validation", time.monotonic()
            if audio.characters is not None and audio.characters > reserved_characters(
                segment.spoken_text
            ):
                raise RuntimeError("Provider usage exceeded reserved characters")
            prefix = f"podcast/{asset_id}/{render_id}/{segment.id}"
            stage, stage_started = "storage_upload", time.monotonic()
            await storage.upload_bytes(
                object_key=prefix + ".original.wav", data=audio.original, content_type="audio/wav"
            )
            path = await storage.upload_bytes(
                object_key=prefix + ".wav", data=audio.wav, content_type="audio/wav"
            )
            async with session_factory() as session:
                stage, stage_started = "segment_finalization", time.monotonic()
                await _fenced(session, render_id, token)
                persisted = await session.get(AssetAudioSegment, segment.id)
                persisted.status, persisted.file_path = "ready", path
                persisted.file_sha256, persisted.duration_seconds = (
                    hashlib.sha256(audio.wav).hexdigest(),
                    audio.duration,
                )
                attempt = await session.get(AssetAudioAttempt, attempt_id)
                attempt.status, attempt.provider_request_id, attempt.billable_characters = (
                    "succeeded",
                    audio.request_id,
                    audio.characters,
                )
                attempt.completed_at = datetime.now(timezone.utc)
                await session.commit()
            posted = False
            current_attempt_id = None
        stage, stage_started = "task_validation", time.monotonic()
        async with session_factory() as session:
            render = await _fenced(session, render_id, token)
            render.status = "assembling"
            segments = list(
                (
                    await session.scalars(
                        select(AssetAudioSegment)
                        .where(AssetAudioSegment.render_id == render_id)
                        .order_by(AssetAudioSegment.position)
                    )
                ).all()
            )
            await session.commit()
        payloads = []
        total_bytes = 0
        stage, stage_started = "storage_download", time.monotonic()
        for segment in segments:
            payload = await storage.get_object(segment.file_path)
            total_bytes += len(payload)
            if total_bytes > 96 * 1024 * 1024:
                raise RuntimeError("Episode exceeds assembly size limit")
            if hashlib.sha256(payload).hexdigest() != segment.file_sha256:
                raise RuntimeError("Stored audio segment failed integrity check")
            payloads.append(payload)
        stage, stage_started = "audio_assembly", time.monotonic()
        mp3, duration = await assemble_mp3(payloads)
        stage, stage_started = "storage_upload", time.monotonic()
        path = await storage.upload_bytes(
            object_key=f"podcast/{asset_id}/{render_id}/episode.mp3",
            data=mp3,
            content_type="audio/mpeg",
        )
        async with session_factory() as session:
            stage, stage_started = "task_finalization", time.monotonic()
            render = await _fenced(session, render_id, token)
            render.status, render.file_path, render.file_sha256 = (
                "ready",
                path,
                hashlib.sha256(mp3).hexdigest(),
            )
            render.duration_seconds, render.completed_at = duration, datetime.now(timezone.utc)
            await session.commit()
    except Exception as error:
        diagnostic = asdict(diagnose_audio_failure(error, stage, int((time.monotonic() - stage_started) * 1000)))
        if audio is not None and diagnostic["provider_request_id"] is None and current_attempt_id:
            diagnostic["provider_request_id"] = audio.request_id
        logger.warning(
            "Podcast audio stopped render_id=%s stage=%s code=%s http_status=%s provider_request_id=%s elapsed_ms=%s exception_type=%s provider_error_code=%s retry_after_seconds=%s",
            render_id, diagnostic["stage"], diagnostic["code"], diagnostic["http_status"],
            diagnostic["provider_request_id"], diagnostic["elapsed_ms"],
            diagnostic["exception_type"], diagnostic["provider_error_code"], diagnostic["retry_after_seconds"],
        )
        async with session_factory() as session:
            render = (
                await session.scalars(
                    select(AssetAudioRender)
                    .where(AssetAudioRender.id == render_id)
                    .with_for_update()
                )
            ).one_or_none()
            if (
                render is not None
                and render.lease_token == token
                and render.status in {"generating", "assembling"}
            ):
                render.status = "outcome_unknown" if posted else "failed"
                render.error_message = (
                    "音频执行停止；有调用结果未知，请核查服务商记录，禁止自动重试。"
                    if posted
                    else "音频输入、凭据或本地处理已变化/失败；未自动重试，已有成功调用可能已计费。"
                )
                render.completed_at = datetime.now(timezone.utc)
                render.failure_details = diagnostic
            elif render is not None and render.lease_token == token and render.status == "outcome_unknown":
                render.completed_at = render.completed_at or datetime.now(timezone.utc)
            attempts = (
                await session.scalars(
                    select(AssetAudioAttempt).where(
                        AssetAudioAttempt.render_id == render_id,
                        AssetAudioAttempt.status == "started",
                    )
                )
            ).all()
            for attempt in attempts:
                attempt.status, attempt.error_code = "outcome_unknown", diagnostic["code"]
                attempt.failure_details = diagnostic
                attempt.completed_at = datetime.now(timezone.utc)
                if attempt.id == current_attempt_id:
                    attempt.provider_request_id = diagnostic["provider_request_id"]
                    if isinstance(error, AudioOutcomeUnknown):
                        attempt.billable_characters = error.characters
                    elif audio is not None:
                        attempt.billable_characters = audio.characters
            await session.execute(
                update(AssetAudioSegment)
                .where(
                    AssetAudioSegment.render_id == render_id,
                    AssetAudioSegment.status == "generating",
                )
                .values(status="outcome_unknown" if posted else "failed")
            )
            await session.commit()
    return True


async def podcast_audio_processing_loop():
    if not settings.PODCAST_AUDIO_ENABLED:
        logger.info("Podcast audio execution is disabled")
        return
    while True:
        try:
            processed = await process_one_audio_render()
        except Exception:
            logger.error("Podcast audio processing failed; no automatic provider retry")
            processed = False
        await asyncio.sleep(1 if processed else 5)
