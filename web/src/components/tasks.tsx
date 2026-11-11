// Task rows, the task editor (with its repeat picker) and the quick-add box.
import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { AlarmClock, AlertCircle, ArrowRight, Bell, BellRing, CalendarClock, Check, Clock, Flag, Mail, MessageCircleQuestion, MoreHorizontal, Pencil, Repeat, SkipForward, Sparkles, Trash2, Wand2, X } from "lucide-react";
import { api, get, type ParsedTask, type Recurrence, type Task, type TaskDetail } from "@/lib/api";
import { WEEKDAYS, dayLabel, timeLabel, ymd } from "@/lib/dates";
import { Badge, Button, Field, Input, Modal, Segmented, Select, cn, timeAgo } from "./ui";

export const nagLabel = (m: number) => (m < 60 ? `${m} min` : m === 60 ? "hour" : `${m / 60} hours`);

export function useInvalidateTasks() {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: ["today"] });
    qc.invalidateQueries({ queryKey: ["tasks"] });
    qc.invalidateQueries({ queryKey: ["lists"] });
    qc.invalidateQueries({ queryKey: ["status"] });
  };
}

export function useLists() {
  return useQuery({ queryKey: ["lists"], queryFn: () => get<{ name: string | null; count: number }[]>("/lists") });
}

function useTaskActions() {
  const invalidate = useInvalidateTasks();
  const undo = async (logId: number) => {
    await api("POST", `/log/${logId}/undo`).catch((e) => toast.error(e.message));
    invalidate();
  };
  const complete = useMutation({
    mutationFn: (t: Task) => api<{ task: Task; logId: number }>("POST", `/tasks/${t.id}/complete`),
    onSuccess: (r, t) => {
      invalidate();
      const next = r.task.recurrence && r.task.dueDate ? ` Next: ${dayLabel(r.task.dueDate, ymd(new Date())).toLowerCase()}.` : "";
      toast.success(`Done: ${t.title}.${next}`, { action: { label: "Undo", onClick: () => undo(r.logId) } });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const skip = useMutation({
    mutationFn: (t: Task) => api<{ task: Task; logId: number }>("POST", `/tasks/${t.id}/skip`),
    onSuccess: (r, t) => {
      invalidate();
      toast(`Skipped ${t.title} this time. Next: ${dayLabel(r.task.dueDate!, ymd(new Date())).toLowerCase()}.`, { action: { label: "Undo", onClick: () => undo(r.logId) } });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const remove = useMutation({
    mutationFn: (t: Task) => api<{ task: Task }>("DELETE", `/tasks/${t.id}`),
    onSuccess: (_r, t) => {
      invalidate();
      toast(`Deleted ${t.title}`, {
        action: {
          label: "Undo",
          onClick: async () => {
            await api("POST", "/tasks", { title: t.title, notes: t.notes, list: t.list, dueDate: t.dueDate, dueTime: t.dueTime, recurrence: t.recurrence, priority: t.priority });
            invalidate();
          },
        },
      });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const snooze = useMutation({
    mutationFn: (t: Task) => api<Task>("POST", `/tasks/${t.id}/snooze`, { minutes: 60 }),
    onSuccess: (_r, t) => {
      invalidate();
      toast(`Snoozed ${t.title} for an hour`);
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const tomorrow = useMutation({
    mutationFn: (t: Task) => api<Task>("POST", `/tasks/${t.id}/tomorrow`),
    onSuccess: (_r, t) => {
      invalidate();
      toast(`Moved ${t.title} to tomorrow`);
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const reopen = useMutation({
    mutationFn: (t: Task) => api<Task>("POST", `/tasks/${t.id}/reopen`),
    onSuccess: invalidate,
    onError: (e: Error) => toast.error(e.message),
  });
  return { complete, skip, remove, reopen, snooze, tomorrow };
}

/** The chips under a task's title. */
export function TaskMeta({
  task,
  today,
  showDate = true,
}: {
  task: Pick<Task, "dueDate" | "dueTime" | "repeatText" | "list" | "priority" | "source"> & { lastDone?: number | null; nagMinutes?: number; snoozedUntil?: number | null };
  today: string;
  showDate?: boolean;
}) {
  const overdue = task.dueDate && task.dueDate < today;
  return (
    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
      {showDate && task.dueDate && (
        <span className={cn("inline-flex items-center gap-1", overdue && "font-medium text-destructive")}>
          {overdue && <AlertCircle className="h-3 w-3" />}
          {dayLabel(task.dueDate, today)}
        </span>
      )}
      {task.dueTime && (
        <span className="inline-flex items-center gap-1">
          <Clock className="h-3 w-3" />
          {timeLabel(task.dueTime)}
        </span>
      )}
      {task.repeatText && (
        <span className="inline-flex items-center gap-1">
          <Repeat className="h-3 w-3" />
          {task.repeatText.replace(", from when it's done", "")}
        </span>
      )}
      {task.list && <span className="rounded bg-muted px-1.5 py-px font-medium">{task.list}</span>}
      {task.priority === 2 && (
        <span className="inline-flex items-center gap-1 font-medium text-warning">
          <Flag className="h-3 w-3" /> High
        </span>
      )}
      {!!task.nagMinutes && (
        <span className="inline-flex items-center gap-1 font-medium text-warning" title={`Reminds you every ${nagLabel(task.nagMinutes)} until it's done`}>
          <BellRing className="h-3 w-3" /> Nags
        </span>
      )}
      {task.snoozedUntil && (
        <span className="inline-flex items-center gap-1">
          <AlarmClock className="h-3 w-3" /> Snoozed till {new Date(task.snoozedUntil).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}
        </span>
      )}
      {task.source === "email" && (
        <span className="inline-flex items-center gap-1">
          <Mail className="h-3 w-3" /> From email
        </span>
      )}
      {task.lastDone && task.repeatText && <span>Last done {timeAgo(task.lastDone)}</span>}
    </div>
  );
}

export function TaskItem({ task, today, showDate = true }: { task: Task; today: string; showDate?: boolean }) {
  const { complete, skip, remove, reopen, snooze, tomorrow } = useTaskActions();
  const [editing, setEditing] = useState(false);
  const [menu, setMenu] = useState(false);
  const done = !!task.doneAt;
  return (
    <li className="group relative flex items-start gap-3 px-4 py-3 transition-colors hover:bg-muted/40 sm:px-5">
      <button
        onClick={() => (done ? reopen.mutate(task) : complete.mutate(task))}
        disabled={complete.isPending}
        className={cn(
          "mt-0.5 flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full border-2 transition-colors",
          done ? "border-primary bg-primary text-primary-foreground" : task.priority === 2 ? "border-warning hover:bg-warning/15" : "border-input hover:border-primary hover:bg-primary-soft",
        )}
        aria-label={done ? `Mark ${task.title} as not done` : `Mark ${task.title} as done`}
        title={done ? "Mark as not done" : task.recurrence ? "Done (moves to the next date)" : "Done"}
      >
        {(done || complete.isPending) && <Check className="h-3.5 w-3.5" strokeWidth={3} />}
      </button>
      <button className="min-w-0 flex-1 text-left" onClick={() => setEditing(true)}>
        <div className={cn("text-[15px] font-medium leading-snug", done && "text-muted-foreground line-through")}>{task.title}</div>
        <TaskMeta task={task} today={today} showDate={showDate} />
      </button>
      <div className="relative">
        <button
          onClick={() => setMenu((m) => !m)}
          className="rounded-md p-1.5 text-muted-foreground opacity-100 hover:bg-muted hover:text-foreground sm:opacity-0 sm:group-hover:opacity-100 sm:focus:opacity-100"
          aria-label="More"
        >
          <MoreHorizontal className="h-4 w-4" />
        </button>
        {menu && (
          <>
            <div className="fixed inset-0 z-10" onClick={() => setMenu(false)} />
            <div className="absolute right-0 z-20 mt-1 w-44 overflow-hidden rounded-lg border bg-card py-1 shadow-lg animate-pop-in">
              <MenuItem icon={Pencil} onClick={() => (setMenu(false), setEditing(true))}>
                Edit
              </MenuItem>
              {task.recurrence && !done && (
                <MenuItem icon={SkipForward} onClick={() => (setMenu(false), skip.mutate(task))}>
                  Skip this time
                </MenuItem>
              )}
              {!done && task.dueDate && task.dueDate <= today && (
                <>
                  {(task.dueTime || task.nagMinutes > 0) && (
                    <MenuItem icon={AlarmClock} onClick={() => (setMenu(false), snooze.mutate(task))}>
                      Snooze 1 hour
                    </MenuItem>
                  )}
                  <MenuItem icon={CalendarClock} onClick={() => (setMenu(false), tomorrow.mutate(task))}>
                    Move to tomorrow
                  </MenuItem>
                </>
              )}
              <MenuItem icon={Trash2} danger onClick={() => (setMenu(false), remove.mutate(task))}>
                Delete
              </MenuItem>
            </div>
          </>
        )}
      </div>
      {editing && <TaskEditor taskId={task.id} initial={task} onClose={() => setEditing(false)} />}
    </li>
  );
}

function MenuItem({ icon: Icon, children, onClick, danger }: { icon: typeof Pencil; children: React.ReactNode; onClick: () => void; danger?: boolean }) {
  return (
    <button onClick={onClick} className={cn("flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm hover:bg-muted", danger && "text-destructive")}>
      <Icon className="h-4 w-4" />
      {children}
    </button>
  );
}

export function TaskList({ tasks, today, showDate = true }: { tasks: Task[]; today: string; showDate?: boolean }) {
  return (
    <ul className="divide-y">
      {tasks.map((t) => (
        <TaskItem key={t.id} task={t} today={today} showDate={showDate} />
      ))}
    </ul>
  );
}

// --- Editor ---------------------------------------------------------------------------

type Draft = {
  title: string;
  notes: string;
  list: string;
  dueDate: string;
  dueTime: string;
  recurrence: Recurrence | null;
  priority: number;
  nagMinutes: number;
};

const toDraft = (t?: Partial<ParsedTask>): Draft => ({
  title: t?.title ?? "",
  notes: t?.notes ?? "",
  list: t?.list ?? "",
  dueDate: t?.dueDate ?? "",
  dueTime: t?.dueTime ?? "",
  recurrence: t?.recurrence ?? null,
  priority: t?.priority ?? 1,
  nagMinutes: t?.nagMinutes ?? 0,
});

const fromDraft = (d: Draft): ParsedTask => ({
  title: d.title.trim(),
  notes: d.notes.trim() || null,
  list: d.list.trim() || null,
  dueDate: d.dueDate || null,
  dueTime: d.dueDate && d.dueTime ? d.dueTime : null,
  recurrence: d.recurrence,
  priority: d.priority,
  nagMinutes: d.nagMinutes,
});

/**
 * Edits a saved task (taskId), creates a new one (no taskId, no onDone), or
 * edits a not-yet-saved draft from quick add (onDone gets the result).
 */
export function TaskEditor({
  taskId,
  initial,
  onClose,
  onDone,
}: {
  taskId?: number;
  initial?: Partial<ParsedTask>;
  onClose: () => void;
  onDone?: (t: ParsedTask) => void;
}) {
  const invalidate = useInvalidateTasks();
  const [d, setD] = useState<Draft>(() => toDraft(initial));
  const [error, setError] = useState<string | null>(null);
  const lists = useLists().data?.map((l) => l.name).filter((n): n is string => !!n) ?? [];
  const detail = useQuery({ queryKey: ["task", taskId], queryFn: () => get<TaskDetail>(`/tasks/${taskId}`), enabled: !!taskId });
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((p) => ({ ...p, [k]: v }));

  const save = useMutation({
    mutationFn: async () => {
      const body = fromDraft(d);
      if (!body.title) throw new Error("Give the task a name");
      if (onDone) return onDone(body);
      if (taskId) await api("PATCH", `/tasks/${taskId}`, body);
      else await api("POST", "/tasks", body);
    },
    onSuccess: () => {
      if (!onDone) {
        invalidate();
        toast.success(taskId ? "Saved" : "Added");
      }
      onClose();
    },
    onError: (e: Error) => setError(e.message),
  });

  return (
    <Modal
      open
      onClose={onClose}
      title={taskId ? "Edit task" : onDone ? "Adjust before adding" : "New task"}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => save.mutate()} loading={save.isPending}>
            {onDone ? "Done" : taskId ? "Save" : "Add task"}
          </Button>
        </>
      }
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <Field label="What" htmlFor="t-title">
          <Input id="t-title" value={d.title} onChange={(e) => set("title", e.target.value)} placeholder="Feed the gecko" autoFocus />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Date" htmlFor="t-date">
            <Input id="t-date" type="date" value={d.dueDate} onChange={(e) => set("dueDate", e.target.value)} />
          </Field>
          <Field label="Time" htmlFor="t-time" hint={d.dueTime ? "You'll get a push at this time" : undefined}>
            <Input id="t-time" type="time" value={d.dueTime} disabled={!d.dueDate} onChange={(e) => set("dueTime", e.target.value)} />
          </Field>
        </div>
        <RepeatEditor value={d.recurrence} onChange={(r) => set("recurrence", r)} />
        <div className="grid grid-cols-2 gap-3">
          <Field label="List" htmlFor="t-list">
            <Input id="t-list" list="t-lists" value={d.list} onChange={(e) => set("list", e.target.value)} placeholder="Pets" />
            <datalist id="t-lists">
              {lists.map((l) => (
                <option key={l} value={l} />
              ))}
            </datalist>
          </Field>
          <Field label="Priority">
            <Segmented
              value={String(d.priority) as "0" | "1" | "2"}
              onChange={(v) => set("priority", Number(v))}
              options={[
                { value: "0", label: "Low" },
                { value: "1", label: "Normal" },
                { value: "2", label: "High" },
              ]}
            />
          </Field>
        </div>
        <Field
          label="Nag me"
          htmlFor="t-nag"
          hint={
            d.nagMinutes
              ? `After ${d.dueTime ? "its time" : "your summary time"}, it pushes again every ${nagLabel(d.nagMinutes)} until it's done or snoozed (quiet 10 PM–7 AM).`
              : "For things you can't let slide, like feeding or meds."
          }
        >
          <Select id="t-nag" value={d.nagMinutes} onChange={(e) => set("nagMinutes", Number(e.target.value))}>
            <option value={0}>No, remind me once</option>
            {[10, 15, 30, 60, 120].map((m) => (
              <option key={m} value={m}>
                Every {nagLabel(m)} until it's done
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Notes" htmlFor="t-notes">
          <textarea
            id="t-notes"
            value={d.notes}
            onChange={(e) => set("notes", e.target.value)}
            rows={2}
            className="w-full rounded-lg border border-input bg-card px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground/70 focus-visible:ring-offset-0"
          />
        </Field>
        {error && <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}
        <button type="submit" hidden />
      </form>
      {detail.data && (detail.data.history.length > 0 || detail.data.email) && (
        <div className="mt-5 space-y-2 border-t pt-4 text-sm">
          {detail.data.email && (
            <p className="flex items-center gap-2 text-muted-foreground">
              <Mail className="h-4 w-4" /> From an email by {detail.data.email.fromName || detail.data.email.fromAddr}: “{detail.data.email.subject}”
            </p>
          )}
          {detail.data.history.length > 0 && (
            <div>
              <div className="mb-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">History</div>
              <div className="flex flex-wrap gap-1.5">
                {detail.data.history.slice(0, 14).map((h) => (
                  <Badge key={h.id} tone={h.action === "done" ? "success" : "neutral"}>
                    {h.action === "done" ? <Check className="h-3 w-3" /> : <SkipForward className="h-3 w-3" />}
                    {new Date(h.at).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                  </Badge>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

export function RepeatEditor({ value, onChange }: { value: Recurrence | null; onChange: (r: Recurrence | null) => void }) {
  const kind = !value ? "none" : value.unit === "week" && value.weekdays?.length ? "days" : "every";
  const setKind = (k: string) => {
    if (k === "none") onChange(null);
    else if (k === "days") onChange({ every: 1, unit: "week", weekdays: value?.weekdays?.length ? value.weekdays : [new Date().getDay()], from: "due" });
    else onChange({ every: value?.every && value.unit !== "week" ? value.every : 1, unit: value?.unit && !value.weekdays?.length ? value.unit : "day", from: value?.from ?? "done" });
  };
  return (
    <Field label="Repeat">
      <div className="space-y-3">
        <Segmented
          value={kind}
          onChange={setKind}
          options={[
            { value: "none", label: "Once" },
            { value: "every", label: "Every…" },
            { value: "days", label: "On days" },
          ]}
        />
        {value && kind === "every" && (
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground">Every</span>
            <Input
              type="number"
              min={1}
              max={365}
              className="w-20"
              value={value.every}
              onChange={(e) => onChange({ ...value, every: Math.max(1, Math.min(365, Number(e.target.value) || 1)) })}
              aria-label="How many"
            />
            <Select className="w-32" value={value.unit} onChange={(e) => onChange({ ...value, unit: e.target.value as Recurrence["unit"], from: e.target.value === "day" ? value.from : "due" })} aria-label="Unit">
              <option value="day">{value.every === 1 ? "day" : "days"}</option>
              <option value="week">{value.every === 1 ? "week" : "weeks"}</option>
              <option value="month">{value.every === 1 ? "month" : "months"}</option>
              <option value="year">{value.every === 1 ? "year" : "years"}</option>
            </Select>
          </div>
        )}
        {value && kind === "days" && (
          <div className="flex flex-wrap gap-1.5">
            {WEEKDAYS.map((name, i) => {
              const on = value.weekdays?.includes(i);
              return (
                <button
                  type="button"
                  key={name}
                  onClick={() => {
                    const days = on ? value.weekdays!.filter((x) => x !== i) : [...(value.weekdays ?? []), i].sort();
                    if (days.length) onChange({ ...value, weekdays: days });
                  }}
                  className={cn("h-9 w-11 rounded-lg border text-sm font-medium", on ? "border-primary bg-primary text-primary-foreground" : "bg-card hover:bg-muted")}
                >
                  {name}
                </button>
              );
            })}
          </div>
        )}
        {value && kind === "every" && (
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-0.5 accent-[hsl(var(--primary))]" checked={value.from === "done"} onChange={(e) => onChange({ ...value, from: e.target.checked ? "done" : "due" })} />
            <span>
              Count from when it's done
              <span className="block text-xs text-muted-foreground">
                {value.from === "done" ? "Do it a day late and the next one moves a day later too." : "Keeps to the calendar, however late you were."}
              </span>
            </span>
          </label>
        )}
      </div>
    </Field>
  );
}

// --- Quick add --------------------------------------------------------------------------

const EXAMPLES = [
  "Feed the frogs every other day",
  "Dentist Friday at 3pm",
  "Pay rent on the 1st every month",
  "Water plants Mondays and Thursdays",
  "When did I last feed the gecko?",
];

export function QuickAdd() {
  const invalidate = useInvalidateTasks();
  const [text, setText] = useState("");
  const [preview, setPreview] = useState<{ tasks: ParsedTask[]; via: string; note?: string } | null>(null);
  const [editing, setEditing] = useState<number | null>(null);
  const [placeholder] = useState(() => EXAMPLES[Math.floor(Math.random() * EXAMPLES.length)]);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [text]);

  const [answer, setAnswer] = useState<{ question: string; answer: string } | null>(null);
  const parse = useMutation({
    mutationFn: () => api<{ tasks: ParsedTask[]; via: string; note?: string }>("POST", "/parse", { text }),
    onSuccess: (r) => setPreview(r),
    onError: (e: Error) => toast.error(e.message),
  });
  const ask = useMutation({
    mutationFn: (question: string) => api<{ answer: string }>("POST", "/ask", { question }),
    onSuccess: (r, question) => setAnswer({ question, answer: r.answer }),
    onError: (e: Error) => toast.error(e.message),
  });
  /** A question ("when did I last feed the gecko?") is asked; anything else becomes tasks. */
  const go = () => {
    const t = text.trim();
    if (!t) return;
    if (t.endsWith("?")) ask.mutate(t);
    else parse.mutate();
  };
  const add = useMutation({
    mutationFn: () => api<Task[]>("POST", "/tasks/bulk", { tasks: preview!.tasks, source: preview!.via === "ai" ? "ai" : "manual" }),
    onSuccess: (r) => {
      invalidate();
      setPreview(null);
      setText("");
      toast.success(r.length === 1 ? `Added ${r[0].title}` : `Added ${r.length} tasks`);
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const today = ymd(new Date());
  const tasks = preview?.tasks ?? [];

  return (
    <>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          go();
        }}
        className="flex items-end gap-2 rounded-xl border bg-card p-2 pl-4 shadow-sm focus-within:ring-2 focus-within:ring-ring"
      >
        <Sparkles className="mb-2.5 h-4 w-4 shrink-0 text-primary" />
        <textarea
          ref={ref}
          rows={1}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              go();
            }
          }}
          placeholder={placeholder}
          aria-label="Add a task in your own words"
          className="min-h-[40px] flex-1 resize-none bg-transparent py-2 text-[15px] outline-none placeholder:text-muted-foreground/70 focus-visible:ring-0 focus-visible:ring-offset-0"
        />
        <Button type="submit" loading={parse.isPending || ask.isPending} disabled={!text.trim()}>
          {!parse.isPending && !ask.isPending && (text.trim().endsWith("?") ? <MessageCircleQuestion className="h-4 w-4" /> : <ArrowRight className="h-4 w-4" />)}
          <span className="hidden sm:inline">{text.trim().endsWith("?") ? "Ask" : "Add"}</span>
        </Button>
      </form>

      <Modal
        open={!!preview}
        onClose={() => setPreview(null)}
        wide
        title={tasks.length === 1 ? "Here's what I got" : `Here's what I got: ${tasks.length} tasks`}
        description={
          preview?.via === "ai" ? (
            <span className="inline-flex items-center gap-1.5">
              <Wand2 className="h-3.5 w-3.5" /> Read by your local AI. Check it over, then add.
            </span>
          ) : (
            (preview?.note ?? "Read with the built-in rules (no local AI set up). Check it over, then add.")
          )
        }
        footer={
          <>
            <Button variant="outline" onClick={() => setPreview(null)}>
              Cancel
            </Button>
            <Button onClick={() => add.mutate()} loading={add.isPending} disabled={!tasks.length}>
              {tasks.length === 1 ? "Add task" : `Add ${tasks.length} tasks`}
            </Button>
          </>
        }
      >
        <ul className="space-y-2">
          {tasks.map((t, i) => (
            <li key={i} className="flex items-start gap-3 rounded-lg border bg-background/60 p-3">
              <div className="min-w-0 flex-1">
                <div className="font-medium">{t.title}</div>
                <PreviewMeta task={t} today={today} />
              </div>
              <button onClick={() => setEditing(i)} className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground" aria-label={`Change ${t.title}`}>
                <Pencil className="h-4 w-4" />
              </button>
              <button
                onClick={() => setPreview((p) => (p ? { ...p, tasks: p.tasks.filter((_, j) => j !== i) } : p))}
                className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-destructive"
                aria-label={`Remove ${t.title}`}
              >
                <X className="h-4 w-4" />
              </button>
            </li>
          ))}
        </ul>
        {!tasks.length && <p className="py-6 text-center text-sm text-muted-foreground">Nothing left to add.</p>}
      </Modal>
      <Modal
        open={!!answer}
        onClose={() => setAnswer(null)}
        title={answer?.question ?? ""}
        description={
          <span className="inline-flex items-center gap-1.5">
            <Wand2 className="h-3.5 w-3.5" /> Answered by your local AI from your tasks, history, calendar and email.
          </span>
        }
        footer={
          <>
            <Button
              variant="ghost"
              onClick={() => {
                setAnswer(null);
                parse.mutate();
              }}
            >
              It was a task, add it
            </Button>
            <Button
              onClick={() => {
                setAnswer(null);
                setText("");
              }}
            >
              Thanks
            </Button>
          </>
        }
      >
        <p className="whitespace-pre-line pb-2 text-[15px] leading-relaxed">{answer?.answer}</p>
      </Modal>
      {editing !== null && preview && (
        <TaskEditor
          initial={preview.tasks[editing]}
          onClose={() => setEditing(null)}
          onDone={(t) => setPreview((p) => (p ? { ...p, tasks: p.tasks.map((x, j) => (j === editing ? t : x)) } : p))}
        />
      )}
    </>
  );
}

function PreviewMeta({ task, today }: { task: ParsedTask; today: string }) {
  const repeatText = useMemo(() => describeRepeat(task.recurrence), [task.recurrence]);
  return (
    <>
      <TaskMeta task={{ ...task, repeatText, source: "ai" }} today={today} />
      {!task.dueDate && <p className="mt-1 text-xs text-muted-foreground">No date: it'll sit under “Anytime”.</p>}
      {task.dueTime && (
        <p className="mt-1 inline-flex items-center gap-1 text-xs text-muted-foreground">
          <Bell className="h-3 w-3" /> You'll get a push at {timeLabel(task.dueTime)}
        </p>
      )}
      {task.recurrence?.from === "done" && <p className="mt-1 text-xs text-muted-foreground">The next one is counted from when you actually do it.</p>}
    </>
  );
}

/** Mirrors the server's wording, for drafts that haven't been saved yet. */
export function describeRepeat(r: Recurrence | null): string | null {
  if (!r) return null;
  const n = r.every;
  const each = (s: string, p: string) => (n === 1 ? `Every ${s}` : n === 2 ? `Every other ${s}` : `Every ${n} ${p}`);
  if (r.unit === "week" && r.weekdays?.length) {
    const key = r.weekdays.join(",");
    const names = key === "1,2,3,4,5" ? "weekday" : key === "0,6" ? "weekend" : r.weekdays.map((d) => WEEKDAYS[d]).join(", ");
    return n === 1 ? `Every ${names}` : `Every ${n === 2 ? "other" : n} week${n > 2 ? "s" : ""} on ${names}`;
  }
  if (r.unit === "day") return each("day", "days");
  if (r.unit === "week") return each("week", "weeks");
  if (r.unit === "month") return each("month", "months");
  return each("year", "years");
}
