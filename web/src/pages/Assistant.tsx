// The assistant: talk to your local AI and let it change your tasks.
// Every change it makes is listed under its reply with an Undo.
import { useMutation, useQuery } from "@tanstack/react-query";
import { ArrowUp, Bot, Check, CheckCircle2, Clock, CornerUpLeft, MoveRight, Plus, RotateCcw, SkipForward } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Link } from "react-router-dom";
import { api, get, type AssistantAction, type AssistantReply, type ChatTurn, type Status } from "@/lib/api";
import { PageHeader } from "@/components/Layout";
import { useInvalidateTasks } from "@/components/tasks";
import { Button, Card, EmptyState, cn } from "@/components/ui";

interface Turn extends ChatTurn {
  actions?: (AssistantAction & { undone?: boolean })[];
}

const STORE = "docket:assistant";
const SUGGESTIONS = [
  "What do I have tomorrow?",
  "Move today's chores to tomorrow",
  "Remind me to call the vet Friday at 10am",
  "Did anyone email me about a deadline this week?",
];

const ICONS = { added: Plus, done: CheckCircle2, skipped: SkipForward, moved: MoveRight, snoozed: Clock } as const;

function load(): Turn[] {
  try {
    const raw = sessionStorage.getItem(STORE);
    const v = raw ? JSON.parse(raw) : [];
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

export default function AssistantPage() {
  const [turns, setTurns] = useState<Turn[]>(load);
  const [text, setText] = useState("");
  const invalidate = useInvalidateTasks();
  const status = useQuery({ queryKey: ["status"], queryFn: () => get<Status>("/status") });
  const end = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    try {
      sessionStorage.setItem(STORE, JSON.stringify(turns.slice(-40)));
    } catch {
      // private window: the chat just isn't kept
    }
    end.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [turns]);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [text]);

  const send = useMutation({
    mutationFn: (history: Turn[]) =>
      api<AssistantReply>("POST", "/assistant", { messages: history.map(({ role, content }) => ({ role, content })) }),
    onSuccess: (r) => {
      setTurns((t) => [...t, { role: "assistant", content: r.reply, actions: r.actions }]);
      if (r.actions.length) invalidate();
    },
    onError: (e: Error, history) => {
      toast.error(e.message);
      // Give them their words back to try again.
      setTurns(history.slice(0, -1));
      setText(history.at(-1)?.content ?? "");
    },
  });

  const undo = useMutation({
    mutationFn: (v: { turn: number; index: number; action: AssistantAction }) => api<{ message: string }>("POST", "/assistant/undo", { undo: v.action.undo }),
    onSuccess: (r, v) => {
      setTurns((all) => all.map((t, i) => (i === v.turn ? { ...t, actions: t.actions?.map((a, j) => (j === v.index ? { ...a, undone: true } : a)) } : t)));
      invalidate();
      toast.success(r.message);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const go = (said = text) => {
    const t = said.trim();
    if (!t || send.isPending) return;
    const history: Turn[] = [...turns, { role: "user", content: t }];
    setTurns(history);
    setText("");
    send.mutate(history);
  };

  const noAi = status.data && !status.data.ai.configured;

  return (
    <div className="flex min-h-[calc(100vh-8rem)] animate-fade-in flex-col">
      <PageHeader
        title="Assistant"
        description="Ask about your day, or tell it what to change. It can add, finish, skip, move and snooze tasks, and look through your email. Every change has an Undo."
        actions={
          turns.length ? (
            <Button variant="outline" size="sm" onClick={() => setTurns([])} disabled={send.isPending}>
              <RotateCcw className="h-3.5 w-3.5" /> New chat
            </Button>
          ) : undefined
        }
      />

      {noAi ? (
        <EmptyState icon={<Bot className="h-5 w-5" />} title="The assistant needs your local AI" action={<Link to="/settings#ai" className="text-sm font-medium text-primary hover:underline">Set it up in Settings →</Link>}>
          It runs on your own AI server, like the rest of Docket. Nothing is sent to a cloud AI.
        </EmptyState>
      ) : (
        <>
          <div className="flex-1 space-y-4 pb-4" aria-live="polite">
            {!turns.length && (
              <Card className="p-5">
                <p className="mb-3 text-sm text-muted-foreground">Try one of these:</p>
                <div className="flex flex-wrap gap-2">
                  {SUGGESTIONS.map((s) => (
                    <button key={s} onClick={() => go(s)} className="rounded-full border bg-background px-3 py-1.5 text-sm hover:bg-muted">
                      {s}
                    </button>
                  ))}
                </div>
              </Card>
            )}

            {turns.map((t, i) =>
              t.role === "user" ? (
                <div key={i} className="flex justify-end">
                  <div className="max-w-[85%] whitespace-pre-line rounded-2xl rounded-br-md bg-primary px-4 py-2.5 text-[15px] text-primary-foreground">{t.content}</div>
                </div>
              ) : (
                <div key={i} className="flex gap-3">
                  <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary-soft text-primary">
                    <Bot className="h-4 w-4" />
                  </div>
                  <div className="min-w-0 max-w-[85%] space-y-2">
                    <div className="whitespace-pre-line rounded-2xl rounded-tl-md border bg-card px-4 py-2.5 text-[15px] leading-relaxed">{t.content}</div>
                    {!!t.actions?.length && (
                      <ul className="space-y-1.5">
                        {t.actions.map((a, j) => {
                          const Icon = ICONS[a.kind] ?? Check;
                          return (
                            <li key={j} className={cn("flex items-center gap-2 rounded-lg border bg-background/60 px-3 py-2 text-sm", a.undone && "opacity-50")}>
                              <Icon className="h-4 w-4 shrink-0 text-primary" />
                              <span className={cn("flex-1", a.undone && "line-through")}>{a.text}</span>
                              {a.undone ? (
                                <span className="text-xs text-muted-foreground">Undone</span>
                              ) : (
                                <button
                                  onClick={() => undo.mutate({ turn: i, index: j, action: a })}
                                  disabled={undo.isPending}
                                  className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
                                  aria-label={`Undo: ${a.text}`}
                                >
                                  <CornerUpLeft className="h-3.5 w-3.5" /> Undo
                                </button>
                              )}
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </div>
                </div>
              ),
            )}

            {send.isPending && (
              <div className="flex gap-3">
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary-soft text-primary">
                  <Bot className="h-4 w-4" />
                </div>
                <div className="rounded-2xl rounded-tl-md border bg-card px-4 py-3 text-sm text-muted-foreground">
                  <span className="inline-flex gap-1">
                    <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-current [animation-delay:-0.3s]" />
                    <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-current [animation-delay:-0.15s]" />
                    <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-current" />
                  </span>
                </div>
              </div>
            )}
            <div ref={end} />
          </div>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              go();
            }}
            className="sticky bottom-[calc(4.5rem+env(safe-area-inset-bottom))] flex items-end gap-2 rounded-xl lg:bottom-3 border bg-card p-2 pl-4 shadow-sm focus-within:ring-2 focus-within:ring-ring"
          >
            <textarea
              ref={box}
              rows={1}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  go();
                }
              }}
              placeholder="Ask or tell the assistant…"
              aria-label="Message the assistant"
              className="min-h-[40px] flex-1 resize-none bg-transparent py-2 text-[15px] outline-none placeholder:text-muted-foreground/70 focus-visible:ring-0 focus-visible:ring-offset-0"
            />
            <Button type="submit" size="icon" loading={send.isPending} disabled={!text.trim()} aria-label="Send">
              {!send.isPending && <ArrowUp className="h-4 w-4" />}
            </Button>
          </form>
        </>
      )}
    </div>
  );
}
