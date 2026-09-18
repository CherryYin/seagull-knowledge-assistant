import { useMemo, useState } from "react";
import { Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { HarnessQuestionAnswer, HarnessQuestionItem } from "@/lib/api";

interface QuestionCardProps {
  questions: HarnessQuestionItem[];
  onSubmit: (answers: HarnessQuestionAnswer[]) => Promise<void> | void;
}

interface DraftAnswer {
  selected: string[];
  custom: string;
}

export function QuestionCard({ questions, onSubmit }: QuestionCardProps) {
  const [drafts, setDrafts] = useState<Record<string, DraftAnswer>>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const complete = useMemo(() => questions.every((question) => {
    const draft = drafts[question.id];
    return Boolean(draft && (draft.selected.length > 0 || draft.custom.trim()));
  }), [drafts, questions]);

  function update(questionId: string, updater: (current: DraftAnswer) => DraftAnswer) {
    setDrafts((current) => ({
      ...current,
      [questionId]: updater(current[questionId] ?? { selected: [], custom: "" }),
    }));
  }

  function toggleOption(question: HarnessQuestionItem, label: string) {
    update(question.id, (current) => ({
      ...current,
      selected: question.multiSelect
        ? current.selected.includes(label)
          ? current.selected.filter((value) => value !== label)
          : [...current.selected, label]
        : [label],
    }));
  }

  async function handleSubmit() {
    if (!complete || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await onSubmit(questions.map((question) => {
        const draft = drafts[question.id] ?? { selected: [], custom: "" };
        return {
          id: question.id,
          selected: draft.selected,
          ...(draft.custom.trim() ? { custom: draft.custom.trim() } : {}),
        };
      }));
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Unable to submit the answer.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex max-h-[min(60vh,36rem)] min-h-0 shrink-0 flex-col border-t border-border bg-card/50">
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-6 py-4">
        <div className="mx-auto max-w-3xl space-y-5">
          {questions.map((question) => {
            const draft = drafts[question.id] ?? { selected: [], custom: "" };
            return (
              <div key={question.id} className="space-y-3">
                {question.header && <p className="text-xs font-semibold uppercase tracking-wide text-primary">{question.header}</p>}
                <p className="text-sm font-medium">{question.question}</p>
                {question.options && question.options.length > 0 && (
                  <div className="flex flex-wrap gap-2">
                    {question.options.map((option) => (
                      <Button
                        key={option.label}
                        type="button"
                        variant={draft.selected.includes(option.label) ? "default" : "outline"}
                        size="sm"
                        className="h-auto max-w-full whitespace-normal py-2 text-left"
                        onClick={() => toggleOption(question, option.label)}
                      >
                        <span><span className="font-medium">{option.label}</span>{option.description && <span className="ml-1 opacity-75">— {option.description}</span>}</span>
                      </Button>
                    ))}
                  </div>
                )}
                <Input
                  value={draft.custom}
                  onChange={(event) => update(question.id, (current) => ({ ...current, custom: event.target.value }))}
                  placeholder={question.options?.length ? "补充说明或输入其他答案…" : "输入你的回复…"}
                />
              </div>
            );
          })}
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
      </div>
      <div className="shrink-0 border-t border-border/70 px-6 py-3">
        <div className="mx-auto flex max-w-3xl justify-end">
          <Button onClick={handleSubmit} disabled={!complete || submitting}>
            <Send className="mr-2 h-4 w-4" />{submitting ? "Submitting…" : "Continue"}
          </Button>
        </div>
      </div>
    </div>
  );
}
