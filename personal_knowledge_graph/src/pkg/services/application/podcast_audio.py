import hashlib
from datetime import datetime, timezone
from decimal import Decimal, ROUND_UP

from fastapi import HTTPException
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from pkg.models.application.podcast import AssetAudioRender
from pkg.models.user_api_credential import UserApiCredential
from pkg.schemas.application.podcast import (
    PodcastAudioPreflight,
    PodcastAudioPreflightIssue,
    PodcastAudioPreflightRequest,
    PodcastAudioSegmentPlan,
    PodcastConfiguration,
)
from pkg.services.application.podcasts import get_podcast_draft
from pkg.services.application.podcasts import _digest
from pkg.services.application.podcast_policy import (
    MINIMUM_PRICE,
    SEGMENT_UTF16_LIMIT,
    SEGMENTATION_VERSION,
    PRICE_POLICY_ID,
    audio_execution_available,
    pricing_policy_current,
)


def reserved_characters(text: str) -> int:
    return 2 * sum(2 if ord(character) > 0xFFFF else 1 for character in text)


def segment_spoken_text(text: str) -> list[str]:
    segments = []
    remaining = text
    while remaining:
        units = 0
        limit = 0
        boundary = 0
        for position, character in enumerate(remaining):
            units += 2 if ord(character) > 0xFFFF else 1
            if units > SEGMENT_UTF16_LIMIT:
                break
            limit = position + 1
            if units >= SEGMENT_UTF16_LIMIT // 2 and (character.isspace() or character in "。！？!?；;"):
                boundary = limit
        end = len(remaining) if limit == len(remaining) else boundary or limit
        segments.append(remaining[:end])
        remaining = remaining[end:]
    return segments


def plan_audio_segments(text: str, price: Decimal | None) -> list[PodcastAudioSegmentPlan]:
    return [
        PodcastAudioSegmentPlan(
            position=position,
            spoken_text=segment,
            text_hash=hashlib.sha256(segment.encode()).hexdigest(),
            character_count=len(segment),
            reserved_character_count=reserved_characters(segment),
            estimated_cost=(
                (Decimal(reserved_characters(segment)) * price / 10000).quantize(
                    Decimal("0.0001"), rounding=ROUND_UP
                )
                if price is not None
                else None
            ),
        )
        for position, segment in enumerate(segment_spoken_text(text))
    ]


async def preflight_podcast_audio(
    session: AsyncSession, *, user_id: str, asset_id: str, body: PodcastAudioPreflightRequest
) -> PodcastAudioPreflight:
    draft = await get_podcast_draft(session, user_id=user_id, asset_id=asset_id)
    if draft.input_hash != body.base_input_hash:
        raise HTTPException(
            status_code=409, detail="Podcast inputs changed; save and confirm again"
        )
    approval = draft.latest_approval
    if (
        draft.status == "archived"
        or draft.approval_status != "current"
        or approval is None
        or draft.approval_issues
    ):
        raise HTTPException(
            status_code=409, detail="Confirm the current saved script before audio preflight"
        )
    if (
        approval.input_hash != draft.input_hash
        or approval.spoken_text != draft.spoken_text
        or hashlib.sha256(approval.spoken_text.encode()).hexdigest() != approval.script_hash
    ):
        raise HTTPException(
            status_code=409, detail="Script snapshot does not match; review and confirm again"
        )

    issues = []
    credential = None
    credential_ready = False
    if body.credential_id is not None:
        credential = (
            await session.execute(
                select(UserApiCredential).where(
                    UserApiCredential.id == body.credential_id,
                    UserApiCredential.user_id == user_id,
                )
            )
        ).scalar_one_or_none()
        if credential is None:
            raise HTTPException(status_code=404, detail="Audio credential not found")
        credential_ready = (
            credential.provider == "qwen"
            and credential.is_enabled
            and bool(credential.secret_encrypted)
            and (credential.config or {}).get("region", "cn-beijing") == "cn-beijing"
        )
        if not credential_ready:
            issues.append(
                PodcastAudioPreflightIssue(
                    code="credential_unavailable",
                    message="请选择本人已启用的 Qwen 凭据；配置地域必须匹配 cn-beijing。",
                )
            )
    else:
        issues.append(
            PodcastAudioPreflightIssue(
                code="credential_required", message="请选择本人的 Qwen 凭据，不使用部署级密钥兜底。"
            )
        )

    active = (
        await session.execute(
            select(AssetAudioRender)
            .where(
                AssetAudioRender.asset_id == asset_id,
                AssetAudioRender.status.in_(
                    ["queued", "generating", "assembling", "outcome_unknown"]
                ),
            )
            .limit(1)
        )
    ).scalar_one_or_none()
    if active is not None:
        issues.append(
            PodcastAudioPreflightIssue(
                code="active_render",
                message="已有活动音频任务或结果未知的调用，请先核查；已停止的任务可在下方确认放弃后重新预检，不会自动重试。",
            )
        )
    segments = plan_audio_segments(approval.spoken_text, body.price_per_10k_characters)
    abandoned_render_count = (
        await session.execute(
            select(func.count(AssetAudioRender.id)).where(
                AssetAudioRender.asset_id == asset_id,
                AssetAudioRender.status == "abandoned",
            )
        )
    ).scalar_one()
    estimated_cost = (
        sum((segment.estimated_cost for segment in segments), Decimal("0.0000"))
        if body.price_per_10k_characters is not None
        else None
    )
    sufficient = estimated_cost <= body.budget_limit if estimated_cost is not None else None
    if estimated_cost is None:
        issues.append(
            PodcastAudioPreflightIssue(
                code="price_unknown", message="尚未填写账户适用单价，费用未知，不等于零。"
            )
        )
    elif not sufficient:
        issues.append(
            PodcastAudioPreflightIssue(
                code="budget_exceeded", message="保守费用估算超过本次预算，请精简稿件或核对单价。"
            )
        )
    if body.price_per_10k_characters is not None and body.price_per_10k_characters < MINIMUM_PRICE:
        issues.append(
            PodcastAudioPreflightIssue(
                code="price_below_safety_floor",
                message="生成预算的预留单价不能低于当前安全价格下限，请核对账户价格后重新预检。",
            )
        )
    return PodcastAudioPreflight(
        asset_id=asset_id,
        input_hash=draft.input_hash,
        script_approval_id=approval.id,
        script_hash=approval.script_hash,
        configuration=PodcastConfiguration.model_validate(
            draft.configuration.model_dump(include=set(PodcastConfiguration.model_fields))
        ),
        credential_id=credential.id if credential is not None else None,
        credential_label=credential.label if credential is not None else None,
        credential_checks_passed=credential_ready,
        budget_limit=body.budget_limit,
        price_per_10k_characters=body.price_per_10k_characters,
        pricing_source="user_entered" if body.price_per_10k_characters is not None else None,
        character_count=len(approval.spoken_text),
        reserved_character_count=reserved_characters(approval.spoken_text),
        segments=segments,
        estimated_cost=estimated_cost,
        budget_sufficient=sufficient,
        active_render_id=active.id if active is not None else None,
        active_render_status=active.status if active is not None else None,
        checks_passed=not issues,
        execution_fingerprint=_digest(
            {
                "input_hash": draft.input_hash,
                "approval_id": approval.id,
                "credential_id": body.credential_id,
                "credential_fingerprint": hashlib.sha256(
                    credential.secret_encrypted.encode()
                ).hexdigest()
                if credential
                else None,
                "budget": str(body.budget_limit.normalize()),
                "price": str(body.price_per_10k_characters.normalize())
                if body.price_per_10k_characters is not None
                else None,
                "policy": PRICE_POLICY_ID,
                "segmentation": SEGMENTATION_VERSION,
                "abandoned_render_count": abandoned_render_count,
            }
        ),
        pricing_policy_id=PRICE_POLICY_ID,
        pricing_policy_current=pricing_policy_current(),
        audio_generation_available=audio_execution_available(),
        issues=issues,
        warnings=[
            "这是本地生成预检，不是执行授权；不会创建任务、发送口播文本或调用 TTS。",
            "单价由用户填写。按每个 UTF-16 单元预留两个计费字符，含标题、标点和空白，以覆盖汉字双字符计费；实际账单以服务商为准。",
            "估算逐段向上取整，仅覆盖一次合成，不含重试、存储、流量或其他模型费用，也不是账单或扣费硬上限。",
            "凭据仅检查归属、启用、提供方及配置地域，未解密或向服务商验证密钥、地域权限、余额和配额。",
            "分段按最多 300 个 UTF-16 单元规划，以缩短单次合成请求；目标时长不是实际测量时长。",
        ],
        checked_at=datetime.now(timezone.utc),
    )
