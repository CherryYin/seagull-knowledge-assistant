import ReactMarkdown, { type Components } from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import { MermaidDiagram } from "@/components/markdown/MermaidDiagram";
import { TOKEN_KEY } from "@/lib/api/client";

const sanitizeSchema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    code: [...(defaultSchema.attributes?.code || []), "className"],
    span: [...(defaultSchema.attributes?.span || []), "className"],
    // Allow note-attached images served by relative URLs (no protocol).
    img: [...(defaultSchema.attributes?.img || []), "src", "alt", "title"],
  },
  protocols: {
    ...defaultSchema.protocols,
    src: ["http", "https", "data", "blob"], // relative URLs pass through without a protocol
  },
};

const mermaidLanguages = new Set([
  "mermaid",
  "mmd",
  "c4",
  "c4context",
  "c4container",
  "c4component",
  "c4deployment",
  "c4dynamic",
]);

function getTextContent(children: React.ReactNode): string {
  if (typeof children === "string") return children;
  if (typeof children === "number") return String(children);
  if (Array.isArray(children)) return children.map(getTextContent).join("");
  return "";
}

function getCodeLanguage(className?: string) {
  return className?.match(/language-([^\s]+)/)?.[1]?.toLowerCase();
}

function isMermaidCodeBlock(language: string | undefined, code: string) {
  if (language && mermaidLanguages.has(language)) return true;
  return /^(architecture-beta|block-beta|c4context|c4container|c4component|c4deployment|c4dynamic|graph|flowchart|sequenceDiagram|classDiagram|stateDiagram(?:-v2)?|erDiagram|journey|gantt|pie|gitGraph|mindmap|timeline|zenuml|sankey-beta|xychart-beta|quadrantChart|requirementDiagram)\b/.test(code.trim());
}

interface MarkdownRendererProps {
  children: string;
  components?: Components;
  enableHighlight?: boolean;
  evidenceLinks?: Record<string, string>;
  noteId?: string;
}

type MarkdownNode = {
  type: string;
  value?: string;
  url?: string;
  children?: MarkdownNode[];
};

const evidenceMarkerPattern = /\[(Source|Note|Wiki):\s*([^\]\s]+)\]/g;

function linkEvidenceMarkers(node: MarkdownNode, evidenceLinks: Record<string, string>, insideLink = false) {
  if (!node.children?.length) return;

  const nextChildren: MarkdownNode[] = [];
  for (const child of node.children) {
    if (child.type === "text" && child.value && !insideLink) {
      let cursor = 0;
      let match: RegExpExecArray | null;
      evidenceMarkerPattern.lastIndex = 0;
      while ((match = evidenceMarkerPattern.exec(child.value)) !== null) {
        const marker = match[0];
        const key = `${match[1].toLowerCase()}:${match[2]}`;
        const href = evidenceLinks[key];
        if (!href) continue;
        if (match.index > cursor) nextChildren.push({ type: "text", value: child.value.slice(cursor, match.index) });
        nextChildren.push({ type: "link", url: href, children: [{ type: "text", value: marker }] });
        cursor = match.index + marker.length;
      }
      if (cursor > 0) {
        if (cursor < child.value.length) nextChildren.push({ type: "text", value: child.value.slice(cursor) });
        continue;
      }
    }

    const blocksLinks = insideLink || child.type === "link" || child.type === "code" || child.type === "inlineCode";
    linkEvidenceMarkers(child, evidenceLinks, blocksLinks);
    nextChildren.push(child);
  }
  node.children = nextChildren;
}

function remarkEvidenceLinks(options?: { links?: Record<string, string> }) {
  return (tree: MarkdownNode) => linkEvidenceMarkers(tree, options?.links ?? {});
}

/** Resolve a relative note-image URL (e.g. "api/notes/{id}/images/{imgId}") into
 * an authenticated full URL by appending the JWT as a query param. Note images
 * are served via <img> tags which cannot attach Authorization headers. The token
 * is only added at render time, never persisted into note content. */
function resolveNoteImageSrc(src: string, noteId?: string): string {
  if (!noteId) return src;
  const marker = `notes/${encodeURIComponent(noteId)}/images/`;
  const idx = src.indexOf(marker);
  if (idx === -1) return src;
  const tail = src.slice(idx); // notes/{id}/images/{imgId}
  const token = localStorage.getItem(TOKEN_KEY) || "";
  const sep = tail.includes("?") ? "&" : "?";
  return `/api/${tail}${sep}token=${encodeURIComponent(token)}`;
}

export function MarkdownRenderer({ children, components, enableHighlight = true, evidenceLinks, noteId }: MarkdownRendererProps) {
  const markdownComponents: Components = {
    ...components,
    img({ src, alt, ...props }) {
      const resolved = resolveNoteImageSrc(typeof src === "string" ? src : "", noteId);
      return <img src={resolved || src} alt={alt} {...props} />;
    },
    code({ className, children: codeChildren, ...props }) {
      const code = getTextContent(codeChildren).replace(/\n$/, "");
      const language = getCodeLanguage(className);

      if (isMermaidCodeBlock(language, code)) {
        return <MermaidDiagram chart={code} />;
      }

      const Code = components?.code;
      if (Code) {
        return <Code className={className} {...props}>{codeChildren}</Code>;
      }

      return <code className={className} {...props}>{codeChildren}</code>;
    },
  };

  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, [remarkEvidenceLinks, { links: evidenceLinks ?? {} }]]}
      rehypePlugins={enableHighlight ? [rehypeHighlight, [rehypeSanitize, sanitizeSchema]] : [[rehypeSanitize, sanitizeSchema]]}
      components={markdownComponents}
    >
      {children}
    </ReactMarkdown>
  );
}
