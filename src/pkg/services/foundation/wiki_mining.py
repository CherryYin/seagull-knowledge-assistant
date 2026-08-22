from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from pkg.models.foundation.wiki import WikiArticleDraft, WikiInsightCandidate, WikiMiningRun


async def list_wiki_mining_runs(
    session: AsyncSession,
    *,
    user_id: str,
    limit: int = 20,
    offset: int = 0,
) -> tuple[list[WikiMiningRun], int]:
    count_rows = await session.execute(select(WikiMiningRun).where(WikiMiningRun.user_id == user_id))
    total = len(list(count_rows.scalars()))
    rows = await session.execute(
        select(WikiMiningRun)
        .where(WikiMiningRun.user_id == user_id)
        .order_by(WikiMiningRun.created_at.desc(), WikiMiningRun.id.desc())
        .offset(offset)
        .limit(limit)
    )
    return list(rows.scalars()), total


async def get_wiki_mining_run_detail(
    session: AsyncSession,
    *,
    user_id: str,
    run_id: int,
) -> tuple[WikiMiningRun | None, list[WikiInsightCandidate], list[WikiArticleDraft]]:
    run = await session.get(WikiMiningRun, run_id)
    if not run or run.user_id != user_id:
        return None, [], []
    insight_rows = await session.execute(
        select(WikiInsightCandidate)
        .where(WikiInsightCandidate.run_id == run_id, WikiInsightCandidate.user_id == user_id)
        .order_by(WikiInsightCandidate.id.asc())
    )
    article_rows = await session.execute(
        select(WikiArticleDraft)
        .where(WikiArticleDraft.run_id == run_id, WikiArticleDraft.user_id == user_id)
        .order_by(WikiArticleDraft.id.asc())
    )
    return run, list(insight_rows.scalars()), list(article_rows.scalars())
