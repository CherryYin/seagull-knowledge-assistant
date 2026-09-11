import { useState } from "react";
import { useNavigate } from "react-router-dom";
import type { Components } from "react-markdown";
import { cn } from "@/lib/utils";
import { Bot, User, RotateCw, Check, FileText, StickyNote, Globe, FileOutput, AlertTriangle, BookOpenCheck, Brain } from "lucide-react";
import { Button } from "@/components/ui/button";
import { MarkdownRenderer } from "@/components/markdown";
import type { MessageMetadata, ReferenceInfo } from "@/lib/api";
import { AGENT_WORKFLOW_SAVE_TARGET_LABELS, type WorkflowResultSaveTarget } from "@/lib/agent-workflows";
import { assessAssetDraft, renderAssetDraftRepairRequest, type AssetGenerationRequest } from "@/lib/asset-generation";
import { getMessageRunContract } from "@/lib/chat-message-contract";

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
  onRemember?: () => Promise<void>;
  saveTargets?: WorkflowResultSaveTarget[];
  onSaveTarget?: (target: WorkflowResultSaveTarget) => Promise<void>;
  onRepairAssetDraft?: (prompt: string) => void;
  assetDraft?: AssetGenerationRequest;
}

export function ChatMessage({
  role,
  content,
  metadata,
  streaming,
  onRetry,
  onRemember,
  saveTargets = [],
  onSaveTarget,
  onRepairAssetDraft,
  assetDraft,
}: Props) {
  const isUser = role === "user";
  const navigate = useNavigate();
  const runContract = getMessageRunContract(metadata);
  const [retryLoading, setRetryLoading] = useState(false);
  const [saveState, setSaveState] = useState<Partial<Record<WorkflowResultSaveTarget, "loading" | "done">>>(() => {
    const receipts = metadata?.save_receipts ?? {};
    return Object.fromEntries(Object.keys(receipts).map((target) => [target, "done"])) as Partial<Record<WorkflowResultSaveTarget, "done">>;
  });
  const [actionError, setActionError] = useState<string | null>(null);
  const assetQuality = !isUser && assetDraft && saveTargets.includes("asset")
    ? assessAssetDraft(metadata?.document_content || content, assetDraft)
    : null;

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

  const handleSaveTarget = async (target: WorkflowResultSaveTarget) => {
    if (!onSaveTarget) return;
    setSaveState((current) => ({ ...current, [target]: "loading" }));
    setActionError(null);
    try {
      await onSaveTarget(target);
      setSaveState((current) => ({ ...current, [target]: "done" }));
    } catch (err) {
      setSaveState((current) => {
        const next = { ...current };
        delete next[target];
        return next;
      });
      setActionError(err instanceof Error ? err.message : "Could not save this workflow result.");
    }
  };

  const saveIcon = (target: WorkflowResultSaveTarget, state?: "loading" | "done") => {
    if (state === "done") return <Check className="h-3 w-3 text-emerald-500" />;
    const className = cn("h-3 w-3", state === "loading" && "animate-pulse");
    if (target === "asset") return <FileOutput className={className} />;
    if (target === "wiki_draft") return <BookOpenCheck className={className} />;
    return <StickyNote className={className} />;
  };

  return (
    <div
      className={cn("group flex gap-3 py-4", isUser && "flex-row-reverse")}
      data-agent-run-status={runContract?.run_status}
      data-agent-workflow-id={runContract?.workflow_id ?? undefined}
    >
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
        {!isUser && runContract && (
          <div className="mb-1 flex flex-wrap items-center gap-2 text-[10px] text-muted-foreground">
            <span className={cn(
              "rounded-full border px-2 py-0.5 font-medium",
              runContract.run_status === "completed" && "border-emerald-500/30 text-emerald-700",
              runContract.run_status === "failed" && "border-red-500/30 text-red-700",
              runContract.run_status === "stopped" && "border-amber-500/30 text-amber-700",
            )}>
              {runContract.run_status === "awaiting_input" ? "Awaiting input" : runContract.run_status.charAt(0).toUpperCase() + runContract.run_status.slice(1)}
            </span>
            <span>{runContract.workflow_id ?? "General Chat"}</span>
            {runContract.object_ref?.title && <span>· {runContract.object_ref.title}</span>}
          </div>
        )}
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
          {!isUser && content.length > 200 && (!metadata?.references || metadata.references.length === 0) && (
            <div className="mt-2 flex items-start gap-1.5 border-t border-border/50 pt-2 text-[10px] text-muted-foreground">
              <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
              No explicit Source/Note/Wiki references were attached. Verify important claims before saving a Knowledge Record.
            </div>
          )}
        </div>

        {assetQuality && (
          <div className={cn(
            "mt-2 max-w-2xl rounded-lg border px-3 py-2 text-xs",
            assetQuality.ready
              ? "border-emerald-500/20 bg-emerald-500/5 text-emerald-800"
              : "border-amber-500/30 bg-amber-500/5 text-amber-900",
          )}>
            <p className="font-medium">{assetQuality.ready ? "Asset draft quality check passed" : "Asset draft save is blocked"}</p>
            {!assetQuality.ready && (
              <ul className="mt-1 list-disc space-y-1 pl-4">
                {assetQuality.blockingIssues.map((issue) => <li key={issue}>{issue}</li>)}
              </ul>
            )}
            {assetQuality.warnings.length > 0 && (
              <ul className="mt-1 list-disc space-y-1 pl-4 opacity-80">
                {assetQuality.warnings.map((warning) => <li key={warning}>{warning}</li>)}
              </ul>
            )}
          </div>
        )}

        {/* Action buttons */}
        {!streaming && content && (
          <div className="mt-1 flex items-center gap-1">
            {/* Retry button — on user messages */}
            {onRetry && (isUser || runContract?.run_status === "failed" || runContract?.run_status === "stopped") && (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 gap-1 px-2 text-xs text-muted-foreground hover:text-foreground"
                onClick={handleRetry}
                disabled={retryLoading}
              >
                <RotateCw className={cn("h-3 w-3", retryLoading && "animate-spin")} />
                {isUser ? "Retry" : "Retry run"}
              </Button>
            )}

            {isUser && onRemember && (
              <Button variant="ghost" size="sm" className="h-7 gap-1 px-2 text-xs text-muted-foreground hover:text-foreground" onClick={() => void onRemember()}>
                <Brain className="h-3 w-3" />Remember
              </Button>
            )}

            {!isUser && assetDraft && assetQuality && !assetQuality.ready && onRepairAssetDraft && (
              <Button
                variant="outline"
                size="sm"
                className="h-7 gap-1 px-2 text-xs"
                onClick={() => onRepairAssetDraft(renderAssetDraftRepairRequest(assetDraft, assetQuality))}
              >
                <RotateCw className="h-3 w-3" />
                Regenerate to fix issues
              </Button>
            )}

            {!isUser && onSaveTarget && saveTargets.map((target) => {
              const state = saveState[target];
              const appliesToExistingAsset = target === "asset" && Boolean(assetDraft?.assetId);
              const label = appliesToExistingAsset ? "Apply Draft to Asset" : AGENT_WORKFLOW_SAVE_TARGET_LABELS[target];
              return (
                <Button
                  key={target}
                  variant="ghost"
                  size="sm"
                  className="h-7 gap-1 px-2 text-xs text-muted-foreground hover:text-foreground"
                  onClick={() => handleSaveTarget(target)}
                  disabled={Boolean(state) || (target === "asset" && assetQuality !== null && !assetQuality.ready)}
                >
                  {saveIcon(target, state)}
                  {state === "done" ? (appliesToExistingAsset ? "Applied to Asset" : "Saved") : label}
                </Button>
              );
            })}

          </div>
        )}
        {actionError && (
          <div className="mt-2 flex max-w-xl items-start gap-1.5 rounded-lg border border-red-500/20 bg-red-500/5 px-3 py-2 text-xs text-red-700">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <div>
              <p className="font-medium">Action failed</p>
              <p>{actionError}</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
