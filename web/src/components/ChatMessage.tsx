import { useState } from "react";
import { useNavigate } from "react-router-dom";
import type { Components } from "react-markdown";
import { cn } from "@/lib/utils";
import { Bot, User, RotateCw, Brain, Check, FileText, StickyNote, Globe, FileOutput } from "lucide-react";
import { Button } from "@/components/ui/button";
import { MarkdownRenderer } from "@/components/markdown";
import type { MessageMetadata, ReferenceInfo } from "@/lib/api";

const CITATION_RE = /\[来源[：:]\s*((?:note|src|source)-[^\]]+)\]/g;

function linkifyCitations(text: string): string {
  return text.replace(CITATION_RE, (_match, id: string) => {
    const trimmed = id.trim();
    if (trimmed.startsWith("note-")) {
      return `[来源: ${trimmed}](/notes/${encodeURIComponent(trimmed)})`;
    }
    // Normalize "source-xxx" to "src-xxx" for the route
    const sourceId = trimmed.startsWith("source-")
      ? "src-" + trimmed.slice("source-".length)
      : trimmed;
    return `[来源: ${trimmed}](/sources/${encodeURIComponent(sourceId)})`;
  });
}

function citationLabel(id: string): string {
  if (id.startsWith("note-")) return id.slice("note-".length).replace(/-/g, " ");
  if (id.startsWith("src-")) return id.slice("src-".length).replace(/-/g, " ");
  if (id.startsWith("source-")) return id.slice("source-".length).replace(/-/g, " ");
  return id.replace(/-/g, " ");
}

interface Props {
  role: "user" | "assistant";
  content: string;
  metadata?: MessageMetadata | null;
  streaming?: boolean;
  onRetry?: () => void;
  onNewKnowledge?: () => void;
  onSaveAsNote?: () => void;
  onRemember?: () => void;
}

export function ChatMessage({
  role,
  content,
  metadata,
  streaming,
  onRetry,
  onNewKnowledge,
  onSaveAsNote,
  onRemember,
}: Props) {
  const isUser = role === "user";
  const navigate = useNavigate();
  const [retryLoading, setRetryLoading] = useState(false);
  const [newKnowledgeLoading, setNewKnowledgeLoading] = useState(false);
  const [saveAsNoteLoading, setSaveAsNoteLoading] = useState(false);
  const [rememberLoading, setRememberLoading] = useState(false);
  const [newKnowledgeDone, setNewKnowledgeDone] = useState(false);
  const [saveAsNoteDone, setSaveAsNoteDone] = useState(false);
  const [rememberDone, setRememberDone] = useState(false);

  const markdownComponents: Components = {
    a: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { children?: React.ReactNode }) => {
      const isNoteCitation = href?.startsWith("/notes/");
      const isSourceCitation = href?.startsWith("/sources/");
      if ((isNoteCitation || isSourceCitation) && href) {
        const rawId = decodeURIComponent(href.split("/").pop() || "");
        const label = citationLabel(rawId);
        const Icon = isNoteCitation ? StickyNote : FileText;
        return (
          <button
            type="button"
            onClick={() => navigate(href, { state: { backTo: "/chat", backLabel: "Back to Chat" } })}
            className="inline-flex items-center gap-0.5 rounded bg-primary/10 px-1.5 py-0.5 text-xs font-medium text-primary hover:bg-primary/20 transition-colors cursor-pointer no-underline align-baseline"
            title={rawId}
          >
            <Icon className="h-3 w-3 shrink-0" />
            {label}
          </button>
        );
      }
      return <a href={href} target="_blank" rel="noopener noreferrer" {...props}>{children}</a>;
    },
  };

  const handleRetry = async () => {
    if (!onRetry) return;
    setRetryLoading(true);
    try {
      onRetry();
    } finally {
      setRetryLoading(false);
    }
  };

  const handleNewKnowledge = async () => {
    if (!onNewKnowledge) return;
    setNewKnowledgeLoading(true);
    try {
      await onNewKnowledge();
      setNewKnowledgeDone(true);
      setTimeout(() => setNewKnowledgeDone(false), 2000);
    } catch {
      // Error handled by parent
    } finally {
      setNewKnowledgeLoading(false);
    }
  };

  const handleRemember = async () => {
    if (!onRemember) return;
    setRememberLoading(true);
    try {
      await onRemember();
      setRememberDone(true);
      setTimeout(() => setRememberDone(false), 2000);
    } catch {
      // Error handled by parent
    } finally {
      setRememberLoading(false);
    }
  };

  const handleSaveAsNote = async () => {
    if (!onSaveAsNote) return;
    setSaveAsNoteLoading(true);
    try {
      await onSaveAsNote();
      setSaveAsNoteDone(true);
      setTimeout(() => setSaveAsNoteDone(false), 2000);
    } catch {
      // Error handled by parent
    } finally {
      setSaveAsNoteLoading(false);
    }
  };

  return (
    <div className={cn("group flex gap-3 py-4", isUser && "flex-row-reverse")}>
      {/* Avatar */}
      <div
        className={cn(
          "flex h-8 w-8 shrink-0 items-center justify-center rounded-full",
          isUser ? "bg-primary/20" : "bg-emerald-500/20"
        )}
      >
        {isUser ? (
          <User className="h-4 w-4 text-primary" />
        ) : (
          <Bot className="h-4 w-4 text-emerald-600" />
        )}
      </div>

      {/* Message bubble + actions */}
      <div className={cn("max-w-[75%]", isUser && "flex flex-col items-end")}>
        <div
          className={cn(
            "rounded-xl px-4 py-3 text-sm",
            isUser
              ? "bg-primary/15 text-foreground"
              : "bg-muted text-foreground"
          )}
        >
          {isUser ? (
            <div className="prose prose-sm">
              <MarkdownRenderer enableHighlight={false}>{content}</MarkdownRenderer>
            </div>
          ) : (
            <div className="prose prose-sm">
              <MarkdownRenderer components={markdownComponents}>{linkifyCitations(content)}</MarkdownRenderer>
            </div>
          )}

          {/* Reference footer */}
          {!isUser && metadata?.references && metadata.references.length > 0 && (
            <div className="mt-2 flex flex-wrap items-center gap-1.5 border-t border-border/50 pt-2">
              <span className="text-[10px] text-muted-foreground mr-0.5">引用:</span>
              {metadata.references.map((ref) => {
                if (ref.type === "web") {
                  return (
                    <a
                      key={ref.id}
                      href={ref.id}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-0.5 rounded bg-blue-500/10 px-1.5 py-0.5 text-xs text-blue-600 hover:bg-blue-500/20 transition-colors no-underline"
                      title={ref.id}
                    >
                      <Globe className="h-3 w-3 shrink-0" />
                      {ref.title}
                    </a>
                  );
                }
                return (
                  <button
                    key={ref.id}
                    type="button"
                    onClick={() => navigate(ref.type === "note" ? `/notes/${encodeURIComponent(ref.id)}` : `/sources/${encodeURIComponent(ref.id)}`, { state: { backTo: "/chat", backLabel: "Back to Chat" } })}
                    className="inline-flex items-center gap-0.5 rounded bg-primary/10 px-1.5 py-0.5 text-xs text-primary hover:bg-primary/20 transition-colors cursor-pointer"
                    title={ref.id}
                  >
                    {ref.type === "note" ? <StickyNote className="h-3 w-3 shrink-0" /> : <FileText className="h-3 w-3 shrink-0" />}
                    {ref.title}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Action buttons */}
        {!streaming && content && (
          <div className="mt-1 flex items-center gap-1">
            {/* Retry button — on user messages */}
            {isUser && onRetry && (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 gap-1 px-2 text-xs text-muted-foreground hover:text-foreground"
                onClick={handleRetry}
                disabled={retryLoading}
              >
                <RotateCw className={cn("h-3 w-3", retryLoading && "animate-spin")} />
                Retry
              </Button>
            )}

            {!isUser && onSaveAsNote && (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 gap-1 px-2 text-xs text-muted-foreground hover:text-foreground"
                onClick={handleSaveAsNote}
                disabled={saveAsNoteLoading || saveAsNoteDone}
              >
                {saveAsNoteDone ? (
                  <Check className="h-3 w-3 text-emerald-500" />
                ) : (
                  <StickyNote className={cn("h-3 w-3", saveAsNoteLoading && "animate-pulse")} />
                )}
                {saveAsNoteDone ? "Saved" : "Save as Note"}
              </Button>
            )}

            {/* Save to Writing button — on assistant messages with generated documents */}
            {!isUser && onNewKnowledge && (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 gap-1 px-2 text-xs text-muted-foreground hover:text-foreground"
                onClick={handleNewKnowledge}
                disabled={newKnowledgeLoading || newKnowledgeDone}
              >
                {newKnowledgeDone ? (
                  <Check className="h-3 w-3 text-emerald-500" />
                ) : (
                  <FileOutput className={cn("h-3 w-3", newKnowledgeLoading && "animate-pulse")} />
                )}
                {newKnowledgeDone ? "Saved" : "Save as Source + Note"}
              </Button>
            )}

            {/* Remember Knowledge button — on all assistant messages */}
            {!isUser && onRemember && (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 gap-1 px-2 text-xs text-muted-foreground hover:text-foreground"
                onClick={handleRemember}
                disabled={rememberLoading || rememberDone}
              >
                {rememberDone ? (
                  <Check className="h-3 w-3 text-emerald-500" />
                ) : (
                  <Brain className={cn("h-3 w-3", rememberLoading && "animate-pulse")} />
                )}
                Remember
              </Button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
