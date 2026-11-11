import { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Info, KeyRound } from "lucide-react";
import { api, get, type About } from "@/lib/api";
import { PageHeader } from "@/components/Layout";
import { AiSection, EmailSection, NotifySection, ScheduleSection, SenderRulesSection, SourcesSection, WidgetSection } from "@/components/settings";
import { Button, Card, CardBody, CardHeader, Field, Input, timeAgo } from "@/components/ui";

export default function SettingsPage() {
  const { hash } = useLocation();
  useEffect(() => {
    if (hash) setTimeout(() => document.querySelector(hash)?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
  }, [hash]);
  return (
    <div className="animate-fade-in">
      <PageHeader title="Settings" />
      <div className="space-y-6">
        <AiSection />
        <NotifySection />
        <ScheduleSection />
        <EmailSection />
        <SenderRulesSection />
        <SourcesSection />
        <WidgetSection />
        <PasswordSection />
        <AboutSection />
      </div>
    </div>
  );
}

function PasswordSection() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const change = useMutation({
    mutationFn: () => api("POST", "/account/password", { current, next }),
    onSuccess: () => {
      setCurrent("");
      setNext("");
      toast.success("Password changed. Other devices are signed out.");
    },
    onError: (e: Error) => toast.error(e.message),
  });
  return (
    <Card>
      <CardHeader icon={<KeyRound className="h-5 w-5" />} title="Password" />
      <CardBody>
        <form
          className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end"
          onSubmit={(e) => {
            e.preventDefault();
            change.mutate();
          }}
        >
          <Field label="Current password" htmlFor="pw-cur">
            <Input id="pw-cur" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
          </Field>
          <Field label="New password" htmlFor="pw-new">
            <Input id="pw-new" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
          </Field>
          <Button type="submit" variant="outline" loading={change.isPending} disabled={!current || next.length < 8}>
            Change
          </Button>
        </form>
      </CardBody>
    </Card>
  );
}

function AboutSection() {
  const about = useQuery({ queryKey: ["about"], queryFn: () => get<About>("/about") });
  const check = useMutation({
    mutationFn: () => api<About>("POST", "/about/check"),
    onSuccess: (a) => {
      about.refetch();
      toast(a.updateAvailable ? `Docket ${a.update.latest} is available` : "You're on the latest version");
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const a = about.data;
  return (
    <Card>
      <CardHeader icon={<Info className="h-5 w-5" />} title="About" />
      <CardBody className="space-y-3 text-sm">
        <p>
          Docket <span className="font-medium">{a?.version}</span>
          {a?.updateAvailable && a.update.url && (
            <>
              {" · "}
              <a className="font-medium text-primary hover:underline" href={a.update.url} target="_blank" rel="noreferrer">
                {a.update.latest} is available
              </a>
              . Update with <code className="rounded bg-muted px-1">docker compose pull && docker compose up -d</code>
            </>
          )}
        </p>
        {a?.update.enabled ? (
          <div className="flex items-center gap-3">
            <Button variant="outline" size="sm" onClick={() => check.mutate()} loading={check.isPending}>
              Check for updates
            </Button>
            <span className="text-xs text-muted-foreground">Last checked {timeAgo(a.update.checkedAt)}</span>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">The update check is turned off.</p>
        )}
        {a && (
          <a className="text-xs text-muted-foreground hover:text-foreground" href={`https://github.com/${a.repo}`} target="_blank" rel="noreferrer">
            github.com/{a.repo}
          </a>
        )}
      </CardBody>
    </Card>
  );
}
