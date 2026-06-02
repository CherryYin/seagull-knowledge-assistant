import { Settings2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

const rules = [
  "Prefer concise Markdown that can be reused in notes and drafts.",
  "Keep source-backed claims traceable to existing sources or notes.",
  "Agents should propose changes before applying them automatically.",
  "Use the user's profile to adapt summary depth, tone, and writing focus.",
  "Digest is recent signal; Writing is output; Notes and Sources remain canonical.",
];

export function WikiRulesPage() {
  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="mx-auto max-w-3xl space-y-5">
        <div>
          <div className="flex items-center gap-2 text-primary">
            <Settings2 className="h-5 w-5" />
            <span className="text-sm font-medium">Wiki Rules</span>
          </div>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight">Lightweight Wiki Rules</h1>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            These rules define the first version of the Wiki workspace. They are informational for now and can later move into user settings.
          </p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Operating Principles</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="space-y-3 text-sm text-muted-foreground">
              {rules.map((rule) => (
                <li key={rule} className="flex gap-3">
                  <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
                  <span>{rule}</span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
