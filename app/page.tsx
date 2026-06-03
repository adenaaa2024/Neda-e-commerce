import { Search } from "lucide-react";
import { CommandCenterDashboard } from "@/components/CommandCenterDashboard";
import { getCommandCenterData } from "./returns/actions";

export default async function Page() {
  const ccRes = await getCommandCenterData();
  const data = ccRes.ok ? ccRes.data ?? null : null;
  const fetchError = ccRes.ok ? null : ccRes.error ?? "Failed to load command center.";

  return (
    <>
      <header className="admin-page-header command-center-header h-auto min-h-14 sm:flex-row">
        <div className="flex flex-col gap-0.5">
          <h1>Dashboard</h1>
          <p>Operational pulse for returns, warehouse intake, claims, and catalog health.</p>
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

      <main className="command-center-main flex-1 overflow-y-auto overflow-x-hidden">
        <div className="flex w-full min-w-0 flex-col py-4 lg:py-5">
          <CommandCenterDashboard data={data} fetchError={fetchError} />
        </div>
      </main>
    </>
  );
}
