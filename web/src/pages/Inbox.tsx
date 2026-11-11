import { useState } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Ban, Check, CheckCheck, ExternalLink, Inbox as InboxIcon, ListPlus, Mail, MoreHorizontal, RefreshCw, Search, Star, X } from "lucide-react";
import { api, get, type Category, type Email, type EmailList, type ParsedTask, type Status } from "@/lib/api";
import { dayLabel, timeLabel, ymd } from "@/lib/dates";
import { PageHeader } from "@/components/Layout";
import { TaskEditor, useInvalidateTasks } from "@/components/tasks";
import { Badge, Button, Card, EmptyState, Input, PageSpinner, cn, timeAgo } from "@/components/ui";

type View = "attention" | "other" | "filtered" | "handled";

const VIEWS: { value: View; label: string; hint: string }[] = [
  { value: "attention", label: "Needs you", hint: "Important email and anything you need to do something about." },
  { value: "other", label: "FYI", hint: "Receipts, shipping updates and other routine mail. Nothing to do." },
  { value: "filtered", label: "Filtered", hint: "Promotions, newsletters, spam and senders you ignore. Check now and then for anything misfiled." },
  { value: "handled", label: "Dealt with", hint: "Email you've cleared." },
];

const CATEGORY: Record<Category, { label: string; tone: "danger" | "primary" | "neutral" | "warning" }> = {
  action: { label: "To do", tone: "danger" },
  important: { label: "Important", tone: "primary" },
  fyi: { label: "FYI", tone: "neutral" },
  promo: { label: "Promo", tone: "neutral" },
  spam: { label: "Spam", tone: "warning" },
  ignored: { label: "Ignored", tone: "neutral" },
};

export function useInvalidateEmails() {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: ["emails"] });
    qc.invalidateQueries({ queryKey: ["status"] });
    qc.invalidateQueries({ queryKey: ["today"] });
  };
}

export default function InboxPage() {
  const [view, setView] = useState<View>("attention");
  const [q, setQ] = useState("");
  const invalidate = useInvalidateEmails();
  const status = useQuery({ queryKey: ["status"], queryFn: () => get<Status>("/status") }).data;
  const list = useQuery({
    queryKey: ["emails", view, q],
    queryFn: () => get<EmailList>(`/emails?view=${view}${q.trim() ? `&q=${encodeURIComponent(q.trim())}` : ""}`),
    placeholderData: (p) => p,
    refetchInterval: 60_000,
  });
  const check = useMutation({
    mutationFn: () => api<{ results: { account: string; added: number; attention: number; error?: string }[] }>("POST", "/mail/check"),
    onSuccess: (r) => {
      invalidate();
      const errors = r.results.filter((x) => x.error);
      if (errors.length) errors.forEach((e) => toast.error(`${e.account}: ${e.error}`));
      const added = r.results.reduce((n, x) => n + x.added, 0);
      const attention = r.results.reduce((n, x) => n + x.attention, 0);
      if (!errors.length) toast.success(added ? `${added} new, ${attention} need${attention === 1 ? "s" : ""} you` : "No new email");
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const clearAll = useMutation({
    mutationFn: (ids: number[]) => api("POST", "/emails/handle", { ids }),
    onSuccess: invalidate,
  });

  if (status && !status.mailAccounts) {
    return (
      <div className="animate-fade-in">
        <PageHeader title="Inbox" description="The email worth your attention, picked out of everything else." />
        <EmptyState
          icon={<Mail className="h-5 w-5" />}
          title="Connect an email account"
          action={
            <Link to="/settings#email">
              <Button>Add an account</Button>
            </Link>
          }
        >
          Docket reads your inbox (read-only, nothing is marked or moved), sorts out the spam and promotions, and turns emails that need you into suggested tasks.
        </EmptyState>
      </div>
    );
  }

  const data = list.data;
  const counts = data?.counts;
  const hint = VIEWS.find((v) => v.value === view)!.hint;

  return (
    <div className="animate-fade-in">
      <PageHeader
        title="Inbox"
        description="The email worth your attention, picked out of everything else."
        actions={
          <Button variant="outline" onClick={() => check.mutate()} loading={check.isPending || status?.mailBusy}>
            {!check.isPending && !status?.mailBusy && <RefreshCw className="h-4 w-4" />}
            Check now
          </Button>
        }
      />
      <div className="scrollbar-none -mx-4 mb-3 flex gap-1 overflow-x-auto border-b px-4 sm:mx-0 sm:px-0">
        {VIEWS.map((v) => {
          const n = counts?.[v.value] ?? 0;
          return (
            <button
              key={v.value}
              onClick={() => setView(v.value)}
              className={cn(
                "-mb-px flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2.5 text-sm font-medium transition-colors",
                view === v.value ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              {v.label}
              {n > 0 && <span className={cn("rounded-full px-1.5 text-[11px]", v.value === "attention" ? "bg-primary text-primary-foreground" : "bg-muted")}>{n}</span>}
            </button>
          );
        })}
      </div>
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center">
        <p className="flex-1 text-sm text-muted-foreground">{hint}</p>
        <div className="relative sm:w-60">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input className="pl-9" placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search email" />
        </div>
      </div>

      {!data ? (
        <PageSpinner />
      ) : !data.emails.length ? (
        <EmptyState icon={<InboxIcon className="h-5 w-5" />} title={view === "attention" ? "You're all caught up" : "Nothing here"}>
          {view === "attention" ? "Nothing in your email needs you right now." : undefined}
        </EmptyState>
      ) : (
        <>
          <div className="space-y-3">
            {data.emails.map((e) => (
              <EmailCard key={e.id} email={e} />
            ))}
          </div>
          {(view === "attention" || view === "other") && data.emails.length > 1 && (
            <div className="mt-4 flex justify-end">
              <Button variant="ghost" size="sm" onClick={() => clearAll.mutate(data.emails.map((e) => e.id))} loading={clearAll.isPending}>
                <CheckCheck className="h-4 w-4" /> Mark all {data.emails.length} as dealt with
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function EmailCard({ email: e }: { email: Email }) {
  const invalidate = useInvalidateEmails();
  const invalidateTasks = useInvalidateTasks();
  const [menu, setMenu] = useState(false);
  const [editing, setEditing] = useState(false);
  const today = ymd(new Date());
  const cat = CATEGORY[e.category];
  const sender = e.fromName || e.fromAddr || "Unknown sender";
  const domain = e.fromAddr?.split("@")[1];

  const patch = useMutation({
    mutationFn: (body: { category?: string; handled?: boolean }) => api<Email>("PATCH", `/emails/${e.id}`, body),
    onSuccess: (_r, body) => {
      invalidate();
      if (body.handled) toast("Marked as dealt with", { action: { label: "Undo", onClick: () => patch.mutate({ handled: false }) } });
    },
    onError: (err: Error) => toast.error(err.message),
  });
  const accept = useMutation({
    mutationFn: (t?: ParsedTask) => api("POST", `/emails/${e.id}/accept`, t ? { title: t.title, dueDate: t.dueDate, dueTime: t.dueTime, list: t.list } : {}),
    onSuccess: () => {
      invalidate();
      invalidateTasks();
      toast.success("Added to your tasks");
    },
    onError: (err: Error) => toast.error(err.message),
  });
  const dismiss = useMutation({
    mutationFn: () => api("POST", `/emails/${e.id}/dismiss`),
    onSuccess: invalidate,
  });
  const rule = useMutation({
    mutationFn: (body: { pattern: string; action: "important" | "ignore" }) => api<{ changed: number; pattern: string }>("POST", "/sender-rules", body),
    onSuccess: (r, body) => {
      invalidate();
      toast.success(body.action === "ignore" ? `Mail from ${r.pattern} will be filtered out` : `Mail from ${r.pattern} will always show here`);
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const s = e.suggestion;
  return (
    <Card className={cn("p-4 sm:p-5", e.handled && "opacity-70")}>
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="truncate font-medium">{sender}</span>
            <Badge tone={cat.tone}>{cat.label}</Badge>
            <span className="text-xs text-muted-foreground">{timeAgo(e.receivedAt)}</span>
          </div>
          <div className="mt-0.5 text-[15px] font-semibold leading-snug">{e.subject}</div>
          <p className="mt-1.5 text-sm text-muted-foreground">{e.summary || e.snippet}</p>
          <p className="mt-2 text-xs text-muted-foreground/90">
            {e.decidedBy === "ai" ? "AI: " : e.decidedBy === "rule" ? "Your rule: " : e.decidedBy === "you" ? "" : "Basic check: "}
            {e.reason}
            {e.aiPending && " · the AI will take a proper look when it's reachable"}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          {e.openUrl && (
            <a href={e.openUrl} target="_blank" rel="noreferrer" className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground" title="Open in Gmail" aria-label="Open in Gmail">
              <ExternalLink className="h-4 w-4" />
            </a>
          )}
          {!e.handled && e.category !== "ignored" && (
            <button onClick={() => patch.mutate({ handled: true })} className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground" title="Dealt with" aria-label="Mark as dealt with">
              <Check className="h-4 w-4" />
            </button>
          )}
          <div className="relative">
            <button onClick={() => setMenu((m) => !m)} className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground" aria-label="More">
              <MoreHorizontal className="h-4 w-4" />
            </button>
            {menu && (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setMenu(false)} />
                <div className="absolute right-0 z-20 mt-1 w-64 overflow-hidden rounded-lg border bg-card py-1 text-sm shadow-lg animate-pop-in">
                  <div className="px-3 pb-1 pt-1.5 text-xs font-medium text-muted-foreground">Move to</div>
                  {(["action", "important", "fyi", "promo", "spam"] as const)
                    .filter((c) => c !== e.category)
                    .map((c) => (
                      <button key={c} onClick={() => (setMenu(false), patch.mutate({ category: c }))} className="block w-full px-3 py-1.5 text-left hover:bg-muted">
                        {CATEGORY[c].label}
                      </button>
                    ))}
                  {e.fromAddr && (
                    <>
                      <div className="mt-1 border-t px-3 pb-1 pt-2 text-xs font-medium text-muted-foreground">From now on</div>
                      <button onClick={() => (setMenu(false), rule.mutate({ pattern: e.fromAddr!, action: "important" }))} className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-muted">
                        <Star className="h-4 w-4" /> Always show {e.fromAddr}
                      </button>
                      <button onClick={() => (setMenu(false), rule.mutate({ pattern: e.fromAddr!, action: "ignore" }))} className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-muted">
                        <Ban className="h-4 w-4" /> Ignore {e.fromAddr}
                      </button>
                      {domain && (
                        <button onClick={() => (setMenu(false), rule.mutate({ pattern: domain, action: "ignore" }))} className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-muted">
                          <Ban className="h-4 w-4" /> Ignore everything from {domain}
                        </button>
                      )}
                    </>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {s && e.suggestionState === "pending" && (
        <div className="mt-4 flex flex-col gap-3 rounded-lg border border-primary/25 bg-primary-soft/60 p-3 sm:flex-row sm:items-center">
          <ListPlus className="hidden h-4 w-4 shrink-0 text-primary sm:block" />
          <div className="min-w-0 flex-1 text-sm">
            <span className="text-muted-foreground">Suggested task: </span>
            <span className="font-medium">{s.title}</span>
            {s.dueDate && (
              <span className="text-muted-foreground">
                {" "}
                · {dayLabel(s.dueDate, today)}
                {s.dueTime ? ` at ${timeLabel(s.dueTime)}` : ""}
              </span>
            )}
          </div>
          <div className="flex gap-2">
            <Button size="sm" onClick={() => accept.mutate(undefined)} loading={accept.isPending}>
              Add
            </Button>
            <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
              Edit
            </Button>
            <Button size="sm" variant="ghost" onClick={() => dismiss.mutate()} aria-label="No thanks">
              <X className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}
      {e.suggestionState === "accepted" && (
        <p className="mt-3 flex items-center gap-1.5 text-xs text-success">
          <Check className="h-3.5 w-3.5" /> Added to your tasks
        </p>
      )}
      {!s && !e.handled && (e.category === "action" || e.category === "important") && (
        <button onClick={() => setEditing(true)} className="mt-3 flex items-center gap-1.5 text-xs font-medium text-primary hover:underline">
          <ListPlus className="h-3.5 w-3.5" /> Make it a task
        </button>
      )}
      {editing && (
        <TaskEditor
          initial={{ title: s?.title ?? e.subject ?? "", dueDate: s?.dueDate ?? null, dueTime: s?.dueTime ?? null }}
          onClose={() => setEditing(false)}
          onDone={(t) => accept.mutate(t)}
        />
      )}
    </Card>
  );
}
