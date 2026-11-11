import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { CalendarCheck, Check, Mail, RefreshCw, SkipForward, Sparkles, Undo2 } from "lucide-react";
import { api, get, type Digest, type Today } from "@/lib/api";
import { dayLabel, longDate } from "@/lib/dates";
import { PageHeader, useStatus } from "@/components/Layout";
import { QuickAdd, TaskList, useInvalidateTasks } from "@/components/tasks";
import { Button, Card, EmptyState, PageSpinner, cn, timeAgo } from "@/components/ui";

export default function TodayPage() {
  const q = useQuery({ queryKey: ["today"], queryFn: () => get<Today>("/today"), refetchInterval: 60_000 });
  const d = q.data;
  if (!d) return <PageSpinner />;
  const nothing = !d.overdue.length && !d.today.length && !d.upcoming.length && !d.anytime.length;
  const upcomingByDay = groupBy(d.upcoming, (t) => t.dueDate!);

  return (
    <div className="animate-fade-in">
      <PageHeader title={greeting()} description={longDate(d.date)} />
      <div className="space-y-6">
        <QuickAdd />
        <Briefing digest={d.digest} today={d.date} />
        {d.inbox > 0 && (
          <Link to="/inbox" className="flex items-center gap-3 rounded-xl border border-primary/30 bg-primary-soft px-4 py-3 text-sm text-primary hover:brightness-[.98]">
            <Mail className="h-4 w-4 shrink-0" />
            <span className="flex-1 font-medium">
              {d.inbox} email{d.inbox === 1 ? "" : "s"} need{d.inbox === 1 ? "s" : ""} you
            </span>
            <span className="text-xs">Open inbox →</span>
          </Link>
        )}

        {nothing && !d.done.length ? (
          <EmptyState icon={<CalendarCheck className="h-5 w-5" />} title="Nothing on your list yet">
            Type something above the way you'd say it, like “feed the gecko every other day” or “dentist Friday at 3pm”.
          </EmptyState>
        ) : (
          <>
            {d.overdue.length > 0 && (
              <Section title="Overdue" count={d.overdue.length} tone="danger">
                <TaskList tasks={d.overdue} today={d.date} />
              </Section>
            )}
            <Section title="Today" count={d.today.length}>
              {d.today.length ? (
                <TaskList tasks={d.today} today={d.date} showDate={false} />
              ) : (
                <p className="px-5 py-6 text-center text-sm text-muted-foreground">{d.done.length ? "All done for today. Nice." : "Nothing due today."}</p>
              )}
            </Section>
            {Object.keys(upcomingByDay).length > 0 && (
              <Section title="Coming up" count={d.upcoming.length} footer={d.later ? <Link to="/tasks" className="text-xs text-muted-foreground hover:text-foreground">+ {d.later} later →</Link> : undefined}>
                {Object.entries(upcomingByDay).map(([day, tasks]) => (
                  <div key={day}>
                    <div className="border-b bg-muted/40 px-5 py-1.5 text-xs font-medium text-muted-foreground">{dayLabel(day, d.date)}</div>
                    <TaskList tasks={tasks} today={d.date} showDate={false} />
                  </div>
                ))}
              </Section>
            )}
            {d.anytime.length > 0 && (
              <Section title="Anytime" count={d.anytime.length}>
                <TaskList tasks={d.anytime} today={d.date} />
              </Section>
            )}
            {d.done.length > 0 && <DoneToday done={d.done} />}
          </>
        )}
      </div>
    </div>
  );
}

function greeting() {
  const h = new Date().getHours();
  return h < 5 ? "Still up?" : h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
}

function groupBy<T>(items: T[], key: (t: T) => string): Record<string, T[]> {
  const out: Record<string, T[]> = {};
  for (const i of items) (out[key(i)] ??= []).push(i);
  return out;
}

function Section({ title, count, tone, children, footer }: { title: string; count?: number; tone?: "danger"; children: React.ReactNode; footer?: React.ReactNode }) {
  return (
    <section>
      <div className="mb-2 flex items-baseline justify-between px-1">
        <h2 className={cn("text-sm font-semibold", tone === "danger" && "text-destructive")}>
          {title}
          {count ? <span className="ml-2 font-normal text-muted-foreground">{count}</span> : null}
        </h2>
        {footer}
      </div>
      <Card className="overflow-hidden">{children}</Card>
    </section>
  );
}

function Briefing({ digest, today }: { digest: Digest | null; today: string }) {
  const qc = useQueryClient();
  const status = useStatus().data;
  const fresh = digest?.date === today;
  const write = useMutation({
    mutationFn: () => api<{ digest: Digest; note?: string }>("POST", "/digest", {}),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ["today"] });
      qc.invalidateQueries({ queryKey: ["status"] });
      if (r.note) toast(r.note);
    },
    onError: (e: Error) => toast.error(e.message),
  });
  if (!fresh) {
    return (
      <div className="flex flex-col gap-3 rounded-xl border border-dashed px-5 py-4 sm:flex-row sm:items-center">
        <Sparkles className="hidden h-5 w-5 text-primary sm:block" />
        <p className="flex-1 text-sm text-muted-foreground">Today's summary hasn't been written yet. It's sent every morning at the time in Settings.</p>
        <Button variant="outline" size="sm" onClick={() => write.mutate()} loading={write.isPending}>
          Write it now
        </Button>
      </div>
    );
  }
  return (
    <Card className="relative overflow-hidden">
      <div className="pointer-events-none absolute -right-16 -top-16 h-48 w-48 rounded-full bg-primary/10 blur-2xl" />
      <div className="relative p-5 sm:p-6">
        <div className="mb-2 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-primary">
            <Sparkles className="h-3.5 w-3.5" />
            Your day
          </div>
          <button
            onClick={() => write.mutate()}
            disabled={write.isPending}
            className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
            title="Write it again from what's on your list now"
          >
            <RefreshCw className={cn("h-3.5 w-3.5", write.isPending && "animate-spin")} />
            {write.isPending ? (status?.ai.configured ? "Asking the AI…" : "Writing…") : "Refresh"}
          </button>
        </div>
        <p className="whitespace-pre-line text-[15px] leading-relaxed">{digest!.briefing}</p>
        <p className="mt-3 text-xs text-muted-foreground">
          {digest!.byAi ? "Written by your local AI" : "Written without the AI"} {timeAgo(digest!.createdAt)}
          {digest!.sentAt ? " · sent to your phone" : ""}
        </p>
      </div>
    </Card>
  );
}

function DoneToday({ done }: { done: Today["done"] }) {
  const invalidate = useInvalidateTasks();
  const undo = useMutation({
    mutationFn: (logId: number) => api("POST", `/log/${logId}/undo`),
    onSuccess: invalidate,
    onError: (e: Error) => toast.error(e.message),
  });
  return (
    <section>
      <h2 className="mb-2 px-1 text-sm font-semibold text-muted-foreground">Done today</h2>
      <ul className="space-y-1">
        {done.map((d) => (
          <li key={d.logId} className="group flex items-center gap-3 rounded-lg px-3 py-1.5 text-sm text-muted-foreground hover:bg-muted/50">
            {d.action === "done" ? <Check className="h-4 w-4 text-success" /> : <SkipForward className="h-4 w-4" />}
            <span className={cn("flex-1", d.action === "done" && "line-through")}>{d.task.title}</span>
            <span className="text-xs">{new Date(d.at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}</span>
            <button onClick={() => undo.mutate(d.logId)} className="rounded p-1 opacity-0 hover:bg-muted hover:text-foreground group-hover:opacity-100" title="Undo" aria-label={`Undo ${d.task.title}`}>
              <Undo2 className="h-3.5 w-3.5" />
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
