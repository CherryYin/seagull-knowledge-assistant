"""RSS topic summarizer — groups recent RSS articles by topic and creates detailed summaries.

Runs daily after the RSS fetcher. Collects articles from the past 24 hours,
sends them to the LLM for topic classification and comprehensive summarization,
then creates a Note per topic.
"""
import json
import logging
from datetime import datetime, timedelta, timezone

from openai import AsyncOpenAI
from pydantic import BaseModel
from sqlalchemy import and_, or_, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from pkg.config import settings
from pkg.db import async_session
from pkg.models.source import Source
from pkg.services.embedding import get_embedding_service

logger = logging.getLogger(__name__)

_MAX_LLM_RETRIES = 2
_LLM_TIMEOUT = 120


class TopicSummary(BaseModel):
    topic: str
    summary: str


_SYSTEM_PROMPT = """\
你是一个专业的信息分析师。请将以下 RSS 文章按主题分类，每个主题生成一篇**详细全面的综述**。

要求：
1. 识别文章中的不同主题，按主题分组
2. 每个主题的综述必须详细全面，不能只是简短摘要
3. 保留关键数据、具体观点、重要论据和结论
4. 分析不同文章之间的关联和差异
5. 在综述中引用原文来源标题（用【来源：标题】格式标注）
6. 使用清晰的 markdown 格式组织内容，包含小标题和要点
7. 如果某个主题只有一篇文章，也要详细展开其核心内容

输出严格的 JSON 数组格式（不要包含 markdown 代码块标记）：
[{"topic": "主题名称", "summary": "详细的 markdown 格式综述内容"}]
"""


def _build_llm_client() -> tuple[AsyncOpenAI, str]:
    """Build an LLM client following the provider pattern from daily_summarizer."""
    if settings.LLM_PROVIDER == "azure":
        client = AsyncOpenAI(
            base_url=(
                f"{settings.AZURE_OPENAI_ENDPOINT}"
                f"/openai/deployments/{settings.AZURE_OPENAI_DEPLOYMENT}"
            ),
            api_key=settings.AZURE_OPENAI_API_KEY,
            default_headers={"api-version": settings.AZURE_OPENAI_API_VERSION},
            timeout=_LLM_TIMEOUT,
        )
        return client, settings.AZURE_OPENAI_DEPLOYMENT
    client = AsyncOpenAI(
        base_url=settings.QWEN_API_BASE,
        api_key=settings.QWEN_API_KEY,
        timeout=_LLM_TIMEOUT,
    )
    return client, settings.QWEN_MODEL


def _parse_topics(raw: str) -> list[TopicSummary]:
    """Parse and validate LLM output into TopicSummary list."""
    cleaned = raw.strip()
    if cleaned.startswith("```"):
        cleaned = cleaned.split("\n", 1)[-1]
        if cleaned.endswith("```"):
            cleaned = cleaned[:-3]
        cleaned = cleaned.strip()

    data = json.loads(cleaned)
    if not isinstance(data, list):
        raise ValueError("Expected JSON array")
    return [TopicSummary(**item) for item in data]


async def summarize_rss_by_topic() -> list[str]:
    """Summarize recent RSS articles by topic. Returns list of created note IDs."""
    cutoff = datetime.now(timezone.utc) - timedelta(hours=24)
    cutoff_iso = cutoff.isoformat()

    async with async_session() as session:
        result = await session.execute(
            select(Source).where(
                or_(
                    and_(
                        text("metadata->>'feed_source_id' IS NOT NULL"),
                        Source.ingested_at >= cutoff,
                    ),
                    and_(
                        text("metadata->>'feed_type' = 'topic'"),
                        text("metadata->>'last_fetch_at' >= :cutoff_iso").bindparams(cutoff_iso=cutoff_iso),
                    ),
                ),
            ).order_by(Source.ingested_at.desc())
        )
        articles = list(result.scalars())

    if not articles:
        logger.info("No recent RSS articles to summarize")
        return []

    logger.info("Summarizing %d RSS articles by topic", len(articles))

    parts: list[str] = []
    for article in articles:
        meta = article.metadata_ or {}
        published = meta.get("published_at") or meta.get("last_fetch_at", "unknown")
        url = meta.get("article_url") or article.url or ""
        content = (article.raw_content or "")[:3000]
        parts.append(
            f"## {article.title}\n"
            f"发布时间: {published} | URL: {url}\n\n"
            f"{content}\n"
        )
    combined = "\n---\n\n".join(parts)

    client, model = _build_llm_client()
    topics: list[TopicSummary] = []

    for attempt in range(_MAX_LLM_RETRIES):
        try:
            response = await client.chat.completions.create(
                model=model,
                messages=[
                    {"role": "system", "content": _SYSTEM_PROMPT},
                    {"role": "user", "content": combined},
                ],
            )
            raw = response.choices[0].message.content or ""
            topics = _parse_topics(raw)

            token_usage = response.usage
            logger.info(
                "RSS summary LLM call: model=%s input_tokens=%s output_tokens=%s topics=%d",
                model,
                token_usage.prompt_tokens if token_usage else "?",
                token_usage.completion_tokens if token_usage else "?",
                len(topics),
            )
            break
        except json.JSONDecodeError:
            logger.warning("RSS summary LLM output not valid JSON (attempt %d)", attempt + 1)
        except Exception:
            logger.error("RSS summary LLM call failed (attempt %d)", attempt + 1, exc_info=True)

    if not topics:
        logger.error("RSS summary failed: no valid topics after %d attempts", _MAX_LLM_RETRIES)
        return []

    from pkg.api.notes import make_note_id, persist_note, put_note_markdown_oss
    from pkg.schemas.note import NoteCreate
    from pkg.api.categories import get_default_category_id

    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    note_ids: list[str] = []

    async with async_session() as session:
        default_cat_id = await get_default_category_id(session)
        article_ids = [a.id for a in articles]

        for topic in topics:
            title = f"RSS: {topic.topic} - {today}"
            body = NoteCreate(
                title=title,
                note_type="inbox",
                category_id=default_cat_id,
                content=topic.summary,
                status="seed",
                tags=["rss-summary", "auto-generated"],
                domains=["rss"],
                source_ids=article_ids,
            )
            note_id = make_note_id(title)
            try:
                storage_uri = await put_note_markdown_oss(note_id, topic.summary)
                note = await persist_note(
                    session=session,
                    body=body.model_copy(update={"id": note_id}),
                    user_id=articles[0].user_id,
                    file_path=storage_uri,
                    content_override=topic.summary,
                )
                note_ids.append(note.id)
            except Exception:
                logger.error("Failed to persist RSS topic note: %s", title, exc_info=True)

    logger.info("RSS summary complete: created %d topic notes", len(note_ids))
    return note_ids
