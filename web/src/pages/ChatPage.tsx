import { useRef, useState, useEffect, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { Bot, History, MessageSquarePlus, Microscope, Send, Sparkles, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ChatMessage } from "@/components/ChatMessage";
import { ResearchSteps, type StepInfo } from "@/components/ResearchSteps";
import {
  streamAction,
  chatSessionsApi,
  knowledgeApi,
  agentProfilesApi,
  type DocumentMetadata,
  type ChatSessionMessage,
  type SSEvent,
} from "@/lib/api";
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
  const [steps, setSteps] = useState<StepInfo[]>([]);
  const [deepResearch, setDeepResearch] = useState(false);
  const [activeProfileId, setActiveProfileId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => { abortRef.current?.abort(); };
  }, []);

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

  const { data: profilesData } = useQuery({
    queryKey: ["agent-profiles"],
    queryFn: agentProfilesApi.list,
  });
  const profiles = profilesData?.items ?? [];

  useEffect(() => {
    if (profiles.length > 0 && activeProfileId === null) {
      const def = profiles.find((p) => p.is_default);
      if (def) setActiveProfileId(def.id);
    }
  }, [profiles, activeProfileId]);

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

  const sendMessage = useCallback(
    async (task: string, truncateAfterIndex?: number) => {
      if (!currentSession || streaming) return;
      const sessionId = currentSession.id;

      // If retrying, truncate messages first
      if (truncateAfterIndex !== undefined) {
        updateSessionLocal(sessionId, (s) => ({
          ...s,
          messages: s.messages.slice(0, truncateAfterIndex),
        }));
      }

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
      setStreaming(true);
      setSteps([]);

      let fullResponse = "";
      const abortController = new AbortController();
      abortRef.current = abortController;

      try {
        const stream = streamAction({
          task,
          session_id: sessionId,
          profile_id: activeProfileId ?? undefined,
        }, abortController.signal);

        for await (const event of stream) {
          switch (event.type) {
            case "content":
              fullResponse += event.text;
              updateSessionLocal(sessionId, (s) => {
                const nextMessages = s.messages.map((m) =>
                  m.id === assistantMsg.id
                    ? { ...m, content: m.content + event.text }
                    : m
                );
                return {
                  ...s,
                  messages: nextMessages,
                  title: deriveSessionTitle(nextMessages),
                  updated_at: new Date().toISOString(),
                };
              });
              break;
            case "step":
              setSteps((prev) => {
                if (event.status === "running") {
                  return [...prev, { tool: event.tool, status: "running" }];
                }
                // Mark matching running step as done
                return prev.map((s) =>
                  s.tool === event.tool && s.status === "running"
                    ? { ...s, status: "done" as const }
                    : s
                );
              });
              break;
            case "ask_human":
              // ask_human question is already part of the content stream
              break;
            case "error":
              updateSessionLocal(sessionId, (s) => {
                const nextMessages = s.messages.map((m) =>
                  m.id === assistantMsg.id
                    ? { ...m, content: m.content + `\n\nError: ${event.message}` }
                    : m
                );
                return { ...s, messages: nextMessages, updated_at: new Date().toISOString() };
              });
              break;
            case "done":
              break;
          }
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
        abortRef.current = null;
        setStreaming(false);
        setSteps([]);
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
        // Refresh session from backend to pick up server-populated metadata
        try {
          const refreshed = await chatSessionsApi.get(sessionId);
          setSessions((prev) =>
            prev.map((s) => (s.id === sessionId ? refreshed : s))
          );
        } catch {
          // Non-critical: metadata just won't show until page reload
        }
      }
    },
    [currentSession, streaming, updateSessionLocal]
  );

  const handleSubmit = async () => {
    const raw = input.trim();
    if (!raw || streaming) return;
    setInput("");
    const task = deepResearch ? `/deep-research ${raw}` : raw;
    sendMessage(task);
  };

  const handleRetry = useCallback(
    (userMsg: ChatSessionMessage, msgIndex: number) => {
      sendMessage(userMsg.content, msgIndex);
    },
    [sendMessage]
  );

  const handleNewKnowledge = useCallback(
    async (doc: DocumentMetadata | undefined, assistantMsg: ChatSessionMessage) => {
      if (!currentSession) return;
      const title = doc?.filename
        ? doc.filename.replace(/\.[^.]+$/, "").replace(/[-_]/g, " ")
        : undefined;
      await knowledgeApi.saveDocument({
        message_content: assistantMsg.content,
        title,
        storage_uri: doc?.storage_uri,
        document_format: doc?.format,
        document_filename: doc?.filename,
        session_id: currentSession.id,
      });
    },
    [currentSession]
  );

  const handleRemember = useCallback(
    async (assistantMsg: ChatSessionMessage) => {
      if (!currentSession) return;
      await knowledgeApi.remember({
        content: assistantMsg.content,
        session_id: currentSession.id,
      });
    },
    [currentSession]
  );

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
                    {currentSession.messages.map((msg, idx) => (
                      <ChatMessage
                        key={msg.id}
                        role={msg.role as "user" | "assistant"}
                        content={msg.content}
                        metadata={msg.metadata}
                        streaming={
                          streaming && idx === currentSession.messages.length - 1
                        }
                        onRetry={
                          msg.role === "user" && !streaming
                            ? () => handleRetry(msg, idx)
                            : undefined
                        }
                        onNewKnowledge={
                          msg.role === "assistant" &&
                          msg.metadata?.documents?.length
                            ? (doc) => handleNewKnowledge(doc, msg)
                            : undefined
                        }
                        onRemember={
                          msg.role === "assistant" && !streaming
                            ? () => handleRemember(msg)
                            : undefined
                        }
                      />
                    ))}
                    {streaming && steps.length > 0 && (
                      <ResearchSteps steps={steps} />
                    )}
                    <div ref={bottomRef} />
                  </div>
                )}
              </div>

              <div className="border-t border-border bg-card/50 px-6 py-4">
                <div className="mx-auto flex max-w-3xl items-center gap-2 mb-2">
                  <button
                    type="button"
                    onClick={() => setDeepResearch((v) => !v)}
                    className={cn(
                      "flex items-center gap-1.5 rounded-full px-3 py-1 text-xs transition-colors border cursor-pointer",
                      deepResearch
                        ? "bg-primary text-primary-foreground border-primary"
                        : "bg-transparent text-muted-foreground border-border hover:bg-accent"
                    )}
                  >
                    <Microscope className="h-3.5 w-3.5" />
                    Deep Research
                  </button>
                  {profiles.length > 0 && (
                    <div className="flex items-center gap-1.5 rounded-full border border-border px-2 py-0.5">
                      <Bot className="h-3.5 w-3.5 text-muted-foreground" />
                      <select
                        value={activeProfileId ?? ""}
                        onChange={(e) => setActiveProfileId(e.target.value || null)}
                        className="bg-transparent text-xs text-muted-foreground outline-none cursor-pointer py-0.5"
                      >
                        <option value="">Default</option>
                        {profiles.map((p) => (
                          <option key={p.id} value={p.id}>{p.name}</option>
                        ))}
                      </select>
                    </div>
                  )}
                </div>
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
                        <ChatMessage
                          key={message.id}
                          role={message.role as "user" | "assistant"}
                          content={message.content}
                          metadata={message.metadata}
                        />
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
