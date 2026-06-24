from __future__ import annotations

from dataclasses import dataclass
import re
from typing import Callable

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


def _asset_kind_label(asset_type: str) -> str:
    if asset_type == "research_brief":
        return "research brief"
    if asset_type == "knowledge_pack":
        return "knowledge pack"
    if asset_type == "newsletter_issue":
        return "newsletter issue"
    if asset_type == "topic_report":
        return "topic report"
    return "blog post"


def _fallback_outline(asset: Asset) -> str:
    if asset.asset_type == "research_brief":
        return "\n".join(
            [
                f"# {asset.title}",
                "",
                "## Executive Summary",
                f"- {asset.brief or 'Summarize the main finding and why it matters.'}",
                "",
                "## Background",
                "- Context, scope, and framing",
                "",
                "## Key Findings",
                "- Evidence-backed observations",
                "",
                "## Comparisons",
                "- Alternatives, benchmarks, or competing views",
                "",
                "## Risks and Open Questions",
                "- Uncertainties, contradictions, and follow-ups",
                "",
                "## Recommendations",
                "- Specific decisions or next actions",
            ]
        )
    if asset.asset_type == "knowledge_pack":
        return "\n".join(
            [
                f"# {asset.title}",
                "",
                "## Overview",
                f"- {asset.brief or 'What this pack covers and who it is for.'}",
                "",
                "## What’s Included",
                "- Key sources, notes, wiki pages, and memory nodes in this pack",
                "",
                "## Core Themes",
                "- The main ideas or threads across the material",
                "",
                "## Recommended Reading Path",
                "- Suggested order for consuming the material",
                "",
                "## Open Questions",
                "- Gaps, ambiguities, or what to research next",
            ]
        )
    if asset.asset_type == "newsletter_issue":
        return "\n".join(
            [
                f"# {asset.title}",
                "",
                "## Issue Overview",
                f"- {asset.brief or 'What this issue covers and who it is for.'}",
                "",
                "## Editor’s Note",
                "- The framing or theme for this issue",
                "",
                "## Featured Items",
                "- The most important links, notes, or takeaways in this issue",
                "",
                "## Why It Matters",
                "- Why the selected items matter now",
                "",
                "## Recommended Next Reads",
                "- What readers should open next",
            ]
        )
    if asset.asset_type == "topic_report":
        return "\n".join(
            [
                f"# {asset.title}",
                "",
                "## Executive Summary",
                f"- {asset.brief or 'Summarize the topic and why this report matters.'}",
                "",
                "## Topic Overview",
                "- Scope, framing, and why this topic matters now",
                "",
                "## Key Themes",
                "- The major thematic threads across the material",
                "",
                "## Findings",
                "- Evidence-backed findings across sources and notes",
                "",
                "## Risks and Gaps",
                "- What remains uncertain, conflicted, or incomplete",
                "",
                "## Recommendations and Next Steps",
                "- What to do or investigate next",
            ]
        )
    return "\n".join(
        [
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
    )


def _fallback_draft(asset: Asset) -> str:
    brief = asset.brief or ""
    outline = (asset.outline or "").strip()
    sections = [f"# {asset.title}"]
    if brief:
        sections.extend(["", brief])
    if outline:
        sections.extend(["", outline])
    if asset.asset_type == "research_brief":
        sections.extend(
            [
                "",
                "## Executive Summary",
                "Summarize the most important evidence-backed conclusions for a decision-maker.",
                "",
                "## Background",
                "Explain the problem framing, time horizon, and scope.",
                "",
                "## Findings",
                "List the strongest supported findings from sources, notes, and stable wiki pages.",
                "",
                "## Risks and Open Questions",
                "Identify uncertainty, conflicting evidence, and what still needs validation.",
                "",
                "## Recommendations",
                "Convert the analysis into concrete next actions.",
            ]
        )
    elif asset.asset_type == "knowledge_pack":
        sections.extend(
            [
                "",
                "## Overview",
                "Summarize what this pack contains, who it is for, and when to use it.",
                "",
                "## What’s Included",
                "List the most important sources, notes, wiki pages, and memory nodes included in the pack.",
                "",
                "## Core Themes",
                "Synthesize the major themes that connect the materials.",
                "",
                "## Recommended Reading Path",
                "Suggest a reading or onboarding order for the pack.",
                "",
                "## Open Questions",
                "Highlight unresolved questions, weak spots, or next areas to deepen.",
            ]
        )
    elif asset.asset_type == "newsletter_issue":
        sections.extend(
            [
                "",
                "## Issue Overview",
                "Summarize the theme of this issue and what readers will get from it.",
                "",
                "## Editor’s Note",
                "Write a short editorial note that frames the issue.",
                "",
                "## Featured Items",
                "List the most important items included in this issue, with short explanations.",
                "",
                "## Why It Matters",
                "Explain why these items are worth the reader’s attention now.",
                "",
                "## Recommended Next Reads",
                "Suggest follow-up links or next items to read after this issue.",
            ]
        )
    elif asset.asset_type == "topic_report":
        sections.extend(
            [
                "",
                "## Executive Summary",
                "Summarize the topic, the core conclusion, and why the report matters now.",
                "",
                "## Topic Overview",
                "Explain the scope, framing, and boundaries of the topic.",
                "",
                "## Key Themes",
                "Identify the major themes that appear across the material.",
                "",
                "## Findings",
                "List the strongest evidence-backed findings from sources, notes, and stable wiki pages.",
                "",
                "## Risks and Gaps",
                "Call out uncertainties, contradictions, and what still needs validation.",
                "",
                "## Recommendations and Next Steps",
                "Turn the analysis into concrete decisions, next actions, or follow-up work.",
            ]
        )
    else:
        sections.extend(["", "## Draft", "", "Expand this draft with source-backed evidence."])
    sections.extend(
        [
            "",
            "## References",
            asset.reference_notes.strip() if asset.reference_notes else "Attach references to ground this draft in source material.",
        ]
    )
    return "\n".join(sections)


def _clean_heading_title(value: str) -> str:
    text = re.sub(r"^#+\s*", "", value.strip())
    return text.strip()


def _strip_title_heading(markdown: str, title: str) -> str:
    text = (markdown or "").strip()
    if not text:
        return ""
    lines = text.splitlines()
    if lines:
        first = _clean_heading_title(lines[0])
        if first.lower() == title.strip().lower():
            return "\n".join(lines[1:]).lstrip()
    return text


def _markdown_section(markdown: str, title: str) -> str | None:
    text = (markdown or "").strip()
    if not text:
        return None
    pattern = re.compile(rf"^##\s+{re.escape(title)}\s*$", re.IGNORECASE | re.MULTILINE)
    match = pattern.search(text)
    if not match:
        return None
    start = match.end()
    remainder = text[start:]
    next_heading = re.search(r"^##\s+", remainder, re.MULTILINE)
    section = remainder[: next_heading.start()] if next_heading else remainder
    return section.strip() or None


def _research_brief_export_markdown(asset: Asset) -> str:
    brief = (asset.brief or "").strip()
    draft = _strip_title_heading(asset.draft_content or "", asset.title)
    outline = _strip_title_heading(asset.outline or "", asset.title)
    metadata = dict(asset.metadata_ or {})
    opinion_notes = str(metadata.get("opinion_notes") or "").strip()
    style_notes = str(metadata.get("style_notes") or "").strip()

    executive_summary = _markdown_section(draft, "Executive Summary")
    findings = _markdown_section(draft, "Findings") or _markdown_section(draft, "Key Findings")
    risks = _markdown_section(draft, "Risks") or _markdown_section(draft, "Risks and Open Questions")
    recommendations = _markdown_section(draft, "Recommendations")
    background = _markdown_section(draft, "Background")
    comparisons = _markdown_section(draft, "Comparisons")

    parts = [f"# {asset.title}", "", "> [!abstract] Brief Overview"]
    if brief:
        parts.append(f"> {brief}")
    else:
        parts.append("> Decision-oriented research brief generated from linked evidence.")

    parts.extend(
        [
            "",
            "## Brief Snapshot",
            "",
            f"- **Asset Type:** { _asset_kind_label(asset.asset_type).title() }",
            f"- **Status:** {asset.status.replace('_', ' ').title()}",
            f"- **Sources:** {len(asset.source_refs or [])}",
            f"- **Notes:** {len(asset.note_refs or [])}",
            f"- **Knowledge Tree Nodes:** {len(asset.memory_refs or [])}",
            f"- **Wiki Pages:** {len(asset.wiki_refs or [])}",
        ]
    )

    if executive_summary:
        parts.extend(["", "## Executive Summary", "", executive_summary])
    elif brief:
        parts.extend(["", "## Executive Summary", "", brief])

    if recommendations:
        parts.extend(["", "## Recommended Decision", "", recommendations])

    if findings:
        parts.extend(["", "## Key Findings", "", findings])
    if risks:
        parts.extend(["", "## Risks and Open Questions", "", risks])
    if background:
        parts.extend(["", "## Background", "", background])
    if comparisons:
        parts.extend(["", "## Comparisons", "", comparisons])

    if draft:
        parts.extend(["", "## Full Brief", "", draft])

    if outline:
        parts.extend(["", "## Appendix A — Working Outline", "", outline])

    if opinion_notes or style_notes:
        parts.extend(["", "## Appendix B — Editorial Intent", ""])
        if opinion_notes:
            parts.extend(["### Point of View", "", opinion_notes, ""])
        if style_notes:
            parts.extend(["### Style Notes", "", style_notes])

    if asset.reference_notes:
        parts.extend(["", "## Appendix C — Evidence and References", "", asset.reference_notes.strip()])

    return "\n".join(parts).strip()


def _knowledge_pack_export_markdown(asset: Asset) -> str:
    brief = (asset.brief or "").strip()
    draft = _strip_title_heading(asset.draft_content or "", asset.title)
    outline = _strip_title_heading(asset.outline or "", asset.title)

    overview = _markdown_section(draft, "Overview")
    included = _markdown_section(draft, "What’s Included") or _markdown_section(draft, "What's Included")
    themes = _markdown_section(draft, "Core Themes")
    path = _markdown_section(draft, "Recommended Reading Path")
    questions = _markdown_section(draft, "Open Questions")

    parts = [f"# {asset.title}", "", "> [!info] Knowledge Pack"]
    if brief:
        parts.append(f"> {brief}")
    else:
        parts.append("> Curated pack of related knowledge artifacts for reuse, onboarding, or structured exploration.")

    parts.extend(
        [
            "",
            "## Pack Snapshot",
            "",
            f"- **Asset Type:** {_asset_kind_label(asset.asset_type).title()}",
            f"- **Status:** {asset.status.replace('_', ' ').title()}",
            f"- **Sources:** {len(asset.source_refs or [])}",
            f"- **Notes:** {len(asset.note_refs or [])}",
            f"- **Knowledge Tree Nodes:** {len(asset.memory_refs or [])}",
            f"- **Wiki Pages:** {len(asset.wiki_refs or [])}",
        ]
    )

    if overview:
        parts.extend(["", "## Overview", "", overview])
    elif brief:
        parts.extend(["", "## Overview", "", brief])
    if included:
        parts.extend(["", "## What’s Included", "", included])
    if themes:
        parts.extend(["", "## Core Themes", "", themes])
    if path:
        parts.extend(["", "## Recommended Reading Path", "", path])
    if questions:
        parts.extend(["", "## Open Questions", "", questions])
    if draft:
        parts.extend(["", "## Full Pack", "", draft])
    if outline:
        parts.extend(["", "## Appendix A — Working Outline", "", outline])
    if asset.reference_notes:
        parts.extend(["", "## Appendix B — References", "", asset.reference_notes.strip()])
    return "\n".join(parts).strip()


def _newsletter_issue_export_markdown(asset: Asset) -> str:
    brief = (asset.brief or "").strip()
    draft = _strip_title_heading(asset.draft_content or "", asset.title)
    outline = _strip_title_heading(asset.outline or "", asset.title)

    overview = _markdown_section(draft, "Issue Overview")
    editors_note = _markdown_section(draft, "Editor’s Note") or _markdown_section(draft, "Editor's Note")
    featured = _markdown_section(draft, "Featured Items")
    matters = _markdown_section(draft, "Why It Matters")
    next_reads = _markdown_section(draft, "Recommended Next Reads")

    parts = [f"# {asset.title}", "", "> [!tip] Newsletter Issue"]
    if brief:
        parts.append(f"> {brief}")
    else:
        parts.append("> Curated issue draft for sending a set of relevant updates, links, and takeaways to readers.")

    parts.extend(
        [
            "",
            "## Issue Snapshot",
            "",
            f"- **Asset Type:** {_asset_kind_label(asset.asset_type).title()}",
            f"- **Status:** {asset.status.replace('_', ' ').title()}",
            f"- **Sources:** {len(asset.source_refs or [])}",
            f"- **Notes:** {len(asset.note_refs or [])}",
            f"- **Knowledge Tree Nodes:** {len(asset.memory_refs or [])}",
            f"- **Wiki Pages:** {len(asset.wiki_refs or [])}",
        ]
    )

    if overview:
        parts.extend(["", "## Issue Overview", "", overview])
    elif brief:
        parts.extend(["", "## Issue Overview", "", brief])
    if editors_note:
        parts.extend(["", "## Editor’s Note", "", editors_note])
    if featured:
        parts.extend(["", "## Featured Items", "", featured])
    if matters:
        parts.extend(["", "## Why It Matters", "", matters])
    if next_reads:
        parts.extend(["", "## Recommended Next Reads", "", next_reads])
    if draft:
        parts.extend(["", "## Full Issue", "", draft])
    if outline:
        parts.extend(["", "## Appendix A — Working Outline", "", outline])
    if asset.reference_notes:
        parts.extend(["", "## Appendix B — References", "", asset.reference_notes.strip()])
    return "\n".join(parts).strip()


def _topic_report_export_markdown(asset: Asset) -> str:
    brief = (asset.brief or "").strip()
    draft = _strip_title_heading(asset.draft_content or "", asset.title)
    outline = _strip_title_heading(asset.outline or "", asset.title)

    summary = _markdown_section(draft, "Executive Summary")
    overview = _markdown_section(draft, "Topic Overview")
    themes = _markdown_section(draft, "Key Themes")
    findings = _markdown_section(draft, "Findings")
    risks = _markdown_section(draft, "Risks and Gaps")
    recommendations = _markdown_section(draft, "Recommendations and Next Steps")

    parts = [f"# {asset.title}", "", "> [!summary] Topic Report"]
    if brief:
        parts.append(f"> {brief}")
    else:
        parts.append("> Systematic report that consolidates a topic into themes, findings, risks, and next steps.")

    parts.extend(
        [
            "",
            "## Report Snapshot",
            "",
            f"- **Asset Type:** {_asset_kind_label(asset.asset_type).title()}",
            f"- **Status:** {asset.status.replace('_', ' ').title()}",
            f"- **Sources:** {len(asset.source_refs or [])}",
            f"- **Notes:** {len(asset.note_refs or [])}",
            f"- **Knowledge Tree Nodes:** {len(asset.memory_refs or [])}",
            f"- **Wiki Pages:** {len(asset.wiki_refs or [])}",
        ]
    )

    if summary:
        parts.extend(["", "## Executive Summary", "", summary])
    elif brief:
        parts.extend(["", "## Executive Summary", "", brief])
    if overview:
        parts.extend(["", "## Topic Overview", "", overview])
    if themes:
        parts.extend(["", "## Key Themes", "", themes])
    if findings:
        parts.extend(["", "## Findings", "", findings])
    if risks:
        parts.extend(["", "## Risks and Gaps", "", risks])
    if recommendations:
        parts.extend(["", "## Recommendations and Next Steps", "", recommendations])
    if draft:
        parts.extend(["", "## Full Report", "", draft])
    if outline:
        parts.extend(["", "## Appendix A — Working Outline", "", outline])
    if asset.reference_notes:
        parts.extend(["", "## Appendix B — References", "", asset.reference_notes.strip()])
    return "\n".join(parts).strip()


async def _generate_with_fallback(
    session: AsyncSession,
    *,
    asset: Asset,
    system_prompt: str,
    user_prompt_builder: Callable[[str], str],
    fallback_builder: Callable[[Asset], str],
) -> str:
    context = await load_generation_context(session, asset=asset)
    context_text = render_generation_context(context)
    try:
        client, model = create_async_client()
        response = await client.chat.completions.create(
            model=model,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt_builder(context_text)},
            ],
        )
        content = response.choices[0].message.content or ""
        if content.strip():
            return content.strip()
    except Exception:
        pass
    return fallback_builder(asset)


async def generate_outline(session: AsyncSession, *, asset: Asset) -> str:
    kind = _asset_kind_label(asset.asset_type)
    system_prompt = (
        "You are a blog outline generator for source-driven knowledge assets. "
        "Produce a concise Markdown outline with sections and bullet points. "
        "Use stable wiki as high-level context, but do not treat wiki as the only evidence. "
        "Preserve traceability back to raw sources, notes, and knowledge-tree context."
    )
    if asset.asset_type == "research_brief":
        system_prompt = (
            "You are a research brief outline generator for source-driven knowledge assets. "
            "Produce a concise Markdown outline with sections for executive summary, findings, risks, and recommendations. "
            "Use stable wiki as high-level context, but preserve traceability back to raw evidence."
        )
    elif asset.asset_type == "knowledge_pack":
        system_prompt = (
            "You are a knowledge pack outline generator for source-driven knowledge assets. "
            "Produce a concise Markdown outline for a reusable curated knowledge pack. "
            "Include sections for overview, what's included, core themes, recommended reading path, and open questions. "
            "Optimize for onboarding, reuse, and guided exploration rather than narrative argument. "
            "Use stable wiki as high-level context, but preserve traceability back to raw evidence."
        )
    elif asset.asset_type == "newsletter_issue":
        system_prompt = (
            "You are a newsletter issue outline generator for source-driven knowledge assets. "
            "Produce a concise Markdown outline for a readable issue with sections for issue overview, editor's note, featured items, why it matters, and recommended next reads. "
            "Optimize for curation and reader flow rather than exhaustive analysis. "
            "Use stable wiki as high-level context, but preserve traceability back to raw evidence."
        )
    elif asset.asset_type == "topic_report":
        system_prompt = (
            "You are a topic report outline generator for source-driven knowledge assets. "
            "Produce a concise Markdown outline for a systematic topic report with sections for executive summary, topic overview, key themes, findings, risks and gaps, and recommendations. "
            "Optimize for structured synthesis rather than a newsletter or persuasive essay. "
            "Use stable wiki as high-level context, but preserve traceability back to raw evidence."
        )
    return await _generate_with_fallback(
        session,
        asset=asset,
        system_prompt=system_prompt,
        user_prompt_builder=lambda context_text: (
            f"Asset title: {asset.title}\n\n"
            f"Asset type: {kind}\n\n"
            f"Asset brief:\n{asset.brief or '(none)'}\n\n"
            f"Opinion / thesis:\n{str((asset.metadata_ or {}).get('opinion_notes') or '(none)')}\n\n"
            f"Style notes:\n{str((asset.metadata_ or {}).get('style_notes') or '(none)')}\n\n"
            f"Context:\n{context_text[:14000]}"
        ),
        fallback_builder=_fallback_outline,
    )


async def generate_draft(session: AsyncSession, *, asset: Asset) -> str:
    outline = asset.outline or await generate_outline(session, asset=asset)
    kind = _asset_kind_label(asset.asset_type)
    system_prompt = (
        "You are a long-form blog draft generator. Write a Markdown draft that follows the outline, "
        "uses the provided stable wiki as context, and keeps claims grounded in raw evidence. "
        "Do not treat stable wiki as the final unquestionable source of truth if raw evidence is thin or conflicting."
    )
    if asset.asset_type == "research_brief":
        system_prompt = (
            "You are a source-grounded research brief generator. Write a Markdown brief that follows the outline, "
            "highlights findings, risks, and recommendations, and keeps claims grounded in raw evidence."
        )
    elif asset.asset_type == "knowledge_pack":
        system_prompt = (
            "You are a source-grounded knowledge pack generator. Write a Markdown pack that follows the outline, "
            "curates the most useful materials, explains what is included, groups them into themes, and recommends a clear reading path grounded in raw evidence. "
            "The result should feel like a reusable onboarding or reference bundle, not a persuasive essay."
        )
    elif asset.asset_type == "newsletter_issue":
        system_prompt = (
            "You are a source-grounded newsletter issue generator. Write a Markdown issue draft that follows the outline, "
            "curates the most important items, uses a light editorial voice, and gives readers a clear sense of what to read and why. "
            "The result should feel like a sendable issue rather than a report or essay."
        )
    elif asset.asset_type == "topic_report":
        system_prompt = (
            "You are a source-grounded topic report generator. Write a Markdown report that follows the outline, "
            "synthesizes the topic into themes and findings, calls out risks and gaps, and ends with concrete next steps. "
            "The result should feel like a systematic report rather than a newsletter or short brief."
        )
    return await _generate_with_fallback(
        session,
        asset=asset,
        system_prompt=system_prompt,
        user_prompt_builder=lambda context_text: (
            f"Asset title: {asset.title}\n\n"
            f"Asset type: {kind}\n\n"
            f"Outline:\n{outline}\n\n"
            f"Context:\n{context_text[:14000]}"
        ),
        fallback_builder=_fallback_draft,
    )


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
    if asset.asset_type == "research_brief":
        if not (asset.wiki_refs or []):
            blocking.append("Research brief requires at least one wiki reference")
        if not any([asset.source_refs, asset.note_refs]):
            blocking.append("Research brief requires at least one source or note reference")
        if not (asset.reference_notes or "").strip():
            blocking.append("Research brief requires evidence references before export")
    if asset.asset_type == "knowledge_pack":
        total_refs = len(asset.source_refs or []) + len(asset.note_refs or []) + len(asset.memory_refs or []) + len(asset.wiki_refs or [])
        if total_refs < 3:
            blocking.append("Knowledge pack requires at least three attached references")
        if not (asset.reference_notes or "").strip():
            blocking.append("Knowledge pack requires references before export")
        draft_text = (asset.draft_content or "").lower()
        if "overview" not in draft_text:
            blocking.append("Knowledge pack requires an 'overview' section")
        if "what's included" not in draft_text and "what’s included" not in draft_text:
            blocking.append("Knowledge pack requires a 'what’s included' section")
        if "recommended reading path" not in draft_text:
            blocking.append("Knowledge pack requires a 'recommended reading path' section")
    if asset.asset_type == "newsletter_issue":
        total_refs = len(asset.source_refs or []) + len(asset.note_refs or []) + len(asset.memory_refs or []) + len(asset.wiki_refs or [])
        if total_refs < 3:
            blocking.append("Newsletter issue requires at least three attached references")
        if not (asset.reference_notes or "").strip():
            blocking.append("Newsletter issue requires references before export")
        draft_text = (asset.draft_content or "").lower()
        if "editor's note" not in draft_text and "editor’s note" not in draft_text:
            blocking.append("Newsletter issue requires an 'editor’s note' section")
        if "featured items" not in draft_text:
            blocking.append("Newsletter issue requires a 'featured items' section")
        if "recommended next reads" not in draft_text:
            blocking.append("Newsletter issue requires a 'recommended next reads' section")
    if asset.asset_type == "topic_report":
        total_refs = len(asset.source_refs or []) + len(asset.note_refs or []) + len(asset.memory_refs or []) + len(asset.wiki_refs or [])
        if not (asset.wiki_refs or []):
            blocking.append("Topic report requires at least one wiki reference")
        if total_refs < 3:
            blocking.append("Topic report requires at least three attached references")
        if not (asset.reference_notes or "").strip():
            blocking.append("Topic report requires references before export")
        draft_text = (asset.draft_content or "").lower()
        if "executive summary" not in draft_text:
            blocking.append("Topic report requires an 'executive summary' section")
        if "key themes" not in draft_text:
            blocking.append("Topic report requires a 'key themes' section")
        if "findings" not in draft_text:
            blocking.append("Topic report requires a 'findings' section")
        if "recommendations" not in draft_text:
            blocking.append("Topic report requires a 'recommendations' section")
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
    if asset.asset_type == "research_brief":
        draft_text = (asset.draft_content or "").lower()
        for heading in ["executive summary", "findings", "risks", "recommendations"]:
            if heading not in draft_text:
                suggestions.append(f"Research brief draft should include a '{heading}' section")
    if asset.asset_type == "knowledge_pack":
        draft_text = (asset.draft_content or "").lower()
        for heading in ["core themes", "open questions"]:
            if heading not in draft_text:
                suggestions.append(f"Knowledge pack draft should include a '{heading}' section")
    if asset.asset_type == "newsletter_issue":
        draft_text = (asset.draft_content or "").lower()
        for heading in ["issue overview", "why it matters"]:
            if heading not in draft_text:
                suggestions.append(f"Newsletter issue draft should include a '{heading}' section")
    if asset.asset_type == "topic_report":
        draft_text = (asset.draft_content or "").lower()
        for heading in ["topic overview", "risks", "gaps"]:
            if heading not in draft_text:
                suggestions.append(f"Topic report draft should include a '{heading}' section")
    wiki_claim_health = _estimate_wiki_claim_health(asset)
    weak_claim_count = wiki_claim_health["weak_claim_count"]
    total_claim_count = wiki_claim_health["total_claim_count"]
    if weak_claim_count >= 3:
        warnings.append(f"Attached wiki context contains {weak_claim_count} weak claims across {total_claim_count} extracted claims")
    elif weak_claim_count > 0:
        suggestions.append(f"Review {weak_claim_count} weak claims in attached wiki context before export")
    return len(blocking) == 0, blocking, warnings, suggestions


def export_markdown(asset: Asset) -> str:
    if asset.asset_type == "research_brief":
        return _research_brief_export_markdown(asset)
    if asset.asset_type == "knowledge_pack":
        return _knowledge_pack_export_markdown(asset)
    if asset.asset_type == "newsletter_issue":
        return _newsletter_issue_export_markdown(asset)
    if asset.asset_type == "topic_report":
        return _topic_report_export_markdown(asset)
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


def _estimate_wiki_claim_health(asset: Asset) -> dict[str, int]:
    metadata = dict(asset.metadata_ or {})
    wiki_claims = metadata.get("wiki_claims")
    if not isinstance(wiki_claims, list):
        return {"weak_claim_count": 0, "total_claim_count": 0}
    total = 0
    weak = 0
    for item in wiki_claims:
        if not isinstance(item, dict):
            continue
        total += 1
        if str(item.get("status") or "") != "supported":
            weak += 1
    return {"weak_claim_count": weak, "total_claim_count": total}
