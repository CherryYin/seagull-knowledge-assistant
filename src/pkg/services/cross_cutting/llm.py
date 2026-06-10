"""LLM model provider factory and dynamic model discovery.

Supports multiple providers via LLM_PROVIDERS config.
Falls back to legacy LLM_PROVIDER (azure/qwen) config for backward compatibility.
"""
import asyncio
import logging
import time
from types import SimpleNamespace
from typing import Any

import httpx
from openai import AsyncAzureOpenAI, AsyncOpenAI
from strands.models.openai import OpenAIModel

from pkg.config import LLMProviderConfig, settings

logger = logging.getLogger(__name__)

_MODEL_CACHE: dict[str, tuple[list[dict], float]] = {}
_CACHE_TTL = 3600


def _is_allowed_provider_model(provider: LLMProviderConfig, model_id: str) -> bool:
    normalized = model_id.strip().lower()
    if provider.id == "qwen":
        blocked_prefixes = (
            "qwen2",
            "qwen-1",
            "qwen1",
        )
        return not normalized.startswith(blocked_prefixes)
    return True


class _MiniMaxChatCompletions:
    def __init__(self, *, base_url: str, api_key: str, timeout: float = 120):
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.timeout = timeout

    async def create(self, *, model: str, messages: list[dict], **kwargs):
        payload: dict[str, Any] = {
            "model": model,
            "messages": messages,
        }
        if "temperature" in kwargs and kwargs["temperature"] is not None:
            payload["temperature"] = kwargs["temperature"]
        async with httpx.AsyncClient(timeout=self.timeout) as client:
            resp = await client.post(
                f"{self.base_url}/text/chatcompletion_v2",
                json=payload,
                headers={"Authorization": f"Bearer {self.api_key}"},
            )
            resp.raise_for_status()
            data = resp.json()
        text = (
            data.get("choices", [{}])[0].get("message", {}).get("content")
            or data.get("reply")
            or data.get("output_text")
            or ""
        )
        return SimpleNamespace(
            choices=[SimpleNamespace(message=SimpleNamespace(content=text))],
            raw=data,
        )


class _MiniMaxAsyncClient:
    def __init__(self, *, base_url: str, api_key: str, timeout: float = 120):
        self.chat = SimpleNamespace(
            completions=_MiniMaxChatCompletions(base_url=base_url, api_key=api_key, timeout=timeout)
        )


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
    started = time.monotonic()
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
                if isinstance(m, dict) and "id" in m and _is_allowed_provider_model(provider, str(m["id"]))
            ]
            models.sort(key=lambda m: m["id"])
        try:
            from pkg.services.cross_cutting.system_jobs import record_system_event

            await record_system_event(
                job_type="llm_model_discovery",
                title=f"Discover models: {provider.display_name}",
                status="completed",
                metadata={"provider_id": provider.id, "model_count": len(models)},
                duration_ms=round((time.monotonic() - started) * 1000, 2),
            )
        except Exception:
            logger.debug("Failed to record model discovery event", exc_info=True)
    except Exception as exc:
        logger.warning("Failed to discover models for provider %s", provider.id, exc_info=True)
        try:
            from pkg.services.cross_cutting.system_jobs import record_system_event

            await record_system_event(
                job_type="llm_model_discovery",
                title=f"Discover models: {provider.display_name}",
                status="failed",
                metadata={"provider_id": provider.id},
                error_message=str(exc),
                duration_ms=round((time.monotonic() - started) * 1000, 2),
            )
        except Exception:
            logger.debug("Failed to record model discovery failure", exc_info=True)

    _MODEL_CACHE[provider.id] = (models, now)
    return models


async def list_all_models() -> list[dict]:
    """Query all configured providers concurrently and return merged model list."""
    providers = settings.get_llm_providers()
    manual_models = settings.get_manual_llm_models()
    if not providers and not manual_models:
        return []

    results = await asyncio.gather(*(discover_models(p) for p in providers)) if providers else []
    merged: list[dict] = []
    for r in results:
        merged.extend(r)

    seen = {(item["provider_id"], item["id"]) for item in merged if "provider_id" in item and "id" in item}
    for item in manual_models:
        provider = settings.get_provider(item.provider_id)
        if provider is None:
            continue
        key = (item.provider_id, item.id)
        if key in seen or not _is_allowed_provider_model(provider, item.id):
            continue
        merged.append(
            {
                "id": item.id,
                "display_name": item.display_name or item.id,
                "provider_id": provider.id,
                "provider_name": provider.display_name,
            }
        )

    merged.sort(key=lambda item: (str(item.get("provider_name", "")), str(item.get("id", ""))))
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
                model_id=model_id or provider.default_model or settings.MINIMAX_MODEL or settings.QWEN_MODEL,
                **model_params,
            )

    # If model_id given without provider_id, try to find matching provider
    if model_id:
        for provider in settings.get_llm_providers():
            if provider.default_model == model_id:
                client = AsyncOpenAI(base_url=provider.base_url, api_key=provider.resolve_api_key())
                return OpenAIModel(client=client, model_id=model_id, **model_params)
        for item in settings.get_manual_llm_models():
            if item.id == model_id:
                provider = settings.get_provider(item.provider_id)
                if provider:
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
) -> tuple[Any, str]:
    """Create a plain AsyncOpenAI client + resolved model_id for non-agent LLM calls."""
    if provider_id:
        provider = settings.get_provider(provider_id)
        if provider:
            if provider.id == "minimax":
                client = _MiniMaxAsyncClient(base_url=provider.base_url, api_key=provider.resolve_api_key(), timeout=120)
                return client, model_id or provider.default_model or settings.MINIMAX_MODEL or "MiniMax-M3"
            client = AsyncOpenAI(base_url=provider.base_url, api_key=provider.resolve_api_key())
            return client, model_id or provider.default_model or settings.QWEN_MODEL

    if model_id:
        for item in settings.get_manual_llm_models():
            if item.id == model_id:
                provider = settings.get_provider(item.provider_id)
                if provider:
                    if provider.id == "minimax":
                        client = _MiniMaxAsyncClient(base_url=provider.base_url, api_key=provider.resolve_api_key(), timeout=120)
                        return client, model_id
                    client = AsyncOpenAI(base_url=provider.base_url, api_key=provider.resolve_api_key())
                    return client, model_id

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
