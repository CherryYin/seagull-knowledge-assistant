"""Embedding maintenance helpers for historical MemoryNode records."""

import logging

from sqlalchemy.ext.asyncio import AsyncSession

from pkg.models.foundation.memory import MemoryEmbedding, MemoryNode
from pkg.services.cross_cutting.embedding import get_embedding_service

logger = logging.getLogger(__name__)


async def upsert_memory_embedding(session: AsyncSession, node: MemoryNode) -> None:
    node_id = node.id
    await session.flush([node])
    try:
        embedding_service = get_embedding_service()
        title_vec = await embedding_service.embed_text(node.title)
        summary_vec = await embedding_service.embed_text(node.summary or node.title)
        content_vec = await embedding_service.embed_text(node.content or node.summary or node.title)
        with session.no_autoflush:
            existing = await session.get(MemoryEmbedding, node_id)
        if existing:
            existing.title_vec = title_vec
            existing.summary_vec = summary_vec
            existing.content_vec = content_vec
        else:
            session.add(
                MemoryEmbedding(
                    memory_node_id=node_id,
                    title_vec=title_vec,
                    summary_vec=summary_vec,
                    content_vec=content_vec,
                )
            )
    except Exception:
        logger.exception("Memory embedding generation failed for node %s", node_id)
