import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ArrowRight, Check } from "lucide-react";
import { api } from "@/lib/api";
import { Logo } from "@/components/Layout";
import { AiSection, EmailSection, NotifySection } from "@/components/settings";
import { Button, cn } from "@/components/ui";

const STEPS = [
  { key: "ai", title: "Local AI", text: "Point Docket at the AI on your PC. Skip it for now and everything still works with the built-in rules." },
  { key: "notify", title: "Notifications", text: "Where reminders and your morning summary go. Pushover or ntfy, or both." },
  { key: "email", title: "Email", text: "Optional. Docket picks out the email that matters and suggests tasks from it." },
] as const;

export default function SetupPage() {
  const qc = useQueryClient();
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const last = step === STEPS.length - 1;

  const finish = async () => {
    setBusy(true);
    try {
      await api("PUT", "/settings", { setupComplete: true });
      await qc.invalidateQueries({ queryKey: ["session"] });
    } catch (e) {
      toast.error((e as Error).message);
      setBusy(false);
    }
  };
  const next = () => (last ? finish() : setStep(step + 1));

  return (
    <div className="mx-auto max-w-2xl px-4 py-8 sm:py-14">
      <div className="mb-8 flex items-center gap-3">
        <Logo className="h-10 w-10 rounded-xl" />
        <div>
          <h1 className="text-xl font-semibold">Set up Docket</h1>
          <p className="text-sm text-muted-foreground">Three quick steps. You can change all of it later in Settings.</p>
        </div>
      </div>
      <ol className="mb-6 grid grid-cols-3 gap-2">
        {STEPS.map((s, i) => (
          <li key={s.key}>
            <button
              onClick={() => setStep(i)}
              className={cn(
                "flex w-full items-center gap-2 rounded-lg border px-3 py-2 text-left text-sm font-medium transition-colors",
                i === step ? "border-primary bg-primary-soft text-primary" : i < step ? "bg-card text-foreground" : "bg-card text-muted-foreground",
              )}
            >
              <span className={cn("flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px]", i < step ? "bg-primary text-primary-foreground" : "border")}>
                {i < step ? <Check className="h-3 w-3" /> : i + 1}
              </span>
              <span className="truncate">{s.title}</span>
            </button>
          </li>
        ))}
      </ol>
      <p className="mb-4 text-sm text-muted-foreground">{STEPS[step].text}</p>
      <div className="animate-fade-in" key={step}>
        {step === 0 && <AiSection onSaved={next} />}
        {step === 1 && <NotifySection />}
        {step === 2 && <EmailSection />}
      </div>
      <div className="mt-6 flex items-center justify-between">
        <Button variant="ghost" onClick={() => setStep(Math.max(0, step - 1))} disabled={step === 0}>
          Back
        </Button>
        <Button onClick={next} loading={busy} variant={last ? "primary" : "outline"}>
          {last ? "Finish" : "Next"} {!last && <ArrowRight className="h-4 w-4" />}
        </Button>
      </div>
    </div>
  );
}
