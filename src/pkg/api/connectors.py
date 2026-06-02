from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from pkg.api.deps import get_current_user
from pkg.db import get_session
from pkg.models.user import User
from pkg.services.connector_cache import connector_cache_key, mark_connector_item_saved, upsert_connector_search_items
from pkg.services.discovery import generate_discovery_items
from pkg.schemas.connector import (
    ArxivImportRequest,
    ArxivSearchRequest,
    ArxivSearchResponse,
    ConnectorImportResponse,
    GitHubImportRequest,
    GitHubRepoSearchRequest,
    GitHubRepoSearchResponse,
)
from pkg.services.connectors import (
    get_github_repo,
    import_arxiv_paper,
    import_github_repo,
    ArxivRateLimitError,
    search_arxiv,
    search_github_repos,
)

router = APIRouter()


@router.post("/arxiv/search", response_model=ArxivSearchResponse)
async def search_arxiv_connector(
    body: ArxivSearchRequest,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    try:
        items = await search_arxiv(
            query=body.query,
            author=body.author,
            category=body.category,
            paper_id=body.paper_id,
            date_from=body.date_from,
            date_to=body.date_to,
            max_results=body.max_results,
        )
    except ArxivRateLimitError as exc:
        raise HTTPException(status_code=429, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"arXiv search failed: {exc}") from exc
    cached = await upsert_connector_search_items(session, user_id=user.id, provider="arxiv", items=items)
    await generate_discovery_items(session, user_id=user.id, providers=["arxiv"], limit=body.max_results, commit=False)
    await session.commit()
    for item in items:
        cache_item = cached.get(connector_cache_key("arxiv", item))
        if cache_item:
            item.cache_id = cache_item.id
            item.cache_status = cache_item.status
            item.cache_expires_at = cache_item.expires_at
            item.source_id = cache_item.source_id
    return ArxivSearchResponse(items=items, total=len(items))


@router.post("/arxiv/import", response_model=ConnectorImportResponse, status_code=201)
async def import_arxiv_connector(
    body: ArxivImportRequest,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    paper = body.paper
    if paper is None:
        if not body.paper_id:
            raise HTTPException(status_code=422, detail="paper or paper_id is required")
        try:
            matches = await search_arxiv(paper_id=body.paper_id, max_results=1)
        except ArxivRateLimitError as exc:
            raise HTTPException(status_code=429, detail=str(exc)) from exc
        except Exception as exc:
            raise HTTPException(status_code=502, detail=f"arXiv lookup failed: {exc}") from exc
        if not matches:
            raise HTTPException(status_code=404, detail="arXiv paper not found")
        paper = matches[0]

    try:
        source, created, dedupe_key = await import_arxiv_paper(
            session,
            user_id=user.id,
            paper=paper,
            category_id=body.category_id,
            fetched_text=None,
        )
        await mark_connector_item_saved(session, user_id=user.id, provider="arxiv", item_key=connector_cache_key("arxiv", paper), source_id=source.id)
        await session.commit()
        await session.refresh(source)
    except ValueError as exc:
        await session.rollback()
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except Exception as exc:
        await session.rollback()
        raise HTTPException(status_code=500, detail=f"arXiv import failed: {exc}") from exc
    return ConnectorImportResponse(source=source, created=created, dedupe_key=dedupe_key)


@router.post("/github/search", response_model=GitHubRepoSearchResponse)
async def search_github_connector(
    body: GitHubRepoSearchRequest,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    try:
        items = await search_github_repos(
            query=body.query,
            language=body.language,
            topic=body.topic,
            min_stars=body.min_stars,
            pushed_after=body.pushed_after,
            max_results=body.max_results,
        )
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"GitHub search failed: {exc}") from exc
    cached = await upsert_connector_search_items(session, user_id=user.id, provider="github", items=items)
    await generate_discovery_items(session, user_id=user.id, providers=["github"], limit=body.max_results, commit=False)
    await session.commit()
    for item in items:
        cache_item = cached.get(connector_cache_key("github", item))
        if cache_item:
            item.cache_id = cache_item.id
            item.cache_status = cache_item.status
            item.cache_expires_at = cache_item.expires_at
            item.source_id = cache_item.source_id
    return GitHubRepoSearchResponse(items=items, total=len(items))


@router.post("/github/import", response_model=ConnectorImportResponse, status_code=201)
async def import_github_connector(
    body: GitHubImportRequest,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
):
    repo = body.repo
    if repo is None:
        if not body.full_name:
            raise HTTPException(status_code=422, detail="repo or full_name is required")
        try:
            repo = await get_github_repo(body.full_name, fetch_readme=body.fetch_readme)
        except Exception as exc:
            raise HTTPException(status_code=502, detail=f"GitHub repo lookup failed: {exc}") from exc

    try:
        source, created, dedupe_key = await import_github_repo(
            session,
            user_id=user.id,
            repo=repo,
            category_id=body.category_id,
        )
        await mark_connector_item_saved(session, user_id=user.id, provider="github", item_key=connector_cache_key("github", repo), source_id=source.id)
        await session.commit()
        await session.refresh(source)
    except ValueError as exc:
        await session.rollback()
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except Exception as exc:
        await session.rollback()
        raise HTTPException(status_code=500, detail=f"GitHub import failed: {exc}") from exc
    return ConnectorImportResponse(source=source, created=created, dedupe_key=dedupe_key)
