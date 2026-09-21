from __future__ import annotations

from dataclasses import dataclass
import hashlib
from html import escape, unescape
import re

import markdown
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from pkg.models.application.asset import Asset
from pkg.models.foundation.note import Note
from pkg.models.foundation.source import Source
from pkg.models.foundation.wiki import WikiPage
from pkg.services.application.asset_experience import experience_from_metadata
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
            candidate_sections.append(
                f"### Candidate Wiki: {wiki.title}\n\n{preview or '(empty wiki)'}"
            )
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
    rendered_body = re.sub(r"\A<h1(?:\s[^>]*)?>.*?</h1>\s*", "", rendered_body, count=1, flags=re.DOTALL)
    if asset.brief:
        rendered_brief = f"<p>{escape(asset.brief, quote=False)}</p>"
        if rendered_body.startswith(rendered_brief):
            rendered_body = rendered_body[len(rendered_brief):].lstrip()
    title = escape(asset.title)
    brief = escape(asset.brief or "")
    asset_kind = escape(_asset_kind_label(asset.asset_type))
    experience = experience_from_metadata(asset.metadata_, asset_type=asset.asset_type)
    style_id = experience["id"]
    style_label = escape(str(experience.get("label") or style_id.replace("_", " ").title()))
    word_count = len(re.findall(r"[A-Za-z0-9_]+|[\u4e00-\u9fff]", markdown_content))
    reading_minutes = max(1, round(word_count / 350))
    theme_css = {
        "editorial_story": "--ink:#29241f;--muted:#766b61;--line:#ded4c7;--accent:#8b5e3c;--accent-soft:#efe2d4;--paper:#fffdf8;--canvas:#eee7dd;--content-width:900px;--body-font:Georgia,'Times New Roman',serif;--display-font:Georgia,'Times New Roman',serif;",
        "executive_brief": "--ink:#eaf4ff;--muted:#9fb6cc;--line:#28445f;--accent:#38bdf8;--accent-soft:#173a54;--paper:#10253a;--canvas:#07121e;--content-width:1080px;--body-font:Inter,ui-sans-serif,system-ui,sans-serif;--display-font:Inter,ui-sans-serif,system-ui,sans-serif;",
        "visual_digest": "--ink:#312e81;--muted:#705b8b;--line:#ebcfe6;--accent:#c026d3;--accent-soft:#f9dff4;--paper:#fffafd;--canvas:#fff0f5;--content-width:1120px;--body-font:Inter,ui-sans-serif,system-ui,sans-serif;--display-font:Inter,ui-sans-serif,system-ui,sans-serif;",
        "knowledge_atlas": "--ink:#17382a;--muted:#557566;--line:#b8d8c5;--accent:#15803d;--accent-soft:#dcefe2;--paper:#f8fff9;--canvas:#e7f2eb;--content-width:1060px;--body-font:Inter,ui-sans-serif,system-ui,sans-serif;--display-font:ui-monospace,SFMono-Regular,Menlo,monospace;",
    }[style_id]
    return f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="generator" content="Seagull Asset Export">
  <title>{title}</title>
  <style>
    :root {{ color-scheme: light; {theme_css} }}
    * {{ box-sizing: border-box; }}
    body {{ margin: 0; background: var(--canvas); color: var(--ink); font: 17px/1.75 var(--body-font); }}
    main {{ width: min(var(--content-width), calc(100% - 32px)); margin: 32px auto; overflow: hidden; background: var(--paper); border: 1px solid var(--line); border-radius: 30px; box-shadow: 0 32px 90px -50px rgba(15,23,42,.55); }}
    .asset-hero {{ position: relative; padding: clamp(36px,7vw,88px); border-bottom: 1px solid var(--line); overflow: hidden; }}
    .asset-hero::after {{ content:""; position:absolute; inset:auto -8% -45% 42%; height:75%; border-radius:50%; background:var(--accent-soft); filter:blur(4px); opacity:.62; pointer-events:none; }}
    .asset-kind {{ position:relative; z-index:1; margin:0 0 28px; color:var(--muted); font:700 11px/1.3 var(--body-font); letter-spacing:.2em; text-transform:uppercase; }}
    .asset-title {{ position:relative; z-index:1; max-width:14ch; margin:0; font:700 clamp(2.6rem,7vw,5.8rem)/.98 var(--display-font); letter-spacing:-.055em; text-wrap:balance; }}
    .asset-dek {{ position:relative; z-index:1; max-width:760px; margin:30px 0 0; color:var(--muted); font-size:clamp(1.05rem,2.4vw,1.35rem); line-height:1.65; }}
    .asset-meta {{ position:relative; z-index:1; display:flex; flex-wrap:wrap; gap:10px; margin-top:34px; }}
    .asset-meta span {{ padding:8px 12px; border:1px solid var(--line); border-radius:999px; background:color-mix(in srgb,var(--paper) 82%,transparent); color:var(--muted); font:700 11px/1 var(--body-font); letter-spacing:.08em; text-transform:uppercase; }}
    .asset-body {{ padding:clamp(32px,7vw,82px); }}
    .asset-body > :first-child {{ margin-top:0; }}
    h1, h2, h3, h4 {{ font-family:var(--display-font); line-height:1.2; letter-spacing:-.025em; }}
    h2 {{ margin-top:2.7em; font-size:clamp(1.6rem,3.2vw,2.15rem); }}
    h3 {{ margin-top:2em; font-size:1.25rem; }}
    p, ul, ol, blockquote, pre, table {{ margin:1.15em 0; }}
    a {{ color: var(--accent); text-underline-offset: 3px; }}
    blockquote {{ margin-left:0; padding:20px 24px; border:1px solid var(--line); border-left:4px solid var(--accent); border-radius:0 16px 16px 0; background:var(--accent-soft); color:var(--ink); }}
    code {{ padding:.15em .35em; border-radius:5px; background:var(--accent-soft); font-size:.9em; }}
    pre {{ overflow-x: auto; padding: 20px; border-radius: 14px; background: #18181b; color: #fafafa; }}
    pre code {{ padding: 0; background: transparent; color: inherit; }}
    table {{ width: 100%; border-collapse: collapse; font-size: .94em; }}
    th, td {{ padding: 10px 12px; border: 1px solid var(--line); text-align: left; vertical-align: top; }}
    th {{ background: var(--accent-soft); }}
    img {{ max-width: 100%; height: auto; border-radius: 12px; }}
    .mermaid {{ margin: 1.5em 0; overflow-x: auto; border: 1px solid var(--line); border-radius: 16px; padding: 18px; background: color-mix(in srgb, var(--paper) 92%, white); }}
    hr {{ margin: 2.5em 0; border: 0; border-top: 1px solid var(--line); }}
    [data-style-profile="editorial_story"] .asset-body {{ max-width:780px; margin:auto; }}
    [data-style-profile="editorial_story"] .asset-body > p:first-of-type {{ font-size:1.18em; line-height:1.9; }}
    [data-style-profile="editorial_story"] .asset-body > p:first-of-type::first-letter {{ float:left; margin:.1em .12em 0 0; color:var(--accent); font:700 4.4em/.72 var(--display-font); }}
    [data-style-profile="editorial_story"] h2 {{ padding-bottom:.5em; border-bottom:1px solid var(--line); }}
    [data-style-profile="executive_brief"] .asset-hero {{ background:linear-gradient(135deg,#0b1d2e,#12334d); }}
    [data-style-profile="executive_brief"] .asset-title {{ max-width:18ch; text-transform:uppercase; letter-spacing:-.045em; }}
    [data-style-profile="executive_brief"] .asset-body {{ display:grid; grid-template-columns:minmax(0,1fr); gap:0; }}
    [data-style-profile="executive_brief"] h2 {{ padding:14px 18px; border-left:5px solid var(--accent); background:var(--accent-soft); text-transform:uppercase; font-size:1.35rem; letter-spacing:.04em; }}
    [data-style-profile="executive_brief"] blockquote {{ border-radius:14px; }}
    [data-style-profile="visual_digest"] .asset-hero {{ background:radial-gradient(circle at 90% 10%,#fde68a 0,transparent 25%),linear-gradient(135deg,#fff7ed,#fdf2f8 48%,#eef2ff); }}
    [data-style-profile="visual_digest"] .asset-title {{ max-width:12ch; color:#312e81; }}
    [data-style-profile="visual_digest"] h2 {{ display:inline-block; padding:10px 18px; border-radius:999px; background:var(--accent-soft); color:#86198f; }}
    [data-style-profile="visual_digest"] blockquote {{ border:0; border-radius:22px; box-shadow:0 16px 40px -30px rgba(126,34,206,.65); }}
    [data-style-profile="visual_digest"] table {{ overflow:hidden; border-radius:16px; box-shadow:0 12px 34px -28px rgba(49,46,129,.5); }}
    [data-style-profile="knowledge_atlas"] main {{ background-image:linear-gradient(rgba(21,128,61,.035) 1px,transparent 1px),linear-gradient(90deg,rgba(21,128,61,.035) 1px,transparent 1px); background-size:28px 28px; }}
    [data-style-profile="knowledge_atlas"] .asset-hero {{ background:linear-gradient(135deg,#effcf3,#dff2e5); }}
    [data-style-profile="knowledge_atlas"] .asset-title {{ max-width:18ch; font-size:clamp(2.3rem,6vw,5rem); }}
    [data-style-profile="knowledge_atlas"] .asset-body {{ counter-reset:atlas-section; }}
    [data-style-profile="knowledge_atlas"] h2 {{ display:grid; grid-template-columns:auto 1fr; align-items:center; gap:12px; padding-bottom:12px; border-bottom:1px dashed var(--line); }}
    [data-style-profile="knowledge_atlas"] h2::before {{ counter-increment:atlas-section; content:counter(atlas-section,decimal-leading-zero); color:var(--accent); font:700 .7em/1 var(--display-font); }}
    [data-style-profile="knowledge_atlas"] blockquote {{ border-radius:4px 18px 18px 4px; }}
    @media (max-width:680px) {{ main {{ margin:0; width:100%; border:0; border-radius:0; }} .asset-hero,.asset-body {{ padding:28px 22px; }} .asset-title {{ font-size:2.65rem; }} }}
    @media print {{ body {{ background:white; }} main {{ width:100%; margin:0; border:0; box-shadow:none; }} }}
  </style>
</head>
<body>
  <main data-style-profile="{style_id}" data-style-version="{experience.get('version', 1)}">
    <header class="asset-hero">
      <p class="asset-kind">{asset_kind} · {style_label}</p>
      <h1 class="asset-title">{title}</h1>
      {f'<p class="asset-dek">{brief}</p>' if brief else ''}
      <div class="asset-meta"><span>{reading_minutes} min read</span><span>{word_count} units</span><span>Editable Mermaid</span></div>
    </header>
    <article class="asset-body">{rendered_body}</article>
  </main>
  <script type="module">
    import mermaid from "https://cdn.jsdelivr.net/npm/mermaid@11.15.0/dist/mermaid.esm.min.mjs";
    mermaid.initialize({{ startOnLoad: false, securityLevel: "strict", theme: "neutral", flowchart: {{ htmlLabels: false }} }});
    const blocks = [...document.querySelectorAll("pre > code.language-mermaid, pre > code.language-mmd")];
    for (const [index, code] of blocks.entries()) {{
      const host = document.createElement("div");
      host.className = "mermaid";
      try {{
        const result = await mermaid.render(`asset-diagram-${{index}}`, code.textContent || "");
        host.innerHTML = result.svg;
        code.parentElement.replaceWith(host);
      }} catch (error) {{
        code.parentElement.insertAdjacentHTML("beforebegin", `<p class="asset-kind">Mermaid render failed</p>`);
      }}
    }}
  </script>
</body>
</html>"""


def export_wechat_html(asset: Asset, *, rendered_diagrams: dict[str, str] | None = None) -> str:
    parts: list[str] = []
    if asset.brief:
        parts.extend([asset.brief, ""])
    if asset.outline:
        parts.extend(["## Outline", "", asset.outline, ""])
    if asset.draft_content:
        parts.append(asset.draft_content)
    if asset.reference_notes:
        parts.extend(["", "## References", "", asset.reference_notes])
    markdown_content = "\n".join(parts).strip()
    rendered = markdown.markdown(
        escape(markdown_content, quote=False),
        extensions=["extra", "sane_lists"],
        output_format="html5",
    )
    experience = experience_from_metadata(asset.metadata_, asset_type=asset.asset_type)
    style_id = str(experience.get("id") or "editorial_story")
    style_label = escape(str(experience.get("label") or style_id.replace("_", " ").title()))
    theme = {
        "editorial_story": {
            "accent": "#8b5e3c", "ink": "#302821", "muted": "#776a5f", "soft": "#f5eee5",
            "heading": "padding-bottom:8px;border-bottom:1px solid #ddcfc0;",
            "quote": "border-left:4px solid #8b5e3c;background:#f7f0e7;border-radius:0 12px 12px 0;",
        },
        "executive_brief": {
            "accent": "#0369a1", "ink": "#172b3a", "muted": "#526879", "soft": "#e8f3f9",
            "heading": "padding:10px 14px;border-left:5px solid #0284c7;background:#e8f3f9;text-transform:uppercase;letter-spacing:.04em;",
            "quote": "border:1px solid #b8d9e8;border-left:5px solid #0284c7;background:#eef8fc;border-radius:12px;",
        },
        "visual_digest": {
            "accent": "#a21caf", "ink": "#3b2861", "muted": "#715b86", "soft": "#fae8ff",
            "heading": "display:inline-block;padding:8px 16px;border-radius:999px;background:#fae8ff;color:#86198f;",
            "quote": "border:1px solid #efc8f3;background:#fff1f8;border-radius:18px;box-shadow:0 10px 28px rgba(126,34,206,.08);",
        },
        "knowledge_atlas": {
            "accent": "#15803d", "ink": "#1f4732", "muted": "#587264", "soft": "#e4f4e8",
            "heading": "padding:8px 0 10px;border-bottom:1px dashed #8fc6a0;font-family:monospace;color:#166534;",
            "quote": "border:1px solid #b8d8c5;border-left:5px solid #16a34a;background:#effaf2;border-radius:4px 16px 16px 4px;",
        },
    }.get(style_id, {})
    accent_candidate = str(theme.get("accent") or experience.get("presentation", {}).get("accent") or "#2563eb")
    accent = accent_candidate if re.fullmatch(r"#[0-9a-fA-F]{6}", accent_candidate) else "#2563eb"
    ink = str(theme.get("ink") or "#2f3437")
    muted = str(theme.get("muted") or "#57606a")
    soft = str(theme.get("soft") or "#f6f8fa")
    rendered = re.sub(
        r'<pre><code class="language-(?:mermaid|mmd)">(.*?)</code></pre>',
        lambda match: _wechat_mermaid_block(
            match.group(1),
            rendered_diagrams=rendered_diagrams or {},
            accent=accent,
            soft=soft,
        ),
        rendered,
        flags=re.DOTALL,
    )
    replacements = {
        "<h1>": f'<h1 style="margin:28px 0 16px;font-size:26px;line-height:1.35;color:{accent};font-weight:700;">',
        "<h2>": f'<h2 style="margin:30px 0 15px;font-size:22px;line-height:1.4;font-weight:700;{theme.get("heading", "")}">',
        "<h3>": f'<h3 style="margin:24px 0 12px;font-size:19px;line-height:1.45;color:{ink};font-weight:700;">',
        "<p>": f'<p style="margin:14px 0;font-size:16px;line-height:1.9;color:{ink};letter-spacing:.01em;">',
        "<blockquote>": f'<blockquote style="margin:20px 0;padding:14px 18px;color:{muted};{theme.get("quote", "")}">',
        "<ul>": '<ul style="margin:14px 0;padding-left:24px;line-height:1.8;">',
        "<ol>": '<ol style="margin:14px 0;padding-left:24px;line-height:1.8;">',
        "<li>": '<li style="margin:6px 0;">',
        "<pre>": f'<pre style="margin:18px 0;padding:16px;overflow:auto;border:1px solid {soft};border-radius:10px;background:{soft};color:{ink};font-size:13px;line-height:1.65;white-space:pre-wrap;">',
        "<table>": '<table style="width:100%;margin:18px 0;border-collapse:collapse;font-size:14px;line-height:1.6;">',
        "<th>": f'<th style="padding:9px;border:1px solid #d8dee4;background:{soft};color:{ink};text-align:left;">',
        "<td>": '<td style="padding:8px;border:1px solid #d8dee4;vertical-align:top;">',
        "<hr>": '<hr style="margin:28px 0;border:0;border-top:1px solid #d8dee4;">',
    }
    for source, target in replacements.items():
        rendered = rendered.replace(source, target)
    rendered = re.sub(
        r'href="(?!https?://)[^"]*"',
        'href="#"',
        rendered,
        flags=re.IGNORECASE,
    )
    rendered = re.sub(
        r'<a href="(https?://[^"]+)"',
        lambda match: f'<a href="{match.group(1)}" style="color:{accent};text-decoration:underline;"',
        rendered,
        flags=re.IGNORECASE,
    )
    signature = (
        f'<section style="margin:0 0 24px;padding:14px 16px;border-radius:14px;background:{soft};">'
        f'<p style="margin:0;color:{accent};font-size:12px;font-weight:700;letter-spacing:.14em;">{style_label.upper()}</p>'
        f'<p style="margin:7px 0 0;color:{muted};font-size:14px;line-height:1.65;">由 Seagull Asset 工作流生成，可在公众号草稿箱继续调整。</p>'
        f'</section>'
    )
    return f'<section style="padding:4px 2px;background:#ffffff;">{signature}{rendered}</section>'


def _wechat_mermaid_block(source_html: str, *, rendered_diagrams: dict[str, str], accent: str, soft: str) -> str:
    source = unescape(unescape(source_html)).strip()
    source_hash = hashlib.sha256(source.encode("utf-8")).hexdigest()
    rendered_url = rendered_diagrams.get(source_hash)
    if rendered_url:
        return (
            f'<section style="margin:22px 0;padding:14px;border:1px solid {soft};border-radius:14px;background:{soft};">'
            f'<p style="margin:0 0 10px;color:{accent};font-size:12px;font-weight:700;letter-spacing:.12em;">DIAGRAM · MERMAID</p>'
            f'<img src="{escape(rendered_url, quote=True)}" alt="Mermaid diagram" style="display:block;width:100%;height:auto;border-radius:8px;background:#ffffff;" />'
            f'</section>'
        )
    return (
        f'<section style="margin:22px 0;padding:14px 16px;border:1px solid {soft};border-radius:14px;background:{soft};">'
        f'<p style="margin:0 0 8px;color:{accent};font-size:12px;font-weight:700;letter-spacing:.12em;">EDITABLE DIAGRAM · MERMAID</p>'
        f'<pre><code class="language-mermaid">{escape(source, quote=False)}</code></pre></section>'
    )


def export_wechat_preview_html(asset: Asset) -> str:
    content = export_wechat_html(asset)
    return f"""<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>{escape(asset.title)}</title>
</head>
<body style="margin:0;background:#f3f4f6;color:#1f2937;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <main style="width:min(720px,calc(100% - 24px));margin:24px auto;padding:28px 24px;background:#ffffff;box-shadow:0 18px 50px rgba(15,23,42,.10);">
    <h1 style="margin:0 0 12px;font-size:30px;line-height:1.35;">{escape(asset.title)}</h1>
    {content}
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
