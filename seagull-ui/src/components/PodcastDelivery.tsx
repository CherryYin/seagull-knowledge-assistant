import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { podcastsApi, type PodcastDeliveryFields, type PodcastDeliveryRecord } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { PodcastScrollRegion } from "@/components/PodcastScrollRegion";
import { PodcastPublicationReview, PublicationSnapshotHistory } from "@/components/PodcastPublicationReview";

const adoptionLabels = { undecided: "暂未决定", original: "原样采用", modified: "修改后采用", not_used: "未采用" };
const manualLabels = { script: "改稿", pronunciation: "发音", speed: "语速", editing: "剪辑", upload: "上传", other: "其他" };

function localTime(value = new Date().toISOString()) {
  const date = new Date(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}

function emptyFields(): PodcastDeliveryFields {
  return { base_revision: 0, render_id: "", channel: "微信公众号", publish_url: null, published_at: null,
    confirm_published: false, notes: "", adoption: "undecided", manual_steps: [], feedback: "", statistics_snapshots: [] };
}

export function PodcastDelivery({ assetId, disabled = false }: { assetId: string; disabled?: boolean }) {
  const queryClient = useQueryClient();
  const records = useQuery({ queryKey: ["podcast-delivery", assetId], queryFn: () => podcastsApi.deliveryRecords(assetId), retry: false });
  const tasks = useQuery({ queryKey: ["podcast-audio-renders", assetId], queryFn: () => podcastsApi.audioRenders(assetId), retry: false });
  const [fields, setFields] = useState(emptyFields);
  const [recordId, setRecordId] = useState<string>(() => crypto.randomUUID());
  const [publicationTime, setPublicationTime] = useState(() => localTime());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const ready = tasks.data?.items.filter(task => task.status === "ready") ?? [];
  const blocked = disabled || busy || records.isPending || records.isError || tasks.isPending || tasks.isError;
  const reset = () => {
    setFields(emptyFields()); setRecordId(crypto.randomUUID()); setPublicationTime(localTime()); setError(""); setMessage("");
  };
  const edit = (record: PodcastDeliveryRecord) => {
    setRecordId(record.id);
    setFields({ base_revision: record.revision, render_id: record.render_id, channel: record.channel,
      publish_url: record.publish_url, published_at: record.published_at, confirm_published: record.confirm_published,
      notes: record.notes, adoption: record.adoption, manual_steps: record.manual_steps, feedback: record.feedback, statistics_snapshots: record.statistics_snapshots ?? [] });
    setPublicationTime(localTime(record.published_at ?? undefined)); setError(""); setMessage("");
  };
  const save = async (confirm: boolean, nextFields = fields): Promise<boolean> => {
    if (confirm && !nextFields.confirm_published && !window.confirm("确认这份音频已在所填渠道发布？这只记录结果，不会代你发布或重新生成音频。")) return false;
    setBusy(true); setError(""); setMessage("");
    try {
      const timestamp = publicationTime ? nextFields.published_at && localTime(nextFields.published_at) === publicationTime
        ? nextFields.published_at : new Date(publicationTime).toISOString() : null;
      const result = await podcastsApi.saveDeliveryRecord(assetId, recordId, { ...nextFields,
        publish_url: nextFields.publish_url?.trim() || null,
        published_at: timestamp,
        confirm_published: confirm || nextFields.confirm_published });
      edit(result);
      queryClient.setQueryData<{ items: PodcastDeliveryRecord[] }>(["podcast-delivery", assetId], previous => ({
        items: [result, ...(previous?.items ?? []).filter(record => record.id !== result.id)],
      }));
      setMessage((result.statistics_snapshots?.length ?? 0) > (fields.statistics_snapshots?.length ?? 0) ? "已保存效果快照，未调用微信或生成音频；历史快照保持不变。" : result.confirm_published ? "已记录发布结果，未触发生成或自动发布。" : "已保存信息，未标记为已发布。");
      void queryClient.invalidateQueries({ queryKey: ["assets"] });
      void queryClient.invalidateQueries({ queryKey: ["asset", assetId] });
      void queryClient.invalidateQueries({ queryKey: ["podcast-draft", assetId] });
      return true;
    } catch (reason) { setError(`${String(reason)}。若提示记录冲突或网络中断，请刷新记录并检查是否已保存，再编辑；不会自动重试。`); return false; }
    finally { setBusy(false); }
  };
  return <section id="podcast-delivery" tabIndex={-1} className="space-y-4 rounded border p-5" data-testid="podcast-delivery">
    <h2 className="text-lg font-semibold">发布记录与使用复盘</h2>
    <p className="text-sm text-muted-foreground">手动记录具体音频版本的去向，不会调用公众号或 TTS。生成、下载不等于发布；发布也不会自动填写采用反馈。</p>
    {records.isPending && <p role="status">正在加载发布记录…</p>}
    {records.isError && <p role="alert">发布记录加载失败，不代表没有记录。<Button variant="outline" onClick={() => void records.refetch()}>重试发布记录</Button></p>}
    {tasks.isError && <p role="alert">音频版本加载失败。<Button variant="outline" onClick={() => void tasks.refetch()}>重试音频版本</Button></p>}
    {records.data && <PodcastScrollRegion label="已保存的发布记录"><div className="space-y-3">{records.data.items.length === 0 && <p className="text-sm">尚无发布记录，可以补录已经发布的这一期。</p>}{records.data.items.map(record => <div key={record.id} className="space-y-1 rounded bg-muted p-3 text-sm">
      <p className="font-medium">{record.confirm_published ? "已发布" : "仅保存信息，未确认发布"} · {record.channel}</p>
      <p className="break-all">音频版本：{record.render_id} · 冻结稿：{record.script_approval_id}</p>
      {record.confirm_published && record.published_at && <p>发布时间：{new Date(record.published_at).toLocaleString()}</p>}
      {record.publish_url && <a className="break-all text-primary underline" href={record.publish_url} target="_blank" rel="noopener noreferrer">查看发布文章</a>}
      <p>采用情况：{adoptionLabels[record.adoption]} · 手动处理：{record.manual_steps.map(step => manualLabels[step]).join("、") || "未反馈（不代表无需处理）"}</p>
      {record.notes && <p className="whitespace-pre-wrap">发布备注：{record.notes}</p>}{record.feedback && <p className="whitespace-pre-wrap">使用反馈：{record.feedback}</p>}
      {(record.statistics_snapshots?.length ?? 0) > 0 && <details><summary className="cursor-pointer">查看效果快照（{record.statistics_snapshots?.length}）</summary><PublicationSnapshotHistory snapshots={record.statistics_snapshots ?? []} /></details>}
      <Button variant="outline" disabled={disabled || busy} onClick={() => edit(record)}>编辑记录</Button>
    </div>)}</div></PodcastScrollRegion>}
    <fieldset disabled={blocked} className="space-y-3">
      <legend className="mb-3 font-medium">{fields.base_revision ? "编辑现有记录" : "新增记录"}</legend>
      <label className="block space-y-1">发布音频<select aria-label="发布音频" className="block w-full rounded border bg-background p-2" value={fields.render_id} disabled={fields.base_revision > 0} onChange={event => setFields({ ...fields, render_id: event.target.value })}>
        <option value="">请选择已生成成功的音频</option>{fields.render_id && !ready.some(task => task.id === fields.render_id) && <option value={fields.render_id}>{fields.render_id}（历史版本）</option>}
        {ready.map(task => <option key={task.id} value={task.id}>{new Date(task.created_at).toLocaleString()} · {task.duration_seconds ?? "未知"} 秒 · {task.id}</option>)}
      </select></label>
      {!tasks.isPending && !tasks.isError && ready.length === 0 && !fields.render_id && <p className="text-sm text-muted-foreground">暂无可选的已完成音频，请先完成音频生成。</p>}
      <div className="grid gap-3 md:grid-cols-2">
        <label className="space-y-1">发布渠道<Input disabled={Boolean(fields.statistics_snapshots?.length)} value={fields.channel} maxLength={100} onChange={event => setFields({ ...fields, channel: event.target.value })} /></label>
        <label className="space-y-1">文章链接（选填）<Input disabled={Boolean(fields.statistics_snapshots?.length)} type="url" value={fields.publish_url ?? ""} onChange={event => setFields({ ...fields, publish_url: event.target.value })} placeholder="https://mp.weixin.qq.com/…" /></label>
        <label className="space-y-1">实际发布时间<Input aria-label="实际发布时间" disabled={Boolean(fields.statistics_snapshots?.length)} type="datetime-local" value={publicationTime} onChange={event => setPublicationTime(event.target.value)} /><span className="text-xs text-muted-foreground">本地时区，可补录历史时间；仅填时间不会标记发布。保存效果快照后，文章链接、渠道和发布时间锁定。</span></label>
      </div>
      <label className="block space-y-1">发布备注（选填）<Textarea value={fields.notes} maxLength={4000} onChange={event => setFields({ ...fields, notes: event.target.value })} placeholder="例如：剪掉开头后上传" /></label>
      <h3 className="font-medium">简短复盘（选填）</h3>
      <label className="block space-y-1">这份音频怎么用的？<select aria-label="这份音频怎么用的？" className="block rounded border bg-background p-2" value={fields.adoption} onChange={event => setFields({ ...fields, adoption: event.target.value as PodcastDeliveryFields["adoption"] })}>{Object.entries(adoptionLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <div><p className="mb-2 text-sm">哪里需要手动处理？（可多选，不选视为未反馈）</p><div className="flex flex-wrap gap-4">{Object.entries(manualLabels).map(([value, label]) => <label key={value} className="flex items-center gap-2"><input type="checkbox" checked={fields.manual_steps.includes(value as PodcastDeliveryFields["manual_steps"][number])} onChange={event => {
        const step = value as PodcastDeliveryFields["manual_steps"][number];
        setFields({ ...fields, manual_steps: event.target.checked ? [...fields.manual_steps, step] : fields.manual_steps.filter(item => item !== step) });
      }} />{label}</label>)}</div></div>
      <label className="block space-y-1">最想改善什么／未采用原因（选填）<Textarea value={fields.feedback} maxLength={4000} onChange={event => setFields({ ...fields, feedback: event.target.value })} /></label>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" disabled={!fields.render_id || !fields.channel.trim()} onClick={() => void save(false)}>{busy ? "保存中…" : fields.confirm_published ? "保存记录修改" : "保存信息"}</Button>
        {!fields.confirm_published && <Button disabled={!fields.render_id || !fields.channel.trim() || !publicationTime} onClick={() => void save(true)}>确认已发布</Button>}
        {fields.base_revision > 0 && <Button variant="outline" onClick={reset}>新增另一条记录</Button>}
      </div>
    </fieldset>
    {fields.confirm_published && fields.publish_url && fields.published_at && <PodcastPublicationReview key={`${recordId}:${fields.publish_url}:${fields.published_at}`} publicationUrl={fields.publish_url} publishedAt={fields.published_at} snapshots={fields.statistics_snapshots ?? []} disabled={blocked} onAppend={snapshot => save(false, { ...fields, statistics_snapshots: [...(fields.statistics_snapshots ?? []), snapshot] })} />}
    {fields.confirm_published && !fields.publish_url && <p className="text-sm">补充并保存公众号文章链接后，可记录发布效果；无需统计接口权限。</p>}
    {error && <p role="alert" className="text-sm text-destructive">{error}<Button variant="outline" onClick={() => void records.refetch()}>刷新记录</Button></p>}
    {message && <p role="status" className="text-sm">{message}</p>}
    {disabled && <p className="text-sm text-muted-foreground">归档播客仅可查看发布记录。</p>}
  </section>;
}
