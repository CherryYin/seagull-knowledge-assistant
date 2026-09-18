---
name: generate-source-mind-map
description: Produce a bounded and traceable PDF Source Mind Map proposal without applying it.
whenToUse: Use whenever Seagull requests an Agent-generated Mind Map for a PDF Source.
---
# Generate Source Mind Map

## Boundary
The request is a bounded representation of one PDF Source. PKG remains read-only. Never create or mutate a formal Mind Map. The only valid deliverable is one `propose_source_mind_map` call.

Do not request, emit, or reconstruct the complete PDF. The request must contain only:

- `source_id` and Source metadata.
- `basis_revision` with `source_content_hash`, `chunk_count`, and `chunk_revision`.
- At most 40 `section_summaries`.
- Between 1 and 80 `chunk_summaries`; large PDFs are evenly sampled and accompanied by section summaries.
- No raw PDF body, base64 data, file bytes, or unrestricted Source text.

## Workflow
1. Preserve `source_id` and every `basis_revision` value exactly.
2. Read the section summaries first to establish the document hierarchy.
3. Use chunk summaries only to support concrete branches and factual nodes.
4. Build exactly one root `topic`; use `section` for major document divisions and `concept` for explanatory ideas.
5. Use `claim`, `evidence`, or `knowledge` only when at least one supplied Chunk supports the node.
6. Use `question` for ambiguity, missing evidence, limitations, or follow-up investigation.
7. Keep sibling `position` values unique and contiguous from zero.
8. Target 18–28 nodes and never exceed 32 nodes. For large PDFs, keep only 2–3 high-value children per section.
9. Reference only Chunk IDs present in the supplied generation context.
10. Include a short exact `quote` only when the supplied Chunk summary contains it; otherwise use page-only navigation or omit the selector.
11. After a short internal plan, call `propose_source_mind_map` exactly once with the complete proposal. Do not echo `input_summary`; PKG validates Chunk ownership and quote authenticity against the Source.
12. Do not emit analysis, Markdown, a JSON draft, or a textual Proposal before the tool call. Omit `note` unless it materially improves interpretation.

## Selected Branch Expansion
When the request includes `expansion_target`, preserve its `map_id`, `base_version`, and `target_node_id` exactly in the Tool call. Build a compact 5–12 node Proposal whose single root is a `topic` with content exactly equal to `expansion_target.content`; that root is an existing anchor and must have no new reference. Add only relevant descendants for that branch. Do not rewrite unrelated branches, the Map title, or layout.

## Exact Tool Shape
Do not invent alternative node keys such as `id`, `title`, `text`, `type`, `children`, `branches`, or `items`. Use this exact flat-tree shape:

```json
{
  "source_id": "source-1",
  "basis_revision": {
    "source_content_hash": "hash-or-null",
    "chunk_count": 3,
    "chunk_revision": null
  },
  "proposal": {
    "title": "Document Map",
    "layout_mode": "balanced",
    "nodes": [
      {"temp_id": "root", "parent_temp_id": null, "position": 0, "content": "Document Map", "note": null, "node_kind": "topic"},
      {"temp_id": "claim-1", "parent_temp_id": "root", "position": 0, "content": "Supported claim", "note": null, "node_kind": "claim"}
    ],
    "references": [
      {"node_temp_id": "claim-1", "chunk_id": 11, "relation": "supports", "fragment_selector": null}
    ]
  }
}
```

Every node is one flat object with exactly `temp_id`, `parent_temp_id`, `position`, `content`, optional `note`, and `node_kind`. Parent-child structure is expressed only through `parent_temp_id`.

## Quality Gate
- One root Topic and no cycles or missing parents.
- No unsupported factual nodes.
- No invented Chunk IDs, pages, quotes, or document claims.
- No direct PKG write and no automatic Apply.
- No second textual copy of the Proposal after the tool call.
