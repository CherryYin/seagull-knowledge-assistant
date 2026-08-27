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
      // lab 端点不存在时静默
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
      alert(err instanceof Error ? err.message : "转化失败");
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
            设计 agent 实验 → 调优验证 → 固化为 Skill + Workflow 双输出
          </p>
        </div>
        {!showForm && (
          <Button onClick={() => setShowForm(true)}>
            <Plus className="mr-1 h-4 w-4" />
            新实验
          </Button>
        )}
      </div>

      {/* ── New Experiment Form ── */}
      {showForm && (
        <Card>
          <CardHeader>
            <CardTitle>设计新实验</CardTitle>
            <CardDescription>
              填写实验步骤，系统将自动生成 PKG Skill + Harness Workflow 双输出。
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="text-sm font-medium">实验名称</label>
                <Input
                  placeholder="如 research-topic-validated"
                  value={experimentName}
                  onChange={(e) => setExperimentName(e.target.value)}
                />
              </div>
              <div>
                <label className="text-sm font-medium">模型</label>
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
              <label className="text-sm font-medium">描述</label>
              <Textarea
                placeholder="这个实验的目的和功能..."
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={2}
              />
            </div>

            <div>
              <label className="mb-2 block text-sm font-medium">执行步骤</label>
              <div className="space-y-2">
                {steps.map((step, i) => (
                  <div key={i} className="flex gap-2">
                    <span className="flex h-9 w-8 items-center justify-center rounded border text-xs text-muted-foreground">
                      {i + 1}
                    </span>
                    <Input
                      placeholder={`步骤 ${i + 1}: 用 pkg_search 搜索...`}
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
                <Plus className="mr-1 h-3 w-3" /> 添加步骤
              </Button>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="text-sm font-medium">输出 Sections（每行一个）</label>
                <Textarea
                  placeholder="核心发现&#10;记忆关联&#10;知识缺口&#10;建议行动"
                  value={outputSections}
                  onChange={(e) => setOutputSections(e.target.value)}
                  rows={4}
                />
              </div>
              <div>
                <label className="text-sm font-medium">约束条件（每行一个）</label>
                <Textarea
                  placeholder="先搜 PKG，不要跳过检索&#10;每步标注来源"
                  value={constraints}
                  onChange={(e) => setConstraints(e.target.value)}
                  rows={4}
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="text-sm font-medium">使用工具（逗号分隔）</label>
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
                  同时保存为 PKG Note
                </label>
              </div>
            </div>

            <div className="flex gap-2">
              <Button onClick={handleSubmit} disabled={submitting}>
                {submitting && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
                固化为 Skill + Workflow
              </Button>
              <Button variant="ghost" onClick={() => setShowForm(false)}>
                取消
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
                  {copied ? "已复制" : "复制"}
                </Button>
                <Button variant="outline" size="sm" onClick={handleDownload}>
                  <Download className="mr-1 h-3 w-3" /> 下载
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
          <CardTitle className="text-base">历史实验</CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <p className="text-sm text-muted-foreground">加载中...</p>
          ) : experiments.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              还没有固化过的实验。设计你的第一个实验吧。
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
              <p className="font-medium">Harness 中实验</p>
              <p className="text-xs text-muted-foreground">
                在 DeepSeek Harness Web UI 中设计 prompt，跑实验，观察 Trajectory View。
              </p>
            </div>
            <div className="space-y-1 rounded border p-3">
              <span className="font-mono text-xs text-purple-500">Phase 2</span>
              <p className="font-medium">固化为双输出</p>
              <p className="text-xs text-muted-foreground">
                在此页面填写实验步骤，系统自动生成 PKG Skill .md + Harness Workflow .yml。
              </p>
            </div>
            <div className="space-y-1 rounded border p-3">
              <span className="font-mono text-xs text-purple-500">Phase 3</span>
              <p className="font-medium">验证 & 对比</p>
              <p className="text-xs text-muted-foreground">
                在 PKG 中调 skill，在 Harness 中 fork 实验，对比效果差异。
              </p>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
