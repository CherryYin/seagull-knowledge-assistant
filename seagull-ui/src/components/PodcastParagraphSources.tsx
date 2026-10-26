import { useRef, useState } from "react";
import type { PodcastDraft, PodcastDraftFields, PodcastParagraphSource } from "@/lib/api";
import { paragraphSources, podcastParagraphs } from "@/lib/podcast-authoring";
import { PodcastScrollRegion } from "@/components/PodcastScrollRegion";

export function PodcastParagraphSources({ fields, draft, disabled, onChange }: {
  fields: PodcastDraftFields;
  draft?: PodcastDraft;
  disabled: boolean;
  onChange: (sources: PodcastParagraphSource[]) => void;
}) {
  const [error, setError] = useState("");
  const [hashing, setHashing] = useState(false);
  const operation = useRef(false);
  const signature = JSON.stringify([fields.draft_content, fields.source_refs, fields.note_refs, fields.wiki_refs, fields.paragraph_sources]);
  const latest = useRef({ signature, disabled });
  latest.current = { signature, disabled };
  const paragraphs = podcastParagraphs(fields.draft_content);
  const materials = (["source", "note", "wiki"] as const).flatMap(kind => fields[`${kind}_refs`].map(id => ({ kind, id,
    title: draft?.materials.find(material => material.kind === kind && material.id === id)?.title || id })));

  const toggle = async (position: number, material: typeof materials[number], checked: boolean) => {
    if (operation.current || disabled) return;
    operation.current = true;
    setHashing(true);
    setError("");
    const body = fields.draft_content;
    const refs = paragraphs.map((_, index) => fields.paragraph_sources?.[index]?.material_refs || []);
    refs[position] = checked ? [...refs[position], { kind: material.kind, id: material.id }] : refs[position].filter(ref => ref.kind !== material.kind || ref.id !== material.id);
    try {
      const sources = await paragraphSources(body, refs);
      if (latest.current.signature !== signature || latest.current.disabled) throw new Error("正文或选材已变化，来源修改未应用，请重试。");
      onChange(sources);
    } catch (reason) { setError(String(reason)); }
    finally { operation.current = false; setHashing(false); }
  };

  return <section className="space-y-3 rounded border p-4"><h2 className="font-semibold">段落来源</h2>
    <p className="text-sm text-muted-foreground">关联只表示本段使用了哪些选定材料，不代表事实审核通过。修改正文或选材后会清除旧映射，需重新关联。</p>
    {error && <p role="alert">{error}</p>}
    {!paragraphs.length && <p className="text-sm text-muted-foreground">填写正文后可逐段关联来源。</p>}
    {paragraphs.length > 200 ? <p role="alert">超过 200 段，暂不支持逐段来源关联，请先合并段落。</p> : paragraphs.length > 0 && <PodcastScrollRegion label="段落来源列表" className="space-y-3">{paragraphs.map((paragraph, position) => <details key={position} className="rounded bg-muted p-3"><summary className="cursor-pointer text-sm">第 {position + 1} 段 · {fields.paragraph_sources?.[position]?.material_refs.length || 0} 份素材 · {paragraph.slice(0, 60)}</summary>
      <p className="my-2 whitespace-pre-wrap text-sm">{paragraph}</p>
      {materials.map(material => <label key={`${material.kind}:${material.id}`} className="flex gap-2 text-sm"><input type="checkbox" disabled={disabled || hashing} aria-label={`第 ${position + 1} 段来源：${material.title}`} checked={Boolean(fields.paragraph_sources?.[position]?.material_refs.some(ref => ref.kind === material.kind && ref.id === material.id))} onChange={event => void toggle(position, material, event.target.checked)} />{material.kind} · {material.title}</label>)}
      {!fields.paragraph_sources?.[position]?.material_refs.length && <p className="mt-2 text-xs text-muted-foreground">未关联素材：如包含事实，请补依据；如为个人观点或过渡，请自行确认。</p>}
    </details>)}</PodcastScrollRegion>}
  </section>;
}
