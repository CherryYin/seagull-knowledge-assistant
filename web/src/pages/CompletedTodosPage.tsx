import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CalendarCheck2, CheckCircle2, ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { calendarRemindersApi, type CalendarReminder } from "@/lib/api";
import { cn } from "@/lib/utils";

type Period = "week" | "month" | "year";

function dateKey(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function startOfWeek(date: Date) {
  const next = new Date(date);
  next.setHours(0, 0, 0, 0);
  next.setDate(next.getDate() - next.getDay());
  return next;
}

function addPeriod(date: Date, period: Period, amount: number) {
  const next = new Date(date);
  if (period === "week") next.setDate(next.getDate() + amount * 7);
  if (period === "month") next.setMonth(next.getMonth() + amount);
  if (period === "year") next.setFullYear(next.getFullYear() + amount);
  return next;
}

function rangeFor(anchor: Date, period: Period) {
  if (period === "week") {
    const start = startOfWeek(anchor);
    const end = new Date(start);
    end.setDate(start.getDate() + 6);
    return { start, end };
  }
  if (period === "month") {
    const start = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
    const end = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0);
    return { start, end };
  }
  const start = new Date(anchor.getFullYear(), 0, 1);
  const end = new Date(anchor.getFullYear(), 11, 31);
  return { start, end };
}

function formatRange(start: Date, end: Date, period: Period) {
  if (period === "month") return start.toLocaleDateString(undefined, { year: "numeric", month: "long" });
  if (period === "year") return start.toLocaleDateString(undefined, { year: "numeric" });
  return `${start.toLocaleDateString(undefined, { month: "short", day: "numeric" })} - ${end.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}`;
}

function groupByDate(items: CalendarReminder[]) {
  const groups = new Map<string, CalendarReminder[]>();
  for (const item of items) {
    const current = groups.get(item.date) ?? [];
    current.push(item);
    groups.set(item.date, current);
  }
  return [...groups.entries()].sort(([a], [b]) => b.localeCompare(a));
}

export function CompletedTodosPage() {
  const [period, setPeriod] = useState<Period>("week");
  const [anchor, setAnchor] = useState(() => new Date());
  const range = useMemo(() => rangeFor(anchor, period), [anchor, period]);

  const { data, isLoading, error } = useQuery({
    queryKey: ["completed-todos", period, dateKey(range.start), dateKey(range.end)],
    queryFn: () => calendarRemindersApi.list({ start: dateKey(range.start), end: dateKey(range.end), include_done: true }),
  });

  const completed = useMemo(
    () => (data?.items ?? []).filter((item) => item.is_done).sort((a, b) => b.updated_at.localeCompare(a.updated_at)),
    [data?.items]
  );
  const grouped = useMemo(() => groupByDate(completed), [completed]);

  return (
    <div className="h-full overflow-y-auto bg-gradient-to-br from-background via-background to-emerald-500/5 p-6">
      <div className="mx-auto max-w-5xl space-y-5">
        <div className="rounded-3xl border border-emerald-500/20 bg-gradient-to-br from-emerald-950 via-slate-950 to-cyan-950 p-6 text-white shadow-2xl shadow-emerald-500/10">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <div className="flex items-center gap-2 text-emerald-200">
                <CalendarCheck2 className="h-5 w-5" />
                <span className="text-sm font-semibold uppercase tracking-[0.2em]">Done Log</span>
              </div>
              <h1 className="mt-3 text-3xl font-semibold tracking-tight">Completed</h1>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-emerald-50/75">
                Review what you have finished. Defaults to this week, with week/month/year views.
              </p>
            </div>
            <div className="rounded-2xl bg-white/10 px-4 py-3 text-right">
              <p className="text-xs uppercase tracking-wide text-emerald-100/80">Completed</p>
              <p className="mt-1 text-3xl font-semibold">{completed.length}</p>
            </div>
          </div>
        </div>

        <Card>
          <CardHeader className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div>
              <CardTitle>{formatRange(range.start, range.end, period)}</CardTitle>
              <p className="mt-1 text-sm text-muted-foreground">Showing completed todos only.</p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <div className="flex rounded-lg bg-muted p-1">
                {(["week", "month", "year"] as Period[]).map((value) => (
                  <button
                    key={value}
                    type="button"
                    className={cn(
                      "rounded-md px-3 py-1.5 text-xs font-medium capitalize transition-colors",
                      period === value ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
                    )}
                    onClick={() => {
                      setPeriod(value);
                      setAnchor(new Date());
                    }}
                  >
                    {value}
                  </button>
                ))}
              </div>
              <Button type="button" size="sm" variant="outline" onClick={() => setAnchor((date) => addPeriod(date, period, -1))}>
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <Button type="button" size="sm" variant="outline" onClick={() => setAnchor(new Date())}>Current</Button>
              <Button type="button" size="sm" variant="outline" onClick={() => setAnchor((date) => addPeriod(date, period, 1))}>
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            {isLoading && <p className="text-sm text-muted-foreground">Loading completed todos...</p>}
            {error instanceof Error && <p className="text-sm text-destructive">Failed to load completed todos: {error.message}</p>}
            {!isLoading && !completed.length && (
              <div className="rounded-2xl border border-dashed p-10 text-center text-sm text-muted-foreground">
                No completed todos in this {period}.
              </div>
            )}
            {!!completed.length && (
              <div className="space-y-5">
                {grouped.map(([date, items]) => (
                  <section key={date}>
                    <div className="mb-2 flex items-center gap-2">
                      <div className="h-px flex-1 bg-border" />
                      <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                        {new Date(`${date}T00:00:00`).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric" })}
                      </h2>
                      <div className="h-px flex-1 bg-border" />
                    </div>
                    <div className="space-y-2">
                      {items.map((item) => (
                        <div key={item.id} className="flex items-start gap-3 rounded-xl border border-emerald-500/20 bg-emerald-500/10 p-3">
                          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
                          <div className="min-w-0 flex-1">
                            <p className="text-sm font-medium">{item.text}</p>
                            <p className="mt-1 text-xs text-muted-foreground">Completed {new Date(item.updated_at).toLocaleString()}</p>
                          </div>
                        </div>
                      ))}
                    </div>
                  </section>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
