import { useState, useEffect } from "react";
import {
  FlaskConical,
  Plus,
  Trash2,
  Copy,
  Check,
  Download,
  FileText,
  Code2,
  ChevronDown,
  ChevronRight,
  Loader2,
} from "lucide-react";
import { request } from "@/lib/api/client";
import { useAuth } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardHeader, CardContent, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Harness2ExperimentLab } from "@/components/Harness2ExperimentLab";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

interface LabExperiment {
  id: string;
  name: string;
  description: string | null;
  status: string;
  created_at: string;
  updated_at: string | null;
}

interface Step {
  text: string;
}

interface LabExperimentList {
  items: LabExperiment[];
}

interface ExperimentToSkillResult {
  skill_markdown: string;
  workflow_yaml: string;
  skill_name: string;
  note_id: string | null;
}

export function LabPage() {
  const { user } = useAuth();

  // ── Experiment list ──
  const [experiments, setExperiments] = useState<LabExperiment[]>([]);
  const [loading, setLoading] = useState(true);

  // ── New experiment form ──
  const [showForm, setShowForm] = useState(false);
  const [experimentName, setExperimentName] = useState("");
  const [description, setDescription] = useState("");
  const [steps, setSteps] = useState<Step[]>([{ text: "" }]);
  const [outputSections, setOutputSections] = useState("");
  const [constraints, setConstraints] = useState("");
  const [toolsUsed, setToolsUsed] = useState("");
  const [modelProvider, setModelProvider] = useState("qwen");
  const [modelName, setModelName] = useState("qwen-plus");
  const [temperature, setTemperature] = useState("0.3");
  const [saveAsNote, setSaveAsNote] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // ── Result ──
  const [result, setResult] = useState<ExperimentToSkillResult | null>(null);
  const [viewMode, setViewMode] = useState<"markdown" | "yaml">("markdown");
  const [copied, setCopied] = useState(false);

  // ── Load experiments ──
  const loadExperiments = async () => {
    try {
      setLoading(true);
      const res = await request<LabExperimentList>("/lab/experiments");
      setExperiments(res.items ?? []);
    } catch {
      // Keep the page usable when the Lab endpoint is unavailable.
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadExperiments(); }, []);

  // ── Submit ──
  const handleSubmit = async () => {
    if (!experimentName.trim() || !description.trim() || steps.every((s) => !s.text.trim())) return;
    setSubmitting(true);
    try {
      const res = await request<ExperimentToSkillResult>("/lab/experiment-to-skill", { method: "POST", body: JSON.stringify({
        experiment_name: experimentName,
        description: description,
        steps: steps.filter((s) => s.text.trim()).map((s) => s.text.trim()),
        output_sections: outputSections
          .split("\n")
          .filter((l) => l.trim()),
        constraints: constraints
          .split("\n")
          .filter((l) => l.trim()),
        tools_used: toolsUsed
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean),
        model_provider: modelProvider,
        model_name: modelName,
        temperature: parseFloat(temperature) || 0.3,
        save_as_note: saveAsNote,
      }) });
      setResult(res);
      setShowForm(false);
      loadExperiments();
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : "Conversion failed");
    } finally {
      setSubmitting(false);
    }
  };

  // ── Copy ──
  const handleCopy = async () => {
    const text = viewMode === "markdown" ? result?.skill_markdown : result?.workflow_yaml;
    if (!text) return;
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // ── Download ──
  const handleDownload = () => {
    const ext = viewMode === "markdown" ? "md" : "yml";
    const text = viewMode === "markdown" ? result?.skill_markdown : result?.workflow_yaml;
    if (!text) return;
    const blob = new Blob([text], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${result?.skill_name || "skill"}.${ext}`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // ── Step handlers ──
  const addStep = () => setSteps([...steps, { text: "" }]);
  const removeStep = (i: number) => {
    if (steps.length <= 1) return;
    setSteps(steps.filter((_, idx) => idx !== i));
  };
  const updateStep = (i: number, text: string) => {
    setSteps(steps.map((s, idx) => (idx === i ? { text } : s)));
  };

  if (!user) return null;

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold">
            <FlaskConical className="h-6 w-6 text-purple-500" />
            Experiment Lab
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Design agent experiments, validate improvements, and produce both Skill and Workflow outputs.
          </p>
        </div>
      </div>

      <Tabs defaultValue="harness2">
        <TabsList><TabsTrigger value="harness2">隔离对比实验</TabsTrigger><TabsTrigger value="skills">Skill / Workflow</TabsTrigger></TabsList>
        <TabsContent value="harness2"><Harness2ExperimentLab /></TabsContent>
        <TabsContent value="skills" className="space-y-6">
        {!showForm && <Button onClick={() => setShowForm(true)}><Plus className="mr-1 h-4 w-4" />New Experiment</Button>}

      {/* ── New Experiment Form ── */}
      {showForm && (
        <Card>
          <CardHeader>
            <CardTitle>Design a New Experiment</CardTitle>
            <CardDescription>
              Define the experiment steps to generate both a PKG Skill and a Harness Workflow.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="text-sm font-medium">Experiment name</label>
                <Input
                  placeholder="For example: research-topic-validated"
                  value={experimentName}
                  onChange={(e) => setExperimentName(e.target.value)}
                />
              </div>
              <div>
                <label className="text-sm font-medium">Model</label>
                <div className="flex gap-2">
                  <Input
                    placeholder="provider"
                    value={modelProvider}
                    onChange={(e) => setModelProvider(e.target.value)}
                    className="w-1/3"
                  />
                  <Input
                    placeholder="model"
                    value={modelName}
                    onChange={(e) => setModelName(e.target.value)}
                    className="flex-1"
                  />
                  <Input
                    placeholder="temp"
                    value={temperature}
                    onChange={(e) => setTemperature(e.target.value)}
                    className="w-20"
                  />
                </div>
              </div>
            </div>

            <div>
              <label className="text-sm font-medium">Description</label>
              <Textarea
                placeholder="Describe the experiment's purpose and behavior..."
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={2}
              />
            </div>

            <div>
              <label className="mb-2 block text-sm font-medium">Execution steps</label>
              <div className="space-y-2">
                {steps.map((step, i) => (
                  <div key={i} className="flex gap-2">
                    <span className="flex h-9 w-8 items-center justify-center rounded border text-xs text-muted-foreground">
                      {i + 1}
                    </span>
                    <Input
                      placeholder={`Step ${i + 1}: search with pkg_search...`}
                      value={step.text}
                      onChange={(e) => updateStep(i, e.target.value)}
                      className="flex-1"
                    />
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => removeStep(i)}
                      disabled={steps.length <= 1}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                ))}
              </div>
              <Button variant="outline" size="sm" className="mt-2" onClick={addStep}>
                <Plus className="mr-1 h-3 w-3" /> Add Step
              </Button>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="text-sm font-medium">Output sections (one per line)</label>
                <Textarea
                  placeholder="Key Findings&#10;Memory Connections&#10;Knowledge Gaps&#10;Recommended Actions"
                  value={outputSections}
                  onChange={(e) => setOutputSections(e.target.value)}
                  rows={4}
                />
              </div>
              <div>
                <label className="text-sm font-medium">Constraints (one per line)</label>
                <Textarea
                  placeholder="Search PKG first; do not skip retrieval&#10;Cite sources at every step"
                  value={constraints}
                  onChange={(e) => setConstraints(e.target.value)}
                  rows={4}
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="text-sm font-medium">Tools used (comma-separated)</label>
                <Input
                  placeholder="pkg_search, pkg_read_note, pkg_save_document"
                  value={toolsUsed}
                  onChange={(e) => setToolsUsed(e.target.value)}
                />
              </div>
              <div className="flex items-end">
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={saveAsNote}
                    onChange={(e) => setSaveAsNote(e.target.checked)}
                    className="h-4 w-4"
                  />
                  Also save as a PKG Note
                </label>
              </div>
            </div>

            <div className="flex gap-2">
              <Button onClick={handleSubmit} disabled={submitting}>
                {submitting && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
                Generate Skill + Workflow
              </Button>
              <Button variant="ghost" onClick={() => setShowForm(false)}>
                Cancel
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* ── Result ── */}
      {result && (
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="flex items-center gap-2">
                  <FlaskConical className="h-5 w-5 text-green-500" />
                  {result.skill_name}
                </CardTitle>
                {result.note_id && (
                  <p className="text-xs text-muted-foreground">Note: {result.note_id}</p>
                )}
              </div>
              <div className="flex gap-2">
                <div className="flex rounded border">
                  <button
                    onClick={() => setViewMode("markdown")}
                    className={`flex items-center gap-1 rounded-l px-3 py-1 text-xs ${
                      viewMode === "markdown" ? "bg-primary text-primary-foreground" : ""
                    }`}
                  >
                    <FileText className="h-3 w-3" /> Skill .md
                  </button>
                  <button
                    onClick={() => setViewMode("yaml")}
                    className={`flex items-center gap-1 rounded-r px-3 py-1 text-xs ${
                      viewMode === "yaml" ? "bg-primary text-primary-foreground" : ""
                    }`}
                  >
                    <Code2 className="h-3 w-3" /> Workflow .yml
                  </button>
                </div>
                <Button variant="outline" size="sm" onClick={handleCopy}>
                  {copied ? <Check className="mr-1 h-3 w-3" /> : <Copy className="mr-1 h-3 w-3" />}
                  {copied ? "Copied" : "Copy"}
                </Button>
                <Button variant="outline" size="sm" onClick={handleDownload}>
                  <Download className="mr-1 h-3 w-3" /> Download
                </Button>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <pre className="max-h-96 overflow-auto rounded bg-muted p-4 text-xs whitespace-pre-wrap">
              {viewMode === "markdown" ? result.skill_markdown : result.workflow_yaml}
            </pre>
          </CardContent>
        </Card>
      )}

      {/* ── Experiment History ── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Experiment History</CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <p className="text-sm text-muted-foreground">Loading...</p>
          ) : experiments.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No experiments have been generated yet. Design your first experiment.
            </p>
          ) : (
            <div className="space-y-2">
              {experiments.map((exp) => (
                <div
                  key={exp.id}
                  className="flex items-center justify-between rounded border p-3"
                >
                  <div>
                    <p className="font-medium">{exp.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {exp.description} · {exp.created_at?.slice(0, 10)}
                    </p>
                  </div>
                  <Badge variant="outline">{exp.status}</Badge>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── Quick Reference ── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Experiment Lab Workflow</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-3 gap-4 text-sm">
            <div className="space-y-1 rounded border p-3">
              <span className="font-mono text-xs text-purple-500">Phase 1</span>
              <p className="font-medium">Experiment in Harness</p>
              <p className="text-xs text-muted-foreground">
                Design prompts, run experiments, and inspect the Trajectory View in the DeepSeek Harness Web UI.
              </p>
            </div>
            <div className="space-y-1 rounded border p-3">
              <span className="font-mono text-xs text-purple-500">Phase 2</span>
              <p className="font-medium">Generate Both Outputs</p>
              <p className="text-xs text-muted-foreground">
                Define experiment steps here to generate a PKG Skill .md and Harness Workflow .yml.
              </p>
            </div>
            <div className="space-y-1 rounded border p-3">
              <span className="font-mono text-xs text-purple-500">Phase 3</span>
              <p className="font-medium">Validate and Compare</p>
              <p className="text-xs text-muted-foreground">
                Tune the Skill in PKG, fork the experiment in Harness, and compare outcomes.
              </p>
            </div>
          </div>
        </CardContent>
      </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
