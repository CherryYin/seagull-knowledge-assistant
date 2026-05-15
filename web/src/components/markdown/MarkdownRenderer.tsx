import ReactMarkdown, { type Components } from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import { MermaidDiagram } from "@/components/markdown/MermaidDiagram";

const sanitizeSchema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    code: [...(defaultSchema.attributes?.code || []), "className"],
    span: [...(defaultSchema.attributes?.span || []), "className"],
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
}

export function MarkdownRenderer({ children, components, enableHighlight = true }: MarkdownRendererProps) {
  const markdownComponents: Components = {
    ...components,
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
      remarkPlugins={[remarkGfm]}
      rehypePlugins={enableHighlight ? [rehypeHighlight, [rehypeSanitize, sanitizeSchema]] : [[rehypeSanitize, sanitizeSchema]]}
      components={markdownComponents}
    >
      {children}
    </ReactMarkdown>
  );
}
