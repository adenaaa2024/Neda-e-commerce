"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  deriveUtcRunTimesDisplayFromLocal,
  formatHoursUtcForInput,
  formatLocalRunTimesForInput,
  isAnyStoreAutomationScheduleEnabled,
  normalizeStoreAutomationSettings,
  parseHoursUtcFromInput,
  parseLocalRunTimesFromInput,
} from "@/lib/platform-automation-schedule";
import {
  computeSavedScheduleNextRuns,
  inferRemovalRunSource,
  storeAutomationSettingsEqual,
  storeSettingsFromView,
} from "@/lib/platform-automation-saved-status";
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
  drainAutomationManualImportRun,
  featureFlagBlockedMessage,
  isLocalhostDryRunOnly,
  manualRunCompletionMessage,
  manualRunAcceptanceMessage,
  manualRunStateFromResponse,
  pollAutomationRuntimeRefresh,
  postAutomationManualRun,
  removalRuntimeStillEmpty,
} from "@/lib/platform-automation-manual-run-ui";
import type { AutomationRunEnvironment } from "@/lib/platform-automation-settings-types";
import { buildClientEmptyAutomationView } from "@/lib/platform-automation-client-empty-view";
import {
  hobbyRemovalScheduleWarning,
  isAutomationHobbyCronTierClient,
} from "@/lib/platform-automation-run-environment-client";
import {
  EMPTY_AUTOMATION_RUNTIME,
  EMPTY_MANUAL_RUNS,
  EMPTY_MANUAL_RUN_STATE,
  type AutomationCardManualRunState,
  type AutomationScheduleRuntime,
  type StoreAutomationSettings,
  type StoreAutomationSettingsView,
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
  AutomationSavedStatusSummary,
  ManualDateRangeFields,
  ManualRunButtons,
  ManualWindowHelp,
  RollingWindowHelp,
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

const LOAD_SETTINGS_TIMEOUT_MS = 28_000;

const EMPTY_SCOPE_RUNTIME: StoreAutomationSettingsView["runtime"] = {
  product_enrichment: { ...EMPTY_AUTOMATION_RUNTIME },
  removal_api_sync: {
    recent: { ...EMPTY_AUTOMATION_RUNTIME },
    historical_backfill: { ...EMPTY_AUTOMATION_RUNTIME },
  },
  reimbursements_api: { ...EMPTY_AUTOMATION_RUNTIME },
  settlement_api: { ...EMPTY_AUTOMATION_RUNTIME },
  finances_archive_api: { ...EMPTY_AUTOMATION_RUNTIME },
};

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

function mergeManualRunState(
  base: StoreAutomationSettingsView["manual_runs"] | null | undefined,
  key: ManualRunKey,
  override: AutomationCardManualRunState | undefined,
): AutomationCardManualRunState {
  return {
    ...(base?.[key] ?? EMPTY_MANUAL_RUN_STATE),
    ...(override ?? {}),
  };
}

function safeRemovalRecentRuntime(
  view: StoreAutomationSettingsView | null | undefined,
): AutomationScheduleRuntime {
  return (
    view?.runtime?.removal_api_sync?.recent ?? {
      ...EMPTY_AUTOMATION_RUNTIME,
    }
  );
}
function mergeRemovalRuntimeFromManualRuns(
  base: AutomationScheduleRuntime,
  order: AutomationCardManualRunState | undefined,
  shipment: AutomationCardManualRunState | undefined,
): AutomationScheduleRuntime {
  if (base.last_run_at) return base;
  const pick = [order, shipment].find((r) => r?.upload_id || r?.source_run_id);
  if (!pick?.upload_id && !pick?.source_run_id) return base;
  const state = String(pick.state ?? "").toLowerCase();
  let status = base.last_run_status;
  if (status === "never") {
    if (state === "complete") status = "success";
    else if (state === "failed") status = "failed";
    else status = "running";
  }
  return {
    ...base,
    last_run_at: new Date().toISOString(),
    last_run_status: status,
    last_error: pick.last_error ?? base.last_error,
  };
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
  const [scopeLoadError, setScopeLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [manualBusy, setManualBusy] = useState<string | null>(null);
  const [manualRunOverride, setManualRunOverride] = useState<
    Partial<StoreAutomationSettingsView["manual_runs"]>
  >({});
  const [apiReportType, setApiReportType] = useState<AutomationApiReportType>("product_data_update");
  const [runEnvironment, setRunEnvironment] = useState<AutomationRunEnvironment | null>(null);
  const hobbyCronTier = isAutomationHobbyCronTierClient();
  const loadRequestIdRef = useRef(0);

  const formatManualRunMessage = useCallback(
    (result: Extract<Awaited<ReturnType<typeof postAutomationManualRun>>, { ok: true }>) =>
      manualRunAcceptanceMessage(result, {
        localhostQueuedOnly: isBrowserLocalhost() && Boolean(runEnvironment?.manual_run_may_queue_only),
      }),
    [runEnvironment],
  );

  const hydrateDraft = useCallback((v: StoreAutomationSettingsView | null | undefined) => {
    const normalized = normalizeStoreAutomationSettings(
      v
        ? {
            product_enrichment: v.product_enrichment,
            removal_api_sync: v.removal_api_sync,
            reimbursements_api: v.reimbursements_api,
            settlement_api: v.settlement_api,
            finances_archive_api: v.finances_archive_api,
          }
        : {},
    );
    setDraft(normalized);
  }, []);

  const loadSettings = useCallback(
    async (organizationId: string, selectedStoreId: string): Promise<StoreAutomationSettingsView | null> => {
      if (!organizationId || !selectedStoreId) return null;
      const requestId = ++loadRequestIdRef.current;
      setScopeLoading(true);
      setScopeLoadError(null);
      setError(null);
      const fallbackView = buildClientEmptyAutomationView(organizationId, selectedStoreId);
      try {
        const res = await Promise.race([
          getPlatformAutomationSettingsAction({
            organizationId,
            storeId: selectedStoreId,
          }),
          new Promise<never>((_, reject) => {
            setTimeout(
              () =>
                reject(
                  new Error(
                    `Settings load timed out after ${LOAD_SETTINGS_TIMEOUT_MS / 1000}s. The server may be slow or unreachable.`,
                  ),
                ),
              LOAD_SETTINGS_TIMEOUT_MS,
            );
          }),
        ]);
        if (requestId !== loadRequestIdRef.current) return null;
        if (res.accessDenied) {
          setAccessDenied(res.accessDenied);
          return null;
        }
        const nextView = res.view ?? fallbackView;
        if (res.loadError) {
          setScopeLoadError(res.loadError);
        }
        setView(nextView);
        setRunEnvironment(res.runEnvironment);
        hydrateDraft(nextView);
        return nextView;
      } catch (err) {
        if (requestId !== loadRequestIdRef.current) return null;
        const msg = err instanceof Error ? err.message : "Failed to load automation settings.";
        setScopeLoadError(msg);
        setView(fallbackView);
        hydrateDraft(fallbackView);
        return null;
      } finally {
        if (requestId === loadRequestIdRef.current) {
          setScopeLoading(false);
        }
      }
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
    try {
      const now = new Date();
      return {
        product: computeProductEnrichmentNextRun(draft.product_enrichment, now),
        removal: computeRemovalRecentNextRun(draft.removal_api_sync, now),
        historical: computeRemovalHistoricalNextRun(draft.removal_api_sync, now),
        reimbursements: computeApiCardNextRun(draft.reimbursements_api, now),
        settlement: computeApiCardNextRun(draft.settlement_api, now),
        finances: computeApiCardNextRun(draft.finances_archive_api, now),
      };
    } catch (err) {
      console.error("[AutomationApiCenterClient] draftNextRuns", err);
      return null;
    }
  }, [draft]);

  const removalHobbyWarning = useMemo(() => {
    if (!draft || !hobbyCronTier) return null;
    return hobbyRemovalScheduleWarning({
      runs_per_day: draft.removal_api_sync.recent_sync.runs_per_day,
      run_times_local: draft.removal_api_sync.recent_sync.run_times_local,
      run_hours_utc: draft.removal_api_sync.recent_sync.run_hours_utc,
    });
  }, [draft, hobbyCronTier]);

  const removalUtcField = useMemo(() => {
    if (!draft) return { value: "", readOnly: false };
    try {
      const rs = draft.removal_api_sync.recent_sync;
      if (rs.run_times_local.length) {
        return {
          value: deriveUtcRunTimesDisplayFromLocal(rs.timezone, rs.run_times_local),
          readOnly: true,
        };
      }
      return {
        value: formatHoursUtcForInput(rs.run_hours_utc),
        readOnly: false,
      };
    } catch (err) {
      console.error("[AutomationApiCenterClient] removalUtcField", err);
      return { value: "", readOnly: false };
    }
  }, [draft]);

  const savePreview = useMemo(() => {
    if (!draft) return null;
    try {
      return buildStoreAutomationSavePreview(draft);
    } catch (err) {
      console.error("[AutomationApiCenterClient] savePreview", err);
      return null;
    }
  }, [draft]);

  const savedSettings = useMemo(() => storeSettingsFromView(view), [view]);
  const savedNextRuns = useMemo(() => computeSavedScheduleNextRuns(view), [view]);
  const savedPreview = useMemo(() => {
    if (!savedSettings) return null;
    try {
      return buildStoreAutomationSavePreview(savedSettings);
    } catch (err) {
      console.error("[AutomationApiCenterClient] savedPreview", err);
      return null;
    }
  }, [savedSettings]);
  const hasUnsavedChanges = useMemo(() => {
    if (!draft || !savedSettings) return false;
    return !storeAutomationSettingsEqual(draft, savedSettings);
  }, [draft, savedSettings]);
  const removalRunSource = useMemo(() => inferRemovalRunSource(view), [view]);

  const flags = view?.api_flags ?? null;
  const manualDates = draft ? defaultManualDates(draft) : defaultReimbursementWindowDates();

  const effectiveManualRuns = useMemo(() => {
    const base = view?.manual_runs ?? EMPTY_MANUAL_RUNS;
    return {
      product_enrichment: mergeManualRunState(base, "product_enrichment", manualRunOverride.product_enrichment),
      reimbursements_api: mergeManualRunState(base, "reimbursements_api", manualRunOverride.reimbursements_api),
      settlement_api: mergeManualRunState(base, "settlement_api", manualRunOverride.settlement_api),
      finances_archive_api: mergeManualRunState(
        base,
        "finances_archive_api",
        manualRunOverride.finances_archive_api,
      ),
      removal_order: mergeManualRunState(base, "removal_order", manualRunOverride.removal_order),
      removal_shipment: mergeManualRunState(base, "removal_shipment", manualRunOverride.removal_shipment),
    };
  }, [view, manualRunOverride]);

  const effectiveRemovalRuntime = useMemo(() => {
    return mergeRemovalRuntimeFromManualRuns(
      safeRemovalRecentRuntime(view),
      effectiveManualRuns.removal_order,
      effectiveManualRuns.removal_shipment,
    );
  }, [view, effectiveManualRuns]);

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
    const enabled = res.view.removal_api_sync.enabled;
    setMessage(
      enabled
        ? "Settings saved. Schedule is enabled — next run is shown below."
        : "Settings saved for this company and store.",
    );
  }

  async function refreshView(): Promise<StoreAutomationSettingsView | null> {
    if (!orgId || !storeId) return null;
    return loadSettings(orgId, storeId);
  }

  function warnIfRemovalRuntimeEmptyAfterRun(
    latestView: StoreAutomationSettingsView | null,
    executionUploadId: string | null,
    accepted?: boolean,
  ) {
    if (!latestView || executionUploadId || accepted) return;
    if (removalRuntimeStillEmpty(safeRemovalRecentRuntime(latestView))) {
      setError("Run request was accepted but no runtime record was created yet. Refresh in a moment.");
    }
  }

  async function applyManualRunResult(
    key: ManualRunKey,
    url: string,
    body: Record<string, unknown>,
    busyKey: string,
    opts?: { verifyRemovalRuntime?: boolean },
  ): Promise<boolean> {
    if (!orgId || !storeId) return false;
    setManualBusy(busyKey);
    setError(null);
    try {
      const result = await postAutomationManualRun(url, body, {
        localhostDryRunOnly: isLocalhostDryRunOnly(runEnvironment, isBrowserLocalhost()),
      });
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
      setMessage(formatManualRunMessage(result));
      let latestView: StoreAutomationSettingsView | null = null;
      const executionUploadId = patch.upload_id ?? patch.source_run_id;
      if (result.httpStatus === 202 || result.accepted) {
        latestView = await pollAutomationRuntimeRefresh(refreshView);
      } else {
        latestView = await refreshView();
      }
      if (opts?.verifyRemovalRuntime) {
        warnIfRemovalRuntimeEmptyAfterRun(latestView, executionUploadId, result.accepted);
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
    const uploadId = effectiveManualRuns.reimbursements_api?.upload_id;
    await applyManualRunResult("reimbursements_api", AUTOMATION_MANUAL_RUN_ROUTES.reimbursements_run, {
      organization_id: orgId,
      store_id: storeId,
      window_start: w.window_start,
      window_end: w.window_end,
      upload_id: uploadId,
    }, "reimbursements");
  }

  async function resumeReimbursements() {
    const uploadId = effectiveManualRuns.reimbursements_api?.upload_id;
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
    const uploadId = effectiveManualRuns.settlement_api?.upload_id;
    await applyManualRunResult("settlement_api", AUTOMATION_MANUAL_RUN_ROUTES.settlement_run, {
      organization_id: orgId,
      store_id: storeId,
      window_start: w.window_start,
      window_end: w.window_end,
      upload_id: uploadId,
    }, "settlement");
  }

  async function resumeSettlement() {
    const uploadId = effectiveManualRuns.settlement_api?.upload_id;
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
    const sourceRunId = effectiveManualRuns.finances_archive_api?.source_run_id;
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
    const dryRunOnly = isLocalhostDryRunOnly(runEnvironment, isBrowserLocalhost());
    const maxRuntimeSeconds = draft.removal_api_sync.recent_sync.max_runtime_seconds;
    try {
      const messages: string[] = [];
      let executionUploadId: string | null = null;

      const runs = [
        {
          key: "removal_order" as const,
          label: "Removal order",
          runUrl: AUTOMATION_MANUAL_RUN_ROUTES.removal_order_run,
          resumeUrl: AUTOMATION_MANUAL_RUN_ROUTES.removal_order_resume,
        },
        {
          key: "removal_shipment" as const,
          label: "Removal shipment",
          runUrl: AUTOMATION_MANUAL_RUN_ROUTES.removal_shipment_run,
          resumeUrl: AUTOMATION_MANUAL_RUN_ROUTES.removal_shipment_resume,
        },
      ];

      for (const spec of runs) {
        const uploadId = effectiveManualRuns[spec.key]?.upload_id;
        const drain = await drainAutomationManualImportRun({
          runUrl: spec.runUrl,
          resumeUrl: spec.resumeUrl,
          runBody: {
            organization_id: orgId,
            store_id: storeId,
            window_start: win.window_start,
            window_end: win.window_end,
            upload_id: uploadId,
          },
          organizationId: orgId,
          maxRuntimeSeconds: maxRuntimeSeconds,
          localhostDryRunOnly: dryRunOnly,
        });
        if (!drain.ok && !drain.last?.ok) {
          setError(featureFlagBlockedMessage(drain.last?.ok === false ? drain.last.code : undefined, drain.error));
          return;
        }
        const finalResult = drain.ok ? drain.final : drain.last;
        if (!finalResult?.ok) {
          setError(!drain.ok ? drain.error : "Manual run failed.");
          return;
        }
        const patch = manualRunStateFromResponse(finalResult.data);
        executionUploadId = patch.upload_id ?? patch.source_run_id ?? executionUploadId;
        setManualRunOverride((prev) => ({
          ...prev,
          [spec.key]: {
            ...view?.manual_runs[spec.key],
            ...patch,
            needs_resume: drain.ok ? false : Boolean(patch.needs_resume),
            last_error: drain.ok ? null : drain.error,
          },
        }));
        messages.push(manualRunCompletionMessage({ drain, label: spec.label }));
        if (!drain.ok && drain.needs_manual_resume) {
          setMessage(messages.join(" "));
          setError(!drain.ok ? drain.error : null);
          await pollAutomationRuntimeRefresh(refreshView);
          return;
        }
      }

      setMessage(
        dryRunOnly
          ? `${messages.join(" ")} Local dev: queued work may not mirror production cron.`
          : messages.join(" "),
      );
      const latestView = await pollAutomationRuntimeRefresh(refreshView);
      warnIfRemovalRuntimeEmptyAfterRun(latestView, executionUploadId, true);
    } finally {
      setManualBusy(null);
    }
  }

  async function resumeRemovalOrder() {
    const uploadId = effectiveManualRuns.removal_order?.upload_id;
    if (!uploadId) {
      setError("No removal order upload to resume.");
      return;
    }
    await applyManualRunResult(
      "removal_order",
      AUTOMATION_MANUAL_RUN_ROUTES.removal_order_resume,
      { organization_id: orgId, upload_id: uploadId, run_pipeline: true },
      "removal-order-resume",
    );
  }

  async function resumeRemovalShipment() {
    const uploadId = effectiveManualRuns.removal_shipment?.upload_id;
    if (!uploadId) {
      setError("No removal shipment upload to resume.");
      return;
    }
    await applyManualRunResult(
      "removal_shipment",
      AUTOMATION_MANUAL_RUN_ROUTES.removal_shipment_resume,
      { organization_id: orgId, upload_id: uploadId, run_pipeline: true },
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

  const scopeReady = Boolean(draft && draftNextRuns && savedNextRuns && !scopeLoading);
  const savedAnyEnabled = savedSettings ? isAnyStoreAutomationScheduleEnabled(savedSettings) : false;
  const draftAnyEnabled = draft ? isAnyStoreAutomationScheduleEnabled(draft) : false;
  const scopeRuntime = view?.runtime ?? EMPTY_SCOPE_RUNTIME;

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
            <p className="mt-2 text-xs opacity-90">
              If the page shows <span className="font-mono">ChunkLoadError</span> or missing{" "}
              <span className="font-mono">/_next/static/chunks/*.js</span>, stop the dev server, delete{" "}
              <span className="font-mono">.next</span>, restart <span className="font-mono">npm run dev</span>, and
              clear this site&apos;s browser cache (Application → Storage → Clear site data). Stale chunk 404s are a
              cache/build artifact, not an automation settings bug, unless they persist after that reset.
            </p>
          </div>
        ) : null}

        {!scopeReady && !scopeLoading ? (
          <div className="rounded-xl border border-border bg-muted/20 px-4 py-6 text-center text-sm text-muted-foreground">
            Choose a company and store above to load automation settings.
          </div>
        ) : null}

        {scopeLoading ? (
          <div className="rounded-xl border border-border bg-muted/20 px-4 py-6 text-center text-sm text-muted-foreground">
            <Loader2 className="mx-auto mb-2 h-5 w-5 animate-spin" aria-hidden />
            Loading automation settings for the selected company and store…
          </div>
        ) : null}

        {scopeLoadError ? (
          <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-950 dark:text-amber-50">
            <p className="font-medium">Could not load automation settings</p>
            <p className="mt-1 text-xs">{scopeLoadError}</p>
            <p className="mt-2 text-xs opacity-90">
              Showing normalized defaults for this company and store. You can edit and save; runtime status may be
              incomplete until the issue is resolved.
            </p>
            {orgId && storeId ? (
              <button
                type="button"
                className="mt-3 rounded-lg border border-amber-600/40 bg-background px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted"
                onClick={() => void loadSettings(orgId, storeId)}
                disabled={scopeLoading}
              >
                Retry
              </button>
            ) : null}
          </div>
        ) : null}

        {scopeReady && draft && draftNextRuns && savedNextRuns && savedSettings ? (
          <>
        {!savedAnyEnabled ? (
          <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-950 dark:text-amber-50">
            <div className="flex gap-2">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              <div className="space-y-1">
                <p className="font-medium">Saved schedules are off for this company / store</p>
                <DryRunNote>
                  Enable a schedule below and save to start cron. Manual runs call existing import API routes
                  without changing saved schedule state.
                </DryRunNote>
              </div>
            </div>
          </div>
        ) : null}

        <AutomationSavedStatusSummary
          orgId={orgId}
          storeId={storeId}
          removalEnabled={savedSettings.removal_api_sync.enabled}
          removalNextRun={savedNextRuns.removal}
          removalLastRun={effectiveRemovalRuntime.last_run_at}
          removalLastSuccess={view?.removal_api_sync.cron_runtime?.last_success_at ?? null}
          removalRunSource={removalRunSource}
          removalStatus={effectiveRemovalRuntime.last_run_status}
          productEnabled={savedSettings.product_enrichment.enabled}
          reimbursementsEnabled={savedSettings.reimbursements_api.enabled}
          settlementEnabled={savedSettings.settlement_api.enabled}
          financesEnabled={savedSettings.finances_archive_api.enabled}
          hasUnsavedChanges={hasUnsavedChanges}
          updatedAt={view?.updated_at ?? null}
        />

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
                savedEnabled={savedSettings.product_enrichment.enabled}
                runtime={scopeRuntime.product_enrichment}
                nextRun={savedNextRuns.product}
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
                      if (hobbyCronTier && raw > 1) {
                        setMessage("Runs per day corrected to 1 for Vercel Hobby.");
                      }
                      const runs = hobbyCronTier ? 1 : raw;
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
                  <RollingWindowHelp />
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
                  label={
                    removalUtcField.readOnly
                      ? "Derived UTC (from local run times)"
                      : "Schedule run times (UTC fallback)"
                  }
                  value={removalUtcField.value}
                  readOnly={removalUtcField.readOnly}
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
                  hint={
                    removalUtcField.readOnly
                      ? `Computed from ${draft.removal_api_sync.recent_sync.timezone} local slots (includes minutes; not the legacy hour-only fallback).`
                      : undefined
                  }
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
                      if (hobbyCronTier && e.target.value.includes(",")) {
                        setMessage("Only one local run time is kept on Vercel Hobby.");
                      }
                      updateDraft({
                        removal_api_sync: {
                          ...draft.removal_api_sync,
                          recent_sync: {
                            ...draft.removal_api_sync.recent_sync,
                            run_times_local: parsed,
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
                hint={<ManualWindowHelp />}
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
                    effectiveManualRuns.removal_order?.needs_resume ||
                      effectiveManualRuns.removal_shipment?.needs_resume,
                  )
                }
                onResume={async () => {
                  if (effectiveManualRuns.removal_order?.needs_resume) await resumeRemovalOrder();
                  if (effectiveManualRuns.removal_shipment?.needs_resume) await resumeRemovalShipment();
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
                savedEnabled={savedSettings.removal_api_sync.enabled}
                runtime={effectiveRemovalRuntime}
                nextRun={savedNextRuns.removal}
                scheduleSource="Platform settings → removal_api_sync (Vercel daily wake 06:30 UTC on Hobby)"
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
                  <RollingWindowHelp />
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
                canResume={Boolean(effectiveManualRuns.reimbursements_api?.needs_resume)}
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
                savedEnabled={savedSettings.reimbursements_api.enabled}
                runtime={scopeRuntime.reimbursements_api}
                nextRun={savedNextRuns.reimbursements}
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
                  <RollingWindowHelp />
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
                canResume={Boolean(effectiveManualRuns.settlement_api?.needs_resume)}
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
                savedEnabled={savedSettings.settlement_api.enabled}
                runtime={scopeRuntime.settlement_api}
                nextRun={savedNextRuns.settlement}
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
                canResume={Boolean(effectiveManualRuns.finances_archive_api?.needs_resume)}
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
                savedEnabled={savedSettings.finances_archive_api.enabled}
                runtime={scopeRuntime.finances_archive_api}
                nextRun={savedNextRuns.finances}
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
                enabled={
                  draft.removal_api_sync.enabled && draft.removal_api_sync.historical_backfill.enabled
                }
                savedEnabled={
                  savedSettings.removal_api_sync.enabled &&
                  savedSettings.removal_api_sync.historical_backfill.enabled
                }
                runtime={scopeRuntime.removal_api_sync.historical_backfill}
                nextRun={savedNextRuns.historical}
              />
            </div>
          </section>
          ) : null}

          {savedPreview || savePreview ? (
            <section className="rounded-2xl border border-violet-500/25 bg-violet-500/5 p-4 sm:p-5">
              <div className="flex items-start gap-2">
                <CalendarClock className="mt-0.5 h-5 w-5 text-violet-600 dark:text-violet-400" aria-hidden />
                <div className="min-w-0 flex-1 space-y-4 text-sm text-muted-foreground">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="text-sm font-semibold text-foreground">Preview before save</h2>
                    {hasUnsavedChanges ? (
                      <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-xs font-medium text-amber-900 dark:text-amber-100">
                        Unsaved changes
                      </span>
                    ) : (
                      <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 text-xs font-medium text-emerald-900 dark:text-emerald-100">
                        Form matches saved settings
                      </span>
                    )}
                  </div>
                  {savedPreview ? (
                    <div>
                      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                        Current saved schedule
                      </p>
                      <ul className="mt-1 space-y-1">
                        <li>{savedPreview.productUpdate}</li>
                        <li>{savedPreview.removalSync}</li>
                        <li>{savedPreview.reimbursements}</li>
                        <li>{savedPreview.settlement}</li>
                        <li>{savedPreview.financesArchive}</li>
                        <li>{savedPreview.historicalBackfill}</li>
                      </ul>
                      {!savedAnyEnabled ? (
                        <p className="mt-2 text-xs">
                          <Clock className="mr-1 inline h-3.5 w-3.5" aria-hidden />
                          Saved schedules are off — cron will not run until you enable and save.
                        </p>
                      ) : null}
                    </div>
                  ) : null}
                  {hasUnsavedChanges && savePreview ? (
                    <div className="rounded-lg border border-violet-500/20 bg-background/60 p-3">
                      <p className="text-xs font-medium uppercase tracking-wide text-violet-800 dark:text-violet-200">
                        If you save (unsaved form changes)
                      </p>
                      <ul className="mt-1 space-y-1">
                        <li>{savePreview.productUpdate}</li>
                        <li>{savePreview.removalSync}</li>
                        <li>{savePreview.reimbursements}</li>
                        <li>{savePreview.settlement}</li>
                        <li>{savePreview.financesArchive}</li>
                        <li>{savePreview.historicalBackfill}</li>
                      </ul>
                      {!draftAnyEnabled ? (
                        <p className="mt-2 text-xs">
                          <Clock className="mr-1 inline h-3.5 w-3.5" aria-hidden />
                          After save, all schedules would be off — cron would not start.
                        </p>
                      ) : null}
                    </div>
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
