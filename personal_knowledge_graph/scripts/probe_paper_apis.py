"""Probe scholarly paper APIs for basic reachability and result quality.

Examples:
    .venv/bin/python scripts/probe_paper_apis.py --query "agent memory" --limit 3
    .venv/bin/python scripts/probe_paper_apis.py --query "retrieval augmented generation" --providers openalex semanticscholar crossref

This script performs lightweight search probes against:
- OpenAlex
- Semantic Scholar
- Crossref

It reports status code, latency, top result titles, and whether the API appears usable
for the current network and credentials.
"""

import argparse
import asyncio
import json
import logging
import sys
import time
from pathlib import Path

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from pkg.config import settings

logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")
logger = logging.getLogger(__name__)


async def probe_openalex(query: str, limit: int) -> dict:
    params = {"search": query, "per-page": limit}
    headers = {"User-Agent": "personal-knowledge-graph/0.1"}
    if settings.OPENALEX_API_KEY:
        params["api_key"] = settings.OPENALEX_API_KEY
    if settings.OPENALEX_POLITE_EMAIL:
        params["mailto"] = settings.OPENALEX_POLITE_EMAIL
    url = f"{settings.OPENALEX_API_URL.rstrip('/')}/works"
    started = time.perf_counter()
    async with httpx.AsyncClient(timeout=20, headers=headers) as client:
        response = await client.get(url, params=params)
    elapsed_ms = round((time.perf_counter() - started) * 1000, 2)
    payload = response.json() if response.headers.get("content-type", "").startswith("application/json") else {}
    items = payload.get("results", []) if isinstance(payload, dict) else []
    return {
        "provider": "openalex",
        "status_code": response.status_code,
        "ok": response.is_success,
        "latency_ms": elapsed_ms,
        "count": len(items),
        "titles": [item.get("display_name") for item in items[:3] if item.get("display_name")],
        "detail": payload.get("error") if isinstance(payload, dict) else None,
    }


async def probe_semanticscholar(query: str, limit: int) -> dict:
    url = "https://api.semanticscholar.org/graph/v1/paper/search"
    params = {
        "query": query,
        "limit": limit,
        "fields": "paperId,title,year,externalIds",
    }
    headers = {"User-Agent": settings.SEMANTIC_SCHOLAR_USER_AGENT}
    if settings.SEMANTIC_SCHOLAR_API_KEY:
        headers["x-api-key"] = settings.SEMANTIC_SCHOLAR_API_KEY
    started = time.perf_counter()
    async with httpx.AsyncClient(timeout=20, headers=headers) as client:
        response = await client.get(url, params=params)
    elapsed_ms = round((time.perf_counter() - started) * 1000, 2)
    payload = response.json() if response.headers.get("content-type", "").startswith("application/json") else {}
    items = payload.get("data", []) if isinstance(payload, dict) else []
    return {
        "provider": "semanticscholar",
        "status_code": response.status_code,
        "ok": response.is_success,
        "latency_ms": elapsed_ms,
        "count": len(items),
        "titles": [item.get("title") for item in items[:3] if item.get("title")],
        "detail": payload if response.status_code >= 400 else None,
    }


async def probe_crossref(query: str, limit: int) -> dict:
    url = "https://api.crossref.org/works"
    params = {"query": query, "rows": limit}
    headers = {"User-Agent": "personal-knowledge-graph/0.1 (mailto:devnull@example.com)"}
    started = time.perf_counter()
    async with httpx.AsyncClient(timeout=20, headers=headers) as client:
        response = await client.get(url, params=params)
    elapsed_ms = round((time.perf_counter() - started) * 1000, 2)
    payload = response.json() if response.headers.get("content-type", "").startswith("application/json") else {}
    items = (((payload.get("message") or {}).get("items")) if isinstance(payload, dict) else []) or []
    return {
        "provider": "crossref",
        "status_code": response.status_code,
        "ok": response.is_success,
        "latency_ms": elapsed_ms,
        "count": len(items),
        "titles": [((item.get("title") or [None])[0]) for item in items[:3] if item.get("title")],
        "detail": payload.get("message") if isinstance(payload, dict) and response.status_code >= 400 else None,
    }


PROBERS = {
    "openalex": probe_openalex,
    "semanticscholar": probe_semanticscholar,
    "crossref": probe_crossref,
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Probe scholarly paper APIs.")
    parser.add_argument("--query", default="agent memory", help="Search query to probe")
    parser.add_argument("--limit", type=int, default=3, help="Top result count per provider")
    parser.add_argument(
        "--providers",
        nargs="*",
        choices=sorted(PROBERS.keys()),
        default=["openalex", "semanticscholar", "crossref"],
        help="Providers to probe",
    )
    parser.add_argument("--json", action="store_true", help="Print machine-readable JSON output")
    return parser.parse_args()


async def main() -> None:
    args = parse_args()
    results = []
    for provider in args.providers:
        try:
            result = await PROBERS[provider](args.query, args.limit)
        except Exception as exc:
            result = {
                "provider": provider,
                "status_code": None,
                "ok": False,
                "latency_ms": None,
                "count": 0,
                "titles": [],
                "detail": str(exc),
            }
        results.append(result)

    if args.json:
        print(json.dumps(results, ensure_ascii=False, indent=2))
        return

    for result in results:
        status = "OK" if result["ok"] else "FAIL"
        logger.info(
            "%s | %s | status=%s latency=%sms count=%s",
            result["provider"],
            status,
            result["status_code"],
            result["latency_ms"],
            result["count"],
        )
        for title in result["titles"]:
            logger.info("  - %s", title)
        if result["detail"] and not result["ok"]:
            logger.warning("  detail: %s", result["detail"])


if __name__ == "__main__":
    asyncio.run(main())
