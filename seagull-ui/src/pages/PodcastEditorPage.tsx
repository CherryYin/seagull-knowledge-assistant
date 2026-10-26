import { useEffect, useState } from "react";
import { PodcastDelivery } from "@/components/PodcastDelivery";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { podcastsApi, sourcesApi, notesApi, wikiApi, type PodcastDraft, type PodcastDraftFields, type Source } from "@/lib/api";
import { PodcastWebMaterials } from "@/components/PodcastWebMaterials";
import { PodcastScrollRegion } from "@/components/PodcastScrollRegion";
import { useAuth } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ProjectAssociations } from "@/components/projects/ProjectAssociations";
import { PodcastAuthoring } from "@/components/PodcastAuthoring";
import { PodcastParagraphSources } from "@/components/PodcastParagraphSources";
import { PodcastAudioPreflight } from "@/components/PodcastAudioPreflight";
import { PodcastAudioTasks } from "@/components/PodcastAudioTasks";

const emptyDraft: PodcastDraftFields = {
  title: "", brief: "", outline: "", draft_content: "", source_refs: [], note_refs: [], wiki_refs: [], paragraph_sources: [],
  configuration: { provider: "qwen", region: "cn-beijing", model: "qwen3-tts-flash", voice_id: "Cherry", target_duration_minutes: 6, information_cutoff_at: null },
};

function editable(draft: PodcastDraft): PodcastDraftFields {
  const { provider, region, model, voice_id, target_duration_minutes, information_cutoff_at } = draft.configuration;
  return { title: draft.title, brief: draft.brief, outline: draft.outline, draft_content: draft.draft_content,
    source_refs: draft.source_refs, note_refs: draft.note_refs, wiki_refs: draft.wiki_refs,
    paragraph_sources: draft.paragraph_sources || [],
    configuration: { provider, region, model, voice_id, target_duration_minutes, information_cutoff_at } };
}

function localDateTime(value: string | null) {
  if (!value) return "";
  const date = new Date(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}

function normalizeSpoken(text: string) {
  return text.replace(/\r\n?/g, "\n").split("\n").map(line => line.trimEnd()).join("\n").trim();
}

function validRecovery(value: unknown): value is { fields: PodcastDraftFields; base: string | null } {
  if (!value || typeof value !== "object" || !("fields" in value) || !("base" in value)) return false;
  const { fields, base } = value;
  if (!fields || typeof fields !== "object" || (base !== null && (typeof base !== "string" || !/^[a-f0-9]{64}$/.test(base)))) return false;
  const draft = fields as Record<string, unknown>;
  if (!["title", "brief", "outline", "draft_content"].every(name => typeof draft[name] === "string")) return false;
  if (!["source_refs", "note_refs", "wiki_refs"].every(name => Array.isArray(draft[name]) && draft[name].every(item => typeof item === "string"))) return false;
  if (draft.paragraph_sources !== undefined && (!Array.isArray(draft.paragraph_sources) || draft.paragraph_sources.some(mapping => !mapping || typeof mapping !== "object" || !Number.isInteger(mapping.paragraph_index) || typeof mapping.text_hash !== "string" || !Array.isArray(mapping.material_refs) || mapping.material_refs.some((ref: { kind?: unknown; id?: unknown } | null) => !ref || !["source", "note", "wiki"].includes(String(ref.kind)) || typeof ref.id !== "string")))) return false;
  const config = draft.configuration as Record<string, unknown> | undefined;
  return Boolean(config && config.provider === "qwen" && config.region === "cn-beijing" && config.model === "qwen3-tts-flash" &&
    typeof config.voice_id === "string" && typeof config.target_duration_minutes === "number" && Number.isInteger(config.target_duration_minutes) &&
    config.target_duration_minutes >= 1 && config.target_duration_minutes <= 30 &&
    (config.information_cutoff_at === null || (typeof config.information_cutoff_at === "string" && !Number.isNaN(Date.parse(config.information_cutoff_at)))));
}

export function PodcastEditorPage() {
  const { id } = useParams();
  const query = useQuery({ queryKey: ["podcast-draft", id], queryFn: () => podcastsApi.draft(id!), enabled: Boolean(id), retry: false });
  if (id && query.isPending) return <p className="p-8" role="status">正在加载播客…</p>;
  if (id && query.isError && !query.data) return <div className="p-8" role="alert">无法加载播客：{query.error.message}<Button onClick={() => void query.refetch()}>重试</Button></div>;
  return <PodcastForm key={id || "new"} initial={query.data} />;
}

function PodcastForm({ initial }: { initial?: PodcastDraft }) {
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const [saved, setSaved] = useState(initial);
  const [form, setForm] = useState<PodcastDraftFields>(() => {
    if (initial) return editable(initial);
    const draft = structuredClone(emptyDraft);
    const seed = location.state?.podcastSeed ?? location.state?.assetHandoff;
    if (!seed || typeof seed !== "object") return draft;
    for (const name of ["title", "brief"] as const) if (typeof seed[name] === "string") draft[name] = seed[name];
    for (const name of ["source_refs", "note_refs", "wiki_refs"] as const) if (Array.isArray(seed[name])) draft[name] = [...new Set<string>(seed[name].filter((value: unknown) => typeof value === "string"))];
    return draft;
  });
  const [busy, setBusy] = useState(false);
  const [audioTaskRevision, setAudioTaskRevision] = useState(0);
  const [webSources, setWebSources] = useState<Source[]>([]);
  const [error, setError] = useState("");
  const [storageError, setStorageError] = useState("");
  const [recovery, setRecovery] = useState<{ fields: PodcastDraftFields; base: string | null } | null>(null);
  const [recoveryChecked, setRecoveryChecked] = useState(false);
  const voices = useQuery({ queryKey: ["podcast-voices"], queryFn: podcastsApi.voices });
  const archived = saved?.status === "archived";
  const dirty = JSON.stringify(form) !== JSON.stringify(saved ? editable(saved) : emptyDraft);
  const recoveryKey = user ? `podcast-draft:${user.id}:${saved?.asset_id || "new"}` : null;

  useEffect(() => {
    if (initial && !dirty && !busy) { setSaved(initial); setForm(editable(initial)); }
  }, [initial]);

  useEffect(() => {
    if (!recoveryKey) return;
    try {
      const raw = localStorage.getItem(recoveryKey);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (validRecovery(parsed)) setRecovery(parsed);
        else setStorageError("浏览器恢复稿格式无效，未自动载入。请自行备份后处理。");
      }
    } catch { setStorageError("浏览器恢复区不可用，请及时保存或自行复制正文备份。"); }
    setRecoveryChecked(true);
  }, [recoveryKey]);

  useEffect(() => {
    if (!recoveryKey || !recoveryChecked || !dirty) return;
    try { localStorage.setItem(recoveryKey, JSON.stringify({ fields: form, base: saved?.input_hash || null })); }
    catch { setStorageError("无法写入浏览器恢复区，请复制正文备份。"); }
  }, [form, dirty, saved?.input_hash, recoveryKey, recoveryChecked]);

  useEffect(() => {
    if (!dirty) return;
    const unload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    const click = (event: MouseEvent) => {
      const anchor = (event.target as HTMLElement).closest("a[href]");
      if (anchor && !window.confirm("有未保存的播客修改，确定离开？")) { event.preventDefault(); event.stopPropagation(); }
    };
    window.addEventListener("beforeunload", unload);
    document.addEventListener("click", click, true);
    return () => { window.removeEventListener("beforeunload", unload); document.removeEventListener("click", click, true); };
  }, [dirty]);

  const accept = (result: PodcastDraft) => {
    setSaved(result); setForm(editable(result)); setRecovery(null);
    queryClient.setQueryData(["podcast-draft", result.asset_id], result);
    void queryClient.invalidateQueries({ queryKey: ["assets"] });
    void queryClient.invalidateQueries({ queryKey: ["asset", result.asset_id] });
    try { if (recoveryKey) localStorage.removeItem(recoveryKey); } catch { setStorageError("无法清理浏览器恢复区。"); }
  };

  const save = async () => {
    setBusy(true); setError("");
    try {
      const result = saved ? await podcastsApi.saveDraft(saved.asset_id, { ...form, base_input_hash: saved.input_hash }) : await podcastsApi.create(form);
      accept(result);
      if (!saved) navigate(`/assets/${encodeURIComponent(result.asset_id)}/podcast`, { replace: true });
    } catch (reason) { setError(String(reason)); }
    finally { setBusy(false); }
  };

  const approve = async () => {
    if (!saved || dirty || !window.confirm("确认将下方预览的全部口播文本、当前素材和音色配置锁定为本次确认快照？不会生成音频或扣费。")) return;
    setBusy(true); setError("");
    try { accept(await podcastsApi.approve(saved.asset_id, saved.input_hash)); }
    catch (reason) { setError(String(reason)); }
    finally { setBusy(false); }
  };

  const reload = async () => {
    if (!saved || (dirty && !window.confirm("加载最新服务器版本？本地修改将保留在恢复区，请手动恢复并检查冲突。"))) return;
    setBusy(true); setError("");
    try {
      const result = await podcastsApi.draft(saved.asset_id);
      if (dirty) setRecovery({ fields: form, base: saved.input_hash });
      setSaved(result); setForm(editable(result));
    } catch (reason) { setError(String(reason)); }
    finally { setBusy(false); }
  };

  const field = (name: "title" | "brief" | "outline" | "draft_content", value: string) => setForm(previous => ({ ...previous, [name]: value, ...(name === "draft_content" ? { paragraph_sources: [] } : {}) }));
  const preview = [normalizeSpoken(form.title), normalizeSpoken(form.draft_content)].filter(Boolean).join("\n\n");
  return <main className="mx-auto h-full max-w-5xl space-y-6 overflow-y-auto p-4 md:p-8" data-testid="podcast-editor">
    <header className="flex flex-wrap items-center justify-between gap-3"><div><h1 className="text-2xl font-semibold">{saved ? "播客工作台" : "创建播客"}</h1><p className="text-sm text-muted-foreground">素材 → 角度 → 口播稿 → 显式确认 → 音频。编辑和预算预检不扣费；合成需部署启用并单独授权。</p></div>
      <div className="flex flex-wrap gap-2"><Button variant="outline" onClick={() => document.getElementById("podcast-audio-generation")?.focus()}>前往生成音频</Button>{saved && <Button variant="outline" onClick={() => document.getElementById("podcast-delivery")?.focus()}>发布记录与复盘</Button>}<Button variant="outline" onClick={() => { if (!dirty || window.confirm("有未保存修改，确定离开？")) navigate("/assets"); }}>返回 Assets</Button>{saved && !archived && <ProjectAssociations resourceType="asset" resourceId={saved.asset_id} />}</div></header>
    {error && <div role="alert" className="rounded border border-destructive p-4">{error}<p>本地修改未丢弃。若出现 409，请加载最新版本，再恢复本地稿并检查差异。</p></div>}
    {storageError && <p role="alert">{storageError}</p>}
    {recovery && !archived && <div className="rounded border p-4">发现浏览器本地恢复稿。<Button variant="outline" disabled={busy} onClick={() => {
      if (recovery.base !== (saved?.input_hash || null) && !window.confirm("恢复稿基于旧版本。恢复后将以最新服务器版本为保存基线，请先核对素材、配置和全文，确认覆盖？")) return;
      setForm(recovery.fields); setRecovery(null);
    }}>恢复本地稿</Button></div>}
    <div className="flex flex-wrap items-center gap-3 rounded border p-4"><span>{archived ? "已归档 · 只读" : dirty ? "有未保存修改 · 必须保存后再确认" : "已保存"}</span>
      <span>脚本：{saved?.approval_status === "current" && !dirty ? "当前版本已确认" : saved?.latest_approval ? "旧确认已失效，需重新确认" : "尚未确认"}</span>
      {saved && <Button variant="outline" disabled={busy} onClick={() => void reload()}>加载最新版本</Button>}</div>
    <fieldset disabled={busy || archived} className="space-y-5 disabled:opacity-70">
      <label className="block space-y-2">本期标题<Input value={form.title} maxLength={300} onChange={event => field("title", event.target.value)} /></label>
      <label className="block space-y-2">角度与个人观点<Textarea value={form.brief} maxLength={10000} onChange={event => field("brief", event.target.value)} /></label>
      <section className="grid gap-4 rounded border p-4 md:grid-cols-3">
        <label className="space-y-2">音色<select aria-label="音色" className="block w-full rounded border bg-background p-2" value={form.configuration.voice_id} onChange={event => setForm({ ...form, configuration: { ...form.configuration, voice_id: event.target.value } })}>
          {!voices.data && <option value={form.configuration.voice_id}>{form.configuration.voice_id}</option>}
          {voices.data?.items.map(voice => <option key={voice.id} value={voice.id}>{voice.name} · {voice.gender} · {voice.id}</option>)}</select>
          {voices.isError && <span role="alert">音色目录加载失败<Button variant="outline" onClick={() => void voices.refetch()}>重试</Button></span>}</label>
        <label className="space-y-2">目标时长（分钟）<Input type="number" min={1} max={30} value={form.configuration.target_duration_minutes} onChange={event => setForm({ ...form, configuration: { ...form.configuration, target_duration_minutes: Number(event.target.value) } })} /></label>
        <label className="space-y-2">信息截止时间（本地时区）<Input type="datetime-local" value={localDateTime(form.configuration.information_cutoff_at)} onChange={event => setForm({ ...form, configuration: { ...form.configuration, information_cutoff_at: event.target.value ? new Date(event.target.value).toISOString() : null } })} /></label>
        <p className="text-sm text-muted-foreground md:col-span-3">Qwen · cn-beijing · qwen3-tts-flash。音色试听暂未接入；切换音色不会自动播放或生成音频。</p>
      </section>
      <MaterialPicker form={form} onChange={value => setForm({ ...value, paragraph_sources: [] })} saved={saved} webSources={webSources} />
      <PodcastWebMaterials disabled={Boolean(archived)} referenceCount={form.source_refs.length + form.note_refs.length + form.wiki_refs.length} sourceIds={form.source_refs} onImportingChange={setBusy} onAdopt={sources => {
        setWebSources(previous => [...new Map([...previous, ...sources].map(source => [source.id, source])).values()]);
        setForm(previous => {
          const sourceRefs = [...new Set([...previous.source_refs, ...sources.map(source => source.id)])];
          return sourceRefs.length === previous.source_refs.length ? previous : { ...previous, source_refs: sourceRefs, paragraph_sources: [] };
        });
      }} />
      <label className="block space-y-2">口播提纲（不朗读）<Textarea value={form.outline} maxLength={20000} onChange={event => field("outline", event.target.value)} /></label>
      <label className="block space-y-2">口播正文（纯文本，请手动编写或粘贴）<Textarea className="min-h-80" value={form.draft_content} maxLength={80000} onChange={event => field("draft_content", event.target.value)} /></label>
      <Button disabled={!form.title.trim() || (!dirty && Boolean(saved))} onClick={() => void save()}>{busy ? "处理中…" : saved ? "保存修改" : "创建并保存播客"}</Button>
    </fieldset>
    <PodcastAuthoring draft={saved} disabled={busy || dirty || Boolean(archived)} onApply={(outline, body, sources) => setForm(previous => ({ ...previous, outline, draft_content: body, paragraph_sources: sources }))} />
    <PodcastParagraphSources fields={form} draft={saved} disabled={busy || Boolean(archived)} onChange={sources => setForm(previous => ({ ...previous, paragraph_sources: sources }))} />
    <section className="space-y-3 rounded border p-5"><h2 className="text-lg font-semibold">实际口播文本预览</h2><p className="text-sm text-muted-foreground">只朗读标题与正文，不自动添加提纲、观点或素材；仅规范换行与行尾空白。</p>
      <PodcastScrollRegion label="实际口播文本预览内容"><pre data-testid="podcast-spoken-preview" className="whitespace-pre-wrap break-words font-sans leading-7">{!dirty && saved ? saved.spoken_text : preview}</pre></PodcastScrollRegion>
      {saved?.approval_issues.map(issue => <p key={issue} className="text-sm text-destructive">{issue}</p>)}
      <Button disabled={busy || archived || !saved || dirty || Boolean(saved?.approval_issues.length) || saved?.approval_status === "current"} onClick={() => void approve()}>确认已保存的口播稿</Button>
      {saved?.latest_approval && <details><summary>上次确认快照（历史记录，不随编辑覆盖）</summary><p>确认时间：{new Date(saved.latest_approval.created_at).toLocaleString()} · 配置版本 {saved.latest_approval.config_revision}</p><PodcastScrollRegion label="历史确认快照内容"><pre className="whitespace-pre-wrap break-words font-sans">{saved.latest_approval.spoken_text}</pre></PodcastScrollRegion></details>}
    </section>
    <PodcastAudioPreflight draft={saved} disabled={busy || dirty || Boolean(archived)} taskRevision={audioTaskRevision} />
    {saved && <PodcastAudioTasks assetId={saved.asset_id} disabled={Boolean(archived)} onAbandoned={() => setAudioTaskRevision(previous => previous + 1)} />}
    {saved && <PodcastDelivery key={saved.asset_id} assetId={saved.asset_id} disabled={Boolean(archived)} />}
  </main>;
}

function MaterialPicker({ form, onChange, saved, webSources }: { form: PodcastDraftFields; onChange: (value: PodcastDraftFields) => void; saved?: PodcastDraft; webSources: Source[] }) {
  const [kind, setKind] = useState<"source" | "note" | "wiki">("source");
  const [page, setPage] = useState(0);
  const [search, setSearch] = useState("");
  const query = useQuery({ queryKey: ["podcast-materials", kind, page], queryFn: async () => {
    const params = { limit: 20, offset: page * 20 };
    if (kind === "source") return sourcesApi.list(params);
    if (kind === "note") return notesApi.list(params);
    return wikiApi.list(params);
  } });
  const key = `${kind}_refs` as "source_refs" | "note_refs" | "wiki_refs";
  const count = form.source_refs.length + form.note_refs.length + form.wiki_refs.length;
  return <section className="space-y-3 rounded border p-4"><h2 className="font-semibold">关联素材（{count}/20）</h2>
    <p className="text-sm text-muted-foreground">素材可选。可以直接在口播正文中粘贴已写好的博客或稿件，无需先导入或关联素材；内容与事实请自行核实。</p>
    <div className="flex flex-wrap gap-2"><select aria-label="素材类型" className="rounded border bg-background p-2" value={kind} onChange={event => { setKind(event.target.value as typeof kind); setPage(0); }}><option value="source">Source</option><option value="note">Note</option><option value="wiki">Wiki</option></select><Input aria-label="筛选当前页素材" placeholder="筛选当前页标题" value={search} onChange={event => setSearch(event.target.value)} /></div>
    {query.isPending && <p role="status">正在加载素材…</p>}
    {query.isError && <p role="alert">素材加载失败<Button variant="outline" onClick={() => void query.refetch()}>重试</Button></p>}
    {query.data?.items.filter(item => item.title.toLowerCase().includes(search.toLowerCase())).map(item => <label key={item.id} className="flex gap-2"><input type="checkbox" checked={form[key].includes(item.id)} disabled={count >= 20 && !form[key].includes(item.id)} onChange={event => onChange({ ...form, [key]: event.target.checked ? [...form[key], item.id] : form[key].filter(id => id !== item.id) })} />{item.title}</label>)}
    <div className="flex items-center gap-2"><Button variant="outline" disabled={!page} onClick={() => setPage(page - 1)}>上一页</Button><span>第 {page + 1} 页</span><Button variant="outline" disabled={!query.data || (page + 1) * 20 >= query.data.total} onClick={() => setPage(page + 1)}>下一页</Button></div>
    <div className="space-y-2">{(["source", "note", "wiki"] as const).flatMap(type => form[`${type}_refs`].map(id => {
      const material = saved?.materials.find(item => item.kind === type && item.id === id);
      const webSource = type === "source" ? webSources.find(source => source.id === id) : undefined;
      return <div key={`${type}:${id}`} className="rounded bg-muted p-2 text-sm"><span>{type}: {material?.title || webSource?.title || id}{material && !material.available ? " · 素材不可用" : ""}</span><Button variant="ghost" size="sm" onClick={() => onChange({ ...form, [`${type}_refs`]: form[`${type}_refs`].filter(value => value !== id) })}>移除</Button>{(material?.excerpt || webSource?.description) && <p className="line-clamp-3 text-muted-foreground">{material?.excerpt || webSource?.description}</p>}</div>;
    }))}</div>
  </section>;
}
