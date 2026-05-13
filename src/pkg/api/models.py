from fastapi import APIRouter, Depends

from pkg.api.deps import get_current_user
from pkg.models.user import User

router = APIRouter()


@router.get("/models")
async def list_models(user: User = Depends(get_current_user)):
    """Return available models from all configured LLM providers."""
    from pkg.services.llm import list_all_models

    return await list_all_models()
