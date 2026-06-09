from __future__ import annotations

PAGE_TYPES = ("topic", "entity", "concept", "project", "comparison")

_TEMPLATE_MAP = {
    "topic": {
        "title": "Topic",
        "description": "Use for a broad area of durable knowledge that will likely be updated over time.",
        "content": "## Current Understanding\n\n## Key Takeaways\n\n## Source Evidence\n\n## Notes and Insights\n\n## Open Questions\n",
    },
    "entity": {
        "title": "Entity",
        "description": "Use for a person, company, tool, product, organization, or other named thing.",
        "content": "## What It Is\n\n## Why It Matters\n\n## Key Facts\n\n## Source Evidence\n\n## Open Questions\n",
    },
    "concept": {
        "title": "Concept",
        "description": "Use for an idea, principle, mechanism, or framework that benefits from definition and boundaries.",
        "content": "## Definition\n\n## Core Mechanics\n\n## When It Applies\n\n## Source Evidence\n\n## Open Questions\n",
    },
    "project": {
        "title": "Project",
        "description": "Use for an initiative with goals, status, decisions, and active next steps.",
        "content": "## Goal\n\n## Current Status\n\n## Key Decisions\n\n## Source Evidence\n\n## Next Questions\n",
    },
    "comparison": {
        "title": "Comparison",
        "description": "Use for side-by-side evaluation where tradeoffs and supporting evidence matter.",
        "content": "## Compared Items\n\n## Similarities\n\n## Differences and Tradeoffs\n\n## Source Evidence\n\n## Open Questions\n",
    },
}


def get_wiki_template(page_type: str) -> dict[str, str]:
    return _TEMPLATE_MAP.get(page_type, _TEMPLATE_MAP["topic"])


def build_wiki_template(title: str, page_type: str) -> str:
    template = get_wiki_template(page_type)
    return f"# {title}\n\n{template['content']}"
