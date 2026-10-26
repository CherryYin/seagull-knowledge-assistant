import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { authApi, podcastsApi, type PodcastAudioPreflight as AudioPreflight, type PodcastDraft, type PodcastAudioRenderRequest } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { readAudioReceipt } from "@/lib/podcast-audio";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PodcastScrollRegion } from "@/components/PodcastScrollRegion";

export function PodcastAudioPreflight({ draft, disabled, taskRevision = 0 }: { draft?: PodcastDraft; disabled: boolean; taskRevision?: number }) {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const receiptKey = user && draft ? `podcast-audio-submit:${user.id}:${draft.asset_id}` : "";
  const [pending, setPending] = useState<PodcastAudioRenderRequest | null>(null);
  const [submissionError, setSubmissionError] = useState("");
  const [submissionStatus, setSubmissionStatus] = useState("");
  const [textConsent, setTextConsent] = useState(false);
  const [billingConsent, setBillingConsent] = useState(false);
  const [credentialId, setCredentialId] = useState("");
  const [budget, setBudget] = useState("2");
  const [price, setPrice] = useState("");
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  const [report, setReport] = useState<{ basis: string; value: AudioPreflight } | null>(null);
  const credentials = useQuery({ queryKey: ["podcast-audio-credentials"], queryFn: () => authApi.listMyApiCredentials(), enabled: Boolean(draft), retry: false });
  const selected = credentials.data?.items.find(credential => credential.id === Number(credentialId));
  const basis = JSON.stringify([draft?.asset_id, draft?.input_hash, draft?.latest_approval?.id, draft?.approval_status, credentialId, selected?.is_enabled, selected?.updated_at, selected?.secret_masked, selected?.config?.region, budget, price, taskRevision]);
  const latest = useRef({ basis, disabled });
  latest.current = { basis, disabled };
  const stale = Boolean(report && (report.basis !== basis || disabled));
  const approved = draft?.approval_status === "current" && !draft.approval_issues.length;
  const validBudget = /^\d+(?:\.\d{1,4})?$/.test(budget) && Number(budget) > 0 && Number(budget) <= 2;
  const validPrice = !price || (/^\d+(?:\.\d{1,6})?$/.test(price) && Number(price) > 0 && Number(price) <= 10000);
  const ready = Boolean(report && !stale && report.value.audio_generation_available && report.value.checks_passed);
  const generationBlocker = !draft ? "请先创建并保存播客，再确认口播稿。"
    : disabled ? "当前稿件有未保存修改、正在处理或已归档；请先保存并确认，归档稿件不可生成音频。"
    : !approved ? "请先确认已保存的口播稿。"
    : !report ? "请选择本人 Qwen 凭据、填写账户单价，然后点击「检查分段与预算（不扣费）」。"
    : stale ? "稿件、凭据、预算或任务状态已变化，请重新预检。"
    : !report.value.audio_generation_available ? "服务端尚未开放音频执行，请检查部署开关、价格策略有效期和 ffmpeg；预检不会生成音频。"
    : !report.value.checks_passed ? "预检尚未通过，请处理上方待处理项后重新预检。"
    : pending || submissionError ? "请先核对上次提交结果，避免重复创建音频任务。"
    : !textConsent || !billingConsent ? "请勾选文本发送授权与计费确认，才能生成音频。"
    : "已准备就绪，点击生成后还需确认本次授权；不会自动重试。";

  useEffect(() => { setTextConsent(false); setBillingConsent(false); }, [basis]);

  useEffect(() => {
    setPending(null); setSubmissionError("");
    if (receiptKey) {
      try { setPending(readAudioReceipt(receiptKey)); }
      catch (reason) { setSubmissionError(String(reason)); }
    }
  }, [receiptKey]);

  const submit = async (body: PodcastAudioRenderRequest) => {
    if (!draft || !receiptKey || running) return;
    setRunning(true); setSubmissionError(""); setSubmissionStatus("");
    let sent = false;
    try {
      localStorage.setItem(receiptKey, JSON.stringify(body));
      setPending(body);
      sent = true;
      const task = await podcastsApi.createAudioRender(draft.asset_id, body);
      setSubmissionStatus(`音频任务已登记：${task.id} · ${task.status}。排队任务需由已启用的音频 Worker 执行。`);
      localStorage.removeItem(receiptKey);
      setPending(null); setReport(null); setTextConsent(false); setBillingConsent(false);
      await queryClient.invalidateQueries({ queryKey: ["podcast-audio-renders", draft.asset_id] });
    } catch (reason) { setSubmissionError(sent ? `${String(reason)} 提交结果未确认，请使用同一回执重试，不要另建任务。` : `${String(reason)} 本地回执无法保存，未提交音频任务。`); }
    finally { setRunning(false); }
  };

  const authorize = () => {
    if (!report || stale || disabled || pending || submissionError || !textConsent || !billingConsent || !report.value.audio_generation_available || !report.value.checks_passed) return;
    if (!window.confirm(`授权把本期冻结口播文本发送给 Qwen，并创建一次预算 ${budget} 元的音频任务？已有成功调用可能已计费，新任务会重新合成。实际账单可能与估算不同；超时不会自动重试。`)) return;
    void submit({ base_input_hash: report.value.input_hash, budget_limit: budget, credential_id: credentialId ? Number(credentialId) : null, price_per_10k_characters: price || null,
      execution_fingerprint: report.value.execution_fingerprint, idempotency_key: crypto.randomUUID(), authorize_text_to_provider: true, acknowledge_billing_uncertainty: true });
  };

  const preflight = async () => {
    if (!draft || disabled || !approved || !validBudget || !validPrice || running) return;
    setRunning(true); setError(""); setReport(null);
    try {
      const value = await podcastsApi.preflightAudio(draft.asset_id, {
        base_input_hash: draft.input_hash,
        budget_limit: budget,
        credential_id: credentialId ? Number(credentialId) : null,
        price_per_10k_characters: price || null,
      });
      if (latest.current.basis !== basis || latest.current.disabled) throw new Error("稿件、凭据、预算或任务状态已变化，本次预检结果未采用，请重新预检。");
      if (value.asset_id !== draft.asset_id || value.input_hash !== draft.input_hash || value.script_approval_id !== draft.latest_approval?.id) throw new Error("预检未绑定当前已确认版本，请重新加载后重试。");
      setReport({ basis, value });
    } catch (reason) { setError(String(reason)); }
    finally { setRunning(false); }
  };

  return <section id="podcast-audio-generation" tabIndex={-1} className="space-y-4 rounded border p-5" data-testid="podcast-audio-preflight">
    <h2 className="text-lg font-semibold">生成音频 · 预算预检与授权</h2>
    <p className="text-sm text-muted-foreground">保存播客 → 确认口播稿 → 选择凭据并预检 → 授权生成 → 在任务列表下载 MP3。</p>
    <p className="text-sm text-muted-foreground">仅检查已确认稿的分段、本人凭据和预算，不创建任务、不发送文本给服务商，也不扣费。预检通过不代表已授权生成。</p>
    {pending && <div className="space-y-2 rounded border p-3"><p className="text-sm">上次提交结果尚未确认，回执已保留；不会自动重发。重试沿用同一授权和幂等键，若上次未受理可能创建原任务。</p><Button variant="outline" disabled={running} onClick={() => { if (window.confirm("重试上次同一授权？若服务端已受理则返回原任务，不创建新任务；若未受理则可能登记原先授权的任务。")) void submit(pending); }}>重试同一音频提交</Button></div>}
    {submissionStatus && <p role="status" className="text-sm">{submissionStatus}</p>}
    {submissionError && <div role="alert" className="text-sm text-destructive">{submissionError}<Button variant="outline" size="sm" disabled={running} onClick={() => { if (receiptKey && window.confirm("已核对服务器任务列表？清除回执不取消已登记的任务，也不证明未计费。")) { try { localStorage.removeItem(receiptKey); setPending(null); setSubmissionError(""); } catch (reason) { setSubmissionError(String(reason)); } } }}>核对任务后清除本地回执</Button></div>}
    {!draft || !approved || disabled ? <p className="text-sm">请先保存并确认当前口播稿，归档稿件不可执行预检。</p> : null}
    <div className="grid gap-4 md:grid-cols-3">
      <label className="space-y-2">本人 Qwen 凭据<select aria-label="音频 Qwen 凭据" className="block w-full rounded border bg-background p-2" value={credentialId} disabled={running || disabled} onChange={event => setCredentialId(event.target.value)}>
        <option value="">尚未选择（不会使用服务器密钥）</option>
        {credentials.data?.items.filter(credential => credential.provider === "qwen").map(credential => <option key={credential.id} value={credential.id} disabled={!credential.is_enabled}>{credential.label} · {credential.secret_masked}{credential.is_enabled ? "" : " · 已停用"}</option>)}
      </select></label>
      <label className="space-y-2">本次预算上限（元）<Input aria-label="音频预算上限" type="number" min="0.0001" max="2" step="0.0001" value={budget} disabled={running || disabled} onChange={event => setBudget(event.target.value)} /></label>
      <label className="space-y-2">账户适用单价（元 / 万字符）<Input aria-label="音频账户单价" type="number" min="0.000001" max="10000" step="0.000001" placeholder="留空表示未知，不是零" value={price} disabled={running || disabled} onChange={event => setPrice(event.target.value)} /></label>
    </div>
    <p className="text-sm text-muted-foreground">请自行核对服务商账户适用价格；系统不内置未经核验的报价。当前预算最多 2 元，且不是对后续调用的扣费授权。凭据配置在 <Link className="underline" to="/settings/api-keys">Settings → API Keys</Link>；此处不会解密密钥或测试远端权限。</p>
    {credentials.isPending && draft && <p role="status">正在加载本人凭据…</p>}
    {credentials.isError && <p role="alert">凭据列表加载失败：{credentials.error.message}<Button variant="outline" size="sm" onClick={() => void credentials.refetch()}>重试凭据</Button></p>}
    {!validBudget && <p className="text-sm text-destructive">预算须大于 0、不超过 2 元，最多 4 位小数。</p>}
    {!validPrice && <p className="text-sm text-destructive">单价须大于 0、不超过 10000 元 / 万字符，最多 6 位小数；未知请留空。</p>}
    <Button disabled={!draft || !approved || disabled || running || !validBudget || !validPrice || credentials.isError || credentials.isFetching} onClick={() => void preflight()}>{running ? "正在预检…" : "检查分段与预算（不扣费）"}</Button>
    {error && <p role="alert" className="text-sm text-destructive">{error} 原稿未变，未创建音频任务。</p>}
    {report && <div className="space-y-3 rounded bg-muted p-4" data-testid="podcast-audio-preflight-report">
      {stale && <p role="alert" className="text-amber-700">旧预检结果已失效：稿件、凭据、预算或任务状态已变化，请重新预检。</p>}
      <p className="font-medium">{stale ? "历史预检" : report.value.checks_passed ? "本地预检通过（不是执行授权）" : "预检发现待处理项"}</p>
      <p className="text-sm">{report.value.configuration.model} · {report.value.configuration.voice_id} · {report.value.configuration.region}</p>
      <p className="text-sm">{report.value.character_count} 个文本字符 · {report.value.reserved_character_count} 个保守预留计费字符 · {report.value.segments.length} 个计划分段</p>
      <p className="font-medium">预计一次合成费用：{report.value.estimated_cost === null ? "未知（不是零）" : `${report.value.estimated_cost} 元（用户输入单价，未核验）`} · 预算 {report.value.budget_limit} 元</p>
      <p className="text-sm">预算判断：{report.value.budget_sufficient === null ? "无法判断" : report.value.budget_sufficient ? "估算在预算内" : "估算超出预算"} · 凭据本地检查：{report.value.credential_checks_passed ? "通过（不代表远端可用）" : "未通过"}</p>
      {report.value.issues.map(issue => <p key={issue.code} className="text-sm text-destructive">{issue.message}</p>)}
      {report.value.active_render_id && <p className="text-sm">已有任务：{report.value.active_render_id} · {report.value.active_render_status}</p>}
      <details><summary className="cursor-pointer text-sm">查看冻结口播稿的分段计划</summary><PodcastScrollRegion label="音频分段计划" className="mt-3 space-y-3">{report.value.segments.map(segment => <div key={segment.position} className="rounded border p-3"><p className="text-xs text-muted-foreground">第 {segment.position + 1} 段 · {segment.character_count} 字符 · 预留 {segment.reserved_character_count} 字符 · {segment.estimated_cost === null ? "费用未知" : `估算 ${segment.estimated_cost} 元`}</p><pre className="mt-2 whitespace-pre-wrap break-words font-sans text-sm">{segment.spoken_text}</pre></div>)}</PodcastScrollRegion></details>
      <details><summary className="cursor-pointer text-sm">估算边界与核对信息</summary><PodcastScrollRegion label="估算边界与核对信息内容" className="mt-2 space-y-2 text-xs text-muted-foreground">{report.value.warnings.map(warning => <p key={warning}>{warning}</p>)}<p>确认快照：{report.value.script_approval_id}</p><p>分段规则：{report.value.segmentation_version}</p><p>预检时间：{new Date(report.value.checked_at).toLocaleString()}</p></PodcastScrollRegion></details>
    </div>}
    <div className="space-y-3 border-t pt-3">
      <p id="podcast-audio-generation-status" className="text-sm" data-testid="podcast-audio-generation-status">{generationBlocker}</p>
      {draft && !(report && !stale ? report.value.audio_generation_available : draft.audio_generation_available) && <p className="text-sm text-amber-700">当前服务端未开放音频执行，生成按钮暂不可用；保存、确认和预算预检仍可使用。</p>}
      {ready && <>
        <label className="flex gap-2 text-sm"><input type="checkbox" checked={textConsent} disabled={running} onChange={event => setTextConsent(event.target.checked)} />授权将本期已确认的标题和口播正文发送给 Qwen 合成</label>
        <label className="flex gap-2 text-sm"><input type="checkbox" checked={billingConsent} disabled={running} onChange={event => setBillingConsent(event.target.checked)} />已核对账户单价和本次预算；接受实际计费差异及超时可能计费，不授权自动重试</label>
      </>}
      <Button aria-describedby="podcast-audio-generation-status" disabled={!ready || running || disabled || Boolean(pending) || Boolean(submissionError) || !textConsent || !billingConsent} onClick={authorize}>生成音频（授权并创建任务）</Button>
    </div>
    <p className="text-sm text-muted-foreground">音频执行默认关闭，需部署启用后另行授权；试听与自动重试仍未开放。音频任务完成不等于已采用或发布。</p>
  </section>;
}
