import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { projectsApi, contextRequest, type ProjectContextRequest, type ProjectContextSnapshot } from "@/lib/api/projects";
import type { ChatSessionRecord } from "@/lib/api/chat-sessions";
import { AGENT_WORKFLOW_TEMPLATES } from "@/lib/agent-workflows";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";

export function ProjectWorkDialog({ projectId, reminderId, snapshot, sessionId, onClose, onSaved }: {
  projectId: string; reminderId?: string; snapshot?: ProjectContextSnapshot; sessionId?: string;
  onClose: () => void; onSaved?: (session: ChatSessionRecord) => void;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [workflowId, setWorkflowId] = useState("research-topic");
  const [taskId, setTaskId] = useState(reminderId ?? snapshot?.task?.id ?? "");
  const [resourcePage, setResourcePage] = useState(0);
  const [taskPage, setTaskPage] = useState(0);
  const [selected, setSelected] = useState<ProjectContextRequest["resources"]>(() => snapshot ? contextRequest(snapshot).resources : []);
  const [preview, setPreview] = useState<ProjectContextSnapshot | null>(null);
  const [newSessionId] = useState(() => `session-${crypto.randomUUID()}`);
  const project = useQuery({ queryKey: ["projects", "work-project", projectId], queryFn: () => projectsApi.get(projectId) });
  const resources = useQuery({ queryKey: ["projects", "work-resources", projectId, resourcePage], queryFn: () => projectsApi.resources(projectId, { limit: 20, offset: resourcePage * 20 }) });
  const tasks = useQuery({ queryKey: ["projects", "work-tasks", projectId, taskPage], queryFn: () => projectsApi.tasks(projectId, { include_done: false, limit: 10, offset: taskPage * 10 }) });
  const prepare = useMutation({ mutationFn: () => projectsApi.previewContext(projectId, { base_revision: project.data!.revision, reminder_id: taskId || null, resources: selected }), onSuccess: setPreview });
  const refresh = useMutation({ mutationFn: async () => { await project.refetch({ throwOnError: true }); await resources.refetch({ throwOnError: true }); await tasks.refetch({ throwOnError: true }); },
    onSuccess: () => { setPreview(null); prepare.reset(); confirm.reset(); } });
  const confirm = useMutation({ mutationFn: () => sessionId
    ? projectsApi.updateContextSession(projectId, sessionId, contextRequest(preview!))
    : projectsApi.createContextSession(projectId, { ...contextRequest(preview!), expected_fingerprint: preview!.fingerprint, session_id: newSessionId }),
    onSuccess: session => {
      void queryClient.invalidateQueries({ queryKey: ["projects"] });
      if (sessionId) { onSaved?.(session); onClose(); }
      else { onClose(); navigate(`/chat?session=${encodeURIComponent(session.id)}`, { state: { preparedSessionId: session.id, workflowId,
        promptSeed: preview!.task?.text ?? preview!.goal, backTo: `/projects/${projectId}`, backLabel: "Back to Project" } }); }
    } });
  const busy = prepare.isPending || confirm.isPending || refresh.isPending;
  return <Dialog open onOpenChange={open => { if (!open && !busy) onClose(); }}><DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto"><DialogHeader><DialogTitle>{sessionId ? "Review current Project context" : "Continue project work"}</DialogTitle></DialogHeader>
    <p className="text-sm text-muted-foreground">{sessionId ? "Refresh this session’s execution context without rewriting its earlier messages." : "Create a new project-linked conversation after confirming the exact context. No model runs until you send a message in Chat."} Only selected summaries are sent; tools can still search your whole knowledge base. Project memory and automatic task completion are not enabled.</p>
    {project.isLoading && <p role="status">Loading project…</p>}
    {project.isError && <p role="alert">Project context is unavailable. Refresh before continuing.</p>}
    {project.data?.archived_at && <p role="alert">Restore this project before starting or refreshing work.</p>}
    {!sessionId && <label className="block text-sm">Workflow<select className="mt-1 block w-full rounded-md border bg-background p-2" disabled={busy} value={workflowId} onChange={event => setWorkflowId(event.target.value)}>{AGENT_WORKFLOW_TEMPLATES.map(workflow => <option key={workflow.id} value={workflow.id}>{workflow.title}</option>)}</select></label>}
    <section className="space-y-2"><h3 className="text-sm font-semibold">Optional action</h3><p className="text-xs text-muted-foreground">{taskId ? `Selected Todo: ${taskId}` : "No action selected"}</p><Button size="sm" variant="outline" disabled={busy || !taskId} onClick={() => { setTaskId(""); setPreview(null); }}>Use project goal only</Button>
      {tasks.isError && <p role="alert" className="text-sm">Project actions are unavailable, not empty.</p>}
      {tasks.data?.items.map(task => <label key={task.id} className="flex gap-2 text-sm"><input type="radio" name="project-work-action" disabled={busy} checked={taskId === task.id} onChange={() => { setTaskId(task.id); setPreview(null); }} />{task.text}</label>)}
      {tasks.data && tasks.data.total > 10 && <div className="flex gap-2"><Button size="sm" variant="outline" disabled={busy || taskPage === 0} onClick={() => setTaskPage(taskPage - 1)}>Previous actions</Button><Button size="sm" variant="outline" disabled={busy || (taskPage + 1) * 10 >= tasks.data.total} onClick={() => setTaskPage(taskPage + 1)}>Next actions</Button></div>}
    </section>
    <section className="space-y-2"><h3 className="text-sm font-semibold">Selected project resources ({selected.length}/20)</h3><p className="text-xs text-muted-foreground">Sessions are links to history, not prompt material. Note/Wiki summaries may use a short content excerpt when no summary exists; Assets use their brief or outline, not full drafts.</p>
      {selected.map(ref => <div key={`${ref.resource_type}:${ref.resource_id}`} className="flex items-center justify-between gap-2 text-xs"><span className="break-all">{ref.resource_type}: {snapshot?.resources.find(item => item.resource_type === ref.resource_type && item.resource_id === ref.resource_id)?.title ?? ref.resource_id}</span><Button size="sm" variant="ghost" disabled={busy} aria-label={`Remove selected context ${ref.resource_id}`} onClick={() => { setSelected(current => current.filter(item => item.resource_type !== ref.resource_type || item.resource_id !== ref.resource_id)); setPreview(null); }}>Remove selection</Button></div>)}
      {resources.isError && <p role="alert" className="text-sm">Project resources are unavailable, not empty.</p>}
      {resources.data?.items.filter(item => item.resource_type !== "chat_session").map(item => {
        const checked = selected.some(ref => ref.resource_type === item.resource_type && ref.resource_id === item.resource_id);
        return <label key={item.id} className="flex items-start gap-2 rounded-lg border p-2 text-sm"><input type="checkbox" checked={checked} disabled={busy || (!checked && selected.length >= 20)} onChange={event => { setSelected(current => event.target.checked ? [...current, { resource_type: item.resource_type as "source" | "note" | "wiki" | "asset", resource_id: item.resource_id }] : current.filter(ref => ref.resource_type !== item.resource_type || ref.resource_id !== item.resource_id)); setPreview(null); }} />{item.title} · {item.resource_type}</label>;
      })}
      <div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" disabled={busy || resourcePage === 0} onClick={() => setResourcePage(resourcePage - 1)}>Previous context resources</Button><Button size="sm" variant="outline" disabled={busy || !resources.data || (resourcePage + 1) * 20 >= resources.data.total} onClick={() => setResourcePage(resourcePage + 1)}>Next context resources</Button><Button size="sm" variant="ghost" disabled={busy} onClick={() => { setSelected([]); setPreview(null); }}>Clear context resources</Button></div>
    </section>
    {(prepare.isError || confirm.isError || refresh.isError) && <div role="alert" className="text-sm text-destructive"><p>{(prepare.error ?? confirm.error ?? refresh.error)?.message}</p><p>Your action and resource selection are retained. Refresh and review a new preview before confirming.</p></div>}
    <div className="flex flex-wrap gap-2"><Button variant="outline" disabled={busy} onClick={() => refresh.mutate()}>Refresh project context inputs</Button><Button disabled={busy || !project.data || project.isError || Boolean(project.data.archived_at) || resources.isError || tasks.isError} onClick={() => { confirm.reset(); prepare.mutate(); }}>Preview exact project context</Button></div>
    {preview && <section className="space-y-2 rounded-xl border p-3"><h3 className="font-semibold">Context to be sent</h3><p className="text-xs text-muted-foreground">Revision {preview.project_revision} · {preview.context_text.length} characters, not a token estimate · {preview.resources.length} resources</p>{preview.truncated && <p className="text-sm text-amber-700">Some text is truncated to fit the 1,000-character summary and 20,000-character context limits. All selected resource references remain visible.</p>}<pre className="max-h-64 whitespace-pre-wrap break-words overflow-y-auto text-xs">{preview.context_text}</pre><Button disabled={busy} onClick={() => confirm.mutate()}>{sessionId ? "Confirm refreshed project context" : "Confirm context and open new Chat"}</Button></section>}
  </DialogContent></Dialog>;
}
