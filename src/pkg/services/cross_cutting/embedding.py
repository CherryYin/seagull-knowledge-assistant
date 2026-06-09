from functools import lru_cache

from openai import AsyncOpenAI

from pkg.config import settings


class EmbeddingService:
    def __init__(self):
        self._client = None

    @property
    def client(self) -> AsyncOpenAI:
        if self._client is None:
            self._client = AsyncOpenAI(
                base_url=settings.resolved_embedding_api_base,
                api_key=settings.resolved_embedding_api_key,
            )
        return self._client

    async def embed_text(self, text: str, max_len: int = 8000) -> list[float]:
        text = (text or "").strip()[:max_len] or "empty"
        response = await self.client.embeddings.create(
            model=settings.EMBEDDING_MODEL,
            input=text,
            dimensions=settings.EMBEDDING_DIM,
            encoding_format="float",
        )
        return response.data[0].embedding

    async def embed_batch(self, texts: list[str], batch_size: int = 10) -> list[list[float]]:
        results: list[list[float]] = []
        for i in range(0, len(texts), batch_size):
            batch = texts[i : i + batch_size]
            response = await self.client.embeddings.create(
                model=settings.EMBEDDING_MODEL,
                input=batch,
                dimensions=settings.EMBEDDING_DIM,
                encoding_format="float",
            )
            results.extend(item.embedding for item in response.data)
        return results


@lru_cache(maxsize=1)
def get_embedding_service() -> EmbeddingService:
    return EmbeddingService()
