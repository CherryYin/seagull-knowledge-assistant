import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ArrowRight, GitBranch, Map as MapIcon, RefreshCw, Sparkles, X } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { MindMapCanvas, type MindMapCanvasNode } from "@/components/mind-map/MindMapCanvas";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { harnessChat } from "@/lib/api/harness";
import {
  mindMapsApi,
  type SourceMindMapProposalValidate,
  type SourceMindMapProposalValidation,
} from "@/lib/api/mind-maps";
import type { Source } from "@/lib/api/sources";

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
  const queryClient = useQueryClient();
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(new Set());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [proposal, setProposal] = useState<SourceMindMapProposalValidation | null>(null);
  const [proposalPhase, setProposalPhase] = useState("Preparing bounded Source context…");
  const [proposalSessionId, setProposalSessionId] = useState<string | null>(null);
  const [savedMessage, setSavedMessage] = useState<string | null>(null);
  const mapsQuery = useQuery({
    queryKey: ["source-mind-maps", source.id],
    queryFn: () => mindMapsApi.list({
      ownerType: "source",
      ownerId: source.id,
      purpose: "document_overview",
      limit: 1,
    }),
  });
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
    mutationFn: async () => {
      setProposal(null);
      setProposalSessionId(null);
      setSavedMessage(null);
      setProposalPhase("Preparing bounded Source context…");
      const context = await mindMapsApi.getSourceGenerationContext(source.id);
      setProposalPhase(`Agent is reviewing ${context.input_summary.chunk_summaries.length} bounded Chunk summaries…`);
      let candidate: SourceMindMapProposalValidate | null = null;
      const prompt = [
        "Generate one PDF Source Mind Map proposal from the bounded context below.",
        "Preserve source_id and basis_revision exactly. Call propose_source_mind_map exactly once.",
        "Each proposal node must use exactly: temp_id, parent_temp_id, position, content, optional note, and node_kind.",
        "Do not write or apply a Mind Map. Do not request the full PDF.",
        JSON.stringify(context),
      ].join("\n\n");
      for await (const event of harnessChat(prompt, {
        preset: "generate-source-mind-map",
        ephemeralSession: true,
        clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
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
        }
        if (event.type === "question") {
          throw new Error("The Mind Map Agent requested extra input instead of using the bounded Source context.");
        }
        if (event.type === "error") throw new Error(event.content || "Mind Map Agent failed.");
      }
      if (!candidate) throw new Error("Agent finished without generating a Source Mind Map proposal.");
      setProposalPhase("Validating Source basis and Chunk references…");
      return mindMapsApi.validateSourceProposal(candidate);
    },
    onSuccess: (validated) => {
      setProposal(validated);
      setProposalPhase("Proposal validated. Review it before saving to the formal Mind Map.");
    },
  });
  const applyProposalMutation = useMutation({
    mutationFn: async () => {
      if (!proposal) throw new Error("Generate and validate a Proposal before saving it.");
      return mindMapsApi.applySourceProposal({
        source_id: proposal.source_id,
        basis_revision: proposal.basis_revision,
        proposal: proposal.proposal,
        ...(mindMap ? { map_id: mindMap.id, base_version: mindMap.version } : {}),
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
  const canCreate = chunkCount > 0 && Boolean(source.raw_content?.trim());
  const proposalPanel = (
    <Card data-testid="source-mind-map-agent-proposal">
      <CardHeader className="flex-row items-start justify-between gap-4 space-y-0">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <CardTitle>Agent Proposal</CardTitle>
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
          <div className="flex flex-wrap items-center gap-3">
            <Button
              type="button"
              disabled={!canCreate || proposalMutation.isPending}
              onClick={() => proposalMutation.mutate()}
            >
              {proposalMutation.isPending
                ? <RefreshCw className="h-4 w-4 animate-spin" />
                : <Sparkles className="h-4 w-4" />}
              {proposalMutation.isPending ? "Generating Proposal…" : "Generate Agent Proposal"}
            </Button>
            {proposalMutation.isPending && <p className="text-sm text-muted-foreground">{proposalPhase}</p>}
          </div>
        )}
        {proposalMutation.isError && (
          <div className="mt-3 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
            <p>{proposalMutation.error.message}</p>
            <Button className="mt-3" type="button" variant="outline" size="sm" onClick={() => proposalMutation.mutate()}>
              <RefreshCw className="h-4 w-4" />Try Again
            </Button>
          </div>
        )}
        {proposal && (
          <div className="space-y-4">
            <div className="flex flex-wrap gap-2 text-xs text-muted-foreground">
              <Badge variant="secondary">{proposal.node_count} nodes</Badge>
              <Badge variant="secondary">{proposal.reference_count} Chunk references</Badge>
              <span>{proposalPhase}</span>
            </div>
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
            <p className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-950">
              Validation passed. This proposal is still separate from the saved Mind Map and has not been applied.
            </p>
            <div className="flex flex-wrap items-center gap-3">
              <Button
                type="button"
                disabled={applyProposalMutation.isPending}
                onClick={() => {
                  const action = mindMap
                    ? `Merge this Proposal into Mind Map v${mindMap.version}? Existing nodes will be preserved.`
                    : "Create a formal Mind Map from this Proposal?";
                  if (window.confirm(action)) applyProposalMutation.mutate();
                }}
              >
                {applyProposalMutation.isPending
                  ? <RefreshCw className="h-4 w-4 animate-spin" />
                  : <GitBranch className="h-4 w-4" />}
                {applyProposalMutation.isPending ? "Saving…" : "Review & Save to Mind Map"}
              </Button>
              <p className="text-xs text-muted-foreground">Safe Merge never deletes existing human nodes.</p>
            </div>
            {applyProposalMutation.isError && (
              <p className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
                {applyProposalMutation.error.message}
              </p>
            )}
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
          <Button type="button" onClick={() => navigate(`/mind-maps/${encodeURIComponent(mindMap.id)}`)}>
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
              onSelectedIdChange={setSelectedId}
              onCollapsedIdsChange={setCollapsedIds}
              className="h-[520px]"
              testId="source-mind-map-preview"
              showMiniMap={canvasNodes.length > 12}
            />
          </CardContent>
        </Card>
      )}
    </div>
  );
}
