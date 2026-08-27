import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams, Link, useNavigate, useLocation } from "react-router-dom";
import { assetsApi, authApi, notesApi, sourcesApi, wikiApi, type Asset, type AssetStatus, type AssetType, type ReadinessCheckResult } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { MarkdownRenderer } from "@/components/markdown/MarkdownRenderer";
import { ReferenceChips, type ReferenceItem } from "@/components/ReferenceChips";
import { QuestionCard } from "@/components/QuestionCard";
import { splitAssetContent } from "@/lib/asset-content";
import { createAssetBlock, createAssetDocument, loadAssetBlocks, serializeAssetBlocks, updateAssetBlock, type AssetBlock } from "@/lib/asset-blocks";
import { answerHarnessQuestion, harnessChat, type HarnessQuestionAnswer, type HarnessQuestionItem } from "@/lib/api";

type ProductionEvent = {
  event_type?: string;
  asset_id?: string;
  asset_type?: string;
  title?: string;
  status?: string;
  timestamp?: string;
  detail?: Record<string, unknown>;
};

interface AssetBlockPatch {
  assetId: string;
  blockId: string;
  baseRevision: number;
  replacementMarkdown: string;
  explanation?: string;
  addedReferences?: {
    sourceRefs?: string[];
    noteRefs?: string[];
    wikiRefs?: string[];
    webUrls?: string[];
  };
}

interface PendingBlockQuestion {
  rpcId: string;
  sessionId: string;
  questions: HarnessQuestionItem[];
}

interface BlockRevisionState {
  blockId: string;
  baseRevision: number;
  originalMarkdown: string;
  instruction: string;
  sessionId?: string;
  streaming: boolean;
  agentStatus: string;
  pendingQuestion?: PendingBlockQuestion;
  proposal?: AssetBlockPatch;
  error?: string;
}

interface DiffLine {
  kind: "same" | "removed" | "added";
  text: string;
}

function buildLineDiff(original: string, proposed: string): DiffLine[] {
  const before = original.split("\n");
  const after = proposed.split("\n");
  const lengths = Array.from({ length: before.length + 1 }, () => Array(after.length + 1).fill(0));
  for (let left = before.length - 1; left >= 0; left -= 1) {
    for (let right = after.length - 1; right >= 0; right -= 1) {
      lengths[left][right] = before[left] === after[right]
        ? lengths[left + 1][right + 1] + 1
        : Math.max(lengths[left + 1][right], lengths[left][right + 1]);
    }
  }
  const lines: DiffLine[] = [];
  let left = 0;
  let right = 0;
  while (left < before.length && right < after.length) {
    if (before[left] === after[right]) {
      lines.push({ kind: "same", text: before[left] });
      left += 1;
      right += 1;
    } else if (lengths[left + 1][right] >= lengths[left][right + 1]) {
      lines.push({ kind: "removed", text: before[left] });
      left += 1;
    } else {
      lines.push({ kind: "added", text: after[right] });
      right += 1;
    }
  }
  while (left < before.length) lines.push({ kind: "removed", text: before[left++] });
  while (right < after.length) lines.push({ kind: "added", text: after[right++] });
  return lines;
}

function parseAssetBlockPatch(value: unknown): AssetBlockPatch | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.assetId !== "string"
    || typeof candidate.blockId !== "string"
    || typeof candidate.baseRevision !== "number"
    || typeof candidate.replacementMarkdown !== "string"
  ) return null;
  return candidate as unknown as AssetBlockPatch;
}

const STATUS_LABELS: Record<AssetStatus, string> = {
  draft: "Draft",
  in_review: "In Review",
  ready_to_export: "Ready",
  exported: "Exported",
  published: "Published",
  archived: "Archived",
};

function assetTypeLabel(assetType?: string) {
  if (assetType === "research_brief") return "Research Brief";
  if (assetType === "knowledge_pack") return "Knowledge Pack";
  if (assetType === "newsletter_issue") return "Newsletter Issue";
  if (assetType === "topic_report") return "Topic Report";
  return "Blog Post";
}

function assetTypeDescription(assetType?: string) {
  if (assetType === "research_brief") {
    return "A structured research deliverable focused on findings, risks, recommendations, and evidence-backed references.";
  }
  if (assetType === "knowledge_pack") {
    return "A reusable knowledge bundle focused on curation, reading order, and traceable references.";
  }
  if (assetType === "newsletter_issue") {
    return "A curated issue draft focused on editorial framing, featured items, and sendable structure.";
  }
  if (assetType === "topic_report") {
    return "A systematic topic-level report focused on themes, findings, risks, and recommendations.";
  }
  return "An editable blog draft focused on angle, audience, and readable publish-ready structure.";
}

function assetReaderPresentation(assetType?: AssetType) {
  if (assetType === "research_brief") {
    return {
      layout: "research-brief",
      kicker: "Decision document",
      briefLabel: "Executive brief",
      documentLabel: "Research findings",
      contentsLabel: "Brief sections",
      lineageLabel: "Evidence base",
      headerTone: "from-sky-500/15",
    };
  }
  if (assetType === "knowledge_pack") {
    return {
      layout: "knowledge-pack",
      kicker: "Reusable collection",
      briefLabel: "Pack purpose",
      documentLabel: "Guided knowledge pack",
      contentsLabel: "Reading path",
      lineageLabel: "Included knowledge",
      headerTone: "from-emerald-500/15",
    };
  }
  if (assetType === "newsletter_issue") {
    return {
      layout: "newsletter-issue",
      kicker: "Editorial issue",
      briefLabel: "Issue theme",
      documentLabel: "Curated issue",
      contentsLabel: "Issue lineup",
      lineageLabel: "Editorial sources",
      headerTone: "from-rose-500/15",
    };
  }
  if (assetType === "topic_report") {
    return {
      layout: "topic-report",
      kicker: "Topic synthesis",
      briefLabel: "Report scope",
      documentLabel: "Topic analysis",
      contentsLabel: "Report sections",
      lineageLabel: "Research foundation",
      headerTone: "from-violet-500/15",
    };
  }
  return {
    layout: "blog-post",
    kicker: "Editorial draft",
    briefLabel: "Article promise",
    documentLabel: "Article",
    contentsLabel: "Article map",
    lineageLabel: "Supporting evidence",
    headerTone: "from-amber-500/15",
  };
}

function assetTypeReadinessGuidance(assetType?: string) {
  if (assetType === "research_brief") {
    return "A strong brief usually has at least one grounded wiki angle, attached source evidence, and clear sections for executive summary, findings, risks, and recommendations.";
  }
  if (assetType === "knowledge_pack") {
    return "A strong knowledge pack usually has enough linked material to justify the bundle, a clear 'what’s included' section, a guided reading path, and readable references for later reuse.";
  }
  if (assetType === "newsletter_issue") {
    return "A strong newsletter issue usually has a clear theme, a short editor's note, a focused set of featured items, and readable references behind each highlighted item.";
  }
  if (assetType === "topic_report") {
    return "A strong topic report usually has stable wiki grounding, enough material to support themes and findings, explicit risks or gaps, and recommendations that remain traceable to references.";
  }
  return "A strong blog post usually has a clear angle, enough evidence to support the thesis, and readable references before export.";
}

function assetTypeReadinessTitle(assetType?: string) {
  if (assetType === "research_brief") return "Research Brief Readiness";
  if (assetType === "knowledge_pack") return "Knowledge Pack Readiness";
  if (assetType === "newsletter_issue") return "Newsletter Issue Readiness";
  if (assetType === "topic_report") return "Topic Report Readiness";
  return "Blog Post Readiness";
}

function assetTypeReadinessIntro(assetType?: string) {
  if (assetType === "research_brief") {
    return "Check whether this brief is evidence-backed, decision-ready, and complete enough to export.";
  }
  if (assetType === "knowledge_pack") {
    return "Check whether this pack has enough material, a clear reading path, and reusable references before export.";
  }
  if (assetType === "newsletter_issue") {
    return "Check whether this issue has a clear theme, curated featured items, and enough source grounding to send.";
  }
  if (assetType === "topic_report") {
    return "Check whether this report has enough topic grounding, clear structure, and traceable findings before export.";
  }
  return "Check whether this post has a clear angle, enough support, and readable references before export.";
}

function markdownHeadings(content?: string | null) {
  if (!content) return [];
  return content
    .split("\n")
    .map((line) => line.match(/^(#{1,3})\s+(.+)$/))
    .filter((match): match is RegExpMatchArray => Boolean(match))
    .map((match) => ({ level: match[1].length, title: match[2].replace(/[*_`]/g, "").trim() }))
    .slice(0, 16);
}

function readinessTone(ready: boolean) {
  return ready ? "border-emerald-200 bg-emerald-50/80" : "border-amber-200 bg-amber-50/70";
}

function formatProductionEventType(eventType?: string) {
  return String(eventType || "unknown")
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function formatProductionEventSummary(event: ProductionEvent) {
  const title = event.title || event.asset_type || "asset";
  switch (event.event_type) {
    case "asset_generated":
      return `Generated ${title}`;
    case "asset_ready_to_export":
      return `${title} is ready to export`;
    case "asset_exported": {
      const channel = typeof event.detail?.channel === "string" ? event.detail.channel : undefined;
      return channel ? `Exported ${title} to ${channel}` : `Exported ${title}`;
    }
    case "asset_published": {
      const channel = typeof event.detail?.channel === "string" ? event.detail.channel : undefined;
      return channel ? `Published ${title} via ${channel}` : `Published ${title}`;
    }
    case "asset_feedback_recorded":
      return `Recorded feedback for ${title}`;
    default:
      return formatProductionEventType(event.event_type);
  }
}

function productionEventMeta(event: ProductionEvent): string[] {
  const parts: string[] = [];
  const channel = typeof event.detail?.channel === "string" ? event.detail.channel : undefined;
  const exportFormat = typeof event.detail?.export_format === "string" ? event.detail.export_format : undefined;
  const publishUrl = typeof event.detail?.publish_url === "string" ? event.detail.publish_url : undefined;
  const feedback = typeof event.detail?.feedback === "string" ? event.detail.feedback : undefined;

  if (channel) parts.push(`Channel: ${channel}`);
  if (exportFormat && exportFormat !== channel) parts.push(`Format: ${exportFormat}`);
  if (publishUrl) parts.push(`URL: ${publishUrl}`);
  if (feedback) parts.push(`Feedback: ${feedback}`);

  return parts;
}

function normalizeAssetText(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, " ")
    .replace(/\s+/g, " ");
}

function buildPrimaryAction(asset: Asset, readiness?: ReadinessCheckResult | null) {
  if (asset.status === "draft") {
    return { label: "Move to Review", nextStatus: "in_review" as AssetStatus, variant: "default" as const };
  }
  if (asset.status === "in_review") {
    return {
      label: readiness?.ready ? "Mark Ready to Export" : "Ready to Export",
      nextStatus: "ready_to_export" as AssetStatus,
      variant: "default" as const,
    };
  }
  if (asset.status === "ready_to_export") {
    return { label: "Export Markdown", nextStatus: null, variant: "default" as const };
  }
  if (asset.status === "exported") {
    return { label: "Mark Published", nextStatus: "published" as AssetStatus, variant: "default" as const };
  }
  return null;
}

function ReadinessList({ title, items, tone, empty }: { title: string; items: string[]; tone: string; empty: string }) {
  return (
    <div className="space-y-2 rounded-md border bg-background/70 p-3">
      <p className="text-sm font-semibold">{title}</p>
      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">{empty}</p>
      ) : (
        <ul className={`space-y-1 text-sm ${tone}`}>
          {items.map((item) => (
            <li key={item}>• {item}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function AssetDetailPage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const locationState = location.state as { backTo?: string; backLabel?: string } | null;
  const backTo = locationState?.backTo || "/assets";
  const backLabel = locationState?.backLabel || "Back to Assets";

  const assetQuery = useQuery({
    queryKey: ["asset", id],
    queryFn: () => assetsApi.get(id),
    enabled: Boolean(id),
  });

  const sourceOptionsQuery = useQuery({
    queryKey: ["asset-detail-sources"],
    queryFn: () => sourcesApi.list({ limit: 100 }),
  });

  const noteOptionsQuery = useQuery({
    queryKey: ["asset-detail-notes"],
    queryFn: () => notesApi.list({ limit: 100 }),
  });

  const asset = assetQuery.data;
  const publishingSettingsQuery = useQuery({ queryKey: ["publishing-settings"], queryFn: () => authApi.getMyPublishingSettings() });
  const publishingSettings = publishingSettingsQuery.data ?? { primary_site_url: "", default_channel: "" };
  const readerPresentation = assetReaderPresentation(asset?.asset_type);
  const assetQueryError = assetQuery.error instanceof Error ? assetQuery.error.message : null;

  const [publishUrl, setPublishUrl] = useState("");
  const [publishChannel, setPublishChannel] = useState("");
  const [publishFeedback, setPublishFeedback] = useState("");
  const [editTitle, setEditTitle] = useState("");
  const [editBrief, setEditBrief] = useState("");
  const [editOutline, setEditOutline] = useState("");
  const [editBlocks, setEditBlocks] = useState<AssetBlock[]>([]);
  const [editStyle, setEditStyle] = useState("");
  const [previewBlockIds, setPreviewBlockIds] = useState<Set<string>>(() => new Set());
  const [blockRevision, setBlockRevision] = useState<BlockRevisionState | null>(null);
  const blockRevisionAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const feedback = ((asset?.metadata_ || {}) as Record<string, unknown>).publish_feedback as Record<string, unknown> | undefined;
    setPublishUrl(typeof feedback?.publish_url === "string" ? feedback.publish_url : publishingSettings.primary_site_url);
    setPublishChannel(typeof feedback?.channel === "string" ? feedback.channel : publishingSettings.default_channel);
    setPublishFeedback(typeof feedback?.feedback === "string" ? feedback.feedback : "");
  }, [asset, publishingSettings.default_channel, publishingSettings.primary_site_url]);

  useEffect(() => {
    setEditTitle(asset?.title ?? "");
    setEditBrief(asset?.brief ?? "");
    setEditOutline(asset?.outline ?? "");
    setEditBlocks(loadAssetBlocks(asset?.metadata_, asset?.draft_content));
    setEditStyle(asset?.style_notes ?? "");
    setPreviewBlockIds(new Set());
    blockRevisionAbortRef.current?.abort();
    blockRevisionAbortRef.current = null;
    setBlockRevision(null);
  }, [asset]);

  const sourceMap = new Map((sourceOptionsQuery.data?.items ?? []).map((item) => [item.id, item]));
  const noteMap = new Map((noteOptionsQuery.data?.items ?? []).map((item) => [item.id, item]));

  const wikiRefsQuery = useQuery({
    queryKey: ["asset-detail-wiki-refs", id, asset?.wiki_refs],
    queryFn: () => wikiApi.resolveReferences((asset?.wiki_refs ?? []).map((wikiId) => ({ ref_type: "wiki", ref_id: wikiId }))),
    enabled: Boolean(asset?.wiki_refs?.length),
  });

  const productionMemoryQuery = useQuery({
    queryKey: ["asset-production-memory", id],
    queryFn: () => authApi.listMyMemories("production_memory"),
  });

  const assetsListQuery = useQuery({
    queryKey: ["assets", "detail-fallback"],
    queryFn: () => assetsApi.list({ limit: 100 }),
    enabled: assetQuery.isError,
  });

  const readinessQuery = useQuery({
    queryKey: ["asset-readiness", id],
    queryFn: () => assetsApi.checkReadiness(id),
    enabled: Boolean(id && asset),
  });

  const refreshAsset = async () => {
    await queryClient.invalidateQueries({ queryKey: ["asset", id] });
    await queryClient.invalidateQueries({ queryKey: ["assets"] });
    await queryClient.invalidateQueries({ queryKey: ["asset-production-memory", id] });
    await queryClient.invalidateQueries({ queryKey: ["asset-readiness", id] });
  };

  const statusMutation = useMutation({
    mutationFn: (status: AssetStatus) => assetsApi.update(id, { status }),
    onSuccess: refreshAsset,
  });

  const editMutation = useMutation({
    mutationFn: () => assetsApi.update(id, {
      title: editTitle.trim(),
      brief: editBrief,
      outline: editOutline,
      draft_content: serializeAssetBlocks(editBlocks),
      style_notes: editStyle,
      metadata: {
        ...(asset?.metadata_ ?? {}),
        asset_document: createAssetDocument(editBlocks),
      },
    }),
    onSuccess: refreshAsset,
  });

  const changeBlock = (blockId: string, markdown: string) => {
    setEditBlocks((blocks) => blocks.map((block) => block.id === blockId ? updateAssetBlock(block, markdown) : block));
  };

  const moveBlock = (blockId: string, offset: -1 | 1) => {
    setEditBlocks((blocks) => {
      const index = blocks.findIndex((block) => block.id === blockId);
      const target = index + offset;
      if (index < 0 || target < 0 || target >= blocks.length) return blocks;
      const next = [...blocks];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  };

  const insertBlockAfter = (blockId?: string) => {
    setEditBlocks((blocks) => {
      const nextBlock = createAssetBlock("");
      if (!blockId) return [...blocks, nextBlock];
      const index = blocks.findIndex((block) => block.id === blockId);
      if (index < 0) return [...blocks, nextBlock];
      return [...blocks.slice(0, index + 1), nextBlock, ...blocks.slice(index + 1)];
    });
  };

  const deleteBlock = (blockId: string) => {
    setEditBlocks((blocks) => blocks.filter((block) => block.id !== blockId));
    setPreviewBlockIds((current) => {
      const next = new Set(current);
      next.delete(blockId);
      return next;
    });
    if (blockRevision?.blockId === blockId) {
      blockRevisionAbortRef.current?.abort();
      blockRevisionAbortRef.current = null;
      setBlockRevision(null);
    }
  };

  const toggleBlockPreview = (blockId: string) => {
    setPreviewBlockIds((current) => {
      const next = new Set(current);
      if (next.has(blockId)) next.delete(blockId);
      else next.add(blockId);
      return next;
    });
  };

  const openBlockRevision = (block: AssetBlock) => {
    blockRevisionAbortRef.current?.abort();
    blockRevisionAbortRef.current = null;
    setBlockRevision({
      blockId: block.id,
      baseRevision: block.revision,
      originalMarkdown: block.markdown,
      instruction: "",
      streaming: false,
      agentStatus: "",
    });
  };

  const discardBlockRevision = () => {
    blockRevisionAbortRef.current?.abort();
    blockRevisionAbortRef.current = null;
    setBlockRevision(null);
  };

  const startBlockRevision = async () => {
    if (!asset || !blockRevision?.instruction.trim() || blockRevision.streaming) return;
    const selectedIndex = editBlocks.findIndex((block) => block.id === blockRevision.blockId);
    const selectedBlock = editBlocks[selectedIndex];
    if (!selectedBlock) return;
    const request = {
      asset_id: asset.id,
      asset_title: editTitle || asset.title,
      asset_type: asset.asset_type,
      brief: editBrief,
      audience: typeof asset.metadata_?.audience === "string" ? asset.metadata_.audience : "",
      style_notes: editStyle,
      block_id: blockRevision.blockId,
      base_revision: blockRevision.baseRevision,
      block_type: selectedBlock.type,
      previous_block: editBlocks[selectedIndex - 1]?.markdown ?? "",
      selected_block: blockRevision.originalMarkdown,
      next_block: editBlocks[selectedIndex + 1]?.markdown ?? "",
      user_instruction: blockRevision.instruction.trim(),
      source_refs: asset.source_refs ?? [],
      note_refs: asset.note_refs ?? [],
      wiki_refs: asset.wiki_refs ?? [],
    };
    const abortController = new AbortController();
    blockRevisionAbortRef.current?.abort();
    blockRevisionAbortRef.current = abortController;
    setBlockRevision((current) => current ? {
      ...current,
      streaming: true,
      agentStatus: "Agent 正在理解修改要求…",
      pendingQuestion: undefined,
      proposal: undefined,
      error: undefined,
    } : current);

    try {
      for await (const event of harnessChat(
        `请按 revise-asset-block 工作流处理以下 JSON 合同：\n\n${JSON.stringify(request, null, 2)}`,
        {
          preset: "revise-asset-block",
          createSession: true,
          clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          signal: abortController.signal,
        },
      )) {
        if (event.type === "session" && event.session_id) {
          setBlockRevision((current) => current ? { ...current, sessionId: event.session_id } : current);
        } else if (event.type === "text" && event.content) {
          setBlockRevision((current) => current ? {
            ...current,
            agentStatus: `${current.agentStatus}${event.content}`.slice(-1200),
          } : current);
        } else if (event.type === "tool_call") {
          if (event.tool === "propose_asset_block_patch") {
            const proposal = parseAssetBlockPatch(event.args);
            if (
              proposal
              && proposal.assetId === asset.id
              && proposal.blockId === blockRevision.blockId
              && proposal.baseRevision === blockRevision.baseRevision
            ) {
              setBlockRevision((current) => current ? {
                ...current,
                proposal,
                agentStatus: proposal.explanation || "Agent 已生成候选修改，请检查 Diff。",
              } : current);
            } else {
              setBlockRevision((current) => current ? { ...current, error: "Agent 返回的 Block 提案与当前修订合同不匹配。" } : current);
            }
          } else {
            setBlockRevision((current) => current ? { ...current, agentStatus: `Agent 正在调用 ${event.tool || "工具"}…` } : current);
          }
        } else if (event.type === "question" && event.rpc_id && event.session_id && event.questions?.length) {
          const pendingQuestion: PendingBlockQuestion = {
            rpcId: event.rpc_id,
            sessionId: event.session_id,
            questions: event.questions,
          };
          setBlockRevision((current) => current ? {
            ...current,
            pendingQuestion,
            agentStatus: "Agent 需要你确认几个修改细节。",
          } : current);
        } else if (event.type === "error") {
          setBlockRevision((current) => current ? { ...current, error: event.content || "Agent 修改失败。" } : current);
        }
      }
    } catch (error) {
      if (!abortController.signal.aborted) {
        setBlockRevision((current) => current ? {
          ...current,
          error: error instanceof Error ? error.message : "Agent 修改失败。",
        } : current);
      }
    } finally {
      if (blockRevisionAbortRef.current === abortController) blockRevisionAbortRef.current = null;
      setBlockRevision((current) => current ? { ...current, streaming: false, pendingQuestion: undefined } : current);
    }
  };

  const applyBlockRevision = () => {
    if (!blockRevision?.proposal) return;
    const currentBlock = editBlocks.find((block) => block.id === blockRevision.blockId);
    if (!currentBlock || currentBlock.revision !== blockRevision.proposal.baseRevision) {
      setBlockRevision((current) => current ? {
        ...current,
        error: "该段在 Agent 工作期间已经发生变化，请重新生成或手动合并。",
      } : current);
      return;
    }
    changeBlock(currentBlock.id, blockRevision.proposal.replacementMarkdown);
    setBlockRevision(null);
  };

  const exportMutation = useMutation({
    mutationFn: () => assetsApi.exportMarkdown(id),
    onSuccess: refreshAsset,
  });

  const publishMutation = useMutation({
    mutationFn: () => assetsApi.updatePublishFeedback(id, {
      publish_url: publishUrl || null,
      channel: publishChannel || null,
      published_at: new Date().toISOString(),
      feedback: publishFeedback || null,
    }),
    onSuccess: refreshAsset,
  });

  const savePublishFeedbackMutation = useMutation({
    mutationFn: () => assetsApi.updatePublishFeedback(id, {
      publish_url: publishUrl || null,
      channel: publishChannel || null,
      feedback: publishFeedback || null,
    }),
    onSuccess: refreshAsset,
  });

  const feedbackToNoteMutation = useMutation({
    mutationFn: () => assetsApi.feedbackToNote(id),
  });

  const actionError = [statusMutation.error, exportMutation.error, publishMutation.error, savePublishFeedbackMutation.error, feedbackToNoteMutation.error]
    .find((error): error is Error => error instanceof Error)?.message ?? null;

  const deleteMutation = useMutation({
    mutationFn: () => assetsApi.delete(id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["assets"] });
      navigate("/assets");
    },
  });

  const sourceRefItems: ReferenceItem[] = (asset?.source_refs ?? []).map((sourceId) => {
    const source = sourceMap.get(sourceId);
    return {
      ref_type: "source",
      ref_id: sourceId,
      title: source?.title ?? sourceId,
      subtitle: source?.source_type ?? null,
      href: `/sources/${encodeURIComponent(sourceId)}`,
    };
  });

  const noteRefItems: ReferenceItem[] = (asset?.note_refs ?? []).map((noteId) => {
    const note = noteMap.get(noteId);
    return {
      ref_type: "note",
      ref_id: noteId,
      title: note?.title ?? noteId,
      subtitle: note?.note_type ?? null,
      href: `/notes/${encodeURIComponent(noteId)}`,
    };
  });

  const stableWikiItems = (wikiRefsQuery.data?.items ?? []).filter((item) => item.status === "stable") as ReferenceItem[];
  const candidateWikiItems = (wikiRefsQuery.data?.items ?? []).filter((item) => item.status !== "stable") as ReferenceItem[];
  const evidenceLinks = useMemo(() => {
    const links: Record<string, string> = {};
    for (const sourceId of asset?.source_refs ?? []) links[`source:${sourceId}`] = `/sources/${encodeURIComponent(sourceId)}`;
    for (const noteId of asset?.note_refs ?? []) links[`note:${noteId}`] = `/notes/${encodeURIComponent(noteId)}`;
    for (const wikiId of asset?.wiki_refs ?? []) links[`wiki:${wikiId}`] = `/wiki/${encodeURIComponent(wikiId)}`;
    return links;
  }, [asset?.note_refs, asset?.source_refs, asset?.wiki_refs]);
  const productionEvents: ProductionEvent[] = ((productionMemoryQuery.data?.[0]?.value as { events?: ProductionEvent[] } | undefined)?.events ?? [])
    .filter((event) => String(event.asset_id || "") === id)
    .slice(0, 12);

  const fallbackTitle = useMemo(() => {
    const titleFromEvent = productionEvents.find((event) => event.title)?.title;
    if (titleFromEvent) return titleFromEvent;
    const decoded = decodeURIComponent(id);
    const match = decoded.match(/^asset-\d{8}-(.+)-[0-9a-f]{8}$/i);
    if (!match) return null;
    return match[1].replace(/-/g, " ");
  }, [id, productionEvents]);

  const fallbackTitleCandidates = useMemo(() => {
    const candidates = new Set<string>();
    if (fallbackTitle) {
      candidates.add(normalizeAssetText(fallbackTitle));
    }
    const decoded = decodeURIComponent(id);
    const match = decoded.match(/^asset-\d{8}-(.+)-[0-9a-f]{8}$/i);
    if (match) {
      const rawSlug = match[1];
      candidates.add(normalizeAssetText(rawSlug));
      candidates.add(normalizeAssetText(rawSlug.replace(/-/g, " ")));
      candidates.add(normalizeAssetText(rawSlug.replace(/-/g, "")));
    }
    return [...candidates].filter(Boolean);
  }, [fallbackTitle, id]);

  const fallbackAsset = useMemo(() => {
    if (!fallbackTitleCandidates.length) return null;
    const items = assetsListQuery.data?.items ?? [];
    const exact = items.find((item) => fallbackTitleCandidates.includes(normalizeAssetText(item.title)));
    if (exact) return exact;
    return items.find((item) => fallbackTitleCandidates.some((candidate) => normalizeAssetText(item.title).includes(candidate) || candidate.includes(normalizeAssetText(item.title)))) ?? null;
  }, [assetsListQuery.data, fallbackTitleCandidates]);

  const isBusy = statusMutation.isPending || exportMutation.isPending || publishMutation.isPending || savePublishFeedbackMutation.isPending;
  const primaryAction = useMemo(() => (asset ? buildPrimaryAction(asset, readinessQuery.data) : null), [asset, readinessQuery.data]);
  const contentPresentation = useMemo(() => splitAssetContent(asset?.draft_content), [asset?.draft_content]);
  const headings = useMemo(() => markdownHeadings(contentPresentation.readerMarkdown), [contentPresentation.readerMarkdown]);
  const audience = typeof asset?.metadata_?.audience === "string" ? asset.metadata_.audience : null;

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-5xl space-y-6 px-6 py-8">
        <div className="flex items-center justify-between gap-4">
          <div className="flex flex-wrap items-center gap-2">
            <Link to={backTo} className="text-sm text-primary hover:underline">{backLabel}</Link>
            {asset && <><span className="text-muted-foreground">/</span><Badge variant="outline">{assetTypeLabel(asset.asset_type)}</Badge><Badge variant="secondary">{STATUS_LABELS[asset.status]}</Badge></>}
            {!asset && <span className="text-sm text-muted-foreground">Loading Asset…</span>}
          </div>
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="outline" onClick={() => exportMutation.mutate()} disabled={!asset || isBusy || asset.status !== "ready_to_export"}>
              {exportMutation.isPending ? "Exporting…" : "Export Markdown"}
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                if (asset && window.confirm(`Delete asset \"${asset.title}\"? This cannot be undone.`)) {
                  deleteMutation.mutate();
                }
              }}
              disabled={!asset || deleteMutation.isPending}
            >
              {deleteMutation.isPending ? "Deleting…" : "Delete"}
            </Button>
          </div>
        </div>

        {assetQuery.isError && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Asset unavailable</CardTitle>
              <CardDescription>
                {assetQueryError?.startsWith("404:")
                  ? "This asset no longer exists or belongs to another user."
                  : "Failed to load this asset."}
              </CardDescription>
            </CardHeader>
            <CardContent className="flex gap-2">
              <Button variant="outline" onClick={() => navigate(backTo)}>
                {backLabel}
              </Button>
              {fallbackAsset && (
                <Button onClick={() => navigate(`/assets/${encodeURIComponent(fallbackAsset.id)}`, { state: { backTo, backLabel } })}>
                  Open Current Asset
                </Button>
              )}
              <Button variant="outline" onClick={() => assetQuery.refetch()}>
                Retry
              </Button>
            </CardContent>
          </Card>
        )}

        {!asset && !assetQuery.isError && <p className="text-sm text-muted-foreground">Loading...</p>}

        {asset && !assetQuery.isError && (
          <Tabs defaultValue="read" className="space-y-6">
            <div className="sticky top-0 z-10 -mx-2 border-b bg-background/95 px-2 py-2 backdrop-blur">
              <TabsList>
                <TabsTrigger value="read">Read</TabsTrigger>
                <TabsTrigger value="edit">Edit</TabsTrigger>
                <TabsTrigger value="evidence">Evidence</TabsTrigger>
                <TabsTrigger value="production">Production</TabsTrigger>
              </TabsList>
            </div>

            <TabsContent value="read" className="mt-0 space-y-8">
              <article data-reader-layout={readerPresentation.layout} className="overflow-hidden rounded-3xl border bg-card shadow-sm">
                <header className={`border-b bg-gradient-to-br ${readerPresentation.headerTone} via-background to-background px-6 py-10 sm:px-10 lg:px-14`}>
                  <div className="mx-auto max-w-4xl">
                    <p className="mb-4 text-xs font-semibold uppercase tracking-[0.2em] text-muted-foreground">{readerPresentation.kicker}</p>
                    <div className="mb-5 flex flex-wrap items-center gap-2">
                      <Badge>{assetTypeLabel(asset.asset_type)}</Badge>
                      <Badge variant="outline">{STATUS_LABELS[asset.status]}</Badge>
                      <span className="text-xs text-muted-foreground">Updated {new Date(asset.updated_at).toLocaleDateString()}</span>
                    </div>
                    <h2 className="max-w-3xl text-4xl font-semibold tracking-tight text-foreground sm:text-5xl">{asset.title}</h2>
                    {asset.brief && (
                      <div className="mt-7 max-w-3xl rounded-2xl border bg-background/70 p-5 shadow-sm">
                        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{readerPresentation.briefLabel}</p>
                        <p className="mt-2 text-lg leading-8 text-foreground/80">{asset.brief}</p>
                      </div>
                    )}
                    <div className="mt-6 flex flex-wrap gap-x-6 gap-y-2 text-sm text-muted-foreground">
                      {audience && <span><span className="font-medium text-foreground">Audience:</span> {audience}</span>}
                      <span><span className="font-medium text-foreground">Evidence:</span> {sourceRefItems.length + noteRefItems.length + stableWikiItems.length + candidateWikiItems.length} records</span>
                    </div>
                  </div>
                </header>

                <div className="mx-auto grid max-w-6xl gap-10 px-6 py-10 sm:px-10 lg:grid-cols-[minmax(0,1fr)_240px] lg:px-14">
                  <div className="min-w-0">
                    <p className="mb-6 text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">{readerPresentation.documentLabel}</p>
                    {contentPresentation.readerMarkdown ? (
                      <div className="prose prose-slate max-w-none text-base leading-8 dark:prose-invert prose-headings:scroll-mt-24 prose-headings:tracking-tight prose-h2:mt-12 prose-h2:border-b prose-h2:pb-3 prose-p:my-5 prose-li:my-2 prose-blockquote:border-primary/40 prose-blockquote:bg-muted/30 prose-blockquote:px-5 prose-blockquote:py-1">
                        <MarkdownRenderer
                          components={{
                            a({ href, children, node, ...props }) {
                              void node;
                              if (href?.startsWith("/")) {
                                return <Link to={href} className="font-medium text-primary underline decoration-primary/30 underline-offset-4 hover:decoration-primary" {...props}>{children}</Link>;
                              }
                              return <a href={href} {...props}>{children}</a>;
                            },
                          }}
                        >
                          {contentPresentation.readerMarkdown}
                        </MarkdownRenderer>
                      </div>
                    ) : (
                      <div className="rounded-2xl border border-dashed p-10 text-center text-muted-foreground">This Asset does not have draft content yet. Continue it from the production workspace.</div>
                    )}
                  </div>

                  <aside className="space-y-6 lg:sticky lg:top-20 lg:self-start">
                    <div className="rounded-2xl border bg-muted/20 p-4">
                      <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{readerPresentation.contentsLabel}</p>
                      {headings.length > 0 ? (
                        <ol className="mt-3 space-y-2 text-sm">
                          {headings.map((heading, index) => <li key={`${heading.title}-${index}`} className={heading.level === 1 ? "font-medium" : heading.level === 2 ? "pl-2" : "pl-5 text-muted-foreground"}>{heading.title}</li>)}
                        </ol>
                      ) : (
                        <p className="mt-3 text-sm text-muted-foreground">No navigable sections yet.</p>
                      )}
                    </div>
                    <div className="rounded-2xl border p-4">
                      <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{readerPresentation.lineageLabel}</p>
                      <div className="mt-3 space-y-3 text-sm">
                        <div className="flex justify-between"><span>Sources</span><span className="font-medium">{sourceRefItems.length}</span></div>
                        <div className="flex justify-between"><span>Notes</span><span className="font-medium">{noteRefItems.length}</span></div>
                        <div className="flex justify-between"><span>Wiki</span><span className="font-medium">{stableWikiItems.length + candidateWikiItems.length}</span></div>
                      </div>
                    </div>
                  </aside>
                </div>
              </article>
            </TabsContent>

            <TabsContent value="edit" className="mt-0">
              <Card>
                <CardHeader><CardTitle>Edit Asset</CardTitle><CardDescription>Edit the draft block by block. Reorder, insert, or remove blocks, then save the complete working document.</CardDescription></CardHeader>
                <CardContent className="space-y-5">
                  <div className="grid gap-4 md:grid-cols-2">
                    <div className="space-y-2"><label className="text-sm font-medium" htmlFor="asset-edit-title">Title</label><Input id="asset-edit-title" value={editTitle} onChange={(event) => setEditTitle(event.target.value)} /></div>
                    <div className="space-y-2"><label className="text-sm font-medium" htmlFor="asset-edit-style">Style guidance</label><Input id="asset-edit-style" value={editStyle} onChange={(event) => setEditStyle(event.target.value)} /></div>
                  </div>
                  <div className="space-y-2"><label className="text-sm font-medium" htmlFor="asset-edit-brief">Brief</label><Textarea id="asset-edit-brief" rows={4} value={editBrief} onChange={(event) => setEditBrief(event.target.value)} /></div>
                  <div className="space-y-2"><label className="text-sm font-medium" htmlFor="asset-edit-outline">Outline</label><Textarea id="asset-edit-outline" className="font-mono text-sm" rows={8} value={editOutline} onChange={(event) => setEditOutline(event.target.value)} /></div>
                  <div className="space-y-3">
                    <div className="flex items-center justify-between gap-3"><div><h3 className="text-sm font-medium">Draft Blocks</h3><p className="text-xs text-muted-foreground">Each heading, paragraph group, list, quote, table, or code fence is edited independently.</p></div><Button type="button" variant="outline" size="sm" onClick={() => insertBlockAfter()}>Add Block</Button></div>
                    {editBlocks.length === 0 && <div className="rounded-xl border border-dashed p-8 text-center"><p className="text-sm text-muted-foreground">This draft has no content blocks yet.</p><Button type="button" variant="outline" size="sm" className="mt-3" onClick={() => insertBlockAfter()}>Add First Block</Button></div>}
                    {editBlocks.map((block, index) => {
                      const revision = blockRevision?.blockId === block.id ? blockRevision : null;
                      const previewing = previewBlockIds.has(block.id);
                      const diffLines = revision?.proposal
                        ? buildLineDiff(revision.originalMarkdown, revision.proposal.replacementMarkdown)
                        : [];
                      return (
                      <div key={block.id} className="rounded-xl border bg-muted/10 p-4" data-asset-block-id={block.id}>
                        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                          <div className="flex items-center gap-2"><Badge variant="outline">{index + 1}</Badge><Badge variant="secondary">{block.type}</Badge><span className="text-xs text-muted-foreground">revision {block.revision}</span></div>
                          <div className="flex flex-wrap gap-2">
                            <Button type="button" variant={previewing ? "secondary" : "outline"} size="sm" aria-label={`${previewing ? "Hide preview for" : "Preview"} block ${index + 1}`} onClick={() => toggleBlockPreview(block.id)}>{previewing ? "Hide Preview" : "Preview"}</Button>
                            <Button type="button" variant={revision ? "secondary" : "outline"} size="sm" onClick={() => revision ? discardBlockRevision() : openBlockRevision(block)}>{revision ? "关闭 Agent" : "让 Agent 修改"}</Button>
                            <Button type="button" variant="outline" size="sm" onClick={() => moveBlock(block.id, -1)} disabled={index === 0}>Move Up</Button>
                            <Button type="button" variant="outline" size="sm" onClick={() => moveBlock(block.id, 1)} disabled={index === editBlocks.length - 1}>Move Down</Button>
                            <Button type="button" variant="outline" size="sm" onClick={() => insertBlockAfter(block.id)}>Add Below</Button>
                            <Button type="button" variant="outline" size="sm" onClick={() => deleteBlock(block.id)}>Delete</Button>
                          </div>
                        </div>
                        <Textarea aria-label={`Draft block ${index + 1}`} className="min-h-28 font-mono text-sm leading-6" value={block.markdown} onChange={(event) => changeBlock(block.id, event.target.value)} />
                        {previewing && (
                          <div className="mt-4 rounded-lg border bg-background p-4" data-block-preview={block.id}>
                            <div className="mb-3 flex items-center justify-between gap-3">
                              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Block Preview</p>
                              <Badge variant="outline">{block.type}</Badge>
                            </div>
                            <div className="prose prose-slate max-w-none dark:prose-invert">
                              <MarkdownRenderer evidenceLinks={evidenceLinks}>{block.markdown}</MarkdownRenderer>
                            </div>
                          </div>
                        )}
                        {revision && (
                          <div className="mt-4 space-y-4 rounded-lg border border-primary/20 bg-background p-4" data-agent-block-revision={block.id}>
                            <div>
                              <p className="text-sm font-semibold">Agent Block Revision</p>
                              <p className="text-xs text-muted-foreground">Agent 只生成候选补丁；点击应用后仍需 Save Changes 才会写入 Asset。</p>
                            </div>
                            <div className="space-y-2">
                              <label className="text-sm font-medium" htmlFor={`agent-block-instruction-${block.id}`}>你希望怎么修改这一段？</label>
                              <Textarea
                                id={`agent-block-instruction-${block.id}`}
                                aria-label={`Agent instruction for block ${index + 1}`}
                                rows={3}
                                value={revision.instruction}
                                disabled={revision.streaming}
                                placeholder="例如：压缩到 120 字，保留论点和证据标记，语气更直接。"
                                onChange={(event) => setBlockRevision((current) => current ? { ...current, instruction: event.target.value } : current)}
                              />
                              <div className="flex flex-wrap gap-2">
                                <Button type="button" size="sm" onClick={() => void startBlockRevision()} disabled={!revision.instruction.trim() || revision.streaming}>
                                  {revision.streaming ? "Agent 工作中…" : revision.proposal ? "重新生成" : "开始修改"}
                                </Button>
                                {revision.streaming && <Button type="button" variant="outline" size="sm" onClick={discardBlockRevision}>停止并丢弃</Button>}
                              </div>
                            </div>
                            {revision.agentStatus && <p className="whitespace-pre-wrap text-sm text-muted-foreground">{revision.agentStatus}</p>}
                            {revision.pendingQuestion && (
                              <div className="overflow-hidden rounded-lg border">
                                <QuestionCard
                                  questions={revision.pendingQuestion.questions}
                                  onSubmit={async (answers: HarnessQuestionAnswer[]) => {
                                    await answerHarnessQuestion(revision.pendingQuestion!.rpcId, revision.pendingQuestion!.sessionId, answers);
                                    setBlockRevision((current) => current ? {
                                      ...current,
                                      pendingQuestion: undefined,
                                      agentStatus: "已提交澄清信息，Agent 正在继续修改…",
                                    } : current);
                                  }}
                                />
                              </div>
                            )}
                            {revision.proposal && (
                              <div className="space-y-3" data-agent-diff-preview>
                                <div className="flex flex-wrap items-center justify-between gap-2">
                                  <div><p className="text-sm font-semibold">Diff Preview</p><p className="text-xs text-muted-foreground">绿色为新增，红色为删除。应用前不会改动当前 Block。</p></div>
                                  <Badge variant="outline">base revision {revision.proposal.baseRevision}</Badge>
                                </div>
                                {revision.proposal.explanation && <p className="rounded-md bg-muted/50 p-3 text-sm">{revision.proposal.explanation}</p>}
                                <pre className="max-h-96 overflow-auto rounded-md border bg-muted/20 p-3 text-xs leading-5">
                                  {diffLines.map((line, lineIndex) => (
                                    <div
                                      key={`${lineIndex}-${line.kind}`}
                                      className={line.kind === "added" ? "bg-emerald-100 text-emerald-950" : line.kind === "removed" ? "bg-red-100 text-red-950" : "text-muted-foreground"}
                                    >
                                      <span className="mr-2 inline-block w-3 select-none">{line.kind === "added" ? "+" : line.kind === "removed" ? "-" : " "}</span>{line.text || " "}
                                    </div>
                                  ))}
                                </pre>
                                <div className="grid gap-3 md:grid-cols-2">
                                  <div className="space-y-1"><p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Original</p><pre className="max-h-56 overflow-auto whitespace-pre-wrap rounded-md border bg-red-50/50 p-3 text-xs">{revision.originalMarkdown}</pre></div>
                                  <div className="space-y-1"><p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Proposed</p><pre className="max-h-56 overflow-auto whitespace-pre-wrap rounded-md border bg-emerald-50/50 p-3 text-xs">{revision.proposal.replacementMarkdown}</pre></div>
                                </div>
                                <div className="flex flex-wrap gap-2">
                                  <Button type="button" size="sm" onClick={applyBlockRevision}>确认应用</Button>
                                  <Button type="button" variant="outline" size="sm" onClick={() => void startBlockRevision()} disabled={revision.streaming}>重新生成</Button>
                                  <Button type="button" variant="ghost" size="sm" onClick={discardBlockRevision}>丢弃</Button>
                                </div>
                              </div>
                            )}
                            {revision.error && <p className="text-sm text-destructive">{revision.error}</p>}
                          </div>
                        )}
                      </div>
                      );
                    })}
                  </div>
                  <div className="flex items-center gap-3"><Button onClick={() => editMutation.mutate()} disabled={!editTitle.trim() || editMutation.isPending}>{editMutation.isPending ? "Saving…" : "Save Changes"}</Button>{editMutation.isSuccess && <span className="text-sm text-emerald-700">Saved. Open Read to inspect the rendered document.</span>}{editMutation.isError && <span className="text-sm text-destructive">Could not save Asset changes.</span>}</div>
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="evidence" className="mt-0">
              <div className="space-y-6">
                {contentPresentation.editorialMarkdown && (
                  <Card>
                    <CardHeader><CardTitle>Editorial Evidence Notes</CardTitle><CardDescription>Agent-produced grounding, confidence, gaps, and review notes. These stay out of the reader preview.</CardDescription></CardHeader>
                    <CardContent className="prose prose-slate max-w-none dark:prose-invert">
                      <MarkdownRenderer evidenceLinks={evidenceLinks}>{contentPresentation.editorialMarkdown}</MarkdownRenderer>
                    </CardContent>
                  </Card>
                )}
                <Card>
                  <CardHeader><CardTitle>Knowledge Evidence</CardTitle><CardDescription>Sources, Notes, and Wiki pages used to produce this Asset.</CardDescription></CardHeader>
                  <CardContent className="grid gap-6 md:grid-cols-2">
                    <div className="space-y-2"><h3 className="text-sm font-semibold">Sources</h3><ReferenceChips items={sourceRefItems} />{sourceRefItems.length === 0 && <p className="text-sm text-muted-foreground">No Source references attached.</p>}</div>
                    <div className="space-y-2"><h3 className="text-sm font-semibold">Notes</h3><ReferenceChips items={noteRefItems} />{noteRefItems.length === 0 && <p className="text-sm text-muted-foreground">No Note references attached.</p>}</div>
                    <div className="space-y-2"><h3 className="text-sm font-semibold">Stable Wiki</h3><ReferenceChips items={stableWikiItems} />{stableWikiItems.length === 0 && <p className="text-sm text-muted-foreground">No stable Wiki references attached.</p>}</div>
                    <div className="space-y-2"><h3 className="text-sm font-semibold">Draft Wiki</h3><ReferenceChips items={candidateWikiItems} />{candidateWikiItems.length === 0 && <p className="text-sm text-muted-foreground">No draft Wiki references attached.</p>}</div>
                  </CardContent>
                </Card>
              </div>
            </TabsContent>

            <TabsContent value="production" className="mt-0 space-y-6">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Production Actions</CardTitle>
                <CardDescription>Push this asset from draft into review, export-ready, exported, and published states.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex flex-wrap gap-2">
                  {primaryAction?.nextStatus && (
                    <Button onClick={() => statusMutation.mutate(primaryAction.nextStatus)} disabled={isBusy || (primaryAction.nextStatus === "ready_to_export" && !readinessQuery.data?.ready)}>
                      {statusMutation.isPending ? "Updating…" : primaryAction.label}
                    </Button>
                  )}
                  {primaryAction && !primaryAction.nextStatus && asset.status === "ready_to_export" && (
                    <Button onClick={() => exportMutation.mutate()} disabled={isBusy}>
                      {exportMutation.isPending ? "Exporting…" : primaryAction.label}
                    </Button>
                  )}
                  {asset.status !== "draft" && asset.status !== "archived" && asset.status !== "published" && (
                    <Button variant="outline" onClick={() => statusMutation.mutate("draft")} disabled={isBusy}>
                      Move back to Draft
                    </Button>
                  )}
                  {asset.status === "published" && (
                    <Button variant="outline" onClick={() => statusMutation.mutate("archived")} disabled={isBusy}>
                      Archive
                    </Button>
                  )}
                </div>

                {statusMutation.isError && (
                  <p className="text-sm text-destructive">Failed to update asset status. Check readiness and retry.</p>
                )}
                {exportMutation.isError && (
                  <p className="text-sm text-destructive">Export failed. Make sure the asset is ready and has references.</p>
                )}
                {publishMutation.isError && (
                  <p className="text-sm text-destructive">Failed to mark asset as published. Add publish details and retry.</p>
                )}
                {actionError?.startsWith("404:") && (
                  <p className="text-sm text-destructive">This asset no longer exists. Go back to the assets list and reopen the current item.</p>
                )}

                {readinessQuery.data && (
                  <div className={`space-y-4 rounded-lg border p-4 ${readinessTone(readinessQuery.data.ready)}`}>
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="text-sm font-semibold">{assetTypeReadinessTitle(asset.asset_type)}</p>
                        <p className="mt-1 text-sm text-muted-foreground">{assetTypeReadinessIntro(asset.asset_type)}</p>
                      </div>
                      <Badge variant={readinessQuery.data.ready ? "default" : "secondary"}>
                        {readinessQuery.data.ready ? "Ready to export" : "Needs work"}
                      </Badge>
                    </div>

                    <div className="grid gap-3 md:grid-cols-3">
                      <ReadinessList title="Blocking" items={readinessQuery.data.blocking_reasons} tone="text-destructive" empty="No blocking issues." />
                      <ReadinessList title="Warnings" items={readinessQuery.data.warning_reasons} tone="text-amber-700" empty="No warning signals." />
                      <ReadinessList title="Suggested next steps" items={readinessQuery.data.suggestion_reasons} tone="text-sky-700" empty="No extra suggestions right now." />
                    </div>

                    <div className="rounded-md border bg-background/80 p-3 text-sm text-muted-foreground">
                      {assetTypeReadinessGuidance(asset.asset_type)}
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">Publish Details</CardTitle>
                <CardDescription>Save publish metadata now, or mark the asset as published once it ships.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid gap-4 md:grid-cols-2">
                  <div className="space-y-2">
                    <h3 className="text-sm font-semibold">Publish URL</h3>
                    <Input value={publishUrl} onChange={(e) => setPublishUrl(e.target.value)} placeholder="https://..." />
                    {publishingSettings.primary_site_url && publishUrl === publishingSettings.primary_site_url && <p className="text-xs text-muted-foreground">Defaulted from Settings. Replace it with the final article URL when this Asset is published.</p>}
                  </div>
                  <div className="space-y-2">
                    <h3 className="text-sm font-semibold">Channel</h3>
                    <Input value={publishChannel} onChange={(e) => setPublishChannel(e.target.value)} placeholder="blog, x, newsletter" />
                  </div>
                </div>

                <div className="space-y-2">
                  <h3 className="text-sm font-semibold">Publish Feedback</h3>
                  <Textarea value={publishFeedback} onChange={(e) => setPublishFeedback(e.target.value)} rows={4} />
                </div>

                <div className="flex flex-wrap gap-2">
                  <Button variant="outline" onClick={() => savePublishFeedbackMutation.mutate()} disabled={isBusy || (!publishUrl.trim() && !publishChannel.trim() && !publishFeedback.trim())}>
                    {savePublishFeedbackMutation.isPending ? "Saving…" : "Save Publish Details"}
                  </Button>
                  <Button onClick={() => publishMutation.mutate()} disabled={isBusy || asset.status !== "exported"}>
                    {publishMutation.isPending ? "Publishing…" : "Mark Published"}
                  </Button>
                  <Button variant="outline" onClick={() => feedbackToNoteMutation.mutate()} disabled={feedbackToNoteMutation.isPending || !publishFeedback.trim()}>
                    {feedbackToNoteMutation.isPending ? "Converting…" : "Feedback to Note"}
                  </Button>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">Production Timeline</CardTitle>
                <CardDescription>Asset creation, export, publication, and feedback events recorded in Production History.</CardDescription>
              </CardHeader>
              <CardContent>
                {productionEvents.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No production events recorded yet.</p>
                ) : (
                  <div className="space-y-3">
                    {productionEvents.map((event, index) => (
                      <div key={`${String(event.timestamp || index)}-${String(event.event_type || index)}`} className="rounded-md border bg-muted/20 p-3">
                        <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                          <div className="space-y-2">
                            <div className="flex flex-wrap items-center gap-2">
                              <Badge variant="outline">{formatProductionEventType(event.event_type)}</Badge>
                              {event.asset_type && <Badge variant="secondary">{event.asset_type}</Badge>}
                              {event.status && <Badge variant="secondary">{event.status}</Badge>}
                            </div>
                            <div className="text-sm font-medium">{formatProductionEventSummary(event)}</div>
                            {(event.title || event.asset_id) && (
                              <p className="text-xs text-muted-foreground">
                                {event.title || "Untitled asset"}
                                {event.asset_id ? ` · ${event.asset_id}` : ""}
                              </p>
                            )}
                            {productionEventMeta(event).length > 0 && (
                              <div className="flex flex-wrap gap-2 pt-1">
                                {productionEventMeta(event).map((item) => (
                                  <span key={item} className="rounded-full bg-muted px-2 py-1 text-[11px] text-muted-foreground">
                                    {item}
                                  </span>
                                ))}
                              </div>
                            )}
                          </div>
                          <div className="text-xs text-muted-foreground">
                            {event.timestamp ? new Date(event.timestamp).toLocaleString() : "Unknown time"}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
            </TabsContent>
          </Tabs>
        )}
      </div>
    </div>
  );
}
