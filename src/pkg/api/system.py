from typing import Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from pkg.api.deps import get_current_user
from pkg.config import settings
from pkg.models.user import User

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


@router.get("/capabilities", response_model=SystemCapabilities)
async def get_system_capabilities(user: User = Depends(get_current_user)):
    has_encryption_key = bool(settings.CREDENTIAL_ENCRYPTION_KEY.strip())
    has_any_llm_provider = any(provider.resolve_api_key().strip() for provider in settings.get_llm_providers())
    has_news_key = bool(settings.NEWSAPI_API_KEY.strip())
    has_openalex_key = bool(settings.OPENALEX_API_KEY.strip())
    has_semantic_scholar_key = bool(settings.SEMANTIC_SCHOLAR_API_KEY.strip())
    arxiv_has_user_agent = bool(settings.ARXIV_USER_AGENT.strip())

    modules = {
        "api-keys": _capability(
            configured=has_encryption_key,
            detail=None if has_encryption_key else "CREDENTIAL_ENCRYPTION_KEY is required before storing user API credentials.",
            setup_route="/settings/api-keys",
        ),
        "connectors": _capability(
            configured=has_news_key or has_openalex_key or has_semantic_scholar_key or arxiv_has_user_agent,
            detail=None if has_news_key or has_openalex_key or has_semantic_scholar_key or arxiv_has_user_agent else "Configure at least one external connector provider.",
            setup_route="/settings/connectors",
        ),
        "discover": _capability(),
        "wiki-discovery": _capability(
            configured=has_any_llm_provider or not settings.WIKI_CONCEPT_DISCOVERY_LLM_ENABLED,
            detail="LLM refinement is disabled; rule-based discovery remains available." if not settings.WIKI_CONCEPT_DISCOVERY_LLM_ENABLED else None,
            setup_route="/settings/agents",
            experimental=True,
        ),
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
