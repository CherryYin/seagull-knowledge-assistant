import { useEffect, useRef, useState } from "react";
import { PodcastScrollRegion } from "@/components/PodcastScrollRegion";
import { harnessChat, podcastsApi, request, type PodcastDraft, type PodcastParagraphSource } from "@/lib/api";
import { buildPodcastAuthoringPrompt, paragraphSources, parsePodcastScriptProposal, type PodcastScriptProposal } from "@/lib/podcast-authoring";
import { Button } from "@/components/ui/button";

export function PodcastAuthoring({ draft, disabled, onApply }: {
  draft?: PodcastDraft;
  disabled: boolean;
  onApply: (outline: string, body: string, sources: PodcastParagraphSource[]) => void;
}) {
  const [consent, setConsent] = useState(false);
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [proposal, setProposal] = useState<PodcastScriptProposal | null>(null);
  const controller = useRef<AbortController | null>(null);
  const session = useRef<string | null>(null);
  const latest = useRef({ disabled, inputHash: draft?.input_hash });
  latest.current = { disabled, inputHash: draft?.input_hash };

  const stop = async () => {
    controller.current?.abort();
    if (session.current) await request(`/sessions/${encodeURIComponent(session.current)}/cancel`, { method: "POST" });
  };
  useEffect(() => () => { if (controller.current) void stop().catch(() => undefined); }, []);

  const generate = async () => {
    if (!draft || disabled || !consent || running) return;
    setRunning(true); setError(""); setProposal(null); setStatus("正在核对已保存输入…");
    const abort = new AbortController();
    let completed = false;
    controller.current = abort; session.current = null;
    const timeout = window.setTimeout(() => {
      setError("超过 3 分钟，已停止接收并尝试取消远端运行；已发生用量可能仍计费，原稿未变。");
      void stop().catch(() => setError("停止请求未获确认，请在 Harness 检查运行状态；原稿未变。"));
    }, 180000);
    try {
      const current = await podcastsApi.draft(draft.asset_id);
      if (current.input_hash !== draft.input_hash || latest.current.disabled || abort.signal.aborted) throw new Error("输入已经改变，请先保存并加载最新版本再生成。");
      const prompt = buildPodcastAuthoringPrompt(current);
      let output = "";
      setStatus("Agent 正在整理口播候选，不会覆盖原稿…");
      for await (const event of harnessChat(prompt, { preset: "knowledge-lab", createSession: true, ephemeralSession: true, signal: abort.signal })) {
        if (event.type === "session" && event.session_id) session.current = event.session_id;
        if (event.type === "text" && event.content) {
          output += event.content;
          if (output.length > 160000) throw new Error("Agent 输出超过允许大小，已停止接收。");
          setStatus(`正在接收候选 · ${output.length} 字符`);
        }
        if (event.type === "error") throw new Error(event.content || "Agent 请求失败。");
        if (event.type === "question") throw new Error("Agent 需要补充信息，请完善创作角度后重新生成；原稿未变。");
        if (event.type === "done") completed = true;
      }
      if (!completed || abort.signal.aborted) throw new Error("未收到完整候选；原稿未变。");
      setProposal(parsePodcastScriptProposal(output, current));
      setStatus("候选已就绪。请核实内容与来源，显式应用后再保存。");
    } catch (reason) {
      if (!abort.signal.aborted) setError(String(reason));
      if (!completed) await stop().catch(() => setError("请求失败且停止未获确认，请在 Harness 检查运行状态；原稿未变。"));
    } finally { window.clearTimeout(timeout); controller.current = null; setRunning(false); }
  };

  const apply = async () => {
    if (!draft || !proposal || disabled || running) return;
    setRunning(true); setError("");
    try {
      const current = await podcastsApi.draft(draft.asset_id);
      if (current.input_hash !== proposal.base_input_hash || latest.current.disabled || latest.current.inputHash !== proposal.base_input_hash) throw new Error("候选已过期或本地稿已修改，请先处理差异，再重新生成。");
      const body = proposal.paragraphs.map(paragraph => paragraph.text).join("\n\n");
      const sources = await paragraphSources(body, proposal.paragraphs.map(paragraph => paragraph.material_refs));
      if (latest.current.disabled || latest.current.inputHash !== proposal.base_input_hash) throw new Error("编辑状态已改变，候选未应用。");
      if (!window.confirm("用这份候选替换本地提纲和正文？服务器稿件与确认快照不会被自动修改，之后仍需保存并确认。")) return;
      onApply(proposal.outline, body, sources); setProposal(null); setStatus("已应用到本地编辑态，请保存并重新确认。");
    } catch (reason) { setError(String(reason)); }
    finally { setRunning(false); }
  };

  return <section className="space-y-3 rounded border p-5"><h2 className="text-lg font-semibold">Agent 辅助口播稿</h2>
    <p className="text-sm text-muted-foreground">使用已保存的角度、截止时间、当前稿件和选定素材摘要生成候选，需至少一份可用素材。直接粘贴成稿无需使用 Agent。素材仅用于定位依据，不自动视为已审核证据。不会自动保存、确认或生成音频。</p>
    <label className="flex gap-2 text-sm"><input type="checkbox" checked={consent} disabled={running} onChange={event => setConsent(event.target.checked)} />允许将上述内容发送给当前 Harness 模型（可能产生模型费用，不属于 TTS）</label>
    <Button disabled={!draft || disabled || running || !consent} onClick={() => void generate()}>生成口播稿候选</Button>
    {running && controller.current && <Button variant="outline" onClick={() => { setStatus("已停止接收并尝试取消远端运行；请留意 Harness 状态，已发生用量可能计费，原稿未变。"); void stop().catch(reason => setError(String(reason))); }}>停止生成</Button>}
    {status && <p role="status" className="text-sm">{status}</p>}{error && <p role="alert" className="text-sm text-destructive">{error} 原稿未被覆盖。</p>}
    {proposal && <div className="space-y-3" data-testid="podcast-script-proposal"><p className="font-medium">候选预览（尚未应用）</p><PodcastScrollRegion label="Agent 口播稿候选内容" className="space-y-3"><pre className="whitespace-pre-wrap font-sans">{proposal.outline}</pre>
      {proposal.paragraphs.map((paragraph, position) => <div key={position} className="rounded bg-muted p-3"><p className="whitespace-pre-wrap">{paragraph.text}</p><p className="mt-1 text-xs text-muted-foreground">{paragraph.material_refs.length ? paragraph.material_refs.map(ref => draft?.materials.find(material => material.kind === ref.kind && material.id === ref.id)?.title || ref.id).join(" · ") : "个人观点/过渡：未关联素材，请自行核实"}</p></div>)}
      {proposal.warnings.map((warning, position) => <p key={position} className="text-sm text-amber-700">待核实：{warning}</p>)}
      </PodcastScrollRegion>
      {proposal.base_input_hash !== draft?.input_hash && <p role="alert">候选对应的输入版本已过期，请重新生成。</p>}
      <div className="flex gap-2"><Button disabled={disabled || running || proposal.base_input_hash !== draft?.input_hash} onClick={() => void apply()}>应用候选到编辑器</Button><Button variant="outline" disabled={running} onClick={() => setProposal(null)}>丢弃候选</Button></div>
    </div>}
  </section>;
}
