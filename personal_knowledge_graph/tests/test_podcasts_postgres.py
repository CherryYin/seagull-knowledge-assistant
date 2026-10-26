import asyncio
import hashlib
import importlib.util
import os
import uuid
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest
from alembic.migration import MigrationContext
from alembic.autogenerate import compare_metadata
from alembic.operations import Operations
from fastapi import HTTPException
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine
from sqlalchemy.ext.asyncio import async_sessionmaker
from decimal import Decimal

from pkg.config import settings
from pkg.db import Base
from pkg.models.application.asset import Asset
from pkg.models.foundation.source import Source
from pkg.models.foundation.note import Note
from pkg.models.foundation.wiki import WikiPage
from pkg.models.user_api_credential import UserApiCredential
from pkg.schemas.application.podcast import (
    PodcastApprovalRequest,
    PodcastConfiguration,
    PodcastConfigurationUpdate,
    PodcastCreate,
    PodcastDraftUpdate,
    PodcastAudioPreflightRequest,
)
from pkg.schemas.application.asset import AssetCreate
from pkg.services.application import podcasts
from pkg.services.application.podcast_audio import preflight_podcast_audio
from pkg.services.application import podcast_renders, podcast_policy
from pkg.schemas.application.podcast import PodcastAudioRenderRequest
from pkg.services.application.assets import create_asset


def run_migration(connection, direction, filename=None):
    filenames = [filename] if filename else ["d0e1f2a3b4c5_add_podcast_foundations.py"]
    if not filename and direction == "upgrade":
        filenames.append("a37c9e6f402b_add_podcast_audio_diagnostics.py")
        filenames.append("b8e26d409a71_add_podcast_audio_abandonment.py")
    for migration_name in filenames:
        path = Path(__file__).resolve().parents[1] / "alembic/versions" / migration_name
        specification = importlib.util.spec_from_file_location("podcast_test_migration", path)
        migration = importlib.util.module_from_spec(specification)
        specification.loader.exec_module(migration)
        with Operations.context(MigrationContext.configure(connection)):
            getattr(migration, direction)()


def compare_podcast_metadata(connection):
    names = {
        "asset_podcast_configs",
        "asset_podcast_script_approvals",
        "asset_audio_renders",
        "asset_audio_segments",
        "asset_audio_attempts",
    }
    context = MigrationContext.configure(
        connection,
        opts={
            "include_object": lambda _object, name, kind, _reflected, _compare_to: (
                kind != "table" or name in names
            ),
        },
    )
    return compare_metadata(context, Base.metadata)


@pytest.mark.skipif(
    os.environ.get("SEAGULL_PODCAST_POSTGRES_TEST") != "1",
    reason="Requires explicit isolated PostgreSQL test opt-in",
)
@pytest.mark.asyncio
async def test_podcast_migration_ownership_concurrency_and_task_constraints(caplog):
    schema = f"podcast_test_{uuid.uuid4().hex}"
    admin = create_async_engine(settings.DATABASE_URL)
    engine = create_async_engine(
        settings.DATABASE_URL, connect_args={"server_settings": {"search_path": schema}}
    )
    created_schema = False
    try:
        async with admin.begin() as connection:
            await connection.execute(text(f'CREATE SCHEMA "{schema}"'))
            created_schema = True
        async with engine.begin() as connection:
            await connection.execute(text("CREATE TABLE users (id VARCHAR PRIMARY KEY)"))
            await connection.execute(text("INSERT INTO users (id) VALUES ('owner'), ('other')"))
            await connection.run_sync(UserApiCredential.__table__.create)
            await connection.execute(
                text(
                    "INSERT INTO user_api_credentials (id,user_id,provider,label,secret_encrypted,secret_masked) VALUES "
                    "(7,'owner','qwen','Personal','encrypted-fixture','***'), "
                    "(8,'other','qwen','Private','foreign-encrypted-fixture','***')"
                )
            )
            await connection.execute(text("CREATE TABLE categories (id INTEGER PRIMARY KEY)"))
            await connection.execute(text("INSERT INTO categories (id) VALUES (1)"))
            for model in (Source, Note, WikiPage):
                await connection.run_sync(model.__table__.create)
            await connection.execute(
                text(
                    "INSERT INTO sources (id,user_id,category_id,title,source_type,raw_content) VALUES ('material','owner',1,'Original story','web','Initial story'), ('private','other',1,'Private','web','Secret')"
                )
            )
            await connection.execute(
                text(
                    "INSERT INTO notes (id,user_id,category_id,title,note_type,content) VALUES ('note','owner',1,'My notes','note','Personal analysis')"
                )
            )
            await connection.execute(
                text(
                    "INSERT INTO wiki_pages (id,user_id,title,page_type,content) VALUES ('wiki','owner','Context','topic','Background')"
                )
            )
            await connection.run_sync(Asset.__table__.create)
            await connection.execute(
                text(
                    "INSERT INTO assets (id, user_id, asset_type, title, metadata) VALUES ('old-blog', 'owner', 'blog_post', 'Untouched', CAST(:metadata AS JSONB))"
                ),
                {"metadata": '{"custom": true}'},
            )
            await connection.run_sync(run_migration, "upgrade")
            await connection.run_sync(run_migration, "downgrade", "b8e26d409a71_add_podcast_audio_abandonment.py")
            await connection.run_sync(run_migration, "upgrade", "b8e26d409a71_add_podcast_audio_abandonment.py")
            assert await connection.run_sync(compare_podcast_metadata) == []
            await connection.execute(
                text(
                    "INSERT INTO assets (id, user_id, asset_type, title) VALUES ('episode', 'owner', 'podcast', 'Episode'), ('other-episode', 'other', 'podcast', 'Other episode')"
                )
            )
            await connection.execute(
                text(
                    "INSERT INTO asset_podcast_configs (asset_id) VALUES ('episode'), ('other-episode')"
                )
            )
        async with AsyncSession(engine, expire_on_commit=False) as session:
            with patch(
                "pkg.services.application.assets.record_asset_production_event", new=AsyncMock()
            ):
                created = await create_asset(
                    session,
                    user_id="owner",
                    body=AssetCreate(title="Atomic creation", asset_type="podcast"),
                )
            initialized = await podcasts.get_podcast(session, user_id="owner", asset_id=created.id)
            assert initialized.configuration.revision == 1
            assert initialized.configuration.voice_id == "Cherry"
            assert initialized.configuration.target_duration_minutes == 6
        await exercise_confirmed_scripts(engine)
        await exercise_audio_execution(engine)
        messages = [record.getMessage() for record in caplog.records if record.name == podcast_renders.__name__]
        assert any("stage=provider_response code=rate_limited http_status=429" in message for message in messages)
        assert any("exception_type=HTTPStatusError provider_error_code=Throttling.RateQuota retry_after_seconds=30" in message for message in messages)
        assert all("fixture-key" not in message and "private-fixture-error" not in message for message in messages)
        await exercise_pasted_script(engine)
        await exercise_web_materials(engine)
        async with AsyncSession(engine, expire_on_commit=False) as session:
            state = await podcasts.get_podcast(session, user_id="owner", asset_id="episode")
            assert state.configuration.revision == 1
            assert state.configuration.voice_id == "Cherry"
            assert state.audio_generation_available is False
            with pytest.raises(HTTPException) as foreign:
                await podcasts.get_podcast(session, user_id="other", asset_id="episode")
            assert foreign.value.status_code == 404

        async def update_voice(voice_id):
            async with AsyncSession(engine, expire_on_commit=False) as session:
                try:
                    return await podcasts.update_podcast(
                        session,
                        user_id="owner",
                        asset_id="episode",
                        body=PodcastConfigurationUpdate(base_revision=1, voice_id=voice_id),
                    )
                except HTTPException as error:
                    await session.rollback()
                    return error.status_code

        updates = await asyncio.gather(update_voice("Eldric Sage"), update_voice("Ethan"))
        assert sum(result == 409 for result in updates) == 1
        async with AsyncSession(engine, expire_on_commit=False) as session:
            state = await podcasts.get_podcast(session, user_id="owner", asset_id="episode")
            assert state.configuration.revision == 2
            assert state.configuration.voice_id in {"Eldric Sage", "Ethan"}

        async with engine.begin() as connection:
            await connection.execute(
                text(
                    "INSERT INTO asset_podcast_script_approvals (id, asset_id, config_revision, script_hash, input_hash, spoken_text, source_snapshot, config_snapshot, approved_by) VALUES ('approval', 'episode', 2, :hash, :hash, 'Approved text', '{}', '{}', 'owner'), ('foreign-approval', 'other-episode', 1, :hash, :hash, 'Other text', '{}', '{}', 'other')"
                ),
                {"hash": "a" * 64},
            )

        async def render(render_id, key, approval="approval", status="queued"):
            async with engine.begin() as connection:
                await connection.execute(
                    text(
                        "INSERT INTO asset_audio_renders (id, asset_id, script_approval_id, idempotency_key, input_hash, config_snapshot, budget_limit, status) VALUES (:id, 'episode', :approval, :key, :hash, '{}', 2, :status)"
                    ),
                    {
                        "id": render_id,
                        "approval": approval,
                        "key": key,
                        "hash": "b" * 64,
                        "status": status,
                    },
                )

        with pytest.raises(IntegrityError):
            await render("wrong-owner", "wrong-owner", approval="foreign-approval")
        await render("render", "key-one")
        with pytest.raises(IntegrityError):
            await render("parallel", "key-two")
        async with engine.begin() as connection:
            await connection.execute(
                text(
                    "UPDATE asset_audio_renders SET status = 'outcome_unknown' WHERE id = 'render'"
                )
            )
        with pytest.raises(IntegrityError):
            await render("uncertain-duplicate", "key-three")
        async with engine.begin() as connection:
            await connection.execute(
                text("UPDATE asset_audio_renders SET status = 'failed' WHERE id = 'render'")
            )
        with pytest.raises(IntegrityError):
            await render("same-key", "key-one", status="failed")
        await render("next-render", "key-two")
        async with engine.begin() as connection:
            await connection.execute(
                text(
                    "INSERT INTO asset_audio_segments (id, render_id, position, spoken_text, input_hash) VALUES ('segment', 'render', 0, 'Text', :hash)"
                ),
                {"hash": "c" * 64},
            )
            with pytest.raises(IntegrityError):
                async with connection.begin_nested():
                    await connection.execute(
                        text(
                            "INSERT INTO asset_audio_segments (id, render_id, position, spoken_text, input_hash) VALUES ('duplicate-position', 'render', 0, 'Text', :hash)"
                        ),
                        {"hash": "c" * 64},
                    )
            with pytest.raises(IntegrityError):
                async with connection.begin_nested():
                    await connection.execute(
                        text(
                            "INSERT INTO asset_audio_attempts (id, render_id, segment_id, attempt_number) VALUES ('wrong-render', 'next-render', 'segment', 1)"
                        )
                    )
            await connection.execute(
                text(
                    "INSERT INTO asset_audio_attempts (id, render_id, segment_id, attempt_number, status) VALUES ('attempt', 'render', 'segment', 1, 'outcome_unknown')"
                )
            )
            unknown = (
                await connection.execute(
                    text(
                        "SELECT billable_characters, reported_cost FROM asset_audio_attempts WHERE id = 'attempt'"
                    )
                )
            ).one()
            assert unknown.billable_characters is None and unknown.reported_cost is None
            with pytest.raises(IntegrityError):
                async with connection.begin_nested():
                    await connection.execute(
                        text(
                            "INSERT INTO asset_audio_attempts (id, render_id, segment_id, attempt_number) VALUES ('duplicate-attempt', 'render', 'segment', 1)"
                        )
                    )
            await connection.run_sync(run_migration, "downgrade", "a37c9e6f402b_add_podcast_audio_diagnostics.py")
            assert (await connection.execute(text("SELECT count(*) FROM asset_audio_attempts WHERE id='attempt'"))).scalar_one() == 1
            await connection.run_sync(run_migration, "upgrade", "a37c9e6f402b_add_podcast_audio_diagnostics.py")
            assert await connection.run_sync(compare_podcast_metadata) == []
            with pytest.raises(RuntimeError, match="Export and explicitly remove"):
                await connection.run_sync(run_migration, "downgrade", "b8e26d409a71_add_podcast_audio_abandonment.py")
            with pytest.raises(RuntimeError, match="Export and explicitly remove"):
                await connection.run_sync(run_migration, "downgrade")
            await connection.execute(text("DELETE FROM assets WHERE asset_type = 'podcast'"))
            for table in [
                "asset_podcast_configs",
                "asset_podcast_script_approvals",
                "asset_audio_renders",
                "asset_audio_segments",
                "asset_audio_attempts",
            ]:
                assert (
                    await connection.execute(text(f'SELECT count(*) FROM "{table}"'))
                ).scalar_one() == 0
            await connection.run_sync(run_migration, "downgrade")
            previous_asset = (
                await connection.execute(
                    text("SELECT title, metadata FROM assets WHERE id = 'old-blog'")
                )
            ).one()
            assert previous_asset.title == "Untouched" and previous_asset.metadata == {
                "custom": True
            }
            await connection.run_sync(run_migration, "upgrade")
    finally:
        await engine.dispose()
        if created_schema:
            async with admin.begin() as connection:
                await connection.execute(text(f'DROP SCHEMA "{schema}" CASCADE'))
        await admin.dispose()


async def exercise_audio_execution(engine):
    from pkg.services.application.podcast_tts import ProviderAudio, AudioOutcomeUnknown
    import io
    import wave

    session_factory = async_sessionmaker(engine, expire_on_commit=False)
    async with engine.begin() as connection:
        await connection.execute(
            text(
                "INSERT INTO sources (id,user_id,category_id,title,source_type,raw_content) VALUES ('audio-material','owner',1,'Audio material','web','Verified input')"
            )
        )

    class MemoryStorage:
        def __init__(self):
            self.files = {}

        async def upload_bytes(self, *, object_key, data, content_type):
            path = "minio://test/" + object_key
            self.files[path] = data
            return path

        async def get_object(self, path):
            return self.files[path]

    storage = MemoryStorage()
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(24000)
        output.writeframes(b"\x00\x00" * 2400)
    wav = buffer.getvalue()
    calls = []

    async def synthesize(text, voice, secret):
        calls.append(text)
        assert voice == "Cherry" and secret == "fixture-key"
        return ProviderAudio(wav, wav, Decimal("0.100"), "abc-123", len(text))

    async with session_factory() as session:
        with patch(
            "pkg.services.application.assets.record_asset_production_event", new=AsyncMock()
        ):
            draft = await podcasts.create_podcast(
                session,
                user_id="owner",
                body=PodcastCreate(
                    title="Audio episode",
                    brief="Angle",
                    draft_content="口播。" * 410,
                    source_refs=["audio-material"],
                    configuration=PodcastConfiguration(
                        information_cutoff_at=datetime.now(timezone.utc)
                    ),
                ),
            )
        draft = await podcasts.approve_podcast_script(
            session,
            user_id="owner",
            asset_id=draft.asset_id,
            body=PodcastApprovalRequest(base_input_hash=draft.input_hash),
        )
        preflight_body = PodcastAudioPreflightRequest(
            base_input_hash=draft.input_hash,
            budget_limit="2",
            credential_id=7,
            price_per_10k_characters="0.8",
        )
        report = await preflight_podcast_audio(
            session, user_id="owner", asset_id=draft.asset_id, body=preflight_body
        )
    request = PodcastAudioRenderRequest(
        **preflight_body.model_dump(),
        idempotency_key="same-authorized-operation",
        execution_fingerprint=report.execution_fingerprint,
        authorize_text_to_provider=True,
        acknowledge_billing_uncertainty=True,
    )

    async def queue(body):
        async with session_factory() as session:
            return await podcast_renders.create_audio_render(
                session, user_id="owner", asset_id=draft.asset_id, body=body
            )

    with (
        patch.object(podcast_policy.settings, "PODCAST_AUDIO_ENABLED", True),
        patch.object(podcast_policy, "pricing_policy_current", return_value=True),
        patch.object(podcast_policy.shutil, "which", return_value="/test/ffmpeg"),
    ):
        results = await asyncio.gather(queue(request), queue(request))
        assert results[0].id == results[1].id
        assert results[0].attempt_count == 0
        with pytest.raises(HTTPException) as reused:
            await queue(request.model_copy(update={"budget_limit": Decimal("1")}))
        assert reused.value.status_code == 409
        with pytest.raises(HTTPException) as active:
            await queue(request.model_copy(update={"idempotency_key": "different-operation"}))
        assert active.value.status_code == 409
        with (
            patch.object(podcast_renders, "synthesize_qwen", new=synthesize),
            patch.object(podcast_renders, "decrypt_secret", return_value="fixture-key"),
            patch.object(podcast_renders, "get_storage_service", return_value=storage),
            patch.object(
                podcast_renders,
                "assemble_mp3",
                new=AsyncMock(return_value=(b"fixture-mp3", Decimal("0.300"))),
            ),
        ):
            assert await podcast_renders.process_one_audio_render(session_factory)
            assert not await podcast_renders.process_one_audio_render(session_factory)
        async with session_factory() as session:
            history = await podcast_renders.list_audio_renders(
                session, user_id="owner", asset_id=draft.asset_id
            )
            ready = history[0]
            assert ready.status == "ready" and ready.ready_segment_count == ready.segment_count
            assert ready.attempt_count == len(calls) == ready.segment_count
            assert "".join(calls) == draft.spoken_text
            assert ready.reported_cost is None
            assert ready.reported_characters == len(draft.spoken_text)
            with patch.object(podcast_renders, "get_storage_service", return_value=storage):
                assert (
                    await podcast_renders.download_audio_render(
                        session, user_id="owner", asset_id=draft.asset_id, render_id=ready.id
                    )
                    == b"fixture-mp3"
                )
            with pytest.raises(HTTPException) as private:
                await podcast_renders.list_audio_renders(
                    session, user_id="other", asset_id=draft.asset_id
                )
            assert private.value.status_code == 404
            from pkg.services.application.assets import delete_asset

            with pytest.raises(HTTPException) as protected:
                await delete_asset(session, user_id="owner", asset_id=draft.asset_id)
            assert protected.value.status_code == 409
        replay = await queue(request)
        assert replay.status == "ready" and replay.id == ready.id
        cancelable = await queue(
            request.model_copy(update={"idempotency_key": "cancel-before-call"})
        )
        async with session_factory() as session:
            canceled = await podcast_renders.cancel_audio_render(
                session, user_id="owner", asset_id=draft.asset_id, render_id=cancelable.id
            )
            assert canceled.status == "canceled" and canceled.attempt_count == 0
        with pytest.raises(HTTPException) as low_price:
            await queue(
                request.model_copy(
                    update={
                        "idempotency_key": "unsafe-price-floor",
                        "price_per_10k_characters": Decimal("0.1"),
                    }
                )
            )
        assert low_price.value.status_code == 409
        with patch.object(podcast_policy.settings, "PODCAST_AUDIO_ENABLED", False):
            with pytest.raises(HTTPException) as disabled:
                await queue(request.model_copy(update={"idempotency_key": "deployment-disabled"}))
            assert disabled.value.status_code == 503
        changed = await queue(
            request.model_copy(update={"idempotency_key": "changed-input-before-call"})
        )
        no_call = AsyncMock()
        with (
            patch.object(
                podcast_renders,
                "get_podcast_draft",
                new=AsyncMock(return_value=draft.model_copy(update={"input_hash": "f" * 64})),
            ),
            patch.object(podcast_renders, "synthesize_qwen", new=no_call),
            patch.object(podcast_renders, "get_storage_service", return_value=storage),
        ):
            assert await podcast_renders.process_one_audio_render(session_factory)
        no_call.assert_not_awaited()
        async with session_factory() as session:
            history = await podcast_renders.list_audio_renders(
                session, user_id="owner", asset_id=draft.asset_id
            )
            assert (
                history[0].id == changed.id
                and history[0].status == "failed"
                and history[0].attempt_count == 0
            )
        queued = await queue(request.model_copy(update={"idempotency_key": "second-authorization"}))
        from pkg.services.application.podcast_tts import AudioFailure
        failures = AsyncMock(side_effect=AudioOutcomeUnknown("private-fixture-error fixture-key", diagnostic=AudioFailure(
            "provider_response", "rate_limited", 120000, 429, "abc-456",
            exception_type="HTTPStatusError", provider_error_code="Throttling.RateQuota", retry_after_seconds=30,
        ), characters=12))
        with (
            patch.object(podcast_renders, "synthesize_qwen", new=failures),
            patch.object(podcast_renders, "decrypt_secret", return_value="fixture-key"),
            patch.object(podcast_renders, "get_storage_service", return_value=storage),
        ):
            assert await podcast_renders.process_one_audio_render(session_factory)
            assert not await podcast_renders.process_one_audio_render(session_factory)
        assert failures.await_count == 1
        async with session_factory() as session:
            history = await podcast_renders.list_audio_renders(
                session, user_id="owner", asset_id=draft.asset_id
            )
            assert history[0].status == "outcome_unknown" and history[0].attempt_count == 1
            assert history[0].reported_characters == 12
            assert history[0].failure_details.stage == "provider_response"
            assert history[0].failure_details.code == "rate_limited"
            assert history[0].failure_details.exception_type == "HTTPStatusError"
            assert history[0].failure_details.provider_error_code == "Throttling.RateQuota"
            assert history[0].failure_details.retry_after_seconds == 30
            assert history[0].failure_details.provider_request_id == "abc-456"
            assert history[0].attempts[0].failure_details == history[0].failure_details
            assert history[0].attempts[0].completed_at is not None
            assert history[0].attempts[0].provider_request_id == "abc-456"
            stopped = await podcast_renders.cancel_audio_render(
                session, user_id="owner", asset_id=draft.asset_id, render_id=queued.id
            )
            assert stopped.status == "outcome_unknown"
        with pytest.raises(HTTPException) as uncertain:
            await queue(request.model_copy(update={"idempotency_key": "must-not-retry"}))
        assert uncertain.value.status_code == 409
        async with engine.begin() as connection:
            await connection.execute(
                text(
                    "UPDATE asset_audio_renders SET status='generating', lease_token='old-token', lease_expires_at=now() + interval '1 minute' WHERE id=:id"
                ),
                {"id": queued.id},
            )
        async with session_factory() as session:
            with pytest.raises(RuntimeError):
                await podcast_renders._fenced(session, queued.id, "not-the-owner")
        from pkg.schemas.application.podcast import PodcastAudioAbandonRequest
        acknowledgment = PodcastAudioAbandonRequest(acknowledge_billing_uncertainty=True, acknowledge_full_regeneration=True)
        async with session_factory() as session:
            with pytest.raises(HTTPException) as live:
                await podcast_renders.abandon_audio_render(session, user_id="owner", asset_id=draft.asset_id, render_id=queued.id, body=acknowledgment)
            assert live.value.status_code == 409
        async with engine.begin() as connection:
            await connection.execute(
                text(
                    "UPDATE asset_audio_renders SET lease_expires_at=now() - interval '1 second' WHERE id=:id"
                ),
                {"id": queued.id},
            )
        await podcast_renders.recover_expired_audio(session_factory)
        async with session_factory() as session:
            history = await podcast_renders.list_audio_renders(
                session, user_id="owner", asset_id=draft.asset_id
            )
            assert history[0].status == "outcome_unknown"

        async def abandon(user_id="owner", asset_id=draft.asset_id):
            async with session_factory() as session:
                return await podcast_renders.abandon_audio_render(session, user_id=user_id, asset_id=asset_id, render_id=queued.id, body=acknowledgment)

        with pytest.raises(HTTPException) as foreign:
            await abandon(user_id="other")
        assert foreign.value.status_code == 404
        with pytest.raises(HTTPException) as wrong_asset:
            await abandon(asset_id="episode")
        assert wrong_asset.value.status_code == 404
        outcomes = await asyncio.gather(abandon(), abandon())
        assert outcomes[0].status == outcomes[1].status == "abandoned"
        assert outcomes[0].abandonment == outcomes[1].abandonment
        assert outcomes[0].abandonment.abandoned_by == "owner"
        assert outcomes[0].abandonment.previous_status == "outcome_unknown"
        assert outcomes[0].attempt_count == 1
        assert outcomes[0].attempts[0].status == "outcome_unknown"
        assert outcomes[0].attempts[0].provider_request_id == "abc-456"
        assert outcomes[0].reported_cost is None
        assert not outcomes[0].can_abandon
        assert failures.await_count == 1
        async with session_factory() as session:
            with pytest.raises(RuntimeError):
                await podcast_renders._fenced(session, queued.id, "old-token")
            report = await preflight_podcast_audio(session, user_id="owner", asset_id=draft.asset_id, body=preflight_body)
            assert report.checks_passed and report.active_render_id is None
        replay = await queue(request.model_copy(update={"idempotency_key": "second-authorization"}))
        assert replay.id == queued.id and replay.status == "abandoned"
        with pytest.raises(HTTPException) as stale:
            await queue(request.model_copy(update={"idempotency_key": "stale-preflight-after-abandonment"}))
        assert stale.value.status_code == 409
        assert report.execution_fingerprint != request.execution_fingerprint
        new_task = await queue(request.model_copy(update={"idempotency_key": "new-explicit-authorization", "execution_fingerprint": report.execution_fingerprint}))
        assert new_task.id != queued.id and new_task.status == "queued"
        assert new_task.attempt_count == 0 and new_task.ready_segment_count == 0
        assert failures.await_count == 1
        async with session_factory() as session:
            with pytest.raises(HTTPException) as active:
                await podcast_renders.abandon_audio_render(session, user_id="owner", asset_id=draft.asset_id, render_id=new_task.id, body=acknowledgment)
            assert active.value.status_code == 409
        stopped_calls = []

        async def stop_during_synthesis(text, voice, secret):
            stopped_calls.append(text)
            async with session_factory() as session:
                stopped = await podcast_renders.cancel_audio_render(session, user_id="owner", asset_id=draft.asset_id, render_id=new_task.id)
                assert stopped.status == "outcome_unknown" and not stopped.can_abandon
            return ProviderAudio(wav, wav, Decimal("0.100"), "abc-789", len(text))

        with (
            patch.object(podcast_renders, "synthesize_qwen", new=stop_during_synthesis),
            patch.object(podcast_renders, "decrypt_secret", return_value="fixture-key"),
            patch.object(podcast_renders, "get_storage_service", return_value=storage),
        ):
            assert await podcast_renders.process_one_audio_render(session_factory)
            assert not await podcast_renders.process_one_audio_render(session_factory)
        assert len(stopped_calls) == 1
        async with session_factory() as session:
            history = await podcast_renders.list_audio_renders(session, user_id="owner", asset_id=draft.asset_id)
            assert history[0].status == "outcome_unknown" and history[0].completed_at is not None
            assert history[0].can_abandon


async def exercise_web_materials(engine):
    from pkg.schemas.discovery import DiscoveryWebSaveRequest
    from pkg.services.foundation.web_materials import save_web_materials

    session_factory = async_sessionmaker(engine, expire_on_commit=False)
    body = DiscoveryWebSaveRequest(
        query="latest topic",
        items=[
            {
                "title": "Selected search result",
                "url": "https://example.com/selected-story",
                "summary": "Search excerpt, not verified full text.",
                "source_name": "tavily",
                "published_at": "2026-10-15",
            }
        ],
    )

    async def save(user_id="owner", request=body):
        async with session_factory() as session:
            return await save_web_materials(session, user_id=user_id, body=request)

    results = await asyncio.gather(save(), save())
    assert sum(result.created for result in results) == 1
    source_id = results[0].items[0].id
    assert results[1].items[0].id == source_id
    assert results[0].items[0].metadata_["content_scope"] == "search_summary"
    assert results[0].items[0].metadata_["fact_check_status"] == "unverified"
    assert results[0].items[0].metadata_["review_status"] == "reviewed_kept"
    assert results[0].items[0].metadata_["published_at"] == "2026-10-15"
    assert results[0].items[0].metadata_["discovery_query"] == "latest topic"
    foreign = await save("other")
    assert foreign.items[0].id != source_id
    async with session_factory() as session:
        source = await session.get(Source, source_id)
        source.raw_content = "User expanded and verified the full page separately."
        source.title = "User edited title"
        source.content_hash = "a" * 64
        source.metadata_ = {"preserve": "user metadata"}
        await session.commit()
    repeated = await save(request=body.model_copy(update={"items": body.items * 2}))
    assert repeated.created == 0 and repeated.reused == 1
    assert len(repeated.items) == 1
    assert repeated.items[0].title == "User edited title"
    assert repeated.items[0].raw_content == "User expanded and verified the full page separately."
    assert repeated.items[0].content_hash == "a" * 64
    assert repeated.items[0].metadata_ == {"preserve": "user metadata"}
    async with session_factory() as session:
        session.add(
            Source(
                id="manually-imported-web-source",
                user_id="owner",
                category_id=1,
                title="Existing full page",
                source_type="web",
                url="https://example.com/manual",
                raw_content="Existing manually reviewed full text",
                metadata_={"preserve": True},
            )
        )
        await session.commit()
    manual = await save(
        request=DiscoveryWebSaveRequest(
            query="another query",
            items=[
                {
                    "title": "Do not replace the title",
                    "url": "https://example.com/manual",
                    "summary": "Do not replace full text",
                }
            ],
        )
    )
    assert manual.created == 0 and manual.items[0].id == "manually-imported-web-source"
    assert manual.items[0].raw_content == "Existing manually reviewed full text"
    assert manual.items[0].metadata_ == {"preserve": True}
    async with session_factory() as session:
        with patch(
            "pkg.services.application.assets.record_asset_production_event", new=AsyncMock()
        ):
            draft = await podcasts.create_podcast(
                session,
                user_id="owner",
                body=PodcastCreate(
                    title="Web research episode",
                    brief="My commentary",
                    draft_content="My manually reviewed script.",
                    source_refs=[source_id],
                    configuration=PodcastConfiguration(
                        information_cutoff_at=datetime(2026, 10, 16, tzinfo=timezone.utc)
                    ),
                ),
            )
        assert draft.materials[0]["id"] == source_id
        assert not draft.approval_issues
        approved = await podcasts.approve_podcast_script(
            session,
            user_id="owner",
            asset_id=draft.asset_id,
            body=PodcastApprovalRequest(base_input_hash=draft.input_hash),
        )
        assert approved.latest_approval.source_snapshot[0]["id"] == source_id


async def exercise_pasted_script(engine):
    async with AsyncSession(engine, expire_on_commit=False) as session:
        with patch(
            "pkg.services.application.assets.record_asset_production_event", new=AsyncMock()
        ):
            draft = await podcasts.create_podcast(
                session,
                user_id="owner",
                body=PodcastCreate(
                    title="粘贴博客成稿",
                    brief="分享已经写好的博客内容",
                    draft_content="这是用户已经写好的博客正文。\n\n直接用作本期口播稿。",
                    configuration=PodcastConfiguration(
                        information_cutoff_at=datetime(2026, 10, 16, tzinfo=timezone.utc)
                    ),
                ),
            )
        assert draft.materials == [] and draft.approval_issues == []
        assert draft.source_refs == draft.note_refs == draft.wiki_refs == []
        approved = await podcasts.approve_podcast_script(
            session,
            user_id="owner",
            asset_id=draft.asset_id,
            body=PodcastApprovalRequest(base_input_hash=draft.input_hash),
        )
        assert approved.approval_status == "current"
        assert approved.latest_approval.source_snapshot == []
        assert approved.latest_approval.spoken_text == draft.spoken_text
        report = await preflight_podcast_audio(
            session,
            user_id="owner",
            asset_id=draft.asset_id,
            body=PodcastAudioPreflightRequest(
                base_input_hash=approved.input_hash,
                budget_limit="2",
                credential_id=7,
                price_per_10k_characters="0.8",
            ),
        )
        assert report.checks_passed
        assert "".join(segment.spoken_text for segment in report.segments) == draft.spoken_text


async def exercise_confirmed_scripts(engine):
    cutoff = datetime(2026, 10, 16, tzinfo=timezone.utc)
    async with AsyncSession(engine, expire_on_commit=False) as session:
        with patch(
            "pkg.services.application.assets.record_asset_production_event", new=AsyncMock()
        ):
            state = await podcasts.create_podcast(
                session,
                user_id="owner",
                body=PodcastCreate(
                    title="Today's topic",
                    brief="My angle",
                    draft_content="First line  \r\nSecond line",
                    source_refs=["material"],
                    note_refs=["note"],
                    paragraph_sources=[
                        {
                            "paragraph_index": 0,
                            "text_hash": hashlib.sha256(b"First line\nSecond line").hexdigest(),
                            "material_refs": [{"kind": "source", "id": "material"}],
                        }
                    ],
                    configuration=PodcastConfiguration(
                        voice_id="Eldric Sage", information_cutoff_at=cutoff
                    ),
                ),
            )
        asset_id = state.asset_id
        assert state.configuration.voice_id == "Eldric Sage"
        assert state.approval_status == "unconfirmed" and not state.approval_issues
        assert state.spoken_text == "Today's topic\n\nFirst line\nSecond line"
        assert state.paragraph_sources[0].material_refs[0].id == "material"
        assert state.materials[0]["paragraph_indexes"] == [0]
        persisted = await podcasts.get_podcast_draft(session, user_id="owner", asset_id=asset_id)
        assert persisted.paragraph_sources == state.paragraph_sources
        approved = await podcasts.approve_podcast_script(
            session,
            user_id="owner",
            asset_id=asset_id,
            body=PodcastApprovalRequest(base_input_hash=state.input_hash),
        )
        first = approved.latest_approval
        assert approved.approval_status == "current" and first.approved_by == "owner"
        assert first.source_snapshot[0]["excerpt"] == "Initial story"
        assert first.source_snapshot[0]["paragraph_indexes"] == [0]
        assert first.config_snapshot["voice_id"] == "Eldric Sage"
        preflight_body = PodcastAudioPreflightRequest(
            base_input_hash=state.input_hash,
            budget_limit="2",
            credential_id=7,
            price_per_10k_characters="0.8",
        )
        report = await preflight_podcast_audio(
            session, user_id="owner", asset_id=asset_id, body=preflight_body
        )
        assert report.checks_passed and report.script_approval_id == first.id
        assert "".join(segment.spoken_text for segment in report.segments) == first.spoken_text
        assert report.configuration.voice_id == "Eldric Sage"
        assert not report.audio_generation_available
        assert (
            await session.execute(text("SELECT count(*) FROM asset_audio_renders"))
        ).scalar_one() == 0
        with pytest.raises(HTTPException) as foreign_credential:
            await preflight_podcast_audio(
                session,
                user_id="owner",
                asset_id=asset_id,
                body=preflight_body.model_copy(update={"credential_id": 8}),
            )
        assert foreign_credential.value.status_code == 404
        with pytest.raises(HTTPException) as foreign_episode:
            await preflight_podcast_audio(
                session, user_id="other", asset_id=asset_id, body=preflight_body
            )
        assert foreign_episode.value.status_code == 404
        duplicate = await podcasts.approve_podcast_script(
            session,
            user_id="owner",
            asset_id=asset_id,
            body=PodcastApprovalRequest(base_input_hash=state.input_hash),
        )
        assert duplicate.latest_approval.id == first.id
        values = state.model_dump(include=set(PodcastCreate.model_fields))
        values["configuration"] = state.configuration.model_dump(
            include=set(PodcastConfiguration.model_fields)
        )
        values["paragraph_sources"][0]["material_refs"] = [{"kind": "note", "id": "note"}]
        attributed = await podcasts.update_podcast_draft(
            session,
            user_id="owner",
            asset_id=asset_id,
            body=PodcastDraftUpdate(**values, base_input_hash=state.input_hash),
        )
        assert attributed.input_hash != state.input_hash
        assert attributed.configuration.revision == 1
        assert attributed.approval_status == "stale"
        assert attributed.latest_approval.source_snapshot[0]["paragraph_indexes"] == [0]
        values["paragraph_sources"] = [mapping.model_dump() for mapping in state.paragraph_sources]
        restored = await podcasts.update_podcast_draft(
            session,
            user_id="owner",
            asset_id=asset_id,
            body=PodcastDraftUpdate(**values, base_input_hash=attributed.input_hash),
        )
        assert restored.input_hash == state.input_hash
        assert restored.approval_status == "current"
        body = PodcastDraftUpdate(
            **state.model_dump(
                include={
                    "title",
                    "brief",
                    "outline",
                    "draft_content",
                    "source_refs",
                    "note_refs",
                    "wiki_refs",
                }
            ),
            configuration=PodcastConfiguration(voice_id="Ethan", information_cutoff_at=cutoff),
            base_input_hash=state.input_hash,
        )
        body.wiki_refs = ["wiki"]
        edited = await podcasts.update_podcast_draft(
            session, user_id="owner", asset_id=asset_id, body=body
        )
        assert edited.approval_status == "stale"
        assert edited.latest_approval == first
        assert edited.configuration.revision == 2
        assert not edited.audio_generation_available
        assert edited.status == "draft"
        assert edited.paragraph_sources == []
    async with AsyncSession(engine) as session:
        with pytest.raises(HTTPException) as stale:
            await podcasts.approve_podcast_script(
                session,
                user_id="owner",
                asset_id=asset_id,
                body=PodcastApprovalRequest(base_input_hash=state.input_hash),
            )
        assert stale.value.status_code == 409
    async with AsyncSession(engine) as session:
        with pytest.raises(HTTPException) as foreign:
            await podcasts.get_podcast_draft(session, user_id="other", asset_id=asset_id)
        assert foreign.value.status_code == 404

    async def confirm():
        async with AsyncSession(engine) as session:
            return await podcasts.approve_podcast_script(
                session,
                user_id="owner",
                asset_id=asset_id,
                body=PodcastApprovalRequest(base_input_hash=edited.input_hash),
            )

    confirmations = await asyncio.gather(confirm(), confirm())
    assert confirmations[0].latest_approval.id == confirmations[1].latest_approval.id

    for table, content_column, material_id in (
        ("sources", "raw_content", "material"),
        ("notes", "content", "note"),
        ("wiki_pages", "content", "wiki"),
    ):
        async with engine.begin() as connection:
            await connection.execute(
                text(f"UPDATE {table} SET {content_column} = 'Changed story' WHERE id = :id"),
                {"id": material_id},
            )
        async with AsyncSession(engine) as session:
            changed = await podcasts.get_podcast_draft(session, user_id="owner", asset_id=asset_id)
            assert changed.approval_status == "stale"
            assert changed.input_hash != edited.input_hash
            assert changed.latest_approval.source_snapshot[0]["excerpt"] == "Initial story"

    async def save(title):
        async with AsyncSession(engine) as session:
            values = changed.model_dump(
                include={
                    "title",
                    "brief",
                    "outline",
                    "draft_content",
                    "source_refs",
                    "note_refs",
                    "wiki_refs",
                }
            )
            values["title"] = title
            try:
                return await podcasts.update_podcast_draft(
                    session,
                    user_id="owner",
                    asset_id=asset_id,
                    body=PodcastDraftUpdate(
                        **values,
                        configuration=PodcastConfiguration.model_validate(
                            changed.configuration.model_dump(
                                exclude={"asset_id", "revision", "created_at", "updated_at"}
                            )
                        ),
                        base_input_hash=changed.input_hash,
                    ),
                )
            except HTTPException as error:
                return error.status_code

    saves = await asyncio.gather(save("First writer"), save("Second writer"))
    assert sum(result == 409 for result in saves) == 1
    async with engine.begin() as connection:
        await connection.execute(text("DELETE FROM sources WHERE id = 'material'"))
    async with AsyncSession(engine) as session:
        missing = await podcasts.get_podcast_draft(session, user_id="owner", asset_id=asset_id)
        assert missing.materials[0] == {"kind": "source", "id": "material", "available": False}
        assert missing.approval_issues and missing.approval_status == "stale"
        with pytest.raises(HTTPException) as invalid:
            await podcasts.approve_podcast_script(
                session,
                user_id="owner",
                asset_id=asset_id,
                body=PodcastApprovalRequest(base_input_hash=missing.input_hash),
            )
        assert invalid.value.status_code == 422
    async with engine.begin() as connection:
        await connection.execute(
            text("UPDATE assets SET status = 'archived' WHERE id = :id"), {"id": asset_id}
        )
    async with AsyncSession(engine) as session:
        with pytest.raises(HTTPException) as archived:
            await podcasts.approve_podcast_script(
                session,
                user_id="owner",
                asset_id=asset_id,
                body=PodcastApprovalRequest(base_input_hash=missing.input_hash),
            )
        assert archived.value.status_code == 409
    async with engine.begin() as connection:
        await connection.execute(text("DELETE FROM assets WHERE id = :id"), {"id": asset_id})
