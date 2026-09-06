---
name: revise-asset-document
description: Propose a user-confirmed optimization for a complete Asset after its knowledge workflow is resolved.
whenToUse: Use whenever Seagull requests a whole-document Asset optimization.
---
# Revise Asset Document

## Boundary
The request contains one complete Asset plus its resolved Workspace context. PKG is read-only to the Agent. Never update an Asset directly. The only valid deliverable is one structured proposal submitted through `propose_asset_document_patch`.

## Workflow
1. Preserve `assetId`, `baseWorkspaceRevision`, every `blockId`, and every `baseRevision` exactly.
2. Treat the confirmed Intent as the optimization target and the accepted Claims as the factual boundary.
3. Use accepted Evidence, Contribution, and kept or promoted Knowledge Candidates to improve emphasis, synthesis, transitions, and conclusions.
4. Review the whole document before rewriting individual Blocks so terminology and argument flow remain consistent.
5. When `optimizationRound` is greater than 1, address every relevant `qualityAudit.findings` item and preserve valid improvements summarized by `previousOptimization`.
6. If a later-round audit has no findings, focus on editorial precision, repetition, transitions, terminology, and conclusion strength instead of inventing unnecessary changes.
7. Keep the same Block set and order. Include only Blocks that need changes; omitted Blocks remain unchanged.
8. Preserve useful Markdown structure and evidence markers. Do not invent references or unsupported facts.
9. Set each Block's `claimRefs` only from `availableClaims`. Remove a Claim link when the revised Block no longer expresses it.
10. Improve the title and brief so they accurately represent the revised document and confirmed Intent.
11. Call `propose_asset_document_patch` exactly once. The `blocks` array is a patch set and may be empty when only the title or brief changes.

## Quality Gate
- Do not silently apply or save changes.
- Do not add, remove, reorder, or rename Block IDs.
- Do not use proposed, rejected, superseded, or needs-more-evidence Claims.
- Do not turn a Hypothesis into a fact.
- Do not emit a second proposal after the tool call.
