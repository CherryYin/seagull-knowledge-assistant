import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Archive, Check, History, Pencil, RotateCcw, Trash2, X } from "lucide-react";
import { agentMemoryApi, type AgentMemory } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { candidateActionLabel } from "@/lib/candidateActions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ModuleSectionNav } from "@/components/SectionNav";

function sourceLabel(sessionId: string) {
  return `Source Session: ${sessionId}`;
}

export function AgentMemoryPage() {
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ["agent-memories"], queryFn: agentMemoryApi.list });
  const recallQuery = useQuery({ queryKey: ["agent-memory-recalls"], queryFn: () => agentMemoryApi.listRecallAudits() });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["agent-memories"] });
  const action = useMutation({ mutationFn: (operation: () => Promise<unknown>) => operation(), onSuccess: refresh });

  const editMemory = (memory: AgentMemory) => {
    const title = window.prompt("Memory title", memory.title);
    if (title === null) return;
    const content = window.prompt("Memory content", memory.content);
    if (content === null) return;
    action.mutate(() => agentMemoryApi.update(memory.id, { title, content }));
  };

  if (query.isLoading) return <div className="p-8 text-sm text-muted-foreground">Loading Agent Memory...</div>;
  if (query.isError) return <div className="p-8 text-sm text-red-600">Could not load Agent Memory.</div>;
  const candidates = query.data?.candidates.filter((item) => item.status === "pending") ?? [];
  const active = query.data?.memories.filter((item) => item.status === "active") ?? [];
  const archived = query.data?.memories.filter((item) => item.status === "archived") ?? [];
  const memoryTitles = new Map(query.data?.memories.map((memory) => [memory.id, memory.title]) ?? []);
  const recalls = recallQuery.data?.items.slice().reverse().slice(0, 20) ?? [];

  return (
    <div className="mx-auto max-w-5xl space-y-8 p-8">
      <ModuleSectionNav parent="settings" active="Agent Memory" />
      <div>
        <h1 className="text-2xl font-semibold">Agent Memory</h1>
        <p className="mt-1 text-sm text-muted-foreground">User-confirmed cross-session preferences and constraints. This is not PKG knowledge evidence.</p>
      </div>
      <section className="space-y-3">
        <h2 className="text-lg font-medium">Pending candidates ({candidates.length})</h2>
        {candidates.length === 0 && <p className="text-sm text-muted-foreground">No candidates need review.</p>}
        {candidates.map((candidate) => (
          <Card key={candidate.id}>
            <CardHeader><CardTitle className="text-base">{candidate.title}</CardTitle></CardHeader>
            <CardContent className="space-y-3 text-sm">
              <p>{candidate.content}</p>
              <p className="text-xs text-muted-foreground">{candidate.reason} · {sourceLabel(candidate.provenance.sessionId)}</p>
              <div className="flex gap-2">
                <Button size="sm" onClick={() => action.mutate(() => agentMemoryApi.accept(candidate.id))}><Check className="mr-1 h-4 w-4" />{candidateActionLabel("keep", "Memory")}</Button>
                <Button size="sm" variant="outline" onClick={() => {
                  const content = window.prompt("Edit candidate before review", candidate.content);
                  if (content !== null) action.mutate(() => agentMemoryApi.updateCandidate(candidate.id, { content }));
                }}><Pencil className="mr-1 h-4 w-4" />Edit</Button>
                <Button size="sm" variant="ghost" onClick={() => action.mutate(() => agentMemoryApi.reject(candidate.id))}><X className="mr-1 h-4 w-4" />{candidateActionLabel("dismiss")}</Button>
              </div>
            </CardContent>
          </Card>
        ))}
      </section>
      <section className="space-y-3">
        <h2 className="text-lg font-medium">Active ({active.length})</h2>
        {active.map((memory) => (
          <Card key={memory.id}>
            <CardHeader><CardTitle className="text-base">{memory.title}</CardTitle></CardHeader>
            <CardContent className="space-y-3 text-sm">
              <p>{memory.content}</p>
              <p className="text-xs text-muted-foreground">{memory.kind} · {memory.scopeType} · {sourceLabel(memory.provenance.sessionId)}{memory.lastUsedAt ? ` · Last used ${new Date(memory.lastUsedAt).toLocaleString()}` : ""}</p>
              <div className="flex gap-2">
                <Button size="sm" variant="outline" onClick={() => editMemory(memory)}><Pencil className="mr-1 h-4 w-4" />Edit</Button>
                <Button size="sm" variant="outline" onClick={() => action.mutate(() => agentMemoryApi.archive(memory.id))}><Archive className="mr-1 h-4 w-4" />{candidateActionLabel("archive")}</Button>
                <Button size="sm" variant="ghost" onClick={() => window.confirm("Permanently delete this Agent Memory?") && action.mutate(() => agentMemoryApi.delete(memory.id))}><Trash2 className="mr-1 h-4 w-4" />Delete</Button>
              </div>
            </CardContent>
          </Card>
        ))}
      </section>
      <section className="space-y-3">
        <h2 className="flex items-center gap-2 text-lg font-medium"><History className="h-5 w-5" />Archived ({archived.length})</h2>
        {archived.map((memory) => (
          <Card key={memory.id}>
            <CardContent className="flex items-center justify-between gap-4 pt-6">
              <div><p className="font-medium">{memory.title}</p><p className="text-sm text-muted-foreground">{sourceLabel(memory.provenance.sessionId)}</p></div>
              <div className="flex gap-2">
                <Button size="sm" variant="outline" onClick={() => action.mutate(() => agentMemoryApi.restore(memory.id))}><RotateCcw className="mr-1 h-4 w-4" />Restore</Button>
                <Button size="sm" variant="ghost" onClick={() => window.confirm("Permanently delete this Agent Memory?") && action.mutate(() => agentMemoryApi.delete(memory.id))}><Trash2 className="h-4 w-4" /></Button>
              </div>
            </CardContent>
          </Card>
        ))}
      </section>
      <section className="space-y-3">
        <h2 className="flex items-center gap-2 text-lg font-medium"><History className="h-5 w-5" />Recent recall audit</h2>
        <p className="text-sm text-muted-foreground">Shows when confirmed Agent Memory was injected and why. Empty recalls are retained to prove that no Memory was injected.</p>
        {recalls.length === 0 && <p className="text-sm text-muted-foreground">No recall audit has been recorded yet.</p>}
        {recalls.map((audit) => (
          <Card key={audit.id}>
            <CardContent className="space-y-2 pt-6 text-sm">
              <p className="font-medium">Session {audit.sessionId}</p>
              <p className="text-xs text-muted-foreground">{new Date(audit.createdAt).toLocaleString()} · Scope {audit.scopeType}{audit.scopeId ? `:${audit.scopeId}` : ""}</p>
              {audit.matches.length === 0 ? (
                <p className="text-muted-foreground">No active Agent Memory was injected.</p>
              ) : audit.matches.map((match) => (
                <div key={match.memoryId} className="rounded-md border border-border px-3 py-2">
                  <p>{memoryTitles.get(match.memoryId) ?? `Deleted memory ${match.memoryId}`}</p>
                  <p className="text-xs text-muted-foreground">Why used: {match.reason}</p>
                </div>
              ))}
            </CardContent>
          </Card>
        ))}
      </section>
    </div>
  );
}
