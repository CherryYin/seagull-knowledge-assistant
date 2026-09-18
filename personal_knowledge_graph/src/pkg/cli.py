import asyncio
import json
from typing import Optional

import typer
from rich.console import Console
from rich.progress import Progress, SpinnerColumn, BarColumn, TextColumn, TaskID
from rich.table import Table

from pkg.config import settings

app = typer.Typer(name="pkg", help="Personal Knowledge Graph CLI")
console = Console()


def _run(coro):
    return asyncio.run(coro)


@app.command()
def sync():
    """Sync markdown files from local directories into the database + OSS."""

    async def _sync():
        from pkg.db import async_session
        from pkg.services.foundation.sync_pipeline import (
            sync_notes_from_directory,
            sync_sources_from_directory,
        )

        async with async_session() as session:
            console.print(f"[bold]Syncing notes from[/bold] {settings.notes_dir}")
            notes_stats = await sync_notes_from_directory(session, settings.notes_dir)
            console.print(f"  Notes: {notes_stats}")

            console.print(f"[bold]Syncing sources from[/bold] {settings.sources_dir}")

            # Progress bar for document extraction (per-page)
            with Progress(
                SpinnerColumn(),
                TextColumn("[progress.description]{task.description}"),
                BarColumn(),
                TextColumn("{task.completed}/{task.total} pages"),
                console=console,
                transient=True,
            ) as progress:
                page_task: TaskID | None = None
                current_file: str | None = None

                def on_page_progress(filename: str, current_page: int, total_pages: int):
                    nonlocal page_task, current_file
                    if filename != current_file:
                        # New file — finish previous task, start new one
                        if page_task is not None:
                            progress.update(page_task, visible=False)
                        current_file = filename
                        page_task = progress.add_task(
                            f"  [cyan]{filename}[/cyan]",
                            total=total_pages,
                        )
                    if page_task is not None:
                        progress.update(page_task, completed=current_page, total=total_pages)

                sources_stats = await sync_sources_from_directory(
                    session, settings.sources_dir, progress_callback=on_page_progress
                )

            console.print(f"  Sources: {sources_stats}")

            console.print("[green]Sync complete.[/green]")

    _run(_sync())


@app.command()
def search(
    query: str = typer.Argument(..., help="Search query"),
    mode: str = typer.Option("auto", help="Search mode: auto|sql|vector|hybrid"),
    top_k: int = typer.Option(5, help="Number of results"),
):
    """Search the knowledge base."""

    async def _search():
        from pkg.db import async_session
        from pkg.services.foundation.retriever import RetrieverAgent

        async with async_session() as session:
            retriever = RetrieverAgent(session)
            results = await retriever.search(query=query, mode=mode, top_k=top_k)

            if not results:
                console.print("[yellow]No results found.[/yellow]")
                return

            table = Table(title=f"Search: '{query}' (mode={mode})")
            table.add_column("ID", style="cyan")
            table.add_column("Title", style="bold")
            table.add_column("Type", style="green")
            table.add_column("Score", justify="right")
            table.add_column("Preview", max_width=50)

            for r in results:
                table.add_row(
                    r.id,
                    r.title,
                    r.type,
                    f"{r.score:.3f}",
                    (r.abstract or r.content_preview or "")[:50],
                )

            console.print(table)

    _run(_search())


@app.command()
def add_note(
    title: str = typer.Argument(..., help="Note title"),
    content: str = typer.Option("", help="Note content"),
    note_type: str = typer.Option("inbox", help="Note type"),
    domains: Optional[list[str]] = typer.Option(None, help="Domains"),
    tags: Optional[list[str]] = typer.Option(None, help="Tags"),
    project: Optional[str] = typer.Option(None, help="Project name"),
):
    """Quick-add a note to the knowledge base."""

    async def _add():
        from datetime import datetime, timezone
        from pkg.db import async_session
        from pkg.models.foundation.note import Note, NoteEmbedding
        from pkg.services.cross_cutting.embedding import get_embedding_service

        async with async_session() as session:
            now = datetime.now(timezone.utc)
            note_id = f"note-{now.strftime('%Y%m%d')}-{title[:30].lower().replace(' ', '-')}"

            note = Note(
                id=note_id,
                title=title,
                note_type=note_type,
                domains=domains or [],
                tags=tags or [],
                content=content,
                project=project,
                word_count=len(content.split()) if content else 0,
            )
            session.add(note)

            emb = get_embedding_service()
            title_vec = await emb.embed_text(title)
            abstract_vec = await emb.embed_text(content or title)
            session.add(NoteEmbedding(
                note_id=note_id, title_vec=title_vec, abstract_vec=abstract_vec
            ))

            await session.commit()
            console.print(f"[green]Created note:[/green] {note_id} — {title}")

    _run(_add())


@app.command()
def add_source(
    title: str = typer.Argument(..., help="Source title"),
    source_type: str = typer.Option("article", help="Source type: pdf|article|conversation|video|web|code"),
    url: Optional[str] = typer.Option(None, help="Source URL"),
    content: str = typer.Option("", help="Source content"),
):
    """Quick-add a source to the knowledge base."""

    async def _add():
        import hashlib
        from datetime import datetime, timezone
        from pkg.db import async_session
        from pkg.models.foundation.source import Source, SourceEmbedding
        from pkg.services.cross_cutting.embedding import get_embedding_service

        async with async_session() as session:
            now = datetime.now(timezone.utc)
            source_id = f"src-{now.strftime('%Y%m%d')}-{title[:30].lower().replace(' ', '-')}"

            source = Source(
                id=source_id,
                title=title,
                source_type=source_type,
                url=url,
                raw_content=content,
                content_hash=hashlib.sha256(content.encode()).hexdigest(),
            )
            session.add(source)

            emb = get_embedding_service()
            title_vec = await emb.embed_text(title)
            summary_vec = await emb.embed_text(content[:500] if content else title)
            session.add(SourceEmbedding(
                source_id=source_id, title_vec=title_vec, summary_vec=summary_vec
            ))

            await session.commit()
            console.print(f"[green]Created source:[/green] {source_id} — {title}")

    _run(_add())


@app.command()
def stats():
    """Show knowledge base statistics."""

    async def _stats():
        from sqlalchemy import func, select
        from pkg.db import async_session
        from pkg.models.foundation.note import Note
        from pkg.models.foundation.source import Source

        async with async_session() as session:
            note_count = (await session.execute(select(func.count()).select_from(Note))).scalar() or 0
            source_count = (await session.execute(select(func.count()).select_from(Source))).scalar() or 0

            # Notes by type
            note_types = await session.execute(
                select(Note.note_type, func.count()).group_by(Note.note_type)
            )

            table = Table(title="Knowledge Base Statistics")
            table.add_column("Metric", style="bold")
            table.add_column("Value", justify="right")

            table.add_row("Total Notes (L2)", str(note_count))
            table.add_row("Total Sources (L1)", str(source_count))

            for row in note_types:
                table.add_row(f"  Notes [{row[0]}]", str(row[1]))

            console.print(table)

    _run(_stats())


@app.command()
def serve(
    host: str = typer.Option("127.0.0.1", help="Host"),
    port: int = typer.Option(8000, help="Port"),
    reload: bool = typer.Option(False, "--reload", help="Reload on source changes"),
):
    """Start the FastAPI server."""
    import uvicorn
    uvicorn.run("pkg.api.app:app", host=host, port=port, reload=reload)


@app.command()
def worker(
    poll_interval: int = typer.Option(
        30,
        "--poll-interval",
        min=1,
        help="Seconds between scheduled task checks",
    ),
):
    """Run scheduled background jobs in a dedicated process."""
    from pkg.worker import run_worker

    _run(run_worker(poll_interval_seconds=poll_interval))


@app.command(name="fetch-feeds")
def fetch_feeds(
    source_id: Optional[str] = typer.Option(None, help="Fetch a specific feed by source ID"),
):
    """Fetch RSS feeds and persist new articles."""

    async def _fetch():
        if source_id:
            from pkg.db import async_session
            from pkg.models.foundation.source import Source
            from pkg.services.foundation.rss_fetcher import fetch_single_feed

            async with async_session() as session:
                feed = await session.get(Source, source_id)
                if not feed:
                    console.print(f"[red]Source not found: {source_id}[/red]")
                    return
                count = await fetch_single_feed(feed, session)
                console.print(f"[green]Fetched {count} new articles from {feed.title}[/green]")
        else:
            from pkg.services.foundation.rss_fetcher import fetch_all_feeds

            stats = await fetch_all_feeds()
            console.print(f"[green]RSS fetch complete:[/green] {stats}")

    _run(_fetch())


@app.command(name="summarize-rss")
def summarize_rss():
    """Generate topic summaries from recent RSS articles."""

    async def _summarize():
        from pkg.services.foundation.rss_summarizer import summarize_rss_by_topic

        note_ids = await summarize_rss_by_topic()
        if note_ids:
            console.print(f"[green]Created {len(note_ids)} topic summaries:[/green]")
            for nid in note_ids:
                console.print(f"  {nid}")
        else:
            console.print("[yellow]No recent RSS articles to summarize.[/yellow]")

    _run(_summarize())


@app.command(name="cleanup-rss")
def cleanup_rss(
    days: Optional[int] = typer.Option(None, help="Override retention days"),
):
    """Delete RSS articles older than retention period."""

    async def _cleanup():
        if days is not None:
            from pkg.config import settings
            original = settings.RSS_RETENTION_DAYS
            settings.RSS_RETENTION_DAYS = days

        from pkg.services.foundation.rss_fetcher import cleanup_old_rss_articles

        deleted = await cleanup_old_rss_articles()
        console.print(f"[green]Cleaned up {deleted} old RSS articles.[/green]")

        if days is not None:
            settings.RSS_RETENTION_DAYS = original  # type: ignore[possibly-undefined]

    _run(_cleanup())


@app.command(name="audit-core")
def audit_core(
    id_limit: int = typer.Option(1000, min=0, help="Maximum IDs included per audit section"),
):
    """Print a read-only Phase A audit without knowledge content."""

    async def _audit():
        from pkg.db import async_session
        from pkg.services.cross_cutting.core_audit import collect_core_simplification_audit

        async with async_session() as session:
            report = await collect_core_simplification_audit(session, id_limit=id_limit)
        console.print_json(json.dumps(report, ensure_ascii=False))

    _run(_audit())


@app.command(name="cleanup-expired-digests")
def cleanup_expired_digests(
    apply: bool = typer.Option(False, "--apply", help="Delete expired Digest notes and linked MinIO objects"),
    id_limit: int = typer.Option(20, min=0, help="Maximum IDs shown in dry-run mode"),
):
    """Dry-run or explicitly delete expired pending-review Digest notes."""

    async def _cleanup():
        from pkg.db import async_session
        from pkg.services.cross_cutting.core_audit import collect_core_simplification_audit
        from pkg.services.cross_cutting.maintenance import cleanup_expired_digest_notes_all_users

        if not apply:
            async with async_session() as session:
                report = await collect_core_simplification_audit(session, id_limit=id_limit)
            result = {
                "mode": "dry-run",
                "apply_required": True,
                "expired_digest_notes": report["expired_digest_notes"],
            }
        else:
            result = {
                "mode": "apply",
                **await cleanup_expired_digest_notes_all_users(),
            }
        console.print_json(json.dumps(result, ensure_ascii=False))

    _run(_cleanup())


if __name__ == "__main__":
    app()
