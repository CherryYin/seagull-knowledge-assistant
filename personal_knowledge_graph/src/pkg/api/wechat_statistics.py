from datetime import date

from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from pkg.api.deps import get_current_user
from pkg.db import get_session
from pkg.models.user import User
from pkg.schemas.application.wechat_statistics import WechatStatisticsRead, WechatStatisticsRequest, WechatStatisticsSaved
from pkg.services.application.wechat_statistics import get_statistics, sync_statistics

router = APIRouter()


@router.get("/wechat-statistics", response_model=WechatStatisticsSaved)
async def saved_statistics(credential_id: int = Query(gt=0), publication_date: date = Query(), user: User = Depends(get_current_user), session: AsyncSession = Depends(get_session)):
    from fastapi.exceptions import RequestValidationError
    from pydantic import ValidationError

    try:
        body = WechatStatisticsRequest(credential_id=credential_id, publication_date=publication_date)
    except ValidationError as error:
        raise RequestValidationError(error.errors()) from None
    return WechatStatisticsSaved(snapshot=await get_statistics(session, user_id=user.id, body=body))


@router.post("/wechat-statistics/sync", response_model=WechatStatisticsRead)
async def synchronize_statistics(body: WechatStatisticsRequest, user: User = Depends(get_current_user), session: AsyncSession = Depends(get_session)):
    return await sync_statistics(session, user_id=user.id, body=body)
