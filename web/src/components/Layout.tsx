import { NavLink, Outlet } from "react-router-dom";
import { useState, useEffect, useRef } from "react";
import {
  MessageSquare,
  Search,
  StickyNote,
  FileText,
  Zap,
  RefreshCw,
  Brain,
  ChevronLeft,
  Palette,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { syncApi } from "@/lib/api";
import {
  BACKGROUND_PRESETS,
  getPresetById,
  loadBackgroundPresetId,
  saveBackgroundPresetId,
  type BackgroundPresetId,
} from "@/lib/uiBackground";

const navItems = [
  { to: "/", icon: MessageSquare, label: "Chat" },
  { to: "/search", icon: Search, label: "Search" },
  { to: "/notes", icon: StickyNote, label: "Notes" },
  { to: "/sources", icon: FileText, label: "Sources" },
  { to: "/skills", icon: Zap, label: "Skills" },
];

export function Layout() {
  const [collapsed, setCollapsed] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<string | null>(null);
  const [backgroundId, setBackgroundId] = useState<BackgroundPresetId>(loadBackgroundPresetId);
  const [bgPickerOpen, setBgPickerOpen] = useState(false);
  const bgPickerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    saveBackgroundPresetId(backgroundId);
  }, [backgroundId]);

  useEffect(() => {
    if (!bgPickerOpen) return;
    const close = (e: MouseEvent) => {
      if (bgPickerRef.current && !bgPickerRef.current.contains(e.target as Node)) {
        setBgPickerOpen(false);
      }
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [bgPickerOpen]);

  const mainBg = getPresetById(backgroundId).color;

  const handleSync = async () => {
    setSyncing(true);
    setSyncResult(null);
    try {
      const res = await syncApi.sync();
      const n = res.notes;
      const s = res.sources;
      setSyncResult(
        `Notes: +${n.created} ~${n.updated} =${n.skipped} | Sources: +${s.created} ~${s.updated} =${s.skipped}`
      );
    } catch {
      setSyncResult("Sync failed");
    } finally {
      setSyncing(false);
      setTimeout(() => setSyncResult(null), 5000);
    }
  };

  return (
    <div className="flex h-screen overflow-hidden">
      {/* Sidebar */}
      <aside
        className={cn(
          "flex flex-col border-r border-border bg-card transition-all duration-200",
          collapsed ? "w-16" : "w-56"
        )}
      >
        {/* Logo */}
        <div className="flex items-center gap-2 px-4 h-14 border-b border-border shrink-0">
          <Brain className="h-6 w-6 text-primary shrink-0" />
          {!collapsed && <span className="font-semibold text-sm">Knowledge Graph</span>}
        </div>

        {/* Nav */}
        <nav className="flex-1 py-3 space-y-1 px-2">
          {navItems.map(({ to, icon: Icon, label }) => (
            <NavLink
              key={to}
              to={to}
              end={to === "/"}
              className={({ isActive }) =>
                cn(
                  "flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors",
                  isActive
                    ? "bg-primary/15 text-primary font-medium"
                    : "text-muted-foreground hover:text-foreground hover:bg-accent"
                )
              }
            >
              <Icon className="h-4 w-4 shrink-0" />
              {!collapsed && label}
            </NavLink>
          ))}
        </nav>

        {/* Bottom actions */}
        <div className="border-t border-border p-2 space-y-1">
          <Button
            variant="ghost"
            size="sm"
            className={cn("w-full", collapsed ? "justify-center" : "justify-start")}
            onClick={handleSync}
            disabled={syncing}
          >
            <RefreshCw className={cn("h-4 w-4 shrink-0", syncing && "animate-spin")} />
            {!collapsed && (syncing ? "Syncing..." : "Sync")}
          </Button>

          <Button
            variant="ghost"
            size="sm"
            className={cn("w-full", collapsed ? "justify-center" : "justify-start")}
            onClick={() => setCollapsed(!collapsed)}
          >
            <ChevronLeft className={cn("h-4 w-4 shrink-0 transition-transform", collapsed && "rotate-180")} />
            {!collapsed && "Collapse"}
          </Button>

          <div className="relative" ref={bgPickerRef}>
            <Button
              variant="ghost"
              size="sm"
              className={cn("w-full", collapsed ? "justify-center" : "justify-start")}
              onClick={() => setBgPickerOpen((o) => !o)}
              title="Background"
            >
              <Palette className="h-4 w-4 shrink-0" />
              {!collapsed && "Background"}
            </Button>
            {bgPickerOpen && (
              <div
                className={cn(
                  "absolute z-50 rounded-lg border border-border bg-card p-2 shadow-lg",
                  collapsed ? "left-full bottom-0 ml-1 w-[200px]" : "bottom-full left-0 mb-1 w-full min-w-[180px]"
                )}
              >
                <p className="mb-2 px-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                  Main area
                </p>
                <div className="grid grid-cols-3 gap-2">
                  {BACKGROUND_PRESETS.map((preset) => (
                    <button
                      key={preset.id}
                      type="button"
                      title={preset.label}
                      onClick={() => {
                        setBackgroundId(preset.id);
                        setBgPickerOpen(false);
                      }}
                      className={cn(
                        "flex h-9 flex-col items-center justify-center gap-0.5 rounded-md border text-[10px] transition-colors",
                        backgroundId === preset.id
                          ? "border-primary ring-1 ring-primary/40"
                          : "border-border hover:border-muted-foreground/40"
                      )}
                    >
                      <span
                        className="h-5 w-full rounded-sm"
                        style={{ backgroundColor: preset.color }}
                      />
                      <span className="truncate text-muted-foreground">{preset.label}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Sync result toast */}
        {syncResult && (
          <div className="mx-2 mb-2 rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
            {syncResult}
          </div>
        )}
      </aside>

      {/* Main content */}
      <main
        className="flex-1 overflow-hidden transition-[background-color] duration-300 ease-out"
        style={{ backgroundColor: mainBg }}
      >
        <Outlet />
      </main>
    </div>
  );
}
