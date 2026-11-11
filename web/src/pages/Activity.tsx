import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Bell, Bot, History, Mail, Sun } from "lucide-react";
import { get, type ActivityEntry } from "@/lib/api";
import { PageHeader } from "@/components/Layout";
import { Card, EmptyState, PageSpinner, cn, timeAgo } from "@/components/ui";

const ICONS: Record<string, typeof Bell> = { reminder: Bell, summary: Sun, mail: Mail, ai: Bot, error: AlertTriangle };

export default function ActivityPage() {
  const q = useQuery({ queryKey: ["activity"], queryFn: () => get<ActivityEntry[]>("/activity?limit=200"), refetchInterval: 30_000 });
  return (
    <div className="animate-fade-in">
      <PageHeader title="Activity" description="What Docket has done in the background: reminders sent, email sorted, and anything that went wrong." />
      {!q.data ? (
        <PageSpinner />
      ) : !q.data.length ? (
        <EmptyState icon={<History className="h-5 w-5" />} title="Nothing yet">
          Reminders, summaries and email checks will show up here.
        </EmptyState>
      ) : (
        <Card>
          <ul className="divide-y">
            {q.data.map((a) => {
              const Icon = ICONS[a.kind] ?? History;
              return (
                <li key={a.id} className="flex items-start gap-3 px-5 py-3 text-sm">
                  <Icon className={cn("mt-0.5 h-4 w-4 shrink-0", a.kind === "error" ? "text-destructive" : "text-muted-foreground")} />
                  <span className="flex-1">{a.message}</span>
                  <span className="shrink-0 text-xs text-muted-foreground" title={new Date(a.at).toLocaleString()}>
                    {timeAgo(a.at)}
                  </span>
                </li>
              );
            })}
          </ul>
        </Card>
      )}
    </div>
  );
}
