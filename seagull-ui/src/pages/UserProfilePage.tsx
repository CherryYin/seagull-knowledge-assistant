import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Brain, Clock, History, MessageCircle, RefreshCw, Rocket, Sparkles, Target, TrendingUp, UserRound, WandSparkles } from "lucide-react";
import { authApi, type UserActivityRecord, type UserMemoryRecord, type UserProfileDepth, type UserProfileValue } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { ModuleSectionNav } from "@/components/SectionNav";

const PROFILE_QUERY_KEY = ["user-profile"] as const;
const PROFILE_RECORDS_QUERY_KEY = ["profile-records"] as const;
const USER_ACTIVITY_QUERY_KEY = ["user-activity"] as const;

const DEPTH_LABELS: Record<string, string> = {
  beginner: "Beginner",
  intermediate: "Intermediate",
  advanced: "Advanced",
};

const BEHAVIOR_LABELS: Array<{
  key: keyof NonNullable<UserProfileValue["behavior"]>;
  label: string;
  icon: typeof Target;
}> = [
  { key: "primary_usage", label: "Primary Usage", icon: Target },
  { key: "active_hours", label: "Active Hours", icon: Clock },
  { key: "content_preference", label: "Content Preference", icon: Brain },
  { key: "interaction_style", label: "Interaction Style", icon: MessageCircle },
];

function formatDepth(depth: UserProfileDepth | undefined) {
  if (!depth) return "Unknown";
  return DEPTH_LABELS[depth] ?? depth;
}

function depthClassName(depth: UserProfileDepth | undefined) {
  if (depth === "advanced") return "bg-emerald-500/15 text-emerald-700";
  if (depth === "intermediate") return "bg-amber-500/15 text-amber-700";
  if (depth === "beginner") return "bg-blue-500/15 text-blue-700";
  return "bg-secondary text-secondary-foreground";
}

function profileRecordTypeLabel(recordType: string) {
  if (recordType === "profile") return "Profile Fact";
  if (recordType === "preference") return "Preference";
  if (recordType === "activity_profile") return "Profile Signal";
  if (recordType === "production_memory") return "Production History";
  return recordType;
}

function isNotFound(error: unknown) {
  return error instanceof Error && error.message.startsWith("404:");
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

function isProductionEvent(value: unknown): value is ProductionEvent {
  return Boolean(value && typeof value === "object");
}

function toProductionEvents(profileRecords: UserMemoryRecord[]): ProductionEvent[] {
  return profileRecords
    .filter((item) => item.memory_type === "production_memory")
    .flatMap((item) => {
      const events = (item.value as { events?: unknown[] } | undefined)?.events;
      if (!Array.isArray(events)) return [];
      return events.filter(isProductionEvent);
    })
    .sort((a, b) => String(b.timestamp || "").localeCompare(String(a.timestamp || "")));
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

export function UserProfilePage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const profileQuery = useQuery({
    queryKey: PROFILE_QUERY_KEY,
    queryFn: authApi.getMyProfile,
    retry: (failureCount, error) => !isNotFound(error) && failureCount < 2,
  });
  const profileRecordsQuery = useQuery({
    queryKey: PROFILE_RECORDS_QUERY_KEY,
    queryFn: () => authApi.listMyMemories(),
  });
  const activityQuery = useQuery({
    queryKey: USER_ACTIVITY_QUERY_KEY,
    queryFn: () => authApi.listMyActivity({ limit: 20 }),
  });

  const generateMutation = useMutation({
    mutationFn: authApi.generateMyProfile,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: PROFILE_QUERY_KEY }),
  });
  const updateProfileRecordMutation = useMutation({
    mutationFn: ({ key, memory_type, value }: { key: string; memory_type: string; value: Record<string, unknown> }) =>
      authApi.updateMyMemory(key, { memory_type, value }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: PROFILE_RECORDS_QUERY_KEY });
      queryClient.invalidateQueries({ queryKey: PROFILE_QUERY_KEY });
    },
  });

  const profile = profileQuery.data?.value;
  const profileRecords = profileRecordsQuery.data ?? [];
  const explicitProfileRecords = profileRecords.filter((item) => item.memory_type === "profile" || item.memory_type === "preference");
  const profileSignalRecords = profileRecords.filter((item) => item.memory_type === "activity_profile");
  const productionEvents = useMemo(() => toProductionEvents(profileRecords), [profileRecords]);
  const activityItems = activityQuery.data ?? [];
  const hasProfile = Boolean(profile && Object.keys(profile).length > 0);
  const showEmptyState = !profileQuery.isLoading && (!hasProfile || isNotFound(profileQuery.error));

	return (
		<div className="h-full overflow-y-auto p-6">
			<div className="mx-auto max-w-5xl space-y-6">
				<ModuleSectionNav parent="settings" active="Profile" />
				<div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="text-xl font-semibold">User Profile</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              AI-inferred traits from your recent notes, sources, searches, and chats.
            </p>
          </div>
          <Button
            onClick={() => generateMutation.mutate()}
            disabled={generateMutation.isPending}
            size="sm"
          >
            <RefreshCw className={cn("h-4 w-4", generateMutation.isPending && "animate-spin")} />
            {generateMutation.isPending ? "Generating..." : "Regenerate"}
          </Button>
        </div>

        {profileQuery.isLoading && (
          <Card>
            <CardContent className="p-6 text-sm text-muted-foreground">Loading profile...</CardContent>
          </Card>
        )}

        {showEmptyState && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Sparkles className="h-5 w-5 text-primary" />
                No profile yet
              </CardTitle>
              <CardDescription>
                Generate a profile after you have at least a few notes, sources, searches, or chats.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <p className="text-sm text-muted-foreground">
                The profile stores explicit Profile Facts, Preferences, and revisable Profile Signals so
                the agent can adapt without treating profile data as factual knowledge evidence.
              </p>
              <Button
                onClick={() => generateMutation.mutate()}
                disabled={generateMutation.isPending}
                size="sm"
              >
                <Sparkles className="h-4 w-4" />
                Generate Profile
              </Button>
            </CardContent>
          </Card>
        )}

        {generateMutation.error && (
          <Card className="border-destructive/30">
            <CardContent className="p-4 text-sm text-destructive">
              {generateMutation.error instanceof Error
                ? generateMutation.error.message
                : "Failed to generate profile"}
            </CardContent>
          </Card>
        )}

        {hasProfile && profile && (
          <div className="space-y-6">
            <ProfileLayersOverviewCard
              explicitCount={explicitProfileRecords.length}
              activityCount={profileSignalRecords.length}
              productionCount={productionEvents.length}
            />
            <SummaryCard profile={profile} updatedAt={profileQuery.data?.updated_at} />
            <ProductionHistoryCard
              events={productionEvents}
              onAskAgent={() =>
                navigate("/chat", {
                  state: {
                    objectRef: {
                      object_type: "production_history",
                      object_id: "production_memory",
                      title: "Production History",
                    },
                    workflowId: "production-retrospective",
                    promptSeed: "Review my recent production history, including generated, exported, published, and feedback events. Identify what is working, what is weak, and what I should produce next.",
                  },
                })
              }
            />
            <ProductionSignalsCard profile={profile} events={productionEvents} />
            <div className="grid gap-6 lg:grid-cols-[1.25fr_0.75fr]">
              <InterestsCard profile={profile} />
              <KnowledgeLevelCard profile={profile} />
            </div>
            <BehaviorCard profile={profile} />
            <ProfileExplainabilityCard profile={profile} />
            <div className="grid gap-6 lg:grid-cols-2">
              <ProfileRecordListCard
                title="Profile Facts & Preferences"
                description="These are user-saved settings or self-declared preferences. They should outweigh inferred signals."
                icon={UserRound}
                items={explicitProfileRecords}
                emptyLabel="No explicit Profile Facts or Preferences yet."
                onUpdateProfileRecordType={(key, memory_type, value) => updateProfileRecordMutation.mutate({ key, memory_type, value })}
                isUpdating={updateProfileRecordMutation.isPending}
              />
              <ProfileRecordListCard
                title="Inferred Profile Signals"
                description="These are inferred from usage activity. Treat them as weak signals, not hard instructions."
                icon={WandSparkles}
                items={profileSignalRecords}
                emptyLabel="No activity-derived profile signals yet."
                onUpdateProfileRecordType={(key, memory_type, value) => updateProfileRecordMutation.mutate({ key, memory_type, value })}
                isUpdating={updateProfileRecordMutation.isPending}
              />
            </div>
            <ActivitySignalsCard items={activityItems} profileSignalRecords={profileSignalRecords} />
          </div>
        )}
      </div>
    </div>
  );
}

function ProfileExplainabilityCard({ profile }: { profile: UserProfileValue }) {
  const explanations = profile._explanations ?? {};
  const entries = Object.entries(explanations);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Why This Profile Was Inferred</CardTitle>
        <CardDescription>
          Field-level explanation links activity signals to inferred profile fields.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {entries.length === 0 ? (
          <p className="text-sm text-muted-foreground">No explainability data available yet.</p>
        ) : (
          <div className="grid gap-4 lg:grid-cols-2">
            {entries.map(([field, info]) => (
              <div key={field} className="rounded-lg border border-border p-4">
                <div className="font-medium capitalize">{field.replace(/_/g, " ")}</div>
                <p className="mt-2 text-sm text-muted-foreground">{info.reason || "No reason recorded."}</p>
                <div className="mt-3 flex flex-wrap gap-2">
                  {(info.signals ?? []).map((signal) => (
                    <Badge key={signal} variant="outline">{signal}</Badge>
                  ))}
                </div>
                {(info.items?.length ?? 0) > 0 && (
                  <div className="mt-4 space-y-3 border-t border-border pt-4">
                    {info.items?.map((item, index) => (
                      <div key={`${field}-${item.value || index}`} className="rounded-md bg-muted/40 p-3">
                        <div className="text-sm font-medium">{item.value || `Item ${index + 1}`}</div>
                        <p className="mt-1 text-xs text-muted-foreground">{item.reason || "No item-level reason recorded."}</p>
                        <div className="mt-2 flex flex-wrap gap-2">
                          {(item.signals ?? []).map((signal) => (
                            <Badge key={`${field}-${item.value}-${signal}`} variant="secondary">{signal}</Badge>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function ActivitySignalsCard({
  items,
  profileSignalRecords,
}: {
  items: UserActivityRecord[];
  profileSignalRecords: UserMemoryRecord[];
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <History className="h-5 w-5 text-primary" />
          Profile Signal Evidence
        </CardTitle>
        <CardDescription>
          This view connects recent activity logs with inferred Profile Signals so users can inspect why the profile changed.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="grid gap-4 lg:grid-cols-2">
          <div className="space-y-3">
            <h3 className="text-sm font-semibold">Recent Activity Signals</h3>
            {items.length === 0 ? (
              <p className="text-sm text-muted-foreground">No recent activity available.</p>
            ) : (
              items.map((item) => (
                <div key={item.id} className="rounded-lg border border-border p-3">
                  <div className="flex items-center justify-between gap-3">
                    <div className="font-medium">{item.action}</div>
                    <div className="text-xs text-muted-foreground">
                      {new Date(item.created_at).toLocaleString()}
                    </div>
                  </div>
                  {item.detail && (
                    <pre className="mt-2 overflow-x-auto whitespace-pre-wrap text-xs leading-6 text-muted-foreground">
                      {JSON.stringify(item.detail, null, 2)}
                    </pre>
                  )}
                </div>
              ))
            )}
          </div>
          <div className="space-y-3">
            <h3 className="text-sm font-semibold">Inferred Profile Signals</h3>
            {profileSignalRecords.length === 0 ? (
              <p className="text-sm text-muted-foreground">No inferred Profile Signals available.</p>
            ) : (
              profileSignalRecords.map((item) => (
                <div key={`${item.memory_type}-${item.key}`} className="rounded-lg border border-border p-3">
                  <div className="font-medium">{item.key}</div>
                  <div className="mt-1 text-xs text-muted-foreground">{item.memory_type}</div>
                  <pre className="mt-2 overflow-x-auto whitespace-pre-wrap text-xs leading-6 text-muted-foreground">
                    {JSON.stringify(item.value, null, 2)}
                  </pre>
                </div>
              ))
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function ProfileLayersOverviewCard({
  explicitCount,
  activityCount,
  productionCount,
}: {
  explicitCount: number;
  activityCount: number;
  productionCount: number;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>User Profile Layers</CardTitle>
        <CardDescription>
          Profile data is separated into explicit facts and preferences, inferred signals, and Asset activity history.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3 sm:grid-cols-3">
        <div className="rounded-lg border border-border p-4">
          <div className="text-sm font-medium">Profile Facts / Preferences</div>
          <p className="mt-1 text-2xl font-semibold">{explicitCount}</p>
          <p className="mt-2 text-sm text-muted-foreground">User-provided or explicitly saved context.</p>
        </div>
        <div className="rounded-lg border border-border p-4">
          <div className="text-sm font-medium">Profile Signals</div>
          <p className="mt-1 text-2xl font-semibold">{activityCount}</p>
          <p className="mt-2 text-sm text-muted-foreground">Inferred from searches, notes, sources, and chats.</p>
        </div>
        <div className="rounded-lg border border-border p-4">
          <div className="text-sm font-medium">Production History</div>
          <p className="mt-1 text-2xl font-semibold">{productionCount}</p>
          <p className="mt-2 text-sm text-muted-foreground">Timeline of generation, export, publish, and feedback events.</p>
        </div>
      </CardContent>
    </Card>
  );
}

function ProductionHistoryCard({ events, onAskAgent }: { events: ProductionEvent[]; onAskAgent: () => void }) {
  const recentEvents = events.slice(0, 8);
  const eventCounts = useMemo(() => {
    return events.reduce<Record<string, number>>((acc, event) => {
      const key = String(event.event_type || "unknown");
      acc[key] = (acc[key] ?? 0) + 1;
      return acc;
    }, {});
  }, [events]);

  const topEventTypes = Object.entries(eventCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4);

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Rocket className="h-5 w-5 text-primary" />
              Production History
            </CardTitle>
            <CardDescription>
              Recent production events captured from asset generation, export, publishing, and feedback.
            </CardDescription>
          </div>
          <Button size="sm" variant="outline" onClick={onAskAgent}>
            <WandSparkles className="h-4 w-4" /> Retrospective Workflow
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {topEventTypes.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground sm:col-span-2 lg:col-span-4">
              No production history yet. Generate or publish an Asset to start building the activity timeline.
            </div>
          ) : (
            topEventTypes.map(([eventType, count]) => (
              <div key={eventType} className="rounded-lg border border-border p-4">
                <div className="text-sm font-medium">{formatProductionEventType(eventType)}</div>
                <p className="mt-1 text-2xl font-semibold">{count}</p>
              </div>
            ))
          )}
        </div>

        {recentEvents.length > 0 && (
          <div className="space-y-3">
            <h3 className="text-sm font-semibold">Recent Timeline</h3>
            {recentEvents.map((event, index) => (
              <div key={`${event.asset_id || "asset"}-${event.timestamp || index}-${event.event_type || "event"}`} className="rounded-lg border border-border p-4">
                {(() => {
                  const meta = productionEventMeta(event);
                  return (
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
                    {meta.length > 0 && (
                      <div className="flex flex-wrap gap-2 pt-1">
                        {meta.map((item) => (
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
                  );
                })()}
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function ProductionSignalsCard({ profile, events }: { profile: UserProfileValue; events: ProductionEvent[] }) {
  const behaviorSignals = profile._explanations?.behavior?.signals ?? [];
  const productionSignals = behaviorSignals.filter((signal) => signal.startsWith("production_"));

  const topChannels = Array.from(
    new Set(
      events
        .map((event) => (typeof event.detail?.channel === "string" ? event.detail.channel : ""))
        .filter(Boolean),
    ),
  ).slice(0, 4);

  const topAssetTypes = Array.from(
    new Set(events.map((event) => event.asset_type).filter(Boolean) as string[]),
  ).slice(0, 4);

  const publishedCount = events.filter((event) => event.event_type === "asset_published").length;
  const exportedCount = events.filter((event) => event.event_type === "asset_exported").length;

  if (events.length === 0 && productionSignals.length === 0) {
    return null;
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Rocket className="h-5 w-5 text-primary" />
          Production Signals
        </CardTitle>
        <CardDescription>
          These signals come from what you actually generate, export, publish, and revise.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="rounded-lg border border-border p-4">
            <div className="text-sm font-medium">Published</div>
            <p className="mt-1 text-2xl font-semibold">{publishedCount}</p>
          </div>
          <div className="rounded-lg border border-border p-4">
            <div className="text-sm font-medium">Exported</div>
            <p className="mt-1 text-2xl font-semibold">{exportedCount}</p>
          </div>
          <div className="rounded-lg border border-border p-4">
            <div className="text-sm font-medium">Production Events</div>
            <p className="mt-1 text-2xl font-semibold">{events.length}</p>
          </div>
        </div>

        {topAssetTypes.length > 0 && (
          <div>
            <h3 className="text-sm font-semibold">Frequent Asset Types</h3>
            <div className="mt-2 flex flex-wrap gap-2">
              {topAssetTypes.map((item) => (
                <Badge key={item} variant="secondary">{item}</Badge>
              ))}
            </div>
          </div>
        )}

        {topChannels.length > 0 && (
          <div>
            <h3 className="text-sm font-semibold">Active Channels</h3>
            <div className="mt-2 flex flex-wrap gap-2">
              {topChannels.map((item) => (
                <Badge key={item} variant="outline">{item}</Badge>
              ))}
            </div>
          </div>
        )}

        {productionSignals.length > 0 && (
          <div>
            <h3 className="text-sm font-semibold">Profile-Level Evidence</h3>
            <div className="mt-2 flex flex-wrap gap-2">
              {productionSignals.map((signal) => (
                <Badge key={signal} variant="outline">{signal.replace(/^production_/, "")}</Badge>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function ProfileRecordListCard({
  title,
  description,
  icon: Icon,
  items,
  emptyLabel,
  onUpdateProfileRecordType,
  isUpdating,
}: {
  title: string;
  description: string;
  icon: typeof Brain;
  items: UserMemoryRecord[];
  emptyLabel: string;
  onUpdateProfileRecordType: (key: string, profileRecordType: string, value: Record<string, unknown>) => void;
  isUpdating: boolean;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Icon className="h-5 w-5 text-primary" />
          {title}
        </CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>
        {items.length === 0 ? (
          <p className="text-sm text-muted-foreground">{emptyLabel}</p>
        ) : (
          <div className="space-y-3">
            {items.map((item) => (
              <ProfileRecordItemCard
                key={`${item.memory_type}-${item.key}`}
                item={item}
                onUpdateProfileRecordType={onUpdateProfileRecordType}
                isUpdating={isUpdating}
              />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function ProfileRecordItemCard({
  item,
  onUpdateProfileRecordType,
  isUpdating,
}: {
  item: UserMemoryRecord;
  onUpdateProfileRecordType: (key: string, profileRecordType: string, value: Record<string, unknown>) => void;
  isUpdating: boolean;
}) {
  const [profileRecordType, setProfileRecordType] = useState(item.memory_type);
  const changed = useMemo(() => profileRecordType !== item.memory_type, [profileRecordType, item.memory_type]);

  return (
    <div className="rounded-lg border border-border p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="font-medium">{item.key}</div>
          <div className="text-xs text-muted-foreground">Current type: {profileRecordTypeLabel(item.memory_type)}</div>
        </div>
        <Badge variant="outline">{new Date(item.updated_at).toLocaleDateString()}</Badge>
      </div>
      <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center">
        <label className="text-xs text-muted-foreground" htmlFor={`memory-type-${item.key}`}>
          Profile record type
        </label>
        <select
          id={`memory-type-${item.key}`}
          value={profileRecordType}
          onChange={(event) => setProfileRecordType(event.target.value)}
          className="h-9 rounded-md border border-border bg-background px-3 text-sm"
          disabled={isUpdating}
        >
          <option value="profile">Profile Fact</option>
          <option value="preference">Preference</option>
          <option value="activity_profile">Profile Signal</option>
        </select>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={!changed || isUpdating}
          onClick={() => onUpdateProfileRecordType(item.key, profileRecordType, item.value)}
        >
          Save Type
        </Button>
      </div>
      <pre className="mt-3 overflow-x-auto whitespace-pre-wrap text-xs leading-6 text-muted-foreground">
        {JSON.stringify(item.value, null, 2)}
      </pre>
    </div>
  );
}

function SummaryCard({ profile, updatedAt }: { profile: UserProfileValue; updatedAt?: string }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Sparkles className="h-5 w-5 text-primary" />
          Summary
        </CardTitle>
        {updatedAt && (
          <CardDescription>Updated {new Date(updatedAt).toLocaleString()}</CardDescription>
        )}
      </CardHeader>
      <CardContent>
        <p className="text-base leading-7">{profile.summary || "No summary available yet."}</p>
      </CardContent>
    </Card>
  );
}

function InterestsCard({ profile }: { profile: UserProfileValue }) {
  const interests = profile.interests ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Target className="h-5 w-5 text-primary" />
          Interests
        </CardTitle>
        <CardDescription>Domains and recent focus inferred from your activity.</CardDescription>
      </CardHeader>
      <CardContent>
        {interests.length === 0 ? (
          <p className="text-sm text-muted-foreground">No interest signals available.</p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {interests.map((interest, index) => (
              <div key={`${interest.domain}-${index}`} className="rounded-lg border border-border p-4">
                <div className="flex items-start justify-between gap-3">
                  <h3 className="font-medium">{interest.domain}</h3>
                  <Badge className={depthClassName(interest.depth)}>{formatDepth(interest.depth)}</Badge>
                </div>
                <p className="mt-2 text-sm leading-6 text-muted-foreground">
                  {interest.recent_focus || "No recent focus recorded."}
                </p>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function KnowledgeLevelCard({ profile }: { profile: UserProfileValue }) {
  const levels = Object.entries(profile.knowledge_level ?? {});

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <TrendingUp className="h-5 w-5 text-primary" />
          Knowledge Level
        </CardTitle>
        <CardDescription>Estimated familiarity by domain.</CardDescription>
      </CardHeader>
      <CardContent>
        {levels.length === 0 ? (
          <p className="text-sm text-muted-foreground">No knowledge level estimate available.</p>
        ) : (
          <div className="space-y-3">
            {levels.map(([domain, depth]) => (
              <div key={domain} className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2">
                <span className="text-sm font-medium">{domain}</span>
                <Badge className={depthClassName(depth)}>{formatDepth(depth)}</Badge>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function BehaviorCard({ profile }: { profile: UserProfileValue }) {
  const behavior = profile.behavior ?? {};

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Brain className="h-5 w-5 text-primary" />
          Behavior Preferences
        </CardTitle>
        <CardDescription>How the assistant should adapt to your working style.</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {BEHAVIOR_LABELS.map(({ key, label, icon: Icon }) => (
            <div key={key} className="rounded-lg border border-border p-4">
              <div className="flex items-center gap-2 text-sm font-medium">
                <Icon className="h-4 w-4 text-primary" />
                {label}
              </div>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">
                {behavior[key] || "Not enough data yet."}
              </p>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
