import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Bell, CalendarDays, CheckCircle2, ChevronLeft, ChevronRight, FileText, Plus, Sparkles, StickyNote, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { calendarRemindersApi, notesApi, sourcesApi, type CalendarReminder, type Note, type Source } from "@/lib/api";
import { cn } from "@/lib/utils";

type CalendarItem = {
  id: string;
  title: string;
  kind: "note" | "source";
  date: Date;
  href: string;
  meta: string;
};

function startOfMonth(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function addMonths(date: Date, months: number) {
  return new Date(date.getFullYear(), date.getMonth() + months, 1);
}

function dateKey(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatMonth(date: Date) {
  return date.toLocaleDateString(undefined, { year: "numeric", month: "long" });
}

function yesterdayKey() {
  const date = new Date();
  date.setDate(date.getDate() - 1);
  return dateKey(date);
}

function toCalendarItems(notes: Note[], sources: Source[]): CalendarItem[] {
  const noteItems = notes.map((note) => ({
    id: note.id,
    title: note.title,
    kind: "note" as const,
    date: new Date(note.updated_at || note.created_at),
    href: `/notes/${encodeURIComponent(note.id)}`,
    meta: `${note.note_type} · ${note.status}`,
  }));

  const sourceItems = sources.map((source) => ({
    id: source.id,
    title: source.title,
    kind: "source" as const,
    date: new Date(source.ingested_at),
    href: `/sources/${encodeURIComponent(source.id)}`,
    meta: source.source_type,
  }));

  return [...noteItems, ...sourceItems]
    .filter((item) => !Number.isNaN(item.date.getTime()))
    .sort((a, b) => b.date.getTime() - a.date.getTime());
}

function buildCalendarDays(month: Date) {
  const first = startOfMonth(month);
  const gridStart = new Date(first);
  gridStart.setDate(first.getDate() - first.getDay());

  return Array.from({ length: 42 }, (_, index) => {
    const day = new Date(gridStart);
    day.setDate(gridStart.getDate() + index);
    return day;
  });
}

function groupReminders(reminders: CalendarReminder[]) {
  const map = new Map<string, CalendarReminder[]>();
  for (const reminder of reminders) {
    const current = map.get(reminder.date) ?? [];
    current.push(reminder);
    map.set(reminder.date, current);
  }
  return map;
}

export function CalendarPage() {
  const queryClient = useQueryClient();
  const [visibleMonth, setVisibleMonth] = useState(() => startOfMonth(new Date()));
  const [selectedKey, setSelectedKey] = useState(() => dateKey(new Date()));
  const [newReminder, setNewReminder] = useState("");

  const days = useMemo(() => buildCalendarDays(visibleMonth), [visibleMonth]);
  const gridStart = dateKey(days[0]);
  const gridEnd = dateKey(days[days.length - 1]);

  const { data: notesData, isLoading: notesLoading } = useQuery({
    queryKey: ["calendar-notes"],
    queryFn: () => notesApi.list({ limit: 200 }),
  });
  const { data: sourcesData, isLoading: sourcesLoading } = useQuery({
    queryKey: ["calendar-sources"],
    queryFn: () => sourcesApi.list({ limit: 200 }),
  });
  const { data: remindersData, isLoading: remindersLoading } = useQuery({
    queryKey: ["calendar-reminders", gridStart, gridEnd],
    queryFn: () => calendarRemindersApi.list({ start: gridStart, end: gridEnd, include_done: true }),
  });
  const { data: overdueData } = useQuery({
    queryKey: ["calendar-reminders-overdue"],
    queryFn: () => calendarRemindersApi.list({ end: yesterdayKey(), include_done: false }),
  });

  const items = useMemo(
    () => toCalendarItems(notesData?.items ?? [], sourcesData?.items ?? []),
    [notesData?.items, sourcesData?.items]
  );

  const itemsByDay = useMemo(() => {
    const map = new Map<string, CalendarItem[]>();
    for (const item of items) {
      const key = dateKey(item.date);
      const current = map.get(key) ?? [];
      current.push(item);
      map.set(key, current);
    }
    return map;
  }, [items]);

  const reminders = remindersData?.items ?? [];
  const remindersByDay = useMemo(() => groupReminders(reminders), [reminders]);
  const overdueReminders = overdueData?.items ?? [];
  const selectedItems = itemsByDay.get(selectedKey) ?? [];
  const selectedReminders = remindersByDay.get(selectedKey) ?? [];
  const loading = notesLoading || sourcesLoading || remindersLoading;
  const noteCount = items.filter((item) => item.kind === "note").length;
  const sourceCount = items.filter((item) => item.kind === "source").length;
  const reminderCount = reminders.filter((reminder) => !reminder.is_done).length;
  const activeDays = new Set([...itemsByDay.keys(), ...remindersByDay.keys()]).size;

  const createReminderMutation = useMutation({
    mutationFn: () => calendarRemindersApi.create({ date: selectedKey, text: newReminder.trim() }),
    onSuccess: () => {
      setNewReminder("");
      queryClient.invalidateQueries({ queryKey: ["calendar-reminders"] });
      queryClient.invalidateQueries({ queryKey: ["calendar-reminders-overdue"] });
    },
  });

  const updateReminderMutation = useMutation({
    mutationFn: ({ id, is_done }: { id: string; is_done: boolean }) => calendarRemindersApi.update(id, { is_done }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["calendar-reminders"] });
      queryClient.invalidateQueries({ queryKey: ["calendar-reminders-overdue"] });
    },
  });

  const deleteReminderMutation = useMutation({
    mutationFn: (id: string) => calendarRemindersApi.delete(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["calendar-reminders"] });
      queryClient.invalidateQueries({ queryKey: ["calendar-reminders-overdue"] });
    },
  });

  const submitReminder = () => {
    if (!newReminder.trim()) return;
    createReminderMutation.mutate();
  };

  return (
    <div className="h-full overflow-y-auto bg-gradient-to-br from-background via-background to-primary/5 p-6">
      <div className="mx-auto max-w-7xl space-y-5">
        <div className="relative overflow-hidden rounded-3xl border border-primary/20 bg-gradient-to-br from-slate-950 via-blue-950 to-cyan-950 p-6 text-white shadow-2xl shadow-primary/10">
          <div className="absolute -right-16 -top-16 h-48 w-48 rounded-full bg-cyan-400/20 blur-3xl" />
          <div className="absolute bottom-0 left-1/3 h-32 w-32 rounded-full bg-blue-500/20 blur-2xl" />
          <div className="relative flex flex-wrap items-center justify-between gap-4">
            <div>
              <div className="flex items-center gap-2 text-cyan-200">
                <CalendarDays className="h-5 w-5" />
                <span className="text-sm font-semibold uppercase tracking-[0.2em]">Calendar</span>
              </div>
              <h1 className="mt-3 text-3xl font-semibold tracking-tight">Knowledge Calendar</h1>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-cyan-50/75">
                Track knowledge activity and daily todos. Unfinished todos from past days stay visible as reminders until completed or deleted.
              </p>
            </div>
            <Button className="bg-white text-slate-950 hover:bg-cyan-50" size="sm" onClick={() => {
              const today = new Date();
              setVisibleMonth(startOfMonth(today));
              setSelectedKey(dateKey(today));
            }}>
              Today
            </Button>
          </div>
        </div>

        {overdueReminders.length > 0 && (
          <div className="rounded-2xl border border-amber-500/30 bg-amber-500/10 p-4">
            <div className="flex items-start gap-3">
              <Bell className="mt-0.5 h-5 w-5 text-amber-600" />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-amber-800">{overdueReminders.length} unfinished todo(s) from previous days</p>
                <div className="mt-2 flex flex-wrap gap-2">
                  {overdueReminders.slice(0, 6).map((reminder) => (
                    <button
                      key={reminder.id}
                      type="button"
                      className="rounded-full border border-amber-500/30 bg-background/70 px-3 py-1 text-xs text-amber-800 hover:bg-background"
                      onClick={() => {
                        setSelectedKey(reminder.date);
                        setVisibleMonth(startOfMonth(new Date(`${reminder.date}T00:00:00`)));
                      }}
                    >
                      {reminder.date} · {reminder.text}
                    </button>
                  ))}
                  {overdueReminders.length > 6 && <span className="text-xs text-amber-700">+{overdueReminders.length - 6} more</span>}
                </div>
              </div>
            </div>
          </div>
        )}

        <div className="grid gap-3 md:grid-cols-4">
          <div className="rounded-2xl border border-cyan-500/20 bg-cyan-500/10 p-4">
            <p className="text-xs font-medium uppercase tracking-wide text-cyan-700">Notes</p>
            <p className="mt-2 text-2xl font-semibold">{noteCount}</p>
          </div>
          <div className="rounded-2xl border border-violet-500/20 bg-violet-500/10 p-4">
            <p className="text-xs font-medium uppercase tracking-wide text-violet-700">Sources</p>
            <p className="mt-2 text-2xl font-semibold">{sourceCount}</p>
          </div>
          <div className="rounded-2xl border border-amber-500/20 bg-amber-500/10 p-4">
            <p className="text-xs font-medium uppercase tracking-wide text-amber-700">Open Todos</p>
            <p className="mt-2 text-2xl font-semibold">{reminderCount}</p>
          </div>
          <div className="rounded-2xl border border-emerald-500/20 bg-emerald-500/10 p-4">
            <p className="text-xs font-medium uppercase tracking-wide text-emerald-700">Active Days</p>
            <p className="mt-2 text-2xl font-semibold">{activeDays}</p>
          </div>
        </div>

        <div className="grid gap-4 lg:grid-cols-[1fr_400px]">
          <Card className="overflow-hidden border-primary/10 shadow-xl shadow-primary/5">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 bg-gradient-to-r from-primary/10 via-cyan-500/10 to-transparent">
              <CardTitle className="text-lg">{formatMonth(visibleMonth)}</CardTitle>
              <div className="flex items-center gap-1 rounded-full bg-background/80 p-1 shadow-sm">
                <Button variant="ghost" size="sm" onClick={() => setVisibleMonth((date) => addMonths(date, -1))}>
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setVisibleMonth((date) => addMonths(date, 1))}>
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
            </CardHeader>
            <CardContent className="p-3 md:p-4">
              <div className="grid grid-cols-7 gap-2 text-xs">
                {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((day) => (
                  <div key={day} className="rounded-lg bg-muted/80 px-2 py-2 text-center font-semibold text-muted-foreground">
                    {day}
                  </div>
                ))}
                {days.map((day) => {
                  const key = dateKey(day);
                  const dayItems = itemsByDay.get(key) ?? [];
                  const dayReminders = remindersByDay.get(key) ?? [];
                  const openReminders = dayReminders.filter((reminder) => !reminder.is_done);
                  const isCurrentMonth = day.getMonth() === visibleMonth.getMonth();
                  const isSelected = key === selectedKey;
                  const isToday = key === dateKey(new Date());
                  return (
                    <button
                      key={key}
                      type="button"
                      onClick={() => setSelectedKey(key)}
                      className={cn(
                        "min-h-28 rounded-2xl border p-2 text-left transition-all hover:-translate-y-0.5 hover:shadow-md",
                        isCurrentMonth ? "bg-card" : "bg-muted/40 text-muted-foreground",
                        isSelected ? "border-primary shadow-lg shadow-primary/10" : "border-border/80"
                      )}
                    >
                      <div className="flex items-center justify-between gap-1">
                        <span className={cn("font-medium", isToday && "rounded-full bg-primary px-1.5 py-0.5 text-primary-foreground")}>
                          {day.getDate()}
                        </span>
                        <div className="flex gap-1">
                          {dayItems.length > 0 && (
                            <span className="rounded-full bg-primary/15 px-1.5 py-0.5 text-[10px] font-semibold text-primary">
                              {dayItems.length}
                            </span>
                          )}
                          {openReminders.length > 0 && (
                            <span className="rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-amber-700">
                              {openReminders.length} todo
                            </span>
                          )}
                        </div>
                      </div>
                      <div className="mt-2 space-y-1">
                        {openReminders.slice(0, 2).map((reminder) => (
                          <div key={reminder.id} className="truncate rounded-md border border-amber-500/20 bg-amber-500/10 px-1.5 py-1 text-[10px] font-medium text-amber-800">
                            {reminder.text}
                          </div>
                        ))}
                        {dayItems.slice(0, Math.max(0, 3 - openReminders.slice(0, 2).length)).map((item) => (
                          <div
                            key={`${item.kind}-${item.id}`}
                            className={cn(
                              "truncate rounded-md border px-1.5 py-1 text-[10px] font-medium",
                              item.kind === "note"
                                ? "border-cyan-500/20 bg-cyan-500/10 text-cyan-800"
                                : "border-violet-500/20 bg-violet-500/10 text-violet-800"
                            )}
                          >
                            {item.title}
                          </div>
                        ))}
                        {dayItems.length + openReminders.length > 3 && (
                          <div className="text-[10px] text-muted-foreground">+{dayItems.length + openReminders.length - 3} more</div>
                        )}
                      </div>
                    </button>
                  );
                })}
              </div>
            </CardContent>
          </Card>

          <Card className="overflow-hidden border-primary/10 shadow-xl shadow-primary/5">
            <CardHeader className="bg-gradient-to-r from-slate-950 to-slate-800 text-white">
              <div className="mb-2 flex items-center gap-2 text-cyan-200">
                <Sparkles className="h-4 w-4" />
                <span className="text-xs font-semibold uppercase tracking-wide">Selected Day</span>
              </div>
              <CardTitle className="text-lg">
                {new Date(`${selectedKey}T00:00:00`).toLocaleDateString(undefined, {
                  weekday: "long",
                  month: "short",
                  day: "numeric",
                })}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-5 p-4">
              <section>
                <div className="mb-2 flex items-center justify-between">
                  <h3 className="text-sm font-semibold">Daily Todos</h3>
                  <span className="text-xs text-muted-foreground">{selectedReminders.filter((reminder) => !reminder.is_done).length} open</span>
                </div>
                <form
                  className="flex gap-2"
                  onSubmit={(event) => {
                    event.preventDefault();
                    submitReminder();
                  }}
                >
                  <Input value={newReminder} onChange={(event) => setNewReminder(event.target.value)} placeholder="Add a todo for this day..." />
                  <Button type="submit" size="icon" disabled={!newReminder.trim() || createReminderMutation.isPending}>
                    <Plus className="h-4 w-4" />
                  </Button>
                </form>
                <div className="mt-3 space-y-2">
                  {selectedReminders.length === 0 ? (
                    <p className="rounded-xl border border-dashed p-3 text-sm text-muted-foreground">No todos for this day.</p>
                  ) : (
                    selectedReminders.map((reminder) => (
                      <div key={reminder.id} className={cn("flex items-start gap-2 rounded-xl border p-3", reminder.is_done ? "bg-muted/40 text-muted-foreground" : "border-amber-500/20 bg-amber-500/10")}>
                        <button
                          type="button"
                          className={cn("mt-0.5 rounded-full", reminder.is_done ? "text-emerald-600" : "text-muted-foreground hover:text-emerald-600")}
                          onClick={() => updateReminderMutation.mutate({ id: reminder.id, is_done: !reminder.is_done })}
                          title={reminder.is_done ? "Mark as open" : "Mark as done"}
                        >
                          <CheckCircle2 className="h-4 w-4" />
                        </button>
                        <div className="min-w-0 flex-1">
                          <p className={cn("text-sm", reminder.is_done && "line-through")}>{reminder.text}</p>
                          <p className="mt-1 text-xs text-muted-foreground">{reminder.date}</p>
                        </div>
                        <button
                          type="button"
                          className="rounded-md p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                          onClick={() => deleteReminderMutation.mutate(reminder.id)}
                          title="Delete todo"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </div>
                    ))
                  )}
                </div>
              </section>

              <section>
                <h3 className="mb-2 text-sm font-semibold">Notes & Sources</h3>
                {loading ? (
                  <p className="text-sm text-muted-foreground">Loading calendar...</p>
                ) : selectedItems.length === 0 ? (
                  <p className="rounded-xl border border-dashed p-3 text-sm text-muted-foreground">No notes or sources on this day.</p>
                ) : (
                  <div className="space-y-2">
                    {selectedItems.map((item) => {
                      const Icon = item.kind === "note" ? StickyNote : FileText;
                      return (
                        <Link
                          key={`${item.kind}-${item.id}`}
                          to={item.href}
                          className={cn(
                            "block rounded-xl border p-3 transition-all hover:-translate-y-0.5 hover:shadow-md",
                            item.kind === "note"
                              ? "border-cyan-500/20 bg-cyan-500/10 hover:border-cyan-500/40"
                              : "border-violet-500/20 bg-violet-500/10 hover:border-violet-500/40"
                          )}
                        >
                          <div className="flex items-start gap-2">
                            <div className={cn("rounded-lg p-1.5", item.kind === "note" ? "bg-cyan-500/15 text-cyan-700" : "bg-violet-500/15 text-violet-700")}>
                              <Icon className="h-4 w-4 shrink-0" />
                            </div>
                            <div className="min-w-0">
                              <p className="truncate text-sm font-medium">{item.title}</p>
                              <p className="mt-1 text-xs text-muted-foreground">
                                {item.kind} · {item.meta}
                              </p>
                            </div>
                          </div>
                        </Link>
                      );
                    })}
                  </div>
                )}
              </section>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
