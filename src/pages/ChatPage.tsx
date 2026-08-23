import { useRef, useState, useEffect, useCallback } from "react";
import { useLocation } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Cpu, History, MessageSquarePlus, Microscope, Send, Sparkles, Square, Trash2, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { agentMemoryApi } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ChatMessage } from "@/components/ChatMessage";
import { QuestionCard } from "@/components/QuestionCard";
import { ResearchSteps, type StepInfo } from "@/components/ResearchSteps";
import {
  harnessChat,
  chatSessionsApi,
  knowledgeApi,
  categoriesApi,
  sessionContextsApi,
  type ChatSessionMessage,
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
import {
  AGENT_WORKFLOW_GROUP_DESCRIPTIONS,
  AGENT_WORKFLOW_SAVE_TARGET_LABELS,
  AGENT_WORKFLOW_TEMPLATES,
  findAgentWorkflowTemplate,
  groupAgentWorkflowTemplates,
  inferAgentWorkflowId,
  renderAgentWorkflowPrompt,
  type AgentWorkflowContext,
  type AgentWorkflowTemplate,
  type WorkflowResultSaveTarget,
} from "@/lib/agent-workflows";
import { saveWorkflowResult } from "@/lib/workflow-result-save";

type ChatLocationState = {
  promptSeed?: string;
  workflowId?: string;
  objectRef?: AgentWorkflowContext["objectRef"];
  assetDraft?: AgentWorkflowContext["assetDraft"];
} | null;

export function ChatPage() {
  const location = useLocation();
  const [sessions, setSessions] = useState<ChatSessionRecord[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [selectedHistorySessionId, setSelectedHistorySessionId] = useState<string | null>(null);
  const [tab, setTab] = useState<"chat" | "history">("chat");
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [steps, setSteps] = useState<StepInfo[]>([]);
  const [deepResearch, setDeepResearch] = useState(false);
  const [pendingQuestion, setPendingQuestion] = useState<{
    question: string;
    options?: string[];
  } | null>(null);
  const [activeModel, setActiveModel] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [seedApplied, setSeedApplied] = useState(false);
  const [selectedWorkflowId, setSelectedWorkflowId] = useState<string | null>(null);
  const [workflowContext, setWorkflowContext] = useState<AgentWorkflowContext>({});
  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const stopRequestedRef = useRef(false);

  useEffect(() => {
    return () => {
      stopRequestedRef.current = true;
      abortRef.current?.abort();
    };
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

  const { data: models } = useQuery({
    queryKey: ["models"],
    queryFn: () => knowledgeApi.models(),
    staleTime: 60 * 60 * 1000,
  });

  const { data: categoriesData } = useQuery({
    queryKey: ["categories"],
    queryFn: () => categoriesApi.list(),
  });
  const defaultCategoryId = categoriesData?.items[0]?.id;

  useEffect(() => {
    if (seedApplied) return;
    const state = location.state as ChatLocationState;
    if (!state?.promptSeed && !state?.workflowId) return;
    const nextWorkflowId =
      state.workflowId ?? inferAgentWorkflowId(state.objectRef?.object_type, state.promptSeed);
    const nextContext = { objectRef: state.objectRef, promptSeed: state.promptSeed, assetDraft: state.assetDraft };
    const workflow = findAgentWorkflowTemplate(nextWorkflowId);

    setWorkflowContext(nextContext);
    setSelectedWorkflowId(workflow?.id ?? null);
    if (workflow) {
      setInput(renderAgentWorkflowPrompt(workflow, nextContext));
    } else if (state.promptSeed) {
      const prefix = state.objectRef?.title
        ? `Context: ${state.objectRef.object_type || "object"} ${state.objectRef.title}\n\n`
        : "";
      setInput(`${prefix}${state.promptSeed}`);
    }
    setTab("chat");
    setSeedApplied(true);
    setTimeout(() => textareaRef.current?.focus(), 0);
  }, [location.state, seedApplied]);

  const currentSession =
    sessions.find((s) => s.id === activeSessionId) ?? sessions[0] ?? null;
  const historySessions = [...sessions]
    .filter((s) => s.messages.length > 0)
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  const selectedHistorySession =
    historySessions.find((s) => s.id === selectedHistorySessionId) ??
    historySessions[0] ??
    null;
  const selectedWorkflow = findAgentWorkflowTemplate(selectedWorkflowId);
  const workflowSections = groupAgentWorkflowTemplates();

  const scrollToBottom = useCallback(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, []);

  useEffect(scrollToBottom, [currentSession?.messages, scrollToBottom]);

  useEffect(() => {
    if (!currentSession) return;
    const state = location.state as ChatLocationState;
    if (state?.assetDraft) {
      void sessionContextsApi.putAssetGeneration(currentSession.id, state.assetDraft).catch((error) => {
        console.error("Failed to persist Asset generation context:", error);
      });
      return;
    }
    if (state?.promptSeed || state?.workflowId) return;

    let cancelled = false;
    void sessionContextsApi.get(currentSession.id).then(({ context }) => {
      if (cancelled) return;
      if (!context) {
        setSelectedWorkflowId(null);
        setWorkflowContext({});
        return;
      }
      const nextContext = { assetDraft: context.assetDraft };
      setSelectedWorkflowId(context.workflowId);
      setWorkflowContext(nextContext);
      if (currentSession.messages.length === 0) {
        const workflow = findAgentWorkflowTemplate(context.workflowId);
        if (workflow) setInput(renderAgentWorkflowPrompt(workflow, nextContext));
      }
    }).catch((error) => {
      if (!cancelled) console.error("Failed to restore Asset generation context:", error);
    });
    return () => { cancelled = true; };
  }, [currentSession?.id, location.state]);

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
      setSelectedWorkflowId(null);
      setWorkflowContext({});
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
      setPendingQuestion(null);
      stopRequestedRef.current = false;
      const sessionId = currentSession.id;
      const createHarnessSession = currentSession.messages.length === 0;
      const harnessPreset = selectedWorkflowId ?? "knowledge-lab";
      const baseMessages = truncateAfterIndex !== undefined
        ? currentSession.messages.slice(0, truncateAfterIndex)
        : currentSession.messages;

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
        const nextMessages = [...baseMessages, userMsg, assistantMsg];
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
      let stopped = false;
      const abortController = new AbortController();
      abortRef.current = abortController;

      try {
        const stream = harnessChat(task, {
          preset: harnessPreset,
          sessionId,
          createSession: createHarnessSession,
          clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          signal: abortController.signal,
        });

        for await (const event of stream) {
          switch (event.type) {
            case "session":
              break;
            case "text": {
              const text = event.content ?? "";
              fullResponse += text;
              updateSessionLocal(sessionId, (s) => {
                const nextMessages = s.messages.map((m) =>
                  m.id === assistantMsg.id
                    ? { ...m, content: m.content + text }
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
            }
            case "tool_call":
              setSteps((prev) => {
                const tool = event.tool ?? "tool";
                return [...prev, { tool, status: "running" }];
              });
              break;
            case "tool_result":
              setSteps((prev) => {
                const tool = event.tool;
                return prev.map((s) =>
                  (!tool || s.tool === tool) && s.status === "running"
                    ? { ...s, status: "done" as const }
                    : s
                );
              });
              break;
            case "error": {
              const errorText = `\n\nError: ${event.content ?? "Harness error"}`;
              fullResponse += errorText;
              updateSessionLocal(sessionId, (s) => {
                const nextMessages = s.messages.map((m) =>
                  m.id === assistantMsg.id
                    ? { ...m, content: m.content + errorText }
                    : m
                );
                return { ...s, messages: nextMessages, updated_at: new Date().toISOString() };
              });
              break;
            }
            case "done":
              break;
          }
        }
      } catch (err) {
        stopped = stopRequestedRef.current || (err instanceof Error && err.name === "AbortError");
        if (!fullResponse) {
          fullResponse = stopped
            ? "Stopped."
            : `Error: ${err instanceof Error ? err.message : "Unknown error"}`;
        }
        updateSessionLocal(sessionId, (s) => {
          const nextMessages = s.messages.map((m) => {
            if (m.id !== assistantMsg.id) return m;
            if (stopped) {
              return { ...m, content: m.content || "Stopped." };
            }
            return {
              ...m,
              content:
                m.content ||
                `Error: ${err instanceof Error ? err.message : "Unknown error"}`,
            };
          });
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
        // Fallback: if ask_human SSE didn't fire but content has the marker
        if (!stopped && fullResponse.includes("[WAITING_FOR_HUMAN]")) {
          setPendingQuestion((prev) => {
            if (prev) return prev; // SSE already set it
            const lines = fullResponse.split("[WAITING_FOR_HUMAN]").pop()?.trim() || "";
            const question = lines.split("\n---")[0].trim();
            return question ? { question } : null;
          });
        }
        const finalMessages = [
          ...baseMessages,
          userMsg,
          { ...assistantMsg, content: fullResponse },
        ];
        const finalSession = {
          ...currentSession,
          messages: finalMessages,
          title: deriveSessionTitle(finalMessages),
          updated_at: new Date().toISOString(),
        };
        setSessions((prev) =>
          prev.map((session) => (session.id === sessionId ? finalSession : session))
        );
        try {
          await saveSession(finalSession);
        } catch (err) {
          console.error("Failed to save session:", err);
        }
        stopRequestedRef.current = false;
      }
    },
    [currentSession, selectedWorkflowId, streaming, updateSessionLocal]
  );

  const handleSubmit = async () => {
    const raw = input.trim();
    if (!raw || streaming) return;
    setInput("");
    const task = deepResearch ? `/deep-research ${raw}` : raw;
    sendMessage(task);
  };

  const handleSelectWorkflow = useCallback(
    (workflow: AgentWorkflowTemplate) => {
      const currentInput = input.trim();
      const userInput = selectedWorkflowId ? undefined : currentInput || undefined;
      setSelectedWorkflowId(workflow.id);
      setInput(renderAgentWorkflowPrompt(workflow, { ...workflowContext, userInput }));
      setTab("chat");
      setTimeout(() => textareaRef.current?.focus(), 0);
    },
    [input, selectedWorkflowId, workflowContext]
  );

  const handleClearWorkflow = useCallback(() => {
    setSelectedWorkflowId(null);
    setInput((value) => value.trim());
    setTimeout(() => textareaRef.current?.focus(), 0);
  }, []);

  const handleStop = useCallback(() => {
    stopRequestedRef.current = true;
    abortRef.current?.abort();
    setStreaming(false);
    setSteps([]);
  }, []);

  const handleRetry = useCallback(
    (userMsg: ChatSessionMessage, msgIndex: number) => {
      sendMessage(userMsg.content, msgIndex);
    },
    [sendMessage]
  );

  const handleSaveTarget = useCallback(
    async (assistantMsg: ChatSessionMessage, target: WorkflowResultSaveTarget) => {
      if (!currentSession) throw new Error("No active Harness session is available.");
      await saveWorkflowResult({
        target,
        sessionId: currentSession.id,
        workflowId: selectedWorkflow?.id,
        content: assistantMsg.metadata?.document_content || assistantMsg.content,
        title: assistantMsg.metadata?.document_title,
        categoryId: defaultCategoryId,
        objectRef: workflowContext.objectRef,
        references: assistantMsg.metadata?.references,
        assetDraft: workflowContext.assetDraft,
      });
    },
    [currentSession, defaultCategoryId, selectedWorkflow?.id, workflowContext]
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
					<h1 className="text-2xl font-bold">Agent Chat</h1>
					<p className="text-sm text-muted-foreground">
						Ask the knowledge task assistant to search, reason, write, and save useful outputs back into the system.
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
                    <div className="mt-4 flex w-full max-w-4xl flex-col gap-4">
                      {workflowSections.map((section) => (
                        <div key={section.group} className="space-y-2">
                          <div>
                            <h3 className="text-sm font-semibold">{section.label}</h3>
                            <p className="text-xs text-muted-foreground">
                              {section.description ?? AGENT_WORKFLOW_GROUP_DESCRIPTIONS[section.group]}
                            </p>
                          </div>
                          <div className="grid gap-3 md:grid-cols-2">
                            {section.items.map((workflow) => (
                              <button
                                key={workflow.id}
                                type="button"
                                onClick={() => handleSelectWorkflow(workflow)}
                                className={cn(
                                  "cursor-pointer rounded-xl border px-4 py-3 text-left transition-colors hover:bg-accent",
                                  selectedWorkflowId === workflow.id
                                    ? "border-primary/50 bg-primary/5"
                                    : "border-border"
                                )}
                              >
                                <div className="mb-1 flex items-center justify-between gap-3">
                                  <h3 className="text-sm font-semibold text-foreground">{workflow.title}</h3>
                                  <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">
                                    {workflow.outputSections.length} sections
                                  </span>
                                </div>
                                <p className="mb-2 text-xs text-muted-foreground">{workflow.description}</p>
                                {workflow.requiredInput && (
                                  <p className="mb-2 text-[10px] text-muted-foreground">
                                    Input: {workflow.requiredInput}
                                  </p>
                                )}
                                <div className="flex flex-wrap gap-1">
                                  {workflow.saveTargets.map((target) => (
                                    <span
                                      key={target}
                                      className="rounded-full border border-border px-2 py-0.5 text-[10px] text-muted-foreground"
                                    >
                                      {AGENT_WORKFLOW_SAVE_TARGET_LABELS[target]}
                                    </span>
                                  ))}
                                </div>
                              </button>
                            ))}
                          </div>
                        </div>
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
                        onRemember={
                          msg.role === "user" && !streaming
                            ? async () => {
                                const title = window.prompt("Agent Memory title", msg.content.slice(0, 60));
                                if (title === null) return;
                                const content = window.prompt("Edit what the Agent should remember", msg.content);
                                if (content === null || !content.trim()) return;
                                const candidate = await agentMemoryApi.propose({
                                  proposedScopeType: "global",
                                  proposedKind: "preference",
                                  title,
                                  content,
                                  reason: "The user selected this Chat message for cross-session memory.",
                                  provenance: { sessionId: currentSession.id, eventIds: [msg.id], toolCallIds: [] },
                                });
                                if (window.confirm("Confirm this as active Agent Memory now? Choose Cancel to leave it pending for review.")) {
                                  await agentMemoryApi.accept(candidate.id);
                                }
                              }
                            : undefined
                        }
                        saveTargets={
                          msg.role === "assistant" && !streaming
                            ? selectedWorkflow?.saveTargets || ["note"]
                            : []
                        }
                        onSaveTarget={
                          msg.role === "assistant" && !streaming
                            ? (target) => handleSaveTarget(msg, target)
                            : undefined
                        }
                        assetDraft={msg.role === "assistant" ? workflowContext.assetDraft : undefined}
                      />
                    ))}
                    {streaming && steps.length > 0 && (
                      <ResearchSteps steps={steps} />
                    )}
                    <div ref={bottomRef} />
                  </div>
                )}
              </div>

              {pendingQuestion ? (
                <QuestionCard
                  question={pendingQuestion.question}
                  options={pendingQuestion.options}
                  onAnswer={(answer) => {
                    setPendingQuestion(null);
                    sendMessage(answer);
                  }}
                />
              ) : (
              <div className="border-t border-border bg-card/50 px-6 py-4">
                {selectedWorkflow && (
                  <div className="mx-auto mb-2 flex max-w-3xl flex-wrap items-center gap-2 rounded-lg border border-primary/20 bg-primary/5 px-3 py-2 text-xs">
                    <span className="font-medium text-primary">Workflow: {selectedWorkflow.title}</span>
                    <span className="text-muted-foreground">Editable prompt · no automatic writes</span>
                    <div className="flex flex-wrap gap-1">
                      {selectedWorkflow.saveTargets.map((target) => (
                        <span
                          key={target}
                          className="rounded-full bg-background px-2 py-0.5 text-[10px] text-muted-foreground"
                        >
                          {AGENT_WORKFLOW_SAVE_TARGET_LABELS[target]}
                        </span>
                      ))}
                    </div>
                    <button
                      type="button"
                      onClick={handleClearWorkflow}
                      className="ml-auto inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] text-muted-foreground hover:bg-background hover:text-foreground"
                    >
                      <X className="h-3 w-3" /> Clear
                    </button>
                  </div>
                )}
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
                  {models && models.length > 0 && (
                    <div className="flex items-center gap-1.5 rounded-full border border-border px-2 py-0.5">
                      <Cpu className="h-3.5 w-3.5 text-muted-foreground" />
                      <select
                        value={activeModel ?? ""}
                        onChange={(e) => setActiveModel(e.target.value || null)}
                        className="bg-transparent text-xs text-muted-foreground outline-none cursor-pointer py-0.5 max-w-[180px]"
                      >
                        <option value="">System Default</option>
                        {(() => {
                          const groups = new Map<string, typeof models>();
                          for (const m of models) {
                            const key = m.provider_id;
                            if (!groups.has(key)) groups.set(key, []);
                            groups.get(key)!.push(m);
                          }
                          return [...groups.entries()].map(([providerId, items]) => (
                            <optgroup key={providerId} label={items[0].provider_name}>
                              {items.map((m) => (
                                <option key={`${providerId}:${m.id}`} value={`${providerId}:${m.id}`}>
                                  {m.display_name}
                                </option>
                              ))}
                            </optgroup>
                          ));
                        })()}
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
                  {streaming ? (
                    <Button size="icon" variant="destructive" onClick={handleStop} title="Stop generating">
                      <Square className="h-4 w-4 fill-current" />
                    </Button>
                  ) : (
                    <Button size="icon" onClick={handleSubmit} disabled={!input.trim()}>
                      <Send className="h-4 w-4" />
                    </Button>
                  )}
                </div>
                <p className="mt-2 text-center text-[10px] text-muted-foreground">
                  Agent searches your knowledge base and reasons over it. Shift+Enter for new line.
                </p>
              </div>
              )}
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
