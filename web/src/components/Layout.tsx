import { NavLink, Outlet, useLocation } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Activity as ActivityIcon, ArrowUpCircle, CalendarCheck, ListTodo, LogOut, Mail, Monitor, Moon, Settings as SettingsIcon, Sun } from "lucide-react";
import { useEffect } from "react";
import { get, type About, type Status } from "@/lib/api";
import { useTheme } from "@/lib/theme";
import { cn, timeAgo } from "./ui";

const NAV = [
  { to: "/", label: "Today", icon: CalendarCheck, end: true, badge: "due" as const },
  { to: "/tasks", label: "Tasks", icon: ListTodo },
  { to: "/inbox", label: "Inbox", icon: Mail, badge: "inbox" as const },
  { to: "/activity", label: "Activity", icon: ActivityIcon },
  { to: "/settings", label: "Settings", icon: SettingsIcon },
];
const MOBILE_NAV = ["/", "/tasks", "/inbox", "/settings"];

export function Logo({ className }: { className?: string }) {
  return <img src="/icon.svg" alt="" className={cn("h-8 w-8 rounded-[9px]", className)} />;
}

export function useStatus() {
  return useQuery({ queryKey: ["status"], queryFn: () => get<Status>("/status"), refetchInterval: 30_000 });
}

/** A dot and a few words: is the local model answering? */
export function AiStatus({ className }: { className?: string }) {
  const status = useStatus().data;
  if (!status) return null;
  const { ai } = status;
  const state = !ai.configured ? "off" : ai.ok === false ? "down" : ai.ok ? "up" : "unknown";
  const label =
    state === "off" ? "Local AI not set up" : state === "down" ? "Local AI unreachable" : state === "up" ? `Local AI: ${status.aiModel}` : `Local AI: ${status.aiModel}`;
  const hint =
    state === "down"
      ? `${ai.error ?? "No answer"} (${timeAgo(ai.checkedAt)}). Quick add and email still work with the built-in rules, and the AI catches up when it's back.`
      : state === "up"
        ? `Answered ${timeAgo(ai.checkedAt)}`
        : state === "off"
          ? "Set it up in Settings. Everything works without it, just less cleverly."
          : "Not used yet since the server started";
  return (
    <NavLink to="/settings#ai" title={hint} className={cn("flex items-center gap-2 rounded-lg px-3 py-2 text-xs text-muted-foreground hover:bg-muted", className)}>
      <span
        className={cn(
          "h-2 w-2 shrink-0 rounded-full",
          state === "up" ? "bg-success" : state === "down" ? "bg-destructive" : state === "off" ? "bg-input" : "bg-warning",
        )}
      />
      <span className="truncate">{label}</span>
    </NavLink>
  );
}

function UpdateNotice() {
  const about = useQuery({ queryKey: ["about"], queryFn: () => get<About>("/about"), staleTime: 3_600_000 }).data;
  if (!about?.updateAvailable || !about.update.url) return null;
  return (
    <a
      href={about.update.url}
      target="_blank"
      rel="noreferrer"
      className="flex items-center gap-2 rounded-lg bg-primary-soft px-3 py-2 text-xs font-medium text-primary hover:brightness-95"
      title="docker compose pull && docker compose up -d"
    >
      <ArrowUpCircle className="h-4 w-4" /> Docket {about.update.latest} is out
    </a>
  );
}

function ThemeButton() {
  const [theme, setTheme] = useTheme();
  const next = theme === "light" ? "dark" : theme === "dark" ? "system" : "light";
  const Icon = theme === "light" ? Sun : theme === "dark" ? Moon : Monitor;
  return (
    <button
      onClick={() => setTheme(next)}
      className="rounded-lg p-2 text-muted-foreground hover:bg-muted hover:text-foreground"
      title={`Theme: ${theme} (click for ${next})`}
      aria-label={`Theme: ${theme}`}
    >
      <Icon className="h-4 w-4" />
    </button>
  );
}

export function Layout({ onSignOut }: { onSignOut: () => void }) {
  const status = useStatus().data;
  const location = useLocation();
  const counts = { due: status?.due ?? 0, inbox: status?.inbox ?? 0 };
  useEffect(() => {
    if (!location.hash) window.scrollTo(0, 0);
  }, [location.pathname, location.hash]);

  return (
    <div className="min-h-screen">
      <div className="flex">
        <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-r bg-card/60 px-3 py-4 lg:flex">
          <div className="mb-6 flex items-center gap-2.5 px-2">
            <Logo />
            <span className="text-[17px] font-semibold tracking-tight">Docket</span>
          </div>
          <nav className="flex flex-col gap-0.5">
            {NAV.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                className={({ isActive }) =>
                  cn(
                    "flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
                    isActive ? "bg-primary-soft text-primary" : "text-muted-foreground hover:bg-muted hover:text-foreground",
                  )
                }
              >
                <item.icon className="h-[18px] w-[18px]" />
                <span className="flex-1">{item.label}</span>
                {item.badge && counts[item.badge] > 0 && (
                  <span className="rounded-full bg-primary px-1.5 py-px text-[11px] font-semibold text-primary-foreground">{counts[item.badge]}</span>
                )}
              </NavLink>
            ))}
          </nav>
          <div className="mt-auto space-y-1 border-t pt-3">
            <UpdateNotice />
            <AiStatus />
            <div className="flex items-center justify-between px-1">
              <ThemeButton />
              <button onClick={onSignOut} className="flex items-center gap-1.5 rounded-lg p-2 text-[13px] text-muted-foreground hover:bg-muted hover:text-foreground">
                <LogOut className="h-4 w-4" /> Sign out
              </button>
            </div>
          </div>
        </aside>

        <div className="min-w-0 flex-1">
          <header className="sticky top-0 z-30 flex items-center justify-between border-b bg-background/85 px-4 py-2.5 backdrop-blur lg:hidden">
            <div className="flex items-center gap-2">
              <Logo className="h-7 w-7" />
              <span className="font-semibold tracking-tight">Docket</span>
            </div>
            <div className="flex items-center">
              <NavLink to="/activity" className="rounded-lg p-2 text-muted-foreground hover:bg-muted" aria-label="Activity">
                <ActivityIcon className="h-4 w-4" />
              </NavLink>
              <ThemeButton />
            </div>
          </header>

          <main className="mx-auto max-w-4xl px-4 pb-28 pt-5 sm:px-6 lg:px-10 lg:pb-16 lg:pt-9">
            <Outlet />
          </main>

          <nav className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-4 border-t bg-card/95 pb-[env(safe-area-inset-bottom)] backdrop-blur lg:hidden">
            {NAV.filter((n) => MOBILE_NAV.includes(n.to)).map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                className={({ isActive }) => cn("relative flex flex-col items-center gap-0.5 py-2 text-[11px] font-medium", isActive ? "text-primary" : "text-muted-foreground")}
              >
                <item.icon className="h-5 w-5" />
                {item.label}
                {item.badge && counts[item.badge] > 0 && <span className="absolute right-[calc(50%-18px)] top-1.5 h-2 w-2 rounded-full bg-primary" />}
              </NavLink>
            ))}
          </nav>
        </div>
      </div>
    </div>
  );
}

export function PageHeader({ title, description, actions }: { title: string; description?: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <div className="mb-6 flex flex-col gap-3 sm:mb-8 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <h1 className="text-2xl font-semibold sm:text-[28px]">{title}</h1>
        {description && <p className="mt-1.5 max-w-2xl text-sm text-muted-foreground sm:text-[15px]">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}
