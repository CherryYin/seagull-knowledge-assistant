import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { Archive, Brain, Bot, ChevronRight, FileText, GitMerge, RotateCcw, ScrollText, Search, Sparkles, XCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { memoryApi, wikiApi, type MemoryNode } from "@/lib/api";
import { getMemoryFamily, getMemoryRole } from "@/lib/memoryRole";
import {
  getMemoryLastUsedAction,
  getMemoryLastUsedAt,
  getMemoryMergedFrom,
  getMemoryMergedInto,
  getMemoryStatus,
  getMemoryStatusLabel,
  getMemoryUsageCount,
  isMemoryStale,
} from "@/lib/memoryStatus";
import { ModuleSectionNav } from "@/components/SectionNav";
import { buildAssetHandoffState } from "@/lib/asset-handoff";

const PAGE_SIZE = 25;
const MEMORY_TYPES = ["", "topic", "source", "global"] as const;
type MemoryStatus = "" | "active" | "archived" | "pending_review" | "rejected" | "merged";

function formatNodeKind(node: MemoryNode) {
  if (node.node_type === "topic") return "Topic";
  if (node.node_type === "source") return "Source-derived";
  if (node.node_type === "global") return "Global";
  return node.node_type;
}

export function MemoryTreePage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [query, setQuery] = useState(searchParams.get("q") || "");
  const [status, setStatus] = useState<MemoryStatus>((searchParams.get("status") as MemoryStatus) || "active");
  const [nodeType, setNodeType] = useState((searchParams.get("type") as (typeof MEMORY_TYPES)[number]) || "");
  const [page, setPage] = useState(Math.max(1, Number(searchParams.get("page") || 1)));
  const [selectedId, setSelectedId] = useState<string | null>(searchParams.get("node"));
  const [expandedIds, setExpandedIds] = useState<Record<string, boolean>>(() => {
    const expanded = searchParams.get("expanded");
    if (!expanded) return {};
    return expanded
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
      .reduce<Record<string, boolean>>((acc, id) => {
        acc[id] = true;
        return acc;
      }, {});
  });

  const { data: selectedPath } = useQuery({
    queryKey: ["memory-path", selectedId],
    queryFn: () => memoryApi.path(selectedId!),
    enabled: !!selectedId,
  });
  const { data: selectedChildren } = useQuery({
    queryKey: ["memory-children", "selected", selectedId],
    queryFn: () => memoryApi.children(selectedId!),
    enabled: !!selectedId,
  });

  const params = useMemo(() => ({
    q: query.trim() || undefined,
    status: status || undefined,
    node_type: nodeType || undefined,
    limit: PAGE_SIZE,
    offset: (page - 1) * PAGE_SIZE,
  }), [query, status, nodeType, page]);

  const { data, isLoading, error } = useQuery({
    queryKey: ["memory-roots", params],
    queryFn: () => memoryApi.roots(params),
  });

  const nodes = data?.items ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const [selectedNode, setSelectedNode] = useState<MemoryNode | null>(null);

  const updateMutation = useMutation({
    mutationFn: ({ id, body }: { id: string; body: { status: "active" | "archived" | "rejected" | "merged" } }) => memoryApi.update(id, body),
    onSuccess: (node) => {
      queryClient.invalidateQueries({ queryKey: ["memory-nodes"] });
      setSelectedId(node.id);
    },
  });

  const mergeMutation = useMutation({
    mutationFn: ({ id, targetNodeId }: { id: string; targetNodeId: string }) => memoryApi.merge(id, { target_node_id: targetNodeId, archive_source: true }),
    onSuccess: (node) => {
      queryClient.invalidateQueries({ queryKey: ["memory-nodes"] });
      setSelectedId(node.id);
    },
  });

  const createWikiDraftMutation = useMutation({
    mutationFn: ({ id, title }: { id: string; title: string }) =>
      wikiApi.createFromMemory({ memory_node_id: id, title, page_type: "topic" }),
    onSuccess: (page) => {
      queryClient.invalidateQueries({ queryKey: ["wiki-pages"] });
      navigate(`/wiki/${encodeURIComponent(page.id)}`, {
        state: { backTo: "/memory", backLabel: "Back to Knowledge Tree" },
      });
    },
  });

  const applyFilters = () => {
    const next = new URLSearchParams();
    if (query.trim()) next.set("q", query.trim());
    if (status && status !== "active") next.set("status", status);
    if (nodeType) next.set("type", nodeType);
    if (page > 1) next.set("page", String(page));
    if (selectedId) next.set("node", selectedId);
    const expanded = Object.keys(expandedIds).filter((id) => expandedIds[id]);
    if (expanded.length) next.set("expanded", expanded.join(","));
    setSearchParams(next, { replace: true });
  };

  const changeStatus = (value: MemoryStatus) => {
    setStatus(value);
    setPage(1);
    const next = new URLSearchParams(searchParams);
    if (value && value !== "active") next.set("status", value);
    else next.delete("status");
    next.delete("page");
    setSearchParams(next, { replace: true });
  };

  const changeType = (value: (typeof MEMORY_TYPES)[number]) => {
    setNodeType(value);
    setPage(1);
    const next = new URLSearchParams(searchParams);
    if (value) next.set("type", value);
    else next.delete("type");
    next.delete("page");
    setSearchParams(next, { replace: true });
  };

  const toggleExpanded = (id: string) => {
    setExpandedIds((current) => {
      const next = { ...current, [id]: !current[id] };
      const params = new URLSearchParams(searchParams);
      const expanded = Object.keys(next).filter((itemId) => next[itemId]);
      if (expanded.length) params.set("expanded", expanded.join(","));
      else params.delete("expanded");
      setSearchParams(params, { replace: true });
      return next;
    });
  };

  const handleSelectNode = (node: MemoryNode) => {
    setSelectedId(node.id);
    setSelectedNode(node);
    const params = new URLSearchParams(searchParams);
    params.set("node", node.id);
    setSearchParams(params, { replace: true });
  };

  const parentNode = selectedPath && selectedPath.items.length > 1
    ? selectedPath.items[selectedPath.items.length - 2]
    : null;
  const childNodes = selectedChildren?.items ?? [];
  const relatedNodes = nodes
    .filter((node) => node.id !== selectedNode?.id)
    .filter((node) => {
      if (!selectedNode) return false;
      const sharedSource = node.derived_from_sources.some((sourceId) => selectedNode.derived_from_sources.includes(sourceId));
      const sharedNote = node.derived_from_notes.some((noteId) => selectedNode.derived_from_notes.includes(noteId));
      return sharedSource || sharedNote;
    })
    .slice(0, 5);

  useEffect(() => {
    if (!selectedPath?.items?.length) return;
    setExpandedIds((current) => {
      const next = { ...current };
      for (const item of selectedPath.items) next[item.id] = true;
      return next;
    });
  }, [selectedPath]);

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-7xl space-y-6 px-6 py-8">
		<ModuleSectionNav parent="knowledge" active="Knowledge Tree" />

        <section className="rounded-3xl border bg-card p-6 shadow-sm">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
            <div>
	          <div className="flex items-center gap-2 text-sm text-muted-foreground"><Brain className="h-4 w-4" /> Knowledge Tree</div>
	          <h1 className="mt-1 text-2xl font-semibold tracking-tight">Knowledge Tree</h1>
				<p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
					Browse topic nodes, inspect a short summary, then decide whether to turn them into wiki drafts, assets, or follow-up review.
				</p>
            </div>
            <form className="flex w-full flex-col gap-2 lg:w-[520px]" onSubmit={(event) => { event.preventDefault(); applyFilters(); }}>
              <div className="flex gap-2">
                <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search topics, summaries, or evidence..." />
                <Button type="submit" variant="outline"><Search className="h-4 w-4" /> Search</Button>
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                <select className="h-10 rounded-md border border-input bg-background px-3 text-sm" value={status} onChange={(event) => changeStatus(event.target.value as MemoryStatus)}>
                  <option value="">Any status</option>
                  <option value="active">Active</option>
                  <option value="pending_review">Pending review</option>
                  <option value="archived">Archived</option>
                  <option value="rejected">Rejected</option>
                  <option value="merged">Merged</option>
                </select>
                <select className="h-10 rounded-md border border-input bg-background px-3 text-sm" value={nodeType} onChange={(event) => changeType(event.target.value as (typeof MEMORY_TYPES)[number])}>
                  <option value="">All types</option>
                  <option value="topic">Topic</option>
                  <option value="source">Source</option>
                  <option value="global">Global</option>
                </select>
              </div>
            </form>
          </div>
        </section>

        {error instanceof Error && <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">{error.message}</div>}

        <div className="grid gap-4 lg:grid-cols-[420px_minmax(0,1fr)]">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center justify-between text-base">
				<span>Knowledge Tree Nodes</span>
                <Badge variant="outline">{isLoading ? "..." : total}</Badge>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {isLoading && <p className="text-sm text-muted-foreground">Loading...</p>}
              {!isLoading && !nodes.length && <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">No knowledge tree nodes found.</p>}
              <div className="space-y-2">
                {nodes.map((node) => (
                  <MemoryTreeItem
                    key={node.id}
                    node={node}
                    expandedIds={expandedIds}
                    activeId={selectedNode?.id ?? selectedId ?? null}
                    depth={0}
                    onToggle={toggleExpanded}
                    onSelect={handleSelectNode}
                  />
                ))}
              </div>
              {totalPages > 1 && (
                <div className="flex items-center justify-between pt-2 text-xs text-muted-foreground">
                  <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))}>Previous</Button>
                  <span>Page {page} / {totalPages}</span>
                  <Button variant="outline" size="sm" disabled={page >= totalPages} onClick={() => setPage((value) => value + 1)}>Next</Button>
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center justify-between gap-3 text-base">
				<span>{selectedNode?.title || "Knowledge Tree Detail"}</span>
                {selectedNode && <StatusBadge node={selectedNode} />}
              </CardTitle>
              {selectedPath?.items?.length ? (
                <p className="text-xs text-muted-foreground">
                  {selectedPath.items.map((item) => item.title).join(" / ")}
                </p>
              ) : null}
            </CardHeader>
            <CardContent>
              {!selectedNode ? (
				<p className="text-sm text-muted-foreground">Select a knowledge tree node to inspect details.</p>
              ) : (
                <MemoryDetail
                  node={selectedNode}
                  parentNode={parentNode}
                  childNodes={childNodes}
                  relatedNodes={relatedNodes}
                  isUpdating={updateMutation.isPending || mergeMutation.isPending}
                  candidates={nodes.filter((node) => node.id !== selectedNode.id && String(node.metadata_?.status || "active") === "active")}
                  onArchive={() => updateMutation.mutate({ id: selectedNode.id, body: { status: "archived" } })}
                  onRestore={() => updateMutation.mutate({ id: selectedNode.id, body: { status: "active" } })}
                  onReject={() => updateMutation.mutate({ id: selectedNode.id, body: { status: "rejected" } })}
                  onCreateWikiDraft={() => createWikiDraftMutation.mutate({ id: selectedNode.id, title: selectedNode.title })}
                  onAskAgent={() =>
                    navigate("/chat", {
                      state: {
                        objectRef: {
                          object_type: "memory",
                          object_id: selectedNode.id,
                          title: selectedNode.title,
                        },
                        workflowId: "draft-wiki-refresh",
                        promptSeed: `Use knowledge tree node "${selectedNode.title}" (${selectedNode.id}) to help me understand it, connect it to related knowledge, and decide whether it should become a wiki draft, asset, or refined knowledge-tree node.`,
                      },
                    })
                  }
                  onCreateAsset={() =>
                    navigate("/assets", {
                      state: {
                        assetHandoff: buildAssetHandoffState({
                          title: selectedNode.title,
                          brief: `Create a blog asset from knowledge tree node: ${selectedNode.title}`,
                          source_refs: selectedNode.derived_from_sources || [],
                          note_refs: selectedNode.derived_from_notes || [],
                        }),
                      },
                    })
                  }
                  onCreateBrief={() =>
                    navigate("/assets", {
                      state: {
                        assetHandoff: buildAssetHandoffState({
                          title: `${selectedNode.title} Brief`,
                          brief: `Create a research brief from knowledge tree node: ${selectedNode.title}`,
                          asset_type: "research_brief",
                          source_refs: selectedNode.derived_from_sources || [],
                          note_refs: selectedNode.derived_from_notes || [],
                        }),
                      },
                    })
                  }
                  onCreatePack={() =>
                    navigate("/assets", {
                      state: {
                        assetHandoff: buildAssetHandoffState({
                          title: `${selectedNode.title} Pack`,
                          brief: `Create a knowledge pack from knowledge tree node: ${selectedNode.title}`,
                          asset_type: "knowledge_pack",
                          source_refs: selectedNode.derived_from_sources || [],
                          note_refs: selectedNode.derived_from_notes || [],
                        }),
                      },
                    })
                  }
                  onCreateNewsletter={() =>
                    navigate("/assets", {
                      state: {
                        assetHandoff: buildAssetHandoffState({
                          title: `${selectedNode.title} Issue`,
                          brief: `Create a newsletter issue from knowledge tree node: ${selectedNode.title}`,
                          asset_type: "newsletter_issue",
                          source_refs: selectedNode.derived_from_sources || [],
                          note_refs: selectedNode.derived_from_notes || [],
                        }),
                      },
                    })
                  }
                  onCreateReport={() =>
                    navigate("/assets", {
                      state: {
                        assetHandoff: buildAssetHandoffState({
                          title: `${selectedNode.title} Report`,
                          brief: `Create a topic report from knowledge tree node: ${selectedNode.title}`,
                          asset_type: "topic_report",
                          source_refs: selectedNode.derived_from_sources || [],
                          note_refs: selectedNode.derived_from_notes || [],
                        }),
                      },
                    })
                  }
                  onMerge={(targetNodeId) => mergeMutation.mutate({ id: selectedNode.id, targetNodeId })}
                  onJumpToNode={handleSelectNode}
                />
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

function MemoryTreeItem({
  node,
  expandedIds,
  activeId,
  depth,
  onToggle,
  onSelect,
}: {
  node: MemoryNode;
  expandedIds: Record<string, boolean>;
  activeId: string | null;
  depth: number;
  onToggle: (id: string) => void;
  onSelect: (node: MemoryNode) => void;
}) {
  const expanded = expandedIds[node.id] ?? depth < 1;
  const active = activeId === node.id;
  const { data: childData, isLoading: isChildrenLoading } = useQuery({
    queryKey: ["memory-children", node.id],
    queryFn: () => memoryApi.children(node.id),
    enabled: expanded && node.child_node_ids.length > 0,
  });
  const children = childData?.items ?? [];
  const isOnActivePath = !!activeId && (activeId === node.id || children.some((child) => child.id === activeId));

  return (
    <div className="space-y-2">
      <div
        className={`relative w-full rounded-lg border p-3 text-left transition-colors ${
          active
            ? "border-primary bg-primary/10 shadow-sm"
            : isOnActivePath
              ? "border-primary/40 bg-primary/5"
              : "hover:border-primary/30"
        }`}
        style={{ marginLeft: depth * 12 }}
      >
        {depth > 0 && <div className="absolute -left-3 top-0 h-full w-px bg-border" />}
        <div className="flex items-start gap-2">
          <button
            type="button"
            className="mt-0.5 rounded p-1 text-muted-foreground hover:bg-accent"
            onClick={() => node.child_node_ids.length > 0 && onToggle(node.id)}
            aria-label={expanded ? "Collapse node" : "Expand node"}
          >
            <ChevronRight className={`h-4 w-4 transition-transform ${expanded ? "rotate-90" : ""} ${node.child_node_ids.length === 0 ? "opacity-30" : ""}`} />
          </button>
          <button type="button" className="min-w-0 flex-1 text-left" onClick={() => onSelect(node)}>
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className={`line-clamp-1 text-sm font-medium ${active ? "text-primary" : ""}`}>{node.title}</p>
                <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{node.summary || node.content}</p>
              </div>
              <StatusBadge node={node} />
            </div>
            <div className="mt-2 flex flex-wrap gap-2">
              <Badge variant="outline">{formatNodeKind(node)}</Badge>
              {node.child_node_ids.length > 0 && <Badge variant="secondary">{node.child_node_ids.length} children</Badge>}
            </div>
          </button>
        </div>
      </div>

      {expanded && isChildrenLoading && node.child_node_ids.length > 0 && (
        <div className="pl-10 text-xs text-muted-foreground" style={{ marginLeft: depth * 12 }}>
          Loading children...
        </div>
      )}

      {expanded && children.length > 0 && (
        <div className="space-y-2">
          {children.map((child) => (
            <MemoryTreeItem
              key={child.id}
              node={child}
              expandedIds={expandedIds}
              activeId={activeId}
              depth={depth + 1}
              onToggle={onToggle}
              onSelect={onSelect}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function MemoryDetail({
  node,
  parentNode,
  childNodes,
  relatedNodes,
  isUpdating,
  candidates,
  onArchive,
  onRestore,
  onReject,
  onCreateWikiDraft,
  onAskAgent,
  onCreateAsset,
  onCreateBrief,
  onCreatePack,
  onCreateNewsletter,
  onCreateReport,
  onMerge,
  onJumpToNode,
}: {
  node: MemoryNode;
  parentNode: MemoryNode | null;
  childNodes: MemoryNode[];
  relatedNodes: MemoryNode[];
  isUpdating: boolean;
  candidates: MemoryNode[];
  onArchive: () => void;
  onRestore: () => void;
  onReject: () => void;
  onCreateWikiDraft: () => void;
  onAskAgent: () => void;
  onCreateAsset: () => void;
  onCreateBrief: () => void;
  onCreatePack: () => void;
  onCreateNewsletter: () => void;
  onCreateReport: () => void;
  onMerge: (targetNodeId: string) => void;
  onJumpToNode: (node: MemoryNode) => void;
}) {
  const status = getMemoryStatus(node);
  const [mergeTarget, setMergeTarget] = useState("");
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        <Badge variant="outline">{formatNodeKind(node)}</Badge>
        <Badge variant="outline">{getMemoryRole(node)}</Badge>
        {isMemoryStale(node) && <Badge variant="outline">stale</Badge>}
        {getMemoryUsageCount(node) > 0 && <Badge variant="outline">used {getMemoryUsageCount(node)}x</Badge>}
      </div>
      <div className="rounded-lg border p-4">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Summary</p>
        <p className="mt-2 text-sm leading-6">{node.summary || node.content || "No summary yet."}</p>
      </div>
      <div className="rounded-lg border p-3">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Next Step</p>
        <p className="mt-1 text-sm text-muted-foreground">Use the quickest action for this node: draft a wiki page, turn it into an asset, or ask the agent to reason over it.</p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button variant="outline" onClick={onCreateWikiDraft}>
            <FileText className="h-4 w-4" /> Create Wiki Draft
          </Button>
          <Button variant="outline" onClick={onAskAgent}>
            <Bot className="h-4 w-4" /> Ask Agent
          </Button>
          <Button variant="outline" onClick={onCreateAsset}>
            <Sparkles className="h-4 w-4" /> Create Asset
          </Button>
          <Button variant="outline" onClick={onCreateBrief}>
            <ScrollText className="h-4 w-4" /> Create Brief
          </Button>
          <Button variant="outline" onClick={onCreatePack}>
            <ScrollText className="h-4 w-4" /> Create Pack
          </Button>
          <Button variant="outline" onClick={onCreateNewsletter}>
            <ScrollText className="h-4 w-4" /> Create Newsletter
          </Button>
          <Button variant="outline" onClick={onCreateReport}>
            <ScrollText className="h-4 w-4" /> Create Report
          </Button>
        </div>
      </div>
      <details className="rounded-lg border p-3">
        <summary className="cursor-pointer text-sm font-medium">More details</summary>
        <div className="mt-3 grid gap-3 md:grid-cols-2">
          <Info label="Evidence refs" value={[...(node.derived_from_notes || []), ...(node.derived_from_sources || [])].join(", ") || "None"} />
          <Info label="Last used" value={getMemoryLastUsedAt(node) || "Never"} />
          <Info label="Last action" value={getMemoryLastUsedAction(node) || "None"} />
          <Info label="Merged into" value={getMemoryMergedInto(node) || "Not merged"} />
          <Info label="Merged from" value={getMemoryMergedFrom(node).join(", ") || "None"} />
          <Info label="Family" value={getMemoryFamily(node)} />
        </div>
        <Textarea value={node.content || ""} readOnly rows={10} className="mt-3 font-mono text-sm" />
      </details>
      <div className="grid gap-3 md:grid-cols-3">
        <NodeJumpCard
          title="Parent"
          emptyLabel="This node is already at the top level."
          nodes={parentNode ? [parentNode] : []}
          onJump={onJumpToNode}
        />
        <NodeJumpCard
          title="Children"
          emptyLabel="No child nodes yet."
          nodes={childNodes}
          onJump={onJumpToNode}
        />
        <NodeJumpCard
          title="Related"
          emptyLabel="No nearby related nodes in the current view."
          nodes={relatedNodes}
          onJump={onJumpToNode}
        />
      </div>
      <div className="flex flex-wrap gap-2">
        {status === "archived" || status === "rejected" || status === "merged" ? (
          <Button variant="outline" disabled={isUpdating} onClick={onRestore}><RotateCcw className="h-4 w-4" /> Restore active</Button>
        ) : (
          <Button variant="outline" disabled={isUpdating} onClick={onArchive}><Archive className="h-4 w-4" /> Archive</Button>
        )}
        {status === "pending_review" && (
          <>
            <Button disabled={isUpdating} onClick={onRestore}><FileText className="h-4 w-4" /> Accept as active memory</Button>
            <Button variant="destructive" disabled={isUpdating} onClick={onReject}><XCircle className="h-4 w-4" /> Dismiss</Button>
          </>
        )}
      </div>
      {status === "pending_review" && candidates.length > 0 && (
        <div className="rounded-lg border p-3">
          <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Merge into existing node</p>
          <div className="flex gap-2">
            <select className="h-10 min-w-0 flex-1 rounded-md border border-input bg-background px-3 text-sm" value={mergeTarget} onChange={(event) => setMergeTarget(event.target.value)}>
              <option value="">Choose target node...</option>
              {candidates.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.title}</option>)}
            </select>
            <Button variant="outline" disabled={isUpdating || !mergeTarget} onClick={() => mergeTarget && onMerge(mergeTarget)}><GitMerge className="h-4 w-4" /> Merge</Button>
          </div>
        </div>
      )}
    </div>
  );
}

function NodeJumpCard({
  title,
  nodes,
  emptyLabel,
  onJump,
}: {
  title: string;
  nodes: MemoryNode[];
  emptyLabel: string;
  onJump: (node: MemoryNode) => void;
}) {
  return (
    <div className="rounded-lg border p-3">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{title}</p>
      {nodes.length === 0 ? (
        <p className="mt-2 text-sm text-muted-foreground">{emptyLabel}</p>
      ) : (
        <div className="mt-2 space-y-2">
          {nodes.map((item) => (
            <button
              key={item.id}
              type="button"
              className="w-full rounded-md border p-2 text-left transition-colors hover:border-primary/40 hover:bg-accent/40"
              onClick={() => onJump(item)}
            >
              <p className="line-clamp-1 text-sm font-medium">{item.title}</p>
              <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{item.summary || item.content}</p>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function StatusBadge({ node }: { node: MemoryNode }) {
  const status = getMemoryStatus(node);
  const variant = status === "pending_review" ? "secondary" : status === "archived" || status === "rejected" || status === "merged" ? "outline" : "default";
  return <Badge variant={variant}>{getMemoryStatusLabel(node)}</Badge>;
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border p-3">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-1 text-sm leading-6">{value}</p>
    </div>
  );
}
