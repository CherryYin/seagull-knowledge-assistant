"""LLM model provider factory and dynamic model discovery.

Supports multiple providers via LLM_PROVIDERS config.
Falls back to legacy LLM_PROVIDER (azure/qwen) config for backward compatibility.
"""
import asyncio
import logging
import time
from typing import Any

import httpx
from openai import AsyncAzureOpenAI, AsyncOpenAI
from strands.models.openai import OpenAIModel

from pkg.config import LLMProviderConfig, settings

logger = logging.getLogger(__name__)

_MODEL_CACHE: dict[str, tuple[list[dict], float]] = {}
_CACHE_TTL = 3600


# ---------------------------------------------------------------------------
# Model discovery
# ---------------------------------------------------------------------------

async def discover_models(provider: LLMProviderConfig) -> list[dict]:
    """Query GET {base_url}/models for a single provider. Returns cached results within TTL."""
    now = time.monotonic()
    cached = _MODEL_CACHE.get(provider.id)
    if cached and now - cached[1] < _CACHE_TTL:
        return cached[0]

    models: list[dict] = []
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.get(
                f"{provider.base_url.rstrip('/')}/models",
                headers={"Authorization": f"Bearer {provider.resolve_api_key()}"},
            )
            resp.raise_for_status()
            data = resp.json().get("data", [])
            models = [
                {
                    "id": m["id"],
                    "display_name": m.get("id", ""),
                    "provider_id": provider.id,
                    "provider_name": provider.display_name,
                }
                for m in data
                if isinstance(m, dict) and "id" in m
            ]
            models.sort(key=lambda m: m["id"])
    except Exception:
        logger.warning("Failed to discover models for provider %s", provider.id, exc_info=True)

    _MODEL_CACHE[provider.id] = (models, now)
    return models


async def list_all_models() -> list[dict]:
    """Query all configured providers concurrently and return merged model list."""
    providers = settings.get_llm_providers()
    if not providers:
        return []
    results = await asyncio.gather(*(discover_models(p) for p in providers))
    merged: list[dict] = []
    for r in results:
        merged.extend(r)
    return merged


def invalidate_model_cache(provider_id: str | None = None):
    if provider_id:
        _MODEL_CACHE.pop(provider_id, None)
    else:
        _MODEL_CACHE.clear()


# ---------------------------------------------------------------------------
# Strands OpenAIModel factory (used by action agent)
# ---------------------------------------------------------------------------

def create_model(
    model_id: str | None = None,
    provider_id: str | None = None,
    temperature: float | None = None,
) -> OpenAIModel:
    params: dict[str, Any] = {}
    if temperature is not None:
        params["temperature"] = temperature
    model_params = {"params": params} if params else {}

    # If provider_id specified, look up from registry
    if provider_id:
        provider = settings.get_provider(provider_id)
        if provider:
            client = AsyncOpenAI(base_url=provider.base_url, api_key=provider.resolve_api_key())
            return OpenAIModel(
                client=client,
                model_id=model_id or provider.default_model or settings.QWEN_MODEL,
                **model_params,
            )

    # If model_id given without provider_id, try to find matching provider
    if model_id:
        for provider in settings.get_llm_providers():
            if provider.default_model == model_id:
                client = AsyncOpenAI(base_url=provider.base_url, api_key=provider.resolve_api_key())
                return OpenAIModel(client=client, model_id=model_id, **model_params)

    # Legacy fallback: use global LLM_PROVIDER setting
    if settings.LLM_PROVIDER == "azure":
        client = AsyncAzureOpenAI(
            api_key=settings.AZURE_OPENAI_API_KEY,
            api_version=settings.AZURE_OPENAI_API_VERSION,
            azure_endpoint=settings.AZURE_OPENAI_ENDPOINT,
        )
        return OpenAIModel(
            client=client,
            model_id=model_id or settings.AZURE_OPENAI_DEPLOYMENT,
            **model_params,
        )

    client = AsyncOpenAI(
        base_url=settings.QWEN_API_BASE,
        api_key=settings.QWEN_API_KEY,
    )
    return OpenAIModel(
        client=client,
        model_id=model_id or settings.QWEN_MODEL,
        **model_params,
    )


# ---------------------------------------------------------------------------
# Async client factory (for background services: rss_summarizer, etc.)
# ---------------------------------------------------------------------------

def create_async_client(
    model_id: str | None = None,
    provider_id: str | None = None,
) -> tuple[AsyncOpenAI, str]:
    """Create a plain AsyncOpenAI client + resolved model_id for non-agent LLM calls."""
    if provider_id:
        provider = settings.get_provider(provider_id)
        if provider:
            client = AsyncOpenAI(base_url=provider.base_url, api_key=provider.resolve_api_key())
            return client, model_id or provider.default_model or settings.QWEN_MODEL

    if settings.LLM_PROVIDER == "azure":
        client = AsyncOpenAI(
            base_url=(
                f"{settings.AZURE_OPENAI_ENDPOINT}"
                f"/openai/deployments/{settings.AZURE_OPENAI_DEPLOYMENT}"
            ),
            api_key=settings.AZURE_OPENAI_API_KEY,
            default_headers={"api-version": settings.AZURE_OPENAI_API_VERSION},
            timeout=120,
        )
        return client, model_id or settings.AZURE_OPENAI_DEPLOYMENT

    client = AsyncOpenAI(
        base_url=settings.QWEN_API_BASE,
        api_key=settings.QWEN_API_KEY,
        timeout=120,
    )
    return client, model_id or settings.QWEN_MODEL
