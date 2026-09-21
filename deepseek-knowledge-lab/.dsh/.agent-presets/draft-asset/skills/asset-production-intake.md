---
name: asset-production-intake
description: Clarify an Asset delivery need, discover local PKG evidence, optionally fill material gaps with web evidence, and produce a reviewable Markdown deliverable.
whenToUse: Use whenever the user starts or continues the draft-asset workflow.
---
# Asset Production Intake

## Core Boundary
The current Harness Session is the drafting workspace. PKG remains the durable knowledge store and is read-only to the Agent. An Asset shell may already exist with confirmed Intent, Evidence, and Claims; the Agent cannot update its draft until the user explicitly applies the result in Seagull.

When the delivery contract includes a `Structured drafting basis` and says the research gates are complete, skip local discovery and web gap filling. Use only the accepted Evidence, accepted Claims, and retained Hypotheses in that basis. If they are insufficient, record the gap in `Review Notes` so the user can return to the Evidence stage.

## Phase 1: Clarify
1. Read the supplied Asset delivery contract and user need.
2. Determine whether the objective, audience, scope, decision/use case, freshness requirement, or important constraints are materially ambiguous.
3. Do not ask questions whose answers can be discovered from PKG.
4. If material ambiguity remains, call `ask_user_question` with one batch of at most three concise questions. Put the recommended option first when choices are useful.
5. Wait for the answers before drafting. Do not emit a placeholder deliverable while waiting.

## Phase 2: Discover Local Evidence
Skip this phase when a Structured drafting basis is supplied.

1. Search PKG first with multiple focused `pkg_search` queries derived from the confirmed need.
2. Inspect explicit seed references even when search finds newer alternatives.
3. Read the full relevant Source or Note when a read tool exists.
4. Prefer a small evidence set that directly supports the deliverable over a large undifferentiated list.
5. Track consulted IDs and cite grounded claims inline as `[Source: id]`, `[Note: id]`, or `[Wiki: id]`.
   Web search results are not PKG Sources: cite their real URL and never invent a `[Source: id]` marker unless the page was explicitly imported into PKG.

## Phase 3: Fill Gaps
Skip this phase when a Structured drafting basis is supplied, even if the Asset originally allowed web research.

1. When the delivery contract says `local_then_web`, finish the PKG pass first, identify at least one concrete freshness or evidence gap, and call `web_search` at least once for that gap.
2. Search for the specific unresolved gap rather than repeating the whole topic.
3. Prefer primary or authoritative results and use only claims supported by the returned snippets or answer.
4. Keep network evidence separate from PKG evidence and retain its URL in the evidence section.
5. If web evidence conflicts with PKG, expose the conflict and confidence instead of silently choosing one.
6. If `web_search` fails or returns no citeable source, record that failure in `Review Notes`; never claim that network research completed.

## Phase 4: Produce
1. Follow the Asset type's required H2 sections and quality criteria exactly.
2. Treat the supplied Experience Profile as a concrete composition contract, not a loose tone suggestion:
   - `editorial_story`: strong opening, varied paragraph rhythm, evidence-led narrative, memorable conclusion.
   - `executive_brief`: conclusions first, compact findings, explicit risks, actionable recommendations.
   - `visual_digest`: short sections, metrics, pull quotes, cards or tables, and Mermaid diagrams when useful.
   - `knowledge_atlas`: precise definitions, relationships, comparisons, exploration paths, and Mermaid concept flows when useful.
3. For architecture, process, lifecycle, or relationship explanations, use the existing `architecture-diagrams` skill and emit standard Mermaid fenced blocks. Prefer `flowchart LR`; use `flowchart TD`, `sequenceDiagram`, `stateDiagram-v2`, or `erDiagram` only when they better fit the information. Keep high-level diagrams focused at roughly 5–12 nodes.
4. Return the complete editable Markdown deliverable, not an intake summary, plan, tool log, or save instruction.
5. Put unsupported claims, uncertainty, source conflicts, and remaining editorial work in `Review Notes`.
6. Never invent a citation, fact, or completed user confirmation.
7. Keep analysis, planning, search narration, and tool-use commentary internal. Do not emit progress messages before the deliverable.
8. Start the final response directly with the document H1 and stop at the document's final line. Do not add a preface, epilogue, explanation, completion message, or an outer Markdown code fence around the full deliverable.

## Interaction Rule
Use questions only for decisions the user must make. Search for facts; ask for intent.
