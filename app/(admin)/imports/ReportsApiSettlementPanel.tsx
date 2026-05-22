"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Banknote, Loader2, Play, RefreshCw } from "lucide-react";

import { isAdminRole, useUserRole } from "@/components/UserRoleContext";
import {
  buildSourceRunUiSnapshot,
  dateInputToWindowIso,
  defaultReimbursementWindowDates,
  SOURCE_RUN_STATE_LABELS,
  type ReportsApiFlagsStatus,
  type ReportsApiRunStateResponse,
  type SourceRunUiSnapshot,
} from "@/lib/amazon/reports-api-ui";
import { SP_API_REPORT_TYPE_SETTLEMENT_V2 } from "@/lib/amazon/reports-api-settlement-plan";
import { isUuidString } from "@/lib/uuid";
import { listStores } from "../../settings/adapters/actions";

type StoreOption = {
  id: string;
  name: string;
  platform: string;
};

type Props = {
  organizationId: string | null;
  onUploadComplete?: () => void;
};

function formatWindow(start: string | null, end: string | null): string | null {
  if (!start && !end) return null;
  return `${start ?? "—"} → ${end ?? "—"}`;
}

function SourceRunStatusCard({
  snapshot,
  stateLabel,
}: {
  snapshot: SourceRunUiSnapshot;
  stateLabel: string | null;
}) {
  const rows: { label: string; value: string | null }[] = [
    { label: "State", value: stateLabel },
    { label: "upload_id", value: snapshot.upload_id },
    { label: "source_run_id", value: snapshot.source_run_id },
    { label: "report_id", value: snapshot.report_id },
    { label: "report_document_id", value: snapshot.report_document_id },
    { label: "Attempt count", value: String(snapshot.attempt_count) },
    { label: "Last error", value: snapshot.last_error_code },
    { label: "Next retry", value: snapshot.next_retry_at },
    { label: "Window", value: formatWindow(snapshot.window_start, snapshot.window_end) },
    { label: "Updated", value: snapshot.updated_at },
  ];

  return (
    <div className="rounded-xl border border-border bg-muted/30 px-4 py-3 text-sm">
      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Settlement source run
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
          Amazon or the import pipeline may need another resume invocation.
        </p>
      ) : null}
    </div>
  );
}

export function ReportsApiSettlementPanel({ organizationId, onUploadComplete }: Props) {
  const { role, actorUserId } = useUserRole();
  const orgId = (organizationId ?? "").trim();
  const hasOrg = isUuidString(orgId);

  const defaults = defaultReimbursementWindowDates();
  const [stores, setStores] = useState<StoreOption[]>([]);
  const [storeId, setStoreId] = useState("");
  const [windowStart, setWindowStart] = useState(defaults.start);
  const [windowEnd, setWindowEnd] = useState(defaults.end);

  const [flags, setFlags] = useState<ReportsApiFlagsStatus | null>(null);
  const [snapshot, setSnapshot] = useState<SourceRunUiSnapshot | null>(null);
  const [busy, setBusy] = useState<"idle" | "pull" | "resume">("idle");
  const [err, setErr] = useState<string | null>(null);

  const uploadIdRef = useRef<string | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const flagsEnabled = flags?.settlement_enabled === true;
  const isBusy = busy !== "idle";

  const clearPoll = useCallback(() => {
    if (pollTimerRef.current) {
      clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, []);

  const fetchFlags = useCallback(async () => {
    const res = await fetch("/api/settings/imports/reports-api/status", { cache: "no-store" });
    const json = (await res.json()) as ReportsApiFlagsStatus & { ok?: boolean };
    setFlags({
      worker_enabled: !!json.worker_enabled,
      reimbursements_enabled: !!json.reimbursements_enabled,
      settlement_enabled: !!json.settlement_enabled,
      disabled_reason: json.disabled_reason ?? null,
      settlement_disabled_reason: json.settlement_disabled_reason ?? null,
    });
  }, []);

  const fetchRunSnapshot = useCallback(
    async (uploadId: string, apiNeedsResume?: boolean) => {
      const res = await fetch(
        `/api/settings/imports/reports-api/status?upload_id=${encodeURIComponent(uploadId)}&organization_id=${encodeURIComponent(orgId)}`,
        { cache: "no-store" },
      );
      const json = (await res.json()) as {
        ok?: boolean;
        source_run?: SourceRunUiSnapshot | null;
        error?: string;
      };
      if (!res.ok || !json.ok) {
        throw new Error(json.error ?? "Could not load settlement source run status.");
      }
      const snap =
        json.source_run ??
        buildSourceRunUiSnapshot({ uploadId, metadata: null, apiNeedsResume });
      if (snap) setSnapshot(snap);
      return snap;
    },
    [orgId],
  );

  const applyRunResponse = useCallback(
    async (json: ReportsApiRunStateResponse) => {
      if (json.upload_id) uploadIdRef.current = json.upload_id;
      if (json.upload_id) {
        await fetchRunSnapshot(json.upload_id, json.needs_resume);
      }
      if (json.state === "complete") {
        clearPoll();
        onUploadComplete?.();
      }
      return !!(json.needs_resume && json.upload_id);
    },
    [clearPoll, fetchRunSnapshot, onUploadComplete],
  );

  const callResume = useCallback(async () => {
    const uploadId = uploadIdRef.current;
    if (!uploadId || !hasOrg) return;
    setBusy("resume");
    setErr(null);
    try {
      const res = await fetch("/api/settings/imports/reports-api/settlement/resume", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ upload_id: uploadId, organization_id: orgId }),
      });
      const json = (await res.json()) as ReportsApiRunStateResponse;
      if (res.status === 503) {
        throw new Error(json.error ?? "Settlement Reports API worker is disabled.");
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
  }, [applyRunResponse, clearPoll, hasOrg, orgId]);

  const startPollIfNeeded = useCallback(
    (needsResume: boolean) => {
      clearPoll();
      if (!needsResume || !uploadIdRef.current) return;
      pollTimerRef.current = setInterval(() => {
        void callResume();
      }, 20_000);
    },
    [callResume, clearPoll],
  );

  const handlePull = useCallback(async () => {
    if (!hasOrg || !storeId) {
      setErr("Select an organization and target store.");
      return;
    }
    const win = dateInputToWindowIso(windowStart, windowEnd);
    if ("error" in win) {
      setErr(win.error);
      return;
    }
    setBusy("pull");
    setErr(null);
    clearPoll();
    try {
      const res = await fetch("/api/settings/imports/reports-api/settlement/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          organization_id: orgId,
          store_id: storeId,
          window_start: win.window_start,
          window_end: win.window_end,
          actor_user_id: actorUserId ?? null,
          upload_id: uploadIdRef.current,
        }),
      });
      const json = (await res.json()) as ReportsApiRunStateResponse;
      if (res.status === 503) {
        throw new Error(json.error ?? "Settlement Reports API worker is disabled.");
      }
      if (!json.ok && json.state !== "complete" && res.status >= 400) {
        throw new Error(json.error ?? "Settlement pull failed.");
      }
      const needs = await applyRunResponse(json);
      startPollIfNeeded(needs);
      if (json.state === "complete" || json.idempotent_replay) {
        onUploadComplete?.();
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Settlement pull failed.");
    } finally {
      setBusy("idle");
    }
  }, [
    actorUserId,
    applyRunResponse,
    clearPoll,
    hasOrg,
    onUploadComplete,
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
      ? SOURCE_RUN_STATE_LABELS[snapshot.display_state] ?? snapshot.display_state
      : null;

  return (
    <section className="rounded-2xl border border-emerald-500/30 bg-card p-6 shadow-sm">
      <div className="flex items-center gap-2">
        <Banknote className="h-5 w-5 text-emerald-600" aria-hidden />
        <h2 className="text-lg font-semibold text-foreground">Amazon Reports API — Settlement</h2>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        Pull <span className="font-mono">{SP_API_REPORT_TYPE_SETTLEMENT_V2}</span> into the
        settlement import pipeline when server flags are enabled. No credentials in the browser.
      </p>

      {flags && !flagsEnabled && (
        <div className="mt-4 rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-900 dark:text-amber-100">
          <p className="font-medium">Settlement Reports API pull is disabled on this server.</p>
          <p className="mt-1 text-xs opacity-90">
            {flags.settlement_disabled_reason === "worker_disabled"
              ? "Set ENABLE_AMAZON_REPORTS_API_WORKER=true on the server."
              : "Set ENABLE_AMAZON_REPORTS_API_SETTLEMENT=true (and master worker flag) on the server."}
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

          <div className="grid grid-cols-2 gap-3">
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
            onClick={() => void handlePull()}
            className="inline-flex h-10 items-center gap-2 rounded-lg bg-emerald-600 px-4 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
          >
            {busy === "pull" ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            ) : (
              <Banknote className="h-4 w-4" aria-hidden />
            )}
            Pull settlement from Amazon
          </button>

          {snapshot?.needs_resume && uploadIdRef.current ? (
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

          {uploadIdRef.current ? (
            <button
              type="button"
              disabled={isBusy || !hasOrg}
              onClick={() => {
                const id = uploadIdRef.current;
                if (id) void fetchRunSnapshot(id).catch((e) => setErr(String(e)));
              }}
              className="inline-flex h-10 items-center gap-2 rounded-lg border border-border px-3 text-sm hover:bg-muted disabled:opacity-50"
            >
              <RefreshCw className="h-4 w-4" aria-hidden />
              Refresh status
            </button>
          ) : null}
        </div>

        {snapshot ? <SourceRunStatusCard snapshot={snapshot} stateLabel={stateLabel} /> : null}
      </div>
    </section>
  );
}
