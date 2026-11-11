// Settings sections. The setup wizard shows the same ones, a step at a time.
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { AlertTriangle, Ban, Bell, Bot, CalendarDays, CheckCircle2, Copy, ExternalLink, GraduationCap, KeyRound, LayoutGrid, Loader2, Mail, Pencil, Plus, RefreshCw, Star, Trash2 } from "lucide-react";
import { api, get, type MailAccount, type MicrosoftFlow, type SenderRule, type Settings, type Source, type WidgetKey } from "@/lib/api";
import { Badge, Button, Card, CardBody, CardHeader, Field, Input, Modal, Select, Switch, cn, timeAgo } from "./ui";

export function useSettings() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["settings"], queryFn: () => get<Settings>("/settings") });
  const save = useMutation({
    mutationFn: (patch: Record<string, unknown>) => api<Settings>("PUT", "/settings", patch),
    onSuccess: (s) => {
      qc.setQueryData(["settings"], s);
      qc.invalidateQueries({ queryKey: ["status"] });
    },
  });
  return { settings: q.data, save };
}

function Row({ title, hint, children }: { title: React.ReactNode; hint?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 py-3">
      <div>
        <div className="text-sm font-medium">{title}</div>
        {hint && <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{hint}</p>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

function SecretInput({ id, set, value, onChange, placeholder }: { id: string; set: boolean; value: string; onChange: (v: string) => void; placeholder?: string }) {
  return <Input id={id} type="password" autoComplete="off" value={value} onChange={(e) => onChange(e.target.value)} placeholder={set ? "Saved (type to replace)" : placeholder} />;
}

// --- Local AI ---------------------------------------------------------------------------

export function AiSection({ onSaved }: { onSaved?: () => void }) {
  const { settings, save } = useSettings();
  const [provider, setProvider] = useState<Settings["aiProvider"]>("ollama");
  const [url, setUrl] = useState("");
  const [model, setModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [aboutMe, setAboutMe] = useState("");
  const [models, setModels] = useState<string[] | null>(null);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    if (!settings) return;
    setProvider(settings.aiProvider);
    setUrl(settings.aiUrl);
    setModel(settings.aiModel);
    setAboutMe(settings.aboutMe);
  }, [settings]);

  const test = useMutation({
    mutationFn: (withModel: boolean) =>
      api<{ models: string[]; tried: string | null }>("POST", "/ai/test", { provider, url, apiKey: apiKey || undefined, model: withModel ? model : undefined }),
    onSuccess: (r, withModel) => {
      setModels(r.models);
      if (!model && r.models.length) setModel(r.models[0]);
      setResult({ ok: true, text: withModel && r.tried ? r.tried : `Connected. ${r.models.length} model${r.models.length === 1 ? "" : "s"} available.` });
    },
    onError: (e: Error) => setResult({ ok: false, text: e.message }),
  });

  const submit = () =>
    save.mutate(
      { aiProvider: provider, aiUrl: url, aiModel: model, aboutMe, ...(apiKey ? { aiApiKey: apiKey } : {}) },
      {
        onSuccess: () => {
          toast.success("Saved");
          setApiKey("");
          onSaved?.();
        },
        onError: (e: Error) => toast.error(e.message),
      },
    );

  if (!settings) return null;
  const off = provider === "none";
  return (
    <Card id="ai">
      <CardHeader
        icon={<Bot className="h-5 w-5" />}
        title="Local AI"
        description="The model on your PC that reads what you type, sorts your email and writes your morning summary. Nothing leaves your network."
      />
      <CardBody className="space-y-4">
        <Field label="AI server">
          <Select value={provider} onChange={(e) => (setProvider(e.target.value as Settings["aiProvider"]), setModels(null), setResult(null))}>
            <option value="ollama">Ollama</option>
            <option value="openai">LM Studio, llama.cpp or another OpenAI-style server</option>
            <option value="none">Don't use AI (built-in rules only)</option>
          </Select>
        </Field>
        {!off && (
          <>
            <Field
              label="Address"
              htmlFor="ai-url"
              hint={
                provider === "ollama" ? (
                  <>
                    Your PC's address on the network, port 11434, like <code>http://192.168.1.20:11434</code>. On the PC, set the environment variable <code>OLLAMA_HOST=0.0.0.0</code> and restart Ollama so other machines can reach it. Same machine as Docker? Use <code>http://host.docker.internal:11434</code>.
                  </>
                ) : (
                  <>
                    Like <code>http://192.168.1.20:1234</code> for LM Studio (turn on “Serve on local network” in its server settings).
                  </>
                )
              }
            >
              <div className="flex gap-2">
                <Input id="ai-url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder={provider === "ollama" ? "http://192.168.1.20:11434" : "http://192.168.1.20:1234"} />
                <Button variant="outline" onClick={() => test.mutate(false)} loading={test.isPending && !test.variables} disabled={!url.trim()}>
                  Connect
                </Button>
              </div>
            </Field>
            {provider === "openai" && (
              <Field label="API key" htmlFor="ai-key" hint="Only if your server asks for one.">
                <SecretInput id="ai-key" set={settings.aiApiKeySet} value={apiKey} onChange={setApiKey} />
              </Field>
            )}
            <Field label="Model" htmlFor="ai-model" hint="An instruction-tuned model of 7–8B or more does well: llama3.1:8b, qwen2.5:7b, gemma3:12b, mistral-nemo.">
              <div className="flex gap-2">
                {models?.length ? (
                  <Select id="ai-model" value={model} onChange={(e) => setModel(e.target.value)}>
                    {!models.includes(model) && model && <option value={model}>{model}</option>}
                    {models.map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </Select>
                ) : (
                  <Input id="ai-model" value={model} onChange={(e) => setModel(e.target.value)} placeholder="llama3.1:8b" />
                )}
                <Button variant="outline" onClick={() => test.mutate(true)} loading={test.isPending && !!test.variables} disabled={!url.trim() || !model.trim()}>
                  Try it
                </Button>
              </div>
            </Field>
            {result && (
              <p className={cn("flex items-start gap-2 rounded-lg px-3 py-2 text-sm", result.ok ? "bg-success/10 text-success" : "bg-destructive/10 text-destructive")}>
                {result.ok ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" /> : <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />}
                {result.text}
              </p>
            )}
            <Field label="About you" htmlFor="ai-about" hint="A line or two the AI keeps in mind, so it knows what matters. Optional.">
              <textarea
                id="ai-about"
                rows={3}
                value={aboutMe}
                onChange={(e) => setAboutMe(e.target.value)}
                placeholder="I'm a student at Wabash College (wabash.edu email). I keep dart frogs and a leopard gecko. Anything from my bank or landlord is important."
                className="w-full rounded-lg border border-input bg-card px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground/70 focus-visible:ring-offset-0"
              />
            </Field>
          </>
        )}
        <p className="text-xs leading-relaxed text-muted-foreground">
          When your PC is off, Docket keeps working: quick add uses its built-in rules, email is sorted with basic checks, and the AI goes back over that email once it's reachable again.
        </p>
        <div className="flex justify-end">
          <Button onClick={submit} loading={save.isPending}>
            Save
          </Button>
        </div>
      </CardBody>
    </Card>
  );
}

// --- Notifications -------------------------------------------------------------------------

export function NotifySection({ onSaved }: { onSaved?: () => void }) {
  const { settings, save } = useSettings();
  const [f, setF] = useState({
    pushoverToken: "",
    pushoverUser: "",
    pushoverDevices: "",
    ntfyServer: "",
    ntfyTopic: "",
    ntfyAuth: "none" as Settings["ntfyAuth"],
    ntfyUsername: "",
    ntfyPassword: "",
    ntfyToken: "",
    ntfyPriority: 3,
    publicUrl: "",
  });
  useEffect(() => {
    if (!settings) return;
    // A v0.1.0 "https://ntfy.sh/topic" address is shown split into the two fields.
    const legacy = settings.ntfyUrl.match(/^(https?:\/\/.+)\/([^/]+)$/);
    setF((p) => ({
      ...p,
      pushoverDevices: settings.pushoverDevices,
      ntfyServer: settings.ntfyServer || legacy?.[1] || "",
      ntfyTopic: settings.ntfyTopic || legacy?.[2] || "",
      ntfyAuth: settings.ntfyAuth === "none" && !settings.ntfyServer && settings.ntfyTokenSet ? "token" : settings.ntfyAuth,
      ntfyUsername: settings.ntfyUsername,
      ntfyPriority: settings.ntfyPriority,
      publicUrl: settings.publicUrl || "",
    }));
  }, [settings]);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF((p) => ({ ...p, [k]: e.target.value }));
  const test = useMutation({
    mutationFn: () => api<{ sent: string[] }>("POST", "/notify/test"),
    onSuccess: (r) => toast.success(`Sent through ${r.sent.join(" and ")}`),
    onError: (e: Error) => toast.error(e.message),
  });
  if (!settings) return null;
  const body: Record<string, unknown> = {
    pushoverDevices: f.pushoverDevices,
    ntfyServer: f.ntfyServer,
    ntfyTopic: f.ntfyTopic,
    ntfyAuth: f.ntfyAuth,
    ntfyUsername: f.ntfyUsername,
    ntfyPriority: Number(f.ntfyPriority),
    publicUrl: f.publicUrl,
  };
  for (const k of ["pushoverToken", "pushoverUser", "ntfyToken", "ntfyPassword"] as const) if (f[k]) body[k] = f[k];
  const submit = (then?: () => void) =>
    save.mutate(body, {
      onSuccess: () => {
        setF((p) => ({ ...p, pushoverToken: "", pushoverUser: "", ntfyToken: "", ntfyPassword: "" }));
        toast.success("Saved");
        then?.();
        onSaved?.();
      },
      onError: (e: Error) => toast.error(e.message),
    });
  return (
    <Card id="notifications">
      <CardHeader icon={<Bell className="h-5 w-5" />} title="Notifications" description="Where reminders, important email and your daily summary are pushed. Set up either or both." />
      <CardBody className="space-y-5">
        <div className="space-y-3">
          <div className="text-sm font-semibold">ntfy</div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Server URL" htmlFor="ntfy-server" hint="Without the topic. On the same Docker network as your ntfy container, use its service name, like http://ntfy:80.">
              <Input id="ntfy-server" value={f.ntfyServer} onChange={set("ntfyServer")} placeholder="https://ntfy.sh" />
            </Field>
            <Field label="Topic" htmlFor="ntfy-topic" hint="Subscribe to the same topic in the ntfy app.">
              <Input id="ntfy-topic" value={f.ntfyTopic} onChange={set("ntfyTopic")} placeholder="Docket" />
            </Field>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Priority" htmlFor="ntfy-prio" hint="Urgent pushes (nags, high-priority tasks, email to act on) go one higher.">
              <Select id="ntfy-prio" value={f.ntfyPriority} onChange={set("ntfyPriority")}>
                <option value={1}>1 · Min</option>
                <option value={2}>2 · Low</option>
                <option value={3}>3 · Default</option>
                <option value={4}>4 · High</option>
                <option value={5}>5 · Max</option>
              </Select>
            </Field>
            <Field label="Authentication" htmlFor="ntfy-auth">
              <Select id="ntfy-auth" value={f.ntfyAuth} onChange={set("ntfyAuth")}>
                <option value="none">None</option>
                <option value="basic">Username and password</option>
                <option value="token">Access token</option>
              </Select>
            </Field>
          </div>
          {f.ntfyAuth === "basic" && (
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Username" htmlFor="ntfy-user">
                <Input id="ntfy-user" autoComplete="off" value={f.ntfyUsername} onChange={set("ntfyUsername")} />
              </Field>
              <Field label="Password" htmlFor="ntfy-pass">
                <SecretInput id="ntfy-pass" set={settings.ntfyPasswordSet} value={f.ntfyPassword} onChange={(v) => setF((p) => ({ ...p, ntfyPassword: v }))} />
              </Field>
            </div>
          )}
          {f.ntfyAuth === "token" && (
            <Field label="Access token" htmlFor="ntfy-token" hint="From ntfy's Account page, or `ntfy token add`.">
              <SecretInput id="ntfy-token" set={settings.ntfyTokenSet} value={f.ntfyToken} onChange={(v) => setF((p) => ({ ...p, ntfyToken: v }))} placeholder="tk_…" />
            </Field>
          )}
        </div>
        <div className="space-y-3 border-t pt-4">
          <div className="text-sm font-semibold">Pushover</div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Application token" htmlFor="po-token" hint="Create an application at pushover.net.">
              <SecretInput id="po-token" set={settings.pushoverTokenSet} value={f.pushoverToken} onChange={(v) => setF((p) => ({ ...p, pushoverToken: v }))} />
            </Field>
            <Field label="User key" htmlFor="po-user" hint="On your Pushover dashboard.">
              <SecretInput id="po-user" set={settings.pushoverUserSet} value={f.pushoverUser} onChange={(v) => setF((p) => ({ ...p, pushoverUser: v }))} />
            </Field>
          </div>
          <Field label="Devices" htmlFor="po-dev" hint="Leave empty for all of them, or list names separated by commas.">
            <Input id="po-dev" value={f.pushoverDevices} onChange={set("pushoverDevices")} placeholder="iphone" />
          </Field>
        </div>
        <Field
          label="Docket's address"
          htmlFor="pub"
          hint="The address your phone opens Docket at, like https://docket.yourdomain.org. Needed for the Done / Snooze buttons: the phone sends them here, so it has to be reachable from your phone, not just from the server."
        >
          <Input id="pub" value={f.publicUrl} onChange={set("publicUrl")} placeholder="https://docket.example.org" />
        </Field>
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="outline" onClick={() => submit(() => test.mutate())} loading={test.isPending}>
            Save and send a test
          </Button>
          <Button onClick={() => submit()} loading={save.isPending}>
            Save
          </Button>
        </div>
      </CardBody>
    </Card>
  );
}

// --- Reminders & summary ---------------------------------------------------------------------

export function ScheduleSection() {
  const { settings, save } = useSettings();
  if (!settings) return null;
  const put = (patch: Partial<Settings>) => save.mutate(patch, { onError: (e: Error) => toast.error(e.message) });
  return (
    <Card id="schedule">
      <CardHeader icon={<Bell className="h-5 w-5" />} title="Reminders and daily summary" />
      <CardBody className="divide-y py-2 sm:py-3">
        <Row title="Daily summary" hint="A short rundown of today: what's overdue, what's due, what's coming, and email that needs you.">
          <Switch label="Daily summary" checked={settings.summaryEnabled} onChange={(v) => put({ summaryEnabled: v })} />
        </Row>
        {settings.summaryEnabled && (
          <>
            <Row title="Send it at" hint="Your server's time zone (set TZ in the compose file).">
              <Input type="time" className="w-32" value={settings.summaryTime} onChange={(e) => e.target.value && put({ summaryTime: e.target.value })} aria-label="Summary time" />
            </Row>
            <Row title="Push the summary to your phone">
              <Switch label="Push the summary" checked={settings.summaryPush} onChange={(v) => put({ summaryPush: v })} />
            </Row>
          </>
        )}
        <Row title="Push reminders for tasks with a time" hint="Tasks with just a date show up in the summary instead.">
          <Switch label="Push reminders" checked={settings.remindersPush} onChange={(v) => put({ remindersPush: v })} />
        </Row>
        {settings.remindersPush && (
          <Row title="Remind me">
            <Select className="w-40" value={settings.reminderLeadMinutes} onChange={(e) => put({ reminderLeadMinutes: Number(e.target.value) })} aria-label="How early">
              <option value={0}>At the time</option>
              <option value={5}>5 min before</option>
              <option value={15}>15 min before</option>
              <option value={30}>30 min before</option>
              <option value={60}>1 hour before</option>
            </Select>
          </Row>
        )}
        <Row title="Push email that needs you" hint="As soon as it's sorted, and once when something you sent has had no reply. Promotions and FYI mail never push.">
          <Switch label="Push important email" checked={settings.emailPush} onChange={(v) => put({ emailPush: v })} />
        </Row>
        <Row title="Waiting on a reply" hint="Email you sent that asked for something is flagged when there's been no answer for this long.">
          <Select className="w-32" value={settings.replyWaitDays} onChange={(e) => put({ replyWaitDays: Number(e.target.value) })} aria-label="Days to wait">
            {[1, 2, 3, 5, 7, 14].map((d) => (
              <option key={d} value={d}>
                {d} day{d === 1 ? "" : "s"}
              </option>
            ))}
          </Select>
        </Row>
      </CardBody>
    </Card>
  );
}

// --- Email accounts ---------------------------------------------------------------------------

const PRESETS: { name: string; host: string; port: number; hint: string }[] = [
  { name: "Gmail", host: "imap.gmail.com", port: 993, hint: "Turn on 2-Step Verification, then create an app password at myaccount.google.com/apppasswords and paste it below." },
  { name: "Outlook, Hotmail, or school / work (Microsoft)", host: "outlook.office365.com", port: 993, hint: "Microsoft doesn't allow passwords here: you sign in with Microsoft instead." },
  { name: "iCloud", host: "imap.mail.me.com", port: 993, hint: "Create an app-specific password at account.apple.com. The username is your full iCloud address." },
  { name: "Yahoo", host: "imap.mail.yahoo.com", port: 993, hint: "Generate an app password under Account security." },
  { name: "Fastmail", host: "imap.fastmail.com", port: 993, hint: "Create an app password with IMAP access under Settings → Privacy & Security." },
  { name: "Other", host: "", port: 993, hint: "Your provider's IMAP server, usually on port 993 with SSL." },
];

export function EmailSection() {
  const qc = useQueryClient();
  const { settings, save } = useSettings();
  const accounts = useQuery({ queryKey: ["mail-accounts"], queryFn: () => get<MailAccount[]>("/mail-accounts"), refetchInterval: 20_000 });
  const [editing, setEditing] = useState<MailAccount | "new" | null>(null);
  const remove = useMutation({
    mutationFn: (id: number) => api("DELETE", `/mail-accounts/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["mail-accounts"] });
      qc.invalidateQueries({ queryKey: ["emails"] });
      qc.invalidateQueries({ queryKey: ["status"] });
    },
  });
  return (
    <Card id="email">
      <CardHeader
        icon={<Mail className="h-5 w-5" />}
        title="Email"
        description="Docket reads new mail over IMAP, read-only: nothing is marked as read, moved or deleted. Only the sender, subject and a short excerpt are kept."
        action={
          <Button size="sm" onClick={() => setEditing("new")}>
            <Plus className="h-4 w-4" /> Add
          </Button>
        }
      />
      <CardBody className="space-y-4">
        {accounts.data?.length ? (
          <ul className="divide-y rounded-lg border">
            {accounts.data.map((a) => (
              <li key={a.id} className="flex items-center gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-medium">{a.label}</span>
                    {!a.enabled && <Badge>Paused</Badge>}
                    {a.auth === "microsoft" && <Badge tone="primary">Microsoft</Badge>}
                    {a.needsSignIn ? <Badge tone="danger">Needs sign-in</Badge> : a.lastError && <Badge tone="danger">Problem</Badge>}
                  </div>
                  <p className="truncate text-xs text-muted-foreground">
                    {a.username} · {a.folder} · {a.lastCheckedAt ? `checked ${timeAgo(a.lastCheckedAt)}` : "not checked yet"} · {a.emails} sorted
                  </p>
                  {a.lastError && <p className="mt-1 text-xs text-destructive">{a.lastError}</p>}
                </div>
                <button onClick={() => setEditing(a)} className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground" aria-label={`Edit ${a.label}`}>
                  <Pencil className="h-4 w-4" />
                </button>
                <button
                  onClick={() => confirm(`Remove ${a.label}? The email Docket sorted from it is removed too (your mailbox isn't touched).`) && remove.mutate(a.id)}
                  className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-destructive"
                  aria-label={`Remove ${a.label}`}
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="rounded-lg border border-dashed px-4 py-5 text-center text-sm text-muted-foreground">No accounts yet.</p>
        )}
        {settings && (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Check every">
              <Select value={settings.mailIntervalMinutes} onChange={(e) => save.mutate({ mailIntervalMinutes: Number(e.target.value) })}>
                {[5, 10, 15, 30, 60, 180].map((m) => (
                  <option key={m} value={m}>
                    {m < 60 ? `${m} minutes` : m === 60 ? "hour" : `${m / 60} hours`}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="First check looks back">
              <Select value={settings.mailLookbackDays} onChange={(e) => save.mutate({ mailLookbackDays: Number(e.target.value) })}>
                {[1, 3, 7, 14].map((d) => (
                  <option key={d} value={d}>
                    {d} day{d === 1 ? "" : "s"}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
        )}
      </CardBody>
      {editing && <AccountEditor account={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
    </Card>
  );
}

function AccountEditor({ account, onClose }: { account: MailAccount | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [preset, setPreset] = useState(() => (account ? (PRESETS.find((p) => p.host === account.host)?.name ?? "Other") : "Gmail"));
  const microsoft = account ? account.auth === "microsoft" : preset.includes("(Microsoft)");
  const [f, setF] = useState({
    label: account?.label ?? "",
    host: account?.host ?? "imap.gmail.com",
    port: account?.port ?? 993,
    username: account?.username ?? "",
    password: "",
    folder: account?.folder ?? "INBOX",
    enabled: account?.enabled ?? true,
    trackReplies: account?.trackReplies ?? true,
  });
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const p = PRESETS.find((x) => x.name === preset)!;
  const body = { ...f, id: account?.id, secure: f.port === 993, label: f.label || f.username };
  const test = useMutation({
    mutationFn: () => api<{ messages: number }>("POST", "/mail-accounts/test", body),
    onSuccess: (r) => setResult({ ok: true, text: `Signed in. ${r.messages.toLocaleString()} messages in ${f.folder}.` }),
    onError: (e: Error) => setResult({ ok: false, text: e.message }),
  });
  const save = useMutation({
    mutationFn: () => (account ? api("PATCH", `/mail-accounts/${account.id}`, body) : api("POST", "/mail-accounts", body)),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["mail-accounts"] });
      qc.invalidateQueries({ queryKey: ["status"] });
      toast.success(account ? "Saved" : "Added. Checking it now…");
      setTimeout(() => qc.invalidateQueries({ queryKey: ["emails"] }), 4000);
      onClose();
    },
    onError: (e: Error) => setResult({ ok: false, text: e.message }),
  });
  return (
    <Modal
      open
      onClose={onClose}
      title={account ? `Edit ${account.label}` : "Add an email account"}
      footer={
        microsoft && !account ? (
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
        ) : (
        <>
          <Button variant="outline" onClick={() => test.mutate()} loading={test.isPending}>
            Test
          </Button>
          <Button onClick={() => save.mutate()} loading={save.isPending}>
            {account ? "Save" : "Add account"}
          </Button>
        </>
        )
      }
    >
      <div className="space-y-4">
        {!account && (
        <Field label="Provider">
          <Select
            value={preset}
            onChange={(e) => {
              const np = PRESETS.find((x) => x.name === e.target.value)!;
              setPreset(np.name);
              setF((x) => ({ ...x, host: np.host || x.host, port: np.port }));
            }}
          >
            {PRESETS.map((x) => (
              <option key={x.name}>{x.name}</option>
            ))}
          </Select>
        </Field>
        )}
        {microsoft ? (
          <>
            {account && (
              <p className="text-sm">
                <span className="text-muted-foreground">Signed in with Microsoft as </span>
                <span className="font-medium">{account.username}</span>
              </p>
            )}
            <MicrosoftConnect
              accountId={account?.id}
              again={!!account}
              onDone={() => {
                qc.invalidateQueries({ queryKey: ["mail-accounts"] });
                qc.invalidateQueries({ queryKey: ["status"] });
                setTimeout(() => qc.invalidateQueries({ queryKey: ["emails"] }), 4000);
                if (!account) onClose();
              }}
            />
          </>
        ) : (
          <>
        <p className="rounded-lg bg-muted px-3 py-2 text-xs leading-relaxed text-muted-foreground">{p.hint}</p>
        {preset === "Other" && (
          <div className="grid grid-cols-[1fr_6rem] gap-3">
            <Field label="IMAP server" htmlFor="m-host">
              <Input id="m-host" value={f.host} onChange={(e) => setF((x) => ({ ...x, host: e.target.value }))} placeholder="imap.example.com" />
            </Field>
            <Field label="Port" htmlFor="m-port">
              <Input id="m-port" type="number" value={f.port} onChange={(e) => setF((x) => ({ ...x, port: Number(e.target.value) }))} />
            </Field>
          </div>
        )}
        <Field label="Email address" htmlFor="m-user">
          <Input id="m-user" autoComplete="off" value={f.username} onChange={(e) => setF((x) => ({ ...x, username: e.target.value }))} placeholder="you@gmail.com" />
        </Field>
        <Field label="App password" htmlFor="m-pass">
          <Input
            id="m-pass"
            type="password"
            autoComplete="off"
            value={f.password}
            onChange={(e) => setF((x) => ({ ...x, password: e.target.value }))}
            placeholder={account ? "Saved (type to replace)" : "abcd efgh ijkl mnop"}
          />
        </Field>
          </>
        )}
        {(!microsoft || account) && (
          <>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Name" htmlFor="m-label">
            <Input id="m-label" value={f.label} onChange={(e) => setF((x) => ({ ...x, label: e.target.value }))} placeholder={f.username || "Personal"} />
          </Field>
          <Field label="Folder" htmlFor="m-folder">
            <Input id="m-folder" value={f.folder} onChange={(e) => setF((x) => ({ ...x, folder: e.target.value }))} />
          </Field>
        </div>
        <Row title="Watch for replies" hint="Reads the Sent folder (read-only) to notice when something you asked hasn't been answered.">
          <Switch label="Watch for replies" checked={f.trackReplies} onChange={(v) => setF((x) => ({ ...x, trackReplies: v }))} />
        </Row>
          </>
        )}
        {account && (
          <Row title="Check this account">
            <Switch label="Enabled" checked={f.enabled} onChange={(v) => setF((x) => ({ ...x, enabled: v }))} />
          </Row>
        )}
        {result && (
          <p className={cn("flex items-start gap-2 rounded-lg px-3 py-2 text-sm", result.ok ? "bg-success/10 text-success" : "bg-destructive/10 text-destructive")}>
            {result.ok ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" /> : <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />}
            {result.text}
          </p>
        )}
      </div>
    </Modal>
  );
}

export function SenderRulesSection() {
  const qc = useQueryClient();
  const rules = useQuery({ queryKey: ["sender-rules"], queryFn: () => get<SenderRule[]>("/sender-rules") });
  const [pattern, setPattern] = useState("");
  const [action, setAction] = useState<"important" | "ignore">("important");
  const add = useMutation({
    mutationFn: () => api<{ changed: number }>("POST", "/sender-rules", { pattern, action }),
    onSuccess: (r) => {
      setPattern("");
      qc.invalidateQueries({ queryKey: ["sender-rules"] });
      qc.invalidateQueries({ queryKey: ["emails"] });
      qc.invalidateQueries({ queryKey: ["status"] });
      toast.success(r.changed ? `Saved, and re-sorted ${r.changed} email${r.changed === 1 ? "" : "s"}` : "Saved");
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const remove = useMutation({
    mutationFn: (id: number) => api("DELETE", `/sender-rules/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["sender-rules"] }),
  });
  return (
    <Card id="rules">
      <CardHeader
        icon={<Star className="h-5 w-5" />}
        title="Senders"
        description="Your own rules always win over the AI. Add them here, or from any email's menu in the inbox."
      />
      <CardBody className="space-y-4">
        <form
          className="flex flex-col gap-2 sm:flex-row"
          onSubmit={(e) => {
            e.preventDefault();
            if (pattern.trim()) add.mutate();
          }}
        >
          <Input value={pattern} onChange={(e) => setPattern(e.target.value)} placeholder="someone@example.com or example.com" aria-label="Sender or domain" />
          <Select className="sm:w-48" value={action} onChange={(e) => setAction(e.target.value as "important" | "ignore")} aria-label="Rule">
            <option value="important">Always important</option>
            <option value="ignore">Always ignore</option>
          </Select>
          <Button type="submit" loading={add.isPending} disabled={!pattern.trim()}>
            Add
          </Button>
        </form>
        {rules.data?.length ? (
          <ul className="divide-y rounded-lg border">
            {rules.data.map((r) => (
              <li key={r.id} className="flex items-center gap-3 px-4 py-2.5 text-sm">
                {r.action === "important" ? <Star className="h-4 w-4 text-primary" /> : <Ban className="h-4 w-4 text-muted-foreground" />}
                <span className="flex-1 truncate font-medium">{r.pattern}</span>
                <span className="text-xs text-muted-foreground">{r.action === "important" ? "Always important" : "Ignored"}</span>
                <button onClick={() => remove.mutate(r.id)} className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-destructive" aria-label={`Remove rule for ${r.pattern}`}>
                  <Trash2 className="h-4 w-4" />
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">No rules yet.</p>
        )}
      </CardBody>
    </Card>
  );
}

// --- Calendars and carrel --------------------------------------------------------------------

export function SourcesSection() {
  const qc = useQueryClient();
  const sources = useQuery({ queryKey: ["sources"], queryFn: () => get<Source[]>("/sources"), refetchInterval: 30_000 });
  const [editing, setEditing] = useState<Source | "ics" | "carrel" | null>(null);
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["sources"] });
    qc.invalidateQueries({ queryKey: ["today"] });
    qc.invalidateQueries({ queryKey: ["status"] });
  };
  const sync = useMutation({
    mutationFn: (id: number) => api<Source>("POST", `/sources/${id}/sync`),
    onSuccess: (s) => {
      invalidate();
      toast.success(`${s.name}: ${s.items} item${s.items === 1 ? "" : "s"}`);
    },
    onError: (e: Error) => {
      invalidate();
      toast.error(e.message);
    },
  });
  const remove = useMutation({ mutationFn: (id: number) => api("DELETE", `/sources/${id}`), onSuccess: invalidate });
  return (
    <Card id="calendars">
      <CardHeader
        icon={<CalendarDays className="h-5 w-5" />}
        title="Calendars and carrel"
        description="Today's schedule, and school work due, on your Today page and in the morning summary. Read every 30 minutes; nothing is ever changed."
      />
      <CardBody className="space-y-4">
        {sources.data?.length ? (
          <ul className="divide-y rounded-lg border">
            {sources.data.map((src) => (
              <li key={src.id} className="flex items-center gap-3 px-4 py-3">
                {src.kind === "carrel" ? <GraduationCap className="h-4 w-4 shrink-0 text-muted-foreground" /> : <CalendarDays className="h-4 w-4 shrink-0 text-muted-foreground" />}
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-medium">{src.name}</span>
                    {!src.enabled && <Badge>Paused</Badge>}
                    {src.lastError && <Badge tone="danger">Problem</Badge>}
                  </div>
                  <p className="truncate text-xs text-muted-foreground">
                    {src.kind === "carrel" ? `${src.username} · ${src.url}` : src.url} · {src.items} item{src.items === 1 ? "" : "s"} · {src.lastSyncedAt ? `read ${timeAgo(src.lastSyncedAt)}` : "not read yet"}
                  </p>
                  {src.lastError && <p className="mt-1 text-xs text-destructive">{src.lastError}</p>}
                </div>
                <button onClick={() => sync.mutate(src.id)} className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground" aria-label={`Read ${src.name} now`} title="Read now">
                  <RefreshCw className={cn("h-4 w-4", sync.isPending && sync.variables === src.id && "animate-spin")} />
                </button>
                <button onClick={() => setEditing(src)} className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground" aria-label={`Edit ${src.name}`}>
                  <Pencil className="h-4 w-4" />
                </button>
                <button onClick={() => confirm(`Remove ${src.name}?`) && remove.mutate(src.id)} className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-destructive" aria-label={`Remove ${src.name}`}>
                  <Trash2 className="h-4 w-4" />
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="rounded-lg border border-dashed px-4 py-5 text-center text-sm text-muted-foreground">Nothing connected yet.</p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={() => setEditing("ics")}>
            <CalendarDays className="h-4 w-4" /> Add a calendar
          </Button>
          <Button variant="outline" size="sm" onClick={() => setEditing("carrel")}>
            <GraduationCap className="h-4 w-4" /> Connect carrel
          </Button>
        </div>
      </CardBody>
      {editing && <SourceEditor source={typeof editing === "string" ? null : editing} kind={typeof editing === "string" ? editing : editing.kind} onClose={() => setEditing(null)} onSaved={invalidate} />}
    </Card>
  );
}

const CALENDAR_HELP: { name: string; text: string }[] = [
  { name: "Google", text: "Calendar settings → pick the calendar under “Settings for my calendars” → Integrate calendar → Secret address in iCal format." },
  { name: "iCloud", text: "Calendar app → right-click the calendar → Share Calendar → tick Public Calendar → copy the webcal:// link. Anyone with the link can read it, so keep it to yourself." },
  { name: "Outlook", text: "outlook.com → Settings → Calendar → Shared calendars → Publish a calendar → copy the ICS link." },
];

function SourceEditor({ source, kind, onClose, onSaved }: { source: Source | null; kind: "ics" | "carrel"; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({ name: source?.name ?? "", url: source?.kind === "carrel" ? source.url : "", username: source?.username ?? "", password: "", enabled: source?.enabled ?? true });
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const body = { ...f, kind, id: source?.id };
  const test = useMutation({
    mutationFn: () => api<{ items: number; upcoming: number }>("POST", "/sources/test", body),
    onSuccess: (r) => setResult({ ok: true, text: `Read it: ${r.upcoming} item${r.upcoming === 1 ? "" : "s"} coming up.` }),
    onError: (e: Error) => setResult({ ok: false, text: e.message }),
  });
  const save = useMutation({
    mutationFn: () => (source ? api<Source>("PATCH", `/sources/${source.id}`, body) : api<Source>("POST", "/sources", body)),
    onSuccess: (s) => {
      onSaved();
      if (s.lastError) toast.error(`${s.name}: ${s.lastError}`);
      else toast.success(`${s.name}: ${s.items} item${s.items === 1 ? "" : "s"}`);
      onClose();
    },
    onError: (e: Error) => setResult({ ok: false, text: e.message }),
  });
  const carrel = kind === "carrel";
  return (
    <Modal
      open
      onClose={onClose}
      title={source ? `Edit ${source.name}` : carrel ? "Connect carrel" : "Add a calendar"}
      footer={
        <>
          <Button variant="outline" onClick={() => test.mutate()} loading={test.isPending}>
            Test
          </Button>
          <Button onClick={() => save.mutate()} loading={save.isPending}>
            {source ? "Save" : "Add"}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {carrel ? (
          <>
            <p className="rounded-lg bg-muted px-3 py-2 text-xs leading-relaxed text-muted-foreground">
              Docket signs in to carrel as you and reads assignments, readings, exams and quizzes with their due dates. Mark them done in carrel; they leave Docket on the next read.
            </p>
            <Field label="carrel's address" htmlFor="s-url" hint="The address you open carrel at. On the same Docker network, its service name works too (http://app:8080).">
              <Input id="s-url" value={f.url} onChange={(e) => setF((x) => ({ ...x, url: e.target.value }))} placeholder="https://carrel.example.org" />
            </Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Email" htmlFor="s-user">
                <Input id="s-user" autoComplete="off" value={f.username} onChange={(e) => setF((x) => ({ ...x, username: e.target.value }))} />
              </Field>
              <Field label="Password" htmlFor="s-pass">
                <Input id="s-pass" type="password" autoComplete="off" value={f.password} onChange={(e) => setF((x) => ({ ...x, password: e.target.value }))} placeholder={source ? "Saved (type to replace)" : ""} />
              </Field>
            </div>
          </>
        ) : (
          <>
            <Field label="Name" htmlFor="s-name">
              <Input id="s-name" value={f.name} onChange={(e) => setF((x) => ({ ...x, name: e.target.value }))} placeholder="Personal" />
            </Field>
            <Field label="Calendar link (.ics)" htmlFor="s-url" hint={source ? "Saved. Paste a new link only to replace it." : undefined}>
              <Input id="s-url" autoComplete="off" value={f.url} onChange={(e) => setF((x) => ({ ...x, url: e.target.value }))} placeholder="https://calendar.google.com/calendar/ical/…/basic.ics" />
            </Field>
            <details className="rounded-lg bg-muted px-3 py-2 text-xs leading-relaxed text-muted-foreground">
              <summary className="cursor-pointer font-medium text-foreground">Where to find the link</summary>
              <ul className="mt-2 space-y-1.5">
                {CALENDAR_HELP.map((h) => (
                  <li key={h.name}>
                    <span className="font-medium text-foreground">{h.name}:</span> {h.text}
                  </li>
                ))}
              </ul>
            </details>
          </>
        )}
        {source && (
          <Row title="Read it">
            <Switch label="Enabled" checked={f.enabled} onChange={(v) => setF((x) => ({ ...x, enabled: v }))} />
          </Row>
        )}
        {result && (
          <p className={cn("flex items-start gap-2 rounded-lg px-3 py-2 text-sm", result.ok ? "bg-success/10 text-success" : "bg-destructive/10 text-destructive")}>
            {result.ok ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" /> : <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />}
            {result.text}
          </p>
        )}
      </div>
    </Modal>
  );
}

// --- Homepage widget ---------------------------------------------------------------------------

export function WidgetSection() {
  const qc = useQueryClient();
  const keys = useQuery({ queryKey: ["widget-keys"], queryFn: () => get<WidgetKey[]>("/widget-keys") });
  const [made, setMade] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: () => api<{ key: string }>("POST", "/widget-keys", { label: "Homepage" }),
    onSuccess: (r) => {
      setMade(r.key);
      qc.invalidateQueries({ queryKey: ["widget-keys"] });
    },
  });
  const revoke = useMutation({ mutationFn: (id: number) => api("DELETE", `/widget-keys/${id}`), onSuccess: () => qc.invalidateQueries({ queryKey: ["widget-keys"] }) });
  const origin = window.location.origin;
  const snippet = `- Docket:
    icon: ${origin}/icon-192.png
    href: ${origin}/
    description: Today's list
    widget:
      type: customapi
      url: ${origin}/api/widget
      refreshInterval: 60000
      headers:
        X-Api-Key: ${made ?? "dkt_your_key_here"}
      mappings:
        - field: due_today
          label: Today
          format: number
        - field: overdue
          label: Overdue
          format: number
        - field: inbox
          label: Email
          format: number
        - field: waiting
          label: No reply
          format: number`;
  return (
    <Card id="widget">
      <CardHeader
        icon={<LayoutGrid className="h-5 w-5" />}
        title="Homepage widget"
        description="Show today's numbers on a Homepage dashboard with its Custom API widget. A key can only read the numbers."
        action={
          <Button size="sm" variant="outline" onClick={() => create.mutate()} loading={create.isPending}>
            <Plus className="h-4 w-4" /> Create key
          </Button>
        }
      />
      <CardBody className="space-y-4">
        {made && (
          <div className="space-y-2 rounded-lg border border-primary/30 bg-primary-soft/50 p-3">
            <p className="text-sm font-medium">Copy this now. It won't be shown again.</p>
            <div className="flex gap-2">
              <code className="flex-1 truncate rounded bg-card px-2 py-1.5 text-xs">{made}</code>
              <Button size="sm" variant="outline" onClick={() => navigator.clipboard.writeText(made).then(() => toast.success("Copied"))}>
                <Copy className="h-4 w-4" />
              </Button>
            </div>
          </div>
        )}
        {keys.data?.length ? (
          <ul className="divide-y rounded-lg border text-sm">
            {keys.data.map((k) => (
              <li key={k.id} className="flex items-center gap-3 px-4 py-2.5">
                <span className="flex-1 font-medium">{k.label}</span>
                <span className="text-xs text-muted-foreground">{k.lastUsedAt ? `used ${timeAgo(k.lastUsedAt)}` : "never used"}</span>
                <button onClick={() => revoke.mutate(k.id)} className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-destructive" aria-label={`Revoke ${k.label}`}>
                  <Trash2 className="h-4 w-4" />
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        <details className="text-sm">
          <summary className="cursor-pointer font-medium">Homepage services.yaml</summary>
          <pre className="mt-2 overflow-x-auto rounded-lg bg-muted p-3 text-xs leading-relaxed">{snippet}</pre>
          <p className="mt-2 text-xs text-muted-foreground">
            Also available: <code>done_today</code>, <code>open</code>, <code>events_today</code>, <code>next_task</code>, <code>next_event</code> and <code>ai</code> (online, offline or off).
          </p>
        </details>
      </CardBody>
    </Card>
  );
}

// --- Sign in with Microsoft -------------------------------------------------------------------

/**
 * Outlook.com and Microsoft 365 (school / work) accounts. First time: register
 * an app in Microsoft Entra and paste its client id. Then: a code to enter at
 * microsoft.com/devicelogin, and Docket picks up the sign-in by itself.
 */
function MicrosoftConnect({ accountId, again, onDone }: { accountId?: number; again?: boolean; onDone: () => void }) {
  const { settings, save } = useSettings();
  const [editingApp, setEditingApp] = useState(false);
  const [clientId, setClientId] = useState("");
  const [tenant, setTenant] = useState("common");
  const [flow, setFlow] = useState<MicrosoftFlow | null>(null);
  useEffect(() => {
    if (settings) {
      setClientId(settings.msClientId);
      setTenant(settings.msTenant || "common");
    }
  }, [settings]);
  const start = useMutation({
    mutationFn: () => api<MicrosoftFlow>("POST", "/microsoft/sign-in", accountId ? { accountId } : {}),
    onSuccess: setFlow,
    onError: (e: Error) => toast.error(e.message),
  });
  const poll = useQuery({
    queryKey: ["ms-flow", flow?.id],
    queryFn: () => get<MicrosoftFlow>(`/microsoft/sign-in/${flow!.id}`),
    enabled: !!flow && flow.state === "pending",
    refetchInterval: 2000,
  });
  const status = poll.data ?? flow;
  useEffect(() => {
    if (status?.state === "done") {
      toast.success(`Signed in as ${status.email}. Checking your mail…`);
      setFlow(null);
      onDone();
    }
  }, [status?.state]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!settings) return null;

  if (!settings.msClientId || editingApp) {
    return (
      <div className="space-y-4">
        <div className="rounded-lg bg-muted px-4 py-3 text-xs leading-relaxed text-muted-foreground">
          <p className="mb-2 font-medium text-foreground">One-time setup: register Docket with Microsoft (about 5 minutes)</p>
          <ol className="list-decimal space-y-1.5 pl-4">
            <li>
              Go to{" "}
              <a className="font-medium text-primary hover:underline" href="https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade" target="_blank" rel="noreferrer">
                entra.microsoft.com → App registrations
              </a>{" "}
              and sign in. Your school account can usually do this; if it says you don't have permission, use a personal Microsoft account with a free Azure account.
            </li>
            <li>
              <b>New registration</b>. Name it Docket. Under <b>Supported account types</b> pick <b>“Accounts in any organizational directory and personal Microsoft accounts”</b> (that's what lets both school and Outlook.com accounts in). Leave Redirect URI empty. <b>Register</b>.
            </li>
            <li>
              On <b>Authentication</b>, set <b>Allow public client flows</b> to <b>Yes</b> and save.
            </li>
            <li>
              On <b>API permissions</b>: <b>Add a permission → Microsoft Graph → Delegated</b>, tick <b>IMAP.AccessAsUser.All</b>, <b>offline_access</b>, <b>openid</b>, <b>email</b> and <b>profile</b>, then add them.
            </li>
            <li>
              Copy the <b>Application (client) ID</b> from <b>Overview</b> into the box below.
            </li>
          </ol>
          <p className="mt-2">School or work account? If signing in says IT has to approve the app, send them this client id and ask for admin consent to IMAP.AccessAsUser.All.</p>
        </div>
        <Field label="Application (client) ID" htmlFor="ms-client">
          <Input id="ms-client" value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder="1b2c3d4e-0000-0000-0000-000000000000" />
        </Field>
        <Field label="Accounts" htmlFor="ms-tenant" hint="“common” takes any account. If your school's IT approved the app for their organization only, use your school's domain (like wabash.edu).">
          <Input id="ms-tenant" value={tenant} onChange={(e) => setTenant(e.target.value)} placeholder="common" />
        </Field>
        <div className="flex justify-end gap-2">
          {settings.msClientId && (
            <Button variant="ghost" onClick={() => setEditingApp(false)}>
              Cancel
            </Button>
          )}
          <Button
            onClick={() =>
              save.mutate(
                { msClientId: clientId, msTenant: tenant || "common" },
                { onSuccess: () => (setEditingApp(false), toast.success("Saved")), onError: (e: Error) => toast.error(e.message) },
              )
            }
            loading={save.isPending}
            disabled={!clientId.trim()}
          >
            Save
          </Button>
        </div>
      </div>
    );
  }

  if (status && status.state === "pending") {
    return (
      <div className="space-y-3 rounded-lg border border-primary/30 bg-primary-soft/50 p-4 text-center">
        <p className="text-sm">
          Open{" "}
          <a className="font-medium text-primary hover:underline" href={status.verificationUri} target="_blank" rel="noreferrer">
            {status.verificationUri.replace(/^https?:\/\//, "")} <ExternalLink className="inline h-3 w-3" />
          </a>{" "}
          on any device and enter:
        </p>
        <button
          onClick={() => navigator.clipboard.writeText(status.userCode).then(() => toast.success("Copied"))}
          className="mx-auto flex items-center gap-2 rounded-lg bg-card px-4 py-2 font-mono text-2xl font-semibold tracking-widest shadow-sm"
          title="Copy"
        >
          {status.userCode} <Copy className="h-4 w-4 text-muted-foreground" />
        </button>
        <p className="flex items-center justify-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Waiting for you to sign in there. This finishes by itself.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {status?.state === "error" && (
        <p className="flex items-start gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          {status.error}
        </p>
      )}
      <Button className="w-full" onClick={() => start.mutate()} loading={start.isPending}>
        <KeyRound className="h-4 w-4" /> {again ? "Sign in with Microsoft again" : "Sign in with Microsoft"}
      </Button>
      <p className="text-center text-xs text-muted-foreground">
        Works with Outlook.com, Hotmail and school or work accounts. Docket only gets permission to read your mail.{" "}
        <button className="underline hover:text-foreground" onClick={() => setEditingApp(true)}>
          App settings
        </button>
      </p>
    </div>
  );
}
