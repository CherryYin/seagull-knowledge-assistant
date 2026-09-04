import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams, Link, useNavigate, useLocation } from "react-router-dom";
import { BookOpen, CalendarDays, ChartNoAxesCombined, CheckCircle2, CircleAlert, Clock3, Copy, Download, Eye, FileSearch, LibraryBig, MailOpen, PenLine, Quote, Sparkles, WandSparkles } from "lucide-react";
import { assetsApi, authApi, notesApi, sourcesApi, wikiApi, type Asset, type AssetClaimProposalInput, type AssetContributionKind, type AssetEvidenceProposalInput, type AssetKnowledgeProposalInput, type AssetStatus, type AssetType, type ReadinessCheckResult } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { MarkdownRenderer } from "@/components/markdown/MarkdownRenderer";
import { ReferenceChips, type ReferenceItem } from "@/components/ReferenceChips";
import { QuestionCard } from "@/components/QuestionCard";
import { splitAssetContent } from "@/lib/asset-content";
import { createAssetBlock, createAssetDocument, loadAssetBlocks, serializeAssetBlocks, updateAssetBlock, updateAssetBlockClaimRefs, type AssetBlock } from "@/lib/asset-blocks";
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
  claimRefs?: string[];
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

interface AgentEvidenceProposalItem {
  targetType: "source" | "note" | "wiki" | "web";
  targetId: string;
  relation: "supports" | "contradicts" | "context" | "unverified";
  summary: string;
  fragmentSelector?: Record<string, unknown>;
}

interface AgentEvidenceProposal {
  assetId: string;
  baseWorkspaceRevision: number;
  intentRevision: number;
  proposals: AgentEvidenceProposalItem[];
}

interface EvidenceAgentState {
  instruction: string;
  streaming: boolean;
  status: string;
  sessionId?: string;
  pendingQuestion?: PendingBlockQuestion;
  proposal?: AgentEvidenceProposal;
  error?: string;
}

interface AgentClaimProposalItem {
  content: string;
  kind: "inference" | "hypothesis" | "recommendation" | "synthesis";
  supportingEvidence: string[];
  contradictingEvidence: string[];
  agentConfidence: "low" | "medium" | "high";
}

interface AgentClaimProposal {
  assetId: string;
  baseWorkspaceRevision: number;
  intentRevision: number;
  proposals: AgentClaimProposalItem[];
}

interface ClaimAgentState {
  instruction: string;
  streaming: boolean;
  status: string;
  sessionId?: string;
  proposal?: AgentClaimProposal;
  error?: string;
}

interface AgentKnowledgeProposal {
  assetId: string;
  baseWorkspaceRevision: number;
  contribution: {
    kind: AssetContributionKind;
    summary: string;
    claimRefs: string[];
  };
  candidates: Array<{
    candidateType: "note" | "wiki";
    action: "create" | "update";
    targetWikiId?: string | null;
    title: string;
    content: string;
    claimRefs: string[];
  }>;
}

interface KnowledgeAgentState {
  instruction: string;
  streaming: boolean;
  status: string;
  sessionId?: string;
  proposal?: AgentKnowledgeProposal;
  error?: string;
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

interface AssetDocumentPatchBlock {
  blockId: string;
  baseRevision: number;
  replacementMarkdown: string;
  claimRefs: string[];
}

interface AssetDocumentPatch {
  assetId: string;
  baseWorkspaceRevision: number;
  replacementTitle: string;
  replacementBrief: string;
  explanation?: string;
  blocks: AssetDocumentPatchBlock[];
}

interface DocumentRevisionState {
  instruction: string;
  streaming: boolean;
  status: string;
  sessionId?: string;
  pendingQuestion?: PendingBlockQuestion;
  proposal?: AssetDocumentPatch;
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
  if (candidate.claimRefs !== undefined && (!Array.isArray(candidate.claimRefs) || candidate.claimRefs.some((item) => typeof item !== "string"))) return null;
  return candidate as unknown as AssetBlockPatch;
}

function parseAssetDocumentPatch(value: unknown): AssetDocumentPatch | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.assetId !== "string"
    || typeof candidate.baseWorkspaceRevision !== "number"
    || typeof candidate.replacementTitle !== "string"
    || typeof candidate.replacementBrief !== "string"
    || !Array.isArray(candidate.blocks)
  ) return null;
  const blocks = candidate.blocks.filter((item): item is AssetDocumentPatchBlock => {
    if (!item || typeof item !== "object") return false;
    const block = item as Record<string, unknown>;
    return typeof block.blockId === "string"
      && typeof block.baseRevision === "number"
      && typeof block.replacementMarkdown === "string"
      && Array.isArray(block.claimRefs)
      && block.claimRefs.every((claimId) => typeof claimId === "string");
  });
  if (blocks.length !== candidate.blocks.length) return null;
  return { ...candidate, blocks } as AssetDocumentPatch;
}

function documentPatchRevisionIssue(
  proposal: AssetDocumentPatch,
  assetId: string,
  workspaceRevision: number,
  blocks: AssetBlock[],
) {
  if (proposal.assetId !== assetId) return "Agent returned a proposal for a different Asset.";
  if (proposal.baseWorkspaceRevision !== workspaceRevision) return `Workspace revision changed from ${proposal.baseWorkspaceRevision} to ${workspaceRevision}.`;
  if (!proposal.replacementTitle.trim()) return "Agent returned an empty title.";

  const currentBlocks = new Map(blocks.map((block) => [block.id, block]));
  const seenBlockIds = new Set<string>();
  for (const proposedBlock of proposal.blocks) {
    if (seenBlockIds.has(proposedBlock.blockId)) return `Agent returned Block ${proposedBlock.blockId} more than once.`;
    seenBlockIds.add(proposedBlock.blockId);
    const currentBlock = currentBlocks.get(proposedBlock.blockId);
    if (!currentBlock) return `Agent returned unknown Block ${proposedBlock.blockId}.`;
    if (currentBlock.revision !== proposedBlock.baseRevision) {
      return `Block ${proposedBlock.blockId} changed from revision ${proposedBlock.baseRevision} to ${currentBlock.revision}.`;
    }
  }
  return null;
}

function mergeDocumentPatchBlocks(blocks: AssetBlock[], proposal: AssetDocumentPatch) {
  const proposedBlocks = new Map(proposal.blocks.map((block) => [block.blockId, block]));
  return blocks.map((block) => proposedBlocks.get(block.id)?.replacementMarkdown ?? block.markdown);
}

function parseAgentEvidenceProposal(value: unknown): AgentEvidenceProposal | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.assetId !== "string"
    || typeof candidate.baseWorkspaceRevision !== "number"
    || typeof candidate.intentRevision !== "number"
    || !Array.isArray(candidate.proposals)
  ) return null;
  const proposals = candidate.proposals.filter((item): item is AgentEvidenceProposalItem => {
    if (!item || typeof item !== "object") return false;
    const proposal = item as Record<string, unknown>;
    return typeof proposal.targetType === "string"
      && typeof proposal.targetId === "string"
      && typeof proposal.relation === "string"
      && typeof proposal.summary === "string";
  });
  if (proposals.length !== candidate.proposals.length || proposals.length === 0) return null;
  return { ...candidate, proposals } as AgentEvidenceProposal;
}

function parseAgentClaimProposal(value: unknown): AgentClaimProposal | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.assetId !== "string"
    || typeof candidate.baseWorkspaceRevision !== "number"
    || typeof candidate.intentRevision !== "number"
    || !Array.isArray(candidate.proposals)
  ) return null;
  const proposals = candidate.proposals.filter((item): item is AgentClaimProposalItem => {
    if (!item || typeof item !== "object") return false;
    const proposal = item as Record<string, unknown>;
    return typeof proposal.content === "string"
      && typeof proposal.kind === "string"
      && Array.isArray(proposal.supportingEvidence)
      && Array.isArray(proposal.contradictingEvidence)
      && typeof proposal.agentConfidence === "string";
  });
  if (proposals.length !== candidate.proposals.length || proposals.length === 0) return null;
  return { ...candidate, proposals } as AgentClaimProposal;
}

function parseAgentKnowledgeProposal(value: unknown): AgentKnowledgeProposal | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.assetId !== "string"
    || typeof candidate.baseWorkspaceRevision !== "number"
    || !candidate.contribution
    || typeof candidate.contribution !== "object"
    || !Array.isArray(candidate.candidates)
  ) return null;
  const contribution = candidate.contribution as Record<string, unknown>;
  if (typeof contribution.kind !== "string" || typeof contribution.summary !== "string" || !Array.isArray(contribution.claimRefs)) return null;
  const candidates = candidate.candidates.filter((item) => {
    if (!item || typeof item !== "object") return false;
    const proposal = item as Record<string, unknown>;
    return typeof proposal.candidateType === "string"
      && typeof proposal.action === "string"
      && typeof proposal.title === "string"
      && typeof proposal.content === "string"
      && Array.isArray(proposal.claimRefs);
  });
  if (candidates.length !== candidate.candidates.length) return null;
  return { ...candidate, contribution, candidates } as AgentKnowledgeProposal;
}

function evidenceHref(targetType: string, targetId: string) {
  if (targetType === "source") return `/sources/${encodeURIComponent(targetId)}`;
  if (targetType === "note") return `/notes/${encodeURIComponent(targetId)}`;
  if (targetType === "wiki") return `/wiki/${encodeURIComponent(targetId)}`;
  return targetId;
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
      accentTone: "bg-sky-500/10 text-sky-700 ring-sky-500/20",
      ruleTone: "from-sky-500 via-cyan-400 to-transparent",
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
      accentTone: "bg-emerald-500/10 text-emerald-700 ring-emerald-500/20",
      ruleTone: "from-emerald-500 via-teal-400 to-transparent",
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
      accentTone: "bg-rose-500/10 text-rose-700 ring-rose-500/20",
      ruleTone: "from-rose-500 via-orange-400 to-transparent",
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
      accentTone: "bg-violet-500/10 text-violet-700 ring-violet-500/20",
      ruleTone: "from-violet-500 via-fuchsia-400 to-transparent",
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
    accentTone: "bg-amber-500/10 text-amber-700 ring-amber-500/20",
    ruleTone: "from-amber-500 via-yellow-400 to-transparent",
  };
}

function AssetReaderIcon({ assetType, className = "h-5 w-5" }: { assetType?: AssetType; className?: string }) {
  if (assetType === "research_brief") return <FileSearch className={className} />;
  if (assetType === "knowledge_pack") return <LibraryBig className={className} />;
  if (assetType === "newsletter_issue") return <MailOpen className={className} />;
  if (assetType === "topic_report") return <ChartNoAxesCombined className={className} />;
  return <PenLine className={className} />;
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
    .map((match) => {
      const title = match[2].replace(/[*_`]/g, "").trim();
      return { level: match[1].length, title, id: markdownHeadingId(title) };
    })
    .slice(0, 16);
}

function markdownHeadingId(title: string) {
  return title
    .toLocaleLowerCase()
    .replace(/<[^>]+>/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "") || "section";
}

function markdownText(children: React.ReactNode): string {
  if (typeof children === "string" || typeof children === "number") return String(children);
  if (Array.isArray(children)) return children.map(markdownText).join("");
  if (children && typeof children === "object" && "props" in children) {
    return markdownText((children as React.ReactElement<{ children?: React.ReactNode }>).props.children);
  }
  return "";
}

function estimateReadingMinutes(content: string) {
  const cjkCharacters = content.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu)?.length ?? 0;
  const latinWords = content.replace(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu, " ").match(/[\p{L}\p{N}]+/gu)?.length ?? 0;
  return Math.max(1, Math.ceil(cjkCharacters / 400 + latinWords / 220));
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

function downloadAssetFile(content: string, title: string, extension: "html" | "md", mimeType: string) {
  const filename = `${title.trim().replace(/[^\p{L}\p{N}._-]+/gu, "-").replace(/^-+|-+$/g, "") || "asset"}.${extension}`;
  const url = URL.createObjectURL(new Blob([content], { type: `${mimeType};charset=utf-8` }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
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
  const workspaceQuery = useQuery({
    queryKey: ["asset-workspace", id],
    queryFn: () => assetsApi.getWorkspace(id),
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
  const [deliveryFormat, setDeliveryFormat] = useState<"markdown" | "html">("markdown");
  const [htmlPreview, setHtmlPreview] = useState("");
  const [htmlPreviewOpen, setHtmlPreviewOpen] = useState(false);
  const [htmlCopied, setHtmlCopied] = useState(false);
  const [editTitle, setEditTitle] = useState("");
  const [editBrief, setEditBrief] = useState("");
  const [editOutline, setEditOutline] = useState("");
  const [editBlocks, setEditBlocks] = useState<AssetBlock[]>([]);
  const [editStyle, setEditStyle] = useState("");
  const [previewBlockIds, setPreviewBlockIds] = useState<Set<string>>(() => new Set());
  const [blockRevision, setBlockRevision] = useState<BlockRevisionState | null>(null);
  const blockRevisionAbortRef = useRef<AbortController | null>(null);
  const [documentRevision, setDocumentRevision] = useState<DocumentRevisionState>({ instruction: "", streaming: false, status: "" });
  const documentRevisionAbortRef = useRef<AbortController | null>(null);
  const [evidenceAgent, setEvidenceAgent] = useState<EvidenceAgentState>({ instruction: "", streaming: false, status: "" });
  const evidenceAgentAbortRef = useRef<AbortController | null>(null);
  const [claimAgent, setClaimAgent] = useState<ClaimAgentState>({ instruction: "", streaming: false, status: "" });
  const [claimEdits, setClaimEdits] = useState<Record<string, string>>({});
  const claimAgentAbortRef = useRef<AbortController | null>(null);
  const [knowledgeAgent, setKnowledgeAgent] = useState<KnowledgeAgentState>({ instruction: "", streaming: false, status: "" });
  const [contributionEdit, setContributionEdit] = useState("");
  const [knowledgeCandidateEdits, setKnowledgeCandidateEdits] = useState<Record<string, { title: string; content: string }>>({});
  const knowledgeAgentAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const feedback = ((asset?.metadata_ || {}) as Record<string, unknown>).publish_feedback as Record<string, unknown> | undefined;
    setPublishUrl(typeof feedback?.publish_url === "string" ? feedback.publish_url : publishingSettings.primary_site_url);
    setPublishChannel(typeof feedback?.channel === "string" ? feedback.channel : publishingSettings.default_channel);
    setPublishFeedback(typeof feedback?.feedback === "string" ? feedback.feedback : "");
  }, [asset, publishingSettings.default_channel, publishingSettings.primary_site_url]);

  useEffect(() => {
    setDeliveryFormat(asset?.metadata_?.delivery_format === "html" ? "html" : "markdown");
    setHtmlPreview("");
    setHtmlPreviewOpen(false);
    setHtmlCopied(false);
  }, [asset?.id, asset?.metadata_?.delivery_format]);

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
    documentRevisionAbortRef.current?.abort();
    documentRevisionAbortRef.current = null;
    setDocumentRevision({ instruction: "", streaming: false, status: "" });
  }, [asset]);

  useEffect(() => {
    setContributionEdit(workspaceQuery.data?.contribution?.summary ?? "");
  }, [workspaceQuery.data?.contribution?.id, workspaceQuery.data?.contribution?.summary]);

  const documentOptimizationGate = useMemo(() => {
    const workspace = workspaceQuery.data;
    const reasons: string[] = [];
    if (!workspace?.intent) reasons.push("Confirm Intent");
    if (!workspace?.evidence.some((item) => item.status === "accepted")) reasons.push("Accept Evidence");
    if (workspace?.evidence.some((item) => item.status === "proposed")) reasons.push("Resolve proposed Evidence");
    if (!workspace?.claims.some((item) => item.status === "accepted" || item.status === "hypothesis")) reasons.push("Accept a Claim or Hypothesis");
    if (workspace?.claims.some((item) => item.status === "proposed")) reasons.push("Resolve proposed Claims");
    if (workspace?.contribution?.status !== "accepted") reasons.push("Accept the Contribution");
    if (!workspace?.knowledge_candidates.some((item) => item.status === "kept" || item.status === "promoted")) reasons.push("Keep or promote a Knowledge Candidate");
    if (workspace?.knowledge_candidates.some((item) => item.status === "proposed")) reasons.push("Resolve proposed Knowledge Candidates");
    return { ready: reasons.length === 0, reasons };
  }, [workspaceQuery.data]);

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
    await queryClient.invalidateQueries({ queryKey: ["asset-workspace", id] });
  };

  const statusMutation = useMutation({
    mutationFn: (status: AssetStatus) => assetsApi.update(id, { status }),
    onSuccess: refreshAsset,
  });

  const saveEvidenceProposalMutation = useMutation({
    mutationFn: async () => {
      const proposal = evidenceAgent.proposal;
      if (!proposal) throw new Error("No Evidence proposal is ready.");
      const proposals: AssetEvidenceProposalInput[] = proposal.proposals.map((item) => ({
        target_type: item.targetType,
        target_id: item.targetId,
        relation: item.relation,
        summary: item.summary,
        fragment_selector: item.fragmentSelector,
      }));
      return assetsApi.proposeEvidence(id, {
        base_workspace_revision: proposal.baseWorkspaceRevision,
        session_id: evidenceAgent.sessionId,
        proposals,
      });
    },
    onSuccess: async () => {
      setEvidenceAgent((current) => ({ ...current, proposal: undefined, status: "Evidence candidates saved for review." }));
      await refreshAsset();
    },
  });

  const evidenceDecisionMutation = useMutation({
    mutationFn: ({ evidenceId, decision }: { evidenceId: string; decision: "accepted" | "rejected" }) => assetsApi.decideEvidence(id, evidenceId, {
      base_workspace_revision: workspaceQuery.data?.workspace_revision ?? 0,
      decision,
    }),
    onSuccess: refreshAsset,
  });

  const saveClaimProposalMutation = useMutation({
    mutationFn: async () => {
      const proposal = claimAgent.proposal;
      if (!proposal) throw new Error("No Claim proposal is ready.");
      const proposals: AssetClaimProposalInput[] = proposal.proposals.map((item) => ({
        content: item.content,
        kind: item.kind,
        supporting_evidence: item.supportingEvidence,
        contradicting_evidence: item.contradictingEvidence,
        agent_confidence: item.agentConfidence,
      }));
      return assetsApi.proposeClaims(id, {
        base_workspace_revision: proposal.baseWorkspaceRevision,
        session_id: claimAgent.sessionId,
        proposals,
      });
    },
    onSuccess: async () => {
      setClaimAgent((current) => ({ ...current, proposal: undefined, status: "Candidate Claims saved for review." }));
      await refreshAsset();
    },
  });

  const claimDecisionMutation = useMutation({
    mutationFn: ({ claimId, decision, editedContent }: { claimId: string; decision: "accept" | "edit_and_accept" | "reject" | "keep_as_hypothesis" | "need_more_evidence"; editedContent?: string }) => assetsApi.decideClaim(id, claimId, {
      base_workspace_revision: workspaceQuery.data?.workspace_revision ?? 0,
      decision,
      ...(editedContent ? { edited_content: editedContent } : {}),
    }),
    onSuccess: refreshAsset,
  });

  const saveKnowledgeProposalMutation = useMutation({
    mutationFn: async () => {
      const proposal = knowledgeAgent.proposal;
      if (!proposal) throw new Error("No Knowledge proposal is ready.");
      const body: AssetKnowledgeProposalInput = {
        contribution: {
          kind: proposal.contribution.kind,
          summary: proposal.contribution.summary,
          claim_refs: proposal.contribution.claimRefs,
        },
        candidates: proposal.candidates.map((item) => ({
          candidate_type: item.candidateType,
          action: item.action,
          target_wiki_id: item.targetWikiId,
          title: item.title,
          content: item.content,
          claim_refs: item.claimRefs,
        })),
      };
      return assetsApi.proposeKnowledge(id, {
        base_workspace_revision: proposal.baseWorkspaceRevision,
        session_id: knowledgeAgent.sessionId,
        ...body,
      });
    },
    onSuccess: async () => {
      setKnowledgeAgent((current) => ({ ...current, proposal: undefined, status: "Contribution and Knowledge Candidates saved for review." }));
      await refreshAsset();
    },
  });

  const contributionDecisionMutation = useMutation({
    mutationFn: ({ decision, attribution }: { decision: "accept" | "edit_and_accept" | "reject"; attribution?: "agent_synthesis" | "user_insight" }) => assetsApi.decideContribution(id, {
      base_workspace_revision: workspaceQuery.data?.workspace_revision ?? 0,
      decision,
      ...(attribution ? { attribution } : {}),
      ...(decision === "edit_and_accept" ? { edited_summary: contributionEdit.trim() } : {}),
    }),
    onSuccess: refreshAsset,
  });

  const knowledgeCandidateDecisionMutation = useMutation({
    mutationFn: ({ candidateId, decision }: { candidateId: string; decision: "keep" | "reject" }) => assetsApi.decideKnowledgeCandidate(id, candidateId, {
      base_workspace_revision: workspaceQuery.data?.workspace_revision ?? 0,
      decision,
    }),
    onSuccess: refreshAsset,
  });

  const knowledgePromotionMutation = useMutation({
    mutationFn: ({ candidateId, confirmOverwrite }: { candidateId: string; confirmOverwrite: boolean }) => {
      const candidate = workspaceQuery.data?.knowledge_candidates.find((item) => item.id === candidateId);
      if (!candidate) throw new Error("Knowledge Candidate not found.");
      const edits = knowledgeCandidateEdits[candidateId];
      const title = edits?.title.trim() || candidate.title;
      const content = edits?.content.trim() || candidate.content;
      return assetsApi.promoteKnowledgeCandidate(id, candidateId, {
        base_workspace_revision: workspaceQuery.data?.workspace_revision ?? 0,
        confirm: true,
        confirm_overwrite: confirmOverwrite,
        ...(title !== candidate.title ? { edited_title: title } : {}),
        ...(content !== candidate.content ? { edited_content: content } : {}),
      });
    },
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

  const toggleBlockClaim = (blockId: string, claimId: string) => {
    setEditBlocks((blocks) => blocks.map((block) => {
      if (block.id !== blockId) return block;
      const claimRefs = block.claimRefs.includes(claimId)
        ? block.claimRefs.filter((item) => item !== claimId)
        : [...block.claimRefs, claimId];
      return updateAssetBlockClaimRefs(block, claimRefs);
    }));
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
    if (!asset || !blockRevision || blockRevision.streaming) return;
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
      selected_claim_refs: selectedBlock.claimRefs,
      next_block: editBlocks[selectedIndex + 1]?.markdown ?? "",
      user_instruction: blockRevision.instruction.trim() || "Review this Block and propose the most useful improvement while preserving its supported claims and the Asset Intent.",
      instruction_source: blockRevision.instruction.trim() ? "user" : "agent_default",
      source_refs: asset.source_refs ?? [],
      note_refs: asset.note_refs ?? [],
      wiki_refs: asset.wiki_refs ?? [],
      available_claims: (workspaceQuery.data?.claims ?? [])
        .filter((claim) => claim.status === "accepted" || claim.status === "hypothesis")
        .map((claim) => ({ id: claim.id, content: claim.content, status: claim.status })),
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
    const allowedClaims = new Set((workspaceQuery.data?.claims ?? [])
      .filter((claim) => claim.status === "accepted" || claim.status === "hypothesis")
      .map((claim) => claim.id));
    if (blockRevision.proposal.claimRefs?.some((claimId) => !allowedClaims.has(claimId))) {
      setBlockRevision((current) => current ? { ...current, error: "Agent Patch 引用了未接受或不存在的 Claim。" } : current);
      return;
    }
    setEditBlocks((blocks) => blocks.map((block) => {
      if (block.id !== currentBlock.id) return block;
      const updated = updateAssetBlock(block, blockRevision.proposal!.replacementMarkdown);
      return blockRevision.proposal!.claimRefs
        ? { ...updated, claimRefs: blockRevision.proposal!.claimRefs }
        : updated;
    }));
    setBlockRevision(null);
  };

  const startDocumentRevision = async () => {
    const workspace = workspaceQuery.data;
    if (!asset || !workspace || documentRevision.streaming) return;
    if (!documentOptimizationGate.ready) {
      setDocumentRevision((current) => ({ ...current, error: `Complete the workflow first: ${documentOptimizationGate.reasons.join("; ")}.` }));
      return;
    }
    if (editBlocks.length === 0) {
      setDocumentRevision((current) => ({ ...current, error: "Add draft content before optimizing the complete Asset." }));
      return;
    }
    const request = {
      assetId: asset.id,
      baseWorkspaceRevision: workspace.workspace_revision,
      instruction: documentRevision.instruction.trim() || "Optimize the complete Asset for clarity, coherence, evidence-grounded claims, transitions, and a stronger conclusion.",
      asset: {
        type: asset.asset_type,
        title: editTitle,
        brief: editBrief,
        style: editStyle,
        blocks: editBlocks.map((block) => ({
          blockId: block.id,
          baseRevision: block.revision,
          type: block.type,
          markdown: block.markdown,
          claimRefs: block.claimRefs,
        })),
      },
      intent: workspace.intent,
      acceptedEvidence: workspace.evidence
        .filter((item) => item.status === "accepted")
        .map((item) => ({ id: item.id, targetType: item.target_type, targetId: item.target_id, relation: item.relation, summary: item.summary })),
      availableClaims: workspace.claims
        .filter((claim) => claim.status === "accepted" || claim.status === "hypothesis")
        .map((claim) => ({ id: claim.id, content: claim.content, kind: claim.kind, status: claim.status, confidence: claim.agent_confidence })),
      contribution: workspace.contribution,
      knowledgeCandidates: workspace.knowledge_candidates
        .filter((candidate) => candidate.status === "kept" || candidate.status === "promoted")
        .map((candidate) => ({ id: candidate.id, title: candidate.title, content: candidate.content, claimRefs: candidate.claim_refs, status: candidate.status })),
    };
    const abortController = new AbortController();
    documentRevisionAbortRef.current?.abort();
    documentRevisionAbortRef.current = abortController;
    setDocumentRevision((current) => ({
      ...current,
      streaming: true,
      status: "Agent is reviewing the complete argument and knowledge trace…",
      pendingQuestion: undefined,
      proposal: undefined,
      error: undefined,
    }));
    try {
      for await (const event of harnessChat(
        `请按 revise-asset-document 工作流处理以下 JSON 合同：\n\n${JSON.stringify(request, null, 2)}`,
        {
          preset: "revise-asset-document",
          createSession: true,
          clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          signal: abortController.signal,
        },
      )) {
        if (event.type === "session" && event.session_id) {
          setDocumentRevision((current) => ({ ...current, sessionId: event.session_id }));
        } else if (event.type === "text" && event.content) {
          setDocumentRevision((current) => ({ ...current, status: `${current.status}${event.content}`.slice(-1200) }));
        } else if (event.type === "tool_call") {
          if (event.tool === "propose_asset_document_patch") {
            const proposal = parseAssetDocumentPatch(event.args);
            const revisionIssue = proposal ? documentPatchRevisionIssue(proposal, asset.id, workspace.workspace_revision, editBlocks) : "Agent returned an invalid document patch contract.";
            if (proposal && !revisionIssue) {
              setDocumentRevision((current) => ({ ...current, proposal, status: proposal.explanation || "Agent produced a complete Asset proposal. Review the Diff before applying it." }));
            } else {
              setDocumentRevision((current) => ({ ...current, error: revisionIssue || "The complete Asset proposal is invalid." }));
            }
          } else {
            setDocumentRevision((current) => ({ ...current, status: `Agent is using ${event.tool || "a tool"}…` }));
          }
        } else if (event.type === "question" && event.rpc_id && event.session_id && event.questions?.length) {
          setDocumentRevision((current) => ({
            ...current,
            pendingQuestion: { rpcId: event.rpc_id!, sessionId: event.session_id!, questions: event.questions! },
            status: "Agent needs clarification before optimizing the complete Asset.",
          }));
        } else if (event.type === "error") {
          setDocumentRevision((current) => ({ ...current, error: event.content || "Complete Asset optimization failed." }));
        }
      }
    } catch (error) {
      if (!abortController.signal.aborted) {
        setDocumentRevision((current) => ({ ...current, error: error instanceof Error ? error.message : "Complete Asset optimization failed." }));
      }
    } finally {
      if (documentRevisionAbortRef.current === abortController) documentRevisionAbortRef.current = null;
      setDocumentRevision((current) => ({ ...current, streaming: false }));
    }
  };

  const applyDocumentRevision = () => {
    const proposal = documentRevision.proposal;
    const workspace = workspaceQuery.data;
    if (!proposal || !workspace) return;
    const revisionIssue = documentPatchRevisionIssue(proposal, asset?.id ?? "", workspace.workspace_revision, editBlocks);
    if (revisionIssue) {
      setDocumentRevision((current) => ({ ...current, error: `${revisionIssue} Generate a fresh optimization.` }));
      return;
    }
    const allowedClaims = new Set(workspace.claims
      .filter((claim) => claim.status === "accepted" || claim.status === "hypothesis")
      .map((claim) => claim.id));
    if (proposal.blocks.some((block) => block.claimRefs.some((claimId) => !allowedClaims.has(claimId)))) {
      setDocumentRevision((current) => ({ ...current, error: "The proposal references a Claim that is not accepted or retained as a Hypothesis." }));
      return;
    }
    setEditTitle(proposal.replacementTitle);
    setEditBrief(proposal.replacementBrief);
    const proposedBlocks = new Map(proposal.blocks.map((block) => [block.blockId, block]));
    setEditBlocks((blocks) => blocks.map((block) => {
      const proposedBlock = proposedBlocks.get(block.id);
      if (!proposedBlock) return block;
      return { ...updateAssetBlock(block, proposedBlock.replacementMarkdown), claimRefs: proposedBlock.claimRefs };
    }));
    setDocumentRevision((current) => ({ ...current, proposal: undefined, status: "Optimization applied to the editor. Review the Blocks, then save explicitly." }));
  };

  const startEvidenceResearch = async () => {
    const workspace = workspaceQuery.data;
    const intent = workspace?.intent;
    if (!asset || !workspace || !intent || evidenceAgent.streaming) return;
    const request = {
      assetId: asset.id,
      baseWorkspaceRevision: workspace.workspace_revision,
      intentRevision: intent.revision,
      intent: {
        question: intent.question,
        goal: intent.goal,
        audience: intent.audience,
        creationMode: intent.creation_mode,
        scope: intent.scope,
        constraints: intent.constraints,
      },
      instruction: evidenceAgent.instruction.trim() || "Find the strongest missing evidence and any credible contradiction for this Intent.",
      existingEvidence: workspace.evidence.map((item) => ({
        targetType: item.target_type,
        targetId: item.target_id,
        relation: item.relation,
        status: item.status,
      })),
      attachedReferences: {
        sourceRefs: asset.source_refs,
        noteRefs: asset.note_refs,
        wikiRefs: asset.wiki_refs,
      },
    };
    const abortController = new AbortController();
    evidenceAgentAbortRef.current?.abort();
    evidenceAgentAbortRef.current = abortController;
    setEvidenceAgent((current) => ({
      ...current,
      streaming: true,
      status: "Agent is searching within the confirmed Intent…",
      pendingQuestion: undefined,
      proposal: undefined,
      error: undefined,
    }));
    try {
      for await (const event of harnessChat(
        `请按 collect-asset-evidence 工作流处理以下 JSON 合同：\n\n${JSON.stringify(request, null, 2)}`,
        {
          preset: "collect-asset-evidence",
          createSession: true,
          clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          signal: abortController.signal,
        },
      )) {
        if (event.type === "session" && event.session_id) {
          setEvidenceAgent((current) => ({ ...current, sessionId: event.session_id }));
        } else if (event.type === "text" && event.content) {
          setEvidenceAgent((current) => ({ ...current, status: `${current.status}${event.content}`.slice(-1200) }));
        } else if (event.type === "tool_call") {
          if (event.tool === "propose_asset_evidence") {
            const proposal = parseAgentEvidenceProposal(event.args);
            if (
              proposal
              && proposal.assetId === asset.id
              && proposal.baseWorkspaceRevision === workspace.workspace_revision
              && proposal.intentRevision === intent.revision
            ) {
              setEvidenceAgent((current) => ({ ...current, proposal, status: "Agent produced Evidence candidates. Review them before saving." }));
            } else {
              setEvidenceAgent((current) => ({ ...current, error: "Agent Evidence proposal does not match the current Workspace and Intent revisions." }));
            }
          } else {
            setEvidenceAgent((current) => ({ ...current, status: `Agent is using ${event.tool || "a tool"}…` }));
          }
        } else if (event.type === "question" && event.rpc_id && event.session_id && event.questions?.length) {
          setEvidenceAgent((current) => ({
            ...current,
            pendingQuestion: { rpcId: event.rpc_id!, sessionId: event.session_id!, questions: event.questions! },
            status: "Agent needs a Scope Gate decision before continuing.",
          }));
        } else if (event.type === "error") {
          setEvidenceAgent((current) => ({ ...current, error: event.content || "Evidence research failed." }));
        }
      }
    } catch (error) {
      if (!abortController.signal.aborted) {
        setEvidenceAgent((current) => ({ ...current, error: error instanceof Error ? error.message : "Evidence research failed." }));
      }
    } finally {
      if (evidenceAgentAbortRef.current === abortController) evidenceAgentAbortRef.current = null;
      setEvidenceAgent((current) => ({ ...current, streaming: false }));
    }
  };

  const startClaimAnalysis = async () => {
    const workspace = workspaceQuery.data;
    const intent = workspace?.intent;
    if (!asset || !workspace || !intent || claimAgent.streaming) return;
    const request = {
      assetId: asset.id,
      baseWorkspaceRevision: workspace.workspace_revision,
      intentRevision: intent.revision,
      intent: {
        question: intent.question,
        goal: intent.goal,
        creationMode: intent.creation_mode,
      },
      instruction: claimAgent.instruction.trim() || "Extract the most decision-relevant Candidate Claims from the current Evidence.",
      evidence: workspace.evidence
        .filter((item) => item.status !== "rejected")
        .map((item) => ({
          id: item.id,
          targetType: item.target_type,
          targetId: item.target_id,
          relation: item.relation,
          summary: item.summary,
          status: item.status,
        })),
      existingClaims: workspace.claims.map((item) => ({ id: item.id, content: item.content, status: item.status })),
    };
    const abortController = new AbortController();
    claimAgentAbortRef.current?.abort();
    claimAgentAbortRef.current = abortController;
    setClaimAgent((current) => ({ ...current, streaming: true, status: "Agent is analyzing Evidence…", proposal: undefined, error: undefined }));
    try {
      for await (const event of harnessChat(
        `请按 analyze-asset-claims 工作流处理以下 JSON 合同：\n\n${JSON.stringify(request, null, 2)}`,
        {
          preset: "analyze-asset-claims",
          createSession: true,
          clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          signal: abortController.signal,
        },
      )) {
        if (event.type === "session" && event.session_id) {
          setClaimAgent((current) => ({ ...current, sessionId: event.session_id }));
        } else if (event.type === "text" && event.content) {
          setClaimAgent((current) => ({ ...current, status: `${current.status}${event.content}`.slice(-1200) }));
        } else if (event.type === "tool_call") {
          if (event.tool === "propose_asset_claims") {
            const proposal = parseAgentClaimProposal(event.args);
            if (
              proposal
              && proposal.assetId === asset.id
              && proposal.baseWorkspaceRevision === workspace.workspace_revision
              && proposal.intentRevision === intent.revision
            ) {
              setClaimAgent((current) => ({ ...current, proposal, status: "Agent produced Candidate Claims. Apply the Claim Gate before accepting conclusions." }));
            } else {
              setClaimAgent((current) => ({ ...current, error: "Agent Claim proposal does not match the current Workspace and Intent revisions." }));
            }
          } else {
            setClaimAgent((current) => ({ ...current, status: `Agent is using ${event.tool || "a tool"}…` }));
          }
        } else if (event.type === "error") {
          setClaimAgent((current) => ({ ...current, error: event.content || "Claim analysis failed." }));
        }
      }
    } catch (error) {
      if (!abortController.signal.aborted) {
        setClaimAgent((current) => ({ ...current, error: error instanceof Error ? error.message : "Claim analysis failed." }));
      }
    } finally {
      if (claimAgentAbortRef.current === abortController) claimAgentAbortRef.current = null;
      setClaimAgent((current) => ({ ...current, streaming: false }));
    }
  };

  const startKnowledgeDistillation = async () => {
    const workspace = workspaceQuery.data;
    if (!asset || !workspace || knowledgeAgent.streaming) return;
    const eligibleClaims = workspace.claims.filter((claim) => claim.status === "accepted" || claim.status === "hypothesis");
    if (eligibleClaims.length === 0) {
      setKnowledgeAgent((current) => ({ ...current, error: "Accept a Claim or retain a Hypothesis before distilling Knowledge." }));
      return;
    }
    const request = {
      assetId: asset.id,
      baseWorkspaceRevision: workspace.workspace_revision,
      title: asset.title,
      instruction: knowledgeAgent.instruction.trim() || "Identify what this Asset adds and propose reusable Note or Wiki candidates.",
      claims: eligibleClaims.map((claim) => ({
        id: claim.id,
        content: claim.content,
        kind: claim.kind,
        status: claim.status,
        agentConfidence: claim.agent_confidence,
      })),
      existingWikiRefs: asset.wiki_refs ?? [],
    };
    const abortController = new AbortController();
    knowledgeAgentAbortRef.current?.abort();
    knowledgeAgentAbortRef.current = abortController;
    setKnowledgeAgent((current) => ({ ...current, streaming: true, status: "Agent is identifying the Asset contribution…", proposal: undefined, error: undefined }));
    try {
      for await (const event of harnessChat(
        `请按 distill-asset-knowledge 工作流处理以下 JSON 合同：\n\n${JSON.stringify(request, null, 2)}`,
        {
          preset: "distill-asset-knowledge",
          createSession: true,
          clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          signal: abortController.signal,
        },
      )) {
        if (event.type === "session" && event.session_id) {
          setKnowledgeAgent((current) => ({ ...current, sessionId: event.session_id }));
        } else if (event.type === "text" && event.content) {
          setKnowledgeAgent((current) => ({ ...current, status: `${current.status}${event.content}`.slice(-1200) }));
        } else if (event.type === "tool_call") {
          if (event.tool === "propose_asset_knowledge") {
            const proposal = parseAgentKnowledgeProposal(event.args);
            if (proposal && proposal.assetId === asset.id && proposal.baseWorkspaceRevision === workspace.workspace_revision) {
              setKnowledgeAgent((current) => ({ ...current, proposal, status: "Agent produced a Contribution and Knowledge Candidates. User confirmation is still required." }));
            } else {
              setKnowledgeAgent((current) => ({ ...current, error: "Agent Knowledge proposal does not match the current Workspace revision." }));
            }
          } else {
            setKnowledgeAgent((current) => ({ ...current, status: `Agent is using ${event.tool || "a tool"}…` }));
          }
        } else if (event.type === "error") {
          setKnowledgeAgent((current) => ({ ...current, error: event.content || "Knowledge distillation failed." }));
        }
      }
    } catch (error) {
      if (!abortController.signal.aborted) {
        setKnowledgeAgent((current) => ({ ...current, error: error instanceof Error ? error.message : "Knowledge distillation failed." }));
      }
    } finally {
      if (knowledgeAgentAbortRef.current === abortController) knowledgeAgentAbortRef.current = null;
      setKnowledgeAgent((current) => ({ ...current, streaming: false }));
    }
  };

  const exportMutation = useMutation({
    mutationFn: () => assetsApi.exportMarkdown(id),
    onSuccess: refreshAsset,
  });

  const previewHtmlMutation = useMutation({
    mutationFn: () => assetsApi.previewHtml(id),
    onSuccess: (result) => {
      setHtmlPreview(result.content);
      setHtmlCopied(false);
      setHtmlPreviewOpen(true);
    },
  });

  const exportHtmlMutation = useMutation({
    mutationFn: () => assetsApi.exportHtml(id),
    onSuccess: async (result) => {
      downloadAssetFile(result.content, asset?.title ?? "asset", "html", "text/html");
      await refreshAsset();
    },
  });

  const saveDeliveryFormatMutation = useMutation({
    mutationFn: () => assetsApi.update(id, {
      metadata: { ...(asset?.metadata_ ?? {}), delivery_format: deliveryFormat },
    }),
    onSuccess: refreshAsset,
  });

  const exportPreferred = () => {
    if (deliveryFormat === "html") exportHtmlMutation.mutate();
    else exportMutation.mutate();
  };

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

  const actionError = [statusMutation.error, exportMutation.error, exportHtmlMutation.error, previewHtmlMutation.error, saveDeliveryFormatMutation.error, publishMutation.error, savePublishFeedbackMutation.error, feedbackToNoteMutation.error]
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

  const isExporting = exportMutation.isPending || exportHtmlMutation.isPending;
  const isBusy = statusMutation.isPending || isExporting || publishMutation.isPending || savePublishFeedbackMutation.isPending;
  const primaryAction = useMemo(() => (asset ? buildPrimaryAction(asset, readinessQuery.data) : null), [asset, readinessQuery.data]);
  const contentPresentation = useMemo(() => splitAssetContent(asset?.draft_content), [asset?.draft_content]);
  const headings = useMemo(() => markdownHeadings(contentPresentation.readerMarkdown), [contentPresentation.readerMarkdown]);
  const audience = typeof asset?.metadata_?.audience === "string" ? asset.metadata_.audience : null;
  const evidenceCount = sourceRefItems.length + noteRefItems.length + stableWikiItems.length + candidateWikiItems.length;
  const readingMinutes = useMemo(() => estimateReadingMinutes(contentPresentation.readerMarkdown), [contentPresentation.readerMarkdown]);
  const documentDiffLines = useMemo(() => {
    if (!documentRevision.proposal) return [];
    return buildLineDiff(
      serializeAssetBlocks(editBlocks),
      mergeDocumentPatchBlocks(editBlocks, documentRevision.proposal).map((markdown) => markdown.trim()).filter(Boolean).join("\n\n"),
    );
  }, [documentRevision.proposal, editBlocks]);

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-6xl space-y-6 px-6 py-8">
        <div className="flex items-center justify-between gap-4">
          <div className="flex flex-wrap items-center gap-2">
            <Link to={backTo} className="text-sm text-primary hover:underline">{backLabel}</Link>
            {asset && <><span className="text-muted-foreground">/</span><Badge variant="outline">{assetTypeLabel(asset.asset_type)}</Badge><Badge variant="secondary">{STATUS_LABELS[asset.status]}</Badge></>}
            {!asset && <span className="text-sm text-muted-foreground">Loading Asset…</span>}
          </div>
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="outline" onClick={exportPreferred} disabled={!asset || isBusy || asset.status !== "ready_to_export"}>
              {isExporting ? "Exporting…" : deliveryFormat === "html" ? "Export HTML" : "Export Markdown"}
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
          <Tabs defaultValue={workspaceQuery.data?.intent ? "intent" : "read"} className="space-y-6">
            <div className="sticky top-0 z-10 -mx-2 border-b bg-background/95 px-2 py-2 backdrop-blur">
              <TabsList>
                <TabsTrigger value="intent">Intent</TabsTrigger>
                <TabsTrigger value="evidence">Evidence</TabsTrigger>
                <TabsTrigger value="claims">Claims</TabsTrigger>
                <TabsTrigger value="knowledge">Knowledge</TabsTrigger>
                <TabsTrigger value="read">Read</TabsTrigger>
                <TabsTrigger value="edit">Edit</TabsTrigger>
                <TabsTrigger value="production">Production</TabsTrigger>
              </TabsList>
            </div>

            <TabsContent value="intent" className="mt-0">
              <Card>
                <CardHeader>
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div><CardTitle>Confirmed Intent</CardTitle><CardDescription>The Agent may recommend a revision, but cannot change these fields directly.</CardDescription></div>
                    {workspaceQuery.data?.intent && <Badge variant="secondary">Revision {workspaceQuery.data.intent.revision}</Badge>}
                  </div>
                </CardHeader>
                <CardContent className="space-y-5">
                  {workspaceQuery.isLoading && <p className="text-sm text-muted-foreground">Loading Intent…</p>}
                  {workspaceQuery.isError && <p className="text-sm text-destructive">Could not load the Asset workspace.</p>}
                  {!workspaceQuery.isLoading && !workspaceQuery.data?.intent && <p className="text-sm text-muted-foreground">This legacy Asset does not have a confirmed Intent yet.</p>}
                  {workspaceQuery.data?.intent && (
                    <>
                      <div><p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Question</p><p className="mt-1 text-sm leading-6">{workspaceQuery.data.intent.question}</p></div>
                      <div><p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Goal</p><p className="mt-1 text-sm leading-6">{workspaceQuery.data.intent.goal}</p></div>
                      <div className="grid gap-5 md:grid-cols-2">
                        <div><p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Audience</p><p className="mt-1 text-sm">{workspaceQuery.data.intent.audience || "Not specified"}</p></div>
                        <div><p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Creation Mode</p><p className="mt-1 text-sm">{workspaceQuery.data.intent.creation_mode.replace(/_/g, " ")}</p></div>
                      </div>
                      <div className="grid gap-5 md:grid-cols-2">
                        <div><p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Scope</p><div className="mt-2 flex flex-wrap gap-2">{workspaceQuery.data.intent.scope.length ? workspaceQuery.data.intent.scope.map((item) => <Badge key={item} variant="outline">{item}</Badge>) : <span className="text-sm text-muted-foreground">Not further constrained</span>}</div></div>
                        <div><p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Constraints</p><div className="mt-2 flex flex-wrap gap-2">{workspaceQuery.data.intent.constraints.length ? workspaceQuery.data.intent.constraints.map((item) => <Badge key={item} variant="outline">{item}</Badge>) : <span className="text-sm text-muted-foreground">None stated</span>}</div></div>
                      </div>
                      <p className="text-xs text-muted-foreground">Confirmed {new Date(workspaceQuery.data.intent.confirmed_at).toLocaleString()} · Workspace revision {workspaceQuery.data.workspace_revision}</p>
                    </>
                  )}
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="read" className="mt-0 space-y-8">
              <article data-reader-layout={readerPresentation.layout} className="overflow-hidden rounded-[2rem] border bg-card shadow-[0_24px_70px_-42px_rgba(15,23,42,0.45)]">
                <div className={`h-1.5 bg-gradient-to-r ${readerPresentation.ruleTone}`} />
                <header className={`relative overflow-hidden border-b bg-gradient-to-br ${readerPresentation.headerTone} via-background to-background px-6 py-10 sm:px-10 sm:py-14 lg:px-16`}>
                  <div className="pointer-events-none absolute -right-24 -top-32 h-80 w-80 rounded-full border border-foreground/5 bg-background/30" />
                  <div className="pointer-events-none absolute -right-8 top-8 h-36 w-36 rounded-full border border-foreground/5" />
                  <div className="relative mx-auto max-w-5xl">
                    <div className="flex flex-wrap items-center justify-between gap-4">
                      <div className="flex items-center gap-3">
                        <div className={`flex h-11 w-11 items-center justify-center rounded-2xl ring-1 ${readerPresentation.accentTone}`}>
                          <AssetReaderIcon assetType={asset.asset_type} />
                        </div>
                        <div>
                          <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-muted-foreground">{readerPresentation.kicker}</p>
                          <p className="mt-1 text-sm font-medium">{assetTypeLabel(asset.asset_type)}</p>
                        </div>
                      </div>
                      <Badge variant="outline" className="rounded-full bg-background/70 px-3 py-1 shadow-sm backdrop-blur">{STATUS_LABELS[asset.status]}</Badge>
                    </div>

                    <h1 className="mt-9 max-w-4xl text-4xl font-semibold leading-[1.08] tracking-[-0.035em] text-foreground sm:text-5xl lg:text-6xl">{asset.title}</h1>
                    {asset.brief && (
                      <div className="mt-8 flex max-w-4xl gap-4 border-l-2 border-foreground/10 pl-5 sm:pl-6">
                        <Quote className="mt-1 h-5 w-5 shrink-0 text-muted-foreground/70" />
                        <div>
                          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">{readerPresentation.briefLabel}</p>
                          <p className="mt-2 text-lg leading-8 text-foreground/75 sm:text-xl sm:leading-9">{asset.brief}</p>
                        </div>
                      </div>
                    )}

                    <div className="mt-10 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                      <div className="flex items-center gap-3 rounded-2xl border bg-background/60 px-4 py-3 backdrop-blur">
                        <Clock3 className="h-4 w-4 text-muted-foreground" />
                        <div><p className="text-xs text-muted-foreground">Reading time</p><p className="text-sm font-semibold">{readingMinutes} min</p></div>
                      </div>
                      <div className="flex items-center gap-3 rounded-2xl border bg-background/60 px-4 py-3 backdrop-blur">
                        <BookOpen className="h-4 w-4 text-muted-foreground" />
                        <div><p className="text-xs text-muted-foreground">Sections</p><p className="text-sm font-semibold">{headings.length || "—"}</p></div>
                      </div>
                      <div className="flex items-center gap-3 rounded-2xl border bg-background/60 px-4 py-3 backdrop-blur">
                        <Sparkles className="h-4 w-4 text-muted-foreground" />
                        <div><p className="text-xs text-muted-foreground">Evidence</p><p className="text-sm font-semibold">{evidenceCount} records</p></div>
                      </div>
                      <div className="flex items-center gap-3 rounded-2xl border bg-background/60 px-4 py-3 backdrop-blur">
                        <CalendarDays className="h-4 w-4 text-muted-foreground" />
                        <div><p className="text-xs text-muted-foreground">Updated</p><p className="text-sm font-semibold">{new Date(asset.updated_at).toLocaleDateString()}</p></div>
                      </div>
                    </div>
                    {audience && <p className="mt-5 text-sm text-muted-foreground"><span className="font-medium text-foreground">For:</span> {audience}</p>}
                  </div>
                </header>

                <div className="mx-auto grid max-w-6xl gap-10 px-6 py-10 sm:px-10 sm:py-14 lg:grid-cols-[minmax(0,1fr)_270px] lg:gap-14 lg:px-14">
                  <div className="min-w-0">
                    <div className="mb-8 flex items-center gap-3">
                      <span className={`h-px w-8 bg-gradient-to-r ${readerPresentation.ruleTone}`} />
                      <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-muted-foreground">{readerPresentation.documentLabel}</p>
                    </div>
                    {contentPresentation.readerMarkdown ? (
                      <div className="prose prose-slate max-w-none text-base leading-8 dark:prose-invert prose-headings:scroll-mt-24 prose-headings:tracking-tight prose-h1:text-3xl prose-h2:mt-14 prose-h2:border-b prose-h2:border-border/70 prose-h2:pb-4 prose-h3:mt-9 prose-p:my-5 prose-li:my-2 prose-blockquote:rounded-r-xl prose-blockquote:border-primary/40 prose-blockquote:bg-muted/30 prose-blockquote:px-5 prose-blockquote:py-2 prose-blockquote:not-italic">
                        <MarkdownRenderer
                          evidenceLinks={evidenceLinks}
                          components={{
                            a({ href, children, node, ...props }) {
                              void node;
                              if (href?.startsWith("/")) {
                                return <Link to={href} className="font-medium text-primary underline decoration-primary/30 underline-offset-4 hover:decoration-primary" {...props}>{children}</Link>;
                              }
                              return <a href={href} {...props}>{children}</a>;
                            },
                            h1({ children, node, ...props }) {
                              void node;
                              return <h1 id={markdownHeadingId(markdownText(children))} {...props}>{children}</h1>;
                            },
                            h2({ children, node, ...props }) {
                              void node;
                              return <h2 id={markdownHeadingId(markdownText(children))} {...props}>{children}</h2>;
                            },
                            h3({ children, node, ...props }) {
                              void node;
                              return <h3 id={markdownHeadingId(markdownText(children))} {...props}>{children}</h3>;
                            },
                          }}
                        >
                          {contentPresentation.readerMarkdown}
                        </MarkdownRenderer>
                      </div>
                    ) : (
                      <div className="rounded-2xl border border-dashed bg-muted/10 p-12 text-center">
                        <BookOpen className="mx-auto h-7 w-7 text-muted-foreground" />
                        <p className="mt-3 font-medium">No draft content yet</p>
                        <p className="mt-1 text-sm text-muted-foreground">Continue this Asset from the production workspace.</p>
                      </div>
                    )}

                    {evidenceCount > 0 && (
                      <section className="mt-14 border-t pt-9">
                        <div className="flex items-center gap-3">
                          <div className={`flex h-9 w-9 items-center justify-center rounded-xl ring-1 ${readerPresentation.accentTone}`}><LibraryBig className="h-4 w-4" /></div>
                          <div><h2 className="font-semibold">Reference shelf</h2><p className="text-sm text-muted-foreground">Knowledge connected to this Asset.</p></div>
                        </div>
                        <div className="mt-6 space-y-5 rounded-2xl border bg-muted/10 p-5">
                          {sourceRefItems.length > 0 && <div><p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Sources</p><ReferenceChips items={sourceRefItems} /></div>}
                          {noteRefItems.length > 0 && <div><p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Notes</p><ReferenceChips items={noteRefItems} /></div>}
                          {(stableWikiItems.length > 0 || candidateWikiItems.length > 0) && <div><p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Wiki</p><ReferenceChips items={[...stableWikiItems, ...candidateWikiItems]} /></div>}
                        </div>
                      </section>
                    )}
                  </div>

                  <aside className="space-y-5 lg:sticky lg:top-20 lg:self-start">
                    <div className="overflow-hidden rounded-2xl border bg-background shadow-sm">
                      <div className="flex items-center gap-2 border-b bg-muted/20 px-4 py-3">
                        <BookOpen className="h-4 w-4 text-muted-foreground" />
                        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{readerPresentation.contentsLabel}</p>
                      </div>
                      {headings.length > 0 ? (
                        <nav aria-label={readerPresentation.contentsLabel} className="p-2">
                          {headings.map((heading, index) => (
                            <a key={`${heading.title}-${index}`} href={`#${heading.id}`} className={`block rounded-lg px-3 py-2 text-sm leading-5 transition-colors hover:bg-muted hover:text-foreground ${heading.level === 1 ? "font-medium text-foreground" : heading.level === 2 ? "pl-5 text-foreground/80" : "pl-8 text-muted-foreground"}`}>
                              {heading.title}
                            </a>
                          ))}
                        </nav>
                      ) : (
                        <p className="p-4 text-sm leading-6 text-muted-foreground">Add Markdown headings to create a navigable reading outline.</p>
                      )}
                    </div>

                    <div className="rounded-2xl border bg-muted/10 p-4">
                      <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{readerPresentation.lineageLabel}</p>
                      <div className="mt-4 space-y-2.5 text-sm">
                        <div className="flex items-center justify-between rounded-xl bg-background px-3 py-2.5"><span>Sources</span><Badge variant="source">{sourceRefItems.length}</Badge></div>
                        <div className="flex items-center justify-between rounded-xl bg-background px-3 py-2.5"><span>Notes</span><Badge variant="note">{noteRefItems.length}</Badge></div>
                        <div className="flex items-center justify-between rounded-xl bg-background px-3 py-2.5"><span>Wiki</span><Badge variant="outline">{stableWikiItems.length + candidateWikiItems.length}</Badge></div>
                      </div>
                    </div>

                    {contentPresentation.editorialMarkdown && (
                      <div className="rounded-2xl border border-dashed p-4 text-sm leading-6 text-muted-foreground">
                        Editorial notes are hidden from the reading view and remain available in Edit.
                      </div>
                    )}
                  </aside>
                </div>
              </article>
            </TabsContent>

            <TabsContent value="edit" className="mt-0">
              <Card>
                <CardHeader><CardTitle>Edit Asset</CardTitle><CardDescription>Edit the draft block by block. Reorder, insert, or remove blocks, then save the complete working document.</CardDescription></CardHeader>
                <CardContent className="space-y-5">
                  <section className={`overflow-hidden rounded-2xl border ${documentOptimizationGate.ready ? "border-violet-200 bg-violet-50/40" : "bg-muted/10"}`}>
                    <div className="flex flex-col gap-4 p-5 lg:flex-row lg:items-start lg:justify-between">
                      <div className="flex gap-3">
                        <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${documentOptimizationGate.ready ? "bg-violet-100 text-violet-700" : "bg-muted text-muted-foreground"}`}>
                          {documentOptimizationGate.ready ? <WandSparkles className="h-5 w-5" /> : <CircleAlert className="h-5 w-5" />}
                        </div>
                        <div>
                          <div className="flex flex-wrap items-center gap-2">
                            <h3 className="font-semibold">Optimize Complete Asset</h3>
                            <Badge variant={documentOptimizationGate.ready ? "default" : "outline"}>{documentOptimizationGate.ready ? "Workflow complete" : "Workflow incomplete"}</Badge>
                          </div>
                          <p className="mt-1 max-w-2xl text-sm leading-6 text-muted-foreground">Use confirmed Intent, accepted Evidence and Claims, plus kept Knowledge Candidates to improve the whole narrative. The Agent only creates a proposal; applying it still does not save the Asset.</p>
                          {!documentOptimizationGate.ready && <p className="mt-2 text-xs text-amber-700">Remaining: {documentOptimizationGate.reasons.join(" · ")}</p>}
                        </div>
                      </div>
                      <Button type="button" onClick={() => void startDocumentRevision()} disabled={!documentOptimizationGate.ready || documentRevision.streaming || editBlocks.length === 0}>
                        <WandSparkles className="mr-2 h-4 w-4" />{documentRevision.streaming ? "Optimizing…" : documentRevision.proposal ? "Regenerate" : "Optimize Entire Draft"}
                      </Button>
                    </div>

                    {documentOptimizationGate.ready && (
                      <div className="space-y-4 border-t bg-background/70 p-5">
                        <div className="space-y-2">
                          <label className="text-sm font-medium" htmlFor="asset-document-agent-instruction">Optimization focus <span className="font-normal text-muted-foreground">(optional)</span></label>
                          <Textarea id="asset-document-agent-instruction" rows={3} value={documentRevision.instruction} onChange={(event) => setDocumentRevision((current) => ({ ...current, instruction: event.target.value }))} placeholder="For example: make the argument more concise, strengthen transitions, and keep a professional research tone." disabled={documentRevision.streaming} />
                        </div>

                        {documentRevision.status && <p className="text-sm text-muted-foreground">{documentRevision.status}</p>}
                        {documentRevision.pendingQuestion && (
                          <QuestionCard
                            questions={documentRevision.pendingQuestion.questions}
                            onSubmit={async (answers: HarnessQuestionAnswer[]) => {
                              await answerHarnessQuestion(documentRevision.pendingQuestion!.rpcId, documentRevision.pendingQuestion!.sessionId, answers);
                              setDocumentRevision((current) => ({ ...current, pendingQuestion: undefined, status: "Clarification submitted. Agent is continuing the complete optimization…" }));
                            }}
                          />
                        )}

                        {documentRevision.proposal && (
                          <div className="space-y-4" data-document-agent-diff-preview>
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <div><p className="text-sm font-semibold">Complete Draft Diff</p><p className="text-xs text-muted-foreground">Review the title, brief, and combined document before applying changes to the editor.</p></div>
                              <Badge variant="outline">Workspace revision {documentRevision.proposal.baseWorkspaceRevision}</Badge>
                            </div>
                            {documentRevision.proposal.explanation && <p className="rounded-xl bg-violet-50 p-3 text-sm text-violet-950">{documentRevision.proposal.explanation}</p>}
                            <div className="grid gap-3 md:grid-cols-2">
                              <div className="rounded-xl border p-3"><p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Current title</p><p className="mt-2 text-sm">{editTitle}</p></div>
                              <div className="rounded-xl border border-emerald-200 bg-emerald-50/50 p-3"><p className="text-xs font-semibold uppercase tracking-wide text-emerald-700">Proposed title</p><p className="mt-2 text-sm font-medium">{documentRevision.proposal.replacementTitle}</p></div>
                              <div className="rounded-xl border p-3"><p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Current brief</p><p className="mt-2 text-sm text-muted-foreground">{editBrief || "No brief"}</p></div>
                              <div className="rounded-xl border border-emerald-200 bg-emerald-50/50 p-3"><p className="text-xs font-semibold uppercase tracking-wide text-emerald-700">Proposed brief</p><p className="mt-2 text-sm">{documentRevision.proposal.replacementBrief || "No brief"}</p></div>
                            </div>
                            <pre className="max-h-[32rem] overflow-auto rounded-xl border bg-muted/20 p-3 text-xs leading-5">
                              {documentDiffLines.map((line, lineIndex) => (
                                <div key={`${lineIndex}-${line.kind}`} className={line.kind === "added" ? "bg-emerald-100 text-emerald-950" : line.kind === "removed" ? "bg-red-100 text-red-950" : "text-muted-foreground"}>
                                  <span className="mr-2 inline-block w-3 select-none">{line.kind === "added" ? "+" : line.kind === "removed" ? "-" : " "}</span>{line.text || " "}
                                </div>
                              ))}
                            </pre>
                            <div className="flex flex-wrap items-center gap-2">
                              <Button type="button" size="sm" onClick={applyDocumentRevision}><CheckCircle2 className="mr-2 h-4 w-4" />Apply to Editor</Button>
                              <Button type="button" variant="outline" size="sm" onClick={() => void startDocumentRevision()} disabled={documentRevision.streaming}>Regenerate</Button>
                              <Button type="button" variant="ghost" size="sm" onClick={() => setDocumentRevision((current) => ({ ...current, proposal: undefined, status: "Proposal discarded." }))}>Discard</Button>
                              <span className="text-xs text-muted-foreground">You must still use Save Changes below.</span>
                            </div>
                          </div>
                        )}
                        {documentRevision.error && <p className="text-sm text-destructive">{documentRevision.error}</p>}
                      </div>
                    )}
                  </section>

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
                        <details className="mt-3 rounded-lg border bg-background px-3 py-2">
                          <summary className="cursor-pointer text-xs font-medium text-muted-foreground">Linked Claims ({block.claimRefs.length})</summary>
                          <div className="mt-3 space-y-2">
                            {(workspaceQuery.data?.claims ?? []).filter((claim) => claim.status === "accepted" || claim.status === "hypothesis").length === 0 && <p className="text-xs text-muted-foreground">No Accepted Claims or retained Hypotheses are available.</p>}
                            {(workspaceQuery.data?.claims ?? []).filter((claim) => claim.status === "accepted" || claim.status === "hypothesis").map((claim) => (
                              <label key={claim.id} className="flex cursor-pointer items-start gap-2 rounded-md border p-2 text-xs">
                                <input type="checkbox" className="mt-0.5" checked={block.claimRefs.includes(claim.id)} onChange={() => toggleBlockClaim(block.id, claim.id)} />
                                <span className="min-w-0"><span className="font-medium">{claim.content}</span><span className="mt-1 block text-muted-foreground">{claim.id} · {claim.status}</span></span>
                              </label>
                            ))}
                          </div>
                        </details>
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
                              <p className="text-xs text-muted-foreground">可以直接启动 Agent 获取建议，也可以先写具体要求。Agent 只生成候选补丁；点击应用后仍需 Save Changes 才会写入 Asset。</p>
                            </div>
                            <div className="space-y-2">
                              <label className="text-sm font-medium" htmlFor={`agent-block-instruction-${block.id}`}>你希望怎么修改这一段？（可选）</label>
                              <Textarea
                                id={`agent-block-instruction-${block.id}`}
                                aria-label={`Agent instruction for block ${index + 1}`}
                                rows={3}
                                value={revision.instruction}
                                disabled={revision.streaming}
                                placeholder="留空时，Agent 会根据 Intent、上下文和已确认 Claim 主动提出改进。"
                                onChange={(event) => setBlockRevision((current) => current ? { ...current, instruction: event.target.value } : current)}
                              />
                              <div className="flex flex-wrap gap-2">
                                <Button type="button" size="sm" onClick={() => void startBlockRevision()} disabled={revision.streaming}>
                                  {revision.streaming ? "Agent 工作中…" : revision.proposal ? "重新生成" : revision.instruction.trim() ? "按要求修改" : "让 Agent 建议"}
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
                                {revision.proposal.claimRefs && <div className="flex flex-wrap gap-2"><span className="text-xs font-semibold text-muted-foreground">Proposed Claim links:</span>{revision.proposal.claimRefs.length ? revision.proposal.claimRefs.map((claimId) => <Badge key={claimId} variant="outline">{claimId}</Badge>) : <span className="text-xs text-muted-foreground">none</span>}</div>}
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
                <Card>
                  <CardHeader>
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div><CardTitle>Collect Evidence with Agent</CardTitle><CardDescription>The Agent searches within the confirmed Intent and can only return candidates.</CardDescription></div>
                      <Badge variant="outline">Workspace revision {workspaceQuery.data?.workspace_revision ?? 0}</Badge>
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    {!workspaceQuery.data?.intent ? (
                      <p className="text-sm text-muted-foreground">Confirm an Intent before collecting structured Evidence.</p>
                    ) : (
                      <>
                        <Textarea
                          aria-label="Evidence research instruction"
                          rows={3}
                          value={evidenceAgent.instruction}
                          onChange={(event) => setEvidenceAgent((current) => ({ ...current, instruction: event.target.value }))}
                          placeholder="Optional focus, for example: find a primary source that contradicts the current recommendation."
                        />
                        <div className="flex flex-wrap items-center gap-3">
                          <Button type="button" onClick={() => void startEvidenceResearch()} disabled={evidenceAgent.streaming || workspaceQuery.isLoading}>
                            {evidenceAgent.streaming ? "Collecting…" : "Ask Agent to Collect Evidence"}
                          </Button>
                          {evidenceAgent.streaming && <Button type="button" variant="outline" onClick={() => evidenceAgentAbortRef.current?.abort()}>Stop</Button>}
                          {evidenceAgent.status && <span className="text-sm text-muted-foreground">{evidenceAgent.status}</span>}
                        </div>
                      </>
                    )}
                    {evidenceAgent.pendingQuestion && (
                      <div className="overflow-hidden rounded-xl border">
                        <QuestionCard
                          questions={evidenceAgent.pendingQuestion.questions}
                          onSubmit={async (answers) => {
                            const question = evidenceAgent.pendingQuestion;
                            if (!question) return;
                            await answerHarnessQuestion(question.rpcId, question.sessionId, answers);
                            setEvidenceAgent((current) => ({ ...current, pendingQuestion: undefined, status: "Scope decision submitted. Agent is continuing…" }));
                          }}
                        />
                      </div>
                    )}
                    {evidenceAgent.proposal && (
                      <div className="space-y-3 rounded-xl border border-primary/20 bg-primary/5 p-4">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div><p className="font-semibold">Evidence Proposal</p><p className="text-xs text-muted-foreground">Review before saving. Saving keeps these items in proposed state.</p></div>
                          <Badge variant="secondary">{evidenceAgent.proposal.proposals.length} candidates</Badge>
                        </div>
                        <div className="grid gap-3 md:grid-cols-2">
                          {evidenceAgent.proposal.proposals.map((item, index) => (
                            <div key={`${item.targetType}-${item.targetId}-${index}`} className="rounded-lg border bg-background p-3">
                              <div className="flex flex-wrap items-center gap-2"><Badge variant="outline">{item.relation}</Badge><Badge variant="secondary">{item.targetType}</Badge></div>
                              <p className="mt-2 break-all text-xs text-muted-foreground">{item.targetId}</p>
                              <p className="mt-2 text-sm leading-6">{item.summary}</p>
                              {typeof item.fragmentSelector?.exact === "string" && <blockquote className="mt-2 border-l-2 pl-3 text-xs text-muted-foreground">{item.fragmentSelector.exact}</blockquote>}
                            </div>
                          ))}
                        </div>
                        <div className="flex flex-wrap gap-2">
                          <Button type="button" size="sm" onClick={() => saveEvidenceProposalMutation.mutate()} disabled={saveEvidenceProposalMutation.isPending}>{saveEvidenceProposalMutation.isPending ? "Saving…" : "Save to Evidence Board"}</Button>
                          <Button type="button" variant="outline" size="sm" onClick={() => void startEvidenceResearch()} disabled={evidenceAgent.streaming}>Investigate Again</Button>
                          <Button type="button" variant="ghost" size="sm" onClick={() => setEvidenceAgent((current) => ({ ...current, proposal: undefined, status: "Proposal discarded." }))}>Discard</Button>
                        </div>
                      </div>
                    )}
                    {(evidenceAgent.error || saveEvidenceProposalMutation.isError) && <p className="text-sm text-destructive">{evidenceAgent.error || "Could not save Evidence candidates. Refresh the Workspace and investigate again."}</p>}
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader><CardTitle>Evidence Board</CardTitle><CardDescription>Only user-accepted local Evidence is attached to the Asset reference set.</CardDescription></CardHeader>
                  <CardContent className="space-y-3">
                    {(workspaceQuery.data?.evidence ?? []).length === 0 && <p className="text-sm text-muted-foreground">No structured Evidence candidates yet.</p>}
                    {(workspaceQuery.data?.evidence ?? []).map((item) => {
                      const href = evidenceHref(item.target_type, item.target_id);
                      const exact = typeof item.fragment_selector?.exact === "string" ? item.fragment_selector.exact : null;
                      return (
                        <div key={item.id} className="rounded-xl border p-4">
                          <div className="flex flex-wrap items-start justify-between gap-3">
                            <div className="min-w-0 flex-1">
                              <div className="flex flex-wrap items-center gap-2"><Badge variant="outline">{item.relation}</Badge><Badge variant="secondary">{item.status}</Badge><span className="text-xs text-muted-foreground">Intent r{item.intent_revision}</span></div>
                              {item.target_type === "web" ? <a className="mt-2 block break-all text-sm font-medium text-primary hover:underline" href={href} target="_blank" rel="noreferrer">{item.target_id}</a> : <Link className="mt-2 block break-all text-sm font-medium text-primary hover:underline" to={href}>{item.target_id}</Link>}
                              <p className="mt-2 text-sm leading-6">{item.summary}</p>
                              {exact && <blockquote className="mt-2 border-l-2 pl-3 text-xs text-muted-foreground">{exact}</blockquote>}
                            </div>
                            {item.status === "proposed" && (
                              <div className="flex gap-2">
                                <Button type="button" size="sm" onClick={() => evidenceDecisionMutation.mutate({ evidenceId: item.id, decision: "accepted" })} disabled={evidenceDecisionMutation.isPending}>Accept</Button>
                                <Button type="button" size="sm" variant="outline" onClick={() => evidenceDecisionMutation.mutate({ evidenceId: item.id, decision: "rejected" })} disabled={evidenceDecisionMutation.isPending}>Reject</Button>
                              </div>
                            )}
                          </div>
                        </div>
                      );
                    })}
                    {evidenceDecisionMutation.isError && <p className="text-sm text-destructive">Evidence changed in another revision. Refresh and retry the decision.</p>}
                  </CardContent>
                </Card>

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

            <TabsContent value="claims" className="mt-0">
              <div className="space-y-6">
                <Card>
                  <CardHeader>
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div><CardTitle>Extract Candidate Claims</CardTitle><CardDescription>The Agent proposes conclusions from Workspace Evidence but cannot accept them or speak for you.</CardDescription></div>
                      <Badge variant="outline">Claim Gate</Badge>
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    {!workspaceQuery.data?.intent ? (
                      <p className="text-sm text-muted-foreground">Confirm an Intent before extracting Candidate Claims.</p>
                    ) : (workspaceQuery.data.evidence.length === 0 ? (
                      <p className="text-sm text-muted-foreground">Add structured Evidence before asking the Agent to extract Claims.</p>
                    ) : (
                      <>
                        <Textarea
                          aria-label="Claim analysis instruction"
                          rows={3}
                          value={claimAgent.instruction}
                          onChange={(event) => setClaimAgent((current) => ({ ...current, instruction: event.target.value }))}
                          placeholder="Optional focus, for example: identify the strongest recommendation and its main counter-evidence."
                        />
                        <div className="flex flex-wrap items-center gap-3">
                          <Button type="button" onClick={() => void startClaimAnalysis()} disabled={claimAgent.streaming}>
                            {claimAgent.streaming ? "Analyzing…" : "Ask Agent to Propose Claims"}
                          </Button>
                          {claimAgent.streaming && <Button type="button" variant="outline" onClick={() => claimAgentAbortRef.current?.abort()}>Stop</Button>}
                          {claimAgent.status && <span className="text-sm text-muted-foreground">{claimAgent.status}</span>}
                        </div>
                      </>
                    ))}
                    {claimAgent.proposal && (
                      <div className="space-y-3 rounded-xl border border-primary/20 bg-primary/5 p-4">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div><p className="font-semibold">Candidate Claim Proposal</p><p className="text-xs text-muted-foreground">Saving preserves Agent authorship and proposed status.</p></div>
                          <Badge variant="secondary">{claimAgent.proposal.proposals.length} candidates</Badge>
                        </div>
                        <div className="space-y-3">
                          {claimAgent.proposal.proposals.map((item, index) => (
                            <div key={`${item.kind}-${index}`} className="rounded-lg border bg-background p-4">
                              <div className="flex flex-wrap items-center gap-2"><Badge variant="outline">{item.kind}</Badge><Badge variant="secondary">{item.agentConfidence} confidence</Badge><span className="text-xs text-muted-foreground">Agent inference</span></div>
                              <p className="mt-3 text-sm leading-6">{item.content}</p>
                              <div className="mt-3 grid gap-3 text-xs md:grid-cols-2">
                                <div><span className="font-semibold text-emerald-700">Supports:</span> {item.supportingEvidence.join(", ") || "none"}</div>
                                <div><span className="font-semibold text-rose-700">Contradicts:</span> {item.contradictingEvidence.join(", ") || "none"}</div>
                              </div>
                            </div>
                          ))}
                        </div>
                        <div className="flex flex-wrap gap-2">
                          <Button type="button" size="sm" onClick={() => saveClaimProposalMutation.mutate()} disabled={saveClaimProposalMutation.isPending}>{saveClaimProposalMutation.isPending ? "Saving…" : "Save to Claim Board"}</Button>
                          <Button type="button" variant="outline" size="sm" onClick={() => void startClaimAnalysis()} disabled={claimAgent.streaming}>Analyze Again</Button>
                          <Button type="button" variant="ghost" size="sm" onClick={() => setClaimAgent((current) => ({ ...current, proposal: undefined, status: "Proposal discarded." }))}>Discard</Button>
                        </div>
                      </div>
                    )}
                    {(claimAgent.error || saveClaimProposalMutation.isError) && <p className="text-sm text-destructive">{claimAgent.error || "Could not save Candidate Claims. Refresh the Workspace and analyze again."}</p>}
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader><CardTitle>Claim Board</CardTitle><CardDescription>Review only conclusions that may enter the final Asset. Editing a Claim does not change its Agent authorship.</CardDescription></CardHeader>
                  <CardContent className="space-y-4">
                    {(workspaceQuery.data?.claims ?? []).length === 0 && <p className="text-sm text-muted-foreground">No Candidate Claims yet.</p>}
                    {(workspaceQuery.data?.claims ?? []).map((claim) => {
                      const referencedEvidence = [...claim.supporting_evidence, ...claim.contradicting_evidence];
                      const evidenceReady = claim.supporting_evidence.length > 0 && referencedEvidence.every((evidenceId) => workspaceQuery.data?.evidence.find((item) => item.id === evidenceId)?.status === "accepted");
                      const editedContent = claimEdits[claim.id] ?? claim.content;
                      return (
                        <div key={claim.id} className="rounded-xl border p-4">
                          <div className="flex flex-wrap items-center gap-2"><Badge variant="outline">{claim.kind}</Badge><Badge variant="secondary">{claim.status}</Badge><Badge variant="outline">{claim.agent_confidence} confidence</Badge><span className="text-xs text-muted-foreground">Authorship: Agent{claim.user_edited ? " · user edited" : ""} · Intent r{claim.intent_revision}</span></div>
                          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                            <span>Used by Blocks:</span>
                            {editBlocks.some((block) => block.claimRefs.includes(claim.id))
                              ? editBlocks.filter((block) => block.claimRefs.includes(claim.id)).map((block) => <Badge key={block.id} variant="outline">{block.id}</Badge>)
                              : <span>none</span>}
                          </div>
                          {claim.status === "proposed" ? (
                            <Textarea className="mt-3" rows={3} value={editedContent} onChange={(event) => setClaimEdits((current) => ({ ...current, [claim.id]: event.target.value }))} />
                          ) : (
                            <p className="mt-3 text-sm leading-6">{claim.content}</p>
                          )}
                          <div className="mt-3 grid gap-3 md:grid-cols-2">
                            <div className="rounded-lg bg-emerald-50/60 p-3 text-xs"><p className="font-semibold text-emerald-800">Supporting Evidence</p><div className="mt-2 flex flex-wrap gap-2">{claim.supporting_evidence.length ? claim.supporting_evidence.map((evidenceId) => <Badge key={evidenceId} variant="outline">{evidenceId} · {workspaceQuery.data?.evidence.find((item) => item.id === evidenceId)?.status ?? "missing"}</Badge>) : <span className="text-muted-foreground">None</span>}</div></div>
                            <div className="rounded-lg bg-rose-50/60 p-3 text-xs"><p className="font-semibold text-rose-800">Contradicting Evidence</p><div className="mt-2 flex flex-wrap gap-2">{claim.contradicting_evidence.length ? claim.contradicting_evidence.map((evidenceId) => <Badge key={evidenceId} variant="outline">{evidenceId} · {workspaceQuery.data?.evidence.find((item) => item.id === evidenceId)?.status ?? "missing"}</Badge>) : <span className="text-muted-foreground">None</span>}</div></div>
                          </div>
                          {claim.status === "proposed" && (
                            <div className="mt-4 space-y-2">
                              {!evidenceReady && <p className="text-xs text-amber-700">Accept is locked until at least one supporting Evidence item and every referenced Evidence item are accepted.</p>}
                              <div className="flex flex-wrap gap-2">
                                <Button type="button" size="sm" onClick={() => claimDecisionMutation.mutate({ claimId: claim.id, decision: "accept" })} disabled={!evidenceReady || claimDecisionMutation.isPending}>Accept</Button>
                                <Button type="button" size="sm" variant="outline" onClick={() => claimDecisionMutation.mutate({ claimId: claim.id, decision: "edit_and_accept", editedContent })} disabled={!evidenceReady || editedContent.trim() === claim.content || !editedContent.trim() || claimDecisionMutation.isPending}>Edit and Accept</Button>
                                <Button type="button" size="sm" variant="outline" onClick={() => claimDecisionMutation.mutate({ claimId: claim.id, decision: "keep_as_hypothesis" })} disabled={claimDecisionMutation.isPending}>Keep as Hypothesis</Button>
                                <Button type="button" size="sm" variant="outline" onClick={() => claimDecisionMutation.mutate({ claimId: claim.id, decision: "need_more_evidence" })} disabled={claimDecisionMutation.isPending}>Need More Evidence</Button>
                                <Button type="button" size="sm" variant="ghost" onClick={() => claimDecisionMutation.mutate({ claimId: claim.id, decision: "reject" })} disabled={claimDecisionMutation.isPending}>Reject</Button>
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    })}
                    {claimDecisionMutation.isError && <p className="text-sm text-destructive">Claim decision failed. Confirm that referenced Evidence is accepted and the Workspace revision is current.</p>}
                  </CardContent>
                </Card>
              </div>
            </TabsContent>

            <TabsContent value="knowledge" className="mt-0">
              <div className="space-y-6">
                <Card>
                  <CardHeader>
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div><CardTitle>Distill Knowledge with Agent</CardTitle><CardDescription>Identify what this Asset adds, then create reviewable Note or Wiki Candidates. No long-term knowledge is written here.</CardDescription></div>
                      <Badge variant="outline">Workspace revision {workspaceQuery.data?.workspace_revision ?? 0}</Badge>
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <Textarea
                      aria-label="Knowledge distillation instruction"
                      rows={3}
                      value={knowledgeAgent.instruction}
                      onChange={(event) => setKnowledgeAgent((current) => ({ ...current, instruction: event.target.value }))}
                      placeholder="Optional focus, for example: extract the reusable decision and propose a Wiki update."
                    />
                    <div className="flex flex-wrap items-center gap-3">
                      <Button
                        type="button"
                        onClick={() => void startKnowledgeDistillation()}
                        disabled={knowledgeAgent.streaming || Boolean(workspaceQuery.data?.contribution && workspaceQuery.data.contribution.status !== "rejected")}
                      >
                        {knowledgeAgent.streaming ? "Distilling…" : "Ask Agent to Distill Knowledge"}
                      </Button>
                      {knowledgeAgent.streaming && <Button type="button" variant="outline" onClick={() => knowledgeAgentAbortRef.current?.abort()}>Stop</Button>}
                      {workspaceQuery.data?.contribution && workspaceQuery.data.contribution.status !== "rejected" && <span className="text-xs text-muted-foreground">Resolve the current Contribution before generating another.</span>}
                    </div>
                    {knowledgeAgent.status && <p className="text-sm text-muted-foreground">{knowledgeAgent.status}</p>}
                    {knowledgeAgent.error && <p className="text-sm text-destructive">{knowledgeAgent.error}</p>}
                    {knowledgeAgent.proposal && (
                      <div className="space-y-3 rounded-xl border bg-muted/20 p-4">
                        <div className="flex flex-wrap items-center gap-2"><Badge variant="outline">{knowledgeAgent.proposal.contribution.kind}</Badge><Badge variant="secondary">Agent proposal</Badge></div>
                        <p className="text-sm leading-6">{knowledgeAgent.proposal.contribution.summary}</p>
                        <div className="flex flex-wrap gap-2">{knowledgeAgent.proposal.contribution.claimRefs.map((claimId) => <Badge key={claimId} variant="outline">{claimId}</Badge>)}</div>
                        {knowledgeAgent.proposal.candidates.map((candidate, index) => (
                          <div key={`${candidate.candidateType}-${index}`} className="rounded-lg border bg-background p-3">
                            <div className="flex flex-wrap items-center gap-2"><Badge variant="outline">{candidate.candidateType}</Badge><Badge variant="outline">{candidate.action}</Badge><span className="font-medium">{candidate.title}</span></div>
                            <p className="mt-2 whitespace-pre-wrap text-sm text-muted-foreground">{candidate.content}</p>
                          </div>
                        ))}
                        <div className="flex flex-wrap gap-2">
                          <Button type="button" size="sm" onClick={() => saveKnowledgeProposalMutation.mutate()} disabled={saveKnowledgeProposalMutation.isPending}>Save Candidates for Review</Button>
                          <Button type="button" size="sm" variant="ghost" onClick={() => setKnowledgeAgent((current) => ({ ...current, proposal: undefined, status: "Proposal discarded." }))}>Discard</Button>
                        </div>
                        {saveKnowledgeProposalMutation.isError && <p className="text-sm text-destructive">Could not save the proposal. Refresh the Workspace and try again.</p>}
                      </div>
                    )}
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader><CardTitle>Contribution Gate</CardTitle><CardDescription>Confirm what this Asset adds and whether the wording represents Agent synthesis or your own insight.</CardDescription></CardHeader>
                  <CardContent className="space-y-4">
                    {!workspaceQuery.data?.contribution ? (
                      <p className="text-sm text-muted-foreground">No Contribution has been proposed.</p>
                    ) : (
                      <div className="space-y-3 rounded-xl border p-4">
                        <div className="flex flex-wrap items-center gap-2"><Badge variant="outline">{workspaceQuery.data.contribution.kind}</Badge><Badge variant="secondary">{workspaceQuery.data.contribution.status}</Badge><span className="text-xs text-muted-foreground">Authorship: Agent{workspaceQuery.data.contribution.user_edited ? " · user edited" : ""}</span></div>
                        {workspaceQuery.data.contribution.status === "proposed" ? (
                          <Textarea rows={4} value={contributionEdit} onChange={(event) => setContributionEdit(event.target.value)} />
                        ) : (
                          <p className="text-sm leading-6">{workspaceQuery.data.contribution.summary}</p>
                        )}
                        <div className="flex flex-wrap gap-2">{workspaceQuery.data.contribution.claim_refs.map((claimId) => <Badge key={claimId} variant="outline">{claimId}</Badge>)}</div>
                        {workspaceQuery.data.contribution.attribution && <p className="text-xs text-muted-foreground">Confirmed attribution: {workspaceQuery.data.contribution.attribution === "user_insight" ? "User insight" : "Agent synthesis"}</p>}
                        {workspaceQuery.data.contribution.status === "proposed" && (
                          <div className="space-y-2">
                            <p className="text-xs text-muted-foreground">Accepting requires an explicit attribution. The Agent cannot choose User insight.</p>
                            <div className="flex flex-wrap gap-2">
                              <Button type="button" size="sm" onClick={() => contributionDecisionMutation.mutate({ decision: contributionEdit.trim() === workspaceQuery.data?.contribution?.summary ? "accept" : "edit_and_accept", attribution: "agent_synthesis" })} disabled={!contributionEdit.trim() || contributionDecisionMutation.isPending}>Accept as Agent Synthesis</Button>
                              <Button type="button" size="sm" variant="outline" onClick={() => contributionDecisionMutation.mutate({ decision: contributionEdit.trim() === workspaceQuery.data?.contribution?.summary ? "accept" : "edit_and_accept", attribution: "user_insight" })} disabled={!contributionEdit.trim() || contributionDecisionMutation.isPending}>Confirm as My Insight</Button>
                              <Button type="button" size="sm" variant="ghost" onClick={() => contributionDecisionMutation.mutate({ decision: "reject" })} disabled={contributionDecisionMutation.isPending}>Reject</Button>
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader><CardTitle>Knowledge Candidates</CardTitle><CardDescription>Keeping a Candidate preserves the proposal only. Promotion into a formal Note or Wiki remains a separate user-confirmed action.</CardDescription></CardHeader>
                  <CardContent className="space-y-3">
                    {(workspaceQuery.data?.knowledge_candidates ?? []).length === 0 ? (
                      <p className="text-sm text-muted-foreground">No Note or Wiki Candidates yet.</p>
                    ) : (workspaceQuery.data?.knowledge_candidates ?? []).map((candidate) => {
                      const edits = knowledgeCandidateEdits[candidate.id] ?? { title: candidate.title, content: candidate.content };
                      const promotionLabel = candidate.candidate_type === "note"
                        ? "Promote to Note"
                        : candidate.action === "update" ? "Apply Wiki Update" : "Create Draft Wiki";
                      const targetHref = candidate.promoted_target_type === "note"
                        ? `/notes/${encodeURIComponent(candidate.promoted_target_id ?? "")}`
                        : `/wiki/${encodeURIComponent(candidate.promoted_target_id ?? "")}`;
                      return (
                        <div key={candidate.id} className="rounded-xl border p-4">
                          <div className="flex flex-wrap items-center gap-2"><Badge variant="outline">{candidate.candidate_type}</Badge><Badge variant="outline">{candidate.action}</Badge><Badge variant="secondary">{candidate.status}</Badge><span className="font-medium">{candidate.title}</span></div>
                          {candidate.status === "kept" ? (
                            <div className="mt-3 space-y-3">
                              <Input value={edits.title} onChange={(event) => setKnowledgeCandidateEdits((current) => ({ ...current, [candidate.id]: { ...edits, title: event.target.value } }))} aria-label="Promotion title" />
                              <Textarea rows={6} value={edits.content} onChange={(event) => setKnowledgeCandidateEdits((current) => ({ ...current, [candidate.id]: { ...edits, content: event.target.value } }))} aria-label="Promotion content" />
                            </div>
                          ) : (
                            <p className="mt-3 whitespace-pre-wrap text-sm leading-6 text-muted-foreground">{candidate.content}</p>
                          )}
                          <div className="mt-3 flex flex-wrap gap-2">{candidate.claim_refs.map((claimId) => <Badge key={claimId} variant="outline">{claimId}</Badge>)}</div>
                          {candidate.status === "proposed" && (
                            <div className="mt-4 flex flex-wrap gap-2">
                              <Button type="button" size="sm" onClick={() => knowledgeCandidateDecisionMutation.mutate({ candidateId: candidate.id, decision: "keep" })} disabled={knowledgeCandidateDecisionMutation.isPending}>Keep Candidate</Button>
                              <Button type="button" size="sm" variant="ghost" onClick={() => knowledgeCandidateDecisionMutation.mutate({ candidateId: candidate.id, decision: "reject" })} disabled={knowledgeCandidateDecisionMutation.isPending}>Reject</Button>
                            </div>
                          )}
                          {candidate.status === "kept" && (
                            <div className="mt-4 space-y-2">
                              <p className="text-xs text-muted-foreground">Promotion writes a formal Knowledge Record and cannot be performed by the Agent.</p>
                              <Button
                                type="button"
                                size="sm"
                                disabled={workspaceQuery.data?.contribution?.status !== "accepted" || !edits.title.trim() || !edits.content.trim() || knowledgePromotionMutation.isPending}
                                onClick={() => {
                                  const isOverwrite = candidate.candidate_type === "wiki" && candidate.action === "update";
                                  const message = isOverwrite
                                    ? `Apply this Candidate by overwriting Wiki ${candidate.target_wiki_id}? This is a formal knowledge change.`
                                    : `Promote this Candidate to a formal ${candidate.candidate_type === "note" ? "Note" : "draft Wiki"}?`;
                                  if (window.confirm(message)) knowledgePromotionMutation.mutate({ candidateId: candidate.id, confirmOverwrite: isOverwrite });
                                }}
                              >{promotionLabel}</Button>
                            </div>
                          )}
                          {candidate.status === "promoted" && candidate.promoted_target_id && (
                            <p className="mt-4 text-sm"><Link className="text-primary hover:underline" to={targetHref}>Open promoted {candidate.promoted_target_type}</Link>{candidate.user_edited ? <span className="ml-2 text-xs text-muted-foreground">Edited before promotion</span> : null}</p>
                          )}
                        </div>
                      );
                    })}
                    {knowledgePromotionMutation.isError && <p className="text-sm text-destructive">Promotion failed. Confirm the Contribution, Candidate state, and current Workspace revision.</p>}
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
                <div className="rounded-2xl border bg-muted/10 p-4">
                  <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
                    <div className="max-w-2xl">
                      <p className="text-sm font-semibold">Delivery Format</p>
                      <p className="mt-1 text-sm leading-6 text-muted-foreground">The editable source remains Markdown. HTML preview and export are generated from the same reviewed Asset without changing Blocks or Claim links.</p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <select aria-label="Asset delivery format" className="h-9 rounded-md border border-input bg-background px-3 text-sm" value={deliveryFormat} onChange={(event) => setDeliveryFormat(event.target.value as "markdown" | "html")}>
                        <option value="markdown">Markdown</option>
                        <option value="html">HTML</option>
                      </select>
                      <Button type="button" variant="outline" size="sm" onClick={() => saveDeliveryFormatMutation.mutate()} disabled={saveDeliveryFormatMutation.isPending || (asset.metadata_?.delivery_format === deliveryFormat || (!asset.metadata_?.delivery_format && deliveryFormat === "markdown"))}>
                        {saveDeliveryFormatMutation.isPending ? "Saving…" : "Save Preference"}
                      </Button>
                      <Button type="button" variant="outline" size="sm" onClick={() => previewHtmlMutation.mutate()} disabled={previewHtmlMutation.isPending}>
                        <Eye className="mr-2 h-4 w-4" />{previewHtmlMutation.isPending ? "Rendering…" : "Preview HTML"}
                      </Button>
                    </div>
                  </div>
                  {saveDeliveryFormatMutation.isSuccess && <p className="mt-3 text-xs text-emerald-700">Delivery preference saved.</p>}
                  {(saveDeliveryFormatMutation.isError || previewHtmlMutation.isError) && <p className="mt-3 text-xs text-destructive">Could not save or render the HTML delivery format.</p>}
                </div>

                <div className="flex flex-wrap gap-2">
                  {primaryAction?.nextStatus && (
                    <Button onClick={() => statusMutation.mutate(primaryAction.nextStatus)} disabled={isBusy || (primaryAction.nextStatus === "ready_to_export" && !readinessQuery.data?.ready)}>
                      {statusMutation.isPending ? "Updating…" : primaryAction.label}
                    </Button>
                  )}
                  {primaryAction && !primaryAction.nextStatus && asset.status === "ready_to_export" && (
                    <Button onClick={exportPreferred} disabled={isBusy}>
                      {isExporting ? "Exporting…" : deliveryFormat === "html" ? <><Download className="mr-2 h-4 w-4" />Export HTML</> : primaryAction.label}
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
                {(exportMutation.isError || exportHtmlMutation.isError) && (
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

        <Dialog open={htmlPreviewOpen} onOpenChange={setHtmlPreviewOpen}>
          <DialogContent className="flex h-[88vh] max-w-[min(1100px,calc(100vw-32px))] flex-col p-0">
            <DialogHeader className="mb-0 flex-row items-center justify-between border-b px-6 py-4 pr-12 text-left">
              <div>
                <DialogTitle>HTML Preview</DialogTitle>
                <p className="mt-1 text-xs text-muted-foreground">Sandboxed preview generated from the current Markdown Asset.</p>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={async () => {
                  await navigator.clipboard.writeText(htmlPreview);
                  setHtmlCopied(true);
                }}
                disabled={!htmlPreview}
              >
                <Copy className="mr-2 h-4 w-4" />{htmlCopied ? "Copied" : "Copy HTML"}
              </Button>
            </DialogHeader>
            <div className="min-h-0 flex-1 bg-muted/30 p-4">
              <iframe title="Asset HTML Preview" sandbox="" srcDoc={htmlPreview} className="h-full w-full rounded-xl border bg-white shadow-sm" />
            </div>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
}
