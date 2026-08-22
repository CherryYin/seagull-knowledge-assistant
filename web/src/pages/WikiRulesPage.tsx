import { Settings2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { wikiTemplates } from "@/lib/wikiTemplates";

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
          <h1 className="mt-2 text-2xl font-semibold tracking-tight">Canonical Knowledge Page Rules</h1>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            These rules define what belongs in a canonical knowledge page, how page types differ, and what should be reviewed before a page is treated as stable.
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

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Page Type Templates</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-4 text-sm text-muted-foreground">
              {Object.entries(wikiTemplates).map(([pageType, template]) => (
                <div key={pageType} className="rounded-lg border p-4">
                  <p className="font-medium text-foreground">{template.label}</p>
                  <p className="mt-1">{template.description}</p>
                  <pre className="mt-3 overflow-x-auto rounded-md bg-muted/50 p-3 text-xs">{template.content}</pre>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Stable Acceptance</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="space-y-3 text-sm text-muted-foreground">
              <li className="flex gap-3"><span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" /><span>The page has a clear page type and follows that template’s structure.</span></li>
              <li className="flex gap-3"><span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" /><span>Important claims are backed by readable Source, Note, or Wiki references.</span></li>
              <li className="flex gap-3"><span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" /><span>Open questions stay explicit rather than being hidden inside confident prose.</span></li>
              <li className="flex gap-3"><span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" /><span>Draft or candidate pages should be reviewed before being treated as stable canonical knowledge.</span></li>
            </ul>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
