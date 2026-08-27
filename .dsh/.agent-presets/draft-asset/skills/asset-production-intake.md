---
name: asset-production-intake
description: Clarify an Asset delivery need, discover local PKG evidence, optionally fill material gaps with web evidence, and produce a reviewable Markdown deliverable.
whenToUse: Use whenever the user starts or continues the draft-asset workflow.
---
# Asset Production Intake

## Core Boundary
The current Harness Session is the production workspace. PKG remains the durable knowledge store and is read-only to the Agent. No Asset exists until the user explicitly saves the final draft in Seagull.

## Phase 1: Clarify
1. Read the supplied Asset delivery contract and user need.
2. Determine whether the objective, audience, scope, decision/use case, freshness requirement, or important constraints are materially ambiguous.
3. Do not ask questions whose answers can be discovered from PKG.
4. If material ambiguity remains, call `ask_user_question` with one batch of at most three concise questions. Put the recommended option first when choices are useful.
5. Wait for the answers before drafting. Do not emit a placeholder deliverable while waiting.

## Phase 2: Discover Local Evidence
1. Search PKG first with multiple focused `pkg_search` queries derived from the confirmed need.
2. Inspect explicit seed references even when search finds newer alternatives.
3. Read the full relevant Source or Note when a read tool exists.
4. Prefer a small evidence set that directly supports the deliverable over a large undifferentiated list.
5. Track consulted IDs and cite grounded claims inline as `[Source: id]`, `[Note: id]`, or `[Wiki: id]`.

## Phase 3: Fill Gaps
1. When the delivery contract says `local_then_web`, finish the PKG pass first, identify at least one concrete freshness or evidence gap, and call `web_search` at least once for that gap.
2. Search for the specific unresolved gap rather than repeating the whole topic.
3. Prefer primary or authoritative results and use only claims supported by the returned snippets or answer.
4. Keep network evidence separate from PKG evidence and retain its URL in the evidence section.
5. If web evidence conflicts with PKG, expose the conflict and confidence instead of silently choosing one.
6. If `web_search` fails or returns no citeable source, record that failure in `Review Notes`; never claim that network research completed.

## Phase 4: Produce
1. Follow the Asset type's required H2 sections and quality criteria exactly.
2. Return the complete editable Markdown deliverable, not an intake summary, plan, tool log, or save instruction.
3. Put unsupported claims, uncertainty, source conflicts, and remaining editorial work in `Review Notes`.
4. Never invent a citation, fact, or completed user confirmation.

## Interaction Rule
Use questions only for decisions the user must make. Search for facts; ask for intent.
