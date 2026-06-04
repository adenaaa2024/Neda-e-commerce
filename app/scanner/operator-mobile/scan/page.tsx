"use client";

import {
  Component,
  Suspense,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type CSSProperties,
  type FormEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { createPortal } from "react-dom";
import {
  AlertTriangle,
  ArrowLeft,
  Barcode,
  Calendar,
  Camera,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Circle,
  ClipboardList,
  Info,
  Lock,
  Loader2,
  Package,
  Package2,
  PackageOpen,
  Pencil,
  Plus,
  Puzzle,
  Save,
  ScanLine,
  Search,
  Sparkles,
  ThumbsUp,
  Trash2,
  Truck,
  Warehouse,
  X,
} from "lucide-react";
import { isSupabaseConfigured, supabase } from "@/src/lib/supabase";
import {
  mockResolveOperatorBarcode,
  resolveOperatorBarcode,
  type OperatorResolveKind,
  type OperatorResolveResult,
} from "@/lib/scanner/operator-resolve-barcode";
import {
  fetchExpectedPackageDetailRowsByIds,
  fetchExpectedPackageDetailRowsForParent,
  isLikelyShipmentTrackingCode,
  loadPalletExpectationSnapshot,
  loadTrackingExpectationSnapshot,
  mockExpectedPackageDetailRows,
  mockPalletExpectationSnapshot,
  mockTrackingExpectationSnapshot,
  remergeTrackingOperatorLineScannedQty,
  scannedCountMapsFromOperatorPackageHydratedRows,
  type TrackingExpectationTotals,
  type TrackingOperatorLine,
} from "@/lib/scanner/operator-tracking-expectations";
import { scannerProductResolutionBadges } from "@/lib/scanner/product-resolution-badges";
import {
  isShipmentEntryOffManifest,
  lookupShipmentEntryScanCode,
  mockLookupShipmentEntryScanCode,
  type ShipmentEntryLookupResult,
} from "@/lib/scanner/shipment-entry-lookup";
import {
  aggregateInventoryStatus,
  deriveInventoryGateVisualStatus,
  fetchVInventoryItemStatusLinesForTrackingNormalized,
  fetchVInventoryItemStatusLinesExact,
  formatInventoryProgressLabel,
  mockVInventoryItemStatusLinesForExact,
  resolveInventoryGateVisualStatus,
  safeInventoryProgressPercent,
  type InventoryGateVisualStatus,
  type InventoryViewMatchField,
  type VInventoryStatusRow,
} from "@/lib/scanner/v-inventory-status";
import { resolveItemBarcodeAgainstExpectedRows, type ItemResolveTier } from "@/lib/scanner/operator-item-resolve";
import {
  resolveItemBarcodeAgainstSlipRows,
  type SlipBarcodeMatchRow,
  type SlipItemResolveTier,
} from "@/lib/scanner/operator-slip-item-resolve";
import { mergeReturnPhotoEvidence } from "@/lib/return-photo-evidence";
import {
  nedaQuantityCardSurfaceStyle,
  nedaQuantityProgressColor,
  nedaQuantityRowPresentation,
} from "@/lib/scanner/neda-quantity-color-matrix";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  isPersistableStoredMediaReference,
  normalizePalletDocumentationImageUrls,
} from "@/lib/media-reference";
import { deleteOperatorEvidenceStorageByPublicUrlsAction } from "@/lib/scanner/operator-evidence-storage-delete";
import { isUuidString } from "@/lib/uuid";
import {
  buildPackageManifestRelativePath,
  buildPackagePhotosRelativePath,
  buildPalletBolRelativePath,
  buildPalletPhotosRelativePath,
  buildPalletShippingLabelsRelativePath,
} from "@/lib/storage-helpers";
import { operatorReceiveItem } from "@/app/scanner/operator-mobile/item-actions";
import { allowOperatorUnknownPackageCreate } from "@/lib/scanner/operator-unknown-package";
import {
  commitOperatorPalletShipmentStepAction,
  createOperatorPalletAction,
  fetchOperatorPalletHydrationAction,
  findOperatorPalletByIdAction,
  findOperatorPalletByTrackingNumberAction,
  findOperatorSavedPackageByCodeOrTrackingAction,
  fetchInventoryItemStatusLinesForGateAction,
  fetchGateProductNamesByIdsAction,
  insertOperatorIntakeBoxPackageAction,
  listOperatorPackagesForPalletAction,
  listOperatorSlipContentsForPackageAction,
  listOperatorPackageItemsForPackageAction,
  lookupShipmentEntryScanCodeAction,
  insertOperatorPackageItemAction,
  previewOperatorItemBarcodeLinkageAction,
  previewOperatorSlipLinesIdentifiersLinkageAction,
  updateOperatorIntakeBoxPackageAction,
  saveOperatorSlipVisionAction,
  checkOperatorSlipCodeDuplicateAction,
  getOperatorMobileCorrectionPermissionsAction,
  moveOperatorIntakeBoxToPalletAction,
  voidOperatorIntakeBoxPackageAction,
  voidOperatorIntakePalletAction,
  updateOperatorPackageItemAction,
  reconcileReturnItemsSlipContentsAction,
  deleteOperatorPackageItemAction,
  type DuplicatePackingSlipInfo,
  type OperatorPackageItemRow,
  type OperatorPackageListRow,
  type OperatorSlipContentsListRow,
  type UpdateOperatorIntakeBoxPackageResult,
} from "@/app/scanner/operator-mobile/_components/operator-store-actions";
import {
  ItemUnitRecordModal,
  type ItemUnitRecordModalInitialState,
  type ItemUnitRecordSavePayload,
  type ItemUnitRecordSaveResult,
} from "@/app/scanner/operator-mobile/_components/ItemUnitRecordModal";
import { OperatorProductLinkageMeta } from "@/app/scanner/operator-mobile/_components/OperatorProductLinkageMeta";
import { ProductLinkagePrimaryLink } from "@/app/scanner/operator-mobile/_components/ProductLinkagePrimaryLink";
import {
  buildProductLinkageDisplayContract,
  PRODUCT_LINKAGE_UNMAPPED_LABEL,
  productLinkageIsAmbiguous,
  productLinkageOperatorPrimaryDisplayLabel,
  productLinkagePrimaryLabel,
  type ProductLinkageDisplayContract,
} from "@/lib/scanner/product-linkage-display-contract";
import {
  buildExpectedPackageProductLinkage,
  buildInventoryViewProductLinkage,
  deriveExpectedPackageEffectiveProductId,
  formatScanVarianceLabel,
} from "@/lib/scanner/expected-packages-read-contract";
import { buildOperatorBarcodeResolverFields } from "@/lib/scanner/operator-barcode-preview-input";
import { OperatorCrossStoreScopeBanner } from "@/app/scanner/operator-mobile/_components/OperatorCrossStoreScopeBanner";
import { OperatorDuplicatePackingSlipBanner } from "@/app/scanner/operator-mobile/_components/OperatorDuplicatePackingSlipBanner";
import { OperatorCorrectionActionsPanel } from "@/app/scanner/operator-mobile/_components/OperatorCorrectionActionsPanel";
import { ScannerPhotoActionSheet } from "@/app/scanner/operator-mobile/_components/ScannerPhotoActionSheet";
import { OperatorMoveBoxModal } from "@/app/scanner/operator-mobile/_components/OperatorMoveBoxModal";
import { OperatorVoidBoxModal } from "@/app/scanner/operator-mobile/_components/OperatorVoidBoxModal";
import { OperatorVoidPalletModal } from "@/app/scanner/operator-mobile/_components/OperatorVoidPalletModal";
import { OperatorScannerFooterActions } from "@/app/scanner/operator-mobile/_components/OperatorScannerFooterActions";
import { ItemScanEditUnitPickerModal } from "@/app/scanner/operator-mobile/_components/ItemScanEditUnitPickerModal";
import {
  filterPackageItemDiscrepancyTags,
  ITEM_UNIT_SELLABLE_OK_TAG,
  normalizeItemUnitDiscrepancySelection,
  type ItemUnitDiscrepancyTagKey,
} from "@/lib/scanner/item-unit-discrepancy-tags";
import { useUserRole } from "@/components/UserRoleContext";
import type { SlipExtractResult } from "@/lib/scanner/operator-slip-scan";
import { isPrintedSlipIdScan } from "@/lib/scanner/box-slip-scan";
import { extractSlipOrderTokenForPalletCompare } from "@/lib/scanner/amazon-ra-order-id";
import {
  INVALID_SLIP_FORMAT,
  isStructuredBoxSlipExtractValid,
  type BoxSlipVisionExtract,
  type BoxSlipVisionLine,
} from "@/lib/scanner/box-slip-vision-parse";
import { normalizeTrackingKey, trackingKeysEqual } from "@/lib/scanner/tracking-normalize";
import {
  fetchStoreDisplayNameForOrganization,
  formatUnauthorizedTrackingInStoreMessage,
} from "@/lib/scanner/operator-store-display";
import {
  type OperatorScanProgressPhase,
} from "@/lib/scanner/operator-scan-progress-ui";
import { OperatorScanProgressStrip } from "@/components/scanner/OperatorScanProgressStrip";

/** Frozen copy of slip line fields persisted to DB — never merge ad-hoc UI edits into item rows. */
function clonePersistBoxSlipVisionLines(lines: BoxSlipVisionLine[]): BoxSlipVisionLine[] {
  return lines.map((l) => ({
    upc: l.upc != null && String(l.upc).trim() !== "" ? String(l.upc).trim() : null,
    fnsku: l.fnsku != null && String(l.fnsku).trim() !== "" ? String(l.fnsku).trim() : null,
    description:
      l.description != null && String(l.description).trim() !== "" ? String(l.description).trim() : null,
    expected_qty: Math.max(0, Math.floor(Number(l.expected_qty ?? 0))),
    condition: l.condition != null && String(l.condition).trim() !== "" ? String(l.condition).trim() : null,
    printed_asin:
      l.printed_asin != null && String(l.printed_asin).trim() !== ""
        ? String(l.printed_asin).trim()
        : null,
    missing: Boolean(l.missing),
  }));
}
import {
  findPalletInOrgByScanCode,
  palletHasPersistedShipmentDetails,
  type OperatorPalletTrackingRow,
} from "@/lib/scanner/operator-pallet-tracking";
import { getAIUnifiedKeyFromStorage, getOpenAIApiKeyFromStorage } from "@/lib/openai-settings";
import {
  KNOWN_CARRIER_ENTRIES,
  OTHER_CARRIER_NAME,
  isKnownCarrierName,
  normalizeCarrierLabel,
} from "@/lib/carriers";
import { MasterUploader } from "@/components/MasterUploader";
import { ScannerBottomNav, SCANNER_OPERATOR_HOME_PATH } from "../_components/ScannerBottomNav";
import { resolveOperatorAuditFieldsClient } from "@/lib/scanner/operator-audit-fields";
import { useOperatorSessionStore } from "../_components/OperatorSessionStoreProvider";

type DetectedBarcode = { rawValue?: string; format?: string };
type BarcodeDetectorInstance = {
  detect(image: ImageBitmapSource): Promise<DetectedBarcode[]>;
};
type BarcodeDetectorCtor = {
  new (opts?: { formats?: string[] }): BarcodeDetectorInstance;
  getSupportedFormats?: () => Promise<string[]>;
};

const PHOTO_BARCODE_FORMATS = [
  "code_128",
  "code_39",
  "code_93",
  "ean_13",
  "ean_8",
  "upc_a",
  "upc_e",
  "itf",
  "qr_code",
  "data_matrix",
  "pdf417",
];

/** Active pallet in the scan UI; `carrier_name` is the session carrier across pallet ↔ box steps. */
type OperatorActivePallet = {
  id: string;
  pallet_number: string;
  carrier_name?: string | null;
  /** `pallets.order_id` when known from resolve / persist (hydrate is authoritative for display state). */
  order_id?: string | null;
};

const DISCREPANCY_AUTO_NOTE =
  "Discrepancy detected: Physical count does not match slip count.";

/** Theme tokens — defined on `.operator-mobile-app-shell` (see globals.css). */
const BG = "var(--scanner-bg)";
const CARD = "var(--scanner-card)";
const CARD_INNER = "var(--scanner-card-inner)";
const BORDER = "var(--scanner-border)";
const MUTED_LABEL = "var(--scanner-muted)";
const TEXT_PRIMARY = "var(--scanner-text)";
const ACCENT_BLUE = "#38bdf8";
const ACTION_BLUE = "#0ea5e9";
const ACTION_BLUE_DEEP = "#0284c7";
const TEAL_STEP = "#2dd4bf";
// (TEAL_STEP_MUTED was used by the old step-progress dots row that was removed
// during the scan-page cleanup; kept as a no-op reference for future styling.)
const SUCCESS = "#34d399";
const SUCCESS_BG = "rgba(52, 211, 153, 0.12)";
/** Box intake lane (reference: purple carton theme) */
const ACCENT_PURPLE = "#c4b5fd";
const ACTION_PURPLE = "#a78bfa";
const ACTION_PURPLE_DEEP = "#7c3aed";
const PURPLE_RING = "rgba(167, 139, 250, 0.35)";
const PURPLE_GLOW = "rgba(139, 92, 246, 0.22)";
const BOX_PURPLE_TRACK = "rgba(167, 139, 250, 0.45)";
const BOX_PURPLE_SOFT_BG = "rgba(167, 139, 250, 0.18)";

/** Zebra handheld — compact action sizing (inline Tailwind only; no globals.css button hooks). */
const ZEBRA_COMPACT_BTN =
  "!h-10 !min-h-0 !max-h-10 !py-2 !text-sm !font-semibold !leading-tight !shadow-none";
/** Inline scan alerts — theme-aware (replaces hardcoded dark-only inline styles). */
const OP_SCAN_ALERT_ERROR = "operator-scan-alert operator-scan-alert--error mb-0 rounded-[20px] border px-3 py-2 text-[12px] font-semibold";
const OP_SCAN_ALERT_WARNING = "operator-scan-alert operator-scan-alert--warning mb-0 rounded-[20px] border px-3 py-2 text-[12px] font-semibold";
const CONFIRM_DIALOG_BTN_GRID = "operator-scan-confirm-dialog__actions mt-6 grid grid-cols-2 gap-3";
/** Rugged handheld density — forced via `.operator-shipment-handheld-compact` on scan page (not viewport MQ). */
const HANDHELD_COMPACT =
  "gap-1 space-y-0.5 px-2 pb-[calc(5.5rem+env(safe-area-inset-bottom,0px))] pt-0";
/** Shipment Entry gate — tight bottom inset above in-column nav (no fixed-action clearance). */
const HANDHELD_GATE_COMPACT =
  "gap-1 space-y-0.5 px-2 pb-[calc(1rem+env(safe-area-inset-bottom,0px))] pt-0";
const HANDHELD_HEADER_COMPACT =
  "px-2 pb-0 pt-0";
const HANDHELD_STEPPER_COMPACT =
  "mt-0 rounded-[11px] px-1.5 py-0.5";
/** Box Info intake (package_scan) — compact polish; scan page only. */
const BOX_INFO_SECTION =
  "relative mb-0 overflow-hidden rounded-md border border-[rgba(138,104,31,0.28)] bg-white p-1.5 shadow-[0_2px_8px_rgba(60,45,20,0.05)] dark:border-[rgba(214,183,110,0.24)] dark:bg-[#1a2129] dark:shadow-[0_4px_12px_rgba(0,0,0,0.22),inset_0_1px_0_rgba(255,255,255,0.04)]";
const BOX_INFO_NOTES_SECTION =
  "relative mb-3 overflow-hidden rounded-md border border-[rgba(138,104,31,0.28)] bg-white p-2 shadow-[0_2px_8px_rgba(60,45,20,0.05)] dark:border-[rgba(214,183,110,0.24)] dark:bg-[#1a2129] dark:shadow-[0_4px_12px_rgba(0,0,0,0.22),inset_0_1px_0_rgba(255,255,255,0.04)]";
const BOX_INFO_DOCS_LIST = "overflow-hidden rounded-sm";
const BOX_INFO_DOCS_ROW_BASE =
  "relative border-b border-[rgba(207,198,182,0.62)] px-1 py-0 last:border-b-0 dark:border-[rgba(185,194,204,0.14)]";
const BOX_INFO_DOCS_ROW_SURFACE =
  "bg-[rgba(248,246,241,0.72)] dark:bg-[rgba(255,255,255,0.025)]";
const BOX_INFO_DOCS_ROW_OPTIONAL =
  "operator-box-info-docs-row-optional min-h-0 bg-[rgba(248,246,241,0.55)] py-0 dark:bg-[rgba(255,255,255,0.015)]";
const BOX_INFO_DOCS_ROW_ACTIVE =
  "operator-box-info-docs-row-active border-l-[3px] border-l-[rgba(138,104,31,0.4)] bg-[rgba(138,104,31,0.06)] py-0.5 pl-[calc(0.5rem-3px)] dark:border-l-[rgba(214,183,110,0.48)] dark:bg-[rgba(214,183,110,0.06)]";
const BOX_INFO_DOCS_ROW_COMPLETE =
  "operator-box-info-docs-row-complete border-l-[3px] border-l-[rgba(15,143,99,0.34)] py-0.5 pl-[calc(0.5rem-3px)] dark:border-l-[rgba(34,197,139,0.32)]";
const BOX_INFO_REFERENCE_DETAILS =
  "rounded-lg border-t border-[rgba(207,198,182,0.62)] bg-[#f8f6f1] px-0 py-1 dark:border-[rgba(185,194,204,0.14)] dark:bg-[rgba(255,255,255,0.025)]";
const BOX_INFO_INPUT_BORDER =
  "border-[rgba(185,194,204,0.28)] px-2 py-0.5 focus:border-[rgba(138,104,31,0.45)] focus:ring-2 focus:ring-[rgba(214,183,110,0.14)] dark:border-[rgba(185,194,204,0.16)] dark:focus:border-[rgba(214,183,110,0.55)] dark:focus:ring-[rgba(214,183,110,0.15)]";
const BOX_INFO_INPUT_COMPACT_HEIGHT = "h-9 min-h-[36px] text-[13px]";
const BOX_INFO_INPUT_COMPACT_HEIGHT_SM = "h-9 min-h-[36px] text-[13px]";
const BOX_INFO_SLIP_META_DIVIDER =
  "border-b border-[rgba(207,198,182,0.55)] py-0.5 last:border-b-0 dark:border-[rgba(185,194,204,0.12)]";
const BOX_INFO_BTN_SAVE_EXIT =
  "flex min-h-[44px] items-center justify-center gap-1.5 rounded-xl border border-[#0f8f63]/50 bg-[#0f8f63]/12 px-2 text-[13px] text-[#0b6f4d] transition active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-35 dark:border-emerald-400/50 dark:bg-emerald-500/18 dark:text-emerald-200";
const BOX_INFO_BTN_DISCARD =
  "flex min-h-[44px] items-center justify-center gap-1.5 rounded-xl border border-[#b4232f]/45 bg-[#b4232f]/12 px-2 text-[13px] text-[#8f1d29] transition active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-35 dark:border-red-400/48 dark:bg-red-500/16 dark:text-red-300";
const BOX_INFO_BTN_PRIMARY =
  "flex !h-11 min-h-[44px] w-full items-center justify-center gap-2 rounded-xl border border-[#C8A96A]/55 bg-gradient-to-b from-[#525d6b] to-[#222830] px-3 py-2 text-[13px] font-semibold leading-tight text-[#faf6ed] shadow-none transition active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40";
const glassCard = "scanner-page-glass-card";
/** Item scan / slip cards — high-density warehouse typography (inline Tailwind; overrides globals.css leaks). */
const SLIP_CARD_HEADING =
  "operator-item-scan-product-link line-clamp-2 text-xs font-bold tracking-wide text-[#FAF6ED] no-underline hover:text-[#FAF6ED]";
const SLIP_CARD_SUBTEXT = "text-[11px] leading-tight text-neutral-400";
const SLIP_CARD_TECH_ID = "font-mono text-[10px] text-neutral-500";
const SLIP_CARD_STATUS_BADGE =
  "text-[9px] px-1 py-0.5 font-bold uppercase leading-none tracking-wide max-w-[6rem] truncate rounded";
const SLIP_CARD_ROW =
  "operator-item-scan-slip-row rounded-lg border border-[rgba(214,183,110,0.24)] bg-[rgba(255,255,255,0.025)] px-2 py-1 shadow-none";
const SLIP_CARD_ROW_ACTIVE = "border-[rgba(34,197,139,0.32)]";
const SLIP_CARD_META_LINKAGE =
  "[&_[data-linkage-chip]]:text-[9px] [&_[data-linkage-chip]]:px-1 [&_[data-linkage-chip]]:py-0.5 [&_[data-linkage-chip]]:font-bold [&_[data-linkage-chip]]:uppercase [&_[data-linkage-chip]]:leading-none [&_.truncate]:text-[11px] [&_.truncate]:leading-tight [&_.truncate]:text-neutral-400 [&_.truncate]:font-medium";
const SLIP_CARD_SECTION =
  "rounded-lg border border-[rgba(214,183,110,0.24)] bg-[rgba(255,255,255,0.025)]";
const SLIP_CARD_DIVIDER = "border-[rgba(185,194,204,0.12)]";
const SLIP_CARD_DIVIDE_Y = "divide-[rgba(185,194,204,0.12)]";
/** Gold accent links — reserved for navigation, not success states */
const viewAllLinkClass = "operator-view-all-link text-[11px] font-bold";

/** Required markers in form labels — bright yellow on dark scanner UI. */
const REQ_MARK_CLASS = "font-normal normal-case text-yellow-300";
const REQ_STAR_CLASS = "font-bold text-yellow-300";
const ENABLE_LEGACY_MOBILE_WORKSPACE = false;
/** Tooltip when pallet shipment order id disagrees with saved packages or slip Order ID. */
const PALLET_ORDER_CONFLICT_TOOLTIP =
  "Different boxes reference different Order IDs, or they disagree with this pallet.";
/** Generic confirmation copy for destructive save/discard flows on operator scan. */
const CONFIRM_SAVE_MESSAGE = "Are you sure you want to save these changes?";
const CONFIRM_DISCARD_MESSAGE = "Unsaved changes will be lost. Are you sure you want to discard?";
const SCANNER_LEAVE_UNSAVED_TITLE = "Leave without saving changes?";
const SCANNER_LEAVE_UNSAVED_BODY = "Unsaved photos, notes, or slip details may be lost.";
/** Set true temporarily to trace back-navigation decisions in the console. */
const SCANNER_BACK_DEBUG = false;

type IdentifyGateLookupTimingPath = "exact_hit" | "fast_miss" | "deep_search";

function logIdentifyGateLookupTiming(path: IdentifyGateLookupTimingPath, ms: number, code: string) {
  if (!SCANNER_BACK_DEBUG) return;
  console.log(`[scanner-identify-gate] path=${path} ms=${Math.round(ms)} code=${code.slice(0, 32)}`);
}

/** Compare persisted vs current evidence URL lists (order-insensitive). */
function operatorEvidenceUrlArraysChanged(
  current: readonly string[],
  baseline: readonly string[],
): boolean {
  const norm = (arr: readonly string[]) =>
    arr.map((u) => String(u ?? "").trim()).filter(Boolean).sort();
  const a = norm(current);
  const b = norm(baseline);
  return a.length !== b.length || a.some((v, i) => v !== b[i]);
}

/** Scalar box/pallet intake fields — treat null/undefined/whitespace as empty. */
function normBoxScalar(value: unknown): string {
  return String(value ?? "").trim();
}
/** Second gate when saving a BOX while slip snapshot records pallet Order ID conflict. */
const PACKAGE_SAVE_ORDER_CONFLICT_WARNING =
  "Order ID conflict: the packing slip does not match this pallet's assigned Order ID. Do you want to continue and save anyway?";
/** Under Reference → Order ID when AI slip read disagrees with pallet. */
const AI_SLIP_ORDER_ID_CONFLICT_SHORT_HINT =
  "Order ID conflict: the packing slip does not match this pallet.";
const AMBER_MIXED_ORDER = "#fbbf24";

function firstSlipOrderIdFromSlipRows(rows: OperatorSlipContentsListRow[]): string {
  for (const r of rows) {
    const o = String(r.order_id ?? "").trim();
    if (o) return o;
  }
  return "";
}

function firstConflictingOrderIdFromSlipRows(rows: OperatorSlipContentsListRow[]): string {
  for (const r of rows) {
    const c = String(r.conflicting_order_id ?? "").trim();
    if (c) return c;
  }
  return "";
}

/** When slip `order_id` equals `conflicting_order_id` (case-insensitive), treat as no conflict for UI. */
function normalizeSlipOrderConflictPair(
  slipOrder: string,
  conflicting: string,
): { slip: string; conflicting: string } {
  const s = slipOrder.trim();
  const c = conflicting.trim();
  if (s && c && s.toLowerCase() === c.toLowerCase()) return { slip: s, conflicting: "" };
  return { slip: s, conflicting: c };
}

/**
 * Reference "Order ID" on package intake: slip token when present (or when slip vs pallet disagree),
 * else package row `order_id`, else caller should fall back to RA-derived pallet token.
 */
function referenceOrderIdForPackageFieldAfterSlipLoad(
  norm: { slip: string; conflicting: string },
  packageOrderId: string,
): string | null {
  if (norm.slip && norm.conflicting) return norm.slip;
  if (norm.slip) return norm.slip;
  const p = packageOrderId.trim();
  return p.length ? p : null;
}

/** Canonical pallet photo-array parser (`text[]` in DB) with legacy JSON-string tolerance. */
function parsePalletPhotoUrlArray(raw: unknown): string[] {
  if (raw == null) return [];
  const out: string[] = [];
  if (Array.isArray(raw)) {
    for (const v of raw) {
      const s = typeof v === "string" ? v.trim() : "";
      if (!s) continue;
      if (out.includes(s)) continue;
      out.push(s);
      if (out.length >= 3) break;
    }
    return out;
  }
  if (typeof raw === "string") {
    const direct = raw.trim();
    if (isPersistableStoredMediaReference(direct)) return [direct];
    try {
      return parsePalletPhotoUrlArray(JSON.parse(raw) as unknown);
    } catch {
      return [];
    }
  }
  return out;
}

/** PostgREST may return `packages.manifest_data` as a JSON object or a stringified blob. */
function coercePackageManifestData(raw: unknown): unknown {
  if (raw == null) return null;
  if (typeof raw === "string") {
    const s = raw.trim();
    if (!s) return null;
    try {
      return JSON.parse(s) as unknown;
    } catch {
      return null;
    }
  }
  return raw;
}

function parseBoxSlipManifestData(raw: unknown): { slipCode: string; rma: string; lines: BoxSlipVisionLine[] } {
  const lines: BoxSlipVisionLine[] = [];
  const coerced = coercePackageManifestData(raw);
  if (!coerced || typeof coerced !== "object" || Array.isArray(coerced)) return { slipCode: "", rma: "", lines };
  const md = coerced as Record<string, unknown>;
  const box = md.box_slip_vision;
  if (!box || typeof box !== "object" || Array.isArray(box)) return { slipCode: "", rma: "", lines };
  const b = box as Record<string, unknown>;
  const slipCode = String(b.id_slip_contents ?? b.slip_code ?? b.slip_id ?? "").trim();
  const rma = String(b.rma_number ?? b.rma ?? "").trim();
  const items = b.items;
  if (!Array.isArray(items)) return { slipCode, rma, lines };
  for (const row of items) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const digitStr = String(r.upc ?? "").replace(/\D/g, "");
    const upc =
      digitStr.length === 12
        ? digitStr
        : typeof r.upc === "string" && r.upc.trim()
          ? r.upc.trim()
          : null;
    const fnskuRaw = typeof r.fnsku === "string" ? r.fnsku.trim() : "";
    const printedRaw = typeof r.printed_asin === "string" ? r.printed_asin.trim() : "";
    const fnskuIsAsin = /^B0[0-9A-Z]{8}$/i.test(fnskuRaw);
    const printedIsAsin = /^B0[0-9A-Z]{8}$/i.test(printedRaw);
    const desc = typeof r.description === "string" ? r.description.trim() : "";
    const cond = typeof r.condition === "string" ? r.condition.trim() : "";
    const q = Number(r.qty ?? r.expected_qty ?? r.quantity ?? 0);
    const missing =
      r.missing === true ||
      r.missing === 1 ||
      String(r.missing).toLowerCase() === "true" ||
      String(r.line_status ?? r.status ?? "")
        .trim()
        .toLowerCase() === "missing";
    lines.push({
      upc,
      fnsku: fnskuRaw && !fnskuIsAsin ? fnskuRaw : null,
      printed_asin:
        printedRaw || (fnskuIsAsin ? fnskuRaw : null) || null,
      description: desc || null,
      expected_qty: Number.isFinite(q) && q >= 0 ? Math.floor(q) : 0,
      condition: cond || null,
      ...(missing ? { missing: true } : {}),
    });
  }
  return { slipCode, rma, lines };
}

type HydratedBoxSlipVisionSnapshot = {
  lines: BoxSlipVisionLine[];
  slipCode: string;
  rma: string;
  slipOrderId: string;
  slipConflictingOrderId: string;
  packageOrderId: string;
};

/** DB + manifest → BOX slip vision UI snapshot (`slip_contents` preferred over manifest JSON). */
async function loadHydratedBoxSlipVisionSnapshot(input: {
  packageId: string;
  orgId: string;
  storeId: string | null;
  manifestRaw: unknown;
  idSlipContents?: unknown;
  rmaNumber?: unknown;
  packageOrderId?: unknown;
}): Promise<HydratedBoxSlipVisionSnapshot> {
  const sidRow = String(input.idSlipContents ?? "").trim();
  const rmaRow = String(input.rmaNumber ?? "").trim();
  const fromManifest = parseBoxSlipManifestData(input.manifestRaw);
  let lines = fromManifest.lines;
  let rma = rmaRow || fromManifest.rma;
  let slipCodeFromContents: string | null = null;
  let slipConflicting = "";
  let slipOrder = "";

  const slipRes = await listOperatorSlipContentsForPackageAction(
    input.orgId,
    input.packageId,
    input.storeId,
  );
  if (slipRes.ok && slipRes.rows.length > 0) {
    const slipRowsMapped = slipRes.rows.map((sr) =>
      mapSlipContentRowToVisionLine(sr as unknown as Record<string, unknown>),
    );
    const firstRma = String(slipRes.rows[0]?.rma_number ?? "").trim();
    if (firstRma) rma = firstRma;
    const sc = String(slipRes.rows[0]?.slip_code ?? "").trim();
    slipCodeFromContents = sc.length ? sc : null;
    slipConflicting = firstConflictingOrderIdFromSlipRows(slipRes.rows);
    slipOrder = firstSlipOrderIdFromSlipRows(slipRes.rows);
    lines = mergeManifestMissingIntoVisionLines(slipRowsMapped, fromManifest);
  }

  const slipCode = sidRow || fromManifest.slipCode || slipCodeFromContents || "";
  const norm = normalizeSlipOrderConflictPair(slipOrder, slipConflicting);
  return {
    lines,
    slipCode,
    rma,
    slipOrderId: norm.slip,
    slipConflictingOrderId: norm.conflicting,
    packageOrderId: String(input.packageOrderId ?? "").trim(),
  };
}

type OperatorPhotoClearField = "slip" | "shipping" | "bol" | "outside" | "inside";

function parseDirectBoxShipmentDocumentation(raw: unknown): {
  shippingLabelUrls: string[];
  bolUrls: string[];
  carrierName: string;
  orderId: string;
} {
  const coerced = coercePackageManifestData(raw);
  if (!coerced || typeof coerced !== "object" || Array.isArray(coerced)) {
    return { shippingLabelUrls: [], bolUrls: [], carrierName: "", orderId: "" };
  }
  const md = coerced as Record<string, unknown>;
  const doc = md.direct_box_shipment_documentation;
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) {
    return { shippingLabelUrls: [], bolUrls: [], carrierName: "", orderId: "" };
  }
  const d = doc as Record<string, unknown>;
  return {
    shippingLabelUrls: parsePalletPhotoUrlArray(d.shipping_label_photo_urls),
    bolUrls: parsePalletPhotoUrlArray(d.bol_photo_urls),
    carrierName: String(d.carrier_name ?? d.carrier ?? "").trim(),
    orderId: String(d.order_id ?? "").trim(),
  };
}

function slipContentsNotesToMissingFlag(notes: unknown): boolean {
  if (notes == null) return false;
  if (typeof notes === "string" && notes.trim().startsWith("{")) {
    try {
      const o = JSON.parse(notes) as { missing?: unknown };
      return o.missing === true || o.missing === 1 || String(o.missing).toLowerCase() === "true";
    } catch {
      return false;
    }
  }
  return false;
}

function mapSlipContentRowToVisionLine(row: Record<string, unknown>): BoxSlipVisionLine {
  const q = Number(row.quantity ?? 0);
  const missing =
    row.missing === true ||
    row.missing === 1 ||
    String(row.missing).toLowerCase() === "true" ||
    String(row.line_status ?? row.status ?? "")
      .trim()
      .toLowerCase() === "missing" ||
    slipContentsNotesToMissingFlag(row.notes);
  return {
    upc: typeof row.upc === "string" && row.upc.trim() ? row.upc.trim() : null,
    fnsku: typeof row.fnsku === "string" && row.fnsku.trim() ? row.fnsku.trim() : null,
    printed_asin:
      typeof row.parsed_asin === "string" && row.parsed_asin.trim()
        ? row.parsed_asin.trim()
        : typeof row.printed_asin === "string" && row.printed_asin.trim()
          ? row.printed_asin.trim()
          : null,
    description: typeof row.description === "string" && row.description.trim() ? row.description.trim() : null,
    expected_qty: Number.isFinite(q) && q >= 0 ? Math.floor(q) : 0,
    condition: typeof row.condition === "string" && row.condition.trim() ? row.condition.trim() : null,
    ...(missing ? { missing: true } : {}),
  };
}

function mergeManifestMissingIntoVisionLines(
  lines: BoxSlipVisionLine[],
  fromManifest: { lines: BoxSlipVisionLine[] },
): BoxSlipVisionLine[] {
  if (fromManifest.lines.length === 0) return lines;
  if (fromManifest.lines.length === lines.length) {
    return lines.map((L, i) => ({
      ...L,
      missing: Boolean(L.missing) || Boolean(fromManifest.lines[i]?.missing),
    }));
  }
  return lines.map((L) => ({
    ...L,
    missing:
      Boolean(L.missing) ||
      Boolean(
        fromManifest.lines.find(
          (m) =>
            (m.fnsku && L.fnsku && m.fnsku === L.fnsku) ||
            (m.upc && L.upc && m.upc === L.upc) ||
            (m.description &&
              L.description &&
              m.description.trim() === L.description.trim()),
        )?.missing,
      ),
  }));
}

type OperatorPackagePickerStatus = "discrepancy" | "complete" | "partial";

function countOperatorPackagePhotoSlotsFilled(raw: unknown): number {
  return parsePalletPhotoUrlArray(raw).filter((u) => String(u ?? "").trim().length > 0).length;
}

/** Uses `packages.notes` (PostgREST column `notes`, plural — not legacy `note` / `discrepancy_note`). */
function resolveOperatorPackagePickerRowStatus(p: OperatorPackageListRow): OperatorPackagePickerStatus {
  const notes = String(p.notes ?? "");
  if (notes.toLowerCase().includes("discrepancy")) return "discrepancy";
  if (
    countOperatorPackagePhotoSlotsFilled(p.slip_photo_urls) < 1 ||
    countOperatorPackagePhotoSlotsFilled(p.outside_photo_urls) < 1 ||
    countOperatorPackagePhotoSlotsFilled(p.inside_photo_urls) < 1
  ) {
    return "partial";
  }
  const exp =
    typeof p.expected_item_count === "number" && Number.isFinite(p.expected_item_count)
      ? Math.floor(p.expected_item_count)
      : null;
  const act =
    typeof p.actual_item_count === "number" && Number.isFinite(p.actual_item_count)
      ? Math.floor(p.actual_item_count)
      : null;
  if (exp != null && exp > 0 && act != null && act === exp) return "complete";
  return "partial";
}

function packageBoxIntakeManifestSaved(row: Record<string, unknown>): boolean {
  const coerced = coercePackageManifestData(row.manifest_data);
  if (!coerced || typeof coerced !== "object" || Array.isArray(coerced)) return false;
  const box = (coerced as Record<string, unknown>).box_slip_vision;
  if (!box || typeof box !== "object" || Array.isArray(box)) return false;
  return Boolean(String((box as Record<string, unknown>).captured_at ?? "").trim());
}

function packageHasSlipContentsSaved(
  row: Record<string, unknown>,
  pickerRow: OperatorPackageListRow,
  slipLineCount?: number | null,
): boolean {
  if (typeof slipLineCount === "number" && slipLineCount > 0) return true;
  if (String(row.id_slip_contents ?? pickerRow.id_slip_contents ?? "").trim()) return true;
  const manifest = parseBoxSlipManifestData(row.manifest_data);
  if (manifest.lines.length > 0) return true;
  const expRaw = pickerRow.expected_item_count ?? row.expected_item_count;
  if (typeof expRaw === "number" && Number.isFinite(expRaw) && Math.floor(expRaw) > 0) return true;
  return false;
}

function packageUsesManualItemScanMode(
  row: Record<string, unknown>,
  pickerRow: OperatorPackageListRow,
): boolean {
  const actRaw = pickerRow.actual_item_count ?? row.actual_item_count;
  const act =
    typeof actRaw === "number" && Number.isFinite(actRaw) ? Math.floor(actRaw) : 0;
  if (act > 0 && !packageHasSlipContentsSaved(row, pickerRow)) return true;
  if (packageBoxIntakeManifestSaved(row) && !packageHasSlipContentsSaved(row, pickerRow)) return true;
  return false;
}

function packageBoxDocsCompleteEnough(
  row: Record<string, unknown>,
  directBox: boolean,
  intakeSaved = false,
): boolean {
  if (countOperatorPackagePhotoSlotsFilled(row.slip_photo_urls) < 1) return false;
  const carrier =
    String(row.carrier_name ?? "").trim() ||
    (directBox ? parseDirectBoxShipmentDocumentation(row.manifest_data).carrierName.trim() : "");
  if (!carrier && !intakeSaved) return false;
  if (directBox) {
    const docs = parseDirectBoxShipmentDocumentation(row.manifest_data);
    const hasShippingLabel = docs.shippingLabelUrls.some((u) => String(u ?? "").trim().length > 0);
    if (hasShippingLabel) return true;
    return intakeSaved || packageBoxIntakeManifestSaved(row);
  }
  return true;
}

function packageItemScanFinalized(pickerRow: OperatorPackageListRow): boolean {
  const exp =
    typeof pickerRow.expected_item_count === "number" && Number.isFinite(pickerRow.expected_item_count)
      ? Math.floor(pickerRow.expected_item_count)
      : null;
  const act =
    typeof pickerRow.actual_item_count === "number" && Number.isFinite(pickerRow.actual_item_count)
      ? Math.floor(pickerRow.actual_item_count)
      : null;
  return exp != null && exp > 0 && act != null && act === exp;
}

/** Resume Item Scan when box intake is saved and item receiving is not finalized. */
function shouldResumePackageToItemScan(input: {
  row: Record<string, unknown>;
  pickerRow: OperatorPackageListRow;
  directBox?: boolean;
  slipLineCount?: number | null;
}): boolean {
  const { row, pickerRow, directBox = false, slipLineCount } = input;
  const notes = String(pickerRow.notes ?? row.notes ?? "").toLowerCase();
  if (notes.includes("discrepancy")) return false;
  if (packageItemScanFinalized(pickerRow)) return false;

  const pkgId = String(row.id ?? pickerRow.id ?? "").trim();
  if (!pkgId || !isUuidString(pkgId)) return false;

  const hasSlipPhoto = countOperatorPackagePhotoSlotsFilled(row.slip_photo_urls ?? pickerRow.slip_photo_urls) >= 1;
  const actRaw = pickerRow.actual_item_count ?? row.actual_item_count;
  const actStarted =
    typeof actRaw === "number" && Number.isFinite(actRaw) && Math.floor(actRaw) > 0;
  const intakeSaved =
    packageBoxIntakeManifestSaved(row) ||
    packageHasSlipContentsSaved(row, pickerRow, slipLineCount) ||
    actStarted;

  if (hasSlipPhoto && !intakeSaved) return false;

  if (
    !packageBoxDocsCompleteEnough(
      {
        ...row,
        slip_photo_urls: row.slip_photo_urls ?? pickerRow.slip_photo_urls,
      },
      directBox,
      intakeSaved,
    )
  ) {
    return false;
  }

  const slipReady =
    packageHasSlipContentsSaved(row, pickerRow, slipLineCount) ||
    packageUsesManualItemScanMode(row, pickerRow) ||
    actStarted;
  if (!slipReady) return false;

  return true;
}

/** Box intake is saved and item receiving is not finalized — resume Item Scan, not BOX intake. */
function operatorPackageShouldResumeItemScan(p: OperatorPackageListRow): boolean {
  return shouldResumePackageToItemScan({
    row: p as unknown as Record<string, unknown>,
    pickerRow: p,
  });
}

function operatorPackageListRowFromRecord(row: Record<string, unknown>): OperatorPackageListRow {
  const pkgId = String(row.id ?? "").trim();
  return {
    id: pkgId,
    package_code: String(row.package_code ?? row.slip_id ?? row.package_number ?? "").trim() || null,
    tracking_number: String(row.tracking_number ?? row.shipment_tracking_number ?? "").trim() || null,
    id_slip_contents: String(row.id_slip_contents ?? row.slip_code ?? "").trim() || null,
    notes: row.notes != null ? String(row.notes) : null,
    outside_photo_urls: row.outside_photo_urls,
    inside_photo_urls: row.inside_photo_urls,
    slip_photo_urls: row.slip_photo_urls,
    expected_item_count:
      typeof row.expected_item_count === "number" && Number.isFinite(row.expected_item_count)
        ? Math.floor(row.expected_item_count)
        : null,
    actual_item_count:
      typeof row.actual_item_count === "number" && Number.isFinite(row.actual_item_count)
        ? Math.floor(row.actual_item_count)
        : null,
  };
}

function formatOperatorPackagePickerItemLine(p: OperatorPackageListRow): string {
  const exp =
    typeof p.expected_item_count === "number" && Number.isFinite(p.expected_item_count)
      ? Math.floor(p.expected_item_count)
      : null;
  const act =
    typeof p.actual_item_count === "number" && Number.isFinite(p.actual_item_count)
      ? Math.floor(p.actual_item_count)
      : null;
  const skuCount =
    typeof p.slip_line_count === "number" && p.slip_line_count > 0
      ? ` · ${p.slip_line_count} SKU`
      : "";
  if (exp != null && exp >= 0 && act != null && act >= 0) return `${act}/${exp} Items${skuCount}`;
  if (exp != null && exp >= 0) return `0/${exp} Items${skuCount}`;
  if (act != null && act >= 0) return `${act} Items${skuCount}`;
  return "0 Items";
}

function operatorPackagePickerStatusBadge(t: OperatorPackagePickerStatus): {
  label: string;
  border: string;
  bg: string;
  color: string;
} {
  switch (t) {
    case "discrepancy":
      return {
        label: "⚠️ Discrepancy",
        border: "rgba(251,191,36,0.5)",
        bg: "rgba(120,53,15,0.45)",
        color: "#fde68a",
      };
    case "complete":
      return {
        label: "✅ Complete",
        border: "rgba(52,211,153,0.45)",
        bg: "rgba(6,78,59,0.4)",
        color: "#bbf7d0",
      };
    default:
      return {
        label: "⏳ Partial",
        border: "rgba(56,189,248,0.45)",
        bg: "rgba(12,74,110,0.45)",
        color: "#bae6fd",
      };
  }
}

/** Reads pallet documentation arrays directly from `pallets.*_urls` array columns. */
function hydrateOperatorPalletDocumentationPhotoUrls(
  row: {
    shipping_label_urls?: unknown;
    pallet_photo_urls?: unknown;
    bol_photo_urls?: unknown;
  },
  sb: SupabaseClient,
): { shippingLabel: string[]; pallet: string[]; bol: string[] } {
  const shippingRaw = parsePalletPhotoUrlArray(row.shipping_label_urls);
  const palletRaw = parsePalletPhotoUrlArray(row.pallet_photo_urls);
  const bolRaw = parsePalletPhotoUrlArray(row.bol_photo_urls);

  return {
    shippingLabel: normalizePalletDocumentationImageUrls(shippingRaw, sb),
    pallet: normalizePalletDocumentationImageUrls(palletRaw, sb),
    bol: normalizePalletDocumentationImageUrls(bolRaw, sb),
  };
}

const IDENTIFICATION_GATE_THEME: Record<
  InventoryGateVisualStatus,
  { border: string; headline: string; outerGlow: string; chipBg: string }
> = {
  new: {
    border: "var(--gate-new-border)",
    headline: "var(--gate-new-headline)",
    outerGlow: "var(--gate-new-shadow)",
    chipBg: "var(--gate-new-chip)",
  },
  manual_new: {
    border: "var(--gate-manual-border)",
    headline: "var(--gate-manual-headline)",
    outerGlow: "var(--gate-manual-shadow)",
    chipBg: "var(--gate-manual-chip)",
  },
  unexpected: {
    border: "var(--gate-unexpected-border)",
    headline: "var(--gate-unexpected-headline)",
    outerGlow: "var(--gate-unexpected-shadow)",
    chipBg: "var(--gate-unexpected-chip)",
  },
  in_progress: {
    border: "var(--gate-progress-border)",
    headline: "var(--gate-progress-headline)",
    outerGlow: "var(--gate-progress-shadow)",
    chipBg: "var(--gate-progress-chip)",
  },
  completed: {
    border: "var(--gate-done-border)",
    headline: "var(--gate-done-headline)",
    outerGlow: "var(--gate-done-shadow)",
    chipBg: "var(--gate-done-chip)",
  },
  over_scanned: {
    border: "var(--gate-over-border)",
    headline: "var(--gate-over-headline)",
    outerGlow: "var(--gate-over-shadow)",
    chipBg: "var(--gate-over-chip)",
  },
};

function identificationGatePrimaryCta(visual: InventoryGateVisualStatus, manifestKnown = false): string {
  switch (visual) {
    case "new":
      return "Continue Shipment";
    case "manual_new":
      return manifestKnown ? "Continue Shipment" : "Create & Start";
    case "unexpected":
      return "Continue Scanning";
    case "in_progress":
      return "Continue Shipment";
    case "completed":
      return "Scan More (Extra)?";
    case "over_scanned":
      return "Continue Anyway";
    default:
      return "Continue";
  }
}

/** Short success tone for laser / handset scanners (no asset file required). */
function playOperatorSuccessBeep() {
  try {
    const AC =
      typeof window !== "undefined"
        ? window.AudioContext ||
          (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
        : undefined;
    if (!AC) return;
    const ctx = new AC();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.frequency.value = 880;
    osc.type = "sine";
    const t0 = ctx.currentTime;
    gain.gain.setValueAtTime(0.11, t0);
    gain.gain.exponentialRampToValueAtTime(0.001, t0 + 0.1);
    osc.start(t0);
    osc.stop(t0 + 0.1);
    osc.onended = () => {
      try {
        void ctx.close();
      } catch {
        /* ignore */
      }
    };
  } catch {
    /* ignore */
  }
}

function shipmentLineStatusVisual(row: Pick<VInventoryStatusRow, "total_expected" | "total_scanned" | "status">): InventoryGateVisualStatus {
  return deriveInventoryGateVisualStatus({
    rowCount: 1,
    totalExpected: row.total_expected,
    totalScanned: row.total_scanned,
  });
}

function shipmentLineStatusLabel(row: Pick<VInventoryStatusRow, "total_expected" | "total_scanned" | "status">): string {
  switch (shipmentLineStatusVisual(row)) {
    case "unexpected":
      return "Unexpected";
    case "over_scanned":
      return "Over scanned";
    case "completed":
      return "Completed";
    case "in_progress":
      return "In progress";
    case "new":
      return "New";
    default:
      return String(row.status ?? "").trim() || "—";
  }
}

/**
 * Searchable carrier picker for the operator slip-details card.
 *
 * Behavior:
 *   • Trigger button shows the current carrier (a known canonical name, the "Other / Not Listed"
 *     sentinel, or a placeholder when blank).
 *   • Clicking the trigger opens a popover with a touch-only carrier list (no soft keyboard).
 *   • Optional search: operator taps "Search carrier" to reveal/focus the filter input.
 *     The filter matches against carrier name AND SCAC code, so typing "EX" finds "Estes (EXLA)".
 *   • Picking a known carrier sets the value and closes the panel.
 *   • Picking "Other / Not Listed" closes the panel, sets the explicit-other flag, and lets the
 *     parent reveal a manual "Enter Carrier Name" input that writes back into the same value.
 *
 * Styling matches the slim, glass-card aesthetic of the Active Pallet section so the slip-details
 * controls feel cohesive with the box-count stepper above them.
 */
function CarrierCombobox(props: {
  triggerId: string;
  /** Current persisted carrier name (canonical, custom, or empty). */
  value: string;
  /** Whether the operator explicitly chose the "Other / Not Listed" sentinel. */
  otherSelected: boolean;
  onPickKnown: (name: string) => void;
  onPickOther: () => void;
  invalid?: boolean;
  /** When false, carrier cannot be changed (shipment locked until Edit All). */
  disabled?: boolean;
  /** Optional trigger classes (defaults to compact glass row). */
  triggerClassName?: string;
  /** After the panel closes, refocus the hidden wedge capture input (Zebra). */
  onRequestScanFocus?: () => void;
}) {
  const {
    triggerId,
    value,
    otherSelected,
    onPickKnown,
    onPickOther,
    invalid = false,
    disabled = false,
    triggerClassName,
    onRequestScanFocus,
  } = props;

  const [open, setOpen] = useState(false);
  const [searchMode, setSearchMode] = useState(false);
  const [query, setQuery] = useState("");
  const [panelPos, setPanelPos] = useState<{ top: number; left: number; width: number } | null>(
    null,
  );
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const syncPanelPosition = useCallback(() => {
    const el = triggerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setPanelPos({
      top: rect.bottom + 6,
      left: rect.left,
      width: rect.width,
    });
  }, []);

  const closePanel = useCallback(() => {
    setOpen(false);
    setSearchMode(false);
    onRequestScanFocus?.();
  }, [onRequestScanFocus]);

  const enableCarrierSearch = useCallback(() => {
    setSearchMode(true);
    window.setTimeout(() => searchRef.current?.focus(), 0);
  }, []);

  // Close panel if interaction becomes disabled while open.
  useEffect(() => {
    if (disabled && open) closePanel();
  }, [disabled, open, closePanel]);

  // Close on outside click / Escape key.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent | TouchEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (triggerRef.current?.contains(target)) return;
      if (panelRef.current?.contains(target)) return;
      closePanel();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") closePanel();
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("touchstart", onPointerDown, { passive: true });
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("touchstart", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, closePanel]);

  // Reset query/search mode and sync panel position when the panel opens.
  useEffect(() => {
    if (!open) {
      setQuery("");
      setSearchMode(false);
      setPanelPos(null);
      return;
    }
    syncPanelPosition();
    const onReflow = () => syncPanelPosition();
    window.addEventListener("resize", onReflow);
    window.addEventListener("scroll", onReflow, true);
    return () => {
      window.removeEventListener("resize", onReflow);
      window.removeEventListener("scroll", onReflow, true);
    };
  }, [open, syncPanelPosition]);

  const trimmedQuery = query.trim().toLowerCase();
  const filteredKnown = useMemo(() => {
    if (!trimmedQuery) return KNOWN_CARRIER_ENTRIES;
    return KNOWN_CARRIER_ENTRIES.filter((e) => {
      if (e.name.toLowerCase().includes(trimmedQuery)) return true;
      if (e.scac && e.scac.toLowerCase().includes(trimmedQuery)) return true;
      return false;
    });
  }, [trimmedQuery]);

  const isKnown = isKnownCarrierName(value);
  const triggerLabel = (() => {
    if (isKnown) return value;
    if (otherSelected || (value !== "" && !isKnown)) return OTHER_CARRIER_NAME;
    return "Pick carrier…";
  })();
  const triggerIsPlaceholder = !isKnown && !otherSelected && value === "";

  return (
    <div className="relative">
      <button
        id={triggerId}
        ref={triggerRef}
        type="button"
        disabled={disabled}
        onClick={() => {
          if (disabled) return;
          if (open) closePanel();
          else setOpen(true);
        }}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-invalid={invalid}
        title={triggerLabel}
        className={`${
          triggerClassName?.trim() ||
          "scanner-input-glass flex h-10 w-full items-center justify-between gap-2 rounded-lg border px-3 text-left text-[13px] outline-none transition focus-visible:border-teal-400/45 focus-visible:shadow-[0_0_0_2px_rgba(45,212,191,0.22)]"
        } ${invalid ? "border-amber-500/55" : ""} ${disabled ? "cursor-not-allowed opacity-50" : ""}`}
        style={{ color: triggerIsPlaceholder ? MUTED_LABEL : TEXT_PRIMARY }}
      >
        <span className="min-w-0 flex-1 truncate">{triggerLabel}</span>
        <ChevronDown
          className={`h-3.5 w-3.5 shrink-0 opacity-70 transition ${open ? "rotate-180" : ""}`}
          strokeWidth={2.25}
        />
      </button>

      {open && panelPos && typeof document !== "undefined"
        ? createPortal(
            <>
              {/* Fixed layer so the list stays above box documentation cards (stacking contexts). */}
              <div
                className="fixed inset-0 z-[198] cursor-default"
                aria-hidden
                onClick={closePanel}
              />
              <div
                ref={panelRef}
                role="listbox"
                aria-label="Carrier"
                className="fixed z-[199] overflow-hidden rounded-xl border shadow-[0_16px_40px_rgba(0,0,0,0.45)]"
                style={{
                  top: panelPos.top,
                  left: panelPos.left,
                  width: panelPos.width,
                  maxHeight: `min(16rem, calc(100vh - ${panelPos.top}px - 1rem))`,
                  borderColor: "var(--scanner-border, #243241)",
                  backgroundColor: "var(--scanner-card, #0e1620)",
                  color: "var(--scanner-text, #f1f5f9)",
                }}
              >
            {searchMode ? (
              <div
                className="flex items-center gap-1.5 border-b px-2.5 py-2"
                style={{ borderColor: "var(--scanner-border, #243241)" }}
              >
                <Search className="h-3.5 w-3.5 shrink-0 opacity-60" strokeWidth={2.25} />
                <input
                  ref={searchRef}
                  type="text"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search carrier or SCAC (e.g. EXLA)"
                  className="min-w-0 flex-1 bg-transparent text-[12px] font-medium outline-none placeholder:opacity-50"
                  spellCheck={false}
                  autoComplete="off"
                  inputMode="search"
                />
                {query ? (
                  <button
                    type="button"
                    onClick={() => {
                      setQuery("");
                      searchRef.current?.focus();
                    }}
                    aria-label="Clear search"
                    className="rounded-md p-0.5 opacity-60 hover:opacity-100"
                  >
                    <X className="h-3 w-3" strokeWidth={2.5} />
                  </button>
                ) : null}
              </div>
            ) : (
              <button
                type="button"
                onClick={enableCarrierSearch}
                className="flex w-full items-center gap-1.5 border-b px-2.5 py-2 text-left text-[12px] font-semibold opacity-80 transition hover:bg-white/5 hover:opacity-100"
                style={{ borderColor: "var(--scanner-border, #243241)" }}
              >
                <Search className="h-3.5 w-3.5 shrink-0 opacity-60" strokeWidth={2.25} />
                <span>Search carrier</span>
              </button>
            )}
            <ul className="max-h-[min(50vh,320px)] list-none overflow-y-auto overscroll-contain py-1">
              {filteredKnown.length === 0 ? (
                <li className="px-3 py-2 text-[12px] font-medium opacity-70" aria-live="polite">
                  No matches
                </li>
              ) : (
                filteredKnown.map((entry) => {
                  const isSelected = entry.name === value;
                  return (
                    <li key={entry.name} role="option" aria-selected={isSelected}>
                      <button
                        type="button"
                        onClick={() => {
                          onPickKnown(entry.name);
                          closePanel();
                        }}
                        className={`flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-[12px] font-semibold transition hover:bg-white/5 ${
                          isSelected ? "bg-teal-500/10 text-teal-200" : ""
                        }`}
                      >
                        <span className="min-w-0 truncate">{entry.name}</span>
                        <span className="flex shrink-0 items-center gap-2">
                          {entry.scac ? (
                            <span className="rounded-md border border-white/10 bg-white/5 px-1.5 py-0.5 text-[10px] font-mono uppercase tracking-wider opacity-80">
                              {entry.scac}
                            </span>
                          ) : null}
                          {isSelected ? (
                            <Check className="h-3.5 w-3.5 text-teal-300" strokeWidth={2.5} />
                          ) : null}
                        </span>
                      </button>
                    </li>
                  );
                })
              )}
              {/* "Other / Not Listed" pinned to the bottom of the list, separated visually. */}
              <li
                role="option"
                aria-selected={otherSelected || (value !== "" && !isKnown)}
                className="border-t"
                style={{ borderColor: "var(--scanner-border, #243241)" }}
              >
                <button
                  type="button"
                  onClick={() => {
                    onPickOther();
                    closePanel();
                  }}
                  className={`flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-[12px] font-semibold transition hover:bg-white/5 ${
                    otherSelected || (value !== "" && !isKnown)
                      ? "bg-amber-500/10 text-amber-200"
                      : "opacity-90"
                  }`}
                >
                  <span className="min-w-0 truncate">{OTHER_CARRIER_NAME}</span>
                  {otherSelected || (value !== "" && !isKnown) ? (
                    <Check className="h-3.5 w-3.5 shrink-0 text-amber-200" strokeWidth={2.5} />
                  ) : null}
                </button>
              </li>
            </ul>
          </div>
            </>,
            document.body,
          )
        : null}
    </div>
  );
}

/** Compact label for the identify gate status pill (top-right). */
function identifyGateStatusBadgeLabel(
  visual: InventoryGateVisualStatus,
  manifestKnown = false,
): string {
  switch (visual) {
    case "new":
      return manifestKnown ? "Expected" : "New";
    case "manual_new":
      return manifestKnown ? "On manifest" : "Off manifest";
    case "unexpected":
      return "Unexpected";
    case "in_progress":
      return "In progress";
    case "completed":
      return "Complete";
    case "over_scanned":
      return "Over scanned";
    default:
      return "Status";
  }
}

const mainScrollClass =
  "[scrollbar-width:thin] [scrollbar-color:var(--scanner-border)_var(--scanner-bg)] [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-[var(--scanner-border)]/90 hover:[&::-webkit-scrollbar-thumb]:opacity-80";

/** Single source of truth: Pallet → Box intake → Item (operational phases map to scan / package_scan / items) */
const SCANNER_STEPS = [
  {
    id: 1,
    key: "pallet",
    label: "Pallet",
    title: "Step 1: Pallet",
    subtitle: "Slip, counts, then boxes",
  },
  {
    id: 2,
    key: "package",
    label: "BOX",
    title: "Step 2: BOX",
    subtitle: "Box intake",
  },
  {
    id: 3,
    key: "item",
    label: "Item",
    title: "Step 3: Item",
    subtitle: "Item scan",
  },
] as const;

type FlowPhase = "scan" | "package_scan" | "items";

type HeaderIdentityBoxSurface = {
  code: string;
  touchLabel: string;
  touchProfileId: string | null;
  touchIso: string | null;
};

/** Pallet row `created_at` — local wall time, fixed MM/DD/YYYY HH:mm for scan header readability. */
function formatOperatorPalletCreatedAt(iso: string | null): string {
  const s = (iso ?? "").trim();
  if (!s) return "—";
  try {
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) return "—";
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    const yyyy = d.getFullYear();
    const hh = String(d.getHours()).padStart(2, "0");
    const min = String(d.getMinutes()).padStart(2, "0");
    return `${mm}/${dd}/${yyyy} ${hh}:${min}`;
  } catch {
    return "—";
  }
}

/** Marks the signed-in profile in the identity strip when it matches the audit UUID. */
function formatOperatorIdentityParticipant(
  displayName: string,
  profileId: string | null | undefined,
  actorUserId: string | null | undefined,
): string {
  const t = displayName.trim() || "—";
  const pid = (profileId ?? "").trim();
  const aid = (actorUserId ?? "").trim();
  if (pid && aid && pid === aid) return `${t} (you)`;
  return t;
}

/** Strip trailing " (you)" for the compact identity line (names only). */
function stripOperatorIdentityYouHint(raw: string): string {
  return raw.replace(/\s*\(you\)\s*$/i, "").trim() || "—";
}

/** Identity line clock: MM/DD HH:mm (local). */
function formatOperatorIdentityCompactAt(iso: string | null): string {
  const s = (iso ?? "").trim();
  if (!s) return "—";
  try {
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) return "—";
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    const hh = String(d.getHours()).padStart(2, "0");
    const min = String(d.getMinutes()).padStart(2, "0");
    return `${mm}/${dd} ${hh}:${min}`;
  } catch {
    return "—";
  }
}

/** Pallet → Box Info → Item Scan (under Shipment Entry). */
function ReceivingMasterStepper({
  flowPhase,
  parentIdentified,
  directBox,
}: {
  flowPhase: FlowPhase;
  parentIdentified: boolean;
  directBox: boolean;
}) {
  const palletDone = parentIdentified || directBox;
  const palletActive = flowPhase === "scan" && !palletDone;
  const boxDone = flowPhase === "items";
  const boxActive = flowPhase === "package_scan" && palletDone;
  const itemsActive = flowPhase === "items";

  const ringBase =
    "operator-stepper-node flex h-[1.3125rem] w-[1.3125rem] shrink-0 items-center justify-center rounded-full border-2 transition";

  const rail = () => (
    <div
      className="operator-stepper-rail mx-0.5 min-w-[0.75rem] max-w-[2rem] flex-1 shrink rounded-full"
      aria-hidden
    />
  );

  const palletNode = () => {
    if (palletDone) {
      return (
        <span className={`${ringBase} operator-stepper-node--done`} aria-hidden>
          <Check className="h-4 w-4" strokeWidth={3} />
        </span>
      );
    }
    if (palletActive) {
      return (
        <span className={`${ringBase} operator-stepper-node--active`} aria-hidden>
          <Warehouse className="h-4 w-4 fill-[var(--op-gold-accent)]/30 text-[var(--op-gold-accent)]" strokeWidth={2.5} />
        </span>
      );
    }
    return (
      <span className={`${ringBase} operator-stepper-node--locked`} aria-hidden>
        <Lock className="h-3.5 w-3.5" strokeWidth={2.5} />
      </span>
    );
  };

  const boxNode = () => {
    if (boxDone) {
      return (
        <span className={`${ringBase} operator-stepper-node--done`} aria-hidden>
          <Check className="h-4 w-4" strokeWidth={3} />
        </span>
      );
    }
    if (boxActive) {
      return (
        <span className={`${ringBase} operator-stepper-node--active`} aria-hidden>
          <Package className="h-4 w-4 fill-[var(--op-gold-accent)]/30 text-[var(--op-gold-accent)]" strokeWidth={2.5} />
        </span>
      );
    }
    return (
      <span className={`${ringBase} operator-stepper-node--locked`} aria-hidden>
        <Lock className="h-3.5 w-3.5" strokeWidth={2.5} />
      </span>
    );
  };

  const itemsNode = () => {
    if (itemsActive) {
      return (
        <span className={`${ringBase} operator-stepper-node--active`} aria-hidden>
          <ScanLine className="h-4 w-4 fill-[var(--op-gold-accent)]/30 text-[var(--op-gold-accent)]" strokeWidth={2.5} />
        </span>
      );
    }
    return (
      <span className={`${ringBase} operator-stepper-node--locked`} aria-hidden>
        <Lock className="h-4 w-4" strokeWidth={2.5} />
      </span>
    );
  };

  return (
    <div className="operator-receiving-stepper w-full px-0 pb-0" role="list" aria-label="Receiving progress">
      <div className="operator-receiving-stepper-track flex w-full items-center justify-center">
        {palletNode()}
        {rail()}
        {boxNode()}
        {rail()}
        {itemsNode()}
      </div>
      <div className="operator-receiving-stepper-labels mt-1 grid grid-cols-[1fr_minmax(0.625rem,1.5rem)_1fr_minmax(0.625rem,1.5rem)_1fr] gap-0 text-center font-bold uppercase tracking-wide">
        <span
          className={`operator-receiving-stepper-label col-start-1 justify-self-center ${palletDone ? "operator-stepper-label--done" : palletActive ? "operator-stepper-label--active" : ""}`}
        >
          Pallet
        </span>
        <span
          className={`operator-receiving-stepper-label col-start-3 justify-self-center ${
            boxActive
              ? "operator-stepper-label--active"
              : boxDone
                ? "operator-stepper-label--done"
                : ""
          }`}
        >
          Box Info
        </span>
        <span
          className={`operator-receiving-stepper-label col-start-5 justify-self-center ${itemsActive ? "operator-stepper-label--active" : ""}`}
        >
          Item Scan
        </span>
      </div>
    </div>
  );
}

/** Locked BOX draft (maybe not persisted yet) or a saved package id from the last completed save. */
function hasReceivableBoxForItems(
  itemScanPackageId: string | null,
  activeBoxSession: { packageId: string | null; barcode: string } | null,
): boolean {
  return Boolean(String(itemScanPackageId ?? "").trim()) || Boolean(activeBoxSession);
}

/** Parent shipment tracking for item-phase EP snapshot (`loadTrackingExpectationSnapshot`). */
function resolveItemScanParentTracking(
  currentPalletTrackingId: string | null,
  activeTracking: string | null,
  identifyGateCanonicalTracking: string | null,
): string | null {
  const tn = (currentPalletTrackingId ?? activeTracking ?? identifyGateCanonicalTracking ?? "").trim();
  return tn || null;
}

/** Neda quantity matrix row sheen — `scanned_count` vs `expected_count`. */
function itemInspectionSlipLinePresentation(
  expectedQty: number,
  scannedQty: number,
  discrepancyMode: boolean,
) {
  return nedaQuantityRowPresentation(expectedQty, scannedQty, discrepancyMode);
}

function itemInspectionSlipCardStyle(vis: ReturnType<typeof itemInspectionSlipLinePresentation>) {
  const surface = nedaQuantityCardSurfaceStyle(vis);
  return {
    background: surface.background,
    borderColor: surface.borderColor,
    borderWidth: surface.borderWidth,
    boxShadow: surface.boxShadow,
  };
}

function itemScanSlipRowShellClass(active?: boolean): string {
  return active ? `${SLIP_CARD_ROW} ${SLIP_CARD_ROW_ACTIVE}` : SLIP_CARD_ROW;
}

/** Compact status chip for item slip rows (all states show a visible label). */
function slipCardStatusMark(vis: ReturnType<typeof itemInspectionSlipLinePresentation>) {
  const label = vis.label;
  if (label === "Awaiting") {
    return (
      <span
        className={`operator-item-scan-slip-status operator-item-scan-slip-status--awaiting border ${SLIP_CARD_STATUS_BADGE}`}
        style={{
          borderColor: "rgba(148,163,184,0.38)",
          backgroundColor: "rgba(30,41,59,0.45)",
          color: "rgba(226,232,240,0.92)",
        }}
        title="Awaiting scan"
      >
        Awaiting
      </span>
    );
  }
  const tone =
    label === "RECEIVED"
      ? "text-emerald-300"
      : label === "IN PROGRESS"
        ? "text-emerald-400/90"
        : label === "UNDER"
          ? "text-red-300"
          : label === "OVER" || label === "UNEXPECTED"
            ? "text-amber-200"
            : "text-neutral-500";
  return (
    <span
      className={`operator-item-scan-slip-status ${SLIP_CARD_STATUS_BADGE} ${tone}`}
      data-neda-qty={label}
      title={label}
    >
      {label}
    </span>
  );
}

function epRowMatchesItemDraft(row: Record<string, unknown>, draft: { epRow: Record<string, unknown> }): boolean {
  const rid = String((row as { id?: unknown }).id ?? "").trim();
  const did = String((draft.epRow as { id?: unknown }).id ?? "").trim();
  if (rid && did && rid === did) return true;
  const sku = String(row.sku ?? "").trim();
  const fnsku = String(row.fnsku ?? "").trim();
  const disp = String(row.disposition ?? "").trim();
  const oid = String(row.order_id ?? "").trim();
  return (
    sku === String(draft.epRow.sku ?? "").trim() &&
    fnsku === String(draft.epRow.fnsku ?? "").trim() &&
    disp === String(draft.epRow.disposition ?? "").trim() &&
    oid === String(draft.epRow.order_id ?? "").trim()
  );
}

function slipTokenNorm(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, "");
}

/** Map slip / vision line identifiers to `expected_packages` detail rows for scanned counts. */
function epRowsMatchingSlipLike(
  slip: { upc: string | null; fnsku: string | null },
  epRows: Record<string, unknown>[],
): Record<string, unknown>[] {
  const su = slipTokenNorm(String(slip.upc ?? ""));
  const sf = slipTokenNorm(String(slip.fnsku ?? ""));
  return epRows.filter((r) => {
    const f = slipTokenNorm(String(r.fnsku ?? ""));
    const sku = slipTokenNorm(String(r.sku ?? ""));
    if (sf && f && sf === f) return true;
    if (su && sku && su === sku) return true;
    if (su && f && su === f) return true;
    if (sf && sku && sf === sku) return true;
    return false;
  });
}

function sumEpActualScanned(epList: Record<string, unknown>[]): number {
  return epList.reduce(
    (s, r) => s + Math.max(0, Math.floor(Number((r as { actual_scanned_count?: unknown }).actual_scanned_count ?? 0))),
    0,
  );
}

function slipInspectionStableKey(slip: OperatorSlipContentsListRow, idx: number): string {
  if (slip.id && isUuidString(slip.id)) return `sc:${slip.id}`;
  return `k:${slip.sort_index}:${idx}:${slipTokenNorm(String(slip.upc ?? ""))}:${slipTokenNorm(String(slip.fnsku ?? ""))}`;
}

function aggregateOperatorPackageItemRows(rows: OperatorPackageItemRow[]): {
  bySlipId: Record<string, number>;
  unexpectedUnits: number;
} {
  const bySlipId: Record<string, number> = {};
  let unexpectedUnits = 0;
  for (const r of rows) {
    const q = Math.max(1, Math.floor(Number(r.quantity ?? 1)));
    const sid = r.slip_content_id?.trim();
    if (sid && isUuidString(sid)) {
      bySlipId[sid] = (bySlipId[sid] ?? 0) + q;
    } else {
      unexpectedUnits += q;
    }
  }
  return { bySlipId, unexpectedUnits };
}

function ItemInspectionSlipSkeletonRows() {
  return (
    <>
      {[0, 1, 2].map((i) => (
        <div
          key={`slip-skel-${i}`}
          className={`animate-pulse ${SLIP_CARD_ROW}`}
          aria-hidden
        >
          <div className="mb-1.5 h-3 w-3/4 rounded bg-slate-700/80" />
          <div className="mb-1 h-2 w-1/2 rounded bg-slate-800/90" />
          <div className="flex justify-between gap-2">
            <div className="h-2 w-24 rounded bg-slate-800/90" />
            <div className="h-3 w-12 rounded bg-slate-700/70" />
          </div>
        </div>
      ))}
    </>
  );
}

function ScanPageLoading(props: { message?: string }) {
  return (
    <div
      className="flex min-h-[50vh] flex-1 flex-col items-center justify-center gap-3 px-6 text-center text-[15px] font-semibold"
      style={{ backgroundColor: BG, color: TEXT_PRIMARY }}
    >
      <Loader2 className="h-10 w-10 animate-spin" style={{ color: ACCENT_BLUE }} strokeWidth={2} />
      <p>{props.message ?? "Loading operator session…"}</p>
    </div>
  );
}

class ScanPageErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    if (this.state.error) {
      return (
        <div className="flex min-h-[50vh] flex-1 flex-col items-center justify-center gap-4 px-6 text-center" style={{ backgroundColor: BG, color: TEXT_PRIMARY }}>
          <AlertTriangle className="h-12 w-12 text-amber-400" strokeWidth={2} />
          <p className="max-w-md text-[15px] font-bold">Something went wrong on this screen.</p>
          <p className="operator-scan-error-boundary__detail max-w-md text-[13px] font-medium">{this.state.error.message}</p>
          <button
            type="button"
            className="rounded-xl px-5 py-3 text-[14px] font-bold text-white transition hover:brightness-110"
            style={{ background: `linear-gradient(180deg, ${ACTION_BLUE} 0%, ${ACTION_BLUE_DEEP} 100%)` }}
            onClick={() => window.location.reload()}
          >
            Reload page
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

async function fetchBlobFromObjectUrl(url: string): Promise<Blob | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return await res.blob();
  } catch {
    return null;
  }
}

const IDENTIFY_GATE_IMAGE_EXT_RE = /\.(jpe?g|png)$/i;

function isAllowedIdentifyGateImageFile(file: File): boolean {
  const t = file.type.toLowerCase();
  if (t === "image/jpeg" || t === "image/jpg" || t === "image/png") return true;
  const n = file.name.trim();
  return n.length > 0 && IDENTIFY_GATE_IMAGE_EXT_RE.test(n);
}

type PhotoBarcodeDecodeResult =
  | { status: "detected"; value: string }
  | { status: "ocr_candidates"; candidates: string[] }
  | { status: "not_found" };

type PhotoBarcodeDecodeAttempt =
  | "BarcodeDetector"
  | "ZXing:imageElement"
  | "ZXing:imageUrl"
  | "ZXing:canvasVariant"
  | "canvasVariant";

type PhotoBarcodeCandidate = {
  value: string;
  decoder: "BarcodeDetector" | "ZXing";
  format?: string;
  variant: string;
  score: number;
};

type PhotoBarcodeCropName = "full" | "top35" | "bottom35" | "centerBand";

type PhotoBarcodeVariant = {
  name: string;
  crop: PhotoBarcodeCropName;
  rotationDeg: number;
  grayscaleContrast: boolean;
  maxWidth: number;
};

type ZxingDecodeResult = {
  getText(): string;
  getBarcodeFormat?: () => unknown;
};

type ZxingPhotoBarcodeReader = {
  reader: {
    decodeFromImageElement(image: HTMLImageElement): Promise<ZxingDecodeResult>;
    decodeFromImageUrl?: (url: string) => Promise<ZxingDecodeResult>;
  };
  formatName(format: unknown): string | undefined;
};

type PhotoBarcodeDecodeErrorLog = {
  attempt: PhotoBarcodeDecodeAttempt | "imageLoad";
  name: string;
  message: string;
};

function getNativeBarcodeDetectorCtor(): BarcodeDetectorCtor | null {
  if (typeof window === "undefined") return null;
  const candidate = (window as Window & { BarcodeDetector?: BarcodeDetectorCtor }).BarcodeDetector;
  return typeof candidate === "function" ? candidate : null;
}

async function createNativeBarcodeDetector(ctor: BarcodeDetectorCtor): Promise<BarcodeDetectorInstance> {
  if (typeof ctor.getSupportedFormats === "function") {
    try {
      const supported = await ctor.getSupportedFormats();
      const supportedSet = new Set(supported);
      const formats = PHOTO_BARCODE_FORMATS.filter((format) => supportedSet.has(format));
      if (formats.length > 0) return new ctor({ formats });
    } catch {
      // Some browser implementations expose the method but reject; fall through to constructor retry.
    }
  }

  try {
    return new ctor({ formats: PHOTO_BARCODE_FORMATS });
  } catch {
    return new ctor();
  }
}

function isPhotoBarcodeDecodeDebugEnabled(): boolean {
  if (process.env.NODE_ENV !== "production") return true;
  return false;
}

function logPhotoBarcodeDecodeDebug(message: string, details?: Record<string, unknown>): void {
  if (!isPhotoBarcodeDecodeDebugEnabled()) return;
  console.debug("[operator-photo-barcode]", message, details ?? {});
}

function summarizePhotoBarcodeDecodeError(
  attempt: PhotoBarcodeDecodeErrorLog["attempt"],
  err: unknown,
): PhotoBarcodeDecodeErrorLog {
  if (err instanceof Error) {
    return { attempt, name: err.name || "Error", message: err.message || String(err) };
  }
  return { attempt, name: typeof err, message: String(err) };
}

function logPhotoBarcodeDecodeError(attempt: PhotoBarcodeDecodeErrorLog["attempt"], err: unknown): PhotoBarcodeDecodeErrorLog {
  const summary = summarizePhotoBarcodeDecodeError(attempt, err);
  logPhotoBarcodeDecodeDebug("decode error", summary);
  if (isPhotoBarcodeDecodeDebugEnabled()) {
    console.debug("[operator-photo-barcode] raw decode error", { attempt, error: err });
  }
  return summary;
}

function photoBarcodeValueLooksLikeUrl(value: string): boolean {
  const v = value.trim();
  return /^(https?:\/\/|www\.)/i.test(v) || /^[a-z][a-z0-9+.-]*:\/\//i.test(v);
}

function photoBarcodeValueLooksTrackingLike(value: string): boolean {
  const compact = value.replace(/[\s-]/g, "").toUpperCase();
  const digitCount = (compact.match(/\d/g) ?? []).length;
  if (isRejectedPhotoCodeCandidate(compact)) return false;
  if (/^TBA\d{10,20}$/.test(compact)) return true;
  if (/^1Z[0-9A-Z]{10,30}$/.test(compact)) return true;
  if (/^VRET[0-9A-Z]{6,30}$/.test(compact)) return true;
  if (/^9\d{10,33}$/.test(compact)) return true;
  if (/^\d{8,34}$/.test(compact)) return true;
  return compact.length >= 10 && compact.length <= 40 && digitCount >= 8 && digitCount / compact.length >= 0.65;
}

function normalizePhotoCodeCandidate(value: string): string {
  return value.replace(/[^0-9A-Za-z]/g, "").toUpperCase();
}

function isRejectedPhotoCodeCandidate(value: string): boolean {
  const compact = normalizePhotoCodeCandidate(value);
  if (!compact) return true;
  if (/^(DAX7|MDW5|ONT1|CVG9|TYS1|SNE1|AKC1)$/.test(compact)) return true;
  if (/^[A-Z]{3}\d$/.test(compact)) return true;
  if (/^CYCLE\d{1,2}$/.test(compact)) return true;
  if (/^\d{1,2}\/\d{1,2}(?:\/\d{2,4})?$/.test(value.trim())) return true;
  if (/^\d+(?:\.\d+)?\s*(?:LB|LBS|POUND|POUNDS)\b/i.test(value.trim())) return true;
  if (/^\d{5}$/.test(compact)) return true;
  return false;
}

function normalizePhotoBarcodeFormat(format?: string): string {
  return String(format ?? "").trim().toLowerCase().replace(/\s+/g, "_");
}

function scorePhotoBarcodeCandidate(value: string, format?: string): number {
  const trimmed = value.trim();
  if (!trimmed) return -999;
  const normalizedFormat = normalizePhotoBarcodeFormat(format);
  let score = 0;
  if (photoBarcodeValueLooksTrackingLike(trimmed)) score += 90;
  if (/code_?128|code_?39/.test(normalizedFormat)) score += 35;
  if (/pdf_?417|itf|ean|upc|code_?93/.test(normalizedFormat)) score += 12;
  if (/qr/.test(normalizedFormat)) score -= 35;
  if (photoBarcodeValueLooksLikeUrl(trimmed)) score -= 100;
  if (trimmed.length >= 8 && trimmed.length <= 48) score += 8;
  return score;
}

function makePhotoBarcodeCandidate(args: {
  value: string;
  decoder: PhotoBarcodeCandidate["decoder"];
  format?: string;
  variant: string;
}): PhotoBarcodeCandidate | null {
  const value = args.value.trim();
  if (!value) return null;
  return {
    value,
    decoder: args.decoder,
    format: args.format,
    variant: args.variant,
    score: scorePhotoBarcodeCandidate(value, args.format),
  };
}

function chooseBestPhotoBarcodeCandidate(candidates: PhotoBarcodeCandidate[]): PhotoBarcodeCandidate | null {
  let best: PhotoBarcodeCandidate | null = null;
  for (const candidate of candidates) {
    if (!best || candidate.score > best.score) best = candidate;
  }
  return best;
}

function isConfidentShipmentPhotoBarcodeCandidate(candidate: PhotoBarcodeCandidate): boolean {
  return candidate.score >= 55 && !photoBarcodeValueLooksLikeUrl(candidate.value);
}

function normalizePhotoOcrShipmentNumber(value: string): string {
  return value.replace(/\D/g, "");
}

function isValidPhotoOcrShipmentNumber(value: string): boolean {
  return /^\d{7,15}$/.test(value) && !isRejectedPhotoCodeCandidate(value);
}

function extractPhotoOcrShipmentNumbers(raw: string): string[] {
  const text = raw.replace(/\r/g, "\n");
  const sameLinePattern =
    /\b(?:SHIPMENT\s*(?:#|NUMBER|NO\.?|ID)?|WAYBILL|PRO\s*#?|BOL\s*#?)\s*[:#-]?\s*([0-9][0-9\s.,-]{5,25}[0-9])\b/gi;
  const results: string[] = [];
  for (const match of text.matchAll(sameLinePattern)) {
    const value = normalizePhotoOcrShipmentNumber(match[1] ?? "");
    if (isValidPhotoOcrShipmentNumber(value)) results.push(value);
  }

  const labelOnlyPattern = /\b(?:SHIPMENT\s*(?:#|NUMBER\b|NO\.?\b|ID\b)?|WAYBILL|PRO\s*#?|BOL\s*#?)\b/i;
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (!labelOnlyPattern.test(line)) continue;
    const next = lines[i + 1] ?? "";
    const nearby = `${line} ${next}`;
    const number = nearby.match(/\b[0-9][0-9\s.,-]{5,25}[0-9]\b/);
    if (!number) continue;
    const value = normalizePhotoOcrShipmentNumber(number[0]);
    if (isValidPhotoOcrShipmentNumber(value)) results.push(value);
  }

  return uniquePhotoOcrCandidates(results);
}

function extractPhotoOcrPackageTrackingCodes(raw: string): string[] {
  const text = raw.replace(/\r/g, "\n").toUpperCase();
  const candidates: string[] = [];

  for (const match of text.matchAll(/\bTBA\s*[- ]?\s*([\d\s-]{10,30})\b/g)) {
    candidates.push(`TBA${String(match[1] ?? "").replace(/\D/g, "")}`);
  }

  const explicitPatterns = [
    /\b1Z[0-9A-Z\s-]{10,30}\b/g,
    /\bVRET[0-9A-Z\s-]{6,30}\b/g,
  ];
  for (const pattern of explicitPatterns) {
    for (const match of text.matchAll(pattern)) {
      candidates.push(normalizePhotoCodeCandidate(match[0] ?? ""));
    }
  }

  const labeledPattern =
    /\b(?:TRACKING\s*NUMBER|TRACKING\s*#|TRACKING|PACKAGE\s*ID|PACKAGE\s*#|PACKAGE|PKG\s*ID|PKG\s*#|BARCODE)\s*[:#-]?\s*([A-Z0-9][A-Z0-9\s-]{8,39})\b/g;
  for (const match of text.matchAll(labeledPattern)) {
    const value = normalizePhotoCodeCandidate(match[1] ?? "");
    if (isPhotoOcrPackageTrackingCandidate(value)) candidates.push(value);
  }

  return uniquePhotoOcrCandidates(candidates.filter(isPhotoOcrPackageTrackingCandidate));
}

function isPhotoOcrPackageTrackingCandidate(value: string): boolean {
  const compact = normalizePhotoCodeCandidate(value);
  if (isRejectedPhotoCodeCandidate(compact)) return false;
  if (/^TBA\d{10,20}$/.test(compact)) return true;
  if (/^1Z[0-9A-Z]{10,30}$/.test(compact)) return true;
  if (/^VRET[0-9A-Z]{6,30}$/.test(compact)) return true;
  if (/^9\d{10,33}$/.test(compact)) return true;
  const digitCount = (compact.match(/\d/g) ?? []).length;
  return compact.length >= 12 && compact.length <= 40 && /[A-Z]/.test(compact) && digitCount >= 6;
}

function uniquePhotoOcrCandidates(candidates: string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const candidate of candidates) {
    const normalized = normalizePhotoCodeCandidate(candidate);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    unique.push(normalized);
  }
  return unique;
}

function extractPhotoOcrCodeCandidates(text: string): string[] {
  return uniquePhotoOcrCandidates([
    ...extractPhotoOcrPackageTrackingCodes(text),
    ...extractPhotoOcrShipmentNumbers(text),
  ]).slice(0, 3);
}

async function withPhotoBarcodeAttemptTimeout<T>(label: string, promise: Promise<T>, timeoutMs = 1800): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

function waitForPhotoBarcodeImageLoad(img: HTMLImageElement): Promise<void> {
  if (img.complete && img.naturalWidth > 0 && img.naturalHeight > 0) return Promise.resolve();

  return new Promise((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error("Image failed to load before barcode decode."));
  });
}

async function detectBarcodeWithNativeDetector(
  img: HTMLImageElement,
  variant = "original",
): Promise<PhotoBarcodeCandidate[]> {
  const ctor = getNativeBarcodeDetectorCtor();
  if (!ctor) {
    logPhotoBarcodeDecodeDebug("decoder unavailable", { decoder: "BarcodeDetector" });
    return [];
  }

  try {
    const detector = await createNativeBarcodeDetector(ctor);
    logPhotoBarcodeDecodeDebug("decoder attempted", { decoder: "BarcodeDetector", variant });
    const detected = await withPhotoBarcodeAttemptTimeout("BarcodeDetector", detector.detect(img), 2200);
    const candidates = detected
      .map((barcode) =>
        makePhotoBarcodeCandidate({
          value: barcode.rawValue ?? "",
          decoder: "BarcodeDetector",
          format: barcode.format,
          variant,
        }),
      )
      .filter((candidate): candidate is PhotoBarcodeCandidate => Boolean(candidate));
    logPhotoBarcodeDecodeDebug("decoder result", {
      decoder: "BarcodeDetector",
      variant,
      detectedCount: detected.length,
      candidates: candidates.map((candidate) => ({
        value: candidate.value,
        format: candidate.format,
        score: candidate.score,
      })),
    });
    return candidates;
  } catch (err) {
    logPhotoBarcodeDecodeError("BarcodeDetector", err);
    return [];
  }
}

async function createZxingPhotoBarcodeReader(): Promise<ZxingPhotoBarcodeReader> {
  const [{ BrowserMultiFormatReader }, { BarcodeFormat, DecodeHintType }] = await Promise.all([
    import("@zxing/browser"),
    import("@zxing/library"),
  ]);
  const hints = new Map();
  hints.set(DecodeHintType.POSSIBLE_FORMATS, [
    BarcodeFormat.CODE_128,
    BarcodeFormat.CODE_39,
    BarcodeFormat.CODE_93,
    BarcodeFormat.EAN_13,
    BarcodeFormat.EAN_8,
    BarcodeFormat.UPC_A,
    BarcodeFormat.UPC_E,
    BarcodeFormat.ITF,
    BarcodeFormat.QR_CODE,
    BarcodeFormat.DATA_MATRIX,
    BarcodeFormat.PDF_417,
  ]);
  hints.set(DecodeHintType.TRY_HARDER, true);
  hints.set(DecodeHintType.ENABLE_CODE_39_EXTENDED_MODE, true);
  const formatNames = new Map<unknown, string>([
    [BarcodeFormat.CODE_128, "code_128"],
    [BarcodeFormat.CODE_39, "code_39"],
    [BarcodeFormat.CODE_93, "code_93"],
    [BarcodeFormat.EAN_13, "ean_13"],
    [BarcodeFormat.EAN_8, "ean_8"],
    [BarcodeFormat.UPC_A, "upc_a"],
    [BarcodeFormat.UPC_E, "upc_e"],
    [BarcodeFormat.ITF, "itf"],
    [BarcodeFormat.QR_CODE, "qr_code"],
    [BarcodeFormat.DATA_MATRIX, "data_matrix"],
    [BarcodeFormat.PDF_417, "pdf417"],
  ]);
  return {
    reader: new BrowserMultiFormatReader(hints),
    formatName: (format: unknown) => formatNames.get(format) ?? (typeof format === "string" ? format : undefined),
  };
}

async function detectBarcodeWithZxingImageElement(
  zxing: ZxingPhotoBarcodeReader,
  img: HTMLImageElement,
  variant = "original",
): Promise<PhotoBarcodeCandidate | null> {
  try {
    logPhotoBarcodeDecodeDebug("decoder attempted", { decoder: "ZXing:imageElement", variant });
    const result = await withPhotoBarcodeAttemptTimeout(
      `ZXing:imageElement ${variant}`,
      zxing.reader.decodeFromImageElement(img),
    );
    const value = result.getText().trim();
    const format = zxing.formatName(result.getBarcodeFormat?.());
    const candidate = makePhotoBarcodeCandidate({ value, decoder: "ZXing", format, variant });
    logPhotoBarcodeDecodeDebug("decoder result", {
      decoder: "ZXing:imageElement",
      variant,
      detectedCount: value ? 1 : 0,
      format,
      score: candidate?.score,
    });
    return candidate;
  } catch (err) {
    logPhotoBarcodeDecodeError("ZXing:imageElement", err);
    return null;
  }
}

async function detectBarcodeWithZxingImageUrl(
  zxing: ZxingPhotoBarcodeReader,
  objectUrl: string,
  variant = "original",
): Promise<PhotoBarcodeCandidate | null> {
  try {
    if (typeof zxing.reader.decodeFromImageUrl !== "function") {
      logPhotoBarcodeDecodeDebug("decoder unavailable", { decoder: "ZXing:imageUrl" });
      return null;
    }
    logPhotoBarcodeDecodeDebug("decoder attempted", { decoder: "ZXing:imageUrl", variant });
    const result = await withPhotoBarcodeAttemptTimeout(
      `ZXing:imageUrl ${variant}`,
      zxing.reader.decodeFromImageUrl(objectUrl),
    );
    const value = result.getText().trim();
    const format = zxing.formatName(result.getBarcodeFormat?.());
    const candidate = makePhotoBarcodeCandidate({ value, decoder: "ZXing", format, variant });
    logPhotoBarcodeDecodeDebug("decoder result", {
      decoder: "ZXing:imageUrl",
      variant,
      detectedCount: value ? 1 : 0,
      format,
      score: candidate?.score,
    });
    return candidate;
  } catch (err) {
    logPhotoBarcodeDecodeError("ZXing:imageUrl", err);
    return null;
  }
}

function buildPhotoBarcodeVariants(): PhotoBarcodeVariant[] {
  const crops: PhotoBarcodeCropName[] = ["full", "top35", "bottom35", "centerBand"];
  const variants: PhotoBarcodeVariant[] = [
    {
      name: "full:rot0:resized:max1800",
      crop: "full",
      rotationDeg: 0,
      grayscaleContrast: false,
      maxWidth: 1800,
    },
  ];

  for (const crop of crops) {
    variants.push({
      name: `${crop}:rot0:contrast:max1800`,
      crop,
      rotationDeg: 0,
      grayscaleContrast: true,
      maxWidth: 1800,
    });
  }

  for (const rotationDeg of [90, 180, 270]) {
    variants.push({
      name: `full:rot${rotationDeg}:contrast:max1800`,
      crop: "full",
      rotationDeg,
      grayscaleContrast: true,
      maxWidth: 1800,
    });
  }

  for (const crop of crops) {
    for (const rotationDeg of [-10, -5, 5, 10]) {
      variants.push({
        name: `${crop}:rot${rotationDeg}:contrast:max1800`,
        crop,
        rotationDeg,
        grayscaleContrast: true,
        maxWidth: 1800,
      });
    }
  }

  return variants;
}

function photoBarcodeCropRect(
  img: HTMLImageElement,
  crop: PhotoBarcodeCropName,
): { sx: number; sy: number; sw: number; sh: number } {
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  if (crop === "top35") return { sx: 0, sy: 0, sw: w, sh: Math.max(1, Math.round(h * 0.35)) };
  if (crop === "bottom35") {
    const sh = Math.max(1, Math.round(h * 0.35));
    return { sx: 0, sy: Math.max(0, h - sh), sw: w, sh };
  }
  if (crop === "centerBand") {
    const sh = Math.max(1, Math.round(h * 0.5));
    return { sx: 0, sy: Math.max(0, Math.round((h - sh) / 2)), sw: w, sh };
  }
  return { sx: 0, sy: 0, sw: w, sh: h };
}

function applyPhotoBarcodeGrayscaleContrast(canvas: HTMLCanvasElement): void {
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return;
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = imageData.data;
  for (let i = 0; i < data.length; i += 4) {
    const gray = data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
    const boosted = Math.max(0, Math.min(255, (gray - 128) * 1.55 + 128));
    data[i] = boosted;
    data[i + 1] = boosted;
    data[i + 2] = boosted;
  }
  ctx.putImageData(imageData, 0, 0);
}

function renderPhotoBarcodeVariantCanvas(img: HTMLImageElement, variant: PhotoBarcodeVariant): HTMLCanvasElement | null {
  const crop = photoBarcodeCropRect(img, variant.crop);
  const scale = Math.min(1, variant.maxWidth / Math.max(1, crop.sw));
  const srcW = Math.max(1, Math.round(crop.sw * scale));
  const srcH = Math.max(1, Math.round(crop.sh * scale));
  const radians = (variant.rotationDeg * Math.PI) / 180;
  const absCos = Math.abs(Math.cos(radians));
  const absSin = Math.abs(Math.sin(radians));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.ceil(srcW * absCos + srcH * absSin));
  canvas.height = Math.max(1, Math.ceil(srcW * absSin + srcH * absCos));
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.rotate(radians);
  ctx.drawImage(img, crop.sx, crop.sy, crop.sw, crop.sh, -srcW / 2, -srcH / 2, srcW, srcH);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  if (variant.grayscaleContrast) applyPhotoBarcodeGrayscaleContrast(canvas);
  return canvas;
}

function canvasToPhotoBarcodeBlob(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob), "image/jpeg", 0.92);
  });
}

async function decodePhotoBarcodeCanvasVariant(
  zxing: ZxingPhotoBarcodeReader,
  img: HTMLImageElement,
  variant: PhotoBarcodeVariant,
): Promise<PhotoBarcodeCandidate | null> {
  logPhotoBarcodeDecodeDebug("variant attempted", {
    variant: variant.name,
    crop: variant.crop,
    rotationDeg: variant.rotationDeg,
    grayscaleContrast: variant.grayscaleContrast,
    decoder: "ZXing",
  });
  const canvas = renderPhotoBarcodeVariantCanvas(img, variant);
  if (!canvas || typeof URL === "undefined" || typeof URL.createObjectURL !== "function") return null;
  const blob = await canvasToPhotoBarcodeBlob(canvas);
  if (!blob) return null;
  const objectUrl = URL.createObjectURL(blob);
  const variantImg = new Image();
  try {
    variantImg.src = objectUrl;
    await withPhotoBarcodeAttemptTimeout(`imageLoad ${variant.name}`, waitForPhotoBarcodeImageLoad(variantImg), 1200);
    logPhotoBarcodeDecodeDebug("variant image loaded", {
      variant: variant.name,
      width: variantImg.naturalWidth,
      height: variantImg.naturalHeight,
    });
    return await detectBarcodeWithZxingImageElement(zxing, variantImg, variant.name);
  } catch (err) {
    logPhotoBarcodeDecodeError("canvasVariant", err);
    return null;
  } finally {
    variantImg.onload = null;
    variantImg.onerror = null;
    URL.revokeObjectURL(objectUrl);
  }
}

async function recognizePhotoBarcodeOcrText(blob: Blob, variantName: string): Promise<string> {
  try {
    const { recognize } = await import("tesseract.js");
    logPhotoBarcodeDecodeDebug("ocr attempted", { decoder: "Tesseract", variant: variantName });
    const result = await withPhotoBarcodeAttemptTimeout(
      `Tesseract ${variantName}`,
      recognize(blob, "eng"),
      6500,
    );
    const text = String(result.data?.text ?? "");
    logPhotoBarcodeDecodeDebug("ocr result", {
      decoder: "Tesseract",
      variant: variantName,
      textLength: text.length,
      candidates: extractPhotoOcrCodeCandidates(text),
    });
    return text;
  } catch (err) {
    logPhotoBarcodeDecodeError("canvasVariant", err);
    return "";
  }
}

async function detectPhotoOcrCandidatesFromImage(img: HTMLImageElement): Promise<string[]> {
  const variants: PhotoBarcodeVariant[] = [
    {
      name: "ocr:full:rot0:contrast:max1800",
      crop: "full",
      rotationDeg: 0,
      grayscaleContrast: true,
      maxWidth: 1800,
    },
    {
      name: "ocr:top35:rot0:contrast:max1800",
      crop: "top35",
      rotationDeg: 0,
      grayscaleContrast: true,
      maxWidth: 1800,
    },
    {
      name: "ocr:bottom35:rot0:contrast:max1800",
      crop: "bottom35",
      rotationDeg: 0,
      grayscaleContrast: true,
      maxWidth: 1800,
    },
    {
      name: "ocr:centerBand:rot0:contrast:max1800",
      crop: "centerBand",
      rotationDeg: 0,
      grayscaleContrast: true,
      maxWidth: 1800,
    },
  ];

  for (const variant of variants) {
    logPhotoBarcodeDecodeDebug("ocr variant attempted", {
      variant: variant.name,
      crop: variant.crop,
      rotationDeg: variant.rotationDeg,
    });
    const canvas = renderPhotoBarcodeVariantCanvas(img, variant);
    if (!canvas) continue;
    const blob = await canvasToPhotoBarcodeBlob(canvas);
    if (!blob) continue;
    const text = await recognizePhotoBarcodeOcrText(blob, variant.name);
    const candidates = extractPhotoOcrCodeCandidates(text);
    if (candidates.length > 0) return candidates;
  }

  return [];
}

async function detectBarcodeFromImageFile(file: File): Promise<PhotoBarcodeDecodeResult> {
  if (typeof URL === "undefined" || typeof URL.createObjectURL !== "function") return { status: "not_found" };

  const objectUrl = URL.createObjectURL(file);
  const img = new Image();
  const candidates: PhotoBarcodeCandidate[] = [];
  const variants = buildPhotoBarcodeVariants();

  logPhotoBarcodeDecodeDebug("file selected", {
    fileName: file.name,
    fileType: file.type,
    fileSize: file.size,
    variantsPlanned: variants.map((variant) => variant.name),
  });

  try {
    img.src = objectUrl;
    try {
      await waitForPhotoBarcodeImageLoad(img);
      logPhotoBarcodeDecodeDebug("image loaded", {
        naturalWidth: img.naturalWidth,
        naturalHeight: img.naturalHeight,
      });
    } catch (err) {
      logPhotoBarcodeDecodeError("imageLoad", err);
      return { status: "not_found" };
    }

    const nativeCandidates = await detectBarcodeWithNativeDetector(img, "original");
    candidates.push(...nativeCandidates);
    const bestNative = chooseBestPhotoBarcodeCandidate(nativeCandidates);
    if (bestNative && isConfidentShipmentPhotoBarcodeCandidate(bestNative)) {
      logPhotoBarcodeDecodeDebug("selected barcode", bestNative);
      return { status: "detected", value: bestNative.value };
    }

    let zxing: ZxingPhotoBarcodeReader;
    try {
      zxing = await createZxingPhotoBarcodeReader();
    } catch (err) {
      logPhotoBarcodeDecodeError("ZXing:imageElement", err);
      const fallback = chooseBestPhotoBarcodeCandidate(candidates);
      if (!fallback || photoBarcodeValueLooksLikeUrl(fallback.value)) {
        const ocrCandidates = await detectPhotoOcrCandidatesFromImage(img);
        if (ocrCandidates.length > 0) return { status: "ocr_candidates", candidates: ocrCandidates };
      }
      return fallback && isConfidentShipmentPhotoBarcodeCandidate(fallback)
        ? { status: "detected", value: fallback.value }
        : { status: "not_found" };
    }

    const zxingElementCandidate = await detectBarcodeWithZxingImageElement(zxing, img, "original");
    if (zxingElementCandidate) {
      candidates.push(zxingElementCandidate);
      if (isConfidentShipmentPhotoBarcodeCandidate(zxingElementCandidate)) {
        logPhotoBarcodeDecodeDebug("selected barcode", zxingElementCandidate);
        return { status: "detected", value: zxingElementCandidate.value };
      }
    }

    const zxingUrlCandidate = await detectBarcodeWithZxingImageUrl(zxing, objectUrl, "original:url");
    if (zxingUrlCandidate) {
      candidates.push(zxingUrlCandidate);
      if (isConfidentShipmentPhotoBarcodeCandidate(zxingUrlCandidate)) {
        logPhotoBarcodeDecodeDebug("selected barcode", zxingUrlCandidate);
        return { status: "detected", value: zxingUrlCandidate.value };
      }
    }

    for (const variant of variants) {
      const candidate = await decodePhotoBarcodeCanvasVariant(zxing, img, variant);
      if (!candidate) continue;
      candidates.push(candidate);
      if (isConfidentShipmentPhotoBarcodeCandidate(candidate)) {
        logPhotoBarcodeDecodeDebug("selected barcode", candidate);
        return { status: "detected", value: candidate.value };
      }
    }

    const fallback = chooseBestPhotoBarcodeCandidate(candidates);
    if (fallback && photoBarcodeValueLooksLikeUrl(fallback.value)) {
      const ocrCandidates = await detectPhotoOcrCandidatesFromImage(img);
      if (ocrCandidates.length > 0) return { status: "ocr_candidates", candidates: ocrCandidates };
    }

    if (fallback && isConfidentShipmentPhotoBarcodeCandidate(fallback)) {
      logPhotoBarcodeDecodeDebug("selected fallback barcode", fallback);
      return { status: "detected", value: fallback.value };
    }

    const ocrCandidates = await detectPhotoOcrCandidatesFromImage(img);
    if (ocrCandidates.length > 0) {
      logPhotoBarcodeDecodeDebug("selected ocr candidates", { candidates: ocrCandidates });
      return { status: "ocr_candidates", candidates: ocrCandidates };
    }

    logPhotoBarcodeDecodeDebug("all decoders failed", {
      attemptedVariants: variants.map((variant) => variant.name),
    });
    return { status: "not_found" };
  } finally {
    img.onload = null;
    img.onerror = null;
    URL.revokeObjectURL(objectUrl);
  }
}

function identifyGateMatchFieldUiLabel(field: ShipmentEntryItemViewMatchField): string {
  switch (field) {
    case "order_id":
      return "Order ID";
    case "tracking_number":
      return "Tracking number";
    case "id_slip_contents":
    case "slip_code":
      return "Slip ID";
    case "package_code":
      return "Package code";
    case "pallet_code":
      return "Pallet code";
    case "container_code":
      return "Container code";
    case "lpn":
      return "LPN";
    case "fnsku":
      return "FNSKU";
    case "sku":
      return "SKU";
    default:
      return "Code";
  }
}

type InspectionCondition = "good" | "damaged" | "expired" | "open_box" | "missing_parts";

/** Item-scan unit modal: slip-linked, EP-only, or unexpected unit. */
const EMPTY_PRODUCT_NAME_LOOKUP = new Map<string, string>();

function slipRowProductLinkage(
  slip: Pick<OperatorSlipContentsListRow, "product_linkage">,
): ProductLinkageDisplayContract {
  return slip.product_linkage;
}

function productLinkagePrimaryIsUnmapped(linkage: ProductLinkageDisplayContract): boolean {
  return productLinkageOperatorPrimaryDisplayLabel(linkage) === PRODUCT_LINKAGE_UNMAPPED_LABEL;
}

/** Prefer Box Info / carryover preview linkage when DB slip row is still unmapped. */
function mergeSlipRowWithStrongerPreviewLinkage(
  row: OperatorSlipContentsListRow,
  preview: ProductLinkageDisplayContract | undefined,
): OperatorSlipContentsListRow {
  if (!preview || productLinkagePrimaryIsUnmapped(preview)) return row;
  if (productLinkagePrimaryIsUnmapped(row.product_linkage)) {
    return { ...row, product_linkage: preview };
  }
  if (!row.product_linkage.product_name?.trim() && preview.product_name?.trim()) {
    return { ...row, product_linkage: preview };
  }
  if (!row.product_linkage.resolved_product_id?.trim() && preview.resolved_product_id?.trim()) {
    return { ...row, product_linkage: preview };
  }
  return row;
}

function slipInspectionRowsWithMergedPreviewLinkages(
  dbRows: OperatorSlipContentsListRow[],
  previewLinkages: ProductLinkageDisplayContract[],
): OperatorSlipContentsListRow[] {
  if (!dbRows.length) return dbRows;
  if (!previewLinkages.length) return dbRows;
  return dbRows.map((row, i) => mergeSlipRowWithStrongerPreviewLinkage(row, previewLinkages[i]));
}

function dbSlipRowHasCatalogLinkage(row: OperatorSlipContentsListRow): boolean {
  const l = row.product_linkage;
  return Boolean(l.resolved_product_id?.trim() && l.product_name?.trim());
}

/** Stable key for matching BOX slip line ↔ carryover preview row. */
function slipInspectionLineMatchKey(row: {
  fnsku?: string | null;
  upc?: string | null;
  description?: string | null;
}): string {
  const f = String(row.fnsku ?? "").trim().toLowerCase();
  if (f.length >= 4) return `fnsku:${f}`;
  const upcDigits = String(row.upc ?? "").replace(/\D/g, "");
  if (upcDigits.length >= 8) return `upc:${upcDigits}`;
  const d = String(row.description ?? "").trim().toLowerCase();
  if (d.length >= 4) return `desc:${d.slice(0, 80)}`;
  return "";
}

function findCarryoverPreviewLinkageForDbRow(
  dbRow: OperatorSlipContentsListRow,
  carryoverRows: OperatorSlipContentsListRow[],
  index: number,
): ProductLinkageDisplayContract | undefined {
  const key = slipInspectionLineMatchKey(dbRow);
  if (key) {
    const hit = carryoverRows.find((r) => slipInspectionLineMatchKey(r) === key);
    if (hit) return hit.product_linkage;
  }
  return carryoverRows[index]?.product_linkage;
}

function mergeDbSlipRowsWithCarryoverPreview(
  dbRows: OperatorSlipContentsListRow[],
  carryoverRows: OperatorSlipContentsListRow[],
): OperatorSlipContentsListRow[] {
  if (!dbRows.length) return dbRows;
  if (!carryoverRows.length) return dbRows;
  return dbRows.map((row, i) => {
    if (dbSlipRowHasCatalogLinkage(row)) return row;
    const preview = findCarryoverPreviewLinkageForDbRow(row, carryoverRows, i);
    return mergeSlipRowWithStrongerPreviewLinkage(row, preview);
  });
}

type ItemScanSlipCarryoverPayload = {
  packageId: string;
  rows: OperatorSlipContentsListRow[];
};

function snapshotItemScanSlipCarryoverFromBoxIntake(
  packageId: string,
  visionLines: BoxSlipVisionLine[],
  linkages: ProductLinkageDisplayContract[],
): ItemScanSlipCarryoverPayload {
  const pid = String(packageId ?? "").trim();
  const lines = clonePersistBoxSlipVisionLines(visionLines);
  const linkSnap = linkages.length >= lines.length ? linkages : linkages.slice(0, lines.length);
  const paddedLinkages: ProductLinkageDisplayContract[] = lines.map(
    (_, i) =>
      linkSnap[i] ??
      buildProductLinkageDisplayContract(
        {
          fnsku: lines[i]?.fnsku,
          upc: lines[i]?.upc,
          description: lines[i]?.description,
        },
        EMPTY_PRODUCT_NAME_LOOKUP,
      ),
  );
  return {
    packageId: pid,
    rows: slipRowsFromBoxSlipVision(lines, paddedLinkages),
  };
}

/** Map BOX slip vision rows + preview linkages into item-scan slip row shape. */
function slipRowsFromBoxSlipVision(
  lines: BoxSlipVisionLine[],
  linkages: ProductLinkageDisplayContract[],
): OperatorSlipContentsListRow[] {
  return lines.map((v, i) => {
    const description = v.description?.trim() ? v.description.trim() : null;
    const upc = v.upc?.trim() ? v.upc.trim() : null;
    const fnsku = v.fnsku?.trim() ? v.fnsku.trim() : null;
    const previewLinkage = linkages[i];
    return {
      id: null,
      upc,
      fnsku,
      description,
      quantity: Math.max(0, Math.floor(Number(v.expected_qty ?? 0))),
      condition: v.condition?.trim() ? v.condition.trim() : null,
      rma_number: null,
      sort_index: i,
      slip_code: null,
      order_id: null,
      conflicting_order_id: null,
      product_linkage:
        previewLinkage ??
        buildProductLinkageDisplayContract(
          { description, fnsku, upc },
          EMPTY_PRODUCT_NAME_LOOKUP,
        ),
    };
  });
}

function productLinkageForSlipMatch(
  slip: SlipBarcodeMatchRow | null,
  lines: OperatorSlipContentsListRow[],
): ProductLinkageDisplayContract | null {
  if (!slip) return null;
  const sid = slip.id && isUuidString(String(slip.id)) ? String(slip.id) : null;
  if (sid) {
    const full = lines.find((r) => r.id === sid);
    if (full) return full.product_linkage;
  }
  return buildProductLinkageDisplayContract(
    { description: slip.description, fnsku: slip.fnsku, upc: slip.upc },
    EMPTY_PRODUCT_NAME_LOOKUP,
  );
}

type ItemUnitModalContext = {
  mode: "create" | "edit";
  returnItemId?: string;
  scannedBarcode: string;
  slip: SlipBarcodeMatchRow | null;
  slipContentId: string | null;
  slipDescription: string | null;
  productLinkage: ProductLinkageDisplayContract | null;
  title: string;
  subtitle: string | null;
  initialState?: ItemUnitRecordModalInitialState | null;
  /**
   * When set, used as persisted match kind (EP / unexpected).
   * When null, match kind is derived from slip + scanned barcode on save.
   */
  matchKindPreset: "fnsku" | "upc" | "unexpected" | null;
};

type ItemScanEditPick = {
  kind: "slip_cell" | "unexpected";
  cellKey?: string;
  slipContentId?: string;
  rowTitle: string;
  rowSubtitle: string | null;
};

function packageItemsForSlipContentId(
  rows: OperatorPackageItemRow[],
  slipContentId: string,
): OperatorPackageItemRow[] {
  const sid = slipContentId.trim();
  if (!sid) return [];
  return rows.filter((u) => String(u.slip_content_id ?? "").trim() === sid);
}

function packageItemsUnexpected(rows: OperatorPackageItemRow[]): OperatorPackageItemRow[] {
  return rows.filter((u) => !String(u.slip_content_id ?? "").trim());
}

function itemScanEditPickMetaFromSlip(
  slip: Pick<OperatorSlipContentsListRow, "product_linkage" | "fnsku" | "upc">,
): { rowTitle: string; rowSubtitle: string | null } {
  const linkage = slipRowProductLinkage(slip);
  const rowTitle = productLinkageOperatorPrimaryDisplayLabel(linkage);
  const fnsku = slip.fnsku?.trim();
  const upc = slip.upc?.trim();
  const rowSubtitle = fnsku ? `FNSKU ${fnsku}` : upc ? `UPC ${upc}` : null;
  return { rowTitle, rowSubtitle };
}

function itemScanRowEditInteractProps(
  editable: boolean,
  selected: boolean,
  onActivate: () => void,
): {
  role?: "button";
  tabIndex?: number;
  onClick?: () => void;
  onKeyDown?: (e: React.KeyboardEvent) => void;
  className: string;
} {
  if (!editable) {
    return { className: "" };
  }
  return {
    role: "button",
    tabIndex: 0,
    onClick: onActivate,
    onKeyDown: (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        onActivate();
      }
    },
    className: selected
      ? "cursor-pointer ring-2 ring-[rgba(214,183,110,0.55)]"
      : "cursor-pointer hover:ring-1 hover:ring-[rgba(214,183,110,0.32)]",
  };
}

function operatorPackageItemRowToModalInitial(unit: OperatorPackageItemRow): ItemUnitRecordModalInitialState {
  const tags = filterPackageItemDiscrepancyTags(unit.discrepancy_tags);
  const selectedTags = normalizeItemUnitDiscrepancySelection(
    tags.length ? (tags as ItemUnitDiscrepancyTagKey[]) : [ITEM_UNIT_SELLABLE_OK_TAG],
  );
  const expiry = unit.expiry_date?.trim() ?? "";
  const hasExpired = selectedTags.includes("expired");
  return {
    selectedTags,
    expiryDate: expiry,
    lotNumber: unit.lot_number?.trim() ?? "",
    noExpiryChecked: !expiry && !hasExpired,
    evidenceUrls: [...(unit.evidence_urls ?? [])],
    optionalItemPhotoUrl: unit.optional_item_photo_url,
    operatorNotes: unit.operator_notes ?? "",
  };
}

function inspectionConditionToClaims(c: InspectionCondition): string[] {
  switch (c) {
    case "good":
      return [];
    case "damaged":
      return ["damaged_warehouse"];
    case "expired":
      return ["expired"];
    case "open_box":
      return ["damaged_box"];
    case "missing_parts":
      return ["missing_parts"];
    default:
      return [];
  }
}

/** Primary label: expected_packages has no product_name — use SKU / FNSKU. */
function epPackageRowPrimaryLabel(row: Record<string, unknown>): string {
  const sku = String(row.sku ?? "").trim();
  const fnsku = String(row.fnsku ?? "").trim();
  const parts = [sku, fnsku].filter(Boolean);
  return parts.length ? parts.join(" · ") : "—";
}

/** Optional catalog line when products join / enrich attached `products.product_name`. */
function epPackageRowCatalogSubtitle(row: Record<string, unknown>): string | null {
  const prod = row.products as { product_name?: string } | null | undefined;
  const name = prod?.product_name?.trim();
  return name || null;
}

function itemResolveTierToPackageMatchKind(tier: ItemResolveTier): "fnsku" | "upc" | "unexpected" {
  if (tier === "fnsku") return "fnsku";
  if (tier === "upc") return "upc";
  return "unexpected";
}

/** Description string for perishable heuristic when there is no slip row (EP match). */
function epRowToSlipDescriptionForItemModal(row: Record<string, unknown>): string | null {
  const sub = epPackageRowCatalogSubtitle(row)?.trim();
  if (sub) return sub;
  const primary = epPackageRowPrimaryLabel(row);
  return primary !== "—" ? primary : null;
}

type IdentifyGateEntity = "pallet" | "package" | "item" | "single_box";
type IdentifyGatePhase = "idle" | "searching" | "matched" | "new";

/** Cap Shipment Entry inventory view reads so the gate cannot spin indefinitely on slow staging. */
const IDENTIFY_GATE_LOOKUP_TIMEOUT_MS = 22_000;

async function withIdentifyGateLookupTimeout<T>(
  promise: Promise<T>,
  timeoutMs = IDENTIFY_GATE_LOOKUP_TIMEOUT_MS,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                `Inventory status lookup timed out after ${Math.round(timeoutMs / 1000)}s`,
              ),
            ),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
type ShipmentEntryItemViewMatchField =
  | InventoryViewMatchField
  | "order_id"
  | "slip_code"
  | "package_code"
  | "pallet_code"
  | "container_code"
  | "lpn";

function identifyGateEntityForManifestMatch(
  matchField: ShipmentEntryItemViewMatchField | null,
  matchStatus: string,
): IdentifyGateEntity {
  if (matchStatus === "found_pallet") return "pallet";
  if (matchField === "tracking_number" || matchField === "pallet_code") return "pallet";
  if (matchField === "package_code" || matchField === "slip_code" || matchField === "id_slip_contents") {
    return "package";
  }
  return "single_box";
}

/** Gate physical box count: empty, zero, or non-numeric → invalid (must be ≥ 1 when required). */
function parseMandatoryGateBoxCount(raw: string): { valid: true; n: number } | { valid: false } {
  const digits = String(raw ?? "").replace(/\D/g, "");
  if (digits === "") return { valid: false };
  const n = Number.parseInt(digits, 10);
  if (Number.isNaN(n) || n < 1) return { valid: false };
  return { valid: true, n };
}

function summarizeExpectedPackageRowsForGate(rows: Record<string, unknown>[]): {
  productName: string;
  skuLabel: string;
  asinLabel: string;
  totalExpectedQty: number;
} {
  let totalExpectedQty = 0;
  const skus = new Set<string>();
  const asins = new Set<string>();
  const names = new Set<string>();
  for (const r of rows) {
    totalExpectedQty += Number((r as { expected_scan_quantity?: number }).expected_scan_quantity ?? 0) || 0;
    const sku = String((r as { sku?: string }).sku ?? "").trim();
    if (sku) skus.add(sku);
    const asin = String((r as { asin?: string | null }).asin ?? "").trim();
    if (asin) asins.add(asin);
    const nm = epPackageRowCatalogSubtitle(r)?.trim();
    if (nm) names.add(nm);
  }
  const productName =
    names.size === 0 ? "—" : names.size === 1 ? [...names][0]! : `${names.size} products`;
  const skuLabel = skus.size === 0 ? "—" : skus.size === 1 ? [...skus][0]! : `${skus.size} SKUs`;
  const asinLabel = asins.size === 0 ? "—" : asins.size === 1 ? [...asins][0]! : `${asins.size} ASINs`;
  return { productName, skuLabel, asinLabel, totalExpectedQty };
}

function pickInventoryViewHints(rows: VInventoryStatusRow[]): {
  productName: string | null;
  carrier: string | null;
  slipCode: string | null;
} {
  let productName: string | null = null;
  let carrier: string | null = null;
  let slipCode: string | null = null;
  for (const r of rows) {
    if (!productName) {
      const nm = r.product_display_name?.trim() || r.product_name?.trim();
      if (nm) productName = nm;
    }
    if (!carrier && r.carrier?.trim()) carrier = r.carrier.trim();
    if (!slipCode && r.id_slip_contents?.trim()) slipCode = r.id_slip_contents.trim();
    if (productName && carrier && slipCode) break;
  }
  return { productName, carrier, slipCode };
}

function inventoryLineDisplayName(line: VInventoryStatusRow): string | null {
  return line.product_display_name?.trim() || line.product_name?.trim() || null;
}

function collectGateProductNamesFromLines(
  epRows: Record<string, unknown>[],
  shipmentLines: VInventoryStatusRow[],
): Map<string, string> {
  const names = new Map<string, string>();
  for (const line of shipmentLines) {
    for (const key of [line.resolved_product_id, line.product_id, line.resolved_catalog_product_id]) {
      const id = String(key ?? "").trim();
      const nm = inventoryLineDisplayName(line);
      if (isUuidString(id) && nm) names.set(id, nm);
    }
  }
  for (const raw of epRows) {
    const id = deriveExpectedPackageEffectiveProductId(raw);
    const nm = epPackageRowCatalogSubtitle(raw)?.trim();
    if (id && isUuidString(id) && nm) names.set(id, nm);
  }
  return names;
}

function collectGateResolvedProductIds(
  epRows: Record<string, unknown>[],
  shipmentLines: VInventoryStatusRow[],
): string[] {
  const ids = new Set<string>();
  for (const raw of epRows) {
    const id = deriveExpectedPackageEffectiveProductId(raw);
    if (id && isUuidString(id)) ids.add(id);
  }
  for (const line of shipmentLines) {
    for (const key of [line.resolved_product_id, line.product_id, line.resolved_catalog_product_id]) {
      const id = String(key ?? "").trim();
      if (isUuidString(id)) ids.add(id);
    }
  }
  return [...ids];
}

function gateEpRowForInventoryLine(
  row: VInventoryStatusRow,
  byId: Map<string, Record<string, unknown>>,
  bySkuFnsku: Map<string, Record<string, unknown>>,
): Record<string, unknown> | undefined {
  const byPk = byId.get(row.expected_package_id);
  if (byPk) return byPk;
  return bySkuFnsku.get(
    `${(row.sku ?? "").trim().toLowerCase()}\u0000${(row.fnsku ?? "").trim().toLowerCase()}\u0000${(row.order_id ?? "").trim().toLowerCase()}`,
  );
}

function firstNonEmptyString(values: unknown[]): string | null {
  for (const value of values) {
    const text = String(value ?? "").trim();
    if (text) return text;
  }
  return null;
}

function firstRecordString(records: Array<Record<string, unknown> | null | undefined>, keys: string[]): string | null {
  for (const record of records) {
    if (!record) continue;
    for (const key of keys) {
      const text = String(record[key] ?? "").trim();
      if (text) return text;
    }
  }
  return null;
}

function recordFromResolveResult(result: OperatorResolveResult | null): Record<string, unknown> | null {
  if (!result || result.kind === "unknown") return null;
  return result.row as Record<string, unknown>;
}

function countLookupExpectedPackages(
  shipmentLines: VInventoryStatusRow[],
  detailRows: Record<string, unknown>[],
  fallbackRowCount?: number | null,
): number | null {
  const ids = new Set<string>();
  for (const line of shipmentLines) {
    const id = String(line.expected_package_id ?? "").trim();
    if (id) ids.add(id);
  }
  for (const row of detailRows) {
    const id = firstRecordString([row], ["id", "expected_package_id", "expected_packages_id"]);
    if (id) ids.add(id);
  }
  if (ids.size > 0) return ids.size;
  if (detailRows.length > 0) return detailRows.length;
  if (shipmentLines.length > 0) return shipmentLines.length;
  return typeof fallbackRowCount === "number" && fallbackRowCount > 0 ? fallbackRowCount : null;
}

/** Matched gate: operator box stepper is hidden — derive count from manifest lookup when possible. */
function resolveMatchedGatePalletBoxCount(
  physicalBoxStr: string,
  shipmentLines: VInventoryStatusRow[],
  detailRows: Record<string, unknown>[],
  inventoryAgg: { rowCount?: number | null } | null,
): number | null {
  const parsed = parseMandatoryGateBoxCount(physicalBoxStr);
  if (parsed.valid) return parsed.n;
  return countLookupExpectedPackages(shipmentLines, detailRows, inventoryAgg?.rowCount ?? null);
}

function trackingScopedInventoryRows(rows: VInventoryStatusRow[], trackingNumber: string): VInventoryStatusRow[] {
  const key = normalizeTrackingKey(trackingNumber);
  if (!key) return [];
  return rows.filter((row) => normalizeTrackingKey(row.tracking_number) === key);
}

function trackingScopedExpectedRows(rows: Record<string, unknown>[], trackingNumber: string): Record<string, unknown>[] {
  const key = normalizeTrackingKey(trackingNumber);
  if (!key) return [];
  return rows.filter((row) => normalizeTrackingKey(String(row.tracking_number ?? "")) === key);
}

function expectedRowValueForTier(row: Record<string, unknown>, tier: ItemResolveTier): string {
  switch (tier) {
    case "fnsku":
      return String(row.fnsku ?? "").trim();
    case "upc":
      return String(row.upc ?? row.product_upc ?? row.gtin ?? "").trim();
    case "sku":
      return String(row.sku ?? "").trim();
    case "asin":
      return String(row.asin ?? row.product_asin ?? "").trim();
    default:
      return "";
  }
}

function normScanToken(s: string): string {
  return s.trim().toLowerCase();
}

function TrackingParentIcon() {
  return (
    <div
      className="relative flex h-[100px] w-[100px] shrink-0 items-center justify-center overflow-hidden rounded-[22px]"
      style={{
        background: `linear-gradient(145deg, ${CARD_INNER} 0%, #0f172a 55%, #020617 100%)`,
        border: `1px solid ${BORDER}`,
        boxShadow: "0 12px 28px -8px rgba(0,0,0,0.75), inset 0 1px 0 rgba(255,255,255,0.08)",
      }}
      aria-hidden
    >
      <Package
        className="absolute left-[14px] top-[22px] h-11 w-11 opacity-[0.55]"
        style={{ color: "#6366f1", filter: "drop-shadow(2px 6px 0 rgba(30,27,75,0.85))" }}
        strokeWidth={2}
      />
      <div
        className="relative flex h-[72px] w-[72px] flex-col items-center justify-center rounded-2xl ring-1"
        style={{
          background: "linear-gradient(180deg, rgba(56,189,248,0.28) 0%, rgba(14,165,233,0.1) 100%)",
          borderColor: "rgba(56,189,248,0.45)",
          boxShadow:
            "0 10px 22px rgba(14,165,233,0.35), inset 0 2px 0 rgba(255,255,255,0.15), inset 0 -6px 12px rgba(15,23,42,0.45)",
        }}
      >
        <ScanLine
          className="relative z-[1] h-9 w-9"
          style={{ color: ACCENT_BLUE, filter: "drop-shadow(0 3px 0 rgba(12,74,110,0.9))" }}
          strokeWidth={2}
        />
        <div className="relative z-[1] mt-1 flex gap-0.5">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="h-3 w-[2px] rounded-full bg-white/95 shadow-[0_0_3px_rgba(255,255,255,0.9)]" />
          ))}
        </div>
      </div>
    </div>
  );
}

function ScanFrameWithLaser(props: {
  children: ReactNode;
  minHeight?: string;
  /** Corner bracket theme; horizontal sweep is always industrial red. */
  laserColor: string;
  frameStyle: React.CSSProperties;
  /** Optional theme-scoped frame surface (e.g. Shipment Entry gate scan viewport). */
  frameClassName?: string;
  cornerColor: string;
  cornerSize?: "sm" | "lg";
  dashedBorder?: boolean;
  /** Thinner corner brackets + softer red sweep. */
  subtleSweep?: boolean;
  /** Cyan glowing brackets via `--scanner-bracket-glow`. */
  bracketGlow?: boolean;
  /** Brief green success pulse on the frame (e.g. item scan saved). */
  successFlash?: boolean;
  onClick?: () => void;
}) {
  const {
    children,
    minHeight = "168px",
    frameStyle,
    frameClassName,
    cornerColor,
    cornerSize = "sm",
    dashedBorder = true,
    subtleSweep = false,
    bracketGlow = false,
    successFlash = false,
    onClick,
  } = props;
  const cw = subtleSweep ? 2 : 3;
  const isLg = cornerSize === "lg";
  const tlCls = isLg ? "left-4 top-4 h-10 w-10 rounded-tl-[14px]" : "left-3 top-3 h-9 w-9 rounded-tl-[12px]";
  const trCls = isLg ? "right-4 top-4 h-10 w-10 rounded-tr-[14px]" : "right-3 top-3 h-9 w-9 rounded-tr-[12px]";
  const blCls = isLg ? "bottom-4 left-4 h-10 w-10 rounded-bl-[14px]" : "bottom-3 left-3 h-9 w-9 rounded-bl-[12px]";
  const brCls = isLg ? "bottom-4 right-4 h-10 w-10 rounded-br-[14px]" : "bottom-3 right-3 h-9 w-9 rounded-br-[12px]";
  const bracketWrapStyle: CSSProperties | undefined = bracketGlow ? { filter: "var(--scanner-bracket-glow)" } : undefined;
  return (
    <div
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
      onClick={onClick}
      onKeyDown={(e) => {
        if (!onClick) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick();
        }
      }}
      className={`relative flex flex-col items-center justify-center overflow-hidden rounded-[22px] border shadow-inner ${dashedBorder ? "border-dashed" : ""} ${onClick ? "cursor-pointer" : ""} ${frameClassName ?? ""}`}
      style={{ ...frameStyle, minHeight }}
    >
      <div className="pointer-events-none absolute inset-0" style={bracketWrapStyle}>
        <span className={`pointer-events-none absolute ${tlCls}`} style={{ borderLeft: `${cw}px solid ${cornerColor}`, borderTop: `${cw}px solid ${cornerColor}` }} />
        <span className={`pointer-events-none absolute ${trCls}`} style={{ borderRight: `${cw}px solid ${cornerColor}`, borderTop: `${cw}px solid ${cornerColor}` }} />
        <span className={`pointer-events-none absolute ${blCls}`} style={{ borderBottom: `${cw}px solid ${cornerColor}`, borderLeft: `${cw}px solid ${cornerColor}` }} />
        <span className={`pointer-events-none absolute ${brCls}`} style={{ borderBottom: `${cw}px solid ${cornerColor}`, borderRight: `${cw}px solid ${cornerColor}` }} />
      </div>
      <div className="pointer-events-none absolute inset-0 overflow-hidden rounded-[inherit]" aria-hidden>
        <div
          className={`operator-handheld-red-laser${subtleSweep ? " operator-handheld-red-laser--subtle" : ""}`}
        />
      </div>
      {successFlash ? (
        <div
          className="pointer-events-none absolute inset-0 z-[4] rounded-[inherit] bg-emerald-400/35 ring-2 ring-emerald-400/80 operator-scan-frame-success-overlay"
          aria-hidden
        />
      ) : null}
      <div className="relative z-[1] flex w-full flex-col items-center justify-center px-2">{children}</div>
    </div>
  );
}

type ExpectedInventoryAccent = "teal" | "purple" | "blue";

type PalletStatGlow = "teal" | "blue" | "green" | "purple";

const PALLET_STAT_GLOW: Record<
  PalletStatGlow,
  {
    iconFill: string;
    iconRing: string;
    iconShadow: string;
    tileBorder: string;
    tileShadow: string;
    innerTileGlow: string;
    veil: string;
  }
> = {
  teal: {
    iconFill: "rgba(45, 212, 191, 0.28)",
    iconRing: "rgba(45, 212, 191, 0.55)",
    iconShadow:
      "0 0 24px rgba(45, 212, 191, 0.5), 0 0 10px rgba(45, 212, 191, 0.35), inset 0 1px 0 rgba(255,255,255,0.16)",
    tileBorder: "rgba(45, 212, 191, 0.28)",
    tileShadow: "0 0 36px -10px rgba(45, 212, 191, 0.35), 0 14px 32px -20px rgba(0,0,0,0.55), inset 0 1px 0 rgba(255,255,255,0.06)",
    innerTileGlow:
      "inset 0 1px 0 rgba(255,255,255,0.07), inset 0 -20px 36px -8px rgba(45,212,191,0.12), inset 0 14px 32px -6px rgba(45,212,191,0.09)",
    veil: "radial-gradient(ellipse 120% 80% at 50% 0%, rgba(45,212,191,0.14) 0%, transparent 62%)",
  },
  blue: {
    iconFill: "rgba(56, 189, 248, 0.26)",
    iconRing: "rgba(56, 189, 248, 0.52)",
    iconShadow:
      "0 0 24px rgba(14, 165, 233, 0.5), 0 0 10px rgba(56, 189, 248, 0.35), inset 0 1px 0 rgba(255,255,255,0.14)",
    tileBorder: "rgba(56, 189, 248, 0.26)",
    tileShadow: "0 0 36px -10px rgba(14, 165, 233, 0.32), 0 14px 32px -20px rgba(0,0,0,0.55), inset 0 1px 0 rgba(255,255,255,0.06)",
    innerTileGlow:
      "inset 0 1px 0 rgba(255,255,255,0.07), inset 0 -20px 36px -8px rgba(14,165,233,0.11), inset 0 14px 32px -6px rgba(56,189,248,0.08)",
    veil: "radial-gradient(ellipse 120% 80% at 50% 0%, rgba(56,189,248,0.12) 0%, transparent 62%)",
  },
  green: {
    iconFill: "rgba(52, 211, 153, 0.26)",
    iconRing: "rgba(52, 211, 153, 0.5)",
    iconShadow:
      "0 0 24px rgba(52, 211, 153, 0.48), 0 0 10px rgba(52, 211, 153, 0.32), inset 0 1px 0 rgba(255,255,255,0.12)",
    tileBorder: "rgba(52, 211, 153, 0.26)",
    tileShadow: "0 0 36px -10px rgba(52, 211, 153, 0.28), 0 14px 32px -20px rgba(0,0,0,0.55), inset 0 1px 0 rgba(255,255,255,0.06)",
    innerTileGlow:
      "inset 0 1px 0 rgba(255,255,255,0.07), inset 0 -20px 36px -8px rgba(52,211,153,0.1), inset 0 14px 32px -6px rgba(52,211,153,0.07)",
    veil: "radial-gradient(ellipse 120% 80% at 50% 0%, rgba(52,211,153,0.11) 0%, transparent 62%)",
  },
  purple: {
    iconFill: "rgba(167, 139, 250, 0.26)",
    iconRing: "rgba(167, 139, 250, 0.52)",
    iconShadow:
      "0 0 24px rgba(139, 92, 246, 0.45), 0 0 10px rgba(167, 139, 250, 0.32), inset 0 1px 0 rgba(255,255,255,0.12)",
    tileBorder: "rgba(167, 139, 250, 0.28)",
    tileShadow: "0 0 36px -10px rgba(139, 92, 246, 0.28), 0 14px 32px -20px rgba(0,0,0,0.55), inset 0 1px 0 rgba(255,255,255,0.06)",
    innerTileGlow:
      "inset 0 1px 0 rgba(255,255,255,0.07), inset 0 -20px 36px -8px rgba(139,92,246,0.1), inset 0 14px 32px -6px rgba(167,139,250,0.08)",
    veil: "radial-gradient(ellipse 120% 80% at 50% 0%, rgba(167,139,250,0.12) 0%, transparent 62%)",
  },
};

function PalletScanStatTile(props: {
  label: string;
  value: string;
  icon: typeof Package;
  glow: PalletStatGlow;
  iconColor: string;
  valueColor: string;
  onClick?: () => void;
  /** When true, tile is not clickable (e.g. active box session). */
  interactionDisabled?: boolean;
}) {
  const { label, value, icon: Icon, glow, iconColor, valueColor, onClick, interactionDisabled } = props;
  const g = PALLET_STAT_GLOW[glow];
  const interactive = Boolean(onClick) && !interactionDisabled;
  const tileShellClass = `operator-pallet-scan-stat-tile operator-pallet-scan-stat-tile--${glow} relative overflow-hidden rounded-2xl border px-2 pb-2.5 pt-2.5`;
  const inner = (
    <>
      <div className="pointer-events-none absolute inset-0 opacity-100" style={{ background: g.veil }} aria-hidden />
      <div className="relative flex min-h-[5.5rem] flex-col items-center justify-center gap-1.5 text-center">
        <div
          className="operator-pallet-scan-stat-tile__icon flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border"
          style={{
            backgroundColor: g.iconFill,
            borderColor: g.iconRing,
            boxShadow: g.iconShadow,
          }}
          aria-hidden
        >
          <Icon className="h-[19px] w-[19px]" strokeWidth={2.25} style={{ color: iconColor }} />
        </div>
        <p className="operator-pallet-scan-stat-tile__label text-[10px] font-semibold uppercase tracking-widest text-slate-500">
          {label}
        </p>
        <p
          className="operator-pallet-scan-stat-tile__value -mt-0.5 text-lg font-semibold tabular-nums tracking-tight sm:text-xl"
          style={{ color: valueColor }}
        >
          {value}
        </p>
      </div>
    </>
  );
  if (!interactive) {
    return <div className={tileShellClass}>{inner}</div>;
  }
  return (
    <button
      type="button"
      onClick={onClick}
      className={`${tileShellClass} w-full text-left outline-none transition-transform duration-150 ease-out hover:scale-[1.02] focus-visible:ring-2 focus-visible:ring-[var(--scanner-focus-ring)] active:scale-[0.98] disabled:pointer-events-none disabled:opacity-50 disabled:hover:scale-100`}
    >
      {inner}
    </button>
  );
}

function ExpectedInventoryLineRow(props: {
  line: TrackingOperatorLine;
  accent: ExpectedInventoryAccent;
}) {
  const { line, accent } = props;
  const linkage = line.product_linkage;
  const varianceLabel = formatScanVarianceLabel(line.expectedQty, line.scannedQty);
  const iconWrapStyle: CSSProperties =
    accent === "teal"
      ? {
          borderColor: "rgba(45,212,191,0.35)",
          boxShadow: "inset 0 1px 0 rgba(255,255,255,0.06), 0 0 12px rgba(45,212,191,0.1)",
        }
      : accent === "purple"
        ? {
            borderColor: PURPLE_RING,
            boxShadow: "inset 0 1px 0 rgba(255,255,255,0.06), 0 0 12px rgba(139,92,246,0.1)",
          }
        : {
            borderColor: BORDER,
            boxShadow: "inset 0 1px 0 rgba(255,255,255,0.04)",
          };
  const iconColor = accent === "teal" ? TEAL_STEP : accent === "purple" ? ACTION_PURPLE : "rgba(196,181,253,0.9)";

  return (
    <li className="flex items-center gap-2.5 py-2.5">
      <div
        className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-lg border"
        style={{ backgroundColor: CARD_INNER, ...iconWrapStyle }}
        aria-hidden
      >
        <PackageOpen className="h-[18px] w-[18px]" strokeWidth={2} style={{ color: iconColor }} />
      </div>
      <div className="min-w-0 flex-1" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
        <ProductLinkagePrimaryLink
          linkage={linkage}
          detailFrom="scan"
          className="text-sm font-bold leading-tight tracking-tight text-sky-300 underline decoration-sky-400/50 underline-offset-2 hover:text-sky-200"
          onClick={(e) => e.stopPropagation()}
        />
        {linkage ? <OperatorProductLinkageMeta linkage={linkage} linkResolvedProductId={false} detailFrom="scan" /> : null}
        <p className="mt-0.5 text-xs tabular-nums text-slate-500">
          <span className="font-mono">{line.asin?.trim() ? line.asin.trim() : "—"}</span>
          <span className="mx-1 font-normal text-slate-600" aria-hidden>
            ·
          </span>
          <span className="font-mono">{line.sku?.trim() ? line.sku.trim() : "—"}</span>
        </p>
        {line.fnsku || line.disposition ? (
          <p className="mt-0.5 text-[10px] font-medium leading-tight text-slate-600">
            {line.fnsku ? (
              <>
                FNSKU <span className="font-mono text-slate-500">{line.fnsku}</span>
              </>
            ) : null}
            {line.fnsku && line.disposition ? <span className="mx-1 text-slate-700">·</span> : null}
            {line.disposition ? (
              <span style={{ color: accent === "purple" ? "rgba(196,181,253,0.85)" : "rgba(45,212,191,0.75)" }}>{line.disposition}</span>
            ) : null}
          </p>
        ) : null}
      </div>
      <div className="flex shrink-0 gap-3 text-right">
        <div>
          <p className="text-[8px] font-semibold uppercase tracking-wide text-slate-500">Exp</p>
          <p className="mt-0.5 text-base font-bold tabular-nums leading-none" style={{ color: ACTION_BLUE }}>
            {line.expectedQty}
          </p>
        </div>
        <div>
          <p className="text-[8px] font-semibold uppercase tracking-wide text-slate-500">Scan</p>
          <p
            className="mt-0.5 text-base font-bold tabular-nums leading-none"
            style={{ color: line.scannedQty >= line.expectedQty && line.expectedQty > 0 ? SUCCESS : TEXT_PRIMARY }}
          >
            {line.scannedQty}
          </p>
        </div>
        <div>
          <p className="text-[8px] font-semibold uppercase tracking-wide text-slate-500">Var</p>
          <p
            className="mt-0.5 text-base font-bold tabular-nums leading-none"
            style={{
              color:
                line.varianceQty > 0 ? "#fbbf24" : line.varianceQty < 0 ? "#f87171" : "rgba(148,163,184,0.9)",
            }}
          >
            {varianceLabel}
          </p>
        </div>
      </div>
    </li>
  );
}

/** Step 3 variance row — EP snapshot line with product linkage contract + Exp/Scan/Var. */
function ItemScanExpectationVarianceRow(props: {
  line: TrackingOperatorLine;
  discrepancyMode: boolean;
}) {
  const { line, discrepancyMode } = props;
  const linkage = line.product_linkage;
  const varianceLabel = formatScanVarianceLabel(line.expectedQty, line.scannedQty);
  const vis = itemInspectionSlipLinePresentation(line.expectedQty, line.scannedQty, discrepancyMode);

  return (
    <div
      className={itemScanSlipRowShellClass(vis.matchedRing)}
      data-neda-qty={vis.label}
      style={itemInspectionSlipCardStyle(vis)}
    >
      <div className="min-w-0" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
        <ProductLinkagePrimaryLink
          linkage={linkage}
          detailFrom="scan"
          className={SLIP_CARD_HEADING}
          onClick={(e) => e.stopPropagation()}
        />
        <div className={SLIP_CARD_META_LINKAGE}>
          <OperatorProductLinkageMeta linkage={linkage} linkResolvedProductId={false} detailFrom="scan" />
        </div>
      </div>
      <div className="mt-0.5 flex min-w-0 items-center justify-between gap-2">
        <p className={`operator-item-scan-slip-row__meta min-w-0 flex-1 truncate leading-none ${SLIP_CARD_TECH_ID}`}>
          SKU {line.sku?.trim() ? line.sku.trim() : "—"}
          <span className="operator-item-scan-slip-row__meta-sep mx-1 text-neutral-600">·</span>
          FNSKU {line.fnsku?.trim() ? line.fnsku.trim() : "—"}
          {line.disposition ? (
            <>
              <span className="operator-item-scan-slip-row__meta-sep mx-1 text-neutral-600">·</span>
              <span className="operator-item-scan-slip-row__meta-disp">{line.disposition}</span>
            </>
          ) : null}
        </p>
        <div className="flex shrink-0 items-center gap-1">
          {slipCardStatusMark(vis)}
          <span className={`operator-item-scan-slip-row__qty whitespace-nowrap tabular-nums ${SLIP_CARD_TECH_ID}`}>
            Exp {line.expectedQty}
            <span className="operator-item-scan-slip-row__qty-sep mx-0.5">·</span>
            Scn {line.scannedQty}
            <span className="operator-item-scan-slip-row__qty-sep mx-0.5">·</span>
            Var{" "}
            <span
              className={
                line.varianceQty > 0
                  ? "operator-item-scan-slip-row__qty-var--over text-amber-300"
                  : line.varianceQty < 0
                    ? "operator-item-scan-slip-row__qty-var--under text-red-300"
                    : "operator-item-scan-slip-row__qty-var--neutral text-neutral-500"
              }
            >
              {varianceLabel}
            </span>
          </span>
        </div>
      </div>
    </div>
  );
}

function WarehouseBreadcrumb(props: {
  /** Kept in props for call-site compatibility, no longer rendered (per scan-page cleanup spec). */
  storeLabel?: string | null;
  palletLabel: string | null;
  /**
   * Carton / locked package barcode for the "Pkg" crumb (never parent shipment or `pallets.tracking_number`).
   * Ignored when `middleOverride` is set.
   */
  shipmentIdLabel: string | null;
  /**
   * Package / item phases: middle crumb (e.g. Box 1, Box 2) so pallet `tracking_number`
   * never appears as a fake "package" id next to the pallet number.
   */
  middleOverride?: { label: string; value: string } | null;
  /** Shown only after a package/carton barcode is locked or an item-phase box is selected. */
  boxBarcode: string | null;
  className?: string;
}) {
  const { palletLabel, shipmentIdLabel, middleOverride, boxBarcode, className } = props;

  // Compact single-line "Pallet > Package > Item" hierarchy.
  // Each segment is rendered only when its value is present so the row stays
  // as short as possible (no Store, no platform name, no "—" placeholders).
  const segments: Array<{ key: string; label: string; value: string; mono?: boolean; valueColor: string }> = [];
  const palletValue = palletLabel?.trim() ?? "";
  if (palletValue) {
    segments.push({ key: "pallet", label: "Pallet", value: palletValue, mono: true, valueColor: TEAL_STEP });
  }
  const mid = middleOverride?.value?.trim()
    ? { label: middleOverride.label.trim() || "BOX", value: middleOverride.value.trim() }
    : null;
  if (mid) {
    segments.push({
      key: "mid",
      label: mid.label,
      value: mid.value,
      mono: true,
      valueColor: TEXT_PRIMARY,
    });
  } else {
    const pkgValue = shipmentIdLabel?.trim() ?? "";
    if (pkgValue) {
      segments.push({ key: "pkg", label: "BOX", value: pkgValue, mono: true, valueColor: TEXT_PRIMARY });
    }
  }
  const itemValue = boxBarcode?.trim() ?? "";
  if (itemValue) {
    segments.push({ key: "item", label: "Item", value: itemValue, mono: true, valueColor: SUCCESS });
  }
  if (segments.length === 0) return null;

  const sep = (
    <span className="mx-0.5 select-none font-semibold tabular-nums text-slate-600" aria-hidden>
      ›
    </span>
  );

  return (
    <nav
      className={`flex w-full max-w-full flex-wrap items-center justify-center gap-x-0.5 overflow-hidden text-[9px] font-bold leading-none tracking-tight ${className ?? ""}`}
      aria-label="Warehouse path"
    >
      {segments.map((s, i) => (
        <span key={s.key} className="flex min-w-0 items-center gap-x-0.5">
          {i > 0 ? sep : null}
          <span style={{ color: MUTED_LABEL }}>{s.label}</span>
          <span
            className={`min-w-0 max-w-[28vw] truncate sm:max-w-[140px] ${s.mono ? "font-mono" : ""}`}
            style={{ color: s.valueColor }}
            title={s.value}
          >
            {s.value}
          </span>
        </span>
      ))}
    </nav>
  );
}

/**
 * 3-cell sticky progress dashboard above the page header — pallet-level box counts only
 * (Expected / Scanned / Remaining). Compact "BOX" unit suffix for quick scanning.
 * Scanned / Remaining cells are clickable for quick navigation when handlers are provided.
 */
function ScanProgressDashboard(props: {
  active: boolean;
  /** Nested under the progress sentence — no extra top border / outer chrome. */
  embedded?: boolean;
  boxesExpected: number;
  boxesScanned: number;
  onScannedBoxesClick?: () => void | Promise<void>;
  onRemainingBoxesClick?: () => void | Promise<void>;
  /** Disables navigation clicks (e.g. while saving pallet step). */
  interactionDisabled?: boolean;
}) {
  const {
    active,
    embedded = false,
    boxesExpected,
    boxesScanned,
    onScannedBoxesClick,
    onRemainingBoxesClick,
    interactionDisabled,
  } = props;
  if (!active) return null;
  if (boxesExpected <= 0 && boxesScanned <= 0) return null;

  const boxesRemaining = Math.max(0, boxesExpected - boxesScanned);
  const primaryExpected = boxesExpected;
  const primaryRemaining = boxesRemaining;
  const remainingColor =
    primaryRemaining <= 0 && primaryExpected > 0
      ? SUCCESS
      : primaryExpected > 0 && primaryRemaining > primaryExpected * 0.5
        ? "#f87171"
        : primaryRemaining > 0
          ? "#fb923c"
          : MUTED_LABEL;

  const palletStatVariant = (label: string) => {
    if (label === "Expected Boxes") return "operator-pallet-stat-cell--expected";
    if (label === "Scanned Boxes") return "operator-pallet-stat-cell--scanned";
    if (label === "Remaining Boxes") return "operator-pallet-stat-cell--remaining";
    return "";
  };

  const renderStaticCell = (label: string, value: number, accent: string, _border: string, _bg: string) => (
    <div
      key={label}
      className={`operator-dashboard-metric-cell operator-pallet-stat-cell ${palletStatVariant(label)} flex min-w-0 flex-col items-stretch justify-center rounded-lg px-1.5 py-1.5`}
    >
      <p
        className="text-center text-[8.5px] font-bold uppercase tracking-widest leading-tight"
        style={{ color: MUTED_LABEL }}
      >
        {label}
      </p>
      <div className="mt-0.5 flex items-baseline justify-center gap-0.5 leading-none">
        <span className="font-mono text-[15px] font-extrabold tabular-nums" style={{ color: accent }}>
          {value}
        </span>
        <span className="text-[8.5px] font-bold uppercase tracking-wider" style={{ color: MUTED_LABEL }}>
          BOX
        </span>
      </div>
    </div>
  );

  const renderNavCell = (
    label: string,
    value: number,
    accent: string,
    border: string,
    bg: string,
    onClick: (() => void | Promise<void>) | undefined,
  ) => {
    const body = (
      <>
        <p
          className="text-center text-[8.5px] font-bold uppercase tracking-widest leading-tight"
          style={{ color: MUTED_LABEL }}
        >
          {label}
        </p>
        <div className="mt-0.5 flex items-baseline justify-center gap-0.5 leading-none">
          <span className="font-mono text-[15px] font-extrabold tabular-nums" style={{ color: accent }}>
            {value}
          </span>
          <span className="text-[8.5px] font-bold uppercase tracking-wider" style={{ color: MUTED_LABEL }}>
            BOX
          </span>
        </div>
      </>
    );
    const clickable = Boolean(onClick) && !interactionDisabled;
    if (!clickable) {
      return (
        <div
          key={label}
          className={`operator-dashboard-metric-cell operator-pallet-stat-cell ${palletStatVariant(label)} flex min-w-0 flex-col items-stretch justify-center rounded-lg px-1.5 py-1.5`}
        >
          {body}
        </div>
      );
    }
    return (
      <button
        key={label}
        type="button"
        onClick={() => void onClick?.()}
        className={`operator-dashboard-metric-cell operator-pallet-stat-cell ${palletStatVariant(label)} flex min-w-0 flex-col items-stretch justify-center rounded-lg px-1.5 py-1.5 text-left outline-none transition-transform duration-150 ease-out hover:scale-[1.02] focus-visible:ring-2 focus-visible:ring-[var(--scanner-focus-ring)] active:scale-[0.98] disabled:pointer-events-none disabled:opacity-50 disabled:hover:scale-100`}
        aria-label={label === "Scanned Boxes" ? "Jump to saved boxes list" : "Start a new box"}
      >
        {body}
      </button>
    );
  };

  return (
    <div
      className={
        embedded
          ? "relative z-[111] shrink-0 px-1 pb-1 pt-0"
          : "relative z-[111] shrink-0 border-t px-2 py-1 backdrop-blur-md"
      }
      style={
        embedded
          ? undefined
          : {
              borderColor: BORDER,
              backgroundColor: "rgba(11,18,24,0.92)",
            }
      }
      aria-label="Box receiving progress"
    >
      <div
        className={`operator-pallet-stat-grid operator-shipment-entry-progress-metrics operator-pallet-progress-dashboard grid grid-cols-3 ${embedded ? "gap-1.5" : "gap-2"}`}
      >
        {renderStaticCell(
          "Expected Boxes",
          boxesExpected,
          ACCENT_BLUE,
          "rgba(56,189,248,0.25)",
          "rgba(56,189,248,0.06)",
        )}
        {renderNavCell(
          "Scanned Boxes",
          boxesScanned,
          SUCCESS,
          "rgba(52,211,153,0.3)",
          "rgba(52,211,153,0.07)",
          onScannedBoxesClick,
        )}
        {renderNavCell(
          "Remaining Boxes",
          boxesRemaining,
          remainingColor,
          primaryRemaining <= 0 && primaryExpected > 0
            ? "rgba(52,211,153,0.3)"
            : primaryExpected > 0 && primaryRemaining > primaryExpected * 0.5
              ? "rgba(248,113,113,0.35)"
              : primaryRemaining > 0
                ? "rgba(251,146,60,0.35)"
                : "rgba(148,163,184,0.18)",
          primaryRemaining <= 0 && primaryExpected > 0
            ? "rgba(52,211,153,0.06)"
            : primaryExpected > 0 && primaryRemaining > primaryExpected * 0.5
              ? "rgba(248,113,113,0.08)"
              : primaryRemaining > 0
                ? "rgba(251,146,60,0.08)"
                : "rgba(148,163,184,0.04)",
          onRemainingBoxesClick,
        )}
      </div>
    </div>
  );
}

function ParentType3DIcon() {
  return (
    <div
      className="relative h-[100px] w-[100px] shrink-0 overflow-visible"
      aria-hidden
    >
      <div
        className="absolute inset-0 rounded-[22px] shadow-[0_12px_28px_-8px_rgba(0,0,0,0.75),inset_0_1px_0_0_rgba(255,255,255,0.08)]"
        style={{
          background: `linear-gradient(145deg, ${CARD_INNER} 0%, #0f172a 55%, #020617 100%)`,
          border: `1px solid ${BORDER}`,
        }}
      />
      {/* Pallet base */}
      <div
        className="absolute bottom-[14px] left-1/2 h-[22px] w-[72px] -translate-x-1/2 rounded-md shadow-[0_6px_14px_rgba(0,0,0,0.5)]"
        style={{
          background: `linear-gradient(180deg, #2563eb 0%, #1d4ed8 45%, #1e3a8a 100%)`,
          border: "1px solid rgba(56,189,248,0.35)",
        }}
      />
      <div
        className="absolute bottom-[22px] left-1/2 h-[8px] w-[64px] -translate-x-1/2 rounded-sm bg-[#172554]/90 shadow-inner"
        style={{ border: `1px solid ${BORDER}` }}
      />
      {/* Box on pallet */}
      <div
        className="absolute left-1/2 top-[18px] w-[52px] -translate-x-1/2 rounded-xl shadow-[0_10px_20px_-6px_rgba(37,99,235,0.65),inset_0_1px_0_0_rgba(255,255,255,0.25)]"
        style={{
          height: 52,
          background: `linear-gradient(145deg, #60a5fa 0%, #2563eb 40%, #1d4ed8 100%)`,
          border: "1px solid rgba(147,197,253,0.45)",
        }}
      >
        <div className="flex h-full flex-col justify-between px-2.5 pb-2 pt-2.5">
          <div className="flex justify-center gap-[3px]">
            {[0, 1, 2, 3, 4].map((i) => (
              <div key={i} className="h-5 w-[2px] rounded-full bg-white/95 shadow-[0_0_2px_rgba(255,255,255,0.8)]" />
            ))}
          </div>
          <div className="h-2 w-full rounded-sm bg-black/15" />
        </div>
      </div>
    </div>
  );
}

function OperatorMobileScanPageContent() {
  const { actorName, actorUserId } = useUserRole();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const formId = useId();
  const {
    organizationId: orgId,
    sessionStoreId,
    operatorStores,
    operatorStoresLoading,
    kioskStoreLocked,
    activeStoreLabel,
  } = useOperatorSessionStore();
  const scannerRef = useRef<HTMLInputElement>(null);
  const gateManualInputRef = useRef<HTMLInputElement>(null);
  const palletManualInputRef = useRef<HTMLInputElement>(null);
  const boxManualInputRef = useRef<HTMLInputElement>(null);
  const scanBufferRef = useRef("");
  const scanBufferClearTimerRef = useRef<number | null>(null);
  /** Item phase: wedge input stays on the hidden laser buffer; unit capture uses {@link ItemUnitRecordModal}. */
  const physicalBoxCountInputRef = useRef<HTMLInputElement>(null);
  /** Chrome height for fixed Item-phase Active Context bar (`padding-top` under `top: 0`). */
  const scanPageHeaderRef = useRef<HTMLElement>(null);
  const operatorMobileMainScrollRef = useRef<HTMLElement | null>(null);
  const bindOperatorMainScrollEl = useCallback((el: HTMLElement | null) => {
    operatorMobileMainScrollRef.current = el;
  }, []);
  const modalOpenRef = useRef(false);
  /** After "all completed" dialog confirm: canonical tracking for the next resolve scan. */
  const postCompleteTrackingRef = useRef<string | null>(null);
  /** One Persian prompt per identification search cycle (reset when a new gate search starts). */
  const completedShipmentDialogShownForKeyRef = useRef<string | null>(null);
  const [flowPhase, setFlowPhase] = useState<FlowPhase>("scan");
  const flowPhasePrevRef = useRef<FlowPhase>("scan");
  const [scanLine, setScanLine] = useState("");
  const [scanCaptureLine, setScanCaptureLine] = useState("");
  const [manualOpen, setManualOpen] = useState(false);
  const [manualEntryMode, setManualEntryMode] = useState(false);
  const isManualEntryMode = manualEntryMode;
  const manualEntryModeRef = useRef(false);
  const [lastScannedCode, setLastScannedCode] = useState("");
  const [scanBarcodeHelpOpen, setScanBarcodeHelpOpen] = useState(false);

  const [activePallet, setActivePallet] = useState<OperatorActivePallet | null>(null);
  /** Parent shipment / carrier id when there is no pallet row yet (identify gate, direct tracking). */
  const [activeTracking, setActiveTracking] = useState<string | null>(null);
  /** `pallets.tracking_number` — shipment/parent id; never the carton scan buffer. */
  const [currentPalletTrackingId, setCurrentPalletTrackingId] = useState<string | null>(null);
  /** Carton / box barcode buffer for Step 3 (package_scan) only — never the pallet shipment id. */
  const [currentPackageTrackingId, setCurrentPackageTrackingId] = useState<string | null>(null);
  const [activeSlipOrPackage, setActiveSlipOrPackage] = useState<string | null>(null);
  const [directBox, setDirectBox] = useState(false);

  const [unknownModal, setUnknownModal] = useState<{ code: string } | null>(null);
  const [busy, setBusy] = useState(false);

  /** Identification gate: hide workflow steps until operator confirms tracking context. */
  const [isIdentified, setIsIdentified] = useState(false);
  /** Continue from Shipment Entry should land on Neda's modern Pallet workspace, never the legacy docs form. */
  const [modernPalletWorkspace, setModernPalletWorkspace] = useState(false);
  const [identifyGatePhase, setIdentifyGatePhase] = useState<IdentifyGatePhase>("idle");
  const [identifyGateSlowHint, setIdentifyGateSlowHint] = useState<string | null>(null);
  const [identifyGateError, setIdentifyGateError] = useState<string | null>(null);
  const [identifyGateEnteredCode, setIdentifyGateEnteredCode] = useState("");
  const [identifyGateRows, setIdentifyGateRows] = useState<Record<string, unknown>[]>([]);
  const [identifyGateCanonicalTracking, setIdentifyGateCanonicalTracking] = useState<string | null>(null);
  /** Which column matched the scan on `v_inventory_item_status` (slip “ASIN” column → `fnsku`). */
  const [identifyGateMatchField, setIdentifyGateMatchField] = useState<ShipmentEntryItemViewMatchField | null>(null);
  const [identifyGateEntity, setIdentifyGateEntity] = useState<IdentifyGateEntity | null>(null);
  const [identifyGatePhysicalBoxStr, setIdentifyGatePhysicalBoxStr] = useState("");
  /** Aggregated `v_inventory_item_status` totals for the current scan (null until search completes). */
  const [identifyGateInventoryAgg, setIdentifyGateInventoryAgg] = useState<{
    rowCount: number;
    totalExpected: number;
    totalScanned: number;
  } | null>(null);
  const [identifyGateInventoryVisual, setIdentifyGateInventoryVisual] = useState<InventoryGateVisualStatus | null>(null);
  const [identifyGateViewHints, setIdentifyGateViewHints] = useState<{
    productName: string | null;
    carrier: string | null;
    slipCode: string | null;
  } | null>(null);
  /** Line-level rows from `v_inventory_item_status` for the matched canonical tracking (strict org/store/tracking query). */
  const [identifyGateShipmentLines, setIdentifyGateShipmentLines] = useState<VInventoryStatusRow[]>([]);
  /** One batch `products` lookup for gate rows with `resolved_product_id` but no view catalog name. */
  const [identifyGateBatchProductNames, setIdentifyGateBatchProductNames] = useState<Map<string, string>>(
    () => new Map(),
  );
  /** EP manifest + variance from `loadTrackingExpectationSnapshot` (product_id-first merge). */
  const [identifyGateExpectationLines, setIdentifyGateExpectationLines] = useState<TrackingOperatorLine[]>([]);
  /** User confirmed adding an off-manifest item after full completion — next scan uses `runResolve` with tracking context. */
  const [awaitingPostCompleteExtraScan, setAwaitingPostCompleteExtraScan] = useState(false);
  const [scanProgressPhase, setScanProgressPhase] = useState<OperatorScanProgressPhase>("idle");
  const [deepSearchAvailableFor, setDeepSearchAvailableFor] = useState<string | null>(null);
  const [identifyGateDeepSearchRunning, setIdentifyGateDeepSearchRunning] = useState(false);

  const [stats, setStats] = useState<{
    totalBoxes: number;
    expectedItems: number;
    scannedItems: number;
    remainingItems: number;
  } | null>(null);

  const [physicalBoxCount, setPhysicalBoxCount] = useState<number | null>(null);
  /**
   * **Edit All**: unlocks pallet shipment fields (tracking, box count, carrier, order, photos, notes)
   * and package intake when a saved UUID box is open. Persisted pallet / saved box rows default to read-only.
   */
  const [editAllMode, setEditAllMode] = useState(false);
  const [correctionPerms, setCorrectionPerms] = useState({ moveBox: false, voidBox: false });
  const [moveBoxModalOpen, setMoveBoxModalOpen] = useState(false);
  /** Target pallet for Move Box — filled by page scan capture while {@link moveBoxModalOpen}. */
  const [moveBoxTargetDraft, setMoveBoxTargetDraft] = useState("");
  const [voidBoxModalOpen, setVoidBoxModalOpen] = useState(false);
  const [voidPalletModalOpen, setVoidPalletModalOpen] = useState(false);
  const [correctionBusy, setCorrectionBusy] = useState(false);
  const [moveBoxModalError, setMoveBoxModalError] = useState<string | null>(null);
  const [voidBoxModalError, setVoidBoxModalError] = useState<string | null>(null);
  const [voidPalletModalError, setVoidPalletModalError] = useState<string | null>(null);
  /** Hydrated slip columns indicate pallet already had shipment data in DB. */
  const [palletDbHasShipmentDetails, setPalletDbHasShipmentDetails] = useState(false);
  /** Shown under Active Pallet — resolved from `pallets.created_by` → `profiles.full_name`. */
  const [palletCreatedByLabel, setPalletCreatedByLabel] = useState<string | null>(null);
  /** `profiles.id` for `pallets.created_by` (UUID) — drives “(you)” in the identity strip. */
  const [palletCreatedByProfileId, setPalletCreatedByProfileId] = useState<string | null>(null);
  const [palletCreatedAtIso, setPalletCreatedAtIso] = useState<string | null>(null);
  /** Bump to re-run pallet row fetch (e.g. same `activePallet.id` after re-search, or post-save). */
  const [palletDocHydrationNonce, setPalletDocHydrationNonce] = useState(0);
  const [boxHydrateNonce, setBoxHydrateNonce] = useState(0);
  const [boxIntakeRestoring, setBoxIntakeRestoring] = useState(false);
  const [scanPageBootComplete, setScanPageBootComplete] = useState(false);
  /** Re-read sessionStorage after Save & Start marks shipment committed for this pallet. */
  const [palletShipmentCommitVersion, setPalletShipmentCommitVersion] = useState(0);
  /**
   * True while `handleConfirmStartBoxScan` is awaiting the Supabase persist. Used by
   * the bottom-of-page "Confirm & Start Box Scan" button to prevent double-taps and
   * surface a "Saving…" indicator. Reset in a finally block so a network failure
   * doesn't strand the operator with a permanently-disabled button.
   */
  const [confirmSaving, setConfirmSaving] = useState(false);
  const [saveShipmentConfirmOpen, setSaveShipmentConfirmOpen] = useState(false);
  const [cancelShipmentConfirmOpen, setCancelShipmentConfirmOpen] = useState(false);
  /** Finalize package (Confirm & Save / discrepancy) — shared copy, distinct actions on confirm. */
  const [packageFinalizeConfirmKind, setPackageFinalizeConfirmKind] = useState<
    null | "save_items" | "save_hub" | "discrepancy"
  >(null);
  /** After generic save confirm, second gate when {@link boxSlipConflictingOrderId} is set. */
  const [packageSaveOrderConflictGateOpen, setPackageSaveOrderConflictGateOpen] = useState(false);
  const [pendingConflictPackageSaveKind, setPendingConflictPackageSaveKind] = useState<
    null | "save_items" | "save_hub" | "discrepancy"
  >(null);
  const [pickerDismissConfirmOpen, setPickerDismissConfirmOpen] = useState(false);
  /** Shared back-navigation gate for unsaved box / pallet intake edits. */
  const [scannerLeaveConfirmOpen, setScannerLeaveConfirmOpen] = useState(false);
  const scannerLeavePendingActionRef = useRef<(() => void) | null>(null);
  /** Exit active box intake without persisting. */
  const [packageSessionCancelConfirmOpen, setPackageSessionCancelConfirmOpen] = useState(false);
  /** Brief full-screen success after package save (before hub scroll or item phase). */
  const [packageSaveSuccessOverlay, setPackageSaveSuccessOverlay] = useState(false);
  /** Where the UI goes after the success overlay (`saveBoxAndContinue`). */
  const [packageSaveSuccessDestination, setPackageSaveSuccessDestination] = useState<null | "hub" | "items">(null);
  /** Step 3 — close box to hub after mandatory confirm (totals + discrepancy warning). */
  const [itemsBoxFinalizeModalOpen, setItemsBoxFinalizeModalOpen] = useState(false);
  const [itemsFinalizeBusy, setItemsFinalizeBusy] = useState(false);

  /** Pending new slip vision data waiting for reconcile confirmation (slip changed with items scanned). */
  const [slipChangeConfirmOpen, setSlipChangeConfirmOpen] = useState(false);
  const slipChangePendingRef = useRef<null | {
    items: BoxSlipVisionLine[];
    sid: string;
    rma: string;
    slipOrderId: string;
    conflictingOrderId: string;
    pkgId: string;
    oid: string;
    storeId: string;
    manifestPayload: Record<string, unknown>;
    linesPayload: { upc: string | null; fnsku: string | null; printed_asin: string | null; description: string | null; expected_qty: number; condition: string | null; missing: boolean }[];
  }>(null);

  /** Pallet shipment-slip / pallet-photo / BOL extras (operator-mobile pallet step). */
  const [palletCarrier, setPalletCarrier] = useState("");
  const [palletOrderId, setPalletOrderId] = useState("");
  /** Last `pallets.order_id` read from DB (not operator-sticky like `palletOrderId`). */
  const [palletDbOrderId, setPalletDbOrderId] = useState("");
  /** Last barcode-resolve pallet `order_id` until DB hydrate overwrites {@link palletDbOrderId}. */
  const [palletResolvedOrderId, setPalletResolvedOrderId] = useState("");
  /** True after a save detected package vs pallet order id conflict (until list hydrate clears it). */
  const [palletMixedOrderIdsWarning, setPalletMixedOrderIdsWarning] = useState(false);
  /** Mirrors {@link palletMixedOrderIdsUi} for pallet hydrate (declared before the memo). */
  const palletMixedOrderIdsUiRef = useRef(false);
  /**
   * True when the operator explicitly picked the "Other / Not Listed" sentinel from the
   * carrier dropdown (so we should render the conditional "Enter Carrier Name" input even
   * when `palletCarrier` is still empty). The flag also flips on automatically when an
   * external value (e.g. OCR result, hydration from DB) lands a custom carrier name into
   * `palletCarrier` that doesn't match any known canonical carrier.
   */
  const [palletCarrierOtherSelected, setPalletCarrierOtherSelected] = useState(false);
  const palletCarrierRef = useRef("");
  const palletOrderIdRef = useRef("");
  /** When set, `palletOrderId` was last auto-filled from RA middle token — safe to clear on RA/slip reset. */
  const lastOrderIdAutoFilledFromRaRef = useRef<string | null>(null);
  /** Latest pallet id targeted by async hydrate — ignore stale fetch results after switching pallets. */
  const hydrateActivePalletIdRef = useRef<string | null>(null);
  /** `${orgId}:${palletId}` — distinguish pallet/org switch from same-pallet refetch (`palletDocHydrationNonce`). */
  const palletHydrateStableKeyRef = useRef<string | null>(null);
  /** When the persisted pallet row changes on the scan step, exit Edit All so shipment UI starts locked. */
  const lastPalletIdForViewLockResetRef = useRef<string | null>(null);
  /** Shipment tracking string to restore after a failed duplicate check while editing the header field. */
  const palletTrackingEditBaselineRef = useRef("");
  const palletShipmentFieldsBaselineRef = useRef({ orderId: "", carrier: "" });
  const parentPalletCarrierDefaultRef = useRef("");
  const itemUnitModalDraftDirtyRef = useRef(false);
  const [slipExtractMissing, setSlipExtractMissing] = useState<{ carrier: boolean; orderId: boolean } | null>(null);
  /** Up to three URLs — persisted in `pallets.shipping_label_urls`. */
  const [shippingLabelPhotoUrls, setShippingLabelPhotoUrls] = useState<string[]>([]);
  /** Up to three URLs — persisted in `pallets.pallet_photo_urls`. */
  const [palletPhotoUrls, setPalletPhotoUrls] = useState<string[]>([]);
  /** Up to three URLs — persisted in `pallets.bol_photo_urls`. */
  const [bolPhotoUrls, setBolPhotoUrls] = useState<string[]>([]);
  const palletPhotoUrlsRef = useRef<string[]>([]);
  const bolPhotoUrlsRef = useRef<string[]>([]);
  const shippingLabelPhotoUrlsRef = useRef<string[]>([]);
  const outsideBoxPhotoUrlsRef = useRef<string[]>([]);
  const insideBoxPhotoUrlsRef = useRef<string[]>([]);
  /** Last server-aligned evidence URLs — soft-removals stage deletes until Save; Discard abandons without storage delete. */
  const evidenceBaselineRef = useRef<{
    slip: string[];
    outside: string[];
    inside: string[];
    shipping: string[];
    pallet: string[];
    bol: string[];
  }>({ slip: [], outside: [], inside: [], shipping: [], pallet: [], bol: [] });
  const boxNotesBaselineRef = useRef("");
  const boxIntakeFieldsBaselineRef = useRef({
    slipCode: "",
    rma: "",
    orderId: "",
    carrier: "",
  });
  /** False while a persisted package row is re-hydrating — avoids false dirty before baseline is finalized. */
  const boxIntakeBaselineReadyRef = useRef(true);
  const finalizeBoxIntakeBaselineRef = useRef<(() => void) | null>(null);
  const reloadBoxPackageIntakeRef = useRef<(pkgId: string) => Promise<boolean>>(async () => false);
  const palletNotesBaselineRef = useRef("");
  /** Persisted storage public URLs to remove after a successful Save/Confirm. */
  const pendingEvidenceStorageDeletesRef = useRef<Set<string>>(new Set());
  /** `pallets.notes` — collaboration / receiving notes (pallet step). */
  const [palletNotes, setPalletNotes] = useState("");

  /**
   * Reset shipment carrier UI to the pallet-session default (Save & Start commit or first hydrate for this pallet).
   * Used when starting each new unsaved box so overrides on the previous box do not carry forward.
   */
  const persistOperatorSessionCarrier = useCallback(
    (carrierValue: string) => {
      const oid = (orgId ?? "").trim();
      if (!oid || typeof window === "undefined") return;
      const pid = activePallet?.id?.trim() && isUuidString(activePallet.id) ? activePallet.id : "";
      const tn = (currentPalletTrackingId ?? "").trim();
      let key: string | null = null;
      if (pid) key = `operatorMobile:sessionCarrier:${oid}:pallet:${pid}`;
      else if (tn) key = `operatorMobile:sessionCarrier:${oid}:tn:${normalizeTrackingKey(tn) || tn}`;
      if (!key) return;
      try {
        if (carrierValue.trim()) window.sessionStorage.setItem(key, carrierValue);
        else window.sessionStorage.removeItem(key);
      } catch {
        /* ignore */
      }
    },
    [orgId, activePallet?.id, currentPalletTrackingId],
  );

  const mergeCarrierIntoActivePalletState = useCallback((carrierValue: string) => {
    setActivePallet((p) => {
      if (!p?.id || !isUuidString(p.id)) return p;
      return { ...p, carrier_name: carrierValue };
    });
  }, []);

  /** Immediate session + `activePallet.carrier_name` — use from carrier inputs (no debounced useEffect). */
  const commitPalletCarrierDraft = useCallback(
    (nextCarrier: string) => {
      setPalletCarrier(nextCarrier);
      persistOperatorSessionCarrier(nextCarrier);
      mergeCarrierIntoActivePalletState(nextCarrier);
    },
    [persistOperatorSessionCarrier, mergeCarrierIntoActivePalletState],
  );

  const applyParentPalletCarrierAsUiDefault = useCallback(() => {
    const def = parentPalletCarrierDefaultRef.current.trim();
    if (!def) return;
    const normalized = normalizeCarrierLabel(def);
    let applied: string;
    if (normalized && normalized !== OTHER_CARRIER_NAME) {
      setPalletCarrierOtherSelected(false);
      setPalletCarrier(normalized);
      applied = normalized;
    } else {
      setPalletCarrierOtherSelected(true);
      setPalletCarrier(def);
      applied = def;
    }
    persistOperatorSessionCarrier(applied);
    mergeCarrierIntoActivePalletState(applied);
  }, [persistOperatorSessionCarrier, mergeCarrierIntoActivePalletState]);

  const sessionCarrierRestoreKeyRef = useRef<string | null>(null);
  useEffect(() => {
    palletCarrierRef.current = palletCarrier;
  }, [palletCarrier]);
  useEffect(() => {
    palletOrderIdRef.current = palletOrderId;
  }, [palletOrderId]);

  const applyPalletOrderIdFromRaIfApplicable = useCallback((rmaRaw: string) => {
    const derived = extractSlipOrderTokenForPalletCompare(rmaRaw);
    if (!derived) return;
    const cur = palletOrderIdRef.current.trim();
    if (!cur || cur === lastOrderIdAutoFilledFromRaRef.current) {
      setPalletOrderId(derived);
      lastOrderIdAutoFilledFromRaRef.current = derived;
    }
  }, []);

  const clearPalletOrderIdIfAutoFilledFromRa = useCallback(() => {
    const cur = palletOrderIdRef.current.trim();
    if (lastOrderIdAutoFilledFromRaRef.current != null && cur === lastOrderIdAutoFilledFromRaRef.current) {
      setPalletOrderId("");
    }
    lastOrderIdAutoFilledFromRaRef.current = null;
  }, []);

  const onPalletOrderIdInputChange = useCallback((v: string) => {
    setPalletOrderId(v);
    const auto = lastOrderIdAutoFilledFromRaRef.current;
    if (auto != null && v.trim() !== auto) lastOrderIdAutoFilledFromRaRef.current = null;
  }, []);

  const applySlipOrderIdIfEmpty = useCallback((raw: string | null | undefined): boolean => {
    const next = String(raw ?? "").trim();
    if (!next || palletOrderIdRef.current.trim()) return false;
    setPalletOrderId(next);
    lastOrderIdAutoFilledFromRaRef.current = null;
    return true;
  }, []);

  useEffect(() => {
    palletPhotoUrlsRef.current = palletPhotoUrls;
  }, [palletPhotoUrls]);
  useEffect(() => {
    bolPhotoUrlsRef.current = bolPhotoUrls;
  }, [bolPhotoUrls]);
  useEffect(() => {
    shippingLabelPhotoUrlsRef.current = shippingLabelPhotoUrls;
  }, [shippingLabelPhotoUrls]);

  const [scannedBoxesSavedCount, setScannedBoxesSavedCount] = useState(0);
  const [activeBoxSession, setActiveBoxSession] = useState<{ barcode: string; packageId: string | null } | null>(null);
  const activeBoxSessionPackageIdRef = useRef<string | null>(null);
  const resolvedActiveBoxPackageId = (activeBoxSession?.packageId ?? "").trim();
  activeBoxSessionPackageIdRef.current = isUuidString(resolvedActiveBoxPackageId)
    ? resolvedActiveBoxPackageId
    : null;
  /** True after “+ Add New Box” until cancel or Apply locks a carton (Step 3 hub hides the intake card until this or a session). */
  const [packageCodeCardOpen, setPackageCodeCardOpen] = useState(false);

  useEffect(() => {
    if (flowPhase !== "package_scan") setPackageCodeCardOpen(false);
  }, [flowPhase]);

  useEffect(() => {
    if (flowPhase !== "package_scan") return;
    const s = activeBoxSession;
    if (!s || s.packageId !== null) return;
    const fromPallet = (activePallet?.carrier_name ?? "").trim();
    if (fromPallet) {
      parentPalletCarrierDefaultRef.current = fromPallet;
    }
    applyParentPalletCarrierAsUiDefault();
  }, [
    flowPhase,
    activeBoxSession?.barcode,
    activeBoxSession?.packageId,
    activePallet?.id,
    activePallet?.carrier_name,
    applyParentPalletCarrierAsUiDefault,
  ]);

  /** After refresh on box scan: prefer sessionStorage carrier over empty/hydrate-only state once per org/shipment key. */
  useEffect(() => {
    if (flowPhase !== "package_scan") {
      sessionCarrierRestoreKeyRef.current = null;
      return;
    }
    const oid = (orgId ?? "").trim();
    if (!oid || typeof window === "undefined") return;
    const pid = activePallet?.id?.trim() && isUuidString(activePallet.id) ? activePallet.id : "";
    const tn = (currentPalletTrackingId ?? "").trim();
    const restoreKey = pid ? `${oid}|p|${pid}` : tn ? `${oid}|t|${normalizeTrackingKey(tn) || tn}` : "";
    if (!restoreKey) return;
    const restoreToken = `${restoreKey}|${palletDocHydrationNonce}`;
    if (sessionCarrierRestoreKeyRef.current === restoreToken) return;
    sessionCarrierRestoreKeyRef.current = restoreToken;
    const storageKey = pid
      ? `operatorMobile:sessionCarrier:${oid}:pallet:${pid}`
      : `operatorMobile:sessionCarrier:${oid}:tn:${normalizeTrackingKey(tn) || tn}`;
    try {
      const saved = window.sessionStorage.getItem(storageKey)?.trim();
      if (!saved) return;
      if (palletCarrier.trim() === saved) return;
      const norm = normalizeCarrierLabel(saved);
      if (norm && norm !== OTHER_CARRIER_NAME) {
        setPalletCarrierOtherSelected(false);
        setPalletCarrier(norm);
        persistOperatorSessionCarrier(norm);
        mergeCarrierIntoActivePalletState(norm);
      } else {
        setPalletCarrierOtherSelected(true);
        setPalletCarrier(saved);
        persistOperatorSessionCarrier(saved);
        mergeCarrierIntoActivePalletState(saved);
      }
    } catch {
      /* ignore */
    }
  }, [
    flowPhase,
    orgId,
    activePallet?.id,
    currentPalletTrackingId,
    palletDocHydrationNonce,
    persistOperatorSessionCarrier,
    mergeCarrierIntoActivePalletState,
  ]);

  const [boxIntakeError, setBoxIntakeError] = useState<string | null>(null);
  const [duplicatePackingSlip, setDuplicatePackingSlip] = useState<DuplicatePackingSlipInfo | null>(null);
  /** Last packing-slip barcode parse (identify gate / shipment context). */
  const [slipBarcodeExtract, setSlipBarcodeExtract] = useState<SlipExtractResult | null>(null);
  /** BOX SCAN — `packages.*_photo_urls` (max 3 each). */
  const [outsideBoxPhotoUrls, setOutsideBoxPhotoUrls] = useState<string[]>([]);
  const [insideBoxPhotoUrls, setInsideBoxPhotoUrls] = useState<string[]>([]);
  const [slipBoxPhotoUrls, setSlipBoxPhotoUrls] = useState<string[]>([]);
  const slipBoxPhotoUrlsRef = useRef<string[]>([]);
  useEffect(() => {
    outsideBoxPhotoUrlsRef.current = outsideBoxPhotoUrls;
  }, [outsideBoxPhotoUrls]);
  useEffect(() => {
    insideBoxPhotoUrlsRef.current = insideBoxPhotoUrls;
  }, [insideBoxPhotoUrls]);
  const [boxSlipCode, setBoxSlipCode] = useState("");
  const boxSlipCodeRef = useRef("");
  useEffect(() => {
    boxSlipCodeRef.current = boxSlipCode;
  }, [boxSlipCode]);
  const [boxSlipRma, setBoxSlipRma] = useState("");
  const boxSlipRmaRef = useRef("");
  useEffect(() => {
    boxSlipRmaRef.current = boxSlipRma;
  }, [boxSlipRma]);

  /** `slip_contents.order_id` — slip-derived token (source of truth for this slip). */
  const [boxSlipOrderId, setBoxSlipOrderId] = useState("");
  /** `slip_contents.conflicting_order_id`: pallet-assigned order id when it disagreed with slip token at save (else ""). */
  const [boxSlipConflictingOrderId, setBoxSlipConflictingOrderId] = useState("");

  const [boxSlipVisionLines, setBoxSlipVisionLines] = useState<BoxSlipVisionLine[]>([]);
  const [boxSlipVisionLineLinkages, setBoxSlipVisionLineLinkages] = useState<
    ProductLinkageDisplayContract[]
  >([]);
  const boxSlipVisionLineLinkagesRef = useRef<ProductLinkageDisplayContract[]>([]);
  const boxSlipVisionLinesPersistRef = useRef<BoxSlipVisionLine[]>([]);
  const commitBoxSlipVisionLinesFromSource = useCallback((lines: BoxSlipVisionLine[]) => {
    const snap = clonePersistBoxSlipVisionLines(lines);
    boxSlipVisionLinesPersistRef.current = snap;
    setBoxSlipVisionLines(snap);
  }, []);
  const clearBoxSlipVisionLinesState = useCallback(() => {
    boxSlipVisionLinesPersistRef.current = [];
    setBoxSlipVisionLines([]);
    setBoxSlipVisionLineLinkages([]);
    setBoxSlipOrderId("");
    setBoxSlipConflictingOrderId("");
  }, []);

  const applyHydratedBoxSlipVisionSnapshot = useCallback(
    (snap: HydratedBoxSlipVisionSnapshot) => {
      if (snap.slipCode) setBoxSlipCode(snap.slipCode);
      setBoxSlipRma((prev) => (prev.trim() ? prev : snap.rma));
      setBoxSlipOrderId(snap.slipOrderId);
      setBoxSlipConflictingOrderId(snap.slipConflictingOrderId);
      const refHydrate = referenceOrderIdForPackageFieldAfterSlipLoad(
        { slip: snap.slipOrderId, conflicting: snap.slipConflictingOrderId },
        snap.packageOrderId,
      );
      if (refHydrate != null) {
        applySlipOrderIdIfEmpty(refHydrate);
      } else if (snap.rma) {
        applyPalletOrderIdFromRaIfApplicable(snap.rma);
      }
      commitBoxSlipVisionLinesFromSource(snap.lines);
      setBoxSlipInvalidFormatBlocksSave(false);
    },
    [
      commitBoxSlipVisionLinesFromSource,
      applySlipOrderIdIfEmpty,
      applyPalletOrderIdFromRaIfApplicable,
    ],
  );

  const hydrateBoxSlipVisionFromSavedPackage = useCallback(
    async (
      packageId: string,
      row: {
        manifest_data?: unknown;
        id_slip_contents?: unknown;
        slip_code?: unknown;
        slip_id?: unknown;
        rma_number?: unknown;
        order_id?: unknown;
      },
    ) => {
      const pid = String(packageId ?? "").trim();
      const oid = (orgId ?? "").trim();
      if (!pid || !isUuidString(pid) || !oid) return;
      try {
        const snap = await loadHydratedBoxSlipVisionSnapshot({
          packageId: pid,
          orgId: oid,
          storeId: sessionStoreId ?? null,
          manifestRaw: row.manifest_data,
          idSlipContents: row.id_slip_contents ?? row.slip_code ?? row.slip_id ?? "",
          rmaNumber: row.rma_number,
          packageOrderId: row.order_id,
        });
        if (hydrateBoxPackageIdRef.current !== pid) return;
        applyHydratedBoxSlipVisionSnapshot(snap);
        finalizeBoxIntakeBaselineRef.current?.();
      } catch {
        /* resume hydration is best-effort */
      }
    },
    [orgId, sessionStoreId, applyHydratedBoxSlipVisionSnapshot],
  );

  const [boxSlipVisionBusy, setBoxSlipVisionBusy] = useState(false);

  useEffect(() => {
    if (!orgId || !sessionStoreId || !isSupabaseConfigured() || boxSlipVisionLines.length === 0) {
      boxSlipVisionLineLinkagesRef.current = [];
      setBoxSlipVisionLineLinkages([]);
      return;
    }
    let cancelled = false;
    void (async () => {
      const res = await previewOperatorSlipLinesIdentifiersLinkageAction({
        requestedOrganizationId: orgId,
        storeId: sessionStoreId,
        lines: boxSlipVisionLines.map((line) => ({
          upc: line.upc,
          fnsku: line.fnsku,
          printed_asin: line.printed_asin,
        })),
      });
      if (cancelled) return;
      const next = res.ok ? res.linkages : [];
      boxSlipVisionLineLinkagesRef.current = next;
      setBoxSlipVisionLineLinkages(next);
    })();
    return () => {
      cancelled = true;
    };
  }, [boxSlipVisionLines, orgId, sessionStoreId]);

  /** Set when /api/scanner/extract-box-slip returns INVALID_SLIP_FORMAT — blocks Save until slip is replaced or removed. */
  const [boxSlipInvalidFormatBlocksSave, setBoxSlipInvalidFormatBlocksSave] = useState(false);
  const [boxSaveBusy, setBoxSaveBusy] = useState(false);
  const [boxNotes, setBoxNotes] = useState("");
  const boxNotesRef = useRef("");
  const [palletPackagePickerList, setPalletPackagePickerList] = useState<OperatorPackageListRow[]>([]);
  const palletPackagePickerListRef = useRef<OperatorPackageListRow[]>([]);
  palletPackagePickerListRef.current = palletPackagePickerList;
  const [palletPackagePickerQuery, setPalletPackagePickerQuery] = useState("");
  const palletPackageSearchInputRef = useRef<HTMLInputElement>(null);
  const hydrateBoxPackageIdRef = useRef<string | null>(null);

  const clearOperatorPhotoArrays = useCallback((fields: OperatorPhotoClearField[]) => {
      for (const field of fields) {
        switch (field) {
          case "slip":
            setSlipBoxPhotoUrls([]);
            slipBoxPhotoUrlsRef.current = [];
            evidenceBaselineRef.current.slip = [];
            break;
          case "shipping":
            setShippingLabelPhotoUrls([]);
            shippingLabelPhotoUrlsRef.current = [];
            evidenceBaselineRef.current.shipping = [];
            break;
          case "bol":
            setBolPhotoUrls([]);
            bolPhotoUrlsRef.current = [];
            evidenceBaselineRef.current.bol = [];
            break;
          case "outside":
            setOutsideBoxPhotoUrls([]);
            outsideBoxPhotoUrlsRef.current = [];
            evidenceBaselineRef.current.outside = [];
            break;
          case "inside":
            setInsideBoxPhotoUrls([]);
            insideBoxPhotoUrlsRef.current = [];
            evidenceBaselineRef.current.inside = [];
            break;
          default:
            break;
        }
      }
  }, []);

  /** Same readiness as the package-list fetch: Step 3, org context, persisted UUID pallet (draft ids skip). */
  const operatorSavedBoxSearchAvailable =
    isSupabaseConfigured() &&
    flowPhase === "package_scan" &&
    Boolean((orgId ?? "").trim()) &&
    Boolean(activePallet?.id && isUuidString((activePallet.id ?? "").trim()));
  /** Hidden laser buffer follows carton field only when the intake card is shown (new box path or no saved-box search UI). */
  const packageScanUsesHiddenCartonBuffer =
    flowPhase === "package_scan" &&
    !activeBoxSession &&
    (packageCodeCardOpen || !operatorSavedBoxSearchAvailable);
  const showOperatorPackageIntakePanel =
    Boolean(activeBoxSession) || packageCodeCardOpen || !operatorSavedBoxSearchAvailable;

  useEffect(() => {
    boxNotesRef.current = boxNotes;
  }, [boxNotes]);

  /** Carton package receiving item scans (last saved or active locked box). */
  const [itemScanPackageId, setItemScanPackageId] = useState<string | null>(null);
  const [itemScanPackageLabel, setItemScanPackageLabel] = useState<string | null>(null);
  /** Σ slip line qty for the current receiving session (set on save from AI lines, or reloaded from `slip_contents`). */
  const [receivingSlipExpectedItemQtyTotal, setReceivingSlipExpectedItemQtyTotal] = useState<number | null>(null);
  /** Live units received for the active package (Supabase `packages.actual_item_count`). */
  const [itemReceivePackageActualCount, setItemReceivePackageActualCount] = useState<number | null>(null);
  /** Bumps after a successful receive so we re-read `actual_item_count` from the DB. */
  const [itemReceiveCountSyncNonce, setItemReceiveCountSyncNonce] = useState(0);
  /** Demo / no-store mode: item units recorded this session for the active demo package. */
  const [itemReceiveDemoScannedUnits, setItemReceiveDemoScannedUnits] = useState(0);
  const [expectedPkgDetailRows, setExpectedPkgDetailRows] = useState<Record<string, unknown>[]>([]);
  /** `slip_contents` lines for Step 3 (refetched when entering item inspection for a UUID package). */
  const [itemInspectionSlipLines, setItemInspectionSlipLines] = useState<OperatorSlipContentsListRow[]>([]);
  /** Box Info vision rows + preview linkage — survives phase flip before `slip_contents` resolves. */
  const [itemScanSlipCarryover, setItemScanSlipCarryover] = useState<ItemScanSlipCarryoverPayload | null>(
    null,
  );
  const itemScanSlipCarryoverRef = useRef<ItemScanSlipCarryoverPayload | null>(null);
  /** Set when item-phase EP fetch returns zero rows for an active tracking (live DB only). */
  const [itemDraft, setItemDraft] = useState<{
    barcode: string;
    tier: ItemResolveTier;
    epRow: Record<string, unknown>;
    identifierMatched: boolean;
    productNameMatched: boolean | null;
    catalogName: string | null;
    catalogImageUrl: string | null;
    expirationSupported: boolean;
  } | null>(null);
  const [candidatePicker, setCandidatePicker] = useState<{
    barcode: string;
    tier: ItemResolveTier;
    candidates: Record<string, unknown>[];
  } | null>(null);
  const [inspectionCondition, setInspectionCondition] = useState<InspectionCondition>("good");
  const [itemQtyStepper, setItemQtyStepper] = useState(1);
  const [itemNotes, setItemNotes] = useState("");
  const [itemExpiryDate, setItemExpiryDate] = useState("");
  const [itemBatch, setItemBatch] = useState("");
  const [itemPhotoFrontUrl, setItemPhotoFrontUrl] = useState<string | null>(null);
  const [itemPhotoBarcodeUrl, setItemPhotoBarcodeUrl] = useState<string | null>(null);
  const [itemPhotoDamageUrl, setItemPhotoDamageUrl] = useState<string | null>(null);
  const itemPhotoFrontRef = useRef<HTMLInputElement>(null);
  const itemPhotoBarcodeRef = useRef<HTMLInputElement>(null);
  const itemPhotoDamageRef = useRef<HTMLInputElement>(null);
  const itemPhotoFrontUrlRef = useRef<string | null>(null);
  const itemPhotoBarcodeUrlRef = useRef<string | null>(null);
  const itemPhotoDamageUrlRef = useRef<string | null>(null);
  const [itemReceiveError, setItemReceiveError] = useState<string | null>(null);
  const [scanSuccessFlash, setScanSuccessFlash] = useState(false);
  /** Brief highlight on the identification “glow” card after a successful inventory lookup or gate confirm. */
  const [identifyGateGlowFlash, setIdentifyGateGlowFlash] = useState(false);
  const [gateTrackingHelpOpen, setGateTrackingHelpOpen] = useState(false);
  const gateTrackingHelpRef = useRef<HTMLDivElement>(null);
  /** Shipment fully complete on the view — Yes/No before continuing or ending session. */
  const [completedShipmentModal, setCompletedShipmentModal] = useState<{ key: string; tracking: string } | null>(null);
  const [itemBarcodeMiss, setItemBarcodeMiss] = useState<string | null>(null);
  /** Item Scan: Edit All unlocks row selection + unit edit (separate from shipment Edit All). */
  const [itemScanEditAllMode, setItemScanEditAllMode] = useState(false);
  const [itemScanEditPick, setItemScanEditPick] = useState<ItemScanEditPick | null>(null);
  const [itemScanUnitPickerOpen, setItemScanUnitPickerOpen] = useState(false);
  /** Per-slip scanned unit counts for the active item-scan package. */
  const [packageItemScanState, setPackageItemScanState] = useState<{
    bySlipId: Record<string, number>;
    unexpectedUnits: number;
  }>({ bySlipId: {}, unexpectedUnits: 0 });
  const [packageItemHydratedRows, setPackageItemHydratedRows] = useState<OperatorPackageItemRow[]>([]);
  const [packageItemsHydrating, setPackageItemsHydrating] = useState(false);
  const [itemInspectionSlipLinesLoading, setItemInspectionSlipLinesLoading] = useState(false);
  const [packageItemsHydrationNonce, setPackageItemsHydrationNonce] = useState(0);
  const [slipLineCandidatePicker, setSlipLineCandidatePicker] = useState<{
    barcode: string;
    tier: SlipItemResolveTier;
    candidates: SlipBarcodeMatchRow[];
  } | null>(null);
  const [unexpectedPackageItemModal, setUnexpectedPackageItemModal] = useState<{ barcode: string } | null>(null);
  const [itemUnitModal, setItemUnitModal] = useState<ItemUnitModalContext | null>(null);
  const [itemOverscanWarning, setItemOverscanWarning] = useState<string | null>(null);
  const [syncErrorToast, setSyncErrorToast] = useState<string | null>(null);

  const [expectedPkgLines, setExpectedPkgLines] = useState<TrackingOperatorLine[]>([]);
  /** Item phase — `loadTrackingExpectationSnapshot` base lines (re-merged on package hydrate). */
  const [itemScanExpectationSnapshotLines, setItemScanExpectationSnapshotLines] = useState<TrackingOperatorLine[]>([]);
  const [itemScanExpectationLoading, setItemScanExpectationLoading] = useState(false);
  /** Server-hydrated linkage from `operatorReceiveItem` — keyed by `expected_packages.id`. */
  const [epReceiveLinkageByEpId, setEpReceiveLinkageByEpId] = useState<
    Record<string, ProductLinkageDisplayContract>
  >({});
  const [expectedPkgTotals, setExpectedPkgTotals] = useState<TrackingExpectationTotals | null>(null);
  const [expectedPkgError, setExpectedPkgError] = useState<string | null>(null);
  /** Row count of raw `expected_packages` rows for this parent (used for box-count discrepancy vs physical). */
  const [expectedPackagesRawRowCount, setExpectedPackagesRawRowCount] = useState<number | null>(null);
  /** Locked when leaving Step 2 so Box Scan denominator stays stable for progress + headers. */
  const [boxScanTargetDenominator, setBoxScanTargetDenominator] = useState<number | null>(null);
  /** Increment to replay the physical-count shake animation. */
  const [physicalCountShakeSeq, setPhysicalCountShakeSeq] = useState(0);
  /** Distinct `tracking_number` values present on loaded `expected_packages` rows — for carton scan match toast. */
  const [expectedPkgTrackingNumbers, setExpectedPkgTrackingNumbers] = useState<string[]>([]);
  const [intakeToast, setIntakeToast] = useState<string | null>(null);
  type ScanActionToastVariant = "success" | "neutral" | "error";
  const [scanActionToast, setScanActionToast] = useState<{
    variant: ScanActionToastVariant;
    message: string;
  } | null>(null);
  const [identifyGatePhotoOcrToast, setIdentifyGatePhotoOcrToast] = useState<string | null>(null);
  const [identifyGatePhotoOcrCandidates, setIdentifyGatePhotoOcrCandidates] = useState<string[]>([]);
  const [identifyGateSelectedPhotoOcrCandidate, setIdentifyGateSelectedPhotoOcrCandidate] = useState<string | null>(null);
  const [identifyGateOcrReading, setIdentifyGateOcrReading] = useState(false);
  const [identifyGateOcrProgressPct, setIdentifyGateOcrProgressPct] = useState(0);
  const [identifyGateOcrMenuOpen, setIdentifyGateOcrMenuOpen] = useState(false);
  const [identifyGateOcrDropHighlight, setIdentifyGateOcrDropHighlight] = useState(false);
  const identifyGateCameraCaptureRef = useRef<HTMLInputElement>(null);
  const identifyGateCameraUploadRef = useRef<HTMLInputElement>(null);
  const identifyGateOcrBusyRef = useRef(false);
  /** Set after {@link resumeWorkflowFromExistingPalletRow} — used by gate search defined earlier in the file. */
  const resumeFromPalletLookupRef = useRef<
    (
      row: OperatorPalletTrackingRow,
      enteredCode: string,
      opts?: { packageRow?: Record<string, unknown> },
    ) => void | Promise<void>
  >(() => {});
  const tryResumeSavedReceivingRef = useRef<
    (
      enteredCode: string,
      gateLookup: ShipmentEntryLookupResult | null,
    ) => Promise<"resumed" | "wrong_store" | "error" | false>
  >(async () => false);
  const maybeResumeItemScanAfterPackageRowRef = useRef<
    (row: Record<string, unknown>, opts?: { directBox?: boolean }) => Promise<boolean>
  >(async () => false);

  const packageScanLaserSuppressed =
    flowPhase === "package_scan" &&
    (Boolean(activeBoxSession) || (operatorSavedBoxSearchAvailable && !packageCodeCardOpen));
  const laserEnabled =
    ((!isIdentified && flowPhase === "scan") ||
      (isIdentified && (flowPhase === "scan" || flowPhase === "package_scan" || flowPhase === "items"))) &&
    !manualOpen &&
    !packageScanLaserSuppressed &&
    !(flowPhase === "items" && isIdentified && !hasReceivableBoxForItems(itemScanPackageId, activeBoxSession));

  const focusScannerAggressive = useCallback(() => {
    if (manualEntryModeRef.current || manualOpen || !laserEnabled) return;
    if (busy && flowPhase !== "items") return;
    const el = scannerRef.current;
    if (!el) return;
    const active = typeof document !== "undefined" ? (document.activeElement as HTMLElement | null) : null;
    if (active && active !== document.body && active !== el) {
      const tag = active.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || active.isContentEditable) return;
    }
    try {
      el.focus({ preventScroll: true });
    } catch {
      el.focus();
    }
  }, [manualOpen, laserEnabled, busy, flowPhase]);

  const scheduleFocusScanner = useCallback(() => {
    if (manualEntryModeRef.current || manualOpen || !laserEnabled) return;
    window.setTimeout(() => focusScannerAggressive(), 0);
  }, [manualOpen, laserEnabled, focusScannerAggressive]);

  useEffect(() => {
    const onRequestScanFocus = () => scheduleFocusScanner();
    window.addEventListener("operator-mobile:request-scan-focus", onRequestScanFocus);
    return () => window.removeEventListener("operator-mobile:request-scan-focus", onRequestScanFocus);
  }, [scheduleFocusScanner]);

  const showScanActionToast = useCallback((variant: ScanActionToastVariant, message: string) => {
    const text = message.trim();
    if (!text) return;
    setScanActionToast({ variant, message: text });
  }, []);

  const clearPreviousLookupResult = useCallback(
    (options?: {
      phase?: IdentifyGatePhase;
      enteredCode?: string;
      clearResolvedContext?: boolean;
      clearScanLine?: boolean;
    }) => {
      setIdentifyGateError(null);
      setIdentifyGateSlowHint(null);
      setIdentifyGateEnteredCode(options?.enteredCode ?? "");
      setIdentifyGateRows([]);
      setIdentifyGateCanonicalTracking(null);
      setIdentifyGateMatchField(null);
      setIdentifyGateEntity(null);
      setIdentifyGatePhysicalBoxStr("");
      setIdentifyGateInventoryAgg(null);
      setIdentifyGateInventoryVisual(null);
      setIdentifyGateViewHints(null);
      setIdentifyGateShipmentLines([]);
      setIdentifyGateBatchProductNames(new Map());
      setIdentifyGateExpectationLines([]);
      setIdentifyGatePhotoOcrToast(null);
      setIdentifyGatePhotoOcrCandidates([]);
      setIdentifyGateSelectedPhotoOcrCandidate(null);
      setIdentifyGateOcrMenuOpen(false);
      setIdentifyGateOcrDropHighlight(false);
      setIdentifyGateGlowFlash(false);
      setAwaitingPostCompleteExtraScan(false);
      setCompletedShipmentModal(null);
      setGateTrackingHelpOpen(false);
      completedShipmentDialogShownForKeyRef.current = null;
      postCompleteTrackingRef.current = null;
      if (options?.clearScanLine) setScanLine("");
      if (options?.clearResolvedContext) {
        setActivePallet(null);
        setActiveTracking(null);
        setCurrentPalletTrackingId(null);
        setActiveSlipOrPackage(null);
        setActiveBoxSession(null);
        setDirectBox(false);
      }
      setIdentifyGatePhase(options?.phase ?? "idle");
      if (options?.phase === "searching") {
        setScanProgressPhase("checking");
      } else if (!options?.phase || options.phase === "idle") {
        setScanProgressPhase("idle");
      }
    },
    [],
  );

  useEffect(() => {
    if (flowPhase !== "scan" || isIdentified) return;
    if (identifyGateOcrReading) {
      setScanProgressPhase("reading");
      return;
    }
    if (identifyGatePhase === "searching" && busy) {
      setScanProgressPhase((prev) =>
        prev === "reading" || prev === "loading_expected_lines" ? prev : "checking",
      );
      return;
    }
    if (identifyGatePhase === "matched") setScanProgressPhase("ready");
    else if (identifyGatePhase === "new") setScanProgressPhase("needs_review");
    else if (identifyGatePhase === "idle" && identifyGateError) setScanProgressPhase("error");
    else if (identifyGatePhase === "idle" && !busy) setScanProgressPhase("idle");
  }, [flowPhase, isIdentified, identifyGateOcrReading, identifyGatePhase, busy, identifyGateError]);

  const closeItemUnitModal = useCallback(
    (cancelled: boolean) => {
      if (busy) return;
      modalOpenRef.current = false;
      itemUnitModalDraftDirtyRef.current = false;
      setItemUnitModal(null);
      if (cancelled) showScanActionToast("neutral", "Action cancelled.");
      scheduleFocusScanner();
    },
    [busy, scheduleFocusScanner, showScanActionToast],
  );

  const handleItemUnitModalUnsavedDraftChange = useCallback((dirty: boolean) => {
    itemUnitModalDraftDirtyRef.current = dirty;
  }, []);

  useEffect(() => {
    scheduleFocusScanner();
  }, [scheduleFocusScanner, unknownModal, activePallet, directBox, manualOpen, flowPhase]);

  useEffect(() => {
    if (!itemUnitModal || busy) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      closeItemUnitModal(true);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [itemUnitModal, busy, closeItemUnitModal]);

  const identifyGateSummary = useMemo(
    () => summarizeExpectedPackageRowsForGate(identifyGateRows),
    [identifyGateRows],
  );

  const identifyGateOrderIdsLabel = useMemo(() => {
    const ids = new Set<string>();
    for (const r of identifyGateShipmentLines) {
      const o = r.order_id?.trim();
      if (o) ids.add(o);
    }
    for (const r of identifyGateRows) {
      const o = String((r as { order_id?: unknown }).order_id ?? "").trim();
      if (o) ids.add(o);
    }
    if (ids.size === 0) return "—";
    return [...ids].join(", ");
  }, [identifyGateShipmentLines, identifyGateRows]);

  const identifyGateEpById = useMemo(() => {
    const m = new Map<string, Record<string, unknown>>();
    for (const raw of identifyGateRows) {
      const id = String((raw as { id?: string }).id ?? "").trim();
      if (id) m.set(id, raw);
    }
    return m;
  }, [identifyGateRows]);

  const identifyGateEpBySkuFnsku = useMemo(() => {
    const m = new Map<string, Record<string, unknown>>();
    for (const raw of identifyGateRows) {
      const sku = String((raw as { sku?: string }).sku ?? "").trim().toLowerCase();
      const fnsku = String((raw as { fnsku?: string }).fnsku ?? "").trim().toLowerCase();
      const orderId = String((raw as { order_id?: string }).order_id ?? "").trim().toLowerCase();
      if (sku || fnsku) m.set(`${sku}\u0000${fnsku}\u0000${orderId}`, raw);
    }
    return m;
  }, [identifyGateRows]);

  const identifyGateResolvedNameMap = useMemo(() => {
    const m = new Map<string, string>();
    for (const [id, nm] of identifyGateBatchProductNames) {
      if (id && nm.trim()) m.set(id, nm.trim());
    }
    for (const raw of identifyGateRows) {
      const r = raw as {
        resolved_product_id?: string | null;
        product_id?: string | null;
        resolved_catalog_product_id?: string | null;
      };
      const rid = String(r.resolved_product_id ?? r.product_id ?? r.resolved_catalog_product_id ?? "").trim();
      const nm = epPackageRowCatalogSubtitle(raw)?.trim();
      if (rid && nm) m.set(rid, nm);
    }
    for (const line of identifyGateShipmentLines) {
      const rid = String(
        line.resolved_product_id ?? line.product_id ?? line.resolved_catalog_product_id ?? "",
      ).trim();
      const nm = inventoryLineDisplayName(line) ?? "";
      if (rid && nm) m.set(rid, nm);
    }
    for (const line of identifyGateExpectationLines) {
      const rid = line.product_linkage?.resolved_product_id?.trim() ?? "";
      const nm = line.product_linkage?.product_name?.trim() ?? "";
      if (rid && nm) m.set(rid, nm);
    }
    return m;
  }, [identifyGateBatchProductNames, identifyGateRows, identifyGateExpectationLines, identifyGateShipmentLines]);

  const runIdentificationGateSearch = useCallback(
    async (rawCode: string, runOpts?: { fullSearch?: boolean }) => {
      const trimmed = rawCode.trim();
      if (!trimmed) return;
      setModernPalletWorkspace(false);
      setDeepSearchAvailableFor(null);
      if (runOpts?.fullSearch) setIdentifyGateDeepSearchRunning(true);
      else setIdentifyGateDeepSearchRunning(false);
      clearPreviousLookupResult({
        phase: "searching",
        enteredCode: trimmed,
        clearResolvedContext: true,
      });
      setBusy(true);
      setScanProgressPhase("checking");
      const lookupStartedAt = performance.now();
      const useSkipFallback = !runOpts?.fullSearch && isLikelyShipmentTrackingCode(trimmed);
      try {
        if (!isSupabaseConfigured()) {
          const demoLookup = mockLookupShipmentEntryScanCode(trimmed);
          const invRowsDemo = demoLookup.inventory_rows;
          setIdentifyGateMatchField(demoLookup.inventory_matched_field);
          const agg = aggregateInventoryStatus(invRowsDemo);
          const vis = resolveInventoryGateVisualStatus(invRowsDemo, agg);
          setIdentifyGateInventoryAgg(agg);
          setIdentifyGateInventoryVisual(vis);
          setIdentifyGateViewHints(pickInventoryViewHints(invRowsDemo));
          if (vis === "manual_new" && isShipmentEntryOffManifest(demoLookup)) {
            setIdentifyGatePhase("new");
            setIdentifyGateMatchField(null);
            setIdentifyGateCanonicalTracking(trimmed);
            return;
          }
          if (vis === "manual_new" && demoLookup.barcode.kind === "pallet") {
            setIdentifyGatePhase("new");
            setIdentifyGateCanonicalTracking(demoLookup.canonical_tracking ?? trimmed);
            return;
          }
          const ids = invRowsDemo.map((r) => r.expected_package_id).filter(Boolean);
          const allMock = mockExpectedPackageDetailRows();
          const detailRows = allMock.filter((r) => ids.includes(String((r as { id?: string }).id ?? "")));
          const canonDemo = demoLookup.canonical_tracking ?? trimmed;
          setIdentifyGateRows(detailRows);
          setIdentifyGateCanonicalTracking(canonDemo);
          setIdentifyGateEntity(
            identifyGateEntityForManifestMatch(demoLookup.inventory_matched_field, demoLookup.match_status),
          );
          const demoSnap = mockTrackingExpectationSnapshot(canonDemo);
          setIdentifyGateExpectationLines(demoSnap.lines);
          const lineField: ShipmentEntryItemViewMatchField =
            demoLookup.inventory_matched_field ?? "tracking_number";
          const lineValue =
            lineField === "id_slip_contents" || lineField === "fnsku" || lineField === "sku" ? trimmed : canonDemo;
          setIdentifyGateShipmentLines(
            invRowsDemo.length
              ? invRowsDemo
              : mockVInventoryItemStatusLinesForExact(
                  lineField as InventoryViewMatchField,
                  lineValue,
                ),
          );
          setIdentifyGatePhase("matched");
          setScanProgressPhase("ready");
          playOperatorSuccessBeep();
          setIdentifyGateGlowFlash(true);
          return;
        }
        if (!sessionStoreId) {
          setIdentifyGateError(
            kioskStoreLocked
              ? "Store context missing — check NEXT_PUBLIC_STORE_ID."
              : operatorStores.length > 1
                ? "Select an active store above (Store row) before searching."
                : "Select or configure a store.",
          );
          setIdentifyGatePhase("idle");
          setScanProgressPhase("error");
          return;
        }

        let gateLookup: Awaited<ReturnType<typeof lookupShipmentEntryScanCode>>;
        try {
          if (isSupabaseConfigured()) {
            const gateRes = await withIdentifyGateLookupTimeout(
              lookupShipmentEntryScanCodeAction(orgId, sessionStoreId, trimmed, { skipExpensiveFallback: useSkipFallback }),
            );
            if (!gateRes.ok) {
              throw new Error(gateRes.error);
            }
            gateLookup = gateRes.lookup;
          } else {
            gateLookup = await withIdentifyGateLookupTimeout(
              lookupShipmentEntryScanCode(supabase, orgId, sessionStoreId, trimmed, { skipExpensiveFallback: useSkipFallback }),
            );
          }
        } catch (err) {
          console.warn("lookupShipmentEntryScanCode failed; inventory slice skipped.", err);
          const emptyAgg = aggregateInventoryStatus([]);
          const timedOut = err instanceof Error && /timed out/i.test(err.message);
          if (timedOut) {
            setIdentifyGateSlowHint(
              "Inventory status is slow or unavailable. You can continue with manual shipment entry below.",
            );
          }
          gateLookup = {
            normalized_code: trimmed,
            match_status: "not_found",
            entity_type: "unknown",
            entity_id: null,
            status_label: timedOut ? "Lookup timed out" : "Lookup error",
            status_detail: err instanceof Error ? err.message : "Lookup failed",
            next_action: "show_not_found",
            inventory_rows: [],
            inventory_matched_field: null,
            inventory_visual: resolveInventoryGateVisualStatus([], emptyAgg),
            barcode: { kind: "unknown", code: trimmed },
            canonical_tracking: null,
          };
        }

        let invRows = gateLookup.inventory_rows;
        const gateMatchField = gateLookup.inventory_matched_field;
        const submittedTrackingForScope = trimmed;

        const lookupTimingPath: IdentifyGateLookupTimingPath = runOpts?.fullSearch
          ? "deep_search"
          : useSkipFallback && isShipmentEntryOffManifest(gateLookup)
            ? "fast_miss"
            : "exact_hit";
        logIdentifyGateLookupTiming(lookupTimingPath, performance.now() - lookupStartedAt, trimmed);

        if (gateMatchField === "tracking_number") {
          invRows = trackingScopedInventoryRows(invRows, submittedTrackingForScope);
        }
        setIdentifyGateMatchField(gateMatchField);
        if (invRows.length) {
          setIdentifyGateEntity(identifyGateEntityForManifestMatch(gateMatchField, gateLookup.match_status));
        }

        const agg = aggregateInventoryStatus(invRows);
        const vis = resolveInventoryGateVisualStatus(invRows, agg);

        const resumeSaved = await tryResumeSavedReceivingRef.current(trimmed, gateLookup);
        if (resumeSaved === "resumed") {
          playOperatorSuccessBeep();
          setIdentifyGateGlowFlash(true);
          return;
        }
        if (resumeSaved === "wrong_store") {
          setIdentifyGatePhase("idle");
          return;
        }
        if (resumeSaved === "error") {
          setIdentifyGatePhase("idle");
          return;
        }

        if (vis === "manual_new" && isShipmentEntryOffManifest(gateLookup)) {
          if (useSkipFallback) {
            setDeepSearchAvailableFor(trimmed);
          }
          setIdentifyGateError(null);
          setIdentifyGatePhase("new");
          setScanProgressPhase("needs_review");
          setIdentifyGateInventoryAgg(agg);
          setIdentifyGateInventoryVisual(vis);
          setIdentifyGateViewHints(null);
          setIdentifyGateEntity(null);
          setIdentifyGateRows([]);
          setIdentifyGateCanonicalTracking(trimmed);
          setIdentifyGateShipmentLines([]);
          setIdentifyGateExpectationLines([]);
          setIdentifyGateMatchField(null);
          return;
        }

        setScanProgressPhase("loading_expected_lines");

        const ids = [...new Set(invRows.map((r) => r.expected_package_id).filter(Boolean))];
        let detailRows: Record<string, unknown>[] = [];
        if (ids.length) {
          try {
            detailRows = await fetchExpectedPackageDetailRowsByIds(supabase, orgId, sessionStoreId, ids);
          } catch (err) {
            console.warn("fetchExpectedPackageDetailRowsByIds failed", err);
          }
        }
        if (!detailRows.length) {
          detailRows = await fetchExpectedPackageDetailRowsForParent(supabase, orgId, sessionStoreId, {
            trackingNumber: gateLookup.canonical_tracking ?? trimmed,
            palletId: null,
          });
        }
        const safe = Array.isArray(detailRows) ? detailRows : [];
        const canon =
          gateLookup.canonical_tracking ??
          invRows.map((r) => String(r.tracking_number ?? "").trim()).find(Boolean) ??
          (String(safe[0]?.tracking_number ?? "").trim() || trimmed);
        const scopedSafe = gateMatchField === "tracking_number" ? trackingScopedExpectedRows(safe, submittedTrackingForScope) : safe;
        setIdentifyGateRows(scopedSafe);
        setIdentifyGateCanonicalTracking(canon);

        let expectationLines: TrackingOperatorLine[] = [];
        if (sessionStoreId && canon) {
          try {
            const snap = await loadTrackingExpectationSnapshot(
              supabase,
              orgId,
              sessionStoreId,
              gateMatchField === "tracking_number" ? submittedTrackingForScope : canon,
            );
            expectationLines = snap.lines;
          } catch (err) {
            console.warn("loadTrackingExpectationSnapshot failed", err);
          }
        }
        setIdentifyGateExpectationLines(expectationLines);

        let shipmentLines: VInventoryStatusRow[] = invRows.length ? invRows : [];
        if (sessionStoreId && gateMatchField === "tracking_number" && !invRows.length) {
          try {
            let rows: VInventoryStatusRow[] = [];
            if (isSupabaseConfigured()) {
              const lineRes = await fetchInventoryItemStatusLinesForGateAction(orgId, sessionStoreId, {
                mode: "tracking",
                trackingNumber: submittedTrackingForScope,
              });
              if (lineRes.ok) rows = lineRes.rows;
              else console.warn("fetchInventoryItemStatusLinesForGateAction failed", lineRes.error);
            } else {
              const fetched = await fetchVInventoryItemStatusLinesForTrackingNormalized(
                supabase,
                orgId,
                sessionStoreId,
                submittedTrackingForScope,
              );
              rows = fetched.rows;
            }
            shipmentLines = rows.length ? trackingScopedInventoryRows(rows, submittedTrackingForScope) : shipmentLines;
          } catch (err) {
            console.warn("fetchVInventoryItemStatusLinesForTrackingNormalized failed", err);
          }
        } else if (!shipmentLines.length && sessionStoreId && gateMatchField) {
          const narrowFields: InventoryViewMatchField[] = [
            "fnsku",
            "sku",
            "tracking_number",
            "id_slip_contents",
          ];
          if (narrowFields.includes(gateMatchField as InventoryViewMatchField)) {
            const lineValue =
              gateMatchField === "id_slip_contents" || gateMatchField === "fnsku" || gateMatchField === "sku"
                ? trimmed
                : canon || trimmed;
            try {
              let rows: VInventoryStatusRow[] = [];
              if (isSupabaseConfigured()) {
                const lineRes = await fetchInventoryItemStatusLinesForGateAction(orgId, sessionStoreId, {
                  mode: "exact",
                  field: gateMatchField as InventoryViewMatchField,
                  value: lineValue,
                });
                if (lineRes.ok) rows = lineRes.rows;
                else console.warn("fetchInventoryItemStatusLinesForGateAction failed", lineRes.error);
              } else {
                const fetched = await fetchVInventoryItemStatusLinesExact(
                  supabase,
                  orgId,
                  sessionStoreId,
                  gateMatchField as InventoryViewMatchField,
                  lineValue,
                );
                rows = fetched.rows;
              }
              shipmentLines = rows;
            } catch (err) {
              console.warn("fetchVInventoryItemStatusLinesExact failed", err);
            }
          }
        }
        if (gateMatchField === "tracking_number") {
          shipmentLines = trackingScopedInventoryRows(shipmentLines, submittedTrackingForScope);
        }
        const scopedAggregateRows = gateMatchField === "tracking_number" ? shipmentLines : invRows;
        const scopedAgg = aggregateInventoryStatus(scopedAggregateRows);
        const scopedVis =
          gateMatchField === "tracking_number"
            ? deriveInventoryGateVisualStatus(scopedAgg)
            : resolveInventoryGateVisualStatus(scopedAggregateRows, scopedAgg);
        if (
          gateMatchField === "tracking_number" &&
          shipmentLines.length === 0 &&
          scopedSafe.length === 0 &&
          expectationLines.length === 0
        ) {
          if (useSkipFallback) {
            setDeepSearchAvailableFor(trimmed);
          }
          setIdentifyGateError(null);
          setIdentifyGatePhase("new");
          setScanProgressPhase("needs_review");
          setIdentifyGateInventoryAgg(scopedAgg);
          setIdentifyGateInventoryVisual("manual_new");
          setIdentifyGateViewHints(null);
          setIdentifyGateEntity(null);
          setIdentifyGateRows([]);
          setIdentifyGateCanonicalTracking(trimmed);
          setIdentifyGateShipmentLines([]);
          setIdentifyGateExpectationLines([]);
          setIdentifyGateMatchField(null);
          return;
        }
        setIdentifyGateInventoryAgg(scopedAgg);
        setIdentifyGateInventoryVisual(scopedVis);
        setIdentifyGateViewHints(pickInventoryViewHints(scopedAggregateRows));
        setIdentifyGateShipmentLines(shipmentLines);
        setIdentifyGateEntity((prev) =>
          prev ?? identifyGateEntityForManifestMatch(gateMatchField, gateLookup.match_status),
        );
        setIdentifyGatePhase("matched");
        setScanProgressPhase("ready");
        // Pre-fill box count from manifest so the operator can confirm or override
        if (!identifyGatePhysicalBoxStr.trim()) {
          const manifestCount = resolveMatchedGatePalletBoxCount("", shipmentLines, scopedSafe, scopedAgg);
          if (manifestCount != null && manifestCount > 0) {
            setIdentifyGatePhysicalBoxStr(String(manifestCount));
          }
        }
        if (!invRows.length && !shipmentLines.length && !scopedSafe.length) {
          setIdentifyGateSlowHint(
            (prev) =>
              prev ??
              "No inventory status rows for this code — continue with Shipment Entry or manual tracking.",
          );
        }
        const viewNames = collectGateProductNamesFromLines(scopedSafe, shipmentLines);
        setIdentifyGateBatchProductNames(viewNames);
        if (isSupabaseConfigured() && sessionStoreId) {
          const productIds = collectGateResolvedProductIds(scopedSafe, shipmentLines);
          const missingIds = productIds.filter((id) => !viewNames.has(id));
          if (missingIds.length) {
            void withIdentifyGateLookupTimeout(
              fetchGateProductNamesByIdsAction(orgId, missingIds),
              12_000,
            )
              .then((nameRes) => {
                if (!nameRes.ok) {
                  console.warn("fetchGateProductNamesByIdsAction failed", nameRes.error);
                  return;
                }
                setIdentifyGateBatchProductNames((prev) => {
                  const merged = new Map(prev);
                  for (const [id, nm] of Object.entries(nameRes.names)) {
                    if (id && nm.trim()) merged.set(id, nm.trim());
                  }
                  return merged;
                });
              })
              .catch((err) => {
                console.warn("fetchGateProductNamesByIdsAction failed", err);
              });
          }
        }
        playOperatorSuccessBeep();
        setIdentifyGateGlowFlash(true);
      } catch (e) {
        console.error(e);
        setIdentifyGateError(e instanceof Error ? e.message : "Lookup failed.");
        setIdentifyGatePhase("idle");
        setScanProgressPhase("error");
        setIdentifyGateInventoryAgg(null);
        setIdentifyGateInventoryVisual(null);
        setIdentifyGateViewHints(null);
        setIdentifyGateShipmentLines([]);
        setIdentifyGateExpectationLines([]);
        setIdentifyGateMatchField(null);
      } finally {
        setBusy(false);
        setIdentifyGateDeepSearchRunning(false);
        scheduleFocusScanner();
      }
    },
    [orgId, sessionStoreId, kioskStoreLocked, operatorStores.length, scheduleFocusScanner, clearPreviousLookupResult],
  );

  /**
   * Reruns the full lookup (with ILIKE deep scan) for a code that previously had a fast no-match.
   * Only callable when deepSearchAvailableFor is set.
   */
  const handleDeepSearch = useCallback(() => {
    const code = deepSearchAvailableFor;
    if (!code) return;
    setIdentifyGateDeepSearchRunning(true);
    void runIdentificationGateSearch(code, { fullSearch: true });
  }, [deepSearchAvailableFor, runIdentificationGateSearch]);

  useEffect(() => {
    if (identifyGatePhase !== "matched") return;
    if (identifyGateInventoryVisual !== "completed") return;
    const entered = identifyGateEnteredCode.trim();
    if (!entered) return;
    const key = `${entered}::${(identifyGateCanonicalTracking ?? "").trim()}::completed`;
    if (completedShipmentDialogShownForKeyRef.current === key) return;
    completedShipmentDialogShownForKeyRef.current = key;
    const tn = (identifyGateCanonicalTracking ?? identifyGateEnteredCode).trim();
    setCompletedShipmentModal({ key, tracking: tn });
    queueMicrotask(() => scheduleFocusScanner());
  }, [
    identifyGatePhase,
    identifyGateInventoryVisual,
    identifyGateCanonicalTracking,
    identifyGateEnteredCode,
    scheduleFocusScanner,
  ]);

  useEffect(() => {
    return () => {
      if (itemPhotoFrontUrlRef.current) URL.revokeObjectURL(itemPhotoFrontUrlRef.current);
      if (itemPhotoBarcodeUrlRef.current) URL.revokeObjectURL(itemPhotoBarcodeUrlRef.current);
      if (itemPhotoDamageUrlRef.current) URL.revokeObjectURL(itemPhotoDamageUrlRef.current);
    };
  }, []);

  const loadPalletDetail = useCallback(async (palletId: string) => {
    if (!isSupabaseConfigured()) {
      setStats({ totalBoxes: 12, expectedItems: 48, scannedItems: 0, remainingItems: 48 });
      return;
    }
    const sid = (sessionStoreId ?? "").trim();
    let q = supabase
      .from("packages")
      .select("expected_item_count, actual_item_count")
      .eq("pallet_id", palletId)
      .is("deleted_at", null);
    if (sid && isUuidString(sid)) {
      q = q.eq("store_id", sid);
    }
    const { data: pkgs, error } = await q;
    if (error) {
      setStats(null);
      return;
    }
    const rows = pkgs ?? [];
    const totalBoxes = rows.length;
    let expectedItems = 0;
    let scannedItems = 0;
    for (const r of rows) {
      expectedItems += Number(r.expected_item_count ?? 0);
      scannedItems += Number(r.actual_item_count ?? 0);
    }
    const remainingItems = Math.max(0, expectedItems - scannedItems);
    setStats({ totalBoxes, expectedItems, scannedItems, remainingItems });
  }, [sessionStoreId]);

  useEffect(() => {
    if (activePallet?.id && isUuidString(activePallet.id)) void loadPalletDetail(activePallet.id);
    else {
      setStats(null);
    }
  }, [activePallet?.id, loadPalletDetail]);

  useEffect(() => {
    setEditAllMode(false);
    setPalletMixedOrderIdsWarning(false);
  }, [activePallet?.id]);

  /** Pallet row or gate entity must never coexist with direct-box intake mode. */
  useEffect(() => {
    if (activePallet?.id?.trim()) setDirectBox(false);
  }, [activePallet?.id]);

  useEffect(() => {
    if (identifyGateEntity === "pallet") setDirectBox(false);
  }, [identifyGateEntity]);

  useEffect(() => {
    const oid = (orgId ?? "").trim();
    if (!oid || !isUuidString(oid)) {
      setCorrectionPerms({ moveBox: false, voidBox: false });
      return;
    }
    let cancelled = false;
    void getOperatorMobileCorrectionPermissionsAction(oid).then((res) => {
      if (cancelled) return;
      if (res.ok) setCorrectionPerms(res.permissions);
      else setCorrectionPerms({ moveBox: false, voidBox: false });
    });
    return () => {
      cancelled = true;
    };
  }, [orgId]);

  /** Hydrate carrier / order_id / shipment-slip / pallet / BOL photo URLs from the active pallet row. */
  useEffect(() => {
    const palletId = activePallet?.id;
    const oid = (orgId ?? "").trim();
    const stableKey =
      palletId && isUuidString(palletId) && oid ? `${oid}:${palletId}` : null;

    const trackingOnlySession =
      !stableKey &&
      (currentPalletTrackingId ?? "").trim().length > 0 &&
      (flowPhase === "scan" || flowPhase === "package_scan" || flowPhase === "items");

    const draftPalletShipmentStep =
      !stableKey &&
      Boolean(palletId) &&
      !isUuidString(palletId) &&
      flowPhase === "scan" &&
      (currentPalletTrackingId ?? "").trim().length > 0;

    if (!stableKey || !palletId || !isUuidString(palletId)) {
      hydrateActivePalletIdRef.current = null;
      palletHydrateStableKeyRef.current = null;
      const palletReceivingSession =
      !directBox &&
      (Boolean(activePallet?.id?.trim()) || Boolean((currentPalletTrackingId ?? "").trim()));

    const receivingLookupInFlight = identifyGatePhase === "searching" || busy;

    if (
      trackingOnlySession ||
      draftPalletShipmentStep ||
      palletReceivingSession ||
      receivingLookupInFlight
    ) {
        return;
      }
      setPalletDbHasShipmentDetails(false);
      setPalletCreatedByLabel(null);
      setPalletCreatedByProfileId(null);
      setPalletCreatedAtIso(null);
      setPalletCarrier("");
      setPalletCarrierOtherSelected(false);
      setPalletOrderId("");
      setPalletDbOrderId("");
      setPalletResolvedOrderId("");
      lastOrderIdAutoFilledFromRaRef.current = null;
      setCurrentPalletTrackingId(null);
      clearOperatorPhotoArrays(["shipping", "bol"]);
      setPalletPhotoUrls([]);
      palletPhotoUrlsRef.current = [];
      evidenceBaselineRef.current.pallet = [];
      pendingEvidenceStorageDeletesRef.current.clear();
      setSlipExtractMissing(null);
      parentPalletCarrierDefaultRef.current = "";
      setPalletNotes("");
      return;
    }

    const priorKey = palletHydrateStableKeyRef.current;
    const switchedPalletOrOrg = priorKey !== stableKey;
    const preserveDraftLookupState =
      flowPhase === "scan" && (currentPalletTrackingId ?? "").trim().length > 0;
    if (switchedPalletOrOrg && !preserveDraftLookupState) {
      setPalletCarrier("");
      setPalletCarrierOtherSelected(false);
      setPalletNotes("");
      setPalletDbOrderId("");
      setPalletResolvedOrderId("");
      setPalletOrderId("");
      lastOrderIdAutoFilledFromRaRef.current = null;
    }
    palletHydrateStableKeyRef.current = stableKey;

    if (!isSupabaseConfigured()) {
      hydrateActivePalletIdRef.current = palletId;
      return;
    }

    hydrateActivePalletIdRef.current = palletId;
    const fetchingFor = palletId;
    let cancelled = false;
    (async () => {
      const PALLET_DOC_SELECT =
        "carrier_name, order_id, notes, shipping_label_urls, pallet_photo_urls, bol_photo_urls, created_by, created_at, updated_at, store_id";

      type HydrateRow = {
        carrier_name?: string | null;
        order_id?: string | null;
        notes?: string | null;
        shipping_label_urls?: unknown;
        pallet_photo_urls?: unknown;
        bol_photo_urls?: unknown;
        created_by?: string | null;
        created_at?: string | null;
        updated_at?: string | null;
        store_id?: string | null;
      };

      let data: HydrateRow | null = null;

      const srv = await fetchOperatorPalletHydrationAction(oid, fetchingFor, sessionStoreId ?? null);
      if (cancelled) return;
      if (hydrateActivePalletIdRef.current !== fetchingFor) return;

      if (srv.ok) {
        data = srv.row as HydrateRow;
      } else if (srv.wrongStore) {
        console.warn("[pallets] hydrate skipped (server store scope):", srv.message, {
          palletId: fetchingFor,
        });
        return;
      } else {
        const { data: clientData, error } = await supabase
          .from("pallets")
          .select(PALLET_DOC_SELECT)
          .eq("id", palletId)
          .maybeSingle();
        if (cancelled) return;
        if (hydrateActivePalletIdRef.current !== fetchingFor) return;
        if (error) {
          console.warn("[pallets] hydrate failed:", error.code ?? "", error.message, { palletId });
          setPalletDbHasShipmentDetails(false);
          setPalletCreatedByLabel(null);
          setPalletCreatedByProfileId(null);
          setPalletCreatedAtIso(null);
          return;
        }
        if (!clientData && process.env.NODE_ENV === "development") {
          console.debug("[operator] pallet hydrate: no row returned (missing id or RLS?)", { palletId });
        }
        if (!clientData) {
          return;
        }
        const rowStore = String((clientData as { store_id?: string | null }).store_id ?? "").trim();
        const sessionSid = (sessionStoreId ?? "").trim();
        if (
          sessionSid &&
          isUuidString(sessionSid) &&
          rowStore &&
          isUuidString(rowStore) &&
          rowStore !== sessionSid
        ) {
          console.warn("[pallets] hydrate skipped: pallet belongs to another store", {
            palletId: fetchingFor,
            rowStore,
            sessionSid,
          });
          return;
        }
        data = clientData as HydrateRow;
      }

      if (!data) return;

      const row = data;
      const createdAtRaw = row.created_at;
      const updatedAtRaw = row.updated_at;
      const activityIso =
        (typeof updatedAtRaw === "string" && updatedAtRaw.trim() ? updatedAtRaw.trim() : null) ||
        (typeof createdAtRaw === "string" && createdAtRaw.trim() ? createdAtRaw.trim() : null);
      setPalletCreatedAtIso(activityIso);
      const cid = (row.created_by ?? "").trim();
      if (cid && isUuidString(cid)) {
        const { data: auth } = await supabase.auth.getUser();
        const me = auth?.user?.id?.trim();
        const { data: prof } = await supabase.from("profiles").select("full_name").eq("id", cid).maybeSingle();
        const fn = (prof as { full_name?: string | null } | null)?.full_name?.trim();
        const emailFallback =
          me === cid ? (typeof auth?.user?.email === "string" ? auth.user.email.trim() : "") : "";
        setPalletCreatedByLabel(fn || emailFallback || "Unknown");
        setPalletCreatedByProfileId(cid);
      } else {
        setPalletCreatedByLabel(null);
        setPalletCreatedByProfileId(null);
      }
      const raw = (row.carrier_name ?? "").trim();
      if (raw) {
        const normalized = normalizeCarrierLabel(raw);
        const applied =
          normalized && normalized !== OTHER_CARRIER_NAME ? normalized : raw;
        if (normalized && normalized !== OTHER_CARRIER_NAME) {
          setPalletCarrier(normalized);
          setPalletCarrierOtherSelected(false);
        } else {
          setPalletCarrier(raw);
          setPalletCarrierOtherSelected(true);
        }
        persistOperatorSessionCarrier(applied);
        mergeCarrierIntoActivePalletState(applied);
        if (switchedPalletOrOrg) {
          parentPalletCarrierDefaultRef.current = raw;
        }
      } else if (switchedPalletOrOrg && !preserveDraftLookupState) {
        parentPalletCarrierDefaultRef.current = "";
      }
      const rowOrder = String(row.order_id ?? "").trim();
      setPalletDbOrderId(rowOrder);
      // When switching pallets, stale `palletPackagePickerList` can still be from the previous pallet
      // for one tick — `palletMixedOrderIdsUiRef` may read true and incorrectly preserve the old input.
      const lockOrderInput =
        palletMixedOrderIdsUiRef.current && !switchedPalletOrOrg;
      setPalletOrderId((prev) => (lockOrderInput ? prev : rowOrder || (preserveDraftLookupState ? prev : "")));
      lastOrderIdAutoFilledFromRaRef.current = null;
      setActivePallet((p) => {
        if (!p?.id || !isUuidString(p.id) || p.id !== fetchingFor) return p;
        return { ...p, order_id: rowOrder.length ? rowOrder : null };
      });
      if (process.env.NODE_ENV === "development") {
        console.log("Current Pallet Data from DB:", { palletId: fetchingFor, ...row });
      }
      setPalletNotes((prev) => {
        if (prev.trim()) return prev;
        const next = String(row.notes ?? "").trim();
        palletNotesBaselineRef.current = next;
        return next;
      });
      // Do not hydrate `currentPalletTrackingId` from DB during the session — gate / operator edits own it.
      const hydrated = hydrateOperatorPalletDocumentationPhotoUrls(row, supabase);
      const incomingPhotoCount =
        hydrated.shippingLabel.length + hydrated.pallet.length + hydrated.bol.length;
      const currentPhotoCount =
        shippingLabelPhotoUrlsRef.current.length +
        palletPhotoUrlsRef.current.length +
        bolPhotoUrlsRef.current.length;
      if (process.env.NODE_ENV === "development") {
        console.debug("[operator] pallet documentation hydrate", {
          palletId: fetchingFor,
          rawShippingLabelUrls: row.shipping_label_urls ?? null,
          rawPalletPhotoUrls: row.pallet_photo_urls ?? null,
          rawBolPhotoUrls: row.bol_photo_urls ?? null,
          hydrated,
          skippedEmptyOverwrite: incomingPhotoCount === 0 && currentPhotoCount > 0,
        });
      }
      if (incomingPhotoCount === 0 && currentPhotoCount > 0) {
        /* Resume may have populated refs before this async fetch; do not wipe. */
      } else {
        setShippingLabelPhotoUrls(hydrated.shippingLabel);
        setPalletPhotoUrls(hydrated.pallet);
        setBolPhotoUrls(hydrated.bol);
        shippingLabelPhotoUrlsRef.current = [...hydrated.shippingLabel];
        palletPhotoUrlsRef.current = [...hydrated.pallet];
        bolPhotoUrlsRef.current = [...hydrated.bol];
        evidenceBaselineRef.current.shipping = [...hydrated.shippingLabel];
        evidenceBaselineRef.current.pallet = [...hydrated.pallet];
        evidenceBaselineRef.current.bol = [...hydrated.bol];
      }
      const persistedSlip =
        Boolean((row.carrier_name ?? "").trim()) ||
        Boolean(rowOrder) ||
        incomingPhotoCount > 0 ||
        currentPhotoCount > 0;
      setPalletDbHasShipmentDetails(persistedSlip);
    })();
    return () => {
      cancelled = true;
    };
  }, [
    activePallet?.id,
    orgId,
    palletDocHydrationNonce,
    flowPhase,
    currentPalletTrackingId,
    directBox,
    persistOperatorSessionCarrier,
    mergeCarrierIntoActivePalletState,
    sessionStoreId,
    identifyGatePhase,
    busy,
    clearOperatorPhotoArrays,
  ]);

  useEffect(() => {
    if (!activePallet) setPalletResolvedOrderId("");
  }, [activePallet]);

  /** Loads `palletPackagePickerList` via {@link listOperatorPackagesForPalletAction} whenever the active pallet (UUID) or scan/box steps change; clears when leaving scan steps or pallet is not persisted yet. */
  useEffect(() => {
    const oid = (orgId ?? "").trim();
    const pid = activePallet?.id?.trim() ?? "";
    const onPalletBoxSteps = flowPhase === "package_scan" || flowPhase === "scan";
    if (!isSupabaseConfigured() || !oid || !pid || !isUuidString(pid) || !onPalletBoxSteps) {
      setPalletPackagePickerList([]);
      return;
    }
    setPalletPackagePickerList([]);
    let cancelled = false;
    void (async () => {
      const res = await listOperatorPackagesForPalletAction(oid, pid, sessionStoreId ?? null);
      if (cancelled) return;
      if (res.ok) setPalletPackagePickerList(res.packages);
      else setPalletPackagePickerList([]);
    })();
    return () => {
      cancelled = true;
    };
  }, [flowPhase, orgId, activePallet?.id, palletDocHydrationNonce, sessionStoreId]);

  /** After pallet hydration refresh, re-read slip_contents so `conflicting_order_id` matches DB immediately. */
  useEffect(() => {
    if (flowPhase !== "package_scan") return;
    const pkg = String(activeBoxSessionPackageIdRef.current ?? "").trim();
    const oid = (orgId ?? "").trim();
    if (!pkg || !oid || !isUuidString(pkg)) return;
    let cancelled = false;
    void listOperatorSlipContentsForPackageAction(oid, pkg, sessionStoreId ?? null).then((slipRes) => {
      if (cancelled) return;
      if (String(activeBoxSessionPackageIdRef.current ?? "").trim() !== pkg) return;
      if (!slipRes.ok) return;
      const so = firstSlipOrderIdFromSlipRows(slipRes.rows);
      const sc = firstConflictingOrderIdFromSlipRows(slipRes.rows);
      const norm = normalizeSlipOrderConflictPair(so, sc);
      setBoxSlipOrderId(norm.slip);
      setBoxSlipConflictingOrderId(norm.conflicting);
      if (norm.slip) {
        applySlipOrderIdIfEmpty(norm.slip);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [palletDocHydrationNonce, flowPhase, orgId, sessionStoreId, activeBoxSession?.packageId, applySlipOrderIdIfEmpty]);

  useEffect(() => {
    setItemReceiveDemoScannedUnits(0);
    setItemReceivePackageActualCount(null);
    setPackageItemScanState({ bySlipId: {}, unexpectedUnits: 0 });
    setPackageItemHydratedRows([]);
    setPackageItemsHydrating(false);
    setPackageItemsHydrationNonce(0);
    setItemScanEditAllMode(false);
    setItemScanEditPick(null);
    setItemScanUnitPickerOpen(false);
  }, [itemScanPackageId]);

  useEffect(() => {
    if (flowPhase !== "items") {
      setItemScanEditAllMode(false);
      setItemScanEditPick(null);
      setItemScanUnitPickerOpen(false);
    }
  }, [flowPhase]);

  /** Hydrate scanned counts from `return_items`, matched to slip lines by barcode. */
  useEffect(() => {
    if (flowPhase !== "items" || !itemScanPackageId || !isUuidString(itemScanPackageId)) {
      setPackageItemScanState({ bySlipId: {}, unexpectedUnits: 0 });
      setPackageItemHydratedRows([]);
      setPackageItemsHydrating(false);
      return;
    }
    if (!isSupabaseConfigured()) {
      setPackageItemHydratedRows([]);
      setPackageItemsHydrating(false);
      return;
    }
    const oid = (orgId ?? "").trim();
    if (!oid) return;
    let cancelled = false;
    setPackageItemsHydrating(true);
    void listOperatorPackageItemsForPackageAction(oid, itemScanPackageId, sessionStoreId ?? null).then((res) => {
      if (cancelled) return;
      setPackageItemsHydrating(false);
      if (!res.ok) {
        setPackageItemScanState({ bySlipId: {}, unexpectedUnits: 0 });
        setPackageItemHydratedRows([]);
        return;
      }
      setPackageItemHydratedRows(res.rows);
      setPackageItemScanState(aggregateOperatorPackageItemRows(res.rows));
    });
    return () => {
      cancelled = true;
      setPackageItemsHydrating(false);
    };
  }, [flowPhase, itemScanPackageId, orgId, sessionStoreId, packageItemsHydrationNonce]);

  useEffect(() => {
    if (flowPhase !== "items" || !itemScanPackageId || !isUuidString(itemScanPackageId)) {
      return;
    }
    if (receivingSlipExpectedItemQtyTotal != null) return;
    const oid = (orgId ?? "").trim();
    if (!oid) return;
    let cancelled = false;
    void listOperatorSlipContentsForPackageAction(oid, itemScanPackageId, sessionStoreId ?? null).then((res) => {
      if (cancelled || !res.ok) return;
      const sum = res.rows.reduce((s, r) => s + Math.max(0, Math.floor(Number(r.quantity ?? 0))), 0);
      if (sum > 0) setReceivingSlipExpectedItemQtyTotal(sum);
    });
    return () => {
      cancelled = true;
    };
  }, [flowPhase, itemScanPackageId, orgId, receivingSlipExpectedItemQtyTotal]);

  useEffect(() => {
    if (flowPhase !== "items") {
      setItemInspectionSlipLines([]);
      setItemInspectionSlipLinesLoading(false);
      return;
    }
    if (!itemScanPackageId || !isUuidString(itemScanPackageId)) {
      setItemInspectionSlipLines([]);
      setItemInspectionSlipLinesLoading(false);
      return;
    }
    const oid = (orgId ?? "").trim();
    if (!oid) {
      setItemInspectionSlipLines([]);
      setItemInspectionSlipLinesLoading(false);
      return;
    }
    let cancelled = false;
    setItemInspectionSlipLinesLoading(true);
    void listOperatorSlipContentsForPackageAction(oid, itemScanPackageId, sessionStoreId ?? null).then((res) => {
      if (cancelled) return;
      const rows = res.ok ? res.rows : [];
      setItemInspectionSlipLines(rows);
      if (rows.length > 0) {
        const allDbCatalogLinked = rows.every(
          (r) =>
            Boolean(r.product_linkage?.resolved_product_id?.trim()) &&
            Boolean(r.product_linkage?.product_name?.trim()),
        );
        if (allDbCatalogLinked) setItemScanSlipCarryover(null);
      }
      setItemInspectionSlipLinesLoading(false);
    });
    return () => {
      cancelled = true;
      setItemInspectionSlipLinesLoading(false);
    };
  }, [flowPhase, itemScanPackageId, orgId, sessionStoreId]);

  /**
   * Direct Item Scan resume path: hydrate preview linkage for saved slip rows even when
   * operator skips Box Info. This mirrors Box Info "Detected Items" deterministic identifier
   * preview (FNSKU/UPC only) so product linkage labels are present on first Item Scan render.
   */
  useEffect(() => {
    if (flowPhase !== "items") return;
    const pid = String(itemScanPackageId ?? "").trim();
    if (!pid || !isUuidString(pid)) return;
    if (itemInspectionSlipLinesLoading) return;
    if (itemInspectionSlipLines.length === 0) return;
    const oid = (orgId ?? "").trim();
    const sid = String(sessionStoreId ?? "").trim();
    if (!oid || !sid || !isUuidString(sid)) return;

    const existingCarryoverRows =
      itemScanSlipCarryover?.packageId === pid
        ? itemScanSlipCarryover.rows
        : itemScanSlipCarryoverRef.current?.packageId === pid
          ? itemScanSlipCarryoverRef.current.rows
          : [];
    if (existingCarryoverRows.length > 0) return;

    const allDbCatalogLinked = itemInspectionSlipLines.every((r) => dbSlipRowHasCatalogLinkage(r));
    if (allDbCatalogLinked) return;

    const hasDeterministicIdentifiers = itemInspectionSlipLines.some(
      (r) => Boolean(String(r.fnsku ?? "").trim()) || Boolean(String(r.upc ?? "").trim()),
    );
    if (!hasDeterministicIdentifiers) return;

    let cancelled = false;
    void (async () => {
      const res = await previewOperatorSlipLinesIdentifiersLinkageAction({
        requestedOrganizationId: oid,
        storeId: sid,
        lines: itemInspectionSlipLines.map((line) => ({
          upc: line.upc,
          fnsku: line.fnsku,
          printed_asin: null,
        })),
      });
      if (cancelled || !res.ok) return;
      const mergedRows = itemInspectionSlipLines.map((row, i) =>
        mergeSlipRowWithStrongerPreviewLinkage(row, res.linkages[i]),
      );
      const payload: ItemScanSlipCarryoverPayload = { packageId: pid, rows: mergedRows };
      itemScanSlipCarryoverRef.current = payload;
      setItemScanSlipCarryover(payload);
    })();
    return () => {
      cancelled = true;
    };
  }, [
    flowPhase,
    itemScanPackageId,
    itemInspectionSlipLinesLoading,
    itemInspectionSlipLines,
    orgId,
    sessionStoreId,
    itemScanSlipCarryover,
  ]);

  useEffect(() => {
    if (flowPhase !== "items") {
      setItemScanExpectationSnapshotLines([]);
      setItemScanExpectationLoading(false);
      return;
    }
    const pkgScoped = Boolean(itemScanPackageId && isUuidString(itemScanPackageId));
    if (pkgScoped) {
      setItemScanExpectationSnapshotLines([]);
      setItemScanExpectationLoading(false);
      return;
    }
    const parentTn = resolveItemScanParentTracking(
      currentPalletTrackingId,
      activeTracking,
      identifyGateCanonicalTracking,
    );
    if (!parentTn) {
      setItemScanExpectationSnapshotLines([]);
      setItemScanExpectationLoading(false);
      return;
    }
    const oid = (orgId ?? "").trim();
    const sid = (sessionStoreId ?? "").trim();
    if (!oid || !sid) {
      setItemScanExpectationSnapshotLines([]);
      setItemScanExpectationLoading(false);
      return;
    }

    let cancelled = false;
    setItemScanExpectationLoading(true);
    void (async () => {
      try {
        if (!isSupabaseConfigured()) {
          const snap = mockTrackingExpectationSnapshot(parentTn);
          if (!cancelled) setItemScanExpectationSnapshotLines(snap.lines);
          return;
        }
        const snap = await loadTrackingExpectationSnapshot(supabase, oid, sid, parentTn);
        if (!cancelled) setItemScanExpectationSnapshotLines(snap.lines);
      } catch (err) {
        console.warn("loadTrackingExpectationSnapshot (item phase) failed", err);
        if (!cancelled) setItemScanExpectationSnapshotLines([]);
      } finally {
        if (!cancelled) setItemScanExpectationLoading(false);
      }
    })();
    return () => {
      cancelled = true;
      setItemScanExpectationLoading(false);
    };
  }, [
    flowPhase,
    itemScanPackageId,
    orgId,
    sessionStoreId,
    currentPalletTrackingId,
    activeTracking,
    identifyGateCanonicalTracking,
  ]);

  const itemScanExpectationLinesLive = useMemo(() => {
    if (!itemScanExpectationSnapshotLines.length) return [];
    const maps = scannedCountMapsFromOperatorPackageHydratedRows(packageItemHydratedRows);
    return remergeTrackingOperatorLineScannedQty(itemScanExpectationSnapshotLines, maps);
  }, [itemScanExpectationSnapshotLines, packageItemHydratedRows]);

  useEffect(() => {
    const hasPallet = Boolean(activePallet?.id);
    const palletTn = (currentPalletTrackingId ?? "").trim();
    const looseTn = (activeTracking ?? "").trim();
    if (!hasPallet && !looseTn) {
      setExpectedPkgLines([]);
      setExpectedPkgTotals(null);
      setExpectedPkgError(null);
      setExpectedPackagesRawRowCount(null);
      setExpectedPkgTrackingNumbers([]);
      return;
    }

    let cancelled = false;
    void (async () => {
      try {
        if (!isSupabaseConfigured()) {
          if (!cancelled) {
            if (hasPallet) {
              if (palletTn) {
                const snap = mockTrackingExpectationSnapshot(palletTn);
                setExpectedPkgLines(snap.lines);
                setExpectedPkgTotals(snap.totals);
                setExpectedPackagesRawRowCount(snap.rawRowCount);
                setExpectedPkgTrackingNumbers(snap.expectedTrackingNumbers);
                setExpectedPkgError(null);
              } else {
                const snap = mockPalletExpectationSnapshot();
                setExpectedPkgLines(snap.lines);
                setExpectedPkgTotals(snap.totals);
                setExpectedPackagesRawRowCount(snap.rawRowCount);
                setExpectedPkgTrackingNumbers(snap.expectedTrackingNumbers);
                setExpectedPkgError(null);
              }
            } else if (looseTn) {
              const snap = mockTrackingExpectationSnapshot(looseTn);
              setExpectedPkgLines(snap.lines);
              setExpectedPkgTotals(snap.totals);
              setExpectedPackagesRawRowCount(snap.rawRowCount);
              setExpectedPkgTrackingNumbers(snap.expectedTrackingNumbers);
              setExpectedPkgError(null);
            }
          }
          return;
        }

        if (!sessionStoreId) {
          if (!cancelled) {
            setExpectedPkgLines([]);
            setExpectedPkgTotals(null);
            setExpectedPackagesRawRowCount(null);
            setExpectedPkgTrackingNumbers([]);
            if (operatorStoresLoading) {
              setExpectedPkgError(null);
            } else {
              setExpectedPkgError(
                kioskStoreLocked
                  ? "Store context missing — check NEXT_PUBLIC_STORE_ID / kiosk configuration."
                  : operatorStores.length > 1
                    ? "Select an active store above to load expected boxes for that location."
                    : operatorStores.length === 0
                      ? "No active stores for this organization — add a store in Settings."
                      : "Select or configure a store to load expected boxes.",
              );
            }
          }
          return;
        }

        if (hasPallet && activePallet?.id) {
          if (palletTn) {
            const snap = await loadTrackingExpectationSnapshot(supabase, orgId, sessionStoreId, palletTn);
            if (cancelled) return;
            setExpectedPkgLines(snap.lines);
            setExpectedPkgTotals(snap.totals);
            setExpectedPackagesRawRowCount(snap.rawRowCount);
            setExpectedPkgTrackingNumbers(snap.expectedTrackingNumbers);
            setExpectedPkgError(
              snap.rawRowCount === 0 ? "No expected boxes for this tracking in the current store." : null,
            );
            return;
          }
          const snap = await loadPalletExpectationSnapshot(supabase, orgId, sessionStoreId, activePallet.id);
          if (cancelled) return;
          setExpectedPkgLines(snap.lines);
          setExpectedPkgTotals(snap.totals);
          setExpectedPackagesRawRowCount(snap.rawRowCount);
          setExpectedPkgTrackingNumbers(snap.expectedTrackingNumbers);
          setExpectedPkgError(
            snap.rawRowCount === 0
              ? "No expected boxes for box trackings on this pallet (link trackings on boxes or worklist)."
              : null,
          );
          return;
        }

        if (looseTn) {
          const snap = await loadTrackingExpectationSnapshot(supabase, orgId, sessionStoreId, looseTn);
          if (cancelled) return;
          setExpectedPkgLines(snap.lines);
          setExpectedPkgTotals(snap.totals);
          setExpectedPackagesRawRowCount(snap.rawRowCount);
          setExpectedPkgTrackingNumbers(snap.expectedTrackingNumbers);
          setExpectedPkgError(
            snap.rawRowCount === 0 ? "No expected boxes for this tracking in the current store." : null,
          );
        }
      } catch (e: unknown) {
        const detail =
          e instanceof Error
            ? e.message
            : typeof e === "object" &&
                e !== null &&
                "message" in e &&
                typeof (e as { message?: unknown }).message === "string"
              ? (e as { message: string }).message
              : (() => {
                  try {
                    return JSON.stringify(e);
                  } catch {
                    return String(e);
                  }
                })();
        console.warn("[operator-mobile] expected_packages load failed:", detail, e);
        if (!cancelled) {
          setExpectedPkgError(
            detail && detail !== "{}"
              ? `Could not load expected boxes: ${detail}`
              : "Could not load expected boxes.",
          );
          setExpectedPkgLines([]);
          setExpectedPkgTotals(null);
          setExpectedPackagesRawRowCount(null);
          setExpectedPkgTrackingNumbers([]);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    activeTracking,
    currentPalletTrackingId,
    activePallet?.id,
    sessionStoreId,
    orgId,
    kioskStoreLocked,
    operatorStores.length,
    operatorStoresLoading,
  ]);

  useEffect(() => {
    if (flowPhase === "scan" && !isIdentified) {
      setBoxScanTargetDenominator(null);
    }
  }, [flowPhase, isIdentified]);

  useEffect(() => {
    if (flowPhase === "package_scan" && flowPhasePrevRef.current !== "package_scan") {
      setScanLine("");
      setCurrentPackageTrackingId(null);
    }
    flowPhasePrevRef.current = flowPhase;
  }, [flowPhase]);

  useEffect(() => {
    if (!intakeToast) return;
    const t = window.setTimeout(() => setIntakeToast(null), 3800);
    return () => window.clearTimeout(t);
  }, [intakeToast]);

  useEffect(() => {
    if (!syncErrorToast) return;
    const t = window.setTimeout(() => setSyncErrorToast(null), 5200);
    return () => window.clearTimeout(t);
  }, [syncErrorToast]);

  useEffect(() => {
    if (!identifyGatePhotoOcrToast) return;
    const t = window.setTimeout(() => setIdentifyGatePhotoOcrToast(null), 4200);
    return () => window.clearTimeout(t);
  }, [identifyGatePhotoOcrToast]);

  useEffect(() => {
    if (!scanActionToast) return;
    const ms =
      scanActionToast.variant === "error" ? 5200 : scanActionToast.variant === "neutral" ? 2800 : 3800;
    const t = window.setTimeout(() => setScanActionToast(null), ms);
    return () => window.clearTimeout(t);
  }, [scanActionToast]);

  useEffect(() => {
    if (!scanSuccessFlash) return;
    const t = window.setTimeout(() => setScanSuccessFlash(false), 420);
    return () => window.clearTimeout(t);
  }, [scanSuccessFlash]);

  useEffect(() => {
    if (!identifyGateGlowFlash) return;
    const t = window.setTimeout(() => setIdentifyGateGlowFlash(false), 520);
    return () => window.clearTimeout(t);
  }, [identifyGateGlowFlash]);

  useEffect(() => {
    if (!gateTrackingHelpOpen) return;
    const onPointerDown = (e: MouseEvent | TouchEvent) => {
      const node = gateTrackingHelpRef.current;
      const t = e.target as Node | null;
      if (node && t && !node.contains(t)) setGateTrackingHelpOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setGateTrackingHelpOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("touchstart", onPointerDown, { passive: true });
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("touchstart", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [gateTrackingHelpOpen]);

  useEffect(() => {
    if (flowPhase !== "items") {
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        if (!isSupabaseConfigured()) {
          if (!cancelled) {
            const mock = mockExpectedPackageDetailRows();
            const safe = mock ?? [];
            setExpectedPkgDetailRows(Array.isArray(safe) ? safe : []);
          }
          return;
        }
        if (!sessionStoreId) {
          if (!cancelled) {
            setExpectedPkgDetailRows([]);
          }
          return;
        }
        const parentTn = activePallet?.id ? (currentPalletTrackingId?.trim() || null) : activeTracking?.trim() || null;
        const rows = await fetchExpectedPackageDetailRowsForParent(supabase, orgId, sessionStoreId, {
          trackingNumber: parentTn,
          palletId: activePallet?.id ?? null,
        });
        if (cancelled) return;
        const data = rows ?? [];
        const safe = Array.isArray(data) ? data : [];
        setExpectedPkgDetailRows(safe);
      } catch (e) {
        console.error(e);
        if (!cancelled) {
          setExpectedPkgDetailRows([]);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [flowPhase, sessionStoreId, orgId, activeTracking, currentPalletTrackingId, activePallet?.id]);

  useEffect(() => {
    if (flowPhase !== "items" || !itemScanPackageId || !isUuidString(itemScanPackageId) || !isSupabaseConfigured()) {
      return;
    }
    let cancelled = false;
    void (async () => {
      const { data, error } = await supabase
        .from("packages")
        .select("package_code, id_slip_contents, expected_item_count, actual_item_count")
        .eq("id", itemScanPackageId)
        .maybeSingle();
      if (cancelled || error) return;
      const row = data as {
        package_code?: string | null;
        id_slip_contents?: string | null;
        slip_id?: string | null;
        package_number?: string | null;
        actual_item_count?: number | null;
      } | null;
      const pn = (row?.package_code ?? row?.slip_id ?? row?.package_number)?.trim();
      if (pn) setItemScanPackageLabel(pn);
      const ac = Math.floor(Number(row?.actual_item_count ?? 0));
      setItemReceivePackageActualCount(Number.isFinite(ac) ? Math.max(0, ac) : 0);
    })();
    return () => {
      cancelled = true;
    };
  }, [flowPhase, itemScanPackageId, itemReceiveCountSyncNonce]);

  const applyResult = useCallback((r: OperatorResolveResult) => {
    setActiveSlipOrPackage(null);
    if (r.kind === "pallet") {
      setActiveTracking(null);
      setCurrentPalletTrackingId(null);
      const id = String(r.row.id ?? "");
      const num = String(r.row.pallet_number ?? "");
      if (id && num) {
        const cn = String(r.row.carrier_name ?? "").trim();
        const oidRow = String((r.row as { order_id?: unknown }).order_id ?? "").trim();
        setPalletResolvedOrderId(oidRow);
        setActivePallet({
          id,
          pallet_number: num,
          ...(cn ? { carrier_name: cn } : {}),
          order_id: oidRow.length ? oidRow : null,
        });
        // `currentPalletTrackingId` is set by the caller with the operator's scanned/typed code
        // (identify gate or runResolve) so Active Pallet edit shows that value, not only DB row.
        setDirectBox(false);
        setFlowPhase("scan");
      }
      return;
    }
    if (r.kind === "package" || r.kind === "slip") {
      const row = r.row;
      const pkgLabel = `Box ${String(row.package_code ?? row.slip_id ?? row.package_number ?? row.tracking_number ?? "")}`;
      const palletId = String(row.pallet_id ?? "").trim();
      if (palletId && isUuidString(palletId)) {
        setDirectBox(false);
        setActiveTracking(null);
        const cn = String(row.carrier_name ?? "").trim();
        setActivePallet({
          id: palletId,
          pallet_number: palletId,
          ...(cn ? { carrier_name: cn } : {}),
        });
        setActiveSlipOrPackage(pkgLabel);
        setFlowPhase("scan");
        return;
      }
      setActivePallet(null);
      setDirectBox(true);
      setActiveTracking(String(row.tracking_number ?? "").trim() || null);
      setActiveSlipOrPackage(pkgLabel);
      return;
    }
    setActivePallet(null);
    setActiveTracking(null);
    setCurrentPalletTrackingId(null);
    if (r.kind === "tracking") {
      setActiveTracking(String(r.row.tracking_number ?? "").trim());
      setDirectBox(false);
      setFlowPhase("scan");
      return;
    }
    if (r.kind === "item") {
      setActiveSlipOrPackage(`Item ${String(r.row.sku ?? "")}`);
    }
  }, []);

  const runResolve = useCallback(
    async (raw: string, only?: OperatorResolveKind) => {
      const code = raw.trim();
      if (!code) return;
      setBusy(true);
      try {
        const r: OperatorResolveResult = !isSupabaseConfigured()
          ? mockResolveOperatorBarcode(code, only)
          : await resolveOperatorBarcode(supabase, orgId, code, {
              ...(only ? { only } : {}),
              storeId: sessionStoreId,
            });

        if (r.kind === "unknown") {
          setUnknownModal({ code });
          modalOpenRef.current = true;
        } else {
          applyResult(r);
          if (r.kind === "pallet") {
            const scanned = code.trim();
            const rowTn = String(r.row.tracking_number ?? "").trim();
            setCurrentPalletTrackingId(scanned || rowTn || null);
            setPalletDocHydrationNonce((n) => n + 1);
          }
        }
      } catch (e) {
        setSyncErrorToast(e instanceof Error ? e.message : "Tracking search failed — check network and column access.");
      } finally {
        setBusy(false);
        scheduleFocusScanner();
      }
    },
    [orgId, sessionStoreId, applyResult, scheduleFocusScanner],
  );

  const runIdentificationGateSearchRef = useRef(runIdentificationGateSearch);
  runIdentificationGateSearchRef.current = runIdentificationGateSearch;

  useEffect(() => {
    const raw = searchParams.get("code") ?? searchParams.get("q");
    if (!raw?.trim()) return;
    if (operatorStoresLoading) return;
    if (isSupabaseConfigured() && !sessionStoreId) return;
    const code = raw.trim();
    setScanLine(code);
    router.replace(pathname, { scroll: false });
    queueMicrotask(() => {
      void runIdentificationGateSearchRef.current(code);
    });
  }, [searchParams, pathname, router, operatorStoresLoading, sessionStoreId]);

  useEffect(() => {
    if (identifyGatePhase !== "searching") return;
    const t = window.setTimeout(() => {
      setIdentifyGateSlowHint((prev) =>
        prev?.startsWith("Loading saved")
          ? prev
          : "Still checking inventory status… You can use Manual Entry if this takes too long.",
      );
    }, 8_000);
    return () => window.clearTimeout(t);
  }, [identifyGatePhase]);

  const capturePalletEvidenceBaseline = useCallback(() => {
    const o = evidenceBaselineRef.current;
    o.shipping = [...shippingLabelPhotoUrlsRef.current];
    o.pallet = [...palletPhotoUrlsRef.current];
    o.bol = [...bolPhotoUrlsRef.current];
    palletNotesBaselineRef.current = palletNotes.trim();
    palletShipmentFieldsBaselineRef.current = {
      orderId: palletOrderIdRef.current.trim(),
      carrier: palletCarrierRef.current.trim(),
    };
    palletTrackingEditBaselineRef.current =
      (currentPalletTrackingId ?? "").trim() || (activePallet?.pallet_number ?? "").trim();
  }, [palletNotes, currentPalletTrackingId, activePallet?.pallet_number]);

  const captureBoxEvidenceBaseline = useCallback(() => {
    const o = evidenceBaselineRef.current;
    o.slip = [...slipBoxPhotoUrlsRef.current];
    o.outside = [...outsideBoxPhotoUrlsRef.current];
    o.inside = [...insideBoxPhotoUrlsRef.current];
    boxNotesBaselineRef.current = boxNotesRef.current.trim();
  }, []);

  const captureBoxIntakeFieldsBaseline = useCallback(() => {
    boxNotesBaselineRef.current = normBoxScalar(boxNotesRef.current);
    boxIntakeFieldsBaselineRef.current = {
      slipCode: normBoxScalar(boxSlipCodeRef.current),
      rma: normBoxScalar(boxSlipRmaRef.current),
      orderId: normBoxScalar(palletOrderIdRef.current),
      carrier: normBoxScalar(palletCarrierRef.current),
    };
  }, []);

  const finalizeBoxIntakeBaselineFromCurrentState = useCallback(() => {
    captureBoxEvidenceBaseline();
    captureBoxIntakeFieldsBaseline();
    boxIntakeBaselineReadyRef.current = true;
  }, [captureBoxEvidenceBaseline, captureBoxIntakeFieldsBaseline]);

  useEffect(() => {
    finalizeBoxIntakeBaselineRef.current = finalizeBoxIntakeBaselineFromCurrentState;
  }, [finalizeBoxIntakeBaselineFromCurrentState]);

  /** Explicit box package reload — used on back from items, hub open, and hydrate effect. Stale-while-revalidate: keeps prior photos until fetch completes. */
  const reloadBoxPackageIntake = useCallback(
    async (pkgId: string): Promise<boolean> => {
      const fetchingFor = String(pkgId ?? "").trim();
      if (!fetchingFor || !isUuidString(fetchingFor) || !isSupabaseConfigured()) return false;
      setBoxIntakeRestoring(true);
      boxIntakeBaselineReadyRef.current = false;
      hydrateBoxPackageIdRef.current = fetchingFor;
      try {
        setBoxSlipConflictingOrderId("");
        setBoxSlipOrderId("");
        const { data, error } = await supabase
          .from("packages")
          .select(
            "outside_photo_urls, inside_photo_urls, slip_photo_urls, package_code, id_slip_contents, rma_number, manifest_data, notes, carrier_name, order_id",
          )
          .eq("id", fetchingFor)
          .maybeSingle();
        if (hydrateBoxPackageIdRef.current !== fetchingFor) return false;
        let row: Record<string, unknown> | null = null;
        if (!error && data) {
          row = data as Record<string, unknown>;
        } else {
          const fb = palletPackagePickerListRef.current.find((r) => r.id === fetchingFor);
          if (fb) {
            row = {
              outside_photo_urls: fb.outside_photo_urls,
              inside_photo_urls: fb.inside_photo_urls,
              slip_photo_urls: fb.slip_photo_urls,
              package_code: fb.package_code,
              id_slip_contents: fb.id_slip_contents,
              rma_number: null,
              manifest_data: null,
              notes: fb.notes ?? null,
              carrier_name: null,
              order_id: fb.order_id ?? null,
            };
          }
        }
        if (!row) return false;
        const o = normalizePalletDocumentationImageUrls(
          parsePalletPhotoUrlArray(row.outside_photo_urls),
          supabase,
        );
        const ins = normalizePalletDocumentationImageUrls(
          parsePalletPhotoUrlArray(row.inside_photo_urls),
          supabase,
        );
        const s = normalizePalletDocumentationImageUrls(
          parsePalletPhotoUrlArray(row.slip_photo_urls),
          supabase,
        );
        setOutsideBoxPhotoUrls(o);
        setInsideBoxPhotoUrls(ins);
        setSlipBoxPhotoUrls(s);
        slipBoxPhotoUrlsRef.current = [...s];
        outsideBoxPhotoUrlsRef.current = [...o];
        insideBoxPhotoUrlsRef.current = [...ins];
        evidenceBaselineRef.current.slip = [...s];
        evidenceBaselineRef.current.outside = [...o];
        evidenceBaselineRef.current.inside = [...ins];
        pendingEvidenceStorageDeletesRef.current.clear();
        const hydratedNotes = normBoxScalar(row.notes);
        setBoxNotes(hydratedNotes);
        boxNotesRef.current = hydratedNotes;
        const pkgCarrierRaw = String(row.carrier_name ?? "").trim();
        if (pkgCarrierRaw) {
          const normalized = normalizeCarrierLabel(pkgCarrierRaw);
          const applied =
            normalized && normalized !== OTHER_CARRIER_NAME ? normalized : pkgCarrierRaw;
          if (normalized && normalized !== OTHER_CARRIER_NAME) {
            setPalletCarrier(normalized);
            setPalletCarrierOtherSelected(false);
          } else {
            setPalletCarrier(pkgCarrierRaw);
            setPalletCarrierOtherSelected(true);
          }
          persistOperatorSessionCarrier(applied);
          mergeCarrierIntoActivePalletState(applied);
        }
        const fromDirectBoxDocs = parseDirectBoxShipmentDocumentation(row.manifest_data);
        if (directBox) {
          if (fromDirectBoxDocs.shippingLabelUrls.length > 0) {
            setShippingLabelPhotoUrls(fromDirectBoxDocs.shippingLabelUrls);
            shippingLabelPhotoUrlsRef.current = [...fromDirectBoxDocs.shippingLabelUrls];
            evidenceBaselineRef.current.shipping = [...fromDirectBoxDocs.shippingLabelUrls];
          }
          if (fromDirectBoxDocs.bolUrls.length > 0) {
            setBolPhotoUrls(fromDirectBoxDocs.bolUrls);
            bolPhotoUrlsRef.current = [...fromDirectBoxDocs.bolUrls];
            evidenceBaselineRef.current.bol = [...fromDirectBoxDocs.bolUrls];
          }
          if (!palletCarrierRef.current.trim() && fromDirectBoxDocs.carrierName) {
            const normalized = normalizeCarrierLabel(fromDirectBoxDocs.carrierName);
            const applied =
              normalized && normalized !== OTHER_CARRIER_NAME
                ? normalized
                : fromDirectBoxDocs.carrierName;
            if (normalized && normalized !== OTHER_CARRIER_NAME) {
              setPalletCarrier(normalized);
              setPalletCarrierOtherSelected(false);
            } else {
              setPalletCarrier(fromDirectBoxDocs.carrierName);
              setPalletCarrierOtherSelected(true);
            }
            persistOperatorSessionCarrier(applied);
            mergeCarrierIntoActivePalletState(applied);
          }
          if (!palletOrderIdRef.current.trim() && fromDirectBoxDocs.orderId) {
            setPalletOrderId(fromDirectBoxDocs.orderId);
          }
        }
        const oidForSlip = (orgId ?? "").trim();
        if (oidForSlip) {
          const snap = await loadHydratedBoxSlipVisionSnapshot({
            packageId: fetchingFor,
            orgId: oidForSlip,
            storeId: sessionStoreId ?? null,
            manifestRaw: row.manifest_data,
            idSlipContents: row.id_slip_contents ?? row.slip_code ?? row.slip_id ?? "",
            rmaNumber: row.rma_number,
            packageOrderId: row.order_id,
          });
          if (hydrateBoxPackageIdRef.current !== fetchingFor) return false;
          applyHydratedBoxSlipVisionSnapshot(snap);
        }
        if (hydrateBoxPackageIdRef.current === fetchingFor) {
          finalizeBoxIntakeBaselineRef.current?.();
        }
        return true;
      } finally {
        if (hydrateBoxPackageIdRef.current === fetchingFor) {
          setBoxIntakeRestoring(false);
        }
      }
    },
    [
      orgId,
      sessionStoreId,
      directBox,
      applyHydratedBoxSlipVisionSnapshot,
      persistOperatorSessionCarrier,
      mergeCarrierIntoActivePalletState,
    ],
  );

  useEffect(() => {
    reloadBoxPackageIntakeRef.current = reloadBoxPackageIntake;
  }, [reloadBoxPackageIntake]);

  const reloadPalletIntake = useCallback(() => {
    const pid = (activePallet?.id ?? "").trim();
    if (pid && isUuidString(pid)) {
      setPalletDocHydrationNonce((n) => n + 1);
    }
  }, [activePallet?.id]);

  const deleteOrphanEvidenceUploads = useCallback(async (urls: readonly string[]) => {
    const oid = (orgId ?? "").trim();
    const list = urls.filter((u) => {
      const s = String(u ?? "").trim();
      return /^https?:\/\//i.test(s) && isPersistableStoredMediaReference(s);
    });
    if (!isSupabaseConfigured() || !oid || !list.length) return;
    const res = await deleteOperatorEvidenceStorageByPublicUrlsAction(oid, list);
    if (!res.ok) {
      console.warn("[operator-mobile] orphan evidence delete:", res.error);
    }
  }, [orgId]);

  /** Restore pallet shipment photos to baseline, drop staged storage deletes, remove orphan uploads (session-only adds). */
  const abandonUnsavedPalletShipmentEdits = useCallback(async () => {
    const b = evidenceBaselineRef.current;
    const ship = [...shippingLabelPhotoUrlsRef.current];
    const p = [...palletPhotoUrlsRef.current];
    const bl = [...bolPhotoUrlsRef.current];
    pendingEvidenceStorageDeletesRef.current.clear();
    const orphanCandidates = [...ship, ...p, ...bl].filter((u) => {
      const s = String(u ?? "").trim();
      if (!/^https?:\/\//i.test(s) || !isPersistableStoredMediaReference(s)) return false;
      return !b.shipping.includes(s) && !b.pallet.includes(s) && !b.bol.includes(s);
    });
    setShippingLabelPhotoUrls([...b.shipping]);
    shippingLabelPhotoUrlsRef.current = [...b.shipping];
    setPalletPhotoUrls([...b.pallet]);
    palletPhotoUrlsRef.current = [...b.pallet];
    setBolPhotoUrls([...b.bol]);
    bolPhotoUrlsRef.current = [...b.bol];
    await deleteOrphanEvidenceUploads(orphanCandidates);
  }, [deleteOrphanEvidenceUploads]);

  const flushPendingEvidenceStorageDeletes = useCallback(async () => {
    const oid = (orgId ?? "").trim();
    const pending = [...pendingEvidenceStorageDeletesRef.current];
    pendingEvidenceStorageDeletesRef.current.clear();
    if (!isSupabaseConfigured() || !oid || !pending.length) return;
    const res = await deleteOperatorEvidenceStorageByPublicUrlsAction(oid, pending);
    if (!res.ok) {
      console.warn("[operator-mobile] deferred evidence delete:", res.error);
    }
  }, [orgId]);

  const recordEvidenceSlotRemoval = useCallback(
    (slot: "slip" | "outside" | "inside" | "shipping" | "pallet" | "bol", prev: string[], next: string[]) => {
      const base = evidenceBaselineRef.current[slot];
      const removed = prev.filter((u) => !next.includes(u));
      for (const u of removed) {
        const s = String(u ?? "").trim();
        if (!/^https?:\/\//i.test(s)) continue;
        if (!isPersistableStoredMediaReference(s)) continue;
        if (base.includes(s)) pendingEvidenceStorageDeletesRef.current.add(s);
      }
      if (slot === "slip" && removed.length > 0) {
        const slipHadAi = boxSlipVisionLines.length > 0 || Boolean(boxSlipCode.trim());
        if (slipHadAi) {
          setIntakeToast(
            "Warning: Deleting the slip image removes visual proof; detected items stay in the record until manually changed.",
          );
        }
      }
    },
    [boxSlipVisionLines.length, boxSlipCode],
  );

  const handleShippingLabelPhotoUrlsChange = useCallback(
    (urls: string[]) => {
      recordEvidenceSlotRemoval("shipping", shippingLabelPhotoUrlsRef.current, urls);
      shippingLabelPhotoUrlsRef.current = urls;
      setShippingLabelPhotoUrls(urls);
    },
    [recordEvidenceSlotRemoval],
  );

  const handlePalletPhotoUrlsChange = useCallback(
    (urls: string[]) => {
      recordEvidenceSlotRemoval("pallet", palletPhotoUrlsRef.current, urls);
      palletPhotoUrlsRef.current = urls;
      setPalletPhotoUrls(urls);
    },
    [recordEvidenceSlotRemoval],
  );

  const handleBolPhotoUrlsChange = useCallback(
    (urls: string[]) => {
      recordEvidenceSlotRemoval("bol", bolPhotoUrlsRef.current, urls);
      bolPhotoUrlsRef.current = urls;
      setBolPhotoUrls(urls);
    },
    [recordEvidenceSlotRemoval],
  );

  const handleOutsideBoxPhotoUrlsChange = useCallback(
    (urls: string[]) => {
      recordEvidenceSlotRemoval("outside", outsideBoxPhotoUrlsRef.current, urls);
      outsideBoxPhotoUrlsRef.current = urls;
      setOutsideBoxPhotoUrls(urls);
    },
    [recordEvidenceSlotRemoval],
  );

  const handleInsideBoxPhotoUrlsChange = useCallback(
    (urls: string[]) => {
      recordEvidenceSlotRemoval("inside", insideBoxPhotoUrlsRef.current, urls);
      insideBoxPhotoUrlsRef.current = urls;
      setInsideBoxPhotoUrls(urls);
    },
    [recordEvidenceSlotRemoval],
  );

  const runBoxSlipVisionOnPhotoUrl = useCallback(
    async (photoUrl: string) => {
      setBoxSlipVisionBusy(true);
      setBoxSlipOrderId("");
      setBoxSlipConflictingOrderId("");
      setBoxSlipInvalidFormatBlocksSave(false);
      try {
        const apiKey = getAIUnifiedKeyFromStorage() || getOpenAIApiKeyFromStorage();
        if (!apiKey && !orgId?.trim()) {
          setSyncErrorToast("Organization context missing — cannot run packing slip vision.");
          return;
        }
        const blob = await fetchBlobFromObjectUrl(photoUrl);
        if (!blob?.type.startsWith("image/")) {
          setSyncErrorToast("Packing slip image could not be read.");
          return;
        }
        const buf = await blob.arrayBuffer();
        const bytes = new Uint8Array(buf);
        let binary = "";
        for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]!);
        const imageBase64 = btoa(binary);
        const mimeType = blob.type || "image/jpeg";

        const headers: Record<string, string> = { "Content-Type": "application/json" };
        if (apiKey) {
          headers.Authorization = `Bearer ${apiKey}`;
        }

        const res = await fetch("/api/scanner/extract-box-slip", {
          method: "POST",
          headers,
          body: JSON.stringify({ imageBase64, mimeType, organizationId: orgId }),
        });
        const json = (await res.json()) as { error?: string; message?: string; slip?: BoxSlipVisionExtract };
        if (!res.ok) {
          if (json.error === INVALID_SLIP_FORMAT) {
            setBoxSlipInvalidFormatBlocksSave(true);
            setBoxSlipCode("");
            setBoxSlipRma("");
            clearPalletOrderIdIfAutoFilledFromRa();
            clearBoxSlipVisionLinesState();
            setDuplicatePackingSlip(null);
            setSyncErrorToast(
              json.message ??
                "INVALID_SLIP_FORMAT: This photo is not a readable packing slip (slip id, item table, and barcodes).",
            );
            return;
          }
          throw new Error(json.error ?? `BOX slip vision failed (${res.status})`);
        }
        if (!json.slip) throw new Error("Invalid BOX slip vision response.");
        if (!isStructuredBoxSlipExtractValid(json.slip)) {
          setBoxSlipInvalidFormatBlocksSave(true);
          setBoxSlipCode("");
          setBoxSlipRma("");
          clearPalletOrderIdIfAutoFilledFromRa();
          clearBoxSlipVisionLinesState();
          setDuplicatePackingSlip(null);
          setSyncErrorToast(
            "INVALID_SLIP_FORMAT: This photo is not a readable packing slip (slip id, item table, and barcodes).",
          );
          return;
        }
        setBoxSlipInvalidFormatBlocksSave(false);
        const sid = (
          json.slip.id_slip_contents ??
          (json.slip as { slip_code?: string | null }).slip_code ??
          (json.slip as { slip_id?: string }).slip_id
        )?.trim() ?? "";
        if (sid) setBoxSlipCode(sid);
        const rma = json.slip.rma_number?.trim() ?? "";
        if (rma) setBoxSlipRma((prev) => (prev.trim() ? prev : rma));
        const items = Array.isArray(json.slip.items) ? json.slip.items : [];
        commitBoxSlipVisionLinesFromSource(items);

        const slipExplicitOrder = String(json.slip.order_id ?? "").trim();
        const rmaTrim = rma.trim();
        const slipTokFromRma = rmaTrim ? extractSlipOrderTokenForPalletCompare(rmaTrim) : null;
        const slipTok = (slipExplicitOrder || slipTokFromRma || "").trim();
        const palletCanon =
          palletDbOrderId.trim() ||
          palletResolvedOrderId.trim() ||
          String(activePallet?.order_id ?? "").trim();
        let confForVision = "";
        if (slipTok && palletCanon && slipTok.toLowerCase() !== palletCanon.toLowerCase()) {
          confForVision = palletCanon;
        }
        const normVision = normalizeSlipOrderConflictPair(slipTok, confForVision);
        setBoxSlipOrderId(normVision.slip);
        setBoxSlipConflictingOrderId(normVision.conflicting);
        const refVision = referenceOrderIdForPackageFieldAfterSlipLoad(normVision, "");
        if (refVision != null) {
          applySlipOrderIdIfEmpty(refVision);
        } else if (rma) {
          applyPalletOrderIdFromRaIfApplicable(rma);
        }

        const pkgIdPersist = activeBoxSessionPackageIdRef.current;
        const oidPersist = (orgId ?? "").trim();
        const storePersist = sessionStoreId?.trim() ?? "";
        if (
          isSupabaseConfigured() &&
          pkgIdPersist &&
          oidPersist &&
          storePersist &&
          items.length > 0
        ) {
          const slipCodeForRow = sid.trim() || null;
          const rmaForRow = (boxSlipRmaRef.current.trim() || rma.trim()) || null;

          let blockVisionPersist = false;
          if (slipCodeForRow) {
            const dupChk = await checkOperatorSlipCodeDuplicateAction(oidPersist, slipCodeForRow, pkgIdPersist);
            if (!dupChk.ok) {
              setSyncErrorToast(dupChk.error);
              blockVisionPersist = true;
            } else if (dupChk.duplicate) {
              setDuplicatePackingSlip({
                slipCode: dupChk.slipCode,
                otherPackageCode: dupChk.otherPackageCode,
              });
              setBoxIntakeError(null);
              blockVisionPersist = true;
            } else {
              setDuplicatePackingSlip(null);
            }
          } else {
            setDuplicatePackingSlip(null);
          }

          if (!blockVisionPersist) {
            const manifestPayload = {
              box_slip_vision: {
                id_slip_contents: slipCodeForRow,
                rma_number: rmaForRow,
                items,
                captured_at: new Date().toISOString(),
              },
            };
            const pid = activePallet?.id?.trim() ?? "";
            const palletIdPersist = isUuidString(pid) ? pid : null;
            const linesPayload = items.map((line) => ({
              upc: line.upc?.trim() || null,
              fnsku: line.fnsku?.trim() || null,
              printed_asin: line.printed_asin?.trim() || null,
              description: line.description?.trim() || null,
              expected_qty: line.expected_qty ?? 0,
              condition: line.condition?.trim() || null,
              missing: Boolean(line.missing),
            }));

            // If items are already scanned for this package, ask for reconciliation confirmation
            const scannedCount = packageItemHydratedRows.length;
            if (scannedCount > 0 && boxSlipVisionLines.length > 0) {
              // Store pending data and show confirm dialog — user must explicitly accept slip change
              slipChangePendingRef.current = {
                items,
                sid: slipCodeForRow ?? "",
                rma: rmaForRow ?? "",
                slipOrderId: normVision.slip,
                conflictingOrderId: normVision.conflicting,
                pkgId: pkgIdPersist,
                oid: oidPersist,
                storeId: storePersist,
                manifestPayload,
                linesPayload,
              };
              modalOpenRef.current = true;
              setSlipChangeConfirmOpen(true);
              return;
            }

            const persistRes = await saveOperatorSlipVisionAction({
              requestedOrganizationId: oidPersist,
              storeId: storePersist,
              packageId: pkgIdPersist,
              palletId: palletIdPersist,
              palletUpdate: null,
              packageUpdate: {
                id_slip_contents: slipCodeForRow,
                rma_number: rmaForRow,
                order_id: palletOrderIdRef.current.trim() || null,
                manifest_data: manifestPayload,
              },
              slipContents: {
                mode: "replace",
                slipCode: slipCodeForRow,
                lines: linesPayload,
              },
            });
            if (!persistRes.ok) {
              if (persistRes.duplicatePackingSlip) {
                setDuplicatePackingSlip(persistRes.duplicatePackingSlip);
                setBoxIntakeError(null);
              } else {
                setSyncErrorToast(persistRes.message);
              }
            } else {
              if (persistRes.palletMixedOrderIds) {
                setPalletMixedOrderIdsWarning(true);
              }
              if ("palletOrderIdFromDb" in persistRes) {
                const raw = persistRes.palletOrderIdFromDb;
                const o = raw == null ? "" : String(raw).trim();
                setPalletDbOrderId(o);
                if (!persistRes.palletMixedOrderIds) {
                  setPalletOrderId(o);
                }
              }
              const so =
                "slipContentsOrderId" in persistRes && persistRes.slipContentsOrderId != null
                  ? String(persistRes.slipContentsOrderId).trim()
                  : "";
              const sc =
                "slipConflictingOrderId" in persistRes && persistRes.slipConflictingOrderId != null
                  ? String(persistRes.slipConflictingOrderId).trim()
                  : "";
              const normPersist = normalizeSlipOrderConflictPair(so, sc);
              setBoxSlipOrderId(normPersist.slip);
              setBoxSlipConflictingOrderId(normPersist.conflicting);
              setPalletDocHydrationNonce((n) => n + 1);
              void listOperatorSlipContentsForPackageAction(oidPersist, pkgIdPersist, sessionStoreId ?? null).then(
                (slipRes) => {
                  if (!slipRes.ok) return;
                  const so2 = firstSlipOrderIdFromSlipRows(slipRes.rows);
                  const sc2 = firstConflictingOrderIdFromSlipRows(slipRes.rows);
                  const norm2 = normalizeSlipOrderConflictPair(so2, sc2);
                  setBoxSlipOrderId(norm2.slip);
                  setBoxSlipConflictingOrderId(norm2.conflicting);
                },
              );
            }
          }
        }
      } catch (e) {
        setSyncErrorToast(e instanceof Error ? e.message : "BOX slip vision failed.");
      } finally {
        setBoxSlipVisionBusy(false);
        scheduleFocusScanner();
      }
    },
    [
      orgId,
      scheduleFocusScanner,
      sessionStoreId,
      activePallet?.id,
      activePallet?.order_id,
      palletDbOrderId,
      palletResolvedOrderId,
      commitBoxSlipVisionLinesFromSource,
      clearBoxSlipVisionLinesState,
      applyPalletOrderIdFromRaIfApplicable,
      applySlipOrderIdIfEmpty,
      clearPalletOrderIdIfAutoFilledFromRa,
      packageItemHydratedRows,
      boxSlipVisionLines,
    ],
  );

  /** Execute the slip-change after the operator confirms via the reconcile dialog. */
  const executeSlipChangePending = useCallback(async () => {
    const pending = slipChangePendingRef.current;
    slipChangePendingRef.current = null;
    setSlipChangeConfirmOpen(false);
    modalOpenRef.current = false;
    if (!pending) return;

    setBoxSlipVisionBusy(true);
    try {
      // Commit new vision lines to UI immediately
      commitBoxSlipVisionLinesFromSource(pending.items);
      setBoxSlipCode(pending.sid);
      setBoxSlipOrderId(pending.slipOrderId);
      setBoxSlipConflictingOrderId(pending.conflictingOrderId);

      // Persist new slip to DB
      const persistRes = await saveOperatorSlipVisionAction({
        requestedOrganizationId: pending.oid,
        storeId: pending.storeId,
        packageId: pending.pkgId,
        palletId: null,
        palletUpdate: null,
        packageUpdate: {
          id_slip_contents: pending.sid || null,
          rma_number: pending.rma || null,
          manifest_data: pending.manifestPayload,
        },
        slipContents: {
          mode: "replace",
          slipCode: pending.sid || null,
          lines: pending.linesPayload,
        },
      });
      if (!persistRes.ok) {
        setSyncErrorToast(persistRes.message ?? "Could not save new slip.");
        return;
      }

      // Reconcile return_items — update slip_content_id and slip_code for all scanned items
      void reconcileReturnItemsSlipContentsAction({
        requestedOrganizationId: pending.oid,
        packageId: pending.pkgId,
        newSlipCode: pending.sid || null,
      }).then((res) => {
        if (!res.ok) console.warn("[slip-reconcile]", res.error);
        // Refresh item scan hydration so OVER items are reflected
        setPackageItemsHydrationNonce((n) => n + 1);
      });

      setPalletDocHydrationNonce((n) => n + 1);
    } catch (e) {
      setSyncErrorToast(e instanceof Error ? e.message : "Slip change failed.");
    } finally {
      setBoxSlipVisionBusy(false);
    }
  }, [commitBoxSlipVisionLinesFromSource]);

  const handleSlipBoxPhotoUrlsChange = useCallback(
    (urls: string[]) => {
      const prev = slipBoxPhotoUrlsRef.current;
      const prevHttps = prev.filter((u) => /^https?:\/\//i.test(String(u ?? "").trim()));
      const nextHttps = urls.filter((u) => /^https?:\/\//i.test(String(u ?? "").trim()));
      const prevPrimary = prevHttps[0] ? String(prevHttps[0]).trim() : "";
      const nextPrimary = nextHttps[0] ? String(nextHttps[0]).trim() : "";
      const slipPrimaryCleared = Boolean(prevPrimary) && !nextPrimary;
      const slipPrimaryReplaced =
        Boolean(prevPrimary) && Boolean(nextPrimary) && prevPrimary !== nextPrimary;

      recordEvidenceSlotRemoval("slip", prev, urls);
      slipBoxPhotoUrlsRef.current = urls;
      setSlipBoxPhotoUrls(urls);

      if (slipPrimaryCleared || slipPrimaryReplaced || nextHttps.length === 0) {
        setBoxSlipInvalidFormatBlocksSave(false);
        setBoxSlipCode("");
        setBoxSlipRma("");
        clearPalletOrderIdIfAutoFilledFromRa();
        clearBoxSlipVisionLinesState();
        setDuplicatePackingSlip(null);
      }

      if (urls.length > prev.length) {
        const last = urls[urls.length - 1];
        if (last && /^https?:\/\//i.test(last)) {
          void runBoxSlipVisionOnPhotoUrl(String(last).trim());
        }
      } else if (slipPrimaryReplaced && nextPrimary) {
        void runBoxSlipVisionOnPhotoUrl(nextPrimary);
      }
    },
    [runBoxSlipVisionOnPhotoUrl, recordEvidenceSlotRemoval, clearBoxSlipVisionLinesState, clearPalletOrderIdIfAutoFilledFromRa],
  );

  useEffect(() => {
    const session = activeBoxSession;
    if (!session) {
      hydrateBoxPackageIdRef.current = null;
      const packageRestorePending =
        identifyGatePhase === "searching" ||
        busy ||
        flowPhase === "items" ||
        boxIntakeRestoring ||
        (flowPhase === "package_scan" &&
          Boolean(activePallet?.id?.trim()) &&
          isUuidString(String(activePallet?.id ?? "").trim()));
      if (packageRestorePending) {
        return;
      }
      clearOperatorPhotoArrays(["outside", "inside", "slip"]);
      pendingEvidenceStorageDeletesRef.current.clear();
      setBoxSlipInvalidFormatBlocksSave(false);
      setBoxSlipCode("");
      setBoxSlipRma("");
      clearPalletOrderIdIfAutoFilledFromRa();
      clearBoxSlipVisionLinesState();
      setBoxNotes("");
      return;
    }
    const pid = String(session.packageId ?? "").trim();
    if (!pid || !isUuidString(pid) || !isSupabaseConfigured()) {
      hydrateBoxPackageIdRef.current = null;
      boxIntakeBaselineReadyRef.current = true;
      return;
    }
    void reloadBoxPackageIntakeRef.current(pid);
  }, [
    activeBoxSession,
    orgId,
    boxHydrateNonce,
    clearPalletOrderIdIfAutoFilledFromRa,
    identifyGatePhase,
    busy,
    flowPhase,
    activePallet?.id,
    clearOperatorPhotoArrays,
  ]);

  useEffect(() => {
    if (flowPhase !== "package_scan") return;
    const pkg = activeBoxSessionPackageIdRef.current;
    if (!pkg) return;
    const oid = (orgId ?? "").trim();
    if (!oid) return;
    const sid = sessionStoreId?.trim() ?? "";
    if (!sid) return;
    const persistable = slipBoxPhotoUrlsRef.current.filter(
      (u) => String(u ?? "").trim().length > 0 && /^https?:\/\//i.test(String(u).trim()),
    );
    if (persistable.length === 0) return;
    const pid = activePallet?.id?.trim() ?? "";
    const palletId = isUuidString(pid) ? pid : null;
    const pkgAtSchedule = pkg;
    let cancelled = false;
    const t = window.setTimeout(() => {
      if (cancelled) return;
      if (activeBoxSessionPackageIdRef.current !== pkgAtSchedule) return;
      void (async () => {
        const latest = slipBoxPhotoUrlsRef.current.filter(
          (u) => String(u ?? "").trim().length > 0 && /^https?:\/\//i.test(String(u).trim()),
        );
        if (latest.length === 0 || activeBoxSessionPackageIdRef.current !== pkgAtSchedule) return;
        await updateOperatorIntakeBoxPackageAction({
          requestedOrganizationId: oid,
          storeId: sid,
          packageId: pkgAtSchedule,
          palletId,
          packageUpdate: { slip_photo_urls: latest },
          slipContents: { mode: "skip" },
        });
      })();
    }, 650);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [slipBoxPhotoUrls, activeBoxSession?.packageId, flowPhase, orgId, sessionStoreId, activePallet?.id]);

  const handleBoxIntakeScan = useCallback(
    async (code: string): Promise<boolean> => {
      const trimmed = code.trim();
      setBoxIntakeError(null);
      setDuplicatePackingSlip(null);
      if (!trimmed) return false;
      if (activeBoxSession) {
        setBoxIntakeError("Save the current box before scanning another barcode.");
        scheduleFocusScanner();
        return false;
      }

      if (isPrintedSlipIdScan(trimmed)) {
        if (!isSupabaseConfigured()) {
          setBoxIntakeError("Slip id lookup requires a live database connection.");
          scheduleFocusScanner();
          return false;
        }
        if (!orgId?.trim()) {
          setBoxIntakeError("Organization context missing — refresh and try again.");
          scheduleFocusScanner();
          return false;
        }
        setBusy(true);
        try {
          const pkgSel =
            "id, package_code, id_slip_contents, pallet_id, outside_photo_urls, inside_photo_urls, slip_photo_urls, rma_number, manifest_data, notes, carrier_name";
          const baseQ = () =>
            supabase
              .from("packages")
              .select(pkgSel)
              .eq("organization_id", orgId.trim())
              .is("deleted_at", null)
              .order("updated_at", { ascending: false })
              .limit(1);
          let { data, error } = await baseQ().eq("id_slip_contents", trimmed);
          if (!error && (!data || (Array.isArray(data) && data.length === 0))) {
            const second = await baseQ().eq("package_code", trimmed);
            data = second.data;
            error = second.error;
          }
          if (error) {
            setBoxSlipCode(trimmed);
            setBoxIntakeError(null);
            setActiveBoxSession(null);
            setPackageCodeCardOpen(true);
            setCurrentPackageTrackingId(trimmed);
            setIntakeToast("Could not look up that slip code — apply the carton barcode to lock the box, then Confirm & Save.");
            playOperatorSuccessBeep();
            setScanSuccessFlash(true);
            scheduleFocusScanner();
            return true;
          }
          const row = Array.isArray(data) ? data[0] : data;
          if (!row || typeof row !== "object") {
            setBoxSlipCode(trimmed);
            setBoxIntakeError(null);
            setActiveBoxSession(null);
            setPackageCodeCardOpen(true);
            setCurrentPackageTrackingId(trimmed);
            setIntakeToast("New slip code — scan the carton and tap Apply, then Confirm & Save to create the box record.");
            playOperatorSuccessBeep();
            setScanSuccessFlash(true);
            scheduleFocusScanner();
            return true;
          }
          const r = row as Record<string, unknown>;
          const pkgId = String(r.id ?? "").trim();
          const pkgNum = String(r.package_code ?? r.slip_id ?? r.package_number ?? "").trim();
          if (!pkgId || !isUuidString(pkgId) || !pkgNum) {
            setBoxSlipCode(trimmed);
            setBoxIntakeError(null);
            setActiveBoxSession(null);
            setPackageCodeCardOpen(true);
            setCurrentPackageTrackingId(trimmed);
            setIntakeToast("That slip record is incomplete — scan the carton and tap Apply, then Confirm & Save.");
            playOperatorSuccessBeep();
            setScanSuccessFlash(true);
            scheduleFocusScanner();
            return true;
          }
          const rowPalletId = String(r.pallet_id ?? "").trim();
          if (activePallet?.id && rowPalletId && rowPalletId !== activePallet.id) {
            setBoxIntakeError("This slip is linked to a BOX on a different pallet.");
            scheduleFocusScanner();
            return false;
          }
          setActiveBoxSession({ barcode: pkgNum, packageId: pkgId });
          setEditAllMode(false);
          setPackageCodeCardOpen(false);
          setCurrentPackageTrackingId(pkgNum);
          setBoxNotes(String(r.notes ?? "").trim());
          const pkgCarrierSlip = String(r.carrier_name ?? "").trim();
          if (pkgCarrierSlip) {
            const normalized = normalizeCarrierLabel(pkgCarrierSlip);
            const applied =
              normalized && normalized !== OTHER_CARRIER_NAME ? normalized : pkgCarrierSlip;
            if (normalized && normalized !== OTHER_CARRIER_NAME) {
              setPalletCarrier(normalized);
              setPalletCarrierOtherSelected(false);
            } else {
              setPalletCarrier(pkgCarrierSlip);
              setPalletCarrierOtherSelected(true);
            }
            persistOperatorSessionCarrier(applied);
            mergeCarrierIntoActivePalletState(applied);
          }
          const o = parsePalletPhotoUrlArray(r.outside_photo_urls);
          const ins = parsePalletPhotoUrlArray(r.inside_photo_urls);
          const s = parsePalletPhotoUrlArray(r.slip_photo_urls);
          setOutsideBoxPhotoUrls(o);
          setInsideBoxPhotoUrls(ins);
          setSlipBoxPhotoUrls(s);
          slipBoxPhotoUrlsRef.current = [...s];
          outsideBoxPhotoUrlsRef.current = [...o];
          insideBoxPhotoUrlsRef.current = [...ins];
          evidenceBaselineRef.current.slip = [...s];
          evidenceBaselineRef.current.outside = [...o];
          evidenceBaselineRef.current.inside = [...ins];
          pendingEvidenceStorageDeletesRef.current.clear();
          const sidRow = String(r.id_slip_contents ?? r.slip_code ?? r.slip_id ?? "").trim();
          const rmaRow = String(r.rma_number ?? "").trim();
          let manifestParsed: unknown = r.manifest_data;
          if (typeof manifestParsed === "string") {
            try {
              manifestParsed = JSON.parse(manifestParsed) as unknown;
            } catch {
              manifestParsed = null;
            }
          }
          const fromManifest = parseBoxSlipManifestData(manifestParsed);
          const fromDirectBoxDocs = parseDirectBoxShipmentDocumentation(manifestParsed);
          const hydrateDirectBoxDocs = directBox;
          if (hydrateDirectBoxDocs) {
            if (fromDirectBoxDocs.shippingLabelUrls.length > 0) {
              setShippingLabelPhotoUrls(fromDirectBoxDocs.shippingLabelUrls);
              shippingLabelPhotoUrlsRef.current = [...fromDirectBoxDocs.shippingLabelUrls];
              evidenceBaselineRef.current.shipping = [...fromDirectBoxDocs.shippingLabelUrls];
            }
            if (fromDirectBoxDocs.bolUrls.length > 0) {
              setBolPhotoUrls(fromDirectBoxDocs.bolUrls);
              bolPhotoUrlsRef.current = [...fromDirectBoxDocs.bolUrls];
              evidenceBaselineRef.current.bol = [...fromDirectBoxDocs.bolUrls];
            }
            if (!palletCarrierRef.current.trim() && fromDirectBoxDocs.carrierName) {
              const normalized = normalizeCarrierLabel(fromDirectBoxDocs.carrierName);
              const applied =
                normalized && normalized !== OTHER_CARRIER_NAME
                  ? normalized
                  : fromDirectBoxDocs.carrierName;
              if (normalized && normalized !== OTHER_CARRIER_NAME) {
                setPalletCarrier(normalized);
                setPalletCarrierOtherSelected(false);
              } else {
                setPalletCarrier(fromDirectBoxDocs.carrierName);
                setPalletCarrierOtherSelected(true);
              }
              persistOperatorSessionCarrier(applied);
              mergeCarrierIntoActivePalletState(applied);
            }
            if (!palletOrderIdRef.current.trim() && fromDirectBoxDocs.orderId) {
              setPalletOrderId(fromDirectBoxDocs.orderId);
            }
          }
          let lines = fromManifest.lines;
          let rma = rmaRow || fromManifest.rma;
          let slipCodeFromContents: string | null = null;
          const oidSlipScan = orgId.trim();
          let slipRowsMapped: BoxSlipVisionLine[] | null = null;
          let slipConflictingScan = "";
          let slipOrderScan = "";
          if (oidSlipScan) {
            const slipRes = await listOperatorSlipContentsForPackageAction(oidSlipScan, pkgId, sessionStoreId ?? null);
            if (slipRes.ok && slipRes.rows.length > 0) {
              slipRowsMapped = slipRes.rows.map((sr) =>
                mapSlipContentRowToVisionLine(sr as unknown as Record<string, unknown>),
              );
              const firstRma = String(slipRes.rows[0]?.rma_number ?? "").trim();
              if (firstRma) rma = firstRma;
              const sc = String(slipRes.rows[0]?.slip_code ?? "").trim();
              slipCodeFromContents = sc.length ? sc : null;
              slipConflictingScan = firstConflictingOrderIdFromSlipRows(slipRes.rows);
              slipOrderScan = firstSlipOrderIdFromSlipRows(slipRes.rows);
            }
          }
          if (slipRowsMapped && slipRowsMapped.length > 0) {
            lines = mergeManifestMissingIntoVisionLines(slipRowsMapped, fromManifest);
          }
          setBoxSlipCode(sidRow || fromManifest.slipCode || slipCodeFromContents || trimmed);
          setBoxSlipRma((prev) => (prev.trim() ? prev : rma));
          const normScan = normalizeSlipOrderConflictPair(slipOrderScan, slipConflictingScan);
          setBoxSlipOrderId(normScan.slip);
          setBoxSlipConflictingOrderId(normScan.conflicting);
          const pkgOidScan = String(r.order_id ?? "").trim();
          const refScan = referenceOrderIdForPackageFieldAfterSlipLoad(normScan, pkgOidScan);
          if (refScan != null) {
            applySlipOrderIdIfEmpty(refScan);
          } else {
            applyPalletOrderIdFromRaIfApplicable(rma);
          }
          commitBoxSlipVisionLinesFromSource(lines);
          setBoxSlipInvalidFormatBlocksSave(false);
          setIntakeToast("BOX loaded from slip id (local). Confirm & Save to write changes.");
          playOperatorSuccessBeep();
          setScanSuccessFlash(true);
          return true;
        } catch (e) {
          setBoxIntakeError(e instanceof Error ? e.message : "Slip lookup failed.");
          return false;
        } finally {
          setBusy(false);
          scheduleFocusScanner();
        }
      }

      const parentTrackingKey = (currentPalletTrackingId ?? "").trim();
      if (parentTrackingKey && trackingKeysEqual(trimmed, parentTrackingKey)) {
        setBoxIntakeError(
          "That code matches this shipment’s tracking ID — scan the barcode on the carton, not the pallet/shipment id.",
        );
        scheduleFocusScanner();
        return false;
      }
      const palletNumKey = activePallet?.pallet_number?.trim() ?? "";
      if (palletNumKey && trackingKeysEqual(trimmed, palletNumKey)) {
        setBoxIntakeError("That code matches the pallet id — scan a distinct box barcode.");
        scheduleFocusScanner();
        return false;
      }

      setBusy(true);
      try {
        if (!isSupabaseConfigured()) {
          setBoxNotes("");
          setActiveBoxSession({ barcode: trimmed, packageId: null });
          setPackageCodeCardOpen(false);
          setCurrentPackageTrackingId(trimmed);
          boxNotesBaselineRef.current = "";
          boxIntakeFieldsBaselineRef.current = {
            slipCode: "",
            rma: "",
            orderId: palletOrderIdRef.current.trim(),
            carrier: palletCarrierRef.current.trim(),
          };
          const tnHit = expectedPkgTrackingNumbers.some((t) => trackingKeysEqual(t, trimmed));
          if (tnHit) setIntakeToast("Tracking matched to box");
          playOperatorSuccessBeep();
          setScanSuccessFlash(true);
          return true;
        }
        if (!orgId?.trim()) {
          setBoxIntakeError("Organization context missing — refresh and try again.");
          return false;
        }
        if (!sessionStoreId) {
          setBoxIntakeError("Configure a store before recording boxes.");
          return false;
        }
        setBoxNotes("");
        setActiveBoxSession({ barcode: trimmed, packageId: null });
        setPackageCodeCardOpen(false);
        setCurrentPackageTrackingId(trimmed);
        boxNotesBaselineRef.current = "";
        boxIntakeFieldsBaselineRef.current = {
          slipCode: "",
          rma: "",
          orderId: palletOrderIdRef.current.trim(),
          carrier: palletCarrierRef.current.trim(),
        };
        const tnHit = expectedPkgTrackingNumbers.some((t) => trackingKeysEqual(t, trimmed));
        if (tnHit) setIntakeToast("Tracking matched to box — Confirm & Save when ready.");
        playOperatorSuccessBeep();
        setScanSuccessFlash(true);
        return true;
      } catch (e) {
        setBoxIntakeError(e instanceof Error ? e.message : "Could not create box record.");
        return false;
      } finally {
        setBusy(false);
        scheduleFocusScanner();
      }
    },
    [
      activeBoxSession,
      currentPalletTrackingId,
      sessionStoreId,
      orgId,
      activePallet?.id,
      activePallet?.pallet_number,
      expectedPkgTrackingNumbers,
      mergeCarrierIntoActivePalletState,
      persistOperatorSessionCarrier,
      scheduleFocusScanner,
      commitBoxSlipVisionLinesFromSource,
      applyPalletOrderIdFromRaIfApplicable,
      applySlipOrderIdIfEmpty,
    ],
  );

  const saveBoxAndContinue = useCallback(
    async (opts?: { appendDiscrepancyNote?: boolean; stayOnPackageScanAfterSave?: boolean }): Promise<boolean> => {
      if (!activeBoxSession) return false;
      const pkgBarcode = (activeBoxSession.barcode ?? "").trim();
      if (!pkgBarcode) {
        setBoxIntakeError("Carton barcode is required — scan the physical box and tap Apply before saving.");
        return false;
      }
      const carrierToPersist = palletCarrier.trim();
      if (!carrierToPersist) {
        setBoxIntakeError("Carrier name is required before saving this BOX.");
        return false;
      }
      if (palletCarrierOtherSelected && !carrierToPersist) {
        setBoxIntakeError("Enter the carrier name (Other selected) before saving this BOX.");
        return false;
      }
      if (!slipBoxPhotoUrls.some((u) => String(u ?? "").trim().length > 0)) {
        setBoxIntakeError("Add at least one packing slip photo before saving this BOX.");
        return false;
      }
      const directBoxShipmentDocumentation = directBox;
      if (
        directBoxShipmentDocumentation &&
        !shippingLabelPhotoUrls.some((u) => String(u ?? "").trim().length > 0)
      ) {
        setBoxIntakeError("Add the required shipment photo / shipping label before saving this BOX.");
        return false;
      }
      if (boxSlipInvalidFormatBlocksSave) {
        setBoxIntakeError(
          "INVALID_SLIP_FORMAT — use a clear packing slip photo (slip id, item lines, and barcodes visible).",
        );
        return false;
      }
      if (boxSlipVisionBusy) {
        setBoxIntakeError("Wait for packing slip analysis to finish before saving.");
        return false;
      }
    const slipCodePersist = boxSlipCode.trim() || null;
    setBoxSaveBusy(true);
    let resolvedPalletIdForDetail: string | null =
      activePallet?.id && isUuidString(activePallet.id) ? activePallet.id : null;
    /** Last successful {@link updateOperatorIntakeBoxPackageAction} result (pallet order re-read). */
    let operatorPackageSaveResult: UpdateOperatorIntakeBoxPackageResult | null = null;
    try {
      setDuplicatePackingSlip(null);
      setBoxIntakeError(null);
      const orderPersist = palletOrderId.trim() || null;
      const rmaPersist = boxSlipRma.trim() || null;
      let notesForSave = boxNotesRef.current.trim();
      if (opts?.appendDiscrepancyNote && !notesForSave.includes(DISCREPANCY_AUTO_NOTE)) {
        notesForSave = notesForSave
          ? `${notesForSave}\n${DISCREPANCY_AUTO_NOTE}`
          : DISCREPANCY_AUTO_NOTE;
      }
      setBoxNotes(notesForSave);
      const slipLinesForPersist =
        boxSlipVisionLinesPersistRef.current.length > 0
          ? boxSlipVisionLinesPersistRef.current
          : clonePersistBoxSlipVisionLines(boxSlipVisionLines);
      const directBoxSave = Boolean(directBox);
      const directBoxTracking =
        (currentPackageTrackingId ?? "").trim() ||
        pkgBarcode ||
        (activeTracking ?? "").trim() ||
        (currentPalletTrackingId ?? "").trim();
      const manifestPayload = {
        box_slip_vision: {
          id_slip_contents: slipCodePersist,
          rma_number: rmaPersist,
          items: slipLinesForPersist,
          captured_at: new Date().toISOString(),
        },
        ...(directBoxSave
          ? {
              direct_box_shipment_documentation: {
                shipping_label_photo_urls: shippingLabelPhotoUrls,
                bol_photo_urls: bolPhotoUrls,
                carrier_name: carrierToPersist,
                order_id: orderPersist,
                captured_at: new Date().toISOString(),
              },
            }
          : {}),
      };
      const oid = orgId?.trim();

      if (isSupabaseConfigured()) {
        if (!oid) {
          setBoxIntakeError("Organization context missing — refresh and try again.");
          return false;
        }
        if (!sessionStoreId) {
          setBoxIntakeError("Configure a store before recording boxes.");
          return false;
        }
        let resolvedPalletId = activePallet?.id && isUuidString(activePallet.id) ? activePallet.id : null;
        const tnForEnsure = (currentPalletTrackingId ?? "").trim() || (activeTracking ?? "").trim();
        if (!directBoxSave && !resolvedPalletId && tnForEnsure) {
          const ensured = await ensureReceivingPalletForTracking(tnForEnsure, orderPersist || null);
          if (!ensured) {
            setBoxIntakeError(
              "Could not link this box to a shipment pallet — confirm the tracking ID on the receiving step, then try again.",
            );
            return false;
          }
          if ("blocked" in ensured) {
            setBoxIntakeError(ensured.message);
            return false;
          }
          resolvedPalletId = ensured.id;
          resolvedPalletIdForDetail = ensured.id;
          setActivePallet({
            id: ensured.id,
            pallet_number: ensured.pallet_number,
            carrier_name: carrierToPersist,
          });
        }
        if (!directBoxSave && !resolvedPalletId) {
          setBoxIntakeError(
            "Could not link this box to a shipment pallet — confirm the tracking ID on the receiving step, then try again.",
          );
          return false;
        }
        const parentShipmentTracking =
          directBoxSave
            ? directBoxTracking || null
            : (currentPalletTrackingId ?? "").trim() || (activeTracking ?? "").trim() || null;
        let packageId = String(activeBoxSession.packageId ?? "").trim();
        if (!packageId || !isUuidString(packageId)) {
          const ins = await insertOperatorIntakeBoxPackageAction({
            requestedOrganizationId: oid,
            palletId: resolvedPalletId && isUuidString(resolvedPalletId) ? resolvedPalletId : null,
            packageNumber: pkgBarcode,
            shipmentTrackingNumber: parentShipmentTracking,
            storeId: sessionStoreId,
          });
          if (!ins.ok) {
            setBoxIntakeError(ins.message);
            return false;
          }
          if (ins.reusedExisting) {
            setIntakeToast("This package barcode was already saved. Updating existing record...");
          }
          packageId = ins.packageId;
        }
        const saveRes = await updateOperatorIntakeBoxPackageAction({
          requestedOrganizationId: oid,
          storeId: sessionStoreId,
          packageId,
          palletId: resolvedPalletId && isUuidString(resolvedPalletId) ? resolvedPalletId : null,
          palletUpdate:
            resolvedPalletId && isUuidString(resolvedPalletId)
              ? {
                  carrier_name: carrierToPersist,
                  order_id: orderPersist,
                  shipping_label_urls: shippingLabelPhotoUrls,
                }
              : null,
          packageUpdate: {
            package_code: pkgBarcode,
            ...(directBoxSave ? { carrier_name: carrierToPersist } : {}),
            tracking_number: parentShipmentTracking,
            order_id: orderPersist,
            outside_photo_urls: outsideBoxPhotoUrls,
            inside_photo_urls: insideBoxPhotoUrls,
            slip_photo_urls: slipBoxPhotoUrls,
            id_slip_contents: slipCodePersist,
            rma_number: rmaPersist,
            manifest_data: manifestPayload,
            notes: notesForSave.length ? notesForSave : null,
          },
          slipContents: {
            mode: "replace",
            slipCode: slipCodePersist,
            lines: slipLinesForPersist.map((line) => ({
              upc: line.upc,
              fnsku: line.fnsku,
              printed_asin: line.printed_asin ?? null,
              description: line.description,
              expected_qty: line.expected_qty,
              condition: line.condition,
              missing: Boolean(line.missing),
            })),
          },
        });
        if (!saveRes.ok) {
          if (saveRes.duplicatePackingSlip) {
            setDuplicatePackingSlip(saveRes.duplicatePackingSlip);
            setBoxIntakeError(null);
          } else {
            setDuplicatePackingSlip(null);
            setBoxIntakeError(saveRes.message);
          }
          return false;
        }
        if (saveRes.palletMixedOrderIds) {
          setPalletMixedOrderIdsWarning(true);
        }
        operatorPackageSaveResult = saveRes;
        const visionSnap = clonePersistBoxSlipVisionLines(slipLinesForPersist);
        const linkageSnap =
          boxSlipVisionLineLinkagesRef.current.length > 0
            ? [...boxSlipVisionLineLinkagesRef.current]
            : [...boxSlipVisionLineLinkages];
        if (!opts?.stayOnPackageScanAfterSave) {
          const carryPayload = snapshotItemScanSlipCarryoverFromBoxIntake(
            packageId,
            visionSnap,
            linkageSnap,
          );
          itemScanSlipCarryoverRef.current = carryPayload;
          setItemScanSlipCarryover(carryPayload);
        } else {
          itemScanSlipCarryoverRef.current = null;
          setItemScanSlipCarryover(null);
        }
        setItemScanPackageId(packageId);
      } else {
        setItemScanPackageId(`demo-${Date.now()}`);
      }
      await flushPendingEvidenceStorageDeletes();
      const slipQtySumForReceiving = slipLinesForPersist.reduce(
        (s, line) => s + Math.max(0, Math.floor(Number(line.expected_qty ?? 0))),
        0,
      );
      setReceivingSlipExpectedItemQtyTotal(slipQtySumForReceiving > 0 ? slipQtySumForReceiving : null);
      setItemScanPackageLabel(activeBoxSession.barcode);
      setScannedBoxesSavedCount((n) => n + 1);
      setActiveBoxSession(null);
      setCurrentPackageTrackingId(null);
      setBoxIntakeError(null);
      setDuplicatePackingSlip(null);
      setBoxSlipInvalidFormatBlocksSave(false);
      clearOperatorPhotoArrays(["outside", "inside", "slip"]);
      setBoxSlipCode("");
      setBoxSlipRma("");
      clearPalletOrderIdIfAutoFilledFromRa();
      if (
        operatorPackageSaveResult &&
        operatorPackageSaveResult.ok &&
        "palletOrderIdFromDb" in operatorPackageSaveResult
      ) {
        const raw = operatorPackageSaveResult.palletOrderIdFromDb;
        const o = raw == null ? "" : String(raw).trim();
        setPalletDbOrderId(o);
        if (!operatorPackageSaveResult.palletMixedOrderIds) {
          setPalletOrderId(o);
        }
      }
      clearBoxSlipVisionLinesState();
      hydrateBoxPackageIdRef.current = null;
      if (resolvedPalletIdForDetail && isUuidString(resolvedPalletIdForDetail)) {
        void loadPalletDetail(resolvedPalletIdForDetail);
      }
      setPalletDocHydrationNonce((n) => n + 1);
      const stay = Boolean(opts?.stayOnPackageScanAfterSave);
      playOperatorSuccessBeep();
      setPackageSaveSuccessDestination(stay ? "hub" : "items");
      setPackageSaveSuccessOverlay(true);
      if (stay) {
        setIntakeToast(
          opts?.appendDiscrepancyNote
            ? "Box saved with discrepancy. Scan the next box, or tap Save & Continue to Items when you are ready."
            : "Box saved. Back at the pallet hub — scan the next box when you are ready.",
        );
      }
      window.setTimeout(() => {
        setPackageSaveSuccessOverlay(false);
        setPackageSaveSuccessDestination(null);
        if (stay) {
          setScanSuccessFlash(true);
          if (!directBoxSave) setDirectBox(false);
          setFlowPhase("package_scan");
          window.requestAnimationFrame(() => {
            window.requestAnimationFrame(() => {
              document
                .getElementById("operator-saved-boxes-hub")
                ?.scrollIntoView({ behavior: "smooth", block: "start" });
            });
          });
        } else {
          setFlowPhase("items");
        }
        scheduleFocusScanner();
      }, 900);
      return true;
    } finally {
      setBoxSaveBusy(false);
    }
  }, [
    activeBoxSession,
    activePallet?.id,
    activeTracking,
    boxSlipCode,
    boxSlipRma,
    boxSlipVisionLines,
    bolPhotoUrls,
    insideBoxPhotoUrls,
    loadPalletDetail,
    outsideBoxPhotoUrls,
    palletCarrier,
    palletCarrierOtherSelected,
    palletOrderId,
    orgId,
    sessionStoreId,
    scheduleFocusScanner,
    shippingLabelPhotoUrls,
    slipBoxPhotoUrls,
    currentPackageTrackingId,
    currentPalletTrackingId,
    directBox,
    flushPendingEvidenceStorageDeletes,
    boxSlipInvalidFormatBlocksSave,
    boxSlipVisionBusy,
    boxSlipVisionLineLinkages,
    clearOperatorPhotoArrays,
  ]);

  const dispatchPackageFinalizeSave = useCallback(
    (kind: "save_items" | "save_hub" | "discrepancy") => {
      if (kind === "save_items") void saveBoxAndContinue();
      else if (kind === "save_hub") void saveBoxAndContinue({ stayOnPackageScanAfterSave: true });
      else void saveBoxAndContinue({ appendDiscrepancyNote: true, stayOnPackageScanAfterSave: true });
    },
    [saveBoxAndContinue],
  );

  const populateDraftFromEpRow = useCallback(
    async (barcode: string, tier: ItemResolveTier, row: Record<string, unknown>) => {
      const sku = String(row.sku ?? "").trim();
      const fnsku = String(row.fnsku ?? "").trim();
      const line = expectedPkgLines.find((l) => l.sku === sku && l.fnsku === fnsku);
      const epLinkage = line?.product_linkage ?? null;
      const catalogName = epLinkage?.product_name?.trim() || epPackageRowCatalogSubtitle(row)?.trim() || null;
      const catalogImageUrl: string | null = null;
      const expirationSupported = false;

      const productNameMatched =
        catalogName && line?.productLabel?.trim() ? catalogName === line.productLabel.trim() : null;

      setItemDraft({
        barcode,
        tier,
        epRow: row,
        identifierMatched: true,
        productNameMatched,
        catalogName,
        catalogImageUrl,
        expirationSupported,
      });
      setItemBarcodeMiss(null);
      setCandidatePicker(null);
      modalOpenRef.current = false;
      setInspectionCondition("good");
      setItemQtyStepper(1);
      setItemNotes("");
      setItemExpiryDate("");
      setItemBatch("");
      setItemReceiveError(null);
    },
    [expectedPkgLines],
  );

  const queueItemUnitModal = useCallback(
    (args: {
      scannedBarcode: string;
      slip: SlipBarcodeMatchRow | null;
      title?: string;
      subtitle?: string | null;
      /** When slip is null, pass EP / shipment line text for perishable heuristic in the modal. */
      slipDescription?: string | null;
      matchKindPreset?: "fnsku" | "upc" | "unexpected" | null;
    }) => {
      const slip = args.slip;
      if (!slip) {
        setItemOverscanWarning(null);
      } else {
        const slipId = slip.id && isUuidString(String(slip.id)) ? String(slip.id) : null;
        const expectedQty = Math.max(0, Math.floor(Number(slip.quantity ?? 0)));
        const currentForSlip = slipId ? (packageItemScanState.bySlipId[slipId] ?? 0) : 0;
        if (expectedQty > 0 && currentForSlip >= expectedQty) {
          setItemOverscanWarning(
            `Over-scan: this slip line already shows ${currentForSlip} scanned (expected ${expectedQty}). The scan will still be recorded.`,
          );
        } else {
          setItemOverscanWarning(null);
        }
      }

      let slipDescription: string | null = null;
      if (args.slipDescription !== undefined) {
        slipDescription = String(args.slipDescription ?? "").trim() || null;
      } else if (slip != null) {
        slipDescription = String(slip.description ?? "").trim() || null;
      }

      const slipIdResolved =
        slip?.id && isUuidString(String(slip.id)) ? String(slip.id) : null;

      setItemDraft(null);
      setCandidatePicker(null);

      itemUnitModalDraftDirtyRef.current = false;
      modalOpenRef.current = true;
      setItemUnitModal({
        mode: "create",
        scannedBarcode: args.scannedBarcode.trim(),
        slip,
        slipContentId: slipIdResolved,
        slipDescription,
        productLinkage: productLinkageForSlipMatch(slip, itemInspectionSlipLines),
        title: args.title ?? "Record scanned unit",
        subtitle: args.subtitle ?? null,
        initialState: null,
        matchKindPreset: args.matchKindPreset ?? null,
      });
    },
    [packageItemScanState.bySlipId, itemInspectionSlipLines],
  );

  const openEditScannedItemModal = useCallback(
    (unit: OperatorPackageItemRow) => {
      if (!itemScanEditAllMode || !unit.id || busy) return;
      const slip =
        unit.slip_content_id && isUuidString(unit.slip_content_id)
          ? itemInspectionSlipLines.find((s) => String(s.id ?? "").trim() === unit.slip_content_id) ?? null
          : null;
      const slipMatch: SlipBarcodeMatchRow | null = slip
        ? {
            id: slip.id,
            upc: slip.upc,
            fnsku: slip.fnsku,
            description: slip.description,
            quantity: slip.quantity,
            sort_index: slip.sort_index,
          }
        : null;
      setItemReceiveError(null);
      setItemBarcodeMiss(null);
      setItemScanEditPick(null);
      itemUnitModalDraftDirtyRef.current = false;
      modalOpenRef.current = true;
      setItemUnitModal({
        mode: "edit",
        returnItemId: unit.id,
        scannedBarcode: unit.scanned_barcode.trim(),
        slip: slipMatch,
        slipContentId: unit.slip_content_id,
        slipDescription: slip?.description?.trim() || null,
        productLinkage: unit.product_linkage,
        title: "Edit scanned item",
        subtitle: unit.scanned_barcode.trim() || null,
        initialState: operatorPackageItemRowToModalInitial(unit),
        matchKindPreset: unit.match_kind,
      });
    },
    [busy, itemScanEditAllMode, itemInspectionSlipLines],
  );

  const closeItemScanUnitPicker = useCallback(() => {
    setItemScanUnitPickerOpen(false);
    setItemScanEditPick(null);
    modalOpenRef.current = false;
  }, []);

  const openItemScanUnitPickerForRow = useCallback(
    (pick: ItemScanEditPick, units: OperatorPackageItemRow[]) => {
      if (units.length === 1) {
        openEditScannedItemModal(units[0]!);
        return;
      }
      setItemScanEditPick(pick);
      setItemScanUnitPickerOpen(true);
      modalOpenRef.current = true;
    },
    [openEditScannedItemModal],
  );

  const handleItemScanEditSelectSlipCell = useCallback(
    (cell: {
      key: string;
      slip: Pick<OperatorSlipContentsListRow, "id" | "product_linkage" | "fnsku" | "upc">;
      scanned: number;
    }) => {
      if (!itemScanEditAllMode || busy || cell.scanned <= 0) return;
      const slipId = cell.slip.id && isUuidString(String(cell.slip.id)) ? String(cell.slip.id).trim() : "";
      const units = slipId ? packageItemsForSlipContentId(packageItemHydratedRows, slipId) : [];
      const meta = itemScanEditPickMetaFromSlip(cell.slip);
      openItemScanUnitPickerForRow(
        { kind: "slip_cell", cellKey: cell.key, slipContentId: slipId, ...meta },
        units,
      );
    },
    [itemScanEditAllMode, busy, packageItemHydratedRows, openItemScanUnitPickerForRow],
  );

  const handleItemScanEditSelectUnexpected = useCallback(() => {
    if (!itemScanEditAllMode || busy) return;
    const units = packageItemsUnexpected(packageItemHydratedRows);
    openItemScanUnitPickerForRow(
      {
        kind: "unexpected",
        rowTitle: "Not on packing slip",
        rowSubtitle: null,
      },
      units,
    );
  }, [itemScanEditAllMode, busy, packageItemHydratedRows, openItemScanUnitPickerForRow]);

  /** Soft-delete the most recently scanned return_item for a given slip cell (Edit All mode only). */
  const handleDeleteSlipCellUnit = useCallback(
    async (cell: { key: string; scanned: number; slip: OperatorSlipContentsListRow }) => {
      if (!itemScanEditAllMode || busy) return;
      const slipId = String(cell.slip.id ?? "").trim();
      const units = slipId ? packageItemsForSlipContentId(packageItemHydratedRows, slipId) : packageItemsUnexpected(packageItemHydratedRows);
      if (units.length === 0) return;
      // Sort by created_at desc to delete most recent
      const sorted = [...units].sort((a, b) => {
        const ta = String(a.created_at ?? "").trim();
        const tb = String(b.created_at ?? "").trim();
        return tb.localeCompare(ta);
      });
      const target = sorted[0];
      if (!target?.id || !isUuidString(String(target.id).trim())) return;
      const oid = (orgId ?? "").trim();
      const pkgId = (itemScanPackageId ?? "").trim();
      if (!oid || !pkgId) return;

      setBusy(true);
      try {
        const res = await deleteOperatorPackageItemAction({
          requestedOrganizationId: oid,
          returnItemId: String(target.id).trim(),
          packageId: pkgId,
        });
        if (!res.ok) {
          setSyncErrorToast(res.error ?? "Could not delete scan record.");
          return;
        }
        // Update local state immediately
        setPackageItemHydratedRows((prev) => prev.filter((r) => r.id !== target.id));
        setPackageItemScanState((prev) => {
          const sid = slipId || null;
          if (!sid) {
            return { ...prev, unexpectedUnits: Math.max(0, prev.unexpectedUnits - 1) };
          }
          const cur = prev.bySlipId[sid] ?? 0;
          return {
            ...prev,
            bySlipId: { ...prev.bySlipId, [sid]: Math.max(0, cur - 1) },
          };
        });
        setItemReceiveCountSyncNonce((n) => n + 1);
      } finally {
        setBusy(false);
      }
    },
    [itemScanEditAllMode, busy, packageItemHydratedRows, orgId, itemScanPackageId],
  );

  const handleItemScanEditSelectOrphanUnit = useCallback(
    (unit: OperatorPackageItemRow) => {
      if (!itemScanEditAllMode || busy) return;
      if (!unit.id) {
        openItemScanUnitPickerForRow(
          {
            kind: "unexpected",
            rowTitle: productLinkageOperatorPrimaryDisplayLabel(unit.product_linkage),
            rowSubtitle: unit.scanned_barcode?.trim() || null,
          },
          [],
        );
        return;
      }
      openEditScannedItemModal(unit);
    },
    [itemScanEditAllMode, busy, openEditScannedItemModal, openItemScanUnitPickerForRow],
  );

  const openAddScanItemModal = useCallback(() => {
    if (!hasReceivableBoxForItems(itemScanPackageId, activeBoxSession)) {
      setItemReceiveError("Select or scan a box before inspecting items.");
      return;
    }
    if (busy) return;
    setItemReceiveError(null);
    setItemBarcodeMiss(null);
    queueItemUnitModal({
      scannedBarcode: "",
      slip: null,
      title: "➕ Add / Scan Item",
      subtitle: "Scan the barcode (UPC / FNSKU), set condition, then save.",
      matchKindPreset: null,
    });
  }, [itemScanPackageId, activeBoxSession, busy, queueItemUnitModal]);

  const saveItemUnitModal = useCallback(
    async (payload: ItemUnitRecordSavePayload): Promise<ItemUnitRecordSaveResult> => {
      const ctx = itemUnitModal;
      if (!ctx) return { ok: false, message: "Item modal closed — try again." };
      const trimmed = payload.scannedBarcode.trim();
      if (!trimmed) {
        const msg = "Barcode is required.";
        showScanActionToast("error", msg);
        return { ok: false, message: msg };
      }

      setItemDraft(null);
      setCandidatePicker(null);

      const isEdit = ctx.mode === "edit" && Boolean(ctx.returnItemId?.trim());
      const editReturnItemId = ctx.returnItemId?.trim() ?? "";

      if (isEdit && isUuidString(editReturnItemId)) {
        if (!sessionStoreId) {
          const msg = "Select an active store before saving changes.";
          showScanActionToast("error", msg);
          return { ok: false, message: msg };
        }
        setBusy(true);
        setItemReceiveError(null);
        try {
          const res = await updateOperatorPackageItemAction({
            requestedOrganizationId: orgId,
            returnItemId: editReturnItemId,
            storeId: sessionStoreId,
            discrepancyTags: payload.discrepancyTags,
            expiryDate: payload.expiryDate,
            lotNumber: payload.lotNumber,
            evidenceUrls: payload.evidenceUrls,
            optionalItemPhotoUrl: payload.optionalItemPhotoUrl,
            traceabilityRequired: payload.traceabilityRequired,
            operatorNotes: payload.operatorNotes,
          });
          if (!res.ok) {
            const msg = res.message?.trim() || "Could not save changes.";
            showScanActionToast("error", msg);
            return { ok: false, message: msg };
          }
          showScanActionToast("success", "✓ Item updated.");
          setPackageItemsHydrationNonce((n) => n + 1);
          setItemReceiveCountSyncNonce((n) => n + 1);
          modalOpenRef.current = false;
          setItemUnitModal(null);
          scheduleFocusScanner();
          return { ok: true };
        } finally {
          setBusy(false);
        }
      }

      const pkgId = itemScanPackageId && isUuidString(itemScanPackageId) ? itemScanPackageId : null;

      const resolverFields = buildOperatorBarcodeResolverFields(trimmed);
      let slipContentId: string | null = ctx.slipContentId;
      let matchKind: "fnsku" | "upc" | "unexpected" =
        ctx.matchKindPreset != null ? ctx.matchKindPreset : resolverFields.matchKind;
      if (ctx.matchKindPreset == null) {
        const slipRowsForMatch: SlipBarcodeMatchRow[] = itemInspectionSlipLines
          .filter((r) => Boolean(r.fnsku?.trim() || r.upc?.trim()))
          .map((r) => ({
            id: r.id,
            upc: r.upc,
            fnsku: r.fnsku,
            description: r.description,
            quantity: r.quantity,
            sort_index: r.sort_index,
          }));
        const pool =
          slipRowsForMatch.length > 0 ? slipRowsForMatch : ctx.slip != null ? [ctx.slip] : [];
        if (pool.length > 0) {
          const outcome = resolveItemBarcodeAgainstSlipRows(trimmed, pool);
          if (outcome.kind === "single") {
            const tier = outcome.tier;
            matchKind = tier === "fnsku" ? "fnsku" : tier === "upc" ? "upc" : "unexpected";
            const sid = String(outcome.slip.id ?? "").trim();
            if (sid && isUuidString(sid)) slipContentId = sid;
          }
        }
      }

      if (!isSupabaseConfigured() || !pkgId) {
        const sid = ctx.slipContentId;
        if (sid && isUuidString(sid)) {
          setPackageItemScanState((prev) => ({
            ...prev,
            bySlipId: {
              ...prev.bySlipId,
              [sid]: (prev.bySlipId[sid] ?? 0) + 1,
            },
          }));
        } else {
          setPackageItemScanState((prev) => ({ ...prev, unexpectedUnits: prev.unexpectedUnits + 1 }));
        }
        setItemReceiveDemoScannedUnits((u) => u + 1);
        setScanSuccessFlash(true);
        showScanActionToast("success", "✓ Item successfully registered and logged.");
        modalOpenRef.current = false;
        setItemUnitModal(null);
        scheduleFocusScanner();
        return { ok: true };
      }

      if (!sessionStoreId) {
        const msg = "Select an active store before saving scans.";
        showScanActionToast("error", msg);
        return { ok: false, message: msg };
      }

      let expectedPackageHintId: string | null = null;
      if (slipContentId && isUuidString(slipContentId)) {
        const slipRow = itemInspectionSlipLines.find((s) => String(s.id ?? "").trim() === slipContentId);
        if (slipRow) {
          const epRows = Array.isArray(expectedPkgDetailRows) ? expectedPkgDetailRows : [];
          const matched = epRowsMatchingSlipLike(slipRow, epRows);
          const pick =
            matched.find((r) => {
              const exp = Math.max(0, Math.floor(Number(r.expected_scan_quantity ?? 0)));
              const act = Math.max(0, Math.floor(Number(r.actual_scanned_count ?? 0)));
              return exp - act > 0;
            }) ?? matched[0];
          const eid = String((pick as { id?: unknown })?.id ?? "").trim();
          if (isUuidString(eid)) expectedPackageHintId = eid;
        }
      }

      setBusy(true);
      setItemReceiveError(null);
      try {
        const res = await insertOperatorPackageItemAction({
          requestedOrganizationId: orgId,
          packageId: pkgId,
          storeId: sessionStoreId,
          slipContentId,
          expectedPackageHintId,
          scannedBarcode: trimmed,
          matchKind,
          quantity: 1,
          discrepancyTags: payload.discrepancyTags,
          expiryDate: payload.expiryDate,
          lotNumber: payload.lotNumber,
          evidenceUrls: payload.evidenceUrls,
          optionalItemPhotoUrl: payload.optionalItemPhotoUrl,
          traceabilityRequired: payload.traceabilityRequired,
          operatorNotes: payload.operatorNotes,
        });
        if (!res.ok) {
          const msg = res.message?.trim() || "Item scan not saved.";
          showScanActionToast("error", msg);
          return { ok: false, message: msg };
        }
        showScanActionToast("success", "✓ Item successfully registered and logged.");
        setPackageItemsHydrationNonce((n) => n + 1);
        setItemReceiveCountSyncNonce((n) => n + 1);
        setScanSuccessFlash(true);
        modalOpenRef.current = false;
        setItemUnitModal(null);
        scheduleFocusScanner();
        return { ok: true };
      } finally {
        setBusy(false);
      }
    },
    [
      itemUnitModal,
      itemScanPackageId,
      orgId,
      sessionStoreId,
      itemInspectionSlipLines,
      expectedPkgDetailRows,
      scheduleFocusScanner,
      showScanActionToast,
    ],
  );

  const resolveItemUnitBarcodeLinkage = useCallback(
    async (
      barcode: string,
      matchKind: "fnsku" | "upc" | "unexpected",
    ): Promise<ProductLinkageDisplayContract | null> => {
      if (!orgId || !sessionStoreId || !isSupabaseConfigured()) return null;
      const fields = buildOperatorBarcodeResolverFields(barcode);
      const effectiveMatchKind =
        matchKind === "fnsku" || matchKind === "upc" ? matchKind : fields.matchKind;
      const res = await previewOperatorItemBarcodeLinkageAction({
        requestedOrganizationId: orgId,
        storeId: sessionStoreId,
        scannedBarcode: barcode,
        matchKind: effectiveMatchKind,
      });
      return res.ok ? res.product_linkage : null;
    },
    [orgId, sessionStoreId],
  );

  const handleItemBarcodeScan = useCallback(
    async (code: string) => {
      if (busy) return;
      if (!hasReceivableBoxForItems(itemScanPackageId, activeBoxSession)) {
        setItemReceiveError("Select or scan a box before inspecting items.");
        setScanProgressPhase("error");
        return;
      }
      const trimmed = code.trim();
      setItemReceiveError(null);
      setItemBarcodeMiss(null);
      setItemOverscanWarning(null);
      if (!trimmed) return;
      setScanProgressPhase("loading_expected_lines");

      const slipRowsForMatch: SlipBarcodeMatchRow[] = itemInspectionSlipLines
        .filter((r) => Boolean(r.fnsku?.trim() || r.upc?.trim()))
        .map((r) => ({
          id: r.id,
          upc: r.upc,
          fnsku: r.fnsku,
          description: r.description,
          quantity: r.quantity,
          sort_index: r.sort_index,
        }));

      const preferSlipMatching = slipRowsForMatch.length > 0;

      if (preferSlipMatching) {
        const outcome = resolveItemBarcodeAgainstSlipRows(trimmed, slipRowsForMatch);
        if (outcome.kind === "none") {
          modalOpenRef.current = true;
          setUnexpectedPackageItemModal({ barcode: trimmed });
          setScanProgressPhase("needs_review");
          return;
        }
        if (outcome.kind === "ambiguous") {
          modalOpenRef.current = true;
          setSlipLineCandidatePicker({
            barcode: outcome.barcode,
            tier: outcome.tier,
            candidates: outcome.candidates,
          });
          setScanProgressPhase("needs_review");
          return;
        }

        queueItemUnitModal({
          scannedBarcode: trimmed,
          slip: outcome.slip,
          title: "Record scanned unit",
          subtitle:
            String(outcome.slip.description ?? "").trim() ||
            [outcome.slip.fnsku, outcome.slip.upc].filter(Boolean).join(" · ") ||
            null,
        });
        setScanProgressPhase("needs_review");
        return;
      }

      const detailSafe = Array.isArray(expectedPkgDetailRows) ? expectedPkgDetailRows : [];
      if (!detailSafe.length) {
        setItemBarcodeMiss(
          `No packing slip lines with UPC/FNSKU for this box, and no shipment expected lines loaded for "${trimmed}".`,
        );
        setScanProgressPhase("error");
        return;
      }
      const outcome = resolveItemBarcodeAgainstExpectedRows(trimmed, detailSafe);
      if (outcome.kind === "none") {
        setItemBarcodeMiss(`No expected match for "${trimmed}".`);
        setScanProgressPhase("error");
        return;
      }
      if (outcome.kind === "ambiguous") {
        modalOpenRef.current = true;
        setCandidatePicker({ barcode: outcome.barcode, tier: outcome.tier, candidates: outcome.candidates });
        setScanProgressPhase("needs_review");
        return;
      }
      queueItemUnitModal({
        scannedBarcode: trimmed,
        slip: null,
        slipDescription: epRowToSlipDescriptionForItemModal(outcome.row as Record<string, unknown>),
        matchKindPreset: itemResolveTierToPackageMatchKind(outcome.tier),
        title: "Record scanned unit",
        subtitle: epPackageRowPrimaryLabel(outcome.row as Record<string, unknown>),
      });
      setScanProgressPhase("needs_review");
      scheduleFocusScanner();
      return;
    },
    [
      busy,
      itemScanPackageId,
      activeBoxSession,
      itemInspectionSlipLines,
      queueItemUnitModal,
      expectedPkgDetailRows,
      scheduleFocusScanner,
    ],
  );

  const beginItemPhase = useCallback(() => {
    const pkgId = String(itemScanPackageId ?? "").trim();
    const sessionPkgId = String(activeBoxSession?.packageId ?? "").trim();
    if (
      pkgId &&
      sessionPkgId &&
      pkgId === sessionPkgId &&
      isUuidString(pkgId)
    ) {
      setFlowPhase("items");
      scheduleFocusScanner();
      return;
    }
    if (activeBoxSession) {
      setBoxIntakeError("Confirm & Save this BOX before continuing to item inspection.");
      return;
    }
    if (!pkgId) {
      setBoxIntakeError("Save this BOX first to continue.");
      return;
    }
    setFlowPhase("items");
    scheduleFocusScanner();
  }, [activeBoxSession, itemScanPackageId, scheduleFocusScanner]);

  const resetItemInspectionForm = useCallback(() => {
    if (itemPhotoFrontUrlRef.current) {
      URL.revokeObjectURL(itemPhotoFrontUrlRef.current);
      itemPhotoFrontUrlRef.current = null;
    }
    if (itemPhotoBarcodeUrlRef.current) {
      URL.revokeObjectURL(itemPhotoBarcodeUrlRef.current);
      itemPhotoBarcodeUrlRef.current = null;
    }
    if (itemPhotoDamageUrlRef.current) {
      URL.revokeObjectURL(itemPhotoDamageUrlRef.current);
      itemPhotoDamageUrlRef.current = null;
    }
    setItemPhotoFrontUrl(null);
    setItemPhotoBarcodeUrl(null);
    setItemPhotoDamageUrl(null);
    setItemDraft(null);
    setInspectionCondition("good");
    setItemQtyStepper(1);
    setItemNotes("");
    setItemExpiryDate("");
    setItemBatch("");
    setItemReceiveError(null);
  }, []);

  const applyEpReceiveLinkageToExpectedRows = useCallback(
    (sku: string, fnsku: string, linkage: ProductLinkageDisplayContract, epId?: string | null) => {
      const label = productLinkagePrimaryLabel(linkage);
      setExpectedPkgLines((lines) =>
        lines.map((l) =>
          l.sku === sku && l.fnsku === fnsku
            ? {
                ...l,
                product_linkage: linkage,
                productLabel: label !== "Line item" ? label : l.productLabel,
              }
            : l,
        ),
      );
      const epKey = String(epId ?? "").trim();
      if (epKey && isUuidString(epKey)) {
        setEpReceiveLinkageByEpId((prev) => ({ ...prev, [epKey]: linkage }));
      }
    },
    [],
  );

  const handleSaveAndNextItem = useCallback(async () => {
    if (!itemDraft) {
      setItemReceiveError("Scan a barcode to match an expected line first.");
      return;
    }
    const hintEpIdRaw = String(itemDraft.epRow.id ?? "").trim();
    const expectedPackageIdHint = isUuidString(hintEpIdRaw) ? hintEpIdRaw : null;

    const claims = inspectionConditionToClaims(inspectionCondition);
    if (itemDraft.expirationSupported && !itemExpiryDate.trim()) {
      setItemReceiveError("Expiration date is required for this catalog product.");
      return;
    }
    if (inspectionCondition === "expired" && !itemExpiryDate.trim()) {
      setItemReceiveError("Add an expiration date when marking expired.");
      return;
    }

    const sku = String(itemDraft.epRow.sku ?? "").trim();
    const fnsku = String(itemDraft.epRow.fnsku ?? "").trim();
    const asin = String((itemDraft.epRow as { asin?: string }).asin ?? "").trim();
    const orderId = String(itemDraft.epRow.order_id ?? "").trim();
    const line = expectedPkgLines.find((l) => l.sku === sku && l.fnsku === fnsku);
    const item_name =
      (itemDraft.catalogName?.trim() || line?.productLabel?.trim() || sku || fnsku || "Item").slice(0, 500);

    const photoEvidence = mergeReturnPhotoEvidence(
      {
        item_front: itemPhotoFrontUrl ? 1 : 0,
        label_photo: itemPhotoBarcodeUrl ? 1 : 0,
        damage_detail: itemPhotoDamageUrl ? 1 : 0,
      },
      {},
    );

    const pkgId = itemScanPackageId && isUuidString(itemScanPackageId) ? itemScanPackageId : null;
    const qty = Math.max(1, Math.min(50, Math.floor(itemQtyStepper)));

    const epQty = Number(itemDraft.epRow.expected_scan_quantity ?? 0);
    const epActual = Number(itemDraft.epRow.actual_scanned_count ?? 0);
    const remainingOnRow = Math.max(0, epQty - epActual);

    const disposition = String(itemDraft.epRow.disposition ?? "").trim();

    const demoLocal = !isSupabaseConfigured() || !sessionStoreId;

    const bumpLocalRows = (resolvedEpId: string) => {
      setExpectedPkgDetailRows((rows) => {
        if (!rows) return [];
        return rows.map((r) =>
          String(r.id) === resolvedEpId
            ? { ...r, actual_scanned_count: Number(r.actual_scanned_count ?? 0) + qty }
            : r,
        );
      });
    };

    const detailRows = Array.isArray(expectedPkgDetailRows) ? expectedPkgDetailRows : [];
    const beforeRemainTotal = Math.max(
      0,
      detailRows.reduce((s, r) => s + Number(r.expected_scan_quantity ?? 0), 0) -
        detailRows.reduce((s, r) => s + Number(r.actual_scanned_count ?? 0), 0),
    );

    if (demoLocal) {
      const bumpId = expectedPackageIdHint ?? hintEpIdRaw;
      if (!isUuidString(bumpId)) {
        setItemReceiveError("Expected box id missing — cannot update counts.");
        return;
      }
      bumpLocalRows(bumpId);
      setItemReceiveDemoScannedUnits((u) => u + qty);
      resetItemInspectionForm();
      if (beforeRemainTotal > qty) setScanSuccessFlash(true);
      focusScannerAggressive();
      return;
    }

    if (!sku) {
      setItemReceiveError("SKU missing from expected row — cannot sync.");
      return;
    }

    setBusy(true);
    setItemReceiveError(null);
    try {
      const res = await operatorReceiveItem({
        organization_id: orgId,
        store_id: sessionStoreId!,
        package_id: pkgId,
        expected_package_id: expectedPackageIdHint,
        disposition: disposition || null,
        sku,
        fnsku,
        asin: asin || undefined,
        item_name,
        conditions: claims,
        notes: itemNotes.trim() || null,
        expiration_date: itemExpiryDate.trim() || undefined,
        batch_number: itemBatch.trim() || undefined,
        quantity: qty,
        photo_evidence: photoEvidence,
        order_id: orderId || null,
      });
      if (!res.ok) {
        setSyncErrorToast("Sync Error: Item not saved");
        setItemReceiveError(res.error ?? "");
        return;
      }
      const resolvedEp = res.expected_package_id ?? expectedPackageIdHint ?? hintEpIdRaw;
      if (isUuidString(resolvedEp)) {
        bumpLocalRows(resolvedEp);
      }
      const primaryLinkage = res.product_linkages?.[0]?.product_linkage;
      if (primaryLinkage) {
        applyEpReceiveLinkageToExpectedRows(sku, fnsku, primaryLinkage, resolvedEp);
      }
      setItemReceiveCountSyncNonce((n) => n + 1);
      resetItemInspectionForm();
      if (remainingOnRow > qty || beforeRemainTotal > qty) setScanSuccessFlash(true);
      focusScannerAggressive();
    } finally {
      setBusy(false);
    }
  }, [
    itemDraft,
    inspectionCondition,
    itemExpiryDate,
    itemPhotoFrontUrl,
    itemPhotoBarcodeUrl,
    itemPhotoDamageUrl,
    itemScanPackageId,
    itemQtyStepper,
    itemNotes,
    itemBatch,
    sessionStoreId,
    orgId,
    expectedPkgDetailRows,
    expectedPkgLines,
    applyEpReceiveLinkageToExpectedRows,
    resetItemInspectionForm,
    focusScannerAggressive,
  ]);

  const resetIdentifyGateForm = useCallback(() => {
    clearPreviousLookupResult();
    setScanLine("");
  }, [clearPreviousLookupResult]);

  const hydrateSavedPackageRowIntoBoxIntake = useCallback(
    (row: Record<string, unknown>, opts: { directBox: boolean }) => {
      const pkgNum = String(row.package_code ?? row.slip_id ?? row.package_number ?? "").trim();
      const pkgId = String(row.id ?? "").trim();
      if (pkgNum) setCurrentPackageTrackingId(pkgNum);
      if (pkgId && isUuidString(pkgId) && pkgNum) {
        setActiveBoxSession({ barcode: pkgNum, packageId: pkgId });
        setEditAllMode(false);
        setPackageCodeCardOpen(false);
      } else {
        setActiveBoxSession(null);
        setPackageCodeCardOpen(true);
      }
      const resumeBoxNotes = String(row.notes ?? "").trim();
      setBoxNotes(resumeBoxNotes);
      boxNotesBaselineRef.current = resumeBoxNotes;
      const pkgCarrier = String(row.carrier_name ?? "").trim();
      if (pkgCarrier && opts.directBox) {
        const normalized = normalizeCarrierLabel(pkgCarrier);
        const applied = normalized && normalized !== OTHER_CARRIER_NAME ? normalized : pkgCarrier;
        if (normalized && normalized !== OTHER_CARRIER_NAME) {
          setPalletCarrier(normalized);
          setPalletCarrierOtherSelected(false);
        } else {
          setPalletCarrier(pkgCarrier);
          setPalletCarrierOtherSelected(true);
        }
        persistOperatorSessionCarrier(applied);
      }
      const o = normalizePalletDocumentationImageUrls(
        parsePalletPhotoUrlArray(row.outside_photo_urls),
        supabase,
      );
      const ins = normalizePalletDocumentationImageUrls(
        parsePalletPhotoUrlArray(row.inside_photo_urls),
        supabase,
      );
      const s = normalizePalletDocumentationImageUrls(
        parsePalletPhotoUrlArray(row.slip_photo_urls),
        supabase,
      );
      setOutsideBoxPhotoUrls(o);
      setInsideBoxPhotoUrls(ins);
      setSlipBoxPhotoUrls(s);
      slipBoxPhotoUrlsRef.current = [...s];
      outsideBoxPhotoUrlsRef.current = [...o];
      insideBoxPhotoUrlsRef.current = [...ins];
      evidenceBaselineRef.current.slip = [...s];
      evidenceBaselineRef.current.outside = [...o];
      evidenceBaselineRef.current.inside = [...ins];
      pendingEvidenceStorageDeletesRef.current.clear();
      const sidRow = String(row.id_slip_contents ?? row.slip_code ?? row.slip_id ?? "").trim();
      if (sidRow) {
        setBoxSlipCode(sidRow);
        boxSlipCodeRef.current = sidRow;
      }
      const rmaRow = String(row.rma_number ?? "").trim();
      if (rmaRow) {
        setBoxSlipRma(rmaRow);
        boxSlipRmaRef.current = rmaRow;
      }
      const orderRow = String((row as { order_id?: unknown }).order_id ?? "").trim();
      if (orderRow && opts.directBox) setPalletOrderId(orderRow);
      if (opts.directBox) {
        const fromDirectBoxDocs = parseDirectBoxShipmentDocumentation(row.manifest_data);
        const directShipUrls = normalizePalletDocumentationImageUrls(
          fromDirectBoxDocs.shippingLabelUrls,
          supabase,
        );
        const directBolUrls = normalizePalletDocumentationImageUrls(fromDirectBoxDocs.bolUrls, supabase);
        if (directShipUrls.length > 0) {
          setShippingLabelPhotoUrls(directShipUrls);
          shippingLabelPhotoUrlsRef.current = [...directShipUrls];
          evidenceBaselineRef.current.shipping = [...directShipUrls];
        }
        if (directBolUrls.length > 0) {
          setBolPhotoUrls(directBolUrls);
          bolPhotoUrlsRef.current = [...directBolUrls];
          evidenceBaselineRef.current.bol = [...directBolUrls];
        }
        if (!palletCarrierRef.current.trim() && fromDirectBoxDocs.carrierName) {
          const normalized = normalizeCarrierLabel(fromDirectBoxDocs.carrierName);
          const applied =
            normalized && normalized !== OTHER_CARRIER_NAME ? normalized : fromDirectBoxDocs.carrierName;
          if (normalized && normalized !== OTHER_CARRIER_NAME) {
            setPalletCarrier(normalized);
            setPalletCarrierOtherSelected(false);
          } else {
            setPalletCarrier(fromDirectBoxDocs.carrierName);
            setPalletCarrierOtherSelected(true);
          }
          persistOperatorSessionCarrier(applied);
        }
        if (!palletOrderIdRef.current.trim() && fromDirectBoxDocs.orderId) {
          setPalletOrderId(fromDirectBoxDocs.orderId);
        }
      }
      if (pkgId && isUuidString(pkgId)) {
        boxIntakeBaselineReadyRef.current = false;
        hydrateBoxPackageIdRef.current = pkgId;
        void hydrateBoxSlipVisionFromSavedPackage(pkgId, row);
      } else {
        finalizeBoxIntakeBaselineFromCurrentState();
      }
    },
    [
      persistOperatorSessionCarrier,
      hydrateBoxSlipVisionFromSavedPackage,
      finalizeBoxIntakeBaselineFromCurrentState,
    ],
  );

  const resumeWorkflowFromExistingPalletRow = useCallback(
    async (
      row: OperatorPalletTrackingRow,
      enteredCode: string,
      opts?: { packageRow?: Record<string, unknown> },
    ) => {
      const tracking = String(row.tracking_number ?? "").trim() || enteredCode.trim();
      const opCount = row.operator_package_count;
      const hydratedPhotos = hydrateOperatorPalletDocumentationPhotoUrls(
        {
          shipping_label_urls: row.shipping_label_urls,
          pallet_photo_urls: row.pallet_photo_urls,
          bol_photo_urls: row.bol_photo_urls,
        },
        supabase,
      );
      resetIdentifyGateForm();
      setModernPalletWorkspace(false);
      setActiveSlipOrPackage(null);
      setDirectBox(false);
      setActiveTracking(null);
      setActivePallet({
        id: row.id,
        pallet_number: row.pallet_number,
        carrier_name: String(row.carrier_name ?? "").trim() || undefined,
        order_id: String(row.order_id ?? "").trim() || null,
      });
      setCurrentPalletTrackingId(tracking);
      if (typeof opCount === "number" && Number.isFinite(opCount) && opCount > 0) {
        setPhysicalBoxCount(opCount);
        setBoxScanTargetDenominator(opCount);
      } else {
        setPhysicalBoxCount(null);
        setBoxScanTargetDenominator(null);
      }
      const resumeCarrier = String(row.carrier_name ?? "").trim();
      if (resumeCarrier) {
        const normalized = normalizeCarrierLabel(resumeCarrier);
        const applied = normalized && normalized !== OTHER_CARRIER_NAME ? normalized : resumeCarrier;
        if (normalized && normalized !== OTHER_CARRIER_NAME) {
          setPalletCarrier(normalized);
          setPalletCarrierOtherSelected(false);
        } else {
          setPalletCarrier(resumeCarrier);
          setPalletCarrierOtherSelected(true);
        }
        parentPalletCarrierDefaultRef.current = applied;
        persistOperatorSessionCarrier(applied);
      }
      const resumeOrder = String(row.order_id ?? "").trim();
      if (resumeOrder) {
        setPalletOrderId(resumeOrder);
        setPalletResolvedOrderId(resumeOrder);
        setPalletDbOrderId(resumeOrder);
      }
      const resumeCid = String(row.created_by ?? "").trim();
      if (resumeCid && isUuidString(resumeCid) && isSupabaseConfigured()) {
        try {
          const { data: auth } = await supabase.auth.getUser();
          const me = auth?.user?.id?.trim();
          const { data: prof } = await supabase.from("profiles").select("full_name").eq("id", resumeCid).maybeSingle();
          const fn = (prof as { full_name?: string | null } | null)?.full_name?.trim();
          const emailFallback =
            me === resumeCid ? (typeof auth?.user?.email === "string" ? auth.user.email.trim() : "") : "";
          setPalletCreatedByLabel(fn || emailFallback || "Unknown");
          setPalletCreatedByProfileId(resumeCid);
        } catch {
          setPalletCreatedByLabel("Unknown");
          setPalletCreatedByProfileId(resumeCid);
        }
      } else {
        setPalletCreatedByLabel(null);
        setPalletCreatedByProfileId(null);
      }
      const hasShip = palletHasPersistedShipmentDetails(row);
      let nextPhase: typeof flowPhase = hasShip ? "package_scan" : "scan";
      let resumedItemScan = false;
      if (opts?.packageRow) {
        hydrateSavedPackageRowIntoBoxIntake(opts.packageRow, { directBox: false });
        resumedItemScan = Boolean(
          await maybeResumeItemScanAfterPackageRowRef.current?.(opts.packageRow, { directBox: false }),
        );
        if (!resumedItemScan) nextPhase = "package_scan";
      } else {
        const oidResume = orgId.trim();
        if (oidResume && isUuidString(row.id) && isSupabaseConfigured()) {
          const pkgRes = await listOperatorPackagesForPalletAction(
            oidResume,
            row.id,
            sessionStoreId ?? null,
          );
          if (pkgRes.ok && pkgRes.packages.length > 0) {
            const pkg0 = pkgRes.packages[0] as unknown as Record<string, unknown>;
            hydrateSavedPackageRowIntoBoxIntake(pkg0, { directBox: false });
            resumedItemScan = Boolean(
              await maybeResumeItemScanAfterPackageRowRef.current?.(pkg0, { directBox: false }),
            );
            if (!resumedItemScan && hasShip) nextPhase = "package_scan";
          }
        }
      }
      if (!resumedItemScan) setFlowPhase(nextPhase);
      if (hasShip && orgId.trim()) {
        try {
          window.sessionStorage.setItem(
            `operatorMobile:palletShipmentCommitted:${orgId}:${row.id}`,
            "1",
          );
        } catch {
          /* ignore */
        }
        setPalletShipmentCommitVersion((v) => v + 1);
      }
      setIsIdentified(true);
      setShippingLabelPhotoUrls(hydratedPhotos.shippingLabel);
      setPalletPhotoUrls(hydratedPhotos.pallet);
      setBolPhotoUrls(hydratedPhotos.bol);
      shippingLabelPhotoUrlsRef.current = [...hydratedPhotos.shippingLabel];
      palletPhotoUrlsRef.current = [...hydratedPhotos.pallet];
      bolPhotoUrlsRef.current = [...hydratedPhotos.bol];
      evidenceBaselineRef.current.shipping = [...hydratedPhotos.shippingLabel];
      evidenceBaselineRef.current.pallet = [...hydratedPhotos.pallet];
      evidenceBaselineRef.current.bol = [...hydratedPhotos.bol];
      setPalletDocHydrationNonce((n) => n + 1);
    },
    [
      orgId,
      sessionStoreId,
      resetIdentifyGateForm,
      hydrateSavedPackageRowIntoBoxIntake,
      persistOperatorSessionCarrier,
    ],
  );

  const resumeWorkflowFromExistingDirectBoxPackage = useCallback(
    async (row: Record<string, unknown>, enteredCode: string): Promise<void> => {
      resetIdentifyGateForm();
      setModernPalletWorkspace(false);
      setDirectBox(true);
      setActivePallet(null);
      setActiveSlipOrPackage(null);
      const tracking =
        String(row.tracking_number ?? row.shipment_tracking_number ?? "").trim() || enteredCode.trim();
      setActiveTracking(tracking);
      setCurrentPalletTrackingId(tracking);
      setPhysicalBoxCount(1);
      setBoxScanTargetDenominator(1);

      const pkgNum = String(row.package_code ?? row.slip_id ?? row.package_number ?? "").trim();
      const pkgId = String(row.id ?? "").trim();
      if (pkgId && isUuidString(pkgId) && pkgNum) {
        setActiveBoxSession({ barcode: pkgNum, packageId: pkgId });
        setEditAllMode(false);
        setPackageCodeCardOpen(false);
        setCurrentPackageTrackingId(pkgNum);
        // Pin the hydrate guard to this package so the box-hydrate effect's async fetch
        // re-affirms (never clears) these arrays for the resumed package.
        hydrateBoxPackageIdRef.current = pkgId;
      }

      // Hydrate photo states DIRECTLY from the resumed package row (box columns) + manifest
      // (direct-box shipment docs). Resolve to viewable URLs so saved storage paths render.
      const slip = normalizePalletDocumentationImageUrls(
        parsePalletPhotoUrlArray(row.slip_photo_urls),
        supabase,
      );
      const outside = normalizePalletDocumentationImageUrls(
        parsePalletPhotoUrlArray(row.outside_photo_urls),
        supabase,
      );
      const inside = normalizePalletDocumentationImageUrls(
        parsePalletPhotoUrlArray(row.inside_photo_urls),
        supabase,
      );
      setSlipBoxPhotoUrls(slip);
      setOutsideBoxPhotoUrls(outside);
      setInsideBoxPhotoUrls(inside);
      slipBoxPhotoUrlsRef.current = [...slip];
      outsideBoxPhotoUrlsRef.current = [...outside];
      insideBoxPhotoUrlsRef.current = [...inside];
      evidenceBaselineRef.current.slip = [...slip];
      evidenceBaselineRef.current.outside = [...outside];
      evidenceBaselineRef.current.inside = [...inside];

      const docs = parseDirectBoxShipmentDocumentation(row.manifest_data);
      const shipUrls = normalizePalletDocumentationImageUrls(docs.shippingLabelUrls, supabase);
      const bolUrls = normalizePalletDocumentationImageUrls(docs.bolUrls, supabase);

      setShippingLabelPhotoUrls(shipUrls);
      setBolPhotoUrls(bolUrls);
      shippingLabelPhotoUrlsRef.current = [...shipUrls];
      bolPhotoUrlsRef.current = [...bolUrls];
      evidenceBaselineRef.current.shipping = [...shipUrls];
      evidenceBaselineRef.current.bol = [...bolUrls];
      pendingEvidenceStorageDeletesRef.current.clear();

      const directBoxNotes = String(row.notes ?? "").trim();
      setBoxNotes(directBoxNotes);
      boxNotesBaselineRef.current = directBoxNotes;
      const carrierRaw = String((row as { carrier_name?: unknown }).carrier_name ?? docs.carrierName ?? "").trim();
      if (carrierRaw) {
        const normalized = normalizeCarrierLabel(carrierRaw);
        const applied = normalized && normalized !== OTHER_CARRIER_NAME ? normalized : carrierRaw;
        if (normalized && normalized !== OTHER_CARRIER_NAME) {
          setPalletCarrier(normalized);
          setPalletCarrierOtherSelected(false);
        } else {
          setPalletCarrier(carrierRaw);
          setPalletCarrierOtherSelected(true);
        }
        persistOperatorSessionCarrier(applied);
      }
      const orderRow = String((row as { order_id?: unknown }).order_id ?? docs.orderId ?? "").trim();
      if (orderRow) setPalletOrderId(orderRow);

      if (pkgId && isUuidString(pkgId)) {
        boxIntakeBaselineReadyRef.current = false;
        await hydrateBoxSlipVisionFromSavedPackage(pkgId, row);
      } else {
        finalizeBoxIntakeBaselineFromCurrentState();
      }

      const resumedItemScan = Boolean(
        await maybeResumeItemScanAfterPackageRowRef.current?.(row, { directBox: true }),
      );
      if (!resumedItemScan) setFlowPhase("package_scan");
      setIsIdentified(true);
      setPalletDocHydrationNonce((n) => n + 1);
    },
    [
      resetIdentifyGateForm,
      persistOperatorSessionCarrier,
      hydrateBoxSlipVisionFromSavedPackage,
      finalizeBoxIntakeBaselineFromCurrentState,
    ],
  );

  const tryDirectPackageDbFallbackResume = useCallback(
    async (
      searchedCode: string,
      extraCandidates: string[] = [],
    ): Promise<"resumed" | "wrong_store" | "error" | false> => {
      if (!isSupabaseConfigured() || !sessionStoreId) return false;
      const primary = searchedCode.trim();
      if (!primary) return false;

      const candidates = [...new Set([primary, ...extraCandidates.map((s) => String(s ?? "").trim()).filter(Boolean)])];

      for (const candidate of candidates) {
        const lookup = await findOperatorSavedPackageByCodeOrTrackingAction(
          orgId,
          candidate,
          sessionStoreId,
        );
        if (!lookup.ok) {
          setIdentifyGateError(lookup.error);
          return "error";
        }
        if (lookup.wrongStore) {
          setIdentifyGateError(
            lookup.wrongStoreMessage ?? formatUnauthorizedTrackingInStoreMessage(""),
          );
          return "wrong_store";
        }

        const pkg = lookup.package;
        if (!pkg?.id || !isUuidString(pkg.id)) continue;

        const row = pkg as unknown as Record<string, unknown>;
        const palletId = String(pkg.pallet_id ?? "").trim();
        if (palletId && isUuidString(palletId)) {
          const byId = await findOperatorPalletByIdAction(orgId, palletId, sessionStoreId);
          if (!byId.ok) {
            setIdentifyGateError(byId.error);
            return "error";
          }
          if (byId.wrongStore) {
            setIdentifyGateError(
              byId.wrongStoreMessage ?? formatUnauthorizedTrackingInStoreMessage(""),
            );
            return "wrong_store";
          }
          if (byId.pallet) {
            setIdentifyGatePhase("idle");
            setIdentifyGateSlowHint("Loading saved shipment…");
            setIntakeToast("Saved package found — loading pallet shipment...");
            await resumeWorkflowFromExistingPalletRow(byId.pallet, primary, { packageRow: row });
            setIdentifyGateSlowHint(null);
            return "resumed";
          }
        }

        setIdentifyGatePhase("idle");
        setIdentifyGateSlowHint("Loading saved box…");
        setIntakeToast("Saved direct box found — loading details...");
        await resumeWorkflowFromExistingDirectBoxPackage(row, primary);
        setIdentifyGateSlowHint(null);
        return "resumed";
      }

      return false;
    },
    [
      orgId,
      sessionStoreId,
      resumeWorkflowFromExistingPalletRow,
      resumeWorkflowFromExistingDirectBoxPackage,
    ],
  );

  const tryResumeSavedReceivingContext = useCallback(
    async (
      enteredCode: string,
      gateLookup: ShipmentEntryLookupResult | null,
    ): Promise<"resumed" | "wrong_store" | "error" | false> => {
      if (!isSupabaseConfigured() || !sessionStoreId) return false;
      const trimmed = enteredCode.trim();
      if (!trimmed) return false;

      const trackingCandidates = [
        trimmed,
        gateLookup?.canonical_tracking,
        gateLookup?.tracking_number,
      ]
        .map((s) => String(s ?? "").trim())
        .filter(Boolean);
      const uniqueTracking = [...new Set(trackingCandidates)];

      const dbFallbackFirst = await tryDirectPackageDbFallbackResume(trimmed, uniqueTracking);
      if (dbFallbackFirst !== false) return dbFallbackFirst;

      for (const tn of uniqueTracking) {
        const dupRes = await findOperatorPalletByTrackingNumberAction(orgId, tn, sessionStoreId);
        if (!dupRes.ok) {
          setIdentifyGateError(dupRes.error);
          return "error";
        }
        if (dupRes.wrongStore) {
          setIdentifyGateError(
            dupRes.wrongStoreMessage ?? formatUnauthorizedTrackingInStoreMessage(""),
          );
          return "wrong_store";
        }
        if (dupRes.pallet) {
          setIdentifyGatePhase("idle");
          setIdentifyGateSlowHint("Loading saved shipment…");
          setIntakeToast("Pallet found — loading details...");
          await resumeWorkflowFromExistingPalletRow(dupRes.pallet, trimmed);
          setIdentifyGateSlowHint(null);
          return "resumed";
        }
      }

      const palletIdFromGate = String(gateLookup?.pallet_id ?? "").trim();
      if (isUuidString(palletIdFromGate)) {
        const byId = await findOperatorPalletByIdAction(orgId, palletIdFromGate, sessionStoreId);
        if (!byId.ok) {
          setIdentifyGateError(byId.error);
          return "error";
        }
        if (byId.wrongStore) {
          setIdentifyGateError(
            byId.wrongStoreMessage ?? formatUnauthorizedTrackingInStoreMessage(""),
          );
          return "wrong_store";
        }
        if (byId.pallet) {
          setIdentifyGatePhase("idle");
          setIdentifyGateSlowHint("Loading saved shipment…");
          setIntakeToast("Pallet found — loading details...");
          await resumeWorkflowFromExistingPalletRow(byId.pallet, trimmed);
          setIdentifyGateSlowHint(null);
          return "resumed";
        }
      }

      const barcode = gateLookup?.barcode;
      let pkgResolve: OperatorResolveResult | null = null;
      if (barcode?.kind === "package" || barcode?.kind === "slip") {
        pkgResolve = barcode;
      } else {
        // Fallback: resolve any already-saved `packages` row for this code / tracking.
        // Covers a previously-received direct (single) box reopened by its tracking number,
        // which the gate classifies as `single_box` (not `found_package`) — without this the
        // matched-start handler would create a fresh empty box session and drop saved photos.
        // `resolveOperatorBarcode` matches received package rows only, so genuinely-new
        // expected shipments return `unknown` and fall through to the normal gate.
        for (const candidate of [...new Set([trimmed, ...uniqueTracking])]) {
          const resolved = await resolveOperatorBarcode(supabase, orgId, candidate, {
            only: "package",
            storeId: sessionStoreId,
          });
          if (resolved.kind === "package" || resolved.kind === "slip") {
            pkgResolve = resolved;
            break;
          }
        }
      }

      if (pkgResolve?.kind === "package" || pkgResolve?.kind === "slip") {
        let pkgRow = pkgResolve.row;
        const pkgId = String(pkgRow.id ?? "").trim();
        if (pkgId && isUuidString(pkgId)) {
          const { data: fullPkg } = await supabase
            .from("packages")
            .select(
              "id, package_code, pallet_id, tracking_number, manifest_data, carrier_name, outside_photo_urls, inside_photo_urls, slip_photo_urls, rma_number, notes, order_id, id_slip_contents",
            )
            .eq("id", pkgId)
            .maybeSingle();
          if (fullPkg && typeof fullPkg === "object") {
            pkgRow = fullPkg as Record<string, unknown>;
          }
        }
        const palletId = String(pkgRow.pallet_id ?? "").trim();
        if (palletId && isUuidString(palletId)) {
          const byId = await findOperatorPalletByIdAction(orgId, palletId, sessionStoreId);
          if (!byId.ok) {
            setIdentifyGateError(byId.error);
            return "error";
          }
          if (byId.wrongStore) {
            setIdentifyGateError(
              byId.wrongStoreMessage ?? formatUnauthorizedTrackingInStoreMessage(""),
            );
            return "wrong_store";
          }
          if (byId.pallet) {
            setIdentifyGatePhase("idle");
            setIdentifyGateSlowHint("Loading saved shipment…");
            setIntakeToast("Pallet shipment found — loading details...");
            await resumeWorkflowFromExistingPalletRow(byId.pallet, trimmed, { packageRow: pkgRow });
            setIdentifyGateSlowHint(null);
            return "resumed";
          }
        } else {
          setIdentifyGatePhase("idle");
          setIdentifyGateSlowHint("Loading saved box…");
          setIntakeToast("Direct box found — loading details...");
          await resumeWorkflowFromExistingDirectBoxPackage(pkgRow, trimmed);
          setIdentifyGateSlowHint(null);
          return "resumed";
        }
      }

      return false;
    },
    [
      orgId,
      sessionStoreId,
      resumeWorkflowFromExistingPalletRow,
      resumeWorkflowFromExistingDirectBoxPackage,
      tryDirectPackageDbFallbackResume,
    ],
  );

  resumeFromPalletLookupRef.current = resumeWorkflowFromExistingPalletRow;
  tryResumeSavedReceivingRef.current = tryResumeSavedReceivingContext;

  const initializeUnlistedTrackingBaselineReturnItem = useCallback(
    async (code: string): Promise<boolean> => {
      if (!isSupabaseConfigured()) return true;
      const scannedCode = code.trim();
      if (!scannedCode) return false;
      if (!sessionStoreId) {
        setSyncErrorToast("Select a store before creating records.");
        return false;
      }

      const res = await insertOperatorPackageItemAction({
        requestedOrganizationId: orgId,
        storeId: sessionStoreId,
        slipContentId: null,
        scannedBarcode: scannedCode,
        matchKind: "unexpected",
        quantity: 1,
        discrepancyTags: ["sellable_ok"],
        looseItem: true,
        operatorNotes: `Shipment Entry baseline initialized for unlisted tracking ${scannedCode}.`,
      });
      if (!res.ok) {
        setSyncErrorToast(res.message?.trim() || "Could not initialize baseline return item.");
        return false;
      }
      return true;
    },
    [orgId, sessionStoreId],
  );

  const exitManualEntryMode = useCallback(() => {
    manualEntryModeRef.current = false;
    setManualEntryMode(false);
    setManualOpen(false);
    const active = typeof document !== "undefined" ? (document.activeElement as HTMLElement | null) : null;
    active?.blur();
    window.setTimeout(() => focusScannerAggressive(), 0);
  }, [focusScannerAggressive]);

  const startManualEntryMode = useCallback((inputRef: RefObject<HTMLInputElement | null>) => {
    manualEntryModeRef.current = true;
    setManualEntryMode(true);
    setManualOpen(true);
    if (!isIdentified && flowPhase === "scan") {
      clearPreviousLookupResult({ clearResolvedContext: true });
    } else {
      setIdentifyGatePhotoOcrToast(null);
      setIdentifyGatePhotoOcrCandidates([]);
      setIdentifyGateSelectedPhotoOcrCandidate(null);
    }
    setScanLine("");
    scannerRef.current?.blur();
    const focusManualInput = () => {
      if (!manualEntryModeRef.current) return;
      const el = inputRef.current;
      if (!el) return;
      try {
        el.focus({ preventScroll: true });
        el.select();
      } catch {
        el.focus();
      }
    };
    window.requestAnimationFrame(focusManualInput);
    window.setTimeout(focusManualInput, 0);
  }, [clearPreviousLookupResult, flowPhase, isIdentified]);

  const handleManualScanLineChange = useCallback(
    (nextValue: string) => {
      if (!isIdentified && flowPhase === "scan") {
        clearPreviousLookupResult({ clearResolvedContext: true });
      } else {
        setIdentifyGatePhotoOcrToast(null);
        setIdentifyGatePhotoOcrCandidates([]);
        setIdentifyGateSelectedPhotoOcrCandidate(null);
      }
      setScanLine(nextValue);
    },
    [clearPreviousLookupResult, flowPhase, isIdentified],
  );

  const openMoveBoxModal = useCallback(() => {
    setMoveBoxModalError(null);
    setMoveBoxTargetDraft("");
    setMoveBoxModalOpen(true);
    window.queueMicrotask(() => scheduleFocusScanner());
  }, [scheduleFocusScanner]);

  const closeMoveBoxModal = useCallback(() => {
    setMoveBoxModalOpen(false);
    setMoveBoxModalError(null);
    setMoveBoxTargetDraft("");
    scheduleFocusScanner();
  }, [scheduleFocusScanner]);

  const submitScannedCode = useCallback(
    async (raw: string, options?: { clearPackageBuffer?: boolean }) => {
      const code = raw.trim();
      if (!code) return;
      if (moveBoxModalOpen) {
        setMoveBoxTargetDraft(code);
        scheduleFocusScanner();
        return;
      }
      setLastScannedCode(code);
      if (!isIdentified && flowPhase === "scan" && awaitingPostCompleteExtraScan) {
        const tn = postCompleteTrackingRef.current?.trim();
        setAwaitingPostCompleteExtraScan(false);
        postCompleteTrackingRef.current = null;
        if (tn) setActiveTracking(tn);
        setIsIdentified(true);
        resetIdentifyGateForm();
        await runResolve(code);
        return;
      }
      if (!isIdentified && flowPhase === "scan") {
        clearPreviousLookupResult({ phase: "searching", enteredCode: code, clearResolvedContext: true });
      } else {
        setIdentifyGatePhotoOcrToast(null);
        setIdentifyGatePhotoOcrCandidates([]);
        setIdentifyGateSelectedPhotoOcrCandidate(null);
      }
      if (flowPhase === "package_scan") {
        setScanProgressPhase("checking");
        try {
          const ok = await handleBoxIntakeScan(code);
          setScanProgressPhase(ok ? "ready" : "error");
          if (ok && options?.clearPackageBuffer) {
            setCurrentPackageTrackingId(null);
          }
        } catch (e) {
          setBoxIntakeError(e instanceof Error ? e.message : "Box scan failed.");
          setScanProgressPhase("error");
        }
        return;
      }
      if (flowPhase === "items") {
        setScanProgressPhase("checking");
        await handleItemBarcodeScan(code);
        return;
      }
      if (!isIdentified && flowPhase === "scan") {
        await runIdentificationGateSearch(code);
        return;
      }
      await runResolve(code);
    },
    [
      flowPhase,
      isIdentified,
      awaitingPostCompleteExtraScan,
      handleBoxIntakeScan,
      handleItemBarcodeScan,
      runIdentificationGateSearch,
      runResolve,
      resetIdentifyGateForm,
      clearPreviousLookupResult,
    ],
  );

  const onSubmitScan = useCallback(
    async (e?: FormEvent) => {
      e?.preventDefault();
      const packageScanBoxBufferOpen = packageScanUsesHiddenCartonBuffer;
      const code = packageScanBoxBufferOpen ? (currentPackageTrackingId ?? "").trim() : scanLine.trim();
      if (packageScanBoxBufferOpen) {
        // Keep the value visible until the box handler accepts it and clears via submitScannedCode.
      } else {
        setScanLine("");
      }
      if (manualEntryMode) exitManualEntryMode();
      await submitScannedCode(code, { clearPackageBuffer: packageScanBoxBufferOpen });
      scheduleFocusScanner();
    },
    [
      scanLine,
      currentPackageTrackingId,
      packageScanUsesHiddenCartonBuffer,
      manualEntryMode,
      exitManualEntryMode,
      submitScannedCode,
      scheduleFocusScanner,
    ],
  );

  const submitScanCaptureInput = useCallback(
    async (raw: string) => {
      const code = raw.trim();
      setScanCaptureLine("");
      if (!code) {
        scheduleFocusScanner();
        return;
      }
      await submitScannedCode(code);
      scheduleFocusScanner();
    },
    [scheduleFocusScanner, submitScannedCode],
  );

  const resetIdentifyGatePhotoFileInputs = useCallback(() => {
    if (identifyGateCameraCaptureRef.current) identifyGateCameraCaptureRef.current.value = "";
    if (identifyGateCameraUploadRef.current) identifyGateCameraUploadRef.current.value = "";
  }, []);

  const focusHiddenScannerAfterPhotoScan = useCallback(() => {
    window.setTimeout(() => {
      if (manualEntryModeRef.current) return;
      const el = scannerRef.current;
      if (!el) return;
      try {
        el.focus({ preventScroll: true });
      } catch {
        el.focus();
      }
    }, 0);
  }, []);

  const clearIdentifyGatePhotoOcrCandidates = useCallback(() => {
    setIdentifyGatePhotoOcrToast(null);
    setIdentifyGatePhotoOcrCandidates([]);
    setIdentifyGateSelectedPhotoOcrCandidate(null);
    focusHiddenScannerAfterPhotoScan();
  }, [focusHiddenScannerAfterPhotoScan]);

  const applyIdentifyGatePhotoOcrCandidate = useCallback(async () => {
    const candidate = (identifyGateSelectedPhotoOcrCandidate ?? identifyGatePhotoOcrCandidates[0] ?? "").trim();
    if (!candidate) return;
    setIdentifyGatePhotoOcrCandidates([]);
    setIdentifyGateSelectedPhotoOcrCandidate(null);
    await submitScannedCode(candidate);
    scheduleFocusScanner();
  }, [
    identifyGatePhotoOcrCandidates,
    identifyGateSelectedPhotoOcrCandidate,
    scheduleFocusScanner,
    submitScannedCode,
  ]);

  const retryIdentifyGatePhotoOcr = useCallback(() => {
    clearPreviousLookupResult({ clearResolvedContext: true });
    setIdentifyGateOcrMenuOpen(true);
    focusHiddenScannerAfterPhotoScan();
  }, [clearPreviousLookupResult, focusHiddenScannerAfterPhotoScan]);

  const startManualEntryFromPhotoOcrCandidate = useCallback(() => {
    clearPreviousLookupResult({ clearResolvedContext: true });
    startManualEntryMode(gateManualInputRef);
  }, [clearPreviousLookupResult, startManualEntryMode]);

  const decodeAndSubmitIdentifyGatePhotoBarcode = useCallback(
    async (file: File) => {
      if (identifyGateOcrBusyRef.current) return;
      clearPreviousLookupResult({ clearResolvedContext: true });
      if (!isAllowedIdentifyGateImageFile(file)) {
        setIdentifyGatePhotoOcrToast("Please use a JPG or PNG image.");
        resetIdentifyGatePhotoFileInputs();
        focusHiddenScannerAfterPhotoScan();
        return;
      }

      identifyGateOcrBusyRef.current = true;
      manualEntryModeRef.current = false;
      setManualEntryMode(false);
      setManualOpen(false);
      setIdentifyGateOcrReading(true);
      setIdentifyGateOcrProgressPct(0);

      try {
        const result = await detectBarcodeFromImageFile(file);
        setIdentifyGateOcrProgressPct(100);

        if (result.status === "detected") {
          await submitScannedCode(result.value);
          return;
        }

        if (result.status === "ocr_candidates") {
          setIdentifyGatePhotoOcrToast(null);
          setIdentifyGatePhotoOcrCandidates(result.candidates);
          setIdentifyGateSelectedPhotoOcrCandidate(result.candidates[0] ?? null);
          return;
        }

        setIdentifyGatePhotoOcrToast(
          "No package, tracking, or shipment code found. Capture the label/code area or use Manual Entry.",
        );
      } finally {
        identifyGateOcrBusyRef.current = false;
        setIdentifyGateOcrReading(false);
        setIdentifyGateOcrProgressPct(0);
        resetIdentifyGatePhotoFileInputs();
        focusHiddenScannerAfterPhotoScan();
      }
    },
    [clearPreviousLookupResult, focusHiddenScannerAfterPhotoScan, resetIdentifyGatePhotoFileInputs, submitScannedCode],
  );

  const onIdentifyGateOcrFileInputChange = useCallback(
    async (e: ChangeEvent<HTMLInputElement>) => {
      const input = e.currentTarget;
      const file = input.files?.[0];
      input.value = "";
      if (file) await decodeAndSubmitIdentifyGatePhotoBarcode(file);
    },
    [decodeAndSubmitIdentifyGatePhotoBarcode],
  );

  const onIdentifyGateScanZoneDragOver = useCallback((e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = "copy";
    setIdentifyGateOcrDropHighlight(true);
  }, []);

  const onIdentifyGateScanZoneDragLeave = useCallback((e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    const rel = e.relatedTarget as Node | null;
    if (rel && e.currentTarget.contains(rel)) return;
    setIdentifyGateOcrDropHighlight(false);
  }, []);

  const onIdentifyGateScanZoneDrop = useCallback(
    async (e: DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.stopPropagation();
      setIdentifyGateOcrDropHighlight(false);
      const file = e.dataTransfer.files?.[0];
      if (file) await decodeAndSubmitIdentifyGatePhotoBarcode(file);
    },
    [decodeAndSubmitIdentifyGatePhotoBarcode],
  );

  useEffect(() => {
    const clearBufferedScan = () => {
      scanBufferRef.current = "";
      if (scanBufferClearTimerRef.current !== null) {
        window.clearTimeout(scanBufferClearTimerRef.current);
        scanBufferClearTimerRef.current = null;
      }
    };

    const onDocumentKeyDown = (e: KeyboardEvent) => {
      if (manualOpen || manualEntryMode || manualEntryModeRef.current || modalOpenRef.current || !laserEnabled) return;
      if (busy && flowPhase !== "items") return;
      if (e.altKey || e.ctrlKey || e.metaKey) return;

      const active = typeof document !== "undefined" ? (document.activeElement as HTMLElement | null) : null;
      if (active && active !== document.body) {
        const tag = active.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || active.isContentEditable) return;
      }

      if (e.key === "Enter") {
        const buffered = scanBufferRef.current.trim();
        clearBufferedScan();
        if (buffered) {
          e.preventDefault();
          void submitScannedCode(buffered, { clearPackageBuffer: packageScanUsesHiddenCartonBuffer });
        }
        return;
      }

      if (
        e.key === "Shift" ||
        e.key === "Alt" ||
        e.key === "Control" ||
        e.key === "Meta" ||
        e.key === "Tab" ||
        e.key === "Escape" ||
        e.key.length !== 1
      ) {
        return;
      }

      scanBufferRef.current += e.key;
      if (scanBufferClearTimerRef.current !== null) window.clearTimeout(scanBufferClearTimerRef.current);
      scanBufferClearTimerRef.current = window.setTimeout(clearBufferedScan, 650);
    };

    document.addEventListener("keydown", onDocumentKeyDown);
    return () => {
      document.removeEventListener("keydown", onDocumentKeyDown);
      clearBufferedScan();
    };
  }, [manualOpen, manualEntryMode, laserEnabled, busy, flowPhase, packageScanUsesHiddenCartonBuffer, submitScannedCode]);

  const closeUnknown = useCallback(() => {
    setUnknownModal(null);
    modalOpenRef.current = false;
    scheduleFocusScanner();
  }, [scheduleFocusScanner]);

  const forceResolve = useCallback(
    async (only: OperatorResolveKind) => {
      if (!unknownModal) return;
      const code = unknownModal.code;
      closeUnknown();
      await runResolve(code, only);
    },
    [unknownModal, closeUnknown, runResolve],
  );

  const handleCreateUnknownPackage = useCallback(() => {
    if (!unknownModal) return;
    const code = unknownModal.code.trim();
    if (!code) return;
    modalOpenRef.current = false;
    setUnknownModal(null);
    setActivePallet(null);
    setActiveSlipOrPackage(null);
    setActiveTracking(code);
    setDirectBox(true);
    setBoxNotes("");
    setActiveBoxSession({ barcode: code, packageId: null });
    setCurrentPalletTrackingId(code);
    setCurrentPackageTrackingId(code);
    setFlowPhase("package_scan");
    scheduleFocusScanner();
  }, [unknownModal, scheduleFocusScanner]);

  /**
   * Resolve or create the receiving pallet row for a tracking number (used by the
   * identification gate and by Save & Start when only tracking context exists).
   */
  const ensureReceivingPalletForTracking = useCallback(
    async (
      tn: string,
      orderId: string | null,
    ): Promise<
      | { id: string; pallet_number: string; created: boolean }
      | { blocked: "other_store"; message: string }
      | null
    > => {
      if (!isSupabaseConfigured() || !sessionStoreId) return null;
      const tracking = tn.trim();
      if (!tracking) return null;
      const oid = orderId?.trim() || null;
      const curStore = sessionStoreId.trim();

      const hitScan = await findPalletInOrgByScanCode(supabase, orgId, tracking);
      if (hitScan?.id) {
        const ps = String(hitScan.store_id ?? "").trim();
        if (ps && isUuidString(ps) && isUuidString(curStore) && ps !== curStore) {
          const label = (await fetchStoreDisplayNameForOrganization(supabase, orgId, ps)) ?? "";
          return { blocked: "other_store", message: formatUnauthorizedTrackingInStoreMessage(label) };
        }
        return {
          id: hitScan.id,
          pallet_number: hitScan.pallet_number,
          created: false,
        };
      }
      if (oid) {
        const { data: hitOrd, error: eOrd } = await supabase
          .from("pallets")
          .select("id, pallet_number, store_id")
          .eq("organization_id", orgId)
          .is("deleted_at", null)
          .eq("order_id", oid)
          .limit(1)
          .maybeSingle();
        if (!eOrd && hitOrd && (hitOrd as { id?: string }).id) {
          const ps = String((hitOrd as { store_id?: string | null }).store_id ?? "").trim();
          if (ps && isUuidString(ps) && isUuidString(curStore) && ps !== curStore) {
            const label = (await fetchStoreDisplayNameForOrganization(supabase, orgId, ps)) ?? "";
            return { blocked: "other_store", message: formatUnauthorizedTrackingInStoreMessage(label) };
          }
          return {
            id: String((hitOrd as { id: string }).id),
            pallet_number: String((hitOrd as { pallet_number: string }).pallet_number),
            created: false,
          };
        }
      }
      const palletNumber = `RCV-${tracking.replace(/\s+/g, "").slice(0, 48) || "TRACK"}`;
      const trackingPersist = normalizeTrackingKey(tracking) || tracking.trim();
      const audit = await resolveOperatorAuditFieldsClient(supabase);
      const insertPayload: Record<string, unknown> = {
        organization_id: orgId,
        store_id: sessionStoreId,
        pallet_number: palletNumber,
        status: "open",
        tracking_number: trackingPersist,
      };
      if (audit.created_by) insertPayload.created_by = audit.created_by;
      if (oid) insertPayload.order_id = oid;
      const { data: created, error: insErr } = await supabase
        .from("pallets")
        .insert(insertPayload)
        .select("id, pallet_number")
        .maybeSingle();
      if (insErr) {
        console.warn("[pallets] shipment receiving pallet create:", insErr.message);
        return null;
      }
      const row = created as { id: string; pallet_number: string } | null;
      return row?.id ? { id: row.id, pallet_number: row.pallet_number, created: true } : null;
    },
    [orgId, sessionStoreId],
  );

  const hydrateMatchedShipmentPalletDraft = useCallback(
    (effectiveTracking: string, lastResolve: OperatorResolveResult | null) => {
      const barcodeRow = recordFromResolveResult(lastResolve);
      const detailRows = identifyGateRows;
      const lineRows = identifyGateShipmentLines as unknown as Record<string, unknown>[];
      const lookupRows = [...lineRows, ...detailRows, barcodeRow].filter(Boolean) as Record<string, unknown>[];

      const trackingCandidate = firstNonEmptyString([
        effectiveTracking,
        identifyGateCanonicalTracking,
        firstRecordString(lookupRows, ["tracking_number", "shipment_tracking_number"]),
        identifyGateEnteredCode,
      ]);
      if (trackingCandidate) setCurrentPalletTrackingId(trackingCandidate);

      const carrierRaw = firstNonEmptyString([
        identifyGateViewHints?.carrier,
        firstRecordString(lookupRows, [
          "carrier_name",
          "carrier",
          "carrier_code",
          "scac",
          "scac_code",
        ]),
      ]);
      if (carrierRaw && !palletCarrierRef.current.trim()) {
        const normalized = normalizeCarrierLabel(carrierRaw);
        const applied = normalized && normalized !== OTHER_CARRIER_NAME ? normalized : carrierRaw;
        if (normalized && normalized !== OTHER_CARRIER_NAME) {
          setPalletCarrierOtherSelected(false);
          setPalletCarrier(normalized);
        } else {
          setPalletCarrierOtherSelected(true);
          setPalletCarrier(carrierRaw);
        }
        parentPalletCarrierDefaultRef.current = applied;
        persistOperatorSessionCarrier(applied);
        mergeCarrierIntoActivePalletState(applied);
      }

      const orderCandidate = firstRecordString(lookupRows, [
        "order_id",
        "amazon_order_id",
        "amazonOrderId",
        "purchase_order_id",
      ]);
      if (orderCandidate && !palletOrderIdRef.current.trim()) {
        setPalletOrderId(orderCandidate);
        setPalletResolvedOrderId(orderCandidate);
        lastOrderIdAutoFilledFromRaRef.current = null;
      }

      const activityIso = firstRecordString(lookupRows, [
        "shipment_date",
        "received_date",
        "receive_date",
        "created_at",
        "updated_at",
      ]);
      if (activityIso) {
        setPalletCreatedAtIso((prev) => prev ?? activityIso);
      }

      const expectedPackageCount = countLookupExpectedPackages(
        identifyGateShipmentLines,
        detailRows,
        identifyGateInventoryAgg?.rowCount ?? null,
      );
      if (expectedPackageCount != null && expectedPackageCount > 0 && identifyGateEntity !== "pallet") {
        setPhysicalBoxCount(expectedPackageCount);
        setBoxScanTargetDenominator(expectedPackageCount);
      }
    },
    [
      identifyGateCanonicalTracking,
      identifyGateEnteredCode,
      identifyGateEntity,
      identifyGateInventoryAgg?.rowCount,
      identifyGateRows,
      identifyGateShipmentLines,
      identifyGateViewHints?.carrier,
      mergeCarrierIntoActivePalletState,
      persistOperatorSessionCarrier,
    ],
  );

  const handleIdentifyMatchedStartWorkflow = useCallback(async () => {
    if (identifyGatePhase !== "matched") return;
    const entity =
      identifyGateEntity ??
      identifyGateEntityForManifestMatch(identifyGateMatchField, "");
    if (!entity) return;
    if (identifyGateInventoryVisual === "completed") return;
    const tracking = (identifyGateCanonicalTracking ?? identifyGateEnteredCode).trim();
    if (!tracking) return;

    if (entity === "pallet") setDirectBox(false);

    const orderIdFromGate = (): string | null => {
      for (const r of identifyGateShipmentLines) {
        const o = firstRecordString([r as unknown as Record<string, unknown>], ["order_id", "amazon_order_id"]);
        if (o) return o;
      }
      for (const r of identifyGateRows) {
        const o = firstRecordString([r], ["order_id", "amazon_order_id", "amazonOrderId"]);
        if (o) return o;
      }
      return null;
    };
    const orderId = orderIdFromGate();

    let palletOperatorPackageCount: number | null = null;
    if (entity === "pallet") {
      palletOperatorPackageCount = resolveMatchedGatePalletBoxCount(
        identifyGatePhysicalBoxStr,
        identifyGateShipmentLines,
        identifyGateRows,
        identifyGateInventoryAgg,
      );
      if (palletOperatorPackageCount != null) {
        setPhysicalBoxCount(palletOperatorPackageCount);
        setBoxScanTargetDenominator(palletOperatorPackageCount);
      }
    } else if (entity === "single_box") {
      palletOperatorPackageCount = 1;
      setPhysicalBoxCount(1);
      setBoxScanTargetDenominator(1);
    } else if (
      !(
        entity === "package" &&
        (identifyGateInventoryVisual === "new" || identifyGateInventoryVisual === "in_progress")
      )
    ) {
      setPhysicalBoxCount(null);
      setBoxScanTargetDenominator(null);
    }

    const shipContinueVisual =
      entity === "package" &&
      (identifyGateInventoryVisual === "new" || identifyGateInventoryVisual === "in_progress");

    setBusy(true);
    try {
      const code = identifyGateEnteredCode.trim() || tracking;
      if (
        entity === "pallet" &&
        palletOperatorPackageCount == null &&
        isSupabaseConfigured() &&
        sessionStoreId
      ) {
        const snap = await loadTrackingExpectationSnapshot(supabase, orgId, sessionStoreId, tracking);
        if (snap.rawRowCount > 0) {
          palletOperatorPackageCount = snap.rawRowCount;
          setPhysicalBoxCount(snap.rawRowCount);
          setBoxScanTargetDenominator(snap.rawRowCount);
        }
      } else if (entity === "pallet" && palletOperatorPackageCount == null && !isSupabaseConfigured()) {
        const snap = mockTrackingExpectationSnapshot(tracking);
        if (snap.rawRowCount > 0) {
          palletOperatorPackageCount = snap.rawRowCount;
          setPhysicalBoxCount(snap.rawRowCount);
          setBoxScanTargetDenominator(snap.rawRowCount);
        }
      }
      if (isSupabaseConfigured() && sessionStoreId) {
        const dbResume = await tryDirectPackageDbFallbackResume(code, [
          tracking,
          identifyGateCanonicalTracking ?? "",
        ]);
        if (dbResume === "resumed") {
          playOperatorSuccessBeep();
          setIdentifyGateGlowFlash(true);
          await new Promise((r) => window.setTimeout(r, 400));
          setIdentifyGateGlowFlash(false);
          setIsIdentified(true);
          setPalletDocHydrationNonce((n) => n + 1);
          resetIdentifyGateForm();
          return;
        }
        if (dbResume === "wrong_store" || dbResume === "error") return;
      }

      let applied = false;
      let lastResolve: OperatorResolveResult | null = null;
      const resolveOnly: OperatorResolveKind | undefined =
        entity === "package"
          ? "package"
          : entity === "single_box"
            ? "tracking"
            : entity === "pallet"
              ? "pallet"
              : "tracking";

      if (isSupabaseConfigured()) {
        lastResolve = await resolveOperatorBarcode(supabase, orgId, code, {
          only: resolveOnly,
          storeId: sessionStoreId,
        });
        if (lastResolve.kind !== "unknown") {
          applyResult(lastResolve);
          applied = true;
        }
      } else {
        const r = mockResolveOperatorBarcode(code, resolveOnly);
        lastResolve = r;
        if (r.kind !== "unknown") {
          applyResult(r);
          applied = true;
        }
      }

      if (applied && lastResolve?.kind === "pallet") {
        const rowTn = String(lastResolve.row.tracking_number ?? "").trim();
        setCurrentPalletTrackingId(tracking || rowTn || null);
        setDirectBox(false);
      }
      if (
        applied &&
        (lastResolve?.kind === "package" || lastResolve?.kind === "slip") &&
        String(lastResolve.row.pallet_id ?? "").trim()
      ) {
        setDirectBox(false);
      }

      let effectiveTracking = tracking;
      if (lastResolve?.kind === "tracking") {
        effectiveTracking = String(lastResolve.row.tracking_number ?? "").trim() || effectiveTracking;
      }

      if (shipContinueVisual) {
        setModernPalletWorkspace(false);
        setActiveSlipOrPackage(null);
        const pkgRow =
          lastResolve?.kind === "package" || lastResolve?.kind === "slip" ? lastResolve.row : null;
        const pkgPalletId = String(pkgRow?.pallet_id ?? "").trim();
        let resumedPalletPackage = false;
        if (
          pkgPalletId &&
          isUuidString(pkgPalletId) &&
          isSupabaseConfigured() &&
          sessionStoreId
        ) {
          const byId = await findOperatorPalletByIdAction(orgId, pkgPalletId, sessionStoreId);
          if (byId.ok && byId.pallet) {
            setDirectBox(false);
            setActiveTracking(null);
            setActivePallet({
              id: byId.pallet.id,
              pallet_number: byId.pallet.pallet_number,
              carrier_name: String(byId.pallet.carrier_name ?? "").trim() || undefined,
            });
            setCurrentPalletTrackingId(
              String(byId.pallet.tracking_number ?? "").trim() || effectiveTracking,
            );
            if (pkgRow) hydrateSavedPackageRowIntoBoxIntake(pkgRow, { directBox: false });
            const resumedItemScanFromPallet = pkgRow
              ? Boolean(
                  await maybeResumeItemScanAfterPackageRowRef.current?.(pkgRow, { directBox: false }),
                )
              : false;
            if (!resumedItemScanFromPallet) setFlowPhase("package_scan");
            setPalletDocHydrationNonce((n) => n + 1);
            resumedPalletPackage = true;
          }
        }
        if (!resumedPalletPackage) {
          const dbResumeShip = await tryDirectPackageDbFallbackResume(effectiveTracking, [
            code,
            tracking,
            identifyGateCanonicalTracking ?? "",
          ]);
          if (dbResumeShip === "resumed") {
            playOperatorSuccessBeep();
            setIdentifyGateGlowFlash(true);
            await new Promise((r) => window.setTimeout(r, 400));
            setIdentifyGateGlowFlash(false);
            setIsIdentified(true);
            setPalletDocHydrationNonce((n) => n + 1);
            resetIdentifyGateForm();
            return;
          }
          if (dbResumeShip === "wrong_store" || dbResumeShip === "error") return;

          setActiveTracking(effectiveTracking);
          setCurrentPalletTrackingId(effectiveTracking);
          setDirectBox(true);
          setActivePallet(null);
          if (isSupabaseConfigured() && sessionStoreId) {
            const snap = await loadTrackingExpectationSnapshot(supabase, orgId, sessionStoreId, effectiveTracking);
            if (snap.rawRowCount > 0) {
              setPhysicalBoxCount(snap.rawRowCount);
              setBoxScanTargetDenominator(snap.rawRowCount);
            }
          } else {
            const snap = mockTrackingExpectationSnapshot(effectiveTracking);
            if (snap.rawRowCount > 0) {
              setPhysicalBoxCount(snap.rawRowCount);
              setBoxScanTargetDenominator(snap.rawRowCount);
            }
          }
          setFlowPhase("package_scan");
        }
      } else {
        setModernPalletWorkspace(false);
        if (entity === "single_box") {
          setActiveSlipOrPackage(null);
          setDirectBox(true);
          setPhysicalBoxCount(1);
          setBoxScanTargetDenominator(1);
          setActivePallet(null);
          setActiveTracking(effectiveTracking);
          setCurrentPalletTrackingId(effectiveTracking);
          setBoxNotes("");
          setActiveBoxSession({ barcode: code, packageId: null });
          setCurrentPackageTrackingId(code);
          setFlowPhase("package_scan");
        } else {
          if (!applied) {
            setActivePallet(null);
            setActiveSlipOrPackage(null);
            setCurrentPalletTrackingId(null);
            setActiveTracking(tracking);
            setDirectBox(false);
            setFlowPhase("scan");
          }
        }
        hydrateMatchedShipmentPalletDraft(effectiveTracking, lastResolve);
      }

      playOperatorSuccessBeep();
      setIdentifyGateGlowFlash(true);
      await new Promise((r) => window.setTimeout(r, 400));
      setIdentifyGateGlowFlash(false);
      setIsIdentified(true);
      if (isSupabaseConfigured()) setPalletDocHydrationNonce((n) => n + 1);
      resetIdentifyGateForm();
    } catch (e) {
      setSyncErrorToast(e instanceof Error ? e.message : "Could not start workflow.");
    } finally {
      setBusy(false);
      scheduleFocusScanner();
    }
  }, [
    identifyGatePhase,
    identifyGateEntity,
    identifyGateMatchField,
    identifyGateInventoryVisual,
    identifyGateInventoryAgg,
    identifyGateCanonicalTracking,
    identifyGateEnteredCode,
    identifyGatePhysicalBoxStr,
    identifyGateShipmentLines,
    identifyGateRows,
    sessionStoreId,
    orgId,
    applyResult,
    ensureReceivingPalletForTracking,
    hydrateMatchedShipmentPalletDraft,
    hydrateSavedPackageRowIntoBoxIntake,
    scheduleFocusScanner,
    resetIdentifyGateForm,
    tryDirectPackageDbFallbackResume,
  ]);

  const handleIdentifyNewCreateAndStart = useCallback(async () => {
    if (identifyGatePhase !== "new" || !identifyGateEntity) return;
    const code = identifyGateEnteredCode.trim();
    if (!code) return;

    let boxN: number | null = null;
    if (identifyGateEntity === "pallet") {
      const parsed = parseMandatoryGateBoxCount(identifyGatePhysicalBoxStr);
      if (!parsed.valid) return;
      boxN = parsed.n;
    } else if (identifyGateEntity === "single_box") {
      boxN = 1;
    }

    if (!isSupabaseConfigured()) {
      if (boxN != null) {
        setPhysicalBoxCount(boxN);
        setBoxScanTargetDenominator(boxN);
      } else {
        setPhysicalBoxCount(null);
        setBoxScanTargetDenominator(null);
      }
      setActiveSlipOrPackage(null);
      if (identifyGateEntity === "pallet") {
        setActivePallet({ id: `local-${crypto.randomUUID()}`, pallet_number: code });
        setPalletCreatedAtIso(new Date().toISOString());
        setActiveTracking(code.trim());
        setCurrentPalletTrackingId(code.trim());
        setDirectBox(false);
        setModernPalletWorkspace(false);
        setFlowPhase("scan");
      } else if (identifyGateEntity === "single_box") {
        setActivePallet(null);
        setActiveTracking(code);
        setCurrentPalletTrackingId(code.trim());
        setDirectBox(true);
        setBoxNotes("");
        setModernPalletWorkspace(false);
        setActiveBoxSession({ barcode: code.trim(), packageId: null });
        setCurrentPackageTrackingId(code.trim());
        setFlowPhase("package_scan");
      } else if (identifyGateEntity === "package") {
        setActivePallet(null);
        setActiveTracking(code);
        setDirectBox(true);
        setCurrentPalletTrackingId(code.trim());
        setModernPalletWorkspace(false);
        setBoxNotes("");
        setActiveBoxSession({ barcode: code.trim(), packageId: null });
        setCurrentPackageTrackingId(code.trim());
        setFlowPhase("package_scan");
      } else {
        setActivePallet(null);
        setActiveTracking(null);
        setDirectBox(false);
        setModernPalletWorkspace(true);
        setFlowPhase("items");
      }
      setIsIdentified(true);
      resetIdentifyGateForm();
      scheduleFocusScanner();
      return;
    }

    if (!sessionStoreId) {
      setSyncErrorToast("Select a store before creating records.");
      return;
    }

    if (
      isSupabaseConfigured() &&
      (identifyGateEntity === "single_box" || identifyGateEntity === "package")
    ) {
      const dbResumeNew = await tryDirectPackageDbFallbackResume(code, []);
      if (dbResumeNew === "resumed") {
        setIsIdentified(true);
        resetIdentifyGateForm();
        scheduleFocusScanner();
        return;
      }
      if (dbResumeNew === "wrong_store" || dbResumeNew === "error") return;
    }

    setBusy(true);
    try {
      const baselineReady = await initializeUnlistedTrackingBaselineReturnItem(code);
      if (!baselineReady) return;
    } finally {
      setBusy(false);
    }

    if (identifyGateEntity === "pallet") {
      if (boxN != null) {
        setPhysicalBoxCount(boxN);
        setBoxScanTargetDenominator(boxN);
      } else {
        setPhysicalBoxCount(null);
        setBoxScanTargetDenominator(null);
      }
      setActiveSlipOrPackage(null);
      setActivePallet({ id: `local-${crypto.randomUUID()}`, pallet_number: code });
      setPalletCreatedAtIso(new Date().toISOString());
      setActiveTracking(code.trim());
      setCurrentPalletTrackingId(code.trim());
      setDirectBox(false);
      setModernPalletWorkspace(false);
      setFlowPhase("scan");
      setIsIdentified(true);
      resetIdentifyGateForm();
      scheduleFocusScanner();
      return;
    }

    if (identifyGateEntity === "single_box") {
      setPhysicalBoxCount(1);
      setBoxScanTargetDenominator(1);
      setActiveSlipOrPackage(null);
      setActivePallet(null);
      setActiveTracking(code);
      setCurrentPalletTrackingId(code.trim());
      setDirectBox(true);
      setBoxNotes("");
      setModernPalletWorkspace(false);
      setActiveBoxSession({ barcode: code.trim(), packageId: null });
      setCurrentPackageTrackingId(code.trim());
      setFlowPhase("package_scan");
      setIsIdentified(true);
      resetIdentifyGateForm();
      scheduleFocusScanner();
      return;
    }

    setBusy(true);
    try {
      if (identifyGateEntity === "package") {
        if (!allowOperatorUnknownPackageCreate()) {
          throw new Error("Unknown box creation is disabled for this deployment.");
        }
        setPhysicalBoxCount(null);
        setBoxScanTargetDenominator(null);
        setActivePallet(null);
        setActiveSlipOrPackage(null);
        setActiveTracking(code);
        setCurrentPalletTrackingId(code.trim());
        setDirectBox(true);
        setBoxNotes("");
        setModernPalletWorkspace(false);
        setActiveBoxSession({ barcode: code.trim(), packageId: null });
        setCurrentPackageTrackingId(code.trim());
        setFlowPhase("package_scan");
      } else {
        // Baseline return_items initialization already happened before this phase transition.
        setPhysicalBoxCount(null);
        setBoxScanTargetDenominator(null);
        setActivePallet(null);
        setActiveTracking(null);
        setActiveSlipOrPackage(null);
        setDirectBox(false);
        setModernPalletWorkspace(true);
        setFlowPhase("items");
      }
      setIsIdentified(true);
      resetIdentifyGateForm();
    } catch (e) {
      setSyncErrorToast(e instanceof Error ? e.message : "Could not create records.");
    } finally {
      setBusy(false);
      scheduleFocusScanner();
    }
  }, [
    identifyGatePhase,
    identifyGateEntity,
    identifyGateEnteredCode,
    identifyGatePhysicalBoxStr,
    sessionStoreId,
    orgId,
    initializeUnlistedTrackingBaselineReturnItem,
    scheduleFocusScanner,
    resetIdentifyGateForm,
    tryDirectPackageDbFallbackResume,
  ]);

  const handleIdentificationGatePrimaryCta = useCallback(() => {
    const visual = identifyGateInventoryVisual;
    if (!visual) return;
    if (visual === "completed") return;
    if (visual === "manual_new" && identifyGatePhase === "new") void handleIdentifyNewCreateAndStart();
    else void handleIdentifyMatchedStartWorkflow();
  }, [
    identifyGateInventoryVisual,
    identifyGatePhase,
    handleIdentifyNewCreateAndStart,
    handleIdentifyMatchedStartWorkflow,
  ]);

  const palletIdentified = Boolean(activePallet);
  const trackingIdentified =
    Boolean(activeTracking?.trim()) || Boolean(activePallet?.id && (currentPalletTrackingId ?? "").trim().length > 0);
  const parentIdentified = palletIdentified || trackingIdentified;

  const stepIndex = flowPhase === "scan" ? 0 : flowPhase === "package_scan" ? 1 : 2;

  const scanStepMeta = SCANNER_STEPS[stepIndex] ?? SCANNER_STEPS[0];
  const headerTitle = "Shipment Entry";
  // Subtitle (e.g. "Step 1: Pallet · Slip, counts, then packages") was removed from the
  // page header per the cleanup spec — only the title and the active tracking/pallet ID
  // belong here. We still keep `scanStepMeta` available for inline use in package_scan
  // and items phases below.
  void scanStepMeta;

  /** Operator box count is collected when entity type is Pallet (for both new and matched). */
  const identifyGateNeedsValidBoxCount = identifyGateEntity === "pallet";
  const identifyGateBoxCountValid = parseMandatoryGateBoxCount(identifyGatePhysicalBoxStr).valid;
  const identifyGateBoxCountShowsError = identifyGateNeedsValidBoxCount && !identifyGateBoxCountValid;
  const identifyGateMandatoryFieldsOk =
    identifyGateEntity !== null &&
    (!identifyGateNeedsValidBoxCount || identifyGateBoxCountValid);

  /** Show box count stepper for any gate phase when pallet is selected. */
  const showIdentifyGatePhysicalBoxInput = identifyGateEntity === "pallet" &&
    (identifyGatePhase === "new" || identifyGatePhase === "matched");

  const hasItemReceivableBox = hasReceivableBoxForItems(itemScanPackageId, activeBoxSession);

  const expectedPkgDetailSafe = Array.isArray(expectedPkgDetailRows) ? expectedPkgDetailRows : [];
  const itemExpectedUnitsTotal = expectedPkgDetailSafe.reduce(
    (s, r) => s + Number((r as { expected_scan_quantity?: number }).expected_scan_quantity ?? 0),
    0,
  );

  const itemsLiveEpRow: Record<string, unknown> | null = itemDraft
    ? (expectedPkgDetailSafe.find((r) => String(r.id) === String(itemDraft.epRow.id ?? "")) ??
        expectedPkgDetailSafe.find(
          (r) =>
            String(r.sku ?? "").trim() === String(itemDraft.epRow.sku ?? "").trim() &&
            String(r.fnsku ?? "").trim() === String(itemDraft.epRow.fnsku ?? "").trim() &&
            String(r.disposition ?? "").trim() === String(itemDraft.epRow.disposition ?? "").trim() &&
            String(r.order_id ?? "").trim() === String(itemDraft.epRow.order_id ?? "").trim(),
        ) ??
        itemDraft.epRow)
    : null;

  const itemsLineForDraft = itemDraft
    ? expectedPkgLines.find(
        (l) =>
          l.sku === String(itemDraft.epRow.sku ?? "").trim() && l.fnsku === String(itemDraft.epRow.fnsku ?? "").trim(),
      )
    : undefined;

  /** EP-only row math (fallback when no slip-like source). */
  const itemInspectionEpOnlyQtyRows = useMemo(() => {
    const rows = Array.isArray(expectedPkgDetailRows) ? expectedPkgDetailRows : [];
    return rows.map((row) => {
      const r = row as Record<string, unknown>;
      const expected = Math.max(0, Math.floor(Number(r.expected_scan_quantity ?? 0)));
      const persisted = Math.max(0, Math.floor(Number(r.actual_scanned_count ?? 0)));
      const draftExtra =
        itemDraft && epRowMatchesItemDraft(r, itemDraft)
          ? Math.max(1, Math.min(50, Math.floor(itemQtyStepper)))
          : 0;
      const scanned = persisted + draftExtra;
      return { row: r, expected, scanned, persisted, draftExtra };
    });
  }, [expectedPkgDetailRows, itemDraft, itemQtyStepper]);

  const carryoverRowsForActiveItemScanPackage = useMemo((): OperatorSlipContentsListRow[] => {
    const pid = String(itemScanPackageId ?? "").trim();
    if (!pid || !isUuidString(pid)) return [];
    const fromState =
      itemScanSlipCarryover?.packageId === pid ? itemScanSlipCarryover.rows : [];
    if (fromState.length > 0) return fromState;
    const fromRef =
      itemScanSlipCarryoverRef.current?.packageId === pid
        ? itemScanSlipCarryoverRef.current.rows
        : [];
    return fromRef;
  }, [itemScanPackageId, itemScanSlipCarryover]);

  const previewLinkagesForItemScanSlipRows = useMemo((): ProductLinkageDisplayContract[] => {
    if (carryoverRowsForActiveItemScanPackage.length > 0) {
      return carryoverRowsForActiveItemScanPackage.map((r) => r.product_linkage);
    }
    if (boxSlipVisionLineLinkages.length > 0) return boxSlipVisionLineLinkages;
    return boxSlipVisionLineLinkagesRef.current;
  }, [carryoverRowsForActiveItemScanPackage, boxSlipVisionLineLinkages]);

  const slipLikeRowsForInspection = useMemo((): OperatorSlipContentsListRow[] => {
    const carryover = carryoverRowsForActiveItemScanPackage;
    if (itemInspectionSlipLines.length > 0) {
      if (carryover.length > 0) {
        return mergeDbSlipRowsWithCarryoverPreview(itemInspectionSlipLines, carryover);
      }
      return slipInspectionRowsWithMergedPreviewLinkages(
        itemInspectionSlipLines,
        previewLinkagesForItemScanSlipRows,
      );
    }
    if (carryover.length > 0) return carryover;
    if (boxSlipVisionLines.length > 0) {
      return slipRowsFromBoxSlipVision(boxSlipVisionLines, boxSlipVisionLineLinkages);
    }
    const eps = Array.isArray(expectedPkgDetailRows) ? expectedPkgDetailRows : [];
    if (eps.length > 0) {
      return eps.map((row, i) => {
        const r = row as Record<string, unknown>;
        const pname = String((r.products as { product_name?: string } | null)?.product_name ?? "").trim();
        const rid = String(r.id ?? "").trim();
        const upc = String(r.sku ?? "").trim() || null;
        const fnsku = String(r.fnsku ?? "").trim() || null;
        const description = pname || null;
        const hydrated = rid && isUuidString(rid) ? epReceiveLinkageByEpId[rid] : undefined;
        return {
          id: rid && isUuidString(rid) ? rid : null,
          upc,
          fnsku,
          description,
          quantity: Math.max(0, Math.floor(Number(r.expected_scan_quantity ?? 0))),
          condition: String(r.disposition ?? "").trim() || null,
          rma_number: null,
          sort_index: i,
          slip_code: null,
          order_id: null,
          conflicting_order_id: null,
          product_linkage:
            hydrated ??
            buildProductLinkageDisplayContract(
              { description, fnsku, upc },
              EMPTY_PRODUCT_NAME_LOOKUP,
            ),
        };
      });
    }
    return [];
  }, [
    itemInspectionSlipLines,
    carryoverRowsForActiveItemScanPackage,
    previewLinkagesForItemScanSlipRows,
    boxSlipVisionLines,
    boxSlipVisionLineLinkages,
    expectedPkgDetailRows,
    epReceiveLinkageByEpId,
  ]);

  const itemInspectionSlipCells = useMemo(() => {
    const epRows = Array.isArray(expectedPkgDetailRows) ? expectedPkgDetailRows : [];
    const slipCounts = packageItemScanState.bySlipId;
    return slipLikeRowsForInspection.map((slip, idx) => {
      const key = slipInspectionStableKey(slip, idx);
      const matched = epRowsMatchingSlipLike(slip, epRows);
      const slipId = slip.id && isUuidString(slip.id) ? slip.id : null;
      const fromPackageItems = slipId ? (slipCounts[slipId] ?? 0) : 0;
      const epScanned = slipId ? fromPackageItems : sumEpActualScanned(matched);
      const draftExtra =
        itemDraft && matched.some((r) => epRowMatchesItemDraft(r, itemDraft))
          ? Math.max(1, Math.min(50, Math.floor(itemQtyStepper)))
          : 0;
      const scanned = Math.max(0, epScanned + draftExtra);
      const expected = Math.max(0, Math.floor(Number(slip.quantity ?? 0)));
      return { key, slip, expected, scanned, epScanned, draftExtra };
    });
  }, [
    slipLikeRowsForInspection,
    expectedPkgDetailRows,
    itemDraft,
    itemQtyStepper,
    packageItemScanState.bySlipId,
  ]);

  /** Saved package item scan — slip_contents / BOX vision, not shipment tracking EP aggregate. */
  const itemScanUsesPackageSlipExpectedRows = useMemo(
    () => Boolean(itemScanPackageId && isUuidString(itemScanPackageId)),
    [itemScanPackageId],
  );

  type ItemScanExpectedItemsRenderSource =
    | "loading"
    | "tracking_ep_variance"
    | "package_slip_cells"
    | "hydrated_return_items_only"
    | "empty";

  const itemScanExpectedItemsRenderSource = useMemo((): ItemScanExpectedItemsRenderSource => {
    if (flowPhase !== "items") return "empty";
    const packageSlipRowsReady =
      itemInspectionSlipCells.length > 0 || slipLikeRowsForInspection.length > 0;
    if (
      itemInspectionSlipLinesLoading ||
      (itemScanUsesPackageSlipExpectedRows && !packageSlipRowsReady)
    ) {
      return "loading";
    }
    if (itemScanUsesPackageSlipExpectedRows && packageSlipRowsReady) {
      return "package_slip_cells";
    }
    if (!itemScanUsesPackageSlipExpectedRows && itemScanExpectationLinesLive.length > 0) {
      return "tracking_ep_variance";
    }
    if (itemInspectionSlipCells.length > 0) return "package_slip_cells";
    if (packageItemHydratedRows.length > 0) return "hydrated_return_items_only";
    return "empty";
  }, [
    flowPhase,
    itemInspectionSlipLinesLoading,
    itemScanUsesPackageSlipExpectedRows,
    itemInspectionSlipCells.length,
    slipLikeRowsForInspection.length,
    itemScanExpectationLinesLive.length,
    packageItemHydratedRows.length,
  ]);

  const itemInspectionQtyBasisExpected = useMemo(() => {
    if (itemScanUsesPackageSlipExpectedRows && itemInspectionSlipCells.length > 0) {
      return itemInspectionSlipCells.reduce((s, c) => s + c.expected, 0);
    }
    if (itemScanExpectationLinesLive.length > 0) {
      return itemScanExpectationLinesLive.reduce((s, line) => s + Math.max(0, line.expectedQty), 0);
    }
    if (itemInspectionSlipCells.length > 0) {
      return itemInspectionSlipCells.reduce((s, c) => s + c.expected, 0);
    }
    return itemExpectedUnitsTotal;
  }, [
    itemScanUsesPackageSlipExpectedRows,
    itemScanExpectationLinesLive,
    itemInspectionSlipCells,
    itemExpectedUnitsTotal,
  ]);

  const itemInspectionQtyBasisScanned = useMemo(() => {
    if (itemScanUsesPackageSlipExpectedRows && itemInspectionSlipCells.length > 0) {
      const lineSum = itemInspectionSlipCells.reduce((s, c) => s + c.scanned, 0);
      return lineSum + packageItemScanState.unexpectedUnits;
    }
    if (itemScanExpectationLinesLive.length > 0) {
      return itemScanExpectationLinesLive.reduce((s, line) => s + Math.max(0, line.scannedQty), 0);
    }
    if (itemInspectionSlipCells.length > 0) {
      const lineSum = itemInspectionSlipCells.reduce((s, c) => s + c.scanned, 0);
      return lineSum + packageItemScanState.unexpectedUnits;
    }
    return itemInspectionEpOnlyQtyRows.reduce((sum, cell) => sum + cell.scanned, 0) + packageItemScanState.unexpectedUnits;
  }, [
    itemScanUsesPackageSlipExpectedRows,
    itemScanExpectationLinesLive,
    itemInspectionSlipCells,
    itemInspectionEpOnlyQtyRows,
    packageItemScanState.unexpectedUnits,
  ]);

  const itemScanStatRemaining = Math.max(0, itemInspectionQtyBasisExpected - itemInspectionQtyBasisScanned);

  const itemScanStatScannedTone = useMemo(() => {
    const exp = itemInspectionQtyBasisExpected;
    const scn = itemInspectionQtyBasisScanned;
    if (exp <= 0) return "neutral";
    if (scn === 0) return "zero";
    if (scn > exp) return "over";
    if (scn === exp) return "match";
    return "progress";
  }, [itemInspectionQtyBasisExpected, itemInspectionQtyBasisScanned]);

  const itemScanStatRemainingTone = useMemo(() => {
    const exp = itemInspectionQtyBasisExpected;
    const scn = itemInspectionQtyBasisScanned;
    const rem = itemScanStatRemaining;
    if (exp <= 0) return "neutral";
    if (scn === 0) return "zero";
    if (rem > 0 && scn < exp) return "shortage";
    if (rem === 0) return "clear";
    return "neutral";
  }, [itemInspectionQtyBasisExpected, itemInspectionQtyBasisScanned, itemScanStatRemaining]);

  const itemsSlipScanProgressPct = useMemo(() => {
    const exp = itemInspectionQtyBasisExpected;
    const scn = itemInspectionQtyBasisScanned;
    if (exp <= 0) return 0;
    return Math.min(100, Math.round((scn / exp) * 100));
  }, [itemInspectionQtyBasisExpected, itemInspectionQtyBasisScanned]);

  const itemsSlipScanProgressTrackColor = useMemo(
    () => nedaQuantityProgressColor(itemInspectionQtyBasisExpected, itemInspectionQtyBasisScanned),
    [itemInspectionQtyBasisExpected, itemInspectionQtyBasisScanned],
  );

  const itemsPhaseLiveTotalScanned = itemInspectionQtyBasisScanned;
  const isItemsQtyDiscrepancy = itemInspectionQtyBasisExpected !== itemInspectionQtyBasisScanned;

  const itemInspectionDiscrepancyKinds = useMemo(() => {
    if (!itemScanUsesPackageSlipExpectedRows && itemScanExpectationLinesLive.length > 0) {
      const hasShortage = itemScanExpectationLinesLive.some((line) => line.scannedQty < line.expectedQty);
      const hasSurplus = itemScanExpectationLinesLive.some((line) => line.scannedQty > line.expectedQty);
      return {
        hasShortage,
        hasSurplus: hasSurplus || packageItemScanState.unexpectedUnits > 0,
      };
    }
    const src = itemInspectionSlipCells.length ? itemInspectionSlipCells : itemInspectionEpOnlyQtyRows;
    const hasShortage = src.some((x) => x.scanned < x.expected);
    const hasSurplus =
      src.some((x) => x.scanned > x.expected) || packageItemScanState.unexpectedUnits > 0;
    return { hasShortage, hasSurplus };
  }, [
    itemScanUsesPackageSlipExpectedRows,
    itemScanExpectationLinesLive,
    itemInspectionSlipCells,
    itemInspectionEpOnlyQtyRows,
    packageItemScanState.unexpectedUnits,
  ]);

  const itemInspectionAggregateStatusLabel = useMemo(() => {
    if (isItemsQtyDiscrepancy) return "Quantity mismatch (expected vs scanned totals)";
    if (!itemScanUsesPackageSlipExpectedRows && itemScanExpectationLinesLive.length > 0) {
      const { hasShortage, hasSurplus } = itemInspectionDiscrepancyKinds;
      if (hasShortage && hasSurplus) return "Mixed: shortage and surplus";
      if (hasSurplus) return "Surplus (over-scanned)";
      if (hasShortage) return "Shortage (under-scanned)";
      return "All matched";
    }
    const src = itemInspectionSlipCells.length ? itemInspectionSlipCells : itemInspectionEpOnlyQtyRows;
    if (src.length === 0) return "No slip lines loaded";
    const { hasShortage, hasSurplus } = itemInspectionDiscrepancyKinds;
    if (hasShortage && hasSurplus) return "Mixed: shortage and surplus";
    if (hasSurplus) return "Surplus (over-scanned)";
    if (hasShortage) return "Shortage (under-scanned)";
    return "All matched";
  }, [
    isItemsQtyDiscrepancy,
    itemScanExpectationLinesLive.length,
    itemInspectionSlipCells,
    itemInspectionEpOnlyQtyRows,
    itemInspectionDiscrepancyKinds,
  ]);

  const confirmItemsPhaseFinalizeToHub = useCallback(async () => {
    const discrepancy = isItemsQtyDiscrepancy;
    const totalExp = itemInspectionQtyBasisExpected;
    const totalScn = itemInspectionQtyBasisScanned;
    const pid = activePallet?.id?.trim() ?? "";
    const pkgId = itemScanPackageId && isUuidString(itemScanPackageId) ? itemScanPackageId : null;
    const oid = (orgId ?? "").trim();
    const store = sessionStoreId?.trim() ?? "";

    if (isSupabaseConfigured() && pkgId && oid && store) {
      setItemsFinalizeBusy(true);
      try {
        let packageUpdate: { notes?: string | null } = {};
        if (discrepancy) {
          const prior = boxNotesRef.current.trim();
          const autoLine = `System Auto-Note: Discrepancy found (Expected ${totalExp}, Scanned ${totalScn})`;
          const merged = prior ? `${prior}\n${autoLine}` : autoLine;
          packageUpdate = { notes: merged };
          setBoxNotes(merged);
          boxNotesRef.current = merged;
        }
        const res = await updateOperatorIntakeBoxPackageAction({
          requestedOrganizationId: oid,
          storeId: store,
          packageId: pkgId,
          palletId: pid && isUuidString(pid) ? pid : null,
          palletUpdate: null,
          packageUpdate,
          slipContents: { mode: "skip" },
        });
        if (!res.ok) {
          setSyncErrorToast(res.message ?? "Could not update package.");
          return;
        }
      } finally {
        setItemsFinalizeBusy(false);
      }
    } else if (discrepancy) {
      const prior = boxNotesRef.current.trim();
      const autoLine = `System Auto-Note: Discrepancy found (Expected ${totalExp}, Scanned ${totalScn})`;
      const merged = prior ? `${prior}\n${autoLine}` : autoLine;
      setBoxNotes(merged);
      boxNotesRef.current = merged;
    }

    resetItemInspectionForm();
    setItemScanPackageId(null);
    setItemScanPackageLabel(null);
    setReceivingSlipExpectedItemQtyTotal(null);
    setItemReceiveDemoScannedUnits(0);
    setItemReceiveCountSyncNonce(0);
    setExpectedPkgDetailRows([]);
    setItemScanExpectationSnapshotLines([]);
    setItemBarcodeMiss(null);
    setItemReceiveError(null);
    setCandidatePicker(null);
    setPackageItemScanState({ bySlipId: {}, unexpectedUnits: 0 });
    setPackageItemsHydrationNonce(0);
    setSlipLineCandidatePicker(null);
    setUnexpectedPackageItemModal(null);
    setItemOverscanWarning(null);
    setItemsBoxFinalizeModalOpen(false);
    setItemScanEditAllMode(false);
    setEditAllMode(false);
    modalOpenRef.current = false;
    setFlowPhase("scan");
    setPalletDocHydrationNonce((n) => n + 1);
    if (isSupabaseConfigured() && pid && isUuidString(pid)) {
      void loadPalletDetail(pid);
    }
    try {
      sessionStorage.setItem(
        "operatorMobile:hubToast",
        discrepancy
          ? "Box closed — item quantity discrepancies recorded for manager review."
          : "Box closed — item inspection complete.",
      );
    } catch {
      /* ignore */
    }
    playOperatorSuccessBeep();
    router.push(SCANNER_OPERATOR_HOME_PATH);
  }, [
    isItemsQtyDiscrepancy,
    itemInspectionQtyBasisScanned,
    itemInspectionQtyBasisExpected,
    itemScanPackageId,
    orgId,
    sessionStoreId,
    activePallet?.id,
    resetItemInspectionForm,
    loadPalletDetail,
    router,
  ]);

  const itemsIdentifierPerfect =
    Boolean(itemDraft && itemsLiveEpRow) &&
    Boolean(
      (() => {
        if (!itemDraft || !itemsLiveEpRow) return false;
        const tv = expectedRowValueForTier(itemsLiveEpRow, itemDraft.tier);
        return Boolean(tv && normScanToken(itemDraft.barcode) === normScanToken(tv));
      })(),
    );

  const itemsProductNamePerfect = Boolean(
    itemDraft?.catalogName?.trim() &&
      itemsLineForDraft?.productLabel?.trim() &&
      itemDraft.catalogName.trim() === itemsLineForDraft.productLabel.trim(),
  );

  /** Date field red state: Expired condition or catalog requires expiry. */
  const itemsExpiryFieldInvalid =
    (inspectionCondition === "expired" && !itemExpiryDate.trim()) ||
    (Boolean(itemDraft?.expirationSupported) && !itemExpiryDate.trim());

  const packageScanStickyCodeLabel =
    (activeBoxSession?.barcode ?? "").trim() ||
    (packageCodeCardOpen
      ? "Adding new box…"
      : operatorSavedBoxSearchAvailable
        ? "Find or add a box…"
        : (currentPackageTrackingId ?? "").trim() || "Pending Scan…");

  const hasPalletShippingLabelPhoto = shippingLabelPhotoUrls.some((u) => String(u ?? "").trim().length > 0);

  const isReadyForBoxScan =
    typeof physicalBoxCount === "number" &&
    physicalBoxCount > 0 &&
    parentIdentified &&
    hasPalletShippingLabelPhoto;

  /** Single Supabase write for pallet shipment-step fields (carrier, counts, photos). */
  const commitActivePalletRowAtSaveAndStart = useCallback(async (): Promise<
    { ok: true; palletId: string } | { ok: false; message: string }
  > => {
    const carrierToPersist = palletCarrier.trim();
    if (!carrierToPersist) {
      return { ok: false, message: "Carrier is required — select or enter a carrier." };
    }
    if (!shippingLabelPhotoUrls.some((u) => String(u ?? "").trim().length > 0)) {
      return { ok: false, message: "Upload at least one shipping label photo before continuing." };
    }
    const orderIdToPersist = palletOrderId.trim();
    const slipShip = slipBarcodeExtract?.shipmentId?.trim() ?? "";
    // Pallet parent tracking only (`pallets.tracking_number`); never carton scans.
    const fromPalletField = (currentPalletTrackingId ?? "").trim();
    const tracking = fromPalletField.length > 0 ? fromPalletField : slipShip.trim();
    const trackingPersist = tracking.length ? tracking : null;
    const boxCount =
      typeof physicalBoxCount === "number" && physicalBoxCount > 0 ? physicalBoxCount : null;

    if (!isSupabaseConfigured()) {
      const demoId = activePallet?.id?.trim() ?? "";
      parentPalletCarrierDefaultRef.current = carrierToPersist;
      await flushPendingEvidenceStorageDeletes();
      capturePalletEvidenceBaseline();
      return { ok: true, palletId: demoId };
    }

    if (!sessionStoreId) {
      return { ok: false, message: "Select a store before saving." };
    }

    let palletId = activePallet?.id && isUuidString(activePallet.id) ? activePallet.id : null;

    if (!palletId) {
      if (!tracking) {
        return { ok: false, message: "Missing tracking number — cannot save pallet." };
      }
      const palletNumForCreate = (activePallet?.pallet_number ?? "").trim() || tracking;
      const created = await createOperatorPalletAction({
        requestedOrganizationId: orgId,
        storeId: sessionStoreId,
        palletNumber: palletNumForCreate,
        trackingNumber: tracking,
        operatorPackageCount: boxCount,
      });
      if (!created.ok) {
        return { ok: false, message: created.error };
      }
      palletId = created.id;
      setActivePallet({
        id: created.id,
        pallet_number: created.pallet_number,
        carrier_name: carrierToPersist,
      });
    } else {
      const palletNumForPersist =
        (activePallet?.pallet_number ?? "").trim() || tracking || palletId;
      setActivePallet({
        id: palletId,
        pallet_number: palletNumForPersist,
        carrier_name: carrierToPersist,
        order_id: activePallet?.order_id ?? null,
      });
    }

    const persisted = await commitOperatorPalletShipmentStepAction({
      requestedOrganizationId: orgId,
      palletId,
      carrier_name: carrierToPersist,
      order_id: orderIdToPersist.length ? orderIdToPersist : null,
      operator_package_count: boxCount,
      tracking_number: trackingPersist,
      shipping_label_photo_urls: shippingLabelPhotoUrls,
      pallet_photo_urls: palletPhotoUrls,
      bol_photo_urls: bolPhotoUrls,
      notes: palletNotes.trim().length ? palletNotes.trim() : null,
    });

    if (!persisted.ok) return { ok: false, message: persisted.message };
    await flushPendingEvidenceStorageDeletes();
    capturePalletEvidenceBaseline();
    setPalletCreatedByLabel(persisted.creatorDisplayLabel.trim() || "Unknown");
    setPalletCreatedByProfileId(persisted.createdByUserId ?? null);
    parentPalletCarrierDefaultRef.current = carrierToPersist;
    return { ok: true, palletId };
  }, [
    palletCarrier,
    palletOrderId,
    slipBarcodeExtract?.shipmentId,
    currentPalletTrackingId,
    physicalBoxCount,
    activePallet?.id,
    activePallet?.pallet_number,
    shippingLabelPhotoUrls,
    palletPhotoUrls,
    bolPhotoUrls,
    orgId,
    sessionStoreId,
    palletNotes,
    flushPendingEvidenceStorageDeletes,
    capturePalletEvidenceBaseline,
  ]);

  const liveDbForShipmentUx = isSupabaseConfigured();
  const palletIdForShipmentUx = activePallet?.id?.trim() ?? "";
  const hasBackendPalletRow =
    liveDbForShipmentUx && Boolean(palletIdForShipmentUx) && isUuidString(palletIdForShipmentUx);

  const palletShipmentCommittedStorageKey =
    hasBackendPalletRow && orgId?.trim()
      ? `operatorMobile:palletShipmentCommitted:${orgId}:${palletIdForShipmentUx}`
      : null;

  const hasSessionShipmentCommit = useMemo(() => {
    if (!palletShipmentCommittedStorageKey || typeof window === "undefined") return false;
    try {
      return window.sessionStorage.getItem(palletShipmentCommittedStorageKey) === "1";
    } catch {
      return false;
    }
  }, [palletShipmentCommittedStorageKey, palletShipmentCommitVersion]);

  /** Backend pallet with no hydrated slip columns and no session commit (used for other UX only). */
  const isInitialDraftShipmentUx =
    hasBackendPalletRow && !palletDbHasShipmentDetails && !hasSessionShipmentCommit;

  /** Persisted pallet on receiving step: shipment strip read-only until Edit All (mirrors saved-box intake). */
  const palletShipmentViewLocked =
    flowPhase === "scan" &&
    parentIdentified &&
    hasBackendPalletRow &&
    isUuidString(palletIdForShipmentUx) &&
    !editAllMode;

  /** Carrier + Order ID (+ pallet photos / notes): demo / no row / Edit All; on scan with a UUID row, Edit All only. */
  const slipCarrierOrderEditable =
    editAllMode ||
    !liveDbForShipmentUx ||
    !hasBackendPalletRow ||
    (isInitialDraftShipmentUx && !palletShipmentViewLocked);

  /** Box count + Tracking ID: read-only until Edit All. */
  const boxCountEditable = editAllMode;
  const trackingIdEditable = editAllMode;

  /**
   * Saved UUID package on BOX intake: entire documentation strip is view-only until Edit All
   * (photos, carrier, reference — AI “Detected Items” table stays non-editable regardless).
   */
  const savedBoxIntakeViewLocked =
    flowPhase === "package_scan" &&
    parentIdentified &&
    Boolean(activeBoxSession) &&
    isUuidString((activeBoxSession?.packageId ?? "").trim()) &&
    !editAllMode;

  /**
   * On package_scan: carrier is read-only until a box session exists, or while a saved box is in view-only mode.
   */
  const boxIntakeCarrierReadOnly =
    flowPhase === "package_scan" && (!activeBoxSession || savedBoxIntakeViewLocked);

  /** Shipment Entry: Edit All appears on pallet step and on box (package) step — toggles tracking, counts, carrier/order locks. */
  const showShipmentEntryEditAll =
    isIdentified &&
    parentIdentified &&
    ((flowPhase === "scan" && Boolean(activePallet?.id?.trim())) ||
      (flowPhase === "package_scan" &&
        (Boolean(activePallet?.id?.trim()) || Boolean(directBox))));
  /** Box Info hub (+ Add New Box / saved-boxes filter): hide top Edit All; pallet scan step unchanged. */
  const operatorSavedBoxesHubVisible =
    operatorSavedBoxSearchAvailable &&
    !(packageCodeCardOpen && !activeBoxSession) &&
    !activeBoxSession;
  const showShipmentEntryEditAllInHeader =
    showShipmentEntryEditAll && !operatorSavedBoxesHubVisible;
  const showItemScanEditAllInHeader = flowPhase === "items" && hasItemReceivableBox;
  const showHeaderEditAllButton = showShipmentEntryEditAllInHeader || showItemScanEditAllInHeader;
  const headerEditAllActive = flowPhase === "items" ? itemScanEditAllMode : editAllMode;

  const itemScanEditPickUnits = useMemo(() => {
    if (!itemScanEditPick) return [];
    if (itemScanEditPick.kind === "slip_cell") {
      const slipContentId = String(itemScanEditPick.slipContentId ?? "").trim();
      if (!slipContentId) return [];
      return packageItemsForSlipContentId(packageItemHydratedRows, slipContentId);
    }
    if (itemScanEditPick.kind === "unexpected") {
      return packageItemsUnexpected(packageItemHydratedRows);
    }
    return [];
  }, [itemScanEditPick, packageItemHydratedRows]);

  const correctionSavedPackageId = useMemo(() => {
    const fromBox = (activeBoxSession?.packageId ?? "").trim();
    if (flowPhase === "package_scan" && isUuidString(fromBox)) return fromBox;
    const fromItems = (itemScanPackageId ?? "").trim();
    if (flowPhase === "items" && isUuidString(fromItems)) return fromItems;
    return null;
  }, [flowPhase, activeBoxSession?.packageId, itemScanPackageId]);

  const correctionPackageLabel = useMemo(() => {
    if (!correctionSavedPackageId) return "";
    const row = palletPackagePickerList.find((p) => p.id === correctionSavedPackageId);
    return (
      (row?.package_code ?? "").trim() ||
      (activeBoxSession?.barcode ?? "").trim() ||
      (itemScanPackageLabel ?? "").trim() ||
      correctionSavedPackageId
    );
  }, [
    correctionSavedPackageId,
    palletPackagePickerList,
    activeBoxSession?.barcode,
    itemScanPackageLabel,
  ]);

  const showCorrectionResetEntry = useMemo(() => {
    if (!editAllMode) return false;
    if (flowPhase === "package_scan") {
      if (activeBoxSession && !isUuidString((activeBoxSession.packageId ?? "").trim())) return true;
      if (packageCodeCardOpen && !activeBoxSession) return true;
    }
    if (flowPhase === "scan" && parentIdentified && isInitialDraftShipmentUx) return true;
    return false;
  }, [
    editAllMode,
    flowPhase,
    activeBoxSession,
    packageCodeCardOpen,
    parentIdentified,
    isInitialDraftShipmentUx,
  ]);

  const showCorrectionMoveBox =
    editAllMode && Boolean(correctionSavedPackageId) && correctionPerms.moveBox;
  const showCorrectionVoidBox =
    editAllMode && Boolean(correctionSavedPackageId) && correctionPerms.voidBox;
  const showCorrectionVoidPallet =
    editAllMode &&
    flowPhase === "scan" &&
    parentIdentified &&
    Boolean(activePallet?.id?.trim()) &&
    isUuidString((activePallet?.id ?? "").trim()) &&
    correctionPerms.voidBox;

  const handleConfirmStartBoxScan = useCallback(async () => {
    if (!parentIdentified) {
      setSyncErrorToast("Identify the pallet barcode first.");
      return;
    }
    if (typeof physicalBoxCount !== "number" || physicalBoxCount <= 0) {
      setPhysicalCountShakeSeq((s) => s + 1);
      setSyncErrorToast(
        boxCountEditable
          ? "Box count is missing — confirm it on the receiving step."
          : "Tap Edit All to adjust the box count.",
      );
      return;
    }

    if (typeof document !== "undefined") {
      const active = document.activeElement as HTMLElement | null;
      if (active && active !== document.body && typeof active.blur === "function") {
        const tag = active.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || active.isContentEditable) {
          active.blur();
        }
      }
    }

    const carrierToPersist = palletCarrier.trim();

    if (palletCarrierOtherSelected && carrierToPersist.length === 0) {
      setSyncErrorToast("Enter the carrier name (Other selected) before continuing.");
      const customInput = document.getElementById(
        `${formId}-pallet-carrier-custom`,
      ) as HTMLInputElement | null;
      customInput?.focus();
      return;
    }
    if (!carrierToPersist) {
      setSyncErrorToast("Select a carrier before continuing.");
      return;
    }

    if (!shippingLabelPhotoUrls.some((u) => String(u ?? "").trim().length > 0)) {
      setSyncErrorToast("Add at least one shipping label photo before continuing.");
      return;
    }

    if (
      expectedPackagesRawRowCount != null &&
      expectedPackagesRawRowCount > 0 &&
      physicalBoxCount !== expectedPackagesRawRowCount
    ) {
      console.warn("[operator-mobile] Box count vs expected_packages row count discrepancy", {
        physicalBoxCount,
        expectedPackagesRowCount: expectedPackagesRawRowCount,
      });
    }

    setConfirmSaving(true);
    try {
      commitPalletCarrierDraft(palletCarrier);
      const res = await commitActivePalletRowAtSaveAndStart();
      if (!res.ok) {
        setSyncErrorToast(res.message);
        return;
      }
      setActivePallet((p) => {
        if (!p || !isUuidString(res.palletId) || p.id !== res.palletId) return p;
        const c = palletCarrier.trim();
        return { ...p, carrier_name: c.length ? c : p.carrier_name };
      });
      if (orgId?.trim() && res.palletId && isUuidString(res.palletId)) {
        try {
          window.sessionStorage.setItem(
            `operatorMobile:palletShipmentCommitted:${orgId}:${res.palletId}`,
            "1",
          );
        } catch {
          /* ignore */
        }
        setPalletShipmentCommitVersion((v) => v + 1);
      }
      setBoxScanTargetDenominator(physicalBoxCount);
      setBoxIntakeError(null);
      setEditAllMode(false);
      setScanLine("");
      setCurrentPackageTrackingId(null);
      setDirectBox(false);
      setFlowPhase("package_scan");
      setPalletDocHydrationNonce((n) => n + 1);
    } finally {
      setConfirmSaving(false);
    }
  }, [
    parentIdentified,
    physicalBoxCount,
    expectedPackagesRawRowCount,
    palletCarrier,
    palletCarrierOtherSelected,
    commitActivePalletRowAtSaveAndStart,
    commitPalletCarrierDraft,
    formId,
    orgId,
    boxCountEditable,
    shippingLabelPhotoUrls,
  ]);
  const boxScanDocumentationLocked =
    flowPhase === "package_scan" && parentIdentified && !activeBoxSession;
  const showBoxIntakeShipmentDocumentation =
    flowPhase === "package_scan" && directBox;
  const directBoxShipmentLabelUploaded = shippingLabelPhotoUrls.some(
    (u) => String(u ?? "").trim().length > 0,
  );
  const directBoxShipmentDocsSubtitle = directBoxShipmentLabelUploaded
    ? "Shipment documents saved"
    : "Required for direct box intake";
  /** BOX intake reference fields: Order / RMA / notes — locked for saved UUID boxes until Edit All; editable for drafts. */
  const boxIntakeReferenceEditable =
    !activeBoxSession
      ? slipCarrierOrderEditable && !boxScanDocumentationLocked
      : !savedBoxIntakeViewLocked && !boxScanDocumentationLocked;
  const canSaveBoxScan =
    !boxScanDocumentationLocked &&
    Boolean(activeBoxSession?.barcode?.trim()) &&
    !busy &&
    !boxSaveBusy &&
    !boxSlipVisionBusy &&
    !boxSlipInvalidFormatBlocksSave &&
    Boolean(palletCarrier.trim()) &&
    (!showBoxIntakeShipmentDocumentation ||
      shippingLabelPhotoUrls.some((u) => String(u ?? "").trim().length > 0)) &&
    slipBoxPhotoUrls.some((u) => String(u ?? "").trim().length > 0) &&
    (!isSupabaseConfigured() || Boolean(sessionStoreId)) &&
    !duplicatePackingSlip;
  /** Primary CTA: save current box and go to items, or resume items when a box is already saved. */
  const canContinueToItemInspection =
    (Boolean(activeBoxSession) && canSaveBoxScan) ||
    (!activeBoxSession && Boolean((itemScanPackageId ?? "").trim())) ||
    (Boolean(activeBoxSession?.packageId) &&
      Boolean(itemScanPackageId) &&
      activeBoxSession?.packageId === itemScanPackageId &&
      isUuidString(itemScanPackageId));

  /** Persisted pallet changed on receiving step — start in locked shipment view (Edit All off). */
  useEffect(() => {
    if (flowPhase !== "scan" || !parentIdentified) return;
    const id = activePallet?.id?.trim() ?? "";
    if (!isUuidString(id)) {
      lastPalletIdForViewLockResetRef.current = id.length ? id : null;
      return;
    }
    if (lastPalletIdForViewLockResetRef.current !== id) {
      lastPalletIdForViewLockResetRef.current = id;
      setEditAllMode(false);
    }
  }, [flowPhase, parentIdentified, activePallet?.id]);

  /** Snapshot header tracking + shipment fields when Edit All enables pallet edits (duplicate-check revert). */
  useEffect(() => {
    if (!trackingIdEditable || flowPhase !== "scan") return;
    palletTrackingEditBaselineRef.current =
      (currentPalletTrackingId ?? "").trim() || (activePallet?.pallet_number ?? "").trim();
    palletShipmentFieldsBaselineRef.current = {
      orderId: palletOrderIdRef.current.trim(),
      carrier: palletCarrierRef.current.trim(),
    };
  }, [trackingIdEditable, flowPhase, currentPalletTrackingId, activePallet?.pallet_number]);

  const handlePalletHeaderTrackingBlur = useCallback(
    async (trimmed: string) => {
      const t = trimmed.trim();
      if (!t || !isSupabaseConfigured() || !orgId?.trim() || !sessionStoreId) return;
      const selfId = activePallet?.id?.trim();
      if (!isUuidString(selfId ?? "")) return;
      const dupRes = await findOperatorPalletByTrackingNumberAction(orgId, t, sessionStoreId);
      if (!dupRes.ok) {
        setSyncErrorToast(dupRes.error);
        const b = palletTrackingEditBaselineRef.current.trim();
        setCurrentPalletTrackingId(b.length ? b : null);
        return;
      }
      if (dupRes.wrongStore) {
        setSyncErrorToast(dupRes.wrongStoreMessage ?? "That tracking belongs to another store.");
        const b = palletTrackingEditBaselineRef.current.trim();
        setCurrentPalletTrackingId(b.length ? b : null);
        return;
      }
      const hitId = dupRes.pallet?.id != null ? String(dupRes.pallet.id).trim() : "";
      if (hitId && isUuidString(hitId) && hitId !== selfId) {
        setSyncErrorToast("That tracking is already on another pallet in this store.");
        const b = palletTrackingEditBaselineRef.current.trim();
        setCurrentPalletTrackingId(b.length ? b : null);
      }
    },
    [orgId, sessionStoreId, activePallet?.id],
  );

  const palletRegisteredBoxCount = palletPackagePickerList.length;
  const visionSlipExpectedQtySum = useMemo(
    () =>
      boxSlipVisionLines.reduce(
        (s, line) => s + Math.max(0, Math.floor(Number(line.expected_qty ?? 0))),
        0,
      ),
    [boxSlipVisionLines],
  );
  const palletDashboardScannedBoxCount =
    isSupabaseConfigured() &&
    (flowPhase === "scan" || flowPhase === "package_scan") &&
    isUuidString((activePallet?.id ?? "").trim())
      ? palletRegisteredBoxCount
      : scannedBoxesSavedCount;
  /** Newest first from DB (`listOperatorPackagesForPalletAction`); filter only when the operator types. */
  const palletPackagePickerFiltered = useMemo(() => {
    const rows = [...palletPackagePickerList];
    const parseTs = (u: unknown) => {
      if (typeof u !== "string" || !u.trim()) return 0;
      const t = Date.parse(u);
      return Number.isFinite(t) ? t : 0;
    };
    rows.sort((a, b) => parseTs(b.updated_at) - parseTs(a.updated_at));
    const q = palletPackagePickerQuery.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((p) => {
      const hay = [
        String(p.package_code ?? ""),
        String(p.tracking_number ?? ""),
        String(p.order_id ?? ""),
        String(p.id_slip_contents ?? ""),
      ]
        .join("\n")
        .toLowerCase();
      return hay.includes(q);
    });
  }, [palletPackagePickerList, palletPackagePickerQuery]);

  const palletShowsMixedOrderIdsFromData = useMemo(() => {
    const db = palletDbOrderId.trim().toLowerCase();
    const distinct = new Set<string>();
    for (const r of palletPackagePickerList) {
      const o = String(r.order_id ?? "").trim();
      if (o) distinct.add(o.toLowerCase());
    }
    const arr = [...distinct];
    if (arr.length > 1) return true;
    if (arr.length === 1 && db && arr[0] !== db) return true;
    return false;
  }, [palletDbOrderId, palletPackagePickerList]);

  const palletMixedOrderIdsUi = palletMixedOrderIdsWarning || palletShowsMixedOrderIdsFromData;

  /** Display order: DB hydrate → barcode resolve → active pallet snapshot (never operator draft). */
  const palletIdentityOrderId =
    palletDbOrderId.trim() ||
    palletResolvedOrderId.trim() ||
    String(activePallet?.order_id ?? "").trim();

  const boxSlipConflictReferenceLine = useMemo(() => {
    const slip = boxSlipOrderId.trim();
    const conf = boxSlipConflictingOrderId.trim();
    if (!slip || !conf || slip.toLowerCase() === conf.toLowerCase()) return "";
    const pallet = palletIdentityOrderId.trim() || "—";
    return `⚠️ Conflict: Slip belongs to ${slip}, but Pallet is ${pallet}.`;
  }, [boxSlipConflictingOrderId, boxSlipOrderId, palletIdentityOrderId]);

  useEffect(() => {
    palletMixedOrderIdsUiRef.current = palletMixedOrderIdsUi;
  }, [palletMixedOrderIdsUi]);

  useEffect(() => {
    if (palletShowsMixedOrderIdsFromData) setPalletMixedOrderIdsWarning(false);
  }, [palletShowsMixedOrderIdsFromData]);

  const palletOrderIdFieldColor = palletMixedOrderIdsUi ? AMBER_MIXED_ORDER : TEXT_PRIMARY;

  const packageScanOrderIdConflictHighlight = Boolean(
    boxSlipOrderId.trim() &&
      boxSlipConflictingOrderId.trim() &&
      boxSlipOrderId.trim().toLowerCase() !== boxSlipConflictingOrderId.trim().toLowerCase(),
  );
  const packageScanOrderIdInputColor = packageScanOrderIdConflictHighlight
    ? AMBER_MIXED_ORDER
    : palletOrderIdFieldColor;

  const boxProgressExpectedY =
    boxScanTargetDenominator != null
      ? boxScanTargetDenominator
      : typeof physicalBoxCount === "number" && physicalBoxCount > 0
        ? physicalBoxCount
        : 0;
  /** Single source for “boxes completed” (matches 3-up Scanned tile). */
  const palletBoxesCompletedUnified = Math.min(
    palletDashboardScannedBoxCount,
    Math.max(boxProgressExpectedY, 0),
  );

  const handlePickExistingPalletPackage = useCallback(
    (p: OperatorPackageListRow) => {
      const code = String(p.package_code ?? "").trim();
      if (!code) {
        setBoxIntakeError("This package has no package code — fix the record before resuming.");
        return;
      }
      if (activeBoxSession) {
        setBoxIntakeError("Finish or save the current box before opening another.");
        return;
      }
      setBoxIntakeError(null);
      if (operatorPackageShouldResumeItemScan(p)) {
        void maybeResumeItemScanAfterPackageRowRef.current?.(p as unknown as Record<string, unknown>);
        palletPackageSearchInputRef.current?.blur();
        return;
      }
      // Synchronously pre-fill photos from cached picker row so UI shows immediately
      // while the full async reload (vision lines, slip code, notes) completes in the background.
      const o = normalizePalletDocumentationImageUrls(parsePalletPhotoUrlArray(p.outside_photo_urls), supabase);
      const ins = normalizePalletDocumentationImageUrls(parsePalletPhotoUrlArray(p.inside_photo_urls), supabase);
      const s = normalizePalletDocumentationImageUrls(parsePalletPhotoUrlArray(p.slip_photo_urls), supabase);
      setOutsideBoxPhotoUrls(o);
      setInsideBoxPhotoUrls(ins);
      setSlipBoxPhotoUrls(s);
      outsideBoxPhotoUrlsRef.current = [...o];
      insideBoxPhotoUrlsRef.current = [...ins];
      slipBoxPhotoUrlsRef.current = [...s];
      pendingEvidenceStorageDeletesRef.current.clear();
      setBoxSlipInvalidFormatBlocksSave(false);
      clearBoxSlipVisionLinesState();
      setBoxNotes(normBoxScalar(p.notes));
      const slipCodeRow = normBoxScalar(p.id_slip_contents);
      setBoxSlipCode(slipCodeRow);
      boxSlipCodeRef.current = slipCodeRow;
      setPalletPackagePickerQuery("");
      setPackageCodeCardOpen(false);
      setCurrentPackageTrackingId(code);
      setReceivingSlipExpectedItemQtyTotal(null);
      setEditAllMode(false);
      boxIntakeBaselineReadyRef.current = false;
      setActiveBoxSession({ barcode: code, packageId: p.id });
      hydrateBoxPackageIdRef.current = p.id;
      // Bump nonce to trigger full async reload (refreshes vision lines, notes, fields from DB)
      setBoxHydrateNonce((n) => n + 1);
      setIntakeToast("Loaded saved box — review photos and slip lines, then save.");
      palletPackageSearchInputRef.current?.blur();
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => {
          operatorMobileMainScrollRef.current?.scrollTo({ top: 0, behavior: "smooth" });
        });
      });
    },
    [activeBoxSession, clearBoxSlipVisionLinesState],
  );

  const closeActiveBoxPackageSession = useCallback(() => {
    const b = evidenceBaselineRef.current;
    const slip = [...slipBoxPhotoUrlsRef.current];
    const out = [...outsideBoxPhotoUrlsRef.current];
    const ins = [...insideBoxPhotoUrlsRef.current];
    const orphanCandidates = [...slip, ...out, ...ins].filter((u) => {
      const s = String(u ?? "").trim();
      if (!/^https?:\/\//i.test(s) || !isPersistableStoredMediaReference(s)) return false;
      return !b.slip.includes(s) && !b.outside.includes(s) && !b.inside.includes(s);
    });
    pendingEvidenceStorageDeletesRef.current.clear();
    const oid = (orgId ?? "").trim();
    if (isSupabaseConfigured() && oid && orphanCandidates.length) {
      void deleteOperatorEvidenceStorageByPublicUrlsAction(oid, orphanCandidates).then((res) => {
        if (!res.ok) console.warn("[operator-mobile] box session abandon orphan delete:", res.error);
      });
    }
    setActiveBoxSession(null);
    setCurrentPackageTrackingId(null);
    setPackageCodeCardOpen(false);
    setPalletPackagePickerQuery("");
    setBoxIntakeError(null);
    setDuplicatePackingSlip(null);
    setBoxSlipInvalidFormatBlocksSave(false);
    hydrateBoxPackageIdRef.current = null;
    boxIntakeBaselineReadyRef.current = true;
    clearOperatorPhotoArrays(["outside", "inside", "slip"]);
    setBoxSlipCode("");
    setBoxSlipRma("");
    clearPalletOrderIdIfAutoFilledFromRa();
    clearBoxSlipVisionLinesState();
    setBoxNotes("");
    boxNotesBaselineRef.current = "";
    boxIntakeFieldsBaselineRef.current = { slipCode: "", rma: "", orderId: "", carrier: "" };
    scheduleFocusScanner();
  }, [
    scheduleFocusScanner,
    clearBoxSlipVisionLinesState,
    orgId,
    clearPalletOrderIdIfAutoFilledFromRa,
    clearOperatorPhotoArrays,
  ]);

  const resumeItemScanForPackage = useCallback(
    (p: OperatorPackageListRow) => {
      const pkgId = String(p.id ?? "").trim();
      const code = String(p.package_code ?? "").trim();
      if (!pkgId || !isUuidString(pkgId)) return false;
      closeActiveBoxPackageSession();
      setItemScanPackageId(pkgId);
      setItemScanPackageLabel(code || null);
      const exp =
        typeof p.expected_item_count === "number" && Number.isFinite(p.expected_item_count)
          ? Math.floor(p.expected_item_count)
          : null;
      setReceivingSlipExpectedItemQtyTotal(exp != null && exp > 0 ? exp : null);
      resetItemInspectionForm();
      setItemBarcodeMiss(null);
      setItemReceiveError(null);
      setCandidatePicker(null);
      setSlipLineCandidatePicker(null);
      setUnexpectedPackageItemModal(null);
      setItemOverscanWarning(null);
      setPackageItemScanState({ bySlipId: {}, unexpectedUnits: 0 });
      setPackageItemsHydrationNonce((n) => n + 1);
      setItemReceiveCountSyncNonce((n) => n + 1);
      setFlowPhase("items");
      setIsIdentified(true);
      scheduleFocusScanner();
      return true;
    },
    [closeActiveBoxPackageSession, resetItemInspectionForm, scheduleFocusScanner],
  );

  const maybeResumeItemScanAfterPackageRow = useCallback(
    async (
      row: Record<string, unknown>,
      opts?: { directBox?: boolean },
    ): Promise<boolean> => {
      const pkgId = String(row.id ?? "").trim();
      if (!pkgId || !isUuidString(pkgId)) return false;
      let mergedRow = row;
      let pickerRow = operatorPackageListRowFromRecord(row);
      const palletId = String(row.pallet_id ?? "").trim();
      const directBox =
        opts?.directBox ?? !(palletId && isUuidString(palletId));

      const needsSupplementalFetch =
        isSupabaseConfigured() &&
        (mergedRow.manifest_data == null ||
          (pickerRow.expected_item_count == null && pickerRow.actual_item_count == null));
      if (needsSupplementalFetch) {
        try {
          const { data } = await supabase
            .from("packages")
            .select(
              "expected_item_count, actual_item_count, notes, outside_photo_urls, inside_photo_urls, slip_photo_urls, manifest_data, carrier_name, id_slip_contents, pallet_id",
            )
            .eq("id", pkgId)
            .maybeSingle();
          if (data && typeof data === "object") {
            mergedRow = { ...mergedRow, ...(data as Record<string, unknown>) };
            pickerRow = {
              ...pickerRow,
              ...operatorPackageListRowFromRecord(data as Record<string, unknown>),
              id: pkgId,
            };
          }
        } catch {
          /* resume heuristic fields optional */
        }
      }

      if (!shouldResumePackageToItemScan({ row: mergedRow, pickerRow, directBox })) return false;
      resumeItemScanForPackage(pickerRow);
      setIntakeToast("Resuming item scan where you left off.");
      return true;
    },
    [resumeItemScanForPackage],
  );

  useEffect(() => {
    maybeResumeItemScanAfterPackageRowRef.current = maybeResumeItemScanAfterPackageRow;
  }, [maybeResumeItemScanAfterPackageRow]);

  /** Leave Item Scan in progress — scanned units already persisted; no discrepancy note. */
  const confirmItemsPhaseSaveAndExit = useCallback(() => {
    itemScanSlipCarryoverRef.current = null;
    setItemScanSlipCarryover(null);
    resetItemInspectionForm();
    setItemScanPackageId(null);
    setItemScanPackageLabel(null);
    setReceivingSlipExpectedItemQtyTotal(null);
    setItemReceiveDemoScannedUnits(0);
    setItemReceiveCountSyncNonce(0);
    setExpectedPkgDetailRows([]);
    setItemScanExpectationSnapshotLines([]);
    setItemBarcodeMiss(null);
    setItemReceiveError(null);
    setCandidatePicker(null);
    setPackageItemScanState({ bySlipId: {}, unexpectedUnits: 0 });
    setPackageItemHydratedRows([]);
    setPackageItemsHydrating(false);
    setPackageItemsHydrationNonce(0);
    setSlipLineCandidatePicker(null);
    setUnexpectedPackageItemModal(null);
    setItemOverscanWarning(null);
    setItemsBoxFinalizeModalOpen(false);
    setItemScanEditAllMode(false);
    setEditAllMode(false);
    modalOpenRef.current = false;
    closeActiveBoxPackageSession();
    setScanLine("");
    setSlipBarcodeExtract(null);
    setFlowPhase("scan");
    setIsIdentified(false);
    completedShipmentDialogShownForKeyRef.current = null;
    setCompletedShipmentModal(null);
    clearPreviousLookupResult({ clearResolvedContext: true, phase: "idle" });
    setIntakeToast("Progress saved. You can continue later.");
    scheduleFocusScanner();
  }, [
    resetItemInspectionForm,
    closeActiveBoxPackageSession,
    clearPreviousLookupResult,
    scheduleFocusScanner,
  ]);

  const hasUnsavedLegacyItemInspectionDraft = useCallback(() => {
    if (!itemDraft) return false;
    if (inspectionCondition !== "good") return true;
    if (itemNotes.trim()) return true;
    if (itemExpiryDate.trim()) return true;
    if (itemBatch.trim()) return true;
    if (itemQtyStepper !== 1) return true;
    if (itemPhotoFrontUrl || itemPhotoBarcodeUrl || itemPhotoDamageUrl) return true;
    return false;
  }, [
    itemDraft,
    inspectionCondition,
    itemNotes,
    itemExpiryDate,
    itemBatch,
    itemQtyStepper,
    itemPhotoFrontUrl,
    itemPhotoBarcodeUrl,
    itemPhotoDamageUrl,
  ]);

  const hasUnsavedPalletShipmentEdits = useCallback((): { dirty: boolean; reason?: string } => {
    if (!isIdentified || flowPhase !== "scan" || !editAllMode) return { dirty: false };
    const b = evidenceBaselineRef.current;
    if (operatorEvidenceUrlArraysChanged(shippingLabelPhotoUrlsRef.current, b.shipping)) {
      return { dirty: true, reason: "shipping_label_photos" };
    }
    if (operatorEvidenceUrlArraysChanged(palletPhotoUrlsRef.current, b.pallet)) {
      return { dirty: true, reason: "pallet_photos" };
    }
    if (operatorEvidenceUrlArraysChanged(bolPhotoUrlsRef.current, b.bol)) {
      return { dirty: true, reason: "bol_photos" };
    }
    if (palletNotes.trim() !== palletNotesBaselineRef.current) {
      return { dirty: true, reason: "pallet_notes" };
    }
    const cur = (currentPalletTrackingId ?? "").trim();
    const base = palletTrackingEditBaselineRef.current.trim();
    if (cur !== base) return { dirty: true, reason: "tracking" };
    const shipBase = palletShipmentFieldsBaselineRef.current;
    if (palletOrderIdRef.current.trim() !== shipBase.orderId) {
      return { dirty: true, reason: "order_id" };
    }
    if (palletCarrierRef.current.trim() !== shipBase.carrier) {
      return { dirty: true, reason: "carrier" };
    }
    return { dirty: false };
  }, [isIdentified, flowPhase, editAllMode, palletNotes, currentPalletTrackingId]);

  const debugLogBoxIntakeDirtyState = useCallback(
    (result: { dirty: boolean; reason?: string }) => {
      if (!SCANNER_BACK_DEBUG) return;
      const b = evidenceBaselineRef.current;
      const fieldBaseline = boxIntakeFieldsBaselineRef.current;
      const reasons: string[] = [];
      if (!boxIntakeBaselineReadyRef.current) reasons.push("baseline_not_ready");
      if (operatorEvidenceUrlArraysChanged(slipBoxPhotoUrlsRef.current, b.slip)) reasons.push("slip_photos");
      if (operatorEvidenceUrlArraysChanged(outsideBoxPhotoUrlsRef.current, b.outside)) {
        reasons.push("outside_photos");
      }
      if (operatorEvidenceUrlArraysChanged(insideBoxPhotoUrlsRef.current, b.inside)) {
        reasons.push("inside_photos");
      }
      if (directBox && operatorEvidenceUrlArraysChanged(shippingLabelPhotoUrlsRef.current, b.shipping)) {
        reasons.push("shipping_label_photos");
      }
      if (directBox && operatorEvidenceUrlArraysChanged(bolPhotoUrlsRef.current, b.bol)) {
        reasons.push("bol_photos");
      }
      if (normBoxScalar(boxNotesRef.current) !== normBoxScalar(boxNotesBaselineRef.current)) {
        reasons.push("box_notes");
      }
      if (normBoxScalar(boxSlipCodeRef.current) !== normBoxScalar(fieldBaseline.slipCode)) {
        reasons.push("slip_code");
      }
      if (normBoxScalar(boxSlipRmaRef.current) !== normBoxScalar(fieldBaseline.rma)) reasons.push("rma");
      if (normBoxScalar(palletOrderIdRef.current) !== normBoxScalar(fieldBaseline.orderId)) {
        reasons.push("order_id");
      }
      if (normBoxScalar(palletCarrierRef.current) !== normBoxScalar(fieldBaseline.carrier)) {
        reasons.push("carrier");
      }
      const visionCurrent = clonePersistBoxSlipVisionLines(boxSlipVisionLines);
      const visionBaseline = boxSlipVisionLinesPersistRef.current;
      if (JSON.stringify(visionCurrent) !== JSON.stringify(visionBaseline)) {
        reasons.push("slip_vision_lines");
      }
      console.log("[box-dirty-debug]", {
        flowPhase,
        packageId: (activeBoxSession?.packageId ?? "").trim() || null,
        directBox,
        parentPalletId: (activePallet?.id ?? "").trim() || null,
        baselineReady: boxIntakeBaselineReadyRef.current,
        hasUnsavedBoxIntakeEdits: result,
        dirtyReasons: reasons,
        packageCodeCardOpen,
        palletPackagePickerQuery: palletPackagePickerQuery.trim(),
        currentPackageTrackingId: (currentPackageTrackingId ?? "").trim() || null,
        fields: {
          slipCode: { current: normBoxScalar(boxSlipCodeRef.current), baseline: fieldBaseline.slipCode },
          rma: { current: normBoxScalar(boxSlipRmaRef.current), baseline: fieldBaseline.rma },
          orderId: { current: normBoxScalar(palletOrderIdRef.current), baseline: fieldBaseline.orderId },
          carrier: { current: normBoxScalar(palletCarrierRef.current), baseline: fieldBaseline.carrier },
          notes: { current: normBoxScalar(boxNotesRef.current), baseline: boxNotesBaselineRef.current },
        },
        photos: {
          slip: { current: slipBoxPhotoUrlsRef.current, baseline: b.slip },
          outside: { current: outsideBoxPhotoUrlsRef.current, baseline: b.outside },
          inside: { current: insideBoxPhotoUrlsRef.current, baseline: b.inside },
          shipping: directBox
            ? { current: shippingLabelPhotoUrlsRef.current, baseline: b.shipping }
            : "ignored_non_direct_box",
          bol: directBox ? { current: bolPhotoUrlsRef.current, baseline: b.bol } : "ignored_non_direct_box",
        },
        slipVisionLines: { current: visionCurrent, baseline: visionBaseline },
        newBoxSession: !isUuidString((activeBoxSession?.packageId ?? "").trim()),
      });
    },
    [
      flowPhase,
      activeBoxSession,
      directBox,
      activePallet?.id,
      boxSlipVisionLines,
      packageCodeCardOpen,
      palletPackagePickerQuery,
      currentPackageTrackingId,
    ],
  );

  const hasUnsavedBoxIntakeEdits = useCallback((): { dirty: boolean; reason?: string } => {
    if (flowPhase !== "package_scan" || !editAllMode) return { dirty: false };
    if (!activeBoxSession) return { dirty: false };
    const sessionPackageId = (activeBoxSession.packageId ?? "").trim();
    if (!isUuidString(sessionPackageId)) return { dirty: false };
    if (!boxIntakeBaselineReadyRef.current) return { dirty: false };
    const b = evidenceBaselineRef.current;
    if (operatorEvidenceUrlArraysChanged(slipBoxPhotoUrlsRef.current, b.slip)) {
      return { dirty: true, reason: "slip_photos" };
    }
    if (operatorEvidenceUrlArraysChanged(outsideBoxPhotoUrlsRef.current, b.outside)) {
      return { dirty: true, reason: "outside_photos" };
    }
    if (operatorEvidenceUrlArraysChanged(insideBoxPhotoUrlsRef.current, b.inside)) {
      return { dirty: true, reason: "inside_photos" };
    }
    if (directBox) {
      if (operatorEvidenceUrlArraysChanged(shippingLabelPhotoUrlsRef.current, b.shipping)) {
        return { dirty: true, reason: "shipping_label_photos" };
      }
      if (operatorEvidenceUrlArraysChanged(bolPhotoUrlsRef.current, b.bol)) {
        return { dirty: true, reason: "bol_photos" };
      }
    }
    if (normBoxScalar(boxNotesRef.current) !== normBoxScalar(boxNotesBaselineRef.current)) {
      return { dirty: true, reason: "box_notes" };
    }
    const fieldBaseline = boxIntakeFieldsBaselineRef.current;
    if (normBoxScalar(boxSlipCodeRef.current) !== normBoxScalar(fieldBaseline.slipCode)) {
      return { dirty: true, reason: "slip_code" };
    }
    if (normBoxScalar(boxSlipRmaRef.current) !== normBoxScalar(fieldBaseline.rma)) {
      return { dirty: true, reason: "rma" };
    }
    if (normBoxScalar(palletOrderIdRef.current) !== normBoxScalar(fieldBaseline.orderId)) {
      return { dirty: true, reason: "order_id" };
    }
    if (normBoxScalar(palletCarrierRef.current) !== normBoxScalar(fieldBaseline.carrier)) {
      return { dirty: true, reason: "carrier" };
    }
    const visionCurrent = clonePersistBoxSlipVisionLines(boxSlipVisionLines);
    const visionBaseline = boxSlipVisionLinesPersistRef.current;
    if (JSON.stringify(visionCurrent) !== JSON.stringify(visionBaseline)) {
      return { dirty: true, reason: "slip_vision_lines" };
    }
    return { dirty: false };
  }, [flowPhase, activeBoxSession, directBox, boxSlipVisionLines, editAllMode]);

  const hasUnsavedIdentifyGateEdits = useCallback((): { dirty: boolean; reason?: string } => {
    if (identifyGatePhase === "idle") return { dirty: false };
    if (identifyGatePhase === "searching" || identifyGateDeepSearchRunning) {
      return { dirty: true, reason: "gate_search_in_progress" };
    }
    if (scanLine.trim()) return { dirty: true, reason: "scan_line" };
    if (manualOpen && scanLine.trim()) return { dirty: true, reason: "manual_entry" };
    if (identifyGatePhysicalBoxStr.trim() && (identifyGatePhase === "matched" || identifyGatePhase === "new")) {
      return { dirty: true, reason: "gate_box_count" };
    }
    if (identifyGatePhotoOcrCandidates.length > 0 || identifyGateSelectedPhotoOcrCandidate) {
      return { dirty: true, reason: "gate_photo_ocr" };
    }
    return { dirty: false };
  }, [
    identifyGatePhase,
    identifyGateDeepSearchRunning,
    scanLine,
    manualOpen,
    identifyGatePhysicalBoxStr,
    identifyGatePhotoOcrCandidates.length,
    identifyGateSelectedPhotoOcrCandidate,
  ]);

  const hasUnsavedItemScanModalDraft = useCallback((): { dirty: boolean; reason?: string } => {
    if (itemUnitModal && itemUnitModalDraftDirtyRef.current) {
      return { dirty: true, reason: "item_unit_modal" };
    }
    if (unexpectedPackageItemModal) {
      return { dirty: true, reason: "unexpected_item_modal" };
    }
    if (candidatePicker || slipLineCandidatePicker) {
      return { dirty: true, reason: "item_line_picker" };
    }
    if (manualOpen && scanLine.trim()) {
      return { dirty: true, reason: "manual_entry" };
    }
    if (hasUnsavedLegacyItemInspectionDraft()) {
      return { dirty: true, reason: "legacy_item_draft" };
    }
    return { dirty: false };
  }, [
    itemUnitModal,
    unexpectedPackageItemModal,
    candidatePicker,
    slipLineCandidatePicker,
    manualOpen,
    scanLine,
    hasUnsavedLegacyItemInspectionDraft,
  ]);

  const hasEditModeUnsavedChanges = useCallback((): { dirty: boolean; reason?: string } => {
    if (flowPhase === "items") {
      const modalEdit =
        itemUnitModal?.mode === "edit" && itemUnitModalDraftDirtyRef.current;
      if (modalEdit) return { dirty: true, reason: "item_unit_modal_edit" };
      if (itemScanEditAllMode) return hasUnsavedItemScanModalDraft();
      return { dirty: false };
    }
    if (!editAllMode) return { dirty: false };
    if (flowPhase === "scan" && isIdentified) return hasUnsavedPalletShipmentEdits();
    if (flowPhase === "package_scan") return hasUnsavedBoxIntakeEdits();
    return { dirty: false };
  }, [
    flowPhase,
    editAllMode,
    itemScanEditAllMode,
    itemUnitModal,
    isIdentified,
    hasUnsavedPalletShipmentEdits,
    hasUnsavedBoxIntakeEdits,
    hasUnsavedItemScanModalDraft,
  ]);

  const dismissItemScanModalDrafts = useCallback(() => {
    modalOpenRef.current = false;
    itemUnitModalDraftDirtyRef.current = false;
    setItemUnitModal(null);
    setCandidatePicker(null);
    setSlipLineCandidatePicker(null);
    setUnexpectedPackageItemModal(null);
    setManualOpen(false);
    manualEntryModeRef.current = false;
  }, []);

  const requestScannerLeaveConfirm = useCallback((action: () => void) => {
    scannerLeavePendingActionRef.current = action;
    modalOpenRef.current = true;
    setScannerLeaveConfirmOpen(true);
  }, []);

  const runScannerLeavePendingAction = useCallback(() => {
    const action = scannerLeavePendingActionRef.current;
    scannerLeavePendingActionRef.current = null;
    setScannerLeaveConfirmOpen(false);
    modalOpenRef.current = false;
    action?.();
  }, []);

  const returnFromPackageScanToShipmentSearch = useCallback(() => {
    if (activePallet?.id?.trim()) {
      setDirectBox(false);
      reloadPalletIntake();
    }
    setFlowPhase("scan");
    scheduleFocusScanner();
  }, [activePallet?.id, scheduleFocusScanner, reloadPalletIntake]);

  const resetToInitialShipmentEntry = useCallback(() => {
    closeActiveBoxPackageSession();
    clearOperatorPhotoArrays(["shipping", "bol", "outside", "inside", "slip"]);
    setPalletPhotoUrls([]);
    palletPhotoUrlsRef.current = [];
    evidenceBaselineRef.current.pallet = [];
    evidenceBaselineRef.current.shipping = [];
    evidenceBaselineRef.current.bol = [];
    pendingEvidenceStorageDeletesRef.current.clear();
    hydrateActivePalletIdRef.current = null;
    hydrateBoxPackageIdRef.current = null;

    setEditAllMode(false);
    setPackageCodeCardOpen(false);
    setModernPalletWorkspace(false);
    setActiveSlipOrPackage(null);
    setActivePallet(null);
    setActiveTracking(null);
    setCurrentPalletTrackingId(null);
    setCurrentPackageTrackingId(null);
    setDirectBox(false);
    setPhysicalBoxCount(null);
    setBoxScanTargetDenominator(null);
    setScannedBoxesSavedCount(0);
    setPalletCarrier("");
    setPalletCarrierOtherSelected(false);
    setPalletOrderId("");
    setPalletDbOrderId("");
    setPalletResolvedOrderId("");
    setPalletNotes("");
    setPalletDbHasShipmentDetails(false);
    setPalletCreatedByLabel(null);
    setPalletCreatedByProfileId(null);
    setPalletCreatedAtIso(null);
    lastOrderIdAutoFilledFromRaRef.current = null;
    parentPalletCarrierDefaultRef.current = "";

    resetItemInspectionForm();
    setItemScanPackageId(null);
    setItemScanPackageLabel(null);
    setReceivingSlipExpectedItemQtyTotal(null);
    setItemReceiveDemoScannedUnits(0);
    setItemReceivePackageActualCount(null);
    setItemReceiveCountSyncNonce(0);
    setExpectedPkgDetailRows([]);
    setCandidatePicker(null);
    setItemBarcodeMiss(null);
    modalOpenRef.current = false;
    setPackageItemScanState({ bySlipId: {}, unexpectedUnits: 0 });
    setPackageItemHydratedRows([]);
    setPackageItemsHydrating(false);
    setPackageItemsHydrationNonce(0);

    setScanLine("");
    setSlipBarcodeExtract(null);
    setFlowPhase("scan");
    setIsIdentified(false);
    completedShipmentDialogShownForKeyRef.current = null;
    setCompletedShipmentModal(null);
    clearPreviousLookupResult({ clearResolvedContext: true, phase: "idle" });
    scheduleFocusScanner();
  }, [
    closeActiveBoxPackageSession,
    clearOperatorPhotoArrays,
    resetItemInspectionForm,
    clearPreviousLookupResult,
    scheduleFocusScanner,
  ]);

  const performBoxIntakeBackNavigation = useCallback(() => {
    if (directBox || !(activePallet?.id?.trim())) {
      resetToInitialShipmentEntry();
      return;
    }
    if (activeBoxSession) {
      closeActiveBoxPackageSession();
      return;
    }
    returnFromPackageScanToShipmentSearch();
  }, [
    directBox,
    activePallet?.id,
    activeBoxSession,
    resetToInitialShipmentEntry,
    closeActiveBoxPackageSession,
    returnFromPackageScanToShipmentSearch,
  ]);

  /** Item Scan header back — return to Box Info for the same package without leaving the workflow. */
  const returnFromItemsPhaseToBoxInfo = useCallback(() => {
    dismissItemScanModalDrafts();
    resetItemInspectionForm();
    setItemBarcodeMiss(null);
    setItemReceiveError(null);
    setItemOverscanWarning(null);
    modalOpenRef.current = false;

    const pkgId = String(itemScanPackageId ?? "").trim();
    const label = String(itemScanPackageLabel ?? "").trim();
    if (pkgId && isUuidString(pkgId)) {
      const row = palletPackagePickerList.find((p) => p.id === pkgId);
      const barcode = label || String(row?.package_code ?? "").trim() || pkgId;
      // Pre-fill photos from cached hub row so UI shows immediately (stale-while-revalidate).
      if (row) {
        const o = normalizePalletDocumentationImageUrls(parsePalletPhotoUrlArray(row.outside_photo_urls), supabase);
        const ins = normalizePalletDocumentationImageUrls(parsePalletPhotoUrlArray(row.inside_photo_urls), supabase);
        const s = normalizePalletDocumentationImageUrls(parsePalletPhotoUrlArray(row.slip_photo_urls), supabase);
        setOutsideBoxPhotoUrls(o);
        setInsideBoxPhotoUrls(ins);
        setSlipBoxPhotoUrls(s);
        outsideBoxPhotoUrlsRef.current = [...o];
        insideBoxPhotoUrlsRef.current = [...ins];
        slipBoxPhotoUrlsRef.current = [...s];
      }
      setActiveBoxSession({ barcode, packageId: pkgId });
      setCurrentPackageTrackingId(barcode);
      setPackageCodeCardOpen(false);
      setEditAllMode(false);
      setFlowPhase("package_scan");
      setBoxHydrateNonce((n) => n + 1);
      void reloadBoxPackageIntakeRef.current(pkgId);
    } else if (label) {
      setCurrentPackageTrackingId(label);
      setActiveBoxSession({ barcode: label, packageId: null });
      setPackageCodeCardOpen(false);
      setFlowPhase("package_scan");
    } else {
      setFlowPhase("package_scan");
    }
    scheduleFocusScanner();
  }, [
    dismissItemScanModalDrafts,
    resetItemInspectionForm,
    itemScanPackageId,
    itemScanPackageLabel,
    palletPackagePickerList,
    scheduleFocusScanner,
  ]);

  const handleScannerBack = useCallback(() => {
    const logScannerBack = (phase: string, dirty: boolean, action: string, reason?: string) => {
      if (!SCANNER_BACK_DEBUG) return;
      console.log(
        `[scanner-back] phase=${phase} dirty=${dirty}${reason ? ` reason=${reason}` : ""} action=${action}`,
      );
    };

    if (identifyGatePhase !== "idle") {
      resetIdentifyGateForm();
      scheduleFocusScanner();
      return;
    }

    if (flowPhase === "items") {
      const proceed = () => returnFromItemsPhaseToBoxInfo();
      const editDirty = hasEditModeUnsavedChanges();
      logScannerBack("items", editDirty.dirty, editDirty.dirty ? "confirm-box-info" : "box-info", editDirty.reason);
      if (editDirty.dirty) requestScannerLeaveConfirm(proceed);
      else proceed();
      return;
    }

    if (flowPhase === "package_scan") {
      const editDirty = hasEditModeUnsavedChanges();
      debugLogBoxIntakeDirtyState(editDirty);
      const isDirect = directBox || !(activePallet?.id?.trim());

      if (activeBoxSession) {
        const action = () => performBoxIntakeBackNavigation();
        logScannerBack("package_scan/session", editDirty.dirty, editDirty.dirty ? "confirm-leave" : "leave", editDirty.reason);
        if (editDirty.dirty) requestScannerLeaveConfirm(action);
        else action();
        return;
      }

      if (packageCodeCardOpen) {
        const dismissPicker = () => {
          if (isDirect) {
            resetToInitialShipmentEntry();
            return;
          }
          setPackageCodeCardOpen(false);
          setPalletPackagePickerQuery("");
          setBoxIntakeError(null);
          closeActiveBoxPackageSession();
          scheduleFocusScanner();
        };
        logScannerBack("package_scan/picker", false, "dismiss");
        dismissPicker();
        return;
      }

      const action = () => performBoxIntakeBackNavigation();
      logScannerBack("package_scan/hub", editDirty.dirty, editDirty.dirty ? "confirm-leave" : "leave", editDirty.reason);
      if (editDirty.dirty) requestScannerLeaveConfirm(action);
      else action();
      return;
    }

    if (flowPhase === "scan" && isIdentified) {
      const editDirty = hasEditModeUnsavedChanges();
      logScannerBack("scan/identified", editDirty.dirty, editDirty.dirty ? "confirm-router-back" : "router-back", editDirty.reason);
      if (editDirty.dirty) {
        requestScannerLeaveConfirm(() => {
          void abandonUnsavedPalletShipmentEdits().finally(() => {
            router.back();
          });
        });
        return;
      }
      router.back();
      return;
    }

    if (flowPhase === "scan" && !isIdentified) {
      if (manualOpen) {
        setManualOpen(false);
        manualEntryModeRef.current = false;
        setManualEntryMode(false);
        scheduleFocusScanner();
        return;
      }
      router.back();
      return;
    }

    logScannerBack(String(flowPhase), false, "router-back-fallback");
    router.back();
  }, [
    identifyGatePhase,
    resetIdentifyGateForm,
    scheduleFocusScanner,
    flowPhase,
    hasEditModeUnsavedChanges,
    returnFromItemsPhaseToBoxInfo,
    requestScannerLeaveConfirm,
    debugLogBoxIntakeDirtyState,
    directBox,
    activePallet?.id,
    activeBoxSession,
    performBoxIntakeBackNavigation,
    packageCodeCardOpen,
    closeActiveBoxPackageSession,
    resetToInitialShipmentEntry,
    isIdentified,
    abandonUnsavedPalletShipmentEdits,
    manualOpen,
    router,
  ]);

  const handleCorrectionResetEntry = useCallback(() => {
    if (flowPhase === "package_scan") {
      if (activeBoxSession) {
        closeActiveBoxPackageSession();
        setEditAllMode(false);
        scheduleFocusScanner();
        return;
      }
      if (packageCodeCardOpen) {
        setPackageCodeCardOpen(false);
        setEditAllMode(false);
        scheduleFocusScanner();
        return;
      }
    }
    if (flowPhase === "scan" && parentIdentified) {
      void abandonUnsavedPalletShipmentEdits();
      setEditAllMode(false);
      scheduleFocusScanner();
    }
  }, [
    flowPhase,
    activeBoxSession,
    packageCodeCardOpen,
    parentIdentified,
    closeActiveBoxPackageSession,
    abandonUnsavedPalletShipmentEdits,
    scheduleFocusScanner,
  ]);

  const handleMoveBoxConfirm = useCallback(
    async (targetPalletTrackingOrNumber: string) => {
      const pkgId = correctionSavedPackageId;
      const oid = (orgId ?? "").trim();
      if (!pkgId || !oid) return;
      setCorrectionBusy(true);
      setMoveBoxModalError(null);
      try {
        const res = await moveOperatorIntakeBoxToPalletAction({
          packageId: pkgId,
          targetPalletTrackingOrNumber,
          requestedOrganizationId: oid,
          storeId: sessionStoreId ?? null,
        });
        if (!res.ok) {
          setMoveBoxModalError(res.message);
          return;
        }
        setMoveBoxModalOpen(false);
        setMoveBoxTargetDraft("");
        setEditAllMode(false);
        setPalletDocHydrationNonce((n) => n + 1);
        if (res.palletId && activePallet?.id !== res.palletId) {
          setActivePallet((p) =>
            p
              ? { ...p, id: res.palletId, pallet_number: res.palletNumber }
              : { id: res.palletId, pallet_number: res.palletNumber },
          );
          if (res.trackingNumber) {
            setCurrentPalletTrackingId(res.trackingNumber);
          }
        }
        closeActiveBoxPackageSession();
        setSyncErrorToast(`Box moved to pallet ${res.palletNumber}.`);
        scheduleFocusScanner();
      } finally {
        setCorrectionBusy(false);
      }
    },
    [
      correctionSavedPackageId,
      orgId,
      sessionStoreId,
      activePallet?.id,
      closeActiveBoxPackageSession,
      scheduleFocusScanner,
    ],
  );

  const handleVoidPalletConfirm = useCallback(async () => {
    const pid = (activePallet?.id ?? "").trim();
    const oid = (orgId ?? "").trim();
    if (!pid || !isUuidString(pid) || !oid) return;
    setCorrectionBusy(true);
    setVoidPalletModalError(null);
    try {
      const res = await voidOperatorIntakePalletAction({
        palletId: pid,
        requestedOrganizationId: oid,
        storeId: sessionStoreId ?? null,
      });
      if (!res.ok) {
        setVoidPalletModalError(res.message);
        return;
      }
      setVoidPalletModalOpen(false);
      setEditAllMode(false);
      resetToInitialShipmentEntry();
      setIntakeToast("Pallet voided.");
    } finally {
      setCorrectionBusy(false);
    }
  }, [activePallet?.id, orgId, sessionStoreId, resetToInitialShipmentEntry]);

  const handleVoidBoxConfirm = useCallback(async () => {
    const pkgId = correctionSavedPackageId;
    const oid = (orgId ?? "").trim();
    if (!pkgId || !oid) return;
    setCorrectionBusy(true);
    setVoidBoxModalError(null);
    try {
      const res = await voidOperatorIntakeBoxPackageAction({
        packageId: pkgId,
        requestedOrganizationId: oid,
        storeId: sessionStoreId ?? null,
      });
      if (!res.ok) {
        setVoidBoxModalError(res.message);
        return;
      }
      setVoidBoxModalOpen(false);
      const wasDirectBox =
        res.wasDirectBox ||
        !res.palletId ||
        (directBox && !activePallet?.id?.trim());

      if (wasDirectBox) {
        resetToInitialShipmentEntry();
        setIntakeToast("Direct box voided.");
        return;
      }

      setEditAllMode(false);
      if (itemScanPackageId === pkgId) {
        resetItemInspectionForm();
        setItemScanPackageId(null);
        setItemScanPackageLabel(null);
        setReceivingSlipExpectedItemQtyTotal(null);
      }
      closeActiveBoxPackageSession();
      setFlowPhase("package_scan");
      setPalletDocHydrationNonce((n) => n + 1);
      setIntakeToast("Box voided.");
      scheduleFocusScanner();
      window.requestAnimationFrame(() => {
        document
          .getElementById("operator-saved-boxes-hub")
          ?.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    } finally {
      setCorrectionBusy(false);
    }
  }, [
    correctionSavedPackageId,
    orgId,
    sessionStoreId,
    directBox,
    activePallet?.id,
    itemScanPackageId,
    resetToInitialShipmentEntry,
    closeActiveBoxPackageSession,
    resetItemInspectionForm,
    scheduleFocusScanner,
  ]);

  const editParent = () => {
    closeActiveBoxPackageSession();
    void abandonUnsavedPalletShipmentEdits();
    setPhysicalBoxCount(null);
    setBoxScanTargetDenominator(null);
    setScannedBoxesSavedCount(0);
    resetItemInspectionForm();
    setItemScanPackageId(null);
    setItemScanPackageLabel(null);
    setReceivingSlipExpectedItemQtyTotal(null);
    setItemReceiveDemoScannedUnits(0);
    setItemReceivePackageActualCount(null);
    setItemReceiveCountSyncNonce(0);
    setExpectedPkgDetailRows([]);
    setCandidatePicker(null);
    setItemBarcodeMiss(null);
    modalOpenRef.current = false;
    setActivePallet(null);
    setActiveTracking(null);
    setCurrentPalletTrackingId(null);
    setCurrentPackageTrackingId(null);
    setPalletCreatedByLabel(null);
    setPalletCreatedByProfileId(null);
    setPalletCreatedAtIso(null);
    setScanLine("");
    setSlipBarcodeExtract(null);
    setFlowPhase("scan");
    setIsIdentified(false);
    setDirectBox(false);
    completedShipmentDialogShownForKeyRef.current = null;
    setCompletedShipmentModal(null);
    resetIdentifyGateForm();
    scheduleFocusScanner();
  };

  const activePackageSessionResolvedRow = useMemo((): OperatorPackageListRow | null => {
    if (!activeBoxSession) return null;
    const sid = activeBoxSession.packageId?.trim() ?? "";
    const code = activeBoxSession.barcode?.trim() ?? "";
    if (sid && isUuidString(sid)) {
      const hit = palletPackagePickerList.find((p) => p.id === sid);
      if (hit) return hit;
    }
    return {
      id: sid && isUuidString(sid) ? sid : "__draft__",
      package_code: code.length ? code : null,
      tracking_number: null,
      id_slip_contents: null,
    };
  }, [activeBoxSession, palletPackagePickerList]);

  const headerIdentityBoxSurface = useMemo((): HeaderIdentityBoxSurface | null => {
    if (flowPhase === "items") {
      const id = (itemScanPackageId ?? "").trim();
      if (!id || !isUuidString(id)) return null;
      const row = palletPackagePickerList.find((p) => p.id === id);
      const code =
        (row?.package_code ?? "").trim() ||
        (itemScanPackageLabel ?? "").trim() ||
        id;
      if (!row) {
        return {
          code,
          touchLabel: actorName.trim() || "—",
          touchProfileId: actorUserId,
          touchIso: null,
        };
      }
      const named = (row.updated_by_display ?? row.created_by_display)?.trim();
      const ub = String(row.updated_by ?? "").trim();
      const cb = String(row.created_by ?? "").trim();
      const touchProfileId: string | null = isUuidString(ub) ? ub : isUuidString(cb) ? cb : actorUserId;
      const touchLabel =
        named || (isUuidString(ub) || isUuidString(cb) ? "Unknown" : actorName.trim() || "—");
      return {
        code,
        touchLabel,
        touchProfileId,
        touchIso: (row.updated_at ?? row.created_at ?? "").trim() || null,
      };
    }
    if (flowPhase === "package_scan" && activeBoxSession) {
      const bc = (activeBoxSession.barcode ?? "").trim();
      if (!bc) return null;
      const row = activePackageSessionResolvedRow;
      if (row && row.id !== "__draft__" && isUuidString(row.id)) {
        const code = (row.package_code ?? "").trim() || bc;
        const named = (row.updated_by_display ?? row.created_by_display)?.trim();
        const ub = String(row.updated_by ?? "").trim();
        const cb = String(row.created_by ?? "").trim();
        const touchProfileId: string | null = isUuidString(ub) ? ub : isUuidString(cb) ? cb : actorUserId;
        const touchLabel =
          named || (isUuidString(ub) || isUuidString(cb) ? "Unknown" : actorName.trim() || "—");
        return {
          code,
          touchLabel,
          touchProfileId,
          touchIso: (row.updated_at ?? row.created_at ?? "").trim() || null,
        };
      }
      return {
        code: bc,
        touchLabel: actorName.trim() || "—",
        touchProfileId: actorUserId,
        touchIso: null,
      };
    }
    return null;
  }, [
    flowPhase,
    itemScanPackageId,
    itemScanPackageLabel,
    palletPackagePickerList,
    activeBoxSession,
    activePackageSessionResolvedRow,
    actorName,
    actorUserId,
  ]);

  const boxScanResolvedPkgBadge = useMemo(() => {
    if (!activeBoxSession?.barcode?.trim() || !activePackageSessionResolvedRow) return null;
    const st = resolveOperatorPackagePickerRowStatus(activePackageSessionResolvedRow);
    return { status: st, ...operatorPackagePickerStatusBadge(st) };
  }, [activeBoxSession?.barcode, activePackageSessionResolvedRow]);

  /** Show “Complete with Discrepancy” only when closing intake for a measurable mismatch. */
  const boxIntakeDiscrepancyEligible = useMemo(() => {
    if (!activeBoxSession) return false;
    if (boxSlipVisionLines.some((l) => Boolean(l.missing))) return true;
    const p = activePackageSessionResolvedRow;
    if (!p || p.id === "__draft__") return false;
    const notes = String(p.notes ?? "").toLowerCase();
    if (notes.includes("discrepancy")) return true;
    const exp =
      typeof p.expected_item_count === "number" && Number.isFinite(p.expected_item_count)
        ? Math.floor(p.expected_item_count)
        : null;
    const act =
      typeof p.actual_item_count === "number" && Number.isFinite(p.actual_item_count)
        ? Math.floor(p.actual_item_count)
        : null;
    return exp != null && exp > 0 && act != null && act !== exp;
  }, [activeBoxSession, activePackageSessionResolvedRow, boxSlipVisionLines]);

  const operatorPalletAlignedUploadPaths = useMemo(() => {
    const sid = sessionStoreId?.trim() ?? "";
    if (!sid || !isUuidString(sid)) return null;
    const pid = activePallet?.id?.trim() ?? "";
    if (!isUuidString(pid)) return null;
    return {
      shipping: buildPalletShippingLabelsRelativePath(sid, pid),
      photos: buildPalletPhotosRelativePath(sid, pid),
      bol: buildPalletBolRelativePath(sid, pid),
    };
  }, [sessionStoreId, activePallet?.id]);

  const operatorPackageAlignedUploadPaths = useMemo(() => {
    if (flowPhase !== "package_scan") return null;
    const sid = sessionStoreId?.trim() ?? "";
    if (!sid || !isUuidString(sid)) return null;
    const pkg = activeBoxSession?.packageId?.trim() ?? "";
    if (!isUuidString(pkg)) return null;
    return {
      photos: buildPackagePhotosRelativePath(sid, pkg),
      manifest: buildPackageManifestRelativePath(sid, pkg),
    };
  }, [flowPhase, sessionStoreId, activeBoxSession?.packageId]);

  const slipMatchParentTn = activePallet?.id ? currentPalletTrackingId : activeTracking;
  const showSlipMatchedBadge =
    slipBarcodeExtract !== null &&
    expectedPkgLines.length > 0 &&
    (!slipBarcodeExtract.shipmentId ||
      trackingKeysEqual(slipBarcodeExtract.shipmentId, slipMatchParentTn ?? ""));
  /**
   * Header "Pallet" crumb + Active Pallet read-only must share the same source as the tracking field:
   * `currentPalletTrackingId` (live while Edit All); when not editing, trimmed tracking then `pallet_number`.
   */
  const warehousePalletLabel = (() => {
    const palletId = activePallet?.id?.trim() ?? "";
    if (!palletId) {
      if (directBox) return "Direct";
      const trackingOnly =
        (currentPalletTrackingId ?? "").trim() || (activeTracking ?? "").trim();
      return trackingOnly.length > 0 ? trackingOnly : null;
    }
    if (trackingIdEditable) {
      const v = currentPalletTrackingId;
      if (v == null || v === "") return null;
      return v;
    }
    const t = (currentPalletTrackingId ?? "").trim();
    return t || (activePallet?.pallet_number ?? "").trim() || null;
  })();
  /** Carton buffer / locked box only — never `currentPalletTrackingId` (shipment id lives in the pallet card, not here). */
  const warehouseBreadcrumbCartonBarcode =
    (activeBoxSession?.barcode ?? "").trim() ||
    (flowPhase === "package_scan" ? (currentPackageTrackingId ?? "").trim() : "") ||
    "";
  const warehouseBreadcrumbCartonBarcodeOrNull = warehouseBreadcrumbCartonBarcode.length
    ? warehouseBreadcrumbCartonBarcode
    : null;
  const contextTrailBoxBarcode = activeBoxSession?.barcode ?? itemScanPackageLabel ?? null;
  const boxTrailTrim = contextTrailBoxBarcode?.trim() ?? "";
  const warehouseBreadcrumbMiddleOverride =
    flowPhase === "items" && boxTrailTrim ? { label: "BOX", value: boxTrailTrim } : null;
  /**
   * "Pkg" crumb = scanned / locked carton id only. Scan step: no second crumb until a box exists.
   * Package step: show typed or locked barcode (not shipment tracking).
   */
  const warehouseBreadcrumbShipmentForTrail =
    flowPhase === "package_scan" ? warehouseBreadcrumbCartonBarcodeOrNull : null;
  /** Avoid duplicate crumbs when the same barcode is already shown as Pkg or Box. */
  const warehouseBreadcrumbTrailingBarcode =
    flowPhase === "package_scan"
      ? null
      : flowPhase === "items" &&
          warehouseBreadcrumbMiddleOverride &&
          warehouseBreadcrumbMiddleOverride.label === "BOX" &&
          warehouseBreadcrumbMiddleOverride.value === boxTrailTrim
        ? null
        : contextTrailBoxBarcode;

  const onItemPhotoFile = (which: "front" | "barcode" | "damage", file: File | undefined) => {
    if (!file?.type.startsWith("image/")) return;
    const url = URL.createObjectURL(file);
    if (which === "front") {
      if (itemPhotoFrontUrlRef.current) URL.revokeObjectURL(itemPhotoFrontUrlRef.current);
      itemPhotoFrontUrlRef.current = url;
      setItemPhotoFrontUrl(url);
    } else if (which === "barcode") {
      if (itemPhotoBarcodeUrlRef.current) URL.revokeObjectURL(itemPhotoBarcodeUrlRef.current);
      itemPhotoBarcodeUrlRef.current = url;
      setItemPhotoBarcodeUrl(url);
    } else {
      if (itemPhotoDamageUrlRef.current) URL.revokeObjectURL(itemPhotoDamageUrlRef.current);
      itemPhotoDamageUrlRef.current = url;
      setItemPhotoDamageUrl(url);
    }
  };

  const identityPalletDisplay =
    (activePallet?.pallet_number ?? "").trim() ||
    (warehousePalletLabel ?? "").trim() ||
    (currentPalletTrackingId ?? "").trim() ||
    (activeTracking ?? "").trim() ||
    "—";
  const identityPalletFormatted =
    identityPalletDisplay === "—" ? "—" : `#${identityPalletDisplay.replace(/^#/, "")}`;
  const showIdentitySummaryStrip =
    isIdentified &&
    (parentIdentified ||
      Boolean((activePallet?.pallet_number ?? "").trim()) ||
      Boolean((activePallet?.id ?? "").toString().trim()));

  const operatorIdentityOneLine = useMemo(() => {
    const pDisplay =
      identityPalletFormatted === "—" ? "—" : identityPalletFormatted.replace(/^#/, "").trim() || "—";
    const palletCreator = stripOperatorIdentityYouHint(
      formatOperatorIdentityParticipant(
        (palletCreatedByLabel ?? "").trim() || "—",
        palletCreatedByProfileId,
        actorUserId,
      ),
    );
    const tsIso =
      (headerIdentityBoxSurface?.touchIso ?? "").trim() ||
      (palletCreatedAtIso ?? "").trim() ||
      null;
    let ts = formatOperatorIdentityCompactAt(tsIso);
    if (ts === "—") ts = formatOperatorIdentityCompactAt(new Date().toISOString());
    if (headerIdentityBoxSurface) {
      const rawCode = headerIdentityBoxSurface.code.trim();
      const bDisplay = rawCode === "—" ? "—" : rawCode.replace(/^#/, "").trim() || "—";
      const boxOp = stripOperatorIdentityYouHint(
        formatOperatorIdentityParticipant(
          headerIdentityBoxSurface.touchLabel,
          headerIdentityBoxSurface.touchProfileId,
          actorUserId,
        ),
      );
      const pid = (palletCreatedByProfileId ?? "").trim();
      const bid = (headerIdentityBoxSurface.touchProfileId ?? "").trim();
      const sameByUuid = isUuidString(pid) && isUuidString(bid) && pid === bid;
      const sameByName =
        !sameByUuid &&
        palletCreator !== "—" &&
        boxOp !== "—" &&
        palletCreator.toLowerCase() === boxOp.toLowerCase();
      if (sameByUuid || sameByName) {
        const byName = palletCreator !== "—" ? palletCreator : boxOp;
        return `P#${pDisplay} (${byName}) • B#${bDisplay} (${byName}) • ${ts}`;
      }
      return `P#${pDisplay} (${palletCreator}) • B#${bDisplay} (${boxOp}) • ${ts}`;
    }
    return `P#${pDisplay} (${palletCreator}) • ${ts}`;
  }, [
    identityPalletFormatted,
    palletCreatedByLabel,
    palletCreatedByProfileId,
    actorUserId,
    palletCreatedAtIso,
    headerIdentityBoxSurface,
  ]);

  /** Hide redundant mini breadcrumb on compact handheld Box Info + Item Scan (identity strip / stepper suffice). */
  const hideHeaderWarehouseTrail =
    flowPhase === "package_scan" ||
    flowPhase === "items" ||
    (showIdentitySummaryStrip && flowPhase === "scan");
  const showWarehouseTrail = isIdentified && (parentIdentified || directBox || flowPhase !== "scan");

  const openOperatorAddNewBox = useCallback(() => {
    setDirectBox(false);
    setPackageCodeCardOpen(true);
    setBoxIntakeError(null);
    setPalletPackagePickerQuery("");
  }, []);

  const continueModernPalletToBoxInfo = useCallback(() => {
    if (typeof physicalBoxCount === "number" && physicalBoxCount > 0) {
      setBoxScanTargetDenominator(physicalBoxCount);
    }
    setBoxIntakeError(null);
    setEditAllMode(false);
    setScanLine("");
    setCurrentPackageTrackingId(null);
    setDirectBox(false);
    setFlowPhase("package_scan");
    setPalletDocHydrationNonce((n) => n + 1);
  }, [physicalBoxCount]);

  const scrollToActiveBoxSummary = useCallback(() => {
    document
      .getElementById("operator-mobile-box-summary-bar")
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  const scrollToSavedBoxesFilter = useCallback(() => {
    window.requestAnimationFrame(() => {
      const el = document.getElementById("operator-saved-boxes-filter");
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "start" });
      } else {
        operatorMobileMainScrollRef.current?.scrollTo({ top: 0, behavior: "smooth" });
      }
    });
  }, []);

  const handlePalletSummaryScannedClick = useCallback(async () => {
    if (activeBoxSession) {
      scrollToActiveBoxSummary();
      return;
    }
    const fromScan = flowPhase === "scan";
    if (fromScan) {
      if (modernPalletWorkspace) continueModernPalletToBoxInfo();
      else await handleConfirmStartBoxScan();
    }
    window.setTimeout(() => scrollToSavedBoxesFilter(), fromScan ? 260 : 0);
  }, [
    activeBoxSession,
    flowPhase,
    modernPalletWorkspace,
    continueModernPalletToBoxInfo,
    handleConfirmStartBoxScan,
    scrollToActiveBoxSummary,
    scrollToSavedBoxesFilter,
  ]);

  const handlePalletSummaryRemainingClick = useCallback(async () => {
    if (activeBoxSession) {
      scrollToActiveBoxSummary();
      return;
    }
    const fromScan = flowPhase === "scan";
    if (fromScan) {
      if (modernPalletWorkspace) continueModernPalletToBoxInfo();
      else await handleConfirmStartBoxScan();
    }
    window.setTimeout(() => {
      openOperatorAddNewBox();
      operatorMobileMainScrollRef.current?.scrollTo({ top: 0, behavior: "smooth" });
    }, fromScan ? 260 : 0);
  }, [
    activeBoxSession,
    flowPhase,
    modernPalletWorkspace,
    continueModernPalletToBoxInfo,
    handleConfirmStartBoxScan,
    openOperatorAddNewBox,
    scrollToActiveBoxSummary,
  ]);

  const palletSummaryTilesInteractionLocked = confirmSaving;

  const liveDb = isSupabaseConfigured();
  const allowSessionIncompleteUi =
    !liveDb || operatorStores.length > 1 || operatorStores.length === 0 || kioskStoreLocked;
  const blockUntilStoreResolved =
    liveDb && !operatorStoresLoading && !sessionStoreId && !allowSessionIncompleteUi;

  useEffect(() => {
    if (!orgId?.trim()) return;
    if (liveDb && operatorStoresLoading) return;
    if (blockUntilStoreResolved) return;
    setScanPageBootComplete(true);
  }, [orgId, liveDb, operatorStoresLoading, blockUntilStoreResolved]);

  const showColdBootLoading =
    !scanPageBootComplete &&
    (!orgId?.trim() || (liveDb && operatorStoresLoading) || blockUntilStoreResolved);

  if (showColdBootLoading) {
    if (!orgId?.trim()) {
      return <ScanPageLoading message="Missing organization context." />;
    }
    if (liveDb && operatorStoresLoading) {
      return <ScanPageLoading />;
    }
    if (blockUntilStoreResolved) {
      return <ScanPageLoading message="Restoring store session…" />;
    }
  }

  const itemsChromeStickyLayout = flowPhase === "items" && hasItemReceivableBox;

  return (
    <div
      className={`operator-shipment-handheld-compact flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden text-[14px] font-medium leading-snug [&_button]:touch-manipulation [&_button]:transition-transform [&_button]:duration-150 [&_button]:ease-out [&_button]:active:scale-95 ${
        itemsChromeStickyLayout ? "operator-item-scan-screen" : ""
      }${!isIdentified ? " operator-shipment-entry-gate-page" : ""}`}
      style={{ backgroundColor: BG, color: TEXT_PRIMARY }}
    >
      {/* Zebra Keyboard Wedge requires a focused input, so scan mode keeps this dedicated capture input focused while suppressing the Android soft keyboard with inputMode="none". */}
      <input
        ref={scannerRef}
        id={`${formId}-scan-capture`}
        type="text"
        value={scanCaptureLine}
        onChange={(e) => setScanCaptureLine(e.target.value)}
        onFocus={() => {
          if (manualEntryModeRef.current) scannerRef.current?.blur();
        }}
        onBlur={() => {
          window.setTimeout(() => {
            if (manualEntryModeRef.current || manualOpen || !laserEnabled) return;
            focusScannerAggressive();
          }, 80);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            void submitScanCaptureInput(e.currentTarget.value);
          }
        }}
        inputMode="none"
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        enterKeyHint="done"
        aria-label="Hardware scanner capture"
        className="pointer-events-none absolute h-px w-px opacity-0 caret-transparent"
        tabIndex={-1}
      />
      <div
        className={
          itemsChromeStickyLayout
            ? "sticky top-0 z-50 shrink-0 bg-background"
            : "shrink-0"
        }
        style={
          itemsChromeStickyLayout
            ? { background: "var(--scanner-header-gradient)" }
            : undefined
        }
      >
      <header
        ref={scanPageHeaderRef}
        className={`operator-shipment-entry-header relative shrink-0 pt-0 ${itemsChromeStickyLayout ? "z-[1]" : "z-[110]"}`}
        style={{
          background: "var(--scanner-header-gradient)",
        }}
      >
        {showIdentitySummaryStrip ? (
          <div className={`operator-shipment-entry-identity-strip border-b px-2.5 py-0`}>
            <p
              className="text-center text-[10px] font-semibold leading-snug tracking-wide tabular-nums sm:text-[11px]"
              style={{
                color: "var(--scanner-text)",
                textShadow: "0 1px 2px rgba(0,0,0,0.35)",
              }}
              aria-label="Pallet, box operator, and last activity time"
            >
              {operatorIdentityOneLine}
            </p>
            {palletIdentityOrderId || palletMixedOrderIdsUi ? (
              <p
                className="operator-shipment-entry-order-meta operator-box-info-order-meta mt-0 flex flex-wrap items-center justify-center gap-x-1.5 gap-y-0 text-center font-mono text-[9px] font-semibold leading-tight tracking-wide tabular-nums"
                aria-label={`Order ID ${palletIdentityOrderId || "not set"}`}
              >
                <span>
                  <span className="operator-shipment-entry-order-meta__tag operator-box-info-order-meta__tag font-bold uppercase tracking-widest">
                    Order
                  </span>{" "}
                  <span className="operator-shipment-entry-order-meta__value operator-box-info-order-meta__value">
                    {palletIdentityOrderId || "—"}
                  </span>
                </span>
                {palletMixedOrderIdsUi ? (
                  <span
                    className="operator-shipment-entry-order-conflict operator-box-info-order-conflict inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[8px] font-medium uppercase tracking-wide"
                    title={PALLET_ORDER_CONFLICT_TOOLTIP}
                  >
                    ORDER CONFLICT
                    <Info className="h-3 w-3" strokeWidth={2.25} aria-hidden />
                  </span>
                ) : null}
              </p>
            ) : null}
          </div>
        ) : null}
        {isIdentified ? (
          <div
            className={`operator-shipment-entry-title-row px-3 pb-0.5 pt-1 sm:px-4 ${HANDHELD_HEADER_COMPACT}`}
            data-receiving-phase={flowPhase}
          >
            <div
              className="flex items-center gap-1 !border-b !border-[#C8A96A]/30 !pb-0.5"
              style={{ borderBottomWidth: 1, borderBottomColor: "rgba(200, 169, 106, 0.3)" }}
            >
              <button
                type="button"
                onClick={() => handleScannerBack()}
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl transition hover:bg-black/[0.06] active:scale-95 dark:hover:bg-white/8"
                style={{ color: TEXT_PRIMARY }}
                aria-label={
                  flowPhase === "items"
                    ? "Return to box info"
                    : flowPhase === "package_scan" && activeBoxSession
                      ? "Exit box session"
                      : "Go back"
                }
              >
                <ArrowLeft className="h-5 w-5" strokeWidth={2} />
              </button>
              <h1
                className="operator-heading min-w-0 flex-1 truncate text-lg font-bold uppercase tracking-wide text-[15px] leading-tight"
                style={{ color: TEXT_PRIMARY }}
              >
                {headerTitle}
              </h1>
              <div
                className={`operator-shipment-edit-all-slot flex shrink-0 items-center justify-end${
                  flowPhase === "scan" ? " min-h-6" : " min-h-8"
                }`}
              >
                {showHeaderEditAllButton ? (
                  <button
                    type="button"
                    onClick={() => {
                      if (flowPhase === "items") {
                        setItemScanEditAllMode((m) => {
                          const next = !m;
                          if (!next) {
                            setItemScanEditPick(null);
                            setItemScanUnitPickerOpen(false);
                          }
                          return next;
                        });
                      } else {
                        setEditAllMode((m) => {
                          const next = !m;
                          if (next) {
                            if (flowPhase === "scan") capturePalletEvidenceBaseline();
                            else if (flowPhase === "package_scan") {
                              captureBoxEvidenceBaseline();
                              captureBoxIntakeFieldsBaseline();
                            }
                          }
                          return next;
                        });
                      }
                    }}
                    aria-pressed={headerEditAllActive}
                    className={`operator-shipment-edit-all-btn inline-flex shrink-0 items-center justify-center whitespace-nowrap rounded-lg border font-bold uppercase tracking-wider shadow-sm transition active:scale-95${
                      flowPhase === "scan"
                        ? " gap-0.5 px-2 py-0.5 text-xs"
                        : " gap-1 px-2.5 py-1 text-xs sm:px-3"
                    }${headerEditAllActive ? " operator-shipment-edit-all-btn--active" : ""}`}
                  >
                    {headerEditAllActive ? (
                      <>
                        <CheckCircle2
                          className={`shrink-0 ${flowPhase === "scan" ? "h-2.5 w-2.5" : "h-3 w-3"}`}
                          strokeWidth={2.5}
                        />
                        Done
                      </>
                    ) : (
                      <>
                        <Pencil
                          className={`shrink-0 ${flowPhase === "scan" ? "h-2.5 w-2.5" : "h-3 w-3"}`}
                          strokeWidth={2}
                        />
                        Edit All
                      </>
                    )}
                  </button>
                ) : (
                  <span
                    className={`inline-block shrink-0 ${flowPhase === "scan" ? "h-6 w-6" : "h-8 w-8"}`}
                    aria-hidden
                  />
                )}
              </div>
            </div>
            <div
              className={`operator-shipment-entry-stepper-shell operator-box-info-stepper-shell operator-pallet-stepper-shell relative z-[1] isolate mx-auto w-full max-w-[19rem] sm:max-w-sm ${HANDHELD_STEPPER_COMPACT}`}
            >
              <ReceivingMasterStepper
                flowPhase={flowPhase}
                parentIdentified={parentIdentified}
                directBox={directBox}
              />
            </div>
            {showWarehouseTrail && !hideHeaderWarehouseTrail ? (
              <div className="mt-0.5 flex w-full justify-center">
                <WarehouseBreadcrumb
                  className="w-full flex-wrap justify-center"
                  storeLabel={activeStoreLabel}
                  palletLabel={warehousePalletLabel}
                  shipmentIdLabel={warehouseBreadcrumbShipmentForTrail}
                  middleOverride={warehouseBreadcrumbMiddleOverride}
                  boxBarcode={warehouseBreadcrumbTrailingBarcode}
                />
              </div>
            ) : null}
          </div>
        ) : (
          <div
            className={`operator-shipment-entry-title-row operator-shipment-entry-title-row--gate flex items-center gap-2 px-3 pt-1 sm:px-4 ${HANDHELD_HEADER_COMPACT}`}
          >
            <button
              type="button"
              onClick={() => handleScannerBack()}
              className="operator-shipment-entry-back-btn flex h-9 w-9 shrink-0 items-center justify-center rounded-xl transition active:scale-95"
              style={{ color: TEXT_PRIMARY }}
              aria-label="Go back"
            >
              <ArrowLeft className="h-5 w-5" strokeWidth={2} />
            </button>
            <h1
              className="operator-heading min-w-0 flex-1 truncate text-lg font-bold uppercase tracking-wide text-[15px] leading-tight"
              style={{ color: TEXT_PRIMARY }}
            >
              {headerTitle}
            </h1>
            <span className="inline-block h-9 w-9 shrink-0" aria-hidden />
          </div>
        )}

        {isIdentified && flowPhase === "package_scan" && activeBoxSession ? (
          <div
            id="operator-mobile-box-summary-bar"
            className={`border-t px-2 py-1`}
            style={{ borderColor: BORDER, backgroundColor: "var(--scanner-card-inner)" }}
          >
            <div className="operator-compact-row flex flex-wrap items-center gap-x-3 gap-y-2">
              {boxIntakeRestoring ? (
                <span className="operator-scan-restoring-indicator w-full justify-center text-[10px] font-semibold" role="status">
                  <Loader2 className="h-3 w-3 shrink-0 animate-spin" aria-hidden />
                  Restoring box data…
                </span>
              ) : null}
              <div className="operator-compact-row flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1.5">
                <span
                  className="font-mono text-[15px] font-black leading-none tracking-tight"
                  style={{ color: "var(--op-gold-accent)" }}
                >
                  {(activeBoxSession.barcode ?? "").trim() || "—"}
                </span>
                <span
                  className="operator-shipment-carrier-badge inline-flex max-w-[min(100%,12rem)] items-center gap-1 rounded-md border px-2 py-0.5 text-[10px] font-bold leading-tight"
                  title={palletCarrier.trim() || undefined}
                >
                  <span
                    className="operator-shipment-carrier-icon operator-shipment-carrier-iconPlate shrink-0"
                    aria-hidden
                  >
                    <Truck className="operator-shipment-carrier-icon__truck h-3 w-3" strokeWidth={2.25} />
                  </span>
                  <span className="operator-shipment-carrier-badge__text truncate">
                    {palletCarrierOtherSelected ? (
                      <>
                        <span className="opacity-60">Other:</span> {palletCarrier.trim() || "—"}
                      </>
                    ) : (
                      palletCarrier.trim() || "—"
                    )}
                  </span>
                </span>
                <span
                  className="operator-box-summary-items-count text-[11px] font-black tabular-nums tracking-tight"
                  style={{ color: TEXT_PRIMARY }}
                  aria-live="polite"
                >
                  Items:{" "}
                  {visionSlipExpectedQtySum <= 0 ? (
                    <span className="operator-box-summary-items-count__empty font-black">--</span>
                  ) : (
                    <>
                      <span className="operator-box-summary-items-count__num font-black">0</span>
                      <span className="operator-box-summary-items-count__sep mx-0.5 font-black">/</span>
                      <span className="operator-box-summary-items-count__total font-black">
                        {visionSlipExpectedQtySum}
                      </span>
                    </>
                  )}
                </span>
                {boxScanResolvedPkgBadge ? (
                  <span
                    className="inline-flex shrink-0 items-center rounded-md border px-1.5 py-0.5 text-[8px] font-black uppercase leading-tight tracking-wide"
                    style={{
                      borderColor: boxScanResolvedPkgBadge.border,
                      backgroundColor: boxScanResolvedPkgBadge.bg,
                      color: boxScanResolvedPkgBadge.color,
                    }}
                  >
                    {boxScanResolvedPkgBadge.label}
                  </span>
                ) : null}
              </div>
            </div>
            {editAllMode &&
            flowPhase === "package_scan" &&
            (showCorrectionResetEntry || showCorrectionMoveBox || showCorrectionVoidBox || showCorrectionVoidPallet) ? (
              <OperatorCorrectionActionsPanel
                showReset={showCorrectionResetEntry}
                showMoveBox={showCorrectionMoveBox}
                showVoidBox={showCorrectionVoidBox}
                showVoidPallet={showCorrectionVoidPallet}
                onReset={handleCorrectionResetEntry}
                onMoveBox={openMoveBoxModal}
                onVoidBox={() => {
                  setVoidBoxModalError(null);
                  setVoidBoxModalOpen(true);
                }}
                onVoidPallet={() => {
                  setVoidPalletModalError(null);
                  setVoidPalletModalOpen(true);
                }}
              />
            ) : null}
          </div>
        ) : null}

        {parentIdentified &&
        flowPhase !== "items" &&
        boxProgressExpectedY > 0 &&
        ((flowPhase === "package_scan" && activeBoxSession) || flowPhase === "scan") ? (
          <div
            className={`operator-shipment-entry-progress operator-shipment-box-progress border-t px-2 py-0.5${
              flowPhase === "scan" && parentIdentified ? " operator-pallet-progress-block" : ""
            }`}
          >
            {flowPhase === "scan" && parentIdentified ? (
              <div className="operator-shipment-entry-progress-tools mx-auto mb-1.5 flex max-w-md flex-col items-stretch gap-1.5">
                {trackingIdEditable ? (
                  <input
                    id={`${formId}-active-pallet-tracking`}
                    type="text"
                    autoComplete="off"
                    enterKeyHint="done"
                    aria-label="Tracking ID"
                    className="operator-shipment-entry-tracking-field block w-full min-w-0 rounded-lg border px-3 py-1.5 text-center font-mono text-xs font-bold outline-none transition"
                    placeholder="Tracking / shipment ID"
                    value={currentPalletTrackingId ?? ""}
                    onChange={(e) => {
                      const v = e.target.value;
                      setCurrentPalletTrackingId(v === "" ? null : v);
                    }}
                    onBlur={(e) => {
                      const t = e.target.value.trim();
                      setCurrentPalletTrackingId(t.length ? t : null);
                      if (trackingIdEditable) void handlePalletHeaderTrackingBlur(t);
                    }}
                  />
                ) : null}
                {editAllMode ? (
                  <div className="operator-shipment-entry-box-count-editor flex flex-wrap items-center justify-center gap-2 border-t pt-1.5">
                    <span
                      className="operator-shipment-entry-box-count-editor__label shrink-0 text-[9px] font-bold uppercase tracking-widest"
                      id={`${formId}-physical-boxes-label`}
                    >
                      Expected boxes
                    </span>
                    <div className="operator-shipment-entry-box-count-stepper flex items-stretch overflow-hidden rounded-md border">
                      <button
                        type="button"
                        aria-label="Decrease box count"
                        disabled={(() => {
                          const n = physicalBoxCount;
                          return typeof n !== "number" || n <= 1;
                        })()}
                        onClick={() => {
                          const cur = physicalBoxCount;
                          if (typeof cur !== "number" || cur <= 1) {
                            setPhysicalBoxCount(null);
                            return;
                          }
                          setPhysicalBoxCount(cur - 1);
                        }}
                        className="operator-shipment-entry-box-count-stepper__btn flex h-8 w-8 shrink-0 items-center justify-center text-[16px] font-black transition active:scale-95 disabled:cursor-not-allowed disabled:opacity-35"
                      >
                        −
                      </button>
                      <input
                        ref={physicalBoxCountInputRef}
                        id={`${formId}-physical-boxes`}
                        type="tel"
                        inputMode="numeric"
                        pattern="[0-9]*"
                        autoComplete="off"
                        enterKeyHint="done"
                        aria-labelledby={`${formId}-physical-boxes-label`}
                        maxLength={4}
                        className="operator-shipment-entry-box-count-stepper__input block h-8 w-[4.25rem] min-w-0 bg-transparent text-center font-mono text-[15px] font-black tabular-nums outline-none"
                        value={physicalBoxCount ?? ""}
                        placeholder="0"
                        onChange={(e) => {
                          const raw = e.target.value.replace(/\D/g, "").slice(0, 4);
                          if (raw === "") setPhysicalBoxCount(null);
                          else {
                            const n = Number.parseInt(raw, 10);
                            if (!Number.isNaN(n)) setPhysicalBoxCount(n);
                          }
                        }}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            (e.target as HTMLInputElement).blur();
                          }
                        }}
                      />
                      <button
                        type="button"
                        aria-label="Increase box count"
                        onClick={() => {
                          const cur = physicalBoxCount;
                          const next =
                            typeof cur === "number" && Number.isFinite(cur) ? Math.min(9999, cur + 1) : 1;
                          setPhysicalBoxCount(next);
                        }}
                        className="operator-shipment-entry-box-count-stepper__btn flex h-8 w-8 shrink-0 items-center justify-center text-[16px] font-black transition active:scale-95"
                      >
                        +
                      </button>
                    </div>
                  </div>
                ) : null}
                {editAllMode &&
                flowPhase === "scan" &&
                (showCorrectionResetEntry ||
                  showCorrectionMoveBox ||
                  showCorrectionVoidBox ||
                  showCorrectionVoidPallet) ? (
                  <OperatorCorrectionActionsPanel
                    showReset={showCorrectionResetEntry}
                    showMoveBox={showCorrectionMoveBox}
                    showVoidBox={showCorrectionVoidBox}
                    showVoidPallet={showCorrectionVoidPallet}
                    onReset={handleCorrectionResetEntry}
                    onMoveBox={openMoveBoxModal}
                    onVoidBox={() => {
                      setVoidBoxModalError(null);
                      setVoidBoxModalOpen(true);
                    }}
                    onVoidPallet={() => {
                      setVoidPalletModalError(null);
                      setVoidPalletModalOpen(true);
                    }}
                  />
                ) : null}
              </div>
            ) : null}
            <p
              className={`operator-shipment-box-progress__text text-center text-[11px] font-semibold tracking-wide${
                flowPhase === "scan" && parentIdentified ? " operator-pallet-progress-line" : ""
              }`}
            >
              <span className="operator-shipment-box-progress__label">Progress: </span>
              <span className="operator-shipment-box-progress__count font-mono font-bold tabular-nums">
                {palletBoxesCompletedUnified}
              </span>
              <span className="operator-shipment-box-progress__label"> of </span>
              <span className="operator-shipment-box-progress__total font-mono font-bold tabular-nums">
                {boxProgressExpectedY}
              </span>
              <span className="operator-shipment-box-progress__label"> boxes completed</span>
            </p>
            {flowPhase === "scan" && parentIdentified && !activeBoxSession && isIdentified ? (
              <ScanProgressDashboard
                embedded
                active
                boxesExpected={
                  typeof physicalBoxCount === "number" && physicalBoxCount > 0 ? physicalBoxCount : 0
                }
                boxesScanned={palletDashboardScannedBoxCount}
                onScannedBoxesClick={handlePalletSummaryScannedClick}
                onRemainingBoxesClick={handlePalletSummaryRemainingClick}
                interactionDisabled={confirmSaving}
              />
            ) : null}
            {flowPhase === "scan" && parentIdentified ? (
              <p className="sr-only" aria-live="polite">
                {scanLine ? `Buffer: ${scanLine}` : "Scanner ready"}
              </p>
            ) : null}
          </div>
        ) : null}
      </header>

      </div>

      <main
        ref={itemsChromeStickyLayout ? undefined : bindOperatorMainScrollEl}
        className={`min-h-0 px-3 pt-1 ${
          itemsChromeStickyLayout
            ? "operator-item-scan-main flex min-h-0 flex-1 flex-col overflow-hidden overscroll-contain"
            : !isIdentified
              ? `operator-shipment-entry-gate-main flex-1 overflow-y-auto overscroll-contain ${mainScrollClass} ${HANDHELD_GATE_COMPACT}`
              : `operator-shipment-identified-main flex-1 overflow-y-auto overscroll-contain pb-3 ${mainScrollClass} ${HANDHELD_COMPACT}`
        }`}
      >
        {!isIdentified ? (
          <>
          <div className="operator-shipment-entry-gate">
            {!isSupabaseConfigured() ? (
              <p className={`${OP_SCAN_ALERT_WARNING} mb-3`}>
                Demo mode — try a tracking code or <span className="font-mono">NEW-</span>. Configure Supabase for live data.
              </p>
            ) : null}
            {isSupabaseConfigured() && !operatorStoresLoading && !kioskStoreLocked && operatorStores.length === 0 ? (
              <p className={`${OP_SCAN_ALERT_ERROR} mb-4`}>
                No active stores for this organization. Add a store in Settings (Stores and adapters), then refresh.
              </p>
            ) : null}
            {isSupabaseConfigured() && !operatorStoresLoading && operatorStores.length > 0 && !sessionStoreId ? (
              <p className={`${OP_SCAN_ALERT_ERROR} mb-4`}>
                Could not activate a store — choose one in the Store row above or verify your connection.
              </p>
            ) : null}

            <section className={`operator-shipment-entry-gate-scan-card relative z-10 mb-3 rounded-[22px] p-3 sm:p-4 mb-1.5 rounded-lg p-2 ${glassCard}`}>
              <div className="flex items-center justify-between gap-2.5">
                <div className="flex min-w-0 flex-1 items-center gap-2.5">
                  <div className="operator-shipment-entry-gate__barcode-plate scanner-neon-icon-ring flex h-11 w-11 shrink-0 items-center justify-center rounded-xl h-9 w-9 rounded-lg">
                    <Barcode className="h-6 w-6" strokeWidth={2.35} aria-hidden />
                  </div>
                  <p className="operator-shipment-entry-gate__tracking-label min-w-0 text-[10px] font-bold uppercase leading-snug tracking-[0.12em] sm:text-xs sm:tracking-[0.14em]">
                    Tracking Number or Slip Code
                  </p>
                </div>
                <div ref={gateTrackingHelpRef} className="relative shrink-0">
                  <button
                    type="button"
                    className="operator-shipment-entry-gate__info-btn operator-info-icon-pulse flex h-8 w-8 shrink-0 items-center justify-center rounded-full outline-none transition"
                    aria-label="How lookup works"
                    aria-expanded={gateTrackingHelpOpen}
                    title="Exact match on inventory status (tracking or slip) for this organization and store. No SKU or ASIN search."
                    onClick={() => setGateTrackingHelpOpen((o) => !o)}
                  >
                    <Info className="h-4 w-4" strokeWidth={2} aria-hidden />
                  </button>
                  {gateTrackingHelpOpen ? (
                    <div
                      className="operator-shipment-entry-gate__help-tooltip absolute right-0 top-full z-30 mt-2 w-[min(calc(100vw-2rem),260px)] max-w-[min(20rem,calc(100vw-2rem))] rounded-xl border px-3 py-2.5 text-left text-[12px] font-medium leading-snug shadow-lg"
                      style={{ boxShadow: "0 12px 40px rgba(0,0,0,0.55)" }}
                      role="tooltip"
                    >
                      <span className="font-semibold">Lookup</span> uses an{" "}
                      <span className="font-mono text-[11px]">exact</span> match on tracking, slip, carton/package code, or
                      pallet for this organization and store. Product SKU/ASIN search is not used on this screen.
                    </div>
                  ) : null}
                </div>
              </div>
              <div
                className={`relative mt-3 rounded-[20px] transition-[box-shadow] ${
                  identifyGateOcrDropHighlight ? "operator-shipment-entry-gate__scan-zone--highlight ring-2 ring-[rgba(214,183,110,0.45)]" : ""
                }`}
                style={{
                  boxShadow: identifyGateOcrDropHighlight ? "0 0 28px rgba(214, 183, 110, 0.22)" : undefined,
                }}
                onDragOver={onIdentifyGateScanZoneDragOver}
                onDragLeave={onIdentifyGateScanZoneDragLeave}
                onDrop={onIdentifyGateScanZoneDrop}
              >
                <ScanFrameWithLaser
                  minHeight="120px"
                  laserColor="#D6B76E"
                  cornerColor="var(--scanner-bracket-cyan)"
                  cornerSize="lg"
                  dashedBorder={false}
                  subtleSweep
                  bracketGlow
                  successFlash={scanSuccessFlash}
                  frameClassName="operator-shipment-entry-gate__scan-preview"
                  frameStyle={{ borderWidth: 1 }}
                  onClick={focusScannerAggressive}
                >
                  <ScanLine className="operator-shipment-entry-gate__scan-icon h-10 w-10" strokeWidth={2.25} aria-hidden />
                </ScanFrameWithLaser>
                {identifyGateOcrDropHighlight ? (
                  <div
                    className="operator-shipment-entry-gate__ocr-drop pointer-events-none absolute inset-0 flex items-center justify-center rounded-[20px] border-2 border-dashed backdrop-blur-[1px]"
                    aria-hidden
                  >
                    <span className="operator-shipment-entry-gate__ocr-drop-label text-[13px] font-bold">
                      Drop JPG or PNG to read code
                    </span>
                  </div>
                ) : null}
              </div>
              <div className="mt-3">
                <input
                  ref={identifyGateCameraCaptureRef}
                  type="file"
                  accept="image/jpeg,image/jpg,image/png,.jpg,.jpeg,.png"
                  capture="environment"
                  className="sr-only"
                  tabIndex={-1}
                  aria-hidden
                  onChange={onIdentifyGateOcrFileInputChange}
                />
                <input
                  ref={identifyGateCameraUploadRef}
                  type="file"
                  accept=".jpg,.jpeg,.png,image/jpeg,image/png,image/jpg"
                  className="sr-only"
                  tabIndex={-1}
                  aria-hidden
                  onChange={onIdentifyGateOcrFileInputChange}
                />
                <div className="relative">
                  {isManualEntryMode ? (
                    <input
                      ref={gateManualInputRef}
                      id={`${formId}-gate-manual`}
                      value={scanLine}
                      onChange={(e) => handleManualScanLineChange(e.target.value)}
                      onFocus={() => setManualOpen(true)}
                      onBlur={() => {
                        window.setTimeout(() => {
                          manualEntryModeRef.current = false;
                          setManualOpen(false);
                          setManualEntryMode(false);
                        }, 120);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          void onSubmitScan();
                        }
                      }}
                      autoComplete="off"
                      autoCorrect="off"
                      spellCheck={false}
                      inputMode="text"
                      disabled={identifyGateOcrReading}
                      aria-busy={identifyGateOcrReading}
                      aria-label={
                        identifyGateOcrReading ? "Analyzing image" : "Type tracking or slip code"
                      }
                      placeholder="Type barcode manually"
                      className="operator-shipment-entry-gate__input scanner-input-glass min-h-[36px] w-full rounded-xl border py-1 pl-3 pr-[4.25rem] font-mono text-[13px] outline-none transition placeholder:text-[13px] disabled:cursor-not-allowed disabled:opacity-60"
                      style={{ color: TEXT_PRIMARY }}
                    />
                  ) : (
                    <button
                      type="button"
                      onClick={() => startManualEntryMode(gateManualInputRef)}
                      className="operator-shipment-entry-gate__input scanner-input-glass flex min-h-[36px] w-full items-center rounded-xl border py-1 pl-3 pr-[7.25rem] text-left font-mono text-[13px] outline-none transition"
                      style={{ color: MUTED_LABEL }}
                    >
                      <span className="min-w-0 truncate">Ready to scan</span>
                    </button>
                  )}
                  <div className="operator-shipment-entry-gate__action-cluster absolute right-1 top-1/2 z-[1] flex -translate-y-1/2 items-stretch">
                    {!isManualEntryMode ? (
                      <>
                        <button
                          type="button"
                          onClick={() => startManualEntryMode(gateManualInputRef)}
                          className="operator-shipment-entry-gate__tap-to-type inline-flex shrink-0 items-center gap-0.5 px-1.5 text-[9px] font-bold uppercase tracking-wider outline-none transition"
                        >
                          <Pencil className="h-2.5 w-2.5" strokeWidth={2.25} aria-hidden />
                          Tap to type
                        </button>
                        <span className="operator-shipment-entry-gate__action-divider self-center" aria-hidden />
                      </>
                    ) : null}
                    <div className="relative flex items-center">
                      <button
                        type="button"
                        disabled={busy || identifyGateOcrReading}
                        onClick={() => setIdentifyGateOcrMenuOpen(true)}
                        className="operator-shipment-entry-gate__camera-btn flex h-7 w-7 shrink-0 items-center justify-center rounded-md outline-none transition disabled:cursor-not-allowed disabled:opacity-35"
                        aria-label="Photo or upload for OCR"
                        aria-expanded={identifyGateOcrMenuOpen}
                        aria-haspopup="menu"
                        title="Camera or file (JPG / PNG)"
                      >
                        <Camera className="h-3.5 w-3.5" strokeWidth={2.25} aria-hidden />
                      </button>
                    </div>
                    <button
                      type="button"
                      disabled={busy || identifyGateOcrReading || !scanLine.trim()}
                      onClick={() => void onSubmitScan()}
                      title={identifyGateOcrReading ? "Wait for image analysis" : undefined}
                      className="operator-shipment-entry-gate__search-btn flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition disabled:cursor-not-allowed disabled:opacity-35"
                      aria-label={busy ? "Searching" : "Search"}
                    >
                      {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={2} /> : <Search className="h-3.5 w-3.5" strokeWidth={2.35} />}
                    </button>
                  </div>
                  {identifyGateOcrReading ? (
                    <div
                      className="scanner-ocr-reading-overlay absolute inset-0 z-[5] flex flex-col items-center justify-center gap-2 rounded-xl px-3 py-2 backdrop-blur-md"
                      role="status"
                      aria-live="polite"
                    >
                      <Loader2
                        className="operator-shipment-entry-gate__ocr-spinner h-7 w-7 animate-spin"
                        strokeWidth={2}
                      />
                      <span className="operator-shipment-entry-gate__ocr-reading text-center text-[12px] font-bold tracking-wide">
                        Reading code... {identifyGateOcrProgressPct}%
                      </span>
                    </div>
                  ) : null}
                </div>
              </div>
              {identifyGatePhotoOcrCandidates.length > 0 ? (
                <div
                  className="mt-3 rounded-2xl border border-[#b08a3c]/35 bg-[#fffaf0] px-3 py-3 text-[#16181b] shadow-[inset_0_1px_0_rgba(255,255,255,0.92),0_14px_32px_rgba(22,24,27,0.12)] dark:border-[#d6b76e]/45 dark:bg-[#0b0d10]/95 dark:text-[#faf6ed] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.05),0_14px_36px_rgba(0,0,0,0.34)]"
                  role="group"
                  aria-label="AI detected possible photo code"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-2">
                      <span
                        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-[#8a681f]/35 bg-[#8a681f]/10 text-[#6f5424] dark:border-[#d6b76e]/45 dark:bg-[#d6b76e]/12 dark:text-[#f1d58a]"
                        aria-hidden
                      >
                        <Sparkles className="h-3.5 w-3.5" strokeWidth={2.25} />
                      </span>
                      <div className="min-w-0">
                        <p className="text-[13px] font-black leading-tight text-[#16181b] dark:text-[#faf6ed]">Possible code found</p>
                        <p className="mt-0.5 text-[10px] font-semibold leading-tight text-[#4d5560] dark:text-[#faf6ed]/65">
                          Package, tracking, or shipment code found from photo. Please confirm before using it.
                        </p>
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <span className="rounded-full border border-[#8a681f]/35 bg-[#8a681f]/10 px-1.5 py-0.5 text-[8px] font-black uppercase leading-none tracking-wide text-[#524018] dark:border-[#d6b76e]/35 dark:bg-[#d6b76e]/10 dark:text-[#f1d58a]">
                        AI Detected
                      </span>
                      <button
                        type="button"
                        className="flex h-7 w-7 items-center justify-center rounded-full text-[#4d5560] transition hover:bg-[#8a681f]/10 hover:text-[#16181b] dark:text-[#faf6ed]/70 dark:hover:bg-white/10 dark:hover:text-[#faf6ed]"
                        aria-label="Dismiss AI detected code"
                        onClick={clearIdentifyGatePhotoOcrCandidates}
                      >
                        <X className="h-3.5 w-3.5" strokeWidth={2.4} aria-hidden />
                      </button>
                    </div>
                  </div>

                  <div className="mt-3 grid gap-1.5">
                    {identifyGatePhotoOcrCandidates.slice(0, 3).map((candidate) => {
                      const selected = candidate === identifyGateSelectedPhotoOcrCandidate;
                      return (
                        <button
                          key={candidate}
                          type="button"
                          className={`flex min-w-0 items-center justify-between gap-2 rounded-xl border px-2.5 py-2 text-left text-[#2f2410] transition active:scale-[0.99] dark:text-[#fef3c7] ${
                            selected
                              ? "border-[#8a681f]/60 bg-[#8a681f]/10 dark:border-[#d6b76e]/70 dark:bg-[#d6b76e]/15"
                              : "border-[#8a681f]/25 bg-white/45 dark:border-[#d6b76e]/25 dark:bg-black/25"
                          }`}
                          aria-pressed={selected}
                          onClick={() => setIdentifyGateSelectedPhotoOcrCandidate(candidate)}
                        >
                          <span className="min-w-0 break-all font-mono text-[18px] font-black leading-tight tracking-wide">
                            {candidate}
                          </span>
                          <span className="shrink-0 rounded-full border border-[#8a681f]/30 bg-[#8a681f]/10 px-1.5 py-0.5 text-[8px] font-black uppercase leading-none tracking-wide text-[#524018] dark:border-[#d6b76e]/35 dark:bg-[#d6b76e]/10 dark:text-[#f1d58a]">
                            AI Detected
                          </span>
                        </button>
                      );
                    })}
                  </div>

                  <div className="mt-3 grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      className="min-h-10 rounded-xl bg-[#1f242b] px-3 py-2 text-[12px] font-black uppercase tracking-wide text-[#fffaf0] shadow-[0_8px_18px_rgba(22,24,27,0.18)] transition active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50 dark:bg-[#d6b76e] dark:text-[#050607] dark:shadow-[0_10px_24px_rgba(214,183,110,0.18)]"
                      disabled={!identifyGateSelectedPhotoOcrCandidate && identifyGatePhotoOcrCandidates.length === 0}
                      onClick={() => void applyIdentifyGatePhotoOcrCandidate()}
                    >
                      Use this code
                    </button>
                    <button
                      type="button"
                      className="min-h-10 rounded-xl border border-[#8a681f]/35 bg-[#f8f6f1] px-3 py-2 text-[12px] font-bold uppercase tracking-wide text-[#524018] transition active:scale-[0.98] dark:border-[#d6b76e]/35 dark:bg-[#151a20] dark:text-[#f1d58a]"
                      onClick={retryIdentifyGatePhotoOcr}
                    >
                      Try again
                    </button>
                  </div>
                  <button
                    type="button"
                    className="mt-2 w-full rounded-lg px-2 py-1.5 text-center text-[11px] font-bold text-[#6f5424] underline decoration-[#8a681f]/35 underline-offset-2 transition hover:text-[#524018] dark:text-[#f1d58a]/85 dark:decoration-[#f1d58a]/35 dark:hover:text-[#faf6ed]"
                    onClick={startManualEntryFromPhotoOcrCandidate}
                  >
                    Manual Entry
                  </button>
                </div>
              ) : null}
              {identifyGatePhase === "searching" ? (
                <p className="operator-shipment-entry-gate__searching-label mt-4 flex items-center justify-center gap-2 text-[13px] font-semibold">
                  <Loader2 className="operator-shipment-entry-gate__searching-spinner h-5 w-5 animate-spin" strokeWidth={2} />
                  Searching inventory status…
                </p>
              ) : null}
              <div className="mt-3">
                <OperatorScanProgressStrip
                  phase={scanProgressPhase}
                  errorMessage={identifyGateError}
                />
              </div>
              {identifyGateDeepSearchRunning && busy ? (
                <p
                  className="mt-3 flex items-center justify-center gap-2 rounded-xl border px-3 py-2.5 text-center text-[12px] font-semibold leading-snug"
                  style={{ borderColor: "rgba(214,183,110,0.35)", backgroundColor: "rgba(214,183,110,0.08)", color: "#e8dcc0" }}
                >
                  <Loader2 className="h-4 w-4 shrink-0 animate-spin" aria-hidden />
                  Running deep search
                </p>
              ) : deepSearchAvailableFor && !busy ? (
                <div
                  className="mt-3 rounded-xl border px-3 py-2.5 text-center"
                  style={{ borderColor: "rgba(214,183,110,0.28)", backgroundColor: "rgba(214,183,110,0.06)" }}
                >
                  <p
                    className="mb-2 text-[11px] font-semibold leading-snug"
                    style={{ color: "#e8dcc0" }}
                  >
                    No exact shipment match. Run deep search or review manually.
                  </p>
                  <button
                    type="button"
                    onClick={handleDeepSearch}
                    className="rounded-xl border px-4 py-2 text-[12px] font-bold transition active:translate-y-px"
                    style={{
                      borderColor: "rgba(214,183,110,0.45)",
                      backgroundColor: "rgba(214,183,110,0.12)",
                      color: "#faf6ed",
                    }}
                  >
                    Deep search
                  </button>
                </div>
              ) : null}
              {identifyGateSlowHint && busy && scanProgressPhase !== "idle" ? (
                <p
                  className="mt-4 rounded-xl border px-3 py-2 text-center text-[12px] font-semibold leading-snug"
                  style={{
                    borderColor: "rgba(214,183,110,0.35)",
                    backgroundColor: "rgba(214,183,110,0.08)",
                    color: "#e8dcc0",
                  }}
                >
                  {identifyGateSlowHint}
                </p>
              ) : null}
              {identifyGateSlowHint && identifyGatePhase !== "searching" && !busy ? (
                <p
                  className="mt-3 rounded-xl border px-3 py-2 text-center text-[11px] font-semibold leading-snug text-[#524018] dark:text-[#f1d58a]"
                  style={{ borderColor: "rgba(138,104,31,0.35)", backgroundColor: "rgba(138,104,31,0.08)" }}
                >
                  {identifyGateSlowHint}
                </p>
              ) : null}
              {identifyGateError ? <OperatorCrossStoreScopeBanner message={identifyGateError} className="mt-3" /> : null}
              {awaitingPostCompleteExtraScan ? (
                <p
                  className="mt-4 rounded-xl border px-3 py-2 text-[11px] font-semibold leading-snug"
                  style={{
                    borderColor: "rgba(52,211,153,0.45)",
                    backgroundColor: "rgba(6,78,59,0.35)",
                    color: "#d1fae5",
                  }}
                >
                  Scan the extra item barcode — recorded as off-manifest when saved.
                </p>
              ) : null}
            </section>
          </div>

            {(identifyGatePhase === "matched" || identifyGatePhase === "new") && identifyGateInventoryVisual ? (
              <section
                key={`identify-gate-results-${identifyGatePhase}-${identifyGateInventoryVisual}`}
                data-gate-visual={identifyGateInventoryVisual}
                className={`operator-shipment-entry-gate__results animate-scanner-results-enter relative z-0 mb-0 w-full max-w-full overflow-x-hidden rounded-lg border px-4 py-4 sm:px-5 sm:py-5 border-[rgba(214,183,110,0.24)] bg-[rgba(255,255,255,0.025)] ${glassCard}${
                  identifyGateGlowFlash ? " operator-shipment-entry-gate__results--glow-flash" : ""
                }`}
              >
                <div
                  className="operator-shipment-entry-gate__results-veil pointer-events-none absolute inset-0 opacity-[0.14]"
                  style={{
                    background: `radial-gradient(120% 80% at 50% -10%, ${IDENTIFICATION_GATE_THEME[identifyGateInventoryVisual].chipBg}, transparent 55%)`,
                  }}
                  aria-hidden
                />
                <div className="absolute right-4 top-4 z-[2] flex items-center gap-1 sm:right-5 sm:top-5">
                  <span
                    data-gate-badge={identifyGateInventoryVisual}
                    className={`operator-shipment-entry-gate__status-badge inline-flex max-w-[10.5rem] items-center truncate rounded-full border ${SLIP_CARD_STATUS_BADGE} sm:max-w-[12rem]`}
                    style={{
                      borderColor: IDENTIFICATION_GATE_THEME[identifyGateInventoryVisual].border,
                      backgroundColor: IDENTIFICATION_GATE_THEME[identifyGateInventoryVisual].chipBg,
                      color: IDENTIFICATION_GATE_THEME[identifyGateInventoryVisual].headline,
                    }}
                  >
                    {identifyGateStatusBadgeLabel(
                      identifyGateInventoryVisual,
                      identifyGatePhase === "matched",
                    )}
                  </span>
                  {identifyGateInventoryVisual === "completed" ? (
                    <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-300/90" strokeWidth={2.25} aria-hidden />
                  ) : identifyGateInventoryVisual === "unexpected" || identifyGateInventoryVisual === "over_scanned" ? (
                    <AlertTriangle className="h-4 w-4 shrink-0 text-amber-200/90" strokeWidth={2.25} aria-hidden />
                  ) : null}
                </div>
                <div className="relative z-[1] pr-1 pt-1 sm:pr-2">
                  {(identifyGatePhase === "matched" || identifyGatePhase === "new") && identifyGateEnteredCode.trim() ? (
                    <div
                      className="operator-shipment-entry-gate__code-summary mb-4 rounded-lg border border-[rgba(185,194,204,0.16)] bg-[rgba(255,255,255,0.025)] px-2.5 py-2 text-[11px] sm:px-3"
                    >
                      {identifyGatePhase === "matched" && identifyGateMatchField ? (
                        <p className="font-semibold leading-snug text-white">
                          <span style={{ color: MUTED_LABEL }}>{identifyGateMatchFieldUiLabel(identifyGateMatchField)}</span>
                          <span className="ml-2 font-mono text-[13px] text-sky-100">{identifyGateEnteredCode.trim()}</span>
                        </p>
                      ) : (
                        <p className="font-semibold leading-snug text-white">
                          <span style={{ color: MUTED_LABEL }}>Code</span>
                          <span className="ml-2 font-mono text-[13px] text-sky-100">{identifyGateEnteredCode.trim()}</span>
                        </p>
                      )}
                      {identifyGatePhase === "matched" ? (
                        <p className="mt-1.5 text-[12px] leading-snug" style={{ color: MUTED_LABEL }}>
                          Order ID{" "}
                          <span className="font-mono font-semibold text-white">{identifyGateOrderIdsLabel}</span>
                        </p>
                      ) : null}
                    </div>
                  ) : null}

                  <p className="mb-1 max-w-[calc(100%-5.5rem)] text-[13px] font-medium leading-snug text-white/90">
                    {identifyGateInventoryVisual !== "manual_new" &&
                    identifyGateInventoryAgg?.totalScanned === 0 &&
                    identifyGateInventoryAgg.totalExpected > 0
                      ? "Expected shipment — no units scanned yet."
                      : identifyGateInventoryVisual === "manual_new" && identifyGatePhase === "new"
                      ? "No manifest lines for this code — create a record or pick entity type."
                      : identifyGateInventoryVisual === "new"
                        ? "Expected shipment — no units scanned yet."
                        : identifyGateInventoryVisual === "unexpected"
                          ? "Not on the expected list (0 expected)."
                          : identifyGateInventoryVisual === "in_progress"
                            ? "Receiving in progress — scanned below manifest total."
                            : identifyGateInventoryVisual === "completed"
                              ? "All manifest units accounted for."
                              : "Scanned exceeds expected — confirm to continue."}
                  </p>

                  {identifyGateInventoryVisual === "unexpected" ? (
                    <p
                      className="operator-shipment-entry-gate__alert operator-shipment-entry-gate__alert--unexpected mt-2 rounded-lg border px-3 py-2 text-[11px] font-semibold leading-snug text-violet-100/95"
                      style={{
                        borderColor: "rgba(168,85,247,0.4)",
                        backgroundColor: "rgba(88,28,135,0.28)",
                      }}
                    >
                      Not on expected list.
                    </p>
                  ) : null}
                  {identifyGateInventoryVisual === "over_scanned" ? (
                    <p
                      className="operator-shipment-entry-gate__alert operator-shipment-entry-gate__alert--over mt-2 rounded-lg border px-3 py-2 text-[11px] font-semibold leading-snug text-orange-100/95"
                      style={{
                        borderColor: "rgba(249,115,22,0.45)",
                        backgroundColor: "rgba(124,45,18,0.32)",
                      }}
                    >
                      Scanned quantity over expected.
                    </p>
                  ) : null}

                  {identifyGateInventoryVisual !== "manual_new" && identifyGateInventoryAgg ? (
                    <div className="mt-4">
                      <div className="mb-1.5 flex items-center justify-between gap-2 text-[12px] font-bold tabular-nums text-white">
                        <span style={{ color: MUTED_LABEL }}>Scan progress</span>
                        <span>
                          {formatInventoryProgressLabel(
                            identifyGateInventoryAgg.totalScanned,
                            identifyGateInventoryAgg.totalExpected,
                          )}
                        </span>
                      </div>
                      <div className="operator-shipment-entry-gate__progress-track h-3.5 w-full overflow-hidden rounded-full bg-black/40 ring-1 ring-white/10">
                        <div
                          className="operator-shipment-entry-gate__progress-fill h-full rounded-full transition-[width] duration-300"
                          style={{
                            width: `${safeInventoryProgressPercent(
                              identifyGateInventoryAgg.totalScanned,
                              identifyGateInventoryAgg.totalExpected,
                            )}%`,
                            background:
                              identifyGateInventoryVisual === "over_scanned"
                                ? "linear-gradient(90deg, #fb923c, #f97316)"
                                : identifyGateInventoryVisual === "completed"
                                  ? "linear-gradient(90deg, #34d399, #10b981)"
                                  : identifyGateInventoryVisual === "unexpected"
                                    ? "linear-gradient(90deg, #a78bfa, #7c3aed)"
                                    : "linear-gradient(90deg, #facc15, #eab308)",
                          }}
                        />
                      </div>
                    </div>
                  ) : null}

                  {identifyGateInventoryVisual !== "manual_new" && identifyGateViewHints?.carrier?.trim() ? (
                    <div className="mt-3 flex items-center gap-2 text-[11px] leading-snug">
                      <span style={{ color: MUTED_LABEL }}>Carrier</span>
                      <span className="inline-flex max-w-[80%] truncate rounded-full border border-white/10 bg-white/5 px-2 py-0.5 font-semibold text-white/90">
                        {identifyGateViewHints.carrier}
                      </span>
                    </div>
                  ) : null}

                  {identifyGatePhase === "matched" &&
                  (identifyGateExpectationLines.some(
                    (line) =>
                      line.product_linkage?.identifier_resolution_status === "unresolved" ||
                      line.product_linkage?.identifier_resolution_status === "ambiguous",
                  ) ||
                    identifyGateRows.some((raw) => {
                      const r = raw as Record<string, unknown>;
                      return Boolean(
                        String(r.identifier_resolution_status ?? "").trim() ||
                          String(r.product_match_status ?? "").trim() ||
                          r.product_review_required ||
                          String(r.identifier_resolution_source ?? "").trim(),
                      );
                    })) ? (
                    <div className="mt-5">
                      <p className="mb-2 text-[10px] font-bold uppercase tracking-widest text-slate-500">
                        Product resolution (expectation lines)
                      </p>
                      <ul className={`space-y-1.5 rounded-lg px-2 py-1.5 ${SLIP_CARD_SECTION}`}>
                        {identifyGateExpectationLines.length > 0
                          ? identifyGateExpectationLines
                              .filter(
                                (line) =>
                                  line.product_linkage?.identifier_resolution_status === "unresolved" ||
                                  line.product_linkage?.identifier_resolution_status === "ambiguous",
                              )
                              .slice(0, 12)
                              .map((line) => (
                                <li
                                  key={`ep-snap-${line.groupKey}`}
                                  className={`flex flex-col gap-0.5 border-b pb-1.5 last:border-b-0 last:pb-0 ${SLIP_CARD_DIVIDER}`}
                                >
                                  <ProductLinkagePrimaryLink
                                    linkage={line.product_linkage}
                                    detailFrom="scan"
                                    className={`operator-shipment-entry-gate__product-link ${SLIP_CARD_HEADING}`}
                                    onClick={(e) => e.stopPropagation()}
                                  />
                                  <div className={SLIP_CARD_META_LINKAGE}>
                                    <OperatorProductLinkageMeta
                                      linkage={line.product_linkage}
                                      linkResolvedProductId={false}
                                      detailFrom="scan"
                                    />
                                  </div>
                                  <span className={`tabular-nums ${SLIP_CARD_TECH_ID}`}>
                                    Exp {line.expectedQty} · Scan {line.scannedQty}
                                  </span>
                                </li>
                              ))
                          : identifyGateRows
                              .filter((raw) => {
                                const r = raw as Record<string, unknown>;
                                return Boolean(
                                  String(r.identifier_resolution_status ?? "").trim() ||
                                    String(r.product_match_status ?? "").trim() ||
                                    r.product_review_required ||
                                    String(r.identifier_resolution_source ?? "").trim(),
                                );
                              })
                              .slice(0, 12)
                              .map((raw, idx) => {
                                const linkage = buildExpectedPackageProductLinkage(
                                  raw as Record<string, unknown>,
                                  identifyGateResolvedNameMap,
                                );
                                return (
                                  <li
                                    key={`ep-res-${String((raw as { id?: string }).id ?? idx)}`}
                                    className={`flex flex-col gap-0.5 border-b pb-1.5 last:border-b-0 last:pb-0 ${SLIP_CARD_DIVIDER}`}
                                  >
                                    <ProductLinkagePrimaryLink
                                      linkage={linkage}
                                      detailFrom="scan"
                                      className={`operator-shipment-entry-gate__product-link ${SLIP_CARD_HEADING}`}
                                      onClick={(e) => e.stopPropagation()}
                                    />
                                    <div className={SLIP_CARD_META_LINKAGE}>
                                      <OperatorProductLinkageMeta
                                        linkage={linkage}
                                        linkResolvedProductId={false}
                                        detailFrom="scan"
                                      />
                                    </div>
                                  </li>
                                );
                              })}
                      </ul>
                    </div>
                  ) : null}

                  {identifyGatePhase === "matched" && identifyGateShipmentLines.length > 0 ? (
                    <div className="mt-5">
                      <p className="mb-2 text-[10px] font-bold uppercase tracking-widest text-slate-500">
                        Line items
                        <span className="ml-1.5 font-normal normal-case text-slate-500">
                          · exact{" "}
                          {identifyGateMatchField ? identifyGateMatchFieldUiLabel(identifyGateMatchField) : "tracking"}
                        </span>
                      </p>
                      <div className={`operator-shipment-entry-gate__line-items ${SLIP_CARD_SECTION}`}>
                        <div className={`grid grid-cols-[minmax(0,1fr)_auto_auto] gap-2 border-b bg-transparent px-2 py-1 text-[9px] font-bold uppercase tracking-wide text-neutral-500 ${SLIP_CARD_DIVIDER}`}>
                          <span>Product</span>
                          <span className="text-right tabular-nums">Expected</span>
                          <span className="text-right tabular-nums">Scanned</span>
                        </div>
                        <div
                          className={`operator-shipment-entry-gate__line-items-scroll operator-scan-panel__body${
                            identifyGateShipmentLines.length > 3
                              ? " operator-shipment-entry-gate__line-items-scroll--long"
                              : ""
                          }`}
                        >
                          <div className="grid gap-1 p-1">
                          {identifyGateShipmentLines.map((row, idx) => {
                            const vis = shipmentLineStatusVisual(row);
                            const th = IDENTIFICATION_GATE_THEME[vis];
                            const epRow =
                              identifyGateEpById.get(row.expected_package_id) ??
                              identifyGateEpBySkuFnsku.get(
                                `${(row.sku ?? "").trim().toLowerCase()}\u0000${(row.fnsku ?? "").trim().toLowerCase()}\u0000${(row.order_id ?? "").trim().toLowerCase()}`,
                              );
                            const lineLinkage = buildInventoryViewProductLinkage(
                              row,
                              epRow,
                              identifyGateResolvedNameMap,
                            );
                            const fnsku = row.fnsku?.trim() ?? "";
                            const asin = row.asin?.trim() ?? "";
                            const sku = row.sku?.trim() ?? "";
                            const primaryIdentifier = fnsku || asin || sku;
                            const primaryIdentifierLabel = fnsku ? "FNSKU" : asin ? "ASIN" : sku ? "SKU" : "Identifier";
                            const secondaryIdentifier = fnsku ? asin || sku : "";
                            const secondaryIdentifierLabel = fnsku && asin ? "ASIN" : fnsku && sku ? "SKU" : "";

                            return (
                              <div
                                key={`${row.expected_package_id}-${idx}`}
                                className="operator-shipment-entry-gate__line-item-card rounded-md bg-[rgba(255,255,255,0.025)] p-1.5"
                              >
                                <div className="flex min-w-0 items-start justify-between gap-2">
                                  <div className="min-w-0 flex-1">
                                    <ProductLinkagePrimaryLink
                                      linkage={lineLinkage}
                                      linkWhenResolved={false}
                                      className={`operator-shipment-entry-gate__product-link line-clamp-2 break-words ${SLIP_CARD_HEADING}`}
                                    />
                                    <div className={`mt-0.5 max-w-full overflow-hidden leading-tight ${SLIP_CARD_TECH_ID}`}>
                                      <span className="text-neutral-500">{primaryIdentifierLabel}</span>{" "}
                                      <span className="break-words">{primaryIdentifier || "—"}</span>
                                      {secondaryIdentifier ? (
                                        <>
                                          <span className="mx-1 text-neutral-600">|</span>
                                          <span className="text-neutral-500">{secondaryIdentifierLabel}</span>{" "}
                                          <span className="break-words">{secondaryIdentifier}</span>
                                        </>
                                      ) : null}
                                    </div>
                                    <div className={SLIP_CARD_META_LINKAGE}>
                                      <OperatorProductLinkageMeta
                                        linkage={lineLinkage}
                                        linkResolvedProductId={false}
                                        detailFrom="scan"
                                      />
                                    </div>
                                  </div>
                                  <span
                                    data-line-status={vis}
                                    className={`operator-shipment-entry-gate__line-item-status-badge shrink-0 rounded-full ${SLIP_CARD_STATUS_BADGE}`}
                                    style={{
                                      borderColor: th.border,
                                      backgroundColor: th.chipBg,
                                      color: th.headline,
                                    }}
                                  >
                                    {shipmentLineStatusLabel(row)}
                                  </span>
                                </div>
                                <div className={`mt-1 grid grid-cols-2 gap-1.5 uppercase tracking-wide ${SLIP_CARD_TECH_ID}`}>
                                  <div className="px-1 py-0.5">
                                    Expected{" "}
                                    <span className="float-right tabular-nums">
                                      {row.total_expected}
                                    </span>
                                  </div>
                                  <div className="px-1 py-0.5">
                                    Scanned{" "}
                                    <span className="float-right tabular-nums">
                                      {row.total_scanned}
                                    </span>
                                  </div>
                                </div>
                              </div>
                            );
                          })}
                          </div>
                        </div>
                      </div>
                    </div>
                  ) : null}

                  {(identifyGatePhase === "new" || identifyGatePhase === "matched") ? (
                    <>
                      <p className="mt-4 text-[10px] font-bold uppercase tracking-widest text-slate-500">Identify as</p>
                      <div className="operator-shipment-entry-gate__entity-grid mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
                        {(
                          [
                            ["pallet", "PALLET"] as const,
                            ["single_box", "SINGLE BOX / ITEM"] as const,
                          ] as const
                        ).map(([id, label]) => {
                          const selected = identifyGateEntity === id;
                          const th = IDENTIFICATION_GATE_THEME[identifyGateInventoryVisual];
                          return (
                            <button
                              key={id}
                              type="button"
                              onClick={() => {
                                setIdentifyGateEntity(id);
                                if (id !== "pallet") setIdentifyGatePhysicalBoxStr("");
                              }}
                              className={`operator-shipment-entry-gate__entity-btn rounded-xl border px-2 py-3 text-[11px] font-bold leading-snug transition active:scale-95 sm:min-h-[3.25rem] ${
                                selected
                                  ? "operator-shipment-entry-gate__entity-btn--selected"
                                  : "operator-shipment-entry-gate__entity-btn--idle"
                              }`}
                              style={{
                                borderColor: selected ? th.border : BORDER,
                                backgroundColor: selected ? th.chipBg : CARD_INNER,
                                color: selected ? th.headline : TEXT_PRIMARY,
                              }}
                            >
                              {label}
                            </button>
                          );
                        })}
                      </div>
                    </>
                  ) : null}
                  {showIdentifyGatePhysicalBoxInput ? (
                    <div className="mt-4">
                      <div className="flex items-center justify-center gap-2">
                        <label
                          htmlFor={`${formId}-gate-physical`}
                          className="flex shrink-0 flex-wrap items-center justify-center gap-1 text-[11px] font-bold uppercase tracking-widest text-slate-300"
                        >
                          <span>BOX count:</span>
                          <span className={REQ_MARK_CLASS}>(required)</span>
                        </label>
                        <div
                          className={`operator-shipment-entry-gate__box-stepper flex items-stretch overflow-hidden rounded-md border-2 bg-[#060a10] shadow-[inset_0_1px_8px_rgba(0,0,0,0.55)] transition ${
                            identifyGateBoxCountShowsError
                              ? "operator-shipment-entry-gate__box-stepper--error border-red-500/80 focus-within:border-red-400 focus-within:shadow-[inset_0_1px_8px_rgba(0,0,0,0.55),0_0_0_3px_rgba(248,113,113,0.3)]"
                              : "border-slate-600/80 focus-within:border-sky-400/65 focus-within:shadow-[inset_0_1px_8px_rgba(0,0,0,0.55),0_0_0_3px_rgba(56,189,248,0.22)]"
                          }`}
                        >
                          <button
                            type="button"
                            aria-label="Decrease box count"
                            disabled={(() => {
                              const n = Number.parseInt(identifyGatePhysicalBoxStr, 10);
                              return !Number.isFinite(n) || n <= 0;
                            })()}
                            onClick={() => {
                              const cur = Number.parseInt(identifyGatePhysicalBoxStr, 10);
                              if (!Number.isFinite(cur) || cur <= 1) {
                                setIdentifyGatePhysicalBoxStr("");
                                return;
                              }
                              setIdentifyGatePhysicalBoxStr(String(cur - 1));
                            }}
                            className="operator-shipment-entry-gate__box-stepper-btn flex h-9 w-9 shrink-0 items-center justify-center text-[18px] font-black text-slate-300 transition hover:bg-slate-700/40 active:scale-95 disabled:cursor-not-allowed disabled:opacity-35"
                          >
                            −
                          </button>
                          <input
                            id={`${formId}-gate-physical`}
                            type="tel"
                            inputMode="numeric"
                            pattern="[0-9]*"
                            autoComplete="off"
                            enterKeyHint="done"
                            maxLength={4}
                            value={identifyGatePhysicalBoxStr}
                            onFocus={() => setManualOpen(true)}
                            onBlur={() => {
                              window.setTimeout(() => setManualOpen(false), 120);
                            }}
                            onChange={(e) => {
                              const v = e.target.value.replace(/\D/g, "").slice(0, 4);
                              setIdentifyGatePhysicalBoxStr(v);
                            }}
                            aria-invalid={identifyGateBoxCountShowsError}
                            aria-label="Operator box count for pallet"
                            className="operator-shipment-entry-gate__box-stepper-input block h-9 w-[4.5rem] min-w-0 bg-transparent px-1 text-center font-mono text-[18px] font-black tabular-nums text-white outline-none"
                          />
                          <button
                            type="button"
                            aria-label="Increase box count"
                            onClick={() => {
                              const cur = Number.parseInt(identifyGatePhysicalBoxStr, 10);
                              const next = Number.isFinite(cur) ? Math.min(9999, cur + 1) : 1;
                              setIdentifyGatePhysicalBoxStr(String(next));
                            }}
                            className="operator-shipment-entry-gate__box-stepper-btn flex h-9 w-9 shrink-0 items-center justify-center text-[18px] font-black text-slate-300 transition hover:bg-slate-700/40 active:scale-95"
                          >
                            +
                          </button>
                        </div>
                      </div>
                      {identifyGateBoxCountShowsError ? (
                        <p className="mt-1.5 text-center text-[11px] font-bold text-red-400" role="alert">
                          Enter BOX count (integer ≥ 1).
                        </p>
                      ) : (
                        <p className="mt-1.5 text-center text-[10px] font-semibold" style={{ color: MUTED_LABEL }}>
                          BOXES on this pallet (saved with the pallet).
                        </p>
                      )}
                    </div>
                  ) : null}
                  <button
                    type="button"
                    disabled={
                      busy ||
                      !identifyGateMandatoryFieldsOk ||
                      identifyGateInventoryVisual === "completed" ||
                      Boolean(completedShipmentModal)
                    }
                    onClick={() => void handleIdentificationGatePrimaryCta()}
                    className="operator-shipment-entry-gate__primary-cta mt-5 flex min-h-[44px] w-full items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold leading-tight transition disabled:cursor-not-allowed disabled:opacity-35"
                  >
                    {identifyGateInventoryVisual === "completed" ? (
                      <ThumbsUp className="h-5 w-5" strokeWidth={2.25} />
                    ) : null}
                    {identificationGatePrimaryCta(
                      identifyGateInventoryVisual,
                      identifyGatePhase === "matched",
                    )}
                  </button>
                </div>
              </section>
            ) : null}
          </>
        ) : (
        <>
        {!isSupabaseConfigured() && flowPhase === "scan" ? (
          <p className={`${OP_SCAN_ALERT_WARNING} mb-3`}>
            Demo — PLT-, TRACK-, BOX-, SLIP-, or SKU patterns. Supabase optional.
          </p>
        ) : null}

        {isSupabaseConfigured() && !operatorStoresLoading && flowPhase === "scan" && !kioskStoreLocked && operatorStores.length === 0 ? (
          <p className={`${OP_SCAN_ALERT_ERROR} mb-3`}>
            No stores — add one in Settings, then refresh.
          </p>
        ) : null}

        {isSupabaseConfigured() && !operatorStoresLoading && flowPhase === "scan" && operatorStores.length > 0 && !sessionStoreId ? (
          <p className={`${OP_SCAN_ALERT_ERROR} mb-3`}>
            Pick a store above to continue.
          </p>
        ) : null}

        {flowPhase === "scan" && parentIdentified && !modernPalletWorkspace ? (
          <div className="operator-pallet-step-screen">
            {parentIdentified ? (
              <section
                className={`operator-pallet-docs-card operator-shipment-intake-card relative z-30 mb-1.5 space-y-2 rounded-2xl p-2 ${glassCard}`}
              >
                {/* `relative z-30` keeps the Carrier combobox above sibling glass cards (backdrop stacking). */}
                <div className="flex flex-wrap items-center gap-2">
                  <ClipboardList className="operator-shipment-section-icon h-4 w-4 shrink-0" strokeWidth={2} />
                  <div className="min-w-0">
                    <h2 className="operator-shipment-section-title text-[14px] leading-tight">
                      Documentation photos
                    </h2>
                    <p className="operator-pallet-section-subtitle mt-0.5 text-[10px] font-semibold uppercase tracking-widest">
                      Carrier · order · labels & proof
                    </p>
                  </div>
                </div>
                {shippingLabelPhotoUrls.length > 0 ? (
                  <p className="operator-pallet-attached-badge inline-flex w-fit max-w-full items-center gap-1.5 rounded-md border px-2 py-1 text-[10px] font-semibold uppercase tracking-wide">
                    <CheckCircle2 className="h-3 w-3 shrink-0" strokeWidth={2.5} />
                    Shipping label attached
                  </p>
                ) : null}
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div>
                    <label
                      htmlFor={slipCarrierOrderEditable ? `${formId}-pallet-carrier` : undefined}
                      className="operator-shipment-field-label mb-1 block text-[10px] font-semibold uppercase tracking-widest"
                    >
                      Carrier{" "}
                      <span className={REQ_MARK_CLASS}>(required)</span>
                    </label>
                    {slipCarrierOrderEditable ? (
                      <>
                        <CarrierCombobox
                          triggerId={`${formId}-pallet-carrier`}
                          value={palletCarrier}
                          otherSelected={palletCarrierOtherSelected}
                          invalid={
                            palletCarrierOtherSelected &&
                            palletCarrier.trim().length === 0
                          }
                          onPickKnown={(name) => {
                            setPalletCarrierOtherSelected(false);
                            commitPalletCarrierDraft(name);
                          }}
                          onPickOther={() => {
                            setPalletCarrierOtherSelected(true);
                            if (isKnownCarrierName(palletCarrier)) {
                              commitPalletCarrierDraft("");
                            }
                          }}
                          onRequestScanFocus={scheduleFocusScanner}
                        />
                        {palletCarrierOtherSelected ? (
                          <div className="relative z-50 mt-2">
                            <label
                              htmlFor={`${formId}-pallet-carrier-custom`}
                              className="operator-shipment-field-label mb-0.5 block text-[9px] font-semibold uppercase leading-tight tracking-wide"
                            >
                              Enter Carrier Name{" "}
                              <span className={REQ_STAR_CLASS}>*</span>
                            </label>
                            <input
                              id={`${formId}-pallet-carrier-custom`}
                              type="text"
                              value={palletCarrier}
                              onChange={(e) => commitPalletCarrierDraft(e.target.value)}
                              placeholder="Type here..."
                              autoComplete="off"
                              spellCheck={false}
                              className="operator-pallet-field-input relative z-50 h-9 w-full rounded-lg border px-3 text-[13px] outline-none transition focus:shadow-[0_0_0_2px_rgba(214,183,110,0.22)]"
                            />
                          </div>
                        ) : null}
                      </>
                    ) : (
                      <div
                        className="operator-pallet-field-readonly block h-9 rounded-md border px-3 leading-9 text-[13px] font-semibold"
                        aria-label={`Carrier: ${palletCarrier || "not set"}`}
                      >
                        {palletCarrier.trim().length > 0 ? (
                          palletCarrierOtherSelected ? (
                            <span>
                              <span className="operator-pallet-field-readonly__muted">Other:</span>{" "}
                              {palletCarrier}
                            </span>
                          ) : (
                            palletCarrier
                          )
                        ) : (
                          <span className="operator-pallet-field-readonly__empty">—</span>
                        )}
                      </div>
                    )}
                  </div>
                  <div>
                    <div className="mb-1 flex flex-wrap items-center gap-1.5">
                      <label
                        htmlFor={slipCarrierOrderEditable ? `${formId}-pallet-order-id` : undefined}
                        className="operator-shipment-field-label block text-[9px] font-semibold uppercase leading-tight tracking-wide mb-0.5"
                      >
                        Order ID{" "}
                        <span className="font-normal normal-case opacity-70">(optional)</span>
                      </label>
                    </div>
                    {slipCarrierOrderEditable ? (
                      <input
                        id={`${formId}-pallet-order-id`}
                        type="text"
                        autoComplete="off"
                        spellCheck={false}
                        value={palletOrderId}
                        onChange={(e) => onPalletOrderIdInputChange(e.target.value)}
                        placeholder="114-XXXXXXX-XXXXXXX"
                        title={palletMixedOrderIdsUi ? PALLET_ORDER_CONFLICT_TOOLTIP : undefined}
                        className="scanner-input-glass h-10 w-full rounded-lg border px-3 font-mono text-[13px] outline-none transition focus:shadow-[0_0_0_2px_rgba(214,183,110,0.22)]"
                        style={{ color: palletOrderIdFieldColor }}
                      />
                    ) : (
                      <div
                        className="operator-pallet-field-readonly block h-9 rounded-md border px-3 font-mono leading-9 text-[13px] font-semibold"
                        aria-label={`Order ID: ${palletIdentityOrderId || "not set"}`}
                        title={palletMixedOrderIdsUi ? PALLET_ORDER_CONFLICT_TOOLTIP : undefined}
                      >
                        {palletIdentityOrderId.length > 0 ? (
                          <span style={{ color: palletOrderIdFieldColor }}>{palletIdentityOrderId}</span>
                        ) : (
                          <span className="operator-pallet-field-readonly__empty">—</span>
                        )}
                      </div>
                    )}
                  </div>
                </div>
                <div className="operator-shipment-docs-list">
                  <div
                    className={[
                      "operator-shipment-docs-row relative",
                      shippingLabelPhotoUrls.length === 0 && !palletShipmentViewLocked
                        ? "operator-shipment-docs-row--active"
                        : "",
                      shippingLabelPhotoUrls.length > 0 ? "operator-shipment-docs-row--complete" : "",
                    ]
                      .filter(Boolean)
                      .join(" ")}
                  >
                    <MasterUploader
                      variant="compact"
                      compactShowTapSubtitle={
                        shippingLabelPhotoUrls.length === 0 && !palletShipmentViewLocked
                      }
                      label={
                        <>
                          SHIPPING LABEL{" "}
                          <span className="operator-shipment-req-mark font-normal normal-case">(required)</span>
                        </>
                      }
                      hint={null}
                      value={shippingLabelPhotoUrls}
                      onChange={handleShippingLabelPhotoUrlsChange}
                      organizationId={orgId}
                      alignedUpload={
                        operatorPalletAlignedUploadPaths
                          ? {
                              bucket: "media",
                              relativePathUnderOrg: operatorPalletAlignedUploadPaths.shipping,
                            }
                          : undefined
                      }
                      maxFiles={3}
                      disabled={!orgId?.trim()}
                      viewLocked={palletShipmentViewLocked}
                      className="operator-shipment-docs-uploader"
                    />
                  </div>
                  <div
                    className={[
                      "operator-shipment-docs-row",
                      shippingLabelPhotoUrls.length > 0 &&
                        palletPhotoUrls.length === 0 &&
                        !palletShipmentViewLocked
                        ? "operator-shipment-docs-row--active"
                        : "",
                      palletPhotoUrls.length > 0 ? "operator-shipment-docs-row--complete" : "",
                    ]
                      .filter(Boolean)
                      .join(" ")}
                  >
                    <MasterUploader
                      variant="compact"
                      compactShowTapSubtitle={
                        shippingLabelPhotoUrls.length > 0 &&
                        palletPhotoUrls.length === 0 &&
                        !palletShipmentViewLocked
                      }
                      label="Pallet photo (optional)"
                      hint={null}
                      value={palletPhotoUrls}
                      onChange={handlePalletPhotoUrlsChange}
                      organizationId={orgId}
                      alignedUpload={
                        operatorPalletAlignedUploadPaths
                          ? {
                              bucket: "media",
                              relativePathUnderOrg: operatorPalletAlignedUploadPaths.photos,
                            }
                          : undefined
                      }
                      maxFiles={3}
                      disabled={!orgId?.trim()}
                      viewLocked={palletShipmentViewLocked}
                      className="operator-shipment-docs-uploader"
                    />
                  </div>
                  <div
                    className={[
                      "operator-shipment-docs-row",
                      palletPhotoUrls.length > 0 &&
                        bolPhotoUrls.length === 0 &&
                        !palletShipmentViewLocked
                        ? "operator-shipment-docs-row--active"
                        : "",
                      bolPhotoUrls.length > 0 ? "operator-shipment-docs-row--complete" : "",
                    ]
                      .filter(Boolean)
                      .join(" ")}
                  >
                    <MasterUploader
                      variant="compact"
                      compactShowTapSubtitle={
                        palletPhotoUrls.length > 0 &&
                        bolPhotoUrls.length === 0 &&
                        !palletShipmentViewLocked
                      }
                      label="Bill of Lading (optional)"
                      hint={null}
                      value={bolPhotoUrls}
                      onChange={handleBolPhotoUrlsChange}
                      organizationId={orgId}
                      alignedUpload={
                        operatorPalletAlignedUploadPaths
                          ? {
                              bucket: "media",
                              relativePathUnderOrg: operatorPalletAlignedUploadPaths.bol,
                            }
                          : undefined
                      }
                      maxFiles={3}
                      disabled={!orgId?.trim()}
                      viewLocked={palletShipmentViewLocked}
                      className="operator-shipment-docs-uploader"
                    />
                  </div>
                </div>
              </section>
            ) : null}

            <section className={`operator-shipment-notes-card mb-2 rounded-xl p-3 ${glassCard}`}>
              <label
                htmlFor={`${formId}-pallet-general-notes`}
                className="operator-shipment-notes-label mb-1.5 block text-[10px] font-bold uppercase tracking-widest"
              >
                General notes <span className="font-normal normal-case opacity-70">(optional)</span>
              </label>
              <textarea
                id={`${formId}-pallet-general-notes`}
                value={palletNotes}
                onChange={(e) => setPalletNotes(e.target.value)}
                rows={3}
                placeholder="Team-visible notes for this pallet…"
                readOnly={!slipCarrierOrderEditable}
                tabIndex={slipCarrierOrderEditable ? undefined : -1}
                aria-readonly={!slipCarrierOrderEditable}
                className="scanner-input-glass w-full resize-y rounded-lg border px-3 py-2 text-[13px] outline-none transition read-only:cursor-default focus:shadow-[0_0_0_2px_rgba(214,183,110,0.22)]"
                style={{ color: TEXT_PRIMARY }}
              />
            </section>

            <div className="operator-pallet-actions mb-[calc(1rem+env(safe-area-inset-bottom,0px))] flex w-full justify-center px-4 pb-0">
              <div className="flex w-full max-w-md flex-wrap justify-center gap-4 sm:flex-nowrap">
                <button
                  type="button"
                  disabled={confirmSaving}
                  onClick={() => {
                    modalOpenRef.current = true;
                    setCancelShipmentConfirmOpen(true);
                  }}
                  className="operator-pallet-btn-cancel flex h-[48px] min-h-[48px] min-w-[9.5rem] flex-1 items-center justify-center rounded-[14px] px-4 text-[13px] transition active:scale-95 disabled:cursor-not-allowed disabled:opacity-35 sm:flex-1"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={confirmSaving}
                  onClick={() => {
                    modalOpenRef.current = true;
                    setSaveShipmentConfirmOpen(true);
                  }}
                  className="operator-pallet-btn-primary flex h-[48px] min-h-[48px] min-w-[9.5rem] flex-1 items-center justify-center gap-2 rounded-[14px] px-4 text-[14px] transition active:scale-95 disabled:cursor-not-allowed disabled:opacity-35 sm:flex-1"
                >
                  {confirmSaving ? (
                    <Loader2 className="h-4 w-4 animate-spin" strokeWidth={2.25} />
                  ) : (
                    <ScanLine className="h-4 w-4" strokeWidth={2.25} />
                  )}
                  {confirmSaving ? "Saving…" : "Save & Start Scan"}
                </button>
              </div>
            </div>
          </div>
        ) : null}

        {ENABLE_LEGACY_MOBILE_WORKSPACE && flowPhase === "scan" && (!parentIdentified || modernPalletWorkspace) ? (
          <>
            <section className={`mb-4 rounded-[22px] p-3 ${glassCard}`}>
              <div className="flex gap-2.5">
                <div
                  className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ring-1"
                  style={{
                    backgroundColor: "rgba(56,189,248,0.08)",
                    borderColor: "rgba(56,189,248,0.18)",
                    boxShadow: "0 0 10px rgba(56,189,248,0.12)",
                  }}
                >
                  <div className="relative flex items-end gap-0.5 pb-0.5">
                    <Package className="relative z-[1] h-6 w-6 drop-shadow-[0_2px_4px_rgba(37,99,235,0.4)]" style={{ color: ACCENT_BLUE }} strokeWidth={2} />
                    <Warehouse className="-ml-2 h-5 w-5 opacity-85" style={{ color: ACTION_BLUE }} strokeWidth={2} />
                  </div>
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-start justify-between gap-2">
                    <h2 className="text-[16px] font-bold leading-tight tracking-tight" style={{ color: TEXT_PRIMARY }}>
                      {trackingIdentified ? "Tracking locked" : "Scan barcode"}
                    </h2>
                    <div className="relative shrink-0">
                      <button
                        type="button"
                        aria-expanded={scanBarcodeHelpOpen}
                        aria-label="Scan instructions"
                        onClick={() => setScanBarcodeHelpOpen((o) => !o)}
                        className="operator-info-icon-pulse flex h-7 w-7 items-center justify-center rounded-lg border border-black/10 text-slate-500 transition hover:border-black/15 hover:bg-black/[0.04] hover:text-slate-700 active:scale-95 dark:border-white/10 dark:text-slate-400 dark:hover:border-white/15 dark:hover:bg-white/5 dark:hover:text-slate-300"
                      >
                        <Info className="h-3.5 w-3.5" strokeWidth={2} />
                      </button>
                      {scanBarcodeHelpOpen ? (
                        <>
                          <button
                            type="button"
                            aria-label="Close instructions"
                            className="fixed inset-0 z-[122] cursor-default bg-black/45"
                            onClick={() => setScanBarcodeHelpOpen(false)}
                          />
                          <div
                            role="dialog"
                            aria-label="Scan instructions"
                            className="absolute right-0 top-[calc(100%+10px)] z-[123] w-[min(92vw,304px)] rounded-[18px] border p-3.5 shadow-[0_16px_40px_rgba(0,0,0,0.55)]"
                            style={{ borderColor: BORDER, backgroundColor: CARD_INNER, color: TEXT_PRIMARY }}
                          >
                            <p className="text-[12px] font-semibold leading-relaxed" style={{ color: MUTED_LABEL }}>
                              {trackingIdentified ? (
                                <>
                                  Expected lines come from the expected box worklist for this tracking and store. Capture slip photos on
                                  this step, then start box scan.
                                </>
                              ) : (
                                <>
                                  Scan a pallet label, tracking label, carton, slip, or item code. When you lock onto a tracking, lines
                                  match the expected box worklist for this org and store.
                                </>
                              )}
                            </p>
                            <p className="mt-2.5 text-[11px] font-medium leading-snug" style={{ color: MUTED_LABEL }}>
                              <span className="font-semibold text-slate-300">No pallet?</span> Scan the carton directly or use{" "}
                              <span className="font-semibold text-slate-300">Direct Box Scan</span> below.
                            </p>
                          </div>
                        </>
                      ) : null}
                    </div>
                  </div>
                </div>
              </div>

              <div className="mt-2">
                <ScanFrameWithLaser
                  minHeight="76px"
                  laserColor={ACCENT_BLUE}
                  cornerColor="var(--scanner-bracket-cyan)"
                  cornerSize="sm"
                  dashedBorder={false}
                  subtleSweep
                  bracketGlow
                  successFlash={scanSuccessFlash}
                  frameStyle={{
                    borderColor: "rgba(148,163,184,0.22)",
                    borderWidth: 1,
                    backgroundColor: BG,
                    boxShadow: "inset 0 1px 8px rgba(0,0,0,0.28)",
                  }}
                  onClick={focusScannerAggressive}
                >
                  <Barcode className="h-8 w-8 opacity-45" strokeWidth={1.25} style={{ color: MUTED_LABEL }} />
                </ScanFrameWithLaser>
              </div>

              <div className="mt-2">
                <div className="relative">
                  {isManualEntryMode ? (
                    <>
                      <input
                        ref={palletManualInputRef}
                        id={`${formId}-scan-manual`}
                        value={scanLine}
                        onChange={(e) => handleManualScanLineChange(e.target.value)}
                        onFocus={() => setManualOpen(true)}
                        onBlur={() => {
                          window.setTimeout(() => {
                            manualEntryModeRef.current = false;
                            setManualOpen(false);
                            setManualEntryMode(false);
                          }, 120);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            void onSubmitScan();
                          }
                        }}
                        autoComplete="off"
                        autoCorrect="off"
                        spellCheck={false}
                        inputMode="text"
                        placeholder="Type barcode manually"
                        className="scanner-input-glass h-9 w-full rounded-lg border py-0 pl-3 pr-[4.25rem] font-mono text-[13px] outline-none transition placeholder:opacity-50 focus:border-teal-400/45 focus:shadow-[0_0_0_2px_rgba(45,212,191,0.22)]"
                        style={{ color: TEXT_PRIMARY }}
                      />
                      <button
                        type="button"
                        disabled={busy || !scanLine.trim()}
                        onClick={() => void onSubmitScan()}
                        className="absolute right-1 top-1/2 flex h-7 min-w-[3.25rem] -translate-y-1/2 items-center justify-center rounded-md text-[10px] font-bold text-teal-100/95 transition hover:bg-teal-500/15 disabled:cursor-not-allowed disabled:opacity-35"
                        style={{
                          color: "#99f6e4",
                        }}
                      >
                        {busy ? "…" : "Apply"}
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      onClick={() => startManualEntryMode(palletManualInputRef)}
                      className="scanner-input-glass flex h-9 w-full items-center justify-between gap-3 rounded-lg border py-0 pl-3 pr-3 text-left font-mono text-[13px] outline-none transition"
                      style={{ color: MUTED_LABEL }}
                    >
                      <span>Ready to scan</span>
                      <span className="inline-flex shrink-0 items-center gap-1 text-[9px] font-bold uppercase tracking-wider text-sky-200/85">
                        <Pencil className="h-3 w-3" strokeWidth={2.25} aria-hidden />
                        Tap to type
                      </span>
                    </button>
                  )}
                </div>
              </div>
            </section>

            <section
              className={`mb-3 rounded-xl p-3 ${glassCard}`}
              style={{
                borderColor: parentIdentified ? (trackingIdentified ? PURPLE_RING : "rgba(45,212,191,0.35)") : BORDER,
                boxShadow: parentIdentified
                  ? trackingIdentified
                    ? `inset 0 0 0 1px rgba(167,139,250,0.12)`
                    : `inset 0 0 0 1px rgba(45,212,191,0.1)`
                  : undefined,
              }}
            >
              <div className="mb-1.5 flex flex-col gap-1">
                <div className="flex items-center gap-2">
                  <Package
                    className="h-4 w-4 shrink-0"
                    strokeWidth={2}
                    style={{ color: trackingIdentified ? ACTION_PURPLE : parentIdentified ? TEAL_STEP : ACCENT_BLUE }}
                  />
                  <h3 className="text-sm font-bold tracking-tight text-slate-400">Expected Inventory Summary</h3>
                </div>
                {parentIdentified ? (
                  <p className="text-[12px] font-semibold" style={{ color: MUTED_LABEL }}>
                    Parent{" "}
                    <span
                      className="font-mono font-bold"
                      style={{ color: trackingIdentified ? ACTION_PURPLE : TEAL_STEP }}
                    >
                      {trackingIdentified
                        ? activePallet?.id
                          ? (currentPalletTrackingId ?? "").trim() || slipBarcodeExtract?.shipmentId?.trim() || activePallet?.pallet_number
                          : activeTracking
                        : activePallet?.pallet_number}
                    </span>
                  </p>
                ) : (
                  <p className="text-[12px] font-medium" style={{ color: MUTED_LABEL }}>
                    Scan a pallet or tracking to load expected boxes.
                  </p>
                )}
              </div>
              {!parentIdentified ? (
                <p className="text-[13px] font-medium" style={{ color: MUTED_LABEL }}>
                  No parent selected.
                </p>
              ) : expectedPkgLines.length === 0 ? (
                <p className="text-[13px] font-medium" style={{ color: MUTED_LABEL }}>
                  No expected boxes for this parent (store + worklist).
                </p>
              ) : (
                <ul className="list-none divide-y divide-slate-700/50">
                  {expectedPkgLines.map((line) => (
                    <ExpectedInventoryLineRow
                      key={line.groupKey}
                      line={line}
                      accent={trackingIdentified ? "purple" : "teal"}
                    />
                  ))}
                </ul>
              )}
            </section>

            <section className={`mb-3 grid gap-2 ${parentIdentified ? "grid-cols-3" : "grid-cols-2 sm:grid-cols-4"}`}>
              {parentIdentified ? (
                <>
                  <PalletScanStatTile
                    label="Expected Boxes"
                    value={
                      typeof physicalBoxCount === "number" && physicalBoxCount > 0
                        ? String(physicalBoxCount)
                        : "—"
                    }
                    icon={ClipboardList}
                    glow="blue"
                    iconColor={ACCENT_BLUE}
                    valueColor={ACTION_BLUE}
                  />
                  <PalletScanStatTile
                    label="Scanned Boxes"
                    value={String(palletDashboardScannedBoxCount)}
                    icon={ScanLine}
                    glow="green"
                    iconColor={SUCCESS}
                    valueColor={SUCCESS}
                    onClick={handlePalletSummaryScannedClick}
                    interactionDisabled={palletSummaryTilesInteractionLocked}
                  />
                  <PalletScanStatTile
                    label="Remaining Boxes"
                    value={
                      typeof physicalBoxCount === "number" && physicalBoxCount > 0
                        ? String(Math.max(0, physicalBoxCount - palletDashboardScannedBoxCount))
                        : "—"
                    }
                    icon={Package}
                    glow="purple"
                    iconColor={ACCENT_PURPLE}
                    valueColor="#e9d5ff"
                    onClick={handlePalletSummaryRemainingClick}
                    interactionDisabled={palletSummaryTilesInteractionLocked}
                  />
                </>
              ) : (
                <>
                  <PalletScanStatTile
                    label="Total Boxes"
                    value={stats ? String(stats.totalBoxes) : "—"}
                    icon={Package}
                    glow="teal"
                    iconColor={TEAL_STEP}
                    valueColor={TEAL_STEP}
                  />
                  <PalletScanStatTile
                    label="Expected Boxes"
                    value="—"
                    icon={ClipboardList}
                    glow="blue"
                    iconColor={ACCENT_BLUE}
                    valueColor={TEXT_PRIMARY}
                  />
                  <PalletScanStatTile
                    label="Scanned Boxes"
                    value="—"
                    icon={ScanLine}
                    glow="green"
                    iconColor={SUCCESS}
                    valueColor={SUCCESS}
                  />
                  <PalletScanStatTile
                    label="Remaining Boxes"
                    value="—"
                    icon={Package}
                    glow="purple"
                    iconColor={ACCENT_PURPLE}
                    valueColor="#e9d5ff"
                  />
                </>
              )}
            </section>

            {parentIdentified ? (
              <button
                type="button"
                onClick={() => continueModernPalletToBoxInfo()}
                className={`mb-4 flex w-full items-center justify-center gap-1.5 rounded-xl border border-[#C8A96A]/60 bg-gradient-to-b from-[#2a313a] to-[#0c0f13] px-4 text-[#faf6ed] transition active:translate-y-px disabled:cursor-not-allowed disabled:opacity-40 ${ZEBRA_COMPACT_BTN}`}
              >
                <ScanLine className="h-5 w-5 shrink-0" strokeWidth={2.5} aria-hidden />
                Continue to Box Info
              </button>
            ) : (
              <button
                type="button"
                onClick={() => {
                  setDirectBox(true);
                  setActivePallet(null);
                  setActiveTracking(null);
                  setActiveSlipOrPackage(null);
                  setExpectedPkgLines([]);
                  setExpectedPkgTotals(null);
                  setExpectedPackagesRawRowCount(null);
                }}
                className="mb-4 w-full rounded-[16px] border py-3 text-[11px] font-bold uppercase tracking-wide transition hover:bg-white/5"
                style={{ borderColor: "rgba(56,189,248,0.25)", color: ACCENT_BLUE, backgroundColor: "rgba(56,189,248,0.06)" }}
              >
                No Pallet / Direct Box Scan
              </button>
            )}
          </>
        ) : null}

        {flowPhase === "package_scan" ? (
          <>
            {!parentIdentified ? (
              <p className={`${OP_SCAN_ALERT_ERROR} mb-4`}>
                Identify a pallet or tracking parent before BOX intake.
              </p>
            ) : (
              <div className="operator-box-info-screen flex flex-col gap-1 overflow-visible pb-2">
                {isSupabaseConfigured() && !operatorStoresLoading && !kioskStoreLocked && operatorStores.length === 0 ? (
                  <p className={`${OP_SCAN_ALERT_ERROR} mb-4`}>
                    No active stores for this organization — add a store in Settings before saving BOX records.
                  </p>
                ) : null}

                {isSupabaseConfigured() && !operatorStoresLoading && operatorStores.length > 0 && !sessionStoreId ? (
                  <p className={`${OP_SCAN_ALERT_ERROR} mb-4`}>
                    Select an active store above — saving BOX records requires a store scope.
                  </p>
                ) : null}

                {duplicatePackingSlip ? (
                  <OperatorDuplicatePackingSlipBanner
                    slipCode={duplicatePackingSlip.slipCode}
                    otherPackageCode={duplicatePackingSlip.otherPackageCode}
                    onDismiss={() => setDuplicatePackingSlip(null)}
                    className="mb-4"
                  />
                ) : null}

                {boxIntakeError ? (
                  <OperatorCrossStoreScopeBanner message={boxIntakeError} className="mb-4" />
                ) : null}

                {packageCodeCardOpen && !activeBoxSession ? (
                  <div className="mb-1 flex justify-end">
                    <button
                      type="button"
                      onClick={() => handleScannerBack()}
                      className="inline-flex items-center gap-1.5 rounded-xl border px-3 py-2 text-[11px] font-bold uppercase tracking-wide text-white/90 transition hover:bg-white/[0.06] active:scale-[0.98]"
                      style={{ borderColor: BORDER, backgroundColor: CARD_INNER }}
                    >
                      <ArrowLeft className="h-4 w-4 shrink-0" strokeWidth={2.25} />
                      Cancel / Back
                    </button>
                  </div>
                ) : null}

                {operatorSavedBoxSearchAvailable &&
                !(packageCodeCardOpen && !activeBoxSession) &&
                !activeBoxSession ? (
                  <section
                    id="operator-saved-boxes-hub"
                    className={`operator-box-info-hub relative z-[100] mb-3 overflow-visible rounded-xl p-3 ${glassCard}`}
                  >
                    <>
                        <button
                          type="button"
                          onClick={() => {
                            setPackageCodeCardOpen(true);
                            setBoxIntakeError(null);
                            setPalletPackagePickerQuery("");
                          }}
                          className="operator-box-info-add-btn mb-2 flex min-h-[3.25rem] w-full items-center justify-center gap-1.5 rounded-xl border-2 px-4 py-3 text-[14px] font-black uppercase tracking-wide transition active:scale-[0.99]"
                        >
                          <Plus className="h-5 w-5 shrink-0" strokeWidth={2.5} aria-hidden />
                          Add New Box
                        </button>
                        <div id="operator-saved-boxes-filter" className="scroll-mt-28">
                        <label className="operator-box-info-filter-label mb-1 block text-[9px] font-bold uppercase tracking-widest">
                          Filter saved boxes
                        </label>
                        <div className="overflow-visible">
                          <input
                            ref={palletPackageSearchInputRef}
                            type="text"
                            value={palletPackagePickerQuery}
                            onChange={(e) => setPalletPackagePickerQuery(e.target.value)}
                            onFocus={() => {
                              try {
                                window.getSelection()?.removeAllRanges();
                              } catch {
                                /* ignore */
                              }
                            }}
                            placeholder="Type to filter (optional)…"
                            autoComplete="off"
                            spellCheck={false}
                            className="operator-box-info-filter w-full rounded-lg border px-3 py-2.5 font-mono text-[12px] outline-none transition"
                            style={{ color: TEXT_PRIMARY }}
                          />
                          {palletPackagePickerQuery.trim().length > 0 &&
                          palletPackagePickerFiltered.length === 0 &&
                          palletPackagePickerList.length > 0 ? (
                            <p className="mt-2 text-[10px] font-medium" style={{ color: MUTED_LABEL }}>
                              No saved boxes match that search.
                            </p>
                          ) : null}
                          {palletPackagePickerFiltered.length > 0 ? (
                            <div
                              className="operator-box-info-list operator-scan-panel__body mt-2 max-h-[min(52vh,280px)] rounded-lg border py-0.5 shadow-inner"
                              role="listbox"
                              aria-label={
                                palletPackagePickerQuery.trim()
                                  ? "Saved boxes matching search"
                                  : "All saved boxes on this pallet"
                              }
                              style={{ backgroundColor: CARD_INNER, borderColor: BORDER }}
                            >
                              {palletPackagePickerFiltered.map((p) => {
                                const st = resolveOperatorPackagePickerRowStatus(p);
                                const badge = operatorPackagePickerStatusBadge(st);
                                const itemLine = formatOperatorPackagePickerItemLine(p);
                                const code = String(p.package_code ?? "").trim() || "—";
                                return (
                                  <button
                                    key={`saved-pkg-${p.id}`}
                                    type="button"
                                    className="operator-saved-box-row flex w-full items-center justify-between gap-2 border-b px-3 py-2 text-left transition last:border-b-0"
                                    style={{ color: TEXT_PRIMARY }}
                                    onMouseDown={(e) => e.preventDefault()}
                                    onClick={() => handlePickExistingPalletPackage(p)}
                                  >
                                    <div className="min-w-0 flex-1">
                                      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
                                        <span className="operator-saved-box-row__code font-mono text-[12px] font-black leading-tight">
                                          {code}
                                        </span>
                                        <span className="operator-saved-box-row__items text-[11px] font-extrabold tabular-nums">
                                          {itemLine}
                                        </span>
                                      </div>
                                      {p.tracking_number ? (
                                        <span className="operator-saved-box-row__tn mt-0.5 block truncate text-[9px] font-semibold">
                                          TN: <span className="font-mono">{p.tracking_number}</span>
                                        </span>
                                      ) : null}
                                    </div>
                                    <span
                                      data-picker-status={st}
                                      className="operator-saved-box-row__badge shrink-0 self-center rounded-md border px-1.5 py-0.5 text-[8px] font-black uppercase leading-tight tracking-wide"
                                      style={{
                                        borderColor: badge.border,
                                        backgroundColor: badge.bg,
                                        color: badge.color,
                                      }}
                                    >
                                      {badge.label}
                                    </span>
                                  </button>
                                );
                              })}
                            </div>
                          ) : null}
                        </div>
                        </div>
                        {palletPackagePickerList.length === 0 ? (
                          <p className="mt-2 text-[10px] font-medium" style={{ color: MUTED_LABEL }}>
                            No saved boxes on this pallet yet.
                          </p>
                        ) : null}
                      </>
                  </section>
                ) : null}

                {/* Inputs: carton lock first, then slip+carrier row, then order+rma row. */}
                {showOperatorPackageIntakePanel ? (
                  <>
                    <section className={`operator-shipment-intake-shell relative z-20 mb-0 space-y-0.5`}>
                  {!activeBoxSession ? (
                  <div>
                    <div className="mb-1 flex items-center justify-between gap-2">
                      <label
                        htmlFor={`${formId}-box-intake-manual`}
                        className="operator-shipment-field-label block text-[9px] font-semibold uppercase leading-tight tracking-wide mb-0.5"
                      >
                        PACKAGE CODE <span className="font-normal normal-case opacity-70">(scan / type — Apply to lock)</span>
                      </label>
                    </div>
                    <div className="flex gap-2">
                      {isManualEntryMode ? (
                        <>
                          <input
                            ref={boxManualInputRef}
                            id={`${formId}-box-intake-manual`}
                            value={currentPackageTrackingId ?? ""}
                            onChange={(e) => {
                              const v = e.target.value;
                              setCurrentPackageTrackingId(v === "" ? null : v);
                            }}
                            onFocus={() => setManualOpen(true)}
                            onBlur={() => {
                              window.setTimeout(() => {
                                manualEntryModeRef.current = false;
                                setManualOpen(false);
                                setManualEntryMode(false);
                              }, 120);
                            }}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") {
                                e.preventDefault();
                                void onSubmitScan();
                              }
                            }}
                            autoComplete="off"
                            autoCorrect="off"
                            spellCheck={false}
                            inputMode="text"
                            placeholder="Type barcode manually"
                            disabled={Boolean(activeBoxSession)}
                            className="scanner-input-glass min-h-[2.75rem] min-w-0 flex-1 rounded-lg border px-3 font-mono text-[13px] outline-none transition disabled:opacity-45"
                            style={{ color: TEXT_PRIMARY }}
                          />
                          <button
                            type="button"
                            disabled={busy || !(currentPackageTrackingId ?? "").trim() || Boolean(activeBoxSession)}
                            onClick={() => void onSubmitScan()}
                            className="operator-box-info-apply-btn flex h-[2.75rem] shrink-0 items-center justify-center gap-1.5 rounded-lg border-2 px-3 text-[12px] font-bold transition disabled:opacity-40"
                          >
                            <ScanLine className="h-4 w-4" strokeWidth={2} />
                            Apply
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          onClick={() => startManualEntryMode(boxManualInputRef)}
                          className="scanner-input-glass flex min-h-[2.75rem] min-w-0 flex-1 items-center justify-between gap-3 rounded-lg border px-3 text-left font-mono text-[13px] outline-none transition"
                          style={{ color: MUTED_LABEL }}
                        >
                          <span>Ready to scan</span>
                          <span className="inline-flex shrink-0 items-center gap-1 text-[9px] font-bold uppercase tracking-wider text-sky-200/85">
                            <Pencil className="h-3 w-3" strokeWidth={2.25} aria-hidden />
                            Tap to type
                          </span>
                        </button>
                      )}
                    </div>
                    {scanProgressPhase !== "idle" ? (
                      <OperatorScanProgressStrip phase={scanProgressPhase} className="mt-2" />
                    ) : (
                      <div className="mt-2 min-h-[2.75rem]" aria-hidden />
                    )}
                  </div>
                  ) : null}

                  <div className="relative min-h-[1px]">
                    {boxScanDocumentationLocked ? (
                      <button
                        type="button"
                        tabIndex={-1}
                        aria-label="Apply package barcode before documentation"
                        className="absolute inset-0 z-[25] cursor-not-allowed rounded-lg bg-transparent"
                        onClick={() =>
                          setIntakeToast("Please scan the box barcode first to start documentation.")
                        }
                      />
                    ) : null}
                    <div
                      className={
                        boxScanDocumentationLocked
                          ? `pointer-events-none select-none opacity-[0.42] ${activeBoxSession ? "flex flex-col gap-3" : "space-y-3"}`
                          : activeBoxSession
                            ? "flex flex-col gap-2"
                            : "space-y-3"
                      }
                    >
                  {showBoxIntakeShipmentDocumentation ? (
                  <section
                    className={[
                      `${BOX_INFO_SECTION} operator-shipment-section--docs relative z-20 mb-0 space-y-1`,
                    ]
                      .filter(Boolean)
                      .join(" ")}
                  >
                    <div className="flex items-center gap-1.5">
                      <ClipboardList className="operator-shipment-section-icon h-3.5 w-3.5 h-3 w-3" strokeWidth={2} />
                      <div className="min-w-0">
                        <p className="operator-shipment-section-title">Shipment Documentation</p>
                        <p
                          className={[
                            "mt-0.5 text-[10px] font-medium normal-case tracking-normal",
                            directBoxShipmentLabelUploaded
                              ? "text-emerald-700 dark:text-emerald-300/90"
                              : "text-slate-500 dark:text-slate-400",
                          ]
                            .filter(Boolean)
                            .join(" ")}
                        >
                          {directBoxShipmentDocsSubtitle}
                        </p>
                      </div>
                    </div>
                    <div className={BOX_INFO_DOCS_LIST}>
                      <div
                        className={[
                          BOX_INFO_DOCS_ROW_BASE,
                          shippingLabelPhotoUrls.length === 0 &&
                          !boxScanDocumentationLocked &&
                          !savedBoxIntakeViewLocked
                            ? BOX_INFO_DOCS_ROW_ACTIVE
                            : shippingLabelPhotoUrls.length > 0
                              ? `${BOX_INFO_DOCS_ROW_SURFACE} ${BOX_INFO_DOCS_ROW_COMPLETE}`
                              : `${BOX_INFO_DOCS_ROW_SURFACE} ${BOX_INFO_DOCS_ROW_OPTIONAL}`,
                        ]
                          .filter(Boolean)
                          .join(" ")}
                      >
                        <MasterUploader
                          variant="compact"
                          compactDensity="dense"
                          compactShowTapSubtitle={
                            shippingLabelPhotoUrls.length === 0 && !boxScanDocumentationLocked && !savedBoxIntakeViewLocked
                          }
                          label={
                            directBoxShipmentLabelUploaded ? (
                              "SHIPMENT PHOTO / SHIPPING LABEL"
                            ) : (
                              <>
                                SHIPMENT PHOTO / SHIPPING LABEL{" "}
                                <span className="operator-shipment-req-mark font-normal normal-case">
                                  (required)
                                </span>
                              </>
                            )
                          }
                          hint={null}
                          value={shippingLabelPhotoUrls}
                          onChange={handleShippingLabelPhotoUrlsChange}
                          organizationId={orgId}
                          alignedUpload={
                            operatorPalletAlignedUploadPaths
                              ? {
                                  bucket: "media",
                                  relativePathUnderOrg: operatorPalletAlignedUploadPaths.shipping,
                                }
                              : undefined
                          }
                          maxFiles={3}
                          disabled={!orgId?.trim() || boxScanDocumentationLocked}
                          viewLocked={savedBoxIntakeViewLocked}
                          className="operator-shipment-docs-uploader"
                        />
                      </div>
                      <div
                        className={[
                          BOX_INFO_DOCS_ROW_BASE,
                          shippingLabelPhotoUrls.length > 0 &&
                            bolPhotoUrls.length === 0 &&
                            !boxScanDocumentationLocked &&
                            !savedBoxIntakeViewLocked
                            ? BOX_INFO_DOCS_ROW_ACTIVE
                            : bolPhotoUrls.length > 0
                              ? `${BOX_INFO_DOCS_ROW_SURFACE} ${BOX_INFO_DOCS_ROW_COMPLETE}`
                              : `${BOX_INFO_DOCS_ROW_SURFACE} ${BOX_INFO_DOCS_ROW_OPTIONAL}`,
                        ]
                          .filter(Boolean)
                          .join(" ")}
                      >
                        <MasterUploader
                          variant="compact"
                          compactDensity="dense"
                          compactShowTapSubtitle={
                            shippingLabelPhotoUrls.length > 0 &&
                            bolPhotoUrls.length === 0 &&
                            !boxScanDocumentationLocked &&
                            !savedBoxIntakeViewLocked
                          }
                          label="Bill of Lading (optional)"
                          hint={null}
                          value={bolPhotoUrls}
                          onChange={handleBolPhotoUrlsChange}
                          organizationId={orgId}
                          alignedUpload={
                            operatorPalletAlignedUploadPaths
                              ? {
                                  bucket: "media",
                                  relativePathUnderOrg: operatorPalletAlignedUploadPaths.bol,
                                }
                              : undefined
                          }
                          maxFiles={3}
                          disabled={!orgId?.trim() || boxScanDocumentationLocked}
                          viewLocked={savedBoxIntakeViewLocked}
                          className="operator-shipment-docs-uploader"
                        />
                      </div>
                    </div>
                  <div className={activeBoxSession ? "space-y-3" : "contents"}>
                  {!activeBoxSession ? (
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 sm:items-start gap-1.5">
                    <div className="min-w-0">
                      <label
                        htmlFor={`${formId}-box-package-code-display`}
                        className="operator-shipment-field-label mb-0.5 block text-[9px] font-semibold uppercase leading-tight tracking-wide"
                      >
                        PACKAGE CODE <span className="operator-shipment-req-mark font-normal normal-case">(required)</span>
                      </label>
                      <div
                        id={`${formId}-box-package-code-display`}
                        className={`scanner-input-glass flex h-10 w-full cursor-default items-center rounded-lg border px-3 font-mono text-[13px] outline-none ${BOX_INFO_INPUT_BORDER} ${BOX_INFO_INPUT_COMPACT_HEIGHT}`}
                        style={{ color: TEXT_PRIMARY }}
                      >
                        {(currentPackageTrackingId ?? "").trim() || "—"}
                      </div>
                    </div>
                    <div className="relative z-30 min-w-0">
                      <label
                        htmlFor={`${formId}-box-pallet-carrier`}
                        className="operator-shipment-field-label mb-0.5 block text-[9px] font-semibold uppercase leading-tight tracking-wide"
                      >
                        Carrier <span className="operator-shipment-req-mark font-normal normal-case">(required)</span>
                      </label>
                      {boxIntakeCarrierReadOnly ? (
                        <div
                          className={`scanner-input-glass flex h-10 w-full min-w-0 items-center rounded-lg border px-3 font-mono text-[13px] ${BOX_INFO_INPUT_BORDER} ${BOX_INFO_INPUT_COMPACT_HEIGHT}`}
                          style={{ color: TEXT_PRIMARY }}
                          aria-readonly="true"
                        >
                          <span className="truncate">{palletCarrier.trim() || "—"}</span>
                        </div>
                      ) : (
                        <CarrierCombobox
                          triggerId={`${formId}-box-pallet-carrier`}
                          triggerClassName={`scanner-input-glass flex h-10 w-full items-center justify-between gap-2 rounded-lg border px-3 text-left text-[13px] outline-none transition ${BOX_INFO_INPUT_BORDER} ${BOX_INFO_INPUT_COMPACT_HEIGHT}`}
                          value={palletCarrier}
                          otherSelected={palletCarrierOtherSelected}
                          invalid={palletCarrierOtherSelected && palletCarrier.trim().length === 0}
                          disabled={!slipCarrierOrderEditable || boxScanDocumentationLocked}
                          onPickKnown={(name) => {
                            setPalletCarrierOtherSelected(false);
                            commitPalletCarrierDraft(name);
                          }}
                          onPickOther={() => {
                            setPalletCarrierOtherSelected(true);
                            if (isKnownCarrierName(palletCarrier)) {
                              commitPalletCarrierDraft("");
                            }
                          }}
                          onRequestScanFocus={scheduleFocusScanner}
                        />
                      )}
                    </div>
                  </div>
                  ) : activeBoxSession || slipCarrierOrderEditable || palletCarrierOtherSelected || boxIntakeCarrierReadOnly ? (
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-1 sm:items-start gap-1.5">
                    <div className="relative z-30 min-w-0">
                      <label
                        htmlFor={`${formId}-box-pallet-carrier`}
                        className="operator-shipment-field-label mb-0.5 block text-[9px] font-semibold uppercase leading-tight tracking-wide"
                      >
                        Carrier <span className="operator-shipment-req-mark font-normal normal-case">(required)</span>
                      </label>
                      {boxIntakeCarrierReadOnly ? (
                        <div
                          className={`scanner-input-glass flex h-10 w-full min-w-0 items-center rounded-lg border px-3 font-mono text-[13px] ${BOX_INFO_INPUT_BORDER} ${BOX_INFO_INPUT_COMPACT_HEIGHT}`}
                          style={{ color: TEXT_PRIMARY }}
                          aria-readonly="true"
                        >
                          <span className="truncate">{palletCarrier.trim() || "—"}</span>
                        </div>
                      ) : (
                        <CarrierCombobox
                          triggerId={`${formId}-box-pallet-carrier`}
                          triggerClassName={`scanner-input-glass flex h-10 w-full items-center justify-between gap-2 rounded-lg border px-3 text-left text-[13px] outline-none transition ${BOX_INFO_INPUT_BORDER} ${BOX_INFO_INPUT_COMPACT_HEIGHT}`}
                          value={palletCarrier}
                          otherSelected={palletCarrierOtherSelected}
                          invalid={palletCarrierOtherSelected && palletCarrier.trim().length === 0}
                          disabled={!slipCarrierOrderEditable || boxScanDocumentationLocked}
                          onPickKnown={(name) => {
                            setPalletCarrierOtherSelected(false);
                            commitPalletCarrierDraft(name);
                          }}
                          onPickOther={() => {
                            setPalletCarrierOtherSelected(true);
                            if (isKnownCarrierName(palletCarrier)) {
                              commitPalletCarrierDraft("");
                            }
                          }}
                          onRequestScanFocus={scheduleFocusScanner}
                        />
                      )}
                    </div>
                  </div>
                  ) : null}
                  {palletCarrierOtherSelected && !boxIntakeCarrierReadOnly ? (
                    <div className="relative z-40">
                      <label
                        htmlFor={`${formId}-box-pallet-carrier-custom`}
                        className="operator-shipment-field-label mb-0.5 block text-[9px] font-semibold uppercase leading-tight tracking-wide"
                      >
                        Carrier name <span className="operator-shipment-req-mark">*</span>
                      </label>
                      <input
                        id={`${formId}-box-pallet-carrier-custom`}
                        type="text"
                        value={palletCarrier}
                        onChange={(e) => commitPalletCarrierDraft(e.target.value)}
                        placeholder="Type here…"
                        autoComplete="off"
                        spellCheck={false}
                        disabled={!slipCarrierOrderEditable || boxScanDocumentationLocked}
                        className={`scanner-input-glass h-10 w-full rounded-lg border px-3 font-mono text-[13px] outline-none transition disabled:opacity-45 ${BOX_INFO_INPUT_BORDER} ${BOX_INFO_INPUT_COMPACT_HEIGHT}`}
                        style={{ color: TEXT_PRIMARY }}
                      />
                    </div>
                  ) : null}

                  {!activeBoxSession ? (
                    <>
                      <div className="operator-shipment-reference-fields mt-1 grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                        <div className="min-w-0">
                          <div className="mb-1 flex flex-wrap items-center gap-1.5">
                            <label
                              htmlFor={`${formId}-box-pallet-order-id`}
                              className="operator-shipment-field-label block text-[9px] font-semibold uppercase leading-tight tracking-wide mb-0.5"
                            >
                              Order ID <span className="font-normal normal-case opacity-70">(optional)</span>
                            </label>
                          </div>
                          <input
                            id={`${formId}-box-pallet-order-id`}
                            type="text"
                            autoComplete="off"
                            spellCheck={false}
                            value={palletOrderId}
                            onChange={(e) => onPalletOrderIdInputChange(e.target.value)}
                            placeholder="114-XXXXXXX-XXXXXXX"
                            readOnly={!slipCarrierOrderEditable}
                            disabled={!slipCarrierOrderEditable || boxScanDocumentationLocked}
                            title={
                              packageScanOrderIdConflictHighlight || palletMixedOrderIdsUi
                                ? PALLET_ORDER_CONFLICT_TOOLTIP
                                : undefined
                            }
                            className={`scanner-input-glass h-8 w-full rounded-lg border px-3 font-mono text-[13px] outline-none transition disabled:opacity-45 ${BOX_INFO_INPUT_BORDER} ${BOX_INFO_INPUT_COMPACT_HEIGHT_SM}`}
                            style={{ color: packageScanOrderIdInputColor }}
                          />
                        </div>
                        <div className="min-w-0">
                          <label
                            htmlFor={`${formId}-box-slip-rma`}
                            className="operator-shipment-field-label mb-0.5 block text-[9px] font-semibold uppercase leading-tight tracking-wide"
                          >
                            RMA # <span className="font-normal normal-case opacity-70">(optional)</span>
                          </label>
                          <input
                            id={`${formId}-box-slip-rma`}
                            type="text"
                            autoComplete="off"
                            spellCheck={false}
                            value={boxSlipRma}
                            onChange={(e) => setBoxSlipRma(e.target.value)}
                            placeholder="RMA / RA / return #"
                            readOnly={!slipCarrierOrderEditable}
                            disabled={!slipCarrierOrderEditable || boxScanDocumentationLocked}
                            className={`scanner-input-glass h-8 w-full rounded-lg border px-3 font-mono text-[13px] outline-none transition disabled:opacity-45 ${BOX_INFO_INPUT_BORDER} ${BOX_INFO_INPUT_COMPACT_HEIGHT_SM}`}
                            style={{ color: TEXT_PRIMARY }}
                          />
                        </div>
                      </div>
                      {boxSlipVisionLines.length > 0 && packageScanOrderIdConflictHighlight ? (
                        <p
                          className="mt-2 text-[10px] font-medium leading-snug text-amber-200/95 sm:text-[11px]"
                          role="status"
                        >
                          {AI_SLIP_ORDER_ID_CONFLICT_SHORT_HINT}
                        </p>
                      ) : null}
                      {boxSlipConflictReferenceLine ? (
                        <p
                          className="mt-2 text-[10px] font-medium leading-snug text-amber-400/95 sm:text-[11px]"
                          role="status"
                        >
                          {boxSlipConflictReferenceLine}
                        </p>
                      ) : null}
                    </>
                  ) : (
                    <details
                      className={`${BOX_INFO_REFERENCE_DETAILS} operator-shipment-reference-details`}
                      open={Boolean(
                        palletIdentityOrderId ||
                          palletOrderId.trim() ||
                          boxSlipRma.trim() ||
                          editAllMode ||
                          slipCarrierOrderEditable ||
                          boxSlipConflictReferenceLine,
                      )}
                    >
                      <summary
                        className="cursor-pointer select-none text-[9px] font-bold uppercase leading-tight tracking-wide text-[#4d5560] dark:text-[#b9c2cc]"
                      >
                        Reference — order ID & RMA
                      </summary>
                      <div className="operator-shipment-reference-fields mt-1 grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                        <div className="min-w-0">
                          <div className="mb-1 flex flex-wrap items-center gap-1.5">
                            <label
                              htmlFor={`${formId}-box-pallet-order-id`}
                              className="operator-shipment-field-label block text-[9px] font-semibold uppercase leading-tight tracking-wide mb-0.5"
                            >
                              Order ID <span className="font-normal normal-case opacity-70">(optional)</span>
                            </label>
                          </div>
                          <input
                            id={`${formId}-box-pallet-order-id`}
                            type="text"
                            autoComplete="off"
                            spellCheck={false}
                            value={palletOrderId}
                            onChange={(e) => onPalletOrderIdInputChange(e.target.value)}
                            placeholder="114-XXXXXXX-XXXXXXX"
                            readOnly={!boxIntakeReferenceEditable}
                            disabled={!boxIntakeReferenceEditable || boxScanDocumentationLocked}
                            title={
                              packageScanOrderIdConflictHighlight || palletMixedOrderIdsUi
                                ? PALLET_ORDER_CONFLICT_TOOLTIP
                                : undefined
                            }
                            className={`scanner-input-glass h-8 w-full rounded-lg border px-3 font-mono text-[13px] outline-none transition disabled:opacity-45 ${BOX_INFO_INPUT_BORDER} ${BOX_INFO_INPUT_COMPACT_HEIGHT_SM}`}
                            style={{ color: packageScanOrderIdInputColor }}
                          />
                        </div>
                        <div className="min-w-0">
                          <label
                            htmlFor={`${formId}-box-slip-rma`}
                            className="operator-shipment-field-label mb-0.5 block text-[9px] font-semibold uppercase leading-tight tracking-wide"
                          >
                            RMA # <span className="font-normal normal-case opacity-70">(optional)</span>
                          </label>
                          <input
                            id={`${formId}-box-slip-rma`}
                            type="text"
                            autoComplete="off"
                            spellCheck={false}
                            value={boxSlipRma}
                            onChange={(e) => setBoxSlipRma(e.target.value)}
                            placeholder="RMA / RA / return #"
                            readOnly={!boxIntakeReferenceEditable}
                            disabled={!boxIntakeReferenceEditable || boxScanDocumentationLocked}
                            className={`scanner-input-glass h-8 w-full rounded-lg border px-3 font-mono text-[13px] outline-none transition disabled:opacity-45 ${BOX_INFO_INPUT_BORDER} ${BOX_INFO_INPUT_COMPACT_HEIGHT_SM}`}
                            style={{ color: TEXT_PRIMARY }}
                          />
                        </div>
                      </div>
                      {boxSlipVisionLines.length > 0 && packageScanOrderIdConflictHighlight ? (
                        <p
                          className="mt-2 text-[10px] font-medium leading-snug text-amber-200/95 sm:text-[11px]"
                          role="status"
                        >
                          {AI_SLIP_ORDER_ID_CONFLICT_SHORT_HINT}
                        </p>
                      ) : null}
                      {boxSlipConflictReferenceLine ? (
                        <p
                          className="mt-2 text-[10px] font-medium leading-snug text-amber-400/95 sm:text-[11px]"
                          role="status"
                        >
                          {boxSlipConflictReferenceLine}
                        </p>
                      ) : null}
                    </details>
                  )}

                {showSlipMatchedBadge ? (
                  <div className="mb-1 flex justify-center">
                    <span
                      className="rounded-full border px-3 py-0.5 text-[10px] font-black uppercase tracking-wide"
                      style={{ borderColor: SUCCESS, backgroundColor: SUCCESS_BG, color: SUCCESS }}
                    >
                      Slip matched
                    </span>
                  </div>
                ) : null}
                  </div>
                  </section>
                  ) : null}

                <div className={activeBoxSession ? "order-1 flex flex-col gap-1.5" : "contents"}>
                <section
                  className={`${BOX_INFO_SECTION} operator-shipment-section--docs relative z-20 mb-0 space-y-1`}
                >
                  <div className="flex items-center gap-1.5">
                    <ClipboardList className="operator-shipment-section-icon h-3.5 w-3.5 h-3 w-3" strokeWidth={2} />
                    <p className="operator-shipment-section-title">Documentation photos</p>
                  </div>
                  <div className={BOX_INFO_DOCS_LIST}>
                    <div
                      className={[
                        BOX_INFO_DOCS_ROW_BASE,
                        slipBoxPhotoUrls.length === 0 &&
                        !boxScanDocumentationLocked &&
                        !savedBoxIntakeViewLocked
                          ? BOX_INFO_DOCS_ROW_ACTIVE
                          : slipBoxPhotoUrls.length > 0
                            ? `${BOX_INFO_DOCS_ROW_SURFACE} ${BOX_INFO_DOCS_ROW_COMPLETE}`
                            : `${BOX_INFO_DOCS_ROW_SURFACE} ${BOX_INFO_DOCS_ROW_OPTIONAL}`,
                      ]
                        .filter(Boolean)
                        .join(" ")}
                    >
                      {boxSlipVisionBusy ? (
                        <div className="operator-shipment-docs-overlay absolute inset-0 z-10 flex flex-col items-center justify-center gap-1 rounded-[inherit] backdrop-blur-[1px]">
                          <Loader2 className="h-5 w-5 animate-spin text-slate-200" strokeWidth={2.25} />
                          <span className="font-bold uppercase tracking-wide">GPT · slip</span>
                        </div>
                      ) : null}
                      <MasterUploader
                        variant="compact"
                        compactDensity="dense"
                        compactShowTapSubtitle={
                          slipBoxPhotoUrls.length === 0 && !boxScanDocumentationLocked && !savedBoxIntakeViewLocked
                        }
                        label={
                          <>
                            PACKING SLIP <span className="operator-shipment-req-mark font-normal normal-case">(required)</span>
                          </>
                        }
                        hint={null}
                        value={slipBoxPhotoUrls}
                        onChange={handleSlipBoxPhotoUrlsChange}
                        organizationId={orgId}
                        alignedUpload={
                          operatorPackageAlignedUploadPaths
                            ? {
                                bucket: "manifests",
                                relativePathUnderOrg: operatorPackageAlignedUploadPaths.manifest,
                              }
                            : undefined
                        }
                        maxFiles={3}
                        disabled={!orgId?.trim() || boxSlipVisionBusy || boxScanDocumentationLocked}
                        viewLocked={savedBoxIntakeViewLocked}
                        className="operator-shipment-docs-uploader"
                      />
                      {boxSlipInvalidFormatBlocksSave ? (
                        <p className="mt-1.5 px-0.5 text-left text-[11px] font-semibold leading-snug text-amber-200/95">
                          INVALID_SLIP_FORMAT — replace this photo with a clear packing slip (slip id, item lines, and
                          barcodes). Save stays disabled until the slip is valid.
                        </p>
                      ) : null}
                    </div>
                    <div
                      className={[
                        BOX_INFO_DOCS_ROW_BASE,
                        slipBoxPhotoUrls.length > 0 &&
                          outsideBoxPhotoUrls.length === 0 &&
                          !boxScanDocumentationLocked &&
                          !savedBoxIntakeViewLocked
                          ? BOX_INFO_DOCS_ROW_ACTIVE
                          : outsideBoxPhotoUrls.length > 0
                            ? `${BOX_INFO_DOCS_ROW_SURFACE} ${BOX_INFO_DOCS_ROW_COMPLETE}`
                            : `${BOX_INFO_DOCS_ROW_SURFACE} ${BOX_INFO_DOCS_ROW_OPTIONAL}`,
                      ]
                        .filter(Boolean)
                        .join(" ")}
                    >
                      <MasterUploader
                        variant="compact"
                        compactDensity="dense"
                        compactShowTapSubtitle={
                          slipBoxPhotoUrls.length > 0 &&
                          outsideBoxPhotoUrls.length === 0 &&
                          !boxScanDocumentationLocked &&
                          !savedBoxIntakeViewLocked
                        }
                        label="OUTSIDE BOX"
                        hint={null}
                        value={outsideBoxPhotoUrls}
                        onChange={handleOutsideBoxPhotoUrlsChange}
                        organizationId={orgId}
                        alignedUpload={
                          operatorPackageAlignedUploadPaths
                            ? {
                                bucket: "media",
                                relativePathUnderOrg: operatorPackageAlignedUploadPaths.photos,
                              }
                            : undefined
                        }
                        maxFiles={3}
                        disabled={!orgId?.trim() || boxScanDocumentationLocked}
                        viewLocked={savedBoxIntakeViewLocked}
                        className="operator-shipment-docs-uploader"
                      />
                    </div>
                    <div
                      className={[
                        BOX_INFO_DOCS_ROW_BASE,
                        outsideBoxPhotoUrls.length > 0 &&
                          insideBoxPhotoUrls.length === 0 &&
                          !boxScanDocumentationLocked &&
                          !savedBoxIntakeViewLocked
                          ? BOX_INFO_DOCS_ROW_ACTIVE
                          : insideBoxPhotoUrls.length > 0
                            ? `${BOX_INFO_DOCS_ROW_SURFACE} ${BOX_INFO_DOCS_ROW_COMPLETE}`
                            : `${BOX_INFO_DOCS_ROW_SURFACE} ${BOX_INFO_DOCS_ROW_OPTIONAL}`,
                      ]
                        .filter(Boolean)
                        .join(" ")}
                    >
                      <MasterUploader
                        variant="compact"
                        compactDensity="dense"
                        compactShowTapSubtitle={
                          outsideBoxPhotoUrls.length > 0 &&
                          insideBoxPhotoUrls.length === 0 &&
                          !boxScanDocumentationLocked &&
                          !savedBoxIntakeViewLocked
                        }
                        label="INSIDE BOX"
                        hint={null}
                        value={insideBoxPhotoUrls}
                        onChange={handleInsideBoxPhotoUrlsChange}
                        organizationId={orgId}
                        alignedUpload={
                          operatorPackageAlignedUploadPaths
                            ? {
                                bucket: "media",
                                relativePathUnderOrg: operatorPackageAlignedUploadPaths.photos,
                              }
                            : undefined
                        }
                        maxFiles={3}
                        disabled={!orgId?.trim() || boxScanDocumentationLocked}
                        viewLocked={savedBoxIntakeViewLocked}
                        className="operator-shipment-docs-uploader"
                      />
                    </div>
                  </div>
                </section>

                <section
                  className={`${BOX_INFO_SECTION} operator-shipment-section--slip relative z-30 mb-0.5 space-y-1`}
                >
                  <div
                    aria-hidden
                    className="pointer-events-none absolute inset-x-4 top-0 h-[2px] rounded-full bg-gradient-to-r from-transparent via-[rgba(214,183,110,0.38)] to-transparent dark:via-[rgba(214,183,110,0.44)]"
                  />
                  {boxSlipVisionLines.length > 0 ||
                  boxSlipVisionBusy ||
                  boxSlipCode.trim() ||
                  boxSlipRma.trim() ||
                  boxSlipOrderId.trim() ||
                  boxSlipConflictingOrderId.trim() ? (
                    <div
                      id="box-slip-verify-table"
                      className="operator-shipment-slip-panel scroll-mt-4 text-left"
                    >
                      <div className="flex flex-wrap items-start justify-between gap-2 border-b border-[rgba(214,183,110,0.22)] pb-2 text-left dark:border-[rgba(214,183,110,0.28)]">
                        <h3 className="operator-shipment-slip-title text-left tracking-tight">Slip Content Info</h3>
                        {boxSlipVisionLines.length > 0 || boxSlipVisionBusy ? (
                          <span className="operator-shipment-slip-ai-badge shrink-0 rounded-full border px-2 py-0.5 uppercase leading-tight tracking-wide">
                            ✨ Detected by AI
                          </span>
                        ) : null}
                      </div>
                      {boxSlipCode.trim() ? (
                        <div className={`operator-shipment-slip-meta operator-shipment-slip-meta--code mt-2 px-0 py-1.5 text-left ${BOX_INFO_SLIP_META_DIVIDER}`}>
                          <p className="operator-shipment-slip-meta__label font-bold uppercase tracking-widest">Slip code</p>
                          <p className="operator-shipment-slip-meta__value mt-0.5 font-mono font-bold tabular-nums">
                            {boxSlipCode.trim()}
                          </p>
                        </div>
                      ) : null}
                      {boxSlipOrderId.trim() ? (
                        <div className={`operator-shipment-slip-meta operator-shipment-slip-meta--order mt-2 px-0 py-1.5 text-left ${BOX_INFO_SLIP_META_DIVIDER}`}>
                          <p className="operator-shipment-slip-meta__label font-bold uppercase tracking-widest">
                            Slip order ID
                          </p>
                          <p className="operator-shipment-slip-meta__value mt-0.5 break-all font-mono font-bold tabular-nums">
                            {boxSlipOrderId.trim()}
                          </p>
                        </div>
                      ) : null}
                      {boxSlipVisionLines.length > 0 || boxSlipVisionBusy ? (
                        <>
                          <p className="operator-shipment-detected-heading mb-1.5 mt-3">Detected Items</p>
                      {boxSlipVisionLines.length > 0 ? (
                        <div className={`operator-shipment-detected-table-wrap operator-scan-panel__body rounded-md leading-snug ${SLIP_CARD_SECTION}`}>
                          <table className="operator-shipment-detected-table border-collapse text-left">
                            <caption className="sr-only">
                              Line items from packing slip vision. FNSKU, UPC, description, and quantity are read-only.
                              Removing persisted slip lines (if offered in the UI) requires the can_delete_slip_items permission
                              (see useRbacPermissions().canDeleteSlipItems).
                            </caption>
                            <colgroup>
                              <col className="operator-shipment-detected-col-fnsku" />
                              <col className="operator-shipment-detected-col-upc" />
                              <col className="operator-shipment-detected-col-desc" />
                              <col className="operator-shipment-detected-col-desc" />
                              <col className="operator-shipment-detected-col-qty" />
                            </colgroup>
                            <thead className="operator-shipment-detected-thead sticky top-0 z-[1]">
                              <tr>
                                <th className="operator-shipment-detected-th operator-shipment-detected-th-fnsku font-bold">
                                  FNSKU
                                </th>
                                <th className="operator-shipment-detected-th operator-shipment-detected-th-upc font-bold">
                                  UPC
                                </th>
                                <th className="operator-shipment-detected-th operator-shipment-detected-th-desc font-bold">
                                  Product
                                </th>
                                <th className="operator-shipment-detected-th operator-shipment-detected-th-desc font-bold">
                                  Description
                                </th>
                                <th className="operator-shipment-detected-th operator-shipment-detected-th-qty font-bold tabular-nums">
                                  Qty
                                </th>
                              </tr>
                            </thead>
                            <tbody className="select-text">
                              {boxSlipVisionLines.map((row, i) => {
                                const fnskuTrim = (row.fnsku ?? "").trim();
                                const upcTrim = (row.upc ?? "").trim();
                                const descTrim = (row.description ?? "").trim();
                                const linkage =
                                  boxSlipVisionLineLinkages[i] ??
                                  buildProductLinkageDisplayContract(
                                    { description: row.description, fnsku: row.fnsku, upc: row.upc },
                                    EMPTY_PRODUCT_NAME_LOOKUP,
                                  );
                                return (
                                  <tr
                                    key={`slip-line-${i}`}
                                    className={`operator-shipment-detected-row cursor-default !rounded-md !border !border-[rgba(214,183,110,0.24)] !bg-[rgba(255,255,255,0.025)] !px-2 !py-1 !shadow-none border-t ${SLIP_CARD_DIVIDER}`}
                                  >
                                    <td className="operator-shipment-detected-td operator-shipment-detected-td-fnsku align-top">
                                      <span className={`operator-shipment-detected-cell-fnsku !font-mono !text-[10px] !font-normal !text-neutral-500 leading-snug`}>
                                        {fnskuTrim || "—"}
                                      </span>
                                    </td>
                                    <td className="operator-shipment-detected-td operator-shipment-detected-td-upc align-top">
                                      <span className={`operator-shipment-detected-cell-upc !font-mono !text-[10px] !font-normal !text-neutral-500 leading-snug`}>
                                        {upcTrim || "—"}
                                      </span>
                                    </td>
                                    <td className="operator-shipment-detected-td operator-shipment-detected-td-desc operator-shipment-detected-td-product align-top">
                                      <ProductLinkagePrimaryLink
                                        linkage={linkage}
                                        detailFrom="scan"
                                        className={`operator-shipment-detected-cell-product !text-xs !font-bold !tracking-wide !text-[#FAF6ED] !no-underline hover:!text-[#FAF6ED]`}
                                      />
                                      <div className={SLIP_CARD_META_LINKAGE}>
                                        <OperatorProductLinkageMeta
                                          linkage={linkage}
                                          linkResolvedProductId={false}
                                          detailFrom="scan"
                                        />
                                      </div>
                                    </td>
                                    <td className="operator-shipment-detected-td operator-shipment-detected-td-desc operator-shipment-detected-td-description align-top">
                                      <span className={`operator-shipment-detected-cell-desc ${SLIP_CARD_SUBTEXT}`}>
                                        {descTrim || "—"}
                                      </span>
                                    </td>
                                    <td className="operator-shipment-detected-td operator-shipment-detected-td-qty align-top">
                                      <span
                                        className={`operator-shipment-qty-pill !font-mono !text-[10px] !font-normal !text-neutral-500 !border-0 !bg-transparent !p-0 tabular-nums`}
                                        aria-label={`Line ${i + 1} quantity`}
                                      >
                                        {row.expected_qty}
                                      </span>
                                    </td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>
                      ) : boxSlipVisionBusy ? (
                        <p className="operator-shipment-slip-hint font-medium leading-snug">
                          Extracting line items from the packing slip…
                        </p>
                      ) : (
                        <p className="operator-shipment-slip-hint font-medium leading-snug">
                          No line items yet — add a packing slip photo above and run detection, or open a saved box.
                        </p>
                      )}
                        </>
                      ) : null}
                    </div>
                  ) : null}
                </section>
                </div>
                  </div>
                  </div>
                </section>

                {expectedPkgLines.length > 0 ? (
                  <section
                    id="expected-intake-table"
                    className={`mb-4 scroll-mt-4 rounded-[24px] p-4 ${glassCard}`}
                    style={{ borderColor: PURPLE_RING }}
                  >
                    <div className="mb-2 flex flex-col gap-0.5">
                      <h3 className="text-[14px] font-bold text-zinc-900 dark:text-white">Shipment lines (reference)</h3>
                    </div>
                    <div
                      className="max-h-[min(48vh,260px)] overflow-auto rounded-xl border"
                      style={{ borderColor: PURPLE_RING, backgroundColor: "#090E1A" }}
                    >
                      <table className="w-full min-w-[360px] border-collapse text-left text-[11px]">
                        <thead className="sticky top-0 z-[1]" style={{ backgroundColor: CARD_INNER, color: MUTED_LABEL }}>
                          <tr>
                            <th className="px-2 py-2 font-bold">Product</th>
                            <th className="px-2 py-2 font-bold font-mono">SKU</th>
                            <th className="px-2 py-2 font-bold tabular-nums">Exp</th>
                            <th className="px-2 py-2 font-bold tabular-nums">Scn</th>
                            <th className="px-2 py-2 font-bold tabular-nums">Var</th>
                          </tr>
                        </thead>
                        <tbody>
                          {expectedPkgLines.map((line) => (
                            <tr key={line.groupKey} className="border-t border-slate-800/90" style={{ color: TEXT_PRIMARY }}>
                              <td
                                className="max-w-[140px] px-2 py-2"
                                onClick={(e) => e.stopPropagation()}
                                onKeyDown={(e) => e.stopPropagation()}
                              >
                                <ProductLinkagePrimaryLink
                                  linkage={line.product_linkage}
                                  detailFrom="scan"
                                  className="truncate font-medium text-sky-300 underline decoration-sky-400/40 underline-offset-2 hover:text-sky-200"
                                  onClick={(e) => e.stopPropagation()}
                                />
                                <OperatorProductLinkageMeta linkage={line.product_linkage} linkResolvedProductId={false} detailFrom="scan" />
                              </td>
                              <td className="px-2 py-2 font-mono font-semibold">{line.sku || "—"}</td>
                              <td className="px-2 py-2 font-mono tabular-nums font-bold" style={{ color: ACTION_PURPLE }}>
                                {line.expectedQty}
                              </td>
                              <td className="px-2 py-2 font-mono tabular-nums font-bold text-emerald-300/90">
                                {line.scannedQty}
                              </td>
                              <td className="px-2 py-2 font-mono tabular-nums font-bold text-violet-200/90">
                                {formatScanVarianceLabel(line.expectedQty, line.scannedQty)}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <div className="mt-2 flex flex-wrap justify-end">
                      <button
                        type="button"
                        className={viewAllLinkClass}
                        onClick={() => document.getElementById("expected-intake-table")?.scrollIntoView({ behavior: "smooth", block: "start" })}
                      >
                        View all items
                      </button>
                    </div>
                  </section>
                ) : null}

                <section
                  className={`${BOX_INFO_NOTES_SECTION} operator-shipment-notes-card`}
                >
                  <label
                    htmlFor={`${formId}-box-general-notes`}
                    className="operator-shipment-notes-label mb-1 block text-[9px] uppercase leading-tight tracking-wide text-[#4d5560] dark:text-[#b9c2cc]"
                  >
                    Box notes{" "}
                    <span className="font-semibold normal-case tracking-normal text-[#66707a] dark:text-[#b9c2cc]">(optional)</span>
                  </label>
                  <textarea
                    id={`${formId}-box-general-notes`}
                    value={boxNotes}
                    onChange={(e) => setBoxNotes(e.target.value)}
                    rows={3}
                    placeholder="Write notes before saving — stored with this package..."
                    disabled={
                      boxScanDocumentationLocked ||
                      !(activeBoxSession ? boxIntakeReferenceEditable : slipCarrierOrderEditable)
                    }
                    className={`scanner-input-glass w-full resize-y rounded-lg border px-3 py-1.5 text-[13px] outline-none transition disabled:opacity-45 placeholder:text-[#66707a] dark:placeholder:text-[#87919d] min-h-[64px] ${BOX_INFO_INPUT_BORDER}`}
                    style={{ color: TEXT_PRIMARY }}
                  />

                  <div className="operator-shipment-notes-actions mt-1 space-y-1 pb-2 pt-0.5">
                    <button
                      type="button"
                      disabled={!canContinueToItemInspection || boxSaveBusy}
                      onClick={() => {
                        const pkgId = String(itemScanPackageId ?? "").trim();
                        const sessionPkgId = String(activeBoxSession?.packageId ?? "").trim();
                        const resumeSavedItemScan =
                          pkgId &&
                          sessionPkgId &&
                          pkgId === sessionPkgId &&
                          isUuidString(pkgId);
                        if (resumeSavedItemScan || (!activeBoxSession && pkgId)) {
                          beginItemPhase();
                          return;
                        }
                        if (activeBoxSession && canSaveBoxScan) {
                          modalOpenRef.current = true;
                          setPackageFinalizeConfirmKind("save_items");
                        }
                      }}
                      className={BOX_INFO_BTN_PRIMARY}
                    >
                      {boxSaveBusy && activeBoxSession ? (
                        <>
                          <Loader2 className="h-4 w-4 shrink-0 animate-spin" strokeWidth={2.25} aria-hidden />
                          Saving…
                        </>
                      ) : (
                        <>Save & Continue to Items →</>
                      )}
                    </button>

                    <div className="grid grid-cols-2 gap-2">
                      <button
                        type="button"
                        disabled={!activeBoxSession || boxSaveBusy}
                        onClick={() => {
                          modalOpenRef.current = true;
                          setPackageSessionCancelConfirmOpen(true);
                        }}
                        className={`${BOX_INFO_BTN_DISCARD} !h-11 !min-h-[44px] !max-h-11 !py-2 !text-sm !font-semibold !leading-tight !shadow-none`}
                      >
                        Discard & Back
                      </button>
                      <button
                        type="button"
                        disabled={!canSaveBoxScan || boxSaveBusy}
                        onClick={() => {
                          modalOpenRef.current = true;
                          setPackageFinalizeConfirmKind("save_hub");
                        }}
                        className={`${BOX_INFO_BTN_SAVE_EXIT} !h-11 !min-h-[44px] !max-h-11 !py-2 !text-sm !font-semibold !leading-tight !shadow-none`}
                      >
                        <PackageOpen className="h-3.5 w-3.5 shrink-0 opacity-95" strokeWidth={2.25} aria-hidden />
                        Save & Exit
                      </button>
                    </div>

                    {boxIntakeDiscrepancyEligible ? (
                      <div className="flex justify-center pt-0.5">
                        <button
                          type="button"
                          disabled={!canSaveBoxScan || boxSaveBusy}
                          onClick={() => {
                            modalOpenRef.current = true;
                            setPackageFinalizeConfirmKind("discrepancy");
                          }}
                          className={`inline-flex w-auto max-w-[min(100%,18.5rem)] items-center justify-center gap-2 rounded-2xl border-2 border-amber-500/60 bg-gradient-to-b from-amber-200 to-amber-500 px-4 text-amber-950 transition active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40 ${ZEBRA_COMPACT_BTN}`}
                        >
                          <AlertTriangle className="h-3.5 w-3.5 shrink-0" strokeWidth={2.25} aria-hidden />
                          <span className="text-center leading-snug">Complete with Discrepancy</span>
                        </button>
                      </div>
                    ) : null}
                  </div>
                </section>
              </>
            ) : null}
              </div>
            )}
          </>
        ) : null}

        {flowPhase === "items" ? (
          !hasItemReceivableBox ? (
            <div className="flex flex-col gap-4">
              <section className={`rounded-[24px] border p-5 ${glassCard}`} style={{ borderColor: BORDER }}>
                <p className="text-[15px] font-bold leading-snug text-zinc-900 dark:text-white">
                  Select or scan a box before inspecting items.
                </p>
                <button
                  type="button"
                  className="mt-4 flex h-[48px] w-full items-center justify-center gap-2 rounded-[18px] text-[14px] font-bold transition hover:brightness-110"
                  style={{
                    background: `linear-gradient(180deg, ${ACTION_PURPLE} 0%, ${ACTION_PURPLE_DEEP} 100%)`,
                    color: "#1e1b4b",
                    boxShadow: `0 6px 20px ${PURPLE_GLOW}`,
                  }}
                  onClick={() => {
                    if (activePallet?.id?.trim()) setDirectBox(false);
                    setFlowPhase("package_scan");
                  }}
                >
                  Back to BOX intake
                </button>
              </section>
            </div>
          ) : (
            <div className="operator-item-scan-body flex min-h-0 flex-1 flex-col gap-[var(--op-scan-gap,0.5rem)]">
              <div className="operator-item-scan-middle-chrome shrink-0 space-y-[var(--op-scan-gap,0.5rem)]">
                {isSupabaseConfigured() && !operatorStoresLoading && !kioskStoreLocked && operatorStores.length === 0 ? (
              <p className={OP_SCAN_ALERT_ERROR}>
                No active stores for this organization — add a store in Settings before receiving items.
              </p>
            ) : null}

            {isSupabaseConfigured() && !operatorStoresLoading && operatorStores.length > 0 && !sessionStoreId ? (
              <p className={OP_SCAN_ALERT_ERROR}>
                Select an active store above to save return items and update receiving data.
              </p>
            ) : null}

            {itemScanPackageId && !isUuidString(itemScanPackageId) && isSupabaseConfigured() ? (
              <p className={OP_SCAN_ALERT_WARNING}>
                Demo mode — saves are not linked to a live box record until you intake one.
              </p>
            ) : null}

                {scanProgressPhase !== "idle" ? (
                  <OperatorScanProgressStrip phase={scanProgressPhase} className="mb-0" />
                ) : null}

                <div className="operator-item-scan-stats grid w-full grid-cols-4 gap-1.5" aria-label="Item scan summary counts">
                  <div className="operator-item-scan-stat operator-item-scan-stat--expected shrink-0 rounded-xl border px-1 py-2 text-center">
                    <p className="operator-item-scan-stat__label text-[8px] font-bold uppercase tracking-wide">Expected</p>
                    <p className="operator-item-scan-stat__value mt-1 text-[17px] font-black tabular-nums leading-none">
                      {itemInspectionQtyBasisExpected}
                    </p>
                  </div>
                  <div className="operator-item-scan-stat operator-item-scan-stat--scanned shrink-0 rounded-xl border px-1 py-2 text-center">
                    <p className="operator-item-scan-stat__label text-[8px] font-bold uppercase tracking-wide">Scanned</p>
                    <p
                      className={`operator-item-scan-stat__value operator-item-scan-stat__value--${itemScanStatScannedTone} mt-1 text-[17px] font-black tabular-nums leading-none`}
                    >
                      {itemInspectionQtyBasisScanned}
                    </p>
                  </div>
                  <div className="operator-item-scan-stat operator-item-scan-stat--remaining shrink-0 rounded-xl border px-1 py-2 text-center">
                    <p className="operator-item-scan-stat__label text-[8px] font-bold uppercase tracking-wide">Remaining</p>
                    <p
                      className={`operator-item-scan-stat__value operator-item-scan-stat__value--${itemScanStatRemainingTone} mt-1 text-[17px] font-black tabular-nums leading-none`}
                    >
                      {itemScanStatRemaining}
                    </p>
                  </div>
                  <div className="operator-item-scan-stat operator-item-scan-stat--skus shrink-0 rounded-xl border px-1 py-2 text-center">
                    <p className="operator-item-scan-stat__label text-[8px] font-bold uppercase tracking-wide">SKUs</p>
                    <p className="operator-item-scan-stat__value mt-1 text-[17px] font-black tabular-nums leading-none">
                      {itemInspectionSlipCells.length}
                    </p>
                  </div>
                </div>

                <button
                  type="button"
                  disabled={busy}
                  onClick={() => openAddScanItemModal()}
                  className={`operator-item-scan-add-btn operator-neda-mechanical-scan-btn shrink-0 flex ${ZEBRA_COMPACT_BTN} w-full items-center justify-center gap-1.5 rounded-xl px-4 transition disabled:cursor-not-allowed disabled:opacity-40`}
                >
                  <Plus className="h-5 w-5 shrink-0" strokeWidth={2.5} aria-hidden />
                  Add / Scan Item
                </button>

            {itemBarcodeMiss ? (
              <p className={OP_SCAN_ALERT_ERROR}>{itemBarcodeMiss}</p>
            ) : null}

            {itemReceiveError ? (
              <p className={OP_SCAN_ALERT_ERROR}>{itemReceiveError}</p>
            ) : null}

            {itemOverscanWarning ? (
              <p className={`${OP_SCAN_ALERT_ERROR} leading-snug`} role="alert">
                {itemOverscanWarning}
              </p>
            ) : null}
              </div>

            <section
              className={`operator-item-scan-expected-panel operator-scan-panel--flexible mb-0 flex min-h-0 flex-1 flex-col overflow-hidden p-2.5 ${glassCard}${
                itemInspectionSlipLines.length <= 2 ? " operator-scan-panel--few-items" : ""
              }`}
            >
              <div className="operator-item-scan-expected-panel__header mb-1.5 flex shrink-0 flex-wrap items-end justify-between gap-2">
                <div className="min-w-0 pr-2">
                  <h3 className="operator-item-scan-expected-panel__title text-[13px] font-bold leading-tight">Expected Items</h3>
                  <p className="operator-item-scan-expected-panel__eyebrow mt-0.5 text-[10px] font-semibold uppercase tracking-wide">
                    Item scan
                  </p>
                  <p className="operator-item-scan-expected-panel__hint mt-0.5 line-clamp-2 text-[9px] font-medium leading-snug">
                    {itemScanEditAllMode ? (
                      <>Select an item row with scanned units to edit.</>
                    ) : (
                      <>
                        Slip lines follow the packing list. Use{" "}
                        <span className="operator-item-scan-expected-panel__hint-strong font-semibold">Add / Scan Item</span> for
                        each unit.
                      </>
                    )}
                  </p>
                  {packageItemsHydrating || itemScanExpectationLoading ? (
                    <p className="operator-item-scan-expected-panel__loading mt-1 flex items-center gap-1 text-[9px] font-semibold">
                      <Loader2 className="h-3 w-3 shrink-0 animate-spin" aria-hidden />
                      {itemScanExpectationLoading && !packageItemsHydrating
                        ? "Loading expected lines…"
                        : "Updating counts…"}
                    </p>
                  ) : null}
                </div>
                <p className="operator-item-scan-expected-panel__counts shrink-0 text-right text-[10px] font-semibold leading-snug tabular-nums">
                  <span className="operator-item-scan-expected-panel__counts-scanned font-black">{itemInspectionQtyBasisScanned}</span>{" "}
                  scanned
                  <br />
                  <span className="operator-item-scan-expected-panel__counts-expected font-black">{itemInspectionQtyBasisExpected}</span>{" "}
                  expected
                </p>
              </div>
              <div className="operator-item-scan-progress-track mb-2 h-2 w-full shrink-0 overflow-hidden rounded-full">
                <div
                  className="h-full rounded-full transition-[width] duration-300 ease-out"
                  style={{
                    width: `${itemsSlipScanProgressPct}%`,
                    backgroundColor: itemsSlipScanProgressTrackColor,
                    boxShadow: `0 0 14px ${itemsSlipScanProgressTrackColor}`,
                  }}
                />
              </div>
              <div
                ref={bindOperatorMainScrollEl}
                className={`operator-item-scan-expected-list-scroll operator-scan-panel__body min-h-0 flex-1 space-y-1.5 px-0.5 ${mainScrollClass}`}
              >
                {itemScanExpectedItemsRenderSource === "loading" ? (
                  <ItemInspectionSlipSkeletonRows />
                ) : itemScanExpectedItemsRenderSource === "tracking_ep_variance" ? (
                  <>
                    {itemScanExpectationLinesLive.map((line) => (
                      <ItemScanExpectationVarianceRow
                        key={`item-ep-${line.groupKey}`}
                        line={line}
                        discrepancyMode={isItemsQtyDiscrepancy && itemsBoxFinalizeModalOpen}
                      />
                    ))}
                    {packageItemScanState.unexpectedUnits > 0 ? (() => {
                      const u = packageItemScanState.unexpectedUnits;
                      const vis = itemInspectionSlipLinePresentation(
                        0,
                        u,
                        isItemsQtyDiscrepancy && itemsBoxFinalizeModalOpen,
                      );
                      return (
                        <div
                          key="unexpected-package-items-ep"
                          className={itemScanSlipRowShellClass(vis.matchedRing)}
                          data-neda-qty={vis.label}
                          style={itemInspectionSlipCardStyle(vis)}
                        >
                          <p className={`operator-item-scan-slip-row__title line-clamp-2 ${SLIP_CARD_HEADING}`}>
                            Not on packing slip
                          </p>
                          <div className="mt-0.5 flex min-w-0 items-center justify-between gap-2">
                            <p className={`operator-item-scan-slip-row__meta min-w-0 flex-1 truncate leading-none ${SLIP_CARD_TECH_ID}`}>
                              No slip line match · {u} unit{u === 1 ? "" : "s"}
                            </p>
                            <div className="flex shrink-0 items-center gap-1">
                              {slipCardStatusMark(vis)}
                              <span className={`operator-item-scan-slip-row__qty whitespace-nowrap tabular-nums ${SLIP_CARD_TECH_ID}`}>
                                Qty {u}/0
                              </span>
                            </div>
                          </div>
                        </div>
                      );
                    })() : null}
                  </>
                ) : itemScanExpectedItemsRenderSource === "hydrated_return_items_only" ? (
                  packageItemHydratedRows.length > 0 ? (
                    <>
                      <p className={`operator-item-scan-empty-note mb-1 rounded-md px-2 py-1 ${SLIP_CARD_SECTION} text-[10px] font-semibold text-neutral-400`}>
                        Scanned units (no packing slip lines on this box)
                      </p>
                      {packageItemHydratedRows.map((unit) => {
                        const linkage = unit.product_linkage;
                        const bc = unit.scanned_barcode?.trim() || "—";
                        const vis = itemInspectionSlipLinePresentation(0, 1, false);
                        const rowEditable = itemScanEditAllMode;
                        const rowInteract = itemScanRowEditInteractProps(rowEditable, false, () =>
                          handleItemScanEditSelectOrphanUnit(unit),
                        );
                        return (
                          <div
                            key={unit.id}
                            className={`${itemScanSlipRowShellClass(false)} ${rowInteract.className}`}
                            data-neda-qty={vis.label}
                            style={itemInspectionSlipCardStyle(vis)}
                            role={rowInteract.role}
                            tabIndex={rowInteract.tabIndex}
                            onClick={rowInteract.onClick}
                            onKeyDown={rowInteract.onKeyDown}
                            aria-label={
                              rowEditable ? "Edit scanned unit for this row" : undefined
                            }
                          >
                            <ProductLinkagePrimaryLink
                              linkage={linkage}
                              linkWhenResolved={false}
                              detailFrom="scan"
                              className={SLIP_CARD_HEADING}
                            />
                            <div className={SLIP_CARD_META_LINKAGE}>
                              <OperatorProductLinkageMeta linkage={linkage} linkResolvedProductId={false} detailFrom="scan" />
                            </div>
                            <div className="mt-0.5 flex min-w-0 items-center justify-between gap-2">
                              <p className={`operator-item-scan-slip-row__meta min-w-0 flex-1 truncate leading-none ${SLIP_CARD_TECH_ID}`}>
                                Barcode {bc}
                                {unit.match_kind === "unexpected" ? (
                                  <>
                                    <span className="operator-item-scan-slip-row__meta-sep mx-1 text-neutral-600">·</span>
                                    <span className="operator-item-scan-slip-row__meta-warn text-amber-300">Off-slip</span>
                                  </>
                                ) : null}
                              </p>
                              <div className="flex shrink-0 items-center gap-1">
                                {slipCardStatusMark(vis)}
                                <span className={`operator-item-scan-slip-row__qty whitespace-nowrap tabular-nums ${SLIP_CARD_TECH_ID}`}>
                                  Qty {Math.max(1, Math.floor(Number(unit.quantity ?? 1)))}
                                </span>
                              </div>
                            </div>
                          </div>
                        );
                      })}
                  </>
                  ) : (
                    <p className={`operator-item-scan-empty-note rounded-md px-2 py-1 ${SLIP_CARD_SECTION} text-[10px] font-semibold text-neutral-400`}>
                      No slip lines yet — add a packing slip on BOX intake (Confirm &amp; Save) or wait for sync. Expected
                      shipment lines may still appear once expectations load.
                    </p>
                  )
                ) : itemScanExpectedItemsRenderSource === "package_slip_cells" ? (
                  <>
                    {itemInspectionSlipCells.map((cell) => {
                      const itemScanDiscrepancyUi =
                        isItemsQtyDiscrepancy && itemsBoxFinalizeModalOpen;
                      const vis = itemInspectionSlipLinePresentation(
                        cell.expected,
                        cell.scanned,
                        itemScanDiscrepancyUi,
                      );
                      const slip = cell.slip;
                      const linkage = slipRowProductLinkage(slip);
                      const upcLabel = slip.upc?.trim() ? slip.upc.trim() : "—";
                      const fnskuLabel = slip.fnsku?.trim() ? slip.fnsku.trim() : "—";
                      const matchedRing = vis.matchedRing;
                      const rowEditable = itemScanEditAllMode && cell.scanned > 0;
                      const rowSelected =
                        itemScanUnitPickerOpen &&
                        itemScanEditPick?.kind === "slip_cell" &&
                        itemScanEditPick.cellKey === cell.key;
                      const rowInteract = itemScanRowEditInteractProps(
                        rowEditable,
                        rowSelected,
                        () => handleItemScanEditSelectSlipCell(cell),
                      );
                      return (
                        <div
                          key={cell.key}
                          className={`${itemScanSlipRowShellClass(matchedRing)} ${rowInteract.className}`}
                          data-neda-qty={vis.label}
                          style={itemInspectionSlipCardStyle(vis)}
                          role={rowInteract.role}
                          tabIndex={rowInteract.tabIndex}
                          onClick={rowInteract.onClick}
                          onKeyDown={rowInteract.onKeyDown}
                          aria-label={
                            rowEditable ? `Edit scanned units for slip line, ${cell.scanned} scanned` : undefined
                          }
                        >
                          <ProductLinkagePrimaryLink
                            linkage={linkage}
                            linkWhenResolved={false}
                            detailFrom="scan"
                            className={SLIP_CARD_HEADING}
                          />
                          <div className={SLIP_CARD_META_LINKAGE}>
                            <OperatorProductLinkageMeta linkage={linkage} linkResolvedProductId={false} detailFrom="scan" />
                          </div>
                          <div className="mt-0.5 flex min-w-0 items-center justify-between gap-2">
                            <p className={`operator-item-scan-slip-row__meta min-w-0 flex-1 truncate leading-none ${SLIP_CARD_TECH_ID}`}>
                              UPC {upcLabel}
                              <span className="operator-item-scan-slip-row__meta-sep mx-1 text-neutral-600">·</span>
                              FNSKU {fnskuLabel}
                            </p>
                            <div className="flex shrink-0 items-center gap-1">
                              {rowEditable ? (
                                <button
                                  type="button"
                                  aria-label="Delete one scanned unit"
                                  disabled={busy || cell.scanned === 0}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    void handleDeleteSlipCellUnit(cell);
                                  }}
                                  className="flex h-5 w-5 shrink-0 items-center justify-center rounded border border-red-500/40 bg-red-50 text-red-600 transition hover:bg-red-100 active:scale-90 disabled:cursor-not-allowed disabled:opacity-30 dark:border-red-500/30 dark:bg-red-950/30 dark:text-red-400"
                                >
                                  <Trash2 className="h-2.5 w-2.5" strokeWidth={2.25} aria-hidden />
                                </button>
                              ) : null}
                              {slipCardStatusMark(vis)}
                              <span className={`operator-item-scan-slip-row__qty whitespace-nowrap tabular-nums ${SLIP_CARD_TECH_ID}`}>
                                Qty {cell.scanned}/{cell.expected}
                              </span>
                            </div>
                          </div>
                          {cell.draftExtra > 0 ? (
                            <p className={`operator-item-scan-slip-row__draft mt-0.5 ${SLIP_CARD_SUBTEXT}`}>
                              +{cell.draftExtra} staged (open draft)
                            </p>
                          ) : null}
                        </div>
                      );
                    })}
                    {packageItemScanState.unexpectedUnits > 0 ? (() => {
                      const u = packageItemScanState.unexpectedUnits;
                      const vis = itemInspectionSlipLinePresentation(
                        0,
                        u,
                        isItemsQtyDiscrepancy && itemsBoxFinalizeModalOpen,
                      );
                      const rowEditable = itemScanEditAllMode && u > 0;
                      const rowSelected =
                        itemScanUnitPickerOpen && itemScanEditPick?.kind === "unexpected";
                      const rowInteract = itemScanRowEditInteractProps(
                        rowEditable,
                        rowSelected,
                        handleItemScanEditSelectUnexpected,
                      );
                      return (
                        <div
                          key="unexpected-package-items"
                          className={`${itemScanSlipRowShellClass(vis.matchedRing)} ${rowInteract.className}`}
                          data-neda-qty={vis.label}
                          style={itemInspectionSlipCardStyle(vis)}
                          role={rowInteract.role}
                          tabIndex={rowInteract.tabIndex}
                          onClick={rowInteract.onClick}
                          onKeyDown={rowInteract.onKeyDown}
                          aria-label={
                            rowEditable ? `Edit ${u} unexpected scanned unit${u === 1 ? "" : "s"}` : undefined
                          }
                        >
                          <p className={`operator-item-scan-slip-row__title line-clamp-2 ${SLIP_CARD_HEADING}`}>
                            Not on packing slip
                          </p>
                          <div className="mt-0.5 flex min-w-0 items-center justify-between gap-2">
                            <p className={`operator-item-scan-slip-row__meta min-w-0 flex-1 truncate leading-none ${SLIP_CARD_TECH_ID}`}>
                              No slip line match · {u} unit{u === 1 ? "" : "s"}
                            </p>
                            <div className="flex shrink-0 items-center gap-1">
                              {slipCardStatusMark(vis)}
                              <span className={`operator-item-scan-slip-row__qty whitespace-nowrap tabular-nums ${SLIP_CARD_TECH_ID}`}>
                                Qty {u}/0
                              </span>
                            </div>
                          </div>
                        </div>
                      );
                    })() : null}
                  </>
                ) : (
                  <p className={`operator-item-scan-empty-note rounded-md px-2 py-1 ${SLIP_CARD_SECTION} text-[10px] font-semibold text-neutral-400`}>
                    No expected item rows for this package (debug source: {itemScanExpectedItemsRenderSource}).
                  </p>
                )}
                {!directBox && parentIdentified && expectedPkgLines.length > 0 ? (
                  <section className="operator-item-scan-shipment-summary mt-2 p-2">
                    <h3 className="operator-item-scan-shipment-summary__title mb-1 text-[11px] font-bold text-[#FAF6ED]">Shipment summary</h3>
                    <ul className={`operator-item-scan-shipment-summary__list divide-y ${SLIP_CARD_DIVIDE_Y}`}>
                      {expectedPkgLines.slice(0, 8).map((line) => (
                        <li key={line.groupKey} className="flex flex-col gap-0.5 py-1 text-[11px]">
                          <div className="flex justify-between gap-2">
                            <ProductLinkagePrimaryLink
                              linkage={line.product_linkage}
                              detailFrom="scan"
                              className={`${SLIP_CARD_HEADING} min-w-0 truncate`}
                            />
                            <span className={`operator-item-scan-shipment-summary__counts shrink-0 tabular-nums ${SLIP_CARD_TECH_ID}`}>
                              Exp {line.expectedQty}
                              <span className="operator-item-scan-shipment-summary__counts-scn"> · Scn {line.scannedQty}</span>
                              <span className="operator-item-scan-shipment-summary__counts-var">
                                {" "}
                                · Var {formatScanVarianceLabel(line.expectedQty, line.scannedQty)}
                              </span>
                            </span>
                          </div>
                          <div className={SLIP_CARD_META_LINKAGE}>
                            <OperatorProductLinkageMeta linkage={line.product_linkage} linkResolvedProductId={false} detailFrom="scan" />
                          </div>
                        </li>
                      ))}
                    </ul>
                  </section>
                ) : null}
              </div>
            </section>
            {itemsChromeStickyLayout ? (
              <div aria-hidden className="operator-item-scan-footer-spacer" />
            ) : null}
            </div>
          )
        ) : null}
        </>
        )}
      </main>

      {intakeToast ? (
        <div
          className="operator-shipment-flow-toast pointer-events-none fixed bottom-[calc(4.5rem+env(safe-area-inset-bottom))] left-1/2 z-[130] w-[min(calc(100vw-2rem),22rem)] -translate-x-1/2 rounded-2xl border px-4 py-3"
          role="status"
        >
          <p className="operator-shipment-flow-toast__text flex items-center gap-2 text-center text-[13px] font-bold leading-snug">
            <CheckCircle2 className="operator-shipment-flow-toast__icon h-5 w-5 shrink-0" strokeWidth={2.25} />
            {intakeToast}
          </p>
        </div>
      ) : null}

      {syncErrorToast ? (
        <div
          className="operator-shipment-flow-toast operator-shipment-flow-toast--error pointer-events-none fixed bottom-[calc(5.5rem+env(safe-area-inset-bottom))] left-1/2 z-[131] w-[min(calc(100vw-2rem),22rem)] -translate-x-1/2 rounded-2xl border px-4 py-3"
          role="alert"
        >
          <p className="operator-shipment-flow-toast__text flex items-center gap-2 text-center text-[13px] font-bold leading-snug">
            <AlertTriangle className="operator-shipment-flow-toast__icon--error h-5 w-5 shrink-0" strokeWidth={2.25} />
            {syncErrorToast}
          </p>
        </div>
      ) : null}

      {scanActionToast ? (
        <div
          className={`operator-shipment-flow-toast operator-shipment-flow-toast--scan-action pointer-events-none fixed bottom-[calc(4.25rem+env(safe-area-inset-bottom))] left-1/2 z-[133] w-[min(calc(100vw-2rem),24rem)] -translate-x-1/2 rounded-2xl border px-4 py-3 ${
            scanActionToast.variant === "success"
              ? "operator-shipment-flow-toast--success"
              : scanActionToast.variant === "error"
                ? "operator-shipment-flow-toast--error"
                : "operator-shipment-flow-toast--neutral"
          }`}
          role={scanActionToast.variant === "error" ? "alert" : "status"}
          aria-live="polite"
        >
          <p className="operator-shipment-flow-toast__text flex items-center gap-2 text-center text-[13px] font-bold leading-snug">
            {scanActionToast.variant === "success" ? (
              <CheckCircle2 className="operator-shipment-flow-toast__icon h-5 w-5 shrink-0" strokeWidth={2.25} />
            ) : scanActionToast.variant === "error" ? (
              <AlertTriangle className="operator-shipment-flow-toast__icon--error h-5 w-5 shrink-0" strokeWidth={2.25} />
            ) : (
              <Info className="operator-shipment-flow-toast__icon--neutral h-5 w-5 shrink-0" strokeWidth={2.25} />
            )}
            {scanActionToast.message}
          </p>
        </div>
      ) : null}

      {identifyGatePhotoOcrToast ? (
        <div
          className="operator-shipment-flow-toast operator-shipment-flow-toast--warning pointer-events-none fixed bottom-[calc(6.5rem+env(safe-area-inset-bottom))] left-1/2 z-[132] w-[min(calc(100vw-2rem),22rem)] -translate-x-1/2 rounded-2xl border px-4 py-3"
          role="status"
        >
          <p className="operator-shipment-flow-toast__text flex items-center gap-2 text-center text-[13px] font-bold leading-snug">
            <AlertTriangle className="operator-shipment-flow-toast__icon--warning h-5 w-5 shrink-0" strokeWidth={2.25} />
            {identifyGatePhotoOcrToast}
          </p>
        </div>
      ) : null}

      <ScannerPhotoActionSheet
        open={identifyGateOcrMenuOpen}
        onClose={() => setIdentifyGateOcrMenuOpen(false)}
        onTakePhoto={() => {
          setIdentifyGateOcrMenuOpen(false);
          identifyGateCameraCaptureRef.current?.click();
        }}
        onUploadPhoto={() => {
          setIdentifyGateOcrMenuOpen(false);
          identifyGateCameraUploadRef.current?.click();
        }}
        disabled={busy || identifyGateOcrReading}
        title="Photo options"
      />

      <OperatorMoveBoxModal
        open={moveBoxModalOpen}
        packageLabel={correctionPackageLabel}
        busy={correctionBusy}
        error={moveBoxModalError}
        target={moveBoxTargetDraft}
        onTargetChange={setMoveBoxTargetDraft}
        onRequestScanFocus={scheduleFocusScanner}
        onClose={() => {
          if (!correctionBusy) closeMoveBoxModal();
        }}
        onConfirm={(target) => void handleMoveBoxConfirm(target)}
      />
      <OperatorVoidBoxModal
        open={voidBoxModalOpen}
        packageLabel={correctionPackageLabel}
        busy={correctionBusy}
        error={voidBoxModalError}
        onClose={() => {
          if (!correctionBusy) {
            setVoidBoxModalOpen(false);
            setVoidBoxModalError(null);
          }
        }}
        onConfirm={() => void handleVoidBoxConfirm()}
      />
      <OperatorVoidPalletModal
        open={voidPalletModalOpen}
        palletLabel={
          (activePallet?.pallet_number ?? currentPalletTrackingId ?? activePallet?.id ?? "").trim() || "—"
        }
        packageCount={palletPackagePickerList.length}
        busy={correctionBusy}
        error={voidPalletModalError}
        onClose={() => {
          if (!correctionBusy) {
            setVoidPalletModalOpen(false);
            setVoidPalletModalError(null);
          }
        }}
        onConfirm={() => void handleVoidPalletConfirm()}
      />

      {completedShipmentModal ? (
        <div
          className="operator-shipment-flow-modal fixed inset-0 z-[140] flex items-center justify-center p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby={`${formId}-ship-done-title`}
        >
          <div className="operator-shipment-flow-modal__panel w-full max-w-md rounded-[24px] border p-5">
            <p
              id={`${formId}-ship-done-title`}
              className="operator-shipment-flow-modal__title text-center text-[17px] font-black leading-snug"
            >
              Shipment complete. Add extra items?
            </p>
            <p className="operator-shipment-flow-modal__body mt-3 text-center text-[12px] font-semibold leading-relaxed">
              Tracking{" "}
              <span className="font-mono font-bold">{completedShipmentModal.tracking || "—"}</span>
            </p>
            <div className="mt-6 grid grid-cols-2 gap-3">
              <button
                type="button"
                className="operator-shipment-flow-modal__btn-secondary h-11 rounded-xl border text-[13px] font-bold transition active:scale-[0.98]"
                onClick={() => {
                  setCompletedShipmentModal(null);
                  editParent();
                }}
              >
                No
              </button>
              <button
                type="button"
                className="operator-shipment-flow-modal__btn-primary h-11 rounded-xl border text-[13px] font-bold transition active:scale-[0.98]"
                onClick={() => {
                  const tn = completedShipmentModal.tracking.trim();
                  if (tn) postCompleteTrackingRef.current = tn;
                  setAwaitingPostCompleteExtraScan(true);
                  setCompletedShipmentModal(null);
                  playOperatorSuccessBeep();
                  scheduleFocusScanner();
                }}
              >
                Yes
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {saveShipmentConfirmOpen ? (
        <div
          className="operator-shipment-flow-modal fixed inset-0 z-[141] flex items-center justify-center p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby={`${formId}-save-ship-confirm-title`}
        >
          <div className="operator-shipment-flow-modal__panel w-full max-w-md rounded-[24px] border p-5">
            <p
              id={`${formId}-save-ship-confirm-title`}
              className="operator-shipment-flow-modal__title text-center text-[16px] font-black leading-snug"
            >
              {CONFIRM_SAVE_MESSAGE}
            </p>
            <p className="operator-shipment-flow-modal__body mt-3 text-center text-[13px] font-semibold leading-relaxed">
              You will save this shipment record and begin scanning boxes.
            </p>
            <div className="mt-6 grid grid-cols-2 gap-3">
              <button
                type="button"
                className="operator-shipment-flow-modal__btn-secondary h-11 rounded-xl border text-[13px] font-bold transition active:scale-[0.98]"
                onClick={() => {
                  setSaveShipmentConfirmOpen(false);
                  modalOpenRef.current = false;
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                className="operator-shipment-flow-modal__btn-primary h-11 rounded-xl border text-[13px] font-bold transition active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40"
                disabled={confirmSaving}
                onClick={() => {
                  setSaveShipmentConfirmOpen(false);
                  modalOpenRef.current = false;
                  void handleConfirmStartBoxScan();
                }}
              >
                Confirm save
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {cancelShipmentConfirmOpen ? (
        <div
          className="operator-shipment-flow-modal fixed inset-0 z-[141] flex items-center justify-center p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby={`${formId}-cancel-ship-confirm-title`}
        >
          <div className="operator-shipment-flow-modal__panel w-full max-w-md rounded-[24px] border p-5">
            <p
              id={`${formId}-cancel-ship-confirm-title`}
              className="operator-shipment-flow-modal__title text-center text-[16px] font-black leading-snug"
            >
              {CONFIRM_DISCARD_MESSAGE}
            </p>
            <p className="operator-shipment-flow-modal__body mt-3 text-center text-[13px] font-semibold leading-relaxed">
              You will return to the search screen.
            </p>
            <OperatorScannerFooterActions
              className="mt-6"
              primary={
                <button
                  type="button"
                  className="operator-shipment-flow-modal__btn-danger h-11 w-full rounded-xl border text-[13px] font-bold transition active:scale-[0.98]"
                  onClick={() => {
                    setCancelShipmentConfirmOpen(false);
                    modalOpenRef.current = false;
                    void abandonUnsavedPalletShipmentEdits().finally(() => {
                      router.push(SCANNER_OPERATOR_HOME_PATH);
                    });
                  }}
                >
                  Discard
                </button>
              }
              secondary={
                <button
                  type="button"
                  className="operator-shipment-flow-modal__btn-secondary h-11 w-full rounded-xl border text-[13px] font-bold transition active:scale-[0.98]"
                  onClick={() => {
                    setCancelShipmentConfirmOpen(false);
                    modalOpenRef.current = false;
                  }}
                >
                  Cancel
                </button>
              }
            />
          </div>
        </div>
      ) : null}

      {packageFinalizeConfirmKind ? (
        <div
          className="operator-shipment-flow-modal fixed inset-0 z-[142] flex items-center justify-center p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby={`${formId}-pkg-finalize-title`}
        >
          <div className="operator-shipment-flow-modal__panel w-full max-w-md rounded-[24px] border p-5">
            <p
              id={`${formId}-pkg-finalize-title`}
              className="operator-shipment-flow-modal__title text-center text-[16px] font-black leading-snug"
            >
              {CONFIRM_SAVE_MESSAGE}
            </p>
            <p className="operator-shipment-flow-modal__body mt-3 text-center text-[13px] font-semibold leading-relaxed">
              {packageFinalizeConfirmKind === "discrepancy"
                ? "Photos and notes will be saved. The record will be flagged and you will return to the pallet hub."
                : packageFinalizeConfirmKind === "save_hub"
                  ? "Photos and notes will be saved. You will return to the pallet hub."
                  : "Photos and notes will be saved. You will move on to item inspection for this box."}
            </p>
            {packageFinalizeConfirmKind === "discrepancy" ? (
              <p className="operator-shipment-flow-modal__note mt-2 text-center text-[11px] font-semibold leading-snug">
                Use this when counts or slip lines do not match what is on the carton.
              </p>
            ) : null}
            <OperatorScannerFooterActions
              className="mt-6"
              primary={
                <button
                  type="button"
                  className="operator-shipment-flow-modal__btn-primary h-11 w-full rounded-xl border text-[13px] font-bold transition active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40"
                  disabled={boxSaveBusy}
                  onClick={() => {
                    const kind = packageFinalizeConfirmKind;
                    setPackageFinalizeConfirmKind(null);
                    modalOpenRef.current = false;
                    if (!kind) return;
                    if (packageScanOrderIdConflictHighlight) {
                      setPendingConflictPackageSaveKind(kind);
                      setPackageSaveOrderConflictGateOpen(true);
                      modalOpenRef.current = true;
                      return;
                    }
                    dispatchPackageFinalizeSave(kind);
                  }}
                >
                  {packageFinalizeConfirmKind === "discrepancy"
                    ? "Save with discrepancy"
                    : packageFinalizeConfirmKind === "save_hub"
                      ? "Save & exit to hub"
                      : "Save & continue"}
                </button>
              }
              secondary={
                <button
                  type="button"
                  className="operator-shipment-flow-modal__btn-secondary h-11 w-full rounded-xl border text-[13px] font-bold transition active:scale-[0.98]"
                  onClick={() => {
                    setPackageFinalizeConfirmKind(null);
                    modalOpenRef.current = false;
                  }}
                >
                  Go Back
                </button>
              }
            />
          </div>
        </div>
      ) : null}

      {packageSaveOrderConflictGateOpen ? (
        <div
          className="operator-shipment-flow-modal operator-shipment-flow-modal--warning fixed inset-0 z-[144] flex items-center justify-center p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby={`${formId}-pkg-order-conflict-title`}
        >
          <div className="operator-shipment-flow-modal__panel w-full max-w-md rounded-[24px] border p-5">
            <p
              id={`${formId}-pkg-order-conflict-title`}
              className="operator-shipment-flow-modal__title text-center text-[15px] font-black leading-snug"
            >
              {PACKAGE_SAVE_ORDER_CONFLICT_WARNING}
            </p>
            <div className="mt-6 grid grid-cols-2 gap-3">
              <button
                type="button"
                className="operator-shipment-flow-modal__btn-secondary h-11 rounded-xl border text-[13px] font-bold transition active:scale-[0.98]"
                onClick={() => {
                  setPackageSaveOrderConflictGateOpen(false);
                  setPendingConflictPackageSaveKind(null);
                  modalOpenRef.current = false;
                }}
              >
                No
              </button>
              <button
                type="button"
                className="operator-shipment-flow-modal__btn-warning h-11 rounded-xl border text-[13px] font-bold transition active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40"
                disabled={boxSaveBusy}
                onClick={() => {
                  const kind = pendingConflictPackageSaveKind;
                  setPackageSaveOrderConflictGateOpen(false);
                  setPendingConflictPackageSaveKind(null);
                  modalOpenRef.current = false;
                  if (kind) dispatchPackageFinalizeSave(kind);
                }}
              >
                Yes, Save Anyway
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {scannerLeaveConfirmOpen ? (
        <div
          className="operator-shipment-flow-modal fixed inset-0 z-[143] flex items-center justify-center p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby={`${formId}-scanner-leave-title`}
        >
          <div className="operator-shipment-flow-modal__panel w-full max-w-md rounded-[24px] border p-5">
            <p
              id={`${formId}-scanner-leave-title`}
              className="operator-shipment-flow-modal__title text-center text-[16px] font-black leading-snug"
            >
              {SCANNER_LEAVE_UNSAVED_TITLE}
            </p>
            <p className="operator-shipment-flow-modal__body mt-3 text-center text-[13px] font-semibold leading-relaxed">
              {SCANNER_LEAVE_UNSAVED_BODY}
            </p>
            <div className="mt-6 grid grid-cols-2 gap-3">
              <button
                type="button"
                className="operator-shipment-flow-modal__btn-secondary h-11 rounded-xl border text-[13px] font-bold transition active:scale-[0.98]"
                onClick={() => {
                  scannerLeavePendingActionRef.current = null;
                  setScannerLeaveConfirmOpen(false);
                  modalOpenRef.current = false;
                }}
              >
                Stay
              </button>
              <button
                type="button"
                className="operator-shipment-flow-modal__btn-danger h-11 rounded-xl border text-[13px] font-bold transition active:scale-[0.98]"
                onClick={() => runScannerLeavePendingAction()}
              >
                Leave
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {pickerDismissConfirmOpen ? (
        <div
          className="operator-shipment-flow-modal fixed inset-0 z-[143] flex items-center justify-center p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby={`${formId}-picker-dismiss-title`}
        >
          <div className="operator-shipment-flow-modal__panel w-full max-w-md rounded-[24px] border p-5">
            <p
              id={`${formId}-picker-dismiss-title`}
              className="operator-shipment-flow-modal__title text-center text-[16px] font-black leading-snug"
            >
              {CONFIRM_DISCARD_MESSAGE}
            </p>
            <p className="operator-shipment-flow-modal__body mt-3 text-center text-[13px] font-semibold leading-relaxed">
              Your unsaved picker selection will be cleared.
            </p>
            <div className="mt-6 grid grid-cols-2 gap-3">
              <button
                type="button"
                className="operator-shipment-flow-modal__btn-secondary h-11 rounded-xl border text-[13px] font-bold transition active:scale-[0.98]"
                onClick={() => {
                  setPickerDismissConfirmOpen(false);
                  modalOpenRef.current = false;
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                className="operator-shipment-flow-modal__btn-danger h-11 rounded-xl border text-[13px] font-bold transition active:scale-[0.98]"
                onClick={() => {
                  setPickerDismissConfirmOpen(false);
                  modalOpenRef.current = false;
                  performBoxIntakeBackNavigation();
                }}
              >
                Discard
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {packageSessionCancelConfirmOpen ? (
        <div
          className="operator-shipment-flow-modal fixed inset-0 z-[142] flex items-center justify-center p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby={`${formId}-pkg-cancel-session-title`}
        >
          <div className="operator-shipment-flow-modal__panel w-full max-w-md rounded-[24px] border p-5">
            <p
              id={`${formId}-pkg-cancel-session-title`}
              className="operator-shipment-flow-modal__title text-center text-[16px] font-black leading-snug"
            >
              {CONFIRM_DISCARD_MESSAGE}
            </p>
            <p className="operator-shipment-flow-modal__body mt-3 text-center text-[13px] font-semibold leading-relaxed">
              You will lose edits on this open box session.
            </p>
            <OperatorScannerFooterActions
              className="mt-6"
              primary={
                <button
                  type="button"
                  className="operator-shipment-flow-modal__btn-danger h-11 w-full rounded-xl border text-[13px] font-bold transition active:scale-[0.98]"
                  onClick={() => {
                    setPackageSessionCancelConfirmOpen(false);
                    modalOpenRef.current = false;
                    const scrollToHub = !directBox && Boolean(activePallet?.id?.trim());
                    performBoxIntakeBackNavigation();
                    if (scrollToHub) {
                      window.requestAnimationFrame(() => {
                        window.requestAnimationFrame(() => {
                          document
                            .getElementById("operator-saved-boxes-hub")
                            ?.scrollIntoView({ behavior: "smooth", block: "start" });
                        });
                      });
                    }
                  }}
                >
                  Discard & Back
                </button>
              }
              secondary={
                <button
                  type="button"
                  className="operator-shipment-flow-modal__btn-secondary h-11 w-full rounded-xl border text-[13px] font-bold transition active:scale-[0.98]"
                  onClick={() => {
                    setPackageSessionCancelConfirmOpen(false);
                    modalOpenRef.current = false;
                  }}
                >
                  Go Back
                </button>
              }
            />
          </div>
        </div>
      ) : null}

      {slipChangeConfirmOpen ? (
        <div
          className="operator-shipment-flow-modal fixed inset-0 z-[145] flex items-center justify-center p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby={`${formId}-slip-change-title`}
        >
          <div className="operator-shipment-flow-modal__panel w-full max-w-md rounded-[24px] border p-5">
            <p
              id={`${formId}-slip-change-title`}
              className="operator-shipment-flow-modal__title text-center text-[16px] font-black leading-snug"
            >
              Slip changed — items already scanned
            </p>
            <p className="operator-shipment-flow-modal__body mt-3 text-center text-[13px] font-semibold leading-relaxed">
              {packageItemHydratedRows.length} unit{packageItemHydratedRows.length !== 1 ? "s were" : " was"} scanned
              against the current slip. Items not found in the new slip will show as{" "}
              <span className="font-bold text-amber-600 dark:text-amber-400">OVER</span>.
            </p>
            <p className="operator-shipment-flow-modal__note mt-2 text-center text-[11px] font-semibold leading-snug">
              Items from the old slip that were not scanned will be removed from the expected list.
            </p>
            <OperatorScannerFooterActions
              className="mt-6"
              primary={
                <button
                  type="button"
                  className="operator-shipment-flow-modal__btn-warning h-11 w-full rounded-xl border border-amber-500/60 bg-amber-50 text-[13px] font-bold text-amber-900 transition active:scale-[0.98] dark:bg-amber-900/20 dark:text-amber-300"
                  onClick={() => void executeSlipChangePending()}
                >
                  Use new slip
                </button>
              }
              secondary={
                <button
                  type="button"
                  className="operator-shipment-flow-modal__btn-secondary h-11 w-full rounded-xl border text-[13px] font-bold transition active:scale-[0.98]"
                  onClick={() => {
                    slipChangePendingRef.current = null;
                    setSlipChangeConfirmOpen(false);
                    modalOpenRef.current = false;
                  }}
                >
                  Keep old slip
                </button>
              }
            />
          </div>
        </div>
      ) : null}

      {itemsBoxFinalizeModalOpen ? (
        <div
          className="operator-shipment-flow-modal fixed inset-0 z-[143] flex items-center justify-center p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby={`${formId}-items-finalize-title`}
        >
          <div className="operator-shipment-flow-modal__panel w-full max-w-md rounded-[24px] border p-5">
            <p
              id={`${formId}-items-finalize-title`}
              className="operator-shipment-flow-modal__title text-center text-[16px] font-black leading-snug"
            >
              {CONFIRM_SAVE_MESSAGE}
            </p>
            <p className="operator-shipment-flow-modal__body mt-2 text-center text-[13px] font-semibold leading-snug">
              Finalize this box and return to the pallet hub?
            </p>
            <p className="operator-shipment-flow-modal__body mt-3 text-center text-[13px] font-semibold leading-relaxed tabular-nums">
              Items:{" "}
              <span className="font-mono font-bold">
                {itemsPhaseLiveTotalScanned}/{itemInspectionQtyBasisExpected}
              </span>
              . Status:{" "}
              <span className="font-bold">{itemInspectionAggregateStatusLabel}</span>
            </p>
            {itemDraft ? (
              <p className="operator-shipment-flow-modal__note mt-2 text-center text-[11px] font-semibold leading-snug">
                You still have an item draft open — it will be cleared when you finalize.
              </p>
            ) : null}
            {isItemsQtyDiscrepancy ? (
              <p className="operator-shipment-flow-modal__alert mt-3 rounded-xl px-3 py-2.5 text-center text-[11px] font-semibold leading-snug">
                <strong>Warning:</strong> Expected{" "}
                <span className="font-mono font-bold">{itemInspectionQtyBasisExpected}</span> units vs scanned{" "}
                <span className="font-mono font-bold">{itemsPhaseLiveTotalScanned}</span>. Continue anyway?
              </p>
            ) : null}
            <OperatorScannerFooterActions
              className="mt-6"
              primary={
                <button
                  type="button"
                  disabled={busy || itemsFinalizeBusy}
                  className={`flex w-full items-center justify-center gap-2 rounded-xl border transition active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40 ${ZEBRA_COMPACT_BTN} ${
                    isItemsQtyDiscrepancy
                      ? "border-amber-500/50 bg-amber-100 text-amber-950"
                      : "border-[#C8A96A]/55 bg-gradient-to-b from-[#3d4550] to-[#171c22] text-[#faf6ed]"
                  }`}
                  onClick={() => void confirmItemsPhaseFinalizeToHub()}
                >
                  {isItemsQtyDiscrepancy ? (
                    <>
                      <AlertTriangle className="h-4 w-4 shrink-0" strokeWidth={2.35} aria-hidden />
                      {itemsFinalizeBusy ? "Saving…" : "Confirm save"}
                    </>
                  ) : (
                    <>
                      <Check className="h-4 w-4 shrink-0" strokeWidth={2.75} aria-hidden />
                      {itemsFinalizeBusy ? "Working…" : "Confirm save"}
                    </>
                  )}
                </button>
              }
              secondary={
                <button
                  type="button"
                  className={`w-full rounded-xl border border-[var(--scanner-border)] bg-[var(--scanner-card)] text-[var(--scanner-text)] transition active:scale-[0.98] ${ZEBRA_COMPACT_BTN}`}
                  onClick={() => {
                    setItemsBoxFinalizeModalOpen(false);
                    modalOpenRef.current = false;
                    scheduleFocusScanner();
                  }}
                >
                  Go Back
                </button>
              }
            />
          </div>
        </div>
      ) : null}

      {packageSaveSuccessOverlay ? (
        <div
          className="operator-shipment-flow-modal operator-shipment-flow-modal--success-overlay fixed inset-0 z-[150] flex items-center justify-center p-6"
          role="status"
          aria-live="polite"
          aria-label="Package saved successfully"
        >
          <div className="operator-shipment-flow-modal__panel operator-shipment-flow-modal__panel--success flex flex-col items-center gap-3 rounded-[28px] border px-10 py-8">
            <CheckCircle2 className="operator-shipment-flow-modal__success-icon h-[4.5rem] w-[4.5rem] shrink-0" strokeWidth={2} aria-hidden />
            <p className="operator-shipment-flow-modal__title text-center text-[18px] font-black tracking-tight">Saved</p>
            <p className="operator-shipment-flow-modal__body text-center text-[12px] font-semibold">
              {packageSaveSuccessDestination === "hub"
                ? "Taking you to the pallet hub…"
                : "Opening item inspection…"}
            </p>
          </div>
        </div>
      ) : null}

      {flowPhase === "items" && hasItemReceivableBox ? (
        <div
          className="operator-item-scan-fixed-actions operator-item-scan-actions operator-item-scan-actions--compact fixed bottom-[calc(var(--scanner-bottom-nav-height,4.75rem)+env(safe-area-inset-bottom,0px))] left-1/2 z-[100] grid w-full max-w-[430px] -translate-x-1/2 grid-cols-2 items-stretch gap-2 border-t px-3 pb-0 pt-1.5 sm:px-4"
          role="region"
          aria-label="Item inspection actions"
        >
          <button
            type="button"
            disabled={busy || itemsFinalizeBusy}
            onClick={() => confirmItemsPhaseSaveAndExit()}
            className={`operator-item-scan-btn-save-exit order-1 flex w-full items-center justify-center gap-2 rounded-xl px-3 transition active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40 ${ZEBRA_COMPACT_BTN}`}
          >
            <PackageOpen className="h-4 w-4 shrink-0 opacity-95" strokeWidth={2.25} aria-hidden />
            <span className="truncate">Save &amp; Exit</span>
          </button>
          <button
            type="button"
            disabled={busy || itemsFinalizeBusy}
            onClick={() => {
              modalOpenRef.current = true;
              setItemsBoxFinalizeModalOpen(true);
            }}
            className={`operator-item-scan-btn-finalize order-2 inline-flex w-full max-w-none shrink-0 items-center justify-center gap-2 rounded-xl px-3 transition active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40 ${ZEBRA_COMPACT_BTN} ${
              isItemsQtyDiscrepancy
                ? "operator-item-scan-btn-finalize--discrepancy"
                : "operator-item-scan-btn-finalize--ok"
            }`}
          >
            {isItemsQtyDiscrepancy ? (
              <>
                <AlertTriangle className="h-4 w-4 shrink-0" strokeWidth={2.35} aria-hidden />
                <span className="truncate">Complete with Discrepancy</span>
              </>
            ) : (
              <>
                <Check className="h-4 w-4 shrink-0" strokeWidth={2.75} aria-hidden />
                <span className="truncate">Finalize &amp; Close Box</span>
              </>
            )}
          </button>
        </div>
      ) : null}

      <ScannerBottomNav active="scan" alertCount={2} />

      {candidatePicker ? (
        <div
          className="operator-shipment-flow-modal fixed inset-0 z-[120] flex items-end justify-center p-4 pb-[max(1rem,env(safe-area-inset-bottom))] sm:items-center"
          role="dialog"
          aria-modal="true"
          aria-labelledby={`${formId}-pick-title`}
        >
          <div className="operator-shipment-flow-modal__panel w-full max-w-md rounded-[24px] border p-4">
            <div className="flex items-start justify-between gap-2">
              <div>
                <p id={`${formId}-pick-title`} className="operator-shipment-flow-modal__title text-lg font-black">
                  Pick expected line
                </p>
                <p className="operator-shipment-flow-modal__note mt-1 font-mono text-xs font-bold">
                  {candidatePicker.tier.toUpperCase()} · {candidatePicker.barcode}
                </p>
                <p className="operator-shipment-flow-modal__body mt-2 text-[12px] font-semibold">
                  Multiple disposition rows share this identifier — choose the carton line to receive against.
                </p>
              </div>
              <button
                type="button"
                onClick={() => {
                  modalOpenRef.current = false;
                  setCandidatePicker(null);
                  scheduleFocusScanner();
                }}
                className="operator-shipment-flow-modal__btn-secondary rounded-xl p-2 transition active:scale-[0.98]"
                aria-label="Close"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="mt-4 flex max-h-[40vh] flex-col gap-2 overflow-auto">
              {(Array.isArray(candidatePicker.candidates) ? candidatePicker.candidates : []).map((epRow) => (
                <button
                  key={String(epRow.id)}
                  type="button"
                  onClick={() => {
                    void (async () => {
                      const r = epRow as Record<string, unknown>;
                      queueItemUnitModal({
                        scannedBarcode: candidatePicker.barcode,
                        slip: null,
                        slipDescription: epRowToSlipDescriptionForItemModal(r),
                        matchKindPreset: itemResolveTierToPackageMatchKind(candidatePicker.tier),
                        title: "Record scanned unit",
                        subtitle: epPackageRowPrimaryLabel(r),
                      });
                      modalOpenRef.current = false;
                      setCandidatePicker(null);
                      scheduleFocusScanner();
                    })();
                  }}
                  className="operator-shipment-flow-modal__btn-secondary rounded-xl border px-3 py-3 text-left text-[13px] font-bold transition active:scale-[0.98]"
                >
                  <span className="operator-shipment-flow-modal__note block font-mono text-[12px]">
                    {epPackageRowPrimaryLabel(epRow as Record<string, unknown>)}
                  </span>
                  {epPackageRowCatalogSubtitle(epRow as Record<string, unknown>) ? (
                    <span className="operator-shipment-flow-modal__body mt-1 block text-[11px] font-semibold normal-case">
                      {epPackageRowCatalogSubtitle(epRow as Record<string, unknown>)}
                    </span>
                  ) : null}
                  <span className="operator-shipment-flow-modal__body mt-1 block text-[11px] font-semibold">
                    Disposition {String(epRow.disposition ?? "—")} · Expected qty{" "}
                    {String(epRow.expected_scan_quantity ?? "—")}
                  </span>
                </button>
              ))}
            </div>
          </div>
        </div>
      ) : null}

      {slipLineCandidatePicker ? (
        <div
          className="operator-shipment-flow-modal fixed inset-0 z-[121] flex items-end justify-center p-4 pb-[max(1rem,env(safe-area-inset-bottom))] sm:items-center"
          role="dialog"
          aria-modal="true"
          aria-labelledby={`${formId}-slip-pick-title`}
        >
          <div className="operator-shipment-flow-modal__panel w-full max-w-md rounded-[24px] border p-4">
            <div className="flex items-start justify-between gap-2">
              <div>
                <p id={`${formId}-slip-pick-title`} className="operator-shipment-flow-modal__title text-lg font-black">
                  Pick slip line
                </p>
                <p className="operator-shipment-flow-modal__note mt-1 font-mono text-xs font-bold">
                  {slipLineCandidatePicker.tier.toUpperCase()} · {slipLineCandidatePicker.barcode}
                </p>
                <p className="operator-shipment-flow-modal__body mt-2 text-[12px] font-semibold">
                  Multiple packing-slip lines share this code — choose the row to record this scan against.
                </p>
              </div>
              <button
                type="button"
                onClick={() => {
                  modalOpenRef.current = false;
                  setSlipLineCandidatePicker(null);
                  scheduleFocusScanner();
                }}
                className="operator-shipment-flow-modal__btn-secondary rounded-xl p-2 transition active:scale-[0.98]"
                aria-label="Close"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="mt-4 flex max-h-[40vh] flex-col gap-2 overflow-auto">
              {(Array.isArray(slipLineCandidatePicker.candidates) ? slipLineCandidatePicker.candidates : []).map(
                (slip, i) => (
                  <button
                    key={slip.id ?? `cand-${i}`}
                    type="button"
                    onClick={() => {
                      void (async () => {
                        queueItemUnitModal({
                          scannedBarcode: slipLineCandidatePicker.barcode,
                          slip,
                          title: "Record scanned unit",
                          subtitle:
                            String(slip.description ?? "").trim() ||
                            [slip.fnsku, slip.upc].filter(Boolean).join(" · ") ||
                            null,
                        });
                        modalOpenRef.current = false;
                        setSlipLineCandidatePicker(null);
                        scheduleFocusScanner();
                      })();
                    }}
                    className="operator-shipment-flow-modal__btn-secondary rounded-xl border px-3 py-3 text-left text-[13px] font-bold transition active:scale-[0.98]"
                  >
                    {(() => {
                      const linkage =
                        productLinkageForSlipMatch(slip, itemInspectionSlipLines) ??
                        buildProductLinkageDisplayContract(
                          { description: slip.description, fnsku: slip.fnsku, upc: slip.upc },
                          EMPTY_PRODUCT_NAME_LOOKUP,
                        );
                      return (
                        <>
                          <ProductLinkagePrimaryLink
                            linkage={linkage}
                            detailFrom="scan"
                            className="operator-shipment-flow-modal__title block text-[12px] font-semibold leading-snug text-sky-300 underline decoration-sky-400/50 underline-offset-2"
                            onClick={(e) => e.stopPropagation()}
                          />
                          <OperatorProductLinkageMeta linkage={linkage} linkResolvedProductId={false} detailFrom="scan" />
                        </>
                      );
                    })()}
                    <span className="operator-shipment-flow-modal__body mt-1 block font-mono text-[11px] font-semibold">
                      UPC {slip.upc?.trim() || "—"} · FNSKU {slip.fnsku?.trim() || "—"} · Qty{" "}
                      {Math.max(0, Math.floor(Number(slip.quantity ?? 0)))}
                    </span>
                  </button>
                ),
              )}
            </div>
          </div>
        </div>
      ) : null}

      <ItemScanEditUnitPickerModal
        open={itemScanUnitPickerOpen && Boolean(itemScanEditPick)}
        rowTitle={itemScanEditPick?.rowTitle ?? "Scanned item"}
        rowSubtitle={itemScanEditPick?.rowSubtitle ?? null}
        units={itemScanEditPickUnits}
        busy={busy}
        onEditUnit={(unit) => {
          closeItemScanUnitPicker();
          openEditScannedItemModal(unit);
        }}
        onClose={closeItemScanUnitPicker}
      />

      <ItemUnitRecordModal
        open={Boolean(itemUnitModal)}
        mode={itemUnitModal?.mode ?? "create"}
        title={itemUnitModal?.title}
        subtitle={itemUnitModal?.subtitle ?? undefined}
        saveLabel={itemUnitModal?.mode === "edit" ? "Save changes" : undefined}
        barcodeReadOnly={itemUnitModal?.mode === "edit"}
        initialBarcode={itemUnitModal?.scannedBarcode ?? ""}
        initialState={itemUnitModal?.initialState ?? null}
        organizationId={(orgId ?? "").trim()}
        slipDescription={itemUnitModal?.slipDescription ?? undefined}
        productLinkage={itemUnitModal?.productLinkage ?? null}
        storeId={sessionStoreId}
        matchKind={itemUnitModal?.matchKindPreset ?? null}
        resolveBarcodeLinkage={resolveItemUnitBarcodeLinkage}
        busy={busy}
        onClose={() => closeItemUnitModal(true)}
        onSave={saveItemUnitModal}
        onUnsavedDraftChange={handleItemUnitModalUnsavedDraftChange}
      />

      {unexpectedPackageItemModal ? (
        <div
          className="operator-shipment-flow-modal fixed inset-0 z-[121] flex items-end justify-center p-4 pb-[max(1rem,env(safe-area-inset-bottom))] sm:items-center"
          role="dialog"
          aria-modal="true"
          aria-labelledby={`${formId}-unexpected-slip-title`}
        >
          <div className="operator-shipment-flow-modal__panel w-full max-w-md rounded-[24px] border p-5">
            <p
              id={`${formId}-unexpected-slip-title`}
              className="operator-shipment-flow-modal__title text-center text-[16px] font-black"
            >
              Item not found in Packing Slip
            </p>
            <p className="operator-shipment-flow-modal__note mt-2 text-center font-mono text-[12px] font-bold">
              {unexpectedPackageItemModal.barcode}
            </p>
            <p className="operator-shipment-flow-modal__body mt-3 text-center text-[13px] font-semibold leading-relaxed">
              Are you sure you want to add it? This records an unexpected unit on the box (not linked to a slip line).
            </p>
            <div className="mt-6 grid grid-cols-2 gap-3">
              <button
                type="button"
                className="operator-shipment-flow-modal__btn-secondary h-11 rounded-xl border text-[13px] font-bold transition active:scale-[0.98]"
                onClick={() => {
                  modalOpenRef.current = false;
                  setUnexpectedPackageItemModal(null);
                  scheduleFocusScanner();
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={busy}
                className="operator-shipment-flow-modal__btn-warning flex h-11 items-center justify-center gap-2 rounded-xl border text-[13px] font-bold transition active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40"
                onClick={() => {
                  void (async () => {
                    const code = unexpectedPackageItemModal.barcode;
                    modalOpenRef.current = false;
                    setUnexpectedPackageItemModal(null);
                    queueItemUnitModal({
                      scannedBarcode: code,
                      slip: null,
                      matchKindPreset: "unexpected",
                      title: "Unexpected unit",
                      subtitle: "Not on packing slip — saved without a slip line link.",
                    });
                  })();
                }}
              >
                Add anyway
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {unknownModal ? (
        <div
          className="operator-shipment-flow-modal fixed inset-0 z-[120] flex items-end justify-center p-4 pb-[max(1rem,env(safe-area-inset-bottom))] sm:items-center"
          role="dialog"
          aria-modal="true"
          aria-labelledby={`${formId}-unk-title`}
        >
          <div className="operator-shipment-flow-modal__panel w-full max-w-md rounded-[24px] border p-4">
            <div className="flex items-start justify-between gap-2">
              <div>
                <p id={`${formId}-unk-title`} className="operator-shipment-flow-modal__title text-lg font-black">
                  Unrecognized code
                </p>
                <p className="operator-shipment-flow-modal__note mt-1 font-mono text-sm font-bold">{unknownModal.code}</p>
                <p className="operator-shipment-flow-modal__body mt-2 text-xs font-semibold">
                  Choose match type: Tracking → Box → Slip → Pallet → Item
                </p>
              </div>
              <button
                type="button"
                onClick={closeUnknown}
                className="operator-shipment-flow-modal__btn-secondary rounded-xl p-2 transition active:scale-[0.98]"
                aria-label="Close"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="mt-4 grid grid-cols-2 gap-2">
              {(
                [
                  ["tracking", "Tracking"],
                  ["package", "Box"],
                  ["slip", "Slip"],
                  ["pallet", "Pallet"],
                  ["item", "Item"],
                ] as const
              ).map(([kind, lab]) => (
                <button
                  key={kind}
                  type="button"
                  onClick={() => void forceResolve(kind)}
                  className="operator-shipment-flow-modal__btn-secondary rounded-xl px-2 py-3 text-center text-xs font-black uppercase tracking-wide transition active:scale-[0.98]"
                >
                  {lab}
                </button>
              ))}
            </div>

            {allowOperatorUnknownPackageCreate() ? (
              <div className="operator-shipment-flow-modal__alert mt-4 rounded-[18px] px-3 py-3">
                <p className="text-[13px] font-bold">Shipment code not found</p>
                <p className="mt-1 text-[11px] font-semibold leading-relaxed">
                  Tracking not found in the database. Create a new unknown box with this scan as{" "}
                  <span className="font-mono">tracking_number</span>? You can continue receiving; worklist data may
                  arrive later.
                </p>
                {operatorStoresLoading ? (
                  <p className="operator-shipment-flow-modal__body mt-2 text-[11px] font-semibold">Loading stores…</p>
                ) : !sessionStoreId ? (
                  <p className="operator-shipment-flow-modal__body mt-2 text-[11px] font-semibold">
                    {operatorStores.length === 0 && !kioskStoreLocked
                      ? "Add an active store for this organization in Settings, or set NEXT_PUBLIC_STORE_ID for kiosk mode."
                      : "Select an active store above (or configure NEXT_PUBLIC_STORE_ID) before creating a box."}
                  </p>
                ) : (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void handleCreateUnknownPackage()}
                    className="operator-shipment-flow-modal__btn-primary mt-3 w-full rounded-xl py-3 text-[12px] font-black uppercase tracking-wide transition active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    Create unknown box
                  </button>
                )}
              </div>
            ) : null}

            <button
              type="button"
              onClick={closeUnknown}
              className="operator-shipment-flow-modal__btn-secondary mt-3 w-full rounded-xl border py-3 text-sm font-bold transition active:scale-[0.98]"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export default function OperatorMobileScanPage() {
  return (
    <ScanPageErrorBoundary>
      <Suspense fallback={null}>
        <OperatorMobileScanPageContent />
      </Suspense>
    </ScanPageErrorBoundary>
  );
}
