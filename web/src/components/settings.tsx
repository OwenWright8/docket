// Settings sections. The setup wizard shows the same ones, a step at a time.
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { AlertTriangle, Ban, Bell, Bot, CheckCircle2, Mail, Pencil, Plus, Star, Trash2 } from "lucide-react";
import { api, get, type MailAccount, type SenderRule, type Settings } from "@/lib/api";
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
  const [f, setF] = useState({ pushoverToken: "", pushoverUser: "", pushoverDevices: "", ntfyUrl: "", ntfyToken: "", publicUrl: "" });
  useEffect(() => {
    if (settings) setF((p) => ({ ...p, pushoverDevices: settings.pushoverDevices, ntfyUrl: settings.ntfyUrl, publicUrl: settings.publicUrl || "" }));
  }, [settings]);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF((p) => ({ ...p, [k]: e.target.value }));
  const test = useMutation({
    mutationFn: () => api<{ sent: string[] }>("POST", "/notify/test"),
    onSuccess: (r) => toast.success(`Sent through ${r.sent.join(" and ")}`),
    onError: (e: Error) => toast.error(e.message),
  });
  if (!settings) return null;
  const body: Record<string, unknown> = { pushoverDevices: f.pushoverDevices, ntfyUrl: f.ntfyUrl, publicUrl: f.publicUrl };
  for (const k of ["pushoverToken", "pushoverUser", "ntfyToken"] as const) if (f[k]) body[k] = f[k];
  const submit = (then?: () => void) =>
    save.mutate(body, {
      onSuccess: () => {
        setF((p) => ({ ...p, pushoverToken: "", pushoverUser: "", ntfyToken: "" }));
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
        <div className="space-y-3 border-t pt-4">
          <div className="text-sm font-semibold">ntfy</div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Topic address" htmlFor="ntfy-url" hint="Subscribe to the same topic in the ntfy app. Use a hard-to-guess name on ntfy.sh.">
              <Input id="ntfy-url" value={f.ntfyUrl} onChange={set("ntfyUrl")} placeholder="https://ntfy.sh/docket-8f2k1x" />
            </Field>
            <Field label="Access token" htmlFor="ntfy-token" hint="Only for a protected topic.">
              <SecretInput id="ntfy-token" set={settings.ntfyTokenSet} value={f.ntfyToken} onChange={(v) => setF((p) => ({ ...p, ntfyToken: v }))} />
            </Field>
          </div>
        </div>
        <Field label="Docket's address" htmlFor="pub" hint="Optional. Tapping a notification opens this.">
          <Input id="pub" value={f.publicUrl} onChange={set("publicUrl")} placeholder="http://192.168.1.10:8585" />
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
        <Row title="Push email that needs you" hint="As soon as it's sorted. Promotions and FYI mail never push.">
          <Switch label="Push important email" checked={settings.emailPush} onChange={(v) => put({ emailPush: v })} />
        </Row>
      </CardBody>
    </Card>
  );
}

// --- Email accounts ---------------------------------------------------------------------------

const PRESETS: { name: string; host: string; port: number; hint: string }[] = [
  { name: "Gmail", host: "imap.gmail.com", port: 993, hint: "Turn on 2-Step Verification, then create an app password at myaccount.google.com/apppasswords and paste it below." },
  { name: "Outlook / Hotmail", host: "outlook.office365.com", port: 993, hint: "Use an app password from account.microsoft.com → Security. Some Microsoft 365 work accounts block IMAP." },
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
                    {a.lastError && <Badge tone="danger">Problem</Badge>}
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
  const [f, setF] = useState({
    label: account?.label ?? "",
    host: account?.host ?? "imap.gmail.com",
    port: account?.port ?? 993,
    username: account?.username ?? "",
    password: "",
    folder: account?.folder ?? "INBOX",
    enabled: account?.enabled ?? true,
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
        <>
          <Button variant="outline" onClick={() => test.mutate()} loading={test.isPending}>
            Test
          </Button>
          <Button onClick={() => save.mutate()} loading={save.isPending}>
            {account ? "Save" : "Add account"}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
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
        <div className="grid grid-cols-2 gap-3">
          <Field label="Name" htmlFor="m-label">
            <Input id="m-label" value={f.label} onChange={(e) => setF((x) => ({ ...x, label: e.target.value }))} placeholder={f.username || "Personal"} />
          </Field>
          <Field label="Folder" htmlFor="m-folder">
            <Input id="m-folder" value={f.folder} onChange={(e) => setF((x) => ({ ...x, folder: e.target.value }))} />
          </Field>
        </div>
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
