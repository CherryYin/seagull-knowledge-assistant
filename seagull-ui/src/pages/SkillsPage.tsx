import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { Zap, ChevronDown, ChevronRight, Code2, FileText, Plus, Search, Sparkles, Trash2, Download } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { skillsApi, type Skill, type SkillArg, type SkillCreateRequest } from "@/lib/api";
import { ModuleSectionNav } from "@/components/SectionNav";

const DEFAULT_TEMPLATE = `Use this skill when the user asks for help with this domain or workflow.

## Workflow

1. Clarify the user's goal and expected output.
2. Inspect relevant project files or inputs when needed.
3. Apply the domain-specific process described by this skill.
4. Validate the result when possible.
5. Summarize the outcome and next steps.

## Guidelines

- Keep instructions concise and procedural.
- Include only context the model would not already know.
- Prefer reusable patterns over one-off examples.
- Ask for clarification only when proceeding would be risky.

---

**User's request**: $@`;

function normalizeSkillName(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function SkillsPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [expandedSkill, setExpandedSkill] = useState<string | null>(null);
  const [sourceFilter, setSourceFilter] = useState<string>("");
  const [creatorOpen, setCreatorOpen] = useState(false);
  const [finderOpen, setFinderOpen] = useState(false);

  const { data: skills, isLoading } = useQuery({
    queryKey: ["skills"],
    queryFn: skillsApi.list,
  });

  const createMutation = useMutation({
    mutationFn: skillsApi.create,
    onSuccess: (skill) => {
      queryClient.invalidateQueries({ queryKey: ["skills"] });
      setExpandedSkill(skill.name);
      setCreatorOpen(false);
    },
  });

  const findMutation = useMutation({
    mutationFn: ({ topic, maxResults }: { topic: string; maxResults: number }) =>
      skillsApi.find(topic, maxResults),
  });

  const filtered = skills?.filter(
    (s) => !sourceFilter || s.source === sourceFilter
  );

  const sources = [...new Set(skills?.map((s) => s.source) ?? [])];

	return (
		<div className="h-full overflow-y-auto">
			<div className="max-w-5xl mx-auto px-6 py-8 space-y-6">
				<ModuleSectionNav parent="settings" active="Skills" />
				<div className="mb-6 overflow-hidden rounded-2xl border border-primary/20 bg-gradient-to-br from-slate-950 via-blue-950 to-cyan-950 p-6 text-white shadow-xl shadow-primary/10">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <div className="flex items-center gap-2 text-cyan-200">
                <Zap className="h-5 w-5" />
                <span className="text-sm font-semibold uppercase tracking-[0.2em]">Skills</span>
              </div>
              <h1 className="mt-3 text-2xl font-bold">Skills</h1>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-cyan-50/75">
				Reusable prompt templates for the Action Agent. Use <code className="rounded bg-white/10 px-1 py-0.5 text-xs">/skill-name</code> in Agent Chat to invoke.
              </p>
            </div>
            <div className="flex items-center gap-3">
              {skills && <span className="text-sm text-cyan-50/70">{skills.length} skills</span>}
              <Button className="bg-cyan-300 text-slate-950 hover:bg-cyan-200" size="sm" onClick={() => setFinderOpen((open) => !open)}>
                <Search className="mr-1 h-4 w-4" />
                Find Skills
              </Button>
              <Button className="bg-white text-slate-950 hover:bg-cyan-50" size="sm" onClick={() => setCreatorOpen((open) => !open)}>
                <Sparkles className="mr-1 h-4 w-4" />
                Skill Creator
              </Button>
            </div>
          </div>
        </div>

        {creatorOpen && (
          <SkillCreatorCard
            loading={createMutation.isPending}
            error={createMutation.error?.message}
            onSubmit={(body) => createMutation.mutateAsync(body)}
          />
        )}

        {finderOpen && (
          <SkillFinderCard
            loading={findMutation.isPending}
            error={findMutation.error?.message}
            result={findMutation.data?.result}
            candidates={findMutation.data?.candidates ?? []}
            importing={createMutation.isPending}
            importError={createMutation.error?.message}
            onSubmit={(topic, maxResults) => findMutation.mutate({ topic, maxResults })}
            onImport={async (candidate) => {
              const created = await createMutation.mutateAsync(candidate);
              setFinderOpen(false);
              return created;
            }}
          />
        )}

        {/* Source filter */}
        {sources.length > 1 && (
          <div className="flex gap-2 mb-4 flex-wrap">
            <button
              onClick={() => setSourceFilter("")}
              className={`px-3 py-1 rounded-md text-xs cursor-pointer transition-colors ${
                !sourceFilter ? "bg-primary/20 text-primary font-medium" : "text-muted-foreground hover:bg-accent"
              }`}
            >
              All
            </button>
            {sources.map((src) => (
              <button
                key={src}
                onClick={() => setSourceFilter(src)}
                className={`px-3 py-1 rounded-md text-xs cursor-pointer transition-colors ${
                  sourceFilter === src ? "bg-primary/20 text-primary font-medium" : "text-muted-foreground hover:bg-accent"
                }`}
              >
                {src}
              </button>
            ))}
          </div>
        )}

        {isLoading && <p className="text-sm text-muted-foreground">Loading...</p>}

        {filtered && filtered.length === 0 && (
          <div className="flex flex-col items-center justify-center py-20 text-muted-foreground">
            <Zap className="h-12 w-12 mb-3 opacity-30" />
            <p>No skills found.</p>
          </div>
        )}

        <div className="grid gap-3">
          {filtered?.map((skill) => {
            const isExpanded = expandedSkill === skill.name;
            const argsHint = skill.args
              .map((a) => (a.required ? `<${a.name}>` : `[${a.name}]`))
              .join(" ");

            return (
              <Card
                key={skill.name}
                className="transition-colors hover:border-primary/40 cursor-pointer"
                onClick={() => setExpandedSkill(isExpanded ? null : skill.name)}
              >
                <CardHeader className="pb-2">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Zap className="h-4 w-4 text-primary shrink-0" />
                      <CardTitle className="text-sm font-mono">
                        /{skill.name}
                        {argsHint && (
                          <span className="text-muted-foreground font-normal ml-1">{argsHint}</span>
                        )}
                      </CardTitle>
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge variant="outline" className="text-[10px]">{skill.source}</Badge>
                      {skill.tools_file && (
                        <Badge variant="secondary" className="text-[10px] gap-1">
                          <Code2 className="h-3 w-3" />
                          tools
                        </Badge>
                      )}
                      {isExpanded ? (
                        <ChevronDown className="h-4 w-4 text-muted-foreground" />
                      ) : (
                        <ChevronRight className="h-4 w-4 text-muted-foreground" />
                      )}
                    </div>
                  </div>
                  <CardDescription className="line-clamp-2 ml-6">
                    {skill.description}
                  </CardDescription>
                </CardHeader>

                {isExpanded && (
                  <CardContent className="pt-0" onClick={(e) => e.stopPropagation()}>
                    <SkillDetails skill={skill} onUse={() => navigate(`/?skill=${encodeURIComponent(skill.name)}`)} />
                  </CardContent>
                )}
              </Card>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function SkillCreatorCard({
  onSubmit,
  loading,
  error,
}: {
  onSubmit: (body: SkillCreateRequest) => Promise<unknown>;
  loading: boolean;
  error?: string;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [template, setTemplate] = useState(DEFAULT_TEMPLATE);
  const [args, setArgs] = useState<SkillArg[]>([
    { name: "task", description: "The user's request for this skill", required: true },
  ]);
  const normalizedName = useMemo(() => normalizeSkillName(name), [name]);

  const updateArg = (index: number, patch: Partial<SkillArg>) => {
    setArgs((current) => current.map((arg, i) => (i === index ? { ...arg, ...patch } : arg)));
  };

  const removeArg = (index: number) => {
    setArgs((current) => current.filter((_, i) => i !== index));
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSubmit({
      name: normalizedName,
      description,
      args: args.filter((arg) => arg.name.trim()).map((arg) => ({ ...arg, name: normalizeSkillName(arg.name) })),
      template,
    });
  };

  return (
    <Card className="mb-6 border-primary/30 shadow-lg shadow-primary/5">
      <CardHeader>
        <div className="flex items-start gap-3">
          <div className="rounded-lg bg-primary/10 p-2 text-primary">
            <Sparkles className="h-5 w-5" />
          </div>
          <div>
            <CardTitle className="text-base">Skill Creator</CardTitle>
            <CardDescription className="mt-1">
              Inspired by Claude/Codex skill creator: define concise trigger metadata, procedural instructions, arguments, and validation guidance.
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <label className="text-sm font-medium">Skill name</label>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="research-summarizer" required />
              <p className="text-xs text-muted-foreground">Saved as <code>/{normalizedName || "skill-name"}</code>. Use lowercase kebab-case.</p>
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">Trigger description</label>
              <Input
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Use when the user asks to..."
                required
              />
              <p className="text-xs text-muted-foreground">Be specific: this decides when the skill should be used.</p>
            </div>
          </div>

          <div className="rounded-lg border border-border bg-muted/30 p-3">
            <div className="mb-3 flex items-center justify-between">
              <div>
                <h3 className="text-sm font-medium">Arguments</h3>
                <p className="text-xs text-muted-foreground">Keep arguments minimal. Most skills only need one required task argument.</p>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setArgs((current) => [...current, { name: "", description: "", required: false }])}
              >
                <Plus className="mr-1 h-3.5 w-3.5" />
                Add Arg
              </Button>
            </div>
            <div className="space-y-2">
              {args.map((arg, index) => (
                <div key={index} className="grid gap-2 rounded-md bg-background p-2 md:grid-cols-[160px_1fr_90px_36px]">
                  <Input value={arg.name} onChange={(e) => updateArg(index, { name: e.target.value })} placeholder="task" />
                  <Input value={arg.description} onChange={(e) => updateArg(index, { description: e.target.value })} placeholder="Argument description" />
                  <label className="flex items-center gap-2 text-xs text-muted-foreground">
                    <input type="checkbox" checked={arg.required} onChange={(e) => updateArg(index, { required: e.target.checked })} />
                    required
                  </label>
                  <Button type="button" variant="ghost" size="sm" onClick={() => removeArg(index)} disabled={args.length === 1}>
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              ))}
            </div>
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium">Skill instructions template</label>
            <Textarea
              value={template}
              onChange={(e) => setTemplate(e.target.value)}
              className="min-h-72 font-mono text-xs"
              required
            />
            <div className="grid gap-2 text-xs text-muted-foreground md:grid-cols-3">
              <p><strong className="text-foreground">Concise:</strong> include only context the model needs.</p>
              <p><strong className="text-foreground">Procedural:</strong> describe steps and validation.</p>
              <p><strong className="text-foreground">Safe:</strong> prefer proposing changes before applying risky ones.</p>
            </div>
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}
          <Button type="submit" disabled={loading || !normalizedName || !description.trim() || !template.trim()}>
            {loading ? "Creating..." : "Create Skill"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

function SkillFinderCard({
  onSubmit,
  onImport,
  loading,
  importing,
  error,
  importError,
  result,
  candidates,
}: {
  onSubmit: (topic: string, maxResults: number) => void;
  onImport: (candidate: SkillCreateRequest) => Promise<unknown>;
  loading: boolean;
  importing: boolean;
  error?: string;
  importError?: string;
  result?: string;
  candidates: SkillCreateRequest[];
}) {
  const [topic, setTopic] = useState("");
  const [maxResults, setMaxResults] = useState(6);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<string | null>(null);

  const selectedCandidates = candidates.filter((candidate) => selected.has(candidate.name));

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!topic.trim()) return;
    setSelected(new Set());
    setExpanded(null);
    onSubmit(topic.trim(), maxResults);
  };

  const toggleSelected = (name: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(name)) {
        next.delete(name);
      } else {
        next.add(name);
      }
      return next;
    });
  };

  const importSelected = async () => {
    for (const candidate of selectedCandidates) {
      await onImport(candidate);
    }
    setSelected(new Set());
  };

  return (
    <Card className="mb-6 border-cyan-500/30 shadow-lg shadow-cyan-500/5">
      <CardHeader>
        <div className="flex items-start gap-3">
          <div className="rounded-lg bg-cyan-500/10 p-2 text-cyan-700">
            <Search className="h-5 w-5" />
          </div>
          <div>
            <CardTitle className="text-base">Find Skills</CardTitle>
            <CardDescription className="mt-1">
              Search real GitHub SKILL.md pages, filter out issues/PRs, then import selected skills into your library.
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid gap-3 md:grid-cols-[1fr_130px_auto]">
            <Input
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              placeholder="meeting notes, architecture diagrams, research summarization..."
              required
            />
            <Input
              type="number"
              min={1}
              max={10}
              value={maxResults}
              onChange={(e) => setMaxResults(Number(e.target.value))}
            />
            <Button type="submit" disabled={loading || !topic.trim()}>
              {loading ? "Searching..." : "Find"}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Requires <code className="rounded bg-muted px-1 py-0.5">TAVILY_API_KEY</code>. Only real SKILL.md pages are importable; review before creating a local skill.
          </p>
        </form>

        {error && <p className="mt-4 text-sm text-destructive">{error}</p>}

        {candidates.length > 0 && (
          <div className="mt-4 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h3 className="text-sm font-medium">Selectable Skills</h3>
                <p className="text-xs text-muted-foreground">Choose candidates and create them into your Skills list.</p>
              </div>
              <Button type="button" size="sm" onClick={importSelected} disabled={importing || selectedCandidates.length === 0}>
                <Download className="mr-1 h-4 w-4" />
                {importing ? "Importing..." : `Import ${selectedCandidates.length || ""}`.trim()}
              </Button>
            </div>

            <div className="grid gap-3 md:grid-cols-2">
              {candidates.map((candidate) => {
                const isSelected = selected.has(candidate.name);
                const isExpanded = expanded === candidate.name;
                return (
                  <div
                    key={candidate.name}
                    className={`rounded-xl border p-3 transition-colors ${isSelected ? "border-cyan-400 bg-cyan-500/10" : "border-border bg-muted/30"}`}
                  >
                    <div className="flex items-start gap-3">
                      <input
                        type="checkbox"
                        className="mt-1"
                        checked={isSelected}
                        onChange={() => toggleSelected(candidate.name)}
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center justify-between gap-2">
                          <code className="truncate text-xs font-semibold text-foreground">/{candidate.name}</code>
                          <button
                            type="button"
                            className="text-xs text-primary hover:underline"
                            onClick={() => setExpanded(isExpanded ? null : candidate.name)}
                          >
                            {isExpanded ? "Hide" : "Preview"}
                          </button>
                        </div>
                        <p className="mt-1 line-clamp-3 text-xs leading-5 text-muted-foreground">{candidate.description}</p>
                      </div>
                    </div>
                    {isExpanded && (
                      <pre className="mt-3 max-h-56 overflow-auto whitespace-pre-wrap rounded-md bg-background p-3 text-xs leading-5 text-muted-foreground">
                        {candidate.template}
                      </pre>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {importError && <p className="mt-4 text-sm text-destructive">{importError}</p>}
        {result && candidates.length === 0 && (
          <div className="mt-4 rounded-lg border border-border bg-muted/40 p-3">
            <h3 className="mb-2 text-sm font-medium">Search Results</h3>
            <pre className="max-h-96 overflow-auto whitespace-pre-wrap text-xs leading-5 text-muted-foreground">{result}</pre>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function SkillDetails({ skill, onUse }: { skill: Skill; onUse: () => void }) {
  return (
    <div className="border-t border-border pt-3 space-y-3">
      {skill.args.length > 0 && (
        <div>
          <h4 className="text-xs font-medium text-muted-foreground mb-1">Arguments</h4>
          <div className="space-y-1">
            {skill.args.map((arg) => (
              <div key={arg.name} className="flex items-center gap-2 text-xs">
                <code className="bg-muted px-1.5 py-0.5 rounded font-mono">{arg.name}</code>
                {arg.required && <Badge variant="secondary" className="text-[9px] px-1 py-0">required</Badge>}
                {arg.description && <span className="text-muted-foreground">{arg.description}</span>}
              </div>
            ))}
          </div>
        </div>
      )}

      <div>
        <h4 className="text-xs font-medium text-muted-foreground mb-1">Template Preview</h4>
        <pre className="text-xs bg-muted/50 rounded-md p-3 overflow-x-auto max-h-60 overflow-y-auto whitespace-pre-wrap text-muted-foreground">
          {skill.template.slice(0, 500)}
          {skill.template.length > 500 && "\n..."}
        </pre>
      </div>

      <div className="flex items-center gap-4 text-[10px] text-muted-foreground">
        {skill.tools_file && (
          <span className="flex items-center gap-1">
            <Code2 className="h-3 w-3" /> {skill.tools_file}
          </span>
        )}
        {skill.file_path && (
          <span className="flex items-center gap-1">
            <FileText className="h-3 w-3" /> {skill.file_path.length > 40 ? "..." + skill.file_path.slice(-40) : skill.file_path}
          </span>
        )}
      </div>

      <button onClick={onUse} className="text-xs text-primary hover:underline">
		Use in Agent Chat &rarr;
      </button>
    </div>
  );
}
