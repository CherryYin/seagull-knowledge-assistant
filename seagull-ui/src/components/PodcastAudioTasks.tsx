import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { podcastsApi, downloadFile } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { PodcastScrollRegion } from "@/components/PodcastScrollRegion";
import { PodcastAudioDiagnostics } from "@/components/PodcastAudioDiagnostics";
import { PodcastAudioAbandon } from "@/components/PodcastAudioAbandon";
import { PodcastAudioPlayer } from "@/components/PodcastAudioPlayer";

export function PodcastAudioTasks({ assetId, disabled = false, onAbandoned }: { assetId: string; disabled?: boolean; onAbandoned?: () => void }) {
  const queryClient = useQueryClient();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const history = useQuery({ queryKey: ["podcast-audio-renders", assetId], queryFn: () => podcastsApi.audioRenders(assetId), retry: false,
    refetchInterval: query => query.state.data?.items.some(task => ["queued", "generating", "assembling"].includes(task.status) || (task.status === "outcome_unknown" && task.can_abandon === false)) ? 3000 : false });
  const act = async (operation: () => Promise<unknown>) => {
    setBusy(true); setError("");
    try { await operation(); await queryClient.invalidateQueries({ queryKey: ["podcast-audio-renders", assetId] }); }
    catch (reason) { setError(String(reason)); }
    finally { setBusy(false); }
  };
  return <section className="space-y-3 rounded border p-5" data-testid="podcast-audio-tasks"><h2 className="text-lg font-semibold">本期音频任务</h2>
    <p className="text-sm text-muted-foreground">展示最近 20 次授权任务。下载前请人工核对发音、结尾与完整性；成功生成、下载均不代表已采用或公众号已发布。</p>
    {error && <p role="alert">{error}</p>}
    {status && <p role="status" className="text-sm">{status}</p>}
    {history.isPending && <p role="status">正在加载音频任务…</p>}
    {history.isError && <p role="alert">音频任务加载失败，不代表没有任务：{history.error.message}<Button variant="outline" onClick={() => void history.refetch()}>重试任务列表</Button></p>}
    {history.data?.items.length === 0 && <p className="text-sm text-muted-foreground">尚无音频任务；预检不会自动创建。</p>}
    {Boolean(history.data?.items.length) && <PodcastScrollRegion label="本期音频任务列表" className="space-y-3">{history.data?.items.map(task => <div key={task.id} className="space-y-2 rounded bg-muted p-3"><p className="text-sm font-medium">{task.status} · {task.id}</p><p className="text-xs text-muted-foreground">冻结稿 {task.script_approval_id} · 分段 {task.ready_segment_count}/{task.segment_count} · 调用 {task.attempt_count} 次 · 预算 {task.budget_limit} 元</p>
      <p className="text-sm">服务商报告字符：{task.reported_characters ?? "未知"} · 实际费用：{task.reported_cost === null ? "未知（不是零）" : `${task.reported_cost} 元`}{task.duration_seconds !== null ? ` · 音频时长 ${task.duration_seconds} 秒` : ""}</p>
      {task.error_message && <p className="text-sm text-destructive">{task.error_message}</p>}
      <PodcastAudioDiagnostics task={task} />
      {task.status === "outcome_unknown" && <p className="text-sm text-amber-700">结果未知，已停止后续请求；不能自动重试或通过取消解除安全锁，请核查服务商调用/账单。</p>}
      {task.status === "outcome_unknown" && task.can_abandon === false && <p className="text-xs">当前调用可能尚未结束，请先等待执行租约到期；状态会自动刷新，期间不能释放生成锁。</p>}
      {task.abandonment && <p className="text-sm">已于 {new Date(task.abandonment.abandoned_at).toLocaleString()} 手动结束（原状态 {task.abandonment.previous_status}）；旧调用和片段已保留，费用状态未被改写。重新生成仍需重新预检和授权。</p>}
      <PodcastAudioAbandon assetId={assetId} task={task} disabled={busy || disabled} onAbandoned={() => {
        setStatus("本次任务已结束，旧调用与片段保留。请前往生成音频，重新检查分段与预算，再单独授权新任务；尚未触发新合成。");
        onAbandoned?.();
      }} />
      {task.status === "queued" && <p className="text-xs">等待音频 Worker；可运行专用的 pkg podcast-worker，不必启动采集调度任务。</p>}
      {task.status === "ready" && <>
        <PodcastAudioPlayer key={`${assetId}:${task.id}`} assetId={assetId} renderId={task.id} />
        <Button variant="outline" disabled={busy} onClick={() => void act(() => downloadFile(`/assets/${encodeURIComponent(assetId)}/podcast/audio-renders/${encodeURIComponent(task.id)}/download`, "seagull-podcast.mp3"))}>下载本期 MP3</Button>
      </>}
      {["queued", "generating", "assembling"].includes(task.status) && <Button variant="outline" disabled={busy} onClick={() => { if (window.confirm(task.status === "queued" ? "取消尚未执行的音频任务？" : "停止后续请求？当前调用可能已计费，状态将保留为结果未知，不会自动重试。")) void act(() => podcastsApi.cancelAudioRender(assetId, task.id)); }}>{task.status === "queued" ? "取消排队任务" : "停止后续音频请求"}</Button>}
    </div>)}</PodcastScrollRegion>}
  </section>;
}
