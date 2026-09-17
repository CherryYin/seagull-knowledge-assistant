from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from pkg.api.deps import get_current_user
from pkg.db import get_session
from pkg.models.user import User
from pkg.schemas.library import LibrarySearchRequest, LibrarySearchResponse
from pkg.services.cross_cutting.activity import log_activity
from pkg.services.foundation.library import LibraryService

router = APIRouter()


@router.post("/search", response_model=LibrarySearchResponse)
async def search_library(
    body: LibrarySearchRequest,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    response = await LibraryService(session, user.id).search(body)
    await log_activity(
        user.id,
        "library_search",
        {
            "query": body.query,
            "mode": body.mode,
            "results": len(response.items),
            "entity_types": body.entity_types,
            "media_types": body.media_types,
        },
    )
    return response


@router.get("", response_model=LibrarySearchResponse)
async def list_library(
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    return await LibraryService(session, user.id).search(LibrarySearchRequest())
