import {
  FlaskConical,
  BarChart3,
  Bell,
  Brain,
  BookOpen,
  CalendarCheck2,
  CalendarDays,
  Compass,
  FileText,
  Home,
  KeyRound,
  MessageSquare,
  Search,
  Settings,
  Sparkles,
  StickyNote,
  User,
  Users,
  Wrench,
  type LucideIcon,
} from "lucide-react";

export type ProductModuleGroup =
  | "daily"
  | "knowledge"
  | "refinement"
  | "discovery"
  | "agent"
  | "production"
  | "personalization"
  | "system";

export interface AppModuleConfig {
  id: string;
  label: string;
  group: ProductModuleGroup;
  route: string;
  icon: LucideIcon;
  description: string;
  nav?: {
    primary?: boolean;
    section?: boolean;
    order?: number;
    parent?: "knowledge" | "review" | "discover" | "settings";
  };
  visibility: {
    defaultEnabled: boolean;
    configurable: boolean;
    advanced?: boolean;
    adminOnly?: boolean;
    experimental?: boolean;
  };
  dependencies?: string[];
  settingsCard?: {
    title?: string;
    description?: string;
    order?: number;
  };
}

export const MODULE_GROUP_LABELS: Record<ProductModuleGroup, string> = {
  daily: "Home",
  knowledge: "Knowledge Foundation",
  refinement: "Inbox",
  discovery: "Discover",
  agent: "Agent",
  production: "Assets & Consumption",
  personalization: "Personalization",
  system: "Settings",
};

export const MODULE_GROUP_ORDER: ProductModuleGroup[] = [
  "daily",
  "knowledge",
  "production",
  "refinement",
  "discovery",
  "agent",
  "personalization",
  "system",
];

export const APP_MODULES: AppModuleConfig[] = [
  {
    id: "home",
    label: "Home",
    group: "daily",
    route: "/",
    icon: Home,
    description: "Main landing page.",
    nav: { primary: true, order: 10 },
    visibility: { defaultEnabled: true, configurable: false },
  },
  {
    id: "calendar",
    label: "Calendar",
    group: "daily",
    route: "/calendar",
    icon: CalendarDays,
    description: "Calendar reminders and daily planning.",
    nav: { primary: true, order: 20 },
    visibility: { defaultEnabled: false, configurable: true },
  },
  {
    id: "completed",
    label: "Completed",
    group: "daily",
    route: "/completed",
    icon: CalendarCheck2,
    description: "Completed tasks and historical activity.",
    nav: { primary: true, order: 30 },
    visibility: { defaultEnabled: false, configurable: true },
  },
  {
    id: "search",
    label: "Search",
    group: "knowledge",
    route: "/search",
    icon: Search,
    description: "Find Sources, Notes, Wiki Pages, and Assets across the knowledge lifecycle.",
    nav: { primary: true, section: true, parent: "knowledge", order: 10 },
    visibility: { defaultEnabled: true, configurable: false },
  },
  {
    id: "sources",
    label: "Sources",
    group: "knowledge",
    route: "/sources",
    icon: FileText,
    description: "Capture and manage raw evidence with provenance.",
    nav: { primary: true, section: true, parent: "knowledge", order: 20 },
    visibility: { defaultEnabled: true, configurable: false },
  },
  {
    id: "notes",
    label: "Notes",
    group: "knowledge",
    route: "/notes",
    icon: StickyNote,
    description: "Develop user-authored working knowledge from Sources and ideas.",
    nav: { primary: true, section: true, parent: "knowledge", order: 30 },
    visibility: { defaultEnabled: true, configurable: false },
  },
  {
    id: "documents",
    label: "Documents",
    group: "knowledge",
    route: "/documents",
    icon: BookOpen,
    description: "Legacy document surface.",
    nav: { primary: true, section: true, parent: "knowledge", order: 35 },
    visibility: { defaultEnabled: false, configurable: true, advanced: true },
  },
  {
    id: "wiki",
    label: "Wiki",
    group: "knowledge",
    route: "/wiki",
    icon: BookOpen,
    description: "Maintain durable syntheses with explicit Source and Note provenance.",
    nav: { primary: true, section: true, parent: "knowledge", order: 50 },
    visibility: { defaultEnabled: true, configurable: false },
    dependencies: ["sources", "notes"],
  },
  {
    id: "assets",
    label: "Assets",
    group: "production",
    route: "/assets",
    icon: FileText,
    description: "Edit, review, export, and publish writing deliverables.",
    nav: { primary: true, order: 10 },
    visibility: { defaultEnabled: true, configurable: false },
    dependencies: ["sources", "notes"],
  },
  {
    id: "review",
    label: "Inbox",
    group: "refinement",
    route: "/review",
    icon: Bell,
    description: "Confirm candidates and queued changes before they affect durable Knowledge Records or Profile Facts.",
    nav: { primary: true, section: true, parent: "review", order: 10 },
    visibility: { defaultEnabled: true, configurable: false },
  },
  {
    id: "digest-review",
    label: "Digest",
    group: "refinement",
    route: "/review/digest",
    icon: StickyNote,
    description: "Review and merge temporary digest notes.",
    nav: { section: true, parent: "review", order: 20 },
    visibility: { defaultEnabled: false, configurable: true, advanced: true },
    dependencies: ["review"],
  },
  {
    id: "wiki-review",
    label: "Wiki Review",
    group: "refinement",
    route: "/review/wiki-suggestions",
    icon: Bell,
    description: "Review wiki recompile suggestions.",
    nav: { section: true, parent: "review", order: 30 },
    visibility: { defaultEnabled: false, configurable: true, advanced: true },
    dependencies: ["wiki", "review"],
  },
  {
    id: "wiki-discovery",
    label: "Wiki Discovery",
    group: "refinement",
    route: "/wiki/discovery",
    icon: Sparkles,
    description: "Mine recent materials for wiki-worthy concepts.",
    nav: { section: true, parent: "review", order: 40 },
    visibility: { defaultEnabled: false, configurable: true, advanced: true, experimental: true },
    dependencies: ["wiki", "review"],
  },
  {
    id: "review-suggestions",
    label: "Suggestions",
    group: "refinement",
    route: "/review/suggestions",
    icon: Bell,
    description: "Review low-confidence Profile Fact and Preference suggestions.",
    nav: { section: true, parent: "review", order: 50 },
    visibility: { defaultEnabled: false, configurable: true, advanced: true },
    dependencies: ["review"],
  },
  {
    id: "wiki-rules",
    label: "Wiki Rules",
    group: "refinement",
    route: "/wiki/rules",
    icon: Wrench,
    description: "Advanced wiki configuration and rules.",
    visibility: { defaultEnabled: false, configurable: true, advanced: true },
    dependencies: ["wiki"],
  },
  {
    id: "discover",
    label: "Discover",
    group: "discovery",
    route: "/discover",
    icon: Compass,
    description: "Recommended knowledge candidates.",
    nav: { primary: true, section: true, parent: "discover", order: 10 },
    visibility: { defaultEnabled: true, configurable: false },
  },
  {
    id: "agent-chat",
    label: "Agent Chat",
    group: "agent",
    route: "/chat",
    icon: MessageSquare,
    description: "Conversational knowledge agent.",
    nav: { primary: true, order: 10 },
    visibility: { defaultEnabled: true, configurable: false },
  },
  {
    id: "agent-memory",
    label: "Agent Memory",
    group: "agent",
    route: "/agent-memory",
    icon: Brain,
    description: "Review and manage user-confirmed cross-session Agent Memory.",
    nav: { primary: true, order: 20 },
    visibility: { defaultEnabled: true, configurable: false },
  },
  {
    id: "settings",
    label: "Settings",
    group: "system",
    route: "/settings",
    icon: Settings,
    description: "Application settings.",
    nav: { primary: true, section: true, parent: "settings", order: 10 },
    visibility: { defaultEnabled: true, configurable: false },
  },
  {
    id: "api-keys",
    label: "API Keys",
    group: "personalization",
    route: "/settings/api-keys",
    icon: KeyRound,
    description: "Manage provider credentials.",
    nav: { section: true, parent: "settings", order: 20 },
    visibility: { defaultEnabled: false, configurable: true, advanced: true },
    settingsCard: {
      description: "Store your own provider credentials for news, web search, and LLM services.",
      order: 20,
    },
  },
  {
    id: "connectors",
    label: "Connectors",
    group: "personalization",
    route: "/settings/connectors",
    icon: Compass,
    description: "Configure external connectors.",
    nav: { section: true, parent: "settings", order: 30 },
    visibility: { defaultEnabled: false, configurable: true, advanced: true },
    settingsCard: {
      description: "Configure scheduled GitHub trend and news search queries.",
      order: 30,
    },
  },
  {
    id: "profile",
    label: "Profile",
    group: "personalization",
    route: "/settings/profile",
    icon: User,
    description: "User profile and personalization.",
    nav: { section: true, parent: "settings", order: 40 },
    visibility: { defaultEnabled: false, configurable: true, advanced: true },
    settingsCard: {
      title: "User Profile",
      description: "Review the learned profile used to adapt answers.",
      order: 40,
    },
  },
  {
    id: "skills",
    label: "Skills",
    group: "agent",
    route: "/settings/skills",
    icon: Sparkles,
    description: "Manage reusable skills.",
    nav: { section: true, parent: "settings", order: 60 },
    visibility: { defaultEnabled: false, configurable: true, advanced: true },
    dependencies: ["agent-chat"],
    settingsCard: {
      description: "Manage reusable chat skills.",
      order: 60,
    },
  },
  {
    id: "system-jobs",
    label: "Jobs",
    group: "system",
    route: "/settings/jobs",
    icon: Wrench,
    description: "Inspect background jobs.",
    nav: { section: true, parent: "settings", order: 80 },
    visibility: { defaultEnabled: false, configurable: true, advanced: true },
    settingsCard: {
      title: "System Jobs",
      description: "Inspect background work, failed jobs, and stuck processing with next-step guidance.",
      order: 80,
    },
  },
  {
    id: "dashboard",
    label: "Dashboard",
    group: "system",
    route: "/stats",
    icon: BarChart3,
    description: "System dashboard and statistics.",
    nav: { primary: true, section: true, parent: "settings", order: 90 },
    visibility: { defaultEnabled: false, configurable: true, advanced: true },
    settingsCard: {
      title: "System Dashboard",
      description: "Inspect operational stats and knowledge rankings outside the daily Home workflow.",
      order: 90,
    },
  },
  {
    id: "lab",
    label: "实验台",
    group: "agent",
    route: "/lab",
    icon: FlaskConical,
    description: "Agent 实验台 — 设计实验、对比结果、固化为 Skill。",
    nav: { primary: true, order: 5 },
    visibility: { defaultEnabled: false, configurable: true, experimental: true },
    dependencies: ["agent-chat"],
  },
  {
    id: "admin-users",
    label: "Admin Users",
    group: "system",
    route: "/admin/users",
    icon: Users,
    description: "Manage users.",
    visibility: { defaultEnabled: false, configurable: false, adminOnly: true },
    settingsCard: {
      title: "Admin Users",
      description: "Manage user approvals and roles.",
      order: 100,
    },
  },
];
