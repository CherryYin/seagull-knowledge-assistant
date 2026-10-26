import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { discoveryApi, type DiscoveryWebResult, type Source } from "@/lib/api";
import { normalizeWebMaterials } from "@/lib/podcast-web-materials";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

interface Props {
  disabled: boolean;
  referenceCount: number;
  sourceIds: string[];
  onAdopt: (sources: Source[]) => void;
  onImportingChange: (importing: boolean) => void;
}

export function PodcastWebMaterials({ disabled, referenceCount, sourceIds, onAdopt, onImportingChange }: Props) {
  const queryClient = useQueryClient();
  const active = useRef(true);
  const [query, setQuery] = useState("");
  const [report, setReport] = useState<{ query: string; items: DiscoveryWebResult[]; ignored: number } | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [adopted, setAdopted] = useState<Record<string, string>>({});
  const [searching, setSearching] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const available = Math.max(0, 20 - referenceCount);
  const stale = report?.query !== query.trim();
  const linked = (url: string) => Boolean(adopted[url] && sourceIds.includes(adopted[url]));
  const selection = report?.items.filter(item => selected.includes(item.url) && !linked(item.url)) ?? [];

  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);

  const search = async () => {
    const text = query.trim();
    if (disabled || searching || saving || !text || text.length > 500) return;
    setSearching(true); setError(""); setStatus(""); setReport(null); setSelected([]);
    try {
      const results = normalizeWebMaterials(await discoveryApi.previewWeb({ query: text, max_results: 8 }));
      if (active.current) setReport({ query: text, ...results });
    } catch (reason) { if (active.current) setError(`联网搜索失败：${String(reason)}。未保存素材，请检查搜索配置后重试。`); }
    finally { if (active.current) setSearching(false); }
  };

  const adopt = async () => {
    if (disabled || searching || saving || !report || stale || !selection.length || selection.length > available) return;
    if (!window.confirm(`将选中的 ${selection.length} 条网页搜索结果保存为 Source，并加入本地播客素材？保存的是搜索摘要，不是网页全文，也不代表事实已核验。已有同 URL 的本人 Source 将直接复用、不覆盖；还需保存稿件才会持久关联。`)) return;
    setSaving(true); onImportingChange(true); setError(""); setStatus("");
    try {
      const result = await discoveryApi.saveWebMaterials({ query: report.query, items: selection });
      if (!active.current) return;
      onAdopt(result.items);
      setAdopted(previous => ({ ...previous, ...Object.fromEntries(result.items.filter(source => source.url).map(source => [source.url!, source.id])) }));
      setSelected([]);
      setStatus(`已保存 ${result.created} 份、复用 ${result.reused} 份 Source，并加入本地素材。请保存稿件后再生成候选或确认；原正文未改动。`);
      void queryClient.invalidateQueries({ queryKey: ["podcast-materials", "source"] });
      void queryClient.invalidateQueries({ queryKey: ["sources"] });
    } catch (reason) { if (active.current) setError(`保存/关联未完成：${String(reason)}。未自动重试；可能已有 Source 入库，重试会复用且不覆盖。也可在已有素材中查看。`); }
    finally { if (active.current) setSaving(false); onImportingChange(false); }
  };

  return <section className="space-y-3 rounded border p-4" data-testid="podcast-web-materials">
    <h2 className="font-semibold">联网搜索素材</h2>
    <p className="text-sm text-muted-foreground">只发送你填写的搜索词，不发送正文。搜索可能消耗服务商额度，但不会自动入库、关联或改稿；勾选并确认后才保存搜索摘要。摘要不等于全文或已核实事实。</p>
    <p className="text-xs text-muted-foreground">复用系统 Web Search（Tavily）配置，可在 <Link className="underline" to="/settings/api-keys">Settings → API Keys</Link> 设置凭据。标题最多 500 字符、摘要最多 10000 字符。</p>
    <p className="text-xs text-muted-foreground">搜索不会按本期信息截止时间自动筛选；发布时间由搜索服务提供，采用前请核对原网页。</p>
    <div className="flex flex-wrap gap-2"><Input className="min-w-48 flex-1" aria-label="播客联网搜索词" placeholder="输入热点主题或具体问题" maxLength={500} value={query} disabled={disabled || searching || saving} onChange={event => { setQuery(event.target.value); setReport(null); setSelected([]); setError(""); setStatus(""); }} /><Button disabled={disabled || searching || saving || !query.trim()} onClick={() => void search()}>{searching ? "正在联网搜索…" : "搜索网络素材"}</Button></div>
    {searching && <p role="status">正在获取候选结果，尚未保存素材…</p>}
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {status && <p role="status" className="text-sm">{status}</p>}
    {report && <div className="space-y-3">
      <p className="text-sm">“{report.query}”的 {report.items.length} 条候选 · 本期还可关联 {available} 份素材</p>
      {report.ignored > 0 && <p className="text-sm text-amber-700">已忽略 {report.ignored} 条格式无效或超出数量范围的结果。</p>}
      {!report.items.length && <p>没有可用结果；不会自动补入或保存其他素材，请修改搜索词后重试。</p>}
      {report.items.map(item => <article key={item.url} className="space-y-2 rounded bg-muted p-3">
        <label className="flex items-start gap-2"><input type="checkbox" aria-label={`采用网页：${item.title}`} checked={selected.includes(item.url) || linked(item.url)} disabled={disabled || saving || stale || linked(item.url) || (!selected.includes(item.url) && selection.length >= available)} onChange={event => setSelected(previous => event.target.checked ? [...previous, item.url] : previous.filter(url => url !== item.url))} /><span className="font-medium">{item.title}{linked(item.url) ? " · 已加入本地素材" : ""}</span></label>
        <p className="text-xs text-muted-foreground">来源：{new URL(item.url).hostname} · 搜索服务：{item.source_name || "未提供"}</p>
        <p className="text-xs text-muted-foreground">发布时间（搜索服务提供，未核验）：{item.published_at || "未知（不是搜索时间）"}</p>
        <a className="block break-all text-sm underline" href={item.url} target="_blank" rel="noopener noreferrer">查看原网页：{item.url}</a>
        <p className="whitespace-pre-wrap break-words text-sm">{item.summary || "未提供摘要，请先查看原网页；保存不会抓取全文。"}</p>
      </article>)}
      {selection.length > available && <p role="alert">选中数量超过本期剩余名额，请取消部分选择或移除已有素材。</p>}
      {report.items.length > 0 && <Button disabled={disabled || saving || searching || stale || !selection.length || selection.length > available} onClick={() => void adopt()}>{saving ? "正在保存并关联…" : `保存并关联选中素材（${selection.length}）`}</Button>}
    </div>}
  </section>;
}
