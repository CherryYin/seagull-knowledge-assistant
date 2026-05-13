import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Brain, Clock, MessageCircle, RefreshCw, Sparkles, Target, TrendingUp } from "lucide-react";
import { authApi, type UserProfileDepth, type UserProfileValue } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

const PROFILE_QUERY_KEY = ["user-profile"] as const;

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

function isNotFound(error: unknown) {
  return error instanceof Error && error.message.startsWith("404:");
}

export function UserProfilePage() {
  const queryClient = useQueryClient();
  const profileQuery = useQuery({
    queryKey: PROFILE_QUERY_KEY,
    queryFn: authApi.getMyProfile,
    retry: (failureCount, error) => !isNotFound(error) && failureCount < 2,
  });

  const generateMutation = useMutation({
    mutationFn: authApi.generateMyProfile,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: PROFILE_QUERY_KEY }),
  });

  const profile = profileQuery.data?.value;
  const hasProfile = Boolean(profile && Object.keys(profile).length > 0);
  const showEmptyState = !profileQuery.isLoading && (!hasProfile || isNotFound(profileQuery.error));

  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="mx-auto max-w-5xl space-y-6">
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
                The profile is stored in your personal memory and helps the agent adapt its answers to
                your interests and preferred interaction style.
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
            <SummaryCard profile={profile} updatedAt={profileQuery.data?.updated_at} />
            <div className="grid gap-6 lg:grid-cols-[1.25fr_0.75fr]">
              <InterestsCard profile={profile} />
              <KnowledgeLevelCard profile={profile} />
            </div>
            <BehaviorCard profile={profile} />
          </div>
        )}
      </div>
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
