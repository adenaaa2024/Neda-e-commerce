"use client";

/**
 * Agent / AI developer hand-off (V16.4.15+):
 * The `claim_submissions` table is the submission queue backing store. Poll (or subscribe to)
 * rows where `status = 'ready_to_send'` to implement marketplace filing; update `status`,
 * `submission_id`, and `reimbursement_amount` as the Agent completes work. See server helpers in
 * `claim-submission-actions.ts` and `claim-actions.ts`.
 *
 * Golden Rule (identifiers): use `ReturnIdentifiersColumn` (or the same vertical ASIN/FNSKU/SKU +
 * copy + marketplace actions) everywhere — PDFs mirror links in `claim-pdf-document.tsx`.
 */

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ChangeEvent, MouseEvent } from "react";
import {
  AlertTriangle,
  ArrowUpDown,
  Ban,
  ChevronDown,
  ChevronUp,
  ClipboardList,
  Clock,
  DollarSign,
  CheckCircle2,
  Eye,
  FileDown,
  FileText,
  History as HistoryIcon,
  Inbox,
  Loader2,
  MessageSquare,
  Percent,
  Search,
  Send,
  ShieldAlert,
  TrendingUp,
} from "lucide-react";
import { useTableSortFilter, useSortFilterState, type SortDir } from "../../hooks/use-table-sort-filter";
import type { CoreSettings } from "../settings/workspace-settings-types";
import type { ClaimEvidenceKey } from "./claim-evidence-settings";
import type { PalletRecord, PackageRecord } from "../returns/returns-action-types";
import { DatabaseTag } from "../../components/DatabaseTag";
import { useUserRole } from "../../components/UserRoleContext";
import { ReturnIdentifiersColumn } from "../../components/ReturnIdentifiersColumn";
import { InlineCopy, StatusBadge } from "../returns/_components";
import type { ClaimRecord } from "./claim-actions";
import { bulkUpdateClaimsStatus, getBulkClaimDetails } from "./claim-actions";
import type { ClaimEngineKpis } from "./claim-crm-actions";
import {
  approveClaimSubmission,
  bulkSubmitClaimsToMarketplace,
  generateDailyClaimReports,
  listClaimSubmissions,
  markClaimSubmissionManualSubmit,
  refreshClaimReportSignedUrl,
  type ClaimSubmissionListRow,
} from "./claim-submission-actions";
import { downloadBulkClaimsPdf, enrichBulkPagesWithDefaultEvidence } from "./claim-pdf-download";
import { prepareClaimEnginePdfPages } from "./claim-pdf-batch-actions";
import { ClaimEngineEmptyState } from "@/components/claim-engine/ClaimEngineEmptyState";
import { ClaimEnginePageShell } from "@/components/claim-engine/ClaimEnginePageShell";
import {
  claimEngineStatusClass,
  CLAIM_ENGINE_AMOUNT_CLASS,
  CLAIM_ENGINE_BANNER_ERROR_CLASS,
  CLAIM_ENGINE_BANNER_INFO_CLASS,
  CLAIM_ENGINE_BANNER_SUCCESS_CLASS,
  CLAIM_ENGINE_BANNER_WARNING_CLASS,
  CLAIM_ENGINE_BTN_ACCENT,
  CLAIM_ENGINE_BTN_PRIMARY,
  CLAIM_ENGINE_BTN_SECONDARY,
  CLAIM_ENGINE_BTN_SUCCESS,
  CLAIM_ENGINE_BTN_TRANSCRIPT,
  CLAIM_ENGINE_CARD_CLASS,
  CLAIM_ENGINE_EMPTY_FILTER_CLASS,
  CLAIM_ENGINE_KPI_CARD_CLASS,
  CLAIM_ENGINE_KPI_HINT_CLASS,
  CLAIM_ENGINE_KPI_LABEL_CLASS,
  CLAIM_ENGINE_KPI_VALUE_CLASS,
  CLAIM_ENGINE_MAIN_CLASS,
  CLAIM_ENGINE_META_CLASS,
  CLAIM_ENGINE_MOBILE_CARD_CLASS,
  CLAIM_ENGINE_MOBILE_CARD_TITLE_CLASS,
  CLAIM_ENGINE_PAYOUT_CLASS,
  CLAIM_ENGINE_PROVIDER_CLASS,
  CLAIM_ENGINE_SEARCH_ICON_CLASS,
  CLAIM_ENGINE_SEARCH_INPUT_CLASS,
  CLAIM_ENGINE_SEARCH_WRAP_CLASS,
  CLAIM_ENGINE_SELECT_CLASS,
  CLAIM_ENGINE_TABLE_CARD_HEADER_CLASS,
  CLAIM_ENGINE_TABLE_CARD_ICON_CLASS,
  CLAIM_ENGINE_TABLE_CARD_SUBTITLE_CLASS,
  CLAIM_ENGINE_TABLE_CARD_TITLE_CLASS,
  CLAIM_ENGINE_TABLE_CLASS,
  CLAIM_ENGINE_TYPE_CLASS,
} from "@/components/claim-engine/claim-engine-ui";
import { ClaimDetailModal } from "./ClaimDetailModal";
import { ClaimGenerationModal } from "./ClaimGenerationModal";
import { ClaimHistoryModal } from "./ClaimHistoryModal";

type StoreRow = { id: string; name: string; platform: string };

function formatCurrency(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(value);
}

/** Always two decimals — e.g. requested claim amounts in the submission queue. */
function formatMoneyUsd2(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Number.isFinite(value) ? value : 0);
}

function formatEstimatedUsd(value: unknown): string {
  const n = Number(value);
  return formatMoneyUsd2(Number.isFinite(n) ? n : 0);
}

function formatFinalPayoutUsd(claim: ClaimRecord): string {
  const reimb = claim.reimbursement_amount;
  if (reimb != null && Number(reimb) > 0) return formatCurrency(Number(reimb));
  return formatCurrency(Number(claim.amount) || 0);
}

function formatDate(iso: string): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(iso));
}

function providerLabel(raw: string | null): string {
  if (!raw) return "—";
  const map: Record<string, string> = {
    amazon_sp_api: "Amazon",
    walmart_api: "Walmart",
    ebay_api: "eBay",
  };
  return map[raw] ?? raw;
}

/** UI buckets over existing `claim_submissions.status` — no schema changes. */
const SUBMISSION_QUEUE_STATUSES = new Set(["draft", "ready_to_send"]);
const ACTIVE_CLAIM_STATUSES = new Set(["submitted", "evidence_requested", "investigating"]);
const CLOSED_CLAIM_STATUSES = new Set(["accepted", "rejected", "failed"]);

type ClaimEngineTabId = "submission_queue" | "active" | "closed";

const TAB_COPY: Record<ClaimEngineTabId, { title: string; description: string }> = {
  submission_queue: {
    title: "Submission queue",
    description: "PDF-ready packages awaiting marketplace filing. Status: draft or ready to send.",
  },
  active: {
    title: "Active",
    description: "Filed claims awaiting marketplace response.",
  },
  closed: {
    title: "Closed",
    description: "Resolved claims — accepted, rejected, or failed.",
  },
};

function resolveStore(claim: ClaimRecord, stores: StoreRow[]): StoreRow | null {
  if (!claim.store_id) return null;
  return stores.find((s) => s.id === claim.store_id) ?? null;
}

function storePlatformForSubmission(row: ClaimSubmissionListRow, stores: StoreRow[]): string | null {
  if (!row.store_id) return null;
  return stores.find((s) => s.id === row.store_id)?.platform ?? null;
}

function DataTableSortHeader({
  label,
  colKey,
  sortKey,
  sortDir,
  onToggle,
  align = "left",
}: {
  label: string;
  colKey: string;
  sortKey: string | null;
  sortDir: SortDir;
  onToggle: (k: string) => void;
  align?: "left" | "right";
}) {
  const active = sortKey === colKey;
  return (
    <th
      className={`px-4 py-2.5 text-[11px] font-medium uppercase tracking-wide text-slate-500 ${
        align === "right" ? "text-right" : "text-left"
      }`}
    >
      <button
        type="button"
        className={`inline-flex w-full items-center gap-1 hover:text-slate-800 dark:hover:text-slate-200 ${
          align === "right" ? "justify-end" : "justify-start"
        }`}
        onClick={() => onToggle(colKey)}
      >
        {label}
        {active ? (
          sortDir === "asc" ? (
            <ChevronUp className="h-3 w-3 shrink-0" />
          ) : (
            <ChevronDown className="h-3 w-3 shrink-0" />
          )
        ) : (
          <ArrowUpDown className="h-3 w-3 shrink-0 opacity-40" />
        )}
      </button>
    </th>
  );
}

export function ClaimEngineClient({
  claims: initialClaims,
  claimsError,
  coreSettings,
  stores,
  organizationId,
  claimSubmissions: initialSubmissions,
  submissionsError,
  kpis,
  kpisError,
  defaultClaimEvidence,
  defaultTab = "submission_queue",
}: {
  claims: ClaimRecord[];
  claimsError: string | null;
  coreSettings: CoreSettings;
  stores: StoreRow[];
  organizationId: string;
  claimSubmissions: ClaimSubmissionListRow[];
  submissionsError: string | null;
  kpis: ClaimEngineKpis | null;
  kpisError: string | null;
  defaultClaimEvidence: Record<ClaimEvidenceKey, boolean>;
  defaultTab?: string;
}) {
  const { actorUserId } = useUserRole();
  const [claims, setClaims] = useState<ClaimRecord[]>(initialClaims);
  const [submissions, setSubmissions] = useState<ClaimSubmissionListRow[]>(initialSubmissions);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [modalClaim, setModalClaim] = useState<ClaimRecord | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [toast, setToast] = useState<{ msg: string; kind: "success" | "error" | "warning" } | null>(null);
  const resolvedDefault: ClaimEngineTabId =
    defaultTab === "active" || defaultTab === "closed" || defaultTab === "submission_queue"
      ? defaultTab
      : "submission_queue";
  const [claimEngineTab, setClaimEngineTab] = useState<ClaimEngineTabId>(resolvedDefault);

  useEffect(() => {
    const t: ClaimEngineTabId =
      defaultTab === "active" || defaultTab === "closed" || defaultTab === "submission_queue"
        ? defaultTab
        : "submission_queue";
    setClaimEngineTab(t);
  }, [defaultTab]);
  const [generateBusy, setGenerateBusy] = useState(false);
  const [bulkSubmitBusy, setBulkSubmitBusy] = useState(false);
  const [queueBusyId, setQueueBusyId] = useState<string | null>(null);
  const [approveBusyId, setApproveBusyId] = useState<string | null>(null);
  const [historyClaimId, setHistoryClaimId] = useState<string | null>(null);
  const [detailModalReadOnly, setDetailModalReadOnly] = useState(false);
  /** Submission-queue row selection for PDF batch (takes priority over workspace selection). */
  const [queueSelectedIds, setQueueSelectedIds] = useState<Set<string>>(new Set());
  const [queueBulkPdfBusy, setQueueBulkPdfBusy] = useState(false);
  const [claimGenSubmissionId, setClaimGenSubmissionId] = useState<string | null>(null);
  const [claimGenAmountNote, setClaimGenAmountNote] = useState<string | undefined>(undefined);

  const activeClaimsSf = useSortFilterState();
  const closedClaimsSf = useSortFilterState();
  const queueSf = useSortFilterState();

  useEffect(() => {
    setClaims(initialClaims);
  }, [initialClaims]);

  useEffect(() => {
    setSubmissions(initialSubmissions);
  }, [initialSubmissions]);

  const refreshSubmissions = useCallback(async () => {
    const res = await listClaimSubmissions(organizationId);
    if (res.ok) setSubmissions(res.data);
  }, [organizationId]);

  const submissionQueueRows = useMemo(() => {
    const rank = (status: string) => (status === "ready_to_send" ? 0 : 1);
    return [...submissions].sort((a, b) => {
      const d = rank(a.status) - rank(b.status);
      if (d !== 0) return d;
      return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
    });
  }, [submissions]);

  /** Pre–marketplace filing: draft / ready_to_send only (per product tab). */
  const submissionQueueFiltered = useMemo(
    () => submissionQueueRows.filter((r) => SUBMISSION_QUEUE_STATUSES.has(r.status)),
    [submissionQueueRows],
  );

  const readyToSendCount = useMemo(
    () => submissionQueueFiltered.filter((r) => r.status === "ready_to_send").length,
    [submissionQueueFiltered],
  );

  const activeClaimsFiltered = useMemo(
    () => claims.filter((c) => ACTIVE_CLAIM_STATUSES.has(c.status)),
    [claims],
  );

  const closedClaimsFiltered = useMemo(
    () => claims.filter((c) => CLOSED_CLAIM_STATUSES.has(c.status)),
    [claims],
  );

  const claimColumns = useMemo(
    () => [
      {
        key: "identifiers",
        pickText: (c: ClaimRecord) =>
          [c.item_name, c.asin, c.fnsku, c.sku].filter(Boolean).join(" "),
      },
      {
        key: "store",
        pickText: (c: ClaimRecord) =>
          resolveStore(c, stores)?.platform ?? c.marketplace_provider ?? "",
      },
      { key: "type", pickText: (c: ClaimRecord) => c.claim_type ?? "" },
      { key: "order", pickText: (c: ClaimRecord) => c.amazon_order_id ?? "" },
      { key: "amount", pickText: (c: ClaimRecord) => String(Number(c.amount) || 0) },
      { key: "status", pickText: (c: ClaimRecord) => c.status },
      { key: "date", pickText: (c: ClaimRecord) => c.created_at },
    ],
    [stores],
  );

  const closedClaimColumns = useMemo(
    () => [
      ...claimColumns,
      {
        key: "payout",
        pickText: (c: ClaimRecord) => {
          const r = c.reimbursement_amount;
          if (r != null && Number(r) >= 0) return String(r);
          return String(Number(c.amount) || 0);
        },
      },
    ],
    [claimColumns],
  );

  const queueColumns = useMemo(
    () => [
      {
        key: "identifiers",
        pickText: (row: ClaimSubmissionListRow) =>
          [row.item_name, row.asin, row.fnsku, row.sku].filter(Boolean).join(" "),
      },
      { key: "status", pickText: (row: ClaimSubmissionListRow) => row.status },
      { key: "amount", pickText: (row: ClaimSubmissionListRow) => String(row.claim_amount) },
      { key: "created", pickText: (row: ClaimSubmissionListRow) => row.created_at },
    ],
    [],
  );

  const activeDisplayClaims = useTableSortFilter(activeClaimsFiltered, {
    filter: activeClaimsSf.filter,
    sortKey: activeClaimsSf.sortKey,
    sortDir: activeClaimsSf.sortDir,
    columns: claimColumns,
  });

  const closedDisplayClaims = useTableSortFilter(closedClaimsFiltered, {
    filter: closedClaimsSf.filter,
    sortKey: closedClaimsSf.sortKey,
    sortDir: closedClaimsSf.sortDir,
    columns: closedClaimColumns,
  });

  const submissionQueueDisplay = useTableSortFilter(submissionQueueFiltered, {
    filter: queueSf.filter,
    sortKey: queueSf.sortKey,
    sortDir: queueSf.sortDir,
    columns: queueColumns,
  });

  /**
   * Opens the evidence picker for exactly one selected submission (queue or workspace claim row).
   */
  function handleGeneratePdfReport() {
    if (claimEngineTab === "submission_queue") {
      if (queueSelectedIds.size === 1) {
        const id = [...queueSelectedIds][0];
        const row = submissionQueueFiltered.find((r) => r.id === id);
        setClaimGenAmountNote(row ? String(row.claim_amount ?? "") : undefined);
        setClaimGenSubmissionId(id);
        return;
      }
      showToast(
        "Select exactly one submission in the queue (checkbox) to configure evidence, or use Review evidence on a row.",
        "warning",
      );
      return;
    }
    if (selectedIds.size === 1) {
      const id = [...selectedIds][0];
      const claim = claims.find((c) => c.id === id);
      setClaimGenAmountNote(claim ? String(claim.amount ?? "") : undefined);
      setClaimGenSubmissionId(id);
      return;
    }
    showToast("Select exactly one claim in the Active claims table to configure evidence.", "warning");
  }

  function openClaimGenerationForRow(row: ClaimSubmissionListRow) {
    setClaimGenAmountNote(String(row.claim_amount ?? ""));
    setClaimGenSubmissionId(row.id);
  }

  async function handleEnqueuePipelineReports() {
    setGenerateBusy(true);
    const res = await generateDailyClaimReports(organizationId);
    setGenerateBusy(false);
    if (!res.ok) {
      showToast(res.error ?? "Build queue failed", "error");
      return;
    }
    if (res.generated === 0) {
      showToast("No ready_for_claim returns found for this workspace.", "warning");
    } else {
      showToast(`Successfully added ${res.generated} items to the queue`, "success");
    }
    await refreshSubmissions();
  }

  async function handlePreview(row: ClaimSubmissionListRow) {
    let url = row.preview_url;
    if (!url && row.report_url) {
      setQueueBusyId(row.id);
      const r = await refreshClaimReportSignedUrl(row.report_url);
      setQueueBusyId(null);
      url = r.ok ? (r.url ?? null) : null;
      if (!url) {
        showToast(r.error ?? "Could not open PDF", "error");
        return;
      }
    }
    if (!url) {
      showToast("No PDF path on file.", "error");
      return;
    }
    window.open(url, "_blank", "noopener,noreferrer");
  }

  async function handleManualSubmit(row: ClaimSubmissionListRow) {
    const id = window.prompt("Marketplace case / claim ID (e.g. Amazon or Walmart):", row.submission_id ?? "");
    if (id === null) return;
    setQueueBusyId(row.id);
    const res = await markClaimSubmissionManualSubmit(row.id, id, organizationId, actorUserId);
    setQueueBusyId(null);
    if (res.ok) {
      showToast("Marked as submitted.", "success");
      setSubmissions((prev) =>
        prev.map((s) =>
          s.id === row.id ? { ...s, status: "submitted", submission_id: id.trim() } : s,
        ),
      );
    } else showToast(res.error ?? "Update failed", "error");
  }

  async function handleBulkMarketplace() {
    setBulkSubmitBusy(true);
    const ids = selectedIds.size > 0 ? [...selectedIds] : null;
    const res = await bulkSubmitClaimsToMarketplace(organizationId, ids, actorUserId);
    setBulkSubmitBusy(false);
    if (res.ok && res.count != null) {
      showToast(`Submitted ${res.count} claim(s) to marketplace workflow.`, "success");
      await refreshSubmissions();
    } else showToast(res.error ?? "Bulk submit failed.", "error");
  }

  const showToast = useCallback((msg: string, kind: "success" | "error" | "warning" = "success") => {
    setToast({ msg, kind });
    setTimeout(() => setToast(null), 3200);
  }, []);

  const totalRecoveredDisplay = useMemo(() => {
    if (kpis?.totalRecoveredUsd != null) return kpis.totalRecoveredUsd;
    return claims
      .filter((c) => c.status === "accepted" || c.status === "recovered")
      .reduce((sum, c) => {
        const r = c.reimbursement_amount;
        if (r != null && Number(r) > 0) return sum + Number(r);
        return sum + (Number(c.amount) || 0);
      }, 0);
  }, [kpis, claims]);
  const pendingCount = claims.filter((c) =>
    ["draft", "ready_to_send", "submitted", "pending", "pending_evidence"].includes(c.status),
  ).length;
  const suspiciousCount = claims.filter((c) =>
    ["suspicious", "evidence_requested"].includes(c.status),
  ).length;

  const allSelected =
    activeDisplayClaims.length > 0 && activeDisplayClaims.every((c) => selectedIds.has(c.id));

  useEffect(() => {
    setSelectedIds(new Set());
    setQueueSelectedIds(new Set());
  }, [claimEngineTab]);

  function toggleRow(id: string, e: MouseEvent) {
    e.stopPropagation();
    setSelectedIds((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }

  function toggleAll(e: ChangeEvent<HTMLInputElement>) {
    if (e.target.checked) setSelectedIds(new Set(activeDisplayClaims.map((c) => c.id)));
    else setSelectedIds(new Set());
  }

  function toggleQueueRow(id: string, e: MouseEvent) {
    e.stopPropagation();
    setQueueSelectedIds((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }

  async function handleBulkCancel() {
    const ids = [...selectedIds];
    if (ids.length === 0) return;
    if (!window.confirm(`Cancel ${ids.length} claim(s)?`)) return;
    setBulkBusy(true);
    const res = await bulkUpdateClaimsStatus(ids, "cancelled", organizationId, actorUserId);
    setBulkBusy(false);
    if (res.ok) {
      setClaims((prev) =>
        prev.map((c) => (selectedIds.has(c.id) ? { ...c, status: "cancelled" } : c)),
      );
      setSelectedIds(new Set());
      showToast("Claims cancelled", "success");
    } else showToast(res.error ?? "Bulk cancel failed", "error");
  }

  async function handleBulkPdf() {
    const ids = [...selectedIds];
    if (ids.length === 0) return;
    setBulkBusy(true);
    const res = await getBulkClaimDetails(ids, organizationId);
    setBulkBusy(false);
    if (!res.ok || !res.data.length) {
      showToast(res.error ?? "Could not load claim details", "error");
      return;
    }
    const pages = res.data.map((detail) => {
      const st = resolveStore(detail.claim, stores);
      return {
        storeName: st?.name ?? providerLabel(detail.claim.marketplace_provider),
        storePlatform: st?.platform ?? "amazon",
        detail,
        claimAmountNote: String(detail.claim.amount ?? ""),
        marketplaceClaimIdNote: detail.claim.marketplace_claim_id ?? undefined,
      };
    });
    try {
      const enriched = await enrichBulkPagesWithDefaultEvidence(pages, defaultClaimEvidence);
      await downloadBulkClaimsPdf({ tenant: coreSettings, pages: enriched });
      showToast("Bulk PDF downloaded", "success");
    } catch {
      showToast("Bulk PDF failed", "error");
    }
  }

  async function handlePrepareBulkQueuePdfReport() {
    const ids = [...queueSelectedIds];
    if (ids.length === 0) return;
    setQueueBulkPdfBusy(true);
    try {
      const res = await prepareClaimEnginePdfPages(organizationId, ids);
      if (!res.ok || !res.pages?.length) {
        showToast(res.error ?? "Could not build PDF report", "error");
        return;
      }
      const mapped = res.pages.map((p) => ({
        storeName: p.storeName,
        storePlatform: p.storePlatform,
        detail: p.detail,
        claimAmountNote: p.claimAmountNote,
        marketplaceClaimIdNote: p.marketplaceClaimIdNote,
      }));
      const enriched = await enrichBulkPagesWithDefaultEvidence(mapped, defaultClaimEvidence);
      await downloadBulkClaimsPdf({
        tenant: coreSettings,
        pages: enriched,
        filename: `claims-bulk-report-${Date.now()}.pdf`,
        reportKind: "batch",
      });
      showToast(
        `Prepared PDF with ${res.pagesBuilt ?? res.pages.length} page(s).`,
        "success",
      );
    } catch {
      showToast("Bulk PDF report failed.", "error");
    } finally {
      setQueueBulkPdfBusy(false);
    }
  }

  async function handleApproveClaim(claim: ClaimRecord) {
    if (claim.status === "accepted") return;
    setApproveBusyId(claim.id);
    const res = await approveClaimSubmission(claim.id, organizationId, actorUserId);
    setApproveBusyId(null);
    if (res.ok) {
      setClaims((prev) =>
        prev.map((c) => (c.id === claim.id ? { ...c, status: "accepted" } : c)),
      );
      showToast("Claim approved", "success");
    } else showToast(res.error ?? "Approve failed", "error");
  }

  return (
    <>
      {toast ? (
        <div
          className={`pointer-events-none fixed bottom-6 left-1/2 z-[500] -translate-x-1/2 rounded-full px-4 py-2 text-sm font-semibold shadow-lg ${
            toast.kind === "success"
              ? "bg-emerald-600 text-white"
              : toast.kind === "error"
                ? "bg-rose-600 text-white"
                : "bg-amber-500 text-white"
          }`}
        >
          {toast.msg}
        </div>
      ) : null}

      {claimEngineTab === "submission_queue" && queueSelectedIds.size > 0 ? (
        <div className="pointer-events-auto fixed bottom-20 left-1/2 z-[470] flex w-[min(100vw-2rem,36rem)] max-w-[calc(100vw-2rem)] -translate-x-1/2 flex-col gap-3 rounded-2xl border border-slate-200 bg-white/95 px-4 py-3 shadow-xl backdrop-blur-md dark:border-slate-700 dark:bg-slate-900/95 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-center text-sm font-semibold text-slate-800 dark:text-slate-100 sm:text-left">
            {queueSelectedIds.size} claim{queueSelectedIds.size === 1 ? "" : "s"} selected
          </p>
          <button
            type="button"
            disabled={queueBulkPdfBusy}
            onClick={() => void handlePrepareBulkQueuePdfReport()}
            className={`inline-flex items-center justify-center gap-2 ${CLAIM_ENGINE_BTN_SUCCESS}`}
          >
            {queueBulkPdfBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileDown className="h-4 w-4" />}
            Prepare bulk PDF report
          </button>
        </div>
      ) : null}

      <ClaimGenerationModal
        open={claimGenSubmissionId !== null}
        onClose={() => {
          setClaimGenSubmissionId(null);
          setClaimGenAmountNote(undefined);
        }}
        submissionId={claimGenSubmissionId}
        organizationId={organizationId}
        actorUserId={actorUserId}
        coreSettings={coreSettings}
        stores={stores}
        defaultClaimEvidence={defaultClaimEvidence}
        claimAmountNote={claimGenAmountNote}
        onToast={showToast}
      />

      <ClaimDetailModal
        open={modalClaim !== null}
        onClose={() => {
          setModalClaim(null);
          setDetailModalReadOnly(false);
        }}
        claim={modalClaim}
        readOnly={detailModalReadOnly}
        coreSettings={coreSettings}
        stores={stores}
        organizationId={organizationId}
        actorUserId={actorUserId}
        defaultClaimEvidence={defaultClaimEvidence}
        onToast={showToast}
        onUpdated={() => {
          setModalClaim(null);
          setDetailModalReadOnly(false);
        }}
      />

      <ClaimHistoryModal
        open={historyClaimId !== null}
        onClose={() => setHistoryClaimId(null)}
        claimId={historyClaimId}
        organizationId={organizationId}
        readOnly={claimEngineTab === "closed"}
      />

      <main className={CLAIM_ENGINE_MAIN_CLASS}>
        <ClaimEnginePageShell
          title={TAB_COPY[claimEngineTab].title}
          description={TAB_COPY[claimEngineTab].description}
        >
          {claimEngineTab === "submission_queue" && (kpisError || kpis) ? (
            <section className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-5">
              {kpisError ? (
                <div className={`col-span-full ${CLAIM_ENGINE_BANNER_ERROR_CLASS}`}>
                  KPI data: {kpisError}
                </div>
              ) : kpis ? (
                <>
                  <div className={CLAIM_ENGINE_KPI_CARD_CLASS}>
                    <p className={CLAIM_ENGINE_KPI_LABEL_CLASS}>Active pipeline</p>
                    <p className={CLAIM_ENGINE_KPI_VALUE_CLASS}>{kpis.totalActiveClaims}</p>
                    <p className={CLAIM_ENGINE_KPI_HINT_CLASS}>Not accepted or denied</p>
                  </div>
                  <div className={CLAIM_ENGINE_KPI_CARD_CLASS}>
                    <p className={CLAIM_ENGINE_KPI_LABEL_CLASS}>Claim value</p>
                    <p className={CLAIM_ENGINE_KPI_VALUE_CLASS}>
                      {formatCurrency(kpis.totalClaimValueUsd)}
                    </p>
                  </div>
                  <div className={CLAIM_ENGINE_KPI_CARD_CLASS}>
                    <p className={CLAIM_ENGINE_KPI_LABEL_CLASS}>Projected recovery</p>
                    <p className={CLAIM_ENGINE_KPI_VALUE_CLASS}>
                      {formatCurrency(kpis.projectedRecoveryUsd)}
                    </p>
                  </div>
                  <div className={CLAIM_ENGINE_KPI_CARD_CLASS}>
                    <p className={CLAIM_ENGINE_KPI_LABEL_CLASS}>Success rate</p>
                    <p className={CLAIM_ENGINE_KPI_VALUE_CLASS}>
                      {kpis.successRatePercent.toFixed(1)}%
                    </p>
                  </div>
                  <div className={CLAIM_ENGINE_KPI_CARD_CLASS}>
                    <p className={CLAIM_ENGINE_KPI_LABEL_CLASS}>Pending evidence</p>
                    <p className={CLAIM_ENGINE_KPI_VALUE_CLASS}>{kpis.pendingEvidenceCount}</p>
                  </div>
                </>
              ) : null}
            </section>
          ) : null}

          {claimEngineTab === "submission_queue" ? (
            <section className={CLAIM_ENGINE_CARD_CLASS}>
              <div className={`${CLAIM_ENGINE_TABLE_CARD_HEADER_CLASS} flex-wrap gap-3`}>
                <div>
                  <p className={CLAIM_ENGINE_TABLE_CARD_TITLE_CLASS}>Submission queue</p>
                  <p className={CLAIM_ENGINE_TABLE_CARD_SUBTITLE_CLASS}>
                    Draft / ready to send — not yet filed with the marketplace. Review evidence, preview PDFs, then submit the claim.
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => void handleGeneratePdfReport()}
                    className={`inline-flex items-center gap-2 ${CLAIM_ENGINE_BTN_SUCCESS}`}
                  >
                    <FileText className="h-4 w-4" />
                    Review evidence (PDF)
                  </button>
                  <button
                    type="button"
                    disabled={generateBusy}
                    onClick={() => void handleEnqueuePipelineReports()}
                    className={`inline-flex items-center gap-2 ${CLAIM_ENGINE_BTN_PRIMARY}`}
                  >
                    {generateBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileText className="h-4 w-4" />}
                    Build queue from returns
                  </button>
                  <button
                    type="button"
                    disabled={bulkSubmitBusy}
                    onClick={() => void handleBulkMarketplace()}
                    className={`inline-flex items-center gap-2 ${CLAIM_ENGINE_BTN_SECONDARY}`}
                  >
                    {bulkSubmitBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                    Submit claim to marketplace
                  </button>
                </div>
              </div>
              <div className={`${CLAIM_ENGINE_SEARCH_WRAP_CLASS} flex flex-wrap items-center gap-3`}>
                <div className="relative min-w-[200px] max-w-md flex-1">
                  <Search className={CLAIM_ENGINE_SEARCH_ICON_CLASS} />
                  <input
                    type="search"
                    placeholder="Filter submission queue…"
                    value={queueSf.filter}
                    onChange={(e) => queueSf.setFilter(e.target.value)}
                    className={CLAIM_ENGINE_SEARCH_INPUT_CLASS}
                  />
                </div>
                <div className="flex flex-wrap items-center gap-2 text-[11px]">
                  <span className="font-medium">Sort</span>
                  <select
                    value={queueSf.sortKey ?? ""}
                    onChange={(e) => queueSf.setSortKey(e.target.value || null)}
                    className={CLAIM_ENGINE_SELECT_CLASS}
                  >
                    <option value="">(list order)</option>
                    <option value="identifiers">Identifiers</option>
                    <option value="status">Status</option>
                    <option value="amount">Amount</option>
                    <option value="created">Created</option>
                  </select>
                  <select
                    value={queueSf.sortDir}
                    onChange={(e) => queueSf.setSortDir(e.target.value as SortDir)}
                    className={CLAIM_ENGINE_SELECT_CLASS}
                  >
                    <option value="asc">Asc</option>
                    <option value="desc">Desc</option>
                  </select>
                </div>
                {queueSelectedIds.size > 0 ? (
                  <span className={`text-xs font-semibold ${CLAIM_ENGINE_AMOUNT_CLASS}`}>
                    {queueSelectedIds.size} row(s) selected for PDF
                  </span>
                ) : null}
              </div>
              {submissionsError ? (
                <div className={CLAIM_ENGINE_BANNER_ERROR_CLASS}>{submissionsError}</div>
              ) : null}
              {readyToSendCount > 0 ? (
                <div className={CLAIM_ENGINE_BANNER_INFO_CLASS}>
                  <p className="text-sm font-bold">
                    {readyToSendCount} claim{readyToSendCount === 1 ? "" : "s"} ready to send
                  </p>
                </div>
              ) : null}
              {submissionQueueFiltered.length === 0 ? (
                <div className="p-4">
                  <ClaimEngineEmptyState
                    title="Submission queue is empty"
                    description="Promote claim cases from Cases to create draft or ready-to-send submissions. PDFs attach when workspace auto_generate_pdf_reports is enabled."
                    action={{ href: "/claim-engine/cases", label: "Open cases" }}
                    secondaryAction={{ href: "/returns/claims", label: "Draft pool" }}
                  />
                </div>
              ) : submissionQueueDisplay.length === 0 ? (
                <div className={CLAIM_ENGINE_EMPTY_FILTER_CLASS}>
                  No queue rows match this filter.
                </div>
              ) : (
                <ul className="divide-y">
                  {submissionQueueDisplay.map((row) => (
                    <li
                      key={row.id}
                      className={[
                        "flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-stretch",
                        row.status === "ready_to_send" ? "claim-engine-row--ready" : "",
                      ].join(" ")}
                    >
                      <div className="flex min-w-0 flex-1 gap-3">
                        <div
                          className="flex shrink-0 items-start pt-1"
                          onClick={(e) => toggleQueueRow(row.id, e)}
                        >
                          <input
                            type="checkbox"
                            checked={queueSelectedIds.has(row.id)}
                            readOnly
                            className="pointer-events-none mt-0.5 h-4 w-4 rounded border-slate-300 text-emerald-600"
                            aria-label="Select for PDF batch"
                          />
                        </div>
                        <div
                          className="claim-engine-icon-tile flex h-16 w-14 shrink-0 items-center justify-center"
                          aria-hidden
                        >
                          <FileText className="h-7 w-7" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <ReturnIdentifiersColumn
                            compact
                            itemName={row.item_name}
                            asin={row.asin}
                            fnsku={row.fnsku}
                            sku={row.sku}
                            storePlatform={storePlatformForSubmission(row, stores)}
                            onToast={showToast}
                          />
                          <p className="mt-2 px-3 py-2 text-sm">
                            <span className={`font-semibold ${CLAIM_ENGINE_META_CLASS}`}>Requested amount </span>
                            <span className={`font-bold tabular-nums ${CLAIM_ENGINE_AMOUNT_CLASS}`}>
                              {formatMoneyUsd2(Number(row.claim_amount) || 0)}
                            </span>
                          </p>
                          <p className={`mt-1 text-[10px] ${CLAIM_ENGINE_META_CLASS}`}>
                            {formatDate(row.created_at)}
                            {typeof row.success_probability === "number" && !Number.isNaN(row.success_probability) ? (
                              <span className="ml-2">
                                P(success): {row.success_probability.toFixed(0)}%
                              </span>
                            ) : null}
                          </p>
                        </div>
                      </div>
                      <div className="flex flex-wrap items-center gap-2 sm:justify-end">
                        <span className={claimEngineStatusClass(row.status)}>
                          {row.status.replace(/_/g, " ")}
                        </span>
                        <button
                          type="button"
                          onClick={() => openClaimGenerationForRow(row)}
                          className={`inline-flex items-center gap-1.5 ${CLAIM_ENGINE_BTN_SUCCESS}`}
                        >
                          <FileText className="h-3.5 w-3.5" />
                          Review evidence
                        </button>
                        <button
                          type="button"
                          disabled={queueBusyId === row.id || !row.report_url}
                          onClick={() => void handlePreview(row)}
                          className={`inline-flex items-center gap-1.5 ${CLAIM_ENGINE_BTN_SECONDARY}`}
                        >
                          {queueBusyId === row.id ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <Eye className="h-3.5 w-3.5" />
                          )}
                          Preview
                        </button>
                        <button
                          type="button"
                          disabled={queueBusyId === row.id}
                          onClick={() => void handleManualSubmit(row)}
                          className={`inline-flex items-center gap-1.5 ${CLAIM_ENGINE_BTN_SUCCESS}`}
                        >
                          Submit claim
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          ) : claimEngineTab === "active" ? (
            <>
          {claimsError && (
            <div className={CLAIM_ENGINE_BANNER_ERROR_CLASS}>
              <span className="font-semibold">Data warning:</span> {claimsError}
            </div>
          )}

          <section className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <div className={CLAIM_ENGINE_KPI_CARD_CLASS}>
              <p className={CLAIM_ENGINE_KPI_LABEL_CLASS}>Total recovered</p>
              <p className={CLAIM_ENGINE_KPI_VALUE_CLASS}>{formatCurrency(totalRecoveredDisplay)}</p>
              <p className={CLAIM_ENGINE_KPI_HINT_CLASS}>Reimbursement when recorded, else claim amount</p>
            </div>
            <div className={CLAIM_ENGINE_KPI_CARD_CLASS}>
              <p className={CLAIM_ENGINE_KPI_LABEL_CLASS}>Pending</p>
              <p className={CLAIM_ENGINE_KPI_VALUE_CLASS}>{pendingCount}</p>
              <p className={CLAIM_ENGINE_KPI_HINT_CLASS}>Awaiting marketplace sync</p>
            </div>
            <div className={CLAIM_ENGINE_KPI_CARD_CLASS}>
              <p className={CLAIM_ENGINE_KPI_LABEL_CLASS}>Suspicious</p>
              <p className={CLAIM_ENGINE_KPI_VALUE_CLASS}>{suspiciousCount}</p>
              <p className={CLAIM_ENGINE_KPI_HINT_CLASS}>Flagged by adapter rules</p>
            </div>
          </section>

          {selectedIds.size > 0 && (
            <div className={`${CLAIM_ENGINE_BANNER_INFO_CLASS} flex flex-wrap items-center gap-3`}>
              <span className="text-sm font-semibold">{selectedIds.size} selected</span>
              <button
                type="button"
                disabled={bulkBusy}
                onClick={() => void handleBulkCancel()}
                className={`inline-flex items-center gap-2 ${CLAIM_ENGINE_BTN_SECONDARY}`}
              >
                {bulkBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Ban className="h-4 w-4" />}
                Cancel claims
              </button>
              <button
                type="button"
                disabled={bulkBusy}
                onClick={() => void handleGeneratePdfReport()}
                className={`inline-flex items-center gap-2 ${CLAIM_ENGINE_BTN_SUCCESS}`}
              >
                <FileText className="h-4 w-4" />
                Generate PDF
              </button>
              <button
                type="button"
                disabled={bulkBusy}
                onClick={() => void handleBulkPdf()}
                className={`inline-flex items-center gap-2 ${CLAIM_ENGINE_BTN_PRIMARY}`}
              >
                {bulkBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileDown className="h-4 w-4" />}
                Export bulk claims PDF
              </button>
              <button
                type="button"
                onClick={() => setSelectedIds(new Set())}
                className={`ml-auto text-xs font-medium ${CLAIM_ENGINE_META_CLASS}`}
              >
                Clear selection
              </button>
            </div>
          )}

          <section className={CLAIM_ENGINE_CARD_CLASS}>
            <DatabaseTag table="claim_submissions" />
            <div className={CLAIM_ENGINE_TABLE_CARD_HEADER_CLASS}>
              <div>
                <p className={CLAIM_ENGINE_TABLE_CARD_TITLE_CLASS}>Active claims</p>
                <p className={CLAIM_ENGINE_TABLE_CARD_SUBTITLE_CLASS}>Submitted, in review, or awaiting evidence — includes Case ID and negotiation when available.</p>
              </div>
              <FileText className={CLAIM_ENGINE_TABLE_CARD_ICON_CLASS} />
            </div>
            <div className={CLAIM_ENGINE_SEARCH_WRAP_CLASS}>
              <div className="relative max-w-md">
                <Search className={CLAIM_ENGINE_SEARCH_ICON_CLASS} />
                <input
                  type="search"
                  placeholder="Filter claims (identifiers, order, status…)"
                  value={activeClaimsSf.filter}
                  onChange={(e) => activeClaimsSf.setFilter(e.target.value)}
                  className={CLAIM_ENGINE_SEARCH_INPUT_CLASS}
                />
              </div>
            </div>

            {activeClaimsFiltered.length === 0 ? (
              <div className="p-4">
                <ClaimEngineEmptyState
                  title="No active claims"
                  description="Submissions move here after marketplace filing — statuses submitted, evidence requested, or investigating."
                  action={{ href: "/claim-engine", label: "Submission queue" }}
                  secondaryAction={{ href: "/settings", label: "Adapter settings" }}
                />
              </div>
            ) : activeDisplayClaims.length === 0 ? (
              <div className={CLAIM_ENGINE_EMPTY_FILTER_CLASS}>
                No claims match this filter. Clear the search box to see all rows.
              </div>
            ) : (
              <>
                <div className="hidden overflow-x-auto md:block">
                  <table className={`${CLAIM_ENGINE_TABLE_CLASS} min-w-[960px]`}>
                    <thead>
                      <tr className="border-b">
                        <th className="w-10 px-2 py-2.5" onClick={(e) => e.stopPropagation()}>
                          <input
                            type="checkbox"
                            checked={allSelected}
                            onChange={toggleAll}
                            className="h-4 w-4 rounded border-slate-300 text-sky-500"
                            aria-label="Select all"
                          />
                        </th>
                        <DataTableSortHeader
                          label="Identifiers"
                          colKey="identifiers"
                          sortKey={activeClaimsSf.sortKey}
                          sortDir={activeClaimsSf.sortDir}
                          onToggle={activeClaimsSf.toggleSort}
                        />
                        <DataTableSortHeader
                          label="Store"
                          colKey="store"
                          sortKey={activeClaimsSf.sortKey}
                          sortDir={activeClaimsSf.sortDir}
                          onToggle={activeClaimsSf.toggleSort}
                        />
                        <DataTableSortHeader
                          label="Claim Type"
                          colKey="type"
                          sortKey={activeClaimsSf.sortKey}
                          sortDir={activeClaimsSf.sortDir}
                          onToggle={activeClaimsSf.toggleSort}
                        />
                        <DataTableSortHeader
                          label="Order / Ref"
                          colKey="order"
                          sortKey={activeClaimsSf.sortKey}
                          sortDir={activeClaimsSf.sortDir}
                          onToggle={activeClaimsSf.toggleSort}
                        />
                        <DataTableSortHeader
                          label="Amount"
                          colKey="amount"
                          sortKey={activeClaimsSf.sortKey}
                          sortDir={activeClaimsSf.sortDir}
                          onToggle={activeClaimsSf.toggleSort}
                          align="right"
                        />
                        <DataTableSortHeader
                          label="Status"
                          colKey="status"
                          sortKey={activeClaimsSf.sortKey}
                          sortDir={activeClaimsSf.sortDir}
                          onToggle={activeClaimsSf.toggleSort}
                        />
                        <DataTableSortHeader
                          label="Date"
                          colKey="date"
                          sortKey={activeClaimsSf.sortKey}
                          sortDir={activeClaimsSf.sortDir}
                          onToggle={activeClaimsSf.toggleSort}
                        />
                        <th className="px-4 py-2.5 text-left text-[11px] font-medium uppercase tracking-wide text-slate-500">Case ID</th>
                        <th className="px-4 py-2.5 text-left text-[11px] font-medium uppercase tracking-wide text-slate-500">Negotiation</th>
                        <th className="px-4 py-2.5 text-left text-[11px] font-medium uppercase tracking-wide text-slate-500">History</th>
                        <th className="px-4 py-2.5 text-left text-[11px] font-medium uppercase tracking-wide text-slate-500">Details</th>
                        <th className="px-4 py-2.5 text-left text-[11px] font-medium uppercase tracking-wide text-slate-500">Actions</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {activeDisplayClaims.map((claim) => (
                        <tr key={claim.id} className="transition">
                          <td
                            className="w-10 px-2 py-3"
                            onClick={(e) => toggleRow(claim.id, e)}
                          >
                            <input
                              type="checkbox"
                              checked={selectedIds.has(claim.id)}
                              readOnly
                              className="pointer-events-none h-4 w-4 rounded border-slate-300 text-sky-500"
                              aria-label="Select row"
                            />
                          </td>
                          <td className="px-4 py-3 align-top">
                            <ReturnIdentifiersColumn
                              compact
                              itemName={claim.item_name}
                              asin={claim.asin}
                              fnsku={claim.fnsku}
                              sku={claim.sku}
                              storePlatform={resolveStore(claim, stores)?.platform}
                              onToast={showToast}
                            />
                          </td>
                          <td className="px-4 py-3 align-top">
                            {claim.marketplace_provider ? (
                              <span className={CLAIM_ENGINE_PROVIDER_CLASS}>
                                {providerLabel(claim.marketplace_provider)}
                              </span>
                            ) : (
                              <span className={`text-xs ${CLAIM_ENGINE_META_CLASS}`}>—</span>
                            )}
                          </td>
                          <td className={`${CLAIM_ENGINE_TYPE_CLASS} px-4 py-3 align-top text-xs`}>
                            {claim.claim_type ?? "—"}
                          </td>
                          <td className={`${CLAIM_ENGINE_META_CLASS} px-4 py-3 align-top font-mono text-xs`}>
                            {claim.amazon_order_id ?? "—"}
                          </td>
                          <td className={`${CLAIM_ENGINE_AMOUNT_CLASS} px-4 py-3 align-top text-right text-xs`}>
                            {formatCurrency(Number(claim.amount) || 0)}
                          </td>
                          <td className="px-4 py-3 align-top">
                            <span className={claimEngineStatusClass(claim.status)}>
                              {claim.status.charAt(0).toUpperCase() + claim.status.slice(1)}
                            </span>
                          </td>
                          <td className={`${CLAIM_ENGINE_META_CLASS} px-4 py-3 align-top text-xs`}>
                            {formatDate(claim.created_at)}
                          </td>
                          <td className={`${CLAIM_ENGINE_META_CLASS} px-4 py-3 align-top font-mono text-xs`}>
                            {claim.marketplace_claim_id?.trim() ? claim.marketplace_claim_id : "—"}
                          </td>
                          <td className="px-4 py-3 align-top">
                            <Link
                              href={`/claim-engine/investigation/${claim.id}`}
                              className={CLAIM_ENGINE_BTN_TRANSCRIPT}
                            >
                              <MessageSquare className="h-3.5 w-3.5" />
                              Negotiation
                            </Link>
                          </td>
                          <td className="px-4 py-3 align-top">
                            <button
                              type="button"
                              onClick={() => setHistoryClaimId(claim.id)}
                              className={CLAIM_ENGINE_BTN_SECONDARY}
                            >
                              <HistoryIcon className="h-3.5 w-3.5" />
                              History
                            </button>
                          </td>
                          <td className="px-4 py-3 align-top">
                            <button
                              type="button"
                              onClick={() => {
                                setDetailModalReadOnly(false);
                                setModalClaim(claim);
                              }}
                              className={CLAIM_ENGINE_BTN_ACCENT}
                            >
                              Details
                            </button>
                          </td>
                          <td className="px-4 py-3 align-top" onClick={(e) => e.stopPropagation()}>
                            <button
                              type="button"
                              disabled={approveBusyId === claim.id || claim.status === "accepted"}
                              onClick={() => void handleApproveClaim(claim)}
                              className={CLAIM_ENGINE_BTN_SUCCESS}
                            >
                              {approveBusyId === claim.id ? (
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              ) : (
                                <CheckCircle2 className="h-3.5 w-3.5" />
                              )}
                              Approve
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <div className="space-y-3 p-3 md:hidden">
                  {activeDisplayClaims.map((claim) => (
                    <div key={claim.id} className={CLAIM_ENGINE_MOBILE_CARD_CLASS}>
                      <p className={CLAIM_ENGINE_MOBILE_CARD_TITLE_CLASS}>
                        {claim.item_name?.trim() || "Claim"}
                      </p>
                      <p className={`mt-1 text-xs ${CLAIM_ENGINE_META_CLASS}`}>
                        Case ID:{" "}
                        <span className="font-mono">
                          {claim.marketplace_claim_id?.trim() ? claim.marketplace_claim_id : "—"}
                        </span>
                      </p>
                      <p className={`mt-1 text-xs ${CLAIM_ENGINE_META_CLASS}`}>
                        {formatCurrency(Number(claim.amount) || 0)} ·{" "}
                        <span className="font-medium">{claim.status}</span>
                      </p>
                      <div className="mt-3 flex flex-wrap gap-2">
                        <button
                          type="button"
                          disabled={approveBusyId === claim.id || claim.status === "accepted"}
                          onClick={() => void handleApproveClaim(claim)}
                          className={`inline-flex flex-1 items-center justify-center gap-1 ${CLAIM_ENGINE_BTN_SUCCESS}`}
                        >
                          {approveBusyId === claim.id ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <CheckCircle2 className="h-4 w-4" />
                          )}
                          Approve
                        </button>
                        <Link
                          href={`/claim-engine/investigation/${claim.id}`}
                          className={`inline-flex flex-1 items-center justify-center gap-1 ${CLAIM_ENGINE_BTN_TRANSCRIPT}`}
                        >
                          <MessageSquare className="h-4 w-4" />
                          Negotiation
                        </Link>
                        <button
                          type="button"
                          onClick={() => setHistoryClaimId(claim.id)}
                          className={`inline-flex flex-1 items-center justify-center gap-1 ${CLAIM_ENGINE_BTN_SECONDARY}`}
                        >
                          <HistoryIcon className="h-4 w-4" />
                          History
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setDetailModalReadOnly(false);
                            setModalClaim(claim);
                          }}
                          className={`inline-flex flex-1 items-center justify-center ${CLAIM_ENGINE_BTN_ACCENT}`}
                        >
                          Details
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}
          </section>
            </>
          ) : (
            <>
              {claimsError && (
                <div className={CLAIM_ENGINE_BANNER_ERROR_CLASS}>
                  <span className="font-semibold">Data warning:</span> {claimsError}
                </div>
              )}

              <section className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                <div className={CLAIM_ENGINE_KPI_CARD_CLASS}>
                  <p className={CLAIM_ENGINE_KPI_LABEL_CLASS}>Total recovered</p>
                  <p className={CLAIM_ENGINE_KPI_VALUE_CLASS}>{formatCurrency(totalRecoveredDisplay)}</p>
                </div>
                <div className={CLAIM_ENGINE_KPI_CARD_CLASS}>
                  <p className={CLAIM_ENGINE_KPI_LABEL_CLASS}>Closed count</p>
                  <p className={CLAIM_ENGINE_KPI_VALUE_CLASS}>{closedDisplayClaims.length}</p>
                </div>
                <div className={CLAIM_ENGINE_KPI_CARD_CLASS}>
                  <p className={CLAIM_ENGINE_KPI_LABEL_CLASS}>Suspicious</p>
                  <p className={CLAIM_ENGINE_KPI_VALUE_CLASS}>{suspiciousCount}</p>
                </div>
              </section>

              <section className={CLAIM_ENGINE_CARD_CLASS}>
                <DatabaseTag table="claim_submissions" />
                <div className={CLAIM_ENGINE_TABLE_CARD_HEADER_CLASS}>
                  <div>
                    <p className={CLAIM_ENGINE_TABLE_CARD_TITLE_CLASS}>Closed claims</p>
                    <p className={CLAIM_ENGINE_TABLE_CARD_SUBTITLE_CLASS}>
                      Accepted, denied, or failed — view-only history, transcript, and final payout.
                    </p>
                  </div>
                  <FileText className={CLAIM_ENGINE_TABLE_CARD_ICON_CLASS} />
                </div>
                <div className={CLAIM_ENGINE_SEARCH_WRAP_CLASS}>
                  <div className="relative max-w-md">
                    <Search className={CLAIM_ENGINE_SEARCH_ICON_CLASS} />
                    <input
                      type="search"
                      placeholder="Filter closed claims…"
                      value={closedClaimsSf.filter}
                      onChange={(e) => closedClaimsSf.setFilter(e.target.value)}
                      className={CLAIM_ENGINE_SEARCH_INPUT_CLASS}
                    />
                  </div>
                </div>

                {closedClaimsFiltered.length === 0 ? (
                  <div className="p-4">
                    <ClaimEngineEmptyState
                      title="No closed claims"
                      description="Terminal outcomes — accepted, rejected, or failed — appear here after marketplace resolution."
                      action={{ href: "/claim-engine?tab=active", label: "View active" }}
                      secondaryAction={{ href: "/claim-engine/report-history", label: "Report history" }}
                    />
                  </div>
                ) : closedDisplayClaims.length === 0 ? (
                  <div className={CLAIM_ENGINE_EMPTY_FILTER_CLASS}>
                    No rows match this filter. Clear the search to see all closed claims.
                  </div>
                ) : (
                  <>
                    <div className="hidden overflow-x-auto md:block">
                      <table className={`${CLAIM_ENGINE_TABLE_CLASS} min-w-[1100px]`}>
                        <thead>
                          <tr className="border-b">
                            <DataTableSortHeader
                              label="Identifiers"
                              colKey="identifiers"
                              sortKey={closedClaimsSf.sortKey}
                              sortDir={closedClaimsSf.sortDir}
                              onToggle={closedClaimsSf.toggleSort}
                            />
                            <DataTableSortHeader
                              label="Store"
                              colKey="store"
                              sortKey={closedClaimsSf.sortKey}
                              sortDir={closedClaimsSf.sortDir}
                              onToggle={closedClaimsSf.toggleSort}
                            />
                            <DataTableSortHeader
                              label="Claim Type"
                              colKey="type"
                              sortKey={closedClaimsSf.sortKey}
                              sortDir={closedClaimsSf.sortDir}
                              onToggle={closedClaimsSf.toggleSort}
                            />
                            <DataTableSortHeader
                              label="Order / Ref"
                              colKey="order"
                              sortKey={closedClaimsSf.sortKey}
                              sortDir={closedClaimsSf.sortDir}
                              onToggle={closedClaimsSf.toggleSort}
                            />
                            <DataTableSortHeader
                              label="Amount"
                              colKey="amount"
                              sortKey={closedClaimsSf.sortKey}
                              sortDir={closedClaimsSf.sortDir}
                              onToggle={closedClaimsSf.toggleSort}
                              align="right"
                            />
                            <DataTableSortHeader
                              label="Status"
                              colKey="status"
                              sortKey={closedClaimsSf.sortKey}
                              sortDir={closedClaimsSf.sortDir}
                              onToggle={closedClaimsSf.toggleSort}
                            />
                            <DataTableSortHeader
                              label="Date"
                              colKey="date"
                              sortKey={closedClaimsSf.sortKey}
                              sortDir={closedClaimsSf.sortDir}
                              onToggle={closedClaimsSf.toggleSort}
                            />
                            <DataTableSortHeader
                              label="Final payout"
                              colKey="payout"
                              sortKey={closedClaimsSf.sortKey}
                              sortDir={closedClaimsSf.sortDir}
                              onToggle={closedClaimsSf.toggleSort}
                              align="right"
                            />
                            <th className="px-4 py-2.5 text-left text-[11px] font-medium uppercase tracking-wide text-slate-500">Case ID</th>
                            <th className="px-4 py-2.5 text-left text-[11px] font-medium uppercase tracking-wide text-slate-500">Transcript</th>
                            <th className="px-4 py-2.5 text-left text-[11px] font-medium uppercase tracking-wide text-slate-500">History</th>
                            <th className="px-4 py-2.5 text-left text-[11px] font-medium uppercase tracking-wide text-slate-500">Details</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y">
                          {closedDisplayClaims.map((claim) => (
                            <tr key={claim.id} className="transition">
                              <td className="px-4 py-3.5 align-top">
                                <ReturnIdentifiersColumn
                                  compact
                                  itemName={claim.item_name}
                                  asin={claim.asin}
                                  fnsku={claim.fnsku}
                                  sku={claim.sku}
                                  storePlatform={resolveStore(claim, stores)?.platform}
                                  onToast={showToast}
                                />
                              </td>
                              <td className="px-4 py-3.5 align-top">
                                {claim.marketplace_provider ? (
                                  <span className={CLAIM_ENGINE_PROVIDER_CLASS}>
                                    {providerLabel(claim.marketplace_provider)}
                                  </span>
                                ) : (
                                  <span className={`text-xs ${CLAIM_ENGINE_META_CLASS}`}>—</span>
                                )}
                              </td>
                              <td className={`${CLAIM_ENGINE_TYPE_CLASS} px-4 py-3.5 align-top text-xs`}>
                                {claim.claim_type ?? "—"}
                              </td>
                              <td className={`${CLAIM_ENGINE_META_CLASS} px-4 py-3.5 align-top font-mono text-xs`}>
                                {claim.amazon_order_id ?? "—"}
                              </td>
                              <td className={`${CLAIM_ENGINE_AMOUNT_CLASS} px-4 py-3.5 align-top text-right text-xs`}>
                                {formatCurrency(Number(claim.amount) || 0)}
                              </td>
                              <td className="px-4 py-3.5 align-top">
                                <span className={claimEngineStatusClass(claim.status)}>
                                  {claim.status.charAt(0).toUpperCase() + claim.status.slice(1)}
                                </span>
                              </td>
                              <td className={`${CLAIM_ENGINE_META_CLASS} px-4 py-3.5 align-top text-xs`}>
                                {formatDate(claim.created_at)}
                              </td>
                              <td className={`${CLAIM_ENGINE_PAYOUT_CLASS} px-4 py-3.5 align-top text-right text-xs`}>
                                {formatFinalPayoutUsd(claim)}
                              </td>
                              <td className={`${CLAIM_ENGINE_META_CLASS} px-4 py-3.5 align-top font-mono text-xs`}>
                                {claim.marketplace_claim_id?.trim() ? claim.marketplace_claim_id : "—"}
                              </td>
                              <td className="px-4 py-3.5 align-top">
                                <Link
                                  href={`/claim-engine/investigation/${claim.id}?readonly=1`}
                                  className={CLAIM_ENGINE_BTN_TRANSCRIPT}
                                >
                                  <MessageSquare className="h-3.5 w-3.5" />
                                  Transcript
                                </Link>
                              </td>
                              <td className="px-4 py-3.5 align-top">
                                <button
                                  type="button"
                                  onClick={() => setHistoryClaimId(claim.id)}
                                  className={CLAIM_ENGINE_BTN_SECONDARY}
                                >
                                  <HistoryIcon className="h-3.5 w-3.5" />
                                  History
                                </button>
                              </td>
                              <td className="px-4 py-3.5 align-top">
                                <button
                                  type="button"
                                  onClick={() => {
                                    setDetailModalReadOnly(true);
                                    setModalClaim(claim);
                                  }}
                                  className={CLAIM_ENGINE_BTN_ACCENT}
                                >
                                  Details
                                </button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>

                    <div className="space-y-3 p-3 md:hidden">
                      {closedDisplayClaims.map((claim) => (
                        <div key={claim.id} className={CLAIM_ENGINE_MOBILE_CARD_CLASS}>
                          <p className={CLAIM_ENGINE_MOBILE_CARD_TITLE_CLASS}>
                            {claim.item_name?.trim() || "Claim"}
                          </p>
                          <p className={`mt-1 text-xs ${CLAIM_ENGINE_META_CLASS}`}>
                            Final payout:{" "}
                            <span className={`${CLAIM_ENGINE_PAYOUT_CLASS} font-semibold`}>{formatFinalPayoutUsd(claim)}</span>
                          </p>
                          <p className={`mt-1 text-xs ${CLAIM_ENGINE_META_CLASS}`}>
                            {formatCurrency(Number(claim.amount) || 0)} requested · {claim.status}
                          </p>
                          <div className="mt-3 flex flex-wrap gap-2">
                            <Link
                              href={`/claim-engine/investigation/${claim.id}?readonly=1`}
                              className={`inline-flex flex-1 items-center justify-center gap-1 ${CLAIM_ENGINE_BTN_TRANSCRIPT}`}
                            >
                              <MessageSquare className="h-4 w-4" />
                              Transcript
                            </Link>
                            <button
                              type="button"
                              onClick={() => setHistoryClaimId(claim.id)}
                              className={`inline-flex flex-1 items-center justify-center gap-1 ${CLAIM_ENGINE_BTN_SECONDARY}`}
                            >
                              <HistoryIcon className="h-4 w-4" />
                              History
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                setDetailModalReadOnly(true);
                                setModalClaim(claim);
                              }}
                              className={`inline-flex flex-1 items-center justify-center ${CLAIM_ENGINE_BTN_ACCENT}`}
                            >
                              Details
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </>
                )}
              </section>
            </>
          )}
        </ClaimEnginePageShell>
      </main>
    </>
  );
}
