import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { podcastsApi, type PodcastAudioRender } from "@/lib/api";
import { Button } from "@/components/ui/button";

export function PodcastAudioAbandon({ assetId, task, disabled, onAbandoned }: {
  assetId: string;
  task: PodcastAudioRender;
  disabled: boolean;
  onAbandoned: () => void;
}) {
  const queryClient = useQueryClient();
  const [expanded, setExpanded] = useState(false);
  const [billingConsent, setBillingConsent] = useState(false);
  const [regenerationConsent, setRegenerationConsent] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  const submit = async () => {
    if (!task.can_abandon || disabled || running || !billingConsent || !regenerationConsent) return;
    setRunning(true); setError("");
    try {
      await podcastsApi.abandonAudioRender(assetId, task.id, {
        acknowledge_billing_uncertainty: true, acknowledge_full_regeneration: true,
      });
      setExpanded(false); setBillingConsent(false); setRegenerationConsent(false);
      onAbandoned();
      await queryClient.invalidateQueries({ queryKey: ["podcast-audio-renders", assetId] });
    } catch (reason) {
      setError(`${String(reason)} 请刷新核对结束结果；此操作不会创建新的音频任务。`);
    } finally { setRunning(false); }
  };

  if (!task.can_abandon) return null;
  return <div className="space-y-3 border-t pt-3">
    {!expanded ? <Button variant="outline" disabled={disabled || running} onClick={() => setExpanded(true)}>结束本次任务，允许重新生成</Button> : <div className="space-y-3">
      <p className="text-sm">仅结束任务并释放本期生成锁，不删除已生成片段和调用记录、不退费。下一次将整期重新合成，不是续跑剩余分段；新任务预算单独计算，累计费用可能超过原预算，仍需重新预检并单独授权。</p>
      <label className="flex gap-2 text-sm"><input type="checkbox" checked={billingConsent} disabled={disabled || running} onChange={event => setBillingConsent(event.target.checked)} />我已核查可用的调用记录，理解费用未知不等于未计费</label>
      <label className="flex gap-2 text-sm"><input type="checkbox" checked={regenerationConsent} disabled={disabled || running} onChange={event => setRegenerationConsent(event.target.checked)} />我确认放弃本次不完整音频，并接受整期重新生成可能重复计费</label>
      <div className="flex flex-wrap gap-2"><Button disabled={disabled || running || !billingConsent || !regenerationConsent} onClick={() => void submit()}>{running ? "正在结束任务…" : "确认结束本次任务"}</Button><Button variant="outline" disabled={running} onClick={() => { setExpanded(false); setBillingConsent(false); setRegenerationConsent(false); }}>暂不结束</Button></div>
    </div>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
  </div>;
}
