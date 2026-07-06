import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { BookOpen, Bot, Plus, Star, Trash2, Pencil } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
	agentProfilesApi,
	skillsApi,
	type AgentProfile,
	type AgentProfileCreate,
	type AgentProfileUpdate,
} from "@/lib/api";
import { ModuleSectionNav } from "@/components/SectionNav";

interface ProfileFormData {
  name: string;
  agent_type: string;
  description: string;
  system_prompt_append: string;
  model_id: string;
  temperature: string;
  enabled_tools: string[] | null;
  enabled_skills: string[] | null;
  is_default: boolean;
}

const emptyForm: ProfileFormData = {
  name: "",
  agent_type: "action",
  description: "",
  system_prompt_append: "",
  model_id: "",
  temperature: "",
  enabled_tools: null,
  enabled_skills: null,
  is_default: false,
};

function profileToForm(p: AgentProfile): ProfileFormData {
  return {
    name: p.name,
    agent_type: p.agent_type,
    description: p.description,
    system_prompt_append: p.system_prompt_append,
    model_id: p.model_id ?? "",
    temperature: p.temperature != null ? String(p.temperature) : "",
    enabled_tools: p.enabled_tools,
    enabled_skills: p.enabled_skills,
    is_default: p.is_default,
  };
}

function formToCreate(f: ProfileFormData): AgentProfileCreate {
  return {
    name: f.name,
    agent_type: f.agent_type,
    description: f.description,
    system_prompt_append: f.system_prompt_append,
    model_id: f.model_id || null,
    temperature: f.temperature ? parseFloat(f.temperature) : null,
    enabled_tools: f.enabled_tools,
    enabled_skills: f.enabled_skills,
    is_default: f.is_default,
  };
}

function formToUpdate(f: ProfileFormData): AgentProfileUpdate {
  return formToCreate(f) as AgentProfileUpdate;
}

export function AgentProfilesPage() {
  const queryClient = useQueryClient();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<AgentProfile | null>(null);
  const [form, setForm] = useState<ProfileFormData>(emptyForm);
  const [toolFilterEnabled, setToolFilterEnabled] = useState(false);
  const [skillFilterEnabled, setSkillFilterEnabled] = useState(false);

  const { data: profilesData, isLoading } = useQuery({
    queryKey: ["agent-profiles"],
    queryFn: agentProfilesApi.list,
  });
  const profiles = profilesData?.items ?? [];

  const { data: availableTools } = useQuery({
    queryKey: ["available-tools"],
    queryFn: agentProfilesApi.availableTools,
  });

  const { data: allowedModels } = useQuery({
    queryKey: ["allowed-models"],
    queryFn: agentProfilesApi.allowedModels,
  });

  const { data: agentTypes } = useQuery({
    queryKey: ["agent-types"],
    queryFn: agentProfilesApi.types,
  });

  const { data: skills } = useQuery({
    queryKey: ["skills"],
    queryFn: skillsApi.list,
  });
  const skillNames = skills?.map((s) => s.name) ?? [];

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["agent-profiles"] });

  const createMutation = useMutation({
    mutationFn: (body: AgentProfileCreate) => agentProfilesApi.create(body),
    onSuccess: () => { invalidate(); setDialogOpen(false); },
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, body }: { id: string; body: AgentProfileUpdate }) =>
      agentProfilesApi.update(id, body),
    onSuccess: () => { invalidate(); setDialogOpen(false); },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => agentProfilesApi.delete(id),
    onSuccess: invalidate,
  });

  const setDefaultMutation = useMutation({
    mutationFn: (id: string) => agentProfilesApi.setDefault(id),
    onSuccess: invalidate,
  });

  const storyWriterPresetMutation = useMutation({
    mutationFn: agentProfilesApi.createStoryWriterPreset,
    onSuccess: invalidate,
  });

  function openCreate() {
    setEditing(null);
    setForm(emptyForm);
    setToolFilterEnabled(false);
    setSkillFilterEnabled(false);
    setDialogOpen(true);
  }

  function openEdit(p: AgentProfile) {
    setEditing(p);
    setForm(profileToForm(p));
    setToolFilterEnabled(p.enabled_tools != null);
    setSkillFilterEnabled(p.enabled_skills != null);
    setDialogOpen(true);
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const data = {
      ...form,
      enabled_tools: toolFilterEnabled ? (form.enabled_tools ?? []) : null,
      enabled_skills: skillFilterEnabled ? (form.enabled_skills ?? []) : null,
    };
    if (editing) {
      updateMutation.mutate({ id: editing.id, body: formToUpdate(data) });
    } else {
      createMutation.mutate(formToCreate(data));
    }
  }

  function toggleInList(list: string[] | null, item: string): string[] {
    const arr = list ?? [];
    return arr.includes(item) ? arr.filter((x) => x !== item) : [...arr, item];
  }

  const mutationError = createMutation.error || updateMutation.error;

	return (
		<div className="h-full overflow-y-auto">
			<div className="max-w-5xl mx-auto px-6 py-8 space-y-6">
				<ModuleSectionNav parent="settings" active="Agents" />
				<div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold">Agents</h1>
            <p className="text-sm text-muted-foreground mt-1">
              Create and manage custom agent configurations for different use cases.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => storyWriterPresetMutation.mutate()}
              disabled={storyWriterPresetMutation.isPending}
            >
              <BookOpen className="h-4 w-4 mr-1" />
              {storyWriterPresetMutation.isPending ? "Creating..." : "Story Agent"}
            </Button>
            <Button size="sm" onClick={openCreate}>
              <Plus className="h-4 w-4 mr-1" /> New Profile
            </Button>
          </div>
        </div>

        {storyWriterPresetMutation.error && (
          <p className="mb-4 text-sm text-destructive">
            {storyWriterPresetMutation.error instanceof Error
              ? storyWriterPresetMutation.error.message
              : "Failed to create story agent"}
          </p>
        )}

        {isLoading && <p className="text-sm text-muted-foreground">Loading...</p>}

        {!isLoading && profiles.length === 0 && (
          <div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
            <Bot className="h-12 w-12 mb-3 opacity-30" />
            <p>No profiles yet. Create one to customize your agent.</p>
          </div>
        )}

        <div className="grid gap-3">
          {profiles.map((profile) => (
            <Card key={profile.id} className="transition-colors hover:border-primary/40">
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Bot className="h-4 w-4 text-primary shrink-0" />
                    <CardTitle className="text-sm">{profile.name}</CardTitle>
                    <Badge variant="outline" className="text-[10px]">
                      {profile.agent_type === "story" ? "Story" : "Action"}
                    </Badge>
                    {profile.is_default && (
                      <Badge variant="secondary" className="text-[10px] gap-1">
                        <Star className="h-3 w-3" /> Default
                      </Badge>
                    )}
                  </div>
                  <div className="flex items-center gap-1">
                    {profile.model_id && (
                      <Badge variant="outline" className="text-[10px]">
                        {profile.model_id}
                      </Badge>
                    )}
                    {profile.temperature != null && (
                      <Badge variant="outline" className="text-[10px]">
                        temp: {profile.temperature}
                      </Badge>
                    )}
                  </div>
                </div>
                {profile.description && (
                  <CardDescription className="line-clamp-2 ml-6">
                    {profile.description}
                  </CardDescription>
                )}
              </CardHeader>
              <CardContent className="pt-0">
                <div className="flex items-center gap-2 ml-6">
                  {profile.enabled_tools && (
                    <span className="text-[10px] text-muted-foreground">
                      {profile.enabled_tools.length} tools
                    </span>
                  )}
                  {profile.enabled_skills && (
                    <span className="text-[10px] text-muted-foreground">
                      {profile.enabled_skills.length} skills
                    </span>
                  )}
                  {profile.system_prompt_append && (
                    <span className="text-[10px] text-muted-foreground">
                      custom instructions
                    </span>
                  )}
                  <div className="flex-1" />
                  {!profile.is_default && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-xs h-7"
                      onClick={() => setDefaultMutation.mutate(profile.id)}
                    >
                      <Star className="h-3 w-3 mr-1" /> Set Default
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-xs h-7"
                    onClick={() => openEdit(profile)}
                  >
                    <Pencil className="h-3 w-3 mr-1" /> Edit
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-xs h-7 text-destructive hover:text-destructive"
                    onClick={() => {
                      if (confirm(`Delete profile "${profile.name}"?`))
                        deleteMutation.mutate(profile.id);
                    }}
                  >
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>

        {/* Create / Edit Dialog */}
        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>{editing ? "Edit Profile" : "New Profile"}</DialogTitle>
            </DialogHeader>
            <form onSubmit={handleSubmit} className="space-y-4">
              {/* Name */}
              <div>
                <label className="text-xs font-medium text-muted-foreground">Name *</label>
                <Input
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder="e.g. Work Assistant"
                  required
                />
              </div>

              {/* Agent Type */}
              <div>
                <label className="text-xs font-medium text-muted-foreground">Agent Type</label>
                <select
                  value={form.agent_type}
                  onChange={(e) => setForm({ ...form, agent_type: e.target.value })}
                  className="w-full h-9 rounded-md border border-input bg-transparent px-3 py-1 text-sm"
                >
                  {(agentTypes ?? [
                    { id: "action", name: "Action Agent", description: "", default_tools: null, default_skills: null },
                    { id: "story", name: "Story Agent", description: "", default_tools: null, default_skills: null },
                  ]).map((type) => (
                    <option key={type.id} value={type.id}>{type.name}</option>
                  ))}
                </select>
                <p className="text-[10px] text-muted-foreground mt-1">
                  {agentTypes?.find((type) => type.id === form.agent_type)?.description ??
                    "Choose the base behavior for this custom agent."}
                </p>
              </div>

              {/* Description */}
              <div>
                <label className="text-xs font-medium text-muted-foreground">Description</label>
                <Input
                  value={form.description}
                  onChange={(e) => setForm({ ...form, description: e.target.value })}
                  placeholder="Brief description of this profile"
                />
              </div>

              {/* Model + Temperature row */}
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="text-xs font-medium text-muted-foreground">Model</label>
                  <select
                    value={form.model_id}
                    onChange={(e) => setForm({ ...form, model_id: e.target.value })}
                    className="w-full h-9 rounded-md border border-input bg-transparent px-3 py-1 text-sm"
                  >
                    <option value="">System Default</option>
                    {allowedModels?.map((m) => (
                      <option key={m} value={m}>{m}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="text-xs font-medium text-muted-foreground">Temperature</label>
                  <Input
                    type="number"
                    step="0.1"
                    min="0"
                    max="2"
                    value={form.temperature}
                    onChange={(e) => setForm({ ...form, temperature: e.target.value })}
                    placeholder="Default"
                  />
                </div>
              </div>

              {/* Custom Instructions */}
              <div>
                <label className="text-xs font-medium text-muted-foreground">Custom Instructions</label>
                <Textarea
                  value={form.system_prompt_append}
                  onChange={(e) => setForm({ ...form, system_prompt_append: e.target.value })}
                  placeholder="Additional instructions appended to the system prompt..."
                  rows={4}
                />
                <p className="text-[10px] text-muted-foreground mt-1">
                  These instructions are appended after the default system prompt.
                </p>
              </div>

              {/* Tool Filter */}
              <div>
                <div className="flex items-center gap-2 mb-2">
                  <input
                    type="checkbox"
                    checked={toolFilterEnabled}
                    onChange={(e) => {
                      setToolFilterEnabled(e.target.checked);
                      if (!e.target.checked) setForm({ ...form, enabled_tools: null });
                      else setForm({ ...form, enabled_tools: availableTools ?? [] });
                    }}
                    className="rounded"
                  />
                  <label className="text-xs font-medium text-muted-foreground">
                    Filter Tools (uncheck to enable all)
                  </label>
                </div>
                {toolFilterEnabled && availableTools && (
                  <div className="flex flex-wrap gap-2 p-3 bg-muted/50 rounded-md">
                    {availableTools.map((tool) => (
                      <label key={tool} className="flex items-center gap-1.5 text-xs cursor-pointer">
                        <input
                          type="checkbox"
                          checked={form.enabled_tools?.includes(tool) ?? false}
                          onChange={() =>
                            setForm({
                              ...form,
                              enabled_tools: toggleInList(form.enabled_tools, tool),
                            })
                          }
                          className="rounded"
                        />
                        <code className="bg-muted px-1 py-0.5 rounded">{tool}</code>
                      </label>
                    ))}
                  </div>
                )}
              </div>

              {/* Skill Filter */}
              <div>
                <div className="flex items-center gap-2 mb-2">
                  <input
                    type="checkbox"
                    checked={skillFilterEnabled}
                    onChange={(e) => {
                      setSkillFilterEnabled(e.target.checked);
                      if (!e.target.checked) setForm({ ...form, enabled_skills: null });
                      else setForm({ ...form, enabled_skills: skillNames });
                    }}
                    className="rounded"
                  />
                  <label className="text-xs font-medium text-muted-foreground">
                    Filter Skills (uncheck to enable all)
                  </label>
                </div>
                {skillFilterEnabled && skillNames.length > 0 && (
                  <div className="flex flex-wrap gap-2 p-3 bg-muted/50 rounded-md">
                    {skillNames.map((name) => (
                      <label key={name} className="flex items-center gap-1.5 text-xs cursor-pointer">
                        <input
                          type="checkbox"
                          checked={form.enabled_skills?.includes(name) ?? false}
                          onChange={() =>
                            setForm({
                              ...form,
                              enabled_skills: toggleInList(form.enabled_skills, name),
                            })
                          }
                          className="rounded"
                        />
                        <code className="bg-muted px-1 py-0.5 rounded">{name}</code>
                      </label>
                    ))}
                  </div>
                )}
              </div>

              {/* Default checkbox */}
              <label className="flex items-center gap-2 text-sm cursor-pointer">
                <input
                  type="checkbox"
                  checked={form.is_default}
                  onChange={(e) => setForm({ ...form, is_default: e.target.checked })}
                  className="rounded"
                />
                Set as default profile
              </label>

              {mutationError && (
                <p className="text-sm text-destructive">{(mutationError as Error).message}</p>
              )}

              <div className="flex justify-end gap-2 pt-2">
                <Button type="button" variant="ghost" onClick={() => setDialogOpen(false)}>
                  Cancel
                </Button>
                <Button
                  type="submit"
                  disabled={createMutation.isPending || updateMutation.isPending}
                >
                  {editing ? "Save" : "Create"}
                </Button>
              </div>
            </form>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
}
