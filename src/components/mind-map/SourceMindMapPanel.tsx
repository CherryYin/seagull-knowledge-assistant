import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ArrowRight, BookOpen, FileText, GitBranch, Map as MapIcon, RefreshCw, Sparkles, StickyNote, X } from "lucide-react";
import { useLocation, useNavigate } from "react-router-dom";
import { MindMapCanvas, type MindMapCanvasNode } from "@/components/mind-map/MindMapCanvas";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { harnessChat } from "@/lib/api/harness";
import { notesApi } from "@/lib/api/notes";
import { buildAssetHandoffState } from "@/lib/asset-handoff";
import {
  mindMapsApi,
  type SourceMindMapGenerationContext,
  type SourceMindMapProposalValidate,
  type SourceMindMapProposalValidation,
} from "@/lib/api/mind-maps";
import type { Source } from "@/lib/api/sources";
import { ActionError } from "@/components/interaction/ActionError";
import { AgentRunStatus } from "@/components/interaction/AgentRunStatus";
import { ProposalActions } from "@/components/interaction/ProposalActions";

interface SourceMindMapPanelProps {
  source: Source;
  chunkCount: number;
}

const STATUS_LABELS = {
  manual: "Manual",
  generating: "Generating",
  ready: "Ready",
  stale: "Stale",
  failed: "Failed",
} as const;

const STALE_REASON_LABELS = {
  source_content_hash: "PDF content changed",
  chunk_count: "Extracted chunk count changed",
  chunk_revision: "Chunk extraction revision changed",
} as const;

const GENERATION_TIMEOUT_SECONDS = 180;
const LARGE_MAP_AUTO_COLLAPSE_THRESHOLD = 40;
const LARGE_MAP_AUTO_COLLAPSE_DEPTH = 2;

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function getDefaultCollapsedProposalIds(proposal: SourceMindMapProposalValidation): Set<string> {
  if (proposal.proposal.nodes.length <= LARGE_MAP_AUTO_COLLAPSE_THRESHOLD) return new Set();
  const nodesById = new Map(proposal.proposal.nodes.map((node) => [node.temp_id, node]));
  const parentIds = new Set(proposal.proposal.nodes.map((node) => node.parent_temp_id).filter((value): value is string => Boolean(value)));
  const depthById = new Map<string, number>();
  const getDepth = (nodeId: string): number => {
    const existing = depthById.get(nodeId);
    if (existing !== undefined) return existing;
    const node = nodesById.get(nodeId);
    const depth = !node?.parent_temp_id ? 0 : getDepth(node.parent_temp_id) + 1;
    depthById.set(nodeId, depth);
    return depth;
  };
  return new Set(
    proposal.proposal.nodes
      .filter((node) => getDepth(node.temp_id) === LARGE_MAP_AUTO_COLLAPSE_DEPTH && parentIds.has(node.temp_id))
      .map((node) => node.temp_id),
  );
}

function parseAgentProposal(value: string | undefined): SourceMindMapProposalValidate | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<SourceMindMapProposalValidate>;
    if (
      typeof parsed.source_id !== "string"
      || !parsed.basis_revision
      || typeof parsed.basis_revision !== "object"
      || !parsed.proposal
      || typeof parsed.proposal !== "object"
    ) return null;
    return parsed as SourceMindMapProposalValidate;
  } catch {
    return null;
  }
}

export function SourceMindMapPanel({ source, chunkCount }: SourceMindMapPanelProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(new Set());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [proposal, setProposal] = useState<SourceMindMapProposalValidation | null>(null);
  const [proposalPhase, setProposalPhase] = useState("Preparing bounded Source context…");
  const [proposalSessionId, setProposalSessionId] = useState<string | null>(null);
  const [savedMessage, setSavedMessage] = useState<string | null>(null);
  const [generationContext, setGenerationContext] = useState<SourceMindMapGenerationContext | null>(null);
  const [generationStartedAt, setGenerationStartedAt] = useState<number | null>(null);
  const [generationDurationSeconds, setGenerationDurationSeconds] = useState<number | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const generationAbortRef = useRef<AbortController | null>(null);
  const generationStopReasonRef = useRef<"cancelled" | "timeout" | null>(null);
  const mapsQuery = useQuery({
    queryKey: ["source-mind-maps", source.id],
    queryFn: () => mindMapsApi.list({
      ownerType: "source",
      ownerId: source.id,
      purpose: "document_overview",
      limit: 1,
    }),
  });
  const updateSavedSelection = (nodeId: string | null) => {
    setSelectedId(nodeId);
    const next = new URLSearchParams(location.search);
    if (nodeId) next.set("map_node", nodeId);
    else next.delete("map_node");
    navigate(
      { pathname: location.pathname, search: next.toString() ? `?${next.toString()}` : "" },
      { replace: true, state: location.state },
    );
  };
  const mindMap = mapsQuery.data?.items[0] ?? null;
  const stalenessQuery = useQuery({
    queryKey: ["mind-map-staleness", mindMap?.id],
    queryFn: () => mindMapsApi.checkStaleness(mindMap!.id),
    enabled: Boolean(mindMap?.id),
    refetchOnWindowFocus: false,
  });
  const displayedMap = stalenessQuery.data?.map ?? mindMap!;
  const treeQuery = useQuery({
    queryKey: ["mind-map-tree", mindMap?.id],
    queryFn: () => mindMapsApi.getTree(mindMap!.id),
    enabled: Boolean(mindMap?.id),
  });
  const createMutation = useMutation({
    mutationFn: () => mindMapsApi.create({
      owner_type: "source",
      owner_id: source.id,
      purpose: "document_overview",
      title: `${source.title} · Mind Map`,
      root_content: source.title,
      root_kind: "topic",
      layout_mode: "balanced",
      basis_revision: {
        source_content_hash: source.content_hash ?? null,
        source_ingested_at: source.ingested_at,
        chunk_count: chunkCount,
        chunk_revision: typeof source.metadata_?.chunk_revision === "number"
          ? source.metadata_.chunk_revision
          : null,
        captured_at: new Date().toISOString(),
      },
    }),
    onSuccess: async (tree) => {
      queryClient.setQueryData(["mind-map-tree", tree.map.id], tree);
      await queryClient.invalidateQueries({ queryKey: ["source-mind-maps", source.id] });
      navigate(`/mind-maps/${encodeURIComponent(tree.map.id)}`);
    },
  });
  const proposalMutation = useMutation({
    mutationFn: async (targetNodeId?: string) => {
      setProposal(null);
      setProposalSessionId(null);
      setSavedMessage(null);
      setGenerationContext(null);
      setGenerationDurationSeconds(null);
      setElapsedSeconds(0);
      const startedAt = Date.now();
      setGenerationStartedAt(startedAt);
      generationStopReasonRef.current = null;
      const controller = new AbortController();
      generationAbortRef.current = controller;
      const timeoutId = window.setTimeout(() => {
        generationStopReasonRef.current = "timeout";
        controller.abort();
      }, GENERATION_TIMEOUT_SECONDS * 1000);
      setProposalPhase("Preparing bounded Source context…");
      try {
        const context = await mindMapsApi.getSourceGenerationContext(source.id);
        setGenerationContext(context);
        const targetNode = targetNodeId
          ? treeQuery.data?.nodes.find((node) => node.id === targetNodeId)
          : null;
        if (targetNodeId && (!mindMap || !targetNode)) throw new Error("The selected branch is no longer available. Refresh the Mind Map and try again.");
        const expansionTarget = targetNode && mindMap ? {
          map_id: mindMap.id,
          base_version: mindMap.version,
          target_node_id: targetNode.id,
          content: targetNode.content,
          node_kind: targetNode.node_kind,
        } : null;
        const samplingLabel = context.sampling.strategy === "all_chunks"
          ? "all extracted Chunks"
          : `${context.sampling.sampled_chunk_count} evenly sampled Chunks from ${context.sampling.total_chunk_count}`;
        setProposalPhase(`Agent is reviewing ${samplingLabel} across ${context.sampling.section_count} document sections…`);
        let candidate: SourceMindMapProposalValidate | null = null;
        const prompt = [
          expansionTarget
            ? "Expand only the selected Source Mind Map branch from the bounded context below."
            : "Generate one PDF Source Mind Map proposal from the bounded context below.",
          "Preserve source_id and basis_revision exactly. Call propose_source_mind_map exactly once.",
          ...(expansionTarget ? [
            "Preserve expansion_target map_id, base_version, and target_node_id exactly in the Tool call.",
            "Use one topic root whose content exactly matches expansion_target.content. The root is an existing anchor: do not reference or rewrite it.",
            "Add only 4 to 10 useful descendants under that root. Do not rewrite unrelated branches, the Map title, or layout.",
          ] : []),
          "Each proposal node must use exactly: temp_id, parent_temp_id, position, content, optional note, and node_kind.",
          expansionTarget
            ? "Keep the complete branch Proposal between 5 and 12 nodes and never exceed 32."
            : "Target 18 to 28 nodes and never exceed 32. Keep only 2 to 3 high-value children per section.",
          "Do not emit analysis, Markdown, or a JSON draft before the tool call.",
          "Do not write or apply a Mind Map. Do not request the full PDF.",
          JSON.stringify(expansionTarget ? { ...context, expansion_target: expansionTarget } : context),
        ].join("\n\n");
        for await (const event of harnessChat(prompt, {
          preset: "generate-source-mind-map",
          ephemeralSession: true,
          clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          signal: controller.signal,
        })) {
          if (event.type === "session" && event.session_id) setProposalSessionId(event.session_id);
          if (event.type === "tool_call" && event.tool === "propose_source_mind_map") {
            setProposalPhase("Agent proposal received. Validating Source basis and Chunk references…");
          }
          if (event.type === "tool_result" && event.tool === "propose_source_mind_map") {
            if (event.error || event.result?.startsWith("Error:")) {
              throw new Error(event.result?.replace(/^Error:\s*/, "") || "Source Mind Map proposal tool failed.");
            }
            candidate = parseAgentProposal(event.result);
            if (!candidate) throw new Error("Agent returned an invalid Source Mind Map proposal contract.");
            if (expansionTarget && (
              candidate.map_id !== expansionTarget.map_id
              || candidate.base_version !== expansionTarget.base_version
              || candidate.target_node_id !== expansionTarget.target_node_id
            )) throw new Error("Agent returned a Branch Expansion Proposal for a different Map revision or target node.");
            break;
          }
          if (event.type === "question") {
            throw new Error("The Mind Map Agent requested extra input instead of using the bounded Source context.");
          }
          if (event.type === "error") throw new Error(event.content || "Mind Map Agent failed.");
        }
        if (!candidate) throw new Error("Agent finished without generating a Source Mind Map proposal.");
        setProposalPhase("Validating Source basis and Chunk references…");
        return await mindMapsApi.validateSourceProposal(candidate);
      } catch (error) {
        if (isAbortError(error)) {
          if (generationStopReasonRef.current === "timeout") {
            throw new Error(`Generation stopped after ${GENERATION_TIMEOUT_SECONDS} seconds. The bounded Agent run did not finish; retry without changing the saved Mind Map.`);
          }
          throw new Error("Generation cancelled. No Proposal was saved or applied.");
        }
        throw error;
      } finally {
        window.clearTimeout(timeoutId);
        setGenerationDurationSeconds(Math.max(1, Math.round((Date.now() - startedAt) / 1000)));
        generationAbortRef.current = null;
      }
    },
    onSuccess: (validated) => {
      setProposal(validated);
      setProposalPhase("Proposal validated. Review it before saving to the formal Mind Map.");
    },
  });
  useEffect(() => {
    if (!proposalMutation.isPending || generationStartedAt === null) return;
    const updateElapsed = () => setElapsedSeconds(Math.floor((Date.now() - generationStartedAt) / 1000));
    updateElapsed();
    const intervalId = window.setInterval(updateElapsed, 1000);
    return () => window.clearInterval(intervalId);
  }, [generationStartedAt, proposalMutation.isPending]);
  const applyProposalMutation = useMutation({
    mutationFn: async () => {
      if (!proposal) throw new Error("Generate and validate a Proposal before saving it.");
      return mindMapsApi.applySourceProposal({
        source_id: proposal.source_id,
        basis_revision: proposal.basis_revision,
        proposal: proposal.proposal,
        ...(proposal.target_node_id
          ? { map_id: proposal.map_id, base_version: proposal.base_version, target_node_id: proposal.target_node_id }
          : mindMap ? { map_id: mindMap.id, base_version: mindMap.version } : {}),
        session_id: proposalSessionId,
        confirm: true,
      });
    },
    onSuccess: async (tree) => {
      setProposal(null);
      setProposalSessionId(null);
      setSavedMessage(`Saved ${tree.nodes.length} nodes to Mind Map v${tree.map.version}.`);
      queryClient.setQueryData(["source-mind-maps", source.id], { items: [tree.map], total: 1 });
      queryClient.setQueryData(["mind-map-tree", tree.map.id], tree);
      queryClient.removeQueries({ queryKey: ["mind-map-staleness", tree.map.id] });
      await queryClient.invalidateQueries({ queryKey: ["source-mind-maps", source.id] });
    },
  });
  useEffect(() => {
    if (!proposal) return;
    setCollapsedIds(getDefaultCollapsedProposalIds(proposal));
    setSelectedId(null);
  }, [proposal]);
  const canvasNodes = useMemo<MindMapCanvasNode[]>(() => {
    const references = new Map<string, number>();
    for (const reference of treeQuery.data?.references ?? []) {
      references.set(reference.node_id, (references.get(reference.node_id) ?? 0) + 1);
    }
    return (treeQuery.data?.nodes ?? []).map((node) => ({
      id: node.id,
      parentId: node.parent_id,
      label: node.content,
      displayId: node.display_id,
      kind: node.node_kind,
      referenceCount: references.get(node.id) ?? 0,
    }));
  }, [treeQuery.data]);
  const proposalCanvasNodes = useMemo<MindMapCanvasNode[]>(() => {
    const referenceCounts = new Map<string, number>();
    for (const reference of proposal?.proposal.references ?? []) {
      referenceCounts.set(reference.node_temp_id, (referenceCounts.get(reference.node_temp_id) ?? 0) + 1);
    }
    return (proposal?.proposal.nodes ?? []).map((node, index) => ({
      id: node.temp_id,
      parentId: node.parent_temp_id,
      label: node.content,
      displayId: index + 1,
      kind: node.node_kind,
      referenceCount: referenceCounts.get(node.temp_id) ?? 0,
    }));
  }, [proposal]);
  const selectedNode = treeQuery.data?.nodes.find((node) => node.id === selectedId) ?? null;
  const selectedNodeReferences = (treeQuery.data?.references ?? []).filter((reference) => reference.node_id === selectedNode?.id);
  const selectedChunkIds = selectedNodeReferences
    .filter((reference) => reference.ref_type === "source_chunk")
    .map((reference) => reference.ref_id);
  useEffect(() => {
    const requestedNodeId = new URLSearchParams(location.search).get("map_node");
    if (!requestedNodeId || !treeQuery.data?.nodes.some((node) => node.id === requestedNodeId)) return;
    setSelectedId(requestedNodeId);
  }, [location.search, treeQuery.data?.nodes]);
  const selectedNodeContext = selectedNode
    ? `Mind Map node #${selectedNode.display_id}: ${selectedNode.content}${selectedChunkIds.length ? `\nReferenced Source Chunks: ${selectedChunkIds.join(", ")}` : ""}`
    : "";
  const createNodeNoteMutation = useMutation({
    mutationFn: async () => {
      if (!selectedNode) throw new Error("Select a Mind Map node first.");
      return notesApi.create({
        title: `${source.title} · ${selectedNode.content}`,
        category_id: source.category_id,
        note_type: "inbox",
        status: "seed",
        confidence: "medium",
        tags: ["from-source", "from-mind-map"],
        abstract: selectedNode.content.slice(0, 240),
        content: `# ${selectedNode.content}\n\n${selectedNode.note || "Develop this selected Source Mind Map idea."}\n\n## Provenance\n\n- Source: ${source.title} (${source.id})\n- Mind Map: ${mindMap?.id ?? "unknown"}\n- Node: ${selectedNode.id}${selectedChunkIds.length ? `\n- Source Chunks: ${selectedChunkIds.join(", ")}` : ""}`,
        source_ids: [source.id],
      });
    },
    onSuccess: (note) => {
      queryClient.invalidateQueries({ queryKey: ["notes"] });
      navigate(`/notes/${encodeURIComponent(note.id)}`);
    },
  });
  const canCreate = chunkCount > 0 && Boolean(source.raw_content?.trim());
  const proposalPanel = (
    <Card data-testid="source-mind-map-agent-proposal">
      <CardHeader className="flex-row items-start justify-between gap-4 space-y-0">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <CardTitle>{proposal?.target_node_id ? "Branch Expansion Proposal" : "Agent Proposal"}</CardTitle>
            <Badge variant={proposal ? "secondary" : "outline"}>{proposal ? "Validated" : "Not Applied"}</Badge>
          </div>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
            The Agent receives bounded section and Chunk summaries only. Nothing changes until you explicitly review and save the validated Proposal.
          </p>
        </div>
        {proposal && (
          <Button type="button" variant="ghost" size="icon" aria-label="Discard proposal" onClick={() => setProposal(null)}>
            <X className="h-4 w-4" />
          </Button>
        )}
      </CardHeader>
      <CardContent>
        {savedMessage && (
          <p className="mb-4 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-950">
            {savedMessage} You can now open the full Map and return without losing it.
          </p>
        )}
        {!proposal && (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-3">
              <Button
                type="button"
                disabled={!canCreate || proposalMutation.isPending}
                onClick={() => proposalMutation.mutate(undefined)}
              >
                {proposalMutation.isPending
                  ? <RefreshCw className="h-4 w-4 animate-spin" />
                  : <Sparkles className="h-4 w-4" />}
                {proposalMutation.isPending ? "Generating Proposal…" : "Generate Agent Proposal"}
              </Button>
              {mindMap && selectedId && (
                <Button
                  type="button"
                  variant="outline"
                  disabled={!canCreate || proposalMutation.isPending}
                  onClick={() => proposalMutation.mutate(selectedId)}
                >
                  <GitBranch className="h-4 w-4" />Expand Selected Branch
                </Button>
              )}
              {proposalMutation.isPending && (
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    generationStopReasonRef.current = "cancelled";
                    generationAbortRef.current?.abort();
                  }}
                >
                  <X className="h-4 w-4" />Cancel Generation
                </Button>
              )}
            </div>
            {proposalMutation.isPending && <AgentRunStatus status={generationContext ? "running" : "preparing"} message={proposalPhase} />}
            {(proposalMutation.isPending || generationContext) && (
              <div className="flex flex-wrap gap-2" data-testid="source-mind-map-generation-metrics">
                <Badge variant="secondary">{generationContext?.sampling.total_chunk_count ?? chunkCount} source chunks</Badge>
                <Badge variant="secondary">{generationContext?.sampling.sampled_chunk_count ?? "…"} Agent input chunks</Badge>
                {generationContext && <Badge variant="outline">{generationContext.sampling.coverage_percent}% coverage</Badge>}
                {generationContext && <Badge variant="outline">{generationContext.sampling.section_count} sections</Badge>}
                <Badge variant="outline">{proposalMutation.isPending ? elapsedSeconds : generationDurationSeconds ?? 0}s elapsed</Badge>
                <Badge variant="outline">{GENERATION_TIMEOUT_SECONDS}s timeout</Badge>
              </div>
            )}
            {generationContext?.sampling.strategy === "evenly_spaced" && (
              <p className="text-xs text-muted-foreground">
                Large PDF protection is active: {generationContext.sampling.sampled_chunk_count} evenly distributed Chunks are used and {generationContext.sampling.omitted_chunk_count} are omitted from this overview run.
              </p>
            )}
          </div>
        )}
        {proposalMutation.isError && <div className="mt-3"><ActionError title="Mind Map proposal failed" impact="No proposal was applied to the saved Mind Map." recovery="Retry generation; the current Mind Map is unchanged." details={proposalMutation.error.message} onRetry={() => proposalMutation.mutate(undefined)} /></div>}
        {proposal && (
          <div className="space-y-4">
            <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
              <Badge variant="secondary">{proposal.node_count} nodes</Badge>
              <Badge variant="secondary">{proposal.reference_count} Chunk references</Badge>
              {generationContext && <Badge variant="outline">{generationContext.sampling.sampled_chunk_count}/{generationContext.sampling.total_chunk_count} Chunks sampled</Badge>}
              {generationDurationSeconds !== null && <Badge variant="outline">{generationDurationSeconds}s generation</Badge>}
              <span>{proposalPhase}</span>
            </div>
            {proposal.node_count > LARGE_MAP_AUTO_COLLAPSE_THRESHOLD && (
              <p className="rounded-lg border border-blue-500/20 bg-blue-500/5 px-4 py-3 text-sm text-muted-foreground" data-testid="source-mind-map-auto-collapse-notice">
                Large Map protection is active. Branches with children are folded at depth {LARGE_MAP_AUTO_COLLAPSE_DEPTH}; expand only the areas you want to inspect.
              </p>
            )}
            <MindMapCanvas
              nodes={proposalCanvasNodes}
              layoutMode={proposal.proposal.layout_mode}
              collapsedIds={collapsedIds}
              focusId={null}
              selectedId={selectedId}
              onSelectedIdChange={setSelectedId}
              onCollapsedIdsChange={setCollapsedIds}
              className="h-[520px] rounded-xl border"
              testId="source-mind-map-proposal-preview"
              showMiniMap={proposalCanvasNodes.length > 12}
            />
            <AgentRunStatus status="completed" message="The proposal passed validation and remains separate from the saved Mind Map until you apply it." />
            <ProposalActions
              primaryLabel="Apply Proposal to Mind Map"
              pendingLabel="Applying…"
              primaryPending={applyProposalMutation.isPending}
              onPrimary={() => {
                  const action = proposal.target_node_id
                    ? `Expand the selected branch in Mind Map v${proposal.base_version}? Existing nodes and unrelated branches will be preserved.`
                    : mindMap
                    ? `Merge this Proposal into Mind Map v${mindMap.version}? Existing nodes will be preserved.`
                    : "Create a formal Mind Map from this Proposal?";
                  if (window.confirm(action)) applyProposalMutation.mutate();
              }}
              onRegenerate={() => proposalMutation.mutate(proposal.target_node_id ?? undefined)}
              regenerateDisabled={proposalMutation.isPending}
              onDiscard={() => {
                setProposal(null);
                proposalMutation.reset();
              }}
              note="Safe Merge never deletes existing human nodes."
            />
            {applyProposalMutation.isError && <ActionError title="Mind Map proposal could not be applied" impact="The saved Mind Map was not changed." recovery="Refresh the Map basis or regenerate the proposal, then apply again." details={applyProposalMutation.error.message} />}
          </div>
        )}
      </CardContent>
    </Card>
  );

  if (mapsQuery.isLoading) {
    return <div className="rounded-xl border p-8 text-center text-sm text-muted-foreground">Loading Mind Map status…</div>;
  }
  if (mapsQuery.isError) {
    return (
      <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-6 text-sm">
        <p className="font-medium text-destructive">Could not load this Source Mind Map.</p>
        <Button className="mt-3" type="button" variant="outline" size="sm" onClick={() => mapsQuery.refetch()}>
          <RefreshCw className="h-4 w-4" />Try again
        </Button>
      </div>
    );
  }

  if (!mindMap) {
    return (
      <div className="space-y-4">
        {proposalPanel}
        <Card data-testid="source-mind-map-empty">
          <CardContent className="flex min-h-[420px] flex-col items-center justify-center p-8 text-center">
            <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/10"><MapIcon className="h-7 w-7 text-primary" /></div>
            <Badge className="mt-4" variant="outline">Not Generated</Badge>
            <h2 className="mt-3 text-xl font-semibold">Create a document overview map</h2>
            <p className="mt-2 max-w-xl text-sm leading-6 text-muted-foreground">
              Create a revision-tracked root Map manually, or review the separate Agent Proposal above. Neither path overwrites Source content.
            </p>
            <div className="mt-4 flex flex-wrap justify-center gap-2 text-xs text-muted-foreground">
              <Badge variant="secondary">{chunkCount} chunks</Badge>
              <Badge variant="secondary">Content hash {source.content_hash ? "available" : "unavailable"}</Badge>
            </div>
            {!canCreate && (
              <p className="mt-4 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-900">
                Text extraction must finish and produce at least one chunk before a Mind Map can be created.
              </p>
            )}
            {createMutation.isError && <p className="mt-4 text-sm text-destructive">{createMutation.error.message}</p>}
            <Button className="mt-5" type="button" disabled={!canCreate || createMutation.isPending} onClick={() => createMutation.mutate()}>
              <GitBranch className="h-4 w-4" />{createMutation.isPending ? "Creating…" : "Create Starter Map"}
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-4" data-testid="source-mind-map-ready">
      <Card>
        <CardHeader className="flex-row items-start justify-between gap-4 space-y-0">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <CardTitle>{displayedMap.title}</CardTitle>
              <Badge
                variant={displayedMap.generation_status === "stale" || displayedMap.generation_status === "failed" ? "outline" : "secondary"}
                className={displayedMap.generation_status === "stale" || displayedMap.generation_status === "failed" ? "border-destructive/40 text-destructive" : undefined}
              >
                {STATUS_LABELS[displayedMap.generation_status]}
              </Badge>
              <Badge variant="outline">v{displayedMap.version}</Badge>
            </div>
            <p className="mt-2 text-sm text-muted-foreground">
              Based on {String(displayedMap.basis_revision.chunk_count ?? chunkCount)} chunks · Updated {new Date(displayedMap.updated_at).toLocaleString()}
            </p>
          </div>
          <Button type="button" onClick={() => navigate(
            `/mind-maps/${encodeURIComponent(mindMap.id)}${selectedId ? `?selected=${encodeURIComponent(selectedId)}` : ""}`,
            {
              state: {
                backTo: `${location.pathname}${location.search}`,
                backLabel: "Back to Source",
              },
            },
          )}>
            Open Full Map<ArrowRight className="h-4 w-4" />
          </Button>
        </CardHeader>
      </Card>
      {proposalPanel}
      {stalenessQuery.isError && (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-950">
          Could not verify whether the Source changed. The existing Mind Map is still available.
        </div>
      )}
      {stalenessQuery.data?.stale && (
        <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-4 text-sm text-amber-950" data-testid="source-mind-map-stale-warning">
          <div className="flex items-start gap-3">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" />
            <div>
              <p className="font-medium">This PDF changed after the Mind Map basis was captured.</p>
              <p className="mt-1 text-amber-900/80">Your current Map and edits were preserved. Review it before choosing to regenerate.</p>
              {stalenessQuery.data.reasons.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-2">
                  {stalenessQuery.data.reasons.map((reason) => (
                    <Badge key={reason} variant="outline" className="border-amber-600/40 text-amber-950">
                      {STALE_REASON_LABELS[reason]}
                    </Badge>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
      {treeQuery.isLoading && <div className="rounded-xl border p-8 text-center text-sm text-muted-foreground">Loading map preview…</div>}
      {treeQuery.isError && <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-5 text-sm text-destructive">Could not load the map preview.</div>}
      {treeQuery.data && (
        <Card className="overflow-hidden">
          <CardContent className="p-0">
            <MindMapCanvas
              nodes={canvasNodes}
              layoutMode={displayedMap.layout_mode}
              collapsedIds={collapsedIds}
              focusId={null}
              selectedId={selectedId}
              onSelectedIdChange={updateSavedSelection}
              onCollapsedIdsChange={setCollapsedIds}
              className="h-[520px]"
              testId="source-mind-map-preview"
              showMiniMap={canvasNodes.length > 12}
            />
            {selectedNode && !proposal && (
              <div className="border-t bg-muted/20 p-4" data-testid="source-mind-map-node-handoff">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="text-sm font-medium">Selected: #{selectedNode.display_id} {selectedNode.content}</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {selectedChunkIds.length ? `${selectedChunkIds.length} Source Chunk reference${selectedChunkIds.length === 1 ? "" : "s"}` : "No direct Chunk reference; the Source remains attached as provenance."}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => navigate("/assets/new", {
                        state: {
                          assetHandoff: buildAssetHandoffState({
                            title: selectedNode.content,
                            brief: `Develop an Asset from this selected Source Mind Map node.\n\n${selectedNodeContext}`,
                            source_refs: [source.id],
                          }),
                        },
                      })}
                    >
                      <FileText className="h-4 w-4" />Create Asset from This Branch
                    </Button>
                    <Button type="button" size="sm" variant="outline" disabled={createNodeNoteMutation.isPending} onClick={() => createNodeNoteMutation.mutate()}>
                      <StickyNote className="h-4 w-4" />{createNodeNoteMutation.isPending ? "Creating…" : "Create Note"}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => navigate("/chat", {
                        state: {
                          objectRef: { object_type: "source", object_id: source.id, title: source.title, url: source.url ?? null },
                          workflowId: "draft-wiki-refresh",
                          promptSeed: `Create a reviewable canonical Wiki Draft from this selected Source Mind Map node. Preserve Source and Chunk provenance.\n\n${selectedNodeContext}`,
                          backTo: `${location.pathname}${location.search}`,
                          backLabel: "Back to Source Mind Map",
                        },
                      })}
                    >
                      <BookOpen className="h-4 w-4" />Draft Wiki
                    </Button>
                  </div>
                </div>
                {createNodeNoteMutation.isError && <p className="mt-3 text-sm text-destructive">{createNodeNoteMutation.error.message}</p>}
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
