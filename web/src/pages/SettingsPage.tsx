import { Link } from "react-router-dom";
import { BarChart3, Bot, Brain, MonitorCog, Settings, Shield, Zap } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/lib/auth";
import { SectionNav, settingsNavItems } from "@/components/SectionNav";

export function SettingsPage() {
  const { isAdmin } = useAuth();
	const items = [
		{ title: "User Profile", description: "Review the learned profile used to adapt answers.", to: "/settings/profile", icon: Brain },
		{ title: "Agent Profiles", description: "Configure how agents operate.", to: "/settings/agents", icon: Bot },
		{ title: "Skills", description: "Manage reusable chat skills.", to: "/settings/skills", icon: Zap },
		{ title: "Agent Workspace", description: "Inspect advanced agent runs and workspace data.", to: "/settings/workspace", icon: MonitorCog },
		{ title: "System Dashboard", description: "Inspect operational stats and knowledge rankings outside the daily Home workflow.", to: "/stats", icon: BarChart3 },
		...(isAdmin ? [{ title: "Admin Users", description: "Manage user approvals and roles.", to: "/admin/users", icon: Shield }] : []),
	];

	return (
		<div className="h-full overflow-y-auto">
			<div className="mx-auto max-w-5xl space-y-6 px-6 py-8">
				<SectionNav items={settingsNavItems} active="Settings" />
				<section className="rounded-3xl border bg-card p-6 shadow-sm">
          <div className="flex items-start gap-4">
            <div className="rounded-xl bg-primary/10 p-3 text-primary"><Settings className="h-6 w-6" /></div>
            <div>
              <h1 className="text-3xl font-semibold tracking-tight">Settings & Advanced</h1>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
                Configuration, advanced agent controls, skills, and admin tools live here so the main steward workflow stays focused.
              </p>
            </div>
          </div>
        </section>

        <div className="grid gap-4 md:grid-cols-2">
          {items.map(({ title, description, to, icon: Icon }) => (
            <Card key={title} className="transition-colors hover:border-primary/40">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base"><Icon className="h-4 w-4" /> {title}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <p className="text-sm text-muted-foreground">{description}</p>
                <Button asChild variant="outline" size="sm"><Link to={to}>Open</Link></Button>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    </div>
  );
}
