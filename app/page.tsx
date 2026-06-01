import { Search } from "lucide-react";
import { CommandCenterDashboard } from "@/components/CommandCenterDashboard";
import { mapDashboardToCommandCenter } from "@/lib/map-dashboard-command-center";
import { getDashboardSnapshot, getReturnsAnalyticsData } from "./returns/actions";

export default async function Page() {
  const [snapRes, analyticsRes] = await Promise.all([
    getDashboardSnapshot(),
    getReturnsAnalyticsData(),
  ]);
  const snap = snapRes.ok ? (snapRes.data ?? null) : null;
  const analytics = analyticsRes.ok ? (analyticsRes.data ?? null) : null;
  const command = mapDashboardToCommandCenter(snap, analytics);
  const fetchError = snapRes.ok
    ? analyticsRes.ok
      ? null
      : analyticsRes.error ?? "Failed to load analytics."
    : snapRes.error ?? "Failed to load dashboard.";

  return (
    <>
      <header className="flex h-14 flex-col gap-2 border-b border-border bg-card/90 px-4 backdrop-blur-sm sm:flex-row sm:items-center sm:justify-between sm:gap-4 md:px-6">
        <div className="flex flex-col">
          <h1 className="text-base font-semibold tracking-tight text-foreground sm:text-sm">Command center</h1>
          <p className="text-xs text-muted-foreground">
            Returns, packages, claims, and operational analytics for your workspace.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 sm:gap-4">
          <div className="relative hidden w-72 items-center md:flex">
            <Search className="pointer-events-none absolute left-3 h-4 w-4 text-muted-foreground" />
            <input
              type="search"
              placeholder="Search orders, RMAs, claims…"
              className="admin-chrome-input h-9 w-full rounded-lg pl-9 pr-3 text-xs text-foreground placeholder:text-muted-foreground outline-none transition"
            />
          </div>
        </div>
      </header>

      <main className="flex-1 overflow-y-auto overflow-x-hidden bg-background">
        <div className="mx-auto flex w-full max-w-[100vw] flex-col gap-5 px-4 py-5 sm:px-4 lg:px-8">
          {fetchError ? (
            <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-xs text-destructive">
              <span className="font-semibold">Data warning:</span> {fetchError}
            </div>
          ) : null}

          <CommandCenterDashboard command={command} analytics={analytics ?? null} />
        </div>
      </main>
    </>
  );
}
