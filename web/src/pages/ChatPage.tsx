import { useRef, useState, useEffect, useCallback } from "react";
import { History, MessageSquarePlus, Send, Sparkles, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ChatMessage } from "@/components/ChatMessage";
import { streamAction } from "@/lib/api";
import {
  createEmptySession,
  createMessage,
  deriveSessionTitle,
  loadSessions,
  saveSession,
  deleteSession,
  type ChatSessionRecord,
} from "@/lib/chatSessions";

export function ChatPage() {
  const [sessions, setSessions] = useState<ChatSessionRecord[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [selectedHistorySessionId, setSelectedHistorySessionId] = useState<string | null>(null);
  const [tab, setTab] = useState<"chat" | "history">("chat");
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [loading, setLoading] = useState(true);
  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Load sessions and skills from backend on mount
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const loaded = await loadSessions();
        if (cancelled) return;
        if (loaded.length > 0) {
          setSessions(loaded);
          setActiveSessionId(loaded[0].id);
          setSelectedHistorySessionId(loaded[0].id);
        } else {
          const fresh = await createEmptySession();
          if (cancelled) return;
          setSessions([fresh]);
          setActiveSessionId(fresh.id);
          setSelectedHistorySessionId(fresh.id);
        }
      } catch (err) {
        console.error("Failed to load sessions:", err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const currentSession =
    sessions.find((s) => s.id === activeSessionId) ?? sessions[0] ?? null;
  const historySessions = [...sessions]
    .filter((s) => s.messages.length > 0)
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  const selectedHistorySession =
    historySessions.find((s) => s.id === selectedHistorySessionId) ??
    historySessions[0] ??
    null;

  const scrollToBottom = useCallback(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, []);

  useEffect(scrollToBottom, [currentSession?.messages, scrollToBottom]);

  const updateSessionLocal = useCallback(
    (sessionId: string, updater: (s: ChatSessionRecord) => ChatSessionRecord) => {
      setSessions((prev) =>
        prev.map((s) => (s.id === sessionId ? updater(s) : s))
      );
    },
    []
  );

  const handleCreateNewSession = useCallback(async () => {
    try {
      const next = await createEmptySession();
      setSessions((prev) => [next, ...prev]);
      setActiveSessionId(next.id);
      setSelectedHistorySessionId(next.id);
      setInput("");
      setTab("chat");
      textareaRef.current?.focus();
    } catch (err) {
      console.error("Failed to create session:", err);
    }
  }, []);

  const handleDeleteSession = useCallback(async (sessionId: string) => {
    try {
      await deleteSession(sessionId);
      setSessions((prev) => prev.filter((s) => s.id !== sessionId));
    } catch (err) {
      console.error("Failed to delete session:", err);
    }
  }, []);

  const handleSubmit = async () => {
    if (!currentSession) return;
    const task = input.trim();
    if (!task || streaming) return;

    const sessionId = currentSession.id;
    const userMsg = createMessage("user", task);
    const assistantMsg = createMessage("assistant", "");

    updateSessionLocal(sessionId, (s) => {
      const nextMessages = [...s.messages, userMsg, assistantMsg];
      return {
        ...s,
        messages: nextMessages,
        title: deriveSessionTitle(nextMessages),
        updated_at: new Date().toISOString(),
      };
    });
    setSelectedHistorySessionId(sessionId);
    setInput("");
    setStreaming(true);

    let fullResponse = "";

    try {
      const stream = streamAction({
        task,
        session_id: sessionId,
      });

      for await (const chunk of stream) {
        fullResponse += chunk;
        updateSessionLocal(sessionId, (s) => {
          const nextMessages = s.messages.map((m) =>
            m.id === assistantMsg.id
              ? { ...m, content: m.content + chunk }
              : m
          );
          return {
            ...s,
            messages: nextMessages,
            title: deriveSessionTitle(nextMessages),
            updated_at: new Date().toISOString(),
          };
        });
      }
    } catch (err) {
      updateSessionLocal(sessionId, (s) => {
        const nextMessages = s.messages.map((m) =>
          m.id === assistantMsg.id
            ? {
                ...m,
                content:
                  m.content ||
                  `Error: ${err instanceof Error ? err.message : "Unknown error"}`,
              }
            : m
        );
        return {
          ...s,
          messages: nextMessages,
          title: deriveSessionTitle(nextMessages),
          updated_at: new Date().toISOString(),
        };
      });
    } finally {
      setStreaming(false);
      // Persist the final state to backend (the stream endpoint also saves,
      // but we save here as well to capture the local message IDs)
      setSessions((prev) => {
        const session = prev.find((s) => s.id === sessionId);
        if (session) {
          saveSession(session).catch((err) =>
            console.error("Failed to save session:", err)
          );
        }
        return prev;
      });
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-muted-foreground">Loading sessions...</p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col px-6 py-6">
      <div className="mx-auto flex h-full w-full max-w-6xl flex-col">
        <div className="mb-4 flex items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold">Chat</h1>
            <p className="text-sm text-muted-foreground">
              Conversations are persisted to the server.
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={handleCreateNewSession} disabled={streaming}>
            <MessageSquarePlus className="h-4 w-4" /> New Session
          </Button>
        </div>

        <Tabs
          value={tab}
          onValueChange={(value) => setTab(value as "chat" | "history")}
          className="flex min-h-0 flex-1 flex-col"
        >
          <TabsList className="w-fit">
            <TabsTrigger value="chat">Chat</TabsTrigger>
            <TabsTrigger value="history">
              <History className="h-4 w-4" /> History
            </TabsTrigger>
          </TabsList>

          <TabsContent value="chat" className="min-h-0 flex-1">
            <div className="flex h-full flex-col rounded-xl border border-border bg-card">
              <div className="border-b border-border px-5 py-3">
                <h2 className="font-semibold">{currentSession?.title || "New Session"}</h2>
                <p className="text-xs text-muted-foreground">
                  {currentSession?.messages.length || 0} messages
                </p>
              </div>

              <div className="flex-1 overflow-y-auto px-6">
                {!currentSession || currentSession.messages.length === 0 ? (
                  <div className="flex h-full flex-col items-center justify-center gap-4 text-center">
                    <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-primary/10">
                      <Sparkles className="h-8 w-8 text-primary" />
                    </div>
                    <div>
                      <h2 className="mb-2 text-xl font-semibold">Knowledge Assistant</h2>
                      <p className="max-w-md text-sm text-muted-foreground">
                        Ask questions, draft documents, analyze decisions, or plan tasks
                        - all grounded in your personal knowledge base.
                      </p>
                    </div>
                    <div className="mt-4 grid max-w-lg grid-cols-2 gap-2">
                      {[
                        "What do I know about knowledge mining?",
                        "Draft a summary of my architecture designs",
                        "Compare deterministic vs model-driven orchestration",
                        "Help me plan the next phase of this project",
                      ].map((q) => (
                        <button
                          key={q}
                          onClick={() => {
                            setInput(q);
                            textareaRef.current?.focus();
                          }}
                          className="cursor-pointer rounded-lg border border-border px-3 py-2 text-left text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                        >
                          {q}
                        </button>
                      ))}
                    </div>
                  </div>
                ) : (
                  <div className="mx-auto max-w-3xl py-6">
                    {currentSession.messages.map((msg) => (
                      <ChatMessage key={msg.id} role={msg.role as "user" | "assistant"} content={msg.content} />
                    ))}
                    <div ref={bottomRef} />
                  </div>
                )}
              </div>

              <div className="border-t border-border bg-card/50 px-6 py-4">
                <div className="mx-auto flex max-w-3xl items-end gap-3">
                  <Textarea
                    ref={textareaRef}
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder="Ask anything about your knowledge base..."
                    className="min-h-[44px] max-h-[200px] resize-none"
                    rows={1}
                  />
                  <Button size="icon" onClick={handleSubmit} disabled={!input.trim() || streaming}>
                    <Send className="h-4 w-4" />
                  </Button>
                </div>
                <p className="mt-2 text-center text-[10px] text-muted-foreground">
                  Agent searches your knowledge base and reasons over it. Shift+Enter for new line.
                </p>
              </div>
            </div>
          </TabsContent>

          <TabsContent value="history" className="min-h-0 flex-1">
            <div className="grid h-full min-h-0 gap-4 lg:grid-cols-[320px_1fr]">
              <div className="overflow-y-auto rounded-xl border border-border bg-card p-3">
                <div className="mb-3 px-2">
                  <h2 className="font-semibold">Sessions</h2>
                  <p className="text-xs text-muted-foreground">
                    Browse previous conversations by session.
                  </p>
                </div>
                <div className="space-y-2">
                  {historySessions.length === 0 ? (
                    <div className="rounded-lg border border-dashed border-border px-4 py-6 text-sm text-muted-foreground">
                      No chat history yet.
                    </div>
                  ) : (
                    historySessions.map((session) => (
                      <button
                        key={session.id}
                        onClick={() => setSelectedHistorySessionId(session.id)}
                        className={`group w-full rounded-lg border px-3 py-3 text-left transition-colors ${
                          selectedHistorySession?.id === session.id
                            ? "border-primary/40 bg-primary/5"
                            : "border-border hover:bg-accent"
                        }`}
                      >
                        <div className="mb-1 flex items-center justify-between gap-2">
                          <p className="truncate text-sm font-medium">{session.title}</p>
                          <div className="flex shrink-0 items-center gap-1">
                            <span className="text-[10px] text-muted-foreground">
                              {session.messages.length}
                            </span>
                            <Trash2
                              className="h-3 w-3 text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100"
                              onClick={(e) => {
                                e.stopPropagation();
                                handleDeleteSession(session.id);
                              }}
                            />
                          </div>
                        </div>
                        <p className="line-clamp-2 text-xs text-muted-foreground">
                          {session.messages[0]?.content || "Empty session"}
                        </p>
                        <p className="mt-2 text-[10px] text-muted-foreground">
                          {new Date(session.updated_at).toLocaleString()}
                        </p>
                      </button>
                    ))
                  )}
                </div>
              </div>

              <div className="min-h-0 overflow-y-auto rounded-xl border border-border bg-card">
                {selectedHistorySession ? (
                  <div className="flex h-full flex-col">
                    <div className="border-b border-border px-5 py-3">
                      <div className="flex items-center justify-between gap-4">
                        <div>
                          <h2 className="font-semibold">{selectedHistorySession.title}</h2>
                          <p className="text-xs text-muted-foreground">
                            Created {new Date(selectedHistorySession.created_at).toLocaleString()}
                          </p>
                        </div>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            setActiveSessionId(selectedHistorySession.id);
                            setTab("chat");
                          }}
                        >
                          Open In Chat
                        </Button>
                      </div>
                    </div>
                    <div className="mx-auto w-full max-w-3xl flex-1 px-6 py-6">
                      {selectedHistorySession.messages.map((message) => (
                        <ChatMessage key={message.id} role={message.role as "user" | "assistant"} content={message.content} />
                      ))}
                    </div>
                  </div>
                ) : (
                  <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
                    Select a session to view its history.
                  </div>
                )}
              </div>
            </div>
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
