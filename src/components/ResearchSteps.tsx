import { Check, Loader2, Search, Globe, BookOpen, FileText, MessageCircleQuestion, BarChart3, Wrench } from "lucide-react";

export interface StepInfo {
  tool: string;
  status: "running" | "done";
}

const TOOL_LABELS: Record<string, { label: string; icon: React.ElementType }> = {
  search_knowledge: { label: "Searching knowledge base", icon: Search },
  web_search: { label: "Searching the web", icon: Globe },
  read_note: { label: "Reading note", icon: BookOpen },
  read_source: { label: "Reading source", icon: FileText },
  ask_human: { label: "Waiting for your input", icon: MessageCircleQuestion },
  knowledge_stats: { label: "Checking KB stats", icon: BarChart3 },
  process_document: { label: "Generating document", icon: FileText },
  list_notes: { label: "Browsing notes", icon: BookOpen },
  list_sources: { label: "Browsing sources", icon: FileText },
};

function getToolInfo(tool: string) {
  return TOOL_LABELS[tool] ?? { label: tool, icon: Wrench };
}

export function ResearchSteps({ steps }: { steps: StepInfo[] }) {
  if (steps.length === 0) return null;

  return (
    <div className="mb-3 flex flex-wrap items-center gap-2">
      {steps.map((step, i) => {
        const { label, icon: Icon } = getToolInfo(step.tool);
        const isDone = step.status === "done";
        return (
          <span
            key={i}
            className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium transition-colors ${
              isDone
                ? "bg-muted text-muted-foreground"
                : "bg-primary/10 text-primary"
            }`}
          >
            <Icon className="h-3 w-3" />
            {label}
            {isDone ? (
              <Check className="h-3 w-3" />
            ) : (
              <Loader2 className="h-3 w-3 animate-spin" />
            )}
          </span>
        );
      })}
    </div>
  );
}
