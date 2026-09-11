import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, ArrowRight, BookOpen, FileText, NotebookPen, Sparkles } from "lucide-react";
import { useLocation, useNavigate } from "react-router-dom";
import { assetsApi, notesApi, sourcesApi, wikiApi } from "@/lib/api";
import { reviseAssetIntent } from "@/lib/api/assets";
import { buildAssetGenerationSeed, type AssetHandoffState } from "@/lib/asset-handoff";
import { MANUAL_ASSET_TYPES, type AssetGenerationRequest, type AssetIntentFormDraft, type AssetIntentProposal } from "@/lib/asset-generation";
import {
  clearAssetIntakeRecovery,
  createAssetIntakeOperationId,
  findAssetForIntakeOperation,
  hasCurrentEvidenceTarget,
  intentMatchesDraft,
  readAssetIntakeRecovery,
  writeAssetIntakeRecovery,
  type AssetIntakeRecovery,
} from "@/lib/asset-intake-recovery";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useReturnNavigation } from "@/hooks/useReturnNavigation";
import { useRouteScrollRestoration } from "@/hooks/useRouteScrollRestoration";

function toggle(values: string[], id: string) {
  return values.includes(id) ? values.filter((value) => value !== id) : [...values, id];
}

function parseLines(value: string) {
  return value.split(/\n|,/).map((item) => item.trim()).filter(Boolean);
}

function fillBlank(existing: string, proposed?: string) {
  return existing.trim() ? existing : proposed ?? existing;
}

export function AssetGenerationPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const navigationState = location.state as {
    assetHandoff?: AssetHandoffState;
    assetIntentDraft?: AssetIntentFormDraft;
    assetIntentProposal?: AssetIntentProposal;
    backTo?: string;
    backLabel?: string;
  } | null;
  const backTo = navigationState?.backTo || "/assets";
  const backLabel = navigationState?.backLabel || "Back to Assets";
  const returnToPrevious = useReturnNavigation(backTo, Boolean(navigationState));
  const { scrollRef, onScroll } = useRouteScrollRestoration<HTMLDivElement>("asset-generation");
  const recoveredIntake = useMemo(() => (
    navigationState?.assetHandoff || navigationState?.assetIntentDraft || navigationState?.assetIntentProposal
      ? null
      : readAssetIntakeRecovery()
  ), [navigationState]);
  const initialSeed = useMemo(() => buildAssetGenerationSeed(
    navigationState?.assetHandoff,
  ), [location.state]);
  const priorDraft = navigationState?.assetIntentDraft ?? recoveredIntake?.form;
  const intentProposal = navigationState?.assetIntentProposal;
  const [assetType, setAssetType] = useState(priorDraft?.assetType ?? initialSeed.assetType);
  const [title, setTitle] = useState(fillBlank(priorDraft?.title ?? initialSeed.title, intentProposal?.workingTitle));
  const [audience, setAudience] = useState(fillBlank(priorDraft?.audience ?? initialSeed.audience, intentProposal?.audience));
  const [question, setQuestion] = useState(fillBlank(priorDraft?.question ?? initialSeed.brief, intentProposal?.question));
  const [goal, setGoal] = useState(fillBlank(priorDraft?.goal ?? "", intentProposal?.goal));
  const [creationMode, setCreationMode] = useState<AssetGenerationRequest["creationMode"]>(priorDraft?.creationMode ?? intentProposal?.creationMode ?? "synthesize");
  const [scope, setScope] = useState(fillBlank(priorDraft?.scope ?? "", intentProposal?.scope.join("\n")));
  const [constraints, setConstraints] = useState(fillBlank(priorDraft?.constraints ?? "", intentProposal?.constraints.join("\n")));
  const [styleNotes, setStyleNotes] = useState(priorDraft?.styleNotes ?? initialSeed.styleNotes);
  const [sourceRefs, setSourceRefs] = useState<string[]>(priorDraft?.sourceRefs ?? initialSeed.sourceRefs);
  const [noteRefs, setNoteRefs] = useState<string[]>(priorDraft?.noteRefs ?? initialSeed.noteRefs);
  const [wikiRefs, setWikiRefs] = useState<string[]>(priorDraft?.wikiRefs ?? initialSeed.wikiRefs);
  const [allowWebResearch, setAllowWebResearch] = useState(priorDraft?.allowWebResearch ?? true);
  const [deliveryFormat, setDeliveryFormat] = useState<"markdown" | "html">(priorDraft?.deliveryFormat ?? "markdown");
  const [isStarting, setIsStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [intakeRecovery, setIntakeRecovery] = useState<AssetIntakeRecovery | null>(recoveredIntake);

  const sources = useQuery({ queryKey: ["asset-wizard-sources"], queryFn: () => sourcesApi.list({ limit: 50 }) });
  const notes = useQuery({ queryKey: ["asset-wizard-notes"], queryFn: () => notesApi.list({ status: "kept", limit: 50 }) });
  const wiki = useQuery({ queryKey: ["asset-wizard-wiki"], queryFn: () => wikiApi.list({ limit: 50 }) });
  const evidenceCount = sourceRefs.length + noteRefs.length + wikiRefs.length;
  const selectedType = useMemo(() => MANUAL_ASSET_TYPES.find((item) => item.value === assetType), [assetType]);
  const canContinue = Boolean(question.trim() && goal.trim());

  function currentDraft(): AssetIntentFormDraft {
    return {
      assetType,
      title,
      audience,
      question,
      goal,
      creationMode,
      scope,
      constraints,
      styleNotes,
      sourceRefs,
      noteRefs,
      wikiRefs,
      allowWebResearch,
      deliveryFormat,
    };
  }

  function persistIntakeRecovery(recovery: Omit<AssetIntakeRecovery, "version" | "updatedAt">) {
    const stored = writeAssetIntakeRecovery(recovery);
    setIntakeRecovery(stored);
    return stored;
  }

  function discussIntentWithAgent() {
    const assetIntentDraft = currentDraft();
    const partialIntent = [
      `Asset type: ${selectedType?.label ?? assetType}`,
      title.trim() ? `Working title: ${title.trim()}` : "Working title: not provided",
      question.trim() ? `Current question: ${question.trim()}` : "Current question: not provided",
      goal.trim() ? `Current goal: ${goal.trim()}` : "Current goal: not provided",
      audience.trim() ? `Audience: ${audience.trim()}` : "Audience: not provided",
      `Creation mode: ${creationMode}`,
      `Scope: ${parseLines(scope).join(", ") || "not provided"}`,
      `Constraints: ${parseLines(constraints).join("; ") || "not provided"}`,
      `Selected evidence: ${evidenceCount} records`,
      `Delivery format: ${deliveryFormat === "html" ? "HTML" : "Markdown"}`,
    ].join("\n");
    navigate("/chat", {
      state: {
        workflowId: "clarify-asset-intent",
        promptSeed: `The Asset Intent is not confirmed yet. Help me clarify it without creating an Asset or treating Agent recommendations as my decisions.\n\n${partialIntent}`,
        assetIntentDraft,
        backTo: `${location.pathname}${location.search}`,
        backLabel: "Back to Asset Generation",
      },
    });
  }

  async function startGeneration() {
    if (!canContinue) return;
    setIsStarting(true);
    setStartError(null);
    let progress: "prepared" | "asset_saved" | "intent_saved" = "prepared";
    const isRetry = Boolean(intakeRecovery);
    let recovery = persistIntakeRecovery({
      operationId: intakeRecovery?.operationId ?? createAssetIntakeOperationId(),
      assetId: intakeRecovery?.assetId,
      form: currentDraft(),
    });
    try {
      const confirmedQuestion = question.trim();
      const confirmedGoal = goal.trim();
      const workingTitle = title.trim() || confirmedQuestion.slice(0, 100);
      let asset = recovery.assetId ? await assetsApi.get(recovery.assetId) : null;
      if (!asset && isRetry) {
        const existingAssets = await assetsApi.list({ limit: 200 });
        asset = findAssetForIntakeOperation(existingAssets.items, recovery.operationId);
      }
      if (!asset) {
        asset = await assetsApi.create({
          title: workingTitle,
          brief: confirmedGoal,
          asset_type: assetType,
          status: "draft",
          source_refs: sourceRefs,
          note_refs: noteRefs,
          wiki_refs: wikiRefs,
          style_notes: styleNotes.trim() || undefined,
          metadata: {
            audience: audience.trim() || null,
            generation_mode: "agent_assisted",
            research_mode: allowWebResearch ? "local_then_web" : "local_only",
            delivery_format: deliveryFormat,
            intake_operation_id: recovery.operationId,
          },
          provenance: { origin_type: "user", action: "save" },
        });
      }
      progress = "asset_saved";
      recovery = persistIntakeRecovery({ ...recovery, assetId: asset.id, form: currentDraft() });
      let workspace = await assetsApi.getWorkspace(asset.id);
      const intentDraft = {
        base_workspace_revision: workspace.workspace_revision,
        question: confirmedQuestion,
        goal: confirmedGoal,
        audience: audience.trim() || null,
        creation_mode: creationMode,
        scope: parseLines(scope),
        constraints: parseLines(constraints),
      };
      if (!isRetry || !intentMatchesDraft(workspace.intent, intentDraft)) {
        workspace = await reviseAssetIntent(asset.id, intentDraft);
      }
      progress = "intent_saved";
      const evidenceSeeds = [
        ...sourceRefs.map((targetId) => ({
          target_type: "source" as const,
          target_id: targetId,
          relation: "context" as const,
          summary: `Selected during Asset intake: ${sources.data?.items.find((item) => item.id === targetId)?.title ?? targetId}. Review its relevance to the confirmed Intent.`,
        })),
        ...noteRefs.map((targetId) => ({
          target_type: "note" as const,
          target_id: targetId,
          relation: "context" as const,
          summary: `Selected during Asset intake: ${notes.data?.items.find((item) => item.id === targetId)?.title ?? targetId}. Review its relevance to the confirmed Intent.`,
        })),
        ...wikiRefs.map((targetId) => ({
          target_type: "wiki" as const,
          target_id: targetId,
          relation: "context" as const,
          summary: `Selected during Asset intake: ${wiki.data?.items.find((item) => item.id === targetId)?.title ?? targetId}. Review its relevance to the confirmed Intent.`,
        })),
      ];
      const missingEvidenceSeeds = isRetry
        ? evidenceSeeds.filter((proposal) => !hasCurrentEvidenceTarget(workspace, proposal))
        : evidenceSeeds;
      if (missingEvidenceSeeds.length > 0) {
        workspace = await assetsApi.proposeEvidence(asset.id, {
          base_workspace_revision: workspace.workspace_revision,
          proposals: missingEvidenceSeeds,
        });
      }
      clearAssetIntakeRecovery();
      setIntakeRecovery(null);
      navigate(`/assets/${encodeURIComponent(asset.id)}?tab=evidence`, {
        state: {
          backTo,
          backLabel,
          stageNotice: evidenceSeeds.length > 0
            ? "The selected records are now Evidence candidates. Review them before generating Claims."
            : "Intent confirmed. Collect and accept Evidence before generating Claims.",
        },
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : "Could not initialize the Asset workspace.";
      setStartError(progress === "prepared"
        ? `Asset creation was not confirmed. Retry will look for the same operation before creating anything. ${detail}`
        : progress === "asset_saved"
          ? `The Asset draft is saved${recovery.assetId ? ` as ${recovery.assetId}` : ""}, but its Intent is not confirmed yet. Retry continues this Asset. ${detail}`
          : `The Asset and Intent are saved${recovery.assetId ? ` as ${recovery.assetId}` : ""}, but Evidence candidates were not fully confirmed. Retry only adds missing candidates. ${detail}`);
    } finally {
      setIsStarting(false);
    }
  }

  return (
    <div
      ref={scrollRef}
      onScroll={onScroll}
      className="h-full overflow-y-auto"
      data-route-scroll="asset-generation"
    >
      <div className="mx-auto max-w-5xl space-y-6 px-6 py-8">
        <div>
          <Button variant="ghost" size="sm" className="mb-3 -ml-2" onClick={returnToPrevious}>
            <ArrowLeft className="mr-2 h-4 w-4" />{backLabel}
          </Button>
          <div className="flex items-start gap-4">
            <div className="rounded-2xl bg-primary/10 p-3 text-primary"><Sparkles className="h-6 w-6" /></div>
            <div>
              <h1 className="text-3xl font-semibold tracking-tight">Create an Asset</h1>
              <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">
                Confirm the question and goal first. The Agent can recommend changes, but only you can revise the stored Intent.
              </p>
            </div>
          </div>
        </div>

        <Card>
          <CardHeader><CardTitle>1. Choose the deliverable</CardTitle><CardDescription>Newsletter automation is intentionally deferred.</CardDescription></CardHeader>
          <CardContent className="grid gap-3 md:grid-cols-2">
            {MANUAL_ASSET_TYPES.map((item) => (
              <button key={item.value} type="button" onClick={() => setAssetType(item.value)} className={`rounded-xl border p-4 text-left transition-colors ${assetType === item.value ? "border-primary bg-primary/5" : "hover:border-primary/40"}`}>
                <p className="font-medium">{item.label}</p><p className="mt-1 text-sm text-muted-foreground">{item.description}</p>
              </button>
            ))}
          </CardContent>
        </Card>

        {intakeRecovery && (
          <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm">
            <p className="font-medium">Unfinished Asset setup recovered</p>
            <p className="mt-1 text-muted-foreground">
              Retry continues the same operation{intakeRecovery.assetId ? ` and Asset ${intakeRecovery.assetId}` : ""}; it does not intentionally create a duplicate.
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              {intakeRecovery.assetId && (
                <Button type="button" size="sm" variant="outline" onClick={() => navigate(`/assets/${encodeURIComponent(intakeRecovery.assetId!)}?tab=evidence`)}>
                  Open saved Asset
                </Button>
              )}
              <Button type="button" size="sm" variant="ghost" onClick={() => {
                clearAssetIntakeRecovery();
                setIntakeRecovery(null);
                setStartError(null);
              }}>
                Dismiss recovery
              </Button>
            </div>
          </div>
        )}

        <Card>
          <CardHeader><CardTitle>2. Confirm the Intent</CardTitle><CardDescription>Question and goal are required because they anchor later Evidence and Claims.</CardDescription></CardHeader>
          <CardContent className="space-y-4">
            {intentProposal && <p className="rounded-lg border border-primary/20 bg-primary/5 px-3 py-2 text-sm text-primary">Agent proposal applied to previously blank fields. Review every field before confirming Intent.</p>}
            <Input aria-label="Asset title" placeholder="Optional working title" value={title} onChange={(event) => setTitle(event.target.value)} />
            <Input aria-label="Target audience" placeholder="Optional target audience" value={audience} onChange={(event) => setAudience(event.target.value)} />
            <Textarea aria-label="Research question" placeholder="What question should this Asset answer?" rows={3} value={question} onChange={(event) => setQuestion(event.target.value)} />
            <Textarea aria-label="Asset goal" placeholder="What decision, understanding, or deliverable should this work support?" rows={3} value={goal} onChange={(event) => setGoal(event.target.value)} />
            <select aria-label="Creation mode" className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm" value={creationMode} onChange={(event) => setCreationMode(event.target.value as AssetGenerationRequest["creationMode"])}>
              <option value="understand">Understand</option><option value="synthesize">Synthesize</option><option value="make_decision">Make a Decision</option><option value="produce">Produce</option>
            </select>
            <div className="space-y-2">
              <select aria-label="Delivery format" className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm" value={deliveryFormat} onChange={(event) => setDeliveryFormat(event.target.value as "markdown" | "html")}>
                <option value="markdown">Markdown delivery</option>
                <option value="html">HTML delivery</option>
              </select>
              <p className="text-xs text-muted-foreground">The Asset remains editable Markdown. HTML is generated safely during preview or export.</p>
            </div>
            <div className="grid gap-4 md:grid-cols-2">
              <Textarea aria-label="Intent scope" placeholder="Scope, one item per line" rows={3} value={scope} onChange={(event) => setScope(event.target.value)} />
              <Textarea aria-label="Intent constraints" placeholder="Constraints, one item per line" rows={3} value={constraints} onChange={(event) => setConstraints(event.target.value)} />
            </div>
            <Textarea aria-label="Style guidance" placeholder="Optional style, tone, or structure guidance" rows={3} value={styleNotes} onChange={(event) => setStyleNotes(event.target.value)} />
            <label className="flex items-start gap-3 rounded-xl border p-4 text-sm">
              <input type="checkbox" className="mt-1" checked={allowWebResearch} onChange={(event) => setAllowWebResearch(event.target.checked)} />
              <span><span className="block font-medium">Include focused web research</span><span className="mt-1 block text-muted-foreground">After searching PKG, the Agent must run at least one web search for a concrete freshness or evidence gap. Network evidence remains separate from local knowledge.</span></span>
            </label>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>3. Add optional seed evidence</CardTitle><CardDescription>You no longer need to find everything yourself. Selected records are guaranteed starting points; the Agent searches for additional relevant PKG knowledge.</CardDescription></CardHeader>
          <CardContent className="grid gap-4 lg:grid-cols-3">
            <EvidenceColumn icon={<FileText className="h-4 w-4" />} title="Sources" items={(sources.data?.items ?? []).map((item) => ({ id: item.id, title: item.title, detail: item.source_type }))} selected={sourceRefs} onToggle={(id) => setSourceRefs((values) => toggle(values, id))} />
            <EvidenceColumn icon={<NotebookPen className="h-4 w-4" />} title="Notes" items={(notes.data?.items ?? []).map((item) => ({ id: item.id, title: item.title, detail: item.note_type }))} selected={noteRefs} onToggle={(id) => setNoteRefs((values) => toggle(values, id))} />
            <EvidenceColumn icon={<BookOpen className="h-4 w-4" />} title="Wiki" items={(wiki.data?.items ?? []).map((item) => ({ id: item.id, title: item.title, detail: item.page_type }))} selected={wikiRefs} onToggle={(id) => setWikiRefs((values) => toggle(values, id))} />
          </CardContent>
        </Card>

        <div className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border bg-card p-5">
          <div><p className="font-medium">{selectedType?.label}</p><p className="text-sm text-muted-foreground">{canContinue ? `Intent ready to confirm · ${evidenceCount} optional seed records` : "Intent not confirmed · you can ask the Agent for help before filling these fields"}</p>{startError && <p className="mt-1 text-sm text-destructive">{startError}</p>}</div>
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" onClick={discussIntentWithAgent} disabled={isStarting}>Discuss Intent with Agent</Button>
            <Button onClick={() => void startGeneration()} disabled={!canContinue || isStarting}>{isStarting ? "Creating Workspace…" : intakeRecovery || startError ? "Retry Asset setup" : "Confirm Intent & Review Evidence"}<ArrowRight className="ml-2 h-4 w-4" /></Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function EvidenceColumn({ icon, title, items, selected, onToggle }: { icon: React.ReactNode; title: string; items: Array<{ id: string; title: string; detail: string }>; selected: string[]; onToggle: (id: string) => void }) {
  return <div className="rounded-xl border p-3"><h3 className="mb-3 flex items-center gap-2 text-sm font-semibold">{icon}{title}</h3><div className="max-h-72 space-y-2 overflow-auto">{items.length === 0 && <p className="text-xs text-muted-foreground">No records available.</p>}{items.map((item) => <label key={item.id} className="flex cursor-pointer items-start gap-2 rounded-lg border p-2 text-sm hover:bg-muted/50"><input type="checkbox" className="mt-1" checked={selected.includes(item.id)} onChange={() => onToggle(item.id)} /><span className="min-w-0"><span className="block truncate font-medium">{item.title}</span><span className="text-xs text-muted-foreground">{item.detail}</span></span></label>)}</div></div>;
}
