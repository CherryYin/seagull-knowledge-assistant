import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router-dom";
import { Archive, Brain, FileText, GitMerge, RefreshCw, RotateCcw, Search, XCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { memoryApi, wikiApi, type MemoryNode } from "@/lib/api";
import { SectionNav, knowledgeNavItems } from "@/components/SectionNav";

const PAGE_SIZE = 25;
const MEMORY_TYPES = ["", "topic", "source", "global"] as const;
type MemoryStatus = "" | "active" | "archived" | "pending_review" | "rejected" | "merged";

export function MemoryTreePage() {
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const [query, setQuery] = useState(searchParams.get("q") || "");
  const [status, setStatus] = useState<MemoryStatus>((searchParams.get("status") as MemoryStatus) || "active");
  const [nodeType, setNodeType] = useState((searchParams.get("type") as (typeof MEMORY_TYPES)[number]) || "");
  const [page, setPage] = useState(Math.max(1, Number(searchParams.get("page") || 1)));
  const [selectedId, setSelectedId] = useState<string | null>(searchParams.get("node"));
  const [queuedRefreshCount, setQueuedRefreshCount] = useState<number | null>(null);

  const params = useMemo(() => ({
    q: query.trim() || undefined,
    status: status || undefined,
    node_type: nodeType || undefined,
    limit: PAGE_SIZE,
    offset: (page - 1) * PAGE_SIZE,
  }), [query, status, nodeType, page]);

  const { data, isLoading, error } = useQuery({
    queryKey: ["memory-nodes", params],
    queryFn: () => memoryApi.list(params),
  });

  const nodes = data?.items ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const selectedNode = nodes.find((node) => node.id === selectedId) ?? nodes[0] ?? null;

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

  const queueWikiRefreshMutation = useMutation({
    mutationFn: ({ id }: { id: string }) => wikiApi.suggest({ trigger_type: "memory", trigger_id: id, limit: 5 }),
    onSuccess: (suggestions) => {
      setQueuedRefreshCount(suggestions.length);
      queryClient.invalidateQueries({ queryKey: ["wiki-suggestions"] });
      queryClient.invalidateQueries({ queryKey: ["wiki-pages"] });
    },
  });

  const applyFilters = () => {
    const next = new URLSearchParams();
    if (query.trim()) next.set("q", query.trim());
    if (status && status !== "active") next.set("status", status);
    if (nodeType) next.set("type", nodeType);
    if (page > 1) next.set("page", String(page));
    if (selectedId) next.set("node", selectedId);
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

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-7xl space-y-6 px-6 py-8">
		<SectionNav items={knowledgeNavItems} active="Memory" />

        <section className="rounded-3xl border bg-card p-6 shadow-sm">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <div className="flex items-center gap-2 text-sm text-muted-foreground"><Brain className="h-4 w-4" /> Memory Tree</div>
              <h1 className="mt-1 text-2xl font-semibold tracking-tight">Memory Workbench</h1>
				<p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
					Memory is the long-term context layer inside Knowledge. Inspect active context here; items that need confirmation stay in Review.
				</p>
            </div>
            <form className="flex w-full flex-col gap-2 lg:w-[520px]" onSubmit={(event) => { event.preventDefault(); applyFilters(); }}>
              <div className="flex gap-2">
                <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search memory..." />
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
                <span>Memory Nodes</span>
                <Badge variant="outline">{isLoading ? "..." : total}</Badge>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {isLoading && <p className="text-sm text-muted-foreground">Loading...</p>}
              {!isLoading && !nodes.length && <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">No memory nodes found.</p>}
              <div className="space-y-2">
                {nodes.map((node) => (
                  <MemoryListItem key={node.id} node={node} active={selectedNode?.id === node.id} onClick={() => setSelectedId(node.id)} />
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
                <span>{selectedNode?.title || "Memory Detail"}</span>
                {selectedNode && <StatusBadge node={selectedNode} />}
              </CardTitle>
            </CardHeader>
            <CardContent>
              {!selectedNode ? (
                <p className="text-sm text-muted-foreground">Select a memory node to inspect details.</p>
              ) : (
                <MemoryDetail
                  node={selectedNode}
                  isUpdating={updateMutation.isPending || mergeMutation.isPending}
                  isQueueingRefresh={queueWikiRefreshMutation.isPending}
                  queuedRefreshCount={queuedRefreshCount}
                  candidates={nodes.filter((node) => node.id !== selectedNode.id && String(node.metadata_?.status || "active") === "active")}
                  onArchive={() => updateMutation.mutate({ id: selectedNode.id, body: { status: "archived" } })}
                  onRestore={() => updateMutation.mutate({ id: selectedNode.id, body: { status: "active" } })}
                  onReject={() => updateMutation.mutate({ id: selectedNode.id, body: { status: "rejected" } })}
                  onQueueWikiRefresh={() => queueWikiRefreshMutation.mutate({ id: selectedNode.id })}
                  onMerge={(targetNodeId) => mergeMutation.mutate({ id: selectedNode.id, targetNodeId })}
                />
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

function MemoryListItem({ node, active, onClick }: { node: MemoryNode; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      className={`w-full rounded-lg border p-3 text-left transition-colors ${active ? "border-primary/50 bg-primary/5" : "hover:border-primary/30"}`}
      onClick={onClick}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="line-clamp-1 text-sm font-medium">{node.title}</p>
          <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{node.summary || node.content}</p>
        </div>
        <StatusBadge node={node} />
      </div>
      <div className="mt-2 flex flex-wrap gap-2">
        <Badge variant="outline">{node.node_type}</Badge>
        <Badge variant="secondary">{node.level}</Badge>
      </div>
    </button>
  );
}

function MemoryDetail({
  node,
  isUpdating,
  isQueueingRefresh,
  queuedRefreshCount,
  candidates,
  onArchive,
  onRestore,
  onReject,
  onQueueWikiRefresh,
  onMerge,
}: {
  node: MemoryNode;
  isUpdating: boolean;
  isQueueingRefresh: boolean;
  queuedRefreshCount: number | null;
  candidates: MemoryNode[];
  onArchive: () => void;
  onRestore: () => void;
  onReject: () => void;
  onQueueWikiRefresh: () => void;
  onMerge: (targetNodeId: string) => void;
}) {
  const status = String(node.metadata_?.status || "active");
  const [mergeTarget, setMergeTarget] = useState("");
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        <Badge variant="outline">{node.id}</Badge>
        <Badge variant="secondary">{node.node_type}/{node.level}</Badge>
        {node.confidence_score !== null && node.confidence_score !== undefined && <Badge variant="outline">confidence {node.confidence_score}</Badge>}
        {node.metadata_?.usage_count !== undefined && <Badge variant="outline">used {String(node.metadata_.usage_count)}x</Badge>}
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        <Info label="Summary" value={node.summary || "None"} />
        <Info label="Evidence" value={[...(node.derived_from_notes || []), ...(node.derived_from_sources || [])].join(", ") || "None"} />
        <Info label="Last used" value={String(node.metadata_?.last_used_at || "Never")} />
        <Info label="Last action" value={String(node.metadata_?.last_used_action || "None")} />
      </div>
      <Textarea value={node.content || ""} readOnly rows={16} className="font-mono text-sm" />
      <div className="rounded-lg border p-3">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Knowledge Flow</p>
        <p className="mt-1 text-sm text-muted-foreground">Queue a wiki refresh if this memory may affect stable knowledge.</p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button variant="outline" disabled={isQueueingRefresh} onClick={onQueueWikiRefresh}>
            <RefreshCw className={`h-4 w-4 ${isQueueingRefresh ? "animate-spin" : ""}`} /> Queue Wiki Refresh
          </Button>
          {queuedRefreshCount !== null && (
            <Link to="/review/wiki-suggestions" className="text-xs text-primary hover:underline">
              {queuedRefreshCount > 0
                ? `Queued ${queuedRefreshCount} refresh reminder${queuedRefreshCount === 1 ? "" : "s"}. View queue.`
                : "No matching wiki pages found yet."}
            </Link>
          )}
        </div>
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
            <Button variant="destructive" disabled={isUpdating} onClick={onReject}><XCircle className="h-4 w-4" /> Reject</Button>
          </>
        )}
      </div>
      {status === "pending_review" && candidates.length > 0 && (
        <div className="rounded-lg border p-3">
          <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Merge into existing memory</p>
          <div className="flex gap-2">
            <select className="h-10 min-w-0 flex-1 rounded-md border border-input bg-background px-3 text-sm" value={mergeTarget} onChange={(event) => setMergeTarget(event.target.value)}>
              <option value="">Choose target memory...</option>
              {candidates.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.title}</option>)}
            </select>
            <Button variant="outline" disabled={isUpdating || !mergeTarget} onClick={() => mergeTarget && onMerge(mergeTarget)}><GitMerge className="h-4 w-4" /> Merge</Button>
          </div>
        </div>
      )}
    </div>
  );
}

function StatusBadge({ node }: { node: MemoryNode }) {
  const status = String(node.metadata_?.status || "active");
  const variant = status === "pending_review" ? "secondary" : status === "archived" || status === "rejected" || status === "merged" ? "outline" : "default";
  return <Badge variant={variant}>{status}</Badge>;
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border p-3">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-1 text-sm leading-6">{value}</p>
    </div>
  );
}
