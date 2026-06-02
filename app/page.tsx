import Link from "next/link";
import { Search, Package2, Boxes, RotateCcw, Send, DollarSign } from "lucide-react";
import { getDashboardSnapshot } from "./returns/actions";

function formatUsdSafe(n: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Number.isFinite(n) ? n : 0);
}

export default async function Page() {
  const snapRes = await getDashboardSnapshot();
  const snap = snapRes.ok ? snapRes.data : null;
  const fetchError = snapRes.ok ? null : snapRes.error ?? "Failed to load dashboard.";

  return (
    <>
      <header className="admin-page-header h-auto min-h-14 sm:flex-row">
        <div className="flex flex-col">
          <h1>Dashboard</h1>
          <p>At-a-glance volume for returns, pallets, and packages.</p>
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
          {fetchError && (
            <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-xs text-destructive">
              <span className="font-semibold">Data warning:</span> {fetchError}
            </div>
          )}

          <section className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
            <div className="admin-stat-card px-4 py-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="admin-stat-card__label">Returns today</p>
                  <p className="admin-stat-card__value mt-1 text-2xl tabular-nums sm:text-3xl">
                    {snap?.returnsToday ?? "—"}
                  </p>
                  <p className="admin-stat-card__hint mt-2">New return items recorded since midnight UTC.</p>
                </div>
                <span className="admin-stat-card__icon">
                  <RotateCcw className="h-5 w-5" strokeWidth={2.25} />
                </span>
              </div>
            </div>

            <div className="admin-stat-card px-4 py-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="admin-stat-card__label">Pallets</p>
                  <p className="admin-stat-card__value mt-1 text-2xl tabular-nums sm:text-3xl">
                    {snap?.palletCount ?? "—"}
                  </p>
                  <p className="admin-stat-card__hint mt-2">Active pallets in your organization.</p>
                </div>
                <span className="admin-stat-card__icon">
                  <Boxes className="h-5 w-5" strokeWidth={2.25} />
                </span>
              </div>
            </div>

            <div className="admin-stat-card px-4 py-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="admin-stat-card__label">Packages</p>
                  <p className="admin-stat-card__value mt-1 text-2xl tabular-nums sm:text-3xl">
                    {snap?.packageCount ?? "—"}
                  </p>
                  <p className="admin-stat-card__hint mt-2">Active packages in your organization.</p>
                </div>
                <span className="admin-stat-card__icon">
                  <Package2 className="h-5 w-5" strokeWidth={2.25} />
                </span>
              </div>
            </div>

            <div className="admin-stat-card px-4 py-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="admin-stat-card__label">Claims ready to send</p>
                  <p className="admin-stat-card__value mt-1 text-2xl tabular-nums sm:text-3xl">
                    {snap?.claimsReadyToSend ?? "—"}
                  </p>
                  <p className="admin-stat-card__hint mt-2">
                    Submission queue — <code className="rounded border border-border bg-muted/80 px-1 font-mono text-[10px] text-foreground">ready_to_send</code> for Agent polling.
                  </p>
                </div>
                <span className="admin-stat-card__icon">
                  <Send className="h-5 w-5" strokeWidth={2.25} />
                </span>
              </div>
            </div>

            <div className="admin-stat-card px-4 py-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="admin-stat-card__label">Returns est. value</p>
                  <p className="admin-stat-card__value mt-1 text-2xl tabular-nums sm:text-3xl">
                    {snap ? formatUsdSafe(snap.returnsEstimatedValueUsd) : "—"}
                  </p>
                  <p className="admin-stat-card__hint mt-2">
                    Sum of <code className="rounded border border-border bg-muted/80 px-1 font-mono text-[10px] text-foreground">returns.estimated_value</code> (null → $0.00).
                  </p>
                </div>
                <span className="admin-stat-card__icon">
                  <DollarSign className="h-5 w-5" strokeWidth={2.25} />
                </span>
              </div>
            </div>
          </section>

          <section className="admin-panel-card p-5 sm:p-6">
            <p className="text-sm font-semibold tracking-tight text-foreground">Next steps</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Process inbound returns in Returns Processing. File and track marketplace claims in the Claim Engine.
            </p>
            <div className="mt-4 flex flex-wrap gap-2.5">
              <Link href="/returns" className="admin-btn-primary">
                Returns Processing
              </Link>
              <Link href="/claim-engine" className="admin-btn-secondary">
                Claim Engine
              </Link>
              <Link href="/settings" className="admin-btn-quiet">
                Connected Stores
              </Link>
            </div>
          </section>
        </div>
      </main>
    </>
  );
}
