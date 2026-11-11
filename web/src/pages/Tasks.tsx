import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ListTodo, Plus, Search } from "lucide-react";
import { get, type Task } from "@/lib/api";
import { ymd } from "@/lib/dates";
import { PageHeader } from "@/components/Layout";
import { TaskEditor, TaskList, useLists } from "@/components/tasks";
import { Button, Card, EmptyState, Input, PageSpinner, Segmented, cn } from "@/components/ui";

type View = "open" | "repeating" | "done";

export default function TasksPage() {
  const [view, setView] = useState<View>("open");
  const [q, setQ] = useState("");
  const [list, setList] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const lists = useLists().data ?? [];
  const tasks = useQuery({
    queryKey: ["tasks", view === "done" ? "done" : "open", q, list],
    queryFn: () => {
      const p = new URLSearchParams({ status: view === "done" ? "done" : "open" });
      if (q.trim()) p.set("q", q.trim());
      if (list) p.set("list", list);
      return get<Task[]>(`/tasks?${p}`);
    },
    placeholderData: (prev) => prev,
  });
  const today = ymd(new Date());
  let rows = tasks.data ?? [];
  if (view === "repeating") rows = rows.filter((t) => t.recurrence);

  // Group open tasks by list; done tasks stay in the order they were done.
  const groups: [string, Task[]][] =
    view === "done"
      ? [["", rows]]
      : Object.entries(
          rows.reduce<Record<string, Task[]>>((acc, t) => {
            (acc[t.list ?? ""] ??= []).push(t);
            return acc;
          }, {}),
        ).sort(([a], [b]) => (a === "" ? 1 : b === "" ? -1 : a.localeCompare(b)));

  return (
    <div className="animate-fade-in">
      <PageHeader
        title="Tasks"
        description="Everything on your list. Click a task to change it, its repeat, or see when you last did it."
        actions={
          <Button onClick={() => setCreating(true)}>
            <Plus className="h-4 w-4" /> New task
          </Button>
        }
      />
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center">
        <Segmented
          value={view}
          onChange={setView}
          options={[
            { value: "open", label: "To do" },
            { value: "repeating", label: "Repeating" },
            { value: "done", label: "Done" },
          ]}
        />
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input className="pl-9" placeholder="Search" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search tasks" />
        </div>
      </div>
      {lists.length > 1 && view !== "done" && (
        <div className="scrollbar-none -mx-4 mb-5 flex gap-1.5 overflow-x-auto px-4 sm:mx-0 sm:flex-wrap sm:px-0">
          <Chip active={!list} onClick={() => setList(null)}>
            All
          </Chip>
          {lists.map((l) => (
            <Chip key={l.name ?? "__none"} active={list === (l.name ?? "__none")} onClick={() => setList(l.name ?? "__none")}>
              {l.name ?? "No list"} <span className="opacity-60">{l.count}</span>
            </Chip>
          ))}
        </div>
      )}

      {tasks.isLoading ? (
        <PageSpinner />
      ) : !rows.length ? (
        <EmptyState icon={<ListTodo className="h-5 w-5" />} title={q ? "Nothing matches" : view === "done" ? "Nothing finished yet" : view === "repeating" ? "No repeating tasks" : "Your list is empty"}>
          {view === "repeating" ? "Say “every other day”, “weekly” or “on Mondays” when you add something, and it'll repeat." : undefined}
        </EmptyState>
      ) : (
        <div className="space-y-5">
          {groups.map(([name, items]) => (
            <section key={name || "none"}>
              {view !== "done" && <h2 className="mb-2 px-1 text-sm font-semibold">{name || "No list"}<span className="ml-2 font-normal text-muted-foreground">{items.length}</span></h2>}
              <Card className="overflow-hidden">
                <TaskList tasks={items} today={today} />
              </Card>
            </section>
          ))}
        </div>
      )}
      {creating && <TaskEditor onClose={() => setCreating(false)} initial={list && list !== "__none" ? { list } : undefined} />}
    </div>
  );
}

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1 text-[13px] font-medium transition-colors",
        active ? "border-primary bg-primary text-primary-foreground" : "bg-card text-muted-foreground hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}
