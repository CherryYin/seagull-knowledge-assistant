from __future__ import annotations

import argparse
import asyncio
import json
import os
import socket
import subprocess
import sys
import tempfile
import time
import uuid
from pathlib import Path

import httpx
from dotenv import load_dotenv
from sqlalchemy import select


LAB_ROOT = Path(__file__).resolve().parents[1]
WORKSPACE_ROOT = LAB_ROOT.parent
PKG_ROOT = WORKSPACE_ROOT / "personal_knowledge_graph"
BFF_ROOT = WORKSPACE_ROOT / "bff"

load_dotenv(PKG_ROOT / ".env")
sys.path.insert(0, str(PKG_ROOT / "src"))

from pkg.db import async_session  # noqa: E402
from pkg.models.user import User  # noqa: E402


def free_port() -> int:
    with socket.socket() as server:
        server.bind(("127.0.0.1", 0))
        return int(server.getsockname()[1])


async def wait_for_url(url: str, timeout_seconds: float = 15) -> None:
    deadline = time.monotonic() + timeout_seconds
    async with httpx.AsyncClient(timeout=2) as client:
        while time.monotonic() < deadline:
            try:
                response = await client.get(url)
                if response.status_code < 500:
                    return
            except httpx.HTTPError:
                pass
            await asyncio.sleep(0.2)
    raise RuntimeError(f"service did not become ready: {url}")


async def active_admin_username() -> str:
    async with async_session() as database:
        result = await database.execute(
            select(User.username)
            .where(User.role == "admin", User.is_active.is_(True))
            .limit(1)
        )
        username = result.scalar_one_or_none()
    if not username:
        raise RuntimeError("no active PKG admin user is available for smoke")
    return username


async def stream_chat(client: httpx.AsyncClient, session_id: str) -> list[str]:
    event_types: list[str] = []
    async with client.stream(
        "POST",
        "/api/chat",
        json={
            "prompt": "Reply with OK only.",
            "preset": "knowledge-lab",
            "session_id": session_id,
            "create_session": True,
        },
        timeout=120,
    ) as response:
        response.raise_for_status()
        async for line in response.aiter_lines():
            if not line.startswith("data: "):
                continue
            try:
                event = json.loads(line[6:])
            except json.JSONDecodeError:
                continue
            event_types.append(str(event.get("type")))
    return event_types


async def run_smoke(*, skip_chat: bool) -> dict[str, object]:
    password = os.environ.get("ADMIN_INIT_PASSWORD")
    if not password:
        raise RuntimeError("ADMIN_INIT_PASSWORD is required in personal_knowledge_graph/.env")
    username = await active_admin_username()
    port = free_port()
    bff_url = f"http://127.0.0.1:{port}"
    temporary_directory = tempfile.TemporaryDirectory(prefix="seagull-four-service-smoke-")
    memory_path = Path(temporary_directory.name) / "agent-memory.json"
    process = subprocess.Popen(
        ["node", "src/index.js"],
        cwd=BFF_ROOT,
        env={
            **os.environ,
            "PORT": str(port),
            "PKG_API_URL": "http://127.0.0.1:8000",
            "HARNESS_API_URL": "http://127.0.0.1:3080",
            "AGENT_MEMORY_STORE_PATH": str(memory_path),
        },
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    note_id = f"note-smoke-{uuid.uuid4()}"
    results: dict[str, object] = {}
    try:
        await wait_for_url(f"{bff_url}/api/health")
        async with httpx.AsyncClient(base_url=bff_url, timeout=30) as client:
            for name, url in {
                "pkg": "http://127.0.0.1:8000/health",
                "harness": "http://127.0.0.1:3080/",
                "bff": f"{bff_url}/api/health",
                "seagull": "http://127.0.0.1:5173/",
            }.items():
                response = await client.get(url)
                response.raise_for_status()
                results[f"health_{name}"] = response.status_code

            login = await client.post(
                "/api/auth/login",
                json={"username": username, "password": password},
            )
            login.raise_for_status()
            results["login"] = login.status_code

            for path in (
                "/api/auth/me",
                "/api/sources?limit=2",
                "/api/notes?limit=2",
                "/api/wiki?limit=2",
                "/api/assets?limit=2",
                "/api/sessions",
                "/api/harness/memories",
            ):
                response = await client.get(path)
                response.raise_for_status()
            results["core_reads"] = True

            search = await client.post(
                "/api/search",
                json={"query": "test", "mode": "sql", "top_k": 3},
            )
            search.raise_for_status()
            results["search_items"] = len(search.json())

            note = await client.post(
                "/api/notes",
                json={
                    "id": note_id,
                    "title": "Four-service smoke",
                    "note_type": "inbox",
                    "tags": ["smoke", "explicit-save"],
                    "content": "Temporary note created by four-service smoke.",
                    "status": "seed",
                },
            )
            note.raise_for_status()
            deleted_note = await client.delete(f"/api/notes/{note_id}")
            if deleted_note.status_code != 204:
                raise RuntimeError(f"Note delete returned {deleted_note.status_code}")
            results["note_crud"] = True

            candidate = await client.post(
                "/api/harness/memory-candidates",
                json={
                    "proposedScopeType": "global",
                    "proposedKind": "preference",
                    "title": "Smoke recall",
                    "content": "For this smoke only, prefer concise replies.",
                    "reason": "Four-service recall audit smoke",
                    "provenance": {
                        "sessionId": "smoke-source",
                        "eventIds": ["smoke-event"],
                        "toolCallIds": [],
                    },
                },
            )
            candidate.raise_for_status()
            candidate_id = candidate.json()["id"]
            if candidate.json()["status"] != "pending":
                raise RuntimeError("new Agent Memory Candidate was not pending")
            before_accept = await client.get("/api/harness/memories")
            before_accept.raise_for_status()
            if before_accept.json()["memories"]:
                raise RuntimeError("pending candidate became active without confirmation")
            edited = await client.patch(
                f"/api/harness/memory-candidates/{candidate_id}",
                json={"content": "Smoke Memory was explicitly confirmed."},
            )
            edited.raise_for_status()
            accepted = await client.post(
                f"/api/harness/memory-candidates/{candidate_id}/accept",
                json={},
            )
            accepted.raise_for_status()
            memory_id = accepted.json()["memory"]["id"]
            session_ids: list[str] = []
            results["memory_lifecycle"] = True

            if not skip_chat:
                active_session = f"smoke-active-{uuid.uuid4()}"
                archived_session = f"smoke-archived-{uuid.uuid4()}"
                session_ids.extend((active_session, archived_session))
                active_events = await stream_chat(client, active_session)
                active_audits = await client.get(
                    f"/api/harness/memory-recalls?session_id={active_session}"
                )
                active_audits.raise_for_status()
                active_matches = len(active_audits.json()["items"][-1]["matches"])
                archived = await client.post(f"/api/harness/memories/{memory_id}/archive")
                archived.raise_for_status()
                archived_events = await stream_chat(client, archived_session)
                archived_audits = await client.get(
                    f"/api/harness/memory-recalls?session_id={archived_session}"
                )
                archived_audits.raise_for_status()
                archived_matches = len(archived_audits.json()["items"][-1]["matches"])
                if active_matches < 1 or archived_matches != 0:
                    raise RuntimeError(
                        f"active-only recall failed: active={active_matches}, archived={archived_matches}"
                    )
                results["active_chat_events"] = active_events
                results["archived_chat_events"] = archived_events
                results["active_recall_matches"] = active_matches
                results["archived_recall_matches"] = archived_matches

            deleted_memory = await client.delete(f"/api/harness/memories/{memory_id}")
            deleted_memory.raise_for_status()
            for session_id in session_ids:
                deleted_session = await client.delete(f"/api/sessions/{session_id}")
                if deleted_session.status_code != 204:
                    raise RuntimeError(
                        f"Session cleanup returned {deleted_session.status_code}: {session_id}"
                    )
            results["cleanup"] = True
    finally:
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)
        temporary_directory.cleanup()
    return results


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run PKG/Harness/BFF/Seagull smoke checks")
    parser.add_argument(
        "--skip-chat",
        action="store_true",
        help="Skip real LLM Chat and active-only recall verification",
    )
    return parser.parse_args()


if __name__ == "__main__":
    arguments = parse_args()
    summary = asyncio.run(run_smoke(skip_chat=arguments.skip_chat))
    print(json.dumps({"ok": True, **summary}, ensure_ascii=False))
