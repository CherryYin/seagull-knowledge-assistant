from typing import Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from pkg.api.deps import get_current_user
from pkg.config import settings
from pkg.db import get_session
from pkg.models.user import User
from pkg.services.cross_cutting.user_api_credentials import get_default_user_api_credential_secret

router = APIRouter()

CapabilityStatus = Literal["ready", "needs_setup", "experimental"]


class ModuleCapability(BaseModel):
    available: bool = True
    status: CapabilityStatus = "ready"
    label: str = "Ready"
    detail: str | None = None
    setup_route: str | None = None
    experimental: bool = False


class SystemCapabilities(BaseModel):
    modules: dict[str, ModuleCapability]


class UserProviderReadiness(BaseModel):
    configured: bool = False
    storage_available: bool = True


def _capability(
    *,
    configured: bool = True,
    detail: str | None = None,
    setup_route: str | None = None,
    experimental: bool = False,
) -> ModuleCapability:
    if experimental:
        return ModuleCapability(status="experimental", label="Experimental", detail=detail, setup_route=setup_route, experimental=True)
    if configured:
        return ModuleCapability(status="ready", label="Ready", detail=detail)
    return ModuleCapability(status="needs_setup", label="Needs setup", detail=detail, setup_route=setup_route)


async def _user_provider_readiness(session: AsyncSession, *, user_id: str, provider: str) -> UserProviderReadiness:
    secret, _config = await get_default_user_api_credential_secret(session, user_id=user_id, provider=provider)
    return UserProviderReadiness(configured=bool(secret), storage_available=True)


def build_system_capabilities(
    *,
    user: User,
    user_providers: dict[str, UserProviderReadiness] | None = None,
) -> SystemCapabilities:
    user_providers = user_providers or {}
    has_encryption_key = bool(settings.CREDENTIAL_ENCRYPTION_KEY.strip())
    has_any_llm_provider = any(provider.resolve_api_key().strip() for provider in settings.get_llm_providers())
    has_news_key = bool(settings.NEWSAPI_API_KEY.strip())
    has_openalex_key = bool(settings.OPENALEX_API_KEY.strip())
    has_semantic_scholar_key = bool(settings.SEMANTIC_SCHOLAR_API_KEY.strip())
    arxiv_has_user_agent = bool(settings.ARXIV_USER_AGENT.strip())
    has_user_news_key = user_providers.get("newsapi", UserProviderReadiness()).configured
    user_credentials_storage_available = all(provider.storage_available for provider in user_providers.values())
    has_any_connector_provider = has_news_key or has_openalex_key or has_semantic_scholar_key or arxiv_has_user_agent or has_user_news_key

    if not has_encryption_key:
        api_key_detail = "CREDENTIAL_ENCRYPTION_KEY is required before storing user API credentials."
    elif not user_credentials_storage_available:
        api_key_detail = "User API credentials storage is unavailable; run database migrations."
    else:
        api_key_detail = None

    modules = {
        "api-keys": _capability(
            configured=has_encryption_key and user_credentials_storage_available,
            detail=api_key_detail,
            setup_route="/settings/api-keys",
        ),
        "connectors": _capability(
            configured=has_any_connector_provider,
            detail=None if has_any_connector_provider else "Configure at least one connector provider, such as arXiv user-agent or NewsAPI/OpenAlex/Semantic Scholar credentials.",
            setup_route="/settings/connectors",
        ),
        "discover": _capability(),
        "wiki-review": _capability(experimental=True, detail="Wiki review suggestions are an advanced refinement workflow."),
        "review-suggestions": _capability(experimental=True, detail="Review suggestions are an advanced refinement workflow."),
        "memory-tree": _capability(experimental=True, detail="Memory Tree is an advanced knowledge graph view."),
        "wiki": _capability(experimental=True, detail="Wiki is an advanced synthesis workspace."),
        "assets": _capability(experimental=True, detail="Assets are generated from selected sources and notes."),
        "agent-chat": _capability(
            configured=has_any_llm_provider,
            detail=None if has_any_llm_provider else "Configure an LLM provider before using agent chat reliably.",
            setup_route="/settings/agents",
        ),
        "agent-profiles": _capability(
            configured=has_any_llm_provider,
            detail=None if has_any_llm_provider else "Configure an LLM provider before using custom agent profiles reliably.",
            setup_route="/settings/agents",
        ),
        "skills": _capability(),
        "workspace": _capability(experimental=True, detail="Workspace profile controls are advanced agent configuration."),
        "system-jobs": _capability(),
        "dashboard": _capability(),
    }

    if user.role == "admin":
        modules["admin-users"] = _capability()

    return SystemCapabilities(modules=modules)


@router.get("/capabilities", response_model=SystemCapabilities)
async def get_system_capabilities(user: User = Depends(get_current_user), session: AsyncSession = Depends(get_session)):
    user_providers = {
        "newsapi": await _user_provider_readiness(session, user_id=user.id, provider="newsapi"),
    }
    return build_system_capabilities(user=user, user_providers=user_providers)
