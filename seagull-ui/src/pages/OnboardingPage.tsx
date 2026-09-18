import { Compass, Sparkles } from "lucide-react";

import { ModuleTogglePanel } from "@/components/ModuleTogglePanel";

export function OnboardingPage() {
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex min-h-full max-w-5xl flex-col justify-center gap-6 px-6 py-10">
        <section className="rounded-3xl border bg-card p-6 shadow-sm">
          <div className="flex items-start gap-4">
            <div className="rounded-xl bg-primary/10 p-3 text-primary">
              <Compass className="h-6 w-6" />
            </div>
            <div>
              <div className="inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs text-muted-foreground">
                <Sparkles className="h-3.5 w-3.5" /> First-time setup
              </div>
              <h1 className="mt-3 text-3xl font-semibold tracking-tight">Choose your workspace mode</h1>
              <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground">
                Start with a focused workspace for notes, sources, search, review, and agent chat. You can enable advanced knowledge-graph and operations modules later in Settings.
              </p>
            </div>
          </div>
        </section>

        <ModuleTogglePanel />
      </div>
    </div>
  );
}
