import asyncio
import base64
import logging
import random
import re
import time
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

import httpx
from sqlalchemy.ext.asyncio import AsyncSession

from pkg.api.sources import persist_source, upsert_source_embeddings
from pkg.config import settings
from pkg.db import async_session
from pkg.models.foundation.source import Source
from pkg.schemas.connector import ArxivPaper, GitHubRepo, NewsArticle
from pkg.schemas.source import SourceCreate
from pkg.services.foundation.web_extractor import WebPageFetchError, fetch_web_page
from pkg.services.foundation.source_review import merge_import_metadata
from pkg.services.cross_cutting.user_api_credentials import get_default_user_api_credential_secret

ARXIV_API_URL = "https://export.arxiv.org/api/query"
GITHUB_API_URL = "https://api.github.com"
NEWSAPI_EVERYTHING_PATH = "/everything"
CONNECTOR_USER_AGENT = "personal-knowledge-graph/0.1"
_arxiv_request_lock = asyncio.Lock()
_last_arxiv_request_at = 0.0
logger = logging.getLogger(__name__)


class ArxivRateLimitError(RuntimeError):
    pass


class NewsRateLimitError(RuntimeError):
    pass


class NewsProviderError(RuntimeError):
    def __init__(self, message: str, *, status_code: int | None = None, provider_code: str | None = None):
        super().__init__(message)
        self.status_code = status_code
        self.provider_code = provider_code


async def _throttle_arxiv_request() -> None:
    global _last_arxiv_request_at
    min_interval = max(float(settings.ARXIV_MIN_REQUEST_INTERVAL_SECONDS), 0.0)
    async with _arxiv_request_lock:
        now = time.monotonic()
        delay = min_interval - (now - _last_arxiv_request_at)
        if delay > 0:
            await asyncio.sleep(delay)
        _last_arxiv_request_at = time.monotonic()


def _arxiv_retry_delay(response: httpx.Response, attempt: int) -> float:
    retry_after = response.headers.get("Retry-After")
    if retry_after:
        try:
            return min(max(float(retry_after), 0.0), float(settings.ARXIV_RETRY_MAX_DELAY_SECONDS))
        except ValueError:
            pass
    base_delay = max(float(settings.ARXIV_RETRY_INITIAL_DELAY_SECONDS), 0.0)
    max_delay = max(float(settings.ARXIV_RETRY_MAX_DELAY_SECONDS), base_delay)
    delay = min(base_delay * (2 ** attempt), max_delay)
    jitter = random.uniform(0, min(1.0, delay * 0.1)) if delay > 0 else 0.0
    return delay + jitter


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).replace(tzinfo=None).isoformat()


def one_year_ago_date(reference: datetime | None = None) -> str:
    reference = reference or datetime.now(timezone.utc)
    if reference.tzinfo is None:
        reference = reference.replace(tzinfo=timezone.utc)
    return (reference - timedelta(days=365)).date().isoformat()


def _safe_id(value: str) -> str:
    return re.sub(r"[^a-zA-Z0-9._-]+", "-", value.strip()).strip("-").lower()


def canonical_arxiv_id(value: str) -> str:
    value = value.strip()
    value = value.removeprefix("http://arxiv.org/abs/").removeprefix("https://arxiv.org/abs/")
    value = value.removeprefix("http://arxiv.org/pdf/").removeprefix("https://arxiv.org/pdf/")
    return value.removesuffix(".pdf")


def arxiv_source_id(arxiv_id: str) -> str:
    return f"src-arxiv-{_safe_id(canonical_arxiv_id(arxiv_id))}"


def github_source_id(full_name: str) -> str:
    return f"src-github-{_safe_id(full_name.replace('/', '-'))}"


def news_source_id(provider: str, url: str) -> str:
    canonical_url = _canonicalize_news_url(url)
    return f"src-news-{_safe_id(provider)}-{_safe_id(canonical_url)[:48]}"


def _parse_datetime(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        try:
            return parsedate_to_datetime(value)
        except Exception:
            return None


def build_arxiv_query(*, query: str | None = None, author: str | None = None, category: str | None = None, paper_id: str | None = None, date_from: str | None = None, date_to: str | None = None) -> str:
    parts: list[str] = []
    if paper_id:
        return f"id:{canonical_arxiv_id(paper_id)}"
    if query:
        parts.append(f"all:{query}")
    if author:
        parts.append(f"au:{author}")
    if category:
        parts.append(f"cat:{category}")
    if date_from or date_to:
        start = (date_from or "190001010000").replace("-", "")
        end = (date_to or "299912312359").replace("-", "")
        if len(start) == 8:
            start += "0000"
        if len(end) == 8:
            end += "2359"
        parts.append(f"submittedDate:[{start}+TO+{end}]")
    return " AND ".join(parts) or "all:*"


def parse_arxiv_feed(payload: str) -> list[ArxivPaper]:
    ns = {"atom": "http://www.w3.org/2005/Atom", "arxiv": "http://arxiv.org/schemas/atom"}
    root = ET.fromstring(payload)
    papers: list[ArxivPaper] = []
    for entry in root.findall("atom:entry", ns):
        entry_id = (entry.findtext("atom:id", default="", namespaces=ns) or "").strip()
        arxiv_id_value = canonical_arxiv_id(entry_id)
        title = " ".join((entry.findtext("atom:title", default="", namespaces=ns) or "").split())
        abstract = " ".join((entry.findtext("atom:summary", default="", namespaces=ns) or "").split())
        authors = [" ".join((author.findtext("atom:name", default="", namespaces=ns) or "").split()) for author in entry.findall("atom:author", ns)]
        categories = [item.attrib.get("term", "") for item in entry.findall("atom:category", ns) if item.attrib.get("term")]
        doi = entry.findtext("arxiv:doi", default=None, namespaces=ns)
        pdf_url = None
        entry_url = entry_id or None
        for link in entry.findall("atom:link", ns):
            if link.attrib.get("title") == "pdf" or link.attrib.get("type") == "application/pdf":
                pdf_url = link.attrib.get("href")
            elif link.attrib.get("rel") == "alternate":
                entry_url = link.attrib.get("href") or entry_url
        if arxiv_id_value and title:
            papers.append(ArxivPaper(
                arxiv_id=arxiv_id_value,
                title=title,
                authors=[author for author in authors if author],
                abstract=abstract,
                categories=categories,
                published=_parse_datetime(entry.findtext("atom:published", default=None, namespaces=ns)),
                updated=_parse_datetime(entry.findtext("atom:updated", default=None, namespaces=ns)),
                pdf_url=pdf_url,
                entry_url=entry_url,
                doi=doi,
            ))
    return papers


async def search_arxiv(*, query: str | None = None, author: str | None = None, category: str | None = None, paper_id: str | None = None, date_from: str | None = None, date_to: str | None = None, max_results: int = 10, retries: int = 2, user_id: str | None = None) -> list[ArxivPaper]:
    if not paper_id and not date_from and not date_to:
        date_from = one_year_ago_date()
    search_query = build_arxiv_query(query=query, author=author, category=category, paper_id=paper_id, date_from=date_from, date_to=date_to)
    params = {"search_query": search_query, "start": 0, "max_results": max_results, "sortBy": "submittedDate", "sortOrder": "descending"}
    user_agent = settings.ARXIV_USER_AGENT or CONNECTOR_USER_AGENT
    if user_id:
        async with async_session() as session:
            user_secret, user_config = await get_default_user_api_credential_secret(session, user_id=user_id, provider="arxiv")
        user_agent = str(user_config.get("user_agent") or user_secret or user_agent).strip() or user_agent
    async with httpx.AsyncClient(timeout=20, headers={"User-Agent": user_agent}) as client:
        for attempt in range(retries + 1):
            await _throttle_arxiv_request()
            response = await client.get(ARXIV_API_URL, params=params)
            if response.status_code != 429:
                response.raise_for_status()
                break
            delay = _arxiv_retry_delay(response, attempt)
            logger.warning(
                "arXiv returned 429",
                extra={
                    "attempt": attempt + 1,
                    "retries": retries,
                    "delay_seconds": delay,
                    "search_query": search_query,
                },
            )
            if attempt >= retries:
                detail = f"arXiv rate limit exceeded; please retry later{f' after {delay:g} seconds' if delay else ''}."
                raise ArxivRateLimitError(detail)
            await asyncio.sleep(delay)
    return parse_arxiv_feed(response.text)


def arxiv_raw_content(paper: ArxivPaper, extra_text: str | None = None) -> str:
    parts = [
        f"# {paper.title}",
        f"arXiv ID: {paper.arxiv_id}",
        f"Authors: {', '.join(paper.authors) or 'Unknown'}",
        f"Categories: {', '.join(paper.categories) or 'Unknown'}",
    ]
    if paper.doi:
        parts.append(f"DOI: {paper.doi}")
    if paper.entry_url:
        parts.append(f"Entry: {paper.entry_url}")
    if paper.pdf_url:
        parts.append(f"PDF: {paper.pdf_url}")
    parts.extend(["", "## Abstract", paper.abstract])
    if extra_text:
        parts.extend(["", "## Fetched Text", extra_text])
    return "\n".join(parts)


async def import_arxiv_paper(session: AsyncSession, *, user_id: str, paper: ArxivPaper, category_id: int = 1, fetched_text: str | None = None) -> tuple[Source, bool, str]:
    canonical_id = canonical_arxiv_id(paper.arxiv_id)
    source_id = arxiv_source_id(canonical_id)
    metadata = {
        "connector": "arxiv",
        "dedupe_key": f"arxiv:{canonical_id}",
        "arxiv_id": canonical_id,
        "authors": paper.authors,
        "categories": paper.categories,
        "published": paper.published.isoformat() if paper.published else None,
        "updated": paper.updated.isoformat() if paper.updated else None,
        "pdf_url": paper.pdf_url,
        "entry_url": paper.entry_url,
        "doi": paper.doi,
        "fetch_status": "abstract_only" if not fetched_text else "text_fetched",
        "review_status": "imported_reviewable",
        "retention": "permanent",
        "kept_at": _utc_now_iso(),
        "fetched_at": _utc_now_iso(),
    }
    existing = await session.get(Source, source_id)
    raw_content = arxiv_raw_content(paper, fetched_text)
    if existing:
        if existing.user_id != user_id:
            raise ValueError("A source with this arXiv id already exists for another user")
        existing.title = paper.title
        existing.category_id = category_id
        existing.source_type = "article"
        existing.url = paper.entry_url or f"https://arxiv.org/abs/{canonical_id}"
        existing.raw_content = raw_content
        existing.metadata_ = merge_import_metadata(existing.metadata_, metadata)
        return existing, False, metadata["dedupe_key"]

    source = await persist_source(
        session=session,
        body=SourceCreate(
            id=source_id,
            title=paper.title,
            category_id=category_id,
            source_type="article",
            url=paper.entry_url or f"https://arxiv.org/abs/{canonical_id}",
            raw_content=raw_content,
            metadata=metadata,
        ),
        user_id=user_id,
    )
    return source, True, metadata["dedupe_key"]


def build_github_query(*, query: str, language: str | None = None, topic: str | None = None, min_stars: int | None = None, pushed_after: str | None = None) -> str:
    parts = [query.strip()]
    if language:
        parts.append(f"language:{language}")
    if topic:
        parts.append(f"topic:{topic}")
    if min_stars is not None:
        parts.append(f"stars:>={min_stars}")
    if pushed_after:
        parts.append(f"pushed:>={pushed_after}")
    return " ".join(part for part in parts if part)


async def _resolve_github_token(user_id: str | None = None) -> str | None:
    token = getattr(settings, "GITHUB_TOKEN", None)
    if user_id:
        async with async_session() as session:
            user_secret, _user_config = await get_default_user_api_credential_secret(session, user_id=user_id, provider="github")
        if user_secret:
            token = user_secret
    return token


async def _github_headers(user_id: str | None = None) -> dict[str, str]:
    headers = {"Accept": "application/vnd.github+json", "User-Agent": CONNECTOR_USER_AGENT}
    token = await _resolve_github_token(user_id)
    if token:
        headers["Authorization"] = f"Bearer {token}"
    return headers


def parse_github_repo(item: dict, readme: str | None = None) -> GitHubRepo:
    owner = item.get("owner") or {}
    license_info = item.get("license") or {}
    return GitHubRepo(
        full_name=item["full_name"],
        owner=owner.get("login") or item["full_name"].split("/")[0],
        name=item.get("name") or item["full_name"].split("/")[-1],
        description=item.get("description"),
        topics=item.get("topics") or [],
        language=item.get("language"),
        stars=item.get("stargazers_count") or 0,
        forks=item.get("forks_count") or 0,
        default_branch=item.get("default_branch"),
        pushed_at=_parse_datetime(item.get("pushed_at")),
        clone_url=item.get("clone_url"),
        html_url=item.get("html_url"),
        license=license_info.get("spdx_id") or license_info.get("name") if license_info else None,
        readme=readme,
    )


async def fetch_github_readme(full_name: str, *, user_id: str | None = None) -> str | None:
    async with httpx.AsyncClient(timeout=20, headers=await _github_headers(user_id)) as client:
        response = await client.get(f"{GITHUB_API_URL}/repos/{full_name}/readme")
        if response.status_code == 404:
            return None
        response.raise_for_status()
    payload = response.json()
    content = payload.get("content")
    if not content:
        return None
    try:
        return base64.b64decode(content).decode("utf-8", errors="replace")
    except Exception:
        return None


async def search_github_repos(*, query: str, language: str | None = None, topic: str | None = None, min_stars: int | None = None, pushed_after: str | None = None, max_results: int = 10, user_id: str | None = None) -> list[GitHubRepo]:
    pushed_after = pushed_after or one_year_ago_date()
    q = build_github_query(query=query, language=language, topic=topic, min_stars=min_stars, pushed_after=pushed_after)
    params = {"q": q, "sort": "stars", "order": "desc", "per_page": max_results}
    async with httpx.AsyncClient(timeout=20, headers=await _github_headers(user_id)) as client:
        response = await client.get(f"{GITHUB_API_URL}/search/repositories", params=params)
        response.raise_for_status()
    payload = response.json()
    return [parse_github_repo(item) for item in payload.get("items", [])]


async def get_github_repo(full_name: str, *, fetch_readme: bool = True, user_id: str | None = None) -> GitHubRepo:
    async with httpx.AsyncClient(timeout=20, headers=await _github_headers(user_id)) as client:
        response = await client.get(f"{GITHUB_API_URL}/repos/{full_name}")
        response.raise_for_status()
        item = response.json()
    readme = await fetch_github_readme(full_name, user_id=user_id) if fetch_readme else None
    return parse_github_repo(item, readme=readme)


def github_raw_content(repo: GitHubRepo) -> str:
    parts = [
        f"# {repo.full_name}",
        repo.description or "No description.",
        "",
        "## Repository Metadata",
        f"Owner: {repo.owner}",
        f"Language: {repo.language or 'Unknown'}",
        f"Topics: {', '.join(repo.topics) or 'None'}",
        f"Stars: {repo.stars}",
        f"Forks: {repo.forks}",
        f"Default branch: {repo.default_branch or 'Unknown'}",
        f"Pushed at: {repo.pushed_at.isoformat() if repo.pushed_at else 'Unknown'}",
        f"License: {repo.license or 'Unknown'}",
        f"URL: {repo.html_url}",
        f"Clone URL: {repo.clone_url or 'Unknown'}",
    ]
    if repo.readme:
        parts.extend(["", "## README", repo.readme])
    return "\n".join(parts)


def github_embedding_text(repo: GitHubRepo) -> str:
    return "\n".join([
        f"GitHub repository: {repo.full_name}",
        f"Description: {repo.description or 'No description.'}",
        f"Owner: {repo.owner}",
        f"Language: {repo.language or 'Unknown'}",
        f"Topics: {', '.join(repo.topics) or 'None'}",
        f"Stars: {repo.stars}",
        f"Forks: {repo.forks}",
        f"Default branch: {repo.default_branch or 'Unknown'}",
        f"License: {repo.license or 'Unknown'}",
        f"URL: {repo.html_url}",
        "Purpose: repo-level source summary for retrieval; README is preserved in raw_content for review.",
    ])


async def import_github_repo(session: AsyncSession, *, user_id: str, repo: GitHubRepo, category_id: int = 1) -> tuple[Source, bool, str]:
    source_id = github_source_id(repo.full_name)
    dedupe_key = f"github:{repo.full_name.lower()}"
    metadata = {
        "connector": "github",
        "dedupe_key": dedupe_key,
        "repo_full_name": repo.full_name,
        "owner": repo.owner,
        "topics": repo.topics,
        "language": repo.language,
        "stars": repo.stars,
        "forks": repo.forks,
        "default_branch": repo.default_branch,
        "pushed_at": repo.pushed_at.isoformat() if repo.pushed_at else None,
        "clone_url": repo.clone_url,
        "html_url": repo.html_url,
        "license": repo.license,
        "fetch_status": "readme_fetched" if repo.readme else "metadata_only",
        "embedding_strategy": "github_repo_summary_v1",
        "embedding_text": github_embedding_text(repo),
        "review_status": "imported_reviewable",
        "retention": "permanent",
        "kept_at": _utc_now_iso(),
        "fetched_at": _utc_now_iso(),
    }
    raw_content = github_raw_content(repo)
    existing = await session.get(Source, source_id)
    if existing:
        if existing.user_id != user_id:
            raise ValueError("A source with this GitHub repo already exists for another user")
        existing.title = repo.full_name
        existing.category_id = category_id
        existing.source_type = "github"
        existing.url = repo.html_url
        existing.raw_content = raw_content
        existing.metadata_ = merge_import_metadata(existing.metadata_, metadata)
        await upsert_source_embeddings(session, existing)
        return existing, False, dedupe_key

    source = await persist_source(
        session=session,
        body=SourceCreate(
            id=source_id,
            title=repo.full_name,
            category_id=category_id,
            source_type="github",
            url=repo.html_url,
            raw_content=raw_content,
            metadata=metadata,
        ),
        user_id=user_id,
    )
    return source, True, dedupe_key


def _news_headers(api_key: str | None = None) -> dict[str, str]:
    headers = {"User-Agent": CONNECTOR_USER_AGENT}
    api_key = api_key if api_key is not None else getattr(settings, "NEWSAPI_API_KEY", "")
    if api_key:
        headers["X-Api-Key"] = api_key
    return headers


def _canonicalize_news_url(url: str) -> str:
    stripped = (url or "").strip()
    if not stripped:
        return ""
    parts = urlsplit(stripped)
    query = [(key, value) for key, value in parse_qsl(parts.query, keep_blank_values=True) if key.lower() not in {"fbclid", "gclid", "ref"} and not key.lower().startswith("utm_")]
    normalized = parts._replace(scheme=parts.scheme.lower(), netloc=parts.netloc.lower(), query=urlencode(query, doseq=True), fragment="")
    return urlunsplit(normalized)


def _parse_newsapi_error(response: httpx.Response) -> NewsProviderError:
    message = f"News provider request failed with HTTP {response.status_code}."
    provider_code: str | None = None
    try:
        payload = response.json()
    except Exception:
        payload = {}
    if isinstance(payload, dict):
        provider_code = str(payload.get("code") or "").strip() or None
        provider_message = str(payload.get("message") or "").strip()
        status = str(payload.get("status") or "").strip()
        parts = []
        if provider_code:
            parts.append(provider_code)
        if provider_message:
            parts.append(provider_message)
        if parts:
            message = "News provider error: " + " - ".join(parts)
        elif status:
            message = f"News provider error: {status}"
    return NewsProviderError(message, status_code=response.status_code, provider_code=provider_code)


def parse_newsapi_article(item: dict, *, query: str | None = None, language: str | None = None, country: str | None = None) -> NewsArticle:
    source = item.get("source") or {}
    return NewsArticle(
        provider="newsapi",
        title=(item.get("title") or "").strip(),
        url=item.get("url") or "",
        source_name=source.get("name"),
        author=item.get("author"),
        description=item.get("description"),
        content=item.get("content"),
        published_at=_parse_datetime(item.get("publishedAt")),
        image_url=item.get("urlToImage"),
        language=language,
        country=country,
        query=query,
    )


def normalize_news_search_query(query: str) -> str:
    topics = [part.strip() for part in query.split(",") if part.strip()]
    if len(topics) <= 1:
        return query.strip()
    return " OR ".join(topics)


async def search_news_articles(*, query: str, language: str | None = None, country: str | None = None, from_date: str | None = None, to_date: str | None = None, sources: list[str] | None = None, domains: list[str] | None = None, max_results: int | None = None, user_id: str | None = None) -> list[NewsArticle]:
    query = normalize_news_search_query(query)
    provider = (settings.NEWS_PROVIDER or "newsapi").strip().lower()
    if provider != "newsapi":
        raise ValueError(f"Unsupported news provider: {provider}")
    resolved_api_key = getattr(settings, "NEWSAPI_API_KEY", "")
    resolved_base_url = (settings.NEWSAPI_BASE_URL or "https://newsapi.org/v2").rstrip("/")
    if user_id:
        async with async_session() as session:
            user_secret, user_config = await get_default_user_api_credential_secret(session, user_id=user_id, provider="newsapi")
        if user_secret:
            resolved_api_key = user_secret
        if user_config.get("base_url"):
            resolved_base_url = str(user_config["base_url"]).rstrip("/")
    params = {
        "q": query,
        "language": language or settings.NEWS_DEFAULT_LANGUAGE or None,
        "from": from_date or None,
        "to": to_date or None,
        "pageSize": max_results or settings.NEWS_DEFAULT_MAX_RESULTS,
        "sortBy": "publishedAt",
    }
    if sources:
        params["sources"] = ",".join(sources)
    if domains:
        params["domains"] = ",".join(domains)
    params = {key: value for key, value in params.items() if value not in (None, "", [])}
    async with httpx.AsyncClient(timeout=settings.NEWS_FETCH_TIMEOUT, headers=_news_headers(resolved_api_key)) as client:
        response = await client.get(f"{resolved_base_url}{NEWSAPI_EVERYTHING_PATH}", params=params)
        if response.status_code == 429:
            error = _parse_newsapi_error(response)
            raise NewsRateLimitError(str(error))
        if response.status_code >= 400:
            raise _parse_newsapi_error(response)
    payload = response.json()
    articles = payload.get("articles") or []
    return [parse_newsapi_article(item, query=query, language=language, country=country) for item in articles if item.get("title") and item.get("url")]


def news_raw_content(article: NewsArticle, extracted_text: str | None = None) -> str:
    parts = [f"# {article.title}"]
    if article.source_name:
        parts.append(f"Source: {article.source_name}")
    if article.author:
        parts.append(f"Author: {article.author}")
    if article.published_at:
        parts.append(f"Published At: {article.published_at.isoformat()}")
    parts.append(f"URL: {article.url}")
    if article.description:
        parts.extend(["", "## Summary", article.description])
    body_text = extracted_text or article.content
    if body_text:
        parts.extend(["", "## Content", body_text])
    return "\n".join(parts)


async def import_news_article(session: AsyncSession, *, user_id: str, article: NewsArticle, category_id: int = 1, fetch_full_text: bool = True) -> tuple[Source, bool, str]:
    canonical_url = _canonicalize_news_url(article.url)
    dedupe_key = f"{article.provider}:{canonical_url}"
    source_id = news_source_id(article.provider, canonical_url)
    extracted_text: str | None = None
    fetch_status = "api_summary_only"
    fetch_error: str | None = None
    if fetch_full_text and canonical_url:
        try:
            page = await fetch_web_page(canonical_url)
            extracted_text = page.text
            fetch_status = "full_text_fetched"
        except WebPageFetchError as exc:
            fetch_error = str(exc)
    metadata = {
        "kind": "news",
        "provider": article.provider,
        "connector": article.provider,
        "source_name": article.source_name,
        "author": article.author,
        "published_at": article.published_at.isoformat() if article.published_at else None,
        "description": article.description,
        "image_url": article.image_url,
        "language": article.language,
        "country": article.country,
        "query": article.query,
        "dedupe_key": dedupe_key,
        "fetch_status": fetch_status,
        "fetch_error": fetch_error,
        "review_status": "imported_reviewable",
        "retention": "permanent",
        "kept_at": _utc_now_iso(),
        "fetched_at": _utc_now_iso(),
    }
    raw_content = news_raw_content(article, extracted_text)
    existing = await session.get(Source, source_id)
    if existing:
        if existing.user_id != user_id:
            raise ValueError("A source with this news article already exists for another user")
        existing.title = article.title
        existing.category_id = category_id
        existing.source_type = "article"
        existing.url = canonical_url or article.url
        existing.raw_content = raw_content
        existing.metadata_ = merge_import_metadata(existing.metadata_, metadata)
        return existing, False, dedupe_key

    source = await persist_source(
        session=session,
        body=SourceCreate(
            id=source_id,
            title=article.title,
            category_id=category_id,
            source_type="article",
            url=canonical_url or article.url,
            raw_content=raw_content,
            metadata=metadata,
        ),
        user_id=user_id,
    )
    return source, True, dedupe_key
