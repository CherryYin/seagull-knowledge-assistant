---
name: revise-asset-document
description: Propose a user-confirmed optimization for a complete Asset after its knowledge workflow is resolved.
whenToUse: Use whenever Seagull requests a whole-document Asset optimization.
---
# Revise Asset Document

## Boundary
The request contains one complete Asset plus its resolved Workspace context. PKG is read-only to the Agent. Never update an Asset directly. The only valid deliverable is one structured proposal submitted through `propose_asset_document_patch`.

## Workflow
1. Preserve `assetId`, `baseWorkspaceRevision`, and `baseDocumentSignature` exactly.
2. Treat the confirmed Intent as the optimization target and the accepted Claims as the factual boundary.
3. Use accepted Evidence, Contribution, and kept or promoted Knowledge Candidates to improve emphasis, synthesis, transitions, and conclusions.
4. Review the whole document before rewriting individual Blocks so terminology and argument flow remain consistent.
5. When `optimizationRound` is greater than 1, address every relevant `qualityAudit.findings` item and preserve valid improvements summarized by `previousOptimization`.
6. If a later-round audit has no findings, focus on editorial precision, repetition, transitions, terminology, and conclusion strength instead of inventing unnecessary changes.
7. For `rewriteMode: replace_document`, rewrite the complete deliverable as a coherent new document. You may merge, split, remove, or reorder the old Blocks; do not preserve process logs, duplicated fragments, or a poor legacy structure merely to keep Block IDs.
8. Return the complete rewritten document in `replacementBlocks`. Each item contains `markdown` and `claimRefs`; do not include old Block IDs in this replacement list.
9. Preserve useful evidence markers. Do not invent references or unsupported facts.
10. Set each replacement Block's `claimRefs` only from `availableClaims`. Remove a Claim link when the rewritten Block no longer expresses it.
11. Improve the title and brief so they accurately represent the revised document and confirmed Intent.
12. Keep internal analysis concise. Do not restate the full source document or spend the output budget narrating the plan; reserve the output budget for `replacementBlocks`.
13. Call `propose_asset_document_patch` exactly once with `rewriteMode: replace_document`, the exact `baseDocumentSignature`, `blocks: []`, and the complete `replacementBlocks` JSON array. Never encode either array as a string.

## Quality Gate
- Do not silently apply or save changes.
- Do not silently mutate the existing editor; the replacement Block structure is still only a proposal until the user applies it.
- Do not use proposed, rejected, superseded, or needs-more-evidence Claims.
- Do not turn a Hypothesis into a fact.
- Do not emit a second proposal after the tool call.
