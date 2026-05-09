"use client";

import {
  Component,
  Suspense,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useLayoutEffect,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type CSSProperties,
  type FormEvent,
  type ReactNode,
} from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
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
  ClipboardList,
  Info,
  Loader2,
  Minus,
  Package,
  Package2,
  PackageOpen,
  Pencil,
  Plus,
  Puzzle,
  Save,
  ScanLine,
  Search,
  ThumbsUp,
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
  EP_DETAIL_SELECT,
  fetchExpectedPackageDetailRowsByIds,
  fetchExpectedPackageDetailRowsForParent,
  fetchExpectedPackagesForTracking,
  loadPalletExpectationSnapshot,
  loadTrackingExpectationSnapshot,
  mockExpectedPackageDetailRows,
  mockPalletExpectationSnapshot,
  mockTrackingExpectationSnapshot,
  type TrackingExpectationTotals,
  type TrackingOperatorLine,
} from "@/lib/scanner/operator-tracking-expectations";
import {
  aggregateInventoryStatus,
  fetchVInventoryItemStatusLinesExact,
  fetchVInventoryStatusForScanCode,
  formatInventoryProgressLabel,
  mapInventoryViewStatusToVisual,
  mockVInventoryItemStatusLinesForExact,
  mockVInventoryRowsForScanCode,
  resolveInventoryGateVisualStatus,
  safeInventoryProgressPercent,
  type InventoryGateVisualStatus,
  type InventoryViewMatchField,
  type VInventoryStatusRow,
} from "@/lib/scanner/v-inventory-status";
import { resolveItemBarcodeAgainstExpectedRows, type ItemResolveTier } from "@/lib/scanner/operator-item-resolve";
import { mergeReturnPhotoEvidence } from "@/lib/return-photo-evidence";
import { extractEvidenceKeyUrls } from "@/lib/entity-photo-evidence";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  isAcceptableStoredMediaReference,
  normalizePalletDocumentationImageUrls,
} from "@/lib/media-reference";
import { isUuidString } from "@/lib/uuid";
import { operatorReceiveItem } from "@/app/scanner/operator-mobile/item-actions";
import {
  allowOperatorUnknownPackageCreate,
  insertUnknownPackageForTrackingCode,
} from "@/lib/scanner/operator-unknown-package";
import { insertIntakeBoxPackage } from "@/lib/scanner/operator-box-intake";
import { looksLikePackingSlipScan, type SlipExtractResult } from "@/lib/scanner/operator-slip-scan";
import { normalizeTrackingKey, slipIdLookupCandidates, trackingKeysEqual } from "@/lib/scanner/tracking-normalize";
import {
  findPalletByTrackingNormalized,
  palletHasPersistedShipmentDetails,
  type OperatorPalletTrackingRow,
} from "@/lib/scanner/operator-pallet-tracking";
import type { SlipVisionExtract } from "@/lib/scanner/slip-extract-parse";
import { attachMatchStatusToSlipItems, type SlipVisionItemRow } from "@/lib/scanner/slip-vision-match";
import { getAIUnifiedKeyFromStorage, getOpenAIApiKeyFromStorage } from "@/lib/openai-settings";
import {
  KNOWN_CARRIER_ENTRIES,
  OTHER_CARRIER_NAME,
  isKnownCarrierName,
  normalizeCarrierLabel,
} from "@/lib/carriers";
import { MasterUploader } from "@/components/MasterUploader";
import { ScannerBottomNav, SCANNER_OPERATOR_HOME_PATH } from "../_components/ScannerBottomNav";
import {
  commitOperatorPalletShipmentStepAction,
  createOperatorPalletAction,
  findOperatorPalletByTrackingNumberAction,
} from "../_components/operator-store-actions";
import { resolveOperatorAuditFieldsClient } from "@/lib/scanner/operator-audit-fields";
import { useOperatorSessionStore } from "../_components/OperatorSessionStoreProvider";

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

/** Theme-aware glass panels (see globals.css `.scanner-page-glass-card`) */
const glassCard = "scanner-page-glass-card";

/** `pallets.photo_evidence` gallery — `{ urls: string[] }` (see migration 20260331). */
function parsePalletPhotoEvidenceUrls(raw: unknown): string[] {
  if (raw == null) return [];
  if (typeof raw === "string") {
    try {
      return parsePalletPhotoEvidenceUrls(JSON.parse(raw) as unknown);
    } catch {
      return [];
    }
  }
  if (typeof raw !== "object") return [];
  const urls = (raw as { urls?: unknown }).urls;
  if (!Array.isArray(urls)) return [];
  const out: string[] = [];
  for (const u of urls) {
    const s = typeof u === "string" ? u.trim() : "";
    if (isAcceptableStoredMediaReference(s)) out.push(s);
  }
  return out;
}

/** Shipping label column + JSONB evidence (when manifest column empty — extras up to maxFiles). */
function buildHydratedShippingLabelUrls(
  manifest: string | null | undefined,
  photoEvidence: unknown,
  maxFiles: number,
): string[] {
  const m = (manifest ?? "").trim();
  const ev = parsePalletPhotoEvidenceUrls(photoEvidence);
  const urls: string[] = [];
  if (m) urls.push(m);
  for (const u of ev) {
    if (urls.length >= maxFiles) break;
    if (!urls.includes(u)) urls.push(u);
  }
  if (urls.length === 0 && ev.length > 0) return ev.slice(0, maxFiles);
  return urls.slice(0, maxFiles);
}

/** Prefer structured `photo_evidence.*_urls`; fall back to legacy TEXT columns + flat `urls` tail for labels. */
function hydrateOperatorPalletDocumentationPhotoUrls(
  row: {
    manifest_photo_url?: string | null;
    photo_url?: string | null;
    bol_photo_url?: string | null;
    photo_evidence?: unknown;
  },
  sb: SupabaseClient,
): { shippingLabel: string[]; pallet: string[]; bol: string[] } {
  const pe = row.photo_evidence;
  const labelStructured = extractEvidenceKeyUrls(pe, "label_urls", 3);
  const shippingRaw =
    labelStructured.length > 0 ? labelStructured : buildHydratedShippingLabelUrls(row.manifest_photo_url, pe, 3);

  const palletStructured = extractEvidenceKeyUrls(pe, "pallet_urls", 3);
  const pu = (row.photo_url ?? "").trim();
  const palletRaw = palletStructured.length > 0 ? palletStructured : pu && isAcceptableStoredMediaReference(pu) ? [pu] : [];

  const bolStructured = extractEvidenceKeyUrls(pe, "bol_urls", 3);
  const bu = (row.bol_photo_url ?? "").trim();
  const bolRaw = bolStructured.length > 0 ? bolStructured : bu && isAcceptableStoredMediaReference(bu) ? [bu] : [];

  return {
    shippingLabel: normalizePalletDocumentationImageUrls(shippingRaw, sb, 3),
    pallet: normalizePalletDocumentationImageUrls(palletRaw, sb, 3),
    bol: normalizePalletDocumentationImageUrls(bolRaw, sb, 3),
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

function identificationGatePrimaryCta(visual: InventoryGateVisualStatus): string {
  switch (visual) {
    case "new":
      return "Continue Shipment";
    case "manual_new":
      return "Create & Start";
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

function shipmentLineStatusVisual(status: string | null): InventoryGateVisualStatus {
  return mapInventoryViewStatusToVisual(status) ?? "manual_new";
}

/**
 * Searchable carrier picker for the operator slip-details card.
 *
 * Behavior:
 *   • Trigger button shows the current carrier (a known canonical name, the "Other / Not Listed"
 *     sentinel, or a placeholder when blank).
 *   • Clicking the trigger opens a popover with a search input and a filtered list. The filter
 *     matches against carrier name AND SCAC code, so typing "EX" finds "Estes (EXLA)".
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
}) {
  const { triggerId, value, otherSelected, onPickKnown, onPickOther, invalid = false } = props;

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // Close on outside click / Escape key.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent | TouchEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (triggerRef.current?.contains(target)) return;
      if (panelRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("touchstart", onPointerDown, { passive: true });
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("touchstart", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  // Reset query and auto-focus search when the panel opens.
  useEffect(() => {
    if (!open) {
      setQuery("");
      return;
    }
    const id = window.setTimeout(() => searchRef.current?.focus(), 60);
    return () => window.clearTimeout(id);
  }, [open]);

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
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-invalid={invalid}
        title={triggerLabel}
        className={`scanner-input-glass flex h-10 w-full items-center justify-between gap-2 rounded-lg border px-3 text-left text-[13px] outline-none transition focus-visible:border-teal-400/45 focus-visible:shadow-[0_0_0_2px_rgba(45,212,191,0.22)] ${
          invalid ? "border-amber-500/55" : ""
        }`}
        style={{ color: triggerIsPlaceholder ? MUTED_LABEL : TEXT_PRIMARY }}
      >
        <span className="min-w-0 flex-1 truncate">{triggerLabel}</span>
        <ChevronDown
          className={`h-3.5 w-3.5 shrink-0 opacity-70 transition ${open ? "rotate-180" : ""}`}
          strokeWidth={2.25}
        />
      </button>

      {open ? (
        <>
          {/* Backdrop swallows clicks outside the panel on touch devices where
              the document-level listener can race the new render. */}
          <div
            className="fixed inset-0 z-[140] cursor-default"
            aria-hidden
            onClick={() => setOpen(false)}
          />
          <div
            ref={panelRef}
            role="listbox"
            aria-label="Carrier"
            className="absolute left-0 right-0 top-[calc(100%+6px)] z-[141] overflow-hidden rounded-xl border shadow-[0_16px_40px_rgba(0,0,0,0.45)]"
            style={{
              borderColor: "var(--scanner-border, #243241)",
              backgroundColor: "var(--scanner-card, #0e1620)",
              color: "var(--scanner-text, #f1f5f9)",
            }}
          >
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
                          setOpen(false);
                          triggerRef.current?.focus();
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
                    setOpen(false);
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
        </>
      ) : null}
    </div>
  );
}

/** Compact label for the identify gate status pill (top-right). */
function identifyGateStatusBadgeLabel(visual: InventoryGateVisualStatus): string {
  switch (visual) {
    case "new":
      return "New";
    case "manual_new":
      return "Off manifest";
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
    label: "Box",
    title: "Step 2: Box",
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

function hasReceivableBoxForItems(
  itemScanPackageId: string | null,
  activeBoxSession: { packageId: string; barcode: string } | null,
): boolean {
  return Boolean(String(itemScanPackageId ?? "").trim()) || Boolean(activeBoxSession?.packageId);
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
          <p className="max-w-md text-[13px] font-medium text-white/70">{this.state.error.message}</p>
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

function stripIdentifyGateOcrEdges(s: string): string {
  let t = s.replace(/\r?\n/g, " ").replace(/\s+/g, " ").trim();
  const stripOnce = (x: string) =>
    x
      .replace(/^[\s:*|#.,;\-–—"'«»()[\]{}<>+=\\/]+/, "")
      .replace(/[\s:*|#.,;\-–—"'«»()[\]{}<>+=\\/]+$/, "");
  let prev = "";
  while (prev !== t) {
    prev = t;
    t = stripOnce(t).trim();
  }
  return t;
}

/**
 * Amazon packing slips: slip / inventory id (e.g. under barcode), FNSKU-style (X00…),
 * ASIN (B0…), and warehouse-style (ZZQ…) tokens. Picks highest-priority longest match, else best OCR line.
 */
const IDENTIFY_GATE_OCR_CODE_PATTERNS: { re: RegExp; tier: number }[] = [
  { re: /\b(SD9Q[A-Z0-9]{4,})\b/gi, tier: 100 },
  { re: /\b(X00[A-Z0-9]{6,})\b/gi, tier: 96 },
  { re: /\b(B0[A-Z0-9]{8})\b/gi, tier: 90 },
  { re: /\b(ZZQ[A-Z0-9]{4,})\b/gi, tier: 84 },
];

function collectIdentifyGateOcrPatternHits(text: string): { text: string; tier: number; alnumLen: number }[] {
  const hits: { text: string; tier: number; alnumLen: number }[] = [];
  const seen = new Set<string>();
  const sources = [text, text.replace(/\s+/g, " ")];
  for (const src of sources) {
    for (const { re, tier } of IDENTIFY_GATE_OCR_CODE_PATTERNS) {
      const r = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
      let m: RegExpExecArray | null;
      while ((m = r.exec(src)) !== null) {
        const cap = (m[1] ?? m[0] ?? "").trim();
        if (!cap) continue;
        const key = cap.toUpperCase();
        if (seen.has(key)) continue;
        seen.add(key);
        const alnumLen = cap.replace(/[^A-Za-z0-9]/g, "").length;
        hits.push({ text: cap, tier, alnumLen });
      }
    }
  }
  return hits;
}

/**
 * Strict: only FNSKU / slip / ASIN-style tokens (X00, B0, ZZQ, SD9Q). Ignores other slip prose.
 * Returns "" if no pattern matched.
 */
function extractStrictIdentifyGateSlipCode(raw: string): string {
  const trimmedRaw = raw.trim();
  const patternHits = collectIdentifyGateOcrPatternHits(trimmedRaw);
  if (!patternHits.length) return "";
  patternHits.sort((a, b) => b.tier - a.tier || b.alnumLen - a.alnumLen || b.text.length - a.text.length);
  return patternHits[0]!.text;
}

const IDENTIFY_GATE_IMAGE_EXT_RE = /\.(jpe?g|png)$/i;

function isAllowedIdentifyGateImageFile(file: File): boolean {
  const t = file.type.toLowerCase();
  if (t === "image/jpeg" || t === "image/jpg" || t === "image/png") return true;
  const n = file.name.trim();
  return n.length > 0 && IDENTIFY_GATE_IMAGE_EXT_RE.test(n);
}

/** Downscale large photos, compress to JPEG, grayscale + contrast — keeps Tesseract responsive on HD uploads. */
async function preprocessIdentifyGatePhotoForOcr(file: File | Blob): Promise<Blob | File> {
  if (typeof createImageBitmap !== "function")
    return file instanceof File ? file : new File([file], "capture.jpg", { type: "image/jpeg" });
  const asFile = file instanceof File ? file : new File([file], "capture.jpg", { type: "image/jpeg" });
  try {
    const bmp = await createImageBitmap(file);
    const w = bmp.width;
    const h = bmp.height;
    const maxEdge = 1680;
    const maxPixels = 2_450_000;
    let scale = Math.min(1, maxEdge / Math.max(w, h, 1));
    let cw = Math.max(1, Math.round(w * scale));
    let ch = Math.max(1, Math.round(h * scale));
    if (cw * ch > maxPixels) {
      const s2 = Math.sqrt(maxPixels / (cw * ch));
      cw = Math.max(1, Math.round(cw * s2));
      ch = Math.max(1, Math.round(ch * s2));
    }
    const canvas = document.createElement("canvas");
    canvas.width = cw;
    canvas.height = ch;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) {
      bmp.close?.();
      return asFile;
    }
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(bmp, 0, 0, cw, ch);
    bmp.close?.();
    const imgData = ctx.getImageData(0, 0, cw, ch);
    const d = imgData.data;
    const contrast = 1.42;
    for (let i = 0; i < d.length; i += 4) {
      const gray = 0.299 * d[i]! + 0.587 * d[i + 1]! + 0.114 * d[i + 2]!;
      let v = (gray - 128) * contrast + 128;
      v = Math.max(0, Math.min(255, v));
      d[i] = v;
      d[i + 1] = v;
      d[i + 2] = v;
    }
    ctx.putImageData(imgData, 0, 0);
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob((b) => resolve(b), "image/jpeg", 0.86),
    );
    return blob ?? asFile;
  } catch {
    return asFile;
  }
}

function identifyGateMatchFieldUiLabel(field: InventoryViewMatchField): string {
  switch (field) {
    case "tracking_number":
      return "Tracking number";
    case "slip_code":
      return "Slip code";
    case "fnsku":
      return "FNSKU";
    case "sku":
      return "SKU";
    default:
      return "Code";
  }
}

function isIdentifyGateOcrAcceptable(confidence: number, cleaned: string): boolean {
  const alnum = cleaned.replace(/[^A-Za-z0-9]/g, "");
  if (alnum.length < 3 || cleaned.length < 3) return false;
  const asinLike = /^B0[A-Z0-9]{8}$/i.test(cleaned);
  const slipIdLike = /^SD9Q[A-Z0-9]{4,}$/i.test(cleaned);
  const fnskuLike = /^X00[A-Z0-9]{6,}$/i.test(cleaned);
  const zzqLike = /^ZZQ[A-Z0-9]{4,}$/i.test(cleaned);
  if (asinLike && confidence >= 12) return true;
  if ((slipIdLike || fnskuLike || zzqLike) && confidence >= 14) return true;
  if (confidence < 16) return false;
  if (confidence < 32 && alnum.length < 10) return false;
  if (confidence < 45 && alnum.length < 6) return false;
  return true;
}

type InspectionCondition = "good" | "damaged" | "expired" | "open_box" | "missing_parts";

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

type IdentifyGateEntity = "pallet" | "package" | "item";
type IdentifyGatePhase = "idle" | "searching" | "matched" | "new";

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
    if (!productName && r.product_name?.trim()) productName = r.product_name.trim();
    if (!carrier && r.carrier?.trim()) carrier = r.carrier.trim();
    if (!slipCode && r.slip_code?.trim()) slipCode = r.slip_code.trim();
    if (productName && carrier && slipCode) break;
  }
  return { productName, carrier, slipCode };
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

type FlowPhase = "scan" | "package_scan" | "items";

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
  cornerColor: string;
  cornerSize?: "sm" | "lg";
  dashedBorder?: boolean;
  /** Thinner corner brackets + softer red sweep. */
  subtleSweep?: boolean;
  /** Cyan glowing brackets via `--scanner-bracket-glow`. */
  bracketGlow?: boolean;
  /** Brief green success pulse on the frame (e.g. item scan saved). */
  successFlash?: boolean;
}) {
  const {
    children,
    minHeight = "168px",
    frameStyle,
    cornerColor,
    cornerSize = "sm",
    dashedBorder = true,
    subtleSweep = false,
    bracketGlow = false,
    successFlash = false,
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
      className={`relative flex flex-col items-center justify-center overflow-hidden rounded-[22px] border shadow-inner ${dashedBorder ? "border-dashed" : ""}`}
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
}) {
  const { label, value, icon: Icon, glow, iconColor, valueColor } = props;
  const g = PALLET_STAT_GLOW[glow];
  return (
    <div
      className="relative overflow-hidden rounded-2xl border px-2 pb-2.5 pt-2.5"
      style={{
        backgroundColor: CARD,
        borderColor: g.tileBorder,
        boxShadow: `${g.tileShadow}, ${g.innerTileGlow}`,
      }}
    >
      <div className="pointer-events-none absolute inset-0 opacity-100" style={{ background: g.veil }} aria-hidden />
      <div className="relative flex min-h-[5.5rem] flex-col items-center justify-center gap-1.5 text-center">
        <div
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border"
          style={{
            backgroundColor: g.iconFill,
            borderColor: g.iconRing,
            boxShadow: g.iconShadow,
          }}
          aria-hidden
        >
          <Icon className="h-[19px] w-[19px]" strokeWidth={2.25} style={{ color: iconColor }} />
        </div>
        <p className="text-[10px] font-semibold uppercase tracking-widest text-slate-500">{label}</p>
        <p className="-mt-0.5 text-lg font-semibold tabular-nums tracking-tight sm:text-xl" style={{ color: valueColor }}>
          {value}
        </p>
      </div>
    </div>
  );
}

function ExpectedInventoryLineRow(props: {
  line: TrackingOperatorLine;
  accent: ExpectedInventoryAccent;
}) {
  const { line, accent } = props;
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
      <div className="min-w-0 flex-1">
        <p className="text-sm font-bold leading-tight tracking-tight text-white">{line.productLabel}</p>
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
      <div className="flex shrink-0 gap-4 text-right">
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
      </div>
    </li>
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
    ? { label: middleOverride.label.trim() || "Box", value: middleOverride.value.trim() }
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
      segments.push({ key: "pkg", label: "Box", value: pkgValue, mono: true, valueColor: TEXT_PRIMARY });
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
      className={`flex max-w-full flex-nowrap items-center gap-x-0.5 overflow-hidden text-[9px] font-bold leading-none tracking-tight ${className ?? ""}`}
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
 */
function ScanProgressDashboard(props: { active: boolean; boxesExpected: number; boxesScanned: number }) {
  const { active, boxesExpected, boxesScanned } = props;
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

  const renderCell = (label: string, value: number, accent: string, border: string, bg: string) => (
    <div
      className="flex min-w-0 flex-col items-stretch justify-center rounded-lg border px-1.5 py-1"
      style={{ borderColor: border, backgroundColor: bg }}
    >
      <p
        className="text-center text-[8.5px] font-bold uppercase tracking-widest leading-tight"
        style={{ color: MUTED_LABEL }}
      >
        {label}
      </p>
      <div className="mt-0.5 flex items-baseline justify-center gap-0.5 leading-none">
        <span
          className="font-mono text-[15px] font-extrabold tabular-nums"
          style={{ color: accent }}
        >
          {value}
        </span>
        <span
          className="text-[8.5px] font-bold uppercase tracking-wider"
          style={{ color: MUTED_LABEL }}
        >
          BOX
        </span>
      </div>
    </div>
  );

  return (
    <div
      className="relative z-[111] shrink-0 border-t px-2 py-1.5 backdrop-blur-md"
      style={{
        borderColor: BORDER,
        backgroundColor: "rgba(11,18,24,0.92)",
      }}
      aria-label="Box receiving progress"
    >
      <div className="grid grid-cols-3 gap-1.5">
        {renderCell(
          "Expected Boxes",
          boxesExpected,
          ACCENT_BLUE,
          "rgba(56,189,248,0.25)",
          "rgba(56,189,248,0.06)",
        )}
        {renderCell(
          "Scanned Boxes",
          boxesScanned,
          SUCCESS,
          "rgba(52,211,153,0.3)",
          "rgba(52,211,153,0.07)",
        )}
        {renderCell(
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
  const physicalBoxCountInputRef = useRef<HTMLInputElement>(null);
  /** Chrome height for fixed Item-phase Active Context bar (`padding-top` under `top: 0`). */
  const scanPageHeaderRef = useRef<HTMLElement>(null);
  const itemsContextBarRef = useRef<HTMLElement>(null);
  const [itemsContextBarInsetPx, setItemsContextBarInsetPx] = useState(0);
  /**
   * Items phase only: padding-top for `<main>` — fixed Active Context sits below the header (same inset as its own padding-top).
   * Must be (fixedBar.offsetHeight − header.offsetHeight) + gap, not full bar height (main already starts below header).
   */
  const [itemsPhaseMainPadPx, setItemsPhaseMainPadPx] = useState(0);
  const modalOpenRef = useRef(false);
  /** After "all completed" dialog confirm: canonical tracking for the next resolve scan. */
  const postCompleteTrackingRef = useRef<string | null>(null);
  /** One Persian prompt per identification search cycle (reset when a new gate search starts). */
  const completedShipmentDialogShownForKeyRef = useRef<string | null>(null);
  const slip2Ref = useRef<HTMLInputElement>(null);
  const cartonPhotoRef = useRef<HTMLInputElement>(null);
  const trackerPhotoRef = useRef<HTMLInputElement>(null);
  const cartonPhotoUrlRef = useRef<string | null>(null);
  const trackerPhotoUrlRef = useRef<string | null>(null);

  const [flowPhase, setFlowPhase] = useState<FlowPhase>("scan");
  const flowPhasePrevRef = useRef<FlowPhase>("scan");
  const [scanLine, setScanLine] = useState("");
  const [manualOpen, setManualOpen] = useState(false);
  const [scanBarcodeHelpOpen, setScanBarcodeHelpOpen] = useState(false);

  const [activePallet, setActivePallet] = useState<{ id: string; pallet_number: string } | null>(null);
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
  const [identifyGatePhase, setIdentifyGatePhase] = useState<IdentifyGatePhase>("idle");
  const [identifyGateError, setIdentifyGateError] = useState<string | null>(null);
  const [identifyGateEnteredCode, setIdentifyGateEnteredCode] = useState("");
  const [identifyGateRows, setIdentifyGateRows] = useState<Record<string, unknown>[]>([]);
  const [identifyGateCanonicalTracking, setIdentifyGateCanonicalTracking] = useState<string | null>(null);
  /** Which column matched the scan on `v_inventory_item_status` (slip “ASIN” column → `fnsku`). */
  const [identifyGateMatchField, setIdentifyGateMatchField] = useState<InventoryViewMatchField | null>(null);
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
  /** User confirmed adding an off-manifest item after full completion — next scan uses `runResolve` with tracking context. */
  const [awaitingPostCompleteExtraScan, setAwaitingPostCompleteExtraScan] = useState(false);

  const [stats, setStats] = useState<{
    totalBoxes: number;
    expectedItems: number;
    scannedItems: number;
    remainingItems: number;
  } | null>(null);

  const [physicalBoxCount, setPhysicalBoxCount] = useState<number | null>(null);
  /**
   * **Edit All**: unlocks Tracking ID + box count + slip fields on pallets that default to read-only.
   * Initial drafts already allow Carrier / Order ID; box + tracking stay read-only until this mode.
   */
  const [editAllMode, setEditAllMode] = useState(false);
  /** Hydrated slip columns indicate pallet already had shipment data in DB. */
  const [palletDbHasShipmentDetails, setPalletDbHasShipmentDetails] = useState(false);
  /** Shown under Active Pallet — resolved from `pallets.created_by` → `profiles.full_name`. */
  const [palletCreatedByLabel, setPalletCreatedByLabel] = useState<string | null>(null);
  /** Bump to re-run pallet row fetch (e.g. same `activePallet.id` after re-search, or post-save). */
  const [palletDocHydrationNonce, setPalletDocHydrationNonce] = useState(0);
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
  const [slipPhoto1Url, setSlipPhoto1Url] = useState<string | null>(null);
  const [slipPhoto2Url, setSlipPhoto2Url] = useState<string | null>(null);
  const slipPhoto1UrlRef = useRef<string | null>(null);
  const slipPhoto2UrlRef = useRef<string | null>(null);

  /** Pallet shipment-slip / pallet-photo / BOL extras (operator-mobile pallet step). */
  const [palletCarrier, setPalletCarrier] = useState("");
  const [palletOrderId, setPalletOrderId] = useState("");
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
  /** Latest pallet id targeted by async hydrate — ignore stale fetch results after switching pallets. */
  const hydrateActivePalletIdRef = useRef<string | null>(null);
  const [slipExtractMissing, setSlipExtractMissing] = useState<{ carrier: boolean; orderId: boolean } | null>(null);
  /** Up to three URLs — `[0]` → `manifest_photo_url`, full array → `photo_evidence.label_urls`. */
  const [shippingLabelPhotoUrls, setShippingLabelPhotoUrls] = useState<string[]>([]);
  /** Up to three URLs — `[0]` → `photo_url`, full array → `photo_evidence.pallet_urls`. */
  const [palletPhotoUrls, setPalletPhotoUrls] = useState<string[]>([]);
  /** Up to three URLs — `[0]` → `bol_photo_url`, full array → `photo_evidence.bol_urls`. */
  const [bolPhotoUrls, setBolPhotoUrls] = useState<string[]>([]);
  const palletPhotoUrlsRef = useRef<string[]>([]);
  const bolPhotoUrlsRef = useRef<string[]>([]);

  useEffect(() => {
    palletCarrierRef.current = palletCarrier;
  }, [palletCarrier]);
  useEffect(() => {
    palletOrderIdRef.current = palletOrderId;
  }, [palletOrderId]);
  useEffect(() => {
    palletPhotoUrlsRef.current = palletPhotoUrls;
  }, [palletPhotoUrls]);
  useEffect(() => {
    bolPhotoUrlsRef.current = bolPhotoUrls;
  }, [bolPhotoUrls]);

  const [cartonPhotoUrl, setCartonPhotoUrl] = useState<string | null>(null);
  const [trackerPhotoUrl, setTrackerPhotoUrl] = useState<string | null>(null);
  const [scannedBoxesSavedCount, setScannedBoxesSavedCount] = useState(0);
  const [activeBoxSession, setActiveBoxSession] = useState<{ barcode: string; packageId: string } | null>(null);
  const [boxIntakeError, setBoxIntakeError] = useState<string | null>(null);
  const [aiSlipReaderPhase, setAiSlipReaderPhase] = useState<"idle" | "reading" | "matched">("idle");
  /** Last packing-slip barcode parse (GPT-Vision OCR preview uses same extraction shapes). */
  const [slipBarcodeExtract, setSlipBarcodeExtract] = useState<SlipExtractResult | null>(null);
  const [slipVisionProcessing, setSlipVisionProcessing] = useState(false);
  const [slipVisionModal, setSlipVisionModal] = useState<{
    extract: SlipVisionExtract;
    suggestedTracking: string | null;
    itemRows: SlipVisionItemRow[];
  } | null>(null);

  /** Carton package receiving item scans (last saved or active locked box). */
  const [itemScanPackageId, setItemScanPackageId] = useState<string | null>(null);
  const [itemScanPackageLabel, setItemScanPackageLabel] = useState<string | null>(null);
  const [expectedPkgDetailRows, setExpectedPkgDetailRows] = useState<Record<string, unknown>[]>([]);
  /** Set when item-phase EP fetch returns zero rows for an active tracking (live DB only). */
  const [itemTrackingExpectationsHint, setItemTrackingExpectationsHint] = useState<string | null>(null);
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
  const [syncErrorToast, setSyncErrorToast] = useState<string | null>(null);

  const [expectedPkgLines, setExpectedPkgLines] = useState<TrackingOperatorLine[]>([]);
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
  const [identifyGatePhotoOcrToast, setIdentifyGatePhotoOcrToast] = useState<string | null>(null);
  const [identifyGateOcrReading, setIdentifyGateOcrReading] = useState(false);
  const [identifyGateOcrProgressPct, setIdentifyGateOcrProgressPct] = useState(0);
  const [identifyGateOcrMenuOpen, setIdentifyGateOcrMenuOpen] = useState(false);
  const [identifyGateOcrDropHighlight, setIdentifyGateOcrDropHighlight] = useState(false);
  const identifyGateCameraCaptureRef = useRef<HTMLInputElement>(null);
  const identifyGateCameraUploadRef = useRef<HTMLInputElement>(null);
  const identifyGateOcrMenuRef = useRef<HTMLDivElement | null>(null);
  const identifyGateOcrBusyRef = useRef(false);
  /** Set after {@link resumeWorkflowFromExistingPalletRow} — used by gate search defined earlier in the file. */
  const resumeFromPalletLookupRef = useRef<
    (row: OperatorPalletTrackingRow, enteredCode: string) => void | Promise<void>
  >(() => {});

  const laserEnabled =
    ((!isIdentified && flowPhase === "scan") ||
      (isIdentified && (flowPhase === "scan" || flowPhase === "package_scan" || flowPhase === "items"))) &&
    !manualOpen &&
    !(flowPhase === "package_scan" && activeBoxSession) &&
    !(flowPhase === "items" && isIdentified && !hasReceivableBoxForItems(itemScanPackageId, activeBoxSession));

  /** Keeps laser wedge wedged: items phase stays focusable during save (busy does not disable input). */
  const scannerDisabled =
    manualOpen ||
    !laserEnabled ||
    (busy && flowPhase !== "items");

  const focusScannerAggressive = useCallback(() => {
    if (manualOpen || !laserEnabled) return;
    if (busy && flowPhase !== "items") return;
    const el = scannerRef.current;
    if (!el) return;
    /** Guard each focus attempt: if the operator is currently typing in another editable
     *  element, abort. Without this, the staggered focus retries (rAF + microtask + 0/32/120ms
     *  timeouts) will yank focus from inputs like the "Other / Not Listed" carrier field,
     *  making them appear locked. */
    const shouldRefocus = () => {
      if (typeof document === "undefined") return true;
      const active = document.activeElement as HTMLElement | null;
      if (!active || active === document.body || active === el) return true;
      const tag = active.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return false;
      if (active.isContentEditable) return false;
      return true;
    };
    const run = () => {
      if (!shouldRefocus()) return;
      try {
        el.focus({ preventScroll: true });
      } catch {
        el.focus();
      }
    };
    run();
    requestAnimationFrame(() => {
      run();
      queueMicrotask(run);
      window.setTimeout(run, 0);
      window.setTimeout(run, 32);
      window.setTimeout(run, 120);
    });
  }, [manualOpen, laserEnabled, busy, flowPhase]);

  const scheduleFocusScanner = useCallback(() => {
    if (modalOpenRef.current || manualOpen || !laserEnabled) return;
    focusScannerAggressive();
  }, [manualOpen, laserEnabled, focusScannerAggressive]);

  useEffect(() => {
    scheduleFocusScanner();
  }, [scheduleFocusScanner, unknownModal, activePallet, directBox, manualOpen, flowPhase]);

  const identifyGateSummary = useMemo(
    () => summarizeExpectedPackageRowsForGate(identifyGateRows),
    [identifyGateRows],
  );

  const identifyGateProductDisplay = useMemo(() => {
    const fromView = identifyGateViewHints?.productName?.trim();
    if (fromView) return fromView;
    return identifyGateSummary.productName;
  }, [identifyGateViewHints?.productName, identifyGateSummary.productName]);

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

  const runIdentificationGateSearch = useCallback(
    async (rawCode: string) => {
      const trimmed = rawCode.trim();
      if (!trimmed) return;
      setIdentifyGateError(null);
      setIdentifyGateEntity(null);
      setIdentifyGatePhysicalBoxStr("");
      setIdentifyGateEnteredCode(trimmed);
      setIdentifyGateRows([]);
      setIdentifyGateCanonicalTracking(null);
      setIdentifyGateMatchField(null);
      setIdentifyGateShipmentLines([]);
      setIdentifyGateInventoryAgg(null);
      setIdentifyGateInventoryVisual(null);
      setIdentifyGateViewHints(null);
      completedShipmentDialogShownForKeyRef.current = null;
      setCompletedShipmentModal(null);
      setAwaitingPostCompleteExtraScan(false);
      setGateTrackingHelpOpen(false);
      setIdentifyGatePhase("searching");
      setBusy(true);
      try {
        if (!isSupabaseConfigured()) {
          if (/^NEW-/i.test(trimmed) || trimmed.length < 3) {
            const emptyAgg = { rowCount: 0, totalExpected: 0, totalScanned: 0 };
            setIdentifyGateInventoryAgg(emptyAgg);
            setIdentifyGateInventoryVisual(resolveInventoryGateVisualStatus([], emptyAgg));
            setIdentifyGateViewHints(null);
            setIdentifyGatePhase("new");
            return;
          }
          const { rows: invRowsDemo, matchedField: mfDemo } = mockVInventoryRowsForScanCode(trimmed);
          setIdentifyGateMatchField(mfDemo);
          const agg = aggregateInventoryStatus(invRowsDemo);
          const vis = resolveInventoryGateVisualStatus(invRowsDemo, agg);
          setIdentifyGateInventoryAgg(agg);
          setIdentifyGateInventoryVisual(vis);
          setIdentifyGateViewHints(pickInventoryViewHints(invRowsDemo));
          if (vis === "manual_new") {
            setIdentifyGatePhase("new");
            setIdentifyGateMatchField(null);
            return;
          }
          const ids = invRowsDemo.map((r) => r.expected_package_id).filter(Boolean);
          const allMock = mockExpectedPackageDetailRows();
          const detailRows = allMock.filter((r) => ids.includes(String((r as { id?: string }).id ?? "")));
          const canonDemo =
            invRowsDemo.map((r) => String(r.tracking_number ?? "").trim()).find(Boolean) ??
            (String(detailRows[0]?.tracking_number ?? "").trim() || trimmed);
          setIdentifyGateRows(detailRows);
          setIdentifyGateCanonicalTracking(canonDemo);
          const lineField: InventoryViewMatchField = mfDemo ?? "tracking_number";
          const lineValue =
            mfDemo === "slip_code" || mfDemo === "fnsku" || mfDemo === "sku" ? trimmed : canonDemo;
          setIdentifyGateShipmentLines(mockVInventoryItemStatusLinesForExact(lineField, lineValue));
          setIdentifyGateEntity("package");
          setIdentifyGatePhase("matched");
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
          return;
        }

        let gateMatchField: InventoryViewMatchField | null = null;
        let invRows: VInventoryStatusRow[] = [];
        try {
          const res = await fetchVInventoryStatusForScanCode(supabase, orgId, sessionStoreId, trimmed);
          invRows = res.rows;
          gateMatchField = res.matchedField;
        } catch (err) {
          console.warn("v_inventory_item_status unavailable; falling back to expected_packages only.", err);
          invRows = [];
        }

        if (!invRows.length) {
          const epFallback = await fetchExpectedPackageDetailRowsForParent(supabase, orgId, sessionStoreId, {
            trackingNumber: trimmed,
            palletId: null,
          });
          const safeEp = Array.isArray(epFallback) ? epFallback : [];
          const exactEp = safeEp.filter((r) =>
            trackingKeysEqual((r as { tracking_number?: string | null }).tracking_number, trimmed),
          );
          if (exactEp.length) {
            gateMatchField = "tracking_number";
            invRows = exactEp.map((r) => ({
              expected_package_id: String((r as { id?: string }).id ?? ""),
              organization_id: orgId,
              store_id: sessionStoreId,
              tracking_number:
                (r as { tracking_number?: string | null }).tracking_number != null
                  ? String((r as { tracking_number?: string | null }).tracking_number)
                  : null,
              slip_code:
                (r as { slip_code?: string | null }).slip_code != null
                  ? String((r as { slip_code?: string | null }).slip_code)
                  : null,
              sku: (r as { sku?: string | null }).sku != null ? String((r as { sku?: string | null }).sku) : null,
              fnsku: (r as { fnsku?: string | null }).fnsku != null ? String((r as { fnsku?: string | null }).fnsku) : null,
              asin: (r as { asin?: string | null }).asin != null ? String((r as { asin?: string | null }).asin) : null,
              order_id:
                (r as { order_id?: string | null }).order_id != null
                  ? String((r as { order_id?: string | null }).order_id)
                  : null,
              status: null,
              product_name: null,
              carrier: null,
              total_expected: Number((r as { expected_scan_quantity?: number }).expected_scan_quantity ?? 0) || 0,
              total_scanned: Number((r as { actual_scanned_count?: number }).actual_scanned_count ?? 0) || 0,
            }));
          }
        }

        setIdentifyGateMatchField(gateMatchField);

        const agg = aggregateInventoryStatus(invRows);
        const vis = resolveInventoryGateVisualStatus(invRows, agg);
        setIdentifyGateInventoryAgg(agg);
        setIdentifyGateInventoryVisual(vis);
        setIdentifyGateViewHints(pickInventoryViewHints(invRows));

        if (vis === "manual_new") {
          if (isSupabaseConfigured()) {
            const dupRes = await findOperatorPalletByTrackingNumberAction(orgId, trimmed);
            if (!dupRes.ok) {
              setIdentifyGateError(dupRes.error);
              setIdentifyGatePhase("idle");
              return;
            }
            if (dupRes.pallet) {
              setIntakeToast("This Tracking Number already exists. Loading details...");
              resumeFromPalletLookupRef.current(dupRes.pallet, trimmed);
              playOperatorSuccessBeep();
              setIdentifyGateGlowFlash(true);
              return;
            }
          }
          setIdentifyGateError(null);
          setIdentifyGatePhase("new");
          setIdentifyGateRows([]);
          setIdentifyGateCanonicalTracking(trimmed);
          setIdentifyGateShipmentLines([]);
          setIdentifyGateMatchField(null);
          return;
        }

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
            trackingNumber: trimmed,
            palletId: null,
          });
        }
        const safe = Array.isArray(detailRows) ? detailRows : [];
        setIdentifyGateRows(safe);
        const canon =
          invRows.map((r) => String(r.tracking_number ?? "").trim()).find(Boolean) ??
          (String(safe[0]?.tracking_number ?? "").trim() || trimmed);
        setIdentifyGateCanonicalTracking(canon);

        let shipmentLines: VInventoryStatusRow[] = [];
        if (sessionStoreId && gateMatchField) {
          const lineValue =
            gateMatchField === "slip_code" || gateMatchField === "fnsku" || gateMatchField === "sku"
              ? trimmed
              : canon || trimmed;
          try {
            const { rows } = await fetchVInventoryItemStatusLinesExact(
              supabase,
              orgId,
              sessionStoreId,
              gateMatchField,
              lineValue,
            );
            shipmentLines = rows;
          } catch (err) {
            console.warn("fetchVInventoryItemStatusLinesExact failed", err);
          }
        }
        setIdentifyGateShipmentLines(shipmentLines);
        if (invRows.length) setIdentifyGateEntity("package");
        setIdentifyGatePhase("matched");
        playOperatorSuccessBeep();
        setIdentifyGateGlowFlash(true);
      } catch (e) {
        console.error(e);
        setIdentifyGateError(e instanceof Error ? e.message : "Lookup failed.");
        setIdentifyGatePhase("idle");
        setIdentifyGateInventoryAgg(null);
        setIdentifyGateInventoryVisual(null);
        setIdentifyGateViewHints(null);
        setIdentifyGateShipmentLines([]);
        setIdentifyGateMatchField(null);
      } finally {
        setBusy(false);
        scheduleFocusScanner();
      }
    },
    [orgId, sessionStoreId, kioskStoreLocked, operatorStores.length, scheduleFocusScanner],
  );

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

  const revokeSlip = useCallback((which: 1 | 2) => {
    const ref = which === 1 ? slipPhoto1UrlRef : slipPhoto2UrlRef;
    if (ref.current) {
      URL.revokeObjectURL(ref.current);
      ref.current = null;
    }
    if (which === 1) setSlipPhoto1Url(null);
    else setSlipPhoto2Url(null);
  }, []);

  useEffect(() => {
    return () => {
      if (slipPhoto1UrlRef.current) URL.revokeObjectURL(slipPhoto1UrlRef.current);
      if (slipPhoto2UrlRef.current) URL.revokeObjectURL(slipPhoto2UrlRef.current);
    };
  }, []);

  useEffect(() => {
    return () => {
      if (cartonPhotoUrlRef.current) URL.revokeObjectURL(cartonPhotoUrlRef.current);
      if (trackerPhotoUrlRef.current) URL.revokeObjectURL(trackerPhotoUrlRef.current);
    };
  }, []);

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
    const { data: pkgs, error } = await supabase
      .from("packages")
      .select("expected_item_count, actual_item_count")
      .eq("pallet_id", palletId)
      .is("deleted_at", null);
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
  }, []);

  useEffect(() => {
    if (activePallet?.id) void loadPalletDetail(activePallet.id);
    else {
      setStats(null);
    }
  }, [activePallet?.id, loadPalletDetail]);

  useEffect(() => {
    setEditAllMode(false);
  }, [activePallet?.id]);

  /** Hydrate carrier / order_id / shipment-slip / pallet / BOL photo URLs from the active pallet row. */
  useEffect(() => {
    const palletId = activePallet?.id;
    if (!palletId || !isUuidString(palletId) || !isSupabaseConfigured()) {
      hydrateActivePalletIdRef.current = null;
      setPalletDbHasShipmentDetails(false);
      setPalletCreatedByLabel(null);
      setPalletCarrier("");
      setPalletCarrierOtherSelected(false);
      setPalletOrderId("");
      setCurrentPalletTrackingId(null);
      setShippingLabelPhotoUrls([]);
      setPalletPhotoUrls([]);
      setBolPhotoUrls([]);
      setSlipExtractMissing(null);
      return;
    }
    hydrateActivePalletIdRef.current = palletId;
    const fetchingFor = palletId;
    let cancelled = false;
    (async () => {
      const PALLET_DOC_SELECT =
        "carrier_name, order_id, manifest_photo_url, photo_url, bol_photo_url, created_by, photo_evidence";
      const { data, error } = await supabase.from("pallets").select(PALLET_DOC_SELECT).eq("id", palletId).maybeSingle();
      if (cancelled) return;
      if (hydrateActivePalletIdRef.current !== fetchingFor) return;
      if (error) {
        console.warn("[pallets] hydrate failed:", error.code ?? "", error.message, { palletId });
        setPalletDbHasShipmentDetails(false);
        setPalletCreatedByLabel(null);
        return;
      }
      if (!data && process.env.NODE_ENV === "development") {
        console.debug("[operator] pallet hydrate: no row returned (missing id or RLS?)", { palletId });
      }
      const row = (data ?? {}) as {
        carrier_name?: string | null;
        order_id?: string | null;
        manifest_photo_url?: string | null;
        photo_url?: string | null;
        bol_photo_url?: string | null;
        created_by?: string | null;
        photo_evidence?: unknown;
      };
      const cid = (row.created_by ?? "").trim();
      if (cid && isUuidString(cid)) {
        const { data: auth } = await supabase.auth.getUser();
        const me = auth?.user?.id?.trim();
        const { data: prof } = await supabase.from("profiles").select("full_name").eq("id", cid).maybeSingle();
        const fn = (prof as { full_name?: string | null } | null)?.full_name?.trim();
        const emailFallback =
          me === cid ? (typeof auth?.user?.email === "string" ? auth.user.email.trim() : "") : "";
        setPalletCreatedByLabel(fn || emailFallback || "Unknown");
      } else {
        setPalletCreatedByLabel(null);
      }
      const raw = (row.carrier_name ?? "").trim();
      if (!raw) {
        setPalletCarrier("");
        setPalletCarrierOtherSelected(false);
      } else {
        const normalized = normalizeCarrierLabel(raw);
        if (normalized && normalized !== OTHER_CARRIER_NAME) {
          setPalletCarrier(normalized);
          setPalletCarrierOtherSelected(false);
        } else {
          setPalletCarrier(raw);
          setPalletCarrierOtherSelected(true);
        }
      }
      setPalletOrderId((prev) => (prev.trim() ? prev : (row.order_id ?? "").trim()));
      // Do not hydrate `currentPalletTrackingId` from DB during the session — gate / operator edits own it.
      const hydrated = hydrateOperatorPalletDocumentationPhotoUrls(row, supabase);
      if (process.env.NODE_ENV === "development") {
        console.debug("[operator] pallet documentation hydrate", {
          palletId: fetchingFor,
          rawManifest: row.manifest_photo_url ?? null,
          rawPhotoUrl: row.photo_url ?? null,
          rawBol: row.bol_photo_url ?? null,
          hydrated,
        });
      }
      setShippingLabelPhotoUrls(hydrated.shippingLabel);
      setPalletPhotoUrls(hydrated.pallet);
      setBolPhotoUrls(hydrated.bol);
      const persistedSlip =
        Boolean((row.carrier_name ?? "").trim()) ||
        Boolean((row.order_id ?? "").trim()) ||
        Boolean((row.manifest_photo_url ?? "").trim());
      setPalletDbHasShipmentDetails(persistedSlip);
    })();
    return () => {
      cancelled = true;
    };
  }, [activePallet?.id, orgId, palletDocHydrationNonce]);

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
    if (flowPhase !== "package_scan") {
      setAiSlipReaderPhase("idle");
      return;
    }
    const pages = (slipPhoto1Url ? 1 : 0) + (slipPhoto2Url ? 1 : 0);
    const hasBarcodeSlip = slipBarcodeExtract !== null;
    if (pages === 0 && !hasBarcodeSlip) {
      setAiSlipReaderPhase("idle");
      return;
    }
    setAiSlipReaderPhase("reading");
    const delayMs = hasBarcodeSlip ? 650 : 2200;
    const t = window.setTimeout(() => setAiSlipReaderPhase("matched"), delayMs);
    return () => window.clearTimeout(t);
  }, [flowPhase, slipPhoto1Url, slipPhoto2Url, slipBarcodeExtract]);

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
    if (!identifyGateOcrMenuOpen) return;
    const onDown = (e: MouseEvent | TouchEvent) => {
      const node = identifyGateOcrMenuRef.current;
      const t = e.target as Node | null;
      if (node && t && !node.contains(t)) setIdentifyGateOcrMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setIdentifyGateOcrMenuOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("touchstart", onDown, { passive: true });
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("touchstart", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [identifyGateOcrMenuOpen]);

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
      setItemTrackingExpectationsHint(null);
      return;
    }
    let cancelled = false;
    setItemTrackingExpectationsHint(null);
    void (async () => {
      try {
        if (!isSupabaseConfigured()) {
          if (!cancelled) {
            const mock = mockExpectedPackageDetailRows();
            const safe = mock ?? [];
            setExpectedPkgDetailRows(Array.isArray(safe) ? safe : []);
            setItemTrackingExpectationsHint(null);
          }
          return;
        }
        if (!sessionStoreId) {
          if (!cancelled) {
            setExpectedPkgDetailRows([]);
            setItemTrackingExpectationsHint(null);
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
        if (parentTn && safe.length === 0) {
          setItemTrackingExpectationsHint(
            "No items found for this Tracking. Please check Store ID and Org ID.",
          );
        } else {
          setItemTrackingExpectationsHint(null);
        }
      } catch (e) {
        console.error(e);
        if (!cancelled) {
          setExpectedPkgDetailRows([]);
          setItemTrackingExpectationsHint(null);
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
        .select("package_number, expected_item_count, actual_item_count")
        .eq("id", itemScanPackageId)
        .maybeSingle();
      if (cancelled || error) return;
      const row = data as { package_number?: string | null } | null;
      const pn = row?.package_number?.trim();
      if (pn) setItemScanPackageLabel(pn);
    })();
    return () => {
      cancelled = true;
    };
  }, [flowPhase, itemScanPackageId]);

  const applyResult = useCallback((r: OperatorResolveResult) => {
    setActiveSlipOrPackage(null);
    setActiveTracking(null);
    setCurrentPalletTrackingId(null);
    if (r.kind === "pallet") {
      const id = String(r.row.id ?? "");
      const num = String(r.row.pallet_number ?? "");
      if (id && num) {
        setActivePallet({ id, pallet_number: num });
        // `currentPalletTrackingId` is set by the caller with the operator's scanned/typed code
        // (identify gate or runResolve) so Active Pallet edit shows that value, not only DB row.
        setDirectBox(false);
        setFlowPhase("scan");
      }
      return;
    }
    setActivePallet(null);
    if (r.kind === "tracking") {
      setActiveTracking(String(r.row.tracking_number ?? "").trim());
      setFlowPhase("scan");
      return;
    }
    if (r.kind === "package") {
      setActiveSlipOrPackage(`Box ${String(r.row.package_number ?? r.row.tracking_number ?? "")}`);
      return;
    }
    if (r.kind === "slip") {
      setActiveSlipOrPackage(`Slip ${String(r.row.rma_number ?? "")}`);
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
    const code = raw.trim();
    setScanLine(code);
    router.replace(pathname, { scroll: false });
    queueMicrotask(() => {
      void runIdentificationGateSearchRef.current(code);
    });
  }, [searchParams, pathname, router]);

  const resolveSlipEpContext = useCallback(
    async (extract: SlipVisionExtract): Promise<{ tracking: string | null; rows: Record<string, unknown>[] }> => {
      const slipParentTn = activePallet?.id ? currentPalletTrackingId : activeTracking;
      const uniq = slipIdLookupCandidates(extract.shipment_id, extract.vret_id, slipParentTn);

      if (!isSupabaseConfigured()) {
        for (const c of uniq) {
          const snap = mockTrackingExpectationSnapshot(c);
          if (snap.rawRowCount > 0) {
            const rows: Record<string, unknown>[] = snap.lines.map((l) => ({
              sku: l.sku,
              fnsku: l.fnsku,
              asin: "",
              product_asin: "",
              expected_scan_quantity: l.expectedQty,
              tracking_number: c,
            }));
            return { tracking: c, rows };
          }
        }
        return { tracking: null, rows: [] };
      }

      if (!sessionStoreId) return { tracking: null, rows: [] };

      for (const c of uniq) {
        const rows = await fetchExpectedPackagesForTracking(supabase, orgId, sessionStoreId, c, EP_DETAIL_SELECT);
        if (rows.length > 0) {
          const tn = String(rows[0]?.tracking_number ?? "").trim() || c;
          return { tracking: tn, rows };
        }
      }
      return { tracking: null, rows: [] };
    },
    [activePallet?.id, activeTracking, currentPalletTrackingId, orgId, sessionStoreId],
  );

  const runSlipVisionOcr = useCallback(
    async (file: File) => {
      setSlipVisionProcessing(true);
      try {
        const apiKey = getAIUnifiedKeyFromStorage() || getOpenAIApiKeyFromStorage();
        if (!apiKey) {
          setSyncErrorToast("Add an OpenAI API key in Settings to read slip photos with GPT-4o Vision.");
          return;
        }
        const buf = await file.arrayBuffer();
        const bytes = new Uint8Array(buf);
        let binary = "";
        for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]!);
        const imageBase64 = btoa(binary);
        const mimeType = file.type || "image/jpeg";

        const res = await fetch("/api/scanner/extract-slip", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({ imageBase64, mimeType, organizationId: orgId }),
        });

        const json = (await res.json()) as { error?: string; slip?: SlipVisionExtract };
        if (!res.ok) {
          throw new Error(json.error ?? `Slip OCR failed (${res.status})`);
        }
        if (!json.slip) throw new Error("Invalid slip OCR response.");

        const { tracking, rows } = await resolveSlipEpContext(json.slip);
        const itemRows = attachMatchStatusToSlipItems(json.slip.items, rows);
        setSlipVisionModal({ extract: json.slip, suggestedTracking: tracking, itemRows });
        modalOpenRef.current = true;

        const carrierFromSlip = json.slip.carrier?.trim() ?? "";
        const normalizedCarrier = normalizeCarrierLabel(carrierFromSlip);
        const orderIdFromSlip = json.slip.amazon_order_id?.trim() ?? "";
        if (carrierFromSlip && !palletCarrierRef.current.trim()) {
          // Prefer the canonical carrier name when OCR text matches a known carrier;
          // otherwise keep the raw OCR string so the operator sees what was on the slip
          // and the "Other / Not Listed" manual entry surfaces with that prefilled value.
          const matchedKnownCarrier =
            normalizedCarrier !== null && normalizedCarrier !== OTHER_CARRIER_NAME;
          const carrierToPersist = matchedKnownCarrier ? normalizedCarrier! : carrierFromSlip;
          palletCarrierRef.current = carrierToPersist;
          setPalletCarrier(carrierToPersist);
          setPalletCarrierOtherSelected(!matchedKnownCarrier);
        }
        if (orderIdFromSlip && !palletOrderIdRef.current.trim()) {
          palletOrderIdRef.current = orderIdFromSlip;
          setPalletOrderId(orderIdFromSlip);
        }
        setSlipExtractMissing({
          carrier: !carrierFromSlip,
          orderId: !orderIdFromSlip,
        });
      } catch (e) {
        setSyncErrorToast(e instanceof Error ? e.message : "Slip OCR failed.");
      } finally {
        setSlipVisionProcessing(false);
        scheduleFocusScanner();
      }
    },
    [activePallet?.id, orgId, resolveSlipEpContext, scheduleFocusScanner],
  );

  const handlePalletPhotoUrlsChange = useCallback((urls: string[]) => {
    setPalletPhotoUrls(urls);
  }, []);

  const handleBolPhotoUrlsChange = useCallback((urls: string[]) => {
    setBolPhotoUrls(urls);
  }, []);

  const handleShippingLabelPhotoUrlsChange = useCallback((urls: string[]) => {
    setShippingLabelPhotoUrls(urls);
  }, []);

  const runManualSlipVisionFromCapture = useCallback(async () => {
    if (!slipPhoto1Url) {
      setSyncErrorToast("Capture Slip Photo 1 first.");
      return;
    }
    const blob = await fetchBlobFromObjectUrl(slipPhoto1Url);
    if (!blob?.type.startsWith("image/")) {
      setSyncErrorToast("Slip Photo 1 is not a readable image.");
      return;
    }
    const file = new File([blob], "slip-capture-manual.jpg", { type: blob.type });
    await runSlipVisionOcr(file);
  }, [slipPhoto1Url, runSlipVisionOcr]);

  const handleBoxIntakeScan = useCallback(
    async (code: string) => {
      const trimmed = code.trim();
      setBoxIntakeError(null);
      if (!trimmed) return;
      if (activeBoxSession) {
        setBoxIntakeError("Save the current box before scanning another barcode.");
        return;
      }

      const parentTrackingKey = (currentPalletTrackingId ?? "").trim();
      if (parentTrackingKey && trackingKeysEqual(trimmed, parentTrackingKey)) {
        setBoxIntakeError(
          "That code matches this shipment’s tracking ID — scan the barcode on the carton, not the pallet/shipment id.",
        );
        scheduleFocusScanner();
        return;
      }
      const palletNumKey = activePallet?.pallet_number?.trim() ?? "";
      if (palletNumKey && trackingKeysEqual(trimmed, palletNumKey)) {
        setBoxIntakeError("That code matches the pallet id — scan a distinct box barcode.");
        scheduleFocusScanner();
        return;
      }

      if (looksLikePackingSlipScan(trimmed)) {
        setBoxIntakeError(
          "That looks like a slip or shipment code — scan the physical box barcode on the carton instead.",
        );
        scheduleFocusScanner();
        return;
      }

      setBusy(true);
      try {
        if (!isSupabaseConfigured()) {
          setActiveBoxSession({ barcode: trimmed, packageId: `demo-${Date.now()}` });
          setCurrentPackageTrackingId(trimmed);
          const tnHit = expectedPkgTrackingNumbers.some((t) => trackingKeysEqual(t, trimmed));
          if (tnHit) setIntakeToast("Tracking matched to box");
          playOperatorSuccessBeep();
          setScanSuccessFlash(true);
          return;
        }
        if (!sessionStoreId) {
          setBoxIntakeError("Configure a store before recording boxes.");
          return;
        }
        const auditFields = await resolveOperatorAuditFieldsClient(supabase);
        const res = await insertIntakeBoxPackage(supabase, {
          organizationId: orgId,
          palletId: activePallet?.id ?? null,
          packageNumber: trimmed,
          created_by: auditFields.created_by,
        });
        if (!res.ok) {
          setBoxIntakeError(res.message);
          return;
        }
        setActiveBoxSession({ barcode: trimmed, packageId: res.packageId });
        setCurrentPackageTrackingId(trimmed);
        const tnHit = expectedPkgTrackingNumbers.some((t) => trackingKeysEqual(t, trimmed));
        if (tnHit) setIntakeToast("Tracking matched to box");
        if (activePallet?.id) void loadPalletDetail(activePallet.id);
        playOperatorSuccessBeep();
        setScanSuccessFlash(true);
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
      loadPalletDetail,
      scheduleFocusScanner,
    ],
  );

  const confirmSlipVisionModal = useCallback(() => {
    if (!slipVisionModal) return;
    const { extract, suggestedTracking } = slipVisionModal;
    const trackingToActivate =
      suggestedTracking?.trim() ||
      extract.shipment_id?.trim() ||
      extract.vret_id?.trim() ||
      "";
    if (trackingToActivate) {
      if (activePallet?.id) setCurrentPalletTrackingId(trackingToActivate);
      else setActiveTracking(trackingToActivate);
    }
    setSlipBarcodeExtract({
      vretId: extract.vret_id,
      shipmentId: extract.shipment_id,
    });
    setSlipVisionModal(null);
    modalOpenRef.current = false;
    setIntakeToast("Slip confirmed — shipment context applied for receiving.");
    scheduleFocusScanner();
  }, [slipVisionModal, scheduleFocusScanner, activePallet?.id]);

  const dismissSlipVisionModal = useCallback(() => {
    setSlipVisionModal(null);
    modalOpenRef.current = false;
    scheduleFocusScanner();
  }, [scheduleFocusScanner]);

  const saveBoxAndContinue = useCallback(() => {
    if (!activeBoxSession) return;
    setItemScanPackageId(activeBoxSession.packageId);
    setItemScanPackageLabel(activeBoxSession.barcode);
    setScannedBoxesSavedCount((n) => n + 1);
    setActiveBoxSession(null);
    setCurrentPackageTrackingId(null);
    setBoxIntakeError(null);
    if (cartonPhotoUrlRef.current) {
      URL.revokeObjectURL(cartonPhotoUrlRef.current);
      cartonPhotoUrlRef.current = null;
    }
    if (trackerPhotoUrlRef.current) {
      URL.revokeObjectURL(trackerPhotoUrlRef.current);
      trackerPhotoUrlRef.current = null;
    }
    setCartonPhotoUrl(null);
    setTrackerPhotoUrl(null);
    if (activePallet?.id) void loadPalletDetail(activePallet.id);
    setFlowPhase("items");
    scheduleFocusScanner();
  }, [activeBoxSession, activePallet?.id, loadPalletDetail, scheduleFocusScanner]);

  const populateDraftFromEpRow = useCallback(
    async (barcode: string, tier: ItemResolveTier, row: Record<string, unknown>) => {
      const sku = String(row.sku ?? "").trim();
      const fnsku = String(row.fnsku ?? "").trim();
      const line = expectedPkgLines.find((l) => l.sku === sku && l.fnsku === fnsku);
      let catalogName: string | null = null;
      let catalogImageUrl: string | null = null;
      let expirationSupported = false;
      if (isSupabaseConfigured()) {
        const bc = barcode.trim();
        const { data } = await supabase.from("products").select("*").eq("barcode", bc).maybeSingle();
        const pr = data as Record<string, unknown> | null;
        if (pr) {
          catalogName = String(pr.name ?? "").trim() || null;
          catalogImageUrl = typeof pr.image_url === "string" ? pr.image_url : null;
          expirationSupported = Boolean(pr.expiration_supported);
        }
      }

      const productNameMatched =
        catalogName?.trim() && line?.productLabel?.trim()
          ? catalogName.trim() === line.productLabel.trim()
          : null;

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

  const handleItemBarcodeScan = useCallback(
    async (code: string) => {
      if (busy) return;
      if (!hasReceivableBoxForItems(itemScanPackageId, activeBoxSession)) {
        setItemReceiveError("Select or scan a box before inspecting items.");
        return;
      }
      const trimmed = code.trim();
      setItemReceiveError(null);
      setItemBarcodeMiss(null);
      if (!trimmed) return;
      const detailSafe = Array.isArray(expectedPkgDetailRows) ? expectedPkgDetailRows : [];
      if (!detailSafe.length) {
        setItemBarcodeMiss("No expected lines loaded for this parent.");
        return;
      }
      const outcome = resolveItemBarcodeAgainstExpectedRows(trimmed, detailSafe);
      if (outcome.kind === "none") {
        setItemBarcodeMiss(`No expected match for "${trimmed}".`);
        return;
      }
      if (outcome.kind === "ambiguous") {
        modalOpenRef.current = true;
        setCandidatePicker({ barcode: outcome.barcode, tier: outcome.tier, candidates: outcome.candidates });
        return;
      }
      await populateDraftFromEpRow(outcome.barcode, outcome.tier, outcome.row);
      scheduleFocusScanner();
    },
    [
      busy,
      itemScanPackageId,
      activeBoxSession,
      expectedPkgDetailRows,
      populateDraftFromEpRow,
      scheduleFocusScanner,
    ],
  );

  const beginItemPhase = useCallback(() => {
    if (!hasReceivableBoxForItems(itemScanPackageId, activeBoxSession)) {
      setBoxIntakeError("Select or scan a box before inspecting items.");
      return;
    }
    if (activeBoxSession?.packageId) {
      setItemScanPackageId(activeBoxSession.packageId);
      setItemScanPackageLabel(activeBoxSession.barcode);
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
    resetItemInspectionForm,
    focusScannerAggressive,
  ]);

  const resetIdentifyGateForm = useCallback(() => {
    setIdentifyGatePhase("idle");
    setIdentifyGateError(null);
    setIdentifyGateEnteredCode("");
    setIdentifyGateRows([]);
    setIdentifyGateCanonicalTracking(null);
    setIdentifyGateShipmentLines([]);
    setIdentifyGateMatchField(null);
    setIdentifyGateEntity(null);
    setIdentifyGatePhysicalBoxStr("");
    setIdentifyGateInventoryAgg(null);
    setIdentifyGateInventoryVisual(null);
    setIdentifyGateViewHints(null);
    setAwaitingPostCompleteExtraScan(false);
    setCompletedShipmentModal(null);
    setGateTrackingHelpOpen(false);
    setScanLine("");
  }, []);

  const resumeWorkflowFromExistingPalletRow = useCallback(
    async (row: OperatorPalletTrackingRow, enteredCode: string) => {
      const tracking = String(row.tracking_number ?? "").trim() || enteredCode.trim();
      const opCount = row.operator_package_count;
      resetIdentifyGateForm();
      setActiveSlipOrPackage(null);
      setDirectBox(false);
      setActiveTracking(null);
      setActivePallet({ id: row.id, pallet_number: row.pallet_number });
      setCurrentPalletTrackingId(tracking);
      if (typeof opCount === "number" && Number.isFinite(opCount) && opCount > 0) {
        setPhysicalBoxCount(opCount);
        setBoxScanTargetDenominator(opCount);
      } else {
        setPhysicalBoxCount(null);
        setBoxScanTargetDenominator(null);
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
        } catch {
          setPalletCreatedByLabel("Unknown");
        }
      } else {
        setPalletCreatedByLabel(null);
      }
      const hasShip = palletHasPersistedShipmentDetails(row);
      setFlowPhase(hasShip ? "package_scan" : "scan");
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
      setPalletDocHydrationNonce((n) => n + 1);
    },
    [orgId, resetIdentifyGateForm],
  );

  resumeFromPalletLookupRef.current = resumeWorkflowFromExistingPalletRow;

  const runIdentifyGatePhotoOcr = useCallback(async (file: File) => {
    if (identifyGateOcrBusyRef.current) return;
    if (!isAllowedIdentifyGateImageFile(file)) {
      setIdentifyGatePhotoOcrToast("Please use a JPG or PNG image.");
      return;
    }
    identifyGateOcrBusyRef.current = true;
    setIdentifyGateOcrReading(true);
    setIdentifyGateOcrProgressPct(0);
    try {
      const { createWorker, PSM } = await import("tesseract.js");
      const worker = await createWorker("eng", undefined, {
        logger: (m: { progress?: number }) => {
          if (typeof m.progress === "number" && Number.isFinite(m.progress)) {
            const pct = Math.round(Math.min(100, Math.max(0, m.progress * 100)));
            setIdentifyGateOcrProgressPct(pct);
          }
        },
      });
      try {
        await worker.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_BLOCK });
        setIdentifyGateOcrProgressPct((p) => Math.max(p, 2));
        const ocrSource = await preprocessIdentifyGatePhotoForOcr(file);
        setIdentifyGateOcrProgressPct((p) => Math.max(p, 6));
        const { data } = await worker.recognize(ocrSource);
        setIdentifyGateOcrProgressPct(100);
        const raw = String(data.text ?? "");
        const picked = extractStrictIdentifyGateSlipCode(raw);
        const cleaned = stripIdentifyGateOcrEdges(picked);
        if (!cleaned.trim()) {
          setIdentifyGatePhotoOcrToast("Could not read text clearly. Please try manual entry.");
          return;
        }
        const conf = typeof data.confidence === "number" ? data.confidence : 0;
        if (!isIdentifyGateOcrAcceptable(conf, cleaned)) {
          setIdentifyGatePhotoOcrToast("Could not read text clearly. Please try manual entry.");
          return;
        }
        setScanLine(cleaned);
      } finally {
        await worker.terminate();
      }
    } catch (err) {
      console.warn("Identify gate photo OCR failed", err);
      setIdentifyGatePhotoOcrToast("Could not read text clearly. Please try manual entry.");
    } finally {
      identifyGateOcrBusyRef.current = false;
      setIdentifyGateOcrReading(false);
      setIdentifyGateOcrProgressPct(0);
    }
  }, []);

  const onIdentifyGateOcrFileInputChange = useCallback(
    async (e: ChangeEvent<HTMLInputElement>) => {
      const input = e.currentTarget;
      const file = input.files?.[0];
      input.value = "";
      if (file) await runIdentifyGatePhotoOcr(file);
    },
    [runIdentifyGatePhotoOcr],
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
      const f = e.dataTransfer.files?.[0];
      if (f) await runIdentifyGatePhotoOcr(f);
    },
    [runIdentifyGatePhotoOcr],
  );

  const onSubmitScan = useCallback(
    async (e?: FormEvent) => {
      e?.preventDefault();
      const packageScanBoxBufferOpen = flowPhase === "package_scan" && !activeBoxSession;
      let code = "";
      if (packageScanBoxBufferOpen) {
        code = (currentPackageTrackingId ?? "").trim();
        setCurrentPackageTrackingId(null);
      } else {
        code = scanLine.trim();
        setScanLine("");
      }
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
      if (flowPhase === "package_scan") {
        await handleBoxIntakeScan(code);
        return;
      }
      if (flowPhase === "items") {
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
      scanLine,
      currentPackageTrackingId,
      activeBoxSession,
      flowPhase,
      isIdentified,
      awaitingPostCompleteExtraScan,
      handleBoxIntakeScan,
      handleItemBarcodeScan,
      runIdentificationGateSearch,
      runResolve,
      resetIdentifyGateForm,
    ],
  );

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

  const handleCreateUnknownPackage = useCallback(async () => {
    if (!unknownModal || !isSupabaseConfigured()) return;
    const code = unknownModal.code.trim();
    if (!code) return;
    if (!sessionStoreId) return;
    setBusy(true);
    try {
      const auditFields = await resolveOperatorAuditFieldsClient(supabase);
      const res = await insertUnknownPackageForTrackingCode(supabase, {
        organizationId: orgId,
        storeId: sessionStoreId,
        scannedCode: code,
        created_by: auditFields.created_by,
      });
      if (!res.ok) {
        console.error(res.message);
        return;
      }
      modalOpenRef.current = false;
      setUnknownModal(null);
      setActivePallet(null);
      setActiveSlipOrPackage(null);
      setActiveTracking(code);
      setDirectBox(false);
      setFlowPhase("scan");
      scheduleFocusScanner();
    } finally {
      setBusy(false);
    }
  }, [unknownModal, sessionStoreId, orgId, scheduleFocusScanner]);

  /**
   * Resolve or create the receiving pallet row for a tracking number (used by the
   * identification gate and by Save & Start when only tracking context exists).
   */
  const ensureReceivingPalletForTracking = useCallback(
    async (
      tn: string,
      orderId: string | null,
    ): Promise<{ id: string; pallet_number: string; created: boolean } | null> => {
      if (!isSupabaseConfigured() || !sessionStoreId) return null;
      const tracking = tn.trim();
      if (!tracking) return null;
      const oid = orderId?.trim() || null;

      const hitTn = await findPalletByTrackingNormalized(supabase, orgId, tracking);
      if (hitTn?.id) {
        return {
          id: hitTn.id,
          pallet_number: hitTn.pallet_number,
          created: false,
        };
      }
      if (oid) {
        const { data: hitOrd, error: eOrd } = await supabase
          .from("pallets")
          .select("id, pallet_number")
          .eq("organization_id", orgId)
          .is("deleted_at", null)
          .eq("order_id", oid)
          .limit(1)
          .maybeSingle();
        if (!eOrd && hitOrd && (hitOrd as { id?: string }).id) {
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

  const handleIdentifyMatchedStartWorkflow = useCallback(async () => {
    if (identifyGatePhase !== "matched" || !identifyGateEntity) return;
    if (identifyGateInventoryVisual === "completed") return;
    const tracking = (identifyGateCanonicalTracking ?? identifyGateEnteredCode).trim();
    if (!tracking) return;

    const orderIdFromGate = (): string | null => {
      for (const r of identifyGateShipmentLines) {
        const o = r.order_id?.trim();
        if (o) return o;
      }
      for (const r of identifyGateRows) {
        const o = String((r as { order_id?: unknown }).order_id ?? "").trim();
        if (o) return o;
      }
      return null;
    };
    const orderId = orderIdFromGate();

    let palletOperatorPackageCount: number | null = null;
    if (identifyGateEntity === "pallet") {
      const parsed = parseMandatoryGateBoxCount(identifyGatePhysicalBoxStr);
      if (!parsed.valid) return;
      palletOperatorPackageCount = parsed.n;
      setPhysicalBoxCount(parsed.n);
      setBoxScanTargetDenominator(parsed.n);
    } else if (
      !(
        identifyGateEntity === "package" &&
        (identifyGateInventoryVisual === "new" || identifyGateInventoryVisual === "in_progress")
      )
    ) {
      setPhysicalBoxCount(null);
      setBoxScanTargetDenominator(null);
    }

    const shipContinueVisual =
      identifyGateEntity === "package" &&
      (identifyGateInventoryVisual === "new" || identifyGateInventoryVisual === "in_progress");

    setBusy(true);
    try {
      const code = identifyGateEnteredCode.trim() || tracking;
      let applied = false;
      let lastResolve: OperatorResolveResult | null = null;
      const resolveOnly: OperatorResolveKind | undefined =
        identifyGateEntity === "package"
          ? "tracking"
          : identifyGateEntity === "pallet"
            ? "pallet"
            : "item";

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
      }

      let effectiveTracking = tracking;
      if (lastResolve?.kind === "tracking") {
        effectiveTracking = String(lastResolve.row.tracking_number ?? "").trim() || effectiveTracking;
      }

      if (shipContinueVisual) {
        setActiveSlipOrPackage(null);
        setActiveTracking(null);
        setCurrentPalletTrackingId(effectiveTracking);
        setDirectBox(false);
        let receiving: { id: string; pallet_number: string; created: boolean } | null = null;
        if (isSupabaseConfigured() && sessionStoreId) {
          receiving = await ensureReceivingPalletForTracking(effectiveTracking, orderId);
        }
        if (receiving) {
          setActivePallet({ id: receiving.id, pallet_number: receiving.pallet_number });
        } else {
          setActivePallet(null);
          setCurrentPalletTrackingId(null);
          setActiveTracking(effectiveTracking);
        }
        if (isSupabaseConfigured() && sessionStoreId) {
          const snap = await loadTrackingExpectationSnapshot(supabase, orgId, sessionStoreId, effectiveTracking);
          if (snap.rawRowCount > 0) {
            setPhysicalBoxCount(snap.rawRowCount);
            setBoxScanTargetDenominator(snap.rawRowCount);
            const pid = receiving?.id;
            if (receiving?.created && pid && isUuidString(pid)) {
              const { error: upErr } = await supabase
                .from("pallets")
                .update({ operator_package_count: snap.rawRowCount })
                .eq("id", pid)
                .eq("organization_id", orgId);
              if (upErr) console.warn("[pallets] operator_package_count (shipment):", upErr.message);
            }
          }
        } else {
          const snap = mockTrackingExpectationSnapshot(effectiveTracking);
          if (snap.rawRowCount > 0) {
            setPhysicalBoxCount(snap.rawRowCount);
            setBoxScanTargetDenominator(snap.rawRowCount);
          }
        }
        setFlowPhase("package_scan");
      } else {
        if (
          applied &&
          identifyGateEntity === "pallet" &&
          palletOperatorPackageCount != null &&
          lastResolve?.kind === "pallet" &&
          isSupabaseConfigured()
        ) {
          const pid = String(lastResolve.row.id ?? "").trim();
          if (isUuidString(pid)) {
            const { error: upErr } = await supabase
              .from("pallets")
              .update({ operator_package_count: palletOperatorPackageCount })
              .eq("id", pid)
              .eq("organization_id", orgId);
            if (upErr) console.warn("[pallets] operator_package_count:", upErr.message);
          }
        }
        if (!applied) {
          setActivePallet(null);
          setActiveSlipOrPackage(null);
          setCurrentPalletTrackingId(null);
          setActiveTracking(tracking);
          setDirectBox(false);
          setFlowPhase("scan");
        }
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
    identifyGateInventoryVisual,
    identifyGateCanonicalTracking,
    identifyGateEnteredCode,
    identifyGatePhysicalBoxStr,
    identifyGateShipmentLines,
    identifyGateRows,
    sessionStoreId,
    orgId,
    applyResult,
    scheduleFocusScanner,
    resetIdentifyGateForm,
    ensureReceivingPalletForTracking,
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
        setActivePallet({ id: crypto.randomUUID(), pallet_number: code });
        setActiveTracking(null);
        setCurrentPalletTrackingId(code.trim());
        setDirectBox(false);
        setFlowPhase("scan");
      } else if (identifyGateEntity === "package") {
        setActivePallet(null);
        setActiveTracking(code);
        setDirectBox(true);
        setFlowPhase("package_scan");
      } else {
        setActivePallet(null);
        setActiveTracking(null);
        setDirectBox(false);
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

    setBusy(true);
    try {
      if (identifyGateEntity === "pallet") {
        const palletRes = await createOperatorPalletAction({
          requestedOrganizationId: orgId,
          storeId: sessionStoreId,
          palletNumber: code,
          trackingNumber: code,
          operatorPackageCount: boxN ?? null,
        });
        if (!palletRes.ok) {
          if (palletRes.duplicatePallet) {
            setIntakeToast("This Tracking Number already exists. Loading details...");
            resumeWorkflowFromExistingPalletRow(palletRes.duplicatePallet, code);
            return;
          }
          throw new Error(palletRes.error);
        }
        const row = { id: palletRes.id, pallet_number: palletRes.pallet_number };
        if (boxN != null) {
          setPhysicalBoxCount(boxN);
          setBoxScanTargetDenominator(boxN);
        }
        setActivePallet({ id: row.id, pallet_number: row.pallet_number });
        setActiveTracking(null);
        setCurrentPalletTrackingId(code.trim());
        setActiveSlipOrPackage(null);
        setDirectBox(false);
        setFlowPhase("scan");
      } else if (identifyGateEntity === "package") {
        if (!allowOperatorUnknownPackageCreate()) {
          throw new Error("Unknown box creation is disabled for this deployment.");
        }
        const auditPkg = await resolveOperatorAuditFieldsClient(supabase);
        const res = await insertUnknownPackageForTrackingCode(supabase, {
          organizationId: orgId,
          storeId: sessionStoreId,
          scannedCode: code,
          created_by: auditPkg.created_by,
        });
        if (!res.ok) throw new Error(res.message);
        setPhysicalBoxCount(null);
        setBoxScanTargetDenominator(null);
        setActivePallet(null);
        setActiveSlipOrPackage(null);
        setActiveTracking(code);
        setDirectBox(false);
        setFlowPhase("package_scan");
      } else {
        const { error } = await supabase.from("returns").insert({
          organization_id: orgId,
          store_id: sessionStoreId,
          status: "received",
          marketplace: "Amazon",
          sku: code,
          item_name: `Unknown scan: ${code}`,
          product_identifier: code,
        });
        if (error) throw new Error(error.message);
        setPhysicalBoxCount(null);
        setBoxScanTargetDenominator(null);
        setActivePallet(null);
        setActiveTracking(null);
        setActiveSlipOrPackage(null);
        setDirectBox(false);
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
    scheduleFocusScanner,
    resetIdentifyGateForm,
    resumeWorkflowFromExistingPalletRow,
  ]);

  const handleIdentificationGatePrimaryCta = useCallback(() => {
    const visual = identifyGateInventoryVisual;
    if (!visual) return;
    if (visual === "completed") return;
    if (visual === "manual_new") void handleIdentifyNewCreateAndStart();
    else void handleIdentifyMatchedStartWorkflow();
  }, [identifyGateInventoryVisual, handleIdentifyNewCreateAndStart, handleIdentifyMatchedStartWorkflow]);

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

  /** Operator box count is collected only when entity type is Pallet (saved as pallets.operator_package_count). */
  const identifyGateNeedsValidBoxCount = identifyGateEntity === "pallet";
  const identifyGateBoxCountValid = parseMandatoryGateBoxCount(identifyGatePhysicalBoxStr).valid;
  const identifyGateBoxCountShowsError = identifyGateNeedsValidBoxCount && !identifyGateBoxCountValid;
  const identifyGateMandatoryFieldsOk =
    identifyGateEntity !== null && (!identifyGateNeedsValidBoxCount || identifyGateBoxCountValid);

  const showIdentifyGatePhysicalBoxInput = identifyGateEntity === "pallet";

  const hasItemReceivableBox = hasReceivableBoxForItems(itemScanPackageId, activeBoxSession);

  const expectedPkgDetailSafe = Array.isArray(expectedPkgDetailRows) ? expectedPkgDetailRows : [];
  const itemExpectedUnitsTotal = expectedPkgDetailSafe.reduce(
    (s, r) => s + Number((r as { expected_scan_quantity?: number }).expected_scan_quantity ?? 0),
    0,
  );
  const itemScannedUnitsTotal = expectedPkgDetailSafe.reduce(
    (s, r) => s + Number((r as { actual_scanned_count?: number }).actual_scanned_count ?? 0),
    0,
  );
  /** Live aggregate: Σ(expected_scan_quantity) − Σ(actual_scanned_count). */
  const itemAggRemaining = Math.max(0, itemExpectedUnitsTotal - itemScannedUnitsTotal);
  const itemProgressDenom = Math.max(itemExpectedUnitsTotal, 1);
  const itemProgressNumerator = Math.min(itemScannedUnitsTotal + 1, itemProgressDenom);

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

  const contextHeadline = activePallet
    ? "Active Pallet"
    : activeTracking?.trim()
      ? "Active Tracking"
      : activeSlipOrPackage
        ? "Active Scan"
        : directBox
          ? "Direct Box Scan"
          : "Awaiting Pallet";

  const contextId =
    activePallet?.pallet_number ??
    (activePallet?.id ? currentPalletTrackingId : activeTracking) ??
    activeSlipOrPackage ??
    (directBox ? "No pallet locked" : "—");

  const contextTone = activePallet
    ? "blue"
    : activeTracking?.trim()
      ? "sky"
      : activeSlipOrPackage?.startsWith("Slip")
        ? "violet"
        : activeSlipOrPackage
          ? "purple"
          : directBox
            ? "amber"
            : "slate";

  const toneRing =
    contextTone === "blue"
      ? "border-blue-500/30 shadow-[0_0_20px_rgba(56,189,248,0.15)]"
      : contextTone === "sky"
        ? "border-sky-500/30 shadow-[0_0_18px_rgba(14,165,233,0.18)]"
        : contextTone === "violet"
          ? "border-violet-500/30 shadow-[0_0_18px_rgba(139,92,246,0.18)]"
          : contextTone === "purple"
            ? "border-purple-500/30 shadow-[0_0_16px_rgba(168,85,247,0.15)]"
            : contextTone === "amber"
              ? "border-amber-500/30 shadow-[0_0_14px_rgba(245,158,11,0.12)]"
              : "border-slate-600/40 shadow-none";

  const onSlipFile = (which: 1 | 2, file: File | undefined) => {
    if (!file?.type.startsWith("image/")) return;
    const url = URL.createObjectURL(file);
    if (which === 1) {
      if (slipPhoto1UrlRef.current) URL.revokeObjectURL(slipPhoto1UrlRef.current);
      slipPhoto1UrlRef.current = url;
      setSlipPhoto1Url(url);
    } else {
      if (slipPhoto2UrlRef.current) URL.revokeObjectURL(slipPhoto2UrlRef.current);
      slipPhoto2UrlRef.current = url;
      setSlipPhoto2Url(url);
    }
  };

  const editParent = () => {
    revokeSlip(1);
    revokeSlip(2);
    setPhysicalBoxCount(null);
    setBoxScanTargetDenominator(null);
    setScannedBoxesSavedCount(0);
    setActiveBoxSession(null);
    setBoxIntakeError(null);
    resetItemInspectionForm();
    setItemScanPackageId(null);
    setItemScanPackageLabel(null);
    setExpectedPkgDetailRows([]);
    setItemTrackingExpectationsHint(null);
    setCandidatePicker(null);
    setItemBarcodeMiss(null);
    modalOpenRef.current = false;
    if (cartonPhotoUrlRef.current) {
      URL.revokeObjectURL(cartonPhotoUrlRef.current);
      cartonPhotoUrlRef.current = null;
    }
    if (trackerPhotoUrlRef.current) {
      URL.revokeObjectURL(trackerPhotoUrlRef.current);
      trackerPhotoUrlRef.current = null;
    }
    setCartonPhotoUrl(null);
    setTrackerPhotoUrl(null);
    setActivePallet(null);
    setActiveTracking(null);
    setCurrentPalletTrackingId(null);
      setCurrentPackageTrackingId(null);
      setPalletCreatedByLabel(null);
      setScanLine("");
      setSlipBarcodeExtract(null);
    setSlipVisionModal(null);
    setSlipVisionProcessing(false);
    setFlowPhase("scan");
    setIsIdentified(false);
    completedShipmentDialogShownForKeyRef.current = null;
    setCompletedShipmentModal(null);
    resetIdentifyGateForm();
    scheduleFocusScanner();
  };

  const isReadyForBoxScan =
    typeof physicalBoxCount === "number" &&
    physicalBoxCount > 0 &&
    parentIdentified &&
    !slipVisionProcessing;

  const expectedBoxesForProgress = Math.max(0, physicalBoxCount ?? 0);
  const physicalDenomFloor = Math.max(expectedBoxesForProgress, 1);
  /** Denominator for Box N of M — locked at confirm from Step 2; otherwise preview from `physicalBoxCount`. */
  const boxIntakeDenom =
    (flowPhase === "package_scan" || flowPhase === "items") && boxScanTargetDenominator != null
      ? boxScanTargetDenominator
      : physicalDenomFloor;

  /** Single Supabase write for pallet shipment-step fields (carrier, counts, photos). */
  const commitActivePalletRowAtSaveAndStart = useCallback(async (): Promise<
    { ok: true; palletId: string } | { ok: false; message: string }
  > => {
    const carrierToPersist = palletCarrier.trim();
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
      const ensured = await ensureReceivingPalletForTracking(tracking, orderIdToPersist || null);
      if (!ensured) {
        return { ok: false, message: "Could not create pallet for this shipment." };
      }
      palletId = ensured.id;
      setActivePallet({ id: ensured.id, pallet_number: ensured.pallet_number });
    }

    const persisted = await commitOperatorPalletShipmentStepAction({
      requestedOrganizationId: orgId,
      palletId,
      carrier_name: carrierToPersist.length ? carrierToPersist : null,
      order_id: orderIdToPersist.length ? orderIdToPersist : null,
      operator_package_count: boxCount,
      tracking_number: trackingPersist,
      shipping_label_photo_urls: shippingLabelPhotoUrls,
      pallet_photo_urls: palletPhotoUrls,
      bol_photo_urls: bolPhotoUrls,
    });

    if (!persisted.ok) return { ok: false, message: persisted.message };
    setPalletCreatedByLabel(persisted.creatorDisplayLabel.trim() || "Unknown");
    return { ok: true, palletId };
  }, [
    palletCarrier,
    palletOrderId,
    slipBarcodeExtract?.shipmentId,
    currentPalletTrackingId,
    physicalBoxCount,
    activePallet?.id,
    shippingLabelPhotoUrls,
    palletPhotoUrls,
    bolPhotoUrls,
    orgId,
    sessionStoreId,
    ensureReceivingPalletForTracking,
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

  /** Backend pallet with no hydrated slip columns and no session commit — Carrier/Order stay editable; box/tracking locked until Edit All. */
  const isInitialDraftShipmentUx =
    hasBackendPalletRow && !palletDbHasShipmentDetails && !hasSessionShipmentCommit;

  /** Carrier + Order ID: editable on demo / no pallet row / initial draft / Edit All. */
  const slipCarrierOrderEditable =
    editAllMode ||
    !liveDbForShipmentUx ||
    !hasBackendPalletRow ||
    isInitialDraftShipmentUx;

  /** Box count + Tracking ID: read-only until Edit All. */
  const boxCountEditable = editAllMode;
  const trackingIdEditable = editAllMode;

  /** Shipment Entry step: global Edit All + tracking lives in Active Pallet card (not duplicated under title). */
  const showShipmentEntryEditAll =
    isIdentified && flowPhase === "scan" && parentIdentified && Boolean(activePallet?.id?.trim());

  const handleConfirmStartBoxScan = useCallback(async () => {
    if (!parentIdentified) {
      setSyncErrorToast("Identify the pallet barcode first.");
      return;
    }
    if (slipVisionProcessing) {
      setSyncErrorToast("Wait for the slip OCR to finish, then try again.");
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
      const res = await commitActivePalletRowAtSaveAndStart();
      if (!res.ok) {
        setSyncErrorToast(res.message);
        return;
      }
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
      setFlowPhase("package_scan");
      setPalletDocHydrationNonce((n) => n + 1);
    } finally {
      setConfirmSaving(false);
    }
  }, [
    parentIdentified,
    slipVisionProcessing,
    physicalBoxCount,
    expectedPackagesRawRowCount,
    palletCarrier,
    palletCarrierOtherSelected,
    commitActivePalletRowAtSaveAndStart,
    formId,
    orgId,
    boxCountEditable,
  ]);
  const boxOrdinal = Math.min(scannedBoxesSavedCount + 1, boxIntakeDenom);
  const slipPagesCaptured = (slipPhoto1Url ? 1 : 0) + (slipPhoto2Url ? 1 : 0);
  const matchedItemsPreviewCount = aiSlipReaderPhase === "matched" ? expectedPkgLines.length : 0;
  const slipMatchParentTn = activePallet?.id ? currentPalletTrackingId : activeTracking;
  const showSlipMatchedBadge =
    aiSlipReaderPhase === "matched" &&
    expectedPkgLines.length > 0 &&
    (!slipBarcodeExtract?.shipmentId ||
      trackingKeysEqual(slipBarcodeExtract.shipmentId, slipMatchParentTn ?? ""));
  const showWarehouseTrail = isIdentified && (parentIdentified || directBox || flowPhase !== "scan");
  /**
   * Header "Pallet" crumb + Active Pallet read-only must share the same source as the tracking field:
   * `currentPalletTrackingId` (live while Edit All); when not editing, trimmed tracking then `pallet_number`.
   */
  const warehousePalletLabel = (() => {
    if (!activePallet?.id) return directBox ? "Direct" : null;
    if (trackingIdEditable) {
      const v = currentPalletTrackingId;
      if (v == null || v === "") return null;
      return v;
    }
    const t = (currentPalletTrackingId ?? "").trim();
    return t || (activePallet.pallet_number ?? "").trim() || null;
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
    flowPhase === "items" && boxTrailTrim ? { label: "Box", value: boxTrailTrim } : null;
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
          warehouseBreadcrumbMiddleOverride.label === "Box" &&
          warehouseBreadcrumbMiddleOverride.value === boxTrailTrim
        ? null
        : contextTrailBoxBarcode;

  useEffect(() => {
    if (flowPhase !== "scan" || !parentIdentified || !boxCountEditable) return;
    const t = window.setTimeout(() => {
      const el = physicalBoxCountInputRef.current;
      if (!el) return;
      try {
        el.focus({ preventScroll: true });
      } catch {
        el.focus();
      }
    }, 180);
    return () => window.clearTimeout(t);
  }, [flowPhase, parentIdentified, boxCountEditable]);

  const onCartonOrTrackerFile = (which: "carton" | "tracker", file: File | undefined) => {
    if (!file?.type.startsWith("image/")) return;
    const url = URL.createObjectURL(file);
    if (which === "carton") {
      if (cartonPhotoUrlRef.current) URL.revokeObjectURL(cartonPhotoUrlRef.current);
      cartonPhotoUrlRef.current = url;
      setCartonPhotoUrl(url);
    } else {
      if (trackerPhotoUrlRef.current) URL.revokeObjectURL(trackerPhotoUrlRef.current);
      trackerPhotoUrlRef.current = url;
      setTrackerPhotoUrl(url);
    }
  };

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

  const showContextHeader = isIdentified && flowPhase === "scan";

  useLayoutEffect(() => {
    if (flowPhase !== "items") {
      setItemsPhaseMainPadPx(0);
      return;
    }
    const head = scanPageHeaderRef.current;
    if (!head) return;
    const ITEMS_FIRST_GAP_PX = 16; /* gap-4 below Active Context before first card */
    const measure = () => {
      const hh = head.offsetHeight;
      setItemsContextBarInsetPx(hh);
      const b = itemsContextBarRef.current;
      if (b) {
        const stripBelowHeader = Math.max(0, b.offsetHeight - hh);
        setItemsPhaseMainPadPx(stripBelowHeader + ITEMS_FIRST_GAP_PX);
      } else {
        setItemsPhaseMainPadPx(ITEMS_FIRST_GAP_PX);
      }
    };
    let roBar: ResizeObserver | null = null;
    const attachBarObserver = () => {
      const b = itemsContextBarRef.current;
      if (!b || roBar) return;
      roBar = new ResizeObserver(measure);
      roBar.observe(b);
    };
    measure();
    attachBarObserver();
    const raf = window.requestAnimationFrame(() => {
      measure();
      attachBarObserver();
    });
    const roHead = new ResizeObserver(measure);
    roHead.observe(head);
    return () => {
      window.cancelAnimationFrame(raf);
      roHead.disconnect();
      roBar?.disconnect();
    };
  }, [
    flowPhase,
    activeStoreLabel,
    activePallet?.pallet_number,
    activeTracking,
    currentPalletTrackingId,
    currentPackageTrackingId,
    editAllMode,
    itemScanPackageLabel,
    activeBoxSession?.barcode,
    itemExpectedUnitsTotal,
    itemScannedUnitsTotal,
    itemAggRemaining,
  ]);

  const liveDb = isSupabaseConfigured();
  const allowSessionIncompleteUi =
    !liveDb || operatorStores.length > 1 || operatorStores.length === 0 || kioskStoreLocked;
  const blockUntilStoreResolved =
    liveDb && !operatorStoresLoading && !sessionStoreId && !allowSessionIncompleteUi;

  /** Step 3: laser wedge + hidden buffer follow carton state, not `scanLine` (items / gate use `scanLine`). */
  const packageScanBoxBufferOpen = flowPhase === "package_scan" && !activeBoxSession;

  if (!orgId?.trim()) {
    return <ScanPageLoading message="Missing organization context." />;
  }
  if (liveDb && operatorStoresLoading) {
    return <ScanPageLoading />;
  }
  if (blockUntilStoreResolved) {
    return <ScanPageLoading message="Restoring store session…" />;
  }

  return (
    <div
      className="flex min-h-0 min-w-0 flex-1 flex-col text-[15px] font-medium leading-snug [&_button]:touch-manipulation [&_button]:transition-transform [&_button]:duration-150 [&_button]:ease-out [&_button]:active:scale-95"
      style={{ backgroundColor: BG, color: TEXT_PRIMARY }}
    >
      <input
        ref={scannerRef}
        id={`${formId}-laser`}
        type="text"
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        disabled={scannerDisabled}
        value={packageScanBoxBufferOpen ? (currentPackageTrackingId ?? "") : scanLine}
        onChange={(e) => {
          const v = e.target.value;
          if (packageScanBoxBufferOpen) setCurrentPackageTrackingId(v === "" ? null : v);
          else setScanLine(v);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            void onSubmitScan();
          }
        }}
        onBlur={() => {
          window.setTimeout(() => {
            if (modalOpenRef.current || manualOpen || !laserEnabled) return;
            // Critical: if focus moved to ANY editable element (input/textarea/select/
            // contentEditable), the operator is intentionally typing — do not yank focus
            // back to the hidden laser input or it will appear "locked" and eat keystrokes.
            const active =
              typeof document !== "undefined"
                ? (document.activeElement as HTMLElement | null)
                : null;
            if (active && active !== document.body) {
              const tag = active.tagName;
              if (
                tag === "INPUT" ||
                tag === "TEXTAREA" ||
                tag === "SELECT" ||
                active.isContentEditable
              ) {
                return;
              }
            }
            focusScannerAggressive();
          }, 100);
        }}
        className="sr-only"
        aria-hidden
        tabIndex={0}
      />

      <header
        ref={scanPageHeaderRef}
        className="relative z-[110] shrink-0 border-b pt-0"
        style={{
          borderColor: BORDER,
          background: "var(--scanner-header-gradient)",
        }}
      >
        <div className="grid grid-cols-[2.5rem_minmax(0,1fr)_auto] items-start gap-x-1 px-3 pb-0.5 pt-1 sm:gap-x-2 sm:px-4">
          <button
            type="button"
            onClick={() => {
              if (!isIdentified) {
                if (identifyGatePhase !== "idle") {
                  resetIdentifyGateForm();
                  scheduleFocusScanner();
                  return;
                }
                router.back();
                return;
              }
              if (flowPhase === "items") setFlowPhase("package_scan");
              else if (flowPhase === "package_scan") setFlowPhase("scan");
              else router.back();
            }}
            className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl transition hover:bg-black/[0.06] active:scale-95 dark:hover:bg-white/8"
            style={{ color: TEXT_PRIMARY }}
            aria-label="Go back"
          >
            <ArrowLeft className="h-5 w-5" strokeWidth={2} />
          </button>
          <div className="min-w-0 px-1 text-center">
            {isIdentified ? (
              <>
                <h1
                  className="operator-heading text-[1.05rem] font-semibold leading-tight tracking-tight sm:text-[1.15rem]"
                  style={{ color: TEXT_PRIMARY }}
                >
                  {headerTitle}
                </h1>
                {showWarehouseTrail ? (
                  <WarehouseBreadcrumb
                    storeLabel={activeStoreLabel}
                    palletLabel={warehousePalletLabel}
                    shipmentIdLabel={warehouseBreadcrumbShipmentForTrail}
                    middleOverride={warehouseBreadcrumbMiddleOverride}
                    boxBarcode={warehouseBreadcrumbTrailingBarcode}
                  />
                ) : null}
                {flowPhase === "package_scan" ? (
                  <p className="mt-0.5 text-[11px] font-bold tabular-nums" style={{ color: ACTION_PURPLE }}>
                    Box {boxOrdinal} of{" "}
                    {typeof physicalBoxCount === "number" && physicalBoxCount > 0 ? physicalBoxCount : boxIntakeDenom}
                  </p>
                ) : null}
                {flowPhase === "items" ? (
                  <p className="mt-0.5 text-[11px] font-bold tabular-nums" style={{ color: TEXT_PRIMARY }}>
                    Item {itemProgressNumerator} of {itemProgressDenom}
                    <span className="font-normal opacity-55">{" · Box receiving progress"}</span>
                  </p>
                ) : null}
              </>
            ) : (
              <div className="h-10 min-h-[2.5rem] sm:h-11" aria-hidden />
            )}
          </div>
          <div className="flex min-h-10 items-start justify-end pt-0.5">
            {showShipmentEntryEditAll ? (
              <button
                type="button"
                onClick={() => setEditAllMode((m) => !m)}
                aria-pressed={editAllMode}
                className={`inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-xl border px-3 py-2 text-[10px] font-bold uppercase tracking-wide shadow-sm transition active:scale-95 sm:px-3.5 sm:py-2 sm:text-[11px] ${
                  editAllMode
                    ? "border-teal-400/65 bg-teal-500/15 text-teal-200"
                    : "border-slate-600/70 bg-slate-800/70 text-slate-200 hover:bg-slate-700/80"
                }`}
              >
                {editAllMode ? (
                  <>
                    <CheckCircle2 className="h-3.5 w-3.5 shrink-0" strokeWidth={2.5} />
                    Done
                  </>
                ) : (
                  <>
                    <Pencil className="h-3.5 w-3.5 shrink-0" strokeWidth={2} />
                    Edit All
                  </>
                )}
              </button>
            ) : (
              <span className="inline-block h-10 w-10 shrink-0" aria-hidden />
            )}
          </div>
        </div>

        {/* Step progress indicator (Pallet → Box → Item dots row) was removed
            from the page header per the cleanup spec. The current phase is implicit
            from the visible UI (active pallet card → box scan card → item form),
            and the sticky progress dashboard at the top of the page surfaces
            scanned/expected counts at all times. */}

        {showContextHeader ? (
          <div className="sticky top-0 z-20 border-t px-2 pb-1.5 pt-0.5" style={{ borderColor: BORDER, backgroundColor: BG }}>
            <div
              className={`rounded-xl border px-2 py-1.5 shadow-[inset_0_1px_0_0_rgba(255,255,255,0.04)] backdrop-blur-[2px] ${toneRing}`}
              style={{ backgroundColor: CARD }}
            >
              <div className="flex items-center gap-2">
                <span
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ring-1"
                  style={{
                    backgroundColor: "rgba(56,189,248,0.1)",
                    color: ACCENT_BLUE,
                    boxShadow: "0 0 12px rgba(56,189,248,0.2)",
                    borderColor: "rgba(56,189,248,0.22)",
                  }}
                >
                  {trackingIdentified ? (
                    <ScanLine className="h-4 w-4" strokeWidth={2.25} />
                  ) : (
                    <Warehouse className="h-4 w-4" strokeWidth={2.25} />
                  )}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <p className="text-[12px] font-bold leading-tight tracking-tight text-white">{contextHeadline}</p>
                    <span
                      className="rounded-full px-1.5 py-0.5 text-[8px] font-bold uppercase tracking-wide"
                      style={
                        parentIdentified
                          ? {
                              border: `1px solid rgba(52,211,153,0.35)`,
                              backgroundColor: SUCCESS_BG,
                              color: SUCCESS,
                            }
                          : {
                              border: `1px solid ${BORDER}`,
                              backgroundColor: CARD_INNER,
                              color: MUTED_LABEL,
                            }
                      }
                    >
                      {parentIdentified ? "Identified" : "Scanning"}
                    </span>
                  </div>
                  {flowPhase === "scan" && parentIdentified ? (
                    trackingIdEditable ? (
                      <input
                        id={`${formId}-active-pallet-tracking`}
                        type="text"
                        autoComplete="off"
                        enterKeyHint="done"
                        aria-label="Tracking ID"
                        className="mt-0.5 block w-full min-w-0 truncate rounded-md border-2 border-sky-400/55 bg-[#060a10] px-2 py-1 font-mono text-xs font-bold text-white outline-none placeholder:text-slate-600 focus-visible:ring-2 focus-visible:ring-sky-500/35"
                        placeholder="Tracking / shipment ID"
                        value={currentPalletTrackingId ?? ""}
                        onChange={(e) => {
                          const v = e.target.value;
                          setCurrentPalletTrackingId(v === "" ? null : v);
                        }}
                        onBlur={(e) => {
                          const t = e.target.value.trim();
                          setCurrentPalletTrackingId(t.length ? t : null);
                        }}
                      />
                    ) : (
                      <p
                        className="mt-0.5 truncate font-mono text-xs font-bold"
                        style={{ color: ACCENT_BLUE }}
                        title={(currentPalletTrackingId ?? "").trim() || activePallet?.pallet_number || undefined}
                      >
                        {(currentPalletTrackingId ?? "").trim() || activePallet?.pallet_number || "—"}
                      </p>
                    )
                  ) : (
                    <p className="mt-0.5 truncate font-mono text-xs font-bold" style={{ color: ACCENT_BLUE }}>
                      {contextId}
                    </p>
                  )}
                </div>
              </div>
              {/* Row 3: Box count — read-only until Edit All unlocks. */}
              {flowPhase === "scan" && parentIdentified ? (
                <div className="mt-1.5 border-t pt-1.5" style={{ borderColor: BORDER }}>
                  {boxCountEditable ? (
                    <div
                      key={`physical-shake-${physicalCountShakeSeq}`}
                      className={`flex flex-wrap items-center gap-2 ${
                        physicalCountShakeSeq > 0 ? "operator-physical-count-shake" : ""
                      }`}
                    >
                      <span
                        className="shrink-0 text-[9px] font-bold uppercase tracking-widest"
                        style={{ color: MUTED_LABEL }}
                        id={`${formId}-physical-boxes-label`}
                      >
                        Box count
                      </span>
                      <div className="flex items-stretch overflow-hidden rounded-md border-2 border-teal-400/65 bg-[#060a10] shadow-[inset_0_1px_8px_rgba(0,0,0,0.55)] focus-within:shadow-[inset_0_1px_8px_rgba(0,0,0,0.55),0_0_0_3px_rgba(45,212,191,0.25)]">
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
                          className="flex h-9 w-9 shrink-0 items-center justify-center text-[18px] font-black text-slate-300 transition hover:bg-slate-700/40 active:scale-95 disabled:cursor-not-allowed disabled:opacity-35"
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
                          className="block h-9 w-[4.25rem] min-w-0 bg-transparent text-center font-mono text-[17px] font-black tabular-nums text-white outline-none placeholder:text-slate-600"
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
                              typeof cur === "number" && Number.isFinite(cur)
                                ? Math.min(9999, cur + 1)
                                : 1;
                            setPhysicalBoxCount(next);
                          }}
                          className="flex h-9 w-9 shrink-0 items-center justify-center text-[18px] font-black text-slate-300 transition hover:bg-slate-700/40 active:scale-95"
                        >
                          +
                        </button>
                      </div>
                    </div>
                  ) : (
                    <p
                      className={`text-[14px] font-extrabold tabular-nums leading-snug text-white ${
                        physicalCountShakeSeq > 0 ? "operator-physical-count-shake text-amber-200" : ""
                      }`}
                      aria-label={`Box count: ${typeof physicalBoxCount === "number" && physicalBoxCount > 0 ? physicalBoxCount : "not set"}`}
                    >
                      Box Count:{" "}
                      {typeof physicalBoxCount === "number" && physicalBoxCount > 0
                        ? physicalBoxCount
                        : "—"}
                    </p>
                  )}
                </div>
              ) : null}
              {flowPhase === "scan" && parentIdentified && activePallet?.id ? (
                <p className="mt-2 text-[9px] font-medium leading-snug opacity-85" style={{ color: MUTED_LABEL }}>
                  Created by:{" "}
                  <span className="font-semibold text-slate-400/95">
                    {palletCreatedByLabel?.trim() ? palletCreatedByLabel.trim() : "Unknown"}
                  </span>
                </p>
              ) : null}
              <p className="sr-only" aria-live="polite">
                {scanLine ? `Buffer: ${scanLine}` : "Scanner ready"}
              </p>
            </div>
          </div>
        ) : null}

        {/* Row 4 — Box-only progress (Expected / Scanned / Remaining). */}
        <ScanProgressDashboard
          active={parentIdentified && flowPhase !== "items"}
          boxesExpected={typeof physicalBoxCount === "number" && physicalBoxCount > 0 ? physicalBoxCount : 0}
          boxesScanned={scannedBoxesSavedCount}
        />
      </header>

      {flowPhase === "items" ? (
        <section
          ref={itemsContextBarRef}
          aria-label="Active context"
          className="fixed left-1/2 top-0 z-[100] w-full max-w-[430px] -translate-x-1/2 border-b border-white/15 shadow-[0_12px_32px_rgba(0,0,0,0.55)]"
          style={{
            paddingTop: itemsContextBarInsetPx,
            backgroundColor: BG,
          }}
        >
          <div className="flex gap-2 px-3 py-2 sm:px-4">
            <div
              className="flex h-8 w-8 shrink-0 items-center justify-center self-start rounded-lg ring-1"
              style={{
                backgroundColor: "rgba(45,212,191,0.1)",
                borderColor: "rgba(45,212,191,0.24)",
                color: TEAL_STEP,
                boxShadow: "0 0 10px rgba(45,212,191,0.14)",
              }}
              aria-hidden
            >
              {trackingIdentified ? <ScanLine className="h-4 w-4" strokeWidth={2.25} /> : <Warehouse className="h-4 w-4" strokeWidth={2.25} />}
            </div>
            <div className="min-w-0 flex-1 space-y-1">
              <p className="text-[9px] font-semibold uppercase tracking-widest text-slate-500">Active context</p>
              <WarehouseBreadcrumb
                className="mt-0 justify-start px-0"
                storeLabel={activeStoreLabel}
                palletLabel={warehousePalletLabel}
                shipmentIdLabel={warehouseBreadcrumbShipmentForTrail}
                middleOverride={warehouseBreadcrumbMiddleOverride}
                boxBarcode={warehouseBreadcrumbTrailingBarcode}
              />
              <div className="flex flex-wrap gap-x-4 gap-y-0.5 border-t border-white/10 pt-1.5 text-[11px] tabular-nums">
                <span
                  className="font-bold"
                  style={{ color: showSlipMatchedBadge ? "rgba(52,211,153,0.95)" : MUTED_LABEL }}
                >
                  Slip {showSlipMatchedBadge ? <span className="text-emerald-300">matched</span> : <span>pending</span>}
                </span>
                <span className="font-semibold text-white/70">
                  Exp. <span className="font-extrabold text-teal-300">{itemExpectedUnitsTotal}</span>
                </span>
                <span className="font-semibold text-white/70">
                  Done <span className="font-extrabold text-emerald-300">{itemScannedUnitsTotal}</span>
                </span>
                <span className="font-semibold text-white/70">
                  Left{" "}
                  <span className={`font-extrabold ${itemAggRemaining > 0 ? "text-amber-300" : "text-emerald-400"}`}>
                    {itemAggRemaining}
                  </span>
                </span>
              </div>
            </div>
          </div>
        </section>
      ) : null}

      <main
        className={`min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 pb-3 ${flowPhase === "items" ? "" : "pt-2"} ${mainScrollClass}`}
        style={flowPhase === "items" ? { paddingTop: itemsPhaseMainPadPx } : undefined}
      >
        {!isIdentified ? (
          <>
            {!isSupabaseConfigured() ? (
              <p
                className="mb-3 rounded-xl border px-3 py-2 text-[11px] font-semibold"
                style={{ borderColor: "rgba(251,191,36,0.35)", backgroundColor: "rgba(69,26,3,0.35)", color: "#fde68a" }}
              >
                Demo mode — try a tracking code or <span className="font-mono">NEW-</span>. Configure Supabase for live data.
              </p>
            ) : null}
            {isSupabaseConfigured() && !operatorStoresLoading && !kioskStoreLocked && operatorStores.length === 0 ? (
              <p
                className="mb-4 rounded-[20px] border px-3.5 py-2.5 text-[12px] font-semibold"
                style={{ borderColor: "rgba(248,113,113,0.35)", backgroundColor: "rgba(69,10,10,0.35)", color: "#fecaca" }}
              >
                No active stores for this organization. Add a store in Settings (Stores and adapters), then refresh.
              </p>
            ) : null}
            {isSupabaseConfigured() && !operatorStoresLoading && operatorStores.length > 0 && !sessionStoreId ? (
              <p
                className="mb-4 rounded-[20px] border px-3.5 py-2.5 text-[12px] font-semibold"
                style={{ borderColor: "rgba(248,113,113,0.35)", backgroundColor: "rgba(69,10,10,0.35)", color: "#fecaca" }}
              >
                Could not activate a store — choose one in the Store row above or verify your connection.
              </p>
            ) : null}

            <div className="mb-3 px-0.5">
              <h1
                className="operator-heading text-[1.28rem] font-semibold leading-tight tracking-tight sm:text-[1.42rem]"
                style={{ color: TEXT_PRIMARY }}
              >
                {headerTitle}
              </h1>
            </div>

            <section className={`relative z-10 mb-4 rounded-[22px] p-4 sm:p-5 ${glassCard}`}>
              <div className="flex items-center justify-between gap-3">
                <div className="flex min-w-0 flex-1 items-center gap-2.5">
                  <div
                    className="scanner-neon-icon-ring flex h-11 w-11 shrink-0 items-center justify-center rounded-xl ring-1 ring-cyan-400/25 dark:ring-cyan-400/35"
                    style={{
                      backgroundColor: "rgba(56,189,248,0.12)",
                      borderColor: "rgba(56,189,248,0.28)",
                    }}
                  >
                    <Barcode className="h-6 w-6" strokeWidth={2} style={{ color: ACCENT_BLUE }} />
                  </div>
                  <p className="min-w-0 text-[10px] font-bold uppercase leading-snug tracking-[0.12em] text-zinc-700 dark:text-white/60 sm:text-xs sm:tracking-[0.14em]">
                    Tracking Number or Slip Code
                  </p>
                </div>
                <div ref={gateTrackingHelpRef} className="relative shrink-0">
                  <button
                    type="button"
                    className="operator-info-icon-pulse flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-black/10 bg-black/[0.04] text-slate-500 outline-none transition hover:border-sky-500/35 hover:bg-sky-500/10 hover:text-sky-700 focus-visible:ring-2 focus-visible:ring-sky-400/40 dark:border-white/12 dark:bg-white/[0.06] dark:text-slate-400 dark:hover:border-sky-400/35 dark:hover:bg-white/10 dark:hover:text-sky-100"
                    aria-label="How lookup works"
                    aria-expanded={gateTrackingHelpOpen}
                    title="Exact match on inventory status (tracking or slip) for this organization and store. No SKU or ASIN search."
                    onClick={() => setGateTrackingHelpOpen((o) => !o)}
                  >
                    <Info className="h-4 w-4" strokeWidth={2} aria-hidden />
                  </button>
                  {gateTrackingHelpOpen ? (
                    <div
                      className="absolute right-0 top-full z-30 mt-2 w-[min(calc(100vw-2rem),260px)] max-w-[min(20rem,calc(100vw-2rem))] rounded-xl border px-3 py-2.5 text-left text-[12px] font-medium leading-snug shadow-lg"
                      style={{
                        borderColor: "rgba(148,163,184,0.28)",
                        backgroundColor: "rgba(15,23,42,0.98)",
                        color: MUTED_LABEL,
                        boxShadow: "0 12px 40px rgba(0,0,0,0.55)",
                      }}
                      role="tooltip"
                    >
                      <span className="font-semibold text-slate-200">Lookup</span> uses an{" "}
                      <span className="font-mono text-[11px] text-sky-200/90">exact</span> match on the unified inventory view
                      (tracking number or slip code) for the current organization and store. Partial SKU or ASIN search is not
                      supported here.
                    </div>
                  ) : null}
                </div>
              </div>
              <div
                className={`relative mt-4 rounded-[20px] transition-[box-shadow] ${
                  identifyGateOcrDropHighlight ? "ring-2 ring-sky-400/55" : ""
                }`}
                style={{
                  boxShadow: identifyGateOcrDropHighlight ? "0 0 28px rgba(56,189,248,0.25)" : undefined,
                }}
                onDragOver={onIdentifyGateScanZoneDragOver}
                onDragLeave={onIdentifyGateScanZoneDragLeave}
                onDrop={onIdentifyGateScanZoneDrop}
              >
                <ScanFrameWithLaser
                  minHeight="120px"
                  laserColor={ACCENT_BLUE}
                  cornerColor="var(--scanner-bracket-cyan)"
                  cornerSize="lg"
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
                >
                  <ScanLine className="h-10 w-10 opacity-40" strokeWidth={2} style={{ color: MUTED_LABEL }} />
                </ScanFrameWithLaser>
                {identifyGateOcrDropHighlight ? (
                  <div
                    className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-[20px] border-2 border-dashed border-sky-400/50 bg-sky-500/10 backdrop-blur-[1px]"
                    aria-hidden
                  >
                    <span className="text-[13px] font-bold text-sky-100/95" style={{ textShadow: "0 0 12px rgba(56,189,248,0.5)" }}>
                      Drop JPG or PNG to read code
                    </span>
                  </div>
                ) : null}
              </div>
              <div className="mt-4">
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
                  <input
                    id={`${formId}-gate-manual`}
                    value={scanLine}
                    onChange={(e) => setScanLine(e.target.value)}
                    onFocus={() => setManualOpen(true)}
                    onBlur={() => {
                      window.setTimeout(() => setManualOpen(false), 120);
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
                    disabled={identifyGateOcrReading}
                    aria-busy={identifyGateOcrReading}
                    aria-label={
                      identifyGateOcrReading ? "Analyzing image" : "Scan, type or upload photo for tracking or slip code"
                    }
                    placeholder={
                      identifyGateOcrReading ? "⏳ Analyzing image..." : "Scan, type or upload photo..."
                    }
                    className="scanner-input-glass min-h-[3rem] w-full rounded-xl border py-2 pl-3.5 pr-[4.75rem] font-mono text-[14px] outline-none transition placeholder:opacity-50 placeholder:text-[13px] focus:border-teal-400/45 focus:shadow-[0_0_0_2px_rgba(45,212,191,0.22)] disabled:cursor-not-allowed disabled:opacity-60 sm:min-h-[3.25rem] sm:pr-[5.25rem] sm:text-[15px] sm:placeholder:text-[14px]"
                    style={{ color: TEXT_PRIMARY }}
                  />
                  <div className="absolute right-1.5 top-1/2 z-[1] flex -translate-y-1/2 items-center gap-0.5">
                    <div className="relative" ref={identifyGateOcrMenuRef}>
                      <button
                        type="button"
                        disabled={busy || identifyGateOcrReading}
                        onClick={() => setIdentifyGateOcrMenuOpen((o) => !o)}
                        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg outline-none transition hover:bg-sky-500/15 focus-visible:ring-2 focus-visible:ring-sky-400/50 disabled:cursor-not-allowed disabled:opacity-35"
                        style={{
                          color: ACCENT_BLUE,
                          filter: "drop-shadow(0 0 5px rgba(56,189,248,0.65)) drop-shadow(0 0 12px rgba(34,211,238,0.35))",
                        }}
                        aria-label="Photo or upload for OCR"
                        aria-expanded={identifyGateOcrMenuOpen}
                        aria-haspopup="menu"
                        title="Camera or file (JPG / PNG)"
                      >
                        <Camera className="h-5 w-5" strokeWidth={2.25} aria-hidden />
                      </button>
                      {identifyGateOcrMenuOpen ? (
                        <div
                          className="scanner-ocr-action-sheet absolute right-0 top-full z-[50] mt-2 w-[min(calc(100vw-2rem),19rem)] overflow-hidden rounded-2xl py-2"
                          role="menu"
                        >
                          <button
                            type="button"
                            role="menuitem"
                            className="flex min-h-[3.25rem] w-full items-center gap-3 px-4 py-3.5 text-left text-[15px] font-bold text-zinc-900 transition hover:bg-cyan-500/10 active:bg-cyan-500/15 dark:text-sky-50 dark:hover:bg-sky-500/15 dark:active:bg-sky-500/25 sm:min-h-[3.5rem] sm:text-[16px]"
                            onClick={() => {
                              setIdentifyGateOcrMenuOpen(false);
                              identifyGateCameraCaptureRef.current?.click();
                            }}
                          >
                            <span className="text-xl leading-none" aria-hidden>
                              📸
                            </span>
                            Take a Photo
                          </button>
                          <button
                            type="button"
                            role="menuitem"
                            className="flex min-h-[3.25rem] w-full items-center gap-3 border-t border-zinc-200 px-4 py-3.5 text-left text-[15px] font-bold text-zinc-900 transition hover:bg-cyan-500/10 active:bg-cyan-500/15 dark:border-white/10 dark:text-sky-50 dark:hover:bg-sky-500/15 dark:active:bg-sky-500/25 sm:min-h-[3.5rem] sm:text-[16px]"
                            onClick={() => {
                              setIdentifyGateOcrMenuOpen(false);
                              identifyGateCameraUploadRef.current?.click();
                            }}
                          >
                            <span className="text-xl leading-none" aria-hidden>
                              📁
                            </span>
                            Upload from Gallery
                          </button>
                        </div>
                      ) : null}
                    </div>
                    <button
                      type="button"
                      disabled={busy || identifyGateOcrReading || !scanLine.trim()}
                      onClick={() => void onSubmitScan()}
                      title={identifyGateOcrReading ? "Wait for image analysis" : undefined}
                      className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-teal-100/95 transition hover:bg-teal-500/15 disabled:cursor-not-allowed disabled:opacity-35"
                      style={{ color: "#99f6e4" }}
                      aria-label={busy ? "Searching" : "Search"}
                    >
                      {busy ? <Loader2 className="h-5 w-5 animate-spin" strokeWidth={2} /> : <Search className="h-5 w-5" strokeWidth={2.25} />}
                    </button>
                  </div>
                  {identifyGateOcrReading ? (
                    <div
                      className="scanner-ocr-reading-overlay absolute inset-0 z-[5] flex flex-col items-center justify-center gap-2 rounded-xl px-3 py-2 backdrop-blur-md"
                      role="status"
                      aria-live="polite"
                    >
                      <Loader2
                        className="h-7 w-7 animate-spin"
                        strokeWidth={2}
                        style={{ color: ACCENT_BLUE, filter: "drop-shadow(0 0 10px rgba(56,189,248,0.7))" }}
                      />
                      <span className="text-center text-[12px] font-bold tracking-wide text-zinc-900 dark:text-sky-100/95">
                        Reading code... {identifyGateOcrProgressPct}%
                      </span>
                    </div>
                  ) : null}
                </div>
              </div>
              {identifyGatePhase === "searching" ? (
                <p className="mt-4 flex items-center justify-center gap-2 text-[13px] font-semibold" style={{ color: MUTED_LABEL }}>
                  <Loader2 className="h-5 w-5 animate-spin" style={{ color: ACCENT_BLUE }} strokeWidth={2} />
                  Searching inventory status…
                </p>
              ) : null}
              {identifyGateError ? (
                <p
                  className="mt-4 rounded-xl border px-3 py-2.5 text-[12px] font-semibold"
                  style={{ borderColor: "rgba(248,113,113,0.35)", backgroundColor: "rgba(69,10,10,0.35)", color: "#fecaca" }}
                >
                  {identifyGateError}
                </p>
              ) : null}
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

            {(identifyGatePhase === "matched" || identifyGatePhase === "new") && identifyGateInventoryVisual ? (
              <section
                key={`identify-gate-results-${identifyGatePhase}-${identifyGateInventoryVisual}`}
                className={`animate-scanner-results-enter relative z-0 mb-4 w-full max-w-full overflow-hidden rounded-[22px] border-2 px-6 py-6 sm:px-8 sm:py-7 ${glassCard}`}
                style={{
                  borderColor: IDENTIFICATION_GATE_THEME[identifyGateInventoryVisual].border,
                  boxShadow: identifyGateGlowFlash
                    ? `${IDENTIFICATION_GATE_THEME[identifyGateInventoryVisual].outerGlow}, 0 0 56px rgba(52,211,153,0.45)`
                    : IDENTIFICATION_GATE_THEME[identifyGateInventoryVisual].outerGlow,
                }}
              >
                <div
                  className="pointer-events-none absolute inset-0 opacity-[0.14]"
                  style={{
                    background: `radial-gradient(120% 80% at 50% -10%, ${IDENTIFICATION_GATE_THEME[identifyGateInventoryVisual].chipBg}, transparent 55%)`,
                  }}
                  aria-hidden
                />
                <div className="absolute right-4 top-4 z-[2] flex items-center gap-1 sm:right-5 sm:top-5">
                  <span
                    className="inline-flex max-w-[10.5rem] items-center truncate rounded-full border px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wide shadow-sm sm:max-w-[12rem]"
                    style={{
                      borderColor: IDENTIFICATION_GATE_THEME[identifyGateInventoryVisual].border,
                      backgroundColor: IDENTIFICATION_GATE_THEME[identifyGateInventoryVisual].chipBg,
                      color: IDENTIFICATION_GATE_THEME[identifyGateInventoryVisual].headline,
                    }}
                  >
                    {identifyGateStatusBadgeLabel(identifyGateInventoryVisual)}
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
                      className="mb-5 rounded-xl border px-3.5 py-3 text-[12px] sm:px-4"
                      style={{ borderColor: "rgba(148,163,184,0.25)", backgroundColor: "rgba(0,0,0,0.28)" }}
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
                    {identifyGateInventoryVisual === "manual_new"
                      ? "No manifest lines for this code — create a record or pick entity type."
                      : identifyGateInventoryVisual === "new"
                        ? "New on manifest — confirm entity and continue."
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
                      className="mt-2 rounded-lg border px-3 py-2 text-[11px] font-semibold leading-snug text-violet-100/95"
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
                      className="mt-2 rounded-lg border px-3 py-2 text-[11px] font-semibold leading-snug text-orange-100/95"
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
                      <div className="h-3.5 w-full overflow-hidden rounded-full bg-black/40 ring-1 ring-white/10">
                        <div
                          className="h-full rounded-full transition-[width] duration-300"
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

                  {identifyGateInventoryVisual !== "manual_new" ? (
                    <dl className="mt-4 space-y-2.5 text-[13px]">
                      <div className="flex justify-between gap-3">
                        <dt style={{ color: MUTED_LABEL }}>Product name</dt>
                        <dd className="max-w-[65%] text-right font-semibold text-white">{identifyGateProductDisplay}</dd>
                      </div>
                      {identifyGateViewHints?.carrier?.trim() ? (
                        <div className="flex justify-between gap-3">
                          <dt style={{ color: MUTED_LABEL }}>Carrier</dt>
                          <dd className="max-w-[65%] text-right font-semibold text-white">{identifyGateViewHints.carrier}</dd>
                        </div>
                      ) : null}
                      <div className="flex justify-between gap-3">
                        <dt style={{ color: MUTED_LABEL }}>Total expected qty</dt>
                        <dd
                          className={`font-mono text-[16px] font-black tabular-nums ${
                            identifyGateInventoryVisual === "unexpected" ? "text-violet-200 ring-1 ring-violet-400/50 rounded-lg px-2 py-0.5" : ""
                          }`}
                          style={identifyGateInventoryVisual === "unexpected" ? undefined : { color: TEAL_STEP }}
                        >
                          {identifyGateInventoryVisual === "unexpected"
                            ? 0
                            : identifyGateInventoryAgg && identifyGateInventoryAgg.totalExpected > 0
                              ? identifyGateInventoryAgg.totalExpected
                              : identifyGateSummary.totalExpectedQty}
                        </dd>
                      </div>
                      {identifyGateInventoryAgg ? (
                        <div className="flex justify-between gap-3">
                          <dt style={{ color: MUTED_LABEL }}>Total scanned (view)</dt>
                          <dd className="font-mono text-[15px] font-black tabular-nums text-white">
                            {identifyGateInventoryAgg.totalScanned}
                          </dd>
                        </div>
                      ) : null}
                    </dl>
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
                      <div className="overflow-x-auto rounded-xl ring-1 ring-white/10">
                        <table className="w-full min-w-[520px] border-collapse text-left text-[11px]">
                          <thead>
                            <tr className="border-b border-white/10 bg-black/25 text-[10px] font-black uppercase tracking-widest text-slate-400">
                              <th className="px-2 py-2">Product name</th>
                              <th className="px-2 py-2 font-mono">FNSKU</th>
                              <th className="px-2 py-2 text-right tabular-nums">Expected</th>
                              <th className="px-2 py-2 text-right tabular-nums">Scanned</th>
                              <th className="px-2 py-2">Status</th>
                            </tr>
                          </thead>
                          <tbody>
                            {identifyGateShipmentLines.map((row, idx) => {
                              const vis = shipmentLineStatusVisual(row.status);
                              const th = IDENTIFICATION_GATE_THEME[vis];
                              return (
                                <tr key={`${row.expected_package_id}-${idx}`} className="border-b border-white/5">
                                  <td className="max-w-[160px] px-2 py-2 font-semibold leading-snug text-white">
                                    {row.product_name?.trim() || "—"}
                                  </td>
                                  <td className="px-2 py-2 font-mono text-[11px] text-white/90">
                                    {row.fnsku?.trim() || row.asin?.trim() || "—"}
                                  </td>
                                  <td className="px-2 py-2 text-right font-mono tabular-nums text-white">{row.total_expected}</td>
                                  <td className="px-2 py-2 text-right font-mono tabular-nums text-white">{row.total_scanned}</td>
                                  <td className="px-2 py-2">
                                    <span
                                      className="inline-block rounded-lg px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ring-1"
                                      style={{
                                        borderColor: th.border,
                                        backgroundColor: th.chipBg,
                                        color: th.headline,
                                      }}
                                    >
                                      {String(row.status ?? "—").trim() || "—"}
                                    </span>
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  ) : null}

                  <p className="mt-4 text-[10px] font-bold uppercase tracking-widest text-slate-500">Entity type</p>
                  <div className="mt-2 grid grid-cols-3 gap-2">
                    {(
                      [
                        ["pallet", "Pallet"],
                        ["package", "Box"],
                        ["item", "Item"],
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
                          className="rounded-xl border py-3 text-[12px] font-bold transition active:scale-95"
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
                  {showIdentifyGatePhysicalBoxInput ? (
                    <div className="mt-4">
                      <div className="flex items-center justify-center gap-2">
                        <label
                          htmlFor={`${formId}-gate-physical`}
                          className="shrink-0 text-[11px] font-bold uppercase tracking-widest text-slate-300"
                        >
                          Box count:
                        </label>
                        <div
                          className={`flex items-stretch overflow-hidden rounded-md border-2 bg-[#060a10] shadow-[inset_0_1px_8px_rgba(0,0,0,0.55)] transition ${
                            identifyGateBoxCountShowsError
                              ? "border-red-500/80 focus-within:border-red-400 focus-within:shadow-[inset_0_1px_8px_rgba(0,0,0,0.55),0_0_0_3px_rgba(248,113,113,0.3)]"
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
                            className="flex h-9 w-9 shrink-0 items-center justify-center text-[18px] font-black text-slate-300 transition hover:bg-slate-700/40 active:scale-95 disabled:cursor-not-allowed disabled:opacity-35"
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
                            className="block h-9 w-[4.5rem] min-w-0 bg-transparent px-1 text-center font-mono text-[18px] font-black tabular-nums text-white outline-none"
                          />
                          <button
                            type="button"
                            aria-label="Increase box count"
                            onClick={() => {
                              const cur = Number.parseInt(identifyGatePhysicalBoxStr, 10);
                              const next = Number.isFinite(cur) ? Math.min(9999, cur + 1) : 1;
                              setIdentifyGatePhysicalBoxStr(String(next));
                            }}
                            className="flex h-9 w-9 shrink-0 items-center justify-center text-[18px] font-black text-slate-300 transition hover:bg-slate-700/40 active:scale-95"
                          >
                            +
                          </button>
                        </div>
                      </div>
                      {identifyGateBoxCountShowsError ? (
                        <p className="mt-1.5 text-center text-[11px] font-bold text-red-400" role="alert">
                          Enter box count (integer ≥ 1).
                        </p>
                      ) : (
                        <p className="mt-1.5 text-center text-[10px] font-semibold" style={{ color: MUTED_LABEL }}>
                          Cartons on this pallet (saved with the pallet).
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
                    className="mt-5 flex h-[52px] w-full items-center justify-center gap-2 rounded-[18px] text-[15px] font-bold shadow-[0_8px_24px_rgba(0,0,0,0.45)] transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-35"
                    style={{
                      background: `linear-gradient(180deg, ${IDENTIFICATION_GATE_THEME[identifyGateInventoryVisual].chipBg} 0%, rgba(15,23,42,0.95) 100%)`,
                      border: `2px solid ${IDENTIFICATION_GATE_THEME[identifyGateInventoryVisual].border}`,
                      color: IDENTIFICATION_GATE_THEME[identifyGateInventoryVisual].headline,
                    }}
                  >
                    {identifyGateInventoryVisual === "completed" ? (
                      <ThumbsUp className="h-5 w-5" strokeWidth={2.25} />
                    ) : null}
                    {identificationGatePrimaryCta(identifyGateInventoryVisual)}
                  </button>
                </div>
              </section>
            ) : null}
          </>
        ) : (
        <>
        {!isSupabaseConfigured() && flowPhase === "scan" ? (
          <p
            className="mb-3 rounded-xl border px-3 py-2 text-[11px] font-semibold"
            style={{ borderColor: "rgba(251,191,36,0.35)", backgroundColor: "rgba(69,26,3,0.35)", color: "#fde68a" }}
          >
            Demo — PLT-, TRACK-, BOX-, SLIP-, or SKU patterns. Supabase optional.
          </p>
        ) : null}

        {isSupabaseConfigured() && !operatorStoresLoading && flowPhase === "scan" && !kioskStoreLocked && operatorStores.length === 0 ? (
          <p
            className="mb-3 rounded-xl border px-3 py-2 text-[11px] font-semibold"
            style={{ borderColor: "rgba(248,113,113,0.35)", backgroundColor: "rgba(69,10,10,0.35)", color: "#fecaca" }}
          >
            No stores — add one in Settings, then refresh.
          </p>
        ) : null}

        {isSupabaseConfigured() && !operatorStoresLoading && flowPhase === "scan" && operatorStores.length > 0 && !sessionStoreId ? (
          <p
            className="mb-3 rounded-xl border px-3 py-2 text-[11px] font-semibold"
            style={{ borderColor: "rgba(248,113,113,0.35)", backgroundColor: "rgba(69,10,10,0.35)", color: "#fecaca" }}
          >
            Pick a store above to continue.
          </p>
        ) : null}

        {flowPhase === "scan" && parentIdentified ? (
          <>
            {activePallet?.id ? (
              <>
                {/* `relative z-30` lifts this section above subsequent sibling cards
                    (Pallet documentation, etc.). Each `glassCard` creates its own stacking
                    context via backdrop-filter, so without this the open Carrier combobox
                    panel would render UNDER the next card in DOM order. */}
                <section className={`relative z-30 mb-2 rounded-2xl p-2.5 ${glassCard}`}>
                  <div className="mb-2 flex items-center gap-2">
                    <ClipboardList className="h-4 w-4 shrink-0" strokeWidth={2} style={{ color: ACCENT_BLUE }} />
                    <h2 className="text-[14px] font-bold text-white">Shipment slip details</h2>
                  </div>
                  {shippingLabelPhotoUrls.length > 0 ? (
                    <p
                      className="mb-3 inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[10px] font-semibold uppercase tracking-wide"
                      style={{
                        borderColor: "rgba(52,211,153,0.4)",
                        backgroundColor: "rgba(6,78,59,0.35)",
                        color: SUCCESS,
                      }}
                    >
                      <CheckCircle2 className="h-3 w-3" strokeWidth={2.5} />
                      Shipping label photo attached
                    </p>
                  ) : null}
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <div>
                      <label
                        htmlFor={slipCarrierOrderEditable ? `${formId}-pallet-carrier` : undefined}
                        className="mb-1 block text-[10px] font-semibold uppercase tracking-widest"
                        style={{ color: MUTED_LABEL }}
                      >
                        Carrier{" "}
                        <span className="font-normal normal-case opacity-70">(optional)</span>
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
                              setPalletCarrier(name);
                            }}
                            onPickOther={() => {
                              setPalletCarrierOtherSelected(true);
                              if (isKnownCarrierName(palletCarrier)) {
                                setPalletCarrier("");
                              }
                            }}
                          />
                          {/* Conditional "Other" free-text input: only renders when
                              "Other / Not Listed" was explicitly selected from the
                              dropdown, even though we're already in global edit mode. */}
                          {palletCarrierOtherSelected ? (
                            <div className="relative z-50 mt-2">
                              <label
                                htmlFor={`${formId}-pallet-carrier-custom`}
                                className="mb-1 block text-[10px] font-semibold uppercase tracking-widest"
                                style={{ color: MUTED_LABEL }}
                              >
                                Enter Carrier Name{" "}
                                <span className="text-amber-400">*</span>
                              </label>
                              <input
                                id={`${formId}-pallet-carrier-custom`}
                                type="text"
                                value={palletCarrier}
                                onChange={(e) => setPalletCarrier(e.target.value)}
                                placeholder="Type here..."
                                autoComplete="off"
                                spellCheck={false}
                                className="relative z-50 h-9 w-full rounded-lg border border-amber-500/55 bg-white/95 px-3 text-[13px] text-zinc-900 outline-none placeholder:opacity-50 focus:border-teal-400 focus:shadow-[0_0_0_2px_rgba(45,212,191,0.22)] dark:bg-zinc-900/95 dark:text-zinc-50"
                              />
                            </div>
                          ) : (
                            <p
                              className="mt-1 text-[10px]"
                              style={{ color: MUTED_LABEL }}
                            >
                              Search by name or SCAC (e.g. EXLA). Auto-fills child
                              boxes.
                            </p>
                          )}
                        </>
                      ) : (
                        // Read-only display: shows the saved canonical name, the
                        // typed Other value, or an em-dash when nothing is set yet.
                        <div
                          className="block h-9 rounded-md border-2 border-slate-600/70 bg-[#060a10] px-3 leading-9 text-[13px] font-semibold text-white shadow-[inset_0_1px_8px_rgba(0,0,0,0.55)]"
                          aria-label={`Carrier: ${palletCarrier || "not set"}`}
                        >
                          {palletCarrier.trim().length > 0 ? (
                            palletCarrierOtherSelected ? (
                              <span>
                                <span className="opacity-60">Other:</span>{" "}
                                {palletCarrier}
                              </span>
                            ) : (
                              palletCarrier
                            )
                          ) : (
                            <span style={{ color: MUTED_LABEL }}>—</span>
                          )}
                        </div>
                      )}
                    </div>
                    <div>
                      <label
                        htmlFor={slipCarrierOrderEditable ? `${formId}-pallet-order-id` : undefined}
                        className="mb-1 block text-[10px] font-semibold uppercase tracking-widest"
                        style={{ color: MUTED_LABEL }}
                      >
                        Order ID{" "}
                        <span className="font-normal normal-case opacity-70">(optional)</span>
                      </label>
                      {slipCarrierOrderEditable ? (
                        <input
                          id={`${formId}-pallet-order-id`}
                          type="text"
                          autoComplete="off"
                          spellCheck={false}
                          value={palletOrderId}
                          onChange={(e) => setPalletOrderId(e.target.value)}
                          placeholder="114-XXXXXXX-XXXXXXX"
                          className="scanner-input-glass h-10 w-full rounded-lg border px-3 font-mono text-[13px] outline-none transition placeholder:opacity-50 focus:border-teal-400/45 focus:shadow-[0_0_0_2px_rgba(45,212,191,0.22)]"
                          style={{ color: TEXT_PRIMARY }}
                        />
                      ) : (
                        <div
                          className="block h-9 rounded-md border-2 border-slate-600/70 bg-[#060a10] px-3 font-mono leading-9 text-[13px] font-semibold text-white shadow-[inset_0_1px_8px_rgba(0,0,0,0.55)]"
                          aria-label={`Order ID: ${palletOrderId || "not set"}`}
                        >
                          {palletOrderId.trim().length > 0 ? (
                            palletOrderId
                          ) : (
                            <span style={{ color: MUTED_LABEL }}>—</span>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                </section>

                <section className={`mb-2 space-y-3 rounded-xl p-2.5 ${glassCard}`}>
                  <div className="flex items-center gap-2">
                    <ClipboardList className="h-4 w-4" strokeWidth={2} style={{ color: ACCENT_BLUE }} />
                    <p className="text-[13px] font-bold text-white">Pallet Documentation</p>
                  </div>
                  <MasterUploader
                    label="SHIPPING LABEL"
                    hint="Up to 3 images — stored as manifest_photo_url plus photo_evidence.label_urls."
                    value={shippingLabelPhotoUrls}
                    onChange={handleShippingLabelPhotoUrlsChange}
                    organizationId={orgId}
                    maxFiles={3}
                    disabled={!slipCarrierOrderEditable}
                  />
                  <MasterUploader
                    label="Pallet photo (optional)"
                    hint="Up to 3 images — stored as photo_url plus photo_evidence.pallet_urls."
                    value={palletPhotoUrls}
                    onChange={handlePalletPhotoUrlsChange}
                    organizationId={orgId}
                    maxFiles={3}
                    disabled={!slipCarrierOrderEditable}
                  />
                  <MasterUploader
                    label="Bill of Lading (optional)"
                    hint="Up to 3 images — stored as bol_photo_url plus photo_evidence.bol_urls."
                    value={bolPhotoUrls}
                    onChange={handleBolPhotoUrlsChange}
                    organizationId={orgId}
                    maxFiles={3}
                    disabled={!slipCarrierOrderEditable}
                  />
                </section>
              </>
            ) : null}

            <div className="mb-6 flex w-full justify-center px-4 pb-1">
              <div className="flex w-full max-w-md flex-wrap justify-center gap-4 sm:flex-nowrap">
                <button
                  type="button"
                  disabled={confirmSaving}
                  onClick={() => {
                    modalOpenRef.current = true;
                    setCancelShipmentConfirmOpen(true);
                  }}
                  className="flex h-[48px] min-h-[48px] min-w-[9.5rem] flex-1 items-center justify-center rounded-[14px] border-2 border-red-400/55 bg-transparent px-4 text-[13px] font-bold text-red-200 shadow-none transition hover:bg-red-500/10 active:scale-95 disabled:cursor-not-allowed disabled:opacity-35 sm:flex-1"
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
                  className="flex h-[48px] min-h-[48px] min-w-[9.5rem] flex-1 items-center justify-center gap-2 rounded-[14px] px-4 text-[14px] font-bold text-white shadow-[0_6px_18px_rgba(14,165,233,0.3)] transition hover:brightness-110 active:scale-95 disabled:cursor-not-allowed disabled:opacity-35 sm:flex-1"
                  style={{
                    background: `linear-gradient(180deg, ${ACTION_BLUE} 0%, ${ACTION_BLUE_DEEP} 100%)`,
                    boxShadow: isReadyForBoxScan ? `0 8px 22px rgba(14,165,233,0.38)` : undefined,
                  }}
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
          </>
        ) : null}

        {flowPhase === "scan" && !parentIdentified ? (
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
                >
                  <Barcode className="h-8 w-8 opacity-45" strokeWidth={1.25} style={{ color: MUTED_LABEL }} />
                </ScanFrameWithLaser>
              </div>

              <div className="mt-2">
                <label htmlFor={`${formId}-scan-manual`} className="mb-1 block text-[9px] font-semibold uppercase tracking-widest text-slate-500">
                  Manual entry
                </label>
                <div className="relative">
                  <input
                    id={`${formId}-scan-manual`}
                    value={scanLine}
                    onChange={(e) => setScanLine(e.target.value)}
                    onFocus={() => setManualOpen(true)}
                    onBlur={() => {
                      window.setTimeout(() => setManualOpen(false), 120);
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
                    placeholder="Barcode"
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
                </div>
              </div>
            </section>

            {palletIdentified ? (
              <section
                className="mb-4 flex items-center justify-between gap-3 rounded-[24px] border px-4 py-4"
                style={{
                  borderColor: "rgba(52,211,153,0.35)",
                  backgroundColor: "rgba(6,78,59,0.18)",
                  boxShadow: "0 0 24px rgba(52,211,153,0.12)",
                }}
              >
                <div className="min-w-0">
                  <p className="font-mono text-[17px] font-bold" style={{ color: SUCCESS }}>
                    {activePallet?.pallet_number}
                  </p>
                  <p className="mt-1 text-[11px] font-bold uppercase tracking-wide" style={{ color: "rgba(167,243,208,0.85)" }}>
                    Pallet Identified
                  </p>
                </div>
                <div
                  className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full ring-2"
                  style={{
                    backgroundColor: "rgba(52,211,153,0.15)",
                    color: SUCCESS,
                    borderColor: "rgba(52,211,153,0.35)",
                    boxShadow: "0 0 18px rgba(52,211,153,0.25)",
                  }}
                >
                  <CheckCircle2 className="h-8 w-8" strokeWidth={2.5} />
                </div>
              </section>
            ) : null}

            {trackingIdentified ? (
              <section
                className="mb-4 flex items-center justify-between gap-3 rounded-[24px] border px-4 py-4"
                style={{
                  borderColor: PURPLE_RING,
                  backgroundColor: BOX_PURPLE_SOFT_BG,
                  boxShadow: `0 0 24px ${PURPLE_GLOW}`,
                }}
              >
                <div className="min-w-0">
                  <p className="font-mono text-[15px] font-bold leading-snug sm:text-[17px]" style={{ color: ACTION_PURPLE }}>
                    {activePallet?.id
                      ? (currentPalletTrackingId ?? "").trim() || slipBarcodeExtract?.shipmentId?.trim() || "—"
                      : activeTracking ?? "—"}
                  </p>
                  <p className="mt-1 text-[11px] font-bold uppercase tracking-wide" style={{ color: "rgba(196,181,253,0.95)" }}>
                    Tracking · box-level parent
                  </p>
                </div>
                <div
                  className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full ring-2"
                  style={{
                    backgroundColor: "rgba(167,139,250,0.15)",
                    color: ACTION_PURPLE,
                    borderColor: PURPLE_RING,
                    boxShadow: `0 0 18px ${PURPLE_GLOW}`,
                  }}
                >
                  <ScanLine className="h-8 w-8" strokeWidth={2.5} />
                </div>
              </section>
            ) : null}

            <section className={`mb-4 grid gap-2.5 ${parentIdentified ? "grid-cols-3" : "grid-cols-2 sm:grid-cols-4"}`}>
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
                    value={String(scannedBoxesSavedCount)}
                    icon={ScanLine}
                    glow="green"
                    iconColor={SUCCESS}
                    valueColor={SUCCESS}
                  />
                  <PalletScanStatTile
                    label="Remaining Boxes"
                    value={
                      typeof physicalBoxCount === "number" && physicalBoxCount > 0
                        ? String(Math.max(0, physicalBoxCount - scannedBoxesSavedCount))
                        : "—"
                    }
                    icon={Package}
                    glow="purple"
                    iconColor={ACCENT_PURPLE}
                    valueColor="#e9d5ff"
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

            <section
              className={`mb-4 rounded-[24px] p-4 ${glassCard}`}
              style={{
                borderColor: parentIdentified ? (trackingIdentified ? PURPLE_RING : "rgba(45,212,191,0.35)") : BORDER,
                boxShadow: parentIdentified
                  ? trackingIdentified
                    ? `inset 0 0 0 1px rgba(167,139,250,0.12)`
                    : `inset 0 0 0 1px rgba(45,212,191,0.1)`
                  : undefined,
              }}
            >
              <div className="mb-2 flex flex-col gap-1">
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
          </>
        ) : null}

        {flowPhase === "package_scan" ? (
          <>
            {!parentIdentified ? (
              <p
                className="mb-4 rounded-[20px] border px-3.5 py-2.5 text-[12px] font-semibold"
                style={{ borderColor: "rgba(248,113,113,0.35)", backgroundColor: "rgba(69,10,10,0.35)", color: "#fecaca" }}
              >
                Identify a pallet or tracking parent before box intake.
              </p>
            ) : (
              <div className="flex flex-col gap-5">
                {isSupabaseConfigured() && !operatorStoresLoading && !kioskStoreLocked && operatorStores.length === 0 ? (
                  <p
                    className="mb-4 rounded-[20px] border px-3.5 py-2.5 text-[12px] font-semibold"
                    style={{ borderColor: "rgba(248,113,113,0.35)", backgroundColor: "rgba(69,10,10,0.35)", color: "#fecaca" }}
                  >
                    No active stores for this organization — add a store in Settings before saving boxes.
                  </p>
                ) : null}

                {isSupabaseConfigured() && !operatorStoresLoading && operatorStores.length > 0 && !sessionStoreId ? (
                  <p
                    className="mb-4 rounded-[20px] border px-3.5 py-2.5 text-[12px] font-semibold"
                    style={{ borderColor: "rgba(248,113,113,0.35)", backgroundColor: "rgba(69,10,10,0.35)", color: "#fecaca" }}
                  >
                    Select an active store above — saving boxes requires a store scope.
                  </p>
                ) : null}

                {boxIntakeError ? (
                  <p
                    className="mb-4 rounded-[20px] border px-3.5 py-2.5 text-[12px] font-semibold"
                    style={{ borderColor: "rgba(248,113,113,0.35)", backgroundColor: "rgba(69,10,10,0.35)", color: "#fecaca" }}
                  >
                    {boxIntakeError}
                  </p>
                ) : null}

                {/* Step 3 — Box intake only (carton evidence). Item barcodes belong in Step 4. */}
                <section
                  className={`mb-4 rounded-[24px] border p-4 ${glassCard}`}
                  style={{
                    borderColor: PURPLE_RING,
                    boxShadow: `0 12px 36px -14px ${PURPLE_GLOW}, inset 0 1px 0 rgba(255,255,255,0.05)`,
                  }}
                >
                  <div className="flex gap-4">
                    <div className="shrink-0" aria-hidden>
                      {trackingIdentified ? <TrackingParentIcon /> : <ParentType3DIcon />}
                    </div>
                    <div className="min-w-0 flex-1 space-y-3">
                      <div>
                        <p className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: MUTED_LABEL }}>
                          Shipment ID
                        </p>
                        <p className="mt-0.5 font-mono text-[17px] font-bold" style={{ color: ACTION_PURPLE }}>
                          {(currentPalletTrackingId ?? "").trim() || "—"}
                        </p>
                      </div>
                      <div className="flex flex-wrap gap-x-8 gap-y-2">
                        <div>
                          <p className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: MUTED_LABEL }}>
                            Expected Boxes
                          </p>
                          <p className="text-[20px] font-bold tabular-nums text-white">{physicalBoxCount ?? "—"}</p>
                        </div>
                        <div>
                          <p className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: MUTED_LABEL }}>
                            Scanned Boxes
                          </p>
                          <p className="text-[20px] font-bold tabular-nums" style={{ color: ACTION_PURPLE }}>
                            {scannedBoxesSavedCount}
                            <span className="text-[14px] font-semibold text-white/80">
                              {" "}
                              / {physicalBoxCount ?? "—"}
                            </span>
                          </p>
                        </div>
                      </div>
                      <div
                        className="h-2.5 w-full overflow-hidden rounded-full"
                        style={{ backgroundColor: CARD_INNER, border: `1px solid ${PURPLE_RING}` }}
                      >
                        <div
                          className="h-full rounded-full transition-[width] duration-500 ease-out"
                          style={{
                            width: `${Math.min(100, (scannedBoxesSavedCount / boxIntakeDenom) * 100)}%`,
                            backgroundColor: ACTION_PURPLE,
                            boxShadow: `0 0 14px ${PURPLE_GLOW}`,
                          }}
                        />
                      </div>
                    </div>
                  </div>
                </section>

                <p className="mb-3 text-center text-[17px] font-black tracking-tight" style={{ color: ACCENT_PURPLE }}>
                  Box {boxOrdinal} of{" "}
                  {typeof physicalBoxCount === "number" && physicalBoxCount > 0 ? physicalBoxCount : boxIntakeDenom}
                </p>
                {showSlipMatchedBadge ? (
                  <div className="-mt-2 mb-3 flex justify-center">
                    <span
                      className="rounded-full border px-3 py-1 text-[11px] font-black uppercase tracking-wide"
                      style={{ borderColor: SUCCESS, backgroundColor: SUCCESS_BG, color: SUCCESS }}
                    >
                      Slip matched
                    </span>
                  </div>
                ) : null}
                {activeBoxSession ? (
                  <p className="-mt-2 mb-3 text-center font-mono text-[11px] font-semibold" style={{ color: ACCENT_PURPLE }}>
                    Locked: {currentPackageTrackingId ?? activeBoxSession.barcode}
                  </p>
                ) : null}

                <section
                  className={`mb-4 rounded-[24px] p-4 ${glassCard}`}
                  style={{
                    borderColor: PURPLE_RING,
                    boxShadow: `inset 0 0 0 1px rgba(167,139,250,0.12)`,
                  }}
                >
                  <ScanFrameWithLaser
                    laserColor={ACTION_PURPLE}
                    cornerColor="rgba(167,139,250,0.5)"
                    subtleSweep
                    successFlash={scanSuccessFlash}
                    frameStyle={{
                      borderColor: "rgba(167,139,250,0.35)",
                      borderWidth: 1,
                      backgroundColor: "#090E1A",
                      boxShadow: "inset 0 1px 10px rgba(0,0,0,0.4)",
                    }}
                  >
                    <Barcode className="mb-2 h-12 w-12 opacity-50" strokeWidth={1.25} style={{ color: ACTION_PURPLE }} />
                    <p className="text-[15px] font-bold text-white">Scan box barcode</p>
                    <p className="mt-1 max-w-[280px] text-center text-[11px] font-medium leading-snug" style={{ color: MUTED_LABEL }}>
                      Locks carton to shipment. Item barcodes in the next step.
                    </p>
                  </ScanFrameWithLaser>
                  <div className="mt-3">
                    <label htmlFor={`${formId}-box-intake-manual`} className="text-[10px] font-bold uppercase tracking-[0.08em]" style={{ color: MUTED_LABEL }}>
                      Manual entry
                    </label>
                    <div className="mt-1.5 flex gap-2">
                      <input
                        id={`${formId}-box-intake-manual`}
                        value={currentPackageTrackingId ?? ""}
                        onChange={(e) => {
                          const v = e.target.value;
                          setCurrentPackageTrackingId(v === "" ? null : v);
                        }}
                        onFocus={() => setManualOpen(true)}
                        onBlur={() => {
                          window.setTimeout(() => setManualOpen(false), 120);
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
                        placeholder="Type box barcode if scanner fails"
                        disabled={Boolean(activeBoxSession)}
                        className="scanner-input-glass h-11 min-w-0 flex-1 rounded-xl border px-3 font-mono text-[14px] outline-none focus:ring-2 focus:ring-violet-500/40 disabled:opacity-45"
                        style={{ borderColor: PURPLE_RING, color: TEXT_PRIMARY }}
                      />
                    </div>
                  </div>
                  <button
                    type="button"
                    disabled={busy || !(currentPackageTrackingId ?? "").trim() || Boolean(activeBoxSession)}
                    onClick={() => void onSubmitScan()}
                    className="mt-4 flex h-[50px] w-full items-center justify-center gap-2 rounded-[16px] text-[15px] font-bold transition hover:brightness-110 disabled:opacity-40"
                    style={{
                      background: `linear-gradient(180deg, ${ACTION_PURPLE} 0%, ${ACTION_PURPLE_DEEP} 100%)`,
                      boxShadow: `0 6px 22px ${PURPLE_GLOW}`,
                      color: "#1e1b4b",
                    }}
                  >
                    <ScanLine className="h-5 w-5" strokeWidth={2} />
                    {busy ? "Saving…" : activeBoxSession ? "Box locked — save to continue" : "Apply scan"}
                  </button>
                </section>

                <section
                  className={`mb-4 rounded-[24px] border p-4 ${glassCard}`}
                  style={{ borderColor: PURPLE_RING }}
                >
                  <h2 className="mb-4 text-[15px] font-bold text-zinc-900 dark:text-white">Required Box Photos</h2>
                  <p className="mb-2 text-[11px] font-bold uppercase tracking-wide" style={{ color: MUTED_LABEL }}>
                    Slip photos <span className="font-normal normal-case">(up to 3 pages)</span>
                  </p>
                  <div className="mb-5 grid grid-cols-3 gap-2">
                    <div
                      className="flex flex-col items-center rounded-xl border px-2 py-3 text-center"
                      style={{ borderColor: PURPLE_RING, backgroundColor: "#090E1A" }}
                    >
                      <p className="text-[10px] font-bold text-white">Slip 1</p>
                      {slipPhoto1Url ? (
                        <div className="relative mt-2 aspect-square w-full max-w-[92px] overflow-hidden rounded-lg border" style={{ borderColor: PURPLE_RING }}>
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src={slipPhoto1Url} alt="" className="h-full w-full object-cover" />
                          {slipVisionProcessing ? (
                            <div className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 bg-black/68 backdrop-blur-[1px]">
                              <div className="relative h-10 w-[90%] overflow-hidden rounded-md">
                                <div className="pointer-events-none absolute inset-0 overflow-hidden rounded-[inherit]" aria-hidden>
                                  <div
                                    className="operator-scan-laser-beam absolute left-1/2 top-1/2 h-[2px] w-[92%] -translate-x-1/2 rounded-full"
                                    style={{
                                      boxShadow: `0 0 12px ${ACTION_PURPLE}`,
                                      background: `linear-gradient(90deg, transparent 0%, ${ACTION_PURPLE} 45%, transparent 100%)`,
                                    }}
                                  />
                                </div>
                              </div>
                              <span className="px-1 text-[8px] font-bold leading-tight text-white">GPT-4o Vision</span>
                              <Loader2 className="h-4 w-4 animate-spin text-violet-300" strokeWidth={2.5} />
                            </div>
                          ) : null}
                        </div>
                      ) : (
                        <Camera className="mt-2 h-7 w-7 opacity-80" style={{ color: ACTION_PURPLE }} strokeWidth={2} />
                      )}
                      {slipPhoto1Url && !slipVisionProcessing ? (
                        <span className="mt-1 inline-flex items-center gap-0.5 text-[9px] font-bold" style={{ color: SUCCESS }}>
                          <CheckCircle2 className="h-3 w-3" strokeWidth={2} />
                          Captured
                        </span>
                      ) : !slipPhoto1Url ? (
                        <span className="mt-1 text-[9px] font-semibold" style={{ color: MUTED_LABEL }}>
                          —
                        </span>
                      ) : null}
                    </div>
                    <div
                      className="flex flex-col items-center rounded-xl border px-2 py-3 text-center"
                      style={{ borderColor: PURPLE_RING, backgroundColor: "#090E1A" }}
                    >
                      <Camera className="h-7 w-7 opacity-80" style={{ color: ACTION_PURPLE }} strokeWidth={2} />
                      <p className="mt-2 text-[10px] font-bold text-white">Slip 2</p>
                      {slipPhoto2Url ? (
                        <span className="mt-1 inline-flex items-center gap-0.5 text-[9px] font-bold" style={{ color: SUCCESS }}>
                          <CheckCircle2 className="h-3 w-3" strokeWidth={2} />
                          Captured
                        </span>
                      ) : (
                        <span className="mt-1 text-[9px] font-semibold" style={{ color: MUTED_LABEL }}>
                          Optional
                        </span>
                      )}
                    </div>
                    <div
                      className="flex flex-col items-center rounded-xl border px-2 py-3 text-center"
                      style={{ borderColor: "rgba(148,163,184,0.2)", backgroundColor: "#090E1A" }}
                    >
                      <Camera className="h-7 w-7 opacity-40" style={{ color: MUTED_LABEL }} strokeWidth={2} />
                      <p className="mt-2 text-[10px] font-bold text-white">Slip 3</p>
                      <span className="mt-1 text-[9px] font-semibold" style={{ color: MUTED_LABEL }}>
                        Not needed
                      </span>
                    </div>
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="rounded-xl border p-3" style={{ borderColor: PURPLE_RING, backgroundColor: "#090E1A" }}>
                      <p className="text-[12px] font-bold text-white">Carton condition photo</p>
                      <input
                        ref={cartonPhotoRef}
                        type="file"
                        accept="image/*"
                        capture="environment"
                        className="sr-only"
                        onChange={(e) => onCartonOrTrackerFile("carton", e.target.files?.[0])}
                      />
                      <button
                        type="button"
                        onClick={() => cartonPhotoRef.current?.click()}
                        className="mt-3 flex w-full flex-col items-center justify-center gap-2 rounded-lg border border-dashed py-7 transition hover:bg-violet-500/5"
                        style={{ borderColor: PURPLE_RING }}
                      >
                        {cartonPhotoUrl ? (
                          <>
                            <img src={cartonPhotoUrl} alt="" className="h-20 w-full rounded-md object-cover" />
                            <span className="text-[11px] font-bold" style={{ color: SUCCESS }}>
                              Captured
                            </span>
                          </>
                        ) : (
                          <>
                            <Camera className="h-8 w-8 opacity-75" style={{ color: ACTION_PURPLE }} strokeWidth={2} />
                            <span className="text-[11px] font-semibold" style={{ color: MUTED_LABEL }}>
                              Not captured
                            </span>
                          </>
                        )}
                      </button>
                    </div>
                    <div className="rounded-xl border p-3" style={{ borderColor: PURPLE_RING, backgroundColor: "#090E1A" }}>
                      <p className="text-[12px] font-bold text-white">Tracker label photo</p>
                      <input
                        ref={trackerPhotoRef}
                        type="file"
                        accept="image/*"
                        capture="environment"
                        className="sr-only"
                        onChange={(e) => onCartonOrTrackerFile("tracker", e.target.files?.[0])}
                      />
                      <button
                        type="button"
                        onClick={() => trackerPhotoRef.current?.click()}
                        className="mt-3 flex w-full flex-col items-center justify-center gap-2 rounded-lg border border-dashed py-7 transition hover:bg-violet-500/5"
                        style={{ borderColor: PURPLE_RING }}
                      >
                        {trackerPhotoUrl ? (
                          <>
                            <img src={trackerPhotoUrl} alt="" className="h-20 w-full rounded-md object-cover" />
                            <span className="text-[11px] font-bold" style={{ color: SUCCESS }}>
                              Captured
                            </span>
                          </>
                        ) : (
                          <>
                            <Camera className="h-8 w-8 opacity-75" style={{ color: ACTION_PURPLE }} strokeWidth={2} />
                            <span className="text-[11px] font-semibold" style={{ color: MUTED_LABEL }}>
                              Not captured
                            </span>
                          </>
                        )}
                      </button>
                    </div>
                  </div>
                </section>

                <section
                  className={`mb-4 rounded-[24px] border p-4 ${glassCard}`}
                  style={{ borderColor: PURPLE_RING }}
                >
                  <h3 className="text-[15px] font-bold text-zinc-900 dark:text-white">AI Slip Reading</h3>
                  <p className="mt-1 text-[12px] font-medium leading-relaxed" style={{ color: MUTED_LABEL }}>
                    GPT-4o Vision runs only when you tap the button below (not on scan or photo capture).
                  </p>
                  <button
                    type="button"
                    disabled={
                      !slipPhoto1Url ||
                      slipVisionProcessing ||
                      !(getAIUnifiedKeyFromStorage() || getOpenAIApiKeyFromStorage())
                    }
                    onClick={() => void runManualSlipVisionFromCapture()}
                    className="mt-4 flex h-[46px] w-full items-center justify-center gap-2 rounded-[14px] text-[13px] font-bold transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-45"
                    style={{
                      background: `linear-gradient(180deg, ${ACTION_PURPLE} 0%, ${ACTION_PURPLE_DEEP} 100%)`,
                      color: "#1e1b4b",
                      boxShadow: `0 6px 18px ${PURPLE_GLOW}`,
                    }}
                  >
                    {slipVisionProcessing ? (
                      <>
                        <Loader2 className="h-5 w-5 animate-spin" strokeWidth={2} />
                        Running slip OCR…
                      </>
                    ) : (
                      <>
                        <Camera className="h-5 w-5" strokeWidth={2} />
                        Run slip OCR (manual)
                      </>
                    )}
                  </button>
                  <div className="mt-5 flex items-start justify-between gap-1 px-0.5">
                    <div className="flex min-w-0 flex-1 flex-col items-center text-center">
                      <div className="flex h-9 w-9 items-center justify-center rounded-full" style={{ backgroundColor: BOX_PURPLE_SOFT_BG }}>
                        {slipPagesCaptured > 0 ? (
                          <CheckCircle2 className="h-5 w-5" style={{ color: SUCCESS }} strokeWidth={2.25} />
                        ) : (
                          <span className="h-2 w-2 rounded-full bg-slate-500" />
                        )}
                      </div>
                      <p className="mt-2 text-[10px] font-bold leading-tight text-white sm:text-[11px]">
                        {slipPagesCaptured} {slipPagesCaptured === 1 ? "page" : "pages"} captured
                      </p>
                    </div>
                    <div
                      className="mx-0.5 mt-[18px] h-[3px] min-w-[8px] flex-1 max-w-[48px] rounded-full sm:max-w-none"
                      style={{
                        backgroundColor: aiSlipReaderPhase === "idle" ? "rgba(51,65,85,0.6)" : BOX_PURPLE_TRACK,
                      }}
                      aria-hidden
                    />
                    <div className="flex min-w-0 flex-1 flex-col items-center text-center">
                      <div
                        className="flex h-9 w-9 items-center justify-center rounded-full"
                        style={{
                          backgroundColor:
                            aiSlipReaderPhase === "reading" ? BOX_PURPLE_SOFT_BG : "rgba(51,65,85,0.5)",
                        }}
                      >
                        {aiSlipReaderPhase === "reading" ? (
                          <Loader2 className="h-5 w-5 animate-spin" style={{ color: ACTION_PURPLE }} strokeWidth={2.25} />
                        ) : aiSlipReaderPhase === "matched" ? (
                          <CheckCircle2 className="h-5 w-5" style={{ color: SUCCESS }} strokeWidth={2.25} />
                        ) : (
                          <span className="h-2 w-2 rounded-full bg-slate-500" />
                        )}
                      </div>
                      <p
                        className="mt-2 text-[10px] font-bold leading-tight sm:text-[11px]"
                        style={{ color: aiSlipReaderPhase === "reading" ? ACTION_PURPLE : MUTED_LABEL }}
                      >
                        {aiSlipReaderPhase === "reading"
                          ? "Reading slip images…"
                          : aiSlipReaderPhase === "matched"
                            ? "Read complete"
                            : "Awaiting slips"}
                      </p>
                    </div>
                    <div
                      className="mx-0.5 mt-[18px] h-[3px] min-w-[8px] flex-1 max-w-[48px] rounded-full sm:max-w-none"
                      style={{
                        backgroundColor: aiSlipReaderPhase === "matched" ? BOX_PURPLE_TRACK : "rgba(51,65,85,0.6)",
                      }}
                      aria-hidden
                    />
                    <div className="flex min-w-0 flex-1 flex-col items-center text-center">
                      <div className="flex h-9 w-9 items-center justify-center rounded-full" style={{ backgroundColor: BOX_PURPLE_SOFT_BG }}>
                        {showSlipMatchedBadge || aiSlipReaderPhase === "matched" ? (
                          <CheckCircle2 className="h-5 w-5" style={{ color: SUCCESS }} strokeWidth={2.25} />
                        ) : (
                          <span className="h-2 w-2 rounded-full bg-slate-500" />
                        )}
                      </div>
                      <p
                        className="mt-2 text-[10px] font-bold leading-tight sm:text-[11px]"
                        style={{
                          color: showSlipMatchedBadge || aiSlipReaderPhase === "matched" ? SUCCESS : MUTED_LABEL,
                        }}
                      >
                        {showSlipMatchedBadge
                          ? "Slip matched"
                          : aiSlipReaderPhase === "matched"
                            ? "Matched to expected items"
                            : "Pending match"}
                      </p>
                    </div>
                  </div>
                </section>

                {expectedPkgLines.length > 0 ? (
                  <section
                    id="expected-intake-table"
                    className={`mb-4 scroll-mt-4 rounded-[24px] p-4 ${glassCard}`}
                    style={{ borderColor: PURPLE_RING }}
                  >
                    <div className="mb-3 flex flex-col gap-1">
                      <h3 className="text-[14px] font-bold text-zinc-900 dark:text-white">Shipment lines (reference)</h3>
                      <p className="text-[11px] font-medium leading-snug" style={{ color: MUTED_LABEL }}>
                        For slip alignment only. Scan each product inside the carton in Step 4 — Item Inspection.
                      </p>
                    </div>
                    <div
                      className="max-h-[min(48vh,260px)] overflow-auto rounded-xl border"
                      style={{ borderColor: PURPLE_RING, backgroundColor: "#090E1A" }}
                    >
                      <table className="w-full min-w-[300px] border-collapse text-left text-[11px]">
                        <thead className="sticky top-0 z-[1]" style={{ backgroundColor: CARD_INNER, color: MUTED_LABEL }}>
                          <tr>
                            <th className="px-2 py-2 font-bold">SKU</th>
                            <th className="px-2 py-2 font-bold">Description</th>
                            <th className="px-2 py-2 font-bold tabular-nums">Expected</th>
                            <th className="px-2 py-2 font-bold tabular-nums">Slip</th>
                            <th className="px-2 py-2 font-bold">Status</th>
                          </tr>
                        </thead>
                        <tbody>
                          {expectedPkgLines.map((line) => {
                            const slipQty = aiSlipReaderPhase === "matched" ? line.expectedQty : null;
                            const matched = slipQty !== null && slipQty === line.expectedQty;
                            return (
                              <tr key={line.groupKey} className="border-t border-slate-800/90" style={{ color: TEXT_PRIMARY }}>
                                <td className="px-2 py-2 font-mono font-semibold">{line.sku || "—"}</td>
                                <td className="max-w-[130px] truncate px-2 py-2 font-medium">{line.productLabel}</td>
                                <td className="px-2 py-2 font-mono tabular-nums font-bold" style={{ color: ACTION_PURPLE }}>
                                  {line.expectedQty}
                                </td>
                                <td className="px-2 py-2 font-mono tabular-nums" style={{ color: ACCENT_BLUE }}>
                                  {slipQty ?? "—"}
                                </td>
                                <td className="px-2 py-2">
                                  {matched ? (
                                    <span className="inline-flex items-center gap-0.5 font-bold" style={{ color: SUCCESS }}>
                                      <CheckCircle2 className="h-3.5 w-3.5" strokeWidth={2} />
                                      Match
                                    </span>
                                  ) : (
                                    <span style={{ color: MUTED_LABEL }}>—</span>
                                  )}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                    <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                      <span className="text-[11px] font-bold" style={{ color: aiSlipReaderPhase === "matched" ? SUCCESS : MUTED_LABEL }}>
                        {aiSlipReaderPhase === "matched"
                          ? `${matchedItemsPreviewCount} of ${expectedPkgLines.length} items matched`
                          : "Run AI slip reading to populate Slip & Status."}
                      </span>
                      <button
                        type="button"
                        className="text-[11px] font-bold transition hover:brightness-125"
                        style={{ color: ACTION_PURPLE }}
                        onClick={() => document.getElementById("expected-intake-table")?.scrollIntoView({ behavior: "smooth", block: "start" })}
                      >
                        View all items &gt;
                      </button>
                    </div>
                  </section>
                ) : null}

                <button
                  type="button"
                  disabled={!activeBoxSession || busy}
                  onClick={() => saveBoxAndContinue()}
                  className="mb-2 flex h-[54px] w-full items-center justify-center gap-2 rounded-[18px] text-[16px] font-black text-[#042f2e] shadow-[0_10px_28px_rgba(45,212,191,0.35)] transition hover:brightness-110 active:scale-95 disabled:cursor-not-allowed disabled:opacity-35"
                  style={{
                    background: `linear-gradient(180deg, ${TEAL_STEP} 0%, #14b8a6 55%, #0d9488 100%)`,
                  }}
                >
                  <PackageOpen className="h-5 w-5" strokeWidth={2.25} />
                  Save Box & Continue
                </button>
                <p className="mb-4 flex items-center justify-center gap-1.5 text-center text-[11px] font-semibold" style={{ color: SUCCESS }}>
                  <CheckCircle2 className="h-3.5 w-3.5" strokeWidth={2} />
                  Auto-saves progress
                </p>

                <button
                  type="button"
                  onClick={() => beginItemPhase()}
                  className="mb-6 w-full rounded-[16px] border py-3 text-[12px] font-bold transition hover:bg-white/5"
                  style={{ borderColor: PURPLE_RING, color: ACCENT_PURPLE }}
                >
                  Continue to Item Inspection →
                </button>
              </div>
            )}
          </>
        ) : null}

        {flowPhase === "items" ? (
          <div className="flex flex-col gap-5">
            {!hasItemReceivableBox ? (
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
                  onClick={() => setFlowPhase("package_scan")}
                >
                  Back to Box Intake
                </button>
              </section>
            ) : (
              <>
                {isSupabaseConfigured() && !operatorStoresLoading && !kioskStoreLocked && operatorStores.length === 0 ? (
              <p
                className="mb-4 rounded-[20px] border px-3.5 py-2.5 text-[12px] font-semibold"
                style={{ borderColor: "rgba(248,113,113,0.35)", backgroundColor: "rgba(69,10,10,0.35)", color: "#fecaca" }}
              >
                No active stores for this organization — add a store in Settings before receiving items.
              </p>
            ) : null}

            {isSupabaseConfigured() && !operatorStoresLoading && operatorStores.length > 0 && !sessionStoreId ? (
              <p
                className="mb-4 rounded-[20px] border px-3.5 py-2.5 text-[12px] font-semibold"
                style={{ borderColor: "rgba(248,113,113,0.35)", backgroundColor: "rgba(69,10,10,0.35)", color: "#fecaca" }}
              >
                Select an active store above to save returns and update receiving data.
              </p>
            ) : null}

            {itemScanPackageId && !isUuidString(itemScanPackageId) && isSupabaseConfigured() ? (
              <p
                className="mb-4 rounded-[20px] border px-3.5 py-2.5 text-[12px] font-semibold"
                style={{ borderColor: "rgba(251,191,36,0.45)", backgroundColor: "rgba(69,26,3,0.35)", color: "#fde68a" }}
              >
                Demo mode — saves are not linked to a live box record until you intake one.
              </p>
            ) : null}

            {itemTrackingExpectationsHint ? (
              <p
                className="mb-4 rounded-[20px] border px-3.5 py-2.5 text-[12px] font-semibold"
                style={{ borderColor: "rgba(251,191,36,0.45)", backgroundColor: "rgba(69,26,3,0.35)", color: "#fde68a" }}
              >
                {itemTrackingExpectationsHint}
              </p>
            ) : null}

            {itemBarcodeMiss ? (
              <p
                className="mb-4 rounded-[20px] border px-3.5 py-2.5 text-[12px] font-semibold"
                style={{ borderColor: "rgba(248,113,113,0.35)", backgroundColor: "rgba(69,10,10,0.35)", color: "#fecaca" }}
              >
                {itemBarcodeMiss}
              </p>
            ) : null}

            {itemReceiveError ? (
              <p
                className="mb-4 rounded-[20px] border px-3.5 py-2.5 text-[12px] font-semibold"
                style={{ borderColor: "rgba(248,113,113,0.35)", backgroundColor: "rgba(69,10,10,0.35)", color: "#fecaca" }}
              >
                {itemReceiveError}
              </p>
            ) : null}

            {itemDraft ? (
              <section
                className={`mb-4 rounded-[24px] border p-4 ${glassCard}`}
                style={{ borderColor: "rgba(45,212,191,0.22)" }}
              >
                <div className="flex gap-3">
                  <div
                    className="relative h-[88px] w-[88px] shrink-0 overflow-hidden rounded-[18px] ring-1 ring-white/10"
                    style={{ backgroundColor: "#090E1A" }}
                  >
                    {itemDraft.catalogImageUrl ? (
                      <img src={itemDraft.catalogImageUrl} alt="" className="h-full w-full object-cover" />
                    ) : (
                      <div className="flex h-full w-full items-center justify-center">
                        <Package className="h-10 w-10 opacity-40" style={{ color: MUTED_LABEL }} strokeWidth={1.25} />
                      </div>
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <p className="text-[15px] font-bold leading-snug text-white">
                        {itemDraft.catalogName ??
                          expectedPkgLines.find(
                            (l) => l.sku === String(itemDraft.epRow.sku ?? "").trim() && l.fnsku === String(itemDraft.epRow.fnsku ?? "").trim(),
                          )?.productLabel ??
                          String(itemDraft.epRow.sku ?? "SKU")}
                      </p>
                      <span
                        className="shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-bold"
                        style={{
                          borderColor: "rgba(56,189,248,0.35)",
                          backgroundColor: "rgba(56,189,248,0.12)",
                          color: ACCENT_BLUE,
                        }}
                      >
                        In Progress
                      </span>
                    </div>
                    <p className="mt-2 font-mono text-[11px] font-semibold leading-relaxed" style={{ color: MUTED_LABEL }}>
                      SKU {String(itemDraft.epRow.sku ?? "—")} · FNSKU {String(itemDraft.epRow.fnsku ?? "—")}
                      {String((itemDraft.epRow as { asin?: string }).asin ?? "").trim()
                        ? ` · ASIN ${String((itemDraft.epRow as { asin?: string }).asin)}`
                        : ""}
                    </p>
                    <div className="mt-3 grid grid-cols-3 gap-2 text-center">
                      <div className="rounded-xl py-2 ring-1 ring-white/10" style={{ backgroundColor: "#090E1A" }}>
                        <p className="text-[10px] font-bold uppercase tracking-wide" style={{ color: MUTED_LABEL }}>
                          Expected
                        </p>
                        <p className="mt-0.5 text-[18px] font-black tabular-nums text-white">
                          {Number(itemsLiveEpRow?.expected_scan_quantity ?? 0)}
                        </p>
                      </div>
                      <div className="rounded-xl py-2 ring-1 ring-emerald-500/25" style={{ backgroundColor: "#090E1A" }}>
                        <p className="text-[10px] font-bold uppercase tracking-wide" style={{ color: MUTED_LABEL }}>
                          Scanned
                        </p>
                        <p className="mt-0.5 text-[18px] font-black tabular-nums" style={{ color: SUCCESS }}>
                          {Number(itemsLiveEpRow?.actual_scanned_count ?? 0)}
                        </p>
                      </div>
                      <div className="rounded-xl py-2 ring-1 ring-white/10" style={{ backgroundColor: "#090E1A" }}>
                        <p className="text-[10px] font-bold uppercase tracking-wide" style={{ color: MUTED_LABEL }}>
                          Remaining
                        </p>
                        <p className="mt-0.5 text-[18px] font-black tabular-nums" style={{ color: "#fbbf24" }}>
                          {Math.max(
                            0,
                            Number(itemsLiveEpRow?.expected_scan_quantity ?? 0) -
                              Number(itemsLiveEpRow?.actual_scanned_count ?? 0),
                          )}
                        </p>
                      </div>
                    </div>

                    <div className="mt-4 flex flex-wrap gap-2">
                      <span
                        className="rounded-full border px-2.5 py-1 text-[10px] font-bold"
                        style={
                          itemsIdentifierPerfect
                            ? {
                                borderColor: "rgba(52,211,153,0.45)",
                                backgroundColor: "rgba(6,78,59,0.35)",
                                color: "#6ee7b7",
                              }
                            : {
                                borderColor: "rgba(251,191,36,0.45)",
                                backgroundColor: "rgba(69,26,3,0.45)",
                                color: "#fde68a",
                              }
                        }
                      >
                        {itemsIdentifierPerfect
                          ? `Identifier matched (${itemDraft.tier.toUpperCase()})`
                          : `Verify identifier (${itemDraft.tier.toUpperCase()})`}
                      </span>
                      {itemsProductNamePerfect ? (
                        <span
                          className="rounded-full border px-2.5 py-1 text-[10px] font-bold"
                          style={{
                            borderColor: "rgba(52,211,153,0.45)",
                            backgroundColor: "rgba(6,78,59,0.35)",
                            color: "#6ee7b7",
                          }}
                        >
                          Product name matched
                        </span>
                      ) : itemDraft.catalogName?.trim() && itemsLineForDraft?.productLabel?.trim() ? (
                        <span
                          className="rounded-full border px-2.5 py-1 text-[10px] font-bold"
                          style={{
                            borderColor: "rgba(248,113,113,0.45)",
                            backgroundColor: "rgba(127,29,29,0.35)",
                            color: "#fecaca",
                          }}
                        >
                          Product name differs
                        </span>
                      ) : (
                        <span
                          className="rounded-full border px-2.5 py-1 text-[10px] font-bold"
                          style={{
                            borderColor: "rgba(56,189,248,0.35)",
                            backgroundColor: "rgba(14,165,233,0.12)",
                            color: ACCENT_BLUE,
                          }}
                        >
                          Name check pending
                        </span>
                      )}
                      <span
                        className="rounded-full border px-2.5 py-1 text-[10px] font-bold"
                        style={
                          itemsIdentifierPerfect
                            ? {
                                borderColor: "rgba(52,211,153,0.45)",
                                backgroundColor: "rgba(6,78,59,0.35)",
                                color: "#6ee7b7",
                              }
                            : {
                                borderColor: "rgba(56,189,248,0.35)",
                                backgroundColor: "rgba(14,165,233,0.12)",
                                color: ACCENT_BLUE,
                              }
                        }
                      >
                        {itemsIdentifierPerfect ? "OCR not needed" : "Confirm barcode"}
                      </span>
                      {inspectionCondition !== "good" ? (
                        <span
                          className="rounded-full border px-2.5 py-1 text-[10px] font-bold"
                          style={{
                            borderColor: "rgba(251,191,36,0.45)",
                            backgroundColor: "rgba(69,26,3,0.45)",
                            color: "#fde68a",
                          }}
                        >
                          Review: issue selected
                        </span>
                      ) : null}
                    </div>
                  </div>
                </div>
              </section>
            ) : null}

            <section
              className={`mb-4 rounded-[24px] p-4 ${glassCard}`}
              style={{
                borderColor: "rgba(45,212,191,0.35)",
                boxShadow: `inset 0 0 0 1px rgba(45,212,191,0.08)`,
              }}
            >
              <p className="text-center text-[16px] font-bold text-zinc-900 dark:text-white">Scan product barcode</p>
              <p className="mt-1 text-center text-[11px] font-medium leading-snug" style={{ color: MUTED_LABEL }}>
                Units in the open carton — UPC, FNSKU, ASIN, or SKU on expected lines.
              </p>
              <div className="mt-4">
                <ScanFrameWithLaser
                  laserColor={TEAL_STEP}
                  cornerColor="rgba(45,212,191,0.55)"
                  subtleSweep
                  successFlash={scanSuccessFlash}
                  frameStyle={{
                    borderColor: "rgba(45,212,191,0.32)",
                    borderWidth: 1,
                    backgroundColor: "#090E1A",
                    boxShadow: "inset 0 1px 10px rgba(0,0,0,0.4)",
                  }}
                >
                  <Barcode className="mb-2 h-12 w-12 opacity-80" strokeWidth={1.25} style={{ color: TEAL_STEP }} />
                </ScanFrameWithLaser>
              </div>
              <button
                type="button"
                disabled={busy || !scanLine.trim()}
                onClick={() => void onSubmitScan()}
                className="mt-4 flex h-[50px] w-full items-center justify-center gap-2 rounded-[16px] text-[15px] font-bold text-white transition hover:brightness-110 disabled:opacity-40"
                style={{
                  background: `linear-gradient(180deg, ${TEAL_STEP} 0%, #14b8a6 100%)`,
                  boxShadow: "0 8px 24px rgba(45,212,191,0.35)",
                }}
              >
                <ScanLine className="h-5 w-5" strokeWidth={2} />
                {busy ? "Working…" : "Apply scan"}
              </button>
            </section>

            <section className={`mb-4 rounded-[24px] border p-4 ${glassCard}`}>
              <div className="mb-3 flex items-center justify-between gap-2">
                <h3 className="text-[14px] font-bold text-white">Required photos</h3>
                <span className="text-[11px] font-bold tabular-nums" style={{ color: TEAL_STEP }}>
                  {[itemPhotoFrontUrl, itemPhotoBarcodeUrl, itemPhotoDamageUrl].filter(Boolean).length} of 3 captured
                </span>
              </div>
              <div className="grid grid-cols-3 gap-2">
                {(
                  [
                    ["front", "Item front", itemPhotoFrontRef, itemPhotoFrontUrl, "front"] as const,
                    ["barcode", "Barcode label", itemPhotoBarcodeRef, itemPhotoBarcodeUrl, "barcode"] as const,
                    ["damage", "Damage detail", itemPhotoDamageRef, itemPhotoDamageUrl, "damage"] as const,
                  ] as const
                ).map(([key, label, ref, url, which]) => (
                  <div key={key} className="flex flex-col items-center rounded-xl border px-2 py-3 text-center" style={{ borderColor: BORDER, backgroundColor: "#090E1A" }}>
                    <input
                      ref={ref}
                      type="file"
                      accept="image/*"
                      capture="environment"
                      className="sr-only"
                      onChange={(e) => onItemPhotoFile(which, e.target.files?.[0])}
                    />
                    <button type="button" onClick={() => ref.current?.click()} className="flex flex-col items-center gap-1">
                      <Camera className="h-7 w-7 opacity-80" style={{ color: TEAL_STEP }} strokeWidth={2} />
                      <span className="text-[10px] font-bold text-white">{label}</span>
                      {url ? (
                        <span className="mt-1 inline-flex items-center gap-0.5 text-[9px] font-bold" style={{ color: SUCCESS }}>
                          <CheckCircle2 className="h-3 w-3" strokeWidth={2} />
                          Captured
                        </span>
                      ) : (
                        <span className="mt-1 text-[9px] font-semibold" style={{ color: MUTED_LABEL }}>
                          Not captured
                        </span>
                      )}
                    </button>
                  </div>
                ))}
              </div>
            </section>

            <section className={`mb-4 rounded-[24px] border p-4 ${glassCard}`}>
              <h3 className="mb-3 text-[14px] font-bold text-white">Item condition</h3>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                {(
                  [
                    ["good", "Good", ThumbsUp],
                    ["damaged", "Damaged", AlertTriangle],
                    ["expired", "Expired", Calendar],
                    ["open_box", "Open box", Package2],
                    ["missing_parts", "Missing parts", Puzzle],
                  ] as const
                ).map(([id, label, Icon]) => {
                  const selected = inspectionCondition === id;
                  return (
                    <button
                      key={id}
                      type="button"
                      onClick={() => setInspectionCondition(id as InspectionCondition)}
                      className="flex min-h-[58px] items-center justify-center gap-2.5 rounded-xl border px-2 py-4 text-[13px] font-bold transition active:scale-95"
                      style={{
                        borderColor: selected ? TEAL_STEP : BORDER,
                        backgroundColor: selected ? "rgba(45,212,191,0.12)" : "#090E1A",
                        color: selected ? TEAL_STEP : TEXT_PRIMARY,
                        boxShadow: selected ? `0 0 0 1px ${TEAL_STEP}` : undefined,
                      }}
                    >
                      <Icon className="h-5 w-5 shrink-0" strokeWidth={2} />
                      {label}
                    </button>
                  );
                })}
              </div>

              {itemDraft?.expirationSupported || inspectionCondition === "expired" ? (
                <div className="mt-4">
                  <label className="text-[11px] font-bold uppercase tracking-wide" style={{ color: MUTED_LABEL }}>
                    Expiration date{" "}
                    {itemDraft?.expirationSupported || inspectionCondition === "expired" ? "(required)" : ""}
                  </label>
                  <input
                    type="date"
                    value={itemExpiryDate}
                    onChange={(e) => setItemExpiryDate(e.target.value)}
                    className="mt-2 h-12 w-full rounded-xl border-2 px-3 font-mono text-sm text-white outline-none focus:ring-2 focus:ring-teal-500/40"
                    style={{
                      borderColor: itemsExpiryFieldInvalid ? "#ef4444" : BORDER,
                      backgroundColor: BG,
                      boxShadow: itemsExpiryFieldInvalid ? "0 0 0 3px rgba(239,68,68,0.28)" : undefined,
                    }}
                  />
                  {itemsExpiryFieldInvalid ? (
                    <p className="mt-1.5 text-[11px] font-bold text-red-400">
                      {inspectionCondition === "expired"
                        ? "Expiration date is required when Expired is selected."
                        : "Expiration date is required for this product."}
                    </p>
                  ) : null}
                </div>
              ) : null}

              <div className="mt-4">
                <label className="text-[11px] font-bold uppercase tracking-wide" style={{ color: MUTED_LABEL }}>
                  Lot / batch (optional)
                </label>
                <input
                  value={itemBatch}
                  onChange={(e) => setItemBatch(e.target.value)}
                  className="mt-2 h-11 w-full rounded-xl border px-3 text-sm text-white outline-none focus:ring-2 focus:ring-teal-500/40"
                  style={{ borderColor: BORDER, backgroundColor: BG }}
                  placeholder="Lot code"
                />
              </div>

              <div className="mt-4">
                <p className="text-[11px] font-bold uppercase tracking-wide" style={{ color: MUTED_LABEL }}>
                  Quantity scanned now
                </p>
                <div className="mt-2 flex items-center justify-center gap-4">
                  <button
                    type="button"
                    onClick={() => setItemQtyStepper((n) => Math.max(1, n - 1))}
                    className="flex h-14 w-14 items-center justify-center rounded-2xl border text-2xl font-black text-white transition hover:bg-white/5"
                    style={{ borderColor: TEAL_STEP, color: TEAL_STEP }}
                  >
                    <Minus className="h-7 w-7" strokeWidth={2.5} />
                  </button>
                  <span className="min-w-[3rem] text-center text-[28px] font-black tabular-nums text-white">{itemQtyStepper}</span>
                  <button
                    type="button"
                    onClick={() => setItemQtyStepper((n) => Math.min(50, n + 1))}
                    className="flex h-14 w-14 items-center justify-center rounded-2xl border text-2xl font-black transition hover:bg-white/5"
                    style={{ borderColor: TEAL_STEP, color: TEAL_STEP }}
                  >
                    <Plus className="h-7 w-7" strokeWidth={2.5} />
                  </button>
                </div>
              </div>

              <div className="mt-4">
                <label className="text-[11px] font-bold uppercase tracking-wide" style={{ color: MUTED_LABEL }}>
                  Notes (optional)
                </label>
                <textarea
                  value={itemNotes}
                  onChange={(e) => setItemNotes(e.target.value)}
                  rows={3}
                  className="mt-2 w-full resize-none rounded-xl border px-3 py-2 text-sm text-white outline-none focus:ring-2 focus:ring-teal-500/40"
                  style={{ borderColor: BORDER, backgroundColor: BG }}
                  placeholder="Add any notes or details about this item…"
                />
              </div>
            </section>

            <div className="mb-4 flex flex-col gap-3 sm:flex-row">
              <button
                type="button"
                onClick={() => {
                  resetItemInspectionForm();
                  scheduleFocusScanner();
                }}
                className="flex h-[52px] flex-1 items-center justify-center gap-2 rounded-[18px] border-2 text-[14px] font-bold transition hover:bg-white/5"
                style={{ borderColor: "rgba(45,212,191,0.35)", color: TEAL_STEP }}
              >
                <Save className="h-5 w-5" strokeWidth={2} />
                Clear draft
              </button>
              <button
                type="button"
                disabled={busy || !itemDraft}
                onClick={() => void handleSaveAndNextItem()}
                className="flex h-[52px] flex-[1.25] items-center justify-center gap-2 rounded-[18px] text-[15px] font-black text-[#042f2e] shadow-[0_10px_28px_rgba(45,212,191,0.35)] transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-35"
                style={{
                  background: `linear-gradient(180deg, ${TEAL_STEP} 0%, #14b8a6 55%, #0d9488 100%)`,
                }}
              >
                Save Item &amp; Continue
                <ChevronRight className="h-5 w-5" strokeWidth={2.5} />
              </button>
            </div>

            <p className="mb-6 flex items-center justify-start gap-2 rounded-[16px] border px-3 py-2.5 text-[11px] font-semibold leading-relaxed" style={{ borderColor: "rgba(56,189,248,0.25)", backgroundColor: "rgba(14,165,233,0.08)", color: ACCENT_BLUE }}>
              <span className="operator-info-icon-pulse flex shrink-0 rounded-full">
                <Info className="h-4 w-4 shrink-0" strokeWidth={2} aria-hidden />
              </span>
              If photos or identifiers do not match the expected item, mark review and add notes. Green flash after save means ready for the next scan.
            </p>

            {!directBox && parentIdentified && expectedPkgLines.length > 0 ? (
              <section className={`mb-6 rounded-[24px] p-4 ${glassCard}`}>
                <h3 className="mb-2 text-[14px] font-bold text-white">Shipment summary</h3>
                <ul className="divide-y divide-[#243241]">
                  {expectedPkgLines.slice(0, 8).map((line) => (
                    <li key={line.groupKey} className="flex justify-between gap-2 py-2 text-[12px]">
                      <span className="min-w-0 truncate font-semibold text-white">{line.productLabel}</span>
                      <span className="shrink-0 font-mono text-[11px] font-bold tabular-nums" style={{ color: ACTION_BLUE }}>
                        Exp {line.expectedQty}
                        <span className="text-emerald-300"> · Scn {line.scannedQty}</span>
                        <span className="text-violet-200"> · Rem {line.remainingQty}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
              </>
            )}
          </div>
        ) : null}
        </>
        )}
      </main>

      {intakeToast ? (
        <div
          className="pointer-events-none fixed bottom-[calc(4.5rem+env(safe-area-inset-bottom))] left-1/2 z-[130] w-[min(calc(100vw-2rem),22rem)] -translate-x-1/2 rounded-2xl border px-4 py-3 shadow-[0_12px_40px_rgba(0,0,0,0.55)]"
          style={{
            borderColor: "rgba(167,139,250,0.45)",
            backgroundColor: "rgba(15,23,42,0.96)",
            boxShadow: `0 0 24px ${PURPLE_GLOW}`,
          }}
          role="status"
        >
          <p className="flex items-center gap-2 text-center text-[13px] font-bold leading-snug text-white">
            <CheckCircle2 className="h-5 w-5 shrink-0" style={{ color: SUCCESS }} strokeWidth={2.25} />
            {intakeToast}
          </p>
        </div>
      ) : null}

      {syncErrorToast ? (
        <div
          className="pointer-events-none fixed bottom-[calc(5.5rem+env(safe-area-inset-bottom))] left-1/2 z-[131] w-[min(calc(100vw-2rem),22rem)] -translate-x-1/2 rounded-2xl border-2 border-red-500/70 bg-[rgba(69,10,10,0.96)] px-4 py-3 shadow-[0_12px_40px_rgba(0,0,0,0.55)]"
          role="alert"
        >
          <p className="flex items-center gap-2 text-center text-[13px] font-bold leading-snug text-red-50">
            <AlertTriangle className="h-5 w-5 shrink-0 text-red-400" strokeWidth={2.25} />
            {syncErrorToast}
          </p>
        </div>
      ) : null}

      {identifyGatePhotoOcrToast ? (
        <div
          className="pointer-events-none fixed bottom-[calc(6.5rem+env(safe-area-inset-bottom))] left-1/2 z-[132] w-[min(calc(100vw-2rem),22rem)] -translate-x-1/2 rounded-2xl border px-4 py-3 shadow-[0_12px_40px_rgba(0,0,0,0.55)]"
          style={{
            borderColor: "rgba(251,191,36,0.55)",
            backgroundColor: "rgba(15,23,42,0.96)",
            boxShadow: "0 0 28px rgba(251,191,36,0.22), 0 12px 40px rgba(0,0,0,0.45)",
          }}
          role="status"
        >
          <p className="flex items-center gap-2 text-center text-[13px] font-bold leading-snug text-amber-50">
            <AlertTriangle className="h-5 w-5 shrink-0 text-amber-300" strokeWidth={2.25} />
            {identifyGatePhotoOcrToast}
          </p>
        </div>
      ) : null}

      {completedShipmentModal ? (
        <div
          className="fixed inset-0 z-[140] flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
          aria-labelledby={`${formId}-ship-done-title`}
        >
          <div
            className="w-full max-w-md rounded-[24px] border-2 p-5 shadow-[0_0_48px_rgba(52,211,153,0.2)]"
            style={{
              borderColor: IDENTIFICATION_GATE_THEME.completed.border,
              backgroundColor: CARD,
              boxShadow: IDENTIFICATION_GATE_THEME.completed.outerGlow,
            }}
          >
            <p
              id={`${formId}-ship-done-title`}
              className="text-center text-[17px] font-black leading-snug text-white"
            >
              Shipment complete. Add extra items?
            </p>
            <p className="mt-3 text-center text-[12px] font-semibold leading-relaxed" style={{ color: MUTED_LABEL }}>
              Tracking{" "}
              <span className="font-mono font-bold text-sky-200/90">{completedShipmentModal.tracking || "—"}</span>
            </p>
            <div className="mt-6 grid grid-cols-2 gap-3">
              <button
                type="button"
                className="h-12 rounded-xl border-2 text-[14px] font-bold transition hover:brightness-110"
                style={{
                  borderColor: BORDER,
                  backgroundColor: CARD_INNER,
                  color: TEXT_PRIMARY,
                }}
                onClick={() => {
                  setCompletedShipmentModal(null);
                  editParent();
                }}
              >
                No
              </button>
              <button
                type="button"
                className="h-12 rounded-xl border-2 text-[14px] font-bold transition hover:brightness-110"
                style={{
                  borderColor: IDENTIFICATION_GATE_THEME.completed.border,
                  backgroundColor: IDENTIFICATION_GATE_THEME.completed.chipBg,
                  color: IDENTIFICATION_GATE_THEME.completed.headline,
                }}
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
          className="fixed inset-0 z-[141] flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
          aria-labelledby={`${formId}-save-ship-confirm-title`}
        >
          <div
            className="w-full max-w-md rounded-[24px] border-2 p-5 shadow-[0_0_48px_rgba(14,165,233,0.18)]"
            style={{ borderColor: "rgba(56,189,248,0.45)", backgroundColor: CARD }}
          >
            <p id={`${formId}-save-ship-confirm-title`} className="text-center text-[16px] font-black leading-snug text-white">
              Are you sure you want to save this record and begin scanning boxes?
            </p>
            <div className="mt-6 grid grid-cols-2 gap-3">
              <button
                type="button"
                className="h-12 rounded-xl border-2 text-[14px] font-bold transition hover:brightness-110"
                style={{
                  borderColor: BORDER,
                  backgroundColor: CARD_INNER,
                  color: TEXT_PRIMARY,
                }}
                onClick={() => {
                  setSaveShipmentConfirmOpen(false);
                  modalOpenRef.current = false;
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                className="h-12 rounded-xl border-2 border-sky-400/55 text-[14px] font-bold text-white transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
                style={{
                  background: `linear-gradient(180deg, ${ACTION_BLUE} 0%, ${ACTION_BLUE_DEEP} 100%)`,
                }}
                disabled={confirmSaving}
                onClick={() => {
                  setSaveShipmentConfirmOpen(false);
                  modalOpenRef.current = false;
                  void handleConfirmStartBoxScan();
                }}
              >
                Confirm
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {cancelShipmentConfirmOpen ? (
        <div
          className="fixed inset-0 z-[141] flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
          aria-labelledby={`${formId}-cancel-ship-confirm-title`}
        >
          <div
            className="w-full max-w-md rounded-[24px] border-2 p-5 shadow-[0_0_48px_rgba(248,113,113,0.15)]"
            style={{ borderColor: "rgba(248,113,113,0.45)", backgroundColor: CARD }}
          >
            <p id={`${formId}-cancel-ship-confirm-title`} className="text-center text-[16px] font-black leading-snug text-white">
              Discard changes? You will return to the search screen.
            </p>
            <div className="mt-6 grid grid-cols-2 gap-3">
              <button
                type="button"
                className="h-12 rounded-xl border-2 text-[14px] font-bold transition hover:brightness-110"
                style={{
                  borderColor: BORDER,
                  backgroundColor: CARD_INNER,
                  color: TEXT_PRIMARY,
                }}
                onClick={() => {
                  setCancelShipmentConfirmOpen(false);
                  modalOpenRef.current = false;
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                className="h-12 rounded-xl border-2 border-red-400/60 bg-transparent text-[14px] font-bold text-red-100 transition hover:bg-red-500/15"
                onClick={() => {
                  setCancelShipmentConfirmOpen(false);
                  modalOpenRef.current = false;
                  router.push(SCANNER_OPERATOR_HOME_PATH);
                }}
              >
                Confirm
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <ScannerBottomNav active="scan" alertCount={2} />

      {candidatePicker ? (
        <div
          className="fixed inset-0 z-[120] flex items-end justify-center bg-black/70 p-4 pb-[max(1rem,env(safe-area-inset-bottom))] backdrop-blur-sm sm:items-center"
          role="dialog"
          aria-modal="true"
          aria-labelledby={`${formId}-pick-title`}
        >
          <div
            className="w-full max-w-md rounded-[24px] border p-4 shadow-[0_0_40px_rgba(45,212,191,0.12)]"
            style={{ borderColor: "rgba(45,212,191,0.35)", backgroundColor: CARD }}
          >
            <div className="flex items-start justify-between gap-2">
              <div>
                <p id={`${formId}-pick-title`} className="text-lg font-black text-white">
                  Pick expected line
                </p>
                <p className="mt-1 font-mono text-xs font-bold" style={{ color: TEAL_STEP }}>
                  {candidatePicker.tier.toUpperCase()} · {candidatePicker.barcode}
                </p>
                <p className="mt-2 text-[12px] font-semibold" style={{ color: MUTED_LABEL }}>
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
                className="rounded-xl p-2 text-white/80 transition hover:bg-white/10"
                aria-label="Close"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="mt-4 flex max-h-[40vh] flex-col gap-2 overflow-auto">
              {(Array.isArray(candidatePicker.candidates) ? candidatePicker.candidates : []).map((row) => (
                <button
                  key={String(row.id)}
                  type="button"
                  onClick={() => {
                    void (async () => {
                      await populateDraftFromEpRow(candidatePicker.barcode, candidatePicker.tier, row);
                      modalOpenRef.current = false;
                      setCandidatePicker(null);
                      scheduleFocusScanner();
                    })();
                  }}
                  className="rounded-xl border px-3 py-3 text-left text-[13px] font-bold transition hover:brightness-110"
                  style={{
                    borderColor: "rgba(45,212,191,0.35)",
                    backgroundColor: "#090E1A",
                    color: TEXT_PRIMARY,
                  }}
                >
                  <span className="font-mono text-[12px]" style={{ color: TEAL_STEP }}>
                    {epPackageRowPrimaryLabel(row as Record<string, unknown>)}
                  </span>
                  {epPackageRowCatalogSubtitle(row as Record<string, unknown>) ? (
                    <span className="mt-1 block text-[11px] font-semibold normal-case" style={{ color: MUTED_LABEL }}>
                      {epPackageRowCatalogSubtitle(row as Record<string, unknown>)}
                    </span>
                  ) : null}
                  <span className="mt-1 block text-[11px] font-semibold" style={{ color: MUTED_LABEL }}>
                    Disposition {String(row.disposition ?? "—")} · Expected qty{" "}
                    {String(row.expected_scan_quantity ?? "—")}
                  </span>
                </button>
              ))}
            </div>
          </div>
        </div>
      ) : null}

      {slipVisionModal ? (
        <div
          className="fixed inset-0 z-[121] flex items-end justify-center bg-black/75 p-4 pb-[max(1rem,env(safe-area-inset-bottom))] backdrop-blur-sm sm:items-center"
          role="dialog"
          aria-modal="true"
          aria-labelledby={`${formId}-slip-vision-title`}
        >
          <div
            className="flex max-h-[min(92vh,720px)] w-full max-w-lg flex-col overflow-hidden rounded-[24px] border shadow-[0_0_48px_rgba(45,212,191,0.12)]"
            style={{ borderColor: "rgba(45,212,191,0.35)", backgroundColor: CARD }}
          >
            <div className="flex items-start justify-between gap-2 border-b px-4 py-3.5" style={{ borderColor: BORDER }}>
              <div>
                <p id={`${formId}-slip-vision-title`} className="text-[17px] font-black text-white">
                  Confirm slip (GPT-4o)
                </p>
                <p className="mt-1 text-[11px] font-semibold leading-relaxed" style={{ color: MUTED_LABEL }}>
                  Review extracted IDs and line items. Confirm applies shipment context before you save box intake to
                  the pallet.
                </p>
              </div>
              <button
                type="button"
                onClick={dismissSlipVisionModal}
                className="rounded-xl p-2 text-white/80 transition hover:bg-white/10"
                aria-label="Close"
              >
                <X className="h-5 w-5" strokeWidth={2} />
              </button>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
              <div className="grid grid-cols-2 gap-3 text-[12px]">
                <div className="rounded-xl border px-3 py-2" style={{ borderColor: BORDER, backgroundColor: "#090E1A" }}>
                  <p className="text-[10px] font-bold uppercase tracking-wide" style={{ color: MUTED_LABEL }}>
                    VRET ID
                  </p>
                  <p className="mt-1 font-mono text-[13px] font-bold text-white">{slipVisionModal.extract.vret_id ?? "—"}</p>
                </div>
                <div className="rounded-xl border px-3 py-2" style={{ borderColor: BORDER, backgroundColor: "#090E1A" }}>
                  <p className="text-[10px] font-bold uppercase tracking-wide" style={{ color: MUTED_LABEL }}>
                    Shipment ID
                  </p>
                  <p className="mt-1 break-all font-mono text-[12px] font-bold text-white">
                    {slipVisionModal.extract.shipment_id ?? "—"}
                  </p>
                </div>
              </div>

              {slipVisionModal.suggestedTracking ? (
                <div className="mt-3 rounded-xl border border-emerald-500/35 bg-emerald-500/10 px-3 py-2.5 text-[12px] font-bold leading-snug text-emerald-100 shadow-[0_0_24px_rgba(16,185,129,0.15)]">
                  <span className="mr-2 inline-block rounded-full border border-emerald-500/30 bg-emerald-500/20 px-2 py-0.5 text-[10px] font-black uppercase tracking-wide text-emerald-400 shadow-[0_0_14px_rgba(16,185,129,0.28)]">
                    Confirmed by Slip
                  </span>
                  <CheckCircle2 className="mr-1 inline-block h-4 w-4 align-text-bottom text-emerald-400" strokeWidth={2} />
                  Expected box · tracking{" "}
                  <span className="font-mono text-white">{slipVisionModal.suggestedTracking}</span>
                </div>
              ) : (
                <div className="mt-3 rounded-xl border border-amber-500/35 bg-amber-500/10 px-3 py-2.5 text-[11px] font-semibold leading-relaxed text-amber-100 shadow-[0_0_22px_rgba(245,158,11,0.12)]">
                  <span className="mr-2 inline-block rounded-full border border-amber-500/30 bg-amber-500/20 px-2 py-0.5 text-[10px] font-black uppercase tracking-wide text-amber-400 shadow-[0_0_14px_rgba(245,158,11,0.22)]">
                    Not confirmed
                  </span>
                  <AlertTriangle className="mr-1 inline-block h-4 w-4 align-text-bottom text-amber-400" strokeWidth={2} />
                  No expected box matched for these IDs (space/case-insensitive tracking search was tried). You can still confirm slip
                  labels; scan or set tracking manually.
                </div>
              )}

              <h4 className="mb-2 mt-4 text-[13px] font-bold text-white">Items from slip</h4>
              {slipVisionModal.itemRows.length === 0 ? (
                <p className="rounded-xl border px-3 py-4 text-center text-[12px] font-semibold" style={{ borderColor: BORDER, color: MUTED_LABEL }}>
                  No line items detected — check photo clarity or edit expectations manually.
                </p>
              ) : (
                <ul className="space-y-2 pb-1">
                  {slipVisionModal.itemRows.map((row, i) => (
                    <li
                      key={`${row.sku ?? ""}-${row.asin ?? ""}-${row.barcode ?? ""}-${row.description ?? ""}-${i}`}
                      className={`flex gap-2 rounded-xl border px-3 py-2.5 text-[11px] ${
                        row.match === "expected"
                          ? "border-emerald-500/25 bg-emerald-500/[0.07] shadow-[inset_0_1px_0_0_rgba(16,185,129,0.12)]"
                          : "border-amber-500/30 bg-[#090E1A]"
                      }`}
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          {row.match === "expected" ? (
                            <span className="inline-flex rounded-full border border-emerald-500/30 bg-emerald-500/20 px-2 py-0.5 text-[9px] font-black uppercase tracking-wide text-emerald-400 shadow-[0_0_12px_rgba(16,185,129,0.25)]">
                              Confirmed by Slip
                            </span>
                          ) : (
                            <span className="inline-flex rounded-full border border-amber-500/30 bg-amber-500/20 px-2 py-0.5 text-[9px] font-black uppercase tracking-wide text-amber-400 shadow-[0_0_12px_rgba(245,158,11,0.2)]">
                              Not confirmed
                            </span>
                          )}
                          {row.match === "expected" ? (
                            <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-400" strokeWidth={2.25} />
                          ) : (
                            <AlertTriangle className="h-4 w-4 shrink-0 text-amber-400" strokeWidth={2.25} />
                          )}
                        </div>
                        <p className="mt-2 font-mono text-[12px] font-bold text-white">
                          {[row.sku, row.asin, row.barcode].filter(Boolean).join(" · ") || "—"}
                        </p>
                        {row.description ? (
                          <p className="mt-0.5 font-medium leading-snug text-slate-400">{row.description}</p>
                        ) : null}
                        <p className="mt-1.5 tabular-nums tracking-tight text-white">
                          <span className="text-[12px] font-extrabold text-white/90">Expected:</span>{" "}
                          <span className="text-[15px] font-black text-teal-300">{row.expected_qty}</span>
                        </p>
                        {row.match === "expected" && row.matchedHint ? (
                          <p className="mt-1 text-[10px] font-bold text-emerald-400/95">{row.matchedHint}</p>
                        ) : row.match === "unexpected" ? (
                          <p className="mt-1 text-[10px] font-bold text-amber-200/95">
                            No expected line matched (SKU / FNSKU / description heuristic).
                          </p>
                        ) : null}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="flex shrink-0 gap-2 border-t px-4 py-3.5" style={{ borderColor: BORDER }}>
              <button
                type="button"
                onClick={dismissSlipVisionModal}
                className="flex-1 rounded-[14px] border py-3 text-[13px] font-bold transition hover:bg-white/5"
                style={{ borderColor: BORDER, color: TEXT_PRIMARY }}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={confirmSlipVisionModal}
                className="flex-1 rounded-[14px] py-3 text-[13px] font-black text-[#042f2e] shadow-[0_8px_24px_rgba(45,212,191,0.35)] transition hover:brightness-110"
                style={{
                  background: `linear-gradient(180deg, ${TEAL_STEP} 0%, #14b8a6 100%)`,
                }}
              >
                Confirm
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {unknownModal ? (
        <div
          className="fixed inset-0 z-[120] flex items-end justify-center bg-black/70 p-4 pb-[max(1rem,env(safe-area-inset-bottom))] backdrop-blur-sm sm:items-center"
          role="dialog"
          aria-modal="true"
          aria-labelledby={`${formId}-unk-title`}
        >
          <div className="w-full max-w-md rounded-[24px] border border-amber-400/40 bg-gradient-to-b from-amber-950/98 to-[#1a1408] p-4 shadow-[0_0_40px_rgba(251,191,36,0.15)]">
            <div className="flex items-start justify-between gap-2">
              <div>
                <p id={`${formId}-unk-title`} className="text-lg font-black text-amber-100">
                  Unrecognized code
                </p>
                <p className="mt-1 font-mono text-sm font-bold text-amber-200/90">{unknownModal.code}</p>
                <p className="mt-2 text-xs font-semibold text-amber-200/70">
                  Choose match type: Tracking → Box → Slip → Pallet → Item
                </p>
              </div>
              <button type="button" onClick={closeUnknown} className="rounded-xl p-2 text-amber-200 hover:bg-amber-500/15" aria-label="Close">
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
                  className="rounded-xl border border-amber-500/35 bg-amber-500/10 px-2 py-3 text-center text-xs font-black uppercase tracking-wide text-amber-50 shadow-[0_0_12px_rgba(251,191,36,0.12)] transition hover:bg-amber-500/20"
                >
                  {lab}
                </button>
              ))}
            </div>

            {allowOperatorUnknownPackageCreate() ? (
              <div className="mt-4 rounded-[18px] border border-amber-300/45 bg-amber-500/10 px-3 py-3">
                <p className="text-[13px] font-bold text-amber-50">Shipment code not found</p>
                <p className="mt-1 text-[11px] font-semibold leading-relaxed text-amber-100/85">
                  Tracking not found in the database. Create a new unknown box with this scan as{" "}
                  <span className="font-mono text-amber-50/95">tracking_number</span>? You can continue receiving; worklist data may
                  arrive later.
                </p>
                {operatorStoresLoading ? (
                  <p className="mt-2 text-[11px] font-semibold text-amber-200/75">Loading stores…</p>
                ) : !sessionStoreId ? (
                  <p className="mt-2 text-[11px] font-semibold text-amber-200/75">
                    {operatorStores.length === 0 && !kioskStoreLocked
                      ? "Add an active store for this organization in Settings, or set NEXT_PUBLIC_STORE_ID for kiosk mode."
                      : "Select an active store above (or configure NEXT_PUBLIC_STORE_ID) before creating a box."}
                  </p>
                ) : (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void handleCreateUnknownPackage()}
                    className="mt-3 w-full rounded-xl py-3 text-[12px] font-black uppercase tracking-wide text-amber-50 shadow-[0_0_18px_rgba(251,191,36,0.15)] transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
                    style={{
                      border: "1px solid rgba(251,191,36,0.45)",
                      background: "linear-gradient(180deg, rgba(245,158,11,0.35) 0%, rgba(180,83,9,0.45) 100%)",
                    }}
                  >
                    Create unknown box
                  </button>
                )}
              </div>
            ) : null}

            <button
              type="button"
              onClick={closeUnknown}
              className="mt-3 w-full rounded-xl border border-slate-600 bg-slate-900 py-3 text-sm font-bold text-slate-200"
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
      <Suspense fallback={<ScanPageLoading />}>
        <OperatorMobileScanPageContent />
      </Suspense>
    </ScanPageErrorBoundary>
  );
}
