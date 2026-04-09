import asyncio
from typing import Optional

import typer
from rich.console import Console
from rich.table import Table

from pkg.config import settings

app = typer.Typer(name="pkg", help="Personal Knowledge Graph CLI")
console = Console()


def _run(coro):
    return asyncio.run(coro)


@app.command()
def sync():
    """Sync markdown files from data/ into the database."""

    async def _sync():
        from pkg.db import async_session
        from pkg.services.sync_pipeline import (
            sync_notes_from_directory,
            sync_sources_from_directory,
        )

        async with async_session() as session:
            console.print(f"[bold]Syncing notes from[/bold] {settings.notes_dir}")
            notes_stats = await sync_notes_from_directory(session, settings.notes_dir)
            console.print(f"  Notes: {notes_stats}")

            console.print(f"[bold]Syncing sources from[/bold] {settings.sources_dir}")
            sources_stats = await sync_sources_from_directory(session, settings.sources_dir)
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
        from pkg.services.retriever import RetrieverAgent

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
        from pkg.models.note import Note, NoteEmbedding
        from pkg.services.embedding import get_embedding_service

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
            title_vec = emb.embed_text(title)
            abstract_vec = emb.embed_text(content or title)
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
        from pkg.models.source import Source, SourceEmbedding
        from pkg.services.embedding import get_embedding_service

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
            title_vec = emb.embed_text(title)
            summary_vec = emb.embed_text(content[:500] if content else title)
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
        from pkg.models.note import Note
        from pkg.models.source import Source

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
def ask(
    task: str = typer.Argument(..., help="Task or question for the Action Agent"),
):
    """Ask the Action Agent to complete a task using your knowledge base.

    The agent autonomously searches your knowledge, reads relevant notes,
    and produces a knowledge-grounded answer. Model-driven — the LLM decides
    which tools to call and in what order.

    Examples:
      pkg ask "What do I know about knowledge mining?"
      pkg ask "Draft a summary of my architecture designs"
      pkg ask "Compare the trade-offs I've considered for deterministic vs model-driven orchestration"
      pkg ask "Help me plan the next phase of my knowledge graph project"
    """
    from pkg.services.action_agent import create_action_agent_sync

    console.print(f"\n[bold]Action Agent[/bold] processing: {task}\n")
    console.print("[dim]Agent is thinking and using tools...[/dim]\n")

    agent = create_action_agent_sync()  # uses PrintingCallbackHandler by default
    agent(task)

    console.print("\n[green]Done.[/green]")


@app.command()
def chat():
    """Start an interactive chat session with the Action Agent.

    Multi-turn conversation where the agent remembers context.
    Type 'exit' or 'quit' to end the session.
    """
    from pkg.services.action_agent import create_action_agent_sync

    console.print("[bold]Interactive Knowledge Chat[/bold]")
    console.print("[dim]Type 'exit' or 'quit' to end. The agent has access to your knowledge base.[/dim]\n")

    agent = create_action_agent_sync()

    while True:
        try:
            user_input = console.input("[bold cyan]You:[/bold cyan] ")
        except (EOFError, KeyboardInterrupt):
            break

        if user_input.strip().lower() in ("exit", "quit", "q"):
            break

        if not user_input.strip():
            continue

        console.print()
        agent(user_input)
        console.print()

    console.print("\n[green]Session ended.[/green]")


@app.command()
def serve(
    host: str = typer.Option("127.0.0.1", help="Host"),
    port: int = typer.Option(8000, help="Port"),
):
    """Start the FastAPI server."""
    import uvicorn
    uvicorn.run("pkg.api.app:app", host=host, port=port, reload=True)


if __name__ == "__main__":
    app()
