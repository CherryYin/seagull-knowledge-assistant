export const wikiTemplates: Record<string, { label: string; description: string; content: string }> = {
  topic: {
    label: "Topic",
    description: "Broad durable knowledge that will likely evolve over time.",
    content: "## Current Understanding\n\n## Key Takeaways\n\n## Source Evidence\n\n## Notes and Insights\n\n## Open Questions\n",
  },
  entity: {
    label: "Entity",
    description: "A named person, company, product, tool, or organization.",
    content: "## What It Is\n\n## Why It Matters\n\n## Key Facts\n\n## Source Evidence\n\n## Open Questions\n",
  },
  concept: {
    label: "Concept",
    description: "An idea, principle, framework, or mechanism that benefits from clear definition.",
    content: "## Definition\n\n## Core Mechanics\n\n## When It Applies\n\n## Source Evidence\n\n## Open Questions\n",
  },
  project: {
    label: "Project",
    description: "An initiative with goals, status, key decisions, and next questions.",
    content: "## Goal\n\n## Current Status\n\n## Key Decisions\n\n## Source Evidence\n\n## Next Questions\n",
  },
  comparison: {
    label: "Comparison",
    description: "Side-by-side evaluation with explicit tradeoffs and evidence.",
    content: "## Compared Items\n\n## Similarities\n\n## Differences and Tradeoffs\n\n## Source Evidence\n\n## Open Questions\n",
  },
};

export function buildWikiTemplate(title: string, pageType: string) {
  const template = wikiTemplates[pageType] ?? wikiTemplates.topic;
  return `# ${title}\n\n${template.content}`;
}
