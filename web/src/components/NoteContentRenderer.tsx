import { MarkdownRenderer } from "@/components/markdown";
import sanitizeHtml from "sanitize-html";

export type NoteRenderMode = "markdown" | "html" | "raw";

function looksLikeHtml(content: string) {
  return /<\/?[a-z][\s\S]*>/i.test(content);
}

function looksLikeFullHtmlDocument(content: string) {
  const normalized = content.trim().toLowerCase();
  return normalized.startsWith("<!doctype html") || (normalized.includes("<html") && normalized.includes("<body"));
}

export function inferNoteRenderMode(content: string): NoteRenderMode {
  return looksLikeHtml(content) ? "html" : "markdown";
}

export function inferNoteRenderModeFromTags(tags: string[] | undefined, content: string): NoteRenderMode {
  const normalized = (tags || []).map((tag) => tag.trim().toLowerCase());
  if (normalized.includes("render:html") || normalized.includes("format:html") || normalized.includes("html")) {
    return "html";
  }
  if (normalized.includes("render:raw") || normalized.includes("format:raw")) {
    return "raw";
  }
  return inferNoteRenderMode(content);
}

export function NoteContentRenderer({ content, mode }: { content: string; mode: NoteRenderMode }) {
  if (mode === "raw") {
    return <pre className="whitespace-pre-wrap font-mono text-sm leading-6">{content || "*No content*"}</pre>;
  }

  if (mode === "html") {
    const source = content || "<p><em>No content</em></p>";

    if (looksLikeFullHtmlDocument(source)) {
      const sanitizedDoc = sanitizeHtml(source, {
        allowedTags: false,
        allowedAttributes: false,
        disallowedTagsMode: "discard",
        allowedSchemes: ["http", "https", "mailto", "data"],
      });

      return (
        <iframe
          title="HTML Note Preview"
          className="min-h-[70vh] w-full rounded-md border border-border bg-white"
          sandbox="allow-same-origin"
          srcDoc={sanitizedDoc}
        />
      );
    }

    const sanitized = sanitizeHtml(source, {
      allowedTags: [
        "a", "article", "aside", "b", "blockquote", "br", "caption", "code", "del", "details", "div", "em",
        "figcaption", "figure", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "i", "img", "li", "ol", "p",
        "pre", "section", "small", "span", "strong", "sub", "summary", "sup", "table", "tbody", "td", "th",
        "thead", "tr", "ul",
      ],
      allowedAttributes: {
        a: ["href", "title", "target", "rel"],
        img: ["src", "alt", "title"],
        code: ["class"],
        span: ["class"],
        th: ["colspan", "rowspan"],
        td: ["colspan", "rowspan"],
      },
      allowedSchemes: ["http", "https", "mailto", "data"],
      transformTags: {
        a: sanitizeHtml.simpleTransform("a", { rel: "noopener noreferrer", target: "_blank" }),
      },
    });

    return (
      <div
        className="note-html-renderer"
        dangerouslySetInnerHTML={{ __html: sanitized }}
      />
    );
  }

  return <MarkdownRenderer>{content || "*No content*"}</MarkdownRenderer>;
}
