import { useState, useRef, useEffect } from "react";
import { Send, Square, X, CornerDownLeft, Plus, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { runComplete, parseModelSelector } from "@/lib/note-ai";
import type { CompleteMessage } from "@/lib/api";

interface PanelMessage {
  role: "user" | "assistant";
  content: string;
}

interface NoteAIPanelProps {
  open: boolean;
  onClose: () => void;
  activeModel: string | null;
  noteTitle: string;
  getSelection: () => string;
  onInsert: (text: string) => void;
  onAppend: (text: string) => void;
}

export function NoteAIPanel({
  open,
  onClose,
  activeModel,
  noteTitle,
  getSelection,
  onInsert,
  onAppend,
}: NoteAIPanelProps) {
  const [messages, setMessages] = useState<PanelMessage[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, streaming]);

  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  if (!open) return null;

  async function handleSend() {
    const question = input.trim();
    if (!question || streaming) return;
    const selection = getSelection();
    const { provider_id, model_id } = parseModelSelector(activeModel);

    const system = `You are a writing assistant helping the user refine a note titled "${noteTitle}".
When the user provides selected text inside <selection> tags, focus your answer on that text.
Be concise and actionable. When asked to rewrite, expand, or transform content, return only markdown.`;

    const userContent = selection
      ? `<selection>\n${selection}\n</selection>\n\n${question}`
      : question;

    const history: CompleteMessage[] = [
      { role: "system", content: system },
      ...messages.map((m) => ({ role: m.role, content: m.content }) as CompleteMessage),
      { role: "user", content: userContent },
    ];

    const assistant: PanelMessage = { role: "assistant", content: "" };
    setMessages((prev) => [...prev, { role: "user", content: question }, assistant]);
    setInput("");
    setError(null);
    setStreaming(true);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      await runComplete(
        { messages: history, provider_id, model_id },
        controller.signal,
        (_delta, full) => {
          setMessages((prev) => {
            const next = [...prev];
            next[next.length - 1] = { role: "assistant", content: full };
            return next;
          });
        },
      );
    } catch (err) {
      if (controller.signal.aborted) {
        // keep partial response
      } else {
        setError(err instanceof Error ? err.message : "Request failed");
      }
    } finally {
      setStreaming(false);
      abortRef.current = null;
    }
  }

  function handleStop() {
    abortRef.current?.abort();
  }

  function handleClear() {
    setMessages([]);
    setError(null);
  }

  const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");

  return (
    <div className="fixed right-0 top-0 z-40 flex h-full w-[380px] max-w-[90vw] flex-col border-l border-border bg-background shadow-xl">
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <div className="flex items-center gap-1.5 text-sm font-medium">
          <Sparkles className="h-4 w-4 text-primary" /> Note Assistant
        </div>
        <div className="flex items-center gap-1">
          {messages.length > 0 && (
            <Button variant="ghost" size="sm" onClick={handleClear} disabled={streaming}>
              Clear
            </Button>
          )}
          <Button variant="ghost" size="icon" onClick={onClose} title="Close">
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto p-3 space-y-3">
        {messages.length === 0 && !streaming && (
          <div className="text-sm text-muted-foreground space-y-2">
            <p>Ask about the whole note, or select text in the editor first to focus the answer on it.</p>
            <p className="text-xs">Tip: rewrite, expand, summarize, or critique a passage.</p>
          </div>
        )}
        {messages.map((m, idx) => (
          <div
            key={idx}
            className={`rounded-lg px-3 py-2 text-sm whitespace-pre-wrap break-words ${
              m.role === "user"
                ? "bg-primary/10 ml-6"
                : "bg-muted mr-2"
            }`}
          >
            {m.content || (m.role === "assistant" && streaming ? "…" : "")}
          </div>
        ))}
        {error && <p className="text-xs text-destructive">{error}</p>}
      </div>

      {lastAssistant && lastAssistant.content && !streaming && (
        <div className="flex gap-2 border-t border-border px-3 py-2">
          <Button variant="outline" size="sm" onClick={() => onInsert(lastAssistant.content)}>
            <CornerDownLeft className="h-3.5 w-3.5" /> Insert at cursor
          </Button>
          <Button variant="outline" size="sm" onClick={() => onAppend(lastAssistant.content)}>
            <Plus className="h-3.5 w-3.5" /> Append
          </Button>
        </div>
      )}

      <div className="border-t border-border p-3">
        <Textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              handleSend();
            }
          }}
          placeholder={streaming ? "Generating…" : "Ask about the note or selection…"}
          disabled={streaming}
          rows={2}
          className="resize-none text-sm"
        />
        <div className="mt-2 flex justify-end">
          {streaming ? (
            <Button size="sm" variant="destructive" onClick={handleStop}>
              <Square className="h-3.5 w-3.5 fill-current" /> Stop
            </Button>
          ) : (
            <Button size="sm" onClick={handleSend} disabled={!input.trim()}>
              <Send className="h-3.5 w-3.5" /> Send
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
