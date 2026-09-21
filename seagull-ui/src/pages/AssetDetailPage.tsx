import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams, Link, useNavigate, useLocation } from "react-router-dom";
import { BookOpen, CalendarDays, ChartNoAxesCombined, CheckCircle2, CircleAlert, Clock3, Copy, Download, Eye, FileSearch, LibraryBig, MailOpen, MessageSquareShare, PenLine, Quote, Sparkles, Square, WandSparkles } from "lucide-react";
import { assetsApi, authApi, notesApi, sourcesApi, wikiApi, type Asset, type AssetClaimProposalInput, type AssetContributionKind, type AssetEvidenceProposalInput, type AssetEvidenceRelation, type AssetKnowledgeProposalInput, type AssetMissingEvidenceRequest, type AssetQualityAuditResult, type AssetStatus, type AssetStyleProfileId, type AssetType, type ReadinessCheckResult } from "@/lib/api";
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
import { createAssetBlock, createAssetDocument, hasStableAssetDocument, loadAssetBlocks, locateAssetBlockRange, locateAssetBlockSelection, reconcileAssetBlocks, serializeAssetBlocks, updateAssetBlock, updateAssetBlockClaimRefs, type AssetBlock } from "@/lib/asset-blocks";
import { answerHarnessQuestion, harnessChat, type HarnessQuestionAnswer, type HarnessQuestionItem } from "@/lib/api";
import { useReturnNavigation } from "@/hooks/useReturnNavigation";
import { useRouteScrollRestoration } from "@/hooks/useRouteScrollRestoration";
import { assetEditorSignature, clearAssetEditorRecovery, readAssetEditorRecovery, writeAssetEditorRecovery, type AssetEditorRecovery, type AssetEditorSnapshot } from "@/lib/asset-editor-recovery";
import { ActionError } from "@/components/interaction/ActionError";
import { AgentRunStatus } from "@/components/interaction/AgentRunStatus";
import { ProposalActions } from "@/components/interaction/ProposalActions";
import { UnsavedChangesBanner } from "@/components/interaction/UnsavedChangesBanner";
import { MindMapCanvas, type MindMapCanvasNode } from "@/components/mind-map/MindMapCanvas";
import { mindMapsApi, type AssetOutlineDocumentPatchProposal, type AssetOutlinePatchOperation, type MindMapNodeRead } from "@/lib/api/mind-maps";
import { ASSET_STYLE_PROFILES, defaultAssetStyleProfile } from "@/lib/asset-generation";
import { renderMermaidDiagramsForWechat } from "@/lib/mermaid-export";

type AssetOutlineRefreshOperation = "add" | "move" | "rename" | "delete";

interface AssetOutlineRefreshChange {
  operation: AssetOutlineRefreshOperation;
  assetBlockId: string;
  label: string;
  detail: string;
}

type ProductionEvent = {
  event_type?: string;
  asset_id?: string;
  asset_type?: string;
  title?: string;
  status?: string;
  timestamp?: string;
  detail?: Record<string, unknown>;
};

type AssetDetailTab = "intent" | "evidence" | "claims" | "read" | "edit" | "map" | "knowledge" | "production";
const ASSET_DETAIL_TABS: AssetDetailTab[] = ["intent", "evidence", "claims", "read", "edit", "map", "knowledge", "production"];

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
  diagnostic?: string;
}

const EVIDENCE_RELATION_PRESENTATION: Record<AssetEvidenceRelation, { label: string; description: string; className: string }> = {
  supports: { label: "Supports", description: "Directly strengthens a Claim or the confirmed Intent.", className: "border-emerald-200 bg-emerald-50/60 text-emerald-900" },
  contradicts: { label: "Contradicts", description: "Challenges an assumption or conclusion and must stay visible.", className: "border-rose-200 bg-rose-50/60 text-rose-900" },
  context: { label: "Context", description: "Explains background without proving the conclusion.", className: "border-sky-200 bg-sky-50/60 text-sky-900" },
  unverified: { label: "Unverified", description: "Potentially useful, but its reliability or relevance is not confirmed.", className: "border-amber-200 bg-amber-50/60 text-amber-900" },
};

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
  diagnostic?: string;
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
  diagnostic?: string;
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
  diagnostic?: string;
}

interface AssetEditorSelection {
  blockId: string;
  text: string;
}

interface AssetDocumentPatchBlock {
  blockId: string;
  baseRevision: number;
  replacementMarkdown: string;
  claimRefs: string[];
}

interface AssetDocumentReplacementBlock {
  markdown: string;
  claimRefs: string[];
}

interface AssetDocumentPatch {
  assetId: string;
  baseWorkspaceRevision: number;
  rewriteMode: "patch_blocks" | "replace_document";
  baseDocumentSignature?: string;
  replacementTitle: string;
  replacementBrief: string;
  explanation?: string;
  blocks: AssetDocumentPatchBlock[];
  replacementBlocks?: AssetDocumentReplacementBlock[];
}

interface DocumentRevisionState {
  instruction: string;
  streaming: boolean;
  status: string;
  round?: number;
  requestedInstruction?: string;
  sessionId?: string;
  pendingQuestion?: PendingBlockQuestion;
  proposal?: AssetDocumentPatch;
  error?: string;
  diagnostic?: string;
}

interface AssetOptimizationRoundRecord {
  round: number;
  completed_at: string;
  workspace_revision: number;
  instruction: string;
  audit_verdict?: AssetQualityAuditResult["verdict"];
  audit_score?: number;
  finding_ids: string[];
}

interface AssetOptimizationMetadata {
  schema_version: 1;
  completed_rounds: number;
  last_completed_at?: string;
  history: AssetOptimizationRoundRecord[];
}

interface PendingOptimizationRound {
  round: number;
  workspaceRevision: number;
  instruction: string;
  auditVerdict?: AssetQualityAuditResult["verdict"];
  auditScore?: number;
  findingIds: string[];
}

interface DiffLine {
  kind: "same" | "removed" | "added";
  text: string;
}

const DOCUMENT_OPTIMIZATION_TIMEOUT_MS = 5 * 60 * 1000;

function assetDocumentSignature(blocks: AssetBlock[]) {
  const value = JSON.stringify(blocks.map((block) => ({
    id: block.id,
    revision: block.revision,
    markdown: block.markdown,
    claimRefs: block.claimRefs,
  })));
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `document-${(hash >>> 0).toString(36)}`;
}

function applyAssetOutlineOperations(blocks: AssetBlock[], operations: AssetOutlinePatchOperation[]) {
  const originalById = new Map(blocks.map((block) => [block.id, block]));
  for (const operation of operations) {
    if (operation.operation === "add") continue;
    const block = originalById.get(operation.block_id);
    if (!block) throw new Error(`Asset Block ${operation.block_id} is no longer available in the editor.`);
    if (block.revision !== operation.base_block_revision) {
      throw new Error(`Asset Block ${operation.block_id} changed from revision ${operation.base_block_revision} to ${block.revision}.`);
    }
  }

  const nextBlocks = blocks.map((block) => ({ ...block, claimRefs: [...block.claimRefs] }));
  const tempBlockIds = new Map<string, string>();
  const resolveDestination = (destinationId: string | null | undefined) => destinationId ? (tempBlockIds.get(destinationId) ?? destinationId) : null;
  const insertAfter = (block: AssetBlock, destinationId: string | null) => {
    if (destinationId === null) {
      nextBlocks.unshift(block);
      return;
    }
    const destinationIndex = nextBlocks.findIndex((candidate) => candidate.id === destinationId);
    if (destinationIndex < 0) throw new Error(`Patch destination ${destinationId} is no longer available.`);
    nextBlocks.splice(destinationIndex + 1, 0, block);
  };

  for (const operation of operations) {
    if (operation.operation === "delete") {
      const index = nextBlocks.findIndex((block) => block.id === operation.block_id);
      if (index < 0) throw new Error(`Asset Block ${operation.block_id} could not be deleted because it is missing.`);
      nextBlocks.splice(index, 1);
      continue;
    }
    if (operation.operation === "add") {
      const block = { ...createAssetBlock(operation.markdown), claimRefs: [...operation.claim_refs] };
      tempBlockIds.set(operation.temp_block_id, block.id);
      insertAfter(block, resolveDestination(operation.after_block_id));
      continue;
    }
    if (operation.operation === "move") {
      const index = nextBlocks.findIndex((block) => block.id === operation.block_id);
      if (index < 0) throw new Error(`Asset Block ${operation.block_id} could not be moved because it is missing.`);
      const [block] = nextBlocks.splice(index, 1);
      insertAfter(block, resolveDestination(operation.after_block_id));
      continue;
    }
    const index = nextBlocks.findIndex((block) => block.id === operation.block_id);
    if (index < 0) throw new Error(`Asset Block ${operation.block_id} could not be updated because it is missing.`);
    nextBlocks[index] = updateAssetBlock(nextBlocks[index], operation.replacement_markdown);
  }
  return nextBlocks;
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
  let candidateValue = value;
  if (typeof candidateValue === "string") {
    try {
      candidateValue = JSON.parse(candidateValue);
    } catch {
      return null;
    }
  }
  if (!candidateValue || typeof candidateValue !== "object") return null;
  const candidate = candidateValue as Record<string, unknown>;
  const assetId = candidate.assetId ?? candidate.asset_id;
  const baseWorkspaceRevision = candidate.baseWorkspaceRevision ?? candidate.base_workspace_revision;
  const replacementTitle = candidate.replacementTitle ?? candidate.replacement_title;
  const replacementBrief = candidate.replacementBrief ?? candidate.replacement_brief;
  const rewriteMode = (candidate.rewriteMode ?? candidate.rewrite_mode) === "replace_document" ? "replace_document" : "patch_blocks";
  const baseDocumentSignature = candidate.baseDocumentSignature ?? candidate.base_document_signature;
  let blocksValue = candidate.blocks;
  if (typeof blocksValue === "string") {
    try {
      blocksValue = JSON.parse(blocksValue);
    } catch {
      return null;
    }
  }
  if (
    typeof assetId !== "string"
    || typeof baseWorkspaceRevision !== "number"
    || typeof replacementTitle !== "string"
    || typeof replacementBrief !== "string"
    || !Array.isArray(blocksValue)
  ) return null;
  const blocks = blocksValue.flatMap((item): AssetDocumentPatchBlock[] => {
    if (!item || typeof item !== "object") return [];
    const block = item as Record<string, unknown>;
    const blockId = block.blockId ?? block.block_id;
    const baseRevision = block.baseRevision ?? block.base_revision;
    const replacementMarkdown = block.replacementMarkdown ?? block.replacement_markdown;
    const claimRefs = block.claimRefs ?? block.claim_refs ?? [];
    if (
      typeof blockId !== "string"
      || typeof baseRevision !== "number"
      || typeof replacementMarkdown !== "string"
      || !Array.isArray(claimRefs)
      || !claimRefs.every((claimId) => typeof claimId === "string")
    ) return [];
    return [{ blockId, baseRevision, replacementMarkdown, claimRefs }];
  });
  if (blocks.length !== blocksValue.length) return null;
  let replacementBlocksValue = candidate.replacementBlocks ?? candidate.replacement_blocks;
  if (typeof replacementBlocksValue === "string") {
    try {
      replacementBlocksValue = JSON.parse(replacementBlocksValue);
    } catch {
      return null;
    }
  }
  const replacementBlocks = Array.isArray(replacementBlocksValue)
    ? replacementBlocksValue.flatMap((item): AssetDocumentReplacementBlock[] => {
        if (!item || typeof item !== "object") return [];
        const block = item as Record<string, unknown>;
        const markdown = block.markdown ?? block.replacementMarkdown ?? block.replacement_markdown;
        const claimRefs = block.claimRefs ?? block.claim_refs ?? [];
        if (typeof markdown !== "string" || !Array.isArray(claimRefs) || !claimRefs.every((claimId) => typeof claimId === "string")) return [];
        return [{ markdown, claimRefs }];
      })
    : [];
  if (rewriteMode === "replace_document" && (
    typeof baseDocumentSignature !== "string"
    || !Array.isArray(replacementBlocksValue)
    || replacementBlocks.length !== replacementBlocksValue.length
    || replacementBlocks.length === 0
  )) return null;
  return {
    assetId,
    baseWorkspaceRevision,
    rewriteMode,
    ...(typeof baseDocumentSignature === "string" ? { baseDocumentSignature } : {}),
    replacementTitle,
    replacementBrief,
    ...(typeof candidate.explanation === "string" ? { explanation: candidate.explanation } : {}),
    blocks,
    ...(rewriteMode === "replace_document" ? { replacementBlocks } : {}),
  };
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
  if (proposal.rewriteMode === "replace_document") {
    if (proposal.baseDocumentSignature !== assetDocumentSignature(blocks)) return "The draft changed while the Agent was rewriting it.";
    if (!proposal.replacementBlocks?.length) return "Agent returned an empty replacement document.";
    const replacementIsUnchanged = proposal.replacementBlocks.length === blocks.length
      && proposal.replacementBlocks.every((block, index) => {
        const currentBlock = blocks[index];
        return currentBlock
          && block.markdown === currentBlock.markdown
          && block.claimRefs.length === currentBlock.claimRefs.length
          && block.claimRefs.every((claimId, claimIndex) => claimId === currentBlock.claimRefs[claimIndex]);
      });
    if (replacementIsUnchanged) return "Agent returned an unchanged replacement document.";
    return null;
  }

  if (proposal.blocks.length === 0) return "Agent returned an empty Block patch.";
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
  if (proposal.rewriteMode === "replace_document") {
    return proposal.replacementBlocks?.map((block) => block.markdown) ?? [];
  }
  const proposedBlocks = new Map(proposal.blocks.map((block) => [block.blockId, block]));
  return blocks.map((block) => proposedBlocks.get(block.id)?.replacementMarkdown ?? block.markdown);
}

function readAssetOptimizationMetadata(metadata: Record<string, unknown> | null | undefined): AssetOptimizationMetadata {
  const candidate = metadata?.asset_optimization_v1;
  if (!candidate || typeof candidate !== "object") {
    return { schema_version: 1, completed_rounds: 0, history: [] };
  }
  const raw = candidate as Record<string, unknown>;
  const history = Array.isArray(raw.history)
    ? raw.history.filter((item): item is AssetOptimizationRoundRecord => {
        if (!item || typeof item !== "object") return false;
        const record = item as Record<string, unknown>;
        return typeof record.round === "number"
          && typeof record.completed_at === "string"
          && typeof record.workspace_revision === "number"
          && typeof record.instruction === "string"
          && Array.isArray(record.finding_ids)
          && record.finding_ids.every((findingId) => typeof findingId === "string");
      })
    : [];
  const completedRounds = typeof raw.completed_rounds === "number"
    ? Math.max(raw.completed_rounds, ...history.map((item) => item.round), 0)
    : Math.max(...history.map((item) => item.round), 0);
  return {
    schema_version: 1,
    completed_rounds: completedRounds,
    last_completed_at: typeof raw.last_completed_at === "string" ? raw.last_completed_at : undefined,
    history,
  };
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

function assetStylePresentation(styleProfileId: AssetStyleProfileId) {
  if (styleProfileId === "executive_brief") return { shell: "border-sky-900 bg-[#10253a]", header: "from-slate-950/40", label: "Executive Brief" };
  if (styleProfileId === "visual_digest") return { shell: "border-fuchsia-200 bg-gradient-to-br from-orange-50 via-fuchsia-50 to-indigo-50", header: "from-fuchsia-500/15", label: "Visual Digest" };
  if (styleProfileId === "knowledge_atlas") return { shell: "border-emerald-200 bg-emerald-50/50 font-mono", header: "from-emerald-500/15", label: "Knowledge Atlas" };
  return { shell: "border-stone-200 bg-[#fffdf8]", header: "from-amber-500/15", label: "Editorial Story" };
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
  const locationState = location.state as { backTo?: string; backLabel?: string; initialTab?: AssetDetailTab; stageNotice?: string } | null;
  const backTo = locationState?.backTo || "/assets";
  const backLabel = locationState?.backLabel || "Back to Assets";
  const returnToPrevious = useReturnNavigation(backTo, Boolean(locationState?.backTo));
  const requestedTab = new URLSearchParams(location.search).get("tab");
  const requestedBlockId = new URLSearchParams(location.search).get("block");
  const routeTab = requestedTab && ASSET_DETAIL_TABS.includes(requestedTab as AssetDetailTab)
    ? requestedTab as AssetDetailTab
    : null;

  const setActiveTab = (tab: AssetDetailTab) => {
    const next = new URLSearchParams(location.search);
    next.set("tab", tab);
    next.delete("block");
    navigate(
      { pathname: location.pathname, search: `?${next.toString()}` },
      { replace: true, state: location.state },
    );
  };

  const openAssetBlockInEditor = (blockId: string) => {
    const next = new URLSearchParams(location.search);
    next.set("tab", "edit");
    next.set("block", blockId);
    navigate(
      { pathname: location.pathname, search: `?${next.toString()}` },
      { replace: true, state: location.state },
    );
  };

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
  const qualityAuditQuery = useQuery({
    queryKey: ["asset-quality-audit", id],
    queryFn: () => assetsApi.getQualityAudit(id),
    enabled: Boolean(id),
  });
  const assetOutlineMapsQuery = useQuery({
    queryKey: ["asset-outline-maps", id],
    queryFn: () => mindMapsApi.list({ ownerType: "asset", ownerId: id, purpose: "asset_outline", limit: 1 }),
    enabled: Boolean(id),
  });
  const assetOutlineMap = assetOutlineMapsQuery.data?.items?.[0] ?? null;
  const assetOutlineTreeQuery = useQuery({
    queryKey: ["mind-map-tree", assetOutlineMap?.id],
    queryFn: () => mindMapsApi.getTree(assetOutlineMap!.id),
    enabled: Boolean(assetOutlineMap?.id),
  });
  const assetOutlineStalenessQuery = useQuery({
    queryKey: ["asset-outline-staleness", assetOutlineMap?.id],
    queryFn: () => mindMapsApi.checkAssetOutlineStaleness(assetOutlineMap!.id),
    enabled: Boolean(assetOutlineMap?.id),
    refetchOnWindowFocus: false,
  });
  const projectAssetOutlineMutation = useMutation({
    mutationFn: () => mindMapsApi.projectAssetOutline(id),
    onSuccess: (tree) => {
      queryClient.setQueryData(["mind-map-tree", tree.map.id], tree);
      queryClient.setQueryData(["asset-outline-maps", id], { items: [tree.map], total: 1 });
    },
  });
  const [assetMapSelectedId, setAssetMapSelectedId] = useState<string | null>(null);
  const [assetMapCollapsedIds, setAssetMapCollapsedIds] = useState<Set<string>>(new Set());
  const [assetOutlineRefreshAppliedVersion, setAssetOutlineRefreshAppliedVersion] = useState<number | null>(null);
  const assetOutlineRefreshMutation = useMutation({
    mutationFn: () => mindMapsApi.buildAssetOutlineRefreshProposal(assetOutlineMap!.id),
    onSuccess: () => setAssetOutlineRefreshAppliedVersion(null),
  });
  const assetOutlineRefreshApplyMutation = useMutation({
    mutationFn: () => mindMapsApi.applyAssetOutlineRefreshProposal(
      assetOutlineMap!.id,
      {
        base_version: assetOutlineRefreshMutation.data!.base_version,
        proposal: assetOutlineRefreshMutation.data!.proposal,
        confirm: true,
      },
    ),
    onSuccess: (tree) => {
      queryClient.setQueryData(["mind-map-tree", tree.map.id], tree);
      queryClient.setQueryData(["asset-outline-maps", id], { items: [tree.map], total: 1 });
      queryClient.setQueryData(
        ["asset-outline-staleness", tree.map.id],
        (current: typeof assetOutlineStalenessQuery.data) => current ? {
          ...current,
          map: tree.map,
          stale: false,
          reasons: [],
          current_basis: tree.map.basis_revision,
        } : current,
      );
      setAssetMapSelectedId(null);
      setAssetMapCollapsedIds(new Set());
      setAssetOutlineRefreshAppliedVersion(tree.map.version);
      assetOutlineRefreshMutation.reset();
    },
  });
  const assetOutlineDocumentPatchMutation = useMutation({
    mutationFn: () => mindMapsApi.buildAssetOutlineDocumentPatch(assetOutlineMap!.id),
    onSuccess: (proposal) => {
      setAssetOutlineDocumentPatchPreview(proposal);
      setAssetOutlinePatchReviewNotice(null);
    },
  });
  const [assetOutlineDocumentPatchPreview, setAssetOutlineDocumentPatchPreview] = useState<AssetOutlineDocumentPatchProposal | null>(null);
  const [assetOutlinePatchReviewNotice, setAssetOutlinePatchReviewNotice] = useState<string | null>(null);
  const [assetOutlineEditorApplyNotice, setAssetOutlineEditorApplyNotice] = useState<string | null>(null);
  const assetMapCanvasNodes = useMemo<MindMapCanvasNode[]>(() => (
    assetOutlineTreeQuery.data?.nodes.map((node) => ({
      id: node.id,
      parentId: node.parent_id,
      label: node.content,
      displayId: node.display_id,
      kind: node.node_kind,
      referenceCount: assetOutlineTreeQuery.data.references.filter((reference) => reference.node_id === node.id).length,
    })) ?? []
  ), [assetOutlineTreeQuery.data]);
  const assetRefreshCanvasNodes = useMemo<MindMapCanvasNode[]>(() => (
    assetOutlineRefreshMutation.data?.proposal.nodes.map((node) => ({
      id: node.temp_id,
      parentId: node.parent_temp_id,
      label: node.content,
      kind: node.node_kind,
      referenceCount: (node.asset_block_id ? 1 : 0) + node.claim_refs.length,
    })) ?? []
  ), [assetOutlineRefreshMutation.data]);
  const assetOutlineRefreshChanges = useMemo<AssetOutlineRefreshChange[]>(() => {
    const tree = assetOutlineTreeQuery.data;
    const proposal = assetOutlineRefreshMutation.data?.proposal;
    if (!tree || !proposal) return [];

    const currentNodeById = new Map(tree.nodes.map((node) => [node.id, node]));
    const currentBlockByNodeId = new Map(
      tree.references
        .filter((reference) => reference.ref_type === "asset_block")
        .map((reference) => [reference.node_id, reference.ref_id]),
    );
    const currentNodeByBlockId = new Map<string, MindMapNodeRead>();
    currentBlockByNodeId.forEach((blockId, nodeId) => {
      const node = currentNodeById.get(nodeId);
      if (node) currentNodeByBlockId.set(blockId, node);
    });
    const proposedNodeByTempId = new Map(proposal.nodes.map((node) => [node.temp_id, node]));
    const proposedNodeByBlockId = new Map(
      proposal.nodes
        .filter((node) => Boolean(node.asset_block_id))
        .map((node) => [node.asset_block_id!, node]),
    );
    const currentParentIdentity = (parentId: string | null) => {
      if (parentId === null || parentId === tree.root_id) return null;
      return currentBlockByNodeId.get(parentId) ?? `node:${parentId}`;
    };
    const proposedParentIdentity = (parentTempId: string | null) => {
      if (parentTempId === null) return null;
      const parent = proposedNodeByTempId.get(parentTempId);
      if (!parent || parent.parent_temp_id === null) return null;
      return parent.asset_block_id ?? `proposal:${parentTempId}`;
    };
    const changes: AssetOutlineRefreshChange[] = [];

    proposedNodeByBlockId.forEach((proposedNode, blockId) => {
      const currentNode = currentNodeByBlockId.get(blockId);
      if (!currentNode) {
        changes.push({ operation: "add", assetBlockId: blockId, label: proposedNode.content, detail: "Add this saved Asset Block to the refreshed Map." });
        return;
      }
      if (currentNode.content !== proposedNode.content) {
        changes.push({ operation: "rename", assetBlockId: blockId, label: proposedNode.content, detail: `Rename “${currentNode.content}” to “${proposedNode.content}”.` });
      }
      if (currentParentIdentity(currentNode.parent_id) !== proposedParentIdentity(proposedNode.parent_temp_id) || currentNode.position !== proposedNode.position) {
        changes.push({ operation: "move", assetBlockId: blockId, label: proposedNode.content, detail: "Move this Block to match the current saved document order." });
      }
    });
    currentNodeByBlockId.forEach((currentNode, blockId) => {
      if (!proposedNodeByBlockId.has(blockId)) {
        changes.push({ operation: "delete", assetBlockId: blockId, label: currentNode.content, detail: "Remove this Map node because its Asset Block is no longer present." });
      }
    });
    return changes;
  }, [assetOutlineRefreshMutation.data, assetOutlineTreeQuery.data]);
  const assetOutlineRefreshChangeCounts = useMemo(() => (
    assetOutlineRefreshChanges.reduce<Record<AssetOutlineRefreshOperation, number>>(
      (counts, change) => ({ ...counts, [change.operation]: counts[change.operation] + 1 }),
      { add: 0, move: 0, rename: 0, delete: 0 },
    )
  ), [assetOutlineRefreshChanges]);

  const sourceOptionsQuery = useQuery({
    queryKey: ["asset-detail-sources"],
    queryFn: () => sourcesApi.list({ limit: 100 }),
  });

  const noteOptionsQuery = useQuery({
    queryKey: ["asset-detail-notes"],
    queryFn: () => notesApi.list({ limit: 100 }),
  });

  const asset = assetQuery.data;
  const resolvedActiveTab = routeTab
    ?? locationState?.initialTab
    ?? (asset?.draft_content?.trim() ? "read" : workspaceQuery.data?.intent ? "intent" : "read");
  const { scrollRef, onScroll } = useRouteScrollRestoration<HTMLDivElement>(
    `asset-detail:${id || "unknown"}`,
    Boolean(asset),
  );
  const optimizationMetadata = useMemo(() => readAssetOptimizationMetadata(asset?.metadata_), [asset?.metadata_]);
  const nextOptimizationRound = optimizationMetadata.completed_rounds + 1;
  const publishingSettingsQuery = useQuery({ queryKey: ["publishing-settings"], queryFn: () => authApi.getMyPublishingSettings() });
  const publishingSettings = publishingSettingsQuery.data ?? { primary_site_url: "", default_channel: "" };
  const readerPresentation = assetReaderPresentation(asset?.asset_type);
  const resolvedStyleProfileId = asset?.style_profile_id ?? defaultAssetStyleProfile(asset?.asset_type ?? "blog_post");
  const wechatDraftReceipt = asset?.metadata_?.wechat_draft && typeof asset.metadata_.wechat_draft === "object"
    ? asset.metadata_.wechat_draft as Record<string, unknown>
    : null;
  const stylePresentation = assetStylePresentation(resolvedStyleProfileId);
  const assetQueryError = assetQuery.error instanceof Error ? assetQuery.error.message : null;

  const [publishUrl, setPublishUrl] = useState("");
  const [publishChannel, setPublishChannel] = useState("");
  const [publishFeedback, setPublishFeedback] = useState("");
  const [deliveryFormat, setDeliveryFormat] = useState<"markdown" | "html">("markdown");
  const [selectedStyleProfileId, setSelectedStyleProfileId] = useState<AssetStyleProfileId>("editorial_story");
  const [htmlPreview, setHtmlPreview] = useState("");
  const [htmlPreviewOpen, setHtmlPreviewOpen] = useState(false);
  const [htmlCopied, setHtmlCopied] = useState(false);
  const [htmlPreviewTitle, setHtmlPreviewTitle] = useState("HTML Preview");
  const [htmlPreviewDescription, setHtmlPreviewDescription] = useState("Sandboxed preview generated from the current Markdown Asset.");
  const [editTitle, setEditTitle] = useState("");
  const [editBrief, setEditBrief] = useState("");
  const [editOutline, setEditOutline] = useState("");
  const [editBlocks, setEditBlocks] = useState<AssetBlock[]>([]);
  const [editStyle, setEditStyle] = useState("");
  const [editorSelection, setEditorSelection] = useState<AssetEditorSelection | null>(null);
  const [selectionInstruction, setSelectionInstruction] = useState("");
  const documentEditorRef = useRef<HTMLTextAreaElement | null>(null);
  const [editorScrollTop, setEditorScrollTop] = useState(0);
  const [editorHighlight, setEditorHighlight] = useState<{ blockId: string; start: number; end: number } | null>(null);
  const editorHighlightMarkRef = useRef<HTMLElement | null>(null);
  const consumedBlockRequestRef = useRef<string | null>(null);
  const [previewBlockIds, setPreviewBlockIds] = useState<Set<string>>(() => new Set());
  const [blockRevision, setBlockRevision] = useState<BlockRevisionState | null>(null);
  const blockRevisionAbortRef = useRef<AbortController | null>(null);
  const [documentRevision, setDocumentRevision] = useState<DocumentRevisionState>({ instruction: "", streaming: false, status: "" });
  const [pendingOptimizationRound, setPendingOptimizationRound] = useState<PendingOptimizationRound | null>(null);
  const [baseEditorSignature, setBaseEditorSignature] = useState("");
  const [recoveryCandidate, setRecoveryCandidate] = useState<AssetEditorRecovery | null>(null);
  const hydratedAssetIdRef = useRef("");
  const baseEditorSignatureRef = useRef("");
  const editorSignatureRef = useRef("");
  const editorSnapshotRef = useRef<AssetEditorSnapshot | null>(null);
  const allowNextHistoryPopRef = useRef(false);
  const documentRevisionAbortRef = useRef<AbortController | null>(null);
  const [evidenceAgent, setEvidenceAgent] = useState<EvidenceAgentState>({ instruction: "", streaming: false, status: "" });
  const [forkOpen, setForkOpen] = useState(false);
  const [forkTitle, setForkTitle] = useState("");
  const [forkBrief, setForkBrief] = useState("");
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
    setSelectedStyleProfileId(resolvedStyleProfileId);
  }, [asset?.id, resolvedStyleProfileId]);

  const serverEditorSnapshot = useMemo<AssetEditorSnapshot | null>(() => asset ? ({
    title: asset.title,
    brief: asset.brief ?? "",
    outline: asset.outline ?? "",
    style: asset.style_notes ?? "",
    blocks: loadAssetBlocks(asset.metadata_, asset.draft_content),
    pendingOptimizationRound: null,
  }) : null, [asset]);
  const serverEditorSignature = useMemo(
    () => serverEditorSnapshot ? assetEditorSignature(serverEditorSnapshot) : "",
    [serverEditorSnapshot],
  );
  const needsStableBlocks = Boolean(
    asset
    && serverEditorSnapshot?.blocks.length
    && !hasStableAssetDocument(asset.metadata_),
  );
  const editDocumentMarkdown = useMemo(() => serializeAssetBlocks(editBlocks), [editBlocks]);
  useEffect(() => {
    if (!requestedBlockId) {
      consumedBlockRequestRef.current = null;
      return;
    }
    if (resolvedActiveTab !== "edit" || consumedBlockRequestRef.current === requestedBlockId) return;
    const range = locateAssetBlockRange(editBlocks, requestedBlockId);
    if (!range) return;
    consumedBlockRequestRef.current = requestedBlockId;
    setEditorHighlight({ blockId: requestedBlockId, start: range.start, end: range.end });
  }, [editBlocks, editDocumentMarkdown, requestedBlockId, resolvedActiveTab]);
  useEffect(() => {
    if (!editorHighlight) return;
    const frame = window.requestAnimationFrame(() => {
      const editor = documentEditorRef.current;
      const mark = editorHighlightMarkRef.current;
      if (!editor || !mark) return;

      const markTop = mark.offsetTop;
      const maxEditorScroll = Math.max(0, editor.scrollHeight - editor.clientHeight);
      const nextEditorScroll = Math.min(
        maxEditorScroll,
        Math.max(0, markTop - editor.clientHeight / 3),
      );
      editor.scrollTop = nextEditorScroll;
      setEditorScrollTop(nextEditorScroll);

      const container = scrollRef.current;
      if (container) {
        const editorRect = editor.getBoundingClientRect();
        const containerRect = container.getBoundingClientRect();
        const targetTop = container.scrollTop
          + editorRect.top
          - containerRect.top
          + markTop
          - nextEditorScroll;
        container.scrollTo({
          top: Math.max(0, targetTop - container.clientHeight / 3),
          behavior: "smooth",
        });
      } else {
        editor.scrollIntoView({ behavior: "smooth", block: "center" });
      }

      editor.focus({ preventScroll: true });
      editor.setSelectionRange(editorHighlight.start, editorHighlight.start);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [editorHighlight, scrollRef]);
  useEffect(() => {
    if (!editorHighlight) return;
    const timer = window.setTimeout(() => setEditorHighlight(null), 5000);
    return () => window.clearTimeout(timer);
  }, [editorHighlight]);
  const editorSnapshot = useMemo<AssetEditorSnapshot>(() => ({
    title: editTitle,
    brief: editBrief,
    outline: editOutline,
    style: editStyle,
    blocks: editBlocks,
    pendingOptimizationRound,
  }), [editTitle, editBrief, editOutline, editStyle, editBlocks, pendingOptimizationRound]);
  const editorSignature = useMemo(() => assetEditorSignature(editorSnapshot), [editorSnapshot]);
  const isEditorDirty = Boolean(asset && baseEditorSignature && editorSignature !== baseEditorSignature);
  const assetOutlineDocumentPatchApplyMutation = useMutation({
    mutationFn: async () => {
      const preview = assetOutlineDocumentPatchPreview;
      if (!preview?.patch || !asset || !assetOutlineTreeQuery.data || !workspaceQuery.data) {
        throw new Error("Generate and review a current Asset Document Patch before applying it.");
      }
      if (isEditorDirty) {
        throw new Error("Save or discard the current Editor changes before applying a Map Patch.");
      }
      const latest = await mindMapsApi.buildAssetOutlineDocumentPatch(preview.map_id);
      if (JSON.stringify(latest) !== JSON.stringify(preview)) {
        return { status: "review" as const, proposal: latest };
      }
      if (!latest.patch) {
        return { status: "review" as const, proposal: latest };
      }
      if (latest.base_map_version !== assetOutlineTreeQuery.data.map.version) {
        throw new Error(`Mind Map changed from version ${latest.base_map_version} to ${assetOutlineTreeQuery.data.map.version}.`);
      }
      const workspaceRevision = latest.basis_revision.workspace_revision;
      if (workspaceRevision !== workspaceQuery.data.workspace_revision) {
        throw new Error(`Asset Workspace changed from revision ${String(workspaceRevision)} to ${workspaceQuery.data.workspace_revision}.`);
      }
      const document = asset.metadata_?.asset_document;
      const documentRevision = document && typeof document === "object" && typeof (document as Record<string, unknown>).revision === "number"
        ? (document as Record<string, unknown>).revision
        : 0;
      if (latest.basis_revision.asset_document_revision !== documentRevision) {
        throw new Error(`Asset Document changed from revision ${String(latest.basis_revision.asset_document_revision)} to ${documentRevision}.`);
      }
      if (latest.basis_revision.base_document_signature !== assetDocumentSignature(editBlocks)) {
        throw new Error("The local Editor Blocks no longer match the Document basis used by this Patch.");
      }
      return {
        status: "applied" as const,
        blocks: applyAssetOutlineOperations(editBlocks, latest.patch.operations),
        operationCount: latest.patch.operations.length,
      };
    },
    onSuccess: (result) => {
      if (result.status === "review") {
        setAssetOutlineDocumentPatchPreview(result.proposal);
        setAssetOutlinePatchReviewNotice("The Map or Asset changed during confirmation. Review the refreshed Patch before applying it.");
        return;
      }
      setEditBlocks(result.blocks);
      setAssetOutlineDocumentPatchPreview(null);
      setAssetOutlinePatchReviewNotice(null);
      setAssetOutlineEditorApplyNotice(`${result.operationCount} Map Patch operation${result.operationCount === 1 ? "" : "s"} applied to the local Editor. Save Changes is still required.`);
      setActiveTab("edit");
    },
  });

  baseEditorSignatureRef.current = baseEditorSignature;
  editorSignatureRef.current = editorSignature;
  editorSnapshotRef.current = editorSnapshot;

  const persistEditorRecovery = useCallback(() => {
    if (!asset || !editorSnapshotRef.current || editorSignatureRef.current === baseEditorSignatureRef.current) return;
    writeAssetEditorRecovery(
      asset.id,
      workspaceQuery.data?.workspace_revision ?? 0,
      baseEditorSignatureRef.current,
      editorSnapshotRef.current,
    );
  }, [asset, workspaceQuery.data?.workspace_revision]);

  const loadEditorSnapshot = useCallback((snapshot: AssetEditorSnapshot) => {
    setEditTitle(snapshot.title);
    setEditBrief(snapshot.brief);
    setEditOutline(snapshot.outline);
    setEditBlocks(snapshot.blocks);
    setEditStyle(snapshot.style);
    setPendingOptimizationRound(snapshot.pendingOptimizationRound);
    setEditorSelection(null);
    setSelectionInstruction("");
    setPreviewBlockIds(new Set());
    blockRevisionAbortRef.current?.abort();
    blockRevisionAbortRef.current = null;
    setBlockRevision(null);
    documentRevisionAbortRef.current?.abort();
    documentRevisionAbortRef.current = null;
    setDocumentRevision({ instruction: "", streaming: false, status: "" });
  }, []);

  useEffect(() => {
    if (!asset || !serverEditorSnapshot || !serverEditorSignature) return;
    const assetChanged = hydratedAssetIdRef.current !== asset.id;
    if (assetChanged) {
      hydratedAssetIdRef.current = asset.id;
      loadEditorSnapshot(serverEditorSnapshot);
      baseEditorSignatureRef.current = serverEditorSignature;
      setBaseEditorSignature(serverEditorSignature);
      const recovery = readAssetEditorRecovery(asset.id);
      if (recovery && assetEditorSignature(recovery.snapshot) !== serverEditorSignature) {
        setRecoveryCandidate(recovery);
      } else {
        clearAssetEditorRecovery(asset.id);
        setRecoveryCandidate(null);
      }
      return;
    }
    if (serverEditorSignature === baseEditorSignatureRef.current) return;
    if (editorSignatureRef.current !== baseEditorSignatureRef.current) return;
    loadEditorSnapshot(serverEditorSnapshot);
    baseEditorSignatureRef.current = serverEditorSignature;
    setBaseEditorSignature(serverEditorSignature);
  }, [asset, loadEditorSnapshot, serverEditorSignature, serverEditorSnapshot]);

  useEffect(() => {
    if (!asset || !isEditorDirty || recoveryCandidate) return;
    const timeout = window.setTimeout(persistEditorRecovery, 250);
    return () => window.clearTimeout(timeout);
  }, [asset, editorSnapshot, isEditorDirty, persistEditorRecovery, recoveryCandidate]);

  useEffect(() => {
    if (!isEditorDirty) return;
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      persistEditorRecovery();
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [isEditorDirty, persistEditorRecovery]);

  useEffect(() => {
    if (!isEditorDirty) return;
    const handleHistoryPop = () => {
      if (allowNextHistoryPopRef.current) {
        allowNextHistoryPopRef.current = false;
        return;
      }
      persistEditorRecovery();
      if (!window.confirm("Leave this Asset with unsaved changes? Your recovery draft will remain available in this browser tab.")) {
        allowNextHistoryPopRef.current = true;
        window.history.go(1);
      }
    };
    window.addEventListener("popstate", handleHistoryPop);
    return () => window.removeEventListener("popstate", handleHistoryPop);
  }, [isEditorDirty, persistEditorRecovery]);

  useEffect(() => {
    if (!isEditorDirty) return;
    const handleDocumentClick = (event: MouseEvent) => {
      const target = event.target instanceof Element ? event.target.closest("a[href]") : null;
      if (!(target instanceof HTMLAnchorElement) || target.target === "_blank" || event.defaultPrevented) return;
      const destination = new URL(target.href, window.location.href);
      const current = new URL(window.location.href);
      if (destination.origin !== current.origin || (destination.pathname === current.pathname && destination.search === current.search)) return;
      persistEditorRecovery();
      if (!window.confirm("Leave this Asset with unsaved changes? Your recovery draft will remain available in this browser tab.")) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    document.addEventListener("click", handleDocumentClick, true);
    return () => document.removeEventListener("click", handleDocumentClick, true);
  }, [isEditorDirty, persistEditorRecovery]);

  const confirmEditorNavigation = useCallback(() => {
    if (!isEditorDirty) return true;
    persistEditorRecovery();
    return window.confirm("Leave this Asset with unsaved changes? Your recovery draft will remain available in this browser tab.");
  }, [isEditorDirty, persistEditorRecovery]);

  const returnFromAsset = useCallback(() => {
    if (!confirmEditorNavigation()) return;
    allowNextHistoryPopRef.current = true;
    window.setTimeout(() => {
      allowNextHistoryPopRef.current = false;
    }, 500);
    returnToPrevious();
  }, [confirmEditorNavigation, returnToPrevious]);

  const restoreRecoveryDraft = () => {
    if (!recoveryCandidate || !serverEditorSignature) return;
    loadEditorSnapshot(recoveryCandidate.snapshot);
    baseEditorSignatureRef.current = serverEditorSignature;
    setBaseEditorSignature(serverEditorSignature);
    setRecoveryCandidate(null);
  };

  const discardRecoveryDraft = () => {
    if (!asset || !serverEditorSnapshot || !serverEditorSignature) return;
    clearAssetEditorRecovery(asset.id);
    loadEditorSnapshot(serverEditorSnapshot);
    baseEditorSignatureRef.current = serverEditorSignature;
    setBaseEditorSignature(serverEditorSignature);
    setRecoveryCandidate(null);
  };

  useEffect(() => {
    setContributionEdit(workspaceQuery.data?.contribution?.summary ?? "");
  }, [workspaceQuery.data?.contribution?.id, workspaceQuery.data?.contribution?.summary]);

  const workflowStage = useMemo(() => {
    const workspace = workspaceQuery.data;
    const intentRevision = workspace?.intent?.revision;
    const currentEvidence = workspace?.evidence.filter((item) => item.intent_revision === intentRevision) ?? [];
    const currentClaims = workspace?.claims.filter((item) => item.intent_revision === intentRevision) ?? [];
    const acceptedEvidence = currentEvidence.filter((item) => item.status === "accepted");
    const pendingEvidence = currentEvidence.filter((item) => item.status === "proposed");
    const acceptedClaims = currentClaims.filter((item) => item.status === "accepted" || item.status === "hypothesis");
    const pendingClaims = currentClaims.filter((item) => item.status === "proposed");
    return {
      currentEvidence,
      currentClaims,
      acceptedEvidence,
      pendingEvidence,
      acceptedClaims,
      pendingClaims,
      evidenceReady: acceptedEvidence.length > 0 && pendingEvidence.length === 0,
      claimsReady: acceptedClaims.length > 0 && pendingClaims.length === 0,
    };
  }, [workspaceQuery.data]);

  const documentOptimizationGate = useMemo(() => {
    const workspace = workspaceQuery.data;
    const reasons: string[] = [];
    if (!workspace?.intent) reasons.push("Confirm Intent");
    const intentRevision = workspace?.intent?.revision;
    const currentEvidence = workspace?.evidence.filter((item) => item.intent_revision === intentRevision) ?? [];
    const currentClaims = workspace?.claims.filter((item) => item.intent_revision === intentRevision) ?? [];
    if (!currentEvidence.some((item) => item.status === "accepted")) reasons.push("Accept current Evidence");
    if (currentEvidence.some((item) => item.status === "proposed")) reasons.push("Resolve proposed Evidence");
    if (!currentClaims.some((item) => item.status === "accepted" || item.status === "hypothesis")) reasons.push("Accept a current Claim or Hypothesis");
    if (currentClaims.some((item) => item.status === "proposed")) reasons.push("Resolve proposed Claims");
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
    await queryClient.invalidateQueries({ queryKey: ["asset-quality-audit", id] });
  };

  const statusMutation = useMutation({
    mutationFn: (status: AssetStatus) => assetsApi.update(id, { status }),
    onSuccess: refreshAsset,
  });

  const attachReferencesMutation = useMutation({
    mutationFn: () => assetsApi.attachReferences(id),
    onSuccess: refreshAsset,
  });

  const saveEvidenceProposalMutation = useMutation({
    mutationFn: async () => {
      const proposal = evidenceAgent.proposal;
      if (!proposal) throw new Error("No Evidence proposal is ready.");
      let workspace = await assetsApi.getWorkspace(id);
      if (workspace.intent?.revision !== proposal.intentRevision) {
        throw new Error("The Intent changed while Evidence was being collected. Investigate again using the current Intent.");
      }
      const existingKeys = new Set(workspace.evidence.map((item) => JSON.stringify([
        item.intent_revision,
        item.target_type,
        item.target_id,
        item.relation,
        item.summary.trim(),
      ])));
      const proposals: AssetEvidenceProposalInput[] = proposal.proposals.map((item) => ({
        target_type: item.targetType,
        target_id: item.targetId,
        relation: item.relation,
        summary: item.summary,
        fragment_selector: item.fragmentSelector,
      })).filter((item) => !existingKeys.has(JSON.stringify([
        proposal.intentRevision,
        item.target_type,
        item.target_id,
        item.relation,
        item.summary.trim(),
      ])));
      if (proposals.length === 0) return { workspace, savedCount: 0 };

      const saveAtRevision = (baseWorkspaceRevision: number) => assetsApi.proposeEvidence(id, {
        base_workspace_revision: baseWorkspaceRevision,
        session_id: evidenceAgent.sessionId,
        proposals,
      });
      try {
        workspace = await saveAtRevision(workspace.workspace_revision);
      } catch (error) {
        if (!(error instanceof Error) || !error.message.startsWith("409:")) throw error;
        const latestWorkspace = await assetsApi.getWorkspace(id);
        if (latestWorkspace.intent?.revision !== proposal.intentRevision) {
          throw new Error("The Intent changed while Evidence was being saved. Investigate again using the current Intent.");
        }
        workspace = await saveAtRevision(latestWorkspace.workspace_revision);
      }
      return { workspace, savedCount: proposals.length };
    },
    onSuccess: async ({ savedCount }) => {
      setEvidenceAgent((current) => ({
        ...current,
        proposal: undefined,
        error: undefined,
        status: savedCount > 0 ? `${savedCount} Evidence candidates saved for review.` : "No new Evidence candidates were found; matching candidates already exist in this Workspace.",
      }));
      await refreshAsset();
    },
    onError: (error) => {
      setEvidenceAgent((current) => ({ ...current, error: error instanceof Error ? error.message : "Could not save Evidence candidates." }));
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
    onSuccess: async (workspace, variables) => {
      queryClient.setQueryData(["asset-workspace", id], workspace);
      if (variables.decision === "need_more_evidence") {
        const request = [...(workspace.missing_evidence_requests ?? [])]
          .reverse()
          .find((item) => item.claim_id === variables.claimId && item.status === "open");
        if (request) {
          setEvidenceAgent((current) => ({
            ...current,
            instruction: request.question,
            sessionId: request.source_session_id ?? current.sessionId,
            proposal: undefined,
            error: undefined,
            status: request.source_session_id
              ? "Missing Evidence Request created. The original Evidence Agent session and Intent Scope are ready to resume."
              : "Missing Evidence Request created. The next investigation will start within the original Intent Scope.",
          }));
          setActiveTab("evidence");
        }
      }
      await refreshAsset();
    },
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
    mutationFn: () => {
      const completedAt = new Date().toISOString();
      const optimization = pendingOptimizationRound
        ? {
            schema_version: 1 as const,
            completed_rounds: Math.max(optimizationMetadata.completed_rounds, pendingOptimizationRound.round),
            last_completed_at: completedAt,
            history: [
              ...optimizationMetadata.history.filter((item) => item.round !== pendingOptimizationRound.round),
              {
                round: pendingOptimizationRound.round,
                completed_at: completedAt,
                workspace_revision: pendingOptimizationRound.workspaceRevision,
                instruction: pendingOptimizationRound.instruction,
                audit_verdict: pendingOptimizationRound.auditVerdict,
                audit_score: pendingOptimizationRound.auditScore,
                finding_ids: pendingOptimizationRound.findingIds,
              },
            ].sort((left, right) => left.round - right.round).slice(-10),
          }
        : null;
      return assetsApi.update(id, {
        title: editTitle.trim(),
        brief: editBrief,
        outline: editOutline,
        draft_content: serializeAssetBlocks(editBlocks),
        style_notes: editStyle,
        metadata: {
          ...(asset?.metadata_ ?? {}),
          asset_document: createAssetDocument(editBlocks),
          ...(optimization ? { asset_optimization_v1: optimization } : {}),
        },
      });
    },
    onSuccess: async () => {
      const savedOptimizationRound = pendingOptimizationRound?.round;
      const savedEditorSignature = editorSnapshotRef.current
        ? assetEditorSignature(editorSnapshotRef.current)
        : editorSignature;
      baseEditorSignatureRef.current = savedEditorSignature;
      setBaseEditorSignature(savedEditorSignature);
      clearAssetEditorRecovery(id);
      setRecoveryCandidate(null);
      setPendingOptimizationRound(null);
      setAssetOutlineEditorApplyNotice(null);
      setDocumentRevision({
        instruction: "",
        streaming: false,
        status: savedOptimizationRound ? `Optimization round ${savedOptimizationRound} saved.` : "",
      });
      await refreshAsset();
    },
  });

  const toggleBlockClaim = (blockId: string, claimId: string) => {
    setEditBlocks((blocks) => blocks.map((block) => {
      if (block.id !== blockId) return block;
      const claimRefs = block.claimRefs.includes(claimId)
        ? block.claimRefs.filter((item) => item !== claimId)
        : [...block.claimRefs, claimId];
      return updateAssetBlockClaimRefs(block, claimRefs);
    }));
  };

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
  };

  const toggleBlockPreview = (blockId: string) => {
    setPreviewBlockIds((current) => {
      const next = new Set(current);
      if (next.has(blockId)) next.delete(blockId);
      else next.add(blockId);
      return next;
    });
  };

  const openBlockRevision = (block: AssetBlock, instruction = "") => {
    blockRevisionAbortRef.current?.abort();
    blockRevisionAbortRef.current = null;
    setBlockRevision({
      blockId: block.id,
      baseRevision: block.revision,
      originalMarkdown: block.markdown,
      instruction,
      streaming: false,
      agentStatus: "",
    });
  };

  const discardBlockRevision = () => {
    blockRevisionAbortRef.current?.abort();
    blockRevisionAbortRef.current = null;
    setBlockRevision(null);
  };

  const changeDocumentMarkdown = (markdown: string) => {
    setEditorHighlight(null);
    setEditBlocks((blocks) => reconcileAssetBlocks(blocks, markdown));
    setEditorSelection(null);
  };

  const captureDocumentSelection = () => {
    const editor = documentEditorRef.current;
    if (!editor || editor.selectionStart === editor.selectionEnd) {
      setEditorSelection(null);
      return;
    }
    const selection = locateAssetBlockSelection(
      editBlocks,
      editor.selectionStart,
      editor.selectionEnd,
    );
    setEditorSelection(selection ? { blockId: selection.block.id, text: selection.selectedText } : null);
  };

  const openSelectionRevision = (preset?: string) => {
    if (!editorSelection) return;
    const block = editBlocks.find((item) => item.id === editorSelection.blockId);
    if (!block) return;
    const instruction = selectionInstruction.trim() || preset || "Improve clarity and flow";
    openBlockRevision(
      block,
      `${instruction}. Only revise the selected excerpt while preserving the surrounding paragraph and its supported claims. Selected excerpt: ${JSON.stringify(editorSelection.text)}`,
    );
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
          ephemeralSession: true,
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
            setBlockRevision((current) => current ? { ...current, agentStatus: "Agent 正在生成候选修改…", diagnostic: `Tool: ${event.tool || "unknown"}` } : current);
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
    setEditorSelection(null);
    setSelectionInstruction("");
    setBlockRevision(null);
  };

  const startDocumentRevision = async () => {
    const workspace = workspaceQuery.data;
    if (!asset || !workspace || documentRevision.streaming) return;
    if (pendingOptimizationRound) {
      setDocumentRevision((current) => ({ ...current, error: `Save optimization round ${pendingOptimizationRound.round} before starting another round.` }));
      return;
    }
    if (!documentOptimizationGate.ready) {
      setDocumentRevision((current) => ({ ...current, error: `Complete the workflow first: ${documentOptimizationGate.reasons.join("; ")}.` }));
      return;
    }
    if (editBlocks.length === 0) {
      setDocumentRevision((current) => ({ ...current, error: "Add draft content before optimizing the complete Asset." }));
      return;
    }
    const requestedInstruction = documentRevision.instruction.trim() || (nextOptimizationRound === 1
      ? "Optimize the complete Asset for clarity, coherence, evidence-grounded claims, transitions, and a stronger conclusion."
      : `Perform optimization round ${nextOptimizationRound}. Preserve accepted improvements from prior rounds, address the current quality-audit findings, tighten the complete argument, and make only evidence-grounded changes.`);
    const audit = qualityAuditQuery.data;
    const auditFindings = audit ? [...audit.blocking_findings, ...audit.warnings] : [];
    const request = {
      assetId: asset.id,
      baseWorkspaceRevision: workspace.workspace_revision,
      optimizationRound: nextOptimizationRound,
      instruction: requestedInstruction,
      qualityAudit: audit ? {
        workspaceRevision: audit.workspace_revision,
        verdict: audit.verdict,
        score: audit.score,
        findings: auditFindings.map((finding) => ({ id: finding.id, severity: finding.severity, title: finding.title, detail: finding.detail })),
        metrics: audit.metrics,
      } : null,
      previousOptimization: optimizationMetadata.history[optimizationMetadata.history.length - 1] ?? null,
      rewriteMode: "replace_document",
      baseDocumentSignature: assetDocumentSignature(editBlocks),
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
    const startedAt = Date.now();
    let timedOut = false;
    let documentPatchSeen = false;
    let documentPatchAccepted = false;
    let completedDocumentProposal: AssetDocumentPatch | undefined;
    let documentRunFailed = false;
    let documentPatchIssue = "Agent returned an invalid document patch contract.";
    const captureDocumentPatch = (value: unknown) => {
      documentPatchSeen = true;
      const proposal = parseAssetDocumentPatch(value);
      const revisionIssue = !proposal
        ? "Agent returned an invalid document patch contract."
        : proposal.rewriteMode !== "replace_document"
          ? "Agent returned a partial Block patch instead of a complete rewritten document."
          : documentPatchRevisionIssue(proposal, asset.id, workspace.workspace_revision, editBlocks);
      if (proposal && !revisionIssue) {
        documentPatchAccepted = true;
        completedDocumentProposal = proposal;
        setDocumentRevision((current) => ({
          ...current,
          proposal: undefined,
          error: undefined,
          status: "Agent returned the rewritten document. Waiting for the run to finish…",
        }));
        return;
      }
      documentPatchIssue = revisionIssue || "The complete Asset proposal is invalid.";
      setDocumentRevision((current) => ({ ...current, proposal: undefined, error: documentPatchIssue }));
    };
    documentRevisionAbortRef.current?.abort();
    documentRevisionAbortRef.current = abortController;
    setDocumentRevision((current) => ({
      ...current,
      streaming: true,
      round: nextOptimizationRound,
      requestedInstruction,
      status: "Agent is reviewing the complete argument and knowledge trace…",
      pendingQuestion: undefined,
      proposal: undefined,
      error: undefined,
    }));
    const progressInterval = window.setInterval(() => {
      const elapsedSeconds = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
      setDocumentRevision((current) => {
        if (!current.streaming || current.pendingQuestion || current.proposal || current.error) return current;
        return {
          ...current,
          status: `Agent is rewriting the complete document from ${editBlocks.length} source blocks · ${elapsedSeconds}s elapsed.`,
        };
      });
    }, 10_000);
    const timeout = window.setTimeout(() => {
      timedOut = true;
      abortController.abort();
      setDocumentRevision((current) => ({
        ...current,
        error: `Full-document rewrite stopped after 5 minutes while reviewing ${editBlocks.length} source blocks. Retry with a more specific focus or a shorter source draft.`,
      }));
    }, DOCUMENT_OPTIMIZATION_TIMEOUT_MS);
    try {
      for await (const event of harnessChat(
        `请按 revise-asset-document 工作流处理以下 JSON 合同：\n\n${JSON.stringify(request, null, 2)}`,
        {
          preset: "revise-asset-document",
          createSession: true,
          ephemeralSession: true,
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
            documentPatchSeen = true;
            setDocumentRevision((current) => ({ ...current, proposal: undefined, status: "Agent is submitting the rewritten document for validation…" }));
          } else {
            setDocumentRevision((current) => ({ ...current, status: "Agent is rewriting and validating the complete document…", diagnostic: `Tool: ${event.tool || "unknown"}` }));
          }
        } else if (event.type === "tool_result") {
          if (event.tool === "propose_asset_document_patch") {
            captureDocumentPatch(event.result);
          } else if (event.tool === "skill") {
            setDocumentRevision((current) => ({ ...current, status: `Optimization instructions loaded. Agent is rewriting the complete document from ${editBlocks.length} source blocks…` }));
          }
        } else if (event.type === "question" && event.rpc_id && event.session_id && event.questions?.length) {
          setDocumentRevision((current) => ({
            ...current,
            pendingQuestion: { rpcId: event.rpc_id!, sessionId: event.session_id!, questions: event.questions! },
            status: "Agent needs clarification before optimizing the complete Asset.",
          }));
        } else if (event.type === "error") {
          documentRunFailed = true;
          completedDocumentProposal = undefined;
          setDocumentRevision((current) => ({ ...current, error: event.content || "Complete Asset optimization failed." }));
        } else if (event.type === "done") {
          if (!documentRunFailed && documentPatchAccepted && completedDocumentProposal) {
            const proposal = completedDocumentProposal;
            setDocumentRevision((current) => ({
              ...current,
              proposal,
              error: undefined,
              status: proposal.explanation || "Agent produced a complete Asset proposal. Review the Diff before applying it.",
            }));
          } else if (!documentRunFailed) {
            setDocumentRevision((current) => ({
              ...current,
              proposal: undefined,
              error: documentPatchSeen ? documentPatchIssue : "Agent finished without returning a complete rewritten document.",
            }));
          }
        }
      }
    } catch (error) {
      if (!abortController.signal.aborted && !timedOut) {
        setDocumentRevision((current) => ({ ...current, error: error instanceof Error ? error.message : "Complete Asset optimization failed." }));
      }
    } finally {
      window.clearInterval(progressInterval);
      window.clearTimeout(timeout);
      if (documentRevisionAbortRef.current === abortController) documentRevisionAbortRef.current = null;
      setDocumentRevision((current) => ({ ...current, streaming: false }));
    }
  };

  const stopDocumentRevision = () => {
    const controller = documentRevisionAbortRef.current;
    if (!controller) return;
    controller.abort();
    setDocumentRevision((current) => ({ ...current, streaming: false, error: "Optimization stopped. You can retry with a narrower focus." }));
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
    const proposedClaimRefs = proposal.rewriteMode === "replace_document"
      ? (proposal.replacementBlocks ?? []).flatMap((block) => block.claimRefs)
      : proposal.blocks.flatMap((block) => block.claimRefs);
    if (proposedClaimRefs.some((claimId) => !allowedClaims.has(claimId))) {
      setDocumentRevision((current) => ({ ...current, error: "The proposal references a Claim that is not accepted or retained as a Hypothesis." }));
      return;
    }
    setEditTitle(proposal.replacementTitle);
    setEditBrief(proposal.replacementBrief);
    if (proposal.rewriteMode === "replace_document") {
      setEditBlocks((proposal.replacementBlocks ?? []).map((block) => ({ ...createAssetBlock(block.markdown), claimRefs: block.claimRefs })));
    } else {
    const proposedBlocks = new Map(proposal.blocks.map((block) => [block.blockId, block]));
    setEditBlocks((blocks) => blocks.map((block) => {
      const proposedBlock = proposedBlocks.get(block.id);
      if (!proposedBlock) return block;
      return { ...updateAssetBlock(block, proposedBlock.replacementMarkdown), claimRefs: proposedBlock.claimRefs };
    }));
    }
    const audit = qualityAuditQuery.data;
    setPendingOptimizationRound({
      round: documentRevision.round ?? nextOptimizationRound,
      workspaceRevision: proposal.baseWorkspaceRevision,
      instruction: documentRevision.requestedInstruction || documentRevision.instruction.trim() || "Optimize the complete Asset.",
      auditVerdict: audit?.verdict,
      auditScore: audit?.score,
      findingIds: audit ? [...audit.blocking_findings, ...audit.warnings].map((finding) => finding.id) : [],
    });
    setDocumentRevision((current) => ({ ...current, proposal: undefined, status: `Optimization round ${current.round ?? nextOptimizationRound} applied to the editor. Review the Blocks, then save explicitly.` }));
  };

  const startEvidenceResearch = async (requestOverride?: Pick<AssetMissingEvidenceRequest, "question" | "source_session_id">) => {
    const workspace = workspaceQuery.data;
    const intent = workspace?.intent;
    if (!asset || !workspace || !intent || evidenceAgent.streaming || evidenceDecisionMutation.isPending || saveEvidenceProposalMutation.isPending) return;
    const instruction = requestOverride?.question ?? (evidenceAgent.instruction.trim() || "Find the strongest missing evidence and any credible contradiction for this Intent.");
    const latestEvidenceSessionId = [...workspace.evidence]
      .reverse()
      .find((item) => item.intent_revision === intent.revision && item.source_session_id)
      ?.source_session_id;
    const resumeSessionId = requestOverride?.source_session_id ?? evidenceAgent.sessionId ?? latestEvidenceSessionId;
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
      instruction,
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
      instruction,
      sessionId: resumeSessionId ?? current.sessionId,
      streaming: true,
      status: resumeSessionId ? "Agent is resuming the original Evidence session within the confirmed Intent Scope…" : "Agent is searching within the confirmed Intent…",
      pendingQuestion: undefined,
      proposal: undefined,
      error: undefined,
    }));
    try {
      for await (const event of harnessChat(
        `请按 collect-asset-evidence 工作流处理以下 JSON 合同：\n\n${JSON.stringify(request, null, 2)}`,
        {
          preset: "collect-asset-evidence",
          sessionId: resumeSessionId ?? undefined,
          createSession: !resumeSessionId,
          ephemeralSession: false,
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
            setEvidenceAgent((current) => ({ ...current, status: "Agent is collecting and validating Evidence candidates…", diagnostic: `Tool: ${event.tool || "unknown"}` }));
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
          ephemeralSession: true,
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
            setClaimAgent((current) => ({ ...current, status: "Agent is drafting and validating Claim candidates…", diagnostic: `Tool: ${event.tool || "unknown"}` }));
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

  const startInitialDraftGeneration = () => {
    const workspace = workspaceQuery.data;
    const intent = workspace?.intent;
    if (!asset || !workspace || !intent) return;
    if (!workflowStage.evidenceReady) {
      setActiveTab("evidence");
      return;
    }
    if (!workflowStage.claimsReady) {
      setActiveTab("claims");
      return;
    }
    const creationMode = ["understand", "synthesize", "make_decision", "produce"].includes(intent.creation_mode)
      ? intent.creation_mode as "understand" | "synthesize" | "make_decision" | "produce"
      : "synthesize";
    const researchMode = asset.metadata_?.research_mode === "local_only" ? "local_only" : "local_then_web";
    const deliveryFormat = asset.metadata_?.delivery_format === "html" ? "html" : "markdown";
    const acceptedEvidence = workflowStage.acceptedEvidence.map((item) => ({
      id: item.id,
      targetType: item.target_type,
      targetId: item.target_id,
      relation: item.relation,
      summary: item.summary,
    }));
    const acceptedClaims = workflowStage.acceptedClaims.map((item) => ({
      id: item.id,
      content: item.content,
      kind: item.kind,
      status: item.status,
      supportingEvidence: item.supporting_evidence,
      contradictingEvidence: item.contradicting_evidence,
    }));
    if (!confirmEditorNavigation()) return;
    navigate("/chat", {
      state: {
        workflowId: "draft-asset",
        backTo: `${location.pathname}${location.search}`,
        backLabel: "Back to Asset",
        assetDraft: {
          assetId: asset.id,
          assetType: asset.asset_type,
          title: asset.title,
          brief: asset.brief || intent.goal,
          question: intent.question,
          goal: intent.goal,
          audience: intent.audience || "",
          creationMode,
          scope: intent.scope,
          constraints: intent.constraints,
          styleNotes: asset.style_notes || "",
          styleProfileId: resolvedStyleProfileId,
          sourceRefs: asset.source_refs,
          noteRefs: asset.note_refs,
          wikiRefs: asset.wiki_refs,
          intakeMode: "agent_assisted",
          researchMode,
          deliveryFormat,
          draftBasis: JSON.stringify({ acceptedEvidence, acceptedClaims }, null, 2),
        },
        objectRef: { object_type: "asset", object_id: asset.id, title: asset.title },
        promptSeed: [
          "The Intent, Evidence Gate, and Claim Gate are complete. Generate the initial Asset draft now.",
          "Treat only the following accepted Evidence and accepted Claims/retained Hypotheses as the structured drafting contract.",
          "Build the document around these Claims, preserve uncertainty, and do not introduce unsupported conclusions.",
        ].join("\n\n"),
      },
    });
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
          ephemeralSession: true,
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
            setKnowledgeAgent((current) => ({ ...current, status: "Agent is drafting and validating Knowledge candidates…", diagnostic: `Tool: ${event.tool || "unknown"}` }));
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
      setHtmlPreviewTitle("HTML Preview");
      setHtmlPreviewDescription("Sandboxed preview generated from the current Markdown Asset.");
      setHtmlPreviewOpen(true);
    },
  });

  const previewWechatMutation = useMutation({
    mutationFn: () => assetsApi.previewWechat(id),
    onSuccess: (result) => {
      setHtmlPreview(result.content);
      setHtmlCopied(false);
      setHtmlPreviewTitle("WeChat Draft Preview");
      setHtmlPreviewDescription("Preview of the WeChat-safe inline HTML before images are uploaded to the Official Account.");
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

  const wechatDraftMutation = useMutation({
    mutationFn: async () => {
      const diagramMarkdown = [asset?.outline, asset?.draft_content, asset?.reference_notes].filter(Boolean).join("\n\n");
      const renderedDiagrams = await renderMermaidDiagramsForWechat(diagramMarkdown);
      return assetsApi.sendToWechatDraft(id, { rendered_diagrams: renderedDiagrams });
    },
    onSuccess: refreshAsset,
  });

  const saveDeliveryFormatMutation = useMutation({
    mutationFn: () => assetsApi.update(id, {
      metadata: { ...(asset?.metadata_ ?? {}), delivery_format: deliveryFormat },
    }),
    onSuccess: refreshAsset,
  });

  const saveStyleProfileMutation = useMutation({
    mutationFn: () => assetsApi.update(id, { style_profile_id: selectedStyleProfileId }),
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

  const actionError = [statusMutation.error, exportMutation.error, exportHtmlMutation.error, wechatDraftMutation.error, previewHtmlMutation.error, previewWechatMutation.error, saveDeliveryFormatMutation.error, publishMutation.error, savePublishFeedbackMutation.error, feedbackToNoteMutation.error]
    .find((error): error is Error => error instanceof Error)?.message ?? null;

  const deleteMutation = useMutation({
    mutationFn: () => assetsApi.delete(id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["assets"] });
      navigate(backTo, { replace: true });
    },
  });

  const forkMutation = useMutation({
    mutationFn: () => assetsApi.fork(id, { title: forkTitle.trim(), brief: forkBrief.trim() || null }),
    onSuccess: (forkedAsset) => {
      queryClient.invalidateQueries({ queryKey: ["assets"] });
      setForkOpen(false);
      navigate(`/assets/${encodeURIComponent(forkedAsset.id)}?tab=intent`, {
        state: { backTo: `${location.pathname}${location.search}`, backLabel: "Back to Original Asset" },
      });
    },
  });

  const openForkDialog = () => {
    if (!asset) return;
    setForkTitle(`${asset.title} — New Question`);
    setForkBrief(asset.brief ?? "");
    forkMutation.reset();
    setForkOpen(true);
  };

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
  const isBusy = statusMutation.isPending || isExporting || wechatDraftMutation.isPending || publishMutation.isPending || savePublishFeedbackMutation.isPending || attachReferencesMutation.isPending;
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
    <div
      ref={scrollRef}
      onScroll={onScroll}
      className="h-full overflow-y-auto"
      data-route-scroll="asset-detail"
    >
      <Dialog open={Boolean(recoveryCandidate)}>
        <DialogContent className="max-w-xl" onEscapeKeyDown={(event) => event.preventDefault()} onPointerDownOutside={(event) => event.preventDefault()}>
          <DialogHeader>
            <DialogTitle>Recover unsaved Asset changes?</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              This browser tab contains an unsaved editor draft from {recoveryCandidate ? new Date(recoveryCandidate.updatedAt).toLocaleString() : "an earlier edit"}.
              {recoveryCandidate && recoveryCandidate.baseEditorSignature !== serverEditorSignature
                ? " The saved Asset changed after that draft began, so review restored content carefully before saving."
                : " Restore it to continue, or discard it and use the saved Asset."}
            </p>
            <div className="flex flex-wrap justify-end gap-2">
              <Button type="button" variant="outline" onClick={discardRecoveryDraft}>Discard Recovery</Button>
              <Button type="button" onClick={restoreRecoveryDraft}>Restore Draft</Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog open={forkOpen} onOpenChange={setForkOpen}>
        <DialogContent className="max-w-xl">
          <DialogHeader><DialogTitle>Fork New Asset</DialogTitle></DialogHeader>
          <div className="space-y-4">
            <p className="text-sm leading-6 text-muted-foreground">
              The new Asset copies Source, Note, and Wiki references plus basic delivery context. It does not copy this Asset&apos;s Workspace, Evidence decisions, Claims, draft content, or revisions.
            </p>
            <div>
              <label className="text-sm font-medium" htmlFor="fork-asset-title">New Asset title</label>
              <Input id="fork-asset-title" className="mt-1" value={forkTitle} onChange={(event) => setForkTitle(event.target.value)} />
            </div>
            <div>
              <label className="text-sm font-medium" htmlFor="fork-asset-brief">Independent question or brief</label>
              <Textarea id="fork-asset-brief" className="mt-1" rows={4} value={forkBrief} onChange={(event) => setForkBrief(event.target.value)} />
            </div>
            {forkMutation.isError && <ActionError title="Asset fork failed" impact="No new Asset was created." recovery="Review the title and references, then retry." details={forkMutation.error instanceof Error ? forkMutation.error.message : "Unknown fork error"} />}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => setForkOpen(false)}>Cancel</Button>
              <Button type="button" onClick={() => forkMutation.mutate()} disabled={!forkTitle.trim() || forkMutation.isPending}>
                {forkMutation.isPending ? "Creating…" : "Create Independent Asset"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
      <div className="mx-auto max-w-6xl space-y-6 px-6 py-8">
        <div className="flex items-center justify-between gap-4">
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={returnFromAsset} className="text-sm text-primary hover:underline">{backLabel}</button>
            {asset && <><span className="text-muted-foreground">/</span><Badge variant="outline">{assetTypeLabel(asset.asset_type)}</Badge><Badge variant="secondary">{STATUS_LABELS[asset.status]}</Badge></>}
            {!asset && <span className="text-sm text-muted-foreground">Loading Asset…</span>}
          </div>
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="outline" onClick={openForkDialog} disabled={!asset || forkMutation.isPending}>
              <Copy className="h-4 w-4" /> Fork New Asset
            </Button>
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
              <Button variant="outline" onClick={returnToPrevious}>
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
          <Tabs value={resolvedActiveTab} onValueChange={(value) => setActiveTab(value as AssetDetailTab)} className="space-y-6">
            <div className="sticky top-0 z-10 -mx-2 border-b bg-background/95 px-2 py-2 backdrop-blur">
              <TabsList>
                <TabsTrigger value="intent">Intent</TabsTrigger>
                <TabsTrigger value="evidence">Evidence</TabsTrigger>
                <TabsTrigger value="claims">Claims</TabsTrigger>
                <TabsTrigger value="read">Read</TabsTrigger>
                <TabsTrigger value="edit" className="gap-2">Edit{isEditorDirty && <span className="h-2 w-2 rounded-full bg-amber-500" aria-label="Unsaved changes" />}</TabsTrigger>
                <TabsTrigger value="map">Map</TabsTrigger>
                <TabsTrigger value="knowledge">Knowledge</TabsTrigger>
                <TabsTrigger value="production">Production</TabsTrigger>
              </TabsList>
            </div>

            {locationState?.stageNotice && (
              <div className="rounded-xl border border-primary/20 bg-primary/5 px-4 py-3 text-sm text-primary">
                {locationState.stageNotice}
              </div>
            )}

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
                      <div><Button type="button" onClick={() => setActiveTab("evidence")}>Continue to Evidence</Button></div>
                    </>
                  )}
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="read" className="mt-0 space-y-8">
              <article data-reader-layout={readerPresentation.layout} data-style-profile={resolvedStyleProfileId} className={`asset-reader overflow-hidden rounded-[2rem] border shadow-[0_24px_70px_-42px_rgba(15,23,42,0.45)] ${stylePresentation.shell}`}>
                <div className={`h-1.5 bg-gradient-to-r ${readerPresentation.ruleTone}`} />
                <header className={`asset-reader-hero relative overflow-hidden border-b bg-gradient-to-br ${stylePresentation.header} via-background/80 to-background/50 px-6 py-10 sm:px-10 sm:py-14 lg:px-16`}>
                  <div className="pointer-events-none absolute -right-24 -top-32 h-80 w-80 rounded-full border border-foreground/5 bg-background/30" />
                  <div className="pointer-events-none absolute -right-8 top-8 h-36 w-36 rounded-full border border-foreground/5" />
                  <div className="relative mx-auto max-w-5xl">
                    <div className="flex flex-wrap items-center justify-between gap-4">
                      <div className="flex items-center gap-3">
                        <div className={`flex h-11 w-11 items-center justify-center rounded-2xl ring-1 ${readerPresentation.accentTone}`}>
                          <AssetReaderIcon assetType={asset.asset_type} />
                        </div>
                        <div>
                          <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-muted-foreground">{readerPresentation.kicker} · {stylePresentation.label}</p>
                          <p className="mt-1 text-sm font-medium">{assetTypeLabel(asset.asset_type)}</p>
                        </div>
                      </div>
                      <Badge variant="outline" className="rounded-full bg-background/70 px-3 py-1 shadow-sm backdrop-blur">{STATUS_LABELS[asset.status]}</Badge>
                    </div>

                    <h1 className="asset-reader-title mt-9 max-w-4xl text-4xl font-semibold leading-[1.08] tracking-[-0.035em] text-foreground sm:text-5xl lg:text-6xl">{asset.title}</h1>
                    {asset.brief && (
                      <div className="asset-reader-brief mt-8 flex max-w-4xl gap-4 border-l-2 border-foreground/10 pl-5 sm:pl-6">
                        <Quote className="mt-1 h-5 w-5 shrink-0 text-muted-foreground/70" />
                        <div>
                          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">{readerPresentation.briefLabel}</p>
                          <p className="mt-2 text-lg leading-8 text-foreground/75 sm:text-xl sm:leading-9">{asset.brief}</p>
                        </div>
                      </div>
                    )}

                    <div className="asset-reader-metrics mt-10 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
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

                <div className="asset-reader-layout mx-auto grid max-w-6xl gap-10 px-6 py-10 sm:px-10 sm:py-14 lg:grid-cols-[minmax(0,1fr)_270px] lg:gap-14 lg:px-14">
                  <div className="min-w-0">
                    <div className="mb-8 flex items-center gap-3">
                      <span className={`h-px w-8 bg-gradient-to-r ${readerPresentation.ruleTone}`} />
                      <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-muted-foreground">{readerPresentation.documentLabel}</p>
                    </div>
                    {contentPresentation.readerMarkdown ? (
                      <div className="asset-reader-prose prose prose-slate max-w-none text-base leading-8 dark:prose-invert prose-headings:scroll-mt-24 prose-headings:tracking-tight prose-h1:text-3xl prose-h2:mt-14 prose-h3:mt-9 prose-p:my-5 prose-li:my-2">
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
                  {assetOutlineEditorApplyNotice && (
                    <div className="rounded-xl border border-emerald-300 bg-emerald-50 p-4 text-sm text-emerald-950" data-testid="asset-outline-editor-applied">
                      <p className="font-semibold">Map Patch applied to the local Editor.</p>
                      <p className="mt-1">{assetOutlineEditorApplyNotice}</p>
                    </div>
                  )}
                  <section className={`overflow-hidden rounded-2xl border ${documentOptimizationGate.ready ? "border-violet-200 bg-violet-50/40" : "bg-muted/10"}`}>
                    <div className="flex flex-col gap-4 p-5 lg:flex-row lg:items-start lg:justify-between">
                      <div className="flex gap-3">
                        <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${documentOptimizationGate.ready ? "bg-violet-100 text-violet-700" : "bg-muted text-muted-foreground"}`}>
                          {documentOptimizationGate.ready ? <WandSparkles className="h-5 w-5" /> : <CircleAlert className="h-5 w-5" />}
                        </div>
                        <div>
                          <div className="flex flex-wrap items-center gap-2">
                            <h3 className="font-semibold">Optimize Complete Asset</h3>
                            <Badge variant={documentOptimizationGate.ready ? "default" : "outline"}>{documentOptimizationGate.ready ? "Ready to polish" : "Research incomplete"}</Badge>
                            <Badge variant="outline">{optimizationMetadata.completed_rounds} rounds completed</Badge>
                          </div>
                          <p className="mt-1 max-w-2xl text-sm leading-6 text-muted-foreground">Use the confirmed Intent plus current accepted Evidence and Claims to rewrite the complete narrative. Existing Knowledge Candidates may inform the rewrite, but knowledge extraction no longer blocks editorial improvement.</p>
                          {!documentOptimizationGate.ready && <p className="mt-2 text-xs text-amber-700">Remaining: {documentOptimizationGate.reasons.join(" · ")}</p>}
                        </div>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <Button type="button" onClick={() => void startDocumentRevision()} disabled={!documentOptimizationGate.ready || documentRevision.streaming || editBlocks.length === 0 || Boolean(pendingOptimizationRound)}>
                          <WandSparkles className="mr-2 h-4 w-4" />{documentRevision.streaming
                            ? `Optimizing Round ${documentRevision.round ?? nextOptimizationRound}…`
                            : pendingOptimizationRound
                              ? `Save Round ${pendingOptimizationRound.round}`
                              : documentRevision.proposal
                                ? "Regenerate"
                                : nextOptimizationRound === 1
                                  ? "Optimize Entire Draft"
                                  : nextOptimizationRound === 2
                                    ? "Run Second-Round Polish"
                                    : `Run Optimization Round ${nextOptimizationRound}`}
                        </Button>
                        {documentRevision.streaming && (
                          <Button type="button" variant="outline" onClick={stopDocumentRevision}>
                            <Square className="mr-2 h-4 w-4" />Stop
                          </Button>
                        )}
                      </div>
                    </div>

                    {documentOptimizationGate.ready && (
                      <div className="space-y-4 border-t bg-background/70 p-5">
                        <div className="rounded-xl border bg-background p-4" data-asset-quality-audit>
                          <div className="flex flex-wrap items-start justify-between gap-3">
                            <div>
                              <div className="flex flex-wrap items-center gap-2">
                                <p className="text-sm font-semibold">Deterministic Quality Audit</p>
                                {qualityAuditQuery.data && <Badge variant={qualityAuditQuery.data.verdict === "block" ? "default" : qualityAuditQuery.data.verdict === "warn" ? "secondary" : "outline"}>{qualityAuditQuery.data.verdict}</Badge>}
                                {qualityAuditQuery.data && <Badge variant="outline">{qualityAuditQuery.data.score.toFixed(1)} / 5</Badge>}
                              </div>
                              <p className="mt-1 text-xs leading-5 text-muted-foreground">The audit checks the Intent → Evidence → Claim → Knowledge trace. Its findings are included in optimization round {nextOptimizationRound}.</p>
                            </div>
                            <Button type="button" variant="outline" size="sm" onClick={() => void qualityAuditQuery.refetch()} disabled={qualityAuditQuery.isFetching}>{qualityAuditQuery.isFetching ? "Checking…" : "Refresh Audit"}</Button>
                          </div>
                          {qualityAuditQuery.isError && <p className="mt-3 text-sm text-destructive">Could not load the quality audit. Optimization can continue, but this round will not include deterministic findings.</p>}
                          {qualityAuditQuery.data && [...qualityAuditQuery.data.blocking_findings, ...qualityAuditQuery.data.warnings].length === 0 && <p className="mt-3 text-sm text-emerald-700">No workflow-quality findings remain. The next round can focus on editorial polish.</p>}
                          {qualityAuditQuery.data && [...qualityAuditQuery.data.blocking_findings, ...qualityAuditQuery.data.warnings].length > 0 && (
                            <div className="mt-3 space-y-2">
                              {[...qualityAuditQuery.data.blocking_findings, ...qualityAuditQuery.data.warnings].map((finding) => (
                                <div key={finding.id} className="rounded-lg border bg-muted/20 px-3 py-2">
                                  <div className="flex flex-wrap items-center gap-2"><Badge variant="outline">{finding.id}</Badge><span className="text-sm font-medium">{finding.title}</span></div>
                                  <p className="mt-1 text-xs leading-5 text-muted-foreground">{finding.detail}</p>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>

                        {pendingOptimizationRound && (
                          <UnsavedChangesBanner message={`Round ${pendingOptimizationRound.round} is applied locally but not saved. Review the editor, then save before starting the next round.`} />
                        )}

                        <div className="space-y-2">
                          <label className="text-sm font-medium" htmlFor="asset-document-agent-instruction">Optimization focus <span className="font-normal text-muted-foreground">(optional)</span></label>
                          <Textarea id="asset-document-agent-instruction" rows={3} value={documentRevision.instruction} onChange={(event) => setDocumentRevision((current) => ({ ...current, instruction: event.target.value }))} placeholder={nextOptimizationRound === 1 ? "For example: make the argument more concise, strengthen transitions, and keep a professional research tone." : "Optional second-round focus. Audit findings and prior-round context are included automatically."} disabled={documentRevision.streaming || Boolean(pendingOptimizationRound)} />
                        </div>

                        {documentRevision.status && (
                          <AgentRunStatus
                            status={documentRevision.error ? "failed" : documentRevision.proposal ? "completed" : documentRevision.pendingQuestion ? "awaiting_input" : documentRevision.streaming ? "running" : "completed"}
                            message={documentRevision.status}
                            details={documentRevision.diagnostic}
                          />
                        )}
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
                            <ProposalActions
                              primaryLabel="Apply to Editor"
                              onPrimary={applyDocumentRevision}
                              onRegenerate={() => void startDocumentRevision()}
                              regenerateDisabled={documentRevision.streaming}
                              onDiscard={() => setDocumentRevision((current) => ({ ...current, proposal: undefined, status: "Proposal discarded." }))}
                              note="Apply updates the local editor only; Save Changes persists it."
                            />
                          </div>
                        )}
                        {documentRevision.error && <ActionError title="Complete document optimization failed" impact="No proposal was applied to the editor." recovery="Retry with the same draft or narrow the optimization focus." details={documentRevision.error} onRetry={() => void startDocumentRevision()} />}
                      </div>
                    )}
                  </section>

                  <div className="grid gap-4 md:grid-cols-2">
                    <div className="space-y-2"><label className="text-sm font-medium" htmlFor="asset-edit-title">Title</label><Input id="asset-edit-title" value={editTitle} onChange={(event) => setEditTitle(event.target.value)} /></div>
                    <div className="space-y-2"><label className="text-sm font-medium" htmlFor="asset-edit-style">Style guidance</label><Input id="asset-edit-style" value={editStyle} onChange={(event) => setEditStyle(event.target.value)} /></div>
                  </div>
                  <div className="space-y-2"><label className="text-sm font-medium" htmlFor="asset-edit-brief">Brief</label><Textarea id="asset-edit-brief" rows={4} value={editBrief} onChange={(event) => setEditBrief(event.target.value)} /></div>
                  <div className="space-y-2"><label className="text-sm font-medium" htmlFor="asset-edit-outline">Outline</label><Textarea id="asset-edit-outline" className="font-mono text-sm" rows={8} value={editOutline} onChange={(event) => setEditOutline(event.target.value)} /></div>
                  <section className="space-y-4">
                    <div>
                      <h3 className="text-sm font-medium">Document</h3>
                      <p className="text-xs text-muted-foreground">Edit the complete Markdown document naturally. Select text inside one paragraph to ask the Agent for a focused revision.</p>
                    </div>
                    <div className="grid gap-4 xl:grid-cols-2">
                      <div className="space-y-2">
                        <div className="flex items-center justify-between gap-3">
                          <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Markdown</span>
                          <span className="text-xs text-muted-foreground">{editDocumentMarkdown.length.toLocaleString()} characters</span>
                        </div>
                        {editorHighlight && (
                          <div className="flex items-center justify-between gap-3 rounded-lg border border-amber-400/50 bg-amber-400/10 px-3 py-2 text-xs text-amber-900 dark:text-amber-100">
                            <span>Mind Map Block highlighted in the Markdown editor.</span>
                            <button type="button" className="font-medium hover:underline" onClick={() => setEditorHighlight(null)}>Dismiss</button>
                          </div>
                        )}
                        <div className="relative">
                          {editorHighlight && (
                            <div aria-hidden="true" className="pointer-events-none absolute inset-px z-0 overflow-hidden rounded-md">
                              <pre
                                className="m-0 min-h-[60rem] whitespace-pre-wrap break-words px-3 py-2 font-mono text-sm leading-6 text-transparent"
                                style={{ transform: `translateY(-${editorScrollTop}px)` }}
                              >
                                {editDocumentMarkdown.slice(0, editorHighlight.start)}
                                <mark ref={editorHighlightMarkRef} className="rounded-sm bg-amber-300/60 text-transparent dark:bg-amber-400/35">
                                  {editDocumentMarkdown.slice(editorHighlight.start, editorHighlight.end)}
                                </mark>
                                {editDocumentMarkdown.slice(editorHighlight.end)}
                              </pre>
                            </div>
                          )}
                          <Textarea
                            ref={documentEditorRef}
                            aria-label="Asset document Markdown"
                            className="relative z-10 min-h-[60rem] resize-y bg-transparent font-mono text-sm leading-6"
                            value={editDocumentMarkdown}
                            onChange={(event) => changeDocumentMarkdown(event.target.value)}
                            onScroll={(event) => setEditorScrollTop(event.currentTarget.scrollTop)}
                            onSelect={captureDocumentSelection}
                            onKeyUp={captureDocumentSelection}
                            onMouseUp={captureDocumentSelection}
                            placeholder="Write the Asset as Markdown…"
                          />
                        </div>
                      </div>
                      <div className="space-y-2">
                        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Live Preview</span>
                        <article className="min-h-[60rem] overflow-auto rounded-xl border bg-background p-6 shadow-sm">
                          {editDocumentMarkdown.trim() ? (
                            <div className="prose prose-slate max-w-none dark:prose-invert">
                              <MarkdownRenderer evidenceLinks={evidenceLinks}>{editDocumentMarkdown}</MarkdownRenderer>
                            </div>
                          ) : (
                            <p className="text-sm text-muted-foreground">Start writing to preview the document.</p>
                          )}
                        </article>
                      </div>
                    </div>
                    {editorSelection && (
                      <div className="sticky bottom-4 z-10 space-y-3 rounded-xl border border-violet-300 bg-background/95 p-4 shadow-xl backdrop-blur">
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div className="min-w-0">
                            <p className="text-sm font-semibold">Revise selected text with Agent</p>
                            <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">“{editorSelection.text}”</p>
                          </div>
                          <Button type="button" variant="ghost" size="sm" onClick={() => setEditorSelection(null)}>Dismiss</Button>
                        </div>
                        <Input value={selectionInstruction} onChange={(event) => setSelectionInstruction(event.target.value)} placeholder="Optional instruction for the selected text…" />
                        <div className="flex flex-wrap gap-2">
                          <Button type="button" size="sm" onClick={() => openSelectionRevision()}>Ask Agent</Button>
                          <Button type="button" variant="outline" size="sm" onClick={() => openSelectionRevision("Make it clearer and more direct")}>Clarify</Button>
                          <Button type="button" variant="outline" size="sm" onClick={() => openSelectionRevision("Make it more concise without losing meaning")}>Shorten</Button>
                          <Button type="button" variant="outline" size="sm" onClick={() => openSelectionRevision("Expand it with useful detail and stronger transitions")}>Expand</Button>
                        </div>
                      </div>
                    )}
                    {blockRevision && (
                      <div className="space-y-4 rounded-xl border border-primary/20 bg-background p-4" data-agent-block-revision={blockRevision.blockId}>
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div><p className="text-sm font-semibold">Agent Selection Revision</p><p className="text-xs text-muted-foreground">The Agent returns a proposal for the containing paragraph. Apply updates the editor only; Save Changes persists it.</p></div>
                          <Button type="button" variant="ghost" size="sm" onClick={discardBlockRevision}>Close</Button>
                        </div>
                        <Textarea rows={3} value={blockRevision.instruction} disabled={blockRevision.streaming} onChange={(event) => setBlockRevision((current) => current ? { ...current, instruction: event.target.value } : current)} />
                        <Button type="button" size="sm" onClick={() => void startBlockRevision()} disabled={blockRevision.streaming}>
                          {blockRevision.streaming ? "Agent is working…" : blockRevision.proposal ? "Regenerate" : "Generate Revision"}
                        </Button>
                        {blockRevision.agentStatus && <AgentRunStatus status={blockRevision.error ? "failed" : blockRevision.proposal ? "completed" : blockRevision.pendingQuestion ? "awaiting_input" : blockRevision.streaming ? "running" : "completed"} message={blockRevision.agentStatus} details={blockRevision.diagnostic} />}
                        {blockRevision.pendingQuestion && (
                          <QuestionCard questions={blockRevision.pendingQuestion.questions} onSubmit={async (answers: HarnessQuestionAnswer[]) => {
                            await answerHarnessQuestion(blockRevision.pendingQuestion!.rpcId, blockRevision.pendingQuestion!.sessionId, answers);
                            setBlockRevision((current) => current ? { ...current, pendingQuestion: undefined, agentStatus: "Clarification received. Agent is continuing…" } : current);
                          }} />
                        )}
                        {blockRevision.proposal && (
                          <div className="space-y-3">
                            {blockRevision.proposal.explanation && <p className="rounded-md bg-muted/50 p-3 text-sm">{blockRevision.proposal.explanation}</p>}
                            <pre className="max-h-96 overflow-auto rounded-md border bg-muted/20 p-3 text-xs leading-5">
                              {buildLineDiff(blockRevision.originalMarkdown, blockRevision.proposal.replacementMarkdown).map((line, lineIndex) => (
                                <div key={`${lineIndex}-${line.kind}`} className={line.kind === "added" ? "bg-emerald-100 text-emerald-950" : line.kind === "removed" ? "bg-red-100 text-red-950" : "text-muted-foreground"}>
                                  <span className="mr-2 inline-block w-3 select-none">{line.kind === "added" ? "+" : line.kind === "removed" ? "-" : " "}</span>{line.text || " "}
                                </div>
                              ))}
                            </pre>
                            <ProposalActions primaryLabel="Apply to Document" onPrimary={applyBlockRevision} onRegenerate={() => void startBlockRevision()} regenerateDisabled={blockRevision.streaming} onDiscard={discardBlockRevision} note="Review the continuous preview, then save explicitly." />
                          </div>
                        )}
                        {blockRevision.error && <ActionError title="Selection revision failed" impact="The document was not changed." recovery="Retry the proposal or adjust the instruction." details={blockRevision.error} onRetry={() => void startBlockRevision()} />}
                      </div>
                    )}
                    <details className="rounded-xl border bg-muted/10 px-4 py-3">
                      <summary className="cursor-pointer text-sm font-medium">Advanced claim links</summary>
                      <p className="mt-2 text-xs text-muted-foreground">Block boundaries remain internal and are shown here only for maintaining Claim references.</p>
                      <div className="mt-3 space-y-3">
                        {editBlocks.map((block, index) => (
                          <div key={block.id} className="rounded-lg border bg-background p-3">
                            <p className="line-clamp-2 text-xs text-muted-foreground">{block.markdown}</p>
                            <div className="mt-2 flex flex-wrap gap-2">
                              {(workspaceQuery.data?.claims ?? []).filter((claim) => claim.status === "accepted" || claim.status === "hypothesis").map((claim) => (
                                <label key={claim.id} className="inline-flex cursor-pointer items-center gap-1.5 rounded-full border px-2 py-1 text-xs">
                                  <input type="checkbox" checked={block.claimRefs.includes(claim.id)} onChange={() => toggleBlockClaim(block.id, claim.id)} />
                                  {claim.id}
                                </label>
                              ))}
                              {!block.claimRefs.length && <span className="text-xs text-muted-foreground">Paragraph {index + 1} has no linked Claims.</span>}
                            </div>
                          </div>
                        ))}
                      </div>
                    </details>
                  </section>
                  <div className="hidden" aria-hidden="true">
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
                            {revision.agentStatus && <AgentRunStatus status={revision.error ? "failed" : revision.proposal ? "completed" : revision.pendingQuestion ? "awaiting_input" : revision.streaming ? "running" : "completed"} message={revision.agentStatus} details={revision.diagnostic} />}
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
                                <ProposalActions primaryLabel="Apply to Editor" onPrimary={applyBlockRevision} onRegenerate={() => void startBlockRevision()} regenerateDisabled={revision.streaming} onDiscard={discardBlockRevision} note="Apply changes this local Block; Save Changes persists the Asset." />
                              </div>
                            )}
                            {revision.error && <ActionError title="Block revision failed" impact="The Block was not changed." recovery="Retry the proposal or discard this revision panel." details={revision.error} onRetry={() => void startBlockRevision()} />}
                          </div>
                        )}
                      </div>
                      );
                    })}
                  </div>
                  {isEditorDirty ? (
                    <UnsavedChangesBanner
                      message="Unsaved changes · recovery draft stored in this tab."
                      onSave={() => editMutation.mutate()}
                      saveLabel={pendingOptimizationRound ? `Save Round ${pendingOptimizationRound.round} Changes` : "Save Changes"}
                      saving={editMutation.isPending}
                      saveDisabled={!editTitle.trim()}
                    />
                  ) : needsStableBlocks ? (
                    <div className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-950" data-testid="asset-stable-blocks-required">
                      <p className="font-semibold">This Asset has saved content but no stable Block record yet.</p>
                      <p className="mt-1">Establish Blocks once so Outline Maps and Block references can safely track later changes.</p>
                      <Button className="mt-3" type="button" onClick={() => editMutation.mutate()} disabled={editMutation.isPending || !editTitle.trim()}>
                        {editMutation.isPending ? "Establishing Stable Blocks…" : "Establish Stable Blocks"}
                      </Button>
                    </div>
                  ) : (
                    <div className="flex flex-wrap items-center gap-3">
                      <Button disabled>Save Changes</Button>
                      {editMutation.isSuccess && <span className="text-sm text-emerald-700">Saved. Open Read to inspect the rendered document.</span>}
                    </div>
                  )}
                  {editMutation.isError && <ActionError title="Asset changes were not saved" impact="The saved Asset is unchanged." recovery="Your recovery draft is still available in this browser tab; retry Save Changes." details={editMutation.error instanceof Error ? editMutation.error.message : "Unknown save error"} onRetry={() => editMutation.mutate()} retryLabel="Retry Save" />}
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="evidence" className="mt-0">
              <div className="space-y-6">
                <Card className={workflowStage.evidenceReady ? "border-emerald-200 bg-emerald-50/30" : "border-primary/20 bg-primary/5"}>
                  <CardContent className="flex flex-wrap items-center justify-between gap-4 pt-6">
                    <div>
                      <div className="flex flex-wrap items-center gap-2"><Badge variant="outline">Stage 2 of 4</Badge><Badge variant={workflowStage.evidenceReady ? "secondary" : "outline"}>{workflowStage.evidenceReady ? "Evidence ready" : "Evidence review required"}</Badge></div>
                      <p className="mt-2 text-sm font-medium">Fix the evidence base before generating conclusions.</p>
                      <p className="mt-1 text-xs text-muted-foreground">{workflowStage.acceptedEvidence.length} accepted · {workflowStage.pendingEvidence.length} awaiting review. Accept at least one current Evidence item and resolve every proposal.</p>
                    </div>
                    <Button type="button" onClick={() => setActiveTab("claims")} disabled={!workflowStage.evidenceReady}>Continue to Claims</Button>
                  </CardContent>
                </Card>

                {(workspaceQuery.data?.missing_evidence_requests ?? []).some((item) => item.status === "open" && item.intent_revision === workspaceQuery.data?.intent?.revision) && (
                  <Card className="border-amber-200 bg-amber-50/30">
                    <CardHeader>
                      <CardTitle>Missing Evidence Requests</CardTitle>
                      <CardDescription>Investigation gaps are tracked separately from Source references and keep the original Intent Scope.</CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-3">
                      {(workspaceQuery.data?.missing_evidence_requests ?? [])
                        .filter((item) => item.status === "open" && item.intent_revision === workspaceQuery.data?.intent?.revision)
                        .map((request) => (
                          <div key={request.id} className="rounded-xl border border-amber-200 bg-background p-4">
                            <div className="flex flex-wrap items-center gap-2">
                              <Badge variant="outline">Claim {request.claim_id}</Badge>
                              {request.requested_relations.map((relation) => <Badge key={relation} variant="secondary">{EVIDENCE_RELATION_PRESENTATION[relation].label}</Badge>)}
                              <Badge variant="outline">{request.source_session_id ? "Session recoverable" : "New session required"}</Badge>
                            </div>
                            <p className="mt-3 text-sm leading-6">{request.question}</p>
                            <p className="mt-2 text-xs text-muted-foreground">Original Scope: {request.scope.length ? request.scope.join(" · ") : "No additional scope constraints"}</p>
                            <Button className="mt-3" size="sm" type="button" onClick={() => void startEvidenceResearch(request)} disabled={evidenceAgent.streaming}>
                              {request.source_session_id ? "Resume Evidence Investigation" : "Start Evidence Investigation"}
                            </Button>
                          </div>
                        ))}
                    </CardContent>
                  </Card>
                )}

                <Card>
                  <CardHeader><CardTitle>Evidence Relationship Guide</CardTitle><CardDescription>Every candidate must state how it relates to the Intent or a Claim.</CardDescription></CardHeader>
                  <CardContent className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                    {(Object.entries(EVIDENCE_RELATION_PRESENTATION) as Array<[AssetEvidenceRelation, (typeof EVIDENCE_RELATION_PRESENTATION)[AssetEvidenceRelation]]>).map(([relation, presentation]) => (
                      <div key={relation} className={`rounded-lg border p-3 ${presentation.className}`}>
                        <p className="text-sm font-semibold">{presentation.label}</p>
                        <p className="mt-1 text-xs leading-5 opacity-80">{presentation.description}</p>
                      </div>
                    ))}
                  </CardContent>
                </Card>

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
                          <Button type="button" onClick={() => void startEvidenceResearch()} disabled={evidenceAgent.streaming || workspaceQuery.isLoading || evidenceDecisionMutation.isPending || saveEvidenceProposalMutation.isPending}>
                            {evidenceAgent.streaming ? "Collecting…" : "Ask Agent to Collect Evidence"}
                          </Button>
                          {evidenceAgent.streaming && <Button type="button" variant="outline" onClick={() => evidenceAgentAbortRef.current?.abort()}>Stop</Button>}
                        </div>
                        {evidenceAgent.status && <AgentRunStatus status={evidenceAgent.error ? "failed" : evidenceAgent.proposal ? "completed" : evidenceAgent.pendingQuestion ? "awaiting_input" : evidenceAgent.streaming ? "running" : "completed"} message={evidenceAgent.status} details={evidenceAgent.diagnostic} />}
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
                              <div className="flex flex-wrap items-center gap-2"><Badge variant="outline">{EVIDENCE_RELATION_PRESENTATION[item.relation].label}</Badge><Badge variant="secondary">{item.targetType}</Badge></div>
                              <p className="mt-2 break-all text-xs text-muted-foreground">{item.targetId}</p>
                              <p className="mt-2 text-sm leading-6">{item.summary}</p>
                              {typeof item.fragmentSelector?.exact === "string" && <blockquote className="mt-2 border-l-2 pl-3 text-xs text-muted-foreground">{item.fragmentSelector.exact}</blockquote>}
                            </div>
                          ))}
                        </div>
                        <ProposalActions primaryLabel="Save Proposal to Evidence Board" pendingLabel="Saving…" primaryPending={saveEvidenceProposalMutation.isPending} primaryDisabled={evidenceDecisionMutation.isPending} onPrimary={() => saveEvidenceProposalMutation.mutate()} onRegenerate={() => void startEvidenceResearch()} regenerateLabel="Investigate Again" regenerateDisabled={evidenceAgent.streaming || evidenceDecisionMutation.isPending} onDiscard={() => setEvidenceAgent((current) => ({ ...current, proposal: undefined, status: "Proposal discarded." }))} />
                      </div>
                    )}
                    {(evidenceAgent.error || saveEvidenceProposalMutation.isError) && <ActionError title="Evidence proposal failed" impact="No new Evidence candidates were saved." recovery="The current Workspace is unchanged; retry collection or saving." details={evidenceAgent.error || (saveEvidenceProposalMutation.error instanceof Error ? saveEvidenceProposalMutation.error.message : "Could not save Evidence candidates.")} onRetry={() => void startEvidenceResearch()} />}
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
                              <div className="flex flex-wrap items-center gap-2"><Badge variant="outline">{EVIDENCE_RELATION_PRESENTATION[item.relation].label}</Badge><Badge variant="secondary">{item.status}</Badge><span className="text-xs text-muted-foreground">Intent r{item.intent_revision}</span></div>
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
                <Card className={workflowStage.claimsReady ? "border-emerald-200 bg-emerald-50/30" : "border-primary/20 bg-primary/5"}>
                  <CardContent className="flex flex-wrap items-center justify-between gap-4 pt-6">
                    <div>
                      <div className="flex flex-wrap items-center gap-2"><Badge variant="outline">Stage 3 of 4</Badge><Badge variant={workflowStage.claimsReady ? "secondary" : "outline"}>{workflowStage.claimsReady ? "Claims ready" : "Claim review required"}</Badge></div>
                      <p className="mt-2 text-sm font-medium">Confirm the conclusions that the initial document may use.</p>
                      <p className="mt-1 text-xs text-muted-foreground">{workflowStage.acceptedClaims.length} accepted or retained · {workflowStage.pendingClaims.length} awaiting review. The document generator stays locked until the Claim Gate is complete.</p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Button type="button" variant="outline" onClick={() => setActiveTab("evidence")}>Back to Evidence</Button>
                      {asset.draft_content?.trim() ? (
                        <Button type="button" onClick={() => setActiveTab("read")}>Open Draft</Button>
                      ) : (
                        <Button type="button" onClick={startInitialDraftGeneration} disabled={!workflowStage.claimsReady}>Generate Initial Draft</Button>
                      )}
                    </div>
                  </CardContent>
                </Card>
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
                    ) : (!workflowStage.evidenceReady ? (
                      <p className="text-sm text-muted-foreground">Accept at least one current Evidence item and resolve all Evidence proposals before asking the Agent to extract Claims.</p>
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
                          <Button type="button" onClick={() => void startClaimAnalysis()} disabled={claimAgent.streaming || !workflowStage.evidenceReady}>
                            {claimAgent.streaming ? "Analyzing…" : "Ask Agent to Propose Claims"}
                          </Button>
                          {claimAgent.streaming && <Button type="button" variant="outline" onClick={() => claimAgentAbortRef.current?.abort()}>Stop</Button>}
                        </div>
                        {claimAgent.status && <AgentRunStatus status={claimAgent.error ? "failed" : claimAgent.proposal ? "completed" : claimAgent.streaming ? "running" : "completed"} message={claimAgent.status} details={claimAgent.diagnostic} />}
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
                        <ProposalActions primaryLabel="Save Proposal to Claim Board" pendingLabel="Saving…" primaryPending={saveClaimProposalMutation.isPending} onPrimary={() => saveClaimProposalMutation.mutate()} onRegenerate={() => void startClaimAnalysis()} regenerateLabel="Analyze Again" regenerateDisabled={claimAgent.streaming} onDiscard={() => setClaimAgent((current) => ({ ...current, proposal: undefined, status: "Proposal discarded." }))} />
                      </div>
                    )}
                    {(claimAgent.error || saveClaimProposalMutation.isError) && <ActionError title="Claim proposal failed" impact="No new Claim candidates were saved." recovery="The current Claim Board is unchanged; retry analysis or saving." details={claimAgent.error || (saveClaimProposalMutation.error instanceof Error ? saveClaimProposalMutation.error.message : "Could not save Candidate Claims.")} onRetry={() => void startClaimAnalysis()} />}
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

            <TabsContent value="map" className="mt-0 space-y-4">
              <Card>
                <CardHeader>
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <CardTitle>Asset Outline Map</CardTitle>
                      <CardDescription>Read-only projection of the saved Asset Blocks. Creating or viewing this Map does not change the editor.</CardDescription>
                    </div>
                    {assetOutlineMap && <Badge variant="secondary">Version {assetOutlineMap.version}</Badge>}
                  </div>
                </CardHeader>
                <CardContent className="space-y-4">
                  {assetOutlineMapsQuery.isLoading && <p className="text-sm text-muted-foreground">Loading Outline Map…</p>}
                  {!assetOutlineMapsQuery.isLoading && !assetOutlineMap && (
                    <div className="rounded-xl border border-dashed p-5">
                      <p className="text-sm font-medium">No Asset Outline Map yet.</p>
                      <p className="mt-1 text-sm text-muted-foreground">The first projection uses the currently saved Blocks and confirmed Claim links. Later Asset changes will not silently replace it.</p>
                      {needsStableBlocks ? (
                        <>
                          <Button className="mt-4" type="button" onClick={() => editMutation.mutate()} disabled={editMutation.isPending || isEditorDirty || !editTitle.trim()}>
                            {editMutation.isPending ? "Establishing Stable Blocks…" : "Establish Stable Blocks First"}
                          </Button>
                          <p className="mt-2 text-xs text-amber-700">This older or automatically generated Asset already has content, but its stable Block record has not been saved yet. This step preserves the current text and adds Block identities only.</p>
                        </>
                      ) : (
                        <Button className="mt-4" type="button" onClick={() => projectAssetOutlineMutation.mutate()} disabled={projectAssetOutlineMutation.isPending || isEditorDirty}>
                          {projectAssetOutlineMutation.isPending ? "Creating Outline Map…" : "Create Outline Map from Saved Blocks"}
                        </Button>
                      )}
                      {isEditorDirty && <p className="mt-2 text-xs text-amber-700">Save the current editor changes before creating the Map so every node receives a stable Block reference.</p>}
                    </div>
                  )}
                  {projectAssetOutlineMutation.isError && <ActionError title="Outline Map could not be created" impact="The Asset editor and saved document were not changed." recovery="Confirm Intent, save the Asset Blocks, then try again." details={projectAssetOutlineMutation.error instanceof Error ? projectAssetOutlineMutation.error.message : "Unknown projection error"} onRetry={() => projectAssetOutlineMutation.mutate()} />}
                  {assetOutlineStalenessQuery.data?.stale && (
                    <div className="rounded-xl border border-amber-400 bg-amber-50 p-4 text-sm text-amber-950" data-testid="asset-outline-stale-warning">
                      <p className="font-semibold">This Outline Map is based on an older Asset revision.</p>
                      <p className="mt-1">The saved Map is preserved. Changed basis: {assetOutlineStalenessQuery.data.reasons.map((reason) => reason.replace(/_/g, " ")).join(", ")}.</p>
                      <Button className="mt-3" type="button" variant="outline" size="sm" onClick={() => assetOutlineRefreshMutation.mutate()} disabled={assetOutlineRefreshMutation.isPending}>
                        {assetOutlineRefreshMutation.isPending ? "Preparing Refresh Preview…" : "Preview Refresh Proposal"}
                      </Button>
                    </div>
                  )}
                  {assetOutlineStalenessQuery.isError && <ActionError title="Outline Map freshness could not be checked" impact="The existing Map remains available and unchanged." recovery="Retry the basis check before generating a Refresh Proposal." details={assetOutlineStalenessQuery.error instanceof Error ? assetOutlineStalenessQuery.error.message : "Unknown staleness error"} onRetry={() => assetOutlineStalenessQuery.refetch()} />}
                  {assetOutlineTreeQuery.data && (
                    <>
                      <MindMapCanvas
                        nodes={assetMapCanvasNodes}
                        layoutMode={assetOutlineTreeQuery.data.map.layout_mode}
                        collapsedIds={assetMapCollapsedIds}
                        focusId={null}
                        selectedId={assetMapSelectedId}
                        onSelectedIdChange={setAssetMapSelectedId}
                        onCollapsedIdsChange={setAssetMapCollapsedIds}
                        className="h-[560px] rounded-xl border"
                        testId="asset-outline-map-preview"
                      />
                      {assetMapSelectedId && (() => {
                        const blockReference = assetOutlineTreeQuery.data.references.find((reference) => reference.node_id === assetMapSelectedId && reference.ref_type === "asset_block");
                        if (!blockReference) return null;
                        return <Button type="button" variant="outline" onClick={() => openAssetBlockInEditor(blockReference.ref_id)}>Open selected Block in Editor</Button>;
                      })()}
                      {!assetOutlineStalenessQuery.data?.stale && (
                        <Button type="button" variant="outline" onClick={() => assetOutlineDocumentPatchMutation.mutate()} disabled={assetOutlineDocumentPatchMutation.isPending}>
                          {assetOutlineDocumentPatchMutation.isPending ? "Preparing Document Patch…" : "Preview Asset Document Patch"}
                        </Button>
                      )}
                    </>
                  )}
                  {assetOutlineRefreshMutation.data && (
                    <div className="space-y-3 rounded-xl border border-blue-300 bg-blue-50/40 p-4" data-testid="asset-outline-refresh-proposal">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div><p className="font-semibold">Refresh Proposal Preview</p><p className="text-sm text-muted-foreground">{assetOutlineRefreshMutation.data.node_count} nodes · {assetOutlineRefreshMutation.data.reference_count} references · no Asset or Map changes applied</p></div>
                      </div>
                      <MindMapCanvas
                        nodes={assetRefreshCanvasNodes}
                        layoutMode={assetOutlineRefreshMutation.data.proposal.layout_mode}
                        collapsedIds={new Set()}
                        focusId={null}
                        selectedId={null}
                        onSelectedIdChange={() => undefined}
                        onCollapsedIdsChange={() => undefined}
                        className="h-[480px] rounded-xl border bg-background"
                        testId="asset-outline-refresh-preview"
                      />
                      <div className="space-y-2 rounded-lg border bg-background/80 p-3" data-testid="asset-outline-refresh-diff">
                        <div className="flex flex-wrap items-center gap-2 text-xs">
                          <span className="font-semibold text-foreground">Structural changes</span>
                          {(["add", "move", "rename", "delete"] as const).map((operation) => (
                            <Badge key={operation} variant="outline">{assetOutlineRefreshChangeCounts[operation]} {operation}</Badge>
                          ))}
                        </div>
                        {assetOutlineRefreshChanges.length === 0 ? (
                          <p className="text-sm text-muted-foreground">No Block-level structural changes were detected.</p>
                        ) : (
                          <ul className="space-y-2 text-sm">
                            {assetOutlineRefreshChanges.map((change, index) => (
                              <li key={`${change.operation}-${change.assetBlockId}-${index}`} className="rounded-md border px-3 py-2">
                                <span className="font-medium capitalize">{change.operation}</span> · {change.label}
                                <p className="mt-1 text-xs text-muted-foreground">{change.detail}</p>
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                      <ProposalActions
                        primaryLabel="Apply Refresh to Map"
                        pendingLabel="Refreshing Map…"
                        onPrimary={() => assetOutlineRefreshApplyMutation.mutate()}
                        primaryPending={assetOutlineRefreshApplyMutation.isPending}
                        onDiscard={() => assetOutlineRefreshMutation.reset()}
                        discardLabel="Discard Preview"
                        note="Updates the formal Map only. The Asset Editor and saved Asset document remain unchanged."
                      />
                    </div>
                  )}
                  {assetOutlineRefreshMutation.isError && <ActionError title="Refresh Proposal could not be generated" impact="The saved Outline Map and Asset editor were not changed." recovery="Save the latest Asset Blocks and retry the preview." details={assetOutlineRefreshMutation.error instanceof Error ? assetOutlineRefreshMutation.error.message : "Unknown refresh error"} onRetry={() => assetOutlineRefreshMutation.mutate()} />}
                  {assetOutlineRefreshApplyMutation.isError && <ActionError title="Outline Map refresh could not be applied" impact="The existing Map and Asset Editor remain unchanged." recovery="Refresh the proposal to use the latest Map and Asset revisions, then apply again." details={assetOutlineRefreshApplyMutation.error instanceof Error ? assetOutlineRefreshApplyMutation.error.message : "Unknown refresh apply error"} onRetry={() => assetOutlineRefreshMutation.mutate()} />}
                  {assetOutlineRefreshAppliedVersion !== null && (
                    <div className="rounded-xl border border-emerald-300 bg-emerald-50 p-4 text-sm text-emerald-950" data-testid="asset-outline-refresh-applied">
                      <p className="font-semibold">Outline Map refreshed to version {assetOutlineRefreshAppliedVersion}.</p>
                      <p className="mt-1">Only the formal Map changed. The Asset Editor and saved Asset document were not modified.</p>
                    </div>
                  )}
                  {assetOutlineDocumentPatchPreview && (
                    <div className="space-y-3 rounded-xl border border-violet-300 bg-violet-50/40 p-4" data-testid="asset-outline-document-patch">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div>
                          <p className="font-semibold">Asset Document Patch Preview</p>
                          <p className="text-sm text-muted-foreground">Generated from Map version {assetOutlineDocumentPatchPreview.base_map_version}. No Editor changes have been applied.</p>
                        </div>
                      </div>
                      {assetOutlinePatchReviewNotice && <p className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">{assetOutlinePatchReviewNotice}</p>}
                      <div className="flex flex-wrap gap-2 text-xs">
                        {(["add", "move", "rename", "delete"] as const).map((operation) => (
                          <Badge key={operation} variant="outline">{assetOutlineDocumentPatchPreview.operation_counts[operation]} {operation}</Badge>
                        ))}
                      </div>
                      {assetOutlineDocumentPatchPreview.warnings.length > 0 && (
                        <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">
                          <p className="font-semibold">Safety notes</p>
                          <ul className="mt-1 space-y-1">{assetOutlineDocumentPatchPreview.warnings.map((warning) => <li key={warning}>• {warning}</li>)}</ul>
                        </div>
                      )}
                      {assetOutlineDocumentPatchPreview.no_changes ? (
                        <p className="rounded-lg border bg-background p-3 text-sm text-muted-foreground">The formal Map already matches the current Asset Block structure.</p>
                      ) : (
                        <ul className="space-y-2 text-sm">
                          {assetOutlineDocumentPatchPreview.patch?.operations.map((operation, index) => (
                            <li key={`${operation.operation}-${index}`} className="rounded-lg border bg-background p-3">
                              <span className="font-semibold capitalize">{operation.operation}</span>
                              {operation.operation === "add" && <p className="mt-1">Add <code>{operation.temp_block_id}</code> after <code>{operation.after_block_id ?? "document start"}</code>: {operation.markdown}</p>}
                              {operation.operation === "move" && <p className="mt-1">Move <code>{operation.block_id}</code> after <code>{operation.after_block_id ?? "document start"}</code>.</p>}
                              {operation.operation === "rename" && <p className="mt-1">Update <code>{operation.block_id}</code> to: {operation.replacement_markdown}</p>}
                              {operation.operation === "delete" && <p className="mt-1">Delete <code>{operation.block_id}</code>{operation.affected_claim_refs.length > 0 ? `; affects Claims: ${operation.affected_claim_refs.join(", ")}` : "."}</p>}
                            </li>
                          ))}
                        </ul>
                      )}
                      {assetOutlineDocumentPatchPreview.patch && (
                        <ProposalActions
                          primaryLabel="Apply to Asset Editor"
                          pendingLabel="Rechecking Patch…"
                          onPrimary={() => assetOutlineDocumentPatchApplyMutation.mutate()}
                          primaryPending={assetOutlineDocumentPatchApplyMutation.isPending}
                          primaryDisabled={isEditorDirty}
                          onRegenerate={() => assetOutlineDocumentPatchMutation.mutate()}
                          regenerateLabel="Refresh Preview"
                          regenerateDisabled={assetOutlineDocumentPatchMutation.isPending}
                          onDiscard={() => {
                            setAssetOutlineDocumentPatchPreview(null);
                            setAssetOutlinePatchReviewNotice(null);
                          }}
                          discardLabel="Discard Preview"
                          note={isEditorDirty ? "Save or discard current Editor changes before applying this Patch." : "Applies to local Editor state only; Save Changes remains required."}
                        />
                      )}
                    </div>
                  )}
                  {assetOutlineDocumentPatchMutation.isError && <ActionError title="Asset Document Patch could not be generated" impact="The Map and Asset Editor remain unchanged." recovery="Refresh a stale Map first, then retry from the latest Map version." details={assetOutlineDocumentPatchMutation.error instanceof Error ? assetOutlineDocumentPatchMutation.error.message : "Unknown document patch error"} onRetry={() => assetOutlineDocumentPatchMutation.mutate()} />}
                  {assetOutlineDocumentPatchApplyMutation.isError && <ActionError title="Asset Document Patch could not be applied" impact="The local Editor and saved Asset remain unchanged." recovery="Refresh the Patch, resolve any current Editor changes, and apply again." details={assetOutlineDocumentPatchApplyMutation.error instanceof Error ? assetOutlineDocumentPatchApplyMutation.error.message : "Unknown Patch apply error"} onRetry={() => assetOutlineDocumentPatchMutation.mutate()} />}
                </CardContent>
              </Card>
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
                    {knowledgeAgent.status && <AgentRunStatus status={knowledgeAgent.error ? "failed" : knowledgeAgent.proposal ? "completed" : knowledgeAgent.streaming ? "running" : "completed"} message={knowledgeAgent.status} details={knowledgeAgent.diagnostic} />}
                    {knowledgeAgent.error && <ActionError title="Knowledge distillation failed" impact="No Contribution or Knowledge candidates were saved." recovery="The Asset Workspace is unchanged; retry distillation." details={knowledgeAgent.error} onRetry={() => void startKnowledgeDistillation()} />}
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
                        <ProposalActions primaryLabel="Save Candidates for Review" pendingLabel="Saving…" primaryPending={saveKnowledgeProposalMutation.isPending} onPrimary={() => saveKnowledgeProposalMutation.mutate()} onRegenerate={() => void startKnowledgeDistillation()} regenerateDisabled={knowledgeAgent.streaming} onDiscard={() => setKnowledgeAgent((current) => ({ ...current, proposal: undefined, status: "Proposal discarded." }))} />
                        {saveKnowledgeProposalMutation.isError && <ActionError title="Knowledge candidates were not saved" impact="The Workspace has no new Contribution or Knowledge candidates." recovery="Retry saving this validated proposal." details={saveKnowledgeProposalMutation.error instanceof Error ? saveKnowledgeProposalMutation.error.message : "Unknown save error"} onRetry={() => saveKnowledgeProposalMutation.mutate()} retryLabel="Retry Save" />}
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
                  <CardHeader><CardTitle>Knowledge Candidates</CardTitle><CardDescription>Extract reusable knowledge after the draft is stable. Keeping a Candidate preserves the proposal only; promotion into a formal Note or Wiki remains a separate user-confirmed action.</CardDescription></CardHeader>
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

                <div className="rounded-2xl border bg-muted/10 p-4">
                  <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
                    <div className="max-w-2xl">
                      <p className="text-sm font-semibold">Experience Style</p>
                      <p className="mt-1 text-sm leading-6 text-muted-foreground">The profile controls generation rhythm, reader presentation, quality hints, and HTML theme while preserving the same Evidence and Claim gates.</p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <select aria-label="Asset experience style" className="h-9 rounded-md border border-input bg-background px-3 text-sm" value={selectedStyleProfileId} onChange={(event) => setSelectedStyleProfileId(event.target.value as AssetStyleProfileId)}>
                        {ASSET_STYLE_PROFILES.map((profile) => <option key={profile.id} value={profile.id}>{profile.label}</option>)}
                      </select>
                      <Button type="button" variant="outline" size="sm" onClick={() => saveStyleProfileMutation.mutate()} disabled={saveStyleProfileMutation.isPending || selectedStyleProfileId === resolvedStyleProfileId}>
                        {saveStyleProfileMutation.isPending ? "Saving…" : "Apply Style"}
                      </Button>
                    </div>
                  </div>
                  {saveStyleProfileMutation.isSuccess && <p className="mt-3 text-xs text-emerald-700">Experience style saved and export theme refreshed.</p>}
                  {saveStyleProfileMutation.isError && <p className="mt-3 text-xs text-destructive">Could not update the experience style.</p>}
                </div>

                <div className="flex flex-col gap-3 rounded-2xl border bg-muted/10 p-4 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <p className="text-sm font-semibold">Reference Notes</p>
                    <p className="mt-1 text-sm text-muted-foreground">Generate the exportable references section from the Asset's attached Sources, Notes, and Wiki pages.</p>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => attachReferencesMutation.mutate()}
                    disabled={isBusy || !((asset.source_refs?.length ?? 0) + (asset.note_refs?.length ?? 0) + (asset.wiki_refs?.length ?? 0))}
                  >
                    {attachReferencesMutation.isPending ? "Generating…" : asset.reference_notes?.trim() ? "Refresh Reference Notes" : "Generate Reference Notes"}
                  </Button>
                </div>
                {attachReferencesMutation.isSuccess && <p className="text-sm text-emerald-700">Reference Notes generated and readiness refreshed.</p>}
                {attachReferencesMutation.isError && <p className="text-sm text-destructive">Could not generate Reference Notes from the attached records.</p>}

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
                  {(asset.status === "ready_to_export" || asset.status === "exported") && (
                    <>
                      <Button variant="outline" onClick={() => previewWechatMutation.mutate()} disabled={isBusy || previewWechatMutation.isPending}>
                        <Eye className="mr-2 h-4 w-4" />{previewWechatMutation.isPending ? "Rendering…" : "Preview WeChat"}
                      </Button>
                      <Button variant="outline" onClick={() => { if (window.confirm("Send this Asset to the configured WeChat Official Account draft box? This creates an external draft but does not publish it.")) wechatDraftMutation.mutate(); }} disabled={isBusy || !readinessQuery.data?.ready}>
                        <MessageSquareShare className="mr-2 h-4 w-4" />{wechatDraftMutation.isPending ? "Rendering diagrams and sending…" : "Send to WeChat Drafts"}
                      </Button>
                    </>
                  )}
                </div>
                {(asset.status === "ready_to_export" || asset.status === "exported") && (
                  <p className="text-xs text-muted-foreground">A permanent cover media ID is required. Inline article images and Mermaid diagrams are uploaded to WeChat and replaced with WeChat-hosted URLs during delivery.</p>
                )}

                {statusMutation.isError && (
                  <p className="text-sm text-destructive">Failed to update asset status. Check readiness and retry.</p>
                )}
                {(exportMutation.isError || exportHtmlMutation.isError) && (
                  <p className="text-sm text-destructive">Export failed. Make sure the asset is ready and has references.</p>
                )}
                {wechatDraftMutation.isSuccess && (
                  <p className="text-sm text-emerald-700">Sent to the configured WeChat Official Account draft box.</p>
                )}
                {wechatDraftMutation.isError && (
                  <p className="text-sm text-destructive">WeChat draft delivery failed: {wechatDraftMutation.error instanceof Error ? wechatDraftMutation.error.message : "Check the account credential and retry."}</p>
                )}
                {wechatDraftReceipt && (
                  <div className="rounded-lg border border-emerald-500/25 bg-emerald-500/5 p-3 text-sm">
                    <p className="font-medium text-emerald-800">Latest WeChat draft</p>
                    <p className="mt-1 text-muted-foreground">Account: {String(wechatDraftReceipt.account_label || "default")} · Media ID: <code>{String(wechatDraftReceipt.media_id || "unknown")}</code></p>
                    {wechatDraftReceipt.sent_at ? <p className="mt-1 text-xs text-muted-foreground">Sent {new Date(String(wechatDraftReceipt.sent_at)).toLocaleString()}</p> : null}
                  </div>
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
                <DialogTitle>{htmlPreviewTitle}</DialogTitle>
                <p className="mt-1 text-xs text-muted-foreground">{htmlPreviewDescription}</p>
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
