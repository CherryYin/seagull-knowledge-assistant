import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { cn } from "@/lib/utils";
import { Bot, User, RotateCw, BookPlus, Brain, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { DocumentMetadata, MessageMetadata } from "@/lib/api";

interface Props {
  role: "user" | "assistant";
  content: string;
  metadata?: MessageMetadata | null;
  streaming?: boolean;
  onRetry?: () => void;
  onNewKnowledge?: (doc: DocumentMetadata) => void;
  onRemember?: () => void;
}

export function ChatMessage({
  role,
  content,
  metadata,
  streaming,
  onRetry,
  onNewKnowledge,
  onRemember,
}: Props) {
  const isUser = role === "user";
  const [retryLoading, setRetryLoading] = useState(false);
  const [newKnowledgeLoading, setNewKnowledgeLoading] = useState(false);
  const [rememberLoading, setRememberLoading] = useState(false);
  const [newKnowledgeDone, setNewKnowledgeDone] = useState(false);
  const [rememberDone, setRememberDone] = useState(false);

  const hasDocuments = !!(metadata?.documents && metadata.documents.length > 0);

  const handleRetry = async () => {
    if (!onRetry) return;
    setRetryLoading(true);
    try {
      onRetry();
    } finally {
      setRetryLoading(false);
    }
  };

  const handleNewKnowledge = async (doc: DocumentMetadata) => {
    if (!onNewKnowledge) return;
    setNewKnowledgeLoading(true);
    try {
      await onNewKnowledge(doc);
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
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
            </div>
          ) : (
            <div className="prose prose-sm">
              <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
                {content}
              </ReactMarkdown>
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

            {/* New Knowledge button — on assistant messages with documents */}
            {!isUser && hasDocuments && onNewKnowledge && (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 gap-1 px-2 text-xs text-muted-foreground hover:text-foreground"
                onClick={() => handleNewKnowledge(metadata!.documents![0])}
                disabled={newKnowledgeLoading || newKnowledgeDone}
              >
                {newKnowledgeDone ? (
                  <Check className="h-3 w-3 text-emerald-500" />
                ) : (
                  <BookPlus className={cn("h-3 w-3", newKnowledgeLoading && "animate-pulse")} />
                )}
                New Knowledge
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
