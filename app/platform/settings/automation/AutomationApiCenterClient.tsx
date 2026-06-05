"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Archive,
  CalendarClock,
  Clock,
  CloudDownload,
  Loader2,
  Package,
  Receipt,
  Save,
  Ship,
  History,
} from "lucide-react";
import Link from "next/link";

import {
  financesFlagWarning,
  reimbursementFlagWarning,
  removalFlagWarning,
  settlementFlagWarning,
} from "@/lib/platform-automation-api-flags";
import {
  buildStoreAutomationSavePreview,
  formatUtcHoursForDisplay,
  formatWeeklySlotDisplay,
  WEEKDAY_NAMES,
} from "@/lib/platform-automation-ui-format";
import {
  computeApiCardNextRun,
  computeProductEnrichmentNextRun,
  computeRemovalHistoricalNextRun,
  computeRemovalRecentNextRun,
  formatHoursUtcForInput,
  formatLocalRunTimesForInput,
  isAnyStoreAutomationScheduleEnabled,
  normalizeStoreAutomationSettings,
  parseHoursUtcFromInput,
  parseLocalRunTimesFromInput,
} from "@/lib/platform-automation-schedule";
import {
  dateInputToWindowIso,
  defaultReimbursementWindowDates,
} from "@/lib/amazon/reports-api-ui";
import {
  drainProductEnrichmentJobTicks,
  enqueueProductEnrichmentJob,
} from "@/lib/pim-catalog-enrichment-job-client";
import {
  AUTOMATION_MANUAL_RUN_ROUTES,
  featureFlagBlockedMessage,
  manualRunAcceptanceMessage,
  manualRunStateFromResponse,
  pollAutomationRuntimeRefresh,
  postAutomationManualRun,
} from "@/lib/platform-automation-manual-run-ui";
import type { AutomationRunEnvironment } from "@/lib/platform-automation-run-environment";
import {
  hobbyRemovalScheduleWarning,
  isAutomationHobbyCronTierClient,
} from "@/lib/platform-automation-run-environment-client";
import type {
  AutomationCardManualRunState,
  StoreAutomationSettings,
  StoreAutomationSettingsView,
} from "@/lib/platform-automation-settings-types";
import {
  readAutomationApiReportType,
  readAutomationScopeStorage,
  writeAutomationApiReportType,
  writeAutomationScopeStorage,
  type AutomationApiReportType,
} from "@/lib/platform-automation-api-report-type";
import { responsiveFormInput, responsivePageInner, responsivePageOuter } from "@/lib/responsive-page-shell";
import { PageHeaderWithInfo } from "../../components/page-header-with-info";
import { AutomationScopeBar } from "./AutomationScopeBar";
import {
  DryRunNote,
  EnabledToggle,
  FeatureFlagBanner,
  ImportResumeNotice,
  ManualDateRangeFields,
  ManualRunButtons,
  RunTimeField,
  RuntimeStatsFromView,
} from "./automation-api-center-shared";
import {
  getPlatformAutomationSettingsAction,
  listPlatformAutomationOrganizationsAction,
  listPlatformAutomationStoresAction,
  savePlatformAutomationSettingsAction,
  type OrganizationOption,
} from "../automation-settings-actions";

type StoreOption = { id: string; name: string; platform: string };

type ManualRunKey = keyof StoreAutomationSettingsView["manual_runs"];

function defaultManualDates(settings: StoreAutomationSettings): { start: string; end: string } {
  const d = defaultReimbursementWindowDates();
  return {
    start: settings.reimbursements_api.manual_window_start ?? d.start,
    end: settings.reimbursements_api.manual_window_end ?? d.end,
  };
}

function resolveWindow(startDate: string, endDate: string): { window_start: string; window_end: string } | null {
  const w = dateInputToWindowIso(startDate, endDate);
  if ("error" in w) return null;
  return w;
}

function isBrowserLocalhost(): boolean {
  if (typeof window === "undefined") return false;
  return /^(localhost|127\.0\.0\.1)$/.test(window.location.hostname);
}

function formatManualRunMessage(
  result: Extract<Awaited<ReturnType<typeof postAutomationManualRun>>, { ok: true }>,
  runEnvironment: AutomationRunEnvironment | null,
): string {
  let msg = manualRunAcceptanceMessage(result);
  if (runEnvironment?.manual_run_may_queue_only && isBrowserLocalhost()) {
    msg += " Local dev: run was queued or partial — not a full production sync.";
  }
  return msg;
}

export function AutomationApiCenterClient() {
  const [loading, setLoading] = useState(true);
  const [scopeLoading, setScopeLoading] = useState(false);
  const [accessDenied, setAccessDenied] = useState<"not_authenticated" | "forbidden" | null>(null);
  const [organizations, setOrganizations] = useState<OrganizationOption[]>([]);
  const [stores, setStores] = useState<StoreOption[]>([]);
  const [orgId, setOrgId] = useState("");
  const [storeId, setStoreId] = useState("");
  const [view, setView] = useState<StoreAutomationSettingsView | null>(null);
  const [draft, setDraft] = useState<StoreAutomationSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [manualBusy, setManualBusy] = useState<string | null>(null);
  const [manualRunOverride, setManualRunOverride] = useState<
    Partial<StoreAutomationSettingsView["manual_runs"]>
  >({});
  const [apiReportType, setApiReportType] = useState<AutomationApiReportType>("product_data_update");
  const [runEnvironment, setRunEnvironment] = useState<AutomationRunEnvironment | null>(null);
  const hobbyCronTier = isAutomationHobbyCronTierClient();

  const hydrateDraft = useCallback((v: StoreAutomationSettingsView) => {
    setDraft(
      normalizeStoreAutomationSettings({
        product_enrichment: v.product_enrichment,
        removal_api_sync: v.removal_api_sync,
        reimbursements_api: v.reimbursements_api,
        settlement_api: v.settlement_api,
        finances_archive_api: v.finances_archive_api,
      }),
    );
  }, []);

  const loadSettings = useCallback(
    async (organizationId: string, selectedStoreId: string) => {
      if (!organizationId || !selectedStoreId) return;
      setScopeLoading(true);
      setError(null);
      const res = await getPlatformAutomationSettingsAction({
        organizationId,
        storeId: selectedStoreId,
      });
      setScopeLoading(false);
      if (res.accessDenied) {
        setAccessDenied(res.accessDenied);
        return;
      }
      setView(res.view);
      setRunEnvironment(res.runEnvironment);
      hydrateDraft(res.view);
    },
    [hydrateDraft],
  );

  useEffect(() => {
    setApiReportType(readAutomationApiReportType());
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const orgRes = await listPlatformAutomationOrganizationsAction();
      if (cancelled) return;
      if (orgRes.accessDenied) {
        setAccessDenied(orgRes.accessDenied);
        setLoading(false);
        return;
      }
      setOrganizations(orgRes.organizations);
      const stored = readAutomationScopeStorage();
      const initialOrg =
        stored.orgId && orgRes.organizations.some((o) => o.id === stored.orgId)
          ? stored.orgId
          : orgRes.organizations[0]?.id ?? "";
      setOrgId(initialOrg);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!orgId) {
      setStores([]);
      setStoreId("");
      return;
    }
    let cancelled = false;
    void (async () => {
      const res = await listPlatformAutomationStoresAction(orgId);
      if (cancelled) return;
      const list = res.accessDenied ? [] : res.stores;
      setStores(list);
      const stored = readAutomationScopeStorage();
      const pick =
        stored.orgId === orgId && stored.storeId && list.some((s) => s.id === stored.storeId)
          ? stored.storeId
          : list.find((s) => (s.platform ?? "").toLowerCase().includes("amazon"))?.id ?? list[0]?.id ?? "";
      setStoreId(pick);
    })();
    return () => {
      cancelled = true;
    };
  }, [orgId]);

  useEffect(() => {
    if (!orgId || !storeId) return;
    writeAutomationScopeStorage(orgId, storeId);
    setManualRunOverride({});
    void loadSettings(orgId, storeId);
  }, [orgId, storeId, loadSettings]);

  const handleOrgChange = useCallback((nextOrgId: string) => {
    setOrgId(nextOrgId);
    setStoreId("");
    setView(null);
    setDraft(null);
    setMessage(null);
    setError(null);
  }, []);

  const handleStoreChange = useCallback((nextStoreId: string) => {
    setStoreId(nextStoreId);
    setView(null);
    setDraft(null);
    setMessage(null);
    setError(null);
  }, []);

  const handleApiReportTypeChange = useCallback((next: AutomationApiReportType) => {
    setApiReportType(next);
    writeAutomationApiReportType(next);
  }, []);

  const draftNextRuns = useMemo(() => {
    if (!draft) return null;
    const now = new Date();
    return {
      product: computeProductEnrichmentNextRun(draft.product_enrichment, now),
      removal: computeRemovalRecentNextRun(draft.removal_api_sync, now),
      historical: computeRemovalHistoricalNextRun(draft.removal_api_sync, now),
      reimbursements: computeApiCardNextRun(draft.reimbursements_api, now),
      settlement: computeApiCardNextRun(draft.settlement_api, now),
      finances: computeApiCardNextRun(draft.finances_archive_api, now),
    };
  }, [draft]);

  const removalHobbyWarning = useMemo(() => {
    if (!draft || !hobbyCronTier) return null;
    return hobbyRemovalScheduleWarning({
      runs_per_day: draft.removal_api_sync.recent_sync.runs_per_day,
      run_times_local: draft.removal_api_sync.recent_sync.run_times_local,
      run_hours_utc: draft.removal_api_sync.recent_sync.run_hours_utc,
    });
  }, [draft, hobbyCronTier]);

  const savePreview = useMemo(
    () => (draft ? buildStoreAutomationSavePreview(draft) : null),
    [draft],
  );

  const flags = view?.api_flags ?? null;
  const manualDates = draft ? defaultManualDates(draft) : defaultReimbursementWindowDates();

  const effectiveManualRuns = useMemo(() => {
    if (!view) return null;
    const merge = (key: ManualRunKey): AutomationCardManualRunState => ({
      ...view.manual_runs[key],
      ...manualRunOverride[key],
    });
    return {
      product_enrichment: merge("product_enrichment"),
      reimbursements_api: merge("reimbursements_api"),
      settlement_api: merge("settlement_api"),
      finances_archive_api: merge("finances_archive_api"),
      removal_order: merge("removal_order"),
      removal_shipment: merge("removal_shipment"),
    };
  }, [view, manualRunOverride]);

  const updateDraft = useCallback((patch: Partial<StoreAutomationSettings>) => {
    setDraft((cur) => (cur ? normalizeStoreAutomationSettings({ ...cur, ...patch }) : cur));
  }, []);

  async function onSave(e: React.FormEvent) {
    e.preventDefault();
    if (!draft || !orgId || !storeId) return;
    setSaving(true);
    setError(null);
    setMessage(null);
    const res = await savePlatformAutomationSettingsAction({
      organizationId: orgId,
      storeId,
      settings: draft,
    });
    setSaving(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setView(res.view);
    hydrateDraft(res.view);
    setMessage("Settings saved for this company and store. Cron is not enabled from this page.");
  }

  async function refreshView() {
    if (orgId && storeId) {
      setManualRunOverride({});
      await loadSettings(orgId, storeId);
    }
  }

  async function applyManualRunResult(
    key: ManualRunKey,
    url: string,
    body: Record<string, unknown>,
    busyKey: string,
  ): Promise<boolean> {
    if (!orgId || !storeId) return false;
    setManualBusy(busyKey);
    setError(null);
    try {
      const result = await postAutomationManualRun(url, body);
      if (!result.ok) {
        setError(featureFlagBlockedMessage(result.code, result.error));
        return false;
      }
      const patch = manualRunStateFromResponse(result.data);
      setManualRunOverride((prev) => ({
        ...prev,
        [key]: {
          ...view?.manual_runs[key],
          ...prev[key],
          ...patch,
          last_error: null,
        },
      }));
      setMessage(formatManualRunMessage(result, runEnvironment));
      if (result.httpStatus === 202 || result.accepted) {
        await pollAutomationRuntimeRefresh(refreshView);
      } else {
        await refreshView();
      }
      return true;
    } finally {
      setManualBusy(null);
    }
  }

  async function runReimbursements() {
    if (!draft) return;
    const w = resolveWindow(
      draft.reimbursements_api.manual_window_start ?? manualDates.start,
      draft.reimbursements_api.manual_window_end ?? manualDates.end,
    );
    if (!w) {
      setError("Invalid manual date range for reimbursements.");
      return;
    }
    const uploadId = effectiveManualRuns?.reimbursements_api.upload_id;
    await applyManualRunResult("reimbursements_api", AUTOMATION_MANUAL_RUN_ROUTES.reimbursements_run, {
      organization_id: orgId,
      store_id: storeId,
      window_start: w.window_start,
      window_end: w.window_end,
      upload_id: uploadId,
    }, "reimbursements");
  }

  async function resumeReimbursements() {
    const uploadId = effectiveManualRuns?.reimbursements_api.upload_id;
    if (!uploadId) {
      setError("No reimbursements upload to resume.");
      return;
    }
    await applyManualRunResult(
      "reimbursements_api",
      AUTOMATION_MANUAL_RUN_ROUTES.reimbursements_resume,
      { organization_id: orgId, upload_id: uploadId },
      "reimbursements-resume",
    );
  }

  async function runSettlement() {
    if (!draft) return;
    const w = resolveWindow(
      draft.settlement_api.manual_window_start ?? manualDates.start,
      draft.settlement_api.manual_window_end ?? manualDates.end,
    );
    if (!w) {
      setError("Invalid manual date range for settlement.");
      return;
    }
    const uploadId = effectiveManualRuns?.settlement_api.upload_id;
    await applyManualRunResult("settlement_api", AUTOMATION_MANUAL_RUN_ROUTES.settlement_run, {
      organization_id: orgId,
      store_id: storeId,
      window_start: w.window_start,
      window_end: w.window_end,
      upload_id: uploadId,
    }, "settlement");
  }

  async function resumeSettlement() {
    const uploadId = effectiveManualRuns?.settlement_api.upload_id;
    if (!uploadId) {
      setError("No settlement upload to resume.");
      return;
    }
    await applyManualRunResult(
      "settlement_api",
      AUTOMATION_MANUAL_RUN_ROUTES.settlement_resume,
      { organization_id: orgId, upload_id: uploadId },
      "settlement-resume",
    );
  }

  async function runFinances() {
    if (!draft) return;
    const w = resolveWindow(
      draft.finances_archive_api.manual_window_start ?? manualDates.start,
      draft.finances_archive_api.manual_window_end ?? manualDates.end,
    );
    if (!w) {
      setError("Invalid manual date range for finances archive.");
      return;
    }
    await applyManualRunResult("finances_archive_api", AUTOMATION_MANUAL_RUN_ROUTES.finances_run, {
      organization_id: orgId,
      store_id: storeId,
      marketplace_id: draft.finances_archive_api.marketplace_id,
      window_start: w.window_start,
      window_end: w.window_end,
    }, "finances");
  }

  async function resumeFinances() {
    const sourceRunId = effectiveManualRuns?.finances_archive_api.source_run_id;
    if (!sourceRunId || !draft) {
      setError("No finances source run to resume.");
      return;
    }
    const w = resolveWindow(
      draft.finances_archive_api.manual_window_start ?? manualDates.start,
      draft.finances_archive_api.manual_window_end ?? manualDates.end,
    );
    if (!w) return;
    await applyManualRunResult("finances_archive_api", AUTOMATION_MANUAL_RUN_ROUTES.finances_resume, {
      organization_id: orgId,
      store_id: storeId,
      source_run_id: sourceRunId,
      window_start: w.window_start,
      window_end: w.window_end,
      marketplace_id: draft.finances_archive_api.marketplace_id,
    }, "finances-resume");
  }

  async function runRemovalFetch() {
    if (!draft) return;
    const win = resolveWindow(
      draft.removal_api_sync.recent_sync.manual_window_start ?? manualDates.start,
      draft.removal_api_sync.recent_sync.manual_window_end ?? manualDates.end,
    );
    if (!win) {
      setError("Invalid manual date range for removal sync.");
      return;
    }
    setManualBusy("removal");
    setError(null);
    try {
      let anyAccepted = false;
      for (const [key, route] of [
        ["removal_order", AUTOMATION_MANUAL_RUN_ROUTES.removal_order_run] as const,
        ["removal_shipment", AUTOMATION_MANUAL_RUN_ROUTES.removal_shipment_run] as const,
      ]) {
        const uploadId = effectiveManualRuns?.[key as ManualRunKey]?.upload_id;
        const result = await postAutomationManualRun(route, {
          organization_id: orgId,
          store_id: storeId,
          window_start: win.window_start,
          window_end: win.window_end,
          upload_id: uploadId,
        });
        if (!result.ok) {
          setError(featureFlagBlockedMessage(result.code, result.error));
          return;
        }
        setManualRunOverride((prev) => ({
          ...prev,
          [key]: {
            ...view?.manual_runs[key as ManualRunKey],
            ...manualRunStateFromResponse(result.data),
            last_error: null,
          },
        }));
        if (result.httpStatus === 202 || result.accepted) anyAccepted = true;
      }
      setMessage(
        anyAccepted
          ? `Run accepted / started. Check status below.${runEnvironment?.manual_run_may_queue_only && isBrowserLocalhost() ? " Local dev: queued only." : ""}`
          : "Removal order and shipment manual runs accepted.",
      );
      if (anyAccepted) await pollAutomationRuntimeRefresh(refreshView);
      else await refreshView();
    } finally {
      setManualBusy(null);
    }
  }

  async function resumeRemovalOrder() {
    const uploadId = effectiveManualRuns?.removal_order.upload_id;
    if (!uploadId) {
      setError("No removal order upload to resume.");
      return;
    }
    await applyManualRunResult(
      "removal_order",
      AUTOMATION_MANUAL_RUN_ROUTES.removal_order_resume,
      { organization_id: orgId, upload_id: uploadId },
      "removal-order-resume",
    );
  }

  async function resumeRemovalShipment() {
    const uploadId = effectiveManualRuns?.removal_shipment.upload_id;
    if (!uploadId) {
      setError("No removal shipment upload to resume.");
      return;
    }
    await applyManualRunResult(
      "removal_shipment",
      AUTOMATION_MANUAL_RUN_ROUTES.removal_shipment_resume,
      { organization_id: orgId, upload_id: uploadId },
      "removal-shipment-resume",
    );
  }

  async function runProductUpdate() {
    if (!orgId || !storeId) return;
    setManualBusy("product");
    setError(null);
    try {
      const enq = await enqueueProductEnrichmentJob({
        organization_id: orgId,
        store_id: storeId,
        idempotency_key: `automation-ui-${orgId}-${storeId}-${Date.now()}`,
        payload: { organization_id: orgId, store_id: storeId, prioritize_incomplete: true },
      });
      if (!enq.ok) {
        setError(enq.error);
        return;
      }
      setManualRunOverride((prev) => ({
        ...prev,
        product_enrichment: {
          active_job_id: enq.job_id,
          job_status: enq.status,
          needs_resume: true,
          state: enq.status,
          upload_id: null,
          source_run_id: null,
          last_error: null,
        },
      }));
      setMessage("Product enrichment background job enqueued.");
      void drainProductEnrichmentJobTicks(enq.job_id, { maxTicks: 8 }).then(() => refreshView());
      await refreshView();
    } finally {
      setManualBusy(null);
    }
  }

  if (loading) {
    return (
      <div className={responsivePageOuter}>
        <div className={`${responsivePageInner} flex min-h-[40vh] items-center justify-center`}>
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      </div>
    );
  }

  if (accessDenied) {
    return (
      <div className={responsivePageOuter}>
        <div className={responsivePageInner}>
          <h1 className="text-lg font-semibold">API Automation</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {accessDenied === "not_authenticated"
              ? "You must be signed in."
              : "Only Menorix super administrators can view or edit API automation."}
          </p>
        </div>
      </div>
    );
  }

  const scopeReady = Boolean(draft && view && draftNextRuns);
  const anyEnabled = draft ? isAnyStoreAutomationScheduleEnabled(draft) : false;

  return (
    <div className={responsivePageOuter}>
      <div className={`${responsivePageInner} space-y-6`}>
        <PageHeaderWithInfo
          title="API Automation"
          titleClassName="text-2xl font-bold tracking-tight text-foreground sm:text-3xl"
          infoAriaLabel="About API automation"
        >
          <p>
            Configure Amazon API pulls and schedules for the selected company and store. File uploads remain on{" "}
            <Link href="/dashboard/file-import" className="font-medium text-violet-600 underline dark:text-violet-400">
              Data Management → Imports
            </Link>
            . All schedules are <strong>off by default</strong>.
          </p>
        </PageHeaderWithInfo>

        <p className="text-sm text-muted-foreground">
          <Link href="/platform/settings" className="font-medium text-violet-600 hover:underline dark:text-violet-400">
            ← Platform branding
          </Link>
        </p>

        <AutomationScopeBar
          organizations={organizations}
          stores={stores}
          orgId={orgId}
          storeId={storeId}
          onOrgChange={handleOrgChange}
          onStoreChange={handleStoreChange}
          apiReportType={apiReportType}
          onApiReportTypeChange={handleApiReportTypeChange}
          scopeLoading={scopeLoading}
        />

        {isBrowserLocalhost() && runEnvironment?.local_warning ? (
          <div className="rounded-xl border border-sky-500/30 bg-sky-500/10 px-4 py-3 text-sm text-sky-950 dark:text-sky-50">
            <p className="font-medium">Local development</p>
            <p className="mt-1 text-xs">{runEnvironment.local_warning}</p>
          </div>
        ) : null}

        {!scopeReady ? (
          <div className="rounded-xl border border-border bg-muted/20 px-4 py-6 text-center text-sm text-muted-foreground">
            {scopeLoading || loading
              ? "Loading automation settings for the selected company and store…"
              : "Choose a company and store above to load automation settings."}
          </div>
        ) : null}

        {scopeReady && draft && view && draftNextRuns ? (
          <>
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-950 dark:text-amber-50">
          <div className="flex gap-2">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            <div className="space-y-1">
              <p className="font-medium">Schedules are off until you enable them</p>
              <DryRunNote>
                Manual runs call existing import API routes. Nothing is scheduled automatically from this page alone.
              </DryRunNote>
            </div>
          </div>
        </div>

        {error ? (
          <div className="rounded-xl border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            {error}
          </div>
        ) : null}
        {message ? (
          <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-900 dark:text-emerald-100">
            {message}
          </div>
        ) : null}

        <form onSubmit={onSave} className="space-y-6">
          {apiReportType === "product_data_update" ? (
          <section className="rounded-2xl border border-border bg-card p-4 shadow-sm sm:p-6">
            <div className="flex items-start gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-violet-500/10 text-violet-700 dark:text-violet-300">
                <Package className="h-5 w-5" aria-hidden />
              </div>
              <div className="min-w-0 flex-1">
                <h2 className="text-lg font-semibold text-foreground">Product Data Update</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  Scheduled catalog enrichment for products with an ASIN (background job).
                </p>
              </div>
            </div>
            <div className="mt-4 space-y-4">
              <EnabledToggle
                checked={draft.product_enrichment.enabled}
                onChange={(v) =>
                  updateDraft({ product_enrichment: { ...draft.product_enrichment, enabled: v } })
                }
                title="Schedule enabled"
                description="When off, no scheduled product data updates will run."
              />
              <div className="grid gap-4 sm:grid-cols-2">
                <label className="block text-sm">
                  <span className="font-medium text-foreground">Runs per day</span>
                  <input
                    type="number"
                    min={1}
                    max={24}
                    value={draft.product_enrichment.runs_per_day}
                    onChange={(e) =>
                      updateDraft({
                        product_enrichment: {
                          ...draft.product_enrichment,
                          runs_per_day: Number(e.target.value),
                        },
                      })
                    }
                    className={`${responsiveFormInput} mt-1.5`}
                  />
                </label>
                <RunTimeField
                  id="pe-run-times"
                  label="Schedule run times (UTC)"
                  value={formatHoursUtcForInput(draft.product_enrichment.run_hours_utc)}
                  onChange={(text) =>
                    updateDraft({
                      product_enrichment: {
                        ...draft.product_enrichment,
                        run_hours_utc: parseHoursUtcFromInput(text, draft.product_enrichment.runs_per_day),
                      },
                    })
                  }
                  runsPerDay={draft.product_enrichment.runs_per_day}
                  formatUtcHoursForDisplay={formatUtcHoursForDisplay}
                  parseHoursUtcFromInput={parseHoursUtcFromInput}
                />
              </div>
              <ManualDateRangeFields
                windowStart={draft.product_enrichment.manual_window_start ?? manualDates.start}
                windowEnd={draft.product_enrichment.manual_window_end ?? manualDates.end}
                onStartChange={(v) =>
                  updateDraft({
                    product_enrichment: { ...draft.product_enrichment, manual_window_start: v || null },
                  })
                }
                onEndChange={(v) =>
                  updateDraft({
                    product_enrichment: { ...draft.product_enrichment, manual_window_end: v || null },
                  })
                }
                hint="Optional saved defaults. Manual catalog update does not use a report date window."
              />
              <ManualRunButtons
                runLabel="Run catalog update now"
                busy={manualBusy === "product"}
                disabled={!orgId || !storeId}
                onRun={runProductUpdate}
              />
              {effectiveManualRuns ? (
                <ImportResumeNotice
                  run={effectiveManualRuns.product_enrichment}
                  label="Product enrichment background job"
                />
              ) : null}
              <RuntimeStatsFromView
                enabled={draft.product_enrichment.enabled}
                runtime={view.runtime.product_enrichment}
                nextRun={draft.product_enrichment.enabled ? draftNextRuns.product : null}
              />
            </div>
          </section>
          ) : null}

          {apiReportType === "removal_shipment" ? (
          <section className="rounded-2xl border border-border bg-card p-4 shadow-sm sm:p-6">
            <div className="flex items-start gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-sky-500/10 text-sky-700 dark:text-sky-300">
                <Ship className="h-5 w-5" aria-hidden />
              </div>
              <div className="min-w-0 flex-1">
                <h2 className="text-lg font-semibold text-foreground">Removal / Shipment Sync</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  Fetch removal order and shipment reports via SP-API.
                </p>
              </div>
            </div>
            {flags ? <FeatureFlagBanner warning={removalFlagWarning(flags)} /> : null}
            {hobbyCronTier ? (
              <div className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-950 dark:text-amber-50">
                <p className="font-medium">Vercel Hobby cron</p>
                <p className="mt-1">
                  Scheduled wake is limited to once per day on Hobby. Use <strong>Runs per day = 1</strong> and one
                  local run time, or set <code className="text-[10px]">NEXT_PUBLIC_AUTOMATION_VERCEL_CRON_TIER=pro</code>{" "}
                  for frequent wakes.
                </p>
              </div>
            ) : null}
            {removalHobbyWarning ? (
              <div className="mt-3 rounded-lg border border-amber-500/40 bg-amber-500/15 px-3 py-2 text-xs text-amber-950 dark:text-amber-50">
                {removalHobbyWarning}
              </div>
            ) : null}
            <div className="mt-4 space-y-4">
              <EnabledToggle
                checked={draft.removal_api_sync.enabled}
                onChange={(v) =>
                  updateDraft({ removal_api_sync: { ...draft.removal_api_sync, enabled: v } })
                }
                title="Schedule enabled"
                description="When off, no scheduled removal or shipment sync will run."
              />
              <div className="grid gap-4 sm:grid-cols-2">
                <label className="block text-sm">
                  <span className="font-medium text-foreground">Runs per day</span>
                  <input
                    type="number"
                    min={1}
                    max={hobbyCronTier ? 1 : 24}
                    value={draft.removal_api_sync.recent_sync.runs_per_day}
                    onChange={(e) => {
                      const raw = Number(e.target.value);
                      const runs = hobbyCronTier ? Math.min(1, raw) : raw;
                      updateDraft({
                        removal_api_sync: {
                          ...draft.removal_api_sync,
                          recent_sync: {
                            ...draft.removal_api_sync.recent_sync,
                            runs_per_day: runs,
                          },
                        },
                      });
                    }}
                    className={`${responsiveFormInput} mt-1.5`}
                  />
                </label>
                <label className="block text-sm">
                  <span className="font-medium text-foreground">Rolling window (days)</span>
                  <input
                    type="number"
                    min={1}
                    max={90}
                    value={draft.removal_api_sync.recent_sync.rolling_days}
                    onChange={(e) =>
                      updateDraft({
                        removal_api_sync: {
                          ...draft.removal_api_sync,
                          recent_sync: {
                            ...draft.removal_api_sync.recent_sync,
                            rolling_days: Number(e.target.value),
                          },
                        },
                      })
                    }
                    className={`${responsiveFormInput} mt-1.5`}
                  />
                </label>
                <RunTimeField
                  id="rem-run-times"
                  label="Schedule run times (UTC fallback)"
                  value={formatHoursUtcForInput(draft.removal_api_sync.recent_sync.run_hours_utc)}
                  onChange={(text) =>
                    updateDraft({
                      removal_api_sync: {
                        ...draft.removal_api_sync,
                        recent_sync: {
                          ...draft.removal_api_sync.recent_sync,
                          run_hours_utc: parseHoursUtcFromInput(
                            text,
                            draft.removal_api_sync.recent_sync.runs_per_day,
                          ),
                        },
                      },
                    })
                  }
                  runsPerDay={draft.removal_api_sync.recent_sync.runs_per_day}
                  formatUtcHoursForDisplay={formatUtcHoursForDisplay}
                  parseHoursUtcFromInput={parseHoursUtcFromInput}
                />
                <label className="block text-sm sm:col-span-2">
                  <span className="font-medium text-foreground">Local run times (preferred)</span>
                  <input
                    type="text"
                    placeholder="23:30, 06:00"
                    value={formatLocalRunTimesForInput(draft.removal_api_sync.recent_sync.run_times_local)}
                    onChange={(e) => {
                      const maxTimes = hobbyCronTier ? 1 : draft.removal_api_sync.recent_sync.runs_per_day;
                      const parsed = parseLocalRunTimesFromInput(e.target.value, maxTimes);
                      updateDraft({
                        removal_api_sync: {
                          ...draft.removal_api_sync,
                          recent_sync: {
                            ...draft.removal_api_sync.recent_sync,
                            run_times_local: parsed,
                            runs_per_day: parsed.length || draft.removal_api_sync.recent_sync.runs_per_day,
                          },
                        },
                      });
                    }}
                    className={`${responsiveFormInput} mt-1.5`}
                  />
                  <span className="mt-1 block text-[11px] text-muted-foreground">
                    HH:MM in timezone below. On Vercel Hobby the route wakes once daily (~08:00 UTC);
                    runs only when a slot falls in that wake window. For multiple runs/day use Vercel Pro
                    cron, an external scheduler hitting /api/cron/removal-nightly-sync, or Supabase pg_cron/pg_net.
                  </span>
                </label>
                <label className="block text-sm">
                  <span className="font-medium text-foreground">Timezone</span>
                  <input
                    type="text"
                    value={draft.removal_api_sync.recent_sync.timezone}
                    onChange={(e) =>
                      updateDraft({
                        removal_api_sync: {
                          ...draft.removal_api_sync,
                          recent_sync: {
                            ...draft.removal_api_sync.recent_sync,
                            timezone: e.target.value.trim() || "UTC",
                          },
                        },
                      })
                    }
                    className={`${responsiveFormInput} mt-1.5`}
                    placeholder="America/Los_Angeles"
                  />
                </label>
                <label className="block text-sm">
                  <span className="font-medium text-foreground">Max runtime (seconds)</span>
                  <input
                    type="number"
                    min={60}
                    max={3600}
                    value={draft.removal_api_sync.recent_sync.max_runtime_seconds}
                    onChange={(e) =>
                      updateDraft({
                        removal_api_sync: {
                          ...draft.removal_api_sync,
                          recent_sync: {
                            ...draft.removal_api_sync.recent_sync,
                            max_runtime_seconds: Number(e.target.value),
                          },
                        },
                      })
                    }
                    className={`${responsiveFormInput} mt-1.5`}
                  />
                </label>
              </div>
              <div className="flex flex-wrap gap-4 text-sm">
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={draft.removal_api_sync.recent_sync.report_types.includes("removal_order")}
                    onChange={(e) => {
                      const set = new Set(draft.removal_api_sync.recent_sync.report_types);
                      if (e.target.checked) set.add("removal_order");
                      else set.delete("removal_order");
                      updateDraft({
                        removal_api_sync: {
                          ...draft.removal_api_sync,
                          recent_sync: {
                            ...draft.removal_api_sync.recent_sync,
                            report_types: [...set] as ("removal_order" | "removal_shipment")[],
                          },
                        },
                      });
                    }}
                  />
                  Removal order report
                </label>
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={draft.removal_api_sync.recent_sync.report_types.includes("removal_shipment")}
                    onChange={(e) => {
                      const set = new Set(draft.removal_api_sync.recent_sync.report_types);
                      if (e.target.checked) set.add("removal_shipment");
                      else set.delete("removal_shipment");
                      updateDraft({
                        removal_api_sync: {
                          ...draft.removal_api_sync,
                          recent_sync: {
                            ...draft.removal_api_sync.recent_sync,
                            report_types: [...set] as ("removal_order" | "removal_shipment")[],
                          },
                        },
                      });
                    }}
                  />
                  Removal shipment report
                </label>
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={draft.removal_api_sync.recent_sync.rebuild_expected_packages}
                    onChange={(e) =>
                      updateDraft({
                        removal_api_sync: {
                          ...draft.removal_api_sync,
                          recent_sync: {
                            ...draft.removal_api_sync.recent_sync,
                            rebuild_expected_packages: e.target.checked,
                          },
                        },
                      })
                    }
                  />
                  Rebuild expected packages
                </label>
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={draft.removal_api_sync.recent_sync.retry_on_failure}
                    onChange={(e) =>
                      updateDraft({
                        removal_api_sync: {
                          ...draft.removal_api_sync,
                          recent_sync: {
                            ...draft.removal_api_sync.recent_sync,
                            retry_on_failure: e.target.checked,
                          },
                        },
                      })
                    }
                  />
                  Retry on failure (next slot)
                </label>
              </div>
              <ManualDateRangeFields
                windowStart={
                  draft.removal_api_sync.recent_sync.manual_window_start ?? manualDates.start
                }
                windowEnd={draft.removal_api_sync.recent_sync.manual_window_end ?? manualDates.end}
                onStartChange={(v) =>
                  updateDraft({
                    removal_api_sync: {
                      ...draft.removal_api_sync,
                      recent_sync: {
                        ...draft.removal_api_sync.recent_sync,
                        manual_window_start: v || null,
                      },
                    },
                  })
                }
                onEndChange={(v) =>
                  updateDraft({
                    removal_api_sync: {
                      ...draft.removal_api_sync,
                      recent_sync: {
                        ...draft.removal_api_sync.recent_sync,
                        manual_window_end: v || null,
                      },
                    },
                  })
                }
              />
              <ManualRunButtons
                busy={manualBusy === "removal" || manualBusy?.startsWith("removal-") === true}
                disabled={!orgId || !storeId || Boolean(flags && removalFlagWarning(flags).disabled)}
                onRun={runRemovalFetch}
                canResume={
                  Boolean(
                    effectiveManualRuns?.removal_order.needs_resume ||
                      effectiveManualRuns?.removal_shipment.needs_resume,
                  )
                }
                onResume={async () => {
                  if (effectiveManualRuns?.removal_order.needs_resume) await resumeRemovalOrder();
                  if (effectiveManualRuns?.removal_shipment.needs_resume) await resumeRemovalShipment();
                }}
              />
              {effectiveManualRuns ? (
                <>
                  <ImportResumeNotice
                    run={effectiveManualRuns.removal_order}
                    label="Removal order import"
                  />
                  <ImportResumeNotice
                    run={effectiveManualRuns.removal_shipment}
                    label="Removal shipment import"
                  />
                </>
              ) : null}
              <RuntimeStatsFromView
                enabled={draft.removal_api_sync.enabled}
                runtime={view.runtime.removal_api_sync.recent}
                nextRun={draft.removal_api_sync.enabled ? draftNextRuns.removal : null}
                scheduleSource="Platform settings → removal_api_sync (Vercel daily wake 08:00 UTC on Hobby)"
              />
            </div>
          </section>
          ) : null}

          {apiReportType === "reimbursements" ? (
          <section className="rounded-2xl border border-border bg-card p-4 shadow-sm sm:p-6">
            <div className="flex items-start gap-3">
              <CloudDownload className="h-5 w-5 text-sky-500" aria-hidden />
              <h2 className="text-lg font-semibold text-foreground">Reimbursements API</h2>
            </div>
            {flags ? <FeatureFlagBanner warning={reimbursementFlagWarning(flags)} /> : null}
            <div className="mt-4 space-y-4">
              <EnabledToggle
                checked={draft.reimbursements_api.enabled}
                onChange={(v) =>
                  updateDraft({ reimbursements_api: { ...draft.reimbursements_api, enabled: v } })
                }
                title="Schedule enabled"
                description="Scheduled pulls use the rolling window below."
              />
              <div className="grid gap-4 sm:grid-cols-2">
                <label className="block text-sm">
                  <span className="font-medium text-foreground">Runs per day</span>
                  <input
                    type="number"
                    min={1}
                    max={24}
                    value={draft.reimbursements_api.runs_per_day}
                    onChange={(e) =>
                      updateDraft({
                        reimbursements_api: {
                          ...draft.reimbursements_api,
                          runs_per_day: Number(e.target.value),
                        },
                      })
                    }
                    className={`${responsiveFormInput} mt-1.5`}
                  />
                </label>
                <label className="block text-sm">
                  <span className="font-medium text-foreground">Rolling window (days)</span>
                  <input
                    type="number"
                    min={1}
                    max={90}
                    value={draft.reimbursements_api.rolling_days}
                    onChange={(e) =>
                      updateDraft({
                        reimbursements_api: {
                          ...draft.reimbursements_api,
                          rolling_days: Number(e.target.value),
                        },
                      })
                    }
                    className={`${responsiveFormInput} mt-1.5`}
                  />
                </label>
                <RunTimeField
                  id="reimb-run-times"
                  label="Schedule run times (UTC)"
                  value={formatHoursUtcForInput(draft.reimbursements_api.run_hours_utc)}
                  onChange={(text) =>
                    updateDraft({
                      reimbursements_api: {
                        ...draft.reimbursements_api,
                        run_hours_utc: parseHoursUtcFromInput(text, draft.reimbursements_api.runs_per_day),
                      },
                    })
                  }
                  runsPerDay={draft.reimbursements_api.runs_per_day}
                  formatUtcHoursForDisplay={formatUtcHoursForDisplay}
                  parseHoursUtcFromInput={parseHoursUtcFromInput}
                />
              </div>
              <ManualDateRangeFields
                windowStart={draft.reimbursements_api.manual_window_start ?? manualDates.start}
                windowEnd={draft.reimbursements_api.manual_window_end ?? manualDates.end}
                onStartChange={(v) =>
                  updateDraft({
                    reimbursements_api: { ...draft.reimbursements_api, manual_window_start: v || null },
                  })
                }
                onEndChange={(v) =>
                  updateDraft({
                    reimbursements_api: { ...draft.reimbursements_api, manual_window_end: v || null },
                  })
                }
              />
              <ManualRunButtons
                busy={manualBusy === "reimbursements" || manualBusy === "reimbursements-resume"}
                disabled={!orgId || !storeId || Boolean(flags && reimbursementFlagWarning(flags).disabled)}
                onRun={runReimbursements}
                canResume={Boolean(effectiveManualRuns?.reimbursements_api.needs_resume)}
                onResume={resumeReimbursements}
              />
              {effectiveManualRuns ? (
                <ImportResumeNotice
                  run={effectiveManualRuns.reimbursements_api}
                  label="Reimbursements import (raw_report_uploads)"
                />
              ) : null}
              <RuntimeStatsFromView
                enabled={draft.reimbursements_api.enabled}
                runtime={view.runtime.reimbursements_api}
                nextRun={draft.reimbursements_api.enabled ? draftNextRuns.reimbursements : null}
              />
            </div>
          </section>
          ) : null}

          {apiReportType === "settlement" ? (
          <section className="rounded-2xl border border-border bg-card p-4 shadow-sm sm:p-6">
            <div className="flex items-start gap-3">
              <Receipt className="h-5 w-5 text-emerald-600" aria-hidden />
              <h2 className="text-lg font-semibold text-foreground">Settlement API</h2>
            </div>
            {flags ? <FeatureFlagBanner warning={settlementFlagWarning(flags)} /> : null}
            <div className="mt-4 space-y-4">
              <EnabledToggle
                checked={draft.settlement_api.enabled}
                onChange={(v) => updateDraft({ settlement_api: { ...draft.settlement_api, enabled: v } })}
                title="Schedule enabled"
                description="Scheduled pulls use the rolling window below."
              />
              <div className="grid gap-4 sm:grid-cols-2">
                <label className="block text-sm">
                  <span className="font-medium text-foreground">Runs per day</span>
                  <input
                    type="number"
                    min={1}
                    max={24}
                    value={draft.settlement_api.runs_per_day}
                    onChange={(e) =>
                      updateDraft({
                        settlement_api: { ...draft.settlement_api, runs_per_day: Number(e.target.value) },
                      })
                    }
                    className={`${responsiveFormInput} mt-1.5`}
                  />
                </label>
                <label className="block text-sm">
                  <span className="font-medium text-foreground">Rolling window (days)</span>
                  <input
                    type="number"
                    min={1}
                    max={90}
                    value={draft.settlement_api.rolling_days}
                    onChange={(e) =>
                      updateDraft({
                        settlement_api: { ...draft.settlement_api, rolling_days: Number(e.target.value) },
                      })
                    }
                    className={`${responsiveFormInput} mt-1.5`}
                  />
                </label>
                <RunTimeField
                  id="sett-run-times"
                  label="Schedule run times (UTC)"
                  value={formatHoursUtcForInput(draft.settlement_api.run_hours_utc)}
                  onChange={(text) =>
                    updateDraft({
                      settlement_api: {
                        ...draft.settlement_api,
                        run_hours_utc: parseHoursUtcFromInput(text, draft.settlement_api.runs_per_day),
                      },
                    })
                  }
                  runsPerDay={draft.settlement_api.runs_per_day}
                  formatUtcHoursForDisplay={formatUtcHoursForDisplay}
                  parseHoursUtcFromInput={parseHoursUtcFromInput}
                />
              </div>
              <ManualDateRangeFields
                windowStart={draft.settlement_api.manual_window_start ?? manualDates.start}
                windowEnd={draft.settlement_api.manual_window_end ?? manualDates.end}
                onStartChange={(v) =>
                  updateDraft({ settlement_api: { ...draft.settlement_api, manual_window_start: v || null } })
                }
                onEndChange={(v) =>
                  updateDraft({ settlement_api: { ...draft.settlement_api, manual_window_end: v || null } })
                }
              />
              <ManualRunButtons
                busy={manualBusy === "settlement" || manualBusy === "settlement-resume"}
                disabled={!orgId || !storeId || Boolean(flags && settlementFlagWarning(flags).disabled)}
                onRun={runSettlement}
                canResume={Boolean(effectiveManualRuns?.settlement_api.needs_resume)}
                onResume={resumeSettlement}
              />
              {effectiveManualRuns ? (
                <ImportResumeNotice
                  run={effectiveManualRuns.settlement_api}
                  label="Settlement import (raw_report_uploads)"
                />
              ) : null}
              <RuntimeStatsFromView
                enabled={draft.settlement_api.enabled}
                runtime={view.runtime.settlement_api}
                nextRun={draft.settlement_api.enabled ? draftNextRuns.settlement : null}
              />
            </div>
          </section>
          ) : null}

          {apiReportType === "finances_archive" ? (
          <section className="rounded-2xl border border-border bg-card p-4 shadow-sm sm:p-6">
            <div className="flex items-start gap-3">
              <Archive className="h-5 w-5 text-violet-600" aria-hidden />
              <h2 className="text-lg font-semibold text-foreground">Finances Archive API</h2>
            </div>
            {flags ? <FeatureFlagBanner warning={financesFlagWarning(flags)} /> : null}
            <div className="mt-4 space-y-4">
              <EnabledToggle
                checked={draft.finances_archive_api.enabled}
                onChange={(v) =>
                  updateDraft({ finances_archive_api: { ...draft.finances_archive_api, enabled: v } })
                }
                title="Schedule enabled"
                description="Writes amazon_finances_* archive tables only."
              />
              <div className="grid gap-4 sm:grid-cols-2">
                <label className="block text-sm">
                  <span className="font-medium text-foreground">Runs per day</span>
                  <input
                    type="number"
                    min={1}
                    max={24}
                    value={draft.finances_archive_api.runs_per_day}
                    onChange={(e) =>
                      updateDraft({
                        finances_archive_api: {
                          ...draft.finances_archive_api,
                          runs_per_day: Number(e.target.value),
                        },
                      })
                    }
                    className={`${responsiveFormInput} mt-1.5`}
                  />
                </label>
                <label className="block text-sm">
                  <span className="font-medium text-foreground">Marketplace ID (optional)</span>
                  <input
                    type="text"
                    value={draft.finances_archive_api.marketplace_id ?? ""}
                    onChange={(e) =>
                      updateDraft({
                        finances_archive_api: {
                          ...draft.finances_archive_api,
                          marketplace_id: e.target.value.trim() || null,
                        },
                      })
                    }
                    className={`${responsiveFormInput} mt-1.5 font-mono text-sm`}
                    placeholder="ATVPDKIKX0DER"
                  />
                </label>
                <RunTimeField
                  id="fin-run-times"
                  label="Schedule run times (UTC)"
                  value={formatHoursUtcForInput(draft.finances_archive_api.run_hours_utc)}
                  onChange={(text) =>
                    updateDraft({
                      finances_archive_api: {
                        ...draft.finances_archive_api,
                        run_hours_utc: parseHoursUtcFromInput(
                          text,
                          draft.finances_archive_api.runs_per_day,
                        ),
                      },
                    })
                  }
                  runsPerDay={draft.finances_archive_api.runs_per_day}
                  formatUtcHoursForDisplay={formatUtcHoursForDisplay}
                  parseHoursUtcFromInput={parseHoursUtcFromInput}
                />
              </div>
              <ManualDateRangeFields
                windowStart={draft.finances_archive_api.manual_window_start ?? manualDates.start}
                windowEnd={draft.finances_archive_api.manual_window_end ?? manualDates.end}
                onStartChange={(v) =>
                  updateDraft({
                    finances_archive_api: { ...draft.finances_archive_api, manual_window_start: v || null },
                  })
                }
                onEndChange={(v) =>
                  updateDraft({
                    finances_archive_api: { ...draft.finances_archive_api, manual_window_end: v || null },
                  })
                }
              />
              <ManualRunButtons
                busy={manualBusy === "finances" || manualBusy === "finances-resume"}
                disabled={!orgId || !storeId || Boolean(flags && financesFlagWarning(flags).disabled)}
                onRun={runFinances}
                canResume={Boolean(effectiveManualRuns?.finances_archive_api.needs_resume)}
                onResume={resumeFinances}
              />
              {effectiveManualRuns ? (
                <ImportResumeNotice
                  run={effectiveManualRuns.finances_archive_api}
                  label="Finances archive (amazon_finances_source_runs)"
                />
              ) : null}
              <RuntimeStatsFromView
                enabled={draft.finances_archive_api.enabled}
                runtime={view.runtime.finances_archive_api}
                nextRun={draft.finances_archive_api.enabled ? draftNextRuns.finances : null}
              />
            </div>
          </section>
          ) : null}

          {apiReportType === "older_backfill" ? (
          <section className="rounded-2xl border border-border bg-card p-4 shadow-sm sm:p-6">
            <div className="flex items-start gap-3">
              <History className="h-5 w-5 text-amber-700" aria-hidden />
              <div>
                <h2 className="text-lg font-semibold text-foreground">Older Data Backfill</h2>
                <p className="mt-1 text-sm text-muted-foreground">Slow weekly catch-up for historical removal windows.</p>
              </div>
            </div>
            {flags ? <FeatureFlagBanner warning={removalFlagWarning(flags)} /> : null}
            <div className="mt-4 space-y-4">
              <EnabledToggle
                checked={draft.removal_api_sync.historical_backfill.enabled}
                onChange={(v) =>
                  updateDraft({
                    removal_api_sync: {
                      ...draft.removal_api_sync,
                      historical_backfill: {
                        ...draft.removal_api_sync.historical_backfill,
                        enabled: v,
                      },
                    },
                  })
                }
                title={draft.removal_api_sync.enabled ? "Schedule enabled" : "Schedule enabled (requires removal sync)"}
                description="One small window per week — never full history overnight."
                disabled={!draft.removal_api_sync.enabled}
              />
              <div className="grid gap-4 sm:grid-cols-2">
                <label className="block text-sm">
                  <span className="font-medium text-foreground">Day of week</span>
                  <select
                    value={draft.removal_api_sync.historical_backfill.run_day_of_week}
                    onChange={(e) =>
                      updateDraft({
                        removal_api_sync: {
                          ...draft.removal_api_sync,
                          historical_backfill: {
                            ...draft.removal_api_sync.historical_backfill,
                            run_day_of_week: Number(e.target.value),
                          },
                        },
                      })
                    }
                    className={`${responsiveFormInput} mt-1.5`}
                  >
                    {WEEKDAY_NAMES.map((d, i) => (
                      <option key={d} value={i}>
                        {d}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="block text-sm">
                  <span className="font-medium text-foreground">Schedule time (UTC hour)</span>
                  <input
                    type="number"
                    min={0}
                    max={23}
                    value={draft.removal_api_sync.historical_backfill.run_hour_utc}
                    onChange={(e) =>
                      updateDraft({
                        removal_api_sync: {
                          ...draft.removal_api_sync,
                          historical_backfill: {
                            ...draft.removal_api_sync.historical_backfill,
                            run_hour_utc: Number(e.target.value),
                          },
                        },
                      })
                    }
                    className={`${responsiveFormInput} mt-1.5`}
                  />
                  <span className="mt-1 block text-xs text-muted-foreground">
                    {formatWeeklySlotDisplay(
                      draft.removal_api_sync.historical_backfill.run_day_of_week,
                      draft.removal_api_sync.historical_backfill.run_hour_utc,
                    )}
                  </span>
                </label>
                <label className="block text-sm sm:col-span-2">
                  <span className="font-medium text-foreground">Past data windows</span>
                  <input
                    type="text"
                    value={draft.removal_api_sync.historical_backfill.window_keys.join(", ")}
                    onChange={(e) =>
                      updateDraft({
                        removal_api_sync: {
                          ...draft.removal_api_sync,
                          historical_backfill: {
                            ...draft.removal_api_sync.historical_backfill,
                            window_keys: e.target.value
                              .split(/[,;\s]+/)
                              .map((s) => s.trim())
                              .filter(Boolean),
                          },
                        },
                      })
                    }
                    className={`${responsiveFormInput} mt-1.5`}
                  />
                </label>
              </div>
              <ManualDateRangeFields
                windowStart={manualDates.start}
                windowEnd={manualDates.end}
                onStartChange={() => undefined}
                onEndChange={() => undefined}
                disabled
                hint="Manual backfill uses window keys above; orchestrator apply gates still required."
              />
              <RuntimeStatsFromView
                enabled={draft.removal_api_sync.enabled && draft.removal_api_sync.historical_backfill.enabled}
                runtime={view.runtime.removal_api_sync.historical_backfill}
                nextRun={
                  draft.removal_api_sync.enabled && draft.removal_api_sync.historical_backfill.enabled
                    ? draftNextRuns.historical
                    : null
                }
              />
            </div>
          </section>
          ) : null}

          {savePreview ? (
            <section className="rounded-2xl border border-violet-500/25 bg-violet-500/5 p-4 sm:p-5">
              <div className="flex items-start gap-2">
                <CalendarClock className="mt-0.5 h-5 w-5 text-violet-600 dark:text-violet-400" aria-hidden />
                <div className="min-w-0 flex-1 space-y-2 text-sm text-muted-foreground">
                  <h2 className="text-sm font-semibold text-foreground">Preview before save</h2>
                  <ul className="space-y-1">
                    <li>{savePreview.productUpdate}</li>
                    <li>{savePreview.removalSync}</li>
                    <li>{savePreview.reimbursements}</li>
                    <li>{savePreview.settlement}</li>
                    <li>{savePreview.financesArchive}</li>
                    <li>{savePreview.historicalBackfill}</li>
                  </ul>
                  {!anyEnabled ? (
                    <p className="text-xs">
                      <Clock className="mr-1 inline h-3.5 w-3.5" aria-hidden />
                      All schedules are off — saving will not start cron.
                    </p>
                  ) : null}
                </div>
              </div>
            </section>
          ) : null}

          <div className="flex justify-end border-t border-border pt-4">
            <button
              type="submit"
              disabled={saving || !orgId || !storeId}
              className="inline-flex items-center gap-2 rounded-lg bg-violet-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-violet-700 disabled:opacity-50"
            >
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              Save for this company / store
            </button>
          </div>
        </form>
          </>
        ) : null}
      </div>
    </div>
  );
}
