"""LLM model provider factory for Strands Agents.

Supports two providers:
- azure: Azure OpenAI via AsyncAzureOpenAI client
- qwen: Qwen API via OpenAI-compatible endpoint
"""
from typing import Any

from openai import AsyncAzureOpenAI, AsyncOpenAI
from strands.models.openai import OpenAIModel

from pkg.config import settings


def create_model(model_id: str | None = None, temperature: float | None = None) -> OpenAIModel:
    params: dict[str, Any] = {}
    if temperature is not None:
        params["temperature"] = temperature

    if settings.LLM_PROVIDER == "azure":
        client = AsyncAzureOpenAI(
            api_key=settings.AZURE_OPENAI_API_KEY,
            api_version=settings.AZURE_OPENAI_API_VERSION,
            azure_endpoint=settings.AZURE_OPENAI_ENDPOINT,
        )
        return OpenAIModel(
            client=client,
            model_id=model_id or settings.AZURE_OPENAI_DEPLOYMENT,
            **({"params": params} if params else {}),
        )
    else:
        client = AsyncOpenAI(
            base_url=settings.QWEN_API_BASE,
            api_key=settings.QWEN_API_KEY,
        )
        return OpenAIModel(
            client=client,
            model_id=model_id or settings.QWEN_MODEL,
            **({"params": params} if params else {}),
        )
