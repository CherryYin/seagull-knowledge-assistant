from __future__ import annotations

import re
import json
import logging
from dataclasses import dataclass, field
from typing import Any, Protocol

from pkg.config import settings

logger = logging.getLogger(__name__)


class ConceptMiningRecord(Protocol):
    record_type: str
    record_id: str
    title: str
    text: str


@dataclass
class CandidateMention:
    name: str
    record_type: str
    record_id: str
    record_title: str
    excerpt: str
    mention_source: str
    normalized_name: str


@dataclass
class KnowledgeEntityCandidate:
    canonical_name: str
    display_name: str
    entity_type: str
    definition: str
    aliases: list[str]
    evidence_refs: list[dict[str, Any]]
    record_refs: list[dict[str, str]]
    related_wiki_ids: list[str]
    related_memory_ids: list[str]
    signals: dict[str, Any]
    score: float
    recommendation: str
    should_create_article: bool
    mentions: list[CandidateMention] = field(default_factory=list)


_GENERIC_TERMS = {
    "a", "an", "and", "are", "as", "at", "be", "by", "can", "for", "from", "has", "have", "in", "into",
    "is", "it", "its", "of", "on", "or", "that", "the", "this", "to", "with", "without",
    "article", "candidate", "content", "data", "document", "file", "information", "item", "knowledge", "note",
    "record", "section", "source", "summary", "system", "thing", "topic", "wiki", "notes",
    "一个", "这个", "以及", "如果", "可以", "进行", "内容", "数据", "信息", "文章", "系统", "知识", "来源", "笔记",
}

_GENERIC_PHRASES = {
    "key ideas", "open questions", "related context", "recent inputs", "review notes", "candidate insights",
    "source content", "wiki page", "wiki pages", "knowledge base", "personal knowledge", "existing context",
    "开放问题", "相关内容", "主要内容", "基本信息",
}

_CONCEPT_SUFFIXES = (
    "architecture", "artifact", "chain", "compiler", "concept", "engine", "flow", "framework", "graph", "index",
    "layer", "loop", "mechanism", "memory", "method", "metric", "model", "node", "pattern", "pipeline",
    "process", "retrieval", "search", "strategy", "template", "workflow",
)

_CHINESE_CONCEPT_SUFFIXES = (
    "模型", "机制", "流程", "节点", "检索", "记忆", "知识", "图谱", "策略", "架构", "模式", "指标", "实体", "概念",
    "主题", "证据", "引用", "沉淀", "关系", "方法", "组件", "产物", "工作流", "管线", "模板",
)

_ENTITY_TYPE_BY_SUFFIX = {
    "architecture": "concept",
    "artifact": "artifact",
    "compiler": "component",
    "engine": "component",
    "flow": "mechanism",
    "framework": "concept",
    "graph": "concept",
    "index": "component",
    "layer": "component",
    "loop": "mechanism",
    "mechanism": "mechanism",
    "memory": "component",
    "method": "method",
    "metric": "metric",
    "model": "concept",
    "node": "component",
    "pattern": "pattern",
    "pipeline": "mechanism",
    "process": "mechanism",
    "retrieval": "method",
    "search": "method",
    "strategy": "method",
    "template": "artifact",
    "workflow": "mechanism",
}

_SOURCE_WEIGHTS = {
    "title": 3.0,
    "heading": 2.5,
    "definition": 2.5,
    "bold": 2.0,
    "code": 2.0,
    "list": 1.5,
    "noun_phrase": 1.0,
    "chinese_phrase": 1.0,
}


async def discover_knowledge_entities(
    session: Any,
    *,
    user_id: str,
    records: list[ConceptMiningRecord],
    max_candidates: int = 80,
    max_llm_candidates: int | None = None,
    use_llm: bool | None = None,
) -> list[KnowledgeEntityCandidate]:
    """Discover reusable knowledge concepts from normalized mining records.

    Rules provide deterministic recall. Optional LLM refinement only validates and
    normalizes top-ranked candidates; failures fall back to rule-based candidates.
    """

    _ = (session, user_id)
    mentions: list[CandidateMention] = []
    for record in records:
        mentions.extend(_extract_record_mentions(record))

    grouped = _group_mentions(mentions)
    candidates = [_build_candidate(name, candidate_mentions) for name, candidate_mentions in grouped.items()]
    candidates = [candidate for candidate in candidates if candidate.score >= 10.0]
    candidates.sort(key=lambda candidate: (candidate.score, len(candidate.evidence_refs), candidate.display_name), reverse=True)
    inferred_domains = _infer_domain_context(records)
    should_use_llm = settings.WIKI_CONCEPT_DISCOVERY_LLM_ENABLED if use_llm is None else use_llm
    if should_use_llm and candidates:
        candidates = await _refine_candidates_with_llm(
            candidates,
            max_llm_candidates=max_llm_candidates or settings.WIKI_CONCEPT_DISCOVERY_LLM_MAX_CANDIDATES,
            domain_context=inferred_domains,
        )
    return candidates[:max_candidates]


async def _refine_candidates_with_llm(
    candidates: list[KnowledgeEntityCandidate],
    *,
    max_llm_candidates: int,
    domain_context: list[str] | None = None,
) -> list[KnowledgeEntityCandidate]:
    top_candidates = candidates[: max(max_llm_candidates, 0)]
    if not top_candidates:
        return candidates
    try:
        from pkg.services.cross_cutting.llm import create_async_client

        client, model = create_async_client(
            model_id=settings.WIKI_CONCEPT_DISCOVERY_LLM_MODEL or None,
            provider_id=settings.WIKI_CONCEPT_DISCOVERY_LLM_PROVIDER_ID or None,
        )
        response = await client.chat.completions.create(
            model=model,
            messages=[
                {"role": "system", "content": _LLM_SYSTEM_PROMPT},
                {"role": "user", "content": json.dumps(_llm_payload(top_candidates, domain_context=domain_context or []), ensure_ascii=False)},
            ],
            temperature=0.1,
            timeout=settings.WIKI_CONCEPT_DISCOVERY_LLM_TIMEOUT,
        )
        raw = response.choices[0].message.content or ""
        refinements = _parse_llm_refinements(raw)
    except Exception:
        logger.warning("Wiki concept discovery LLM refinement failed; using rule candidates", exc_info=True)
        return candidates

    if not refinements:
        return candidates

    by_name = {candidate.canonical_name: candidate for candidate in candidates}
    refined_names: set[str] = set()
    refined_top: list[KnowledgeEntityCandidate] = []
    for candidate in top_candidates:
        refinement = refinements.get(candidate.canonical_name)
        if not refinement:
            refined_top.append(candidate)
            continue
        refined_candidate = _apply_llm_refinement(candidate, refinement)
        if refined_candidate is None:
            continue
        refined_names.add(candidate.canonical_name)
        by_name.pop(candidate.canonical_name, None)
        existing = by_name.get(refined_candidate.canonical_name)
        if existing:
            refined_candidate = _merge_refined_candidates(existing, refined_candidate)
        by_name[refined_candidate.canonical_name] = refined_candidate
        refined_top.append(refined_candidate)

    untouched_tail = [candidate for candidate in candidates[len(top_candidates):] if candidate.canonical_name not in refined_names]
    merged: dict[str, KnowledgeEntityCandidate] = {}
    for candidate in refined_top + untouched_tail:
        existing = merged.get(candidate.canonical_name)
        merged[candidate.canonical_name] = _merge_refined_candidates(existing, candidate) if existing else candidate
    result = list(merged.values())
    result.sort(key=lambda candidate: (candidate.score, len(candidate.evidence_refs), candidate.display_name), reverse=True)
    return result


_LLM_SYSTEM_PROMPT = """\
You refine candidate knowledge concepts for a personal knowledge graph.

Keep only reusable knowledge entities: concepts, methods, mechanisms, components,
artifacts, patterns, problems, metrics, principles, or terms. Reject generic words,
section names, vague phrases, and accidental n-grams.

Prefer candidates that are:
- clearly inside the inferred target domains from the user's recent materials;
- specific enough to become durable wiki knowledge;
- meaningful, reusable, and non-generic within that domain.

Reject candidates that are:
- generic cross-domain abstractions with little domain specificity;
- document-section labels, workflow boilerplate, or writing scaffolding;
- broad umbrella topics unless the evidence shows a concrete, domain-specific concept.

Use only the provided evidence. Do not invent facts. Return JSON only:
{"entities":[{"canonical_name":"...","display_name":"...","entity_type":"concept|method|mechanism|component|artifact|pattern|problem|metric|principle|term","definition":"...","aliases":["..."],"should_keep":true,"wiki_recommendation":"new_concept_wiki|update_existing_wiki|merge_into_topic|ignore","confidence":0.0,"reason":"..."}]}
"""


def _llm_payload(candidates: list[KnowledgeEntityCandidate], *, domain_context: list[str]) -> dict[str, Any]:
    return {
        "target_domain_context": domain_context,
        "selection_goal": "Keep only domain-relevant, meaningful, and non-generic topic/entity/concept candidates suitable for durable wiki knowledge.",
        "candidates": [
            {
                "canonical_name": candidate.canonical_name,
                "display_name": candidate.display_name,
                "entity_type": candidate.entity_type,
                "definition": candidate.definition,
                "aliases": candidate.aliases,
                "signals": candidate.signals,
                "evidence": [
                    {
                        "record_type": ref.get("ref_type"),
                        "title": ref.get("title"),
                        "excerpt": ref.get("excerpt"),
                        "mention_source": ref.get("mention_source"),
                    }
                    for ref in candidate.evidence_refs[:3]
                ],
                "existing_matches": {
                    "wiki_ids": candidate.related_wiki_ids,
                    "memory_ids": candidate.related_memory_ids,
                },
            }
            for candidate in candidates
        ]
    }


def _parse_llm_refinements(raw: str) -> dict[str, dict[str, Any]]:
    text = raw.strip()
    if text.startswith("```"):
        text = text.split("\n", 1)[1] if "\n" in text else text[3:]
        if text.endswith("```"):
            text = text[:-3]
        text = text.strip()
        if text.lower().startswith("json"):
            text = text[4:].strip()
    data = json.loads(text)
    entities = data.get("entities") if isinstance(data, dict) else None
    if not isinstance(entities, list):
        return {}
    refinements: dict[str, dict[str, Any]] = {}
    for item in entities:
        if not isinstance(item, dict):
            continue
        canonical_name = normalize_candidate_name(str(item.get("canonical_name") or ""))
        if not canonical_name:
            continue
        refinements[canonical_name] = item
    return refinements


def _apply_llm_refinement(
    candidate: KnowledgeEntityCandidate,
    refinement: dict[str, Any],
) -> KnowledgeEntityCandidate | None:
    should_keep = refinement.get("should_keep", True)
    recommendation = str(refinement.get("wiki_recommendation") or candidate.recommendation)
    confidence = _safe_float(refinement.get("confidence"), default=0.0)
    if should_keep is False or recommendation == "ignore" or confidence < 0.35:
        return None

    canonical_name = normalize_candidate_name(str(refinement.get("canonical_name") or candidate.canonical_name))
    if not canonical_name:
        canonical_name = candidate.canonical_name
    aliases = refinement.get("aliases") if isinstance(refinement.get("aliases"), list) else []
    alias_values = [str(alias) for alias in aliases if str(alias).strip()]
    display_name = str(refinement.get("display_name") or candidate.display_name).strip() or candidate.display_name
    entity_type = str(refinement.get("entity_type") or candidate.entity_type).strip() or candidate.entity_type
    if entity_type not in {"concept", "method", "mechanism", "component", "artifact", "pattern", "problem", "metric", "principle", "term"}:
        entity_type = candidate.entity_type
    definition = str(refinement.get("definition") or candidate.definition).strip() or candidate.definition
    reason = str(refinement.get("reason") or "").strip()
    signals = dict(candidate.signals)
    signals.update({"llm_refined": True, "llm_confidence": confidence})
    if reason:
        signals["llm_reason"] = reason
    signals["domain_fit"] = _safe_float(refinement.get("confidence"), default=confidence)
    candidate.canonical_name = canonical_name
    candidate.display_name = display_name
    candidate.entity_type = entity_type
    candidate.definition = definition
    candidate.aliases = _merge_unique([display_name, *alias_values, *candidate.aliases, canonical_name])[:12]
    candidate.signals = signals
    candidate.recommendation = recommendation
    candidate.should_create_article = candidate.score >= 14.0 and recommendation == "new_concept_wiki"
    return candidate


def _infer_domain_context(records: list[ConceptMiningRecord], limit: int = 8) -> list[str]:
    phrases: list[str] = []
    for record in records[:24]:
        title = (record.title or "").strip()
        text = (record.text or "")[:1000]
        phrases.extend(_title_phrases(title))
        phrases.extend(_markdown_headings(text))
        phrases.extend(_definition_subjects(text))

    cleaned: list[str] = []
    seen: set[str] = set()
    for phrase in phrases:
        normalized = normalize_candidate_name(phrase)
        if not normalized or _is_generic_phrase(normalized):
            continue
        if len(normalized.split()) == 1 and normalized in _GENERIC_TERMS:
            continue
        if normalized in seen:
            continue
        seen.add(normalized)
        cleaned.append(_clean_display_text(phrase))
        if len(cleaned) >= limit:
            break
    return cleaned


def _merge_refined_candidates(
    existing: KnowledgeEntityCandidate | None,
    candidate: KnowledgeEntityCandidate,
) -> KnowledgeEntityCandidate:
    if existing is None:
        return candidate
    existing.aliases = _merge_unique(existing.aliases + candidate.aliases)[:12]
    existing.evidence_refs = _merge_evidence_refs(existing.evidence_refs + candidate.evidence_refs)
    existing.record_refs = _merge_record_refs(existing.record_refs + candidate.record_refs)
    existing.related_wiki_ids = _merge_unique(existing.related_wiki_ids + candidate.related_wiki_ids)
    existing.related_memory_ids = _merge_unique(existing.related_memory_ids + candidate.related_memory_ids)
    existing.score = max(existing.score, candidate.score)
    existing.signals = {**existing.signals, **candidate.signals}
    existing.should_create_article = existing.should_create_article or candidate.should_create_article
    return existing


def _extract_record_mentions(record: ConceptMiningRecord) -> list[CandidateMention]:
    raw_mentions: list[tuple[str, str]] = []
    title = record.title or ""
    text = record.text or ""

    raw_mentions.extend((phrase, "title") for phrase in _title_phrases(title))
    raw_mentions.extend((phrase, "heading") for phrase in _markdown_headings(text))
    raw_mentions.extend((phrase, "bold") for phrase in _bold_terms(text))
    raw_mentions.extend((phrase, "code") for phrase in _inline_code_terms(text))
    raw_mentions.extend((phrase, "definition") for phrase in _definition_subjects(text))
    raw_mentions.extend((phrase, "list") for phrase in _list_prefix_terms(text))
    raw_mentions.extend((phrase, "noun_phrase") for phrase in _english_noun_phrases(title + "\n" + text[:3000]))
    raw_mentions.extend((phrase, "chinese_phrase") for phrase in _chinese_concept_phrases(title + "\n" + text[:3000]))

    mentions: list[CandidateMention] = []
    seen: set[tuple[str, str]] = set()
    full_text = "\n".join(part for part in [title, text] if part)
    for name, mention_source in raw_mentions:
        normalized_name = normalize_candidate_name(name)
        if not _is_candidate_allowed(name, normalized_name, mention_source):
            continue
        key = (normalized_name, mention_source)
        if key in seen:
            continue
        seen.add(key)
        mentions.append(
            CandidateMention(
                name=_clean_display_text(name),
                record_type=record.record_type,
                record_id=record.record_id,
                record_title=record.title,
                excerpt=_excerpt_around(full_text, name),
                mention_source=mention_source,
                normalized_name=normalized_name,
            )
        )
    return mentions


def normalize_candidate_name(value: str) -> str:
    cleaned = _split_identifier(value)
    cleaned = cleaned.replace("_", " ").replace("-", " ").replace("/", " ")
    cleaned = re.sub(r"[`*_#>\[\](){}:;,.!?\"']+", " ", cleaned)
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    if not cleaned:
        return ""
    if _contains_cjk(cleaned):
        return cleaned
    words = [_singularize(word.lower()) for word in cleaned.split()]
    return " ".join(words)


def _build_candidate(canonical_name: str, mentions: list[CandidateMention]) -> KnowledgeEntityCandidate:
    aliases = _merge_unique([mention.name for mention in mentions] + [canonical_name])[:12]
    evidence_refs = _evidence_refs(mentions)
    record_refs = _record_refs(mentions)
    record_ids = {(mention.record_type, mention.record_id) for mention in mentions}
    layer_count = len({mention.record_type for mention in mentions})
    title_hits = _count_source(mentions, "title")
    definition_hits = _count_source(mentions, "definition")
    markdown_structure_hits = sum(_count_source(mentions, source) for source in ("heading", "bold", "code", "list"))
    memory_hits = len({mention.record_id for mention in mentions if mention.record_type == "memory"})
    related_wiki_ids = _merge_unique([mention.record_id for mention in mentions if mention.record_type == "wiki"])
    related_memory_ids = _merge_unique([mention.record_id for mention in mentions if mention.record_type == "memory"])
    frequency = len(mentions)
    generic_penalty = 1 if _is_generic_phrase(canonical_name) else 0
    weak_context_penalty = 1 if len(record_ids) == 1 and not (title_hits or definition_hits or markdown_structure_hits) else 0
    score = (
        3.0 * title_hits
        + 2.5 * definition_hits
        + 2.0 * markdown_structure_hits
        + 2.0 * len(record_ids)
        + 3.0 * layer_count
        + 1.0 * frequency
        + 2.5 * memory_hits
        + (0.0 if related_wiki_ids else 2.0)
        - 3.0 * generic_penalty
        - 2.0 * weak_context_penalty
    )
    recommendation = "update_existing_wiki" if related_wiki_ids else "new_concept_wiki"
    should_create_article = score >= 14.0 and recommendation == "new_concept_wiki"
    signals = {
        "score": round(score, 2),
        "frequency": frequency,
        "unique_record_count": len(record_ids),
        "layer_count": layer_count,
        "title_hits": title_hits,
        "definition_hits": definition_hits,
        "markdown_structure_hits": markdown_structure_hits,
        "memory_hits": memory_hits,
        "existing_wiki_matches": len(related_wiki_ids),
        "generic_penalty": generic_penalty,
        "weak_context_penalty": weak_context_penalty,
        "mention_sources": _mention_source_counts(mentions),
    }
    display_name = _display_name(canonical_name, aliases)
    definition = _definition_hint(display_name, mentions)
    return KnowledgeEntityCandidate(
        canonical_name=canonical_name,
        display_name=display_name,
        entity_type=_infer_entity_type(canonical_name),
        definition=definition,
        aliases=aliases,
        evidence_refs=evidence_refs,
        record_refs=record_refs,
        related_wiki_ids=related_wiki_ids,
        related_memory_ids=related_memory_ids,
        signals=signals,
        score=score,
        recommendation=recommendation,
        should_create_article=should_create_article,
        mentions=mentions,
    )


def _title_phrases(title: str) -> list[str]:
    parts = re.split(r"[:|—–\-()]", title)
    phrases = [part.strip() for part in parts if part.strip()]
    phrases.extend(_english_noun_phrases(title))
    phrases.extend(_chinese_concept_phrases(title))
    return phrases


def _markdown_headings(text: str) -> list[str]:
    return [match.group(1).strip() for match in re.finditer(r"(?m)^#{1,4}\s+(.{2,100})$", text)]


def _bold_terms(text: str) -> list[str]:
    return [match.group(1).strip() for match in re.finditer(r"\*\*([^*\n]{2,100})\*\*", text)]


def _inline_code_terms(text: str) -> list[str]:
    terms = []
    for match in re.finditer(r"`([^`\n]{2,80})`", text):
        term = match.group(1).strip()
        if re.search(r"[A-Za-z_\-/][A-Za-z0-9_\-/]+", term):
            terms.append(term)
    return terms


def _definition_subjects(text: str) -> list[str]:
    subjects: list[str] = []
    patterns = [
        r"(?im)^\s*(?:[-*]\s*)?([A-Z][A-Za-z0-9_\-/ ]{2,80}?)\s+(?:is|are|refers to|means|is used for)\b",
        r"(?m)^\s*(?:[-*]\s*)?([\u4e00-\u9fffA-Za-z0-9_\-/ ]{2,40}?)\s*(?:是|指的是|用于|可以)",
    ]
    for pattern in patterns:
        subjects.extend(match.group(1).strip() for match in re.finditer(pattern, text))
    return subjects


def _list_prefix_terms(text: str) -> list[str]:
    terms: list[str] = []
    for match in re.finditer(r"(?m)^\s*[-*]\s+(.{2,100})$", text):
        item = match.group(1).strip()
        prefix = re.split(r"[:：—–-]", item, maxsplit=1)[0].strip()
        if 2 <= len(prefix) <= 80:
            terms.append(prefix)
    return terms


def _english_noun_phrases(text: str) -> list[str]:
    phrases: list[str] = []
    segments = re.split(r"\s+[—–-]\s+|[\n。！？!?;；:：,.，()]", text)
    for segment in segments:
        tokens = re.findall(r"[A-Za-z][A-Za-z0-9_/-]*", segment)
        for start_index in range(len(tokens)):
            for size in range(2, 5):
                phrase_tokens = tokens[start_index : start_index + size]
                if len(phrase_tokens) != size:
                    continue
                if any(token.lower() in _GENERIC_TERMS for token in phrase_tokens):
                    continue
                phrase = " ".join(phrase_tokens)
                normalized = normalize_candidate_name(phrase)
                if _has_repeated_words(normalized):
                    continue
                if _looks_like_english_concept(normalized):
                    phrases.append(phrase)
    return phrases[:120]


def _chinese_concept_phrases(text: str) -> list[str]:
    phrases: list[str] = []
    suffix_pattern = "|".join(re.escape(suffix) for suffix in _CHINESE_CONCEPT_SUFFIXES)
    for match in re.finditer(rf"[\u4e00-\u9fffA-Za-z0-9]{{0,8}}(?:{suffix_pattern})", text):
        phrase = match.group(0).strip()
        if 2 <= len(phrase) <= 12:
            phrases.append(phrase)
    return phrases[:120]


def _is_candidate_allowed(original: str, normalized: str, mention_source: str) -> bool:
    if not normalized or _is_generic_phrase(normalized):
        return False
    if _has_repeated_words(normalized):
        return False
    if re.fullmatch(r"\d+", normalized):
        return False
    if len(normalized) > 80:
        return False
    if _contains_cjk(normalized):
        return len(normalized) >= 2
    words = normalized.split()
    if len(words) == 1:
        return mention_source in {"title", "heading", "definition", "bold", "code"} and len(words[0]) >= 6
    if len(words) > 6:
        return False
    meaningful_words = [word for word in words if word not in _GENERIC_TERMS]
    if len(meaningful_words) < 2:
        return False
    if mention_source in {"title", "heading", "definition", "bold", "code"}:
        return True
    return _looks_like_english_concept(normalized) or _looks_like_identifier(original)


def _looks_like_english_concept(normalized: str) -> bool:
    words = normalized.split()
    if len(words) < 2:
        return False
    return words[-1] in _CONCEPT_SUFFIXES or any(word in _CONCEPT_SUFFIXES for word in words)


def _looks_like_identifier(value: str) -> bool:
    return bool(re.search(r"[a-z][A-Z]|[_/-]", value))


def _has_repeated_words(value: str) -> bool:
    if _contains_cjk(value):
        return False
    words = value.split()
    return len(words) != len(set(words))


def _is_generic_phrase(value: str) -> bool:
    normalized = value.strip().lower()
    if normalized in _GENERIC_PHRASES or normalized in _GENERIC_TERMS:
        return True
    words = normalized.split()
    return bool(words) and all(word in _GENERIC_TERMS for word in words)


def _group_mentions(mentions: list[CandidateMention]) -> dict[str, list[CandidateMention]]:
    grouped: dict[str, list[CandidateMention]] = {}
    for mention in mentions:
        grouped.setdefault(mention.normalized_name, []).append(mention)
    return grouped


def _evidence_refs(mentions: list[CandidateMention]) -> list[dict[str, Any]]:
    refs: list[dict[str, Any]] = []
    seen: set[tuple[str, str]] = set()
    sorted_mentions = sorted(mentions, key=lambda mention: _SOURCE_WEIGHTS.get(mention.mention_source, 1.0), reverse=True)
    for mention in sorted_mentions:
        key = (mention.record_type, mention.record_id)
        if key in seen:
            continue
        seen.add(key)
        refs.append(
            {
                "ref_type": mention.record_type,
                "ref_id": mention.record_id,
                "title": mention.record_title,
                "excerpt": mention.excerpt,
                "mention_source": mention.mention_source,
            }
        )
        if len(refs) >= 5:
            break
    return refs


def _record_refs(mentions: list[CandidateMention]) -> list[dict[str, str]]:
    refs: list[dict[str, str]] = []
    seen: set[tuple[str, str]] = set()
    for mention in mentions:
        key = (mention.record_type, mention.record_id)
        if key in seen:
            continue
        seen.add(key)
        refs.append({"type": mention.record_type, "id": mention.record_id, "title": mention.record_title})
    return refs[:10]


def _merge_evidence_refs(refs: list[dict[str, Any]]) -> list[dict[str, Any]]:
    merged: list[dict[str, Any]] = []
    seen: set[tuple[str, str]] = set()
    for ref in refs:
        key = (str(ref.get("ref_type") or ""), str(ref.get("ref_id") or ""))
        if key in seen:
            continue
        seen.add(key)
        merged.append(ref)
    return merged[:5]


def _merge_record_refs(refs: list[dict[str, str]]) -> list[dict[str, str]]:
    merged: list[dict[str, str]] = []
    seen: set[tuple[str, str]] = set()
    for ref in refs:
        key = (str(ref.get("type") or ""), str(ref.get("id") or ""))
        if key in seen:
            continue
        seen.add(key)
        merged.append(ref)
    return merged[:10]


def _count_source(mentions: list[CandidateMention], mention_source: str) -> int:
    return sum(1 for mention in mentions if mention.mention_source == mention_source)


def _mention_source_counts(mentions: list[CandidateMention]) -> dict[str, int]:
    counts: dict[str, int] = {}
    for mention in mentions:
        counts[mention.mention_source] = counts.get(mention.mention_source, 0) + 1
    return counts


def _display_name(canonical_name: str, aliases: list[str]) -> str:
    for alias in aliases:
        if _looks_like_identifier(alias):
            return _clean_display_text(_split_identifier(alias)).title()
    if _contains_cjk(canonical_name):
        return canonical_name
    return canonical_name.title()


def _definition_hint(display_name: str, mentions: list[CandidateMention]) -> str:
    definition_mentions = [mention for mention in mentions if mention.mention_source == "definition"]
    if definition_mentions:
        excerpt = definition_mentions[0].excerpt
        return excerpt[:240]
    return f"{display_name} is a reusable knowledge concept discovered from recent materials."


def _infer_entity_type(canonical_name: str) -> str:
    if _contains_cjk(canonical_name):
        if canonical_name.endswith(("方法", "策略")):
            return "method"
        if canonical_name.endswith(("机制", "流程", "工作流", "管线")):
            return "mechanism"
        if canonical_name.endswith(("节点", "组件")):
            return "component"
        if canonical_name.endswith(("指标",)):
            return "metric"
        if canonical_name.endswith(("模板", "产物")):
            return "artifact"
        return "concept"
    words = canonical_name.split()
    for word in reversed(words):
        if word in _ENTITY_TYPE_BY_SUFFIX:
            return _ENTITY_TYPE_BY_SUFFIX[word]
    return "concept"


def _excerpt_around(text: str, term: str, radius: int = 120) -> str:
    compact_text = re.sub(r"\s+", " ", text).strip()
    if not compact_text:
        return ""
    match = re.search(re.escape(term), compact_text, flags=re.IGNORECASE)
    if not match:
        return compact_text[: radius * 2]
    start = max(match.start() - radius, 0)
    end = min(match.end() + radius, len(compact_text))
    return compact_text[start:end]


def _split_identifier(value: str) -> str:
    value = re.sub(r"([a-z0-9])([A-Z])", r"\1 \2", value)
    value = re.sub(r"([A-Z]+)([A-Z][a-z])", r"\1 \2", value)
    return value


def _singularize(word: str) -> str:
    if len(word) > 4 and word.endswith("ies"):
        return f"{word[:-3]}y"
    if len(word) > 3 and word.endswith("s") and not word.endswith("ss"):
        return word[:-1]
    return word


def _contains_cjk(value: str) -> bool:
    return bool(re.search(r"[\u4e00-\u9fff]", value))


def _clean_display_text(value: str) -> str:
    return re.sub(r"\s+", " ", value.strip(" `*_#>\t\r\n"))


def _merge_unique(values: list[str]) -> list[str]:
    seen: set[str] = set()
    merged: list[str] = []
    for value in values:
        if not value:
            continue
        key = value.lower() if not _contains_cjk(value) else value
        if key in seen:
            continue
        seen.add(key)
        merged.append(value)
    return merged


def _safe_float(value: Any, *, default: float) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default
