from __future__ import annotations

PAGE_TYPES = ("topic", "entity", "concept", "project", "comparison")

_TEMPLATE_MAP = {
    "topic": {
        "title": "Topic",
        "description": "Use for a broad area of durable knowledge that will likely be updated over time.",
        "content": "## Overview\n\nWrite a short introduction that explains the topic in plain language and gives the reader immediate context.\n\n## Background\n\nExplain how this topic emerged, why it matters, or what surrounding context helps the reader understand it.\n\n## Key Ideas\n\nDescribe the main ideas, patterns, or moving parts in readable paragraphs.\n\n## Implications\n\nExplain why this topic matters in practice, including consequences, tradeoffs, or applications.\n\n## Open Questions\n\nList remaining uncertainties, weakly supported areas, or questions worth revisiting.\n",
    },
    "entity": {
        "title": "Entity",
        "description": "Use for a person, company, tool, product, organization, or other named thing.",
        "content": "## Overview\n\nIntroduce the entity in one or two readable paragraphs. Explain what it is and why someone should care.\n\n## Background\n\nDescribe the entity's origin, role, or context.\n\n## Notable Characteristics\n\nExplain the most important facts, capabilities, or distinguishing traits in prose rather than bullet fragments.\n\n## Why It Matters\n\nDescribe its relevance, impact, or relationship to the surrounding topic space.\n\n## Open Questions\n\nCapture ambiguity, missing evidence, or unresolved issues.\n",
    },
    "concept": {
        "title": "Concept",
        "description": "Use for an idea, principle, mechanism, or framework that benefits from definition and boundaries.",
        "content": "## Definition\n\nDefine the concept clearly in a way that is readable to someone new to the topic.\n\n## Explanation\n\nExplain the concept's core logic, mechanism, or structure in connected paragraphs.\n\n## When It Applies\n\nDescribe the situations where this concept is useful, including boundaries and caveats.\n\n## Examples or Interpretations\n\nAdd examples, analogies, or contrasting interpretations when they help understanding.\n\n## Open Questions\n\nRecord uncertainty, edge cases, or places where the concept needs stronger evidence.\n",
    },
    "project": {
        "title": "Project",
        "description": "Use for an initiative with goals, status, decisions, and active next steps.",
        "content": "## Overview\n\nDescribe what the project is, what it is trying to accomplish, and why it exists.\n\n## Current Status\n\nExplain the current state in readable prose, including major progress and current direction.\n\n## Key Decisions\n\nSummarize important decisions, constraints, or turning points.\n\n## Risks and Unknowns\n\nDescribe blockers, risks, and unresolved questions.\n\n## Next Questions\n\nList the questions or decisions that still need to be addressed.\n",
    },
    "comparison": {
        "title": "Comparison",
        "description": "Use for side-by-side evaluation where tradeoffs and supporting evidence matter.",
        "content": "## Overview\n\nExplain what is being compared and why the comparison matters.\n\n## Shared Ground\n\nDescribe the main similarities or common assumptions.\n\n## Differences and Tradeoffs\n\nExplain the meaningful distinctions in readable prose, with emphasis on practical consequences.\n\n## Where Each Option Fits\n\nDescribe when one option is more appropriate than another.\n\n## Open Questions\n\nCapture weak evidence, unresolved comparisons, or missing benchmarks.\n",
    },
}


def get_wiki_template(page_type: str) -> dict[str, str]:
    return _TEMPLATE_MAP.get(page_type, _TEMPLATE_MAP["topic"])


def build_wiki_template(title: str, page_type: str) -> str:
    template = get_wiki_template(page_type)
    return f"# {title}\n\n{template['content']}"
