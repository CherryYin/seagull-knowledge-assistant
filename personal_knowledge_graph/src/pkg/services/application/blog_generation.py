from __future__ import annotations

from dataclasses import dataclass
from html import escape
import re

import markdown
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from pkg.models.application.asset import Asset
from pkg.models.foundation.note import Note
from pkg.models.foundation.source import Source
from pkg.models.foundation.wiki import WikiPage
from pkg.services.foundation.wiki_lifecycle import get_wiki_role


@dataclass
class GenerationContext:
    asset: Asset
    sources: list[Source]
    notes: list[Note]
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
    wiki_pages = await _load(WikiPage, asset.wiki_refs or [], asset.user_id)
    stable_wiki_pages = [wiki for wiki in wiki_pages if get_wiki_role(wiki) == "stable"]
    candidate_wiki_pages = [wiki for wiki in wiki_pages if get_wiki_role(wiki) != "stable"]
    return GenerationContext(
        asset=asset,
        sources=sources,
        notes=notes,
        stable_wiki_pages=stable_wiki_pages,
        candidate_wiki_pages=candidate_wiki_pages,
    )


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
    if not any([asset.source_refs, asset.note_refs, asset.wiki_refs]):
        blocking.append("No references attached")
    if asset.asset_type == "research_brief":
        if not (asset.wiki_refs or []):
            blocking.append("Research brief requires at least one wiki reference")
        if not any([asset.source_refs, asset.note_refs]):
            blocking.append("Research brief requires at least one source or note reference")
        if not (asset.reference_notes or "").strip():
            blocking.append("Research brief requires evidence references before export")
    if asset.asset_type == "knowledge_pack":
        total_refs = len(asset.source_refs or []) + len(asset.note_refs or []) + len(asset.wiki_refs or [])
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
        total_refs = len(asset.source_refs or []) + len(asset.note_refs or []) + len(asset.wiki_refs or [])
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
        total_refs = len(asset.source_refs or []) + len(asset.note_refs or []) + len(asset.wiki_refs or [])
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
    if asset.wiki_refs and not asset.source_refs and not asset.note_refs:
        warnings.append("Wiki context is attached without raw source/note references")
    if asset.wiki_refs and not (asset.reference_notes or "").strip():
        warnings.append("Wiki-backed asset is missing reference notes")
    if (asset.draft_content or "").strip() and len((asset.draft_content or "").strip()) < 800:
        warnings.append("Draft is very short")
    if not (asset.editor_feedback or "").strip():
        suggestions.append("Add editor feedback before export review")
    if not (asset.reference_notes or "").strip() and any([asset.source_refs, asset.note_refs, asset.wiki_refs]):
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


def export_html(asset: Asset) -> str:
    markdown_content = export_markdown(asset)
    rendered_body = markdown.markdown(
        escape(markdown_content, quote=False),
        extensions=["extra", "sane_lists", "toc"],
        output_format="html5",
    )
    title = escape(asset.title)
    asset_kind = escape(_asset_kind_label(asset.asset_type))
    return f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="generator" content="Seagull Asset Export">
  <title>{title}</title>
  <style>
    :root {{ color-scheme: light; --ink: #18181b; --muted: #71717a; --line: #e4e4e7; --accent: #2563eb; --paper: #ffffff; --canvas: #f4f4f5; }}
    * {{ box-sizing: border-box; }}
    body {{ margin: 0; background: var(--canvas); color: var(--ink); font: 17px/1.75 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }}
    main {{ width: min(860px, calc(100% - 32px)); margin: 32px auto; padding: clamp(28px, 6vw, 72px); background: var(--paper); border: 1px solid var(--line); border-radius: 24px; box-shadow: 0 24px 70px -44px rgba(15, 23, 42, .45); }}
    .asset-kind {{ margin: 0 0 28px; color: var(--muted); font-size: 12px; font-weight: 700; letter-spacing: .16em; text-transform: uppercase; }}
    h1, h2, h3, h4 {{ line-height: 1.2; letter-spacing: -.02em; }}
    h1 {{ margin: 0 0 32px; font-size: clamp(2.25rem, 7vw, 4.5rem); }}
    h2 {{ margin-top: 2.5em; padding-bottom: .45em; border-bottom: 1px solid var(--line); font-size: 1.65rem; }}
    h3 {{ margin-top: 2em; font-size: 1.25rem; }}
    p, ul, ol, blockquote, pre, table {{ margin: 1.1em 0; }}
    a {{ color: var(--accent); text-underline-offset: 3px; }}
    blockquote {{ margin-left: 0; padding: .25em 0 .25em 1.25em; border-left: 3px solid var(--accent); color: #3f3f46; }}
    code {{ padding: .15em .35em; border-radius: 5px; background: #f4f4f5; font-size: .9em; }}
    pre {{ overflow-x: auto; padding: 20px; border-radius: 14px; background: #18181b; color: #fafafa; }}
    pre code {{ padding: 0; background: transparent; color: inherit; }}
    table {{ width: 100%; border-collapse: collapse; font-size: .94em; }}
    th, td {{ padding: 10px 12px; border: 1px solid var(--line); text-align: left; vertical-align: top; }}
    th {{ background: #f4f4f5; }}
    img {{ max-width: 100%; height: auto; border-radius: 12px; }}
    hr {{ margin: 2.5em 0; border: 0; border-top: 1px solid var(--line); }}
    @media print {{ body {{ background: white; }} main {{ width: 100%; margin: 0; padding: 0; border: 0; box-shadow: none; }} }}
  </style>
</head>
<body>
  <main>
    <p class="asset-kind">{asset_kind}</p>
    {rendered_body}
  </main>
</body>
</html>"""


def _estimate_unsupported_claims(asset: Asset) -> int:
    draft = (asset.draft_content or "").strip()
    if not draft:
        return 0
    reference_weight = len(asset.source_refs or []) + len(asset.note_refs or []) + len(asset.wiki_refs or [])
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
