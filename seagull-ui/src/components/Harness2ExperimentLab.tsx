import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { FlaskConical, Loader2, RefreshCw } from "lucide-react";
import { harness2Api, type ExperimentCase, type ExperimentOutput, type ExperimentStatus, type ExperimentWinner } from "@/lib/api/harness2";
import { useAuth } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

const labels: Record<ExperimentStatus, string> = {
  prepared: "方案已准备", train_running: "训练样例执行中", awaiting_review: "等待人工评审 / 复验",
  holdout_running: "新素材复验中", completed: "执行完成，待确认结论", stopped: "已停止",
  outcome_unknown: "调用结果未知，已锁定", interrupted: "进程中断，请核查",
};
const winners: Record<ExperimentWinner, string> = { baseline: "A 更好", candidate: "B 更好", tie: "差不多", neither: "都不行" };
const active = (status?: ExperimentStatus) => status === "train_running" || status === "holdout_running";
const display = (value: string | number | null | undefined) => value ?? "未知";

function errorText(error: unknown) {
  return error instanceof Error ? error.message : "操作未获确认，请刷新核查；未自动重试。";
}

function Output({ title, output }: { title: string; output: ExperimentOutput }) {
  const response = output.response;
  return <section className="min-w-0 space-y-3 rounded-lg border p-4" aria-label={title}>
    <h4 className="font-medium">{title}</h4>
    {response ? <>
      <p className="text-xs text-muted-foreground">{response.model} · 输入 {display(response.input_tokens)} / 输出 {display(response.output_tokens)} Token</p>
      <p className="text-xs text-muted-foreground">耗时 {display(response.elapsed_ms)} ms · 重试 {display(response.retry_count)} 次 · 估算 {display(output.estimated_cny)} 元</p>
      <div className="max-h-[32rem] overflow-auto whitespace-pre-wrap break-words text-sm leading-7">{response.text}</div>
    </> : <p className="text-sm text-muted-foreground">{output.status === "not_started" ? "尚未生成，不代表失败。" : output.status === "outcome_unknown" ? "调用结果未知，请核查服务商账单，不可自动重试。" : "请求已登记，尚未获得可确认的完整结果。"}</p>}
  </section>;
}

function CaseReview({ item, experimentId, allowed, onSaved }: { item: ExperimentCase; experimentId: string; allowed: boolean; onSaved: () => Promise<void> }) {
  const [winner, setWinner] = useState<ExperimentWinner>("tie");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const complete = Object.values(item.outputs).every(output => output.response && output.status === "completed");
  const save = async () => {
    setBusy(true);
    setError("");
    try {
      await harness2Api.review(experimentId, item.id, winner, reason.trim());
      await onSaved();
    } catch (caught) { setError(errorText(caught)); }
    finally { setBusy(false); }
  };
  return <Card>
    <CardHeader>
      <CardTitle className="text-base">{item.split === "train" ? "训练样例" : "留出复验"} · {item.id}</CardTitle>
      <CardDescription>核对事实、限定条件、无依据补写、可读性，以及达到可发表状态仍需哪些修改。</CardDescription>
    </CardHeader>
    <CardContent className="space-y-4">
      <details><summary className="cursor-pointer text-sm">查看虚构素材</summary><p className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap text-sm">{item.material ?? "留出素材在复验阶段才展示，避免提前针对它调整候选。"}</p></details>
      <div className="grid gap-4 lg:grid-cols-2"><Output title="A · 当前提示词" output={item.outputs.baseline} /><Output title="B · 人工候选提示词" output={item.outputs.candidate} /></div>
      {item.review ? <div className="rounded-lg bg-muted p-3 text-sm"><strong>人工取舍：{winners[item.review.winner]}</strong><p className="mt-1 whitespace-pre-wrap break-words">{item.review.reason}</p><p className="mt-2 text-xs text-muted-foreground">已保存，不可覆盖；不会自动应用到生产。</p></div>
        : complete && allowed ? <div className="space-y-3">
          <label className="block text-sm">人工取舍
            <select aria-label={`人工取舍 ${item.id}`} value={winner} onChange={event => setWinner(event.target.value as ExperimentWinner)} className="ml-3 rounded border bg-background p-2">
              {Object.entries(winners).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </label>
          <Textarea aria-label={`取舍原因 ${item.id}`} placeholder="说明你的判断，以及仍需手动修改的地方；更长或更自信不等于更好。" value={reason} onChange={event => setReason(event.target.value)} maxLength={4000} />
          <Button size="sm" disabled={busy || !reason.trim()} onClick={save}>{busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}保存本组评审</Button>
        </div> : <p className="text-xs text-muted-foreground">阶段执行完成且 A/B 输出齐全后，才能记录人工评审。</p>}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    </CardContent>
  </Card>;
}

export function Harness2ExperimentLab() {
  const { user } = useAuth();
  const client = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [budget, setBudget] = useState("2");
  const [preflight, setPreflight] = useState<Awaited<ReturnType<typeof harness2Api.preflight>> | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [noteId, setNoteId] = useState<string | null>(null);
  const list = useQuery({ queryKey: ["harness2", user?.id, "list"], queryFn: harness2Api.list, retry: false, refetchOnWindowFocus: false });
  const detail = useQuery({ queryKey: ["harness2", user?.id, "detail", selectedId], queryFn: () => harness2Api.get(selectedId!), enabled: !!selectedId, retry: false, refetchOnWindowFocus: false,
    refetchInterval: query => active(query.state.data?.status) ? 2500 : false });
  const experiment = detail.data;
  const running = active(experiment?.status);
  const phase = experiment?.status === "prepared" ? "train" : "holdout";
  const trainReviewed = experiment?.cases.filter(item => item.split === "train").every(item => !!item.review);
  const canPlan = experiment?.status === "prepared" || (experiment?.status === "awaiting_review" && trainReviewed);
  useEffect(() => { setPreflight(null); setConfirmed(false); setError(""); setNoteId(null); setBudget("2"); }, [selectedId]);
  useEffect(() => { setPreflight(null); setConfirmed(false); }, [budget, experiment?.status]);
  useEffect(() => {
    if (experiment?.status) void client.invalidateQueries({ queryKey: ["harness2", user?.id, "list"] });
  }, [client, user?.id, experiment?.status]);
  const refresh = async () => { await client.invalidateQueries({ queryKey: ["harness2", user?.id] }); };
  const perform = async (action: () => Promise<void>) => {
    setBusy(true); setError("");
    try { await action(); }
    catch (caught) { setError(errorText(caught)); }
    finally { setBusy(false); }
  };
  const create = () => perform(async () => {
    const created = await harness2Api.create();
    await refresh();
    setSelectedId(created.id);
  });
  const plan = () => perform(async () => {
    setConfirmed(false);
    setPreflight(null);
    setPreflight(await harness2Api.preflight(selectedId!, phase, experiment?.budget_cny ?? budget));
  });
  const start = () => perform(async () => {
    const token = preflight?.preflight_id;
    if (!token || !confirmed) return;
    setPreflight(null); setConfirmed(false);
    try { await harness2Api.start(selectedId!, token); }
    finally { await refresh(); }
  });
  return <div className="space-y-5">
    <Card>
      <CardHeader><CardTitle className="flex items-center gap-2 text-base"><FlaskConical className="h-5 w-5" />Harness² 隔离试验</CardTitle>
        <CardDescription>当前接入 Newsletter 单篇深度解读的提示词 A/B，不是完整 Harness² 自动优化循环。B 为人工候选，不会自动改你的系统。</CardDescription></CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p>准备方案 → 预算预检 → 明确确认 → 3 组 A/B → 人工评审 → 1 组新素材复验 → 保存结论</p>
        <p className="text-muted-foreground">仅发送内置虚构素材；不连接生产知识库、现有 Harness 会话、TTS 或微信。不自动重试或提升生产配置。独立进程不是容器安全沙箱。</p>
        <details><summary className="cursor-pointer">首次使用：配置执行权限和专用 Key</summary><div className="mt-2 space-y-2 text-muted-foreground">
          <p>在 BFF 的 <code>bff/.env</code> 配置 <code>HARNESS2_LAB_EXECUTION_ENABLED=true</code>，并配置 <code>HARNESS2_LAB_KEY_FILE</code> 指向仅本人可读写的 <code>/tmp/seagull-harness2-key-*</code> 文件。也可使用专用变量 <code>HARNESS2_DEEPSEEK_API_KEY</code>。</p>
          <p>不要在页面、笔记或聊天中粘贴 Key；不使用生产通用 Key。配置生效需要重启 BFF，不需要重启 PKG 或 Harness。价格策略过期时仍会阻止运行，不能只修改到期时间。</p>
        </div></details>
        <div className="flex flex-wrap gap-2"><Button disabled={busy} onClick={create}>新建 Newsletter 对比实验</Button><Button variant="outline" disabled={busy} onClick={() => perform(refresh)}><RefreshCw className="mr-2 h-4 w-4" />刷新记录</Button></div>
      </CardContent>
    </Card>
    {(error || list.error || detail.error) && <p role="alert" className="rounded border border-destructive p-3 text-sm text-destructive">{error || errorText(list.error || detail.error)}</p>}
    {list.isLoading ? <p>正在加载实验…</p> : list.data?.items.length ? <label className="block text-sm">选择实验
      <select className="mt-2 block w-full rounded border bg-background p-2" aria-label="选择实验" value={selectedId ?? ""} disabled={busy} onChange={event => setSelectedId(event.target.value || null)}>
        <option value="">请选择实验</option>{list.data.items.map(item => <option key={item.id} value={item.id}>{item.name} · {labels[item.status]} · {item.created_at.slice(0, 16)} · {item.id.slice(0, 8)}</option>)}
      </select>
    </label> : !list.error && <p className="text-sm text-muted-foreground">暂无页面实验记录。命令行已有实验不会自动导入或继承计费授权；新建方案本身不调用模型。</p>}
    {detail.isLoading && selectedId && <p>正在读取实验详情…</p>}
    {experiment && <>
      <Card><CardHeader><CardTitle className="flex flex-wrap items-center gap-3 text-base">{experiment.name}<Badge variant="outline">{labels[experiment.status]}</Badge></CardTitle><CardDescription>实验 {experiment.id}</CardDescription></CardHeader>
        <CardContent className="space-y-4 text-sm">
          <p>已登记调用 {experiment.attempts} 次 · 估算费用 {display(experiment.spent_estimate_cny)} 元 · 已用及保守预留 {experiment.spent_or_reserved_cny} 元</p>
          <p className="text-xs text-muted-foreground">Token 和费用来自服务商响应及本地估算，未经账单核验；预算不是服务商侧硬限额。未知费用不是零。</p>
          {experiment.message && <p role="status" className="rounded border p-3">{experiment.message}</p>}
          {running && <p role="status" className="flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" />实验独立执行中，关闭页面不会取消；这里只轮询状态，不重复发起模型调用。</p>}
          {canPlan && <div className="space-y-3 rounded border p-3">
            <p className="font-medium">{phase === "train" ? "启动前：先做不计费的本地预检" : "三组人工评审已完成，可单独确认新素材复验"}</p>
            <label className="flex items-center gap-3">本实验总预算（元，最多 2 元）<Input className="max-w-24" aria-label="实验总预算" type="number" min="0.01" max="2" step="0.01" value={experiment.budget_cny ?? budget} disabled={busy || !!experiment.budget_cny} onChange={event => setBudget(event.target.value)} /></label>
            <Button variant="outline" disabled={busy} onClick={plan}>预算与配置预检（不调用模型）</Button>
          </div>}
          {experiment.status === "awaiting_review" && !trainReviewed && <p>请先完成下面三组人工评审，才能预检留出复验。</p>}
          {preflight && <div className="space-y-3 rounded border p-3" aria-label="预检结果">
            <p>预检发送请求：{preflight.network_requests_sent} 次</p>
            {preflight.model && <p>模型 {preflight.model} · 本阶段 {preflight.requests} 次请求 · 保守预留 {preflight.phase_reservation_cny} 元</p>}
            {preflight.pricing_expires_at && <p>价格策略有效期至 {preflight.pricing_expires_at}；到期必须重新核价。</p>}
            {preflight.blockers.map((blocker, index) => <p className="text-destructive" key={index}>{blocker}</p>)}
            {preflight.ready && <>
              <label className="flex items-start gap-2"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />我确认发送内置虚构素材，并授权本实验总预算 {preflight.budget_cny} 元内的本阶段计费；不自动重试或应用生产。</label>
              {user?.role === "admin" ? <Button disabled={busy || !confirmed} onClick={start}>确认并运行{preflight.phase === "train" ? "训练对比" : "新素材复验"}</Button> : <p>需管理员启动计费任务。</p>}
            </>}
          </div>}
          <details><summary className="cursor-pointer">查看两套只读提示词</summary><div className="mt-3 grid gap-4 lg:grid-cols-2">{(["baseline", "candidate"] as const).map(variant => <div key={variant}><h4>{variant === "baseline" ? "A · 当前版本快照" : "B · 人工候选"}</h4><pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded bg-muted p-3 text-xs">{experiment.prompts[variant]}</pre></div>)}</div></details>
          <Button variant="outline" disabled={busy || running} onClick={() => perform(async () => { const result = await harness2Api.saveNote(experiment.id); setNoteId(result.note_id); })}>将当前实验报告保存为 Note</Button>
          {noteId && <p>报告已保存：<Link className="underline" to={`/notes/${encodeURIComponent(noteId)}`}>打开实验 Note</Link></p>}
        </CardContent>
      </Card>
      {experiment.cases.map(item => <CaseReview key={`${experiment.id}:${item.id}`} item={item} experimentId={experiment.id} allowed={!running} onSaved={async () => { setPreflight(null); setNoteId(null); await refresh(); }} />)}
      <p className="text-sm text-muted-foreground">小规模虚构样例不证明真实发布效果。复验后仍需人工决定是否进一步验证；这里没有自动应用、发布或启用 Skill 的入口。</p>
    </>}
  </div>;
}
