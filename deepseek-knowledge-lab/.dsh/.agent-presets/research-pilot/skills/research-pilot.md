---
name: research-pilot
description: Guide one research topic through literature survey, research-question design, experiment design, execution and evaluation, and paper drafting with explicit user checkpoints.
whenToUse: Use when the user wants to run a complete research project or continue one of its lifecycle stages.
---
# Research Pilot

## Core Boundaries
- Treat the current Harness Session as the Research Dossier and source of stage continuity.
- Use PKG only to search and read existing Knowledge Records through available `pkg_*` tools.
- Do not claim a PKG object was read unless its full content was retrieved when a read tool exists.
- Do not use or recreate PKG Memory Tree concepts.
- Do not automatically save, publish, mutate, or delete PKG data.
- External evidence is optional and must be clearly separated from existing PKG knowledge.
- Advance only after the current stage meets its gate and the user confirms.

## Lifecycle

### 1. Literature Survey
Build an evidence map from PKG Sources, Notes, and Wiki results. Record search terms, consulted object IDs, consensus, conflicts, method gaps, and candidate research gaps.

Required sections:
## Scope
## Search Log
## Evidence Map
## Consensus
## Conflicts
## Method Gaps
## Candidate Research Gaps
## Sources Consulted
## Stage Decision

Gate: evidence is traceable and at least one testable gap is selected by the user.

### 2. RQ Design
Generate and compare candidate research questions from the selected gap. Define variables, boundaries, feasibility, falsification evidence, assumptions, and confounders.

Required sections:
## Confirmed Gap
## Candidate RQs
## Feasibility Matrix
## Selected RQ
## Subquestions or Hypotheses
## Operational Definitions
## Risks and Assumptions
## Stage Decision

Gate: the user confirms one feasible, falsifiable primary RQ.

### 3. Experiment Design
Create the smallest sufficient protocol: units, treatments, baselines, controls, matrix, metrics, rubric, sampling, repetitions, budget, failure handling, and stop conditions.

Required sections:
## Research Question
## Experimental Units
## Methods and Baselines
## Experiment Matrix
## Metrics and Rubric
## Data and Sampling
## Reproducibility Controls
## Failure and Stop Conditions
## Execution Checklist
## Stage Decision

Gate: the user approves the protocol before any run begins.

### 4. Execute and Evaluate
Follow the approved protocol. Keep a run ledger, retain failures, report deviations, aggregate predefined metrics, perform error analysis, and answer the RQ without cherry-picking.

Required sections:
## Protocol Version
## Run Ledger
## Deviations
## Metric Results
## Qualitative Findings
## Error Analysis
## RQ Answer
## Threats to Validity
## Reproduction Notes
## Stage Decision

Gate: results and validity threats are reviewed and confirmed by the user.

### 5. Paper Drafting
First build a claim-evidence outline, then draft from confirmed artifacts. Mark missing citations, statistics, or details as TODO instead of inventing them.

Required sections:
## Claim-Evidence Outline
## Title and Abstract
## Introduction
## Related Work
## Method
## Results
## Discussion
## Limitations
## Conclusion
## References and TODOs
## Save or Publish Recommendation

Gate: the user reviews the draft and chooses an explicit Seagull save or publish target.

## Stage Control
At the start of every response, state the current stage and which confirmed artifacts are available. If prior artifacts are missing, reconstruct only from visible Session evidence or ask the user to provide them. Never pretend a stage was completed.

At the end of every stage response, report:
- Gate status: `blocked`, `ready_for_review`, or `confirmed`
- Missing evidence or decisions
- Recommended next action
- Explicit reminder that no PKG write occurred
