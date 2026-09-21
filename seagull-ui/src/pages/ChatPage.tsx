import { useRef, useState, useEffect, useCallback } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Cpu, GripHorizontal, History, MessageSquarePlus, Microscope, Send, Sparkles, Square, Trash2, X } from "lucide-react";
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
  harnessSettingsApi,
  answerHarnessQuestion,
  chatSessionsApi,
  categoriesApi,
  sessionContextsApi,
  type ChatSessionMessage,
  type HarnessQuestionItem,
  type HarnessQuestionAnswer,
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
import {
  completeChatRunContract,
  createChatRunContract,
  createSaveReceipt,
  getMessageAssetDraft,
  getMessageRunContract,
  getMessageSaveTargets,
} from "@/lib/chat-message-contract";
import type { AssetIntentFormDraft, AssetIntentProposal } from "@/lib/asset-generation";
import { useReturnNavigation } from "@/hooks/useReturnNavigation";
import { useRouteScrollRestoration } from "@/hooks/useRouteScrollRestoration";
import { ProposalActions } from "@/components/interaction/ProposalActions";

type ChatLocationState = {
  promptSeed?: string;
  workflowId?: string;
  objectRef?: AgentWorkflowContext["objectRef"];
  assetDraft?: AgentWorkflowContext["assetDraft"];
  assetIntentDraft?: AssetIntentFormDraft;
  backTo?: string;
  backLabel?: string;
} | null;

const CHAT_INPUT_HEIGHT_KEY = "seagull.chat.input-height";
const MIN_CHAT_INPUT_HEIGHT = 44;

function initialChatInputHeight() {
  const stored = Number(window.localStorage.getItem(CHAT_INPUT_HEIGHT_KEY));
  return Number.isFinite(stored) && stored >= MIN_CHAT_INPUT_HEIGHT ? stored : 76;
}

function parseAssetIntentProposal(value: unknown): AssetIntentProposal | null {
  let candidate = value;
  if (typeof candidate === "string") {
    try {
      candidate = JSON.parse(candidate);
    } catch {
      return null;
    }
  }
  if (!candidate || typeof candidate !== "object") return null;
  const proposal = candidate as Record<string, unknown>;
  const workingTitle = proposal.workingTitle ?? proposal.working_title ?? "";
  const creationMode = proposal.creationMode ?? proposal.creation_mode;
  if (
    typeof workingTitle !== "string"
    || typeof proposal.question !== "string"
    || typeof proposal.goal !== "string"
    || (proposal.audience !== undefined && proposal.audience !== null && typeof proposal.audience !== "string")
    || !["understand", "synthesize", "make_decision", "produce"].includes(String(creationMode))
    || !Array.isArray(proposal.scope)
    || !Array.isArray(proposal.constraints)
    || typeof proposal.rationale !== "string"
  ) return null;
  return {
    workingTitle,
    question: proposal.question,
    goal: proposal.goal,
    audience: typeof proposal.audience === "string" ? proposal.audience : "",
    creationMode: creationMode as AssetIntentProposal["creationMode"],
    scope: proposal.scope.filter((item): item is string => typeof item === "string"),
    constraints: proposal.constraints.filter((item): item is string => typeof item === "string"),
    rationale: proposal.rationale,
    authorship: "agent",
    requiresUserConfirmation: true,
  };
}

function parseAssetIntentDraft(value: unknown): AssetIntentFormDraft | undefined {
  if (!value || typeof value !== "object") return undefined;
  const draft = value as Record<string, unknown>;
  if (
    typeof draft.assetType !== "string"
    || typeof draft.title !== "string"
    || typeof draft.audience !== "string"
    || typeof draft.question !== "string"
    || typeof draft.goal !== "string"
    || !["understand", "synthesize", "make_decision", "produce"].includes(String(draft.creationMode))
    || typeof draft.scope !== "string"
    || typeof draft.constraints !== "string"
    || typeof draft.styleNotes !== "string"
    || !Array.isArray(draft.sourceRefs)
    || !Array.isArray(draft.noteRefs)
    || !Array.isArray(draft.wikiRefs)
    || typeof draft.allowWebResearch !== "boolean"
  ) return undefined;
  return {
    ...(draft as unknown as AssetIntentFormDraft),
    styleProfileId: ["editorial_story", "executive_brief", "visual_digest", "knowledge_atlas"].includes(String(draft.styleProfileId))
      ? draft.styleProfileId as AssetIntentFormDraft["styleProfileId"]
      : "editorial_story",
  };
}

export function ChatPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const initialNavigationParams = useRef(new URLSearchParams(location.search));
  const initialTab = initialNavigationParams.current.get("tab") === "history" ? "history" : "chat";
  const [sessions, setSessions] = useState<ChatSessionRecord[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [selectedHistorySessionId, setSelectedHistorySessionId] = useState<string | null>(null);
  const [tab, setTab] = useState<"chat" | "history">(initialTab);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [steps, setSteps] = useState<StepInfo[]>([]);
  const [deepResearch, setDeepResearch] = useState(false);
  const [pendingQuestion, setPendingQuestion] = useState<{
    rpcId: string;
    sessionId: string;
    questions: HarnessQuestionItem[];
  } | null>(null);
  const [activeModel, setActiveModel] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [seedApplied, setSeedApplied] = useState(false);
  const [selectedWorkflowId, setSelectedWorkflowId] = useState<string | null>(null);
  const [workflowContext, setWorkflowContext] = useState<AgentWorkflowContext>({});
  const [assetIntentProposal, setAssetIntentProposal] = useState<AssetIntentProposal | null>(null);
  const [assetIntentProposalIssue, setAssetIntentProposalIssue] = useState<string | null>(null);
  const [chatInputHeight, setChatInputHeight] = useState(initialChatInputHeight);
  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const stopRequestedRef = useRef(false);
  const sessionsRef = useRef<ChatSessionRecord[]>([]);
  const restoredIntentSessionIdRef = useRef<string | null>(null);
  const sessionSaveQueuesRef = useRef(new Map<string, Promise<void>>());
  const launchStateRef = useRef<ChatLocationState>(location.state as ChatLocationState);
  const launchContextPersistedRef = useRef(false);
  const launchState = launchStateRef.current;
  const backTo = launchState?.backTo || "/";
  const backLabel = launchState?.backLabel || "Back";
  const returnToPrevious = useReturnNavigation(backTo, Boolean(launchState?.backTo));

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
        const resumableSessions = loaded.filter((session) => session.messages.length > 0);
        const launchState = launchStateRef.current;
        const requestedSessionId = initialNavigationParams.current.get("session");
        const requestedHistorySessionId = initialNavigationParams.current.get("history_session");
        const startsWorkflow = Boolean(launchState?.promptSeed || launchState?.workflowId);
        if (startsWorkflow) {
          const fresh = await createEmptySession();
          if (cancelled) return;
          const nextSessions = [fresh, ...resumableSessions.filter((session) => session.id !== fresh.id)];
          sessionsRef.current = nextSessions;
          setSessions(nextSessions);
          setActiveSessionId(fresh.id);
          setSelectedHistorySessionId(fresh.id);
          setTab("chat");
        } else if (resumableSessions.length > 0) {
          const requestedSession = resumableSessions.find((session) => session.id === requestedSessionId) ?? resumableSessions[0];
          const requestedHistorySession = resumableSessions.find((session) => session.id === requestedHistorySessionId) ?? requestedSession;
          sessionsRef.current = resumableSessions;
          setSessions(resumableSessions);
          setActiveSessionId(requestedSession.id);
          setSelectedHistorySessionId(requestedHistorySession.id);
        } else {
          const fresh = await createEmptySession();
          if (cancelled) return;
          sessionsRef.current = [fresh];
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
    queryKey: ["harness-models"],
    queryFn: () => harnessSettingsApi.listModels(),
    staleTime: 60 * 60 * 1000,
  });

  const { data: categoriesData } = useQuery({
    queryKey: ["categories"],
    queryFn: () => categoriesApi.list(),
  });
  const defaultCategoryId = categoriesData?.items[0]?.id;

  useEffect(() => {
    if (seedApplied) return;
    const state = launchStateRef.current;
    if (!state?.promptSeed && !state?.workflowId) return;
    const nextWorkflowId =
      state.workflowId ?? inferAgentWorkflowId(state.objectRef?.object_type, state.promptSeed);
    const nextContext = { objectRef: state.objectRef, promptSeed: state.promptSeed, assetDraft: state.assetDraft, assetIntentDraft: state.assetIntentDraft };
    const workflow = findAgentWorkflowTemplate(nextWorkflowId);

    setWorkflowContext(nextContext);
    setSelectedWorkflowId(workflow?.id ?? null);
    setAssetIntentProposal(null);
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
    navigate(
      { pathname: location.pathname, search: location.search },
      {
        replace: true,
        state: state.backTo ? { backTo: state.backTo, backLabel: state.backLabel } : null,
      },
    );
    setTimeout(() => textareaRef.current?.focus(), 0);
  }, [location.pathname, navigate, seedApplied]);

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
  const requestedMessageId = new URLSearchParams(location.search).get("message");
  const {
    scrollRef: messageScrollRef,
    onScroll: onMessageScroll,
    hasStoredScroll: hasStoredMessageScroll,
  } = useRouteScrollRestoration<HTMLDivElement>(
    `chat-session:${currentSession?.id ?? "none"}`,
    Boolean(currentSession),
  );

  useEffect(() => {
    if (loading || !activeSessionId) return;
    const next = new URLSearchParams(location.search);
    if (tab === "history") next.set("tab", "history");
    else next.delete("tab");
    next.set("session", activeSessionId);
    if (tab === "history" && selectedHistorySessionId) next.set("history_session", selectedHistorySessionId);
    else next.delete("history_session");
    const nextSearch = next.toString();
    if (nextSearch === new URLSearchParams(location.search).toString()) return;
    navigate(
      { pathname: location.pathname, search: `?${nextSearch}` },
      { replace: true, state: location.state },
    );
  }, [activeSessionId, loading, location.pathname, location.search, location.state, navigate, selectedHistorySessionId, tab]);

  useEffect(() => {
    if (!currentSession) return;
    const sessionChanged = restoredIntentSessionIdRef.current !== currentSession.id;
    restoredIntentSessionIdRef.current = currentSession.id;
    const storedMessage = [...currentSession.messages].reverse().find((message) => message.metadata?.asset_intent_proposal);
    const proposal = parseAssetIntentProposal(storedMessage?.metadata?.asset_intent_proposal);
    if (!proposal) {
      if (sessionChanged) {
        setAssetIntentProposal(null);
        setAssetIntentProposalIssue(null);
      }
      return;
    }
    const draft = parseAssetIntentDraft(storedMessage?.metadata?.asset_intent_draft);
    setAssetIntentProposal(proposal);
    setSelectedWorkflowId("clarify-asset-intent");
    setWorkflowContext((current) => ({ ...current, assetIntentDraft: draft ?? current.assetIntentDraft }));
    setAssetIntentProposalIssue(null);
  }, [currentSession]);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "smooth") => {
    bottomRef.current?.scrollIntoView({ behavior });
  }, []);

  useEffect(() => {
    if (!currentSession) return;
    if (requestedMessageId) {
      let frame = 0;
      let attempts = 0;
      const scrollWhenReady = () => {
        const scrollContainer = messageScrollRef.current;
        const message = scrollContainer?.querySelector<HTMLElement>(
          `[data-chat-message-id="${CSS.escape(requestedMessageId)}"]`,
        );
        if (!scrollContainer || !message || scrollContainer.clientHeight === 0) {
          if (attempts++ < 12) frame = window.requestAnimationFrame(scrollWhenReady);
          return;
        }
        const containerRect = scrollContainer.getBoundingClientRect();
        const messageRect = message.getBoundingClientRect();
        const centeredTop = scrollContainer.scrollTop
          + messageRect.top
          - containerRect.top
          - Math.max(0, (scrollContainer.clientHeight - messageRect.height) / 2);
        scrollContainer.scrollTo({ top: Math.max(0, centeredTop), behavior: "auto" });
      };
      const timeout = window.setTimeout(() => {
        frame = window.requestAnimationFrame(scrollWhenReady);
      }, 0);
      return () => {
        window.clearTimeout(timeout);
        if (frame) window.cancelAnimationFrame(frame);
      };
    }
    if (streaming) scrollToBottom();
    else if (!hasStoredMessageScroll) window.requestAnimationFrame(() => scrollToBottom("auto"));
  }, [currentSession, hasStoredMessageScroll, messageScrollRef, requestedMessageId, scrollToBottom, streaming]);

  useEffect(() => {
    if (loading || !currentSession) return;
    const state = launchStateRef.current;
    if (state?.assetDraft && !launchContextPersistedRef.current) {
      launchContextPersistedRef.current = true;
      void sessionContextsApi.putAssetGeneration(currentSession.id, state.assetDraft).catch((error) => {
        launchContextPersistedRef.current = false;
        console.error("Failed to persist Asset generation context:", error);
      });
      return;
    }
    if (state?.promptSeed || state?.workflowId) return;
    if (seedApplied || currentSession.messages.some((message) => message.metadata?.asset_intent_proposal)) return;

    let cancelled = false;
    void sessionContextsApi.get(currentSession.id).then(({ context }) => {
      if (cancelled) return;
      if (!context) {
        setSelectedWorkflowId(null);
        setWorkflowContext({});
        return;
      }
      const nextContext = {
        assetDraft: context.assetDraft,
        objectRef: context.assetDraft.assetId
          ? { object_type: "asset", object_id: context.assetDraft.assetId, title: context.assetDraft.title }
          : undefined,
      };
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
  }, [currentSession?.id, currentSession?.messages, loading, seedApplied]);

  const updateSessionLocal = useCallback(
    (sessionId: string, updater: (s: ChatSessionRecord) => ChatSessionRecord) => {
      const nextSessions = sessionsRef.current.map((session) => (session.id === sessionId ? updater(session) : session));
      sessionsRef.current = nextSessions;
      setSessions(nextSessions);
    },
    []
  );

  const persistSessionInOrder = useCallback(async (session: ChatSessionRecord) => {
    const previousSave = sessionSaveQueuesRef.current.get(session.id) ?? Promise.resolve();
    const nextSave = previousSave.catch(() => undefined).then(async () => {
      await saveSession(session);
    });
    sessionSaveQueuesRef.current.set(session.id, nextSave);
    try {
      await nextSave;
    } finally {
      if (sessionSaveQueuesRef.current.get(session.id) === nextSave) {
        sessionSaveQueuesRef.current.delete(session.id);
      }
    }
  }, []);

  const handleCreateNewSession = useCallback(async () => {
    try {
      const next = await createEmptySession();
      const nextSessions = [next, ...sessionsRef.current.filter((session) => session.id !== next.id)];
      sessionsRef.current = nextSessions;
      setSessions(nextSessions);
      setActiveSessionId(next.id);
      setSelectedHistorySessionId(next.id);
      setInput("");
      setSelectedWorkflowId(null);
      setWorkflowContext({});
      setAssetIntentProposal(null);
      setAssetIntentProposalIssue(null);
      setTab("chat");
      textareaRef.current?.focus();
    } catch (err) {
      console.error("Failed to create session:", err);
    }
  }, []);

  const handleDeleteSession = useCallback(async (sessionId: string) => {
    try {
      await deleteSession(sessionId);
      const nextSessions = sessionsRef.current.filter((session) => session.id !== sessionId);
      sessionsRef.current = nextSessions;
      setSessions(nextSessions);
    } catch (err) {
      console.error("Failed to delete session:", err);
    }
  }, []);

  const sendMessage = useCallback(
    async (task: string, truncateAfterIndex?: number) => {
      const sessionAtStart = sessionsRef.current.find((session) => session.id === activeSessionId) ?? currentSession;
      if (!sessionAtStart || streaming) return;
      setPendingQuestion(null);
      stopRequestedRef.current = false;
      const sessionId = sessionAtStart.id;
      const createHarnessSession = sessionAtStart.messages.length === 0;
      const harnessPreset = selectedWorkflowId ?? "knowledge-lab";
      const workflowAtStart = findAgentWorkflowTemplate(selectedWorkflowId);
      const contextAtStart: AgentWorkflowContext = {
        ...workflowContext,
        objectRef: workflowContext.objectRef ? { ...workflowContext.objectRef } : undefined,
        assetDraft: workflowContext.assetDraft
          ? JSON.parse(JSON.stringify(workflowContext.assetDraft)) as AgentWorkflowContext["assetDraft"]
          : undefined,
        assetIntentDraft: workflowContext.assetIntentDraft
          ? JSON.parse(JSON.stringify(workflowContext.assetIntentDraft)) as AgentWorkflowContext["assetIntentDraft"]
          : undefined,
      };
      const runContract = createChatRunContract({
        workflowId: workflowAtStart?.id ?? null,
        objectRef: contextAtStart.objectRef,
        saveTargets: workflowAtStart?.saveTargets ?? ["note"],
        assetDraft: contextAtStart.assetDraft,
      });
      const expectsIntentProposal = harnessPreset === "clarify-asset-intent";
      if (expectsIntentProposal) setAssetIntentProposalIssue(null);
      const baseMessages = truncateAfterIndex !== undefined
        ? sessionAtStart.messages.slice(0, truncateAfterIndex)
        : sessionAtStart.messages;

      // If retrying, truncate messages first
      if (truncateAfterIndex !== undefined) {
        updateSessionLocal(sessionId, (s) => ({
          ...s,
          messages: s.messages.slice(0, truncateAfterIndex),
        }));
      }

      const userMsg = createMessage("user", task);
      const assistantMsg = createMessage("assistant", "", { agent_run: runContract });

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
      let runFailed = false;
      let runError: string | undefined;
      let awaitingInput = false;
      let sawDone = false;
      let generatedIntentProposal: AssetIntentProposal | null = null;
      const abortController = new AbortController();
      abortRef.current = abortController;

      const captureIntentProposal = (value: unknown) => {
        const proposal = parseAssetIntentProposal(value);
        if (!proposal) return false;
        generatedIntentProposal = proposal;
        setAssetIntentProposal(proposal);
        setAssetIntentProposalIssue(null);
        updateSessionLocal(sessionId, (session) => ({
          ...session,
          messages: session.messages.map((message) => message.id === assistantMsg.id ? {
            ...message,
            metadata: {
              ...(message.metadata ?? {}),
              asset_intent_proposal: proposal as unknown as Record<string, unknown>,
              ...(contextAtStart.assetIntentDraft ? { asset_intent_draft: contextAtStart.assetIntentDraft as unknown as Record<string, unknown> } : {}),
            },
          } : message),
        }));
        return true;
      };

      try {
        const stream = harnessChat(task, {
          preset: harnessPreset,
          model: activeModel,
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
              if (event.tool === "propose_asset_intent") {
                captureIntentProposal(event.args);
              }
              setSteps((prev) => {
                const tool = event.tool ?? "tool";
                return [...prev, { tool, status: "running" }];
              });
              break;
            case "tool_result":
              if (event.tool === "propose_asset_intent") captureIntentProposal(event.result);
              setSteps((prev) => {
                const tool = event.tool;
                return prev.map((s) =>
                  (!tool || s.tool === tool) && s.status === "running"
                    ? { ...s, status: "done" as const }
                    : s
                );
              });
              break;
            case "question":
              if (event.rpc_id && event.session_id && event.questions?.length) {
                awaitingInput = true;
                setPendingQuestion({
                  rpcId: event.rpc_id,
                  sessionId: event.session_id,
                  questions: event.questions,
                });
              }
              break;
            case "error": {
              runFailed = true;
              runError = event.content ?? "Harness error";
              const errorText = `\n\nError: ${runError}`;
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
              sawDone = true;
              awaitingInput = false;
              break;
          }
        }
      } catch (err) {
        stopped = stopRequestedRef.current || (err instanceof Error && err.name === "AbortError");
        runFailed = !stopped;
        runError = stopped ? undefined : err instanceof Error ? err.message : "Unknown error";
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
        const latestSession = sessionsRef.current.find((session) => session.id === sessionId) ?? sessionAtStart;
        const finalRunStatus = stopped
          ? "stopped"
          : runFailed
            ? "failed"
            : awaitingInput && !sawDone
              ? "awaiting_input"
              : "completed";
        const finalMessages = latestSession.messages.map((message) => message.id === assistantMsg.id ? {
          ...message,
          content: fullResponse,
          metadata: {
            ...(message.metadata ?? {}),
            agent_run: completeChatRunContract(runContract, finalRunStatus, runError),
            ...(generatedIntentProposal ? {
              asset_intent_proposal: generatedIntentProposal as unknown as Record<string, unknown>,
              ...(contextAtStart.assetIntentDraft ? { asset_intent_draft: contextAtStart.assetIntentDraft as unknown as Record<string, unknown> } : {}),
            } : {}),
          },
        } : message);
        const finalSession = {
          ...latestSession,
          messages: finalMessages,
          title: deriveSessionTitle(finalMessages),
          updated_at: new Date().toISOString(),
        };
        const nextSessions = sessionsRef.current.map((session) => (session.id === sessionId ? finalSession : session));
        sessionsRef.current = nextSessions;
        setSessions(nextSessions);
        try {
          await persistSessionInOrder(finalSession);
        } catch (err) {
          console.error("Failed to save session:", err);
        }
        if (expectsIntentProposal && !generatedIntentProposal && !stopped) {
          setAssetIntentProposalIssue("The Agent returned text but did not create an applyable Intent Proposal.");
        }
        stopRequestedRef.current = false;
      }
    },
    [activeModel, activeSessionId, currentSession, persistSessionInOrder, selectedWorkflowId, streaming, updateSessionLocal, workflowContext]
  );

  const handleSubmit = async () => {
    const raw = input.trim();
    if (!raw || streaming) return;
    setInput("");
    const task = deepResearch ? `/deep-research ${raw}` : raw;
    sendMessage(task);
  };

  const handleRetryIntentProposal = useCallback(() => {
    void sendMessage(
      "Create the applyable Intent Proposal now. Use the conversation context already available, call propose_asset_intent exactly once, and do not treat a prose brief as completion."
    );
  }, [sendMessage]);

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
  }, []);

  const handleRetry = useCallback(
    (userMsg: ChatSessionMessage, msgIndex: number) => {
      sendMessage(userMsg.content, msgIndex);
    },
    [sendMessage]
  );

  const handleSaveTarget = useCallback(
    async (session: ChatSessionRecord, assistantMsg: ChatSessionMessage, target: WorkflowResultSaveTarget) => {
      const runContract = getMessageRunContract(assistantMsg.metadata);
      const allowedTargets = getMessageSaveTargets(assistantMsg.metadata, assistantMsg.content);
      if (!allowedTargets.includes(target)) {
        throw new Error("This message is not a completed, validated result for that save action.");
      }
      const result = await saveWorkflowResult({
        target,
        sessionId: session.id,
        workflowId: runContract?.workflow_id,
        content: assistantMsg.metadata?.document_content || assistantMsg.content,
        title: assistantMsg.metadata?.document_title,
        categoryId: defaultCategoryId,
        objectRef: runContract?.object_ref,
        references: assistantMsg.metadata?.references,
        assetDraft: getMessageAssetDraft(assistantMsg.metadata),
      });
      const receipt = createSaveReceipt(target, result);
      let updatedSession: ChatSessionRecord | null = null;
      updateSessionLocal(session.id, (current) => {
        const messages = current.messages.map((message) => message.id === assistantMsg.id ? {
          ...message,
          metadata: {
            ...(message.metadata ?? {}),
            save_receipts: {
              ...(message.metadata?.save_receipts ?? {}),
              [target]: receipt,
            },
          },
        } : message);
        updatedSession = { ...current, messages, updated_at: new Date().toISOString() };
        return updatedSession;
      });
      if (updatedSession) await persistSessionInOrder(updatedSession);
    },
    [defaultCategoryId, persistSessionInOrder, updateSessionLocal]
  );

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const clampChatInputHeight = useCallback((height: number) => {
    const maximum = Math.max(MIN_CHAT_INPUT_HEIGHT, Math.floor(window.innerHeight * 0.5));
    return Math.min(maximum, Math.max(MIN_CHAT_INPUT_HEIGHT, Math.round(height)));
  }, []);

  const persistChatInputHeight = useCallback((height: number) => {
    const nextHeight = clampChatInputHeight(height);
    setChatInputHeight(nextHeight);
    window.localStorage.setItem(CHAT_INPUT_HEIGHT_KEY, String(nextHeight));
  }, [clampChatInputHeight]);

  const handleChatInputResizeStart = useCallback((event: React.PointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = chatInputHeight;
    const handlePointerMove = (moveEvent: PointerEvent) => {
      setChatInputHeight(clampChatInputHeight(startHeight + startY - moveEvent.clientY));
    };
    const handlePointerUp = (upEvent: PointerEvent) => {
      const nextHeight = clampChatInputHeight(startHeight + startY - upEvent.clientY);
      persistChatInputHeight(nextHeight);
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    };
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
  }, [chatInputHeight, clampChatInputHeight, persistChatInputHeight]);

  const handleChatInputResizeKeyDown = useCallback((event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    event.preventDefault();
    persistChatInputHeight(chatInputHeight + (event.key === "ArrowUp" ? 24 : -24));
  }, [chatInputHeight, persistChatInputHeight]);

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
						{launchState?.backTo && (
              <button type="button" onClick={returnToPrevious} className="mb-1 text-sm text-primary hover:underline">
                {backLabel}
              </button>
            )}
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

              <div
                ref={messageScrollRef}
                onScroll={onMessageScroll}
                className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-6"
                data-route-scroll="chat-messages"
              >
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
                    {currentSession.messages.map((msg, idx) => {
                      const runContract = getMessageRunContract(msg.metadata);
                      const messageSaveTargets = msg.role === "assistant" && !streaming
                        ? getMessageSaveTargets(msg.metadata, msg.content)
                        : [];
                      const previousUserMessage = idx > 0 && currentSession.messages[idx - 1]?.role === "user"
                        ? currentSession.messages[idx - 1]
                        : null;
                      const canRetryAssistant = msg.role === "assistant"
                        && (runContract?.run_status === "failed" || runContract?.run_status === "stopped")
                        && previousUserMessage;
                      return (
                      <div key={msg.id} data-chat-message-id={msg.id}>
                      <ChatMessage
                        role={msg.role as "user" | "assistant"}
                        content={msg.content}
                        metadata={msg.metadata}
                        streaming={
                          streaming && idx === currentSession.messages.length - 1
                        }
                        onRetry={
                          msg.role === "user" && !streaming
                            ? () => handleRetry(msg, idx)
                            : canRetryAssistant
                              ? () => handleRetry(previousUserMessage, idx - 1)
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
                        saveTargets={messageSaveTargets}
                        onSaveTarget={
                          msg.role === "assistant" && !streaming && messageSaveTargets.length > 0
                            ? (target) => handleSaveTarget(currentSession, msg, target)
                            : undefined
                        }
                        onRepairAssetDraft={
                          msg.role === "assistant" && !streaming
                            ? (prompt) => void sendMessage(prompt)
                            : undefined
                        }
                        assetDraft={msg.role === "assistant" ? getMessageAssetDraft(msg.metadata) : undefined}
                      />
                      </div>
                      );
                    })}
                    {streaming && steps.length > 0 && (
                      <ResearchSteps steps={steps} />
                    )}
                    <div ref={bottomRef} />
                  </div>
                )}
              </div>

              {(assetIntentProposal || assetIntentProposalIssue) && (
                <div className="border-t border-border bg-card/50 px-6 pt-4">
                  <div className="mx-auto max-w-3xl space-y-3">
                    {assetIntentProposalIssue && (
                      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm">
                        <div>
                          <p className="font-medium">Intent Proposal was not generated</p>
                          <p className="text-xs text-muted-foreground">{assetIntentProposalIssue}</p>
                        </div>
                        <Button type="button" size="sm" variant="outline" disabled={streaming} onClick={handleRetryIntentProposal}>
                          <Sparkles className="mr-2 h-4 w-4" />
                          Generate Intent Proposal
                        </Button>
                      </div>
                    )}
                    {assetIntentProposal && (
                      <div className="space-y-3 rounded-xl border border-primary/20 bg-primary/5 p-4">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div><p className="font-medium">Agent Intent Proposal</p><p className="text-xs text-muted-foreground">Candidate only · existing form values will not be overwritten</p></div>
                          <ProposalActions
                            primaryLabel="Apply Intent Proposal to Form"
                            onPrimary={() => navigate("/assets/new", { state: { assetIntentProposal, assetIntentDraft: workflowContext.assetIntentDraft } })}
                            onRegenerate={handleRetryIntentProposal}
                            regenerateDisabled={streaming}
                          />
                        </div>
                        <div className="grid gap-3 text-sm md:grid-cols-2">
                          <div><p className="text-xs font-semibold uppercase text-muted-foreground">Question</p><p>{assetIntentProposal.question}</p></div>
                          <div><p className="text-xs font-semibold uppercase text-muted-foreground">Goal</p><p>{assetIntentProposal.goal}</p></div>
                          <div><p className="text-xs font-semibold uppercase text-muted-foreground">Audience</p><p>{assetIntentProposal.audience || "Not specified"}</p></div>
                          <div><p className="text-xs font-semibold uppercase text-muted-foreground">Recommended Mode</p><p>{assetIntentProposal.creationMode.replace(/_/g, " ")}</p></div>
                        </div>
                        <p className="text-xs text-muted-foreground">{assetIntentProposal.rationale}</p>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {pendingQuestion ? (
                <QuestionCard
                  questions={pendingQuestion.questions}
                  onSubmit={async (answers: HarnessQuestionAnswer[]) => {
                    await answerHarnessQuestion(pendingQuestion.rpcId, pendingQuestion.sessionId, answers);
                    setPendingQuestion(null);
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
                  {models && models.models.length > 0 && (
                    <div className="flex items-center gap-1.5 rounded-full border border-border px-2 py-0.5">
                      <Cpu className="h-3.5 w-3.5 text-muted-foreground" />
                      <select
                        value={activeModel ?? ""}
                        onChange={(e) => setActiveModel(e.target.value || null)}
                        className="bg-transparent text-xs text-muted-foreground outline-none cursor-pointer py-0.5 max-w-[180px]"
                      >
                        <option value="">System Default</option>
                        {(() => {
                          const groups = new Map<string, typeof models.models>();
                          for (const m of models.models) {
                            const key = m.provider;
                            if (!groups.has(key)) groups.set(key, []);
                            groups.get(key)!.push(m);
                          }
                          return [...groups.entries()].map(([providerId, items]) => (
                            <optgroup key={providerId} label={items[0].provider_name}>
                              {items.map((m) => (
                                <option key={`${providerId}:${m.id}`} value={`${providerId}:${m.id}`}>
                                  {m.name}
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
                  <div className="min-w-0 flex-1">
                    <button
                      type="button"
                      role="separator"
                      aria-label="Resize Chat input"
                      aria-orientation="horizontal"
                      aria-valuemin={MIN_CHAT_INPUT_HEIGHT}
                      aria-valuemax={Math.max(MIN_CHAT_INPUT_HEIGHT, Math.floor(window.innerHeight * 0.5))}
                      aria-valuenow={chatInputHeight}
                      className="group flex h-4 w-full touch-none cursor-row-resize items-center justify-center rounded-t-md text-muted-foreground/60 hover:bg-muted hover:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                      onPointerDown={handleChatInputResizeStart}
                      onKeyDown={handleChatInputResizeKeyDown}
                      title="Drag upward to enlarge the Chat input"
                    >
                      <GripHorizontal className="h-4 w-4 transition-transform group-hover:scale-110" />
                    </button>
                    <Textarea
                      ref={textareaRef}
                      value={input}
                      onChange={(e) => setInput(e.target.value)}
                      onKeyDown={handleKeyDown}
                      placeholder="Ask anything about your knowledge base..."
                      className="min-h-[44px] max-h-[50vh] resize-none overflow-auto rounded-t-none"
                      style={{ height: chatInputHeight }}
                      rows={1}
                    />
                  </div>
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
                      {selectedHistorySession.messages.map((message) => {
                        const messageSaveTargets = message.role === "assistant"
                          ? getMessageSaveTargets(message.metadata, message.content)
                          : [];
                        return (
                        <ChatMessage
                          key={message.id}
                          role={message.role as "user" | "assistant"}
                          content={message.content}
                          metadata={message.metadata}
                          saveTargets={messageSaveTargets}
                          onSaveTarget={message.role === "assistant" && messageSaveTargets.length > 0
                            ? (target) => handleSaveTarget(selectedHistorySession, message, target)
                            : undefined}
                          assetDraft={message.role === "assistant" ? getMessageAssetDraft(message.metadata) : undefined}
                        />
                        );
                      })}
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
