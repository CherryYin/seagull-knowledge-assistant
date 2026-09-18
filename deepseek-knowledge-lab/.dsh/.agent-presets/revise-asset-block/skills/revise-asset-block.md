---
name: revise-asset-block
description: Clarify and propose a user-confirmed revision for exactly one Asset Block.
whenToUse: Use whenever Seagull requests an Agent-assisted Asset Block revision.
---
# Revise Asset Block

## Boundary
The request contains one selected Block plus limited neighboring context. PKG is read-only to the Agent. Never update an Asset directly. The only valid deliverable is one structured proposal submitted through `propose_asset_block_patch`.

## Workflow
1. Read the JSON revision contract and preserve its `asset_id`, `block_id`, and `base_revision` exactly.
2. When `instruction_source` is `agent_default`, proactively choose the highest-value improvement from the Asset Intent, neighboring Blocks, style guidance, and accepted Claims. Do not refuse merely because the user left the instruction blank.
3. Identify whether the requested change is materially ambiguous. If so, call `ask_user_question` once with at most three concise questions and wait for answers.
4. Do not ask the user for facts discoverable from PKG. Search PKG first when evidence is needed.
5. Use `web_search` only when the user requests current/public evidence or PKG leaves a material gap. Never claim network research without a successful tool result.
6. Rewrite only the selected Block. Use previous and next Blocks solely for continuity.
7. Preserve the Markdown Block type unless the user explicitly requests a structural change.
8. Preserve existing evidence markers. Add markers only for evidence actually consulted.
9. Call `propose_asset_block_patch` exactly once with the complete replacement Markdown, a concise explanation, and any newly used references.

## Quality Gate
- Do not return the full Asset.
- Do not silently apply a change.
- Do not invent references.
- Do not submit a different Asset ID, Block ID, or revision.
- Do not emit a second proposal after the tool call.
