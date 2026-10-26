import json
import hashlib
import uuid
from datetime import timezone
from functools import lru_cache
from pathlib import Path

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from pkg.models.application.podcast import PodcastConfig, PodcastScriptApproval
from pkg.models.foundation.source import Source
from pkg.models.foundation.note import Note
from pkg.models.foundation.wiki import WikiPage
from pkg.services.application.podcast_policy import audio_execution_available
from pkg.schemas.application.asset import AssetCreate
from pkg.schemas.application.podcast import (
    PodcastApprovalRequest,
    PodcastApprovalRead,
    PodcastConfiguration,
    PodcastConfigurationUpdate,
    PodcastCreate,
    PodcastDraft,
    PodcastDraftFields,
    PodcastDraftUpdate,
    PodcastParagraphSource,
    PodcastState,
    PodcastVoiceCatalog,
)
from pkg.services.application.assets import create_asset, get_asset


@lru_cache(maxsize=1)
def _voice_catalog() -> PodcastVoiceCatalog:
    payload = json.loads(
        Path(__file__).with_name("podcast_voices.json").read_text(encoding="utf-8")
    )
    return PodcastVoiceCatalog.model_validate(
        {
            "source": payload["source"],
            "checked_on": payload["checked_on"],
            "model": payload["model"],
            "items": payload["voices"],
        }
    )


def get_voice_catalog() -> PodcastVoiceCatalog:
    return _voice_catalog().model_copy(deep=True)


async def _owned_config(
    session: AsyncSession, *, user_id: str, asset_id: str, for_update: bool = False
) -> PodcastConfig:
    asset = await get_asset(session, user_id=user_id, asset_id=asset_id, for_update=for_update)
    if asset.asset_type != "podcast":
        raise HTTPException(status_code=409, detail="Asset is not a podcast")
    if for_update and asset.status == "archived":
        raise HTTPException(status_code=409, detail="Archived podcast configuration is read-only")
    statement = select(PodcastConfig).where(PodcastConfig.asset_id == asset.id)
    if for_update:
        statement = statement.with_for_update().execution_options(populate_existing=True)
    configuration = (await session.execute(statement)).scalar_one_or_none()
    if configuration is None:
        raise HTTPException(
            status_code=409,
            detail="Podcast configuration is missing; recreate the podcast through the supported API",
        )
    return configuration


async def get_podcast(session: AsyncSession, *, user_id: str, asset_id: str) -> PodcastState:
    configuration = await _owned_config(session, user_id=user_id, asset_id=asset_id)
    return PodcastState(
        asset_id=asset_id,
        configuration=configuration,
        audio_generation_available=audio_execution_available(),
    )


async def update_podcast(
    session: AsyncSession, *, user_id: str, asset_id: str, body: PodcastConfigurationUpdate
) -> PodcastState:
    configuration = await _owned_config(
        session, user_id=user_id, asset_id=asset_id, for_update=True
    )
    if configuration.revision != body.base_revision:
        raise HTTPException(
            status_code=409, detail="Podcast configuration changed; reload before saving"
        )
    if body.voice_id not in {voice.id for voice in _voice_catalog().items}:
        raise HTTPException(
            status_code=422,
            detail="Voice is not supported by the selected podcast model and region",
        )
    for name, value in body.model_dump(exclude={"base_revision"}).items():
        setattr(configuration, name, value)
    configuration.revision += 1
    await session.commit()
    await session.refresh(configuration)
    return PodcastState(
        asset_id=asset_id,
        configuration=configuration,
        audio_generation_available=audio_execution_available(),
    )


def _digest(value) -> str:
    return hashlib.sha256(
        json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()


def _configuration_snapshot(configuration: PodcastConfig) -> dict:
    snapshot = PodcastConfiguration.model_validate(configuration, from_attributes=True).model_dump(
        mode="json"
    )
    cutoff = configuration.information_cutoff_at
    snapshot["information_cutoff_at"] = (
        cutoff.astimezone(timezone.utc).isoformat() if cutoff else None
    )
    snapshot["revision"] = configuration.revision
    snapshot["reading_rules"] = "title-and-body-normalized-lines-v1"
    return snapshot


def _spoken_text(title: str, body: str) -> str:
    def normalize(text: str) -> str:
        return "\n".join(
            line.rstrip() for line in text.replace("\r\n", "\n").replace("\r", "\n").split("\n")
        ).strip()

    return "\n\n".join(part for part in (normalize(title), normalize(body)) if part)


def _validate_voice(configuration: PodcastConfiguration) -> None:
    if configuration.voice_id not in {voice.id for voice in _voice_catalog().items}:
        raise HTTPException(status_code=422, detail="Unsupported podcast voice")


async def _materials(
    session: AsyncSession, *, user_id: str, fields: PodcastDraftFields, lock: bool
) -> list[dict]:
    snapshots = []
    for kind, model, ids, content_fields in (
        (
            "source",
            Source,
            fields.source_refs,
            ("description", "raw_content", "content_hash", "url"),
        ),
        ("note", Note, fields.note_refs, ("abstract", "content")),
        ("wiki", WikiPage, fields.wiki_refs, ("summary", "content", "content_revision")),
    ):
        if not ids:
            continue
        statement = (
            select(model).where(model.user_id == user_id, model.id.in_(ids)).order_by(model.id)
        )
        statement = statement.execution_options(populate_existing=True)
        if lock:
            statement = statement.with_for_update(read=True)
        rows = {row.id: row for row in (await session.execute(statement)).scalars()}
        for material_id in ids:
            row = rows.get(material_id)
            if row is None:
                snapshots.append({"kind": kind, "id": material_id, "available": False})
                continue
            content = {name: getattr(row, name, None) for name in content_fields}
            snapshots.append(
                {
                    "kind": kind,
                    "id": material_id,
                    "available": True,
                    "title": row.title,
                    "content_hash": _digest({"title": row.title, **content}),
                    "excerpt": str(
                        next(
                            (
                                value
                                for value in content.values()
                                if isinstance(value, str) and value
                            ),
                            "",
                        )
                    )[:1000],
                }
            )
    return snapshots


async def _draft_state(
    session: AsyncSession, *, user_id: str, asset, configuration, lock: bool = False
) -> PodcastDraft:
    fields = PodcastDraftFields(
        **{
            name: getattr(asset, name, None) or ([] if name.endswith("_refs") else "")
            for name in PodcastDraftFields.model_fields
        }
    )
    materials = await _materials(session, user_id=user_id, fields=fields, lock=lock)
    paragraph_sources = [
        PodcastParagraphSource.model_validate(mapping)
        for mapping in (asset.metadata_ or {}).get("podcast_script_v1", [])
    ]
    draft_snapshot = fields.model_dump()
    if paragraph_sources:
        draft_snapshot["paragraph_sources"] = [
            mapping.model_dump() for mapping in paragraph_sources
        ]
        for material in materials:
            material["paragraph_indexes"] = [
                mapping.paragraph_index
                for mapping in paragraph_sources
                if any(
                    reference.kind == material["kind"] and reference.id == material["id"]
                    for reference in mapping.material_refs
                )
            ]
    snapshot = _configuration_snapshot(configuration)
    input_hash = _digest(
        {"draft": draft_snapshot, "materials": materials, "configuration": snapshot}
    )
    approval = (
        await session.execute(
            select(PodcastScriptApproval)
            .where(PodcastScriptApproval.asset_id == asset.id)
            .order_by(PodcastScriptApproval.created_at.desc(), PodcastScriptApproval.id.desc())
            .limit(1)
        )
    ).scalar_one_or_none()
    issues = []
    if not fields.brief.strip():
        issues.append("请填写本期角度与个人观点")
    if not fields.draft_content.strip():
        issues.append("请填写口播正文")
    if any(not material["available"] for material in materials):
        issues.append("部分素材已删除或无权访问，请移除或重新选择")
    if configuration.information_cutoff_at is None:
        issues.append("请设置本期信息截止时间")
    if asset.status == "archived":
        issues.append("已归档播客只读")
    status = (
        "unconfirmed"
        if approval is None
        else ("current" if approval.input_hash == input_hash else "stale")
    )
    return PodcastDraft(
        **fields.model_dump(),
        asset_id=asset.id,
        status=asset.status,
        configuration=configuration,
        input_hash=input_hash,
        spoken_text=_spoken_text(fields.title, fields.draft_content),
        materials=materials,
        latest_approval=approval,
        approval_status=status,
        approval_issues=issues,
        paragraph_sources=paragraph_sources,
        audio_generation_available=audio_execution_available(),
    )


async def get_podcast_draft(session: AsyncSession, *, user_id: str, asset_id: str) -> PodcastDraft:
    configuration = await _owned_config(session, user_id=user_id, asset_id=asset_id)
    asset = await get_asset(session, user_id=user_id, asset_id=asset_id)
    return await _draft_state(session, user_id=user_id, asset=asset, configuration=configuration)


async def create_podcast(
    session: AsyncSession, *, user_id: str, body: PodcastCreate
) -> PodcastDraft:
    _validate_voice(body.configuration)
    fields = body.model_dump(exclude={"configuration", "paragraph_sources"})
    asset = await create_asset(
        session, user_id=user_id, body=AssetCreate(asset_type="podcast", **fields), commit=False
    )
    await session.flush()
    if body.paragraph_sources:
        asset.metadata_ = {
            **(asset.metadata_ or {}),
            "podcast_script_v1": [mapping.model_dump() for mapping in body.paragraph_sources],
        }
    configuration = await _owned_config(session, user_id=user_id, asset_id=asset.id)
    for name, value in body.configuration.model_dump().items():
        setattr(configuration, name, value)
    await session.flush()
    await session.refresh(configuration)
    state = await _draft_state(session, user_id=user_id, asset=asset, configuration=configuration)
    await session.commit()
    return state


async def update_podcast_draft(
    session: AsyncSession, *, user_id: str, asset_id: str, body: PodcastDraftUpdate
) -> PodcastDraft:
    configuration = await _owned_config(
        session, user_id=user_id, asset_id=asset_id, for_update=True
    )
    asset = await get_asset(session, user_id=user_id, asset_id=asset_id)
    current = await _draft_state(
        session, user_id=user_id, asset=asset, configuration=configuration, lock=True
    )
    if current.input_hash != body.base_input_hash:
        raise HTTPException(
            status_code=409,
            detail="Podcast inputs changed; keep local edits and reload before saving",
        )
    _validate_voice(body.configuration)
    materials = await _materials(session, user_id=user_id, fields=body, lock=True)
    if any(not material["available"] for material in materials):
        raise HTTPException(status_code=404, detail="Unknown podcast material refs")
    candidate = body.configuration.model_dump(mode="json")
    previous = PodcastConfiguration.model_validate(configuration, from_attributes=True).model_dump(
        mode="json"
    )
    if candidate != previous:
        for name, value in body.configuration.model_dump().items():
            setattr(configuration, name, value)
        configuration.revision += 1
    for name in PodcastDraftFields.model_fields:
        setattr(asset, name, getattr(body, name))
    asset.metadata_ = {
        **(asset.metadata_ or {}),
        "podcast_script_v1": [mapping.model_dump() for mapping in body.paragraph_sources],
    }
    await session.flush()
    await session.refresh(configuration)
    state = await _draft_state(session, user_id=user_id, asset=asset, configuration=configuration)
    await session.commit()
    return state


async def approve_podcast_script(
    session: AsyncSession, *, user_id: str, asset_id: str, body: PodcastApprovalRequest
) -> PodcastDraft:
    configuration = await _owned_config(
        session, user_id=user_id, asset_id=asset_id, for_update=True
    )
    asset = await get_asset(session, user_id=user_id, asset_id=asset_id)
    state = await _draft_state(
        session, user_id=user_id, asset=asset, configuration=configuration, lock=True
    )
    if state.input_hash != body.base_input_hash:
        raise HTTPException(
            status_code=409, detail="Podcast inputs changed; review the saved script again"
        )
    if state.approval_issues:
        raise HTTPException(status_code=422, detail=state.approval_issues)
    if state.approval_status == "current":
        await session.commit()
        return state
    approval = PodcastScriptApproval(
        id="podcast-approval-" + uuid.uuid4().hex,
        asset_id=asset.id,
        config_revision=configuration.revision,
        script_hash=hashlib.sha256(state.spoken_text.encode()).hexdigest(),
        input_hash=state.input_hash,
        spoken_text=state.spoken_text,
        source_snapshot=state.materials,
        config_snapshot=_configuration_snapshot(configuration),
        approved_by=user_id,
    )
    session.add(approval)
    await session.flush()
    result = state.model_copy(
        update={
            "latest_approval": PodcastApprovalRead.model_validate(approval),
            "approval_status": "current",
        }
    )
    await session.commit()
    return result
