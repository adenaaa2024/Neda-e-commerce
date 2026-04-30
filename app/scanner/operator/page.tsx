"use client";

/**
 * Operator scanner — scan-first, hierarchical workspace flow.
 *
 * View state machine
 * ------------------
 *   Home (lane = null)
 *     -> New Receiving      (lane = "new")
 *     -> Continue Existing  (lane = "continue")
 *
 *   In a lane, the body renders ONE of:
 *     - Workspace    (primary: pallet | package | loose-item + scan list)
 *     - Expected inbound card + one-tap create (read-only expected_packages until create)
 *     - “What is this?” quick creates (pallet / package / loose item) when no DB match
 *     - Optional compact forms (“Detailed … form”) without duplicating Returns / Meysam UI
 *
 * Database access
 * ---------------
 * All writes go through existing server actions (no duplicated DB logic, no schema changes).
 * Direct (org-scoped, RLS-enforced) Supabase reads are used only for scan resolution:
 *   expected_packages (read-only) → pallets → packages → returns (LPN / product_identifier).
 * `listPallets/Packages/Returns` snapshots refresh after lookups and writes for child lists.
 *
 * Visuals: premium gold accent in both themes — explicit hex + Tailwind `dark:` variants so the
 * page follows the app light/dark toggle (no shadcn semantic color tokens).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useUserRole } from "@/components/UserRoleContext";
import { listStores, type StorePublicRow } from "@/app/settings/adapters/actions";
import {
  createPackage,
  createPallet,
  insertReturn,
  listOpenPackages,
  listPackages,
  listPallets,
  listReturns,
  updatePackage,
  updatePallet,
  updateReturn,
} from "@/app/returns/actions";
import type {
  PackageRecord,
  PackageUpdatePayload,
  PalletRecord,
  ReturnRecord,
} from "@/app/returns/returns-action-types";
import type { TenantQueryOpts } from "@/lib/server-tenant";
import { isUuidString } from "@/lib/uuid";
import { isSupabaseConfigured, supabase } from "@/src/lib/supabase";
import {
  AlertCircle,
  ArrowLeft,
  Box,
  Boxes,
  Camera,
  CheckCircle2,
  ChevronRight,
  Loader2,
  Package,
  ScanLine,
  Search,
  XCircle,
} from "lucide-react";

/* ------------------------------------------------------------------ */
/* Theme-aware luxury gold — light default + `dark:` (follows app toggle). */
/* ------------------------------------------------------------------ */

/**
 * Route shell: at least viewport height, no `overflow-hidden` trap — document/body (or AppShell)
 * can scroll so forms and workspace lists stay reachable on mobile.
 */
const PAGE_BG =
  "flex flex-1 min-h-screen w-full min-w-0 flex-col antialiased [color-scheme:light] text-[#0F172A] bg-[#FAF7EF] dark:[color-scheme:dark] " +
  "bg-[radial-gradient(ellipse_100%_55%_at_50%_-8%,rgba(214,180,106,0.14),transparent_52%),linear-gradient(180deg,#FFFCF7_0%,#FAF7EF_100%)] " +
  "dark:text-[#F8FAFC] dark:bg-[#020617] " +
  "dark:bg-[radial-gradient(ellipse_100%_50%_at_50%_-12%,rgba(255,215,0,0.09),transparent_52%),linear-gradient(180deg,#030712_0%,#020617_50%,#020617_100%)] " +
  "dark:shadow-[inset_0_0_100px_rgba(0,0,0,0.45)]";

/** Shared scan field hint (home + lane lookup, pallet tracking). */
const SCAN_PLACEHOLDER_TRACKING = "Scan or type Tracking Number";

const TEXT_BODY = "text-[#0F172A] dark:text-[#F8FAFC]";
const TEXT_SUBTLE = "text-[#475569] dark:text-[#94A3B8]";

const CARD =
  "rounded-2xl border border-[#D6B46A]/30 bg-white p-6 " +
  "shadow-[0_0_0_1px_rgba(214,180,106,0.08),0_8px_28px_rgba(15,23,42,0.06),0_0_40px_-12px_rgba(214,180,106,0.12)] " +
  "dark:border-[#F5C542]/28 dark:bg-[#0B1220] " +
  "dark:shadow-[0_0_0_1px_rgba(245,197,66,0.06),0_12px_40px_rgba(0,0,0,0.55),0_0_48px_-12px_rgba(255,215,0,0.14)]";

const LABEL = "mb-1.5 block text-xs font-semibold text-[#475569] dark:text-[#94A3B8]";
const SECTION_TITLE = "text-base font-bold tracking-tight text-[#0F172A] dark:text-[#F8FAFC]";
const SECTION_KICKER =
  "text-[10px] font-bold uppercase tracking-[0.18em] text-[#A67C2C] dark:text-[#D6B46A]";
const TEXT_MUTED = "text-[#475569] dark:text-[#94A3B8]";

const INPUT =
  "h-12 w-full rounded-xl border border-[#CBD5E1] bg-white px-4 text-base text-[#0F172A] placeholder:text-[#64748B] " +
  "transition focus:border-[#D6B46A] focus:outline-none focus:ring-2 focus:ring-[#D6B46A]/35 focus:ring-offset-2 focus:ring-offset-[#FAF7EF] " +
  "dark:border-[#F5C542]/20 dark:bg-[#08111F] dark:text-[#F8FAFC] dark:placeholder:text-[#64748B] " +
  "dark:focus:border-[#F5C542]/75 dark:focus:ring-[#F5C542]/40 dark:focus:ring-offset-0 dark:focus:ring-offset-transparent " +
  "dark:focus:shadow-[0_0_0_2px_rgba(245,197,66,0.35),0_0_20px_rgba(255,215,0,0.22)]";
const INPUT_SM =
  "h-10 w-full rounded-lg border border-[#CBD5E1] bg-white px-3 text-sm text-[#0F172A] placeholder:text-[#64748B] " +
  "focus:border-[#D6B46A] focus:outline-none focus:ring-2 focus:ring-[#D6B46A]/35 focus:ring-offset-2 focus:ring-offset-[#FAF7EF] " +
  "dark:border-[#F5C542]/20 dark:bg-[#08111F] dark:text-[#F8FAFC] dark:focus:border-[#F5C542]/75 dark:focus:ring-[#F5C542]/40 dark:focus:ring-offset-0 " +
  "dark:focus:shadow-[0_0_0_2px_rgba(245,197,66,0.3),0_0_16px_rgba(255,215,0,0.2)]";

const SCAN_INPUT =
  "h-16 w-full rounded-2xl border border-[#D6B46A]/35 bg-white px-4 text-center font-mono text-lg font-semibold tracking-wide text-[#0F172A] " +
  "placeholder:text-[10px] placeholder:font-medium placeholder:leading-tight placeholder:tracking-tight placeholder:text-[#64748B] sm:placeholder:text-[11px] " +
  "transition focus:border-[#D6B46A] focus:outline-none focus:ring-2 focus:ring-[#D6B46A]/40 focus:ring-offset-2 focus:ring-offset-[#FAF7EF] " +
  "dark:border-[#F5C542]/25 dark:bg-[#08111F] dark:text-[#F8FAFC] dark:placeholder:text-[#94A3B8] dark:focus:border-[#FFD700]/90 dark:focus:ring-[#F5C542]/45 dark:focus:ring-offset-0 " +
  "dark:focus:shadow-[0_0_0_2px_rgba(255,215,0,0.45),0_0_24px_rgba(255,215,0,0.3),0_0_48px_rgba(245,197,66,0.15)]";

/** Pallet tracking field: same hint as scan inputs, smaller placeholder so it fits in `INPUT`. */
const INPUT_PLACEHOLDER_TRACKING = `${INPUT} placeholder:text-[10px] placeholder:leading-tight placeholder:tracking-tight sm:placeholder:text-xs`;

/**
 * Lookup — saturated gold (light + dark); no gray `disabled:*` on the base token.
 */
const BTN_LOOKUP =
  "flex h-12 w-full items-center justify-center gap-2 rounded-2xl border border-[#FFB300] px-4 font-extrabold tracking-tight text-[#000000] [&_svg]:text-[#000000] " +
  "bg-gradient-to-b from-[#FFE082] via-[#FFC400] to-[#F57F17] " +
  "shadow-[inset_0_1px_0_rgba(255,255,255,0.55),0_4px_0_#B45309] " +
  "transition-all duration-150 ease-out " +
  "hover:brightness-105 hover:saturate-125 " +
  "active:translate-y-1 active:brightness-100 active:shadow-[0_1px_0_#B45309] " +
  "dark:border-[#FFD54F] dark:text-[#000000] dark:[&_svg]:text-[#000000] " +
  "dark:bg-gradient-to-b dark:from-[#FFEB3B] dark:via-[#FFC107] dark:to-[#F57C00] " +
  "dark:shadow-[inset_0_2px_0_rgba(255,255,255,0.55),0_4px_0_#B45309,0_0_22px_rgba(255,193,7,0.55),0_0_40px_rgba(255,152,0,0.28)] " +
  "dark:hover:brightness-105 dark:hover:saturate-125 dark:hover:shadow-[inset_0_2px_0_rgba(255,255,255,0.62),0_4px_0_#B45309,0_0_28px_rgba(255,214,0,0.65),0_0_52px_rgba(255,167,38,0.35)] " +
  "dark:active:translate-y-1 dark:active:brightness-100 dark:active:shadow-[0_1px_0_#B45309]";

/** Same 3D gold as primary — all “Lookup” actions share one premium treatment. */
const BTN_SECONDARY_LOOKUP = BTN_LOOKUP;

const BTN_GHOST =
  "flex h-11 w-full items-center justify-center gap-2 rounded-xl border border-[#D6B46A]/28 bg-white/90 px-4 text-sm font-semibold text-[#0F172A] " +
  "shadow-[inset_0_0_0_1px_rgba(255,255,255,0.6)] transition " +
  "hover:border-[#D6B46A]/50 hover:bg-[#FFFBF5] hover:shadow-[0_0_18px_rgba(214,180,106,0.18)] " +
  "dark:border-[#F5C542]/22 dark:bg-[#0B1220] dark:text-[#F8FAFC] dark:shadow-[inset_0_0_0_1px_rgba(245,197,66,0.04)] " +
  "dark:hover:border-[#F5C542]/45 dark:hover:bg-[#08111F] dark:hover:shadow-[0_0_20px_rgba(255,215,0,0.15)]";

const BTN_PILL_GOLD =
  "inline-flex h-9 items-center justify-center gap-1.5 rounded-lg border border-[#D6B46A]/45 bg-[#FFFBF5] px-3 text-xs font-semibold text-[#8B6914] " +
  "shadow-[0_0_10px_rgba(214,180,106,0.15)] transition hover:border-[#D6B46A] hover:text-[#0F172A] hover:shadow-[0_0_14px_rgba(214,180,106,0.22)] " +
  "dark:border-[#F5C542]/50 dark:bg-[#08111F] dark:text-[#D6B46A] dark:shadow-[0_0_12px_rgba(245,197,66,0.12)] " +
  "dark:hover:border-[#FFD700]/70 dark:hover:text-[#F5C542] dark:hover:shadow-[0_0_18px_rgba(255,215,0,0.25)]";

const SCAN_ICON_WRAP =
  "relative flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-[#D6B46A]/40 bg-[#FFFBF5] text-[#B8860B] " +
  "shadow-[0_0_10px_rgba(214,180,106,0.25),inset_0_0_8px_rgba(255,255,255,0.5)] " +
  "dark:border-[#F5C542]/45 dark:bg-[#08111F] dark:text-[#FFD700] " +
  "dark:shadow-[0_0_16px_rgba(255,215,0,0.35),0_0_28px_rgba(245,197,66,0.2),inset_0_0_12px_rgba(255,215,0,0.08)]";

const FORM_CARD =
  "space-y-4 rounded-2xl border border-[#D6B46A]/28 bg-white p-5 " +
  "shadow-[0_0_0_1px_rgba(214,180,106,0.06),0_8px_28px_rgba(15,23,42,0.06),0_0_36px_-8px_rgba(214,180,106,0.1)] " +
  "dark:border-[#F5C542]/22 dark:bg-[#0B1220] " +
  "dark:shadow-[0_0_0_1px_rgba(245,197,66,0.05),0_10px_36px_rgba(0,0,0,0.5),0_0_40px_-8px_rgba(255,215,0,0.1)]";

const PLACEHOLDER_BOX =
  "flex min-h-[3.25rem] w-full flex-col items-center justify-center gap-1 rounded-xl border-2 border-dashed border-[#D6B46A]/35 bg-[#FFFBF5] px-3 py-3 text-center text-[11px] font-medium text-[#64748B] " +
  "dark:border-[#D6B46A]/28 dark:bg-[#08111F] dark:text-[#94A3B8]";

/** Scan-in-flight pulse — separate keyframes per theme (see `<style>` block). */
const SCAN_INPUT_SEARCHING =
  "motion-safe:animate-[operator-scan-input-pulse-light_1.4s_ease-in-out_infinite] dark:motion-safe:animate-[operator-scan-input-pulse-dark_1.4s_ease-in-out_infinite]";

/** Multi-store org-wide lookup — only when dev debug panel is enabled (never shown in production paths). */
const OPERATOR_SCAN_DEBUG_ORG_WIDE = "__operator_scan_debug_org_wide__";

const CARRIERS = ["UPS", "FedEx", "USPS", "DHL", "OnTrac", "Amazon Logistics", "Other"] as const;

/* ------------------------------------------------------------------ */
/* Types                                                              */
/* ------------------------------------------------------------------ */

type Lane = null | "new" | "continue";

type NoticeTone = "success" | "warning" | "error";
type Notice = { tone: NoticeTone; message: string };

type ExpectedPackageRow = {
  sku?: string | null;
  tracking_number?: string | null;
  allocation_box_code?: string | null;
  carrier?: string | null;
  carrier_name?: string | null;
  store_id?: string | null;
  order_id?: string | null;
  amazon_order_id?: string | null;
  expected_scan_quantity?: number | null;
  shipped_quantity?: number | null;
  requested_quantity?: number | null;
};

type ExpectedPackagesDiagSampleRow = {
  tracking_number?: string | null;
  allocation_box_code?: string | null;
  store_id?: string | null;
  organization_id?: string | null;
};

/** Read-only probes after expected_packages miss — RLS vs org vs store vs tracking. */
type ExpectedPackagesFailureDiagnostics = {
  scannedRaw: string;
  normalized: string;
  effectiveOrganizationId: string;
  selectedStoreIdUsed: string;
  activeStoresLoadedCount: number;
  selectedStoreName: string;
  /** 1 — no filters; total rows visible to client (exact count). */
  queryNoFilterExactCount: number | null;
  queryNoFilterExactError: string | null;
  queryNoFilterSampleRows: ExpectedPackagesDiagSampleRow[];
  queryNoFilterSampleError: string | null;
  /** 2 — `.eq(organization_id`, effectiveOrganizationId)` exact count + sample limit 5. */
  queryOrgOnlyExactCount: number | null;
  queryOrgOnlyExactError: string | null;
  queryOrgOnlySampleRows: ExpectedPackagesDiagSampleRow[];
  queryOrgOnlySampleError: string | null;
  /** 3 — `.eq(store_id`, selectedStoreId)` only. */
  queryStoreOnlyExactCount: number | null;
  queryStoreOnlyExactError: string | null;
  queryStoreOnlySkippedReason: string | null;
  /** 4 — organization_id + store_id. */
  queryOrgAndStoreExactCount: number | null;
  queryOrgAndStoreExactError: string | null;
  queryOrgAndStoreSkippedReason: string | null;
  strictTrackingRowCount: number;
  strictTrackingError: string | null;
  /** Interpretation lines (6–9 from spec). */
  diagnosticHints: string[];
};

type NewHit =
  | { kind: "expected"; row: ExpectedPackageRow }
  | { kind: "pallet"; row: PalletRecord }
  | { kind: "package"; row: PackageRecord; pallet?: PalletRecord | null }
  | { kind: "item"; row: ReturnRecord; pkg?: PackageRecord | null; pallet?: PalletRecord | null }
  | { kind: "none"; expectedLookupError?: string; expectedPackagesDiagnostics?: ExpectedPackagesFailureDiagnostics };

type ContinueHit =
  | { kind: "pallet"; row: PalletRecord }
  | { kind: "package"; row: PackageRecord; pallet?: PalletRecord | null }
  | { kind: "item"; row: ReturnRecord; pkg?: PackageRecord | null; pallet?: PalletRecord | null };

type ActiveForm = "pallet" | "package" | "item";
type SaveMode = "create" | "edit";

type WorkspaceView =
  | { kind: "pallet"; pallet: PalletRecord }
  | { kind: "package"; pkg: PackageRecord; pallet: PalletRecord | null }
  | { kind: "loose-item"; item: ReturnRecord }
  | null;

/* ------------------------------------------------------------------ */
/* Helpers                                                            */
/* ------------------------------------------------------------------ */

function cn(...parts: Array<string | false | undefined | null>): string {
  return parts.filter(Boolean).join(" ");
}

function generatePalletNumber(): string {
  const d = new Date();
  return `PLT-${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}-${Math.floor(Math.random() * 900 + 100)}`;
}

function generatePackageNumber(): string {
  return `PKG-${Date.now().toString(36).toUpperCase()}`;
}

function platformToMarketplace(platform: string): string {
  const p = platform.toLowerCase();
  if (p.includes("walmart")) return "walmart";
  if (p.includes("ebay")) return "ebay";
  return "amazon";
}

function asTrimmedString(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function asNumericString(v: unknown): string {
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v))) return v.trim();
  return "";
}

const NO_PHYSICAL_ITEM = new Set(["empty_box", "missing_item"]);
const REQUIRES_PHYSICAL_ITEM = new Set([
  "expired",
  "scratched",
  "damaged_customer",
  "wrong_item_different",
  "missing_parts",
  "damaged_box",
]);

function chipDisabledForConditions(key: string, selected: string[]): boolean {
  if (selected.includes("sellable")) return key !== "sellable";
  if (NO_PHYSICAL_ITEM.has(key) && selected.some((k) => REQUIRES_PHYSICAL_ITEM.has(k))) return true;
  if (REQUIRES_PHYSICAL_ITEM.has(key) && selected.some((k) => NO_PHYSICAL_ITEM.has(k))) return true;
  return false;
}

function toggleConditionKey(selected: string[], key: string): string[] {
  const s = new Set(selected);
  if (s.has(key)) {
    s.delete(key);
    return [...s];
  }
  if (key === "sellable") return ["sellable"];
  s.delete("sellable");
  if (NO_PHYSICAL_ITEM.has(key)) REQUIRES_PHYSICAL_ITEM.forEach((k) => s.delete(k));
  if (REQUIRES_PHYSICAL_ITEM.has(key)) NO_PHYSICAL_ITEM.forEach((k) => s.delete(k));
  s.add(key);
  return [...s];
}

function conditionsFromKeys(keys: string[]): string[] {
  if (!keys?.length) return [];
  if (keys.includes("sellable")) return ["sellable"];
  return [...keys];
}

/** First active store for the org (single-store org or deterministic fallback). */
function firstStoreId(stores: StorePublicRow[]): string | null {
  const s = stores[0];
  const id = s?.id?.trim() ?? "";
  return id && isUuidString(id) ? id : null;
}

/** Active store for creates: auto when exactly one; otherwise requires an explicit dropdown selection. */
function resolveStoreIdForCreates(stores: StorePublicRow[], selectedStoreId: string): string | null {
  if (stores.length === 0) return null;
  if (stores.length === 1) return firstStoreId(stores);
  const t = selectedStoreId.trim();
  if (t && isUuidString(t) && stores.some((s) => s.id === t)) return t;
  return null;
}

const ISSUE_CHIPS: { key: string; label: string }[] = [
  { key: "damaged_box", label: "Damaged box" },
  { key: "damaged_customer", label: "Damaged product" },
  { key: "scratched", label: "Scratched" },
  { key: "wrong_item_different", label: "Wrong item" },
  { key: "expired", label: "Expired" },
  { key: "missing_parts", label: "Missing parts" },
  { key: "empty_box", label: "Empty box" },
  { key: "missing_item", label: "Missing item" },
  { key: "sellable", label: "Sellable / OK" },
];

function isContinueEligiblePallet(p: PalletRecord): boolean {
  const s = String(p.status ?? "").toLowerCase();
  return s === "open" || s === "" || s === "submitted";
}

function isContinueEligiblePackage(p: PackageRecord): boolean {
  const s = String(p.status ?? "").toLowerCase();
  return s === "open" || s === "suspicious";
}

function isContinueEligibleReturn(r: ReturnRecord): boolean {
  const s = String(r.status ?? "").toLowerCase();
  return !s || s === "received" || s === "open" || s === "processing" || s === "pending";
}

/**
 * expected_packages columns only — verified against migrations + worklist upserts
 * (`carrier` / `order_id`; not `carrier_name` / `amazon_order_id`). No `package_id` / `lpn` on this table.
 */
const EXPECTED_PKG_SELECT =
  "sku,tracking_number,allocation_box_code,carrier,store_id,order_id,expected_scan_quantity,shipped_quantity,requested_quantity";

/** Zero-width / BOM / soft hyphen — common when pasting from spreadsheets or SQL clients. */
const INVISIBLE_SCAN_CHARS = /[\u200B-\u200D\uFEFF\u2060\u00AD]/g;

/**
 * Normalize operator scan / paste for expected_packages lookup.
 * - Unicode NFC, trim, strip invisible code points, NBSP → space.
 */
function normalizeExpectedScanInput(raw: string): string {
  let s = String(raw ?? "")
    .normalize("NFC")
    .replace(INVISIBLE_SCAN_CHARS, "")
    .replace(/\u00a0/g, " ")
    .trim();
  s = s.replace(/\s+/g, " ").trim();
  return s;
}

/**
 * Lookup scope for `store_id` columns: non-empty applies `.eq("store_id", …)`.
 * Empty means omit the store filter — used only for multi-store debug org-wide mode.
 */
function trimUuidOrEmpty(v: string | null | undefined): string {
  const t = typeof v === "string" ? v.trim() : "";
  return t && isUuidString(t) ? t : "";
}

/** Escape `%` and `_` so PostgREST `ilike` matches the full literal (not a substring wildcard). */
function escapeForIlikeExactLiteral(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

type PostgrestishError = { message?: string; code?: string; details?: string } | null;

function isRlsOrPermissionLookupError(err: PostgrestishError): boolean {
  if (!err?.message) return false;
  const m = err.message.toLowerCase();
  const c = String(err.code ?? "");
  return (
    c === "42501" ||
    c === "PGRST301" ||
    m.includes("permission denied") ||
    m.includes("rls") ||
    m.includes("row-level security") ||
    m.includes("jwt") ||
    m.includes("not authorized")
  );
}

function isUnknownColumnError(err: PostgrestishError): boolean {
  if (!err?.message) return false;
  const m = err.message.toLowerCase();
  return (
    m.includes("column") && (m.includes("does not exist") || m.includes("not found in schema"))
  );
}

type ExpectedPackagesBroadSampleRow = {
  tracking_number?: string | null;
  allocation_box_code?: string | null;
  organization_id?: string | null;
};

type ExpectedLookupQueryStepDebug = {
  step: string;
  status: "ok" | "error";
  rowCount: number;
  errorMessage: string | null;
};

/** Populated for devtools panel + “why no hit” logic; safe to log in development only. */
type ExpectedLookupDebug = {
  rawInput: string;
  normalized: string;
  effectiveOrganizationId: string;
  selectListUsed: string;
  broadSample: {
    status: "idle" | "ok" | "error";
    rowCount: number;
    errorMessage: string | null;
    rows: ExpectedPackagesBroadSampleRow[];
  };
  mainSteps: ExpectedLookupQueryStepDebug[];
  normalizedMatchInSample: boolean;
  zeroRowsVisibleForOrg: boolean;
};

type ExpectedPackageLookupResult = {
  row: ExpectedPackageRow | null;
  /** Permission / RLS / JWT — show in UI; do not fall through to other tables. */
  uiError?: string;
  /** Non-RLS query or schema mismatch — show in UI; do not fall through. */
  queryFailureMessage?: string;
  debug: ExpectedLookupDebug;
};

const EXPECTED_LOOKUP_UI_ERROR =
  "Expected package lookup failed: organization mismatch or permission issue";

function emptyExpectedLookupDebug(
  rawInput: string,
  normalized: string,
  orgTrim: string,
): ExpectedLookupDebug {
  return {
    rawInput,
    normalized,
    effectiveOrganizationId: orgTrim,
    selectListUsed: EXPECTED_PKG_SELECT,
    broadSample: { status: "idle", rowCount: 0, errorMessage: null, rows: [] },
    mainSteps: [],
    normalizedMatchInSample: false,
    zeroRowsVisibleForOrg: false,
  };
}

/**
 * Read-only diagnostics after expected_packages miss — unfiltered, org-only, store-only, org+store, strict tracking.
 * Does not write. Does not bypass RLS.
 */
async function fetchExpectedPackagesFailureDiagnostics(params: {
  scannedRaw: string;
  normalized: string;
  effectiveOrganizationId: string;
  selectedStoreIdUsed: string;
  activeStoresLoadedCount: number;
  selectedStoreName: string;
}): Promise<ExpectedPackagesFailureDiagnostics> {
  const empty = (reason: string): ExpectedPackagesFailureDiagnostics => ({
    scannedRaw: params.scannedRaw,
    normalized: params.normalized,
    effectiveOrganizationId: params.effectiveOrganizationId.trim(),
    selectedStoreIdUsed: params.selectedStoreIdUsed,
    activeStoresLoadedCount: params.activeStoresLoadedCount,
    selectedStoreName: params.selectedStoreName,
    queryNoFilterExactCount: null,
    queryNoFilterExactError: reason,
    queryNoFilterSampleRows: [],
    queryNoFilterSampleError: reason,
    queryOrgOnlyExactCount: null,
    queryOrgOnlyExactError: reason,
    queryOrgOnlySampleRows: [],
    queryOrgOnlySampleError: reason,
    queryStoreOnlyExactCount: null,
    queryStoreOnlyExactError: reason,
    queryStoreOnlySkippedReason: null,
    queryOrgAndStoreExactCount: null,
    queryOrgAndStoreExactError: reason,
    queryOrgAndStoreSkippedReason: null,
    strictTrackingRowCount: 0,
    strictTrackingError: reason,
    diagnosticHints: [reason],
  });

  if (!isSupabaseConfigured()) return empty("Supabase is not configured.");
  const org = params.effectiveOrganizationId.trim();
  if (!org) return empty("Missing organization id.");

  const storeEq = trimUuidOrEmpty(params.selectedStoreIdUsed);
  const cols = "tracking_number,allocation_box_code,store_id,organization_id";

  // 1 — no organization filter: exact count + limit 5 sample
  const { count: noFilterCount, error: noFilterCountErr } = await supabase
    .from("expected_packages")
    .select("*", { count: "exact", head: true });
  const { data: noFilterRows, error: noFilterSampleErr } = await supabase
    .from("expected_packages")
    .select(cols)
    .limit(5);
  const queryNoFilterSampleRows = Array.isArray(noFilterRows)
    ? (noFilterRows as ExpectedPackagesDiagSampleRow[])
    : [];

  // 2 — organization_id only
  const { count: orgOnlyCount, error: orgOnlyCountErr } = await supabase
    .from("expected_packages")
    .select("*", { count: "exact", head: true })
    .eq("organization_id", org);
  const { data: orgOnlyRows, error: orgOnlySampleErr } = await supabase
    .from("expected_packages")
    .select(cols)
    .eq("organization_id", org)
    .limit(5);
  const queryOrgOnlySampleRows = Array.isArray(orgOnlyRows)
    ? (orgOnlyRows as ExpectedPackagesDiagSampleRow[])
    : [];

  // 3 — store_id only
  let queryStoreOnlyExactCount: number | null = null;
  let queryStoreOnlyExactError: string | null = null;
  let queryStoreOnlySkippedReason: string | null = null;
  if (!storeEq) {
    queryStoreOnlySkippedReason =
      "No selectedStoreId — skipped `.eq(\"store_id\", selectedStoreId)` diagnostic.";
  } else {
    const { count: cStore, error: errStore } = await supabase
      .from("expected_packages")
      .select("*", { count: "exact", head: true })
      .eq("store_id", storeEq);
    queryStoreOnlyExactCount = errStore ? null : (cStore ?? 0);
    queryStoreOnlyExactError = errStore ? (errStore.message ?? String(errStore)) : null;
  }

  // 4 — organization_id + store_id
  let queryOrgAndStoreExactCount: number | null = null;
  let queryOrgAndStoreExactError: string | null = null;
  let queryOrgAndStoreSkippedReason: string | null = null;
  if (!storeEq) {
    queryOrgAndStoreSkippedReason =
      "No selectedStoreId — skipped `.eq(organization_id).eq(store_id)` diagnostic.";
  } else {
    const { count: cBoth, error: errBoth } = await supabase
      .from("expected_packages")
      .select("*", { count: "exact", head: true })
      .eq("organization_id", org)
      .eq("store_id", storeEq);
    queryOrgAndStoreExactCount = errBoth ? null : (cBoth ?? 0);
    queryOrgAndStoreExactError = errBoth ? (errBoth.message ?? String(errBoth)) : null;
  }

  // Strict tracking_number match under org + store
  let strictTrackingRowCount = 0;
  let strictTrackingError: string | null = null;
  if (!storeEq) {
    strictTrackingError =
      "Skipped — empty store_id; cannot run `.eq(tracking_number`, normalized)` under org+store.";
  } else if (!params.normalized) {
    strictTrackingError = "Skipped — normalized scan is empty.";
  } else {
    const { data: stRows, error: stErr } = await supabase
      .from("expected_packages")
      .select(cols)
      .eq("organization_id", org)
      .eq("store_id", storeEq)
      .eq("tracking_number", params.normalized)
      .limit(5);
    if (stErr) {
      strictTrackingError = stErr.message ?? String(stErr);
    } else {
      strictTrackingRowCount = Array.isArray(stRows) ? stRows.length : 0;
    }
  }

  const nf = noFilterCountErr ? null : (noFilterCount ?? 0);
  const oc = orgOnlyCountErr ? null : (orgOnlyCount ?? 0);
  const bs = queryOrgAndStoreSkippedReason ? null : queryOrgAndStoreExactCount;

  const diagnosticHints: string[] = [];

  if (!noFilterCountErr && nf === 0) {
    diagnosticHints.push(
      "No expected_packages rows visible from browser client. Check RLS or Supabase project/environment.",
    );
  }
  if (!noFilterCountErr && !orgOnlyCountErr && nf !== null && nf > 0 && oc === 0) {
    diagnosticHints.push("organization_id mismatch");
  }
  if (
    !orgOnlyCountErr &&
    !queryOrgAndStoreSkippedReason &&
    !queryOrgAndStoreExactError &&
    oc !== null &&
    oc > 0 &&
    storeEq &&
    bs === 0
  ) {
    diagnosticHints.push("store_id mismatch");
  }
  if (
    storeEq &&
    bs !== null &&
    bs > 0 &&
    strictTrackingRowCount === 0 &&
    !strictTrackingError &&
    params.normalized
  ) {
    diagnosticHints.push("tracking_number mismatch / formatting issue");
  }

  return {
    scannedRaw: params.scannedRaw,
    normalized: params.normalized,
    effectiveOrganizationId: org,
    selectedStoreIdUsed: params.selectedStoreIdUsed,
    activeStoresLoadedCount: params.activeStoresLoadedCount,
    selectedStoreName: params.selectedStoreName,
    queryNoFilterExactCount: noFilterCountErr ? null : (noFilterCount ?? 0),
    queryNoFilterExactError: noFilterCountErr ? (noFilterCountErr.message ?? String(noFilterCountErr)) : null,
    queryNoFilterSampleRows,
    queryNoFilterSampleError: noFilterSampleErr ? (noFilterSampleErr.message ?? String(noFilterSampleErr)) : null,
    queryOrgOnlyExactCount: orgOnlyCountErr ? null : (orgOnlyCount ?? 0),
    queryOrgOnlyExactError: orgOnlyCountErr ? (orgOnlyCountErr.message ?? String(orgOnlyCountErr)) : null,
    queryOrgOnlySampleRows,
    queryOrgOnlySampleError: orgOnlySampleErr ? (orgOnlySampleErr.message ?? String(orgOnlySampleErr)) : null,
    queryStoreOnlyExactCount,
    queryStoreOnlyExactError,
    queryStoreOnlySkippedReason,
    queryOrgAndStoreExactCount,
    queryOrgAndStoreExactError,
    queryOrgAndStoreSkippedReason,
    strictTrackingRowCount,
    strictTrackingError,
    diagnosticHints,
  };
}

/**
 * Direct expected_packages lookup (read-only). Org-scoped `.eq("organization_id", …)`.
 * Optional `storeScopeId` narrows rows when the operator chose a store (column exists on expected_packages).
 * Does not use `maybeSingle()` — duplicate tracking_number values return the first of up to 10 rows.
 */
async function lookupExpectedPackageByScan(
  orgId: string,
  rawInput: string,
  storeScopeId?: string | null,
): Promise<ExpectedPackageLookupResult> {
  const orgTrim = typeof orgId === "string" ? orgId.trim() : "";
  const storeEq = trimUuidOrEmpty(storeScopeId);
  const normalized = normalizeExpectedScanInput(rawInput);
  const debug = emptyExpectedLookupDebug(String(rawInput ?? ""), normalized, orgTrim);
  debug.selectListUsed = "*";

  if (!isSupabaseConfigured() || !orgTrim) {
    return {
      row: null,
      queryFailureMessage: !isSupabaseConfigured()
        ? "Supabase is not configured; cannot query expected_packages."
        : "Missing organization id; cannot scope expected_packages.",
      debug: {
        ...debug,
        broadSample: { status: "error", rowCount: 0, errorMessage: "not run", rows: [] },
      },
    };
  }
  if (!normalized) {
    return { row: null, debug };
  }

  /** PostgREST builders are awaitable; cast for TS without pulling deep client generics. */
  const asAwaitable = (b: unknown) => b as Promise<{ data: unknown; error: PostgrestishError }>;

  let sampleQ = supabase
    .from("expected_packages")
    .select("tracking_number,allocation_box_code,organization_id")
    .eq("organization_id", orgTrim);
  if (storeEq) sampleQ = sampleQ.eq("store_id", storeEq);
  const { data: sampleData, error: sampleErr } = await sampleQ.limit(5);

  const sampleRows = Array.isArray(sampleData) ? (sampleData as ExpectedPackagesBroadSampleRow[]) : [];

  if (sampleErr) {
    const em = sampleErr.message ?? String(sampleErr);
    debug.broadSample = { status: "error", rowCount: 0, errorMessage: em, rows: [] };
    if (isRlsOrPermissionLookupError(sampleErr)) {
      return { row: null, uiError: EXPECTED_LOOKUP_UI_ERROR, queryFailureMessage: EXPECTED_LOOKUP_UI_ERROR, debug };
    }
    return {
      row: null,
      queryFailureMessage: `expected_packages sample query failed: ${em}`,
      debug,
    };
  }

  debug.broadSample = {
    status: "ok",
    rowCount: sampleRows.length,
    errorMessage: null,
    rows: sampleRows,
  };
  debug.zeroRowsVisibleForOrg = sampleRows.length === 0;
  debug.normalizedMatchInSample = sampleRows.some((r) => {
    const tn = normalizeExpectedScanInput(asTrimmedString(r.tracking_number));
    const ab = normalizeExpectedScanInput(asTrimmedString(r.allocation_box_code));
    return (tn.length > 0 && tn === normalized) || (ab.length > 0 && ab === normalized);
  });

  const base = () => {
    let q = supabase.from("expected_packages").select("*").eq("organization_id", orgTrim);
    if (storeEq) q = q.eq("store_id", storeEq);
    return q;
  };

  const steps: Array<[string, Promise<{ data: unknown; error: PostgrestishError }>]> = [
    ["tracking_number.eq", asAwaitable(base().eq("tracking_number", normalized).limit(10))],
    [
      "tracking_number.ilike",
      asAwaitable(base().ilike("tracking_number", escapeForIlikeExactLiteral(normalized)).limit(10)),
    ],
    ["allocation_box_code.eq", asAwaitable(base().eq("allocation_box_code", normalized).limit(10))],
    [
      "allocation_box_code.ilike",
      asAwaitable(base().ilike("allocation_box_code", escapeForIlikeExactLiteral(normalized)).limit(10)),
    ],
  ];

  let firstHardError: string | null = null;

  for (const [label, promise] of steps) {
    const { data, error } = await promise;
    const rows = Array.isArray(data) ? data : [];
    const rowCount = rows.length;
    if (error) {
      const msg = error.message ?? String(error);
      debug.mainSteps.push({ step: label, status: "error", rowCount: 0, errorMessage: msg });
      if (isRlsOrPermissionLookupError(error)) {
        return { row: null, uiError: EXPECTED_LOOKUP_UI_ERROR, queryFailureMessage: EXPECTED_LOOKUP_UI_ERROR, debug };
      }
      if (isUnknownColumnError(error)) {
        if (!firstHardError) {
          firstHardError = `${label}: ${msg}`;
        }
        continue;
      }
      if (!firstHardError) {
        firstHardError = `${label}: ${msg}`;
      }
      continue;
    }
    debug.mainSteps.push({ step: label, status: "ok", rowCount, errorMessage: null });
    if (rowCount > 0) {
      return { row: rows[0] as ExpectedPackageRow, debug };
    }
  }

  if (firstHardError) {
    return {
      row: null,
      queryFailureMessage: `expected_packages lookup failed (${firstHardError}). Check select list vs table columns.`,
      debug,
    };
  }

  return { row: null, debug };
}

async function lookupPalletByScanDirect(
  orgId: string,
  raw: string,
  storeScopeId?: string | null,
): Promise<PalletRecord | null> {
  if (!isSupabaseConfigured() || !orgId) return null;
  const t = raw.trim();
  if (!t) return null;
  const storeEq = trimUuidOrEmpty(storeScopeId);
  let qn = supabase.from("pallets").select("*").eq("organization_id", orgId);
  if (storeEq) qn = qn.eq("store_id", storeEq);
  const { data: byNum, error: e1 } = await qn.eq("pallet_number", t).limit(1).maybeSingle();
  if (e1) console.warn("[operator-scan] pallets number", e1.message);
  if (byNum) return byNum as PalletRecord;
  let qt = supabase.from("pallets").select("*").eq("organization_id", orgId);
  if (storeEq) qt = qt.eq("store_id", storeEq);
  const { data: byTr, error: e2 } = await qt.eq("tracking_number", t).limit(1).maybeSingle();
  if (e2) console.warn("[operator-scan] pallets tracking", e2.message);
  return (byTr as PalletRecord | null) ?? null;
}

async function lookupPackageByScanDirect(
  orgId: string,
  raw: string,
  storeScopeId?: string | null,
): Promise<PackageRecord | null> {
  if (!isSupabaseConfigured() || !orgId) return null;
  const t = raw.trim();
  if (!t) return null;
  const storeEq = trimUuidOrEmpty(storeScopeId);
  let qn = supabase.from("packages").select("*").eq("organization_id", orgId);
  if (storeEq) qn = qn.eq("store_id", storeEq);
  const { data: byNum, error: e1 } = await qn.eq("package_number", t).limit(1).maybeSingle();
  if (e1) console.warn("[operator-scan] packages number", e1.message);
  if (byNum) return byNum as PackageRecord;
  let qt = supabase.from("packages").select("*").eq("organization_id", orgId);
  if (storeEq) qt = qt.eq("store_id", storeEq);
  const { data: byTr, error: e2 } = await qt.eq("tracking_number", t).limit(1).maybeSingle();
  if (e2) console.warn("[operator-scan] packages tracking", e2.message);
  return (byTr as PackageRecord | null) ?? null;
}

async function fetchPalletById(id: string): Promise<PalletRecord | null> {
  if (!isSupabaseConfigured() || !id || !isUuidString(id)) return null;
  const { data, error } = await supabase.from("pallets").select("*").eq("id", id).maybeSingle();
  if (error) return null;
  return (data as PalletRecord | null) ?? null;
}

async function fetchPackageById(id: string): Promise<PackageRecord | null> {
  if (!isSupabaseConfigured() || !id || !isUuidString(id)) return null;
  const { data, error } = await supabase.from("packages").select("*").eq("id", id).maybeSingle();
  if (error) return null;
  return (data as PackageRecord | null) ?? null;
}

/** Returns rows by LPN or product_identifier (direct query, org-scoped; optional store scope). */
async function lookupReturnByIdentifiers(
  orgId: string,
  raw: string,
  storeScopeId?: string | null,
): Promise<ReturnRecord | null> {
  if (!isSupabaseConfigured() || !orgId) return null;
  const t = raw.trim();
  if (!t) return null;
  const storeEq = trimUuidOrEmpty(storeScopeId);
  for (const col of ["lpn", "product_identifier"] as const) {
    let q = supabase.from("returns").select("*").eq("organization_id", orgId);
    if (storeEq) q = q.eq("store_id", storeEq);
    const { data, error } = await q.eq(col, t).limit(1).maybeSingle();
    if (error) console.warn(`[operator-scan] returns ${col}`, error.message);
    if (data) return data as ReturnRecord;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Sub-components                                                     */
/* ------------------------------------------------------------------ */

function PhotoSlot({ label, hint }: { label: string; hint: string }) {
  return (
    <div>
      <p className={LABEL}>{label}</p>
      <div className={PLACEHOLDER_BOX}>
        <Camera className="h-4 w-4 text-[#94A3B8] dark:text-[#64748B]" />
        <span className={TEXT_MUTED}>{hint}</span>
      </div>
    </div>
  );
}

function ParentChip({
  kicker,
  title,
  subtitle,
}: {
  kicker: string;
  title: string;
  subtitle?: string | null;
}) {
  return (
    <div className="rounded-xl border border-[#D6B46A]/25 bg-[#FFFBF5] px-3 py-2 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.5)] dark:border-[#F5C542]/18 dark:bg-[#08111F] dark:shadow-[inset_0_0_0_1px_rgba(245,197,66,0.04)]">
      <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[#64748B] dark:text-[#94A3B8]">{kicker}</p>
      <p className={`mt-0.5 truncate font-mono text-sm font-semibold ${TEXT_BODY}`}>{title}</p>
      {subtitle ? <p className={`mt-0.5 truncate text-[11px] ${TEXT_SUBTLE}`}>{subtitle}</p> : null}
    </div>
  );
}

function ExpectedInboundCard({ row }: { row: ExpectedPackageRow }) {
  const carrier = asTrimmedString(row.carrier_name) || asTrimmedString(row.carrier) || "—";
  const order = asTrimmedString(row.order_id) || asTrimmedString(row.amazon_order_id) || "—";
  const store = asTrimmedString(row.store_id) || "—";
  const qty =
    asNumericString(row.expected_scan_quantity) ||
    asNumericString(row.shipped_quantity) ||
    asNumericString(row.requested_quantity) ||
    "—";
  return (
    <div className="rounded-2xl border border-[#D6B46A]/35 bg-white p-4 shadow-[0_0_24px_rgba(214,180,106,0.15),inset_0_1px_0_rgba(255,255,255,0.8)] dark:border-[#F5C542]/35 dark:bg-[#08111F] dark:shadow-[0_0_28px_rgba(255,215,0,0.12),inset_0_1px_0_rgba(255,215,0,0.06)]">
      <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-[#B8860B] dark:text-[#FFD700]">Expected inbound</p>
      <dl className="mt-3 grid gap-2 text-sm">
        <div className="flex justify-between gap-2 border-b border-[#D6B46A]/15 py-1.5 dark:border-[#F5C542]/12">
          <dt className={TEXT_MUTED}>Tracking</dt>
          <dd className={`max-w-[60%] truncate font-mono ${TEXT_BODY}`}>{asTrimmedString(row.tracking_number) || "—"}</dd>
        </div>
        <div className="flex justify-between gap-2 border-b border-[#D6B46A]/15 py-1.5 dark:border-[#F5C542]/12">
          <dt className={TEXT_MUTED}>SKU</dt>
          <dd className={`max-w-[60%] truncate font-mono ${TEXT_BODY}`}>{asTrimmedString(row.sku) || "—"}</dd>
        </div>
        <div className="flex justify-between gap-2 border-b border-[#D6B46A]/15 py-1.5 dark:border-[#F5C542]/12">
          <dt className={TEXT_MUTED}>Expected qty</dt>
          <dd className="font-semibold text-[#B8860B] dark:text-[#F5C542]">{qty}</dd>
        </div>
        <div className="flex justify-between gap-2 border-b border-[#D6B46A]/15 py-1.5 dark:border-[#F5C542]/12">
          <dt className={TEXT_MUTED}>Carrier</dt>
          <dd className={`truncate ${TEXT_BODY}`}>{carrier}</dd>
        </div>
        <div className="flex justify-between gap-2 border-b border-[#D6B46A]/15 py-1.5 dark:border-[#F5C542]/12">
          <dt className={TEXT_MUTED}>Order</dt>
          <dd className={`max-w-[60%] truncate font-mono text-xs ${TEXT_SUBTLE}`}>{order}</dd>
        </div>
        <div className="flex justify-between gap-2 py-1.5">
          <dt className={TEXT_MUTED}>Store</dt>
          <dd className={`max-w-[60%] truncate font-mono text-xs ${TEXT_SUBTLE}`}>{store}</dd>
        </div>
      </dl>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Main page                                                          */
/* ------------------------------------------------------------------ */

const ORG_CONTEXT_NOT_READY_MSG = "Organization context not loaded.";

export default function OperatorScannerPage() {
  const {
    organizationId: selectedOrganizationId,
    actorUserId,
    actorName,
    role,
    profileLoading,
    canonicalRoleKey,
    actorCanonicalRoleKey,
  } = useUserRole();

  /** Same tenant scope as the shell company switcher — never substitute env/default UUIDs. */
  const effectiveOrganizationId = useMemo((): string | null => {
    const oid = selectedOrganizationId?.trim();
    return oid && isUuidString(oid) ? oid : null;
  }, [selectedOrganizationId]);

  const orgContextLoading = profileLoading;
  const orgContextMissing = !profileLoading && !effectiveOrganizationId;

  const listTenantOpts = useMemo((): TenantQueryOpts => {
    const base: TenantQueryOpts = { actorProfileId: actorUserId ?? null };
    if (role === "super_admin" && effectiveOrganizationId) {
      return { ...base, filterOrganizationId: effectiveOrganizationId };
    }
    return base;
  }, [actorUserId, role, effectiveOrganizationId]);

  const writeOrgPayload = useMemo(() => {
    if (!effectiveOrganizationId) return null;
    return {
      actor_profile_id: actorUserId ?? null,
      organization_id: effectiveOrganizationId,
    };
  }, [actorUserId, effectiveOrganizationId]);

  /* ------------- top-level state ------------- */

  const [lane, setLane] = useState<Lane>(null);
  const [scanNew, setScanNew] = useState("");
  const [scanContinue, setScanContinue] = useState("");
  const [scanWorkspace, setScanWorkspace] = useState("");

  const [busy, setBusy] = useState(false);
  /** Lookup-only: drives "Searching…", spinner, scan pulse; saves still use `busy`. */
  const [lookupBusy, setLookupBusy] = useState(false);
  /** Bumps when a lookup completes so result panels replay a subtle reveal animation. */
  const [resultRevealKey, setResultRevealKey] = useState(0);
  /** Dev-only: last expected_packages lookup diagnostics (see panel under New Receiving result). */
  const [expectedLookupDebug, setExpectedLookupDebug] = useState<ExpectedLookupDebug | null>(null);
  /** Dev-only: set `localStorage.operator_scanner_show_debug = "1"` to reveal debug panels (NODE_ENV=development). */
  const [showScannerDebug, setShowScannerDebug] = useState(false);
  const scannerDevDebug = process.env.NODE_ENV === "development" && showScannerDebug;
  /** Multi-store: explicit UUID from dropdown; dev-only value `OPERATOR_SCAN_DEBUG_ORG_WIDE` means org-wide reads. Single-store org does not use this (resolved automatically). */
  const [scannerLookupStoreId, setScannerLookupStoreId] = useState("");
  const [notice, setNotice] = useState<Notice | null>(null);
  const [snapshotWarning, setSnapshotWarning] = useState<string | null>(null);

  const [newHit, setNewHit] = useState<NewHit | null>(null);
  const [continueHit, setContinueHit] = useState<ContinueHit | null>(null);
  const [lookupDone, setLookupDone] = useState(false);

  const [activeForm, setActiveForm] = useState<ActiveForm | null>(null);
  const [saveMode, setSaveMode] = useState<SaveMode>("create");
  const [workspaceView, setWorkspaceView] = useState<WorkspaceView>(null);

  const [pallets, setPallets] = useState<PalletRecord[]>([]);
  const [packages, setPackages] = useState<PackageRecord[]>([]);
  const [openPackages, setOpenPackages] = useState<PackageRecord[]>([]);
  const [returns, setReturns] = useState<ReturnRecord[]>([]);

  const [storesList, setStoresList] = useState<StorePublicRow[]>([]);
  const [storesLoading, setStoresLoading] = useState(false);
  const [storesError, setStoresError] = useState<string | null>(null);

  const scanHomeNewRef = useRef<HTMLInputElement>(null);
  const scanHomeContinueRef = useRef<HTMLInputElement>(null);
  const scanWorkspaceRef = useRef<HTMLInputElement>(null);

  /** Pallet form */
  const [palletId, setPalletId] = useState<string | null>(null);
  const [pltTracking, setPltTracking] = useState("");
  const [pltCarrier, setPltCarrier] = useState("UPS");
  const [pltAmazonOrder, setPltAmazonOrder] = useState("");
  const [pltStoreId, setPltStoreId] = useState("");
  const [pltCountedBoxes, setPltCountedBoxes] = useState("");
  const [pltNotes, setPltNotes] = useState("");

  /** Package form */
  const [pkgId, setPkgId] = useState<string | null>(null);
  const [pkgPalletId, setPkgPalletId] = useState("");
  const [pkgNumber, setPkgNumber] = useState("");
  const [pkgTracking, setPkgTracking] = useState("");
  const [pkgCarrier, setPkgCarrier] = useState("");
  const [pkgRma, setPkgRma] = useState("");
  const [pkgAmazonOrder, setPkgAmazonOrder] = useState("");
  const [pkgExpected, setPkgExpected] = useState("");
  const [pkgStoreId, setPkgStoreId] = useState("");

  /** Item (return row) form */
  const [retId, setRetId] = useState<string | null>(null);
  const [itemPackageId, setItemPackageId] = useState("");
  const [itemProductCode, setItemProductCode] = useState("");
  const [itemLpn, setItemLpn] = useState("");
  const [itemRma, setItemRma] = useState("");
  const [itemStoreId, setItemStoreId] = useState("");
  const [itemName, setItemName] = useState("");
  const [itemAsin, setItemAsin] = useState("");
  const [itemFnsku, setItemFnsku] = useState("");
  const [itemSku, setItemSku] = useState("");
  const [itemConditionKeys, setItemConditionKeys] = useState<string[]>([]);
  const [itemExpiry, setItemExpiry] = useState("");
  const [itemBatch, setItemBatch] = useState("");
  const [itemNotes, setItemNotes] = useState("");

  const palletById = useMemo(() => {
    const m = new Map<string, PalletRecord>();
    for (const p of pallets) m.set(p.id, p);
    return m;
  }, [pallets]);

  const storesForOrg = useMemo(
    () => storesList.filter((s) => s.organization_id === effectiveOrganizationId && s.is_active === true),
    [storesList, effectiveOrganizationId],
  );

  const storesForOrgSorted = useMemo(
    () =>
      [...storesForOrg].sort((a, b) =>
        String(a.name ?? "").localeCompare(String(b.name ?? ""), undefined, { sensitivity: "base" }),
      ),
    [storesForOrg],
  );

  /** UUID passed to scan lookups — always set when org has exactly one active store; multi-store requires selection (or debug org-wide). */
  const resolvedLookupStoreId = useMemo((): string => {
    if (!effectiveOrganizationId || storesLoading) return "";
    const n = storesForOrg.length;
    if (n === 0) return "";
    if (n === 1) {
      const id = storesForOrg[0]?.id?.trim() ?? "";
      return id && isUuidString(id) ? id : "";
    }
    if (scannerDevDebug && scannerLookupStoreId === OPERATOR_SCAN_DEBUG_ORG_WIDE) return "";
    const t = scannerLookupStoreId.trim();
    if (t && isUuidString(t) && storesForOrg.some((s) => s.id === t)) return t;
    return "";
  }, [
    effectiveOrganizationId,
    storesLoading,
    storesForOrg,
    scannerLookupStoreId,
    scannerDevDebug,
  ]);

  const scannerStoreGateBlocksLookup = useMemo(() => {
    if (!effectiveOrganizationId || storesLoading) return true;
    if (storesForOrg.length === 0) return true;
    if (storesForOrg.length === 1) return false;
    if (scannerDevDebug && scannerLookupStoreId === OPERATOR_SCAN_DEBUG_ORG_WIDE) return false;
    const t = scannerLookupStoreId.trim();
    return !(t && isUuidString(t) && storesForOrg.some((s) => s.id === t));
  }, [
    effectiveOrganizationId,
    storesLoading,
    storesForOrg,
    scannerLookupStoreId,
    scannerDevDebug,
  ]);

  useEffect(() => {
    setScannerLookupStoreId("");
  }, [effectiveOrganizationId]);

  useEffect(() => {
    if (process.env.NODE_ENV !== "development" || typeof window === "undefined") return;
    try {
      setShowScannerDebug(window.localStorage.getItem("operator_scanner_show_debug") === "1");
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    if (!scannerLookupStoreId) return;
    if (scannerLookupStoreId === OPERATOR_SCAN_DEBUG_ORG_WIDE) {
      if (!scannerDevDebug || storesForOrg.length <= 1) setScannerLookupStoreId("");
      return;
    }
    const ok = storesForOrg.some((s) => s.id === scannerLookupStoreId);
    if (!ok) setScannerLookupStoreId("");
  }, [storesForOrg, scannerLookupStoreId, scannerDevDebug]);

  const openPalletOptions = useMemo(
    () => pallets.filter((p) => p.status === "open" || p.status === "submitted"),
    [pallets],
  );

  /** Children of current pallet (for pallet workspace list). */
  const childPackagesForCurrentPallet = useMemo(() => {
    if (workspaceView?.kind !== "pallet") return [];
    return packages.filter((p) => p.pallet_id === workspaceView.pallet.id);
  }, [packages, workspaceView]);

  /** Children of current package (for package workspace list). */
  const childItemsForCurrentPackage = useMemo(() => {
    if (workspaceView?.kind !== "package") return [];
    return returns.filter((r) => r.package_id === workspaceView.pkg.id);
  }, [returns, workspaceView]);

  const refreshSnapshots = useCallback(async () => {
    if (role === "super_admin" && !effectiveOrganizationId) {
      setSnapshotWarning(null);
      setPallets([]);
      setPackages([]);
      setReturns([]);
      setOpenPackages([]);
      return;
    }
    const [pl, pk, rt, opk] = await Promise.all([
      listPallets(listTenantOpts),
      listPackages(listTenantOpts),
      listReturns(listTenantOpts),
      listOpenPackages(listTenantOpts),
    ]);
    const warn = [pl.ok ? "" : pl.error, pk.ok ? "" : pk.error, rt.ok ? "" : rt.error, opk.ok ? "" : opk.error]
      .filter(Boolean)
      .join(" | ");
    setSnapshotWarning(warn || null);
    setPallets(pl.ok ? pl.data : []);
    setPackages(pk.ok ? pk.data : []);
    setReturns(rt.ok ? rt.data : []);
    setOpenPackages(opk.ok ? opk.data : []);
  }, [listTenantOpts, role, effectiveOrganizationId]);

  useEffect(() => {
    let cancelled = false;
    setStoresLoading(true);
    setStoresError(null);
    void listStores(null)
      .then((res) => {
        if (cancelled) return;
        if (res.ok && res.data) setStoresList(res.data);
        else setStoresError(res.ok === false ? res.error ?? "Failed to load stores" : "No stores");
      })
      .catch((e) => {
        if (!cancelled) setStoresError(e instanceof Error ? e.message : "Failed to load stores");
      })
      .finally(() => {
        if (!cancelled) setStoresLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (profileLoading) return;
    if (role === "super_admin" && !effectiveOrganizationId) {
      setSnapshotWarning(null);
      setPallets([]);
      setPackages([]);
      setReturns([]);
      setOpenPackages([]);
      return;
    }
    void refreshSnapshots();
  }, [profileLoading, role, effectiveOrganizationId, refreshSnapshots]);

  /* ------------- form reset / hydrate ------------- */

  const resetForms = useCallback(() => {
    setPalletId(null);
    setPltTracking("");
    setPltCarrier("UPS");
    setPltAmazonOrder("");
    setPltStoreId("");
    setPltCountedBoxes("");
    setPltNotes("");

    setPkgId(null);
    setPkgPalletId("");
    setPkgNumber(generatePackageNumber());
    setPkgTracking("");
    setPkgCarrier("");
    setPkgRma("");
    setPkgAmazonOrder("");
    setPkgExpected("");
    setPkgStoreId("");

    setRetId(null);
    setItemPackageId("");
    setItemProductCode("");
    setItemLpn("");
    setItemRma("");
    setItemStoreId("");
    setItemName("");
    setItemAsin("");
    setItemFnsku("");
    setItemSku("");
    setItemConditionKeys([]);
    setItemExpiry("");
    setItemBatch("");
    setItemNotes("");
  }, []);

  const startOver = useCallback(() => {
    setLane(null);
    setScanNew("");
    setScanContinue("");
    setScanWorkspace("");
    setNewHit(null);
    setContinueHit(null);
    setLookupDone(false);
    setActiveForm(null);
    setSaveMode("create");
    setWorkspaceView(null);
    setNotice(null);
    setLookupBusy(false);
    setExpectedLookupDebug(null);
    setScannerLookupStoreId("");
    resetForms();
  }, [resetForms]);

  const exitWorkspace = useCallback(() => {
    setWorkspaceView(null);
    setActiveForm(null);
    setNewHit(null);
    setContinueHit(null);
    setLookupDone(false);
    setScanWorkspace("");
    setNotice(null);
    resetForms();
    setTimeout(() => scanWorkspaceRef.current?.focus(), 0);
  }, [resetForms]);

  const hydratePalletFromRow = useCallback((row: PalletRecord) => {
    setPalletId(row.id);
    setPltTracking(row.tracking_number?.trim() || "");
    setPltCarrier(row.carrier_name?.trim() || "UPS");
    setPltAmazonOrder(row.amazon_order_id?.trim() || "");
    setPltStoreId(row.store_id ?? "");
    setPltNotes(row.notes ?? "");
  }, []);

  const hydratePackageFromRow = useCallback((row: PackageRecord, palletHint?: PalletRecord | null) => {
    setPkgId(row.id);
    setPkgNumber(row.package_number);
    setPkgTracking(row.tracking_number?.trim() || "");
    setPkgCarrier(row.carrier_name?.trim() || "");
    setPkgRma(row.rma_number?.trim() || "");
    setPkgAmazonOrder(row.order_id?.trim() || "");
    setPkgExpected(String(row.expected_item_count ?? 0));
    setPkgStoreId(row.store_id ?? "");
    const pid = row.pallet_id ?? palletHint?.id ?? "";
    setPkgPalletId(pid && isUuidString(pid) ? pid : "");
  }, []);

  const hydrateItemFromRow = useCallback((row: ReturnRecord) => {
    setRetId(row.id);
    setItemPackageId(row.package_id && isUuidString(row.package_id) ? row.package_id : "");
    setItemLpn(row.lpn?.trim() || "");
    setItemRma(row.rma_number?.trim() || "");
    setItemStoreId(row.store_id ?? "");
    setItemName(row.item_name ?? "");
    setItemAsin(row.asin?.trim() || "");
    setItemFnsku(row.fnsku?.trim() || "");
    setItemSku(row.sku?.trim() || "");
    setItemProductCode(row.product_identifier?.trim() || row.asin?.trim() || row.sku?.trim() || "");
    setItemConditionKeys([...(row.conditions ?? [])]);
    setItemExpiry(row.expiration_date?.slice(0, 10) ?? "");
    setItemBatch(row.batch_number?.trim() || "");
    setItemNotes(row.notes?.trim() || "");
  }, []);

  /** Optional compact form instead of one-tap create (same fields as before). */
  const beginCreate = useCallback(
    (form: ActiveForm, scan: string) => {
      resetForms();
      setActiveForm(form);
      setSaveMode("create");
      setWorkspaceView(null);
      if (form === "pallet") {
        setPalletId(null);
        setPltTracking(scan.trim());
      } else if (form === "package") {
        setPkgId(null);
        setPkgNumber(generatePackageNumber());
        setPkgTracking(scan.trim());
      } else {
        setRetId(null);
        const s = scan.trim();
        if (s) {
          setItemLpn(s);
          setItemProductCode(s);
        }
        setItemName("");
      }
    },
    [resetForms],
  );

  /* ------------- lookup resolvers (kept as before) ------------- */

  const resolveNewHit = useCallback(
    async (scan: string): Promise<NewHit> => {
      const t = normalizeExpectedScanInput(scan);
      if (!t) return { kind: "none" };

      if (!effectiveOrganizationId) {
        setExpectedLookupDebug(null);
        return {
          kind: "none",
          expectedLookupError: profileLoading ? undefined : ORG_CONTEXT_NOT_READY_MSG,
        };
      }

      const ep = await lookupExpectedPackageByScan(effectiveOrganizationId, scan, resolvedLookupStoreId);
      if (process.env.NODE_ENV === "development" && showScannerDebug) {
        setExpectedLookupDebug(ep.debug);
      } else {
        setExpectedLookupDebug(null);
      }

      let selectedStoreName = "—";
      if (resolvedLookupStoreId) {
        selectedStoreName =
          storesForOrg.find((s) => s.id === resolvedLookupStoreId)?.name?.trim() || "—";
      } else if (scannerDevDebug && scannerLookupStoreId === OPERATOR_SCAN_DEBUG_ORG_WIDE) {
        selectedStoreName = "(debug org-wide)";
      }

      if (ep.row) {
        return { kind: "expected", row: ep.row };
      }

      const diag = await fetchExpectedPackagesFailureDiagnostics({
        scannedRaw: String(scan ?? ""),
        normalized: normalizeExpectedScanInput(scan),
        effectiveOrganizationId,
        selectedStoreIdUsed: resolvedLookupStoreId,
        activeStoresLoadedCount: storesForOrg.length,
        selectedStoreName,
      });

      const expectedFatal = ep.uiError ?? ep.queryFailureMessage;
      if (expectedFatal) {
        return {
          kind: "none",
          expectedLookupError: expectedFatal,
          expectedPackagesDiagnostics: diag,
        };
      }

      const plt = await lookupPalletByScanDirect(effectiveOrganizationId, t, resolvedLookupStoreId);
      if (plt) return { kind: "pallet", row: plt };

      const pkg = await lookupPackageByScanDirect(effectiveOrganizationId, t, resolvedLookupStoreId);
      if (pkg) {
        const parent = pkg.pallet_id ? await fetchPalletById(pkg.pallet_id) : null;
        return { kind: "package", row: pkg, pallet: parent };
      }

      const retNew = await lookupReturnByIdentifiers(effectiveOrganizationId, t, resolvedLookupStoreId);
      if (retNew) {
        const pkgRow = retNew.package_id ? await fetchPackageById(retNew.package_id) : null;
        let pltRow: PalletRecord | null = null;
        if (pkgRow?.pallet_id) pltRow = await fetchPalletById(pkgRow.pallet_id);
        else if (retNew.pallet_id) pltRow = await fetchPalletById(retNew.pallet_id);
        return { kind: "item", row: retNew, pkg: pkgRow, pallet: pltRow };
      }

      return { kind: "none", expectedPackagesDiagnostics: diag };
    },
    [
      effectiveOrganizationId,
      profileLoading,
      showScannerDebug,
      resolvedLookupStoreId,
      storesForOrg,
      scannerLookupStoreId,
      scannerDevDebug,
      setExpectedLookupDebug,
    ],
  );

  const resolveContinueHit = useCallback(
    async (scan: string): Promise<ContinueHit | null> => {
      const t = scan.trim();
      if (!t) return null;
      if (!effectiveOrganizationId) return null;

      const plt = await lookupPalletByScanDirect(effectiveOrganizationId, t, resolvedLookupStoreId);
      if (plt && isContinueEligiblePallet(plt)) return { kind: "pallet", row: plt };

      const pkg = await lookupPackageByScanDirect(effectiveOrganizationId, t, resolvedLookupStoreId);
      if (pkg && isContinueEligiblePackage(pkg)) {
        const parent = pkg.pallet_id ? await fetchPalletById(pkg.pallet_id) : null;
        return { kind: "package", row: pkg, pallet: parent };
      }

      const retC = await lookupReturnByIdentifiers(effectiveOrganizationId, t, resolvedLookupStoreId);
      if (retC && isContinueEligibleReturn(retC)) {
        const pkgRow = retC.package_id ? await fetchPackageById(retC.package_id) : null;
        let pltRow: PalletRecord | null = null;
        if (pkgRow?.pallet_id) pltRow = await fetchPalletById(pkgRow.pallet_id);
        else if (retC.pallet_id) pltRow = await fetchPalletById(retC.pallet_id);
        return { kind: "item", row: retC, pkg: pkgRow, pallet: pltRow };
      }

      return null;
    },
    [effectiveOrganizationId, resolvedLookupStoreId],
  );

  const scannerBlockedNoOrg = orgContextMissing || orgContextLoading;

  /* ------------- new lane: lookup -> workspace (or expected / no-match panels) ------------- */

  /**
   * New Receiving: real DB hit → open the right workspace (pallet / package / loose item).
   * Expected inbound stays read-only until the operator confirms one-tap package create.
   */
  const applyNewReceivingLookupResult = useCallback(
    (hit: NewHit) => {
      resetForms();
      setWorkspaceView(null);
      setActiveForm(null);
      if (hit.kind === "none") {
        setSaveMode("create");
        return;
      }
      if (hit.kind === "expected") {
        setSaveMode("create");
        return;
      }
      setSaveMode("edit");
      if (hit.kind === "pallet") {
        setWorkspaceView({ kind: "pallet", pallet: hit.row });
        return;
      }
      if (hit.kind === "package") {
        setWorkspaceView({ kind: "package", pkg: hit.row, pallet: hit.pallet ?? null });
        return;
      }
      if (hit.kind === "item") {
        if (hit.pkg) {
          setWorkspaceView({ kind: "package", pkg: hit.pkg, pallet: hit.pallet ?? null });
        } else {
          setWorkspaceView({ kind: "loose-item", item: hit.row });
        }
      }
    },
    [resetForms],
  );

  /** Continue lane: jump straight into the relevant workspace (no form). */
  const applyContinueHitToWorkspace = useCallback((hit: ContinueHit | null) => {
    setActiveForm(null);
    if (!hit) {
      setWorkspaceView(null);
      return;
    }
    if (hit.kind === "pallet") {
      setWorkspaceView({ kind: "pallet", pallet: hit.row });
      return;
    }
    if (hit.kind === "package") {
      setWorkspaceView({ kind: "package", pkg: hit.row, pallet: hit.pallet ?? null });
      return;
    }
    if (hit.pkg) {
      setWorkspaceView({ kind: "package", pkg: hit.pkg, pallet: hit.pallet ?? null });
      return;
    }
    setWorkspaceView({ kind: "loose-item", item: hit.row });
  }, []);

  const quickCreatePalletFromScan = useCallback(async () => {
    const tr = scanWorkspace.trim();
    if (!tr) return;
    if (!writeOrgPayload) {
      setNotice({ tone: "error", message: ORG_CONTEXT_NOT_READY_MSG });
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      const createStore = resolveStoreIdForCreates(storesForOrg, scannerLookupStoreId);
      if (!createStore) {
        setNotice({
          tone: "error",
          message:
            storesForOrg.length === 0
              ? "No active stores found. Add a store in System Settings."
              : "Select a store before creating a pallet.",
        });
        return;
      }
      const cr = await createPallet({
        pallet_number: generatePalletNumber(),
        tracking_number: tr,
        carrier_name: "UPS",
        store_id: createStore,
        notes: "",
        ...writeOrgPayload,
      });
      if (!cr.ok || !cr.data) {
        setNotice({ tone: "error", message: cr.error ?? "Create failed." });
        return;
      }
      setActiveForm(null);
      setNewHit(null);
      setLookupDone(false);
      setWorkspaceView({ kind: "pallet", pallet: cr.data });
      setScanWorkspace("");
      setNotice({ tone: "success", message: `Created pallet ${cr.data.pallet_number}` });
      await refreshSnapshots();
    } finally {
      setBusy(false);
      setTimeout(() => scanWorkspaceRef.current?.focus(), 0);
    }
  }, [scanWorkspace, storesForOrg, scannerLookupStoreId, writeOrgPayload, refreshSnapshots]);

  const quickCreatePackageFromScan = useCallback(async () => {
    const tr = scanWorkspace.trim();
    if (!tr) return;
    if (!effectiveOrganizationId) {
      setNotice({ tone: "error", message: ORG_CONTEXT_NOT_READY_MSG });
      return;
    }
    const storeId = resolveStoreIdForCreates(storesForOrg, scannerLookupStoreId);
    if (!storeId) {
      setNotice({
        tone: "error",
        message:
          storesForOrg.length === 0
            ? "No active stores found. Add a store in System Settings."
            : "Select a store before creating a package.",
      });
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      const cr = await createPackage({
        organization_id: effectiveOrganizationId,
        actor_profile_id: actorUserId,
        package_number: generatePackageNumber(),
        tracking_number: tr,
        expected_item_count: 0,
        store_id: storeId,
        created_by: actorName ?? "operator",
      });
      if (!cr.ok || !cr.data) {
        setNotice({ tone: "error", message: cr.error ?? "Create failed." });
        return;
      }
      setActiveForm(null);
      setNewHit(null);
      setLookupDone(false);
      const parent = cr.data.pallet_id ? await fetchPalletById(cr.data.pallet_id) : null;
      setWorkspaceView({ kind: "package", pkg: cr.data, pallet: parent });
      setScanWorkspace("");
      setNotice({ tone: "success", message: `Created package ${cr.data.package_number}` });
      await refreshSnapshots();
    } finally {
      setBusy(false);
      setTimeout(() => scanWorkspaceRef.current?.focus(), 0);
    }
  }, [
    scanWorkspace,
    storesForOrg,
    scannerLookupStoreId,
    effectiveOrganizationId,
    actorUserId,
    actorName,
    refreshSnapshots,
  ]);

  const quickCreateLooseItemFromScan = useCallback(async () => {
    const raw = scanWorkspace.trim();
    if (!raw) return;
    if (!effectiveOrganizationId) {
      setNotice({ tone: "error", message: ORG_CONTEXT_NOT_READY_MSG });
      return;
    }
    const storeId = resolveStoreIdForCreates(storesForOrg, scannerLookupStoreId);
    if (!storeId) {
      setNotice({
        tone: "error",
        message:
          storesForOrg.length === 0
            ? "No active stores found. Add a store in System Settings."
            : "Select a store before creating an item.",
      });
      return;
    }
    const storeRow = storesForOrg.find((s) => s.id === storeId);
    const marketplace = platformToMarketplace(storeRow?.platform ?? "amazon");
    setBusy(true);
    setNotice(null);
    try {
      const res = await insertReturn({
        organization_id: effectiveOrganizationId,
        actor_profile_id: actorUserId,
        lpn: raw,
        marketplace,
        item_name: raw,
        conditions: [],
        store_id: storeId,
        created_by: actorName ?? "operator",
      });
      if (!res.ok || !res.data) {
        setNotice({ tone: "error", message: res.error ?? "Create failed." });
        return;
      }
      setActiveForm(null);
      setNewHit(null);
      setLookupDone(false);
      setWorkspaceView({ kind: "loose-item", item: res.data });
      setScanWorkspace("");
      setNotice({ tone: "success", message: "Created loose item." });
      await refreshSnapshots();
    } finally {
      setBusy(false);
      setTimeout(() => scanWorkspaceRef.current?.focus(), 0);
    }
  }, [
    scanWorkspace,
    storesForOrg,
    scannerLookupStoreId,
    effectiveOrganizationId,
    actorUserId,
    actorName,
    refreshSnapshots,
  ]);

  const onCreateInboundPackageFromExpected = useCallback(async () => {
    if (newHit?.kind !== "expected") return;
    if (!effectiveOrganizationId) {
      setNotice({ tone: "error", message: ORG_CONTEXT_NOT_READY_MSG });
      return;
    }
    const row = newHit.row;
    const storeFromRow = asTrimmedString(row.store_id);
    const storeId =
      storeFromRow && isUuidString(storeFromRow)
        ? storeFromRow
        : resolveStoreIdForCreates(storesForOrg, scannerLookupStoreId);
    if (!storeId) {
      setNotice({
        tone: "error",
        message:
          storesForOrg.length === 0
            ? "No active stores found. Add a store in System Settings."
            : "Expected row has no store — select a store or add one in System Settings.",
      });
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      const cr = await createPackage({
        organization_id: effectiveOrganizationId,
        actor_profile_id: actorUserId,
        package_number: generatePackageNumber(),
        tracking_number: asTrimmedString(row.tracking_number) || scanWorkspace.trim() || undefined,
        carrier_name:
          asTrimmedString(row.carrier_name) || asTrimmedString(row.carrier) || undefined,
        order_id:
          asTrimmedString(row.amazon_order_id) || asTrimmedString(row.order_id) || null,
        expected_item_count:
          Number.parseInt(
            asNumericString(row.expected_scan_quantity) ||
              asNumericString(row.shipped_quantity) ||
              asNumericString(row.requested_quantity) ||
              "0",
            10,
          ) || 0,
        store_id: storeId,
        created_by: actorName ?? "operator",
      });
      if (!cr.ok || !cr.data) {
        setNotice({ tone: "error", message: cr.error ?? "Create failed." });
        return;
      }
      setActiveForm(null);
      setNewHit(null);
      setLookupDone(false);
      const parent = cr.data.pallet_id ? await fetchPalletById(cr.data.pallet_id) : null;
      setWorkspaceView({ kind: "package", pkg: cr.data, pallet: parent });
      setScanWorkspace("");
      setNotice({ tone: "success", message: `Created package ${cr.data.package_number} from expected inbound.` });
      await refreshSnapshots();
    } finally {
      setBusy(false);
      setTimeout(() => scanWorkspaceRef.current?.focus(), 0);
    }
  }, [
    newHit,
    storesForOrg,
    scannerLookupStoreId,
    effectiveOrganizationId,
    actorUserId,
    actorName,
    scanWorkspace,
    refreshSnapshots,
  ]);

  const onRunNewLookup = useCallback(async () => {
    const rawOriginal = lane ? scanWorkspace : scanNew;
    const raw = normalizeExpectedScanInput(rawOriginal);
    if (!raw) return;
    if (scannerStoreGateBlocksLookup) return;
    if (!effectiveOrganizationId) {
      setNotice({
        tone: profileLoading ? "warning" : "error",
        message: profileLoading ? "Loading organization…" : ORG_CONTEXT_NOT_READY_MSG,
      });
      return;
    }
    setLookupBusy(true);
    setNotice(null);
    setLookupDone(false);
    try {
      const hit = await resolveNewHit(rawOriginal);
      setLane("new");
      setScanWorkspace(hit.kind === "none" ? raw : "");
      setNewHit(hit);
      setContinueHit(null);
      setLookupDone(true);
      setResultRevealKey((k) => k + 1);
      applyNewReceivingLookupResult(hit);
      await refreshSnapshots();
      if (hit.kind !== "none") setScanNew("");

      if (hit.kind === "none" && hit.expectedLookupError) {
        setNotice({ tone: "error", message: hit.expectedLookupError });
      } else if (hit.kind === "none") {
        setNotice({ tone: "warning", message: "No match — choose what this is below." });
      } else if (hit.kind === "expected") {
        setNotice({ tone: "success", message: "Expected inbound — create package when ready." });
      } else {
        setNotice({ tone: "success", message: "Match found — workspace opened." });
      }
    } finally {
      setLookupBusy(false);
      setTimeout(() => scanWorkspaceRef.current?.focus(), 0);
    }
  }, [
    lane,
    scanNew,
    scanWorkspace,
    resolveNewHit,
    applyNewReceivingLookupResult,
    refreshSnapshots,
    effectiveOrganizationId,
    profileLoading,
    scannerStoreGateBlocksLookup,
  ]);

  const onRunContinueLookup = useCallback(async () => {
    const raw = (lane ? scanWorkspace : scanContinue).trim();
    if (!raw) return;
    if (scannerStoreGateBlocksLookup) return;
    if (!effectiveOrganizationId) {
      setNotice({
        tone: profileLoading ? "warning" : "error",
        message: profileLoading ? "Loading organization…" : ORG_CONTEXT_NOT_READY_MSG,
      });
      return;
    }
    setLookupBusy(true);
    setNotice(null);
    setLookupDone(false);
    try {
      const hit = await resolveContinueHit(raw);
      setLane("continue");
      setScanWorkspace("");
      setContinueHit(hit);
      setNewHit(null);
      setLookupDone(true);
      setResultRevealKey((k) => k + 1);
      applyContinueHitToWorkspace(hit);

      if (!hit) {
        setNotice({ tone: "warning", message: "No existing open work for that scan." });
      } else {
        await refreshSnapshots();
        setNotice({ tone: "success", message: "Continuing existing work." });
      }
    } finally {
      setLookupBusy(false);
      setTimeout(() => scanWorkspaceRef.current?.focus(), 0);
    }
  }, [
    lane,
    scanContinue,
    scanWorkspace,
    resolveContinueHit,
    applyContinueHitToWorkspace,
    refreshSnapshots,
    effectiveOrganizationId,
    profileLoading,
    scannerStoreGateBlocksLookup,
  ]);

  /* ------------- Workspace scan handlers ------------- */

  /** Pallet workspace: scan packages → expected_packages, then packages, then create-under-pallet. */
  const onScanPackageInPallet = useCallback(async () => {
    if (workspaceView?.kind !== "pallet") return;
    const pallet = workspaceView.pallet;
    const raw = scanWorkspace.trim();
    if (!raw) return;
    if (scannerStoreGateBlocksLookup) return;
    if (!effectiveOrganizationId) {
      setNotice({
        tone: profileLoading ? "warning" : "error",
        message: profileLoading ? "Loading organization…" : ORG_CONTEXT_NOT_READY_MSG,
      });
      return;
    }
    setLookupBusy(true);
    setNotice(null);
    try {
      // 1. expected_packages
      if (lane === "new") {
        const epRes = await lookupExpectedPackageByScan(effectiveOrganizationId, raw, resolvedLookupStoreId);
        if (process.env.NODE_ENV === "development" && showScannerDebug) {
          setExpectedLookupDebug(epRes.debug);
        } else {
          setExpectedLookupDebug(null);
        }
        const expectedBlock = epRes.uiError ?? epRes.queryFailureMessage;
        if (expectedBlock) {
          setNotice({ tone: "error", message: expectedBlock });
          return;
        }
        const expected = epRes.row;
        if (expected) {
          const cr = await createPackage({
            organization_id: effectiveOrganizationId,
            actor_profile_id: actorUserId,
            package_number: generatePackageNumber(),
            tracking_number: asTrimmedString(expected.tracking_number) || raw,
            carrier_name:
              asTrimmedString(expected.carrier_name) ||
              asTrimmedString(expected.carrier) ||
              pallet.carrier_name ||
              undefined,
            order_id:
              asTrimmedString(expected.amazon_order_id) ||
              asTrimmedString(expected.order_id) ||
              pallet.amazon_order_id ||
              null,
            expected_item_count:
              Number.parseInt(
                asNumericString(expected.expected_scan_quantity) ||
                  asNumericString(expected.shipped_quantity) ||
                  asNumericString(expected.requested_quantity) ||
                  "0",
                10,
              ) || 0,
            pallet_id: pallet.id,
            store_id:
              asTrimmedString(expected.store_id) && isUuidString(asTrimmedString(expected.store_id))
                ? asTrimmedString(expected.store_id)
                : pallet.store_id ?? undefined,
            created_by: actorName ?? "operator",
          });
          if (cr.ok && cr.data) {
            setNotice({ tone: "success", message: `Created package ${cr.data.package_number} from expected.` });
            setScanWorkspace("");
            await refreshSnapshots();
            return;
          }
          setNotice({ tone: "error", message: cr.error ?? "Create failed." });
          return;
        }
      }

      // 2. existing packages → link
      const existingPkg = await lookupPackageByScanDirect(effectiveOrganizationId, raw, resolvedLookupStoreId);
      if (existingPkg) {
        if (existingPkg.pallet_id !== pallet.id) {
          const ur = await updatePackage(
            existingPkg.id,
            { pallet_id: pallet.id },
            actorName ?? "operator",
            actorUserId,
          );
          if (!ur.ok) {
            setNotice({ tone: "error", message: ur.error ?? "Link failed." });
            return;
          }
          setNotice({ tone: "success", message: `Linked ${existingPkg.package_number} to this pallet.` });
        } else {
          setNotice({ tone: "success", message: `Already on this pallet: ${existingPkg.package_number}.` });
        }
        setScanWorkspace("");
        await refreshSnapshots();
        return;
      }

      // 3. continue lane: no creates
      if (lane === "continue") {
        setNotice({ tone: "warning", message: "No matching package found." });
        return;
      }

      // 4. create new package under current pallet (inherit pallet metadata)
      const cr = await createPackage({
        organization_id: effectiveOrganizationId,
        actor_profile_id: actorUserId,
        package_number: generatePackageNumber(),
        tracking_number: raw,
        pallet_id: pallet.id,
        store_id: pallet.store_id ?? undefined,
        carrier_name: pallet.carrier_name ?? undefined,
        order_id: pallet.amazon_order_id ?? null,
        expected_item_count: 0,
        created_by: actorName ?? "operator",
      });
      if (cr.ok && cr.data) {
        setNotice({ tone: "success", message: `Created package ${cr.data.package_number}.` });
        setScanWorkspace("");
        await refreshSnapshots();
      } else {
        setNotice({ tone: "error", message: cr.error ?? "Create failed." });
      }
    } finally {
      setLookupBusy(false);
      setTimeout(() => scanWorkspaceRef.current?.focus(), 0);
    }
  }, [
    workspaceView,
    scanWorkspace,
    effectiveOrganizationId,
    actorUserId,
    actorName,
    lane,
    refreshSnapshots,
    setExpectedLookupDebug,
    profileLoading,
    resolvedLookupStoreId,
    showScannerDebug,
  ]);

  /** Package workspace: scan items → returns lookup, link or create under current package. */
  const onScanItemInPackage = useCallback(async () => {
    if (workspaceView?.kind !== "package") return;
    const pkg = workspaceView.pkg;
    const raw = scanWorkspace.trim();
    if (!raw) return;
    if (scannerStoreGateBlocksLookup) return;
    if (!effectiveOrganizationId) {
      setNotice({
        tone: profileLoading ? "warning" : "error",
        message: profileLoading ? "Loading organization…" : ORG_CONTEXT_NOT_READY_MSG,
      });
      return;
    }
    setLookupBusy(true);
    setNotice(null);
    try {
      const existing = await lookupReturnByIdentifiers(effectiveOrganizationId, raw, resolvedLookupStoreId);
      if (existing) {
        if (existing.package_id !== pkg.id) {
          const ur = await updateReturn(
            existing.id,
            { package_id: pkg.id },
            actorName ?? "operator",
            actorUserId,
          );
          if (!ur.ok) {
            setNotice({ tone: "error", message: ur.error ?? "Link failed." });
            return;
          }
          setNotice({
            tone: "success",
            message: `Linked ${existing.item_name || existing.lpn || raw} to this package.`,
          });
        } else {
          setNotice({
            tone: "success",
            message: `Already in this package: ${existing.item_name || existing.lpn || raw}.`,
          });
        }
        setScanWorkspace("");
        await refreshSnapshots();
        return;
      }

      if (lane === "continue") {
        setNotice({ tone: "warning", message: "No matching item found." });
        return;
      }

      const storeRow = storesForOrg.find((s) => s.id === (pkg.store_id ?? ""));
      const marketplace = platformToMarketplace(storeRow?.platform ?? "amazon");
      const res = await insertReturn({
        organization_id: effectiveOrganizationId,
        actor_profile_id: actorUserId,
        lpn: raw,
        marketplace,
        // item_name is required by ReturnInsertPayload — operator can rename later in admin Returns.
        item_name: raw,
        conditions: [],
        package_id: pkg.id,
        store_id: pkg.store_id ?? undefined,
        order_id: pkg.order_id ?? null,
        created_by: actorName ?? "operator",
      });
      if (res.ok && res.data) {
        setNotice({ tone: "success", message: `Captured item ${res.data.lpn ?? raw}.` });
        setScanWorkspace("");
        await refreshSnapshots();
      } else {
        setNotice({ tone: "error", message: res.error ?? "Create failed." });
      }
    } finally {
      setLookupBusy(false);
      setTimeout(() => scanWorkspaceRef.current?.focus(), 0);
    }
  }, [
    workspaceView,
    scanWorkspace,
    effectiveOrganizationId,
    actorUserId,
    actorName,
    storesForOrg,
    lane,
    refreshSnapshots,
    profileLoading,
    scannerStoreGateBlocksLookup,
    resolvedLookupStoreId,
  ]);

  /** Top-of-page scan dispatch — depends on current view. */
  const onWorkspaceScan = useCallback(() => {
    if (workspaceView?.kind === "pallet") {
      void onScanPackageInPallet();
      return;
    }
    if (workspaceView?.kind === "package") {
      void onScanItemInPackage();
      return;
    }
    // No workspace: re-run lookup on current lane.
    if (lane === "new") void onRunNewLookup();
    else if (lane === "continue") void onRunContinueLookup();
  }, [workspaceView, lane, onScanPackageInPallet, onScanItemInPackage, onRunNewLookup, onRunContinueLookup]);

  /* ------------- Form save handlers (transition to workspace) ------------- */

  const onSavePallet = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (!effectiveOrganizationId || !writeOrgPayload) {
        setNotice({ tone: "error", message: ORG_CONTEXT_NOT_READY_MSG });
        return;
      }
      const tr = pltTracking.trim();
      if (!tr) {
        setNotice({ tone: "warning", message: "Tracking or pallet identifier is required." });
        return;
      }
      setBusy(true);
      setNotice(null);
      try {
        if (saveMode === "edit" && palletId) {
          const ur = await updatePallet(
            palletId,
            {
              tracking_number: tr,
              carrier_name: pltCarrier || null,
              amazon_order_id: pltAmazonOrder.trim() || null,
              store_id: pltStoreId || null,
              notes: pltNotes.trim() || null,
            },
            actorName ?? "operator",
            effectiveOrganizationId,
            actorUserId,
          );
          if (!ur.ok || !ur.data) {
            setNotice({ tone: "error", message: ur.error ?? "Save failed." });
            return;
          }
          setActiveForm(null);
          setWorkspaceView({ kind: "pallet", pallet: ur.data });
          setNotice({ tone: "success", message: `Saved pallet ${ur.data.pallet_number}` });
        } else {
          const cr = await createPallet({
            pallet_number: generatePalletNumber(),
            tracking_number: tr,
            carrier_name: pltCarrier || null,
            amazon_order_id: pltAmazonOrder.trim() || null,
            store_id: pltStoreId || undefined,
            notes: pltNotes.trim() || "",
            ...writeOrgPayload,
          });
          if (!cr.ok || !cr.data) {
            setNotice({ tone: "error", message: cr.error ?? "Create failed." });
            return;
          }
          setActiveForm(null);
          setWorkspaceView({ kind: "pallet", pallet: cr.data });
          setNotice({ tone: "success", message: `Created pallet ${cr.data.pallet_number}` });
        }
        setScanWorkspace("");
        await refreshSnapshots();
      } finally {
        setBusy(false);
        setTimeout(() => scanWorkspaceRef.current?.focus(), 0);
      }
    },
    [
      pltTracking,
      pltCarrier,
      pltAmazonOrder,
      pltStoreId,
      pltNotes,
      saveMode,
      palletId,
      actorName,
      effectiveOrganizationId,
      actorUserId,
      writeOrgPayload,
      refreshSnapshots,
    ],
  );

  const onSavePackage = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (!effectiveOrganizationId) {
        setNotice({ tone: "error", message: ORG_CONTEXT_NOT_READY_MSG });
        return;
      }
      if (!pkgNumber.trim()) {
        setNotice({ tone: "warning", message: "Package # is required." });
        return;
      }
      if (!pkgStoreId.trim() || !isUuidString(pkgStoreId)) {
        setNotice({ tone: "warning", message: "Select a valid store." });
        return;
      }
      setBusy(true);
      setNotice(null);
      try {
        const palletFk = pkgPalletId.trim() && isUuidString(pkgPalletId.trim()) ? pkgPalletId.trim() : undefined;
        if (saveMode === "edit" && pkgId) {
          /** `PackageUpdatePayload` allows store_id update (server treats as nullable). */
          const pkgUpdates = {
            tracking_number: pkgTracking.trim() || null,
            carrier_name: pkgCarrier.trim() || null,
            rma_number: pkgRma.trim() || null,
            order_id: pkgAmazonOrder.trim() || null,
            expected_item_count: Number.parseInt(pkgExpected, 10) || 0,
            pallet_id: palletFk ?? null,
            store_id: pkgStoreId,
          } as PackageUpdatePayload;
          const ur = await updatePackage(pkgId, pkgUpdates, actorName ?? "operator", actorUserId);
          if (!ur.ok || !ur.data) {
            setNotice({ tone: "error", message: ur.error ?? "Save failed." });
            return;
          }
          const parent = palletFk ? palletById.get(palletFk) ?? null : null;
          setActiveForm(null);
          setWorkspaceView({ kind: "package", pkg: ur.data, pallet: parent });
          setNotice({ tone: "success", message: `Saved package ${ur.data.package_number}` });
        } else {
          const cr = await createPackage({
            organization_id: effectiveOrganizationId,
            actor_profile_id: actorUserId,
            package_number: pkgNumber.trim(),
            tracking_number: pkgTracking.trim() || undefined,
            carrier_name: pkgCarrier.trim() || undefined,
            rma_number: pkgRma.trim() || undefined,
            order_id: pkgAmazonOrder.trim() || null,
            expected_item_count: Number.parseInt(pkgExpected, 10) || 0,
            pallet_id: palletFk,
            store_id: pkgStoreId || undefined,
            created_by: actorName ?? "operator",
          });
          if (!cr.ok || !cr.data) {
            setNotice({ tone: "error", message: cr.error ?? "Create failed." });
            return;
          }
          const parent = palletFk ? palletById.get(palletFk) ?? null : null;
          setActiveForm(null);
          setWorkspaceView({ kind: "package", pkg: cr.data, pallet: parent });
          setNotice({ tone: "success", message: `Created package ${cr.data.package_number}` });
        }
        setScanWorkspace("");
        await refreshSnapshots();
      } finally {
        setBusy(false);
        setTimeout(() => scanWorkspaceRef.current?.focus(), 0);
      }
    },
    [
      pkgNumber,
      pkgTracking,
      pkgCarrier,
      pkgRma,
      pkgAmazonOrder,
      pkgExpected,
      pkgPalletId,
      pkgStoreId,
      saveMode,
      pkgId,
      actorName,
      actorUserId,
      effectiveOrganizationId,
      palletById,
      refreshSnapshots,
    ],
  );

  const onSaveItem = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (!effectiveOrganizationId) {
        setNotice({ tone: "error", message: ORG_CONTEXT_NOT_READY_MSG });
        return;
      }
      if (!itemName.trim()) {
        setNotice({ tone: "warning", message: "Item name is required." });
        return;
      }
      if (!itemStoreId.trim() || !isUuidString(itemStoreId)) {
        setNotice({ tone: "warning", message: "Select a valid store." });
        return;
      }
      const storeRow = storesForOrg.find((s) => s.id === itemStoreId);
      const marketplace = platformToMarketplace(storeRow?.platform ?? "amazon");
      const conditions = conditionsFromKeys(itemConditionKeys);
      const pkgFk = itemPackageId.trim() && isUuidString(itemPackageId.trim()) ? itemPackageId.trim() : undefined;

      setBusy(true);
      setNotice(null);
      try {
        if (saveMode === "edit" && retId) {
          const ur = await updateReturn(
            retId,
            {
              lpn: itemLpn.trim() || null,
              rma_number: itemRma.trim() || null,
              item_name: itemName.trim(),
              asin: itemAsin.trim() || undefined,
              fnsku: itemFnsku.trim() || undefined,
              sku: itemSku.trim() || undefined,
              product_identifier: itemProductCode.trim() || undefined,
              notes: itemNotes.trim() || null,
              conditions,
              expiration_date: itemExpiry.trim() || undefined,
              batch_number: itemBatch.trim() || undefined,
              package_id: pkgFk,
              store_id: itemStoreId,
            },
            actorName ?? "operator",
            actorUserId,
          );
          if (!ur.ok || !ur.data) {
            setNotice({ tone: "error", message: ur.error ?? "Save failed." });
            return;
          }
          setActiveForm(null);
          if (ur.data.package_id) {
            const pkgRow = await fetchPackageById(ur.data.package_id);
            if (pkgRow) {
              const palletRow = pkgRow.pallet_id ? await fetchPalletById(pkgRow.pallet_id) : null;
              setWorkspaceView({ kind: "package", pkg: pkgRow, pallet: palletRow });
            } else {
              setWorkspaceView({ kind: "loose-item", item: ur.data });
            }
          } else {
            setWorkspaceView({ kind: "loose-item", item: ur.data });
          }
          setNotice({ tone: "success", message: "Saved item." });
        } else {
          const res = await insertReturn({
            organization_id: effectiveOrganizationId,
            actor_profile_id: actorUserId,
            lpn: itemLpn.trim() || undefined,
            rma_number: itemRma.trim() || undefined,
            marketplace,
            item_name: itemName.trim(),
            conditions,
            asin: itemAsin.trim() || itemProductCode.trim() || undefined,
            fnsku: itemFnsku.trim() || undefined,
            sku: itemSku.trim() || undefined,
            amazon_order_id: undefined,
            notes: itemNotes.trim() || undefined,
            expiration_date: itemExpiry.trim() || undefined,
            batch_number: itemBatch.trim() || undefined,
            package_id: pkgFk,
            store_id: itemStoreId || undefined,
            created_by: actorName ?? "operator",
          });
          if (!res.ok || !res.data) {
            setNotice({ tone: "error", message: res.error ?? "Create failed." });
            return;
          }
          setActiveForm(null);
          if (res.data.package_id) {
            const pkgRow = await fetchPackageById(res.data.package_id);
            if (pkgRow) {
              const palletRow = pkgRow.pallet_id ? await fetchPalletById(pkgRow.pallet_id) : null;
              setWorkspaceView({ kind: "package", pkg: pkgRow, pallet: palletRow });
            } else {
              setWorkspaceView({ kind: "loose-item", item: res.data });
            }
          } else {
            setWorkspaceView({ kind: "loose-item", item: res.data });
          }
          setNotice({ tone: "success", message: "Created item." });
        }
        setScanWorkspace("");
        await refreshSnapshots();
      } finally {
        setBusy(false);
        setTimeout(() => scanWorkspaceRef.current?.focus(), 0);
      }
    },
    [
      itemName,
      itemStoreId,
      storesForOrg,
      itemConditionKeys,
      itemPackageId,
      itemLpn,
      itemRma,
      itemAsin,
      itemProductCode,
      itemFnsku,
      itemSku,
      itemNotes,
      itemExpiry,
      itemBatch,
      saveMode,
      retId,
      actorName,
      actorUserId,
      effectiveOrganizationId,
      refreshSnapshots,
    ],
  );

  /* ------------- workspace transitions ------------- */

  const openPackageWorkspace = useCallback(
    (pkg: PackageRecord) => {
      const parent = pkg.pallet_id ? palletById.get(pkg.pallet_id) ?? null : null;
      setActiveForm(null);
      setNewHit(null);
      setContinueHit(null);
      setLookupDone(false);
      setScanWorkspace("");
      setWorkspaceView({ kind: "package", pkg, pallet: parent });
      setNotice(null);
      setTimeout(() => scanWorkspaceRef.current?.focus(), 0);
    },
    [palletById],
  );

  const backToPalletWorkspace = useCallback(() => {
    if (workspaceView?.kind !== "package") return;
    if (!workspaceView.pallet) {
      setWorkspaceView(null);
      return;
    }
    setWorkspaceView({ kind: "pallet", pallet: workspaceView.pallet });
    setScanWorkspace("");
    setTimeout(() => scanWorkspaceRef.current?.focus(), 0);
  }, [workspaceView]);

  /* ------------- visual chrome ------------- */

  const detectedLabel = useMemo(() => {
    if (lane === "new" && newHit) {
      if (newHit.kind === "expected") return "Expected inbound";
      if (newHit.kind === "pallet") return "Pallet";
      if (newHit.kind === "package") return "Package / Box";
      if (newHit.kind === "item") return "Item (return)";
      return "Unknown scan";
    }
    if (lane === "continue" && continueHit) {
      if (continueHit.kind === "pallet") return "Pallet";
      if (continueHit.kind === "package") return "Package / Box";
      return "Item (return)";
    }
    return null;
  }, [lane, newHit, continueHit]);

  const noticeClass =
    notice?.tone === "success"
      ? "border-[#D6B46A]/40 bg-[rgba(214,180,106,0.12)] text-[#0F172A] shadow-[0_0_20px_rgba(214,180,106,0.2)] dark:border-[#F5C542]/40 dark:bg-[rgba(245,197,66,0.1)] dark:text-[#F8FAFC] dark:shadow-[0_0_24px_rgba(255,215,0,0.12)]"
      : notice?.tone === "error"
        ? "border-[#DC2626]/45 bg-[rgba(220,38,38,0.08)] text-[#991B1B] shadow-[0_0_16px_rgba(220,38,38,0.12)] dark:bg-[rgba(220,38,38,0.12)] dark:text-[#FECACA] dark:shadow-[0_0_20px_rgba(220,38,38,0.12)]"
        : "border-[#D6B46A]/35 bg-[rgba(214,180,106,0.1)] text-[#0F172A] shadow-[0_0_16px_rgba(214,180,106,0.15)] dark:bg-[rgba(214,180,106,0.08)] dark:text-[#F8FAFC] dark:shadow-[0_0_18px_rgba(245,197,66,0.08)]";

  const scanLineIconAnimClass = useMemo(
    () =>
      lookupBusy
        ? "motion-safe:animate-[operator-scan-icon-searching-light_1.1s_ease-in-out_infinite] dark:motion-safe:animate-[operator-scan-icon-searching-dark_1.1s_ease-in-out_infinite]"
        : "motion-safe:animate-[operator-scan-icon-idle-light_3.2s_ease-in-out_infinite] dark:motion-safe:animate-[operator-scan-icon-idle-dark_3.2s_ease-in-out_infinite]",
    [lookupBusy],
  );

  /** Store scope — above scan inputs; UI depends on active store count for effectiveOrganizationId. */
  const storeLookupControl = (
    <div className="space-y-2 rounded-2xl border border-[#D6B46A]/22 bg-white/80 p-4 dark:border-[#F5C542]/18 dark:bg-[#0B1220]/80">
      {storesLoading ? (
        <p className={`text-sm ${TEXT_SUBTLE}`}>Loading stores…</p>
      ) : !effectiveOrganizationId ? (
        <p className={`text-sm ${TEXT_SUBTLE}`}>Store scope loads after organization context is ready.</p>
      ) : storesForOrg.length === 0 ? (
        <div
          className="rounded-xl border border-[#DC2626]/35 bg-[rgba(220,38,38,0.08)] px-3 py-3 text-sm text-[#991B1B] dark:border-[#F87171]/40 dark:bg-[rgba(220,38,38,0.12)] dark:text-[#FECACA]"
          role="alert"
        >
          No active stores found. Add a store in System Settings.
        </div>
      ) : storesForOrg.length === 1 ? (
        <div className="inline-flex max-w-full flex-wrap items-center gap-2 rounded-xl border border-[#D6B46A]/25 bg-[#FFFBF5] px-3 py-2 text-sm shadow-[inset_0_0_0_1px_rgba(255,255,255,0.5)] dark:border-[#F5C542]/18 dark:bg-[#08111F] dark:shadow-[inset_0_0_0_1px_rgba(245,197,66,0.04)]">
          <span className={`font-medium ${TEXT_BODY}`}>
            Store: {storesForOrgSorted[0]?.name?.trim() || "—"}
          </span>
        </div>
      ) : (
        <>
          <label className={LABEL} htmlFor="operator-scanner-lookup-store">
            Store
          </label>
          <select
            id="operator-scanner-lookup-store"
            className={`${INPUT_SM} min-h-[3rem] text-base touch-manipulation`}
            value={scannerLookupStoreId}
            onChange={(e) => setScannerLookupStoreId(e.target.value)}
            disabled={storesLoading || scannerBlockedNoOrg || !effectiveOrganizationId}
            aria-invalid={
              scannerStoreGateBlocksLookup &&
              storesForOrg.length > 1 &&
              !(scannerDevDebug && scannerLookupStoreId === OPERATOR_SCAN_DEBUG_ORG_WIDE)
            }
          >
            <option value="" disabled>
              Select a store…
            </option>
            {scannerDevDebug ? (
              <option value={OPERATOR_SCAN_DEBUG_ORG_WIDE}>All stores (debug only)</option>
            ) : null}
            {storesForOrgSorted.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          {scannerStoreGateBlocksLookup &&
          !(scannerDevDebug && scannerLookupStoreId === OPERATOR_SCAN_DEBUG_ORG_WIDE) ? (
            <p className="text-sm font-medium text-[#B45309] dark:text-[#FBBF24]" role="status">
              Select a store before lookup.
            </p>
          ) : null}
          {scannerDevDebug && scannerLookupStoreId === OPERATOR_SCAN_DEBUG_ORG_WIDE ? (
            <p className={`text-[11px] ${TEXT_SUBTLE}`}>
              Debug: lookups run organization-wide (no store_id filter on reads).
            </p>
          ) : null}
        </>
      )}
      {storesError ? <p className="text-xs text-[#DC2626] dark:text-[#F87171]">{storesError}</p> : null}
    </div>
  );

  const scanKeyframes = (
    <style>{`
      @keyframes operator-scan-icon-idle-light {
        0%, 100% { opacity: 0.92; filter: drop-shadow(0 0 2px rgba(214, 180, 106, 0.35)) drop-shadow(0 0 8px rgba(214, 180, 106, 0.2)); }
        50% { opacity: 1; filter: drop-shadow(0 0 6px rgba(214, 180, 106, 0.5)) drop-shadow(0 0 14px rgba(245, 197, 66, 0.25)); }
      }
      @keyframes operator-scan-icon-idle-dark {
        0%, 100% { opacity: 0.9; filter: drop-shadow(0 0 4px rgba(255, 215, 0, 0.45)) drop-shadow(0 0 14px rgba(245, 197, 66, 0.3)); }
        50% { opacity: 1; filter: drop-shadow(0 0 10px rgba(255, 215, 0, 0.8)) drop-shadow(0 0 22px rgba(245, 197, 66, 0.5)); }
      }
      @keyframes operator-scan-icon-searching-light {
        0%, 100% { opacity: 1; filter: drop-shadow(0 0 4px rgba(214, 180, 106, 0.45)); }
        50% { filter: drop-shadow(0 0 10px rgba(214, 180, 106, 0.65)); }
      }
      @keyframes operator-scan-icon-searching-dark {
        0%, 100% { opacity: 1; filter: drop-shadow(0 0 6px rgba(255, 215, 0, 0.55)); }
        50% { filter: drop-shadow(0 0 16px rgba(255, 215, 0, 0.9)) drop-shadow(0 0 28px rgba(245, 197, 66, 0.55)); }
      }
      @keyframes operator-scan-input-pulse-light {
        0%, 100% { box-shadow: 0 0 0 0 rgba(214, 180, 106, 0), inset 0 0 0 1px rgba(214, 180, 106, 0.12); }
        50% { box-shadow: 0 0 0 2px rgba(214, 180, 106, 0.35), 0 0 18px rgba(245, 197, 66, 0.2), inset 0 0 12px rgba(255, 252, 247, 0.5); }
      }
      @keyframes operator-scan-input-pulse-dark {
        0%, 100% { box-shadow: 0 0 0 0 rgba(255, 215, 0, 0), inset 0 0 0 1px rgba(245, 197, 66, 0.15); }
        50% { box-shadow: 0 0 0 2px rgba(255, 215, 0, 0.45), 0 0 22px rgba(245, 197, 66, 0.38), inset 0 0 16px rgba(255, 215, 0, 0.05); }
      }
      @keyframes operator-result-reveal {
        from { opacity: 0; transform: translateY(8px); }
        to { opacity: 1; transform: translateY(0); }
      }
      .operator-result-reveal {
        animation: operator-result-reveal 0.38s cubic-bezier(0.22, 1, 0.36, 1) both;
      }
    `}</style>
  );

  const debugPanelsEnabled = process.env.NODE_ENV === "development" && showScannerDebug;

  const orgScopeDebugPanel = debugPanelsEnabled ? (
      <div className="rounded-lg border border-dashed border-[#94A3B8]/60 bg-[rgba(148,163,184,0.08)] p-3 font-mono text-[10px] leading-relaxed text-[#334155] dark:border-[#64748B]/50 dark:bg-[rgba(30,41,59,0.5)] dark:text-[#CBD5E1]">
        <p className="mb-1.5 font-sans text-[11px] font-bold uppercase tracking-wide text-[#64748B] dark:text-[#94A3B8]">
          Dev — organization scope
        </p>
        <dl className="space-y-0.5">
          <div>
            <dt className="inline text-[#64748B] dark:text-[#94A3B8]">loggedInRole (effective tier):</dt>{" "}
            <dd className="inline">{role}</dd>
          </div>
          <div>
            <dt className="inline text-[#64748B] dark:text-[#94A3B8]">canonicalRoleKey (effective):</dt>{" "}
            <dd className="inline break-all">{canonicalRoleKey ?? "(null)"}</dd>
          </div>
          <div>
            <dt className="inline text-[#64748B] dark:text-[#94A3B8]">actorCanonicalRoleKey:</dt>{" "}
            <dd className="inline break-all">{actorCanonicalRoleKey ?? "(null)"}</dd>
          </div>
          <div>
            <dt className="inline text-[#64748B] dark:text-[#94A3B8]">actorUserId:</dt>{" "}
            <dd className="inline break-all">{actorUserId ?? "(null)"}</dd>
          </div>
          <div>
            <dt className="inline text-[#64748B] dark:text-[#94A3B8]">selectedOrganizationId (UserRoleContext.organizationId):</dt>{" "}
            <dd className="inline break-all">{selectedOrganizationId ?? "(null)"}</dd>
          </div>
          <div>
            <dt className="inline text-[#64748B] dark:text-[#94A3B8]">effectiveOrganizationId (queries):</dt>{" "}
            <dd className="inline break-all">{effectiveOrganizationId ?? "(null)"}</dd>
          </div>
          <div>
            <dt className="inline text-[#64748B] dark:text-[#94A3B8]">profileLoading:</dt>{" "}
            <dd className="inline">{profileLoading ? "true" : "false"}</dd>
          </div>
        </dl>
      </div>
    ) : null;

  /* ============================================================== */
  /* HOME                                                            */
  /* ============================================================== */

  if (!lane) {
    return (
      <>
        {scanKeyframes}
        <div className={`${PAGE_BG} px-4 py-6 pb-28`}>
          <main className="mx-auto w-full max-w-lg flex flex-col gap-6 py-4">
            <header className="text-center">
              <h1 className="bg-gradient-to-r from-[#0F172A] via-[#B8860B] to-[#D4A017] bg-clip-text text-3xl font-bold tracking-tight text-transparent drop-shadow-[0_1px_2px_rgba(15,23,42,0.08)] dark:from-[#F8FAFC] dark:via-[#F5C542] dark:to-[#FFD700] dark:drop-shadow-[0_0_24px_rgba(255,215,0,0.25)]">
                Operator Scanner
              </h1>
            </header>

            {orgContextLoading && (
              <p className={`text-center text-xs ${TEXT_SUBTLE}`}>Loading organization…</p>
            )}
            {orgContextMissing && (
              <div className="rounded-xl border border-[#DC2626]/35 bg-[rgba(220,38,38,0.08)] px-3 py-2 text-center text-sm text-[#991B1B] dark:border-[#F87171]/40 dark:bg-[rgba(220,38,38,0.12)] dark:text-[#FECACA]">
                {ORG_CONTEXT_NOT_READY_MSG}
              </div>
            )}
            {orgScopeDebugPanel}

            {storeLookupControl}

            <section className={CARD}>
              <div className="mb-4 flex items-center justify-between gap-3">
                <h2 className={SECTION_TITLE}>New Receiving</h2>
                <span className={SCAN_ICON_WRAP}>
                  <ScanLine className={`h-5 w-5 ${scanLineIconAnimClass}`} />
                </span>
              </div>
              <form
                className="space-y-3"
                onSubmit={(e) => {
                  e.preventDefault();
                  void onRunNewLookup();
                }}
              >
                <input
                  ref={scanHomeNewRef}
                  className={`${SCAN_INPUT} ${lookupBusy ? SCAN_INPUT_SEARCHING : ""}`}
                  value={scanNew}
                  onChange={(e) => setScanNew(e.target.value)}
                  placeholder={SCAN_PLACEHOLDER_TRACKING}
                  autoComplete="off"
                  spellCheck={false}
                />
                <button
                  type="submit"
                  disabled={
                    scannerBlockedNoOrg || scannerStoreGateBlocksLookup || lookupBusy || !scanNew.trim()
                  }
                  className={cn(
                    BTN_LOOKUP,
                    (scannerBlockedNoOrg || scannerStoreGateBlocksLookup || !scanNew.trim()) &&
                      "cursor-not-allowed opacity-60",
                    lookupBusy && "brightness-90",
                  )}
                >
                  {lookupBusy ? (
                    <>
                      <Loader2 className="h-5 w-5 shrink-0 text-[#000000] motion-safe:animate-spin" />
                      <span className="text-[#000000]">Searching…</span>
                    </>
                  ) : (
                    <>
                      <Search className="h-5 w-5 shrink-0 text-[#000000]" />
                      <span className="text-[#000000]">Lookup</span>
                    </>
                  )}
                </button>
              </form>
            </section>

            <section className={CARD}>
              <div className="mb-4 flex items-center justify-between gap-3">
                <h2 className={SECTION_TITLE}>Continue Existing</h2>
                <span className={SCAN_ICON_WRAP}>
                  <ScanLine className={`h-5 w-5 ${scanLineIconAnimClass}`} />
                </span>
              </div>
              <form
                className="space-y-3"
                onSubmit={(e) => {
                  e.preventDefault();
                  void onRunContinueLookup();
                }}
              >
                <input
                  ref={scanHomeContinueRef}
                  className={`${SCAN_INPUT} ${lookupBusy ? SCAN_INPUT_SEARCHING : ""}`}
                  value={scanContinue}
                  onChange={(e) => setScanContinue(e.target.value)}
                  placeholder={SCAN_PLACEHOLDER_TRACKING}
                  autoComplete="off"
                  spellCheck={false}
                />
                <button
                  type="submit"
                  disabled={
                    scannerBlockedNoOrg || scannerStoreGateBlocksLookup || lookupBusy || !scanContinue.trim()
                  }
                  className={cn(
                    BTN_SECONDARY_LOOKUP,
                    (scannerBlockedNoOrg || scannerStoreGateBlocksLookup || !scanContinue.trim()) &&
                      "cursor-not-allowed opacity-60",
                    lookupBusy && "brightness-90",
                  )}
                >
                  {lookupBusy ? (
                    <>
                      <Loader2 className="h-5 w-5 shrink-0 text-[#000000] motion-safe:animate-spin" />
                      <span className="text-[#000000]">Searching…</span>
                    </>
                  ) : (
                    <>
                      <Search className="h-5 w-5 shrink-0 text-[#000000]" />
                      <span className="text-[#000000]">Lookup</span>
                    </>
                  )}
                </button>
              </form>
            </section>
          </main>
        </div>
      </>
    );
  }

  /* ============================================================== */
  /* IN-LANE — top scan card adapts to current workspace             */
  /* ============================================================== */

  const topPrompt: string =
    workspaceView?.kind === "pallet"
      ? "Scan packages / boxes for this pallet"
      : workspaceView?.kind === "package"
        ? "Now scan items for this package"
        : workspaceView?.kind === "loose-item"
          ? "Loose item — scan another to start over"
          : lane === "new"
            ? "New Receiving"
            : "Continue Existing";

  const topPlaceholder: string =
    workspaceView?.kind === "pallet"
      ? "Scan package barcode…"
      : workspaceView?.kind === "package"
        ? "Scan item barcode…"
        : SCAN_PLACEHOLDER_TRACKING;

  const topButtonClass = workspaceView ? BTN_LOOKUP : lane === "new" ? BTN_LOOKUP : BTN_SECONDARY_LOOKUP;
  const topButtonLabel: string = workspaceView
    ? workspaceView.kind === "pallet"
      ? "Scan package"
      : workspaceView.kind === "package"
        ? "Scan item"
        : "Lookup"
    : "Lookup";

  return (
    <>
      {scanKeyframes}
      <div className={`${PAGE_BG} px-4 py-4 pb-32`}>
        <main className="mx-auto w-full max-w-lg space-y-4 pb-8">
          {/* Top nav */}
          <div className="flex items-center gap-2">
            <button type="button" className={BTN_GHOST} onClick={startOver}>
              <ArrowLeft className="h-4 w-4" /> Home
            </button>
            {workspaceView && (
              <button type="button" className={BTN_GHOST} onClick={exitWorkspace}>
                Exit workspace
              </button>
            )}
          </div>

          {orgContextLoading && (
            <p className={`text-center text-xs ${TEXT_SUBTLE}`}>Loading organization…</p>
          )}
          {orgContextMissing && (
            <div className="rounded-xl border border-[#DC2626]/35 bg-[rgba(220,38,38,0.08)] px-3 py-2 text-center text-sm text-[#991B1B] dark:border-[#F87171]/40 dark:bg-[rgba(220,38,38,0.12)] dark:text-[#FECACA]">
              {ORG_CONTEXT_NOT_READY_MSG}
            </div>
          )}
          {orgScopeDebugPanel}

          {storeLookupControl}

          {/* Top scan card (contextual) */}
          <div className={CARD}>
            <div className="flex items-center justify-between gap-2">
              <p className={SECTION_KICKER}>{topPrompt}</p>
              <span className={SCAN_ICON_WRAP}>
                <ScanLine className={`h-5 w-5 ${scanLineIconAnimClass}`} />
              </span>
            </div>
            <form
              className="mt-4 space-y-3"
              onSubmit={(e) => {
                e.preventDefault();
                onWorkspaceScan();
              }}
            >
              <input
                ref={scanWorkspaceRef}
                className={`${SCAN_INPUT} ${lookupBusy ? SCAN_INPUT_SEARCHING : ""}`}
                value={scanWorkspace}
                onChange={(e) => setScanWorkspace(e.target.value)}
                placeholder={topPlaceholder}
                autoComplete="off"
                spellCheck={false}
              />
              <button
                type="submit"
                disabled={
                  scannerBlockedNoOrg ||
                  scannerStoreGateBlocksLookup ||
                  lookupBusy ||
                  !scanWorkspace.trim()
                }
                className={cn(
                  topButtonClass,
                  (scannerBlockedNoOrg || scannerStoreGateBlocksLookup || !scanWorkspace.trim()) &&
                    "cursor-not-allowed opacity-60",
                  lookupBusy && "brightness-90",
                )}
              >
                {lookupBusy ? (
                  <>
                    <Loader2 className="h-5 w-5 shrink-0 text-[#000000] motion-safe:animate-spin" />
                    <span className="text-[#000000]">Searching…</span>
                  </>
                ) : (
                  <>
                    <Search className="h-5 w-5 shrink-0 text-[#000000]" />
                    <span className="text-[#000000]">{topButtonLabel}</span>
                  </>
                )}
              </button>
            </form>
          </div>

          {snapshotWarning && (
            <div className="flex gap-2 rounded-2xl border border-[#D6B46A]/30 bg-[rgba(214,180,106,0.1)] p-3 text-xs text-[#0F172A] shadow-[0_0_16px_rgba(214,180,106,0.15)] dark:border-[#F5C542]/30 dark:bg-[rgba(245,197,66,0.08)] dark:text-[#F8FAFC] dark:shadow-[0_0_20px_rgba(255,215,0,0.1)]">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-[#B8860B] dark:text-[#FFD700]" />
              <span>Picker lists may be incomplete: {snapshotWarning}</span>
            </div>
          )}

          {notice && (
            <div className={`flex items-start gap-2 rounded-2xl border p-3 text-sm ${noticeClass}`}>
              {notice.tone === "success" ? (
                <CheckCircle2 className="h-5 w-5 shrink-0 text-[#B8860B] dark:text-[#FFD700]" />
              ) : notice.tone === "error" ? (
                <XCircle className="h-5 w-5 shrink-0 text-[#DC2626] dark:text-[#F87171]" />
              ) : (
                <AlertCircle className="h-5 w-5 shrink-0 text-[#A67C2C] dark:text-[#D6B46A]" />
              )}
              <span>{notice.message}</span>
            </div>
          )}

          {/* Result reveal — only shown when not yet inside a workspace */}
          {!workspaceView && lookupDone && lane === "new" && newHit && (
            <div
              key={`new-result-${resultRevealKey}`}
              className={`operator-result-reveal rounded-2xl border px-4 py-4 ${
                newHit.kind === "none"
                  ? "border-[#DC2626]/35 bg-[rgba(220,38,38,0.08)] text-[#991B1B] shadow-[0_0_16px_rgba(220,38,38,0.1)] dark:bg-[rgba(220,38,38,0.1)] dark:text-[#FECACA] dark:shadow-[0_0_20px_rgba(220,38,38,0.12)]"
                  : "border-[#D6B46A]/35 bg-[rgba(214,180,106,0.12)] text-[#0F172A] shadow-[0_0_20px_rgba(214,180,106,0.18)] dark:border-[#F5C542]/35 dark:bg-[rgba(245,197,66,0.1)] dark:text-[#F8FAFC] dark:shadow-[0_0_24px_rgba(255,215,0,0.14)]"
              }`}
            >
              <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-[#64748B] dark:text-[#94A3B8]">
                {newHit.kind === "none"
                  ? newHit.expectedLookupError
                    ? "Expected lookup"
                    : "No match"
                  : "Found"}
              </p>
              {newHit.kind !== "none" && detectedLabel && (
                <p className={`mt-1 text-lg font-bold ${TEXT_BODY}`}>{detectedLabel}</p>
              )}
              {newHit.kind === "none" && newHit.expectedLookupError && (
                <p className={`mt-1 text-sm text-[#B91C1C] dark:text-[#FCA5A5]`}>{newHit.expectedLookupError}</p>
              )}
              {newHit.kind === "none" && !newHit.expectedLookupError && (
                <p className={`mt-1 text-sm text-[#B91C1C] dark:text-[#FCA5A5]`}>
                  {"expectedPackagesDiagnostics" in newHit && newHit.expectedPackagesDiagnostics
                    ? "No expected inbound match — query diagnostics below."
                    : "Unknown scan — choose a type below."}
                </p>
              )}
            </div>
          )}

          {!workspaceView &&
            lookupDone &&
            lane === "new" &&
            newHit &&
            newHit.kind === "none" &&
            "expectedPackagesDiagnostics" in newHit &&
            newHit.expectedPackagesDiagnostics && (
              <div
                className="operator-result-reveal rounded-2xl border border-[#B45309]/45 bg-[rgba(180,83,9,0.06)] p-4 font-mono text-[10px] leading-relaxed text-[#0F172A] dark:border-[#FBBF24]/35 dark:bg-[rgba(251,191,36,0.08)] dark:text-[#E2E8F0]"
                aria-label="expected_packages lookup failure diagnostics"
              >
                <p className="mb-3 font-sans text-[11px] font-bold uppercase tracking-wide text-[#B45309] dark:text-[#FBBF24]">
                  expected_packages lookup diagnostics
                </p>
                {newHit.expectedPackagesDiagnostics.diagnosticHints.length > 0 ? (
                  <ul className="mb-4 list-inside list-disc space-y-1 rounded-lg border border-[#B45309]/40 bg-[rgba(180,83,9,0.12)] px-3 py-2 font-sans text-[11px] font-semibold text-[#92400E] dark:border-[#FBBF24]/35 dark:bg-[rgba(251,191,36,0.12)] dark:text-[#FDE68A]">
                    {newHit.expectedPackagesDiagnostics.diagnosticHints.map((h) => (
                      <li key={h}>{h}</li>
                    ))}
                  </ul>
                ) : null}
                <dl className="space-y-3">
                  <div>
                    <dt className="text-[#64748B] dark:text-[#94A3B8]">Scan context — scanned (raw)</dt>
                    <dd className="break-all text-[#0F172A] dark:text-[#F8FAFC]">
                      {JSON.stringify(newHit.expectedPackagesDiagnostics.scannedRaw)}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-[#64748B] dark:text-[#94A3B8]">Scan context — normalized</dt>
                    <dd className="break-all text-[#0F172A] dark:text-[#F8FAFC]">
                      {JSON.stringify(newHit.expectedPackagesDiagnostics.normalized)}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-[#64748B] dark:text-[#94A3B8]">effectiveOrganizationId</dt>
                    <dd className="break-all text-[#0F172A] dark:text-[#F8FAFC]">
                      {newHit.expectedPackagesDiagnostics.effectiveOrganizationId || "(empty)"}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-[#64748B] dark:text-[#94A3B8]">selected/auto store_id</dt>
                    <dd className="break-all text-[#0F172A] dark:text-[#F8FAFC]">
                      {newHit.expectedPackagesDiagnostics.selectedStoreIdUsed || "(empty)"}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-[#64748B] dark:text-[#94A3B8]">active stores loaded / selected name</dt>
                    <dd className="text-[#0F172A] dark:text-[#F8FAFC]">
                      {newHit.expectedPackagesDiagnostics.activeStoresLoadedCount} —{" "}
                      {newHit.expectedPackagesDiagnostics.selectedStoreName}
                    </dd>
                  </div>

                  <div>
                    <dt className="font-semibold text-[#64748B] dark:text-[#94A3B8]">
                      1. No organization filter — select columns, limit 5 (read-only)
                    </dt>
                    <dd className="mt-1 text-[#0F172A] dark:text-[#F8FAFC]">
                      <span className="text-[#64748B] dark:text-[#94A3B8]">exact count (client-visible): </span>
                      {newHit.expectedPackagesDiagnostics.queryNoFilterExactError ? (
                        <span className="text-[#DC2626] dark:text-[#FCA5A5]">
                          error: {newHit.expectedPackagesDiagnostics.queryNoFilterExactError}
                        </span>
                      ) : (
                        <>{String(newHit.expectedPackagesDiagnostics.queryNoFilterExactCount)}</>
                      )}
                    </dd>
                    <dd className="mt-1">
                      <span className="text-[#64748B] dark:text-[#94A3B8]">sample query error: </span>
                      {newHit.expectedPackagesDiagnostics.queryNoFilterSampleError ? (
                        <span className="text-[#DC2626] dark:text-[#FCA5A5]">
                          {newHit.expectedPackagesDiagnostics.queryNoFilterSampleError}
                        </span>
                      ) : (
                        <span className="text-[#0F172A] dark:text-[#F8FAFC]">none</span>
                      )}
                    </dd>
                    <dd className="mt-1">
                      <span className="text-[#64748B] dark:text-[#94A3B8]">rows returned (max 5): </span>
                      {newHit.expectedPackagesDiagnostics.queryNoFilterSampleRows.length}
                    </dd>
                    <ul className="mt-1 space-y-1 break-all pl-2 text-[#0F172A] dark:text-[#F8FAFC]">
                      {newHit.expectedPackagesDiagnostics.queryNoFilterSampleRows.length === 0 ? (
                        <li className="text-[#B45309] dark:text-[#FBBF24]">(no rows)</li>
                      ) : (
                        newHit.expectedPackagesDiagnostics.queryNoFilterSampleRows.map((r, i) => (
                          <li key={i}>
                            tracking_number={JSON.stringify(r.tracking_number ?? null)}, allocation_box_code=
                            {JSON.stringify(r.allocation_box_code ?? null)}, store_id=
                            {JSON.stringify(r.store_id ?? null)}, organization_id=
                            {JSON.stringify(r.organization_id ?? null)}
                          </li>
                        ))
                      )}
                    </ul>
                  </div>

                  <div>
                    <dt className="font-semibold text-[#64748B] dark:text-[#94A3B8]">
                      2. Filter organization_id only — exact count + limit 5 sample
                    </dt>
                    <dd className="mt-1">
                      <span className="text-[#64748B] dark:text-[#94A3B8]">count error: </span>
                      {newHit.expectedPackagesDiagnostics.queryOrgOnlyExactError ? (
                        <span className="text-[#DC2626] dark:text-[#FCA5A5]">
                          {newHit.expectedPackagesDiagnostics.queryOrgOnlyExactError}
                        </span>
                      ) : (
                        <span className="text-[#0F172A] dark:text-[#F8FAFC]">none</span>
                      )}
                    </dd>
                    <dd className="mt-1 text-[#0F172A] dark:text-[#F8FAFC]">
                      <span className="text-[#64748B] dark:text-[#94A3B8]">count: </span>
                      {newHit.expectedPackagesDiagnostics.queryOrgOnlyExactError
                        ? "—"
                        : String(newHit.expectedPackagesDiagnostics.queryOrgOnlyExactCount)}
                    </dd>
                    <dd className="mt-1">
                      <span className="text-[#64748B] dark:text-[#94A3B8]">sample error: </span>
                      {newHit.expectedPackagesDiagnostics.queryOrgOnlySampleError ? (
                        <span className="text-[#DC2626] dark:text-[#FCA5A5]">
                          {newHit.expectedPackagesDiagnostics.queryOrgOnlySampleError}
                        </span>
                      ) : (
                        <span className="text-[#0F172A] dark:text-[#F8FAFC]">none</span>
                      )}
                    </dd>
                    <ul className="mt-1 space-y-1 break-all pl-2 text-[#0F172A] dark:text-[#F8FAFC]">
                      {newHit.expectedPackagesDiagnostics.queryOrgOnlySampleRows.length === 0 ? (
                        <li className="text-[#B45309] dark:text-[#FBBF24]">(no rows)</li>
                      ) : (
                        newHit.expectedPackagesDiagnostics.queryOrgOnlySampleRows.map((r, i) => (
                          <li key={i}>
                            tracking_number={JSON.stringify(r.tracking_number ?? null)}, allocation_box_code=
                            {JSON.stringify(r.allocation_box_code ?? null)}, store_id=
                            {JSON.stringify(r.store_id ?? null)}, organization_id=
                            {JSON.stringify(r.organization_id ?? null)}
                          </li>
                        ))
                      )}
                    </ul>
                  </div>

                  <div>
                    <dt className="font-semibold text-[#64748B] dark:text-[#94A3B8]">
                      3. Filter store_id only — exact count
                    </dt>
                    <dd className="mt-1 text-[#0F172A] dark:text-[#F8FAFC]">
                      {newHit.expectedPackagesDiagnostics.queryStoreOnlySkippedReason ? (
                        <span className="text-[#B45309] dark:text-[#FBBF24]">
                          {newHit.expectedPackagesDiagnostics.queryStoreOnlySkippedReason}
                        </span>
                      ) : newHit.expectedPackagesDiagnostics.queryStoreOnlyExactError ? (
                        <span className="text-[#DC2626] dark:text-[#FCA5A5]">
                          error: {newHit.expectedPackagesDiagnostics.queryStoreOnlyExactError}
                        </span>
                      ) : (
                        <>count = {String(newHit.expectedPackagesDiagnostics.queryStoreOnlyExactCount)}</>
                      )}
                    </dd>
                  </div>

                  <div>
                    <dt className="font-semibold text-[#64748B] dark:text-[#94A3B8]">
                      4. `.eq(organization_id)` + `.eq(store_id)` — exact count
                    </dt>
                    <dd className="mt-1 text-[#0F172A] dark:text-[#F8FAFC]">
                      {newHit.expectedPackagesDiagnostics.queryOrgAndStoreSkippedReason ? (
                        <span className="text-[#B45309] dark:text-[#FBBF24]">
                          {newHit.expectedPackagesDiagnostics.queryOrgAndStoreSkippedReason}
                        </span>
                      ) : newHit.expectedPackagesDiagnostics.queryOrgAndStoreExactError ? (
                        <span className="text-[#DC2626] dark:text-[#FCA5A5]">
                          error: {newHit.expectedPackagesDiagnostics.queryOrgAndStoreExactError}
                        </span>
                      ) : (
                        <>count = {String(newHit.expectedPackagesDiagnostics.queryOrgAndStoreExactCount)}</>
                      )}
                    </dd>
                  </div>

                  <div>
                    <dt className="font-semibold text-[#64748B] dark:text-[#94A3B8]">
                      5. Strict match — organization_id + store_id + tracking_number (normalized)
                    </dt>
                    <dd className="mt-1 text-[#0F172A] dark:text-[#F8FAFC]">
                      {newHit.expectedPackagesDiagnostics.strictTrackingError ? (
                        <span className="text-[#DC2626] dark:text-[#FCA5A5]">
                          {newHit.expectedPackagesDiagnostics.strictTrackingError}
                        </span>
                      ) : (
                        <>rows matched (limit 5) = {newHit.expectedPackagesDiagnostics.strictTrackingRowCount}</>
                      )}
                    </dd>
                  </div>
                </dl>
              </div>
            )}

          {debugPanelsEnabled &&
            !workspaceView &&
            lookupDone &&
            lane === "new" &&
            expectedLookupDebug && (
              <div
                className="rounded-xl border border-dashed border-[#64748B]/50 bg-[rgba(15,23,42,0.04)] p-3 font-mono text-[10px] leading-relaxed text-[#334155] dark:border-[#94A3B8]/40 dark:bg-[rgba(2,6,23,0.85)] dark:text-[#CBD5E1]"
                aria-label="Development-only expected_packages lookup debug"
              >
                <p className="mb-2 font-sans text-[11px] font-bold uppercase tracking-wide text-[#64748B] dark:text-[#94A3B8]">
                  Dev — expected_packages lookup
                </p>
                <dl className="space-y-1">
                  <div>
                    <dt className="inline text-[#64748B] dark:text-[#94A3B8]">scanned (raw):</dt>{" "}
                    <dd className="inline break-all">{JSON.stringify(expectedLookupDebug.rawInput)}</dd>
                  </div>
                  <div>
                    <dt className="inline text-[#64748B] dark:text-[#94A3B8]">normalized:</dt>{" "}
                    <dd className="inline break-all">{JSON.stringify(expectedLookupDebug.normalized)}</dd>
                  </div>
                  <div>
                    <dt className="inline text-[#64748B] dark:text-[#94A3B8]">effectiveOrganizationId:</dt>{" "}
                    <dd className="inline break-all">{expectedLookupDebug.effectiveOrganizationId || "(empty)"}</dd>
                  </div>
                  <div>
                    <dt className="inline text-[#64748B] dark:text-[#94A3B8]">select() columns:</dt>{" "}
                    <dd className="inline break-all">{expectedLookupDebug.selectListUsed}</dd>
                  </div>
                  <div>
                    <dt className="inline text-[#64748B] dark:text-[#94A3B8]">broad sample query:</dt>{" "}
                    <dd className="inline">
                      {expectedLookupDebug.broadSample.status}
                      {expectedLookupDebug.broadSample.status === "ok"
                        ? ` — ${expectedLookupDebug.broadSample.rowCount} row(s)`
                        : ""}
                      {expectedLookupDebug.broadSample.errorMessage
                        ? ` — error: ${expectedLookupDebug.broadSample.errorMessage}`
                        : ""}
                    </dd>
                  </div>
                  {expectedLookupDebug.broadSample.status === "ok" &&
                    expectedLookupDebug.zeroRowsVisibleForOrg && (
                      <p className="font-sans text-[11px] font-medium text-[#B45309] dark:text-[#FBBF24]">
                        No expected_packages rows visible for this organization. Check organization_id / RLS.
                      </p>
                    )}
                  <div>
                    <dt className="inline text-[#64748B] dark:text-[#94A3B8]">Normalized match in sample (first 5):</dt>{" "}
                    <dd className="inline font-semibold">
                      {expectedLookupDebug.normalizedMatchInSample ? "yes" : "no"}
                    </dd>
                  </div>
                  {expectedLookupDebug.mainSteps.length > 0 && (
                    <div>
                      <dt className="mb-0.5 block text-[#64748B] dark:text-[#94A3B8]">Main lookup steps:</dt>
                      <dd>
                        <ul className="list-inside list-disc space-y-0.5 pl-1">
                          {expectedLookupDebug.mainSteps.map((s) => (
                            <li key={s.step}>
                              {s.step}: {s.status}, rows={s.rowCount}
                              {s.errorMessage ? ` — ${s.errorMessage}` : ""}
                            </li>
                          ))}
                        </ul>
                      </dd>
                    </div>
                  )}
                </dl>
              </div>
            )}

          {!workspaceView && lookupDone && lane === "continue" && (
            <div
              key={`continue-result-${resultRevealKey}`}
              className={`operator-result-reveal rounded-2xl border px-4 py-4 ${
                continueHit
                  ? "border-[#D6B46A]/35 bg-[rgba(214,180,106,0.12)] text-[#0F172A] shadow-[0_0_20px_rgba(214,180,106,0.18)] dark:border-[#F5C542]/35 dark:bg-[rgba(245,197,66,0.1)] dark:text-[#F8FAFC] dark:shadow-[0_0_24px_rgba(255,215,0,0.14)]"
                  : "border-[#DC2626]/35 bg-[rgba(220,38,38,0.08)] text-[#991B1B] shadow-[0_0_16px_rgba(220,38,38,0.1)] dark:bg-[rgba(220,38,38,0.1)] dark:text-[#FECACA] dark:shadow-[0_0_20px_rgba(220,38,38,0.12)]"
              }`}
            >
              <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-[#64748B] dark:text-[#94A3B8]">
                {continueHit ? "Found" : "No match"}
              </p>
              {continueHit && detectedLabel && (
                <p className={`mt-1 text-lg font-bold ${TEXT_BODY}`}>{detectedLabel}</p>
              )}
              {!continueHit && (
                <p className="mt-1 text-sm text-[#B91C1C] dark:text-[#FCA5A5]">No open pallet, package, or item for this scan.</p>
              )}
            </div>
          )}

          {/* Expected-inbound preview (new lane, before save) */}
          {!workspaceView && lane === "new" && lookupDone && newHit?.kind === "expected" && (
            <div key={`expected-${resultRevealKey}`} className="operator-result-reveal space-y-3">
              <ExpectedInboundCard row={newHit.row} />
              <button
                type="button"
                disabled={busy || storesLoading}
                className={BTN_LOOKUP}
                onClick={() => void onCreateInboundPackageFromExpected()}
              >
                {busy ? (
                  <>
                    <Loader2 className="h-5 w-5 shrink-0 text-[#000000] motion-safe:animate-spin" />
                    <span className="text-[#000000]">Creating…</span>
                  </>
                ) : (
                  <>
                    <Package className="h-5 w-5 shrink-0 text-[#000000]" />
                    <span className="text-[#000000]">Create inbound package</span>
                  </>
                )}
              </button>
            </div>
          )}

          {/* Create-as buttons (new lane no-match) */}
          {!workspaceView && lane === "new" && lookupDone && newHit?.kind === "none" && (
            <div className="space-y-3 rounded-2xl border border-[#D6B46A]/28 bg-white p-4 shadow-[0_0_20px_rgba(214,180,106,0.12)] dark:border-[#F5C542]/22 dark:bg-[#0B1220] dark:shadow-[0_0_24px_rgba(255,215,0,0.08)]">
              <p className={`${SECTION_TITLE} text-center`}>What is this?</p>
              <p className={`text-center text-xs ${TEXT_SUBTLE}`}>Creates a real record in your org, then opens the workspace.</p>
              <div className="flex flex-col gap-2">
                <button
                  type="button"
                  disabled={busy}
                  className={BTN_GHOST}
                  onClick={() => void quickCreatePalletFromScan()}
                >
                  <Boxes className="h-5 w-5 text-[#B8860B] dark:text-[#FFD700]" /> Create as Pallet
                </button>
                <button
                  type="button"
                  disabled={busy || storesLoading}
                  className={BTN_GHOST}
                  onClick={() => void quickCreatePackageFromScan()}
                >
                  <Box className="h-5 w-5 text-[#B8860B] dark:text-[#FFD700]" /> Create as Package / Box
                </button>
                <button
                  type="button"
                  disabled={busy || storesLoading}
                  className={BTN_GHOST}
                  onClick={() => void quickCreateLooseItemFromScan()}
                >
                  <Package className="h-5 w-5 text-[#B8860B] dark:text-[#FFD700]" /> Create as Loose Item
                </button>
              </div>
              <p className={`text-center text-[10px] ${TEXT_SUBTLE}`}>Optional</p>
              <div className="flex flex-col gap-2 border-t border-[#D6B46A]/15 pt-3 dark:border-[#F5C542]/12">
                <button type="button" className={BTN_GHOST} onClick={() => beginCreate("pallet", scanWorkspace)}>
                  Detailed pallet form…
                </button>
                <button type="button" className={BTN_GHOST} onClick={() => beginCreate("package", scanWorkspace)}>
                  Detailed package form…
                </button>
                <button type="button" className={BTN_GHOST} onClick={() => beginCreate("item", scanWorkspace)}>
                  Detailed item form…
                </button>
              </div>
            </div>
          )}

          {/* ============================================================ */}
          {/* PALLET WORKSPACE                                              */}
          {/* ============================================================ */}

          {workspaceView?.kind === "pallet" && (
            <section className={CARD}>
              <p className={SECTION_KICKER}>Current pallet</p>
              <p className={`mt-1 text-sm font-medium ${TEXT_SUBTLE}`}>Scan packages / boxes for this pallet</p>
              <div className="mt-2 flex items-center justify-between gap-3">
                <p className={`font-mono text-xl font-bold ${TEXT_BODY}`}>{workspaceView.pallet.pallet_number}</p>
                <span className="rounded-full border border-[#D6B46A]/45 bg-[rgba(214,180,106,0.15)] px-2.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-[#8B6914] shadow-[0_0_8px_rgba(214,180,106,0.2)] dark:border-[#F5C542]/50 dark:bg-[rgba(245,197,66,0.12)] dark:text-[#FFD700] dark:shadow-[0_0_12px_rgba(255,215,0,0.2)]">
                  {workspaceView.pallet.status}
                </span>
              </div>
              <dl className="mt-3 grid grid-cols-2 gap-3 text-sm">
                <div>
                  <dt className={LABEL}>Tracking</dt>
                  <dd className={`truncate font-mono ${TEXT_BODY}`}>
                    {workspaceView.pallet.tracking_number ?? "—"}
                  </dd>
                </div>
                <div>
                  <dt className={LABEL}>Carrier</dt>
                  <dd className={`truncate ${TEXT_BODY}`}>{workspaceView.pallet.carrier_name ?? "—"}</dd>
                </div>
                <div>
                  <dt className={LABEL}>Order</dt>
                  <dd className={`truncate font-mono text-xs ${TEXT_SUBTLE}`}>
                    {workspaceView.pallet.amazon_order_id ?? "—"}
                  </dd>
                </div>
                <div>
                  <dt className={LABEL}>Packages</dt>
                  <dd className={`font-semibold ${TEXT_BODY}`}>{childPackagesForCurrentPallet.length}</dd>
                </div>
              </dl>

              <button
                type="button"
                className={`${BTN_GHOST} mt-3 text-xs`}
                onClick={() => {
                  hydratePalletFromRow(workspaceView.pallet);
                  setSaveMode("edit");
                  setWorkspaceView(null);
                  setActiveForm("pallet");
                  setTimeout(() => scanWorkspaceRef.current?.focus(), 0);
                }}
              >
                Edit pallet details (carrier, store, notes)…
              </button>

              <div className="mt-5">
                <p className={SECTION_KICKER}>Packages on this pallet</p>
                {childPackagesForCurrentPallet.length === 0 ? (
                  <div className={`mt-2 ${PLACEHOLDER_BOX}`}>
                    <span className={TEXT_MUTED}>No packages yet — scan above to add.</span>
                  </div>
                ) : (
                  <ul className="mt-3 space-y-2">
                    {childPackagesForCurrentPallet.map((p) => (
                      <li
                        key={p.id}
                        className="flex items-center justify-between gap-3 rounded-xl border border-[#D6B46A]/22 bg-[#FFFBF5] p-3 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.5)] dark:border-[#F5C542]/16 dark:bg-[#08111F] dark:shadow-[inset_0_0_0_1px_rgba(245,197,66,0.04)]"
                      >
                        <div className="min-w-0">
                          <p className={`truncate font-mono text-sm font-semibold ${TEXT_BODY}`}>
                            {p.package_number}
                          </p>
                          <p className={`mt-0.5 truncate text-[11px] ${TEXT_SUBTLE}`}>
                            {p.tracking_number ?? "no tracking"} · {p.actual_item_count ?? 0}/{p.expected_item_count ?? 0} items
                          </p>
                        </div>
                        <button
                          type="button"
                          className={BTN_PILL_GOLD}
                          onClick={() => openPackageWorkspace(p)}
                        >
                          Scan items <ChevronRight className="h-3.5 w-3.5" />
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </section>
          )}

          {/* ============================================================ */}
          {/* PACKAGE WORKSPACE                                             */}
          {/* ============================================================ */}

          {workspaceView?.kind === "package" && (
            <section className={CARD}>
              <div className="flex items-center justify-between gap-2">
                <p className={SECTION_KICKER}>Current package</p>
                {workspaceView.pallet ? (
                  <button type="button" className={BTN_PILL_GOLD} onClick={backToPalletWorkspace}>
                    <ArrowLeft className="h-3.5 w-3.5" /> Back to pallet
                  </button>
                ) : null}
              </div>

              <div className="mt-3 space-y-2">
                {workspaceView.pallet ? (
                  <ParentChip
                    kicker="Parent pallet"
                    title={workspaceView.pallet.pallet_number}
                    subtitle={workspaceView.pallet.tracking_number ?? null}
                  />
                ) : (
                  <div className="rounded-xl border border-dashed border-[#D6B46A]/40 bg-[#FFFBF5] px-3 py-2 text-xs text-[#8B6914] dark:border-[#D6B46A]/35 dark:bg-[#08111F] dark:text-[#D6B46A]">
                    No pallet parent
                  </div>
                )}
                <div className="rounded-xl border border-[#D6B46A]/35 bg-white px-3 py-3 shadow-[0_0_16px_rgba(214,180,106,0.12)] dark:border-[#F5C542]/40 dark:bg-[#08111F] dark:shadow-[0_0_20px_rgba(255,215,0,0.1)]">
                  <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-[#B8860B] dark:text-[#FFD700]">Package</p>
                  <p className={`mt-0.5 font-mono text-base font-bold ${TEXT_BODY}`}>
                    {workspaceView.pkg.package_number}
                  </p>
                  <p className={`mt-0.5 text-[11px] ${TEXT_SUBTLE}`}>
                    {workspaceView.pkg.tracking_number ?? "no tracking"} · expected {workspaceView.pkg.expected_item_count ?? 0}
                  </p>
                </div>
              </div>

              <button
                type="button"
                className={`${BTN_GHOST} mt-3 w-full text-xs`}
                onClick={() => {
                  hydratePackageFromRow(workspaceView.pkg, workspaceView.pallet);
                  setSaveMode("edit");
                  setWorkspaceView(null);
                  setActiveForm("package");
                  setTimeout(() => scanWorkspaceRef.current?.focus(), 0);
                }}
              >
                Edit package details…
              </button>

              <div className="mt-5">
                <p className={SECTION_KICKER}>Items in this package</p>
                {childItemsForCurrentPackage.length === 0 ? (
                  <div className={`mt-2 ${PLACEHOLDER_BOX}`}>
                    <span className={TEXT_MUTED}>No items yet — scan above to add.</span>
                  </div>
                ) : (
                  <ul className="mt-3 space-y-2">
                    {childItemsForCurrentPackage.map((r, idx) => (
                      <li
                        key={r.id}
                        className={`rounded-xl border p-3 ${
                          idx === 0
                            ? "border-[#D6B46A]/45 bg-[#FFFBF5] shadow-[0_0_14px_rgba(214,180,106,0.2)] dark:border-[#F5C542]/50 dark:bg-[#08111F] dark:shadow-[0_0_18px_rgba(255,215,0,0.12)]"
                            : "border-[#D6B46A]/20 bg-[#FFFBF5] dark:border-[#F5C542]/14 dark:bg-[#08111F]"
                        }`}
                      >
                        <div className="flex items-center justify-between gap-3">
                          <div className="min-w-0">
                            <p className={`truncate text-sm font-semibold ${TEXT_BODY}`}>
                              {r.item_name || r.lpn || r.product_identifier || "Item"}
                            </p>
                            <p className={`mt-0.5 truncate font-mono text-[11px] ${TEXT_SUBTLE}`}>
                              {r.lpn ?? r.product_identifier ?? "—"}
                            </p>
                          </div>
                          {idx === 0 && (
                            <span className="rounded-full border border-[#D6B46A]/50 bg-[rgba(214,180,106,0.18)] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-[#8B6914] shadow-[0_0_6px_rgba(214,180,106,0.25)] dark:border-[#FFD700]/55 dark:bg-[rgba(255,215,0,0.12)] dark:text-[#FFD700] dark:shadow-[0_0_10px_rgba(255,215,0,0.25)]">
                              Last
                            </span>
                          )}
                        </div>
                        {r.conditions && r.conditions.length > 0 ? (
                          <p className={`mt-1 text-[11px] ${TEXT_SUBTLE}`}>
                            {r.conditions.join(" · ")}
                          </p>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </section>
          )}

          {/* ============================================================ */}
          {/* LOOSE-ITEM WORKSPACE                                          */}
          {/* ============================================================ */}

          {workspaceView?.kind === "loose-item" && (
            <section className={CARD}>
              <p className={SECTION_KICKER}>Loose item — no pallet / package parent</p>
              <p className={`mt-2 text-base font-bold ${TEXT_BODY}`}>
                {workspaceView.item.item_name || workspaceView.item.lpn || "Item"}
              </p>
              <dl className="mt-3 grid grid-cols-2 gap-3 text-sm">
                <div>
                  <dt className={LABEL}>LPN</dt>
                  <dd className={`truncate font-mono ${TEXT_BODY}`}>{workspaceView.item.lpn ?? "—"}</dd>
                </div>
                <div>
                  <dt className={LABEL}>ASIN</dt>
                  <dd className={`truncate font-mono ${TEXT_BODY}`}>{workspaceView.item.asin ?? "—"}</dd>
                </div>
                <div>
                  <dt className={LABEL}>SKU</dt>
                  <dd className={`truncate font-mono ${TEXT_BODY}`}>{workspaceView.item.sku ?? "—"}</dd>
                </div>
                <div>
                  <dt className={LABEL}>Status</dt>
                  <dd className={`truncate ${TEXT_BODY}`}>{workspaceView.item.status ?? "—"}</dd>
                </div>
              </dl>
              <button
                type="button"
                className={`${BTN_GHOST} mt-3 w-full text-xs`}
                onClick={() => {
                  hydrateItemFromRow(workspaceView.item);
                  setSaveMode("edit");
                  setWorkspaceView(null);
                  setActiveForm("item");
                  setTimeout(() => scanWorkspaceRef.current?.focus(), 0);
                }}
              >
                Edit item details…
              </button>
              <button type="button" className={`${BTN_GHOST} mt-4`} onClick={exitWorkspace}>
                Done — start another scan
              </button>
            </section>
          )}

          {/* ============================================================ */}
          {/* COMPACT FORMS (only shown when no workspaceView yet)          */}
          {/* ============================================================ */}

          {!workspaceView && activeForm === "pallet" && (
            <form onSubmit={onSavePallet} className={FORM_CARD}>
              <h3 className={SECTION_TITLE}>Pallet</h3>
              <div>
                <label className={LABEL}>Tracking / pallet #</label>
                <input
                  className={INPUT_PLACEHOLDER_TRACKING}
                  value={pltTracking}
                  onChange={(e) => setPltTracking(e.target.value)}
                  placeholder={SCAN_PLACEHOLDER_TRACKING}
                />
              </div>
              <div>
                <label className={LABEL}>Carrier</label>
                <select className={INPUT} value={pltCarrier} onChange={(e) => setPltCarrier(e.target.value)}>
                  {CARRIERS.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className={LABEL}>Amazon Order ID</label>
                <input
                  className={INPUT}
                  value={pltAmazonOrder}
                  onChange={(e) => setPltAmazonOrder(e.target.value)}
                  placeholder="Optional"
                />
              </div>
              <div>
                <label className={LABEL}>Store</label>
                <select
                  className={INPUT}
                  value={pltStoreId}
                  onChange={(e) => setPltStoreId(e.target.value)}
                  disabled={storesLoading}
                >
                  <option value="">{storesLoading ? "Loading…" : "Select store"}</option>
                  {storesForOrg.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name} ({s.platform})
                    </option>
                  ))}
                </select>
                {storesError && <p className="mt-1 text-xs text-[#F87171]">{storesError}</p>}
              </div>
              <div>
                <label className={LABEL}>Operator counted packages / boxes</label>
                <input
                  className={INPUT}
                  type="number"
                  min={0}
                  value={pltCountedBoxes}
                  onChange={(e) => setPltCountedBoxes(e.target.value)}
                  placeholder="Local count (not persisted yet)"
                />
                <p className={`mt-1 text-[11px] ${TEXT_SUBTLE}`}>Local only until mapped on pallet row.</p>
              </div>
              <PhotoSlot label="Pallet photo" hint="Placeholder — use Returns for uploads" />
              <PhotoSlot label="Bill of Lading" hint="Placeholder — use Returns for uploads" />
              <div>
                <label className={LABEL}>Notes</label>
                <textarea
                  className={`${INPUT} min-h-[5rem] py-3`}
                  value={pltNotes}
                  onChange={(e) => setPltNotes(e.target.value)}
                  rows={3}
                />
              </div>
              <button type="submit" disabled={busy} className={BTN_LOOKUP}>
                {saveMode === "edit" ? "Save pallet" : "Create pallet"}
              </button>
            </form>
          )}

          {!workspaceView && activeForm === "package" && (
            <form onSubmit={onSavePackage} className={FORM_CARD}>
              <h3 className={SECTION_TITLE}>Package / Box</h3>
              <div>
                <label className={LABEL}>Link to pallet (optional)</label>
                <select
                  className={INPUT}
                  value={pkgPalletId}
                  onChange={(e) => setPkgPalletId(e.target.value)}
                >
                  <option value="">— None —</option>
                  {openPalletOptions.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.pallet_number}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className={LABEL}>Package #</label>
                <input
                  className={INPUT}
                  value={pkgNumber}
                  onChange={(e) => setPkgNumber(e.target.value)}
                  readOnly={saveMode === "edit"}
                  title={
                    saveMode === "edit"
                      ? "Package # is fixed after create — change in Returns if required."
                      : undefined
                  }
                />
              </div>
              <div>
                <label className={LABEL}>Tracking #</label>
                <input
                  className={INPUT}
                  value={pkgTracking}
                  onChange={(e) => setPkgTracking(e.target.value)}
                  placeholder="Unique per org"
                />
              </div>
              <div>
                <label className={LABEL}>Carrier</label>
                <select className={INPUT} value={pkgCarrier} onChange={(e) => setPkgCarrier(e.target.value)}>
                  <option value="">Select…</option>
                  {CARRIERS.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className={LABEL}>RMA</label>
                <input className={INPUT} value={pkgRma} onChange={(e) => setPkgRma(e.target.value)} />
              </div>
              <div>
                <label className={LABEL}>Amazon Order ID</label>
                <input
                  className={INPUT}
                  value={pkgAmazonOrder}
                  onChange={(e) => setPkgAmazonOrder(e.target.value)}
                  placeholder="Saved as package order_id"
                />
              </div>
              <div>
                <label className={LABEL}>Expected items</label>
                <input
                  className={INPUT}
                  type="number"
                  min={0}
                  value={pkgExpected}
                  onChange={(e) => setPkgExpected(e.target.value)}
                />
              </div>
              <div>
                <label className={LABEL}>Store</label>
                <select
                  className={INPUT}
                  value={pkgStoreId}
                  onChange={(e) => setPkgStoreId(e.target.value)}
                  disabled={storesLoading}
                >
                  <option value="">{storesLoading ? "Loading…" : "Select store"}</option>
                  {storesForOrg.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
                {storesError && <p className="mt-1 text-xs text-[#F87171]">{storesError}</p>}
              </div>
              <PhotoSlot label="Packing slip OCR" hint="Placeholder — enable in Returns" />
              <PhotoSlot label="Shipping label" hint="Placeholder" />
              <PhotoSlot label="Outer box" hint="Placeholder" />
              <PhotoSlot label="Inside content" hint="Placeholder" />
              <PhotoSlot label="Sealed box" hint="Placeholder" />
              <button type="submit" disabled={busy} className={BTN_LOOKUP}>
                {saveMode === "edit" ? "Save package" : "Create package"}
              </button>
            </form>
          )}

          {!workspaceView && activeForm === "item" && (
            <form onSubmit={onSaveItem} className={FORM_CARD}>
              <h3 className={SECTION_TITLE}>Item</h3>
              <div>
                <label className={LABEL}>Assign to package (optional)</label>
                <select
                  className={INPUT}
                  value={itemPackageId}
                  onChange={(e) => setItemPackageId(e.target.value)}
                >
                  <option value="">— Loose —</option>
                  {openPackages.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.package_number} · {p.tracking_number ?? "no tracking"}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className={LABEL}>Product barcode</label>
                <input
                  className={INPUT}
                  value={itemProductCode}
                  onChange={(e) => setItemProductCode(e.target.value)}
                  placeholder="Maps to ASIN on save if ASIN empty"
                />
              </div>
              <div>
                <label className={LABEL}>Return label / LPN</label>
                <input className={INPUT} value={itemLpn} onChange={(e) => setItemLpn(e.target.value)} />
              </div>
              <div>
                <label className={LABEL}>RMA</label>
                <input className={INPUT} value={itemRma} onChange={(e) => setItemRma(e.target.value)} />
              </div>
              <div>
                <label className={LABEL}>Store</label>
                <select
                  className={INPUT}
                  value={itemStoreId}
                  onChange={(e) => setItemStoreId(e.target.value)}
                  disabled={storesLoading}
                >
                  <option value="">{storesLoading ? "Loading…" : "Select store"}</option>
                  {storesForOrg.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
                {storesError && <p className="mt-1 text-xs text-[#F87171]">{storesError}</p>}
              </div>
              <div>
                <label className={LABEL}>Item name</label>
                <input className={INPUT} value={itemName} onChange={(e) => setItemName(e.target.value)} />
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <div>
                  <label className={LABEL}>ASIN</label>
                  <input className={INPUT_SM} value={itemAsin} onChange={(e) => setItemAsin(e.target.value)} />
                </div>
                <div>
                  <label className={LABEL}>FNSKU</label>
                  <input className={INPUT_SM} value={itemFnsku} onChange={(e) => setItemFnsku(e.target.value)} />
                </div>
                <div>
                  <label className={LABEL}>SKU</label>
                  <input className={INPUT_SM} value={itemSku} onChange={(e) => setItemSku(e.target.value)} />
                </div>
              </div>
              <div>
                <label className={LABEL}>Issues</label>
                <div className="flex flex-wrap gap-2">
                  {ISSUE_CHIPS.map((c) => {
                    const active = itemConditionKeys.includes(c.key);
                    const dis = chipDisabledForConditions(c.key, itemConditionKeys);
                    return (
                      <button
                        key={c.key}
                        type="button"
                        disabled={dis}
                        onClick={() => setItemConditionKeys((prev) => toggleConditionKey(prev, c.key))}
                        className={`rounded-full border px-3 py-1.5 text-xs font-semibold transition ${
                          active
                            ? "border-[#D6B46A] bg-[rgba(214,180,106,0.22)] text-[#0F172A] shadow-[0_0_10px_rgba(214,180,106,0.2)] dark:border-[#FFD700]/60 dark:bg-[rgba(255,215,0,0.14)] dark:text-[#FFD700] dark:shadow-[0_0_14px_rgba(255,215,0,0.2)]"
                            : "border-[#CBD5E1] bg-white text-[#475569] hover:border-[#D6B46A]/45 hover:shadow-[0_0_8px_rgba(214,180,106,0.12)] dark:border-[#F5C542]/18 dark:bg-[#08111F] dark:text-[#94A3B8] dark:hover:border-[#F5C542]/45 dark:hover:shadow-[0_0_12px_rgba(245,197,66,0.12)]"
                        } ${dis ? "opacity-40" : ""}`}
                      >
                        {c.label}
                      </button>
                    );
                  })}
                </div>
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <label className={LABEL}>Expiry date</label>
                  <input
                    className={INPUT}
                    type="date"
                    value={itemExpiry}
                    onChange={(e) => setItemExpiry(e.target.value)}
                  />
                </div>
                <div>
                  <label className={LABEL}>Batch / Lot</label>
                  <input className={INPUT} value={itemBatch} onChange={(e) => setItemBatch(e.target.value)} />
                </div>
              </div>
              <div>
                <label className={LABEL}>Comments</label>
                <textarea
                  className={`${INPUT} min-h-[4rem]`}
                  value={itemNotes}
                  onChange={(e) => setItemNotes(e.target.value)}
                  rows={3}
                />
              </div>
              <button type="submit" disabled={busy} className={BTN_LOOKUP}>
                {saveMode === "edit" ? "Save item" : "Create item"}
              </button>
            </form>
          )}
        </main>
      </div>
    </>
  );
}
