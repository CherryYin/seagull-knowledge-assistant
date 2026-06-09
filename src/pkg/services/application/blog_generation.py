from __future__ import annotations

from dataclasses import dataclass
import re

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from pkg.models.application.asset import Asset
from pkg.models.foundation.note import Note
from pkg.models.foundation.source import Source
from pkg.models.foundation.wiki import WikiPage
from pkg.models.foundation.memory import MemoryNode
from pkg.services.cross_cutting.llm import create_async_client
from pkg.services.foundation.wiki_lifecycle import get_wiki_role


@dataclass
class GenerationContext:
    asset: Asset
    sources: list[Source]
    notes: list[Note]
    memories: list[MemoryNode]
    stable_wiki_pages: list[WikiPage]
    candidate_wiki_pages: list[WikiPage]


async def load_generation_context(session: AsyncSession, *, asset: Asset) -> GenerationContext:
    async def _load(model, ids: list[str], user_id: str):
        if not ids:
            return []
        rows = await session.execute(select(model).where(model.user_id == user_id, model.id.in_(ids)))
        return list(rows.scalars())

    sources = await _load(Source, asset.source_refs or [], asset.user_id)
    notes = await _load(Note, asset.note_refs or [], asset.user_id)
    memories = await _load(MemoryNode, asset.memory_refs or [], asset.user_id)
    wiki_pages = await _load(WikiPage, asset.wiki_refs or [], asset.user_id)
    stable_wiki_pages = [wiki for wiki in wiki_pages if get_wiki_role(wiki) == "stable"]
    candidate_wiki_pages = [wiki for wiki in wiki_pages if get_wiki_role(wiki) != "stable"]
    return GenerationContext(
        asset=asset,
        sources=sources,
        notes=notes,
        memories=memories,
        stable_wiki_pages=stable_wiki_pages,
        candidate_wiki_pages=candidate_wiki_pages,
    )


def render_generation_context(context: GenerationContext) -> str:
    parts: list[str] = []
    if context.asset.brief:
        parts.append(f"## Editorial Brief\n\n{context.asset.brief.strip()}")
    metadata = dict(context.asset.metadata_ or {})
    opinion_notes = str(metadata.get("opinion_notes") or "").strip()
    style_notes = str(metadata.get("style_notes") or "").strip()
    if opinion_notes:
        parts.append(f"## Author Point of View\n\n{opinion_notes}")
    if style_notes:
        parts.append(f"## Style Instructions\n\n{style_notes}")
    raw_evidence_parts: list[str] = []
    if context.sources:
        source_sections = []
        for source in context.sources[:8]:
            body = (source.raw_content or "").strip()
            preview = body[:1800] + ("…" if len(body) > 1800 else "")
            source_sections.append(f"### Source: {source.title}\n\n{preview or '(empty source)'}")
        raw_evidence_parts.append("## Sources\n\n" + "\n\n".join(source_sections))
    if context.notes:
        note_sections = []
        for note in context.notes[:8]:
            body = (note.content or note.abstract or "").strip()
            preview = body[:1200] + ("…" if len(body) > 1200 else "")
            note_sections.append(f"### Note: {note.title}\n\n{preview or '(empty note)'}")
        raw_evidence_parts.append("## Notes\n\n" + "\n\n".join(note_sections))
    if context.memories:
        memory_sections = []
        for memory in context.memories[:8]:
            body = (memory.content or memory.summary or "").strip()
            preview = body[:1000] + ("…" if len(body) > 1000 else "")
            memory_sections.append(f"### Knowledge Tree: {memory.title}\n\n{preview or '(empty memory)'}")
        raw_evidence_parts.append("## Knowledge Tree Context\n\n" + "\n\n".join(memory_sections))
    if raw_evidence_parts:
        parts.append("# Raw Evidence\n\n" + "\n\n".join(raw_evidence_parts))
    if context.stable_wiki_pages:
        wiki_sections = []
        for wiki in context.stable_wiki_pages[:6]:
            body = (wiki.content or wiki.summary or "").strip()
            preview = body[:1000] + ("…" if len(body) > 1000 else "")
            wiki_sections.append(f"### Stable Wiki: {wiki.title}\n\n{preview or '(empty wiki)'}")
        parts.append("# Stable Wiki Context\n\n" + "\n\n".join(wiki_sections))
    if context.candidate_wiki_pages:
        candidate_sections = []
        for wiki in context.candidate_wiki_pages[:6]:
            body = (wiki.content or wiki.summary or "").strip()
            preview = body[:1000] + ("…" if len(body) > 1000 else "")
            candidate_sections.append(f"### Candidate Wiki: {wiki.title}\n\n{preview or '(empty wiki)'}")
        parts.append("# Candidate Wiki Context\n\n" + "\n\n".join(candidate_sections))
    return "\n\n".join(parts).strip()


async def generate_outline(session: AsyncSession, *, asset: Asset) -> str:
    context = await load_generation_context(session, asset=asset)
    context_text = render_generation_context(context)
    try:
        client, model = create_async_client()
        response = await client.chat.completions.create(
            model=model,
            messages=[
                {
                    "role": "system",
                    "content": (
                        "You are a blog outline generator for source-driven knowledge assets. "
                        "Produce a concise Markdown outline with sections and bullet points. "
                        "Use stable wiki as high-level context, but do not treat wiki as the only evidence. "
                        "Preserve traceability back to raw sources, notes, and knowledge-tree context."
                    ),
                },
                {
                    "role": "user",
                    "content": (
                        f"Asset title: {asset.title}\n\n"
                        f"Asset brief:\n{asset.brief or '(none)'}\n\n"
                        f"Opinion / thesis:\n{str((asset.metadata_ or {}).get('opinion_notes') or '(none)')}\n\n"
                        f"Style notes:\n{str((asset.metadata_ or {}).get('style_notes') or '(none)')}\n\n"
                        f"Context:\n{context_text[:14000]}"
                    ),
                },
            ],
        )
        content = response.choices[0].message.content or ""
        if content.strip():
            return content.strip()
    except Exception:
        pass

    headings = [
        f"# {asset.title}",
        "",
        "## Why this matters",
        "- Main argument",
        "",
        "## Core evidence",
        "- Source-backed point 1",
        "- Source-backed point 2",
        "",
        "## Implications",
        "- Practical takeaway",
    ]
    return "\n".join(headings)


async def generate_draft(session: AsyncSession, *, asset: Asset) -> str:
    context = await load_generation_context(session, asset=asset)
    context_text = render_generation_context(context)
    outline = asset.outline or await generate_outline(session, asset=asset)
    try:
        client, model = create_async_client()
        response = await client.chat.completions.create(
            model=model,
            messages=[
                {
                    "role": "system",
                    "content": (
                        "You are a long-form blog draft generator. Write a Markdown draft that follows the outline, "
                        "uses the provided stable wiki as context, and keeps claims grounded in raw evidence. "
                        "Do not treat stable wiki as the final unquestionable source of truth if raw evidence is thin or conflicting."
                    ),
                },
                {
                    "role": "user",
                    "content": (
                        f"Asset title: {asset.title}\n\n"
                        f"Outline:\n{outline}\n\n"
                        f"Context:\n{context_text[:14000]}"
                    ),
                },
            ],
        )
        content = response.choices[0].message.content or ""
        if content.strip():
            return content.strip()
    except Exception:
        pass

    brief = asset.brief or ""
    return f"# {asset.title}\n\n{brief}\n\n## Draft\n\nExpand this draft with source-backed evidence."


async def attach_references(session: AsyncSession, *, asset: Asset, include_reference_notes: bool = True) -> str:
    context = await load_generation_context(session, asset=asset)
    lines: list[str] = []
    if context.sources:
        lines.append("## Source References")
        for source in context.sources:
            lines.append(f"- Source: {source.title} ({source.id})")
    if context.notes:
        lines.append("\n## Note References")
        for note in context.notes:
            lines.append(f"- Note: {note.title} ({note.id})")
    if context.memories:
        lines.append("\n## Knowledge Tree References")
        for memory in context.memories:
            lines.append(f"- Knowledge Tree: {memory.title} ({memory.id})")
    if context.stable_wiki_pages:
        lines.append("\n## Stable Wiki References")
        for wiki in context.stable_wiki_pages:
            lines.append(f"- Stable Wiki: {wiki.title} ({wiki.id})")
    if context.candidate_wiki_pages:
        lines.append("\n## Candidate Wiki References")
        for wiki in context.candidate_wiki_pages:
            lines.append(f"- Candidate Wiki: {wiki.title} ({wiki.id})")
    if include_reference_notes and asset.reference_notes:
        lines.append("\n## Existing Reference Notes")
        lines.append(asset.reference_notes)
    return "\n".join(lines).strip()


def check_readiness(asset: Asset) -> tuple[bool, list[str], list[str], list[str]]:
    blocking: list[str] = []
    warnings: list[str] = []
    suggestions: list[str] = []
    if not (asset.title or "").strip():
        blocking.append("Missing title")
    if not (asset.brief or "").strip():
        blocking.append("Missing brief")
    if not (asset.outline or "").strip():
        blocking.append("Missing outline")
    if not (asset.draft_content or "").strip():
        blocking.append("Missing draft content")
    if not any([asset.source_refs, asset.note_refs, asset.memory_refs, asset.wiki_refs]):
        blocking.append("No references attached")
    if asset.wiki_refs and not asset.source_refs and not asset.note_refs and not asset.memory_refs:
        warnings.append("Wiki context is attached without raw source/note references")
    if asset.wiki_refs and not (asset.reference_notes or "").strip():
        warnings.append("Wiki-backed asset is missing reference notes")
    if (asset.draft_content or "").strip() and len((asset.draft_content or "").strip()) < 800:
        warnings.append("Draft is very short")
    if not (asset.editor_feedback or "").strip():
        suggestions.append("Add editor feedback before export review")
    if not (asset.reference_notes or "").strip() and any([asset.source_refs, asset.note_refs, asset.memory_refs, asset.wiki_refs]):
        suggestions.append("Attach references to generate a readable references section")
    if asset.status == "ready_to_export" and blocking:
        warnings.append("Asset is marked ready_to_export but still has blocking readiness issues")
    unsupported_claim_count = _estimate_unsupported_claims(asset)
    if unsupported_claim_count >= 3:
        warnings.append(f"Draft may contain {unsupported_claim_count} unsupported claims")
    elif unsupported_claim_count > 0:
        suggestions.append(f"Review {unsupported_claim_count} potentially unsupported claims in the draft")
    return len(blocking) == 0, blocking, warnings, suggestions


def export_markdown(asset: Asset) -> str:
    parts = [f"# {asset.title}"]
    if asset.brief:
        parts.extend(["", asset.brief])
    if asset.outline:
        parts.extend(["", "## Outline", "", asset.outline])
    if asset.draft_content:
        parts.extend(["", asset.draft_content])
    if asset.reference_notes:
        parts.extend(["", "## References", "", asset.reference_notes])
    return "\n".join(parts).strip()


def _estimate_unsupported_claims(asset: Asset) -> int:
    draft = (asset.draft_content or "").strip()
    if not draft:
        return 0
    reference_weight = len(asset.source_refs or []) + len(asset.note_refs or []) + len(asset.memory_refs or []) + len(asset.wiki_refs or [])
    if reference_weight >= 4 and (asset.reference_notes or "").strip():
        return 0
    sentences = [segment.strip() for segment in re.split(r"[\n.!?。！？]", draft) if segment.strip()]
    claim_like = [
        sentence for sentence in sentences
        if len(sentence) >= 40 and not sentence.startswith("#") and any(marker in sentence.lower() for marker in [" is ", " are ", " shows ", " means ", " will ", " can ", " 表明", "意味着", "说明", "是"])  # noqa: E501
    ]
    return max(0, min(len(claim_like), 6) - min(reference_weight, 3))
