"use client";

import React, { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import axios, { AxiosError } from "axios";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useUserRole } from "../../../components/UserRoleContext";
import { useRbacPermissions } from "../../../hooks/useRbacPermissions";
import {
  assignPimUploadToStore,
  clearStalePimUploadsForStore,
  deletePimImportUploads,
  detachConflictingImapRows,
  fetchPimImportPreviewSnapshot,
  findActivePimImportBySha,
  findLatestActivePimUpload,
  findResumablePimProductMasterSession,
  getPimImportSyncDiagnostics,
  listPimImportSessions,
  getPimImportFileProcessingMetrics,
  pimPriceBackfillStep,
  retryPimImportPreviewSession,
  type PimImportSessionListRow,
  type PimSuggestedActiveImport,
} from "./pim-import-actions";
import { pimUiMayRunPriceBackfill } from "../../../lib/pim-import-history";
import {
  getPimIntegrationsSummary,
  getPimManualProductFormDefaults,
  type PimIntegrationsSummary,
  type PimStoreOption,
} from "./pim-actions";
import {
  AlertTriangle,
  Ban,
  Building2,
  CheckCircle2,
  ChevronDown,
  Cloud,
  Copy,
  FileSpreadsheet,
  Globe2,
  LayoutGrid,
  Link2,
  Loader2,
  Package,
  Plug,
  RefreshCw,
  Scissors,
  Sparkles,
  Split,
  Table2,
  Tag,
  UploadCloud,
  Bug,
  X,
} from "lucide-react";
import { PimCatalogHub } from "./pim/PimCatalogHub";
import { PimHelpNote } from "./pim/PimHelpNote";

function etlApiBase(): string {
  const raw = (process.env.NEXT_PUBLIC_ETL_API_ORIGIN || "").trim().replace(/\/$/, "");
  return raw || "http://127.0.0.1:8000";
}

/** Legacy single-request `/etl/seed-products` (still available server-side). */
const PIM_SEED_PREVIEW_TIMEOUT_MS = 180_000;
const PIM_SEED_APPLY_TIMEOUT_MS = 300_000;
/** Must be ≥ server ETL timeout (`lib/pim-import-etl-server.ts`) so the client does not abort first. */
const PIM_IMPORT_BROWSER_STEP_MS = 125_000;
const PIM_UPLOAD_CHUNK_BYTES = 4 * 1024 * 1024;

async function sha256HexFromFile(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  const hash = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function postDashboardPimImport(
  path: string,
  body: unknown,
): Promise<{ ok: boolean; status: number; data: unknown }> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), PIM_IMPORT_BROWSER_STEP_MS);
  try {
    const res = await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    const data = await res.json().catch(() => null);
    return { ok: res.ok, status: res.status, data };
  } finally {
    clearTimeout(t);
  }
}

type TabId = "catalog" | "import" | "integrations";

type ImportPhase = "idle" | "selected" | "uploading" | "preview_ready" | "success" | "error";

/** ETL `/etl/seed-products` preview payload (`quality` object). */
type PimCatalogSeedQuality = {
  rows_total?: number;
  dirty_rows?: number;
  dirty_rate?: number;
  max_dirty_rate?: number;
  apply_blocked_by_dirty_rate?: boolean;
  blocked_new_without_seller_sku?: number;
  products_would_create?: number;
  products_would_update?: number;
  vendors_would_create?: number;
  vendors_reused?: number;
  categories_would_create?: number;
  categories_reused?: number;
  prices_would_insert?: number;
  skipped_no_identity?: number;
  skipped_ambiguous?: number;
  skipped_dirty_row?: number;
  invalid_price_rows?: number;
  preview_errors?: string[];
  rejected_sample?: { message: string; row?: string }[];
  accepted_sample?: unknown[];
  rows_accepted_estimate?: number;
  fields_trimmed?: number;
  multi_identifier_cells_split?: number;
  /** Individual cleaned identifier values (SKU/ASIN/FNSKU/UPC tokens). */
  identifier_tokens_accepted?: number;
  /** @deprecated same as identifier_tokens_accepted (older previews). */
  identifier_tokens_created?: number;
  identifier_tokens_rejected?: number;
  duplicate_identifier_tokens_collapsed?: number;
  ambiguous_multi_identifier_rows?: number;
  identifier_map_rows_would_insert?: number;
  identifier_map_rows_would_update?: number;
  identifier_rows_would_insert?: number;
  identifier_rows_would_update?: number;
  duplicates_reused?: number;
  existing_products_matched?: number;
  ambiguous_matches?: number;
  would_create_products?: number;
  would_update_products?: number;
  metadata_attributes_detected?: number;
  rows_skipped?: number;
  ambiguous_rows?: number;
  identifier_map_conflicts_preview?: number;
  /** PIM Product Master chunked preview — multi-SKU rows unified when safe. */
  multi_identifier_rows_allowed?: number;
  multi_identifier_rows_conflicting?: number;
  canonical_products_from_multi_id_rows?: number;
  identifier_tokens_attached?: number;
  conflict_rows_blocked?: number;
  apply_blocked_by_conflicts?: boolean;
  already_complete?: number;
  prices_skipped_duplicate?: number;
  category_import_debug?: Record<string, unknown> | null;
  /** Structured per-row conflict records for the conflict diagnosis panel. */
  conflict_detail?: Array<{
    row: string;
    sku: string;
    asin: string;
    fnsku: string;
    upc: string;
    product_name: string;
    resolved_pid: string | null;
    conflict_pids: string[];
    reason_source: "products" | "imap" | "both";
    recommended: string;
  }>;
};

/** Accepts ETL `preview_quality` (rows_total) or persisted public slice (rows_scanned). */
function normalizePimPreviewQuality(pq: unknown): PimCatalogSeedQuality | null {
  if (!pq || typeof pq !== "object" || Array.isArray(pq)) return null;
  const o = pq as unknown as Record<string, unknown>;
  const rt =
    typeof o.rows_total === "number"
      ? o.rows_total
      : typeof o.rows_scanned === "number"
        ? o.rows_scanned
        : undefined;
  if (typeof rt !== "number") return null;
  if (typeof o.rows_total === "number") return o as PimCatalogSeedQuality;
  return { ...o, rows_total: rt } as PimCatalogSeedQuality;
}

type SeedProductsMetrics = {
  rows_processed?: number;
  sheets_processed?: number;
  rows_per_sheet?: Record<string, number>;
  vendors_created: number;
  vendors_reused?: number;
  categories_created?: number;
  categories_reused?: number;
  products_created: number;
  products_updated?: number;
  identifiers_created?: number;
  identifiers_updated?: number;
  prices_inserted?: number;
  prices_skipped_duplicate?: number;
  products_enriched_by_amazon: number;
  skipped_no_identity?: number;
  skipped_ambiguous?: number;
  errors?: string[];
  reconciliation?: Record<string, unknown>;
  /** Legacy ETL response (pre store-scoped PIM metrics). */
  skus_mapped?: number;
  skipped_garbage?: number;
  fields_trimmed?: number;
  multi_identifier_cells_split?: number;
  identifier_tokens_accepted?: number;
  identifier_tokens_created?: number;
  identifier_tokens_rejected?: number;
  duplicate_identifier_tokens_collapsed?: number;
  ambiguous_multi_identifier_rows?: number;
};

type SeedProductsResponse = {
  status: string;
  message: string;
  stage?: string;
  metrics?: SeedProductsMetrics;
  quality?: PimCatalogSeedQuality;
  mode?: string;
  mapping?: Record<string, string>;
  mapping_source?: string;
  seed_session_id?: string | null;
  delimiter_detected?: string | null;
  delimiter_uncertain?: boolean;
  errors?: string[];
  accepted_sample?: unknown[];
  rejected_sample?: { message: string }[];
};

type PimPreviewStepResponse = {
  ok?: boolean;
  done?: boolean;
  terminal?: boolean;
  status?: string;
  import_job_id?: string;
  last_error?: string;
  preview_quality?: PimCatalogSeedQuality;
  quality?: Record<string, unknown>;
  preview_metrics?: Record<string, unknown>;
  mapping?: Record<string, string>;
  mapping_source?: string;
  seed_session_id?: string | null;
  selected_sheets?: string[];
  ignored_sheets?: unknown[];
  samples?: { accepted?: unknown[]; rejected?: unknown[] };
  errors?: string[];
  progress_pct?: number;
  stage_label?: string;
  lifecycle?: string;
  error?: string;
  cached?: boolean;
  preview_progress?: Record<string, unknown>;
  /** Persisted row cursor after a chunk (diagnostic hint to ETL). */
  next_cursor?: number;
  retryable?: boolean;
};

type PreviewDiag = {
  jobId: string;
  stage: string;
  raw: string;
  route?: string;
  job_status?: string;
  last_error?: string | null;
  preview_progress?: Record<string, unknown>;
  /** Which dashboard→ETL flow produced this snapshot (for View debug). */
  flow?: "preview" | "apply";
  upload_row_id?: string | null;
  report_type?: string | null;
  row_status?: string | null;
  preview_status?: string | null;
  lifecycle?: string | null;
  import_store_id?: string | null;
  content_sha256?: string | null;
  updated_at?: string | null;
  category_import_debug?: unknown;
  ui_restore_note?: string | null;
};

function formatPreviewProgressLine(pp: Record<string, unknown> | undefined | null): string | null {
  if (!pp || typeof pp !== "object" || Array.isArray(pp)) return null;
  const n = (k: string) => (typeof pp[k] === "number" && Number.isFinite(pp[k] as number) ? (pp[k] as number) : null);
  const s = (k: string) => (typeof pp[k] === "string" && (pp[k] as string).trim() ? (pp[k] as string).trim() : null);
  const pr = n("parsed_rows");
  const mr = n("mapped_rows");
  const vr = n("validated_rows");
  const rr = n("resolved_rows");
  const tot = n("total_rows");
  const pct = n("percent");
  const step = s("current_step");
  const hb = s("last_heartbeat");
  const parts: string[] = [];
  if (pr != null || mr != null || vr != null || rr != null) {
    parts.push(
      `parsed ${pr ?? "—"} · mapped ${mr ?? "—"} · validated ${vr ?? "—"} · resolved ${rr ?? "—"}` +
        (tot != null ? ` / ${tot} total` : ""),
    );
  }
  if (pct != null) parts.push(`${pct}%`);
  if (step) parts.push(step.replace(/_/g, " "));
  if (hb) parts.push(`hb ${hb}`);
  return parts.length ? parts.join(" · ") : null;
}

type PimApplyStepResponse = {
  ok?: boolean;
  done?: boolean;
  error?: string;
  last_error?: string;
  message?: string;
  status?: string;
  metrics?: SeedProductsMetrics;
  metrics_partial?: SeedProductsMetrics;
  progress_pct?: number;
  stage_label?: string;
  preview_progress?: Record<string, unknown>;
  user_message?: string;
  apply_row_cursor?: number;
  apply_row_goal?: number;
  apply_chunk_index?: number;
  apply_chunks_estimate?: number | null;
  apply_failed_at_row?: number;
  apply_retry_chunk?: number;
  retryable?: boolean;
};

function pimApplyStepUserFacingMessage(d: PimApplyStepResponse, httpStatus: number): string {
  if (typeof d.user_message === "string" && d.user_message.trim()) return d.user_message.trim();
  const um =
    typeof d.last_error === "string"
      ? d.last_error.trim()
      : typeof d.message === "string"
        ? d.message.trim()
        : typeof d.error === "string"
          ? d.error.trim()
          : "";
  if (um) {
    const stage =
      typeof d.stage_label === "string" && d.stage_label.trim()
        ? d.stage_label.replace(/_/g, " ")
        : "";
    let geo = "";
    if (typeof d.apply_failed_at_row === "number") {
      geo = `Paused at row ${d.apply_failed_at_row}`;
      if (typeof d.apply_retry_chunk === "number") {
        geo += ` · retry chunk: ${d.apply_retry_chunk} rows`;
      }
    } else if (typeof d.apply_row_cursor === "number") {
      geo =
        typeof d.apply_row_goal === "number" && d.apply_row_goal > 0
          ? `${d.apply_row_cursor.toLocaleString()} / ~${d.apply_row_goal.toLocaleString()} rows`
          : `${d.apply_row_cursor.toLocaleString()} rows processed`;
      if (typeof d.apply_chunk_index === "number") {
        geo +=
          typeof d.apply_chunks_estimate === "number" && d.apply_chunks_estimate > 0
            ? ` · chunk ${d.apply_chunk_index}/${d.apply_chunks_estimate}`
            : ` · chunk ${d.apply_chunk_index}`;
      }
    }
    const prefix = [stage && `Stage: ${stage}`, geo].filter(Boolean).join(" · ");
    return prefix ? `${prefix}. ${um}` : um;
  }
  return `Import step failed (HTTP ${httpStatus}).`;
}

function formatResponseDetail(data: { detail?: unknown; message?: unknown } | undefined): string | undefined {
  const d = data?.detail;
  if (typeof d === "string") return d;
  if (Array.isArray(d)) {
    const parts = d.map((item) => {
      if (item && typeof item === "object" && "msg" in item) {
        return String((item as { msg?: string }).msg ?? JSON.stringify(item));
      }
      return typeof item === "string" ? item : JSON.stringify(item);
    });
    return parts.join("; ").slice(0, 2000);
  }
  if (d != null && typeof d === "object") return JSON.stringify(d).slice(0, 2000);
  const m = data?.message;
  if (typeof m === "string") return m;
  return undefined;
}

function axiosMessage(error: unknown, fallback: string): string {
  const err = error as AxiosError<{ detail?: unknown; message?: unknown }>;
  return formatResponseDetail(err.response?.data) ?? err.message ?? fallback;
}

async function uploadLocalFileToRawReportChunks(uploadId: string, file: File): Promise<void> {
  const totalParts = Math.max(1, Math.ceil(file.size / PIM_UPLOAD_CHUNK_BYTES));
  const ext = file.name.split(".").pop() ?? "csv";
  for (let i = 0; i < totalParts; i++) {
    const start = i * PIM_UPLOAD_CHUNK_BYTES;
    const blob = file.slice(start, Math.min(start + PIM_UPLOAD_CHUNK_BYTES, file.size));
    const form = new FormData();
    form.append("upload_id", uploadId);
    form.append("part_index", String(i));
    form.append("total_parts", String(totalParts));
    form.append("total_bytes", String(file.size));
    form.append("file_extension", ext);
    form.append("file", blob, file.name);
    const res = await fetch("/api/settings/imports/chunk", { method: "POST", body: form });
    if (!res.ok) {
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(typeof j.error === "string" ? j.error : `Chunk upload failed (${res.status})`);
    }
  }
}

function looksLikeGoogleSheetsPermissionError(raw: string | null | undefined): boolean {
  if (!raw) return false;
  const low = raw.toLowerCase();
  return low.includes("403") || low.includes("permission denied") || low.includes("forbidden");
}

function humanizeGoogleSheetsError(raw: string): string {
  const t = raw.trim();
  const low = t.toLowerCase();
  if (!t) return "Google Sheets could not run.";
  if (low.includes("google sheet id not found") || (low.includes("google_sheet_id") && low.includes("configure"))) {
    return "Spreadsheet ID is not set for this workspace. Add it under Settings → Catalog & Google Sheets, then try again.";
  }
  if (low.includes("service account") || (low.includes("google_sheets_api") && low.includes("missing"))) {
    return "Google service account key is missing. Paste the JSON in Settings → Catalog & Google Sheets.";
  }
  if (low.includes("403") || low.includes("permission denied") || low.includes("forbidden")) {
    return "Google returned permission denied. Share the spreadsheet with the service account email from your JSON key.";
  }
  if (low.includes("404") || low.includes("not found")) {
    return "Spreadsheet or tab was not found. Check the spreadsheet ID and that the sheet exists.";
  }
  return "Google Sheets request failed. Verify spreadsheet ID and service account, then try again.";
}

function CatalogSheetsSettingsLink() {
  const { canSeeSettings } = useRbacPermissions();
  if (!canSeeSettings) {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-lg border border-dashed border-border px-3 py-1.5 text-xs font-medium text-muted-foreground">
        <Plug className="h-3.5 w-3.5 shrink-0" aria-hidden />
        Catalog and Google Sheets — contact an admin for Settings access
      </span>
    );
  }
  return (
    <Link
      href="/settings#catalog_imports"
      className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-semibold text-foreground/90 transition hover:bg-muted/60"
    >
      <Plug className="h-3.5 w-3.5" aria-hidden />
      Catalog and Google Sheets (Settings)
    </Link>
  );
}

const TABS: { id: TabId; label: string; icon: React.ElementType }[] = [
  { id: "catalog", label: "Catalog Hub", icon: LayoutGrid },
  { id: "import", label: "Quick file import", icon: Sparkles },
  { id: "integrations", label: "Integrations & API", icon: Plug },
];

export default function ProductInformationManagementPage() {
  const [activeTab, setActiveTab] = useState<TabId>("catalog");
  const { organizationId, organizationName, profileLoading } = useUserRole();

  return (
    <div className="relative min-h-screen overflow-hidden bg-background px-4 py-10 sm:px-6 lg:px-8">
      <div
        className="pointer-events-none absolute inset-0 opacity-40 dark:opacity-25"
        aria-hidden
      >
        <div className="absolute -left-32 top-0 h-96 w-96 rounded-full bg-primary/20 blur-3xl" />
        <div className="absolute bottom-0 right-0 h-80 w-80 rounded-full bg-sky-400/15 blur-3xl dark:bg-sky-500/10" />
      </div>

      <div className="relative mx-auto w-full max-w-[min(100%,1680px)]">
        <header className="mb-8 rounded-2xl border border-border/60 bg-card/70 p-6 shadow-xl backdrop-blur-md dark:bg-card/50 sm:p-8">
          <div className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-widest text-primary">PIM</p>
              <div className="mt-1 flex flex-wrap items-center gap-2">
                <h1 className="text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">Product Information Management</h1>
                <PimHelpNote label="About PIM">
                  <div>
                    Store-scoped catalog, quick file seed via ETL, integrations, and optional Google Sheets sync. Full staged file imports use{" "}
                    <Link href="/dashboard/file-import" className="font-medium text-primary underline-offset-2 hover:underline">
                      Imports
                    </Link>
                    .
                  </div>
                </PimHelpNote>
              </div>
              <p className="mt-2 max-w-xl text-sm text-muted-foreground">Admin tools for catalog data and connections.</p>
            </div>
          </div>

          <nav
            className="mt-8 flex flex-wrap gap-2 rounded-xl border border-border/50 bg-muted/20 p-1.5 backdrop-blur-sm"
            aria-label="PIM sections"
          >
            {TABS.map(({ id, label, icon: Icon }) => {
              const selected = activeTab === id;
              return (
                <button
                  key={id}
                  type="button"
                  onClick={() => setActiveTab(id)}
                  className={[
                    "inline-flex flex-1 items-center justify-center gap-2 rounded-lg px-3 py-2.5 text-sm font-medium transition-all min-w-[140px]",
                    selected
                      ? "bg-card text-foreground shadow-md ring-1 ring-border/80"
                      : "text-muted-foreground hover:bg-background/60 hover:text-foreground",
                  ].join(" ")}
                >
                  <Icon className="h-4 w-4 shrink-0" aria-hidden />
                  {label}
                </button>
              );
            })}
          </nav>
        </header>

        {/* Keep catalog hub mounted so list scroll, filters, and selection survive tab switches. */}
        <div className={activeTab !== "catalog" ? "hidden" : ""}>
          <Suspense
            fallback={
              <section className="rounded-2xl border border-border/60 bg-card/70 p-8 text-sm text-muted-foreground shadow-xl">
                Loading catalog…
              </section>
            }
          >
            <PimCatalogHub organizationId={organizationId} />
          </Suspense>
        </div>
        {/* Keep import panel mounted so file + preview state survive tab switches within PIM. */}
        <div className={activeTab !== "import" ? "hidden" : ""}>
          <Suspense
            fallback={
              <section className="rounded-2xl border border-border/60 bg-card/70 p-6 text-sm text-muted-foreground">
                Loading import…
              </section>
            }
          >
            <AiCsvImportPanel
              organizationId={organizationId}
              organizationName={organizationName}
              profileLoading={profileLoading}
            />
          </Suspense>
        </div>
        {activeTab === "integrations" && <IntegrationsPanel organizationId={organizationId} />}
      </div>
    </div>
  );
}

type PimUiJobSnap = { lifecycle: string | null; preview_status: string | null; stage_label: string | null } | null;

type PimStatusTone = "success" | "info" | "warning" | "danger" | "muted" | "progress";

function PimStatusBadge({ label, tone }: { label: string; tone: PimStatusTone }) {
  const map: Record<PimStatusTone, string> = {
    success: "bg-emerald-500/15 text-emerald-900 dark:bg-emerald-950/50 dark:text-emerald-100",
    info: "bg-sky-500/15 text-sky-900 dark:bg-sky-950/50 dark:text-sky-100",
    warning: "bg-amber-500/15 text-amber-950 dark:bg-amber-950/40 dark:text-amber-100",
    danger: "bg-red-500/15 text-red-900 dark:bg-red-950/50 dark:text-red-100",
    muted: "bg-muted text-muted-foreground",
    progress: "bg-violet-500/15 text-violet-900 dark:bg-violet-950/50 dark:text-violet-100",
  };
  return (
    <span className={`inline-flex shrink-0 rounded-full px-2.5 py-0.5 text-xs font-semibold ${map[tone]}`}>{label}</span>
  );
}

function pimActiveImportDisplayStatus(
  phase: ImportPhase,
  busyKind: "preview" | "apply" | null,
  snap: PimUiJobSnap,
): { label: string; tone: PimStatusTone } {
  const life = String(snap?.lifecycle ?? "").toLowerCase();
  const pstat = String(snap?.preview_status ?? "").toLowerCase();
  const stage = String(snap?.stage_label ?? "").toLowerCase();

  if (phase === "success") return { label: "Completed", tone: "success" };
  if (life === "cancelled" || pstat === "cancelled") return { label: "Cancelled", tone: "muted" };

  if (phase === "error") {
    if (stage === "import_partial_failed" || pstat === "import_partial_failed") {
      return { label: "Partially imported", tone: "warning" };
    }
    return { label: "Failed", tone: "danger" };
  }

  if (busyKind === "apply" || life === "importing" || life === "import_queued") {
    return { label: "Importing", tone: "progress" };
  }
  if (busyKind === "preview" || life === "previewing" || pstat === "previewing" || phase === "uploading") {
    return { label: "Scanning preview", tone: "info" };
  }
  if (phase === "preview_ready") return { label: "Preview ready", tone: "info" };

  return { label: "In progress", tone: "muted" };
}

function pimHistoryRowDisplayStatus(row: PimImportSessionListRow): { label: string; tone: PimStatusTone } {
  const meta = row.metadata && typeof row.metadata === "object" ? row.metadata : {};
  const job = (meta as { pim_import_job?: Record<string, unknown> }).pim_import_job ?? {};
  const life = String(job.lifecycle ?? "").toLowerCase();
  const pstat = String((meta as { preview_status?: string }).preview_status ?? "").toLowerCase();
  const stage = String(job.stage_label ?? "").toLowerCase();
  const ss = String(row.session_status ?? "").toLowerCase();

  if (ss === "completed" || life === "completed") return { label: "Completed", tone: "success" };
  if (ss === "reset") return { label: "Reset", tone: "muted" };
  if (ss === "cancelled" || life === "cancelled" || pstat === "cancelled") return { label: "Cancelled", tone: "muted" };
  if (stage === "import_partial_failed" || pstat === "import_partial_failed") {
    return { label: "Partially imported", tone: "warning" };
  }
  if (ss === "failed" || life === "failed" || pstat === "failed") return { label: "Failed", tone: "danger" };
  if (ss === "importing" || life === "importing" || life === "import_queued") return { label: "Importing", tone: "progress" };
  if (ss === "preview_running" || life === "previewing" || pstat === "previewing") {
    return { label: "Scanning preview", tone: "info" };
  }
  if (ss === "preview_ready" || pstat === "preview_ready" || life === "waiting_for_confirmation") {
    return { label: "Preview ready", tone: "info" };
  }
  if (ss === "uploaded" || life === "uploaded") return { label: "Uploaded", tone: "muted" };
  return { label: "In progress", tone: "muted" };
}

/** Map raw ETL stage strings to operator-friendly labels. */
const PIM_STAGE_LABELS: Record<string, string> = {
  scanning_rows: "Scanning file",
  reading_workbook: "Reading file",
  import_partial_failed: "Import paused — resumable",
  waiting_for_confirmation: "Ready to import",
  preview_ready: "Preview ready",
  importing: "Importing rows",
  previewing: "Running preview",
  uploaded: "Waiting to start",
  queued: "Queued",
  completed: "Import complete",
  failed: "Import failed",
  cancelled: "Cancelled",
  download_failed: "File download failed",
  preview_incomplete: "Preview incomplete",
};
function friendlyStageLabel(raw: string | null | undefined): string {
  const k = (raw || "").toLowerCase().replace(/\s+/g, "_");
  return PIM_STAGE_LABELS[k] ?? (raw || "").replace(/_/g, " ");
}

function pimColumnMappingSummary(mapping: Record<string, string>): string {
  const keys = Object.keys(mapping);
  if (!keys.length) return "";
  const pretty = keys.map((k) =>
    k
      .replace(/_/g, " ")
      .replace(/\b\w/g, (ch) => ch.toUpperCase())
      .replace(/\bSku\b/i, "SKU")
      .replace(/\bAsin\b/i, "ASIN")
      .replace(/\bUpc\b/i, "UPC")
      .replace(/\bFnsku\b/i, "FNSKU")
      .replace(/\bMpn\b/i, "MPN"),
  );
  const head = pretty.slice(0, 14).join(", ");
  return pretty.length > 14 ? `${head}, …` : head;
}

type AiCsvImportPanelProps = {
  organizationId: string | null;
  organizationName: string;
  profileLoading: boolean;
};

function AiCsvImportPanel({ organizationId, organizationName, profileLoading }: AiCsvImportPanelProps) {
  const searchParams = useSearchParams();
  const pimDebugEnabled = searchParams.get("pimdebug") === "1";
  const { canonicalRoleKey } = useUserRole();
  const perms = useRbacPermissions();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const progressTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [phase, setPhase] = useState<ImportPhase>("idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [metrics, setMetrics] = useState<SeedProductsMetrics | null>(null);
  const [previewQuality, setPreviewQuality] = useState<PimCatalogSeedQuality | null>(null);
  const [busyKind, setBusyKind] = useState<null | "preview" | "apply">(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [pimStores, setPimStores] = useState<PimStoreOption[]>([]);
  const [selectedStoreId, setSelectedStoreId] = useState("");
  const [pimFormLoading, setPimFormLoading] = useState(false);
  const [seedSessionId, setSeedSessionId] = useState<string | null>(null);
  const [importUploadId, setImportUploadId] = useState<string | null>(null);
  const [importSessionId, setImportSessionId] = useState<string | null>(null);
  const [activeImportFileLabel, setActiveImportFileLabel] = useState<string | null>(null);
  const [columnMapping, setColumnMapping] = useState<Record<string, string>>({});
  const [mappingSource, setMappingSource] = useState<string | null>(null);
  const [uiStageLabel, setUiStageLabel] = useState("");
  const [progressPct, setProgressPct] = useState(0);
  const [previewProgressLine, setPreviewProgressLine] = useState<string | null>(null);
  const [historyRows, setHistoryRows] = useState<PimImportSessionListRow[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  /** Counters from `listPimImportSessions` (`raw_report_uploads` for selected store). */
  const [storeImportStats, setStoreImportStats] = useState<{
    rawInEnsureScan: number;
    sessionRowsInDb: number;
    backfilled: number;
    suggestedActive: PimSuggestedActiveImport | null;
  } | null>(null);
  const [clearStaleModalOpen, setClearStaleModalOpen] = useState(false);
  const [seedDelimiterDetected, setSeedDelimiterDetected] = useState<string | null>(null);
  const [seedDelimiterUncertain, setSeedDelimiterUncertain] = useState(false);
  const [previewDiag, setPreviewDiag] = useState<PreviewDiag | null>(null);
  const [showPreviewDebug, setShowPreviewDebug] = useState(false);
  /** Live counters while chunked apply is polling (from each metrics_partial). */
  const [applyPartialMetrics, setApplyPartialMetrics] = useState<SeedProductsMetrics | null>(null);
  const [historySelectedIds, setHistorySelectedIds] = useState<Set<string>>(() => new Set());
  /** Latest server job metadata for the active upload (drives lifecycle buttons in the Active import card). */
  const [activeJobSnap, setActiveJobSnap] = useState<{
    lifecycle: string | null;
    preview_status: string | null;
    stage_label: string | null;
  } | null>(null);
  const [showDirtyRowsPanel, setShowDirtyRowsPanel] = useState(false);
  const [showConflictPanel, setShowConflictPanel] = useState(false);
  const [conflictSearchText, setConflictSearchText] = useState("");
  const [conflictReasonFilter, setConflictReasonFilter] = useState<string>("all");
  const [conflictDetachBusy, setConflictDetachBusy] = useState<string | null>(null);
  /** True when the current/last apply was "Import safe rows only". Persists across retry/resume within the session. */
  const [wasSafeRowsOnly, setWasSafeRowsOnly] = useState(false);
  const [mappingDetailsOpen, setMappingDetailsOpen] = useState(false);
  const [activeImportDetailsOpen, setActiveImportDetailsOpen] = useState(false);
  /** Expands the Preview summary metric grid above — toggled from the active import card. */
  const [importDetailPanelsOpen, setImportDetailPanelsOpen] = useState(false);
  const [priceBackfillBusyUploadId, setPriceBackfillBusyUploadId] = useState<string | null>(null);
  const [fpsPriceBackfillByUpload, setFpsPriceBackfillByUpload] = useState<Record<string, Record<string, unknown>>>({});
  const [importDeleteModal, setImportDeleteModal] = useState<null | {
    uploadId: string;
    fileLabel: string;
    warnCatalog: boolean;
    historyRow: PimImportSessionListRow | null;
  }>(null);

  const pimImportDebugSnapshot = useMemo(() => {
    const byStatus: Record<string, number> = {};
    let resetOrDeleted = 0;
    for (const r of historyRows) {
      const raw = String(r.preview_status ?? "").trim();
      const key = raw ? raw.toLowerCase() : "—";
      byStatus[key] = (byStatus[key] ?? 0) + 1;
      const m = r.metadata as unknown as Record<string, unknown> | undefined;
      if (
        key === "reset" ||
        key === "deleted" ||
        m?.pim_upload_deleted === true ||
        m?.deleted === true
      ) {
        resetOrDeleted += 1;
      }
    }
    return { byStatus, resetOrDeleted, historyLen: historyRows.length };
  }, [historyRows]);

  const clearProgressTimer = useCallback(() => {
    if (progressTimerRef.current) {
      clearInterval(progressTimerRef.current);
      progressTimerRef.current = null;
    }
  }, []);

  const refreshHistory = useCallback(async () => {
    const oid = organizationId?.trim();
    const sid = selectedStoreId.trim();
    if (!oid || !sid) {
      setHistoryRows([]);
      setStoreImportStats(null);
      return;
    }
    setHistoryLoading(true);
    try {
      const uid = importUploadId?.trim() || undefined;
      const res = await listPimImportSessions({
        organizationId: oid,
        storeId: sid,
        limit: 100,
        ...(uid ? { includeUploadIds: [uid] } : {}),
      });
      if (res.ok) {
        setHistoryRows(res.rows);
        const es = res.ensureStats;
        setStoreImportStats({
          rawInEnsureScan: es.scannedRawUploads,
          sessionRowsInDb: es.sessionsForStore,
          backfilled: es.backfilled,
          suggestedActive: res.suggestedActive,
        });
        if (process.env.NODE_ENV === "development") {
          console.info("[PIM import sync]", es, "suggested:", res.suggestedActive);
        }
      } else {
        setHistoryRows([]);
        setStoreImportStats(null);
      }
    } finally {
      setHistoryLoading(false);
    }
  }, [organizationId, selectedStoreId, importUploadId]);

  const refreshPriceBackfillSnapshot = useCallback(
    async (uploadId: string) => {
      const oid = organizationId?.trim();
      if (!oid) return;
      const r = await getPimImportFileProcessingMetrics({ organizationId: oid, uploadId });
      if (!r.ok || !r.import_metrics) return;
      const im = r.import_metrics as unknown as Record<string, unknown>;
      const pb = im.price_backfill;
      if (pb && typeof pb === "object") {
        setFpsPriceBackfillByUpload((m) => ({ ...m, [uploadId]: pb as unknown as Record<string, unknown> }));
      }
    },
    [organizationId],
  );

  const runPimPriceBackfillForUpload = useCallback(
    async (uploadId: string) => {
      const oid = organizationId?.trim();
      if (!oid) return;
      setPriceBackfillBusyUploadId(uploadId);
      try {
        for (let step = 0; step < 5000; step++) {
          const res = await pimPriceBackfillStep({ organizationId: oid, uploadId });
          if (res.ok && res.price_backfill) {
            setFpsPriceBackfillByUpload((m) => ({ ...m, [uploadId]: res.price_backfill! }));
          }
          if (!res.ok) {
            window.alert(res.error);
            break;
          }
          if (res.done || res.terminal || res.cancelled) break;
        }
        void refreshHistory();
        void refreshPriceBackfillSnapshot(uploadId);
      } finally {
        setPriceBackfillBusyUploadId(null);
      }
    },
    [organizationId, refreshHistory, refreshPriceBackfillSnapshot],
  );

  const runActiveUploadPriceBackfill = useCallback(async () => {
    const oid = organizationId?.trim();
    const uid = importUploadId?.trim();
    if (!oid || !uid) return;
    setPriceBackfillBusyUploadId(uid);
    try {
      for (let step = 0; step < 5000; step++) {
        const res = await pimPriceBackfillStep({ organizationId: oid, uploadId: uid });
        if (res.ok && res.price_backfill) {
          setFpsPriceBackfillByUpload((m) => ({ ...m, [uid]: res.price_backfill! }));
        }
        if (!res.ok) {
          window.alert(res.error);
          break;
        }
        if (res.done || res.terminal || res.cancelled) break;
      }
      void refreshHistory();
      void refreshPriceBackfillSnapshot(uid);
    } finally {
      setPriceBackfillBusyUploadId(null);
    }
  }, [organizationId, importUploadId, refreshHistory, refreshPriceBackfillSnapshot]);

  useEffect(() => {
    if (process.env.NODE_ENV !== "development") return;
    const oid = organizationId?.trim();
    const sid = selectedStoreId.trim();
    if (!oid || !sid) return;
    void getPimImportSyncDiagnostics({ organizationId: oid, storeId: sid }).then((r) => {
      if (r.ok) console.info("[PIM import diagnostics]", r);
    });
  }, [organizationId, selectedStoreId]);

  const refreshActiveJobSnap = useCallback(async () => {
    const oid = organizationId?.trim();
    const uid = importUploadId?.trim();
    if (!oid || !uid) {
      setActiveJobSnap(null);
      return;
    }
    const snap = await fetchPimImportPreviewSnapshot({ organizationId: oid, uploadId: uid });
    if (!snap.ok) return;
    const job = snap.pim_import_job;
    setActiveJobSnap({
      lifecycle: typeof job?.lifecycle === "string" ? job.lifecycle : null,
      preview_status: typeof snap.preview_status === "string" ? snap.preview_status : null,
      stage_label: typeof job?.stage_label === "string" ? job.stage_label : null,
    });
  }, [organizationId, importUploadId]);

  useEffect(() => {
    void refreshActiveJobSnap();
  }, [refreshActiveJobSnap, phase, busyKind]);

  useEffect(() => {
    const uid = importUploadId?.trim();
    if (!uid) return;
    const id = window.setInterval(() => void refreshActiveJobSnap(), 22_000);
    return () => window.clearInterval(id);
  }, [importUploadId, refreshActiveJobSnap]);

  useEffect(() => {
    void refreshHistory();
  }, [refreshHistory]);

  /** Keep history in sync when a new upload id appears (backfill runs inside listPimImportSessions). */
  useEffect(() => {
    const oid = organizationId?.trim();
    const sid = selectedStoreId.trim();
    const uid = importUploadId?.trim();
    if (!oid || !sid || !uid) return;
    void refreshHistory();
  }, [importUploadId, organizationId, selectedStoreId, refreshHistory]);

  useEffect(() => {
    setHistorySelectedIds(new Set());
  }, [selectedStoreId]);

  /** When preview is ready in another tab, keep session id / step in sync from DB. */
  useEffect(() => {
    const oid = organizationId?.trim();
    const sid = selectedStoreId.trim();
    const uid = importUploadId?.trim();
    if (!oid || !sid || !uid) return;
    if (phase !== "preview_ready" && phase !== "success") return;
    let cancelled = false;
    const tick = async () => {
      try {
        const st = await fetch(
          `/api/dashboard/products/import/status?organization_id=${encodeURIComponent(oid)}&job_id=${encodeURIComponent(uid)}`,
          { method: "GET" },
        );
        if (!st.ok || cancelled) return;
        const sj = (await st.json()) as {
          import_session_id?: string | null;
          session_status?: string | null;
          session_current_step?: string | null;
        };
        if (typeof sj.import_session_id === "string" && sj.import_session_id) setImportSessionId(sj.import_session_id);
      } catch {
        /* ignore */
      }
    };
    void tick();
    const id = window.setInterval(() => void tick(), 14_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [organizationId, selectedStoreId, importUploadId, phase]);

  useEffect(() => {
    const oid = organizationId?.trim();
    // Does NOT require selectedStoreId — queries by org only so restore works on page load/refresh
    // before stores have finished loading.
    if (!oid || profileLoading || pimFormLoading || file || busyKind) return;
    if (phase === "success") return;
    let cancelled = false;
    void (async () => {
      // Query raw_report_uploads directly by org — no storeId dependency
      const active = await findLatestActivePimUpload({ organizationId: oid });
      if (cancelled || !active.ok || !active.row) return;
      const activeRow = active.row;
      const jobId = activeRow.id;

      // Skip if already showing this exact job in preview_ready
      if (importUploadId === jobId && phase === "preview_ready" && previewQuality) return;

      // Apply the upload's store to selectedStoreId if it differs and that store exists in the list
      const uploadStore = activeRow.import_store_id;
      if (uploadStore && pimStores.some((s) => s.id === uploadStore) && selectedStoreId !== uploadStore) {
        setSelectedStoreId(uploadStore);
      }
      const storeForPoll = (uploadStore && pimStores.some((s) => s.id === uploadStore)
        ? uploadStore
        : selectedStoreId).trim();

      setImportUploadId(jobId);
      setActiveImportFileLabel(activeRow.file_name);
      if (activeRow.pim_import_safe_rows_only) setWasSafeRowsOnly(true);

      const snap = await fetchPimImportPreviewSnapshot({ organizationId: oid, uploadId: jobId });
      if (snap.ok && snap.pim_import_session_id) setImportSessionId(snap.pim_import_session_id);
      if (snap.ok && snap.pim_import_safe_rows_only) setWasSafeRowsOnly(true);
      if (cancelled) return;

      const life = activeRow.lifecycle ?? "";
      const pstat = activeRow.preview_status ?? "";
      const pqNorm = snap.ok ? normalizePimPreviewQuality(snap.preview_quality) : null;
      const pr = snap.ok ? snap.pim_preview_result : null;
      const map =
        pr && typeof pr.mapping === "object" && pr.mapping !== null && !Array.isArray(pr.mapping)
          ? (pr.mapping as Record<string, string>)
          : {};
      const catDbg =
        pr && typeof pr.category_import_debug === "object" ? pr.category_import_debug : snap.ok ? snap.preview_quality : null;

      if (pstat === "preview_ready" || life === "waiting_for_confirmation") {
        if (pqNorm) {
          setPreviewQuality(pqNorm);
          setColumnMapping(map);
          setMappingSource(typeof pr?.mapping_source === "string" ? pr.mapping_source : null);
          setSeedSessionId(
            typeof pr?.seed_session_id === "string"
              ? pr.seed_session_id
              : snap.ok && typeof snap.pim_import_job?.pim_seed_session_id === "string"
                ? String(snap.pim_import_job.pim_seed_session_id)
                : null,
          );
          setPhase("preview_ready");
          setSuccessMessage("Restored import preview from server — you can confirm when ready.");
          setPreviewDiag({
            jobId,
            stage: "restored_snapshot",
            raw: JSON.stringify({ snap: snap.ok ? snap : null, note: "UI restored from raw_report_uploads" }, null, 2).slice(0, 14000),
            route: "findLatestActivePimUpload + fetchPimImportPreviewSnapshot",
            flow: "preview",
            upload_row_id: snap.ok ? snap.upload_row_id : jobId,
            report_type: snap.ok ? snap.report_type : null,
            row_status: activeRow.status,
            preview_status: pstat,
            lifecycle: life,
            import_store_id: activeRow.import_store_id,
            content_sha256: snap.ok ? snap.content_sha256 : null,
            updated_at: activeRow.updated_at,
            category_import_debug: catDbg,
            ui_restore_note: "restored_from_raw_report_uploads",
          });
          void refreshHistory();
          return;
        }
      }

      if (pstat === "cancelled" || life === "cancelled") {
        return;
      }

      if (life === "failed" || pstat === "import_partial_failed" || pstat === "failed") {
        if (pqNorm) setPreviewQuality(pqNorm);
        setColumnMapping(map);
        const jobMeta = (activeRow.metadata as { pim_import_job?: Record<string, unknown> }).pim_import_job ?? {};
        const stageLbl = String(jobMeta.stage_label ?? "").toLowerCase();
        const partial = stageLbl === "import_partial_failed" || pstat === "import_partial_failed";
        const leRaw = typeof jobMeta.last_error === "string" ? jobMeta.last_error : "";
        const le = leRaw.trim()
          ? leRaw.trim()
          : partial
            ? "Import paused after writing some rows — use Resume import to continue from checkpoint."
            : "Import failed — use Resume import to retry from checkpoint.";
                setErrorMsg(le);
        setPhase("error");
        setPreviewDiag({
          jobId,
          stage: partial ? "import_partial_failed" : "failed_restored",
          raw: JSON.stringify({ snap: snap.ok ? snap : null }, null, 2).slice(0, 14000),
          route: "findLatestActivePimUpload",
          flow: "apply",
          last_error: le,
          job_status: partial ? "import_partial_failed" : "failed",
        });
        void refreshActiveJobSnap();
        void refreshHistory();
        return;
      }

      if (life === "previewing" || pstat === "previewing") {
        if (!storeForPoll) return;
        setBusyKind("preview");
        setPhase("uploading");
        setErrorMsg(null);
        try {
          await runPimPreviewChunkPoll(oid, storeForPoll, jobId);
        } finally {
          setBusyKind(null);
          setTimeout(() => {
            setProgressPct(0);
            setUiStageLabel("");
          }, 600);
        }
        return;
      }

      if (life === "importing" || life === "import_queued") {
        if (!storeForPoll) return;
        if (pqNorm) setPreviewQuality(pqNorm);
        setBusyKind("apply");
        setPhase("uploading");
        setErrorMsg(null);
        try {
          await runPimApplyChunkPoll(oid, storeForPoll, jobId, { skipConflicts: activeRow.pim_import_safe_rows_only });
        } finally {
          setBusyKind(null);
          setTimeout(() => {
            setProgressPct(0);
            setUiStageLabel("");
          }, 800);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    organizationId,
    profileLoading,
    pimFormLoading,
    file,
    busyKind,
    phase,
    importUploadId,
    previewQuality,
    pimStores,
    selectedStoreId,
    refreshHistory,
    refreshActiveJobSnap,
  ]);

  useEffect(() => {
    return () => {
      clearProgressTimer();
    };
  }, [clearProgressTimer]);

  useEffect(() => {
    const oid = organizationId?.trim();
    if (!oid) {
      setPimStores([]);
      setSelectedStoreId("");
      return;
    }
    let cancelled = false;
    setPimFormLoading(true);
    void getPimManualProductFormDefaults(oid)
      .then((r) => {
        if (cancelled) return;
        if (!r.ok) {
          setPimStores([]);
          setSelectedStoreId("");
          return;
        }
        setPimStores(r.stores);
        const def = r.defaultStoreId?.trim() || "";
        const first = r.stores[0]?.id?.trim() || "";
        const next = def && r.stores.some((s) => s.id === def) ? def : first;
        setSelectedStoreId(next);
      })
      .finally(() => {
        if (!cancelled) setPimFormLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [organizationId]);

  const acceptFile = useCallback((f: File) => {
    const ext = f.name.split(".").pop()?.toLowerCase() ?? "";
    if (ext !== "csv" && ext !== "txt" && ext !== "xlsx" && ext !== "xlsm") {
      setErrorMsg("Only .csv, .txt, .xlsx, or .xlsm files are supported.");
      setFile(null);
      setPhase("idle");
      return;
    }
    setFile(f);
    setErrorMsg(null);
    setMetrics(null);
    setPreviewQuality(null);
    setSuccessMessage(null);
    setSeedSessionId(null);
    setImportUploadId(null);
    setImportSessionId(null);
    setActiveImportFileLabel(null);
    setColumnMapping({});
    setMappingSource(null);
    setSeedDelimiterDetected(null);
    setSeedDelimiterUncertain(false);
    setPreviewDiag(null);
    setShowPreviewDebug(false);
    setPreviewProgressLine(null);
    setPhase("selected");
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback(() => {
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragging(false);
      const f = e.dataTransfer.files?.[0];
      if (f) acceptFile(f);
    },
    [acceptFile],
  );

  const resetImport = useCallback(() => {
    setFile(null);
    setPhase("idle");
    setErrorMsg(null);
    setMetrics(null);
    setPreviewQuality(null);
    setSuccessMessage(null);
    setSeedSessionId(null);
    setImportUploadId(null);
    setImportSessionId(null);
    setActiveImportFileLabel(null);
    setColumnMapping({});
    setMappingSource(null);
    setSeedDelimiterDetected(null);
    setSeedDelimiterUncertain(false);
    setPreviewDiag(null);
    setShowPreviewDebug(false);
    setPreviewProgressLine(null);
    setApplyPartialMetrics(null);
    setHistorySelectedIds(new Set());
    setActiveJobSnap(null);
    setShowDirtyRowsPanel(false);
    setMappingDetailsOpen(false);
    setActiveImportDetailsOpen(false);
    setImportDeleteModal(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }, []);

  async function runPimPreviewChunkPoll(oid: string, sid: string, jobId: string) {
    let previewTimeoutsInRow = 0;
    let scanDataRowHint: number | undefined;
    let previewIterations = 0;
    setProgressPct(18);
    setUiStageLabel("Preview job…");
    try {
    while (previewIterations < 5000) {
      previewIterations += 1;

      if (previewIterations % 4 === 1) {
        try {
          const st = await fetch(
            `/api/dashboard/products/import/status?organization_id=${encodeURIComponent(oid)}&job_id=${encodeURIComponent(jobId)}`,
            { method: "GET" },
          );
          if (st.ok) {
            const sj = (await st.json()) as { percent?: number; stage?: string; job_status?: string };
            if (typeof sj.percent === "number") setProgressPct(Math.min(95, sj.percent));
            if (typeof sj.stage === "string" && sj.stage) setUiStageLabel(sj.stage.replace(/_/g, " "));
          }
        } catch {
          /* optional status poll */
        }
      }

      const step = await postDashboardPimImport("/api/dashboard/products/import/preview-step", {
        organization_id: oid,
        store_id: sid,
        job_id: jobId,
        ...(typeof scanDataRowHint === "number" ? { scan_data_row_hint: scanDataRowHint } : {}),
      });
      const d = step.data as PimPreviewStepResponse;
      const rawJson = JSON.stringify(d ?? {});
      setPreviewDiag({
        jobId,
        stage: String(d?.stage_label ?? d?.status ?? ""),
        raw: rawJson.length > 14000 ? `${rawJson.slice(0, 14000)}…` : rawJson,
        route: "POST /api/dashboard/products/import/preview-step → ETL /etl/pim-import/preview-step",
        job_status: typeof d?.status === "string" ? d.status : undefined,
        last_error: typeof d?.last_error === "string" ? d.last_error : null,
        flow: "preview",
        preview_progress:
          d?.preview_progress && typeof d.preview_progress === "object" && !Array.isArray(d.preview_progress)
            ? d.preview_progress
            : undefined,
      });

      if (!step.ok) {
        if (step.status === 504) {
          previewTimeoutsInRow += 1;
          if (previewTimeoutsInRow > 60) {
            setErrorMsg(
              "Preview kept timing out — check that the Python ETL service is running and reachable (ETL_API_ORIGIN).",
            );
            setPhase("error");
            break;
          }
          setUiStageLabel("Waiting for server chunk…");
          await new Promise((r) => setTimeout(r, 600));
          continue;
        }
        const msg =
          typeof d === "object" && d && typeof (d as { message?: string }).message === "string"
            ? (d as { message: string }).message
            : typeof d === "object" && d && typeof (d as { detail?: { message?: string } }).detail?.message === "string"
              ? String((d as { detail: { message: string } }).detail.message)
              : `Preview step failed (HTTP ${step.status}). Check that the Python ETL service is running (restart may be needed after code changes).`;
        setErrorMsg(msg);
        setPhase("error");
        break;
      }
      previewTimeoutsInRow = 0;

      if (d.ok === false) {
        const msg =
          (typeof d.last_error === "string" && d.last_error.trim()) ||
          (typeof d.error === "string" && d.error.trim()) ||
          "Preview failed";
        setErrorMsg(msg);
        setPhase("error");
        break;
      }

      if (d.status === "cancelled") {
        setErrorMsg("Preview was cancelled.");
        setPhase("error");
        void refreshHistory();
        break;
      }

      if (typeof d.progress_pct === "number") setProgressPct(Math.min(100, d.progress_pct));
      if (typeof d.stage_label === "string" && d.stage_label) setUiStageLabel(d.stage_label.replace(/_/g, " "));
      if (typeof d.next_cursor === "number") scanDataRowHint = d.next_cursor;

      if (d.preview_progress && typeof d.preview_progress === "object" && !Array.isArray(d.preview_progress)) {
        setPreviewProgressLine(formatPreviewProgressLine(d.preview_progress));
      }

      const pqNorm = normalizePimPreviewQuality(d.preview_quality ?? d.quality);
      const previewReady =
        d.status === "preview_ready" ||
        (Boolean(d.done) && (Boolean(d.terminal) || pqNorm !== null));

      if (previewReady && pqNorm) {
        setPreviewQuality(pqNorm);
        setSeedSessionId(typeof d.seed_session_id === "string" ? d.seed_session_id : null);
        setColumnMapping(d.mapping && typeof d.mapping === "object" ? d.mapping : {});
        setMappingSource(typeof d.mapping_source === "string" ? d.mapping_source : null);
        setSeedDelimiterDetected(null);
        setSeedDelimiterUncertain(false);
        setSuccessMessage("Preview ready — review quality, then confirm import.");
        setProgressPct(100);
        setUiStageLabel("Preview ready");
        setPhase("preview_ready");
        setPreviewDiag(null);
        setPreviewProgressLine(null);
        void refreshHistory();
        break;
      }

      if (Boolean(d.done) && Boolean(d.terminal) && !pqNorm) {
        const snap = await fetchPimImportPreviewSnapshot({
          organizationId: oid,
          uploadId: jobId,
        });
        const snapQ = snap.ok ? normalizePimPreviewQuality(snap.preview_quality) : null;
        if (snap.ok && snapQ) {
          setPreviewQuality(snapQ);
          const pr = snap.pim_preview_result;
          const map =
            pr && typeof pr.mapping === "object" && pr.mapping !== null && !Array.isArray(pr.mapping)
              ? (pr.mapping as Record<string, string>)
              : {};
          setColumnMapping(map);
          setMappingSource(typeof pr?.mapping_source === "string" ? pr.mapping_source : null);
          setSeedSessionId(
            typeof pr?.seed_session_id === "string"
              ? pr.seed_session_id
              : typeof snap.pim_import_job?.pim_seed_session_id === "string"
                ? String(snap.pim_import_job.pim_seed_session_id)
                : null,
          );
          setSuccessMessage("Preview ready (loaded from saved session).");
          setProgressPct(100);
          setUiStageLabel("Preview ready");
          setPhase("preview_ready");
          setPreviewDiag(null);
          setPreviewProgressLine(null);
          void refreshHistory();
          break;
        }
        const jobErr =
          snap.ok && snap.pim_import_job && typeof snap.pim_import_job.last_error === "string"
            ? snap.pim_import_job.last_error
            : "";
        setErrorMsg(
          [
            "Preview finished without a usable quality summary.",
            !snap.ok ? snap.error : "",
            jobErr ? jobErr : "",
            "Open View debug (preview) below if you need raw job ids and server response text.",
          ]
            .filter(Boolean)
            .join(" "),
        );
        setPhase("error");
        break;
      }
    }
    if (previewIterations >= 5000) {
      setErrorMsg("Preview exceeded maximum steps — try a smaller file or contact support.");
      setPhase("error");
    }
    } finally {
      void refreshActiveJobSnap();
    }
  }

  async function runCatalogPreview() {
    if (!file || phase === "uploading" || profileLoading || !organizationId) return;
    const sid = selectedStoreId.trim();
    if (!sid) {
      setErrorMsg("Choose a target store for this import (required).");
      setPhase("error");
      return;
    }

    setPhase("uploading");
    setBusyKind("preview");
    setErrorMsg(null);
    setMetrics(null);
    setPreviewQuality(null);
    setSuccessMessage(null);
    setPreviewDiag(null);
    setShowPreviewDebug(false);
    setPreviewProgressLine(null);
    setProgressPct(5);
    setUiStageLabel("Uploading to storage…");

    try {
      const ext = file.name.split(".").pop() ?? "csv";
      const sha = await sha256HexFromFile(file);
      const dup = await findActivePimImportBySha({
        organizationId: organizationId,
        storeId: sid,
        contentSha256: sha,
      });
      if (dup.ok && dup.found && dup.uploadId) {
        const reuse = window.confirm(
          `An import for this exact file is already active in this store (${dup.fileName ?? "same file hash"}). OK = open that session (no duplicate upload). Cancel = choose whether to upload as a new session.`,
        );
        if (reuse) {
          setImportUploadId(dup.uploadId);
          setImportSessionId(dup.importSessionId);
          setActiveImportFileLabel(dup.fileName ?? file.name);
          setProgressPct(14);
          setUiStageLabel("Loading existing session…");
          const snap = await fetchPimImportPreviewSnapshot({ organizationId: organizationId, uploadId: dup.uploadId });
          if (snap.ok && snap.pim_import_session_id) setImportSessionId(snap.pim_import_session_id);
          const life = String(snap.ok ? snap.pim_import_job?.lifecycle ?? "" : "").toLowerCase();
          const pstat = String(snap.ok ? snap.preview_status ?? "" : "").toLowerCase();
          const pqNorm = snap.ok ? normalizePimPreviewQuality(snap.preview_quality) : null;
          const pr = snap.ok ? snap.pim_preview_result : null;
          const map =
            pr && typeof pr.mapping === "object" && pr.mapping !== null && !Array.isArray(pr.mapping)
              ? (pr.mapping as Record<string, string>)
              : {};
          if (snap.ok && (pstat === "preview_ready" || life === "waiting_for_confirmation") && pqNorm) {
            setPreviewQuality(pqNorm);
            setColumnMapping(map);
            setMappingSource(typeof pr?.mapping_source === "string" ? pr.mapping_source : null);
            setPhase("preview_ready");
            setSuccessMessage("Using existing import session — preview is already on the server.");
            void refreshHistory();
            void refreshActiveJobSnap();
            return;
          }
          await runPimPreviewChunkPoll(organizationId, sid, dup.uploadId);
          void refreshActiveJobSnap();
          return;
        }
        const forceNew = window.confirm(
          "Upload as a new session anyway? This uses more storage unless you delete older sessions.",
        );
        if (!forceNew) {
          setPhase("selected");
          return;
        }
      }

      const up = await postDashboardPimImport("/api/dashboard/products/import/upload", {
        organization_id: organizationId,
        store_id: sid,
        file_name: file.name,
        total_bytes: file.size,
        file_extension: ext,
        content_sha256: sha,
      });
      const upData = up.data as {
        ok?: boolean;
        error?: string;
        job_id?: string;
        import_session_id?: string | null;
        resumed?: boolean;
        skip_upload?: boolean;
      } | null;
      if (!up.ok || !upData?.ok || !upData.job_id) {
        setErrorMsg(typeof upData?.error === "string" ? upData.error : `Upload session failed (${up.status}).`);
        setPhase("error");
        return;
      }
      const jobId = upData.job_id;
      setImportUploadId(jobId);
      setImportSessionId(typeof upData.import_session_id === "string" ? upData.import_session_id : null);
      setActiveImportFileLabel(file.name);
      const skipParts = Boolean(upData.skip_upload);
      if (!skipParts) {
        setProgressPct(12);
        setUiStageLabel("Uploading chunks…");
        await uploadLocalFileToRawReportChunks(jobId, file);

        const fin = await postDashboardPimImport("/api/dashboard/products/import/finalize", {
          organization_id: organizationId,
          job_id: jobId,
          total_parts: Math.max(1, Math.ceil(file.size / PIM_UPLOAD_CHUNK_BYTES)),
        });
        const finData = fin.data as { ok?: boolean; error?: string } | null;
        if (!fin.ok || !finData?.ok) {
          setErrorMsg(typeof finData?.error === "string" ? finData.error : `Finalize failed (${fin.status}).`);
          setPhase("error");
          return;
        }
      } else {
        setProgressPct(16);
        setUiStageLabel("Resuming existing upload — preview…");
      }

      await runPimPreviewChunkPoll(organizationId, sid, jobId);
    } catch (err) {
      setErrorMsg(axiosMessage(err, "Preview failed (timeout or network)."));
      setPhase("error");
    } finally {
      setBusyKind(null);
      setTimeout(() => {
        setProgressPct(0);
        setUiStageLabel("");
      }, 600);
    }
  }

  async function runPimApplyChunkPoll(oid: string, sid: string, jobId: string, opts?: { skipConflicts?: boolean }) {
    setApplyPartialMetrics(null);
    let applyIterations = 0;
    let applyTimeoutsInRow = 0;
    try {
    while (applyIterations < 5000) {
      applyIterations += 1;

      if (applyIterations % 4 === 1) {
        try {
          const st = await fetch(
            `/api/dashboard/products/import/status?organization_id=${encodeURIComponent(oid)}&job_id=${encodeURIComponent(jobId)}`,
            { method: "GET" },
          );
          if (st.ok) {
            const sj = (await st.json()) as {
              import_session_id?: string | null;
              session_current_step?: string | null;
              percent?: number;
              stage?: string;
            };
            if (typeof sj.import_session_id === "string" && sj.import_session_id) setImportSessionId(sj.import_session_id);
            if (typeof sj.session_current_step === "string" && sj.session_current_step.trim()) {
              setUiStageLabel(sj.session_current_step.replace(/_/g, " "));
            } else if (typeof sj.stage === "string" && sj.stage) {
              setUiStageLabel(sj.stage.replace(/_/g, " "));
            }
            if (typeof sj.percent === "number") setProgressPct(Math.min(99, sj.percent));
          }
        } catch {
          /* optional */
        }
      }

      const response = await postDashboardPimImport("/api/dashboard/products/import/apply-step", {
        organization_id: oid,
        store_id: sid,
        job_id: jobId,
        ...(opts?.skipConflicts ? { import_safe_rows_only: true, skip_conflicts: true } : {}),
      });
      const d = response.data as PimApplyStepResponse;
      const applyRawJson = JSON.stringify(d ?? {});
      if (!response.ok) {
        if (response.status === 504) {
          applyTimeoutsInRow += 1;
          if (applyTimeoutsInRow > 60) {
            setErrorMsg("Import repeatedly timed out — check ETL service and try Confirm & Import again.");
            setPhase("error");
            setPreviewDiag({
              jobId,
              stage: String(d?.stage_label ?? d?.status ?? ""),
              raw: applyRawJson.length > 14000 ? `${applyRawJson.slice(0, 14000)}…` : applyRawJson,
              route: "POST /api/dashboard/products/import/apply-step → ETL /etl/pim-import/apply-step",
              job_status: typeof d?.status === "string" ? d.status : undefined,
              last_error: typeof d?.last_error === "string" ? d.last_error : typeof d?.error === "string" ? d.error : null,
              flow: "apply",
              preview_progress:
                d?.preview_progress && typeof d.preview_progress === "object" && !Array.isArray(d.preview_progress)
                  ? d.preview_progress
                  : undefined,
            });
            break;
          }
          setUiStageLabel("Waiting for import chunk…");
          await new Promise((r) => setTimeout(r, 600));
          continue;
        }
        setErrorMsg(pimApplyStepUserFacingMessage(d, response.status));
        setPhase("error");
        setPreviewDiag({
          jobId,
          stage: String(d?.stage_label ?? d?.status ?? ""),
          raw: applyRawJson.length > 14000 ? `${applyRawJson.slice(0, 14000)}…` : applyRawJson,
          route: "POST /api/dashboard/products/import/apply-step → ETL /etl/pim-import/apply-step",
          job_status: typeof d?.status === "string" ? d.status : undefined,
          last_error: typeof d?.last_error === "string" ? d.last_error : typeof d?.error === "string" ? d.error : null,
          flow: "apply",
          preview_progress:
            d?.preview_progress && typeof d.preview_progress === "object" && !Array.isArray(d.preview_progress)
              ? d.preview_progress
              : undefined,
        });
        break;
      }
      applyTimeoutsInRow = 0;
      if (d.ok === false) {
        setErrorMsg(pimApplyStepUserFacingMessage(d, response.status));
        setPhase("error");
        setPreviewDiag({
          jobId,
          stage: String(d?.stage_label ?? d?.status ?? ""),
          raw: applyRawJson.length > 14000 ? `${applyRawJson.slice(0, 14000)}…` : applyRawJson,
          route: "POST /api/dashboard/products/import/apply-step → ETL /etl/pim-import/apply-step",
          job_status: typeof d?.status === "string" ? d.status : undefined,
          last_error: typeof d?.last_error === "string" ? d.last_error : typeof d?.error === "string" ? d.error : null,
          flow: "apply",
          preview_progress:
            d?.preview_progress && typeof d.preview_progress === "object" && !Array.isArray(d.preview_progress)
              ? d.preview_progress
              : undefined,
        });
        break;
      }
      if (d.status === "cancelled") {
        setErrorMsg("Import was cancelled.");
        setPhase("error");
        void refreshHistory();
        break;
      }
      if (d.metrics_partial && typeof d.metrics_partial === "object") {
        setApplyPartialMetrics(d.metrics_partial);
      }
      if (typeof d.user_message === "string" && d.user_message.trim()) {
        setUiStageLabel(d.user_message.trim());
      }
      if (typeof d.progress_pct === "number") setProgressPct(Math.min(99, d.progress_pct));
      if (d.done && d.metrics && typeof d.metrics === "object") {
        setMetrics(d.metrics);
        setApplyPartialMetrics(null);
        setPreviewQuality(null);
        setSuccessMessage("Import completed.");
        setProgressPct(100);
        setUiStageLabel("Complete");
        setPhase("success");
        void refreshHistory();
        break;
      }
      if (d.done && !d.metrics) {
        setErrorMsg("Import ended without metrics.");
        setPhase("error");
        break;
      }
    }
    if (applyIterations >= 5000) {
      setErrorMsg("Import exceeded maximum steps — check history or retry.");
      setPhase("error");
    }
    } finally {
      void refreshActiveJobSnap();
    }
  }

  async function retryApplyFromCheckpoint() {
    const oid = organizationId?.trim();
    const sid = selectedStoreId.trim();
    const jid = importUploadId?.trim();
    if (!oid || !sid || !jid) return;
    setPhase("uploading");
    setBusyKind("apply");
    setErrorMsg(null);
    setSuccessMessage(null);
    setProgressPct(8);
    setUiStageLabel("Resuming import…");
    try {
      // Pass import_safe_rows_only if this session was originally safe-only.
      // The backend ALSO auto-reads pim_import_safe_rows_only from metadata as a
      // belt-and-suspenders safeguard (handles page-refresh case too).
      await runPimApplyChunkPoll(oid, sid, jid, { skipConflicts: wasSafeRowsOnly });
    } catch (err) {
      setErrorMsg(axiosMessage(err, "Import failed."));
      setPhase("error");
      void refreshHistory();
    } finally {
      setBusyKind(null);
      setTimeout(() => {
        setProgressPct(0);
        setUiStageLabel("");
      }, 800);
    }
  }

  async function runCatalogApply(opts?: { skipConflicts?: boolean }) {
    if (phase === "uploading" || profileLoading || !organizationId) return;
    const sid = selectedStoreId.trim();
    if (!sid) {
      setErrorMsg("Choose a target store for this import (required).");
      setPhase("error");
      return;
    }
    if (phase !== "preview_ready" || !previewQuality) {
      setErrorMsg("Run Preview import first.");
      setPhase("error");
      return;
    }
    if (!importUploadId) {
      setErrorMsg("Missing import session — run Preview again.");
      setPhase("error");
      return;
    }
    if (previewQuality.apply_blocked_by_dirty_rate) {
      setErrorMsg(
        `Import blocked: dirty rate ${previewQuality.dirty_rate ?? "—"} exceeds maximum ${previewQuality.max_dirty_rate ?? "—"}. Fix the sheet and preview again.`,
      );
      setPhase("error");
      return;
    }
    if (previewQuality.apply_blocked_by_conflicts && !opts?.skipConflicts) {
      setErrorMsg("Import blocked: preview has identifier conflicts. Use 'Import safe rows only' to import accepted rows and skip conflicting rows.");
      setPhase("error");
      return;
    }

    setPhase("uploading");
    setBusyKind("apply");
    setErrorMsg(null);
    setMetrics(null);
    setSuccessMessage(null);
    setProgressPct(8);
    setUiStageLabel("Importing…");
    // Track whether this run used safe-rows-only so retry/resume can inherit the flag
    if (opts?.skipConflicts) setWasSafeRowsOnly(true);

    try {
      const conf = await postDashboardPimImport("/api/dashboard/products/import/confirm", {
        organization_id: organizationId,
        job_id: importUploadId,
        ...(opts?.skipConflicts ? { import_safe_rows_only: true } : {}),
      });
      const confData = conf.data as { ok?: boolean; error?: string } | null;
      if (!conf.ok || !confData?.ok) {
        setErrorMsg(typeof confData?.error === "string" ? confData.error : `Confirm failed (${conf.status}).`);
        setPhase("error");
        return;
      }

      await runPimApplyChunkPoll(organizationId, sid, importUploadId, { skipConflicts: opts?.skipConflicts });
    } catch (err) {
      setErrorMsg(axiosMessage(err, "Import failed."));
      setPhase("error");
      void refreshHistory();
    } finally {
      setBusyKind(null);
      setTimeout(() => {
        setProgressPct(0);
        setUiStageLabel("");
      }, 800);
    }
  }

  async function cancelActiveImportJob() {
    if (!organizationId?.trim() || !importUploadId) return;
    if (!window.confirm("Stop this preview or import job on the server?")) return;
    const res = await postDashboardPimImport("/api/dashboard/products/import/cancel", {
      organization_id: organizationId.trim(),
      job_id: importUploadId,
    });
    const data = res.data as { ok?: boolean; error?: string } | null;
    if (!res.ok || !data?.ok) {
      setErrorMsg(typeof data?.error === "string" ? data.error : "Cancel request failed.");
      return;
    }
    setBusyKind(null);
    setErrorMsg(null);
    setSuccessMessage("Job cancelled.");
    setPhase("error");
    void refreshHistory();
  }

  async function resumeImportFromHistoryRow(row: PimImportSessionListRow) {
    if (!organizationId?.trim()) return;
    const oid = organizationId.trim();
    const sid = String((row.metadata as { import_store_id?: string } | null)?.import_store_id ?? "").trim();
    if (sid && pimStores.some((s) => s.id === sid)) setSelectedStoreId(sid);
    const useStore = (sid && pimStores.some((s) => s.id === sid) ? sid : selectedStoreId).trim();
    if (!useStore) {
      setErrorMsg("This session has no target store in metadata — pick the correct store above.");
      return;
    }
    setImportUploadId(row.upload_id);
    setImportSessionId(row.session_id);
    setActiveImportFileLabel(row.file_name);
    setErrorMsg(null);
    const snap = await fetchPimImportPreviewSnapshot({ organizationId: oid, uploadId: row.upload_id });
    if (!snap.ok) {
      setErrorMsg(snap.error);
      return;
    }
    const life = String(snap.pim_import_job?.lifecycle ?? "").toLowerCase();
    const pstat = String(snap.preview_status ?? "").toLowerCase();
    const pqNorm = normalizePimPreviewQuality(snap.preview_quality);
    const pr = snap.pim_preview_result;
    const map =
      pr && typeof pr.mapping === "object" && pr.mapping !== null && !Array.isArray(pr.mapping)
        ? (pr.mapping as Record<string, string>)
        : {};
    // Detect if this session was originally safe-rows-only and preserve the flag
    const rowSafeOnly =
      Boolean((row.metadata as unknown as Record<string, unknown> | null)?.pim_import_safe_rows_only) ||
      Boolean((snap as unknown as Record<string, unknown>)?.pim_import_safe_rows_only);
    if (rowSafeOnly) setWasSafeRowsOnly(true);
    if ((pstat === "preview_ready" || life === "waiting_for_confirmation") && pqNorm) {
      setPreviewQuality(pqNorm);
      setColumnMapping(map);
      setMappingSource(typeof pr?.mapping_source === "string" ? pr.mapping_source : null);
      if (snap.pim_import_session_id) setImportSessionId(snap.pim_import_session_id);
      setPhase("preview_ready");
      setSuccessMessage("Session loaded from history — confirm import when ready.");
      void refreshHistory();
      return;
    }
    if (life === "previewing" || pstat === "previewing") {
      setBusyKind("preview");
      setPhase("uploading");
      try {
        await runPimPreviewChunkPoll(oid, useStore, row.upload_id);
      } finally {
        setBusyKind(null);
        setTimeout(() => {
          setProgressPct(0);
          setUiStageLabel("");
        }, 600);
      }
      void refreshHistory();
      return;
    }
    if (life === "importing" || life === "import_queued") {
      if (pqNorm) setPreviewQuality(pqNorm);
      setBusyKind("apply");
      setPhase("uploading");
      try {
        await runPimApplyChunkPoll(oid, useStore, row.upload_id, { skipConflicts: rowSafeOnly });
      } finally {
        setBusyKind(null);
        setTimeout(() => {
          setProgressPct(0);
          setUiStageLabel("");
        }, 800);
      }
      void refreshHistory();
      return;
    }
    if (life === "failed") {
      if (pqNorm) setPreviewQuality(pqNorm);
      setColumnMapping(map);
      const stageLbl = String(snap.pim_import_job?.stage_label ?? "").toLowerCase();
      const partial = stageLbl === "import_partial_failed" || pstat === "import_partial_failed";
      const leRaw =
        snap.pim_import_job && typeof snap.pim_import_job.last_error === "string" ? snap.pim_import_job.last_error : "";
      setErrorMsg(
        leRaw.trim()
          ? leRaw.trim()
          : partial
            ? "Import paused after writing rows — resume from checkpoint in the Active import card."
            : "Import failed — retry from checkpoint.",
      );
      setPhase("error");
      void refreshActiveJobSnap();
      void refreshHistory();
    }
  }

  async function confirmImportFromHistoryRow(row: PimImportSessionListRow) {
    if (!organizationId?.trim()) return;
    const oid = organizationId.trim();
    const sid = String((row.metadata as { import_store_id?: string } | null)?.import_store_id ?? "").trim();
    if (sid && pimStores.some((s) => s.id === sid)) setSelectedStoreId(sid);
    const useStore = (sid && pimStores.some((s) => s.id === sid) ? sid : selectedStoreId).trim();
    if (!useStore) {
      setErrorMsg("This session has no target store in metadata — pick the correct store above.");
      return;
    }
    const snap = await fetchPimImportPreviewSnapshot({ organizationId: oid, uploadId: row.upload_id });
    if (!snap.ok) {
      setErrorMsg(snap.error);
      return;
    }
    const life = String(snap.pim_import_job?.lifecycle ?? "").toLowerCase();
    const pstat = String(snap.preview_status ?? "").toLowerCase();
    if (pstat === "import_partial_failed") {
      setErrorMsg("This job stopped mid-import — use Resume import from the Active import card (or Reset) before confirming again.");
      return;
    }
    if (!(pstat === "preview_ready" || life === "waiting_for_confirmation" || life === "preview_ready")) {
      setErrorMsg("Preview is not ready for this session — resume preview first.");
      return;
    }
    const pqNorm = normalizePimPreviewQuality(snap.preview_quality);
    if (!pqNorm) {
      setErrorMsg("No preview metrics found — run Preview again.");
      return;
    }
    if (pqNorm.apply_blocked_by_dirty_rate) {
      setErrorMsg(
        `Import blocked: dirty rate ${String(pqNorm.dirty_rate ?? "—")} exceeds maximum ${String(pqNorm.max_dirty_rate ?? "—")}. Clean the sheet, re-preview, or raise PIM_SEED_MAX_DIRTY_RATE on the ETL server.`,
      );
      return;
    }
    if (pqNorm.apply_blocked_by_conflicts) {
      setErrorMsg("Import blocked: preview has blocking identifier conflicts.");
      return;
    }
    const pr = snap.pim_preview_result;
    const map =
      pr && typeof pr.mapping === "object" && pr.mapping !== null && !Array.isArray(pr.mapping)
        ? (pr.mapping as Record<string, string>)
        : {};
    setImportUploadId(row.upload_id);
    setImportSessionId(row.session_id);
    setActiveImportFileLabel(row.file_name);
    setPreviewQuality(pqNorm);
    setColumnMapping(map);
    setMappingSource(typeof pr?.mapping_source === "string" ? pr.mapping_source : null);
    if (snap.pim_import_session_id) setImportSessionId(snap.pim_import_session_id);
    setErrorMsg(null);
    setPhase("uploading");
    setBusyKind("apply");
    setMetrics(null);
    setSuccessMessage(null);
    setProgressPct(8);
    setUiStageLabel("Importing…");
    try {
      const conf = await postDashboardPimImport("/api/dashboard/products/import/confirm", {
        organization_id: oid,
        job_id: row.upload_id,
      });
      const confData = conf.data as { ok?: boolean; error?: string } | null;
      if (!conf.ok || !confData?.ok) {
        setErrorMsg(typeof confData?.error === "string" ? confData.error : `Confirm failed (${conf.status}).`);
        setPhase("error");
        return;
      }
      await runPimApplyChunkPoll(oid, useStore, row.upload_id);
    } catch (err) {
      setErrorMsg(axiosMessage(err, "Import failed."));
      setPhase("error");
      void refreshHistory();
    } finally {
      setBusyKind(null);
      setTimeout(() => {
        setProgressPct(0);
        setUiStageLabel("");
      }, 800);
    }
  }

  async function retryPreviewFromHistoryRow(row: PimImportSessionListRow) {
    if (!organizationId?.trim()) return;
    const oid = organizationId.trim();
    const sid = String((row.metadata as { import_store_id?: string } | null)?.import_store_id ?? "").trim();
    if (sid && pimStores.some((s) => s.id === sid)) setSelectedStoreId(sid);
    const useStore = (sid && pimStores.some((s) => s.id === sid) ? sid : selectedStoreId).trim();
    if (!useStore) {
      setErrorMsg("This session has no target store in metadata — pick the correct store above.");
      return;
    }
    if (!window.confirm(`Re-run preview scan for ${row.file_name}?`)) return;
    const res = await retryPimImportPreviewSession({
      organizationId: oid,
      storeId: useStore,
      uploadId: row.upload_id,
    });
    if (!res.ok) {
      setErrorMsg(res.error);
      return;
    }
    setImportUploadId(row.upload_id);
    setImportSessionId(row.session_id);
    setActiveImportFileLabel(row.file_name);
    setErrorMsg(null);
    setBusyKind("preview");
    setPhase("uploading");
    try {
      await runPimPreviewChunkPoll(oid, useStore, row.upload_id);
    } finally {
      setBusyKind(null);
      setTimeout(() => {
        setProgressPct(0);
        setUiStageLabel("");
      }, 600);
    }
    void refreshHistory();
  }

  async function deleteHistoryImportRow(row: PimImportSessionListRow) {
    if (!organizationId?.trim()) return;
    await openPimImportDeleteModal(row);
  }

  async function bulkDeleteSelectedHistory() {
    const oid = organizationId?.trim();
    if (!oid || historySelectedIds.size === 0) return;
    const uploadIds = historyRows.filter((r) => historySelectedIds.has(r.session_id)).map((r) => r.upload_id);
    if (uploadIds.length === 0) return;
    if (
      !window.confirm(
        `Delete ${uploadIds.length} import session(s)? Uploaded chunk files in storage for these jobs will be removed (products already imported stay in the catalog).`,
      )
    )
      return;
    const res = await deletePimImportUploads({ organizationId: oid, uploadIds });
    if (!res.ok) {
      setErrorMsg(res.error);
      return;
    }
    setHistorySelectedIds(new Set());
    if (importUploadId && uploadIds.includes(importUploadId)) {
      resetImport();
    }
    void refreshHistory();
  }

  async function resetHistoryImportJob(row: PimImportSessionListRow) {
    if (!organizationId?.trim()) return;
    if (
      !window.confirm(
        `Reset checkpoint for ${row.file_name}? Apply progress is cleared and you must confirm import again. Catalog products already created are not removed.`,
      )
    )
      return;
    const res = await postDashboardPimImport("/api/dashboard/products/import/reset", {
      organization_id: organizationId.trim(),
      job_id: row.upload_id,
    });
    const data = res.data as { ok?: boolean; error?: string } | null;
    if (!res.ok || !data?.ok) {
      setErrorMsg(typeof data?.error === "string" ? data.error : "Reset failed.");
      return;
    }
    setSuccessMessage("Import job reset — confirm again before applying.");
    void refreshHistory();
  }

  async function cancelHistoryImportRow(row: PimImportSessionListRow) {
    if (!organizationId?.trim()) return;
    if (!window.confirm(`Cancel active job for ${row.file_name}?`)) return;
    const res = await postDashboardPimImport("/api/dashboard/products/import/cancel", {
      organization_id: organizationId.trim(),
      job_id: row.upload_id,
    });
    const data = res.data as { ok?: boolean; error?: string } | null;
    if (!res.ok || !data?.ok) {
      setErrorMsg(typeof data?.error === "string" ? data.error : "Cancel failed.");
      return;
    }
    void refreshHistory();
  }

  async function confirmClearStalePimUploads() {
    const oid = organizationId?.trim();
    const sid = selectedStoreId.trim();
    if (!oid || !sid) return;
    setClearStaleModalOpen(false);
    const res = await clearStalePimUploadsForStore({ organizationId: oid, storeId: sid });
    if (!res.ok) {
      setErrorMsg("error" in res ? res.error : "Clear failed.");
      return;
    }
    if (res.deletedUploadIds.length && importUploadId && res.deletedUploadIds.includes(importUploadId)) {
      resetImport();
    }
    setSuccessMessage(
      res.candidateCount ? `Removed ${res.deletedUploadIds.length} stale / unlinked upload(s).` : "No stale uploads matched.",
    );
    void refreshHistory();
  }

  async function clearStagingHistoryRow(row: PimImportSessionListRow) {
    if (!organizationId?.trim()) return;
    if (
      !window.confirm(
        "Remove merged workbook and CSV scan cache from storage for this session? You can run Preview again afterward.",
      )
    )
      return;
    const res = await fetch(`/api/dashboard/products/import/sessions/${encodeURIComponent(row.session_id)}/clear-staging`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ organization_id: organizationId.trim() }),
    });
    const data = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
    if (!res.ok || !data?.ok) {
      setErrorMsg(typeof data?.error === "string" ? data.error : "Clear staging failed.");
      return;
    }
    setErrorMsg(null);
    setSuccessMessage("Preview staging files cleared for this session.");
    void refreshHistory();
  }

  async function openActiveImportDebugPanel() {
    const oid = organizationId?.trim();
    const uid = importUploadId?.trim();
    if (!oid || !uid) return;
    const snap = await fetchPimImportPreviewSnapshot({ organizationId: oid, uploadId: uid });
    const raw = snap.ok ? JSON.stringify(snap, null, 2).slice(0, 14000) : JSON.stringify({ error: snap.error }, null, 2);
    setPreviewDiag({
      jobId: uid,
      stage: "upload_snapshot",
      raw,
      route: "fetchPimImportPreviewSnapshot (active import card)",
      flow: "preview",
    });
    setShowPreviewDebug(true);
  }

  async function retryPreviewForActiveUpload() {
    const oid = organizationId?.trim();
    const sid = selectedStoreId.trim();
    const jid = importUploadId?.trim();
    if (!oid || !sid || !jid) return;
    if (!window.confirm("Re-run preview for this upload job?")) return;
    setErrorMsg(null);
    setBusyKind("preview");
    setPhase("uploading");
    try {
      const res = await retryPimImportPreviewSession({ organizationId: oid, storeId: sid, uploadId: jid });
      if (!res.ok) {
        setErrorMsg(res.error);
        setPhase("error");
        return;
      }
      await runPimPreviewChunkPoll(oid, sid, jid);
    } finally {
      setBusyKind(null);
      setTimeout(() => {
        setProgressPct(0);
        setUiStageLabel("");
      }, 600);
    }
    void refreshHistory();
    void refreshActiveJobSnap();
  }

  async function resetActivePimImportJob() {
    const oid = organizationId?.trim();
    const jid = importUploadId?.trim();
    if (!oid || !jid) return;
    if (
      !window.confirm(
        "Reset this import job? Clears the apply checkpoint and unconfirms — catalog products already written are not removed.",
      )
    )
      return;
    clearProgressTimer();
    const res = await postDashboardPimImport("/api/dashboard/products/import/reset", {
      organization_id: oid,
      job_id: jid,
    });
    const data = res.data as { ok?: boolean; error?: string } | null;
    if (!res.ok || !data?.ok) {
      setErrorMsg(typeof data?.error === "string" ? data.error : "Reset failed.");
      return;
    }
    setSuccessMessage("Active import reset — pick a file and run Preview again.");
    resetImport();
    void refreshHistory();
  }

  async function openPimImportDeleteModal(row: PimImportSessionListRow | null) {
    const oid = organizationId?.trim();
    if (!oid) return;
    const uid = (row?.upload_id ?? importUploadId)?.trim();
    if (!uid) return;
    const snap = await fetchPimImportPreviewSnapshot({ organizationId: oid, uploadId: uid });
    let warnCatalog = false;
    if (snap.ok && snap.pim_import_job && typeof snap.pim_import_job === "object") {
      const am = (snap.pim_import_job as { apply_metrics?: Record<string, unknown> }).apply_metrics;
      if (am && typeof am === "object") {
        const pc = Number(am.products_created ?? 0);
        const pu = Number(am.products_updated ?? 0);
        const pr = Number(am.prices_inserted ?? 0);
        warnCatalog = pc + pu + pr > 0;
      }
    }
    const fileLabel =
      row?.file_name?.trim() ||
      activeImportFileLabel?.trim() ||
      file?.name?.trim() ||
      "this import";
    setImportDeleteModal({ uploadId: uid, fileLabel, warnCatalog, historyRow: row });
  }

  async function confirmPimImportDeleteModal() {
    if (!importDeleteModal || !organizationId?.trim()) return;
    const oid = organizationId.trim();
    const res = await deletePimImportUploads({ organizationId: oid, uploadIds: [importDeleteModal.uploadId] });
    if (!res.ok) {
      setErrorMsg(res.error);
      setImportDeleteModal(null);
      return;
    }
    const deletedId = importDeleteModal.uploadId;
    setImportDeleteModal(null);
    if (importUploadId === deletedId) resetImport();
    void refreshHistory();
  }

  async function bulkResetSelectedHistory() {
    const oid = organizationId?.trim();
    if (!oid || historySelectedIds.size === 0) return;
    const rows = historyRows.filter((r) => historySelectedIds.has(r.session_id));
    if (!rows.length) return;
    if (!window.confirm(`Reset ${rows.length} import job(s)? Clears apply checkpoints; catalog products are not removed.`)) return;
    let okN = 0;
    for (const row of rows) {
      const res = await postDashboardPimImport("/api/dashboard/products/import/reset", {
        organization_id: oid,
        job_id: row.upload_id,
      });
      const data = res.data as { ok?: boolean; error?: string } | null;
      if (res.ok && data?.ok) okN += 1;
    }
    setHistorySelectedIds(new Set());
    setSuccessMessage(okN ? `Reset ${okN} job(s).` : "No jobs were reset.");
    void refreshHistory();
  }

  const isBusy = phase === "uploading";
  /** Show the drop zone only when there is no in-flight or existing upload for this session. */
  const showDropZone = !importUploadId && (phase === "idle" || phase === "selected");
  const canSync =
    Boolean(organizationId) && !profileLoading && Boolean(selectedStoreId.trim()) && pimStores.length > 0;

  const lifeS = (activeJobSnap?.lifecycle ?? "").toLowerCase();
  const pstatS = (activeJobSnap?.preview_status ?? "").toLowerCase();
  const stageS = (activeJobSnap?.stage_label ?? "").toLowerCase();
  const partialFailed = stageS === "import_partial_failed" || pstatS === "import_partial_failed";
  const serverImporting = lifeS === "importing" || lifeS === "import_queued";
  const serverPreviewing = lifeS === "previewing" || pstatS === "previewing";
  const serverCancelled = lifeS === "cancelled" || pstatS === "cancelled";
  const activeStatusDisplay = pimActiveImportDisplayStatus(phase, busyKind, activeJobSnap);
  const activeStoreLabel = pimStores.find((s) => s.id === selectedStoreId.trim())?.display_name || "Selected store";

  const btnPrimary =
    "inline-flex items-center justify-center rounded-lg bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground shadow-sm transition hover:opacity-95 disabled:cursor-not-allowed disabled:opacity-45";
  const btnSecondary =
    "inline-flex items-center justify-center rounded-lg border border-border bg-background px-3 py-2 text-sm font-medium text-foreground shadow-sm transition hover:bg-muted/50 disabled:cursor-not-allowed disabled:opacity-45";
  const btnDanger =
    "inline-flex items-center justify-center rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm font-medium text-destructive transition hover:bg-destructive/15 disabled:cursor-not-allowed disabled:opacity-45";

  return (
    <section
      className="rounded-2xl border border-border/60 bg-card/70 p-6 shadow-xl backdrop-blur-md dark:bg-card/50 sm:p-8"
      aria-labelledby="import-heading"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h2 id="import-heading" className="text-lg font-semibold text-foreground">
          Quick catalog file import
        </h2>
        <PimHelpNote label="Quick file import help">
          <div className="space-y-2">
            <div>
              Supported: <strong>.csv</strong>, <strong>.txt</strong> (delimiter detected in preview), <strong>.xlsx</strong>, <strong>.xlsm</strong>.
              Preview is read-only; confirm writes to the selected store only.
            </div>
            <div>
              Excel runs non-empty sheets in order; column mapping can reuse when headers match the first sheet. Use Managed imports below for
              larger or staged jobs.
            </div>
            <div>If the AI module is enabled, mapping or validation may be assisted automatically.</div>
          </div>
        </PimHelpNote>
      </div>
      <p className="mt-1 text-sm text-muted-foreground">Upload a file to preview, then confirm to seed this store.</p>

      <div className="mt-4 flex flex-col gap-2 rounded-xl border border-sky-200/80 bg-sky-50/50 px-4 py-3 text-sm dark:border-sky-800/50 dark:bg-sky-950/25">
        <div className="flex flex-wrap items-center gap-2">
          <p className="font-medium text-sky-950 dark:text-sky-100">Managed imports</p>
          <PimHelpNote label="Managed imports">
            <div>Use the Imports pipeline for large files, multi-format jobs, and staged review instead of this quick seed.</div>
          </PimHelpNote>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link
            href="/dashboard/file-import"
            className="inline-flex items-center gap-1.5 rounded-lg border border-sky-300 bg-background px-3 py-1.5 text-xs font-semibold text-sky-900 shadow-sm transition hover:bg-sky-100 dark:border-sky-700 dark:text-sky-100 dark:hover:bg-sky-900/40"
          >
            <FileSpreadsheet className="h-3.5 w-3.5" aria-hidden />
            Imports
          </Link>
          <CatalogSheetsSettingsLink />
        </div>
      </div>

      <div className="mt-4 rounded-lg border border-border bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
        <p>
          <span className="font-medium text-foreground">Workspace:</span>{" "}
          {profileLoading ? "…" : organizationName || "—"}
        </p>
        {!profileLoading && !organizationId ? (
          <p className="mt-1 text-amber-800 dark:text-amber-200">
            No organization in scope. Choose a company from the header (super admins may switch workspace).
          </p>
        ) : null}
        {!profileLoading && organizationId && !pimFormLoading && pimStores.length === 0 ? (
          <p className="mt-1 text-amber-800 dark:text-amber-200">
            No stores found for this organization. Create a store before importing (imports are always scoped to one
            store).
          </p>
        ) : null}
        {pimFormLoading && organizationId ? (
          <p className="mt-1 flex items-center gap-1.5 text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
            Loading stores…
          </p>
        ) : null}
      </div>

      {organizationId && !profileLoading && pimStores.length > 0 ? (
        <div className="mt-4 space-y-1.5">
          <label htmlFor="pim-seed-store" className="text-xs font-medium text-foreground">
            Target store (required)
          </label>
          <select
            id="pim-seed-store"
            className="w-full max-w-md rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
            value={selectedStoreId}
            onChange={(e) => setSelectedStoreId(e.target.value)}
            disabled={isBusy || pimFormLoading}
          >
            {pimStores.map((s) => (
              <option key={s.id} value={s.id}>
                {s.display_name || s.id}
              </option>
            ))}
          </select>
          {pimDebugEnabled && storeImportStats ? (
            <div className="mt-3 rounded-lg border border-border/50 bg-muted/20 px-3 py-2.5 text-xs text-muted-foreground">
              <p className="mb-2 font-medium text-foreground">Store import stats (current selection)</p>
              <dl className="grid gap-1.5 sm:grid-cols-2 lg:grid-cols-4">
                <div>
                  <dt className="text-[11px] uppercase tracking-wide text-muted-foreground">PIM raw uploads (ensure scan)</dt>
                  <dd className="font-mono text-sm text-foreground">{storeImportStats.rawInEnsureScan}</dd>
                </div>
                <div>
                  <dt className="text-[11px] uppercase tracking-wide text-muted-foreground">PIM uploads for store (scan)</dt>
                  <dd className="font-mono text-sm text-foreground">{storeImportStats.sessionRowsInDb}</dd>
                </div>
                <div>
                  <dt className="text-[11px] uppercase tracking-wide text-muted-foreground">Backfilled</dt>
                  <dd className="font-mono text-sm text-foreground">{storeImportStats.backfilled}</dd>
                </div>
                <div className="min-w-0 sm:col-span-2 lg:col-span-1">
                  <dt className="text-[11px] uppercase tracking-wide text-muted-foreground">Active import candidate</dt>
                  <dd className="truncate font-mono text-sm text-foreground" title={storeImportStats.suggestedActive?.file_name ?? ""}>
                    {storeImportStats.suggestedActive
                      ? storeImportStats.suggestedActive.file_name || storeImportStats.suggestedActive.upload_id.slice(0, 8) + "…"
                      : "—"}
                  </dd>
                </div>
              </dl>
              <p className="mt-2 border-t border-border/40 pt-2 text-[11px] leading-snug">
                Counts come from <span className="font-medium text-foreground/90">raw_report_uploads</span> only (newest ≤800 rows fetched,
                filtered by metadata store id). No <span className="font-medium text-foreground/90">pim_import_sessions</span> table.
              </p>
            </div>
          ) : null}
          {pimDebugEnabled && organizationId && selectedStoreId.trim() ? (
            <div className="mt-3 rounded-lg border border-dashed border-primary/35 bg-primary/5 px-3 py-2.5 font-mono text-[11px] text-foreground">
              <p className="mb-1.5 font-sans text-xs font-semibold text-foreground">PIM Quick Import debug</p>
              <div className="space-y-1 text-muted-foreground">
                <div>
                  raw_report_uploads PIM rows (store scan):{" "}
                  <span className="text-foreground">{storeImportStats?.rawInEnsureScan ?? "—"}</span>
                </div>
                <div>
                  Active UI upload id: <span className="text-foreground">{importUploadId ?? "—"}</span>
                  {" · "}
                  file: <span className="text-foreground">{activeImportFileLabel ?? "—"}</span>
                </div>
                <div>
                  Suggested active (from history):{" "}
                  <span className="text-foreground">
                    {storeImportStats?.suggestedActive
                      ? `${storeImportStats.suggestedActive.upload_id} · ${storeImportStats.suggestedActive.file_name}`
                      : "—"}
                  </span>
                </div>
                <div>
                  History rows loaded: <span className="text-foreground">{pimImportDebugSnapshot.historyLen}</span>
                  {" · "}
                  reset/deleted-ish rows (approx):{" "}
                  <span className="text-foreground">{pimImportDebugSnapshot.resetOrDeleted}</span>
                </div>
                <div className="pt-1">
                  preview_status histogram:{" "}
                  <span className="break-all text-foreground">
                    {JSON.stringify(pimImportDebugSnapshot.byStatus)}
                  </span>
                </div>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}


      <div className="mt-6 space-y-6">
        {/* When active job exists, offer a small "upload another" link instead of the full dropzone */}
        {!showDropZone && importUploadId && !isBusy ? (
          <div className="flex justify-center">
                  <button
                    type="button"
              className="text-sm font-medium text-primary underline-offset-4 hover:underline"
              onClick={() => {
                const ok = window.confirm(
                  "You already have an active import session.\n\nClick OK to start a new upload (you can still access the current job in history).\n\nOr Cancel and use Reset or Delete on the current job card below first.",
                );
                if (ok) {
                  resetImport();
                }
              }}
            >
              <UploadCloud className="mr-1.5 inline h-3.5 w-3.5" aria-hidden />
              Upload another file
                  </button>
            </div>
              ) : null}
        {showDropZone && (
          <div
            role="button"
            tabIndex={0}
            aria-label="Drop zone for product CSV, TXT, or Excel"
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            onClick={() => !isBusy && fileInputRef.current?.click()}
            onKeyDown={(e) => {
              if (!isBusy && (e.key === "Enter" || e.key === " ")) {
                e.preventDefault();
                fileInputRef.current?.click();
              }
            }}
            className={[
              "flex cursor-pointer flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed px-6 py-14 text-center transition-colors",
              isBusy ? "pointer-events-none opacity-60" : "",
              isDragging
                ? "border-sky-400 bg-sky-50/50 dark:border-sky-500 dark:bg-sky-950/30"
                : file && phase !== "idle"
                  ? "border-emerald-400/80 bg-emerald-50/30 dark:border-emerald-600 dark:bg-emerald-950/20"
                  : "border-border bg-muted/20 hover:border-primary/40 hover:bg-muted/35",
            ].join(" ")}
          >
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv,.txt,.xlsx,.xlsm,text/plain,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              className="hidden"
              disabled={isBusy}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) acceptFile(f);
              }}
            />
            <div className="flex h-14 w-14 items-center justify-center rounded-2xl border border-border/60 bg-background/80 shadow-inner">
              <UploadCloud className={`h-7 w-7 ${file ? "text-emerald-500" : "text-primary"}`} />
            </div>
            {file && phase !== "idle" ? (
              <>
                <div className="flex items-center gap-2">
                  <FileSpreadsheet className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                  <span className="text-sm font-semibold text-emerald-800 dark:text-emerald-200">{file.name}</span>
                </div>
                {profileLoading ? (
                  <p className="max-w-md text-xs text-muted-foreground">Resolving workspace…</p>
                ) : !organizationId ? (
                  <p className="max-w-md text-xs text-amber-800 dark:text-amber-200">Select a workspace organization before syncing.</p>
                ) : null}
                <div className="mt-2 flex flex-wrap items-center justify-center gap-2">
                  <button
                    type="button"
                    disabled={isBusy || !canSync}
                    onClick={(e) => {
                      e.stopPropagation();
                      void runCatalogPreview();
                    }}
                    className="inline-flex h-10 items-center gap-2 rounded-lg border border-border bg-background px-4 text-sm font-semibold text-foreground shadow-sm transition hover:bg-muted/50 disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {isBusy && busyKind === "preview" ? (
                      <>
                        <Loader2 className="h-4 w-4 animate-spin" />
                        Scanning…
                      </>
                    ) : (
                      <>
                        <Table2 className="h-4 w-4" />
                        Preview import
                      </>
                    )}
                  </button>
                  {(busyKind === "preview" || busyKind === "apply") && importUploadId ? (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        void cancelActiveImportJob();
                      }}
                      className="inline-flex h-10 items-center gap-2 rounded-lg border border-destructive/40 bg-background px-4 text-sm font-semibold text-destructive shadow-sm transition hover:bg-destructive/10"
                    >
                      <Ban className="h-4 w-4" aria-hidden />
                      Cancel
                    </button>
                  ) : null}
                </div>
              </>
            ) : (
              <>
                <p className="text-sm font-medium text-foreground">Drag and drop your file here</p>
                <p className="text-xs text-muted-foreground">or click to browse — .csv, .txt, .xlsx, or .xlsm</p>
              </>
            )}
          </div>
        )}

        {errorMsg && (
          <div
            className="rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm"
            role="alert"
          >
            <p className="font-semibold text-destructive">
              {busyKind === "apply" || (previewDiag?.flow === "apply")
                ? "Import failed"
                : busyKind === "preview" || (previewDiag?.flow === "preview")
                  ? "Preview failed"
                  : "Import error"}
              {activeImportFileLabel ? (
                <span className="ml-1 font-normal text-destructive/80">— {activeImportFileLabel}</span>
              ) : null}
            </p>
            <p className="mt-1 text-destructive/90">{errorMsg}</p>
            <p className="mt-1.5 text-xs text-destructive/70">
              {partialFailed
                ? "Some rows were already written. Use Resume import to continue from the checkpoint."
                : serverCancelled
                  ? "The job was cancelled. Use Resume import to restart."
                  : "Use Retry import or Retry preview below. View details for the raw server error."}
            </p>
              </div>
        )}



        <div className="mt-6 rounded-xl border border-border/60 bg-muted/10 p-4 sm:p-5 shadow-sm">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-base font-semibold text-foreground">Import history</h3>
                  <PimHelpNote label="Import history">
                <div className="max-w-sm space-y-2 text-xs leading-relaxed">
                  <div>
                    One panel: toolbar on top, then the <strong>current file</strong> block (preview / confirm / details), then the framed <strong>session list</strong> (table or empty state). Refresh and bulk actions apply to that list.
                  </div>
                  <div>Use row actions for resume, reset, price import, or diagnostics.</div>
                </div>
              </PimHelpNote>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {historySelectedIds.size > 0 ? (
                <>
                  <button
                    type="button"
                    disabled={historyLoading || !organizationId}
                    onClick={() => void bulkResetSelectedHistory()}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1 text-xs font-medium text-foreground transition hover:bg-muted/50 disabled:opacity-50"
                  >
                    Reset selected ({historySelectedIds.size})
                  </button>
                  <button
                    type="button"
                    disabled={historyLoading || !organizationId}
                    onClick={() => void bulkDeleteSelectedHistory()}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-destructive/40 bg-destructive/10 px-2.5 py-1 text-xs font-medium text-destructive transition hover:bg-destructive/15 disabled:opacity-50"
                  >
                    Delete selected ({historySelectedIds.size})
                  </button>
                </>
              ) : null}
              {perms.isAtLeast("admin") ? (
                <button
                  type="button"
                  disabled={historyLoading || !organizationId}
                  onClick={() => setClearStaleModalOpen(true)}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-amber-700/40 bg-amber-500/10 px-2.5 py-1 text-xs font-medium text-amber-950 transition hover:bg-amber-500/15 disabled:opacity-50 dark:text-amber-100"
                >
                  Clear stale uploads
                </button>
              ) : null}
              <button
                type="button"
                disabled={historyLoading || !organizationId}
                onClick={() => void refreshHistory()}
                className="inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1 text-xs font-medium text-foreground transition hover:bg-muted/50 disabled:opacity-50"
              >
                <RefreshCw className={`h-3.5 w-3.5 ${historyLoading ? "animate-spin" : ""}`} aria-hidden />
                Refresh
              </button>
            </div>
          </div>
          <p className="mb-3 text-sm text-muted-foreground">
            Use the toolbar on this card for <span className="font-medium text-foreground">Refresh</span>, bulk actions, and clearing stale uploads.
            The bordered block below is the <span className="font-medium text-foreground">current file</span>; the <span className="font-medium text-foreground">session list</span> is the framed section under it.
          </p>

          <div id="pim-import-history-current" className="mb-4 space-y-4 rounded-xl border border-primary/20 bg-card/80 p-4 shadow-sm">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/40 pb-2">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Current file &amp; actions</p>
            </div>
            {(importUploadId && organizationId) ? (
              isBusy ? (
                <div className="flex flex-col items-center justify-center gap-4 rounded-xl border border-primary/20 bg-primary/5 px-6 py-12">
                <Loader2 className="h-12 w-12 animate-spin text-primary" aria-label="Loading" />
                  <div className="text-center space-y-1">
                    <p className="text-sm font-semibold text-foreground">{activeImportFileLabel || file?.name || "—"}</p>
                    <p className="text-sm font-medium text-foreground">{friendlyStageLabel(uiStageLabel) || "Working…"}</p>
                    <p className="text-xs text-muted-foreground">{activeStoreLabel}</p>
                  </div>
                {busyKind === "preview" && previewProgressLine ? (
                  <p className="text-center text-xs font-mono text-muted-foreground">{previewProgressLine}</p>
                ) : null}
                {busyKind === "apply" && applyPartialMetrics ? (
                  <div className="w-full max-w-lg rounded-lg border border-border/50 bg-card/60 px-3 py-2 text-left text-[11px] text-muted-foreground">
                    <p className="font-medium text-foreground">Apply progress (partial)</p>
                    <ul className="mt-1 grid gap-0.5 sm:grid-cols-2">
                      <li>
                        Products created {applyPartialMetrics.products_created ?? 0}, updated {applyPartialMetrics.products_updated ?? 0}
                      </li>
                      <li>
                        Vendors +{applyPartialMetrics.vendors_created ?? 0} new · reused {applyPartialMetrics.vendors_reused ?? 0}
                      </li>
                      <li>
                        Categories +{applyPartialMetrics.categories_created ?? 0} new · reused {applyPartialMetrics.categories_reused ?? 0}
                      </li>
                      <li>Identifier rows +{applyPartialMetrics.identifiers_created ?? applyPartialMetrics.skus_mapped ?? 0}</li>
                      <li>Prices inserted {applyPartialMetrics.prices_inserted ?? 0}</li>
                    </ul>
                  </div>
                ) : null}
                <div className="h-2 w-full max-w-md overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full rounded-full bg-primary transition-[width] duration-300"
                    style={{ width: `${Math.min(100, Math.max(0, progressPct))}%` }}
                  />
                </div>
                <p className="text-center text-xs text-muted-foreground">
                  {busyKind === "apply"
                    ? "Import runs on the server in steps; this screen updates as each step finishes."
                    : "Preview runs on the server in steps; this screen updates as each step finishes."}
                </p>
                  <div className="flex flex-wrap justify-center gap-2">
                    {busyKind === "apply" ? (
                      <>
                        <button
                          type="button"
                          className={`${btnSecondary} border-destructive/50 text-destructive hover:bg-destructive/10`}
                          onClick={() => void cancelActiveImportJob()}
                        >
                          Cancel import
                        </button>
                        <button type="button" className={btnSecondary} onClick={() => void refreshActiveJobSnap()}>
                          Refresh status
                        </button>
                      </>
                    ) : null}
                    {busyKind === "preview" ? (
                      <button
                        type="button"
                        className={`${btnSecondary} border-destructive/50 text-destructive hover:bg-destructive/10`}
                        onClick={() => void cancelActiveImportJob()}
                      >
                        Cancel preview
                      </button>
                    ) : null}
              </div>
                </div>
              ) : (
                <div className="rounded-xl border border-border/70 bg-card/90 p-5 shadow-sm">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0 flex-1 space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <PimStatusBadge label={activeStatusDisplay.label} tone={activeStatusDisplay.tone} />
                      </div>
                      <p className="truncate text-sm font-semibold text-foreground">{activeImportFileLabel || file?.name || "—"}</p>
                      <p className="text-xs text-muted-foreground">{activeStoreLabel}</p>
                    </div>
                  </div>
                  {phase === "preview_ready" && previewQuality?.apply_blocked_by_dirty_rate ? (
                    <div className="mt-3 flex flex-wrap items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 text-sm text-amber-950 dark:text-amber-50">
                      <p className="min-w-0 flex-1 leading-snug">
                        {(() => {
                          const total = Number(previewQuality.rows_total ?? 0);
                          const bad = Number(previewQuality.dirty_rows ?? previewQuality.skipped_dirty_row ?? 0);
                          return `Import blocked — ${bad.toLocaleString()} of ${total.toLocaleString()} rows failed validation. Review dirty rows, clean the file, or ask an admin to adjust the allowed failure rate.`;
                        })()}
                      </p>
                      <PimHelpNote label="About validation limits">
                        <div className="max-w-xs space-y-2 text-xs leading-relaxed">
                          <div>
                            An administrator can raise the allowed failure rate on the import service, or you can fix the spreadsheet and run
                            preview again.
                          </div>
                        </div>
                      </PimHelpNote>
                    </div>
                  ) : null}
                  <div className="mt-4 space-y-3 border-t border-border/50 pt-4">
                    <div className="flex flex-wrap gap-2">
                      {phase === "success" ? (
                        <>
                          <button
                            type="button"
                            className={btnSecondary}
                            onClick={() =>
                              document
                                .getElementById("pim-quick-import-success")
                                ?.scrollIntoView({ behavior: "smooth", block: "start" })
                            }
                          >
                            View results
                          </button>
                          <button type="button" className={btnPrimary} onClick={() => resetImport()}>
                            Import another file
                          </button>
                        </>
                      ) : null}
                      {phase === "error" && partialFailed ? (
                        <>
                          <button
                            type="button"
                            disabled={isBusy || !canSync}
                            className={btnPrimary}
                            onClick={() => void retryApplyFromCheckpoint()}
                          >
                            Resume import
                          </button>
                          <button
                            type="button"
                            disabled={isBusy || !canSync}
                            className={btnSecondary}
                            onClick={() => void retryApplyFromCheckpoint()}
                          >
                            Retry failed chunk
                          </button>
                          <button
                            type="button"
                            disabled={isBusy || !canSync}
                            className={btnSecondary}
                            onClick={() => void retryPreviewForActiveUpload()}
                          >
                            Retry preview
                          </button>
                          <button
                            type="button"
                            disabled={isBusy}
                            className={`${btnSecondary} border-destructive/50 text-destructive hover:bg-destructive/10`}
                            onClick={() => void cancelActiveImportJob()}
                          >
                            Cancel import
                          </button>
                        </>
                      ) : null}
                      {phase === "error" && !partialFailed && !serverCancelled ? (
                        <>
                          <button
                            type="button"
                            disabled={isBusy || !canSync}
                            className={btnPrimary}
                            onClick={() => void retryApplyFromCheckpoint()}
                          >
                            Retry import
                          </button>
                          <button
                            type="button"
                            disabled={isBusy || !canSync}
                            className={btnSecondary}
                            onClick={() => void retryPreviewForActiveUpload()}
                          >
                            Retry preview
                          </button>
                        </>
                      ) : null}
                      {phase === "error" && serverCancelled ? (
                        <>
                          <button
                            type="button"
                            disabled={isBusy || !canSync}
                            className={btnPrimary}
                            onClick={() => void retryApplyFromCheckpoint()}
                          >
                            Resume import
                          </button>
                          <button
                            type="button"
                            disabled={isBusy || !canSync}
                            className={btnSecondary}
                            onClick={() => void retryPreviewForActiveUpload()}
                          >
                            Retry preview
                          </button>
                        </>
                      ) : null}
                      {phase === "preview_ready" && !isBusy ? (
                        <>
                          <button
                            type="button"
                            disabled={
                              !canSync ||
                              !previewQuality ||
                              Boolean(previewQuality.apply_blocked_by_dirty_rate) ||
                              Boolean(previewQuality.apply_blocked_by_conflicts)
                            }
                            title={
                              previewQuality?.apply_blocked_by_dirty_rate
                                ? "Too many rows failed validation for the current safety limit."
                                : previewQuality?.apply_blocked_by_conflicts
                                  ? "Import has identifier conflicts — use Import safe rows only below."
                                  : undefined
                            }
                            className={btnPrimary}
                            onClick={() => void runCatalogApply()}
                          >
                            Confirm &amp; Import
                          </button>
                          <button
                            type="button"
                            disabled={!canSync}
                            className={btnSecondary}
                            onClick={() => void retryPreviewForActiveUpload()}
                          >
                            Retry preview
                          </button>
                          {previewQuality?.apply_blocked_by_conflicts ? (
                            <button
                              type="button"
                              disabled={!canSync}
                              className={`${btnSecondary} border-amber-600/50 text-amber-900 hover:bg-amber-500/15 dark:text-amber-100`}
                              title="Imports accepted rows only — skips the conflicting rows. Conflict details are preserved."
                              onClick={() => void runCatalogApply({ skipConflicts: true })}
                            >
                              Import safe rows only
                            </button>
                          ) : null}
                          {previewQuality &&
                          (Boolean(previewQuality.apply_blocked_by_dirty_rate) ||
                            Boolean(previewQuality.apply_blocked_by_conflicts)) ? (
                            <p className="basis-full text-sm text-amber-950 dark:text-amber-100">
                              {previewQuality.apply_blocked_by_dirty_rate
                                ? "Confirm stays off until fewer rows fail validation or an administrator raises the allowed failure rate."
                                : `Confirm & Import is blocked — ${previewQuality.conflict_rows_blocked ?? 0} rows have identifier conflicts. Use Import safe rows only to import the ${(previewQuality.rows_accepted_estimate ?? 0).toLocaleString()} accepted rows now. View & repair conflicts in the panel below.`}
                            </p>
                          ) : null}
                          {previewQuality && (previewQuality.prices_would_insert ?? 0) > 0 ? (
                            <p className="basis-full text-xs text-muted-foreground">
                              Price column(s): <span className="font-medium text-foreground">{(previewQuality.prices_would_insert ?? 0).toLocaleString()}</span>{" "}
                              price row(s) in preview — written on import. If counts are still short after import, use{" "}
                              <span className="font-medium text-foreground">Import prices to database</span> on this card (admins).
                            </p>
                          ) : null}
                        </>
                      ) : null}
                    </div>
                    <div className="flex flex-wrap gap-2 border-t border-border/40 pt-3">
                      <button
                        type="button"
                        className={btnSecondary}
                        aria-expanded={importDetailPanelsOpen}
                        onClick={() => {
                          setImportDetailPanelsOpen((v) => {
                            const next = !v;
                            if (next) {
                              window.setTimeout(() => {
                                document.getElementById("pim-import-detail-panels")?.scrollIntoView({ behavior: "smooth", block: "start" });
                              }, 0);
                            }
                            return next;
                          });
                        }}
                      >
                        {importDetailPanelsOpen ? "Hide details" : "View details"}
                      </button>
                      <button type="button" className={btnSecondary} onClick={() => setActiveImportDetailsOpen((v) => !v)}>
                        {activeImportDetailsOpen ? "Hide technical info" : "Technical info"}
                      </button>
                      {importUploadId &&
                      pimUiMayRunPriceBackfill(canonicalRoleKey) &&
                      (previewQuality?.prices_would_insert ?? 0) > 0 &&
                      !busyKind &&
                      (typeof metrics?.prices_inserted !== "number" ||
                        (previewQuality?.prices_would_insert ?? 0) > (metrics.prices_inserted ?? 0)) ? (
                        <button
                          type="button"
                          disabled={priceBackfillBusyUploadId !== null || isBusy}
                          className={btnPrimary}
                          onClick={() => void runActiveUploadPriceBackfill()}
                        >
                          {priceBackfillBusyUploadId ? "Importing prices…" : "Import prices to database"}
                        </button>
                      ) : null}
                      {phase !== "success" ? (
                        <button
                          type="button"
                          className={btnSecondary}
                          disabled={isBusy && busyKind === "apply"}
                          title={
                            isBusy && busyKind === "apply" ? "Cancel the import run before resetting this job." : undefined
                          }
                          onClick={() => void resetActivePimImportJob()}
                        >
                          Reset
                        </button>
                      ) : null}
                      <button type="button" className={btnDanger} onClick={() => void openPimImportDeleteModal(null)}>
                        Delete
                      </button>
                    </div>
                    {activeImportDetailsOpen ? (
                      <div className="space-y-2 rounded-lg border border-border/60 bg-muted/25 p-3 text-xs text-muted-foreground">
                        <p className="font-medium text-foreground">Diagnostic references</p>
                        <p className="break-all">
                          <span className="text-muted-foreground">Upload id: </span>
                          {importUploadId}
                        </p>
                        <p className="break-all">
                          <span className="text-muted-foreground">Session id: </span>
                          {importSessionId ?? "—"}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          Use the diagnostic log below for server error details.
                        </p>
                        {(pimDebugEnabled || perms.isAtLeast("admin")) ? (
                          <div className="flex flex-wrap gap-2 pt-1">
                            <button
                              type="button"
                              className="text-primary underline-offset-2 hover:underline"
                              onClick={() => void openActiveImportDebugPanel()}
                            >
                              {showPreviewDebug ? "Hide debug log" : "Open full diagnostic log"}
                            </button>
                          </div>
                        ) : null}
                        {showPreviewDebug && previewDiag?.raw ? (
                          <pre className="mt-2 max-h-64 overflow-auto rounded border border-border bg-muted/20 p-2 text-[10px] leading-relaxed">
                            {previewDiag.raw}
                          </pre>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                </div>
              )
            ) : null}

          {phase === "preview_ready" && previewQuality && !importDetailPanelsOpen ? (
          <div
            className="mb-4 rounded-lg border border-dashed border-border/70 bg-muted/10 px-4 py-3 text-xs text-muted-foreground"
            role="note"
          >
            <span className="font-medium text-foreground">Preview details</span> are hidden. Use{" "}
            <span className="font-medium text-foreground">View details</span> on the current file card above to show preview metrics, column
            mapping, and conflicts together.
          </div>
        ) : null}

          {importDetailPanelsOpen && phase === "preview_ready" && previewQuality ? (
            <div id="pim-import-detail-panels" className="mb-4 space-y-4 rounded-xl border border-border/60 bg-muted/20 p-4">
                      {phase === "preview_ready" && Object.keys(columnMapping).length > 0 ? (
                        <div className="rounded-lg border border-border/60 bg-card/40 px-4 py-3 text-sm">
                          <button
                            type="button"
                            className="flex w-full items-start justify-between gap-2 text-left"
                            onClick={() => setMappingDetailsOpen((v) => !v)}
                          >
                            <p className="min-w-0 flex-1 text-sm text-foreground">
                              <span className="font-medium">Column mapping detected:</span> {pimColumnMappingSummary(columnMapping) || "—"}
                            </p>
                            <ChevronDown
                              className={`mt-0.5 h-4 w-4 shrink-0 text-muted-foreground transition-transform ${mappingDetailsOpen ? "rotate-180" : ""}`}
                              aria-hidden
                            />
                          </button>
                          {mappingDetailsOpen ? (
                            <div className="mt-3 space-y-2 border-t border-border/40 pt-3">
                              <PimHelpNote label="Column mapping details">
                                <div className="space-y-2 text-xs">
                                  <div>
                                    Source: <span className="font-mono text-foreground">{mappingSource ?? "—"}</span>
                                    {seedSessionId ? (
                                      <>
                                        {" "}
                                        · Session <span className="font-mono text-[10px] text-foreground">{seedSessionId.slice(0, 8)}…</span>
                                      </>
                                    ) : null}
                                  </div>
                                  {seedDelimiterDetected ? (
                                    <div>
                                      Delimiter: <span className="font-mono text-foreground">{seedDelimiterDetected}</span>
                                      {seedDelimiterUncertain ? (
                                        <span className="ml-1 text-amber-700 dark:text-amber-300">(uncertain — verify columns)</span>
                                      ) : null}
                                    </div>
                                  ) : null}
                                </div>
                              </PimHelpNote>
                              <div className="max-h-48 overflow-y-auto rounded border border-border/50">
                                <table className="w-full text-left text-xs">
                                  <thead className="sticky top-0 bg-muted/80">
                                    <tr>
                                      <th className="px-2 py-1.5 font-medium text-muted-foreground">Standard field</th>
                                      <th className="px-2 py-1.5 font-medium text-muted-foreground">Your column</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {Object.entries(columnMapping).map(([std, hdr]) => (
                                      <tr key={std} className="border-t border-border/40">
                                        <td className="px-2 py-1.5 font-medium text-foreground">{std}</td>
                                        <td className="px-2 py-1.5 font-mono text-muted-foreground">{hdr}</td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              </div>
                            </div>
                          ) : null}
                        </div>
                      ) : null}


                      {phase === "preview_ready" && previewQuality ? (
                        <div
                          id="pim-preview-summary"
                          className="space-y-3 rounded-lg border border-border/60 bg-muted/15 px-4 py-3 text-sm"
                          role="status"
                        >
                          <div className="flex flex-wrap items-center gap-2">
                            <p className="font-medium text-foreground">Preview summary</p>
                            <PimHelpNote label="Preview summary">
                              <div className="max-w-sm space-y-1 text-xs leading-relaxed">
                                <div>These counts come from the last preview scan only — nothing is written until you confirm.</div>
                                <div>Review counts below, then use Confirm &amp; Import when ready.</div>
                              </div>
                            </PimHelpNote>
                          </div>
                          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3 text-xs">
                            <MetricCard icon={Table2} label="Rows scanned" value={previewQuality.rows_total ?? 0} tone="slate" />
                            <MetricCard
                              icon={CheckCircle2}
                              label="Accepted rows"
                              value={
                                typeof previewQuality.rows_accepted_estimate === "number"
                                  ? previewQuality.rows_accepted_estimate
                                  : "—"
                              }
                              tone="emerald"
                            />
                            <MetricCard
                              icon={Ban}
                              label="Rejected rows"
                              value={
                                (previewQuality.dirty_rows ?? previewQuality.skipped_dirty_row ?? 0) +
                                (previewQuality.blocked_new_without_seller_sku ?? 0)
                              }
                              tone="amber"
                            />
                            {typeof previewQuality.dirty_rate === "number" ? (
                              <MetricCard
                                icon={Tag}
                                label="Dirty rate"
                                value={`${(previewQuality.dirty_rate * 100).toFixed(1)}%`}
                                tone={previewQuality.apply_blocked_by_dirty_rate ? "amber" : "slate"}
                              />
                            ) : null}
                            <MetricCard
                              icon={Package}
                              label="Products to create"
                              value={previewQuality.products_would_create ?? previewQuality.would_create_products ?? 0}
                              tone="violet"
                            />
                            <MetricCard
                              icon={Package}
                              label="Products to update"
                              value={previewQuality.products_would_update ?? previewQuality.would_update_products ?? 0}
                              tone="violet"
                            />
                            {typeof previewQuality.existing_products_matched === "number" ? (
                              <MetricCard
                                icon={CheckCircle2}
                                label="Existing products matched"
                                value={previewQuality.existing_products_matched}
                                tone="emerald"
                              />
                            ) : null}
                            <MetricCard icon={Building2} label="Vendors to create" value={previewQuality.vendors_would_create ?? 0} tone="sky" />
                            {typeof previewQuality.vendors_reused === "number" ? (
                              <MetricCard icon={Building2} label="Vendors reused" value={previewQuality.vendors_reused} tone="emerald" />
                            ) : null}
                            {/* Category cards — show friendly message when column is blank */}
                            {(() => {
                              const catDbg = previewQuality.category_import_debug as unknown as Record<string, unknown> | undefined;
                              const reasons = Array.isArray((catDbg as unknown as Record<string, unknown> | undefined)?.why_categories_zero)
                                ? ((catDbg as unknown as Record<string, unknown>).why_categories_zero as string[])
                                : [];
                              const noCatInFile =
                                reasons.includes("category_cells_empty_on_accepted_rows") ||
                                reasons.includes("no_category_column_mapped");
                              if (noCatInFile) {
                                return (
                                  <div className="col-span-full rounded-lg border border-border/40 bg-muted/15 px-3 py-2 text-xs text-muted-foreground">
                                    No categories in this file — categories can be assigned later via product enrichment.
                                  </div>
                                );
                              }
                              return (
                                <>
                                  {typeof previewQuality.categories_would_create === "number" ? (
                                    <MetricCard icon={LayoutGrid} label="Categories to create" value={previewQuality.categories_would_create} tone="sky" />
                                  ) : null}
                                  {typeof previewQuality.categories_reused === "number" ? (
                                    <MetricCard icon={LayoutGrid} label="Categories reused" value={previewQuality.categories_reused} tone="emerald" />
                                  ) : null}
                                </>
                              );
                            })()}
                            <MetricCard
                              icon={Link2}
                              label="Identifiers to add"
                              value={
                                previewQuality.identifier_rows_would_insert ??
                                previewQuality.identifier_map_rows_would_insert ??
                                0
                              }
                              tone="violet"
                            />
                            {typeof (previewQuality.identifier_rows_would_update ?? previewQuality.identifier_map_rows_would_update) === "number" ? (
                              <MetricCard
                                icon={Link2}
                                label="Identifiers to update"
                                value={previewQuality.identifier_rows_would_update ?? previewQuality.identifier_map_rows_would_update ?? 0}
                                tone="violet"
                              />
                            ) : null}
                            {typeof previewQuality.duplicates_reused === "number" ? (
                              <MetricCard icon={Copy} label="Links already complete" value={previewQuality.duplicates_reused} tone="slate" />
                            ) : null}
                            <MetricCard icon={FileSpreadsheet} label="Prices to add" value={previewQuality.prices_would_insert ?? 0} tone="violet" />
                            {typeof previewQuality.metadata_attributes_detected === "number" ? (
                              <MetricCard
                                icon={Cloud}
                                label="Metadata rows detected"
                                value={previewQuality.metadata_attributes_detected}
                                tone="slate"
                              />
                            ) : null}
                            {typeof previewQuality.rows_skipped === "number" ? (
                              <MetricCard icon={Ban} label="Rows skipped" value={previewQuality.rows_skipped} tone="slate" />
                            ) : null}
                            <MetricCard
                              icon={AlertTriangle}
                              label="Conflicts"
                              value={
                                (previewQuality.conflict_rows_blocked ?? 0) +
                                (previewQuality.multi_identifier_rows_conflicting ?? 0) +
                                (previewQuality.identifier_map_conflicts_preview ?? 0)
                              }
                              tone={previewQuality.apply_blocked_by_conflicts ? "amber" : "slate"}
                            />
                          </div>
                          {/* Single collapsible rejected/conflict samples section */}
                          {(() => {
                            const hasSamples =
                              (Array.isArray(previewQuality.rejected_sample) && previewQuality.rejected_sample.length > 0) ||
                              (Array.isArray(previewQuality.preview_errors) && previewQuality.preview_errors.length > 0);
                            if (!hasSamples) return null;
                            return (
                              <div>
                                <button
                                  type="button"
                                  className="flex w-full items-center justify-between gap-2 rounded-lg border border-border/60 bg-muted/20 px-3 py-2 text-left text-xs font-medium text-foreground hover:bg-muted/40"
                                  onClick={() => setShowDirtyRowsPanel((v) => !v)}
                                >
                                  <span>
                                    Rejected / conflict samples (
                                    {(previewQuality.rejected_sample?.length ?? 0) + (previewQuality.preview_errors?.length ?? 0)}
                                    )
                                  </span>
                                  <ChevronDown
                                    className={`h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform ${showDirtyRowsPanel ? "rotate-180" : ""}`}
                                    aria-hidden
                                  />
                                </button>
                                {showDirtyRowsPanel ? (
                                  <div className="mt-1 max-h-56 overflow-y-auto rounded-lg border border-border/60 bg-card/50 px-3 py-2 text-[11px] text-muted-foreground">
                                    {Array.isArray(previewQuality.rejected_sample) && previewQuality.rejected_sample.length > 0 ? (
                                      <>
                                        <p className="mb-1 font-medium text-foreground">Rejected rows</p>
                                        <ul className="mb-2 list-inside list-disc space-y-1">
                                          {previewQuality.rejected_sample.slice(0, 30).map((r, i) => (
                                  <li key={i}>
                                    {typeof r.row === "string" ? <span className="font-mono text-foreground/80">{r.row}: </span> : null}
                                    {r.message}
                                  </li>
                                ))}
                              </ul>
                                      </>
                          ) : null}
                          {Array.isArray(previewQuality.preview_errors) && previewQuality.preview_errors.length > 0 ? (
                                      <>
                                        <p className="mb-1 font-medium text-foreground">
                                          Preview messages (first {Math.min(20, previewQuality.preview_errors.length)})
                                        </p>
                                        <ul className="list-inside list-disc space-y-0.5">
                                          {previewQuality.preview_errors.slice(0, 20).map((e, i) => (
                                  <li key={i}>{e}</li>
                                ))}
                              </ul>
                                      </>
                                    ) : null}
                            </div>
                          ) : null}
                              </div>
                            );
                          })()}
                          <p className="text-xs text-muted-foreground">
                            Use <span className="font-medium text-foreground">Confirm &amp; Import</span> below when you are ready.
                          </p>
                          {successMessage ? <p className="text-xs text-emerald-700 dark:text-emerald-300">{successMessage}</p> : null}
                        </div>
                      ) : null}

                      {/* Conflict diagnosis panel — shown when preview has conflicts */}
                      {phase === "preview_ready" && (previewQuality?.apply_blocked_by_conflicts || (previewQuality?.conflict_detail?.length ?? 0) > 0) ? (
                        <div className="space-y-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-sm">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <div className="flex items-center gap-2">
                              <AlertTriangle className="h-4 w-4 shrink-0 text-amber-600" aria-hidden />
                              <p className="font-semibold text-foreground">
                                {(previewQuality!.conflict_detail?.length ?? previewQuality!.conflict_rows_blocked ?? 0)} row{(previewQuality!.conflict_detail?.length ?? previewQuality!.conflict_rows_blocked ?? 0) !== 1 ? "s" : ""} have identifier conflicts — those rows will be skipped on import.
                              </p>
                            </div>
                            <div className="flex flex-wrap gap-2">
                              <button
                                type="button"
                                className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-background px-3 py-1.5 text-xs font-medium text-foreground shadow-sm hover:bg-muted/50"
                                onClick={() => setShowConflictPanel((v) => !v)}
                              >
                                {showConflictPanel ? "Hide conflicts" : "View conflicts"}
                              </button>
                              <button
                                type="button"
                                disabled={!(previewQuality?.conflict_detail?.length)}
                                className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-background px-3 py-1.5 text-xs font-medium text-foreground shadow-sm hover:bg-muted/50 disabled:opacity-50"
                                onClick={() => {
                                  const detail = previewQuality?.conflict_detail;
                                  if (!detail?.length) return;
                                  const cols = ["row","sku","asin","fnsku","upc","product_name","conflict_pids","reason_source","recommended"];
                                  const csvEscape = (v: unknown): string => {
                                    const s = Array.isArray(v) ? v.join("|") : String(v ?? "");
                                    // RFC 4180: wrap in double-quotes, escape embedded double-quotes
                                    return `"${s.replace(/"/g, '""')}"`;
                                  };
                                  const rows = detail.map((r) => cols.map((c) => csvEscape((r as unknown as Record<string, unknown>)[c])).join(","));
                                  const csv = [cols.map((c) => `"${c}"`).join(","), ...rows].join("\r\n");
                                  const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" });
                                  const url = URL.createObjectURL(blob);
                                  const a = document.createElement("a");
                                  a.href = url;
                                  a.download = `conflicts_${activeImportFileLabel ?? "import"}.csv`;
                                  a.click();
                                  URL.revokeObjectURL(url);
                                }}
                              >
                                <FileSpreadsheet className="h-3.5 w-3.5" aria-hidden />
                                Export CSV
                              </button>
                              <button
                                type="button"
                                disabled={isBusy || !canSync || !previewQuality}
                                className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground shadow-sm hover:opacity-95 disabled:cursor-not-allowed disabled:opacity-50"
                                onClick={() => void runCatalogApply({ skipConflicts: true })}
                              >
                                <Sparkles className="h-3.5 w-3.5" aria-hidden />
                                Import safe rows only
                              </button>
                            </div>
                          </div>
                          {showConflictPanel ? (
                            <div className="space-y-2 border-t border-border/40 pt-2">
                              {/* Filter bar */}
                              <div className="flex flex-wrap gap-2 text-xs">
                                <input
                                  type="search"
                                  placeholder="Search SKU / ASIN / FNSKU / UPC…"
                                  value={conflictSearchText}
                                  onChange={(e) => setConflictSearchText(e.target.value)}
                                  className="h-7 min-w-[200px] rounded-md border border-border bg-background px-2 text-xs text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                />
                                <select
                                  value={conflictReasonFilter}
                                  onChange={(e) => setConflictReasonFilter(e.target.value)}
                                  className="h-7 rounded-md border border-border bg-background px-2 text-xs text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                >
                                  <option value="all">All sources</option>
                                  <option value="imap">Identifier map</option>
                                  <option value="products">Products table</option>
                                  <option value="both">Both</option>
                                </select>
                              </div>
                              {/* Conflict table — only shown when conflict_detail is available (requires re-preview after latest backend) */}
                              {(previewQuality?.conflict_detail?.length ?? 0) > 0 ? (
                              <div className="overflow-x-auto rounded border border-border/60">
                                <table className="min-w-[900px] w-full border-collapse text-left text-[11px]">
                                  <thead className="bg-muted/50 text-muted-foreground">
                                    <tr>
                                      <th className="px-2 py-1.5 font-medium">Row</th>
                                      <th className="px-2 py-1.5 font-medium">SKU</th>
                                      <th className="px-2 py-1.5 font-medium">ASIN</th>
                                      <th className="px-2 py-1.5 font-medium">FNSKU</th>
                                      <th className="px-2 py-1.5 font-medium">Product name</th>
                                      <th className="px-2 py-1.5 font-medium">Source</th>
                                      <th className="px-2 py-1.5 font-medium">Conflicting products</th>
                                      {perms.isAtLeast("admin") ? <th className="px-2 py-1.5 font-medium">Action</th> : null}
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {(previewQuality!.conflict_detail ?? [])
                                      .filter((cd) => {
                                        if (conflictReasonFilter !== "all" && cd.reason_source !== conflictReasonFilter) return false;
                                        if (conflictSearchText) {
                                          const q = conflictSearchText.toLowerCase();
                                          return (
                                            cd.sku.toLowerCase().includes(q) ||
                                            cd.asin.toLowerCase().includes(q) ||
                                            cd.fnsku.toLowerCase().includes(q) ||
                                            cd.upc.toLowerCase().includes(q)
                                          );
                                        }
                                        return true;
                                      })
                                      .slice(0, 100)
                                      .map((cd, i) => (
                                        <tr key={i} className="border-t border-border/40 align-top hover:bg-muted/20">
                                          <td className="px-2 py-1.5 text-muted-foreground">{cd.row}</td>
                                          <td className="max-w-[120px] truncate px-2 py-1.5 font-mono text-foreground" title={cd.sku}>{cd.sku || "—"}</td>
                                          <td className="px-2 py-1.5 font-mono text-muted-foreground">{cd.asin || "—"}</td>
                                          <td className="px-2 py-1.5 font-mono text-muted-foreground">{cd.fnsku || "—"}</td>
                                          <td className="max-w-[150px] truncate px-2 py-1.5 text-muted-foreground" title={cd.product_name}>{cd.product_name || "—"}</td>
                                          <td className="px-2 py-1.5 text-muted-foreground">{cd.reason_source}</td>
                                          <td className="px-2 py-1.5 font-mono text-muted-foreground">
                                            {cd.conflict_pids.map((p) => p.slice(0, 8)).join(", ")}…
                                          </td>
                                          {perms.isAtLeast("admin") ? (
                                            <td className="px-2 py-1.5">
                                              {cd.resolved_pid ? (
                                                <button
                                                  type="button"
                                                  disabled={conflictDetachBusy === cd.row || !organizationId}
                                                  className="inline-flex items-center gap-1 rounded border border-amber-600/50 bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-900 hover:bg-amber-500/20 disabled:opacity-50 dark:text-amber-100"
                                                  onClick={async () => {
                                                    if (!organizationId) return;
                                                    setConflictDetachBusy(cd.row);
                                                    try {
                                                      // dryRun first
                                                      const dry = await detachConflictingImapRows({
                                                        organizationId,
                                                        storeId: selectedStoreId.trim(),
                                                        keepProductId: cd.resolved_pid!,
                                                        sellerSku: cd.sku || null,
                                                        asin: cd.asin || null,
                                                        fnsku: cd.fnsku || null,
                                                        upc: cd.upc || null,
                                                        uploadId: importUploadId,
                                                        dryRun: true,
                                                      });
                                                      if (!dry.ok) { window.alert(`Error: ${dry.error}`); return; }
                                                      const go = window.confirm(
                                                        `Detach ${dry.would_detach} wrong identifier link(s) for row ${cd.row}?\n\nThis will soft-delete the incorrect links and is logged in the audit trail. You can re-run preview after.`,
                                                      );
                                                      if (!go) return;
                                                      const result = await detachConflictingImapRows({
                                                        organizationId,
                                                        storeId: selectedStoreId.trim(),
                                                        keepProductId: cd.resolved_pid!,
                                                        sellerSku: cd.sku || null,
                                                        asin: cd.asin || null,
                                                        fnsku: cd.fnsku || null,
                                                        upc: cd.upc || null,
                                                        uploadId: importUploadId,
                                                        dryRun: false,
                                                        confirmRecent: true,
                                                      });
                                                      if (!result.ok) { window.alert(`Error: ${result.error}`); return; }
                                                      window.alert(`Detached ${result.detached} link(s). Re-run preview to verify conflicts are resolved.`);
                                                    } finally {
                                                      setConflictDetachBusy(null);
                                                    }
                                                  }}
                                                >
                                                  Detach wrong link
                                                </button>
                                              ) : (
                                                <span className="text-muted-foreground">Review manually</span>
                                              )}
                                            </td>
                                          ) : null}
                                        </tr>
                                      ))}
                                  </tbody>
                                </table>
                              </div>
                              ) : (
                                <div className="rounded border border-border/50 bg-muted/20 px-3 py-3 text-xs text-muted-foreground">
                                  Conflict row details are not available yet. Re-run preview to generate the conflict report with per-row details.
                                </div>
                              )}
                              <p className="text-xs text-muted-foreground">
                                {(previewQuality?.conflict_detail?.length ?? 0) > 0
                                  ? `Showing up to 100 of ${previewQuality!.conflict_detail!.length} conflict rows. `
                                  : ""}
                                Use <span className="font-medium text-foreground">Import safe rows only</span> to import the {(previewQuality?.rows_accepted_estimate ?? 0).toLocaleString()} accepted rows now and resolve conflicts separately.
                              </p>
                            </div>
                          ) : null}
                        </div>
                      ) : null}
            </div>
          ) : null}

          </div>
          <div className="mt-1 space-y-3 rounded-xl border border-border/60 bg-muted/10 p-3 sm:p-4">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Session list</p>
          {!organizationId ? (
            <p className="text-xs text-muted-foreground">Select an organization to load history.</p>
          ) : !selectedStoreId.trim() ? (
            <p className="text-xs text-muted-foreground">Choose a target store to load import session history.</p>
          ) : historyLoading && historyRows.length === 0 ? (
            <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              Loading import history…
            </div>
          ) : historyRows.length === 0 ? (
            <div className="rounded-lg border border-border/60 bg-muted/15 px-3 py-3 text-sm text-muted-foreground">
              {importUploadId && !historyLoading ? (
                <>
                  <p className="font-medium text-foreground">Session list is empty</p>
                  <p className="mt-1 text-xs leading-relaxed">
                    The current file card above may still show your active upload. Use <span className="font-medium text-foreground">Refresh</span> in the toolbar to reload this table. If it stays empty, there may be no Product Master rows in the current window, or the upload&apos;s store may not match the selected store.
                  </p>
                </>
              ) : (
                <p className="text-sm">
                  No sessions in this list yet. Pick a store if needed, then <span className="font-medium text-foreground">Refresh</span> in the toolbar.
                </p>
              )}
            </div>
          ) : (
            <div className="space-y-3">
              {/* Banner when active upload is missing from history */}
              {importUploadId && !historyLoading && !historyRows.some((r) => r.upload_id === importUploadId) ? (
                <div className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/8 px-3 py-2 text-xs text-amber-950 dark:text-amber-100">
                  <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden />
                  <span className="flex-1">
                    Active upload is not in history for this store — store ID may not match. Check store selection or use Refresh.
                  </span>
                  <button
                    type="button"
                    disabled={historyLoading}
                    onClick={() => void refreshHistory()}
                    className="inline-flex items-center gap-1 text-xs font-medium underline-offset-2 hover:underline"
                  >
                    <RefreshCw className="h-3 w-3" aria-hidden />
                    Refresh
                  </button>
                </div>
              ) : null}
              <div className="overflow-x-auto rounded-lg border border-border/60">
              <table className="min-w-[1100px] w-full border-collapse text-left text-[11px]">
                <thead className="bg-muted/50 text-muted-foreground">
                  <tr>
                    <th className="w-8 px-1 py-2 font-medium">
                      <input
                        type="checkbox"
                        title="Select all"
                        checked={historyRows.length > 0 && historySelectedIds.size === historyRows.length}
                        onChange={(e) => {
                          if (e.target.checked) setHistorySelectedIds(new Set(historyRows.map((r) => r.session_id)));
                          else setHistorySelectedIds(new Set());
                        }}
                      />
                    </th>
                    <th className="px-2 py-2 font-medium">File</th>
                    <th className="px-2 py-2 font-medium">Status</th>
                    <th className="px-2 py-2 font-medium whitespace-nowrap">Created</th>
                    <th className="px-2 py-2 font-medium">Store</th>
                    <th className="px-2 py-2 font-medium">Scanned</th>
                    <th className="px-2 py-2 font-medium">Accepted</th>
                    <th className="px-2 py-2 font-medium">Dirty / rejected</th>
                    <th className="px-2 py-2 font-medium">Products ±</th>
                    <th className="px-2 py-2 font-medium">Identifiers ±</th>
                    <th className="px-2 py-2 font-medium">Prices +</th>
                    <th className="min-w-[220px] px-2 py-2 font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {historyRows.map((row) => {
                    const meta = row.metadata && typeof row.metadata === "object" ? row.metadata : {};
                    const job = (meta as { pim_import_job?: Record<string, unknown> }).pim_import_job ?? {};
                    const previewSt = typeof (meta as { preview_status?: string }).preview_status === "string"
                      ? String((meta as { preview_status?: string }).preview_status)
                      : "";
                    const pq = (job as { preview_quality?: Record<string, unknown> }).preview_quality;
                    const pub = (meta as { pim_preview_result?: { quality?: Record<string, unknown> } }).pim_preview_result?.quality;
                    const pm = row.preview_metrics && typeof row.preview_metrics === "object" ? row.preview_metrics : null;
                    const qm = ((pub && typeof pub === "object" ? pub : pq) ?? pm) as unknown as Record<string, unknown> | undefined;
                    const storeId = String((meta as { import_store_id?: string }).import_store_id ?? "").trim();
                    const storeNm = pimStores.find((s) => s.id === storeId)?.display_name ?? (storeId ? `${storeId.slice(0, 8)}…` : "—");
                    const life = String(job.lifecycle ?? "").toLowerCase();
                    const ss = String(row.session_status ?? "").toLowerCase();
                    const activeJob =
                      life === "previewing" ||
                      life === "importing" ||
                      life === "import_queued" ||
                      previewSt === "previewing" ||
                      ss === "preview_running" ||
                      ss === "importing";
                    const am = row.apply_metrics;
                    const amObj = am && typeof am === "object" ? (am as unknown as Record<string, unknown>) : null;
                    const rowsScannedHist =
                      typeof qm?.rows_scanned === "number"
                        ? qm.rows_scanned
                        : typeof qm?.rows_total === "number"
                          ? qm.rows_total
                          : row.total_rows;
                    const rejDirtyHist =
                      typeof qm?.skipped_dirty_row === "number"
                        ? qm.skipped_dirty_row
                        : typeof qm?.dirty_rows === "number"
                          ? qm.dirty_rows
                          : row.dirty_rows;
                    const acceptedHist =
                      row.accepted_rows ??
                      (typeof qm?.rows_accepted_estimate === "number" ? qm.rows_accepted_estimate : null);
                    const previewReadyHist =
                      previewSt === "preview_ready" ||
                      life === "waiting_for_confirmation" ||
                      life === "preview_ready";
                    const confirmBlockedHist =
                      Boolean(qm?.apply_blocked_by_dirty_rate) || Boolean(qm?.apply_blocked_by_conflicts);
                    const stageRaw = typeof job.stage_label === "string" ? String(job.stage_label).toLowerCase() : "";
                    const partialHist =
                      stageRaw === "import_partial_failed" || String(previewSt).toLowerCase() === "import_partial_failed";
                    const histBadge = pimHistoryRowDisplayStatus(row);
                    const pc =
                      typeof amObj?.products_created === "number"
                        ? amObj.products_created
                        : typeof qm?.products_would_create === "number"
                          ? qm.products_would_create
                          : typeof qm?.would_create_products === "number"
                            ? qm.would_create_products
                            : null;
                    const pu =
                      typeof amObj?.products_updated === "number"
                        ? amObj.products_updated
                        : typeof qm?.products_would_update === "number"
                          ? qm.products_would_update
                          : typeof qm?.would_update_products === "number"
                            ? qm.would_update_products
                            : null;
                    const idc =
                      typeof amObj?.identifiers_created === "number"
                        ? amObj.identifiers_created
                        : typeof qm?.identifier_rows_would_insert === "number"
                          ? qm.identifier_rows_would_insert
                          : typeof qm?.identifier_map_rows_would_insert === "number"
                            ? qm.identifier_map_rows_would_insert
                            : null;
                    const idu =
                      typeof amObj?.identifiers_updated === "number"
                        ? amObj.identifiers_updated
                        : typeof qm?.identifier_rows_would_update === "number"
                          ? qm.identifier_rows_would_update
                          : typeof qm?.identifier_map_rows_would_update === "number"
                            ? qm.identifier_map_rows_would_update
                            : null;
                    const priceN =
                      typeof amObj?.prices_inserted === "number"
                        ? amObj.prices_inserted
                        : typeof qm?.prices_would_insert === "number"
                          ? qm.prices_would_insert
                          : null;
                    const conflictN =
                      (typeof qm?.conflict_rows_blocked === "number" ? qm.conflict_rows_blocked : 0) +
                      (typeof qm?.multi_identifier_rows_conflicting === "number" ? qm.multi_identifier_rows_conflicting : 0);
                    const conflictExtra =
                      typeof row.conflict_rows === "number" ? row.conflict_rows : conflictN;
                    const dirtyRejected = (typeof rejDirtyHist === "number" ? rejDirtyHist : 0) + conflictExtra;
                    const histBtn =
                      "inline-flex items-center justify-center rounded-md border border-border bg-background px-2 py-1 text-[11px] font-medium text-foreground shadow-sm hover:bg-muted/55 disabled:cursor-not-allowed disabled:opacity-45";
                    const histBtnPri =
                      "inline-flex items-center justify-center rounded-md bg-primary px-2 py-1 text-[11px] font-semibold text-primary-foreground shadow-sm hover:opacity-95 disabled:cursor-not-allowed disabled:opacity-45";
                    const histBtnDanger =
                      "inline-flex items-center justify-center rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1 text-[11px] font-medium text-destructive hover:bg-destructive/15 disabled:cursor-not-allowed disabled:opacity-45";
                    const rowActive = importUploadId === row.upload_id;
                    const rtHist = String(row.report_type ?? "").trim().toLowerCase();
                    const isPmHistoryReport =
                      rtHist === "pim_product_master" ||
                      rtHist === "pim_catalog_seed" ||
                      String(row.report_type ?? "").trim() === "PIM_CATALOG_SEED";
                    const pwHist =
                      typeof qm?.prices_would_insert === "number" ? qm.prices_would_insert : null;
                    const piHist =
                      typeof amObj?.prices_inserted === "number" ? amObj.prices_inserted : null;
                    const bfRow = fpsPriceBackfillByUpload[row.upload_id] ?? {};
                    const bfSt = String(bfRow.status ?? "idle").toLowerCase();
                    const bfProc = Number(bfRow.processed_rows ?? bfRow.offset ?? 0);
                    const bfTot = Number(bfRow.total ?? 0);
                    const bfPct =
                      bfTot > 0 ? Math.min(100, Math.round((100 * bfProc) / bfTot)) : bfSt === "completed" ? 100 : 0;
                    const histPriceStripEligible =
                      pimUiMayRunPriceBackfill(canonicalRoleKey) &&
                      isPmHistoryReport &&
                      !activeJob &&
                      pwHist != null &&
                      pwHist > 0;
                    const histPriceLikelyIncomplete =
                      piHist == null || (typeof pwHist === "number" && typeof piHist === "number" && piHist < pwHist);
                    const histPricePanelOpen =
                      histPriceStripEligible ||
                      priceBackfillBusyUploadId === row.upload_id ||
                      (isPmHistoryReport && bfSt && bfSt !== "idle" && bfSt !== "");

                    return (
                      <tr
                        key={row.session_id}
                        className={`border-t border-border/50 align-top ${rowActive ? "bg-muted/25" : ""}`}
                      >
                        <td className="px-1 py-2 align-middle">
                          <input
                            type="checkbox"
                            checked={historySelectedIds.has(row.session_id)}
                            onChange={(e) => {
                              const next = new Set(historySelectedIds);
                              if (e.target.checked) next.add(row.session_id);
                              else next.delete(row.session_id);
                              setHistorySelectedIds(next);
                            }}
                            aria-label={`Select ${row.file_name}`}
                          />
                        </td>
                        <td className="max-w-[200px] truncate px-2 py-2 font-medium text-foreground" title={row.file_name}>
                          {row.file_name}
                          {row.store_mismatch ? (
                            <span className="ml-1 rounded bg-amber-500/20 px-1 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-amber-800 dark:text-amber-200">
                              store mismatch
                            </span>
                          ) : null}
                        </td>
                        <td className="px-2 py-2">
                          <PimStatusBadge label={histBadge.label} tone={histBadge.tone} />
                          {row.session_last_error ? (
                            <span className="mt-1 line-clamp-2 block text-[10px] text-destructive" title={row.session_last_error}>
                              {row.session_last_error}
                            </span>
                          ) : null}
                        </td>
                        <td className="whitespace-nowrap px-2 py-2 text-muted-foreground">
                          {row.created_at ? new Date(row.created_at).toLocaleString() : "—"}
                        </td>
                        <td className="px-2 py-2 text-muted-foreground">{storeNm}</td>
                        <td className="px-2 py-2 tabular-nums text-muted-foreground">{rowsScannedHist ?? "—"}</td>
                        <td className="px-2 py-2 tabular-nums text-muted-foreground">{acceptedHist ?? "—"}</td>
                        <td className="px-2 py-2 tabular-nums text-muted-foreground">{dirtyRejected}</td>
                        <td className="px-2 py-2 tabular-nums leading-tight text-muted-foreground">
                          <div>+{pc ?? "—"}</div>
                          <div>~{pu ?? "—"}</div>
                        </td>
                        <td className="px-2 py-2 tabular-nums leading-tight text-muted-foreground">
                          <div>+{idc ?? "—"}</div>
                          <div>~{idu ?? "—"}</div>
                        </td>
                        <td className="px-2 py-2 tabular-nums text-muted-foreground">{priceN ?? "—"}</td>
                        <td className="px-2 py-2">
                          <div className="flex flex-wrap gap-1">
                            {activeJob ? (
                              <button type="button" className={histBtnDanger} onClick={() => void cancelHistoryImportRow(row)}>
                                Cancel
                              </button>
                            ) : null}
                            {!activeJob && previewReadyHist ? (
                              <button
                                type="button"
                                disabled={confirmBlockedHist || isBusy}
                                title={
                                  confirmBlockedHist
                                    ? "Too many rows failed validation or there are identifier conflicts — fix the file or run preview again."
                                    : undefined
                                }
                                className={histBtnPri}
                                onClick={() => void confirmImportFromHistoryRow(row)}
                              >
                                Confirm
                              </button>
                            ) : null}
                            {!activeJob &&
                            !previewReadyHist &&
                            (partialHist || life === "failed" || ss === "failed") ? (
                              <button type="button" disabled={isBusy} className={histBtnPri} onClick={() => void resumeImportFromHistoryRow(row)}>
                                Resume
                              </button>
                            ) : null}
                            {!activeJob &&
                            !previewReadyHist &&
                            !partialHist &&
                            life !== "failed" &&
                            ss !== "failed" ? (
                              <button type="button" disabled={isBusy} className={histBtnPri} onClick={() => void resumeImportFromHistoryRow(row)}>
                                Continue
                              </button>
                            ) : null}
                            {!activeJob ? (
                              <button type="button" disabled={isBusy} className={histBtn} onClick={() => void retryPreviewFromHistoryRow(row)}>
                                Retry preview
                              </button>
                            ) : null}
                            <button
                              type="button"
                              className={histBtn}
                              onClick={() => {
                                const blob = new Blob([JSON.stringify(row.metadata ?? {}, null, 2)], {
                                  type: "application/json",
                                });
                                const url = URL.createObjectURL(blob);
                                const a = document.createElement("a");
                                a.href = url;
                                a.download = `pim-seed-${row.session_id}.json`;
                                a.click();
                                URL.revokeObjectURL(url);
                              }}
                            >
                              View details
                            </button>
                            {!activeJob ? (
                              <button type="button" className={histBtn} onClick={() => void resetHistoryImportJob(row)}>
                                Reset
                              </button>
                            ) : null}
                            {!activeJob ? (
                              <button type="button" className={histBtn} onClick={() => void clearStagingHistoryRow(row)}>
                                Clear staging
                              </button>
                            ) : null}
                            {row.store_mismatch && organizationId ? (
                              <button
                                type="button"
                                className="inline-flex items-center justify-center rounded-md border border-amber-600/50 bg-amber-500/10 px-2 py-1 text-[11px] font-medium text-amber-900 hover:bg-amber-500/20 disabled:cursor-not-allowed disabled:opacity-45 dark:text-amber-100"
                                title={`Assign this upload's store metadata to "${activeStoreLabel}"`}
                                onClick={async () => {
                                  const oid = organizationId?.trim();
                                  if (!oid || !selectedStoreId.trim()) return;
                                  const ok = window.confirm(
                                    `Assign upload "${row.file_name}" to store "${activeStoreLabel}"?\n\nThis updates the upload's store metadata to match the currently selected store.`,
                                  );
                                  if (!ok) return;
                                  const res = await assignPimUploadToStore({
                                    organizationId: oid,
                                    uploadId: row.upload_id,
                                    targetStoreId: selectedStoreId.trim(),
                                  });
                                  if (!res.ok) {
                                    window.alert(`Failed: ${res.error}`);
                                  } else {
                                    void refreshHistory();
                                  }
                                }}
                              >
                                Assign to store
                              </button>
                            ) : null}
                            <button type="button" className={histBtnDanger} onClick={() => void deleteHistoryImportRow(row)}>
                              Delete
                            </button>
                          </div>
                          {histPricePanelOpen ? (
                            <div className="mt-3 w-full min-w-[280px] max-w-xl rounded-lg border border-violet-500/30 bg-violet-500/5 p-3 text-[11px] leading-snug text-muted-foreground shadow-inner">
                              <p className="font-semibold text-foreground">Import prices to catalog</p>
                              <p className="mt-1 text-[10px]">
                                Writes <span className="font-medium text-foreground">product_prices</span> from this upload&apos;s staged rows.
                                Preview expected <span className="tabular-nums text-foreground">{pwHist?.toLocaleString() ?? "—"}</span> · inserted{" "}
                                <span className="tabular-nums text-foreground">{piHist?.toLocaleString() ?? "—"}</span>.
                              </p>
                              {histPriceStripEligible && !histPriceLikelyIncomplete && bfSt === "completed" ? (
                                <p className="mt-1 text-[10px] text-emerald-700 dark:text-emerald-300">
                                  Apply metrics match preview counts for prices; use Import again only if you intentionally need a replay.
                                </p>
                              ) : null}
                              <dl className="mt-2 grid gap-1 sm:grid-cols-2">
                                <div>
                                  <dt className="text-[10px] uppercase tracking-wide text-muted-foreground">Stage</dt>
                                  <dd className="font-medium capitalize text-foreground">{bfSt || "idle"}</dd>
                                </div>
                                <div>
                                  <dt className="text-[10px] uppercase tracking-wide text-muted-foreground">Progress</dt>
                                  <dd className="tabular-nums text-foreground">
                                    {bfProc.toLocaleString()} / {bfTot > 0 ? bfTot.toLocaleString() : "—"} ({bfPct}%)
                                  </dd>
                                </div>
                                <div>
                                  <dt className="text-[10px] uppercase tracking-wide text-muted-foreground">Inserted (this run)</dt>
                                  <dd className="tabular-nums text-foreground">{Number(bfRow.inserted ?? 0).toLocaleString()}</dd>
                                </div>
                                <div>
                                  <dt className="text-[10px] uppercase tracking-wide text-muted-foreground">Skipped (no price)</dt>
                                  <dd className="tabular-nums text-foreground">{Number(bfRow.skipped_no_price ?? 0).toLocaleString()}</dd>
                                </div>
                                <div>
                                  <dt className="text-[10px] uppercase tracking-wide text-muted-foreground">Duplicates skipped</dt>
                                  <dd className="tabular-nums text-foreground">{Number(bfRow.skipped_duplicate ?? 0).toLocaleString()}</dd>
                                </div>
                                <div>
                                  <dt className="text-[10px] uppercase tracking-wide text-muted-foreground">Errors</dt>
                                  <dd className="tabular-nums text-foreground">{Number(bfRow.errors ?? 0).toLocaleString()}</dd>
                                </div>
                              </dl>
                              {bfRow.last_error ? (
                                <p className="mt-2 rounded border border-destructive/30 bg-destructive/10 px-2 py-1 font-mono text-[10px] text-destructive">
                                  {String(bfRow.last_error)}
                                </p>
                              ) : null}
                              <div className="mt-2 h-2.5 w-full overflow-hidden rounded-full bg-muted">
                                <div
                                  className="h-full rounded-full bg-violet-600 transition-[width] duration-300"
                                  style={{ width: `${bfPct}%` }}
                                />
                              </div>
                              <div className="mt-2 flex flex-wrap gap-1">
                                <button
                                  type="button"
                                  disabled={
                                    (priceBackfillBusyUploadId !== null && priceBackfillBusyUploadId !== row.upload_id) || isBusy
                                  }
                                  className={histBtnPri}
                                  onClick={() => void runPimPriceBackfillForUpload(row.upload_id)}
                                >
                                  {priceBackfillBusyUploadId === row.upload_id ? "Working…" : "Import prices to database"}
                                </button>
                                <button
                                  type="button"
                                  className={histBtn}
                                  onClick={() => void refreshPriceBackfillSnapshot(row.upload_id)}
                                >
                                  Refresh progress
                                </button>
                                {(bfSt === "running" || bfSt === "paused" || priceBackfillBusyUploadId === row.upload_id) &&
                                organizationId ? (
                                  <button
                                    type="button"
                                    className={histBtn}
                                    onClick={async () => {
                                      const oid = organizationId.trim();
                                      await pimPriceBackfillStep({
                                        organizationId: oid,
                                        uploadId: row.upload_id,
                                        cancel: true,
                                      });
                                      void refreshPriceBackfillSnapshot(row.upload_id);
                                      void refreshHistory();
                                    }}
                                  >
                                    Cancel backfill
                                  </button>
                                ) : null}
                              </div>
                            </div>
                          ) : null}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            </div>
          )}
          </div>
        </div>


        {phase === "success" && metrics && (
          <div id="pim-quick-import-success" className="space-y-4">
            <div className="flex items-center gap-2 text-sm text-emerald-600 dark:text-emerald-400">
              <CheckCircle2 className="h-4 w-4 shrink-0" />
              <span>{successMessage}</span>
            </div>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {typeof metrics.sheets_processed === "number" && metrics.sheets_processed > 0 ? (
                <MetricCard icon={FileSpreadsheet} label="Sheets processed" value={metrics.sheets_processed} tone="slate" />
              ) : null}
              {typeof metrics.rows_processed === "number" && (
                <MetricCard icon={Table2} label="Rows processed" value={metrics.rows_processed} tone="slate" />
              )}
              <MetricCard icon={Building2} label="Vendors created" value={metrics.vendors_created} tone="sky" />
              {typeof metrics.vendors_reused === "number" ? (
                <MetricCard icon={Building2} label="Vendors reused" value={metrics.vendors_reused} tone="emerald" />
              ) : null}
              {typeof metrics.categories_created === "number" && (
                <MetricCard icon={LayoutGrid} label="Categories created" value={metrics.categories_created} tone="sky" />
              )}
              {typeof metrics.categories_reused === "number" ? (
                <MetricCard icon={LayoutGrid} label="Categories reused" value={metrics.categories_reused} tone="emerald" />
              ) : null}
              <MetricCard icon={Package} label="Products created" value={metrics.products_created} tone="violet" />
              {typeof metrics.products_updated === "number" && (
                <MetricCard icon={Package} label="Products updated" value={metrics.products_updated} tone="violet" />
              )}
              <MetricCard
                icon={Globe2}
                label="Enriched by Amazon"
                value={metrics.products_enriched_by_amazon}
                tone="emerald"
              />
              <MetricCard
                icon={Link2}
                label="Catalog link rows created"
                value={metrics.identifiers_created ?? metrics.skus_mapped ?? 0}
                tone="amber"
              />
              {typeof metrics.identifiers_updated === "number" && (
                <MetricCard icon={Link2} label="Catalog link rows updated" value={metrics.identifiers_updated} tone="amber" />
              )}
              {typeof metrics.prices_inserted === "number" && (
                <MetricCard icon={FileSpreadsheet} label="Prices inserted" value={metrics.prices_inserted} tone="emerald" />
              )}
              {typeof metrics.skipped_no_identity === "number" && (
                <MetricCard icon={Ban} label="Skipped (no identity)" value={metrics.skipped_no_identity} tone="slate" />
              )}
              {typeof metrics.skipped_ambiguous === "number" && (
                <MetricCard icon={Ban} label="Skipped (ambiguous)" value={metrics.skipped_ambiguous} tone="slate" />
              )}
              {typeof metrics.skipped_garbage === "number" && (
                <MetricCard icon={Ban} label="Rows skipped (legacy)" value={metrics.skipped_garbage} tone="slate" />
              )}
            </div>
            {metrics.reconciliation && typeof metrics.reconciliation === "object" ? (
              <div className="rounded-lg border border-border/60 bg-muted/15 px-3 py-3 text-xs">
                <p className="font-medium text-foreground">Preview vs apply reconciliation</p>
                <ul className="mt-2 grid gap-1 sm:grid-cols-2">
                  {Object.entries(metrics.reconciliation).map(([k, v]) => (
                    <li key={k} className="text-muted-foreground">
                      <span className="font-medium text-foreground">{k.replace(/_/g, " ")}:</span>{" "}
                      {typeof v === "object" ? JSON.stringify(v) : String(v)}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            <div className="rounded-lg border border-border/60 bg-muted/10 px-3 py-3 text-xs">
              <p className="font-medium text-foreground">Import cleaning (apply)</p>
              <div className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                <MetricCard icon={Scissors} label="Fields trimmed (cells)" value={metrics.fields_trimmed ?? 0} tone="slate" />
                <MetricCard icon={Split} label="Multi-ID cells split" value={metrics.multi_identifier_cells_split ?? 0} tone="slate" />
                <MetricCard
                  icon={Link2}
                  label="ID tokens accepted"
                  value={metrics.identifier_tokens_accepted ?? metrics.identifier_tokens_created ?? 0}
                  tone="emerald"
                />
                <MetricCard icon={Ban} label="ID tokens rejected" value={metrics.identifier_tokens_rejected ?? 0} tone="amber" />
                <MetricCard
                  icon={Copy}
                  label="Duplicate tokens collapsed"
                  value={metrics.duplicate_identifier_tokens_collapsed ?? 0}
                  tone="slate"
                />
                <MetricCard
                  icon={AlertTriangle}
                  label="Ambiguous multi-ID rows"
                  value={metrics.ambiguous_multi_identifier_rows ?? 0}
                  tone="amber"
                />
              </div>
            </div>
            {metrics.rows_per_sheet && Object.keys(metrics.rows_per_sheet).length > 0 ? (
              <div className="rounded-lg border border-border/60 bg-muted/15 px-3 py-2 text-xs text-muted-foreground">
                <p className="font-medium text-foreground">Rows per sheet</p>
                <ul className="mt-1 list-inside list-disc space-y-0.5">
                  {Object.entries(metrics.rows_per_sheet).map(([name, n]) => (
                    <li key={name}>
                      {name}: {n}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {Array.isArray(metrics.errors) && metrics.errors.length > 0 ? (
              <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-950 dark:text-amber-100">
                <p className="font-medium">Import messages ({metrics.errors.length})</p>
                <ul className="mt-2 max-h-40 list-inside list-disc space-y-1 overflow-y-auto">
                  {metrics.errors.slice(0, 25).map((e, i) => (
                    <li key={i}>{e}</li>
                  ))}
                </ul>
              </div>
            ) : null}
            <button
              type="button"
              onClick={resetImport}
              className="text-sm font-medium text-primary underline-offset-4 hover:underline"
            >
              Upload another file
            </button>
          </div>
        )}



      </div>
      {clearStaleModalOpen ? (
        <div className="fixed inset-0 z-[80] flex items-start justify-center px-4 py-16" role="dialog" aria-modal="true">
          <button
            type="button"
            className="absolute inset-0 bg-black/40"
            aria-label="Close clear stale dialog"
            onClick={() => setClearStaleModalOpen(false)}
          />
          <div className="relative z-[81] w-full max-w-md rounded-xl border border-border bg-card p-5 shadow-lg">
            <h4 className="text-base font-semibold text-foreground">Clear stale uploads?</h4>
            <p className="mt-2 text-sm text-muted-foreground">
              Removes Product Master uploads for this store that have <span className="font-medium text-foreground">no catalog writes</span>{" "}
              (no products, identifiers, or prices recorded on the session), plus any orphan upload rows that failed to link to a session.
              Partially imported jobs with writes are skipped.
            </p>
            <div className="mt-5 flex flex-wrap justify-end gap-2">
              <button type="button" className={btnSecondary} onClick={() => setClearStaleModalOpen(false)}>
                Cancel
              </button>
              <button type="button" className={btnDanger} onClick={() => void confirmClearStalePimUploads()}>
                Clear stale
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {importDeleteModal ? (
        <div className="fixed inset-0 z-[80] flex items-start justify-center px-4 py-16" role="dialog" aria-modal="true">
          <button
            type="button"
            className="absolute inset-0 bg-black/40"
            aria-label="Close delete dialog"
            onClick={() => setImportDeleteModal(null)}
          />
          <div className="relative z-[81] w-full max-w-md rounded-xl border border-border bg-card p-5 shadow-lg">
            <h4 className="text-base font-semibold text-foreground">Delete this import?</h4>
            <p className="mt-2 text-sm text-muted-foreground">
              <span className="font-medium text-foreground">{importDeleteModal.fileLabel}</span>
            </p>
            {importDeleteModal.warnCatalog ? (
              <p className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-950 dark:text-amber-100">
                Some catalog rows were already written from this job. Deleting removes the upload session and file records only — products and
                prices already in the catalog stay as they are.
              </p>
            ) : (
              <p className="mt-3 text-sm text-muted-foreground">
                This removes the upload, session, and preview data from the import workspace. Catalog products are not changed.
              </p>
            )}
            <div className="mt-5 flex flex-wrap justify-end gap-2">
              <button type="button" className={btnSecondary} onClick={() => setImportDeleteModal(null)}>
                Cancel
              </button>
              <button type="button" className={btnDanger} onClick={() => void confirmPimImportDeleteModal()}>
                Delete
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function SeedCleaningPreviewGrid({ q }: { q: PimCatalogSeedQuality }) {
  return (
    <div className="mt-3 border-t border-border/40 pt-3">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-xs font-medium text-foreground">Import cleaning</p>
        <PimHelpNote label="Import cleaning metrics">
          <div>
            Cells are trimmed before mapping. UPC, ASIN, FNSKU, and seller SKU cells may be split into separate identifier tokens. Use these
            counts to spot messy source files before confirming an import.
          </div>
        </PimHelpNote>
      </div>
      <p className="mt-0.5 text-[11px] text-muted-foreground">Tokenization and map row estimates from the preview run.</p>
      <div className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-3 text-xs">
        <MetricCard icon={Scissors} label="Fields trimmed (cells)" value={q.fields_trimmed ?? 0} tone="slate" />
        <MetricCard icon={Split} label="Multi-ID cells split" value={q.multi_identifier_cells_split ?? 0} tone="slate" />
        <MetricCard
          icon={Link2}
          label="ID tokens accepted"
          value={q.identifier_tokens_accepted ?? q.identifier_tokens_created ?? 0}
          tone="emerald"
        />
        <MetricCard
          icon={LayoutGrid}
          label="Identifier rows (would insert)"
          value={q.identifier_rows_would_insert ?? q.identifier_map_rows_would_insert ?? 0}
          tone="violet"
        />
        <MetricCard
          icon={LayoutGrid}
          label="Identifier rows (would update)"
          value={q.identifier_rows_would_update ?? q.identifier_map_rows_would_update ?? 0}
          tone="violet"
        />
        <MetricCard icon={Ban} label="ID tokens rejected" value={q.identifier_tokens_rejected ?? 0} tone="amber" />
        <MetricCard
          icon={Copy}
          label="Duplicate tokens collapsed"
          value={q.duplicate_identifier_tokens_collapsed ?? 0}
          tone="slate"
        />
        <MetricCard
          icon={AlertTriangle}
          label="Ambiguous multi-ID rows"
          value={q.ambiguous_multi_identifier_rows ?? 0}
          tone="amber"
        />
        <MetricCard
          icon={Package}
          label="Existing products matched"
          value={q.existing_products_matched ?? 0}
          tone="emerald"
        />
        <MetricCard icon={Copy} label="Links already complete" value={q.duplicates_reused ?? 0} tone="slate" />
        <MetricCard
          icon={AlertTriangle}
          label="Conflicting matches (skipped)"
          value={q.ambiguous_matches ?? q.skipped_ambiguous ?? 0}
          tone="amber"
        />
        <MetricCard icon={Package} label="Would create products" value={q.would_create_products ?? q.products_would_create ?? 0} tone="violet" />
        <MetricCard icon={Package} label="Would update products" value={q.would_update_products ?? q.products_would_update ?? 0} tone="violet" />
        <MetricCard
          icon={FileSpreadsheet}
          label="Prices would insert"
          value={q.prices_would_insert ?? 0}
          tone="violet"
        />
        <MetricCard icon={Building2} label="Vendors would create" value={q.vendors_would_create ?? 0} tone="sky" />
        <MetricCard icon={Building2} label="Vendors reused" value={q.vendors_reused ?? 0} tone="emerald" />
        <MetricCard icon={Tag} label="Categories would create" value={q.categories_would_create ?? 0} tone="sky" />
        <MetricCard icon={Tag} label="Categories reused" value={q.categories_reused ?? 0} tone="emerald" />
        <MetricCard
          icon={Split}
          label="Metadata rows (extra cols detected)"
          value={q.metadata_attributes_detected ?? 0}
          tone="slate"
        />
        <MetricCard
          icon={Ban}
          label="Rows skipped"
          value={q.rows_skipped ?? (q.skipped_no_identity ?? 0) + (q.skipped_ambiguous ?? 0)}
          tone="slate"
        />
        <MetricCard icon={AlertTriangle} label="Ambiguous rows" value={q.ambiguous_rows ?? q.skipped_ambiguous ?? 0} tone="amber" />
      </div>
    </div>
  );
}

function MetricCard({
  icon: Icon,
  label,
  value,
  tone,
}: {
  icon: React.ElementType;
  label: string;
  value: number | string;
  tone: "sky" | "violet" | "emerald" | "amber" | "slate";
}) {
  const toneRing: Record<typeof tone, string> = {
    sky: "ring-sky-500/20 bg-sky-500/5",
    violet: "ring-violet-500/20 bg-violet-500/5",
    emerald: "ring-emerald-500/20 bg-emerald-500/5",
    amber: "ring-amber-500/20 bg-amber-500/5",
    slate: "ring-slate-500/20 bg-slate-500/5",
  };
  const toneIcon: Record<typeof tone, string> = {
    sky: "text-sky-600 dark:text-sky-400",
    violet: "text-violet-600 dark:text-violet-400",
    emerald: "text-emerald-600 dark:text-emerald-400",
    amber: "text-amber-600 dark:text-amber-400",
    slate: "text-slate-600 dark:text-slate-400",
  };

  return (
    <div className={`rounded-xl border border-border/60 p-5 shadow-sm ring-1 backdrop-blur-sm ${toneRing[tone]}`}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
          <p className="mt-2 text-3xl font-semibold tabular-nums tracking-tight text-foreground">{value}</p>
        </div>
        <div className={`rounded-lg border border-border/40 bg-background/80 p-2 ${toneIcon[tone]}`}>
          <Icon className="h-5 w-5" aria-hidden />
        </div>
      </div>
    </div>
  );
}

type IntegrationsPanelProps = {
  organizationId: string | null;
};

function IntegrationsPanel({ organizationId }: IntegrationsPanelProps) {
  return <IntegrationsHub organizationId={organizationId} />;
}

function GoogleSheetsStatusCard({
  sheetIdConfigured,
  serviceAccountConfigured,
  configureHref,
  canConfigureSettings,
  accessDeniedLikely,
}: {
  sheetIdConfigured: boolean;
  serviceAccountConfigured: boolean;
  configureHref: string;
  canConfigureSettings: boolean;
  /** True when a recent sync/preview error looks like Google denied access (e.g. 403). */
  accessDeniedLikely?: boolean;
}) {
  const fullyConfigured = sheetIdConfigured && serviceAccountConfigured;
  const neither = !sheetIdConfigured && !serviceAccountConfigured;
  const headline =
    accessDeniedLikely && fullyConfigured
      ? "Spreadsheet not shared with the service account"
      : fullyConfigured
        ? "Configured"
        : neither
          ? "Missing spreadsheet ID and service account"
          : !sheetIdConfigured
            ? "Missing spreadsheet ID"
            : "Missing service account JSON";
  const tone =
    fullyConfigured && !accessDeniedLikely
      ? "text-emerald-600 dark:text-emerald-400"
      : "text-amber-700 dark:text-amber-300";
  return (
    <div className="rounded-xl border border-border/60 bg-muted/10 p-4 shadow-sm">
      <div className="flex items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-border/50 bg-card">
          <Table2 className="h-5 w-5 text-primary" aria-hidden />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-foreground">Google Sheets</p>
          <p className="mt-1 text-xs text-muted-foreground">Catalog sync uses a spreadsheet ID plus a service account key.</p>
          <p className={`mt-2 text-sm font-medium ${tone}`}>{headline}</p>
          <ul className="mt-2 space-y-0.5 text-[11px] text-muted-foreground">
            <li>Spreadsheet ID: {sheetIdConfigured ? <span className="text-foreground">Set</span> : <span>Not set</span>}</li>
            <li>Service account JSON: {serviceAccountConfigured ? <span className="text-foreground">Present</span> : <span>Missing</span>}</li>
            {accessDeniedLikely && fullyConfigured ? (
              <li className="text-amber-800 dark:text-amber-200">Access: permission issue detected on last request</li>
            ) : null}
          </ul>
          {canConfigureSettings ? (
            <Link
              href={configureHref}
              className="mt-2 inline-block text-xs font-medium text-primary underline-offset-2 hover:underline"
            >
              Open Catalog &amp; Google Sheets in Settings
            </Link>
          ) : (
            <p className="mt-2 text-xs text-muted-foreground">Contact an admin to configure.</p>
          )}
        </div>
      </div>
    </div>
  );
}

function IntegrationStatusCard({
  title,
  description,
  icon: Icon,
  connected,
  configureHref,
  canConfigureSettings,
}: {
  title: string;
  description: string;
  icon: React.ElementType;
  connected: boolean;
  configureHref: string;
  canConfigureSettings: boolean;
}) {
  return (
    <div className="rounded-xl border border-border/60 bg-muted/10 p-4 shadow-sm">
      <div className="flex items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-border/50 bg-card">
          <Icon className="h-5 w-5 text-primary" aria-hidden />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-foreground">{title}</p>
          <p className="mt-1 text-xs text-muted-foreground">{description}</p>
          <p
            className={
              connected
                ? "mt-2 text-sm font-medium text-emerald-600 dark:text-emerald-400"
                : "mt-2 text-sm font-medium text-amber-700 dark:text-amber-300"
            }
          >
            {connected ? "Connected" : "Not configured"}
          </p>
          {canConfigureSettings ? (
            <Link
              href={configureHref}
              className="mt-2 inline-block text-xs font-medium text-primary underline-offset-2 hover:underline"
            >
              Open in Settings
            </Link>
          ) : (
            <p className="mt-2 text-xs text-muted-foreground">Contact an admin to configure.</p>
          )}
        </div>
      </div>
    </div>
  );
}

function IntegrationsHub({ organizationId }: { organizationId: string | null }) {
  const { canSeeSettings } = useRbacPermissions();
  const [summary, setSummary] = useState<PimIntegrationsSummary | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadingSummary, setLoadingSummary] = useState(false);
  const [syncPhase, setSyncPhase] = useState<"idle" | "syncing" | "preview_ready" | "done" | "error">("idle");
  const [sheetsBusyKind, setSheetsBusyKind] = useState<null | "preview" | "apply">(null);
  const [sheetsPreviewQuality, setSheetsPreviewQuality] = useState<PimCatalogSeedQuality | null>(null);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [syncErrorDetail, setSyncErrorDetail] = useState<string | null>(null);

  const loadSummary = useCallback(async () => {
    if (!organizationId?.trim()) {
      setSummary(null);
      setLoadError(null);
      setLoadingSummary(false);
      return;
    }
    setLoadingSummary(true);
    setLoadError(null);
    try {
      const res = await getPimIntegrationsSummary(organizationId.trim());
      if (!res.ok) {
        setLoadError(res.error);
        setSummary(null);
        return;
      }
      setSummary(res.data);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Failed to load integrations.");
      setSummary(null);
    } finally {
      setLoadingSummary(false);
    }
  }, [organizationId]);

  useEffect(() => {
    void loadSummary();
  }, [loadSummary]);

  async function previewGoogleSheetsSync() {
    const oid = organizationId?.trim();
    if (!oid) return;
    setSyncPhase("syncing");
    setSheetsBusyKind("preview");
    setSyncError(null);
    setSyncErrorDetail(null);
    setSyncMessage(null);
    setSheetsPreviewQuality(null);
    try {
      if (!summary?.googleSheetId?.trim()) {
        setSyncErrorDetail(null);
        setSyncError("Spreadsheet ID is not set. Add it under Settings → Catalog & Google Sheets.");
        setSyncPhase("error");
        return;
      }
      const sid = summary?.defaultStoreId?.trim();
      if (!sid) {
        setSyncErrorDetail(null);
        setSyncError("Set a default store in Settings → General (or pick a store for imports) before Google Sheets sync.");
        setSyncPhase("error");
        return;
      }
      const fd = new FormData();
      fd.append("organization_id", oid);
      fd.append("store_id", sid);
      fd.append("mode", "preview");
      const base = etlApiBase();
      const res = await axios.post<SeedProductsResponse>(`${base}/etl/sync-google-sheets`, fd, {
        timeout: 120_000,
      });
      const q = res.data?.quality;
      if (res.data?.status === "preview" && q && typeof q === "object") {
        setSheetsPreviewQuality(q);
        setSyncMessage(res.data.message ?? "Preview ready — review quality, then confirm sync.");
        setSyncPhase("preview_ready");
      } else {
        setSyncErrorDetail(JSON.stringify(res.data ?? null).slice(0, 4000));
        setSyncError("Unexpected response: expected preview + quality.");
        setSyncPhase("error");
      }
    } catch (err) {
      const raw = axiosMessage(err, "Google Sheets preview failed.");
      setSyncErrorDetail(raw);
      setSyncError(humanizeGoogleSheetsError(raw));
      setSyncPhase("error");
    } finally {
      setSheetsBusyKind(null);
    }
  }

  async function applyGoogleSheetsSync() {
    const oid = organizationId?.trim();
    if (!oid) return;
    if (syncPhase !== "preview_ready" || !sheetsPreviewQuality) {
      setSyncErrorDetail(null);
      setSyncError("Run Preview first.");
      setSyncPhase("error");
      return;
    }
    if (sheetsPreviewQuality.apply_blocked_by_dirty_rate) {
      setSyncErrorDetail(null);
      setSyncError(
        `Sync blocked: dirty rate ${String(sheetsPreviewQuality.dirty_rate)} exceeds max ${String(sheetsPreviewQuality.max_dirty_rate)}.`,
      );
      setSyncPhase("error");
      return;
    }
    setSyncPhase("syncing");
    setSheetsBusyKind("apply");
    setSyncError(null);
    setSyncErrorDetail(null);
    setSyncMessage(null);
    try {
      if (!summary?.googleSheetId?.trim()) {
        setSyncErrorDetail(null);
        setSyncError("Spreadsheet ID is not set. Add it under Settings → Catalog & Google Sheets.");
        setSyncPhase("error");
        return;
      }
      const sid = summary?.defaultStoreId?.trim();
      if (!sid) {
        setSyncErrorDetail(null);
        setSyncError("Set a default store in Settings → General before Google Sheets sync.");
        setSyncPhase("error");
        return;
      }
      const fd = new FormData();
      fd.append("organization_id", oid);
      fd.append("store_id", sid);
      fd.append("mode", "apply");
      fd.append("confirm", "true");
      const base = etlApiBase();
      const res = await axios.post<SeedProductsResponse>(`${base}/etl/sync-google-sheets`, fd, {
        timeout: 120_000,
      });
      setSyncMessage(res.data?.message ?? res.data?.status ?? "Sync finished.");
      setSheetsPreviewQuality(null);
      setSyncPhase("done");
      void loadSummary();
      window.dispatchEvent(new Event("pim-catalog-refresh"));
    } catch (err) {
      const raw = axiosMessage(err, "Google Sheets sync failed.");
      setSyncErrorDetail(raw);
      setSyncError(humanizeGoogleSheetsError(raw));
      setSyncPhase("error");
    } finally {
      setSheetsBusyKind(null);
    }
  }

  const sheetId = summary?.googleSheetId?.trim() ?? "";
  const googleReady = Boolean(summary?.connectionStatus.googleSheets);
  const amazonReady = Boolean(summary?.connectionStatus.amazonSpApi);
  const openAiReady = Boolean(summary?.connectionStatus.openai);
  const googleSheetsAccessDeniedLikely =
    syncPhase === "error" && looksLikeGoogleSheetsPermissionError(syncErrorDetail);

  return (
    <div className="space-y-6">
      {!organizationId?.trim() ? (
        <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-900 dark:text-amber-100">
          Select a workspace organization in the header.
        </p>
      ) : null}

      {loadError ? (
        <div
          className="flex flex-col gap-3 rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-4 sm:flex-row sm:items-center sm:justify-between"
          role="alert"
        >
          <p className="text-sm text-destructive">{loadError}</p>
          <button
            type="button"
            disabled={loadingSummary || !organizationId?.trim()}
            onClick={() => void loadSummary()}
            className="inline-flex shrink-0 items-center gap-2 rounded-lg border border-border bg-background px-3 py-2 text-sm font-medium text-foreground transition hover:bg-accent disabled:opacity-50"
          >
            <RefreshCw className={`h-4 w-4 ${loadingSummary ? "animate-spin" : ""}`} />
            Retry
          </button>
        </div>
      ) : null}

      <section
        className="rounded-2xl border border-border/60 bg-card/70 p-6 shadow-xl backdrop-blur-md dark:bg-card/50 sm:p-8"
        aria-labelledby="integrations-status-heading"
      >
        <div className="flex flex-wrap items-center gap-2">
          <h2 id="integrations-status-heading" className="text-lg font-semibold text-foreground">
            Connection status
          </h2>
          <PimHelpNote label="Integrations help">
            <div>
              Read-only summary of workspace keys (no secrets on this page). Configure Amazon SP-API, AI quotas, and Google Sheets in Settings.
            </div>
          </PimHelpNote>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">Connection status for catalog enrichment and sync.</p>
        {loadingSummary && !summary ? (
          <div className="mt-6 flex justify-center py-10">
            <Loader2 className="h-8 w-8 animate-spin text-primary" aria-label="Loading" />
          </div>
        ) : (
          <div className="mt-6 grid gap-4 sm:grid-cols-3">
            <IntegrationStatusCard
              title="Amazon SP-API"
              description="Selling Partner / marketplace credentials for enrichment and catalog."
              icon={Globe2}
              connected={amazonReady}
              configureHref="/settings#marketplaces"
              canConfigureSettings={canSeeSettings}
            />
            <IntegrationStatusCard
              title="OpenAI / GPT"
              description="LLM keys used by Sheets sync and intelligent mapping when configured."
              icon={Sparkles}
              connected={openAiReady}
              configureHref="/settings#ai_quotas"
              canConfigureSettings={canSeeSettings}
            />
            <GoogleSheetsStatusCard
              sheetIdConfigured={Boolean(sheetId)}
              serviceAccountConfigured={googleReady}
              configureHref="/settings#catalog_imports"
              canConfigureSettings={canSeeSettings}
              accessDeniedLikely={googleSheetsAccessDeniedLikely}
            />
          </div>
        )}
      </section>

      <section
        className="rounded-2xl border border-border/60 bg-card/70 p-6 shadow-xl backdrop-blur-md dark:bg-card/50 sm:p-8"
        aria-labelledby="integrations-google-heading"
      >
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex items-start gap-3">
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border border-border/60 bg-gradient-to-br from-violet-500/15 to-sky-500/15">
              <Table2 className="h-6 w-6 text-primary" aria-hidden />
            </div>
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <h2 id="integrations-google-heading" className="text-lg font-semibold text-foreground">
                  Google Sheets sync
                </h2>
                <PimHelpNote label="Google Sheets sync help">
                  <div>
                    Preview runs with <strong>no writes</strong>; confirm applies changes. Requires a default store, spreadsheet ID, and service
                    account credentials in Settings.
                  </div>
                </PimHelpNote>
              </div>
              <p className="mt-1 text-sm text-muted-foreground">Pull catalog updates from your linked spreadsheet.</p>
              {canSeeSettings ? (
                <Link
                  href="/settings#catalog_imports"
                  className="mt-2 inline-flex text-xs font-semibold text-primary underline-offset-2 hover:underline"
                >
                  Open Settings → Catalog &amp; Google Sheets
                </Link>
              ) : null}
            </div>
          </div>
        </div>

        <div className="mt-6 rounded-xl border border-border/60 bg-muted/15 p-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Spreadsheet</p>
          {loadingSummary && !summary ? (
            <div className="flex justify-center py-6">
              <Loader2 className="h-6 w-6 animate-spin text-primary" aria-label="Loading" />
            </div>
          ) : (
            <div className="mt-2 space-y-1 text-sm">
              <p className="text-foreground">
                {sheetId ? (
                  <>
                    Linked:{" "}
                    <span className="font-mono text-xs break-all">
                      {sheetId.length > 28 ? `${sheetId.slice(0, 12)}…${sheetId.slice(-8)}` : sheetId}
                    </span>
                  </>
                ) : (
                  <span className="text-muted-foreground">No spreadsheet ID saved for this workspace yet.</span>
                )}
              </p>
              <p className="text-xs text-muted-foreground">
                Service account:{" "}
                <span className={googleReady ? "font-medium text-emerald-600 dark:text-emerald-400" : "font-medium text-amber-700 dark:text-amber-300"}>
                  {googleReady ? "Key on file" : "Not configured"}
                </span>
              </p>
            </div>
          )}
        </div>

        <div className="mt-6 flex flex-col gap-3 sm:flex-row">
          <button
            type="button"
            disabled={!organizationId?.trim() || syncPhase === "syncing" || loadingSummary}
            onClick={() => void previewGoogleSheetsSync()}
            className="flex min-h-[3.25rem] flex-1 items-center justify-center gap-2 rounded-2xl border border-border bg-background px-4 py-3 text-base font-semibold text-foreground shadow-sm transition hover:bg-muted/40 disabled:cursor-not-allowed disabled:opacity-45"
          >
            {syncPhase === "syncing" && sheetsBusyKind === "preview" ? (
              <>
                <Loader2 className="h-5 w-5 shrink-0 animate-spin" />
                Scanning…
              </>
            ) : (
              <>
                <Table2 className="h-5 w-5 shrink-0" />
                Preview Sheets sync
              </>
            )}
          </button>
          <button
            type="button"
            disabled={
              !organizationId?.trim() ||
              syncPhase === "syncing" ||
              loadingSummary ||
              syncPhase !== "preview_ready" ||
              !sheetsPreviewQuality ||
              Boolean(sheetsPreviewQuality.apply_blocked_by_dirty_rate)
            }
            onClick={() => void applyGoogleSheetsSync()}
            className="flex min-h-[3.25rem] flex-1 items-center justify-center gap-2 rounded-2xl bg-gradient-to-r from-violet-600 to-sky-600 px-4 py-3 text-base font-bold tracking-tight text-white shadow-lg shadow-violet-500/25 transition hover:opacity-95 disabled:cursor-not-allowed disabled:opacity-45"
          >
            {syncPhase === "syncing" && sheetsBusyKind === "apply" ? (
              <>
                <Loader2 className="h-5 w-5 shrink-0 animate-spin" />
                Writing…
              </>
            ) : (
              <>
                <Cloud className="h-5 w-5 shrink-0" />
                Confirm Sheets sync
              </>
            )}
          </button>
        </div>
        <details className="mt-2 text-center text-[11px] text-muted-foreground">
          <summary className="cursor-pointer select-none text-xs font-medium text-foreground/80">API details (debug)</summary>
          <p className="mt-2">
            POST <code className="rounded bg-muted px-1">{etlApiBase()}/etl/sync-google-sheets</code> with{" "}
            <code className="rounded bg-muted px-1">organization_id</code>, <code className="rounded bg-muted px-1">store_id</code>,{" "}
            <code className="rounded bg-muted px-1">mode=preview|apply</code>, and <code className="rounded bg-muted px-1">confirm=true</code> for
            apply.
          </p>
        </details>
        {syncPhase === "preview_ready" && sheetsPreviewQuality ? (
          <div className="mt-4 rounded-lg border border-border/60 bg-muted/15 px-3 py-3 text-xs text-muted-foreground">
            <div className="flex flex-wrap items-center gap-2">
              <p className="font-medium text-foreground">Sheets preview</p>
              <PimHelpNote label="Sheets preview">
                <div>
                  Same quality gates as file import (dirty rows, rate cap, estimates). Confirm applies only after a successful preview. If the AI
                  module is enabled, mapping or validation may be assisted automatically.
                </div>
              </PimHelpNote>
            </div>
            <p className="mt-1">
              Rows {sheetsPreviewQuality.rows_total ?? "—"}, dirty {sheetsPreviewQuality.dirty_rows ?? "—"}, rate{" "}
              {String(sheetsPreviewQuality.dirty_rate ?? "—")} (max {String(sheetsPreviewQuality.max_dirty_rate ?? "—")}). Would
              create products: {sheetsPreviewQuality.products_would_create ?? 0}.
            </p>
            <SeedCleaningPreviewGrid q={sheetsPreviewQuality} />
          </div>
        ) : null}
        {syncMessage ? (
          <p className="mt-4 text-center text-sm font-medium text-emerald-600 dark:text-emerald-400">{syncMessage}</p>
        ) : null}
        {syncError ? (
          <div className="mt-4 rounded-lg border border-destructive/25 bg-destructive/5 px-4 py-3 text-center" role="alert">
            <p className="text-sm text-destructive">{syncError}</p>
            {canSeeSettings ? (
              <Link
                href="/settings#catalog_imports"
                className="mt-2 inline-block text-xs font-semibold text-primary underline-offset-2 hover:underline"
              >
                Open Catalog &amp; Google Sheets in Settings
              </Link>
            ) : null}
            {syncErrorDetail ? (
              <details className="mt-3 text-left">
                <summary className="cursor-pointer text-xs font-medium text-muted-foreground">Technical details</summary>
                <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded border border-border/60 bg-muted/30 p-2 text-[11px] text-foreground">
                  {syncErrorDetail}
                </pre>
              </details>
            ) : null}
          </div>
        ) : null}
      </section>
    </div>
  );
}
