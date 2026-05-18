"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Archive, Loader2, Play, RefreshCw } from "lucide-react";

import { isAdminRole, useUserRole } from "@/components/UserRoleContext";
import {
  buildFinancesSourceRunUiSnapshot,
  dateInputToWindowIso,
  defaultFinancesWindowDates,
  FINANCES_SOURCE_RUN_STATE_LABELS,
  type FinancesApiFlagsStatus,
  type FinancesApiRunStateResponse,
  type FinancesSourceRunUiSnapshot,
} from "@/lib/amazon/finances-api-ui";
import { isUuidString } from "@/lib/uuid";
import { listStores } from "../../settings/adapters/actions";

type StoreOption = {
  id: string;
  name: string;
  platform: string;
};

type Props = {
  organizationId: string | null;
  onArchiveComplete?: () => void;
};

function formatWindow(start: string | null, end: string | null): string | null {
  if (!start && !end) return null;
  return `${start ?? "—"} → ${end ?? "—"}`;
}

function FinancesSourceRunStatusCard({
  snapshot,
  stateLabel,
}: {
  snapshot: FinancesSourceRunUiSnapshot;
  stateLabel: string | null;
}) {
  const rows: { label: string; value: string | null }[] = [
    { label: "State", value: stateLabel },
    { label: "source_run_id", value: snapshot.source_run_id },
    { label: "Phase", value: snapshot.phase },
    { label: "Finances API version", value: snapshot.finances_api_version },
    { label: "API pages", value: String(snapshot.counts.api_pages) },
    { label: "Event groups", value: String(snapshot.counts.event_groups) },
    { label: "Events", value: String(snapshot.counts.events) },
    { label: "Attempt count", value: String(snapshot.attempt_count) },
    { label: "Last error", value: snapshot.last_error_code },
    { label: "Last operation", value: snapshot.last_operation },
    { label: "Next retry", value: snapshot.next_retry_at },
    { label: "Window", value: formatWindow(snapshot.window_start, snapshot.window_end) },
    { label: "Marketplace", value: snapshot.marketplace_id },
    { label: "Store", value: snapshot.store_id },
    { label: "Updated", value: snapshot.updated_at },
  ];

  return (
    <div className="rounded-xl border border-border bg-muted/30 px-4 py-3 text-sm">
      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Finances archive source run
      </p>
      <dl className="mt-3 grid gap-2 sm:grid-cols-2">
        {rows.map(({ label, value }) => (
          <div key={label}>
            <dt className="text-[11px] font-medium text-muted-foreground">{label}</dt>
            <dd className="mt-0.5 break-all font-mono text-xs text-foreground">{value ?? "—"}</dd>
          </div>
        ))}
      </dl>
      {snapshot.needs_resume ? (
        <p className="mt-3 text-xs text-amber-700 dark:text-amber-300">
          Pagination or parsing may need another resume invocation. Use Resume or wait for auto-poll.
        </p>
      ) : null}
      <p className="mt-3 text-[11px] text-muted-foreground">
        Writes only to <span className="font-mono">amazon_finances_*</span> archive tables — no FRR or
        settlement spine from this worker.
      </p>
    </div>
  );
}

export function FinancesApiArchivePanel({ organizationId, onArchiveComplete }: Props) {
  const { role } = useUserRole();
  const orgId = (organizationId ?? "").trim();
  const hasOrg = isUuidString(orgId);

  const defaults = defaultFinancesWindowDates();
  const [stores, setStores] = useState<StoreOption[]>([]);
  const [storeId, setStoreId] = useState("");
  const [marketplaceId, setMarketplaceId] = useState("");
  const [windowStart, setWindowStart] = useState(defaults.start);
  const [windowEnd, setWindowEnd] = useState(defaults.end);

  const [flags, setFlags] = useState<FinancesApiFlagsStatus | null>(null);
  const [snapshot, setSnapshot] = useState<FinancesSourceRunUiSnapshot | null>(null);
  const [busy, setBusy] = useState<"idle" | "run" | "resume">("idle");
  const [err, setErr] = useState<string | null>(null);

  const sourceRunIdRef = useRef<string | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const flagsEnabled = flags?.ingest_enabled === true;
  const isBusy = busy !== "idle";

  const clearPoll = useCallback(() => {
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, []);

  const fetchFlags = useCallback(async () => {
    const res = await fetch("/api/settings/imports/finances-api/status", { cache: "no-store" });
    const json = (await res.json()) as FinancesApiFlagsStatus & { ok?: boolean };
    setFlags({
      worker_enabled: !!json.worker_enabled,
      ingest_enabled: !!json.ingest_enabled,
      disabled_reason: json.disabled_reason ?? null,
    });
  }, []);

  const fetchRunSnapshot = useCallback(
    async (sourceRunId: string, apiNeedsResume?: boolean) => {
      const res = await fetch(
        `/api/settings/imports/finances-api/status?source_run_id=${encodeURIComponent(sourceRunId)}&organization_id=${encodeURIComponent(orgId)}`,
        { cache: "no-store" },
      );
      const json = (await res.json()) as {
        ok?: boolean;
        source_run?: FinancesSourceRunUiSnapshot | null;
        error?: string;
      };
      if (!res.ok || !json.ok) {
        throw new Error(json.error ?? "Could not load Finances archive status.");
      }
      const snap =
        json.source_run ??
        buildFinancesSourceRunUiSnapshot({
          row: { id: sourceRunId, state: "polling" },
          apiNeedsResume,
        });
      if (snap) setSnapshot(snap);
      return snap;
    },
    [orgId],
  );

  const applyRunResponse = useCallback(
    async (json: FinancesApiRunStateResponse) => {
      if (json.source_run_id) sourceRunIdRef.current = json.source_run_id;
      if (json.source_run_id) {
        await fetchRunSnapshot(json.source_run_id, json.needs_resume);
      }
      if (json.state === "complete") {
        clearPoll();
        onArchiveComplete?.();
      }
      return !!(json.needs_resume && json.source_run_id);
    },
    [clearPoll, fetchRunSnapshot, onArchiveComplete],
  );

  const callResume = useCallback(async () => {
    const sourceRunId = sourceRunIdRef.current;
    if (!sourceRunId || !hasOrg || !storeId) return;
    const win = dateInputToWindowIso(windowStart, windowEnd);
    if ("error" in win) {
      setErr(win.error);
      return;
    }
    setBusy("resume");
    setErr(null);
    try {
      const res = await fetch("/api/settings/imports/finances-api/resume", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          organization_id: orgId,
          store_id: storeId,
          source_run_id: sourceRunId,
          window_start: win.window_start,
          window_end: win.window_end,
          marketplace_id: marketplaceId.trim() || null,
        }),
      });
      const json = (await res.json()) as FinancesApiRunStateResponse;
      if (res.status === 503) {
        throw new Error(json.error ?? "Finances API worker is disabled.");
      }
      if (!json.ok && json.state !== "complete" && res.status >= 400) {
        throw new Error(json.error ?? "Resume failed.");
      }
      const needs = await applyRunResponse(json);
      if (!needs && json.state !== "complete") clearPoll();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Resume failed.");
    } finally {
      setBusy("idle");
    }
  }, [
    applyRunResponse,
    clearPoll,
    hasOrg,
    marketplaceId,
    orgId,
    storeId,
    windowEnd,
    windowStart,
  ]);

  const startPollIfNeeded = useCallback(
    (needsResume: boolean) => {
      clearPoll();
      if (!needsResume || !sourceRunIdRef.current) return;
      pollTimerRef.current = setInterval(() => {
        void callResume();
      }, 20_000);
    },
    [callResume, clearPoll],
  );

  const handleRunArchive = useCallback(async () => {
    if (!hasOrg || !storeId) {
      setErr("Select an organization and target store.");
      return;
    }
    const win = dateInputToWindowIso(windowStart, windowEnd);
    if ("error" in win) {
      setErr(win.error);
      return;
    }
    setBusy("run");
    setErr(null);
    clearPoll();
    try {
      const res = await fetch("/api/settings/imports/finances-api/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          organization_id: orgId,
          store_id: storeId,
          window_start: win.window_start,
          window_end: win.window_end,
          marketplace_id: marketplaceId.trim() || null,
          source_run_id: sourceRunIdRef.current,
        }),
      });
      const json = (await res.json()) as FinancesApiRunStateResponse;
      if (res.status === 503) {
        throw new Error(json.error ?? "Finances API worker is disabled.");
      }
      if (!json.ok && json.state !== "complete" && res.status >= 400) {
        throw new Error(json.error ?? "Archive run failed.");
      }
      const needs = await applyRunResponse(json);
      startPollIfNeeded(needs);
      if (json.state === "complete" || json.idempotent_replay) {
        onArchiveComplete?.();
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Archive run failed.");
    } finally {
      setBusy("idle");
    }
  }, [
    applyRunResponse,
    clearPoll,
    hasOrg,
    marketplaceId,
    onArchiveComplete,
    orgId,
    startPollIfNeeded,
    storeId,
    windowEnd,
    windowStart,
  ]);

  useEffect(() => {
    void fetchFlags();
  }, [fetchFlags]);

  useEffect(() => {
    let cancelled = false;
    if (!hasOrg) {
      setStores([]);
      setStoreId("");
      return;
    }
    void listStores().then((res) => {
      if (cancelled || !res.ok || !res.data) return;
      const active = res.data
        .filter((s) => s.is_active !== false && s.organization_id === orgId)
        .map((s) => ({ id: s.id, name: s.name, platform: s.platform }));
      setStores(active);
      setStoreId((cur) => {
        if (cur && active.some((s) => s.id === cur)) return cur;
        const amazon = active.find((s) => s.platform.toLowerCase().includes("amazon"));
        return amazon?.id ?? active[0]?.id ?? "";
      });
    });
    return () => {
      cancelled = true;
    };
  }, [hasOrg, orgId]);

  useEffect(() => () => clearPoll(), [clearPoll]);

  if (!isAdminRole(role)) return null;

  const stateLabel =
    snapshot?.display_state != null
      ? FINANCES_SOURCE_RUN_STATE_LABELS[snapshot.display_state] ?? snapshot.display_state
      : null;

  return (
    <section className="rounded-2xl border border-violet-500/30 bg-card p-6 shadow-sm">
      <div className="flex items-center gap-2">
        <Archive className="h-5 w-5 text-violet-500" aria-hidden />
        <h2 className="text-lg font-semibold text-foreground">Amazon Finances API — Archive</h2>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        Pull Finances API v0 event groups and events into <span className="font-mono">amazon_finances_*</span>{" "}
        tables when server feature flags are enabled. No FRR or CSV pipeline.
      </p>

      {flags && !flagsEnabled && (
        <div className="mt-4 rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-900 dark:text-amber-100">
          <p className="font-medium">Finances API archive is disabled on this server.</p>
          <p className="mt-1 text-xs opacity-90">
            {flags.disabled_reason === "worker_disabled"
              ? "Set ENABLE_AMAZON_FINANCES_API_WORKER=true on the server."
              : "Set ENABLE_AMAZON_FINANCES_API_INGEST=true (and master worker flag) on the server."}
          </p>
        </div>
      )}

      {err ? (
        <div className="mt-4 rounded-xl border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {err}
        </div>
      ) : null}

      <div className={`mt-5 space-y-4 ${!flagsEnabled ? "pointer-events-none opacity-50" : ""}`}>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Target store
            </label>
            <select
              value={storeId}
              disabled={isBusy || !hasOrg}
              onChange={(e) => setStoreId(e.target.value)}
              className="h-10 w-full rounded-lg border border-border bg-background px-3 text-sm disabled:opacity-50"
            >
              <option value="">Select a store…</option>
              {stores.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} ({s.platform})
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Marketplace ID (optional)
            </label>
            <input
              type="text"
              value={marketplaceId}
              disabled={isBusy}
              placeholder="e.g. ATVPDKIKX0DER"
              onChange={(e) => setMarketplaceId(e.target.value)}
              className="h-10 w-full rounded-lg border border-border bg-background px-3 font-mono text-sm disabled:opacity-50"
            />
          </div>

          <div className="grid grid-cols-2 gap-3 sm:col-span-2">
            <div>
              <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Window start
              </label>
              <input
                type="date"
                value={windowStart}
                disabled={isBusy}
                onChange={(e) => setWindowStart(e.target.value)}
                className="h-10 w-full rounded-lg border border-border bg-background px-3 text-sm disabled:opacity-50"
              />
            </div>
            <div>
              <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Window end
              </label>
              <input
                type="date"
                value={windowEnd}
                disabled={isBusy}
                onChange={(e) => setWindowEnd(e.target.value)}
                className="h-10 w-full rounded-lg border border-border bg-background px-3 text-sm disabled:opacity-50"
              />
            </div>
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            disabled={!flagsEnabled || isBusy || !storeId || !hasOrg}
            onClick={() => void handleRunArchive()}
            className="inline-flex h-10 items-center gap-2 rounded-lg bg-violet-600 px-4 text-sm font-medium text-white hover:bg-violet-700 disabled:opacity-50"
          >
            {busy === "run" ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            ) : (
              <Archive className="h-4 w-4" aria-hidden />
            )}
            Run Finances archive
          </button>

          {snapshot?.needs_resume && sourceRunIdRef.current ? (
            <button
              type="button"
              disabled={!flagsEnabled || isBusy}
              onClick={() => void callResume()}
              className="inline-flex h-10 items-center gap-2 rounded-lg border border-border bg-background px-4 text-sm font-medium hover:bg-muted disabled:opacity-50"
            >
              {busy === "resume" ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              ) : (
                <Play className="h-4 w-4" aria-hidden />
              )}
              Resume
            </button>
          ) : null}

          {sourceRunIdRef.current ? (
            <button
              type="button"
              disabled={isBusy || !hasOrg}
              onClick={() => {
                const id = sourceRunIdRef.current;
                if (id) void fetchRunSnapshot(id).catch((e) => setErr(String(e)));
              }}
              className="inline-flex h-10 items-center gap-2 rounded-lg border border-border px-3 text-sm hover:bg-muted disabled:opacity-50"
            >
              <RefreshCw className="h-4 w-4" aria-hidden />
              Refresh status
            </button>
          ) : null}
        </div>

        {snapshot ? <FinancesSourceRunStatusCard snapshot={snapshot} stateLabel={stateLabel} /> : null}
      </div>
    </section>
  );
}
