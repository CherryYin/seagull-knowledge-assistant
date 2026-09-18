const EDITORIAL_SECTION_HEADINGS = new Set([
  "evidence notes",
  "evidence and confidence",
  "evidence index",
  "review notes",
]);

const KNOWLEDGE_MARKER_PATTERN = /\[(?:Source|Note|Wiki):\s*[^\]\s]+\]/g;

function normalizeHeading(value: string) {
  return value
    .trim()
    .toLocaleLowerCase()
    .replace(/[’']/g, "'")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function cleanReaderLine(line: string) {
  return line
    .replace(KNOWLEDGE_MARKER_PATTERN, "")
    .replace(/[ \t]+([,.;:!?，。；：！？])/g, "$1")
    .replace(/[ \t]{2,}/g, " ")
    .trimEnd();
}

export interface AssetContentPresentation {
  readerMarkdown: string;
  editorialMarkdown: string;
}

export function splitAssetContent(content?: string | null): AssetContentPresentation {
  if (!content?.trim()) return { readerMarkdown: "", editorialMarkdown: "" };

  const readerLines: string[] = [];
  const editorialLines: string[] = [];
  let editorialSection = false;

  for (const line of content.split("\n")) {
    const heading = line.match(/^##\s+(.+?)\s*$/);
    if (heading) editorialSection = EDITORIAL_SECTION_HEADINGS.has(normalizeHeading(heading[1]));

    if (editorialSection) editorialLines.push(line);
    else readerLines.push(cleanReaderLine(line));
  }

  return {
    readerMarkdown: readerLines.join("\n").replace(/\n{3,}/g, "\n\n").trim(),
    editorialMarkdown: editorialLines.join("\n").replace(/\n{3,}/g, "\n\n").trim(),
  };
}
