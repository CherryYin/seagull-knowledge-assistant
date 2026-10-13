import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { projectsApi, type Project, type ProjectInput } from "@/lib/api/projects";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

export function ProjectForm({ project, onSaved }: { project?: Project; onSaved: (saved: Project) => void }) {
  const queryClient = useQueryClient();
  const [title, setTitle] = useState(project?.title ?? "");
  const [goal, setGoal] = useState(project?.goal ?? "");
  const [criteria, setCriteria] = useState(project?.completion_criteria ?? "");
  const [revision, setRevision] = useState(project?.revision ?? 1);
  const [latest, setLatest] = useState<Project | null>(null);
  const save = useMutation({
    mutationFn: () => {
      const input: ProjectInput = { title: title.trim(), goal: goal.trim(), completion_criteria: criteria.trim() };
      if (!project) return projectsApi.create(input);
      const changes: Partial<ProjectInput> = {};
      for (const key of ["title", "goal", "completion_criteria"] as const) if (input[key] !== project[key]) changes[key] = input[key];
      return projectsApi.update(project.id, { ...changes, base_revision: revision });
    },
    onSuccess: saved => { void queryClient.invalidateQueries({ queryKey: ["projects"] }); onSaved(saved); },
  });
  const refresh = useMutation({
    mutationFn: () => projectsApi.get(project!.id),
    onSuccess: saved => { setLatest(saved); setRevision(saved.revision); save.reset(); },
  });

  return <form className="space-y-4" onSubmit={event => { event.preventDefault(); save.mutate(); }}>
    <label className="block space-y-1 text-sm font-medium">Project name<Input value={title} onChange={event => setTitle(event.target.value)} maxLength={200} required /></label>
    <label className="block space-y-1 text-sm font-medium">Goal<Textarea value={goal} onChange={event => setGoal(event.target.value)} maxLength={4000} required placeholder="What are you working toward?" /></label>
    <label className="block space-y-1 text-sm font-medium">Completion criteria<Textarea value={criteria} onChange={event => setCriteria(event.target.value)} maxLength={4000} placeholder="What result will let you call this complete?" /></label>
    {latest && <div className="rounded-lg border p-3 text-sm"><p className="font-medium">Latest saved version (revision {latest.revision})</p><p className="mt-2 whitespace-pre-wrap">{latest.title}{"\n"}{latest.goal}{"\n"}{latest.completion_criteria}</p><p className="mt-2 text-muted-foreground">Your edits are retained. Only fields you changed will be saved. Review differences before saving again.</p></div>}
    {(save.isError || refresh.isError) && <div role="alert" className="space-y-2 text-sm text-destructive"><p>Could not save this project. Your edits are retained.</p><p className="break-words">{(save.error ?? refresh.error)?.message}</p>{project && <Button type="button" variant="outline" disabled={refresh.isPending} onClick={() => refresh.mutate()}>Load latest revision (keep edits)</Button>}</div>}
    <Button type="submit" disabled={!title.trim() || !goal.trim() || save.isPending || refresh.isPending}>{save.isPending ? "Saving…" : project ? "Save Project" : "Create Project"}</Button>
  </form>;
}
