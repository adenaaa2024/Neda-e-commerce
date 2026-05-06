"use client";

import {
  Component,
  Fragment,
  Suspense,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useLayoutEffect,
  useRef,
  useState,
  type ChangeEvent,
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
  CheckCircle2,
  ClipboardList,
  Info,
  Loader2,
  Minus,
  Package,
  ChevronRight,
  Package2,
  PackageOpen,
  Pencil,
  Plus,
  Puzzle,
  RotateCcw,
  Save,
  ScanLine,
  Search,
  ThumbsUp,
  Warehouse,
  X,
} from "lucide-react";
import { isSupabaseConfigured, supabase } from "@/src/lib/supabase";
import { resolveOrganizationId } from "@/lib/organization";
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
import { isUuidString } from "@/lib/uuid";
import { operatorReceiveItem } from "@/app/scanner/operator-mobile/item-actions";
import {
  allowOperatorUnknownPackageCreate,
  insertUnknownPackageForTrackingCode,
} from "@/lib/scanner/operator-unknown-package";
import { insertIntakeBoxPackage } from "@/lib/scanner/operator-box-intake";
import {
  extractSlipIdsFromScan,
  looksLikePackingSlipScan,
  type SlipExtractResult,
} from "@/lib/scanner/operator-slip-scan";
import { slipIdLookupCandidates, trackingKeysEqual } from "@/lib/scanner/tracking-normalize";
import type { SlipVisionExtract } from "@/lib/scanner/slip-extract-parse";
import { attachMatchStatusToSlipItems, type SlipVisionItemRow } from "@/lib/scanner/slip-vision-match";
import { getAIUnifiedKeyFromStorage, getOpenAIApiKeyFromStorage } from "@/lib/openai-settings";
import { ScannerBottomNav } from "../_components/ScannerBottomNav";
import { OperatorThemeToggle } from "../_components/OperatorThemeToggle";
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
const TEAL_STEP_MUTED = "rgba(45, 212, 191, 0.22)";
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

const glassCard = `border-[0.5px] border-cyan-500/15 shadow-lg backdrop-blur-xl scanner-glass-surface dark:border-white/12`;

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

/** Single source of truth: Pallet → Package → Item (operational phases map to scan / package_scan / items) */
const SCANNER_STEPS = [
  {
    id: 1,
    key: "pallet",
    label: "Pallet",
    title: "Step 1: Pallet",
    subtitle: "Slip, counts, then packages",
  },
  {
    id: 2,
    key: "package",
    label: "Package",
    title: "Step 2: Package",
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

function scoreIdentifyGateOcrLine(line: string): number {
  return line.replace(/[^A-Za-z0-9]/g, "").length;
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

function pickBestIdentifyGateOcrLine(raw: string): string {
  const trimmedRaw = raw.trim();
  const patternHits = collectIdentifyGateOcrPatternHits(trimmedRaw);
  if (patternHits.length) {
    patternHits.sort((a, b) => b.tier - a.tier || b.alnumLen - a.alnumLen || b.text.length - a.text.length);
    return patternHits[0]!.text;
  }
  const lines = trimmedRaw
    .split(/\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (!lines.length) return trimmedRaw;
  let best = lines[0]!;
  let bestScore = scoreIdentifyGateOcrLine(best);
  for (const line of lines) {
    const sc = scoreIdentifyGateOcrLine(line);
    if (sc > bestScore) {
      best = line;
      bestScore = sc;
    }
  }
  return best;
}

/** Boost small slip text: grayscale + contrast before Tesseract. */
async function preprocessIdentifyGatePhotoForOcr(file: File): Promise<Blob | File> {
  if (typeof createImageBitmap !== "function") return file;
  try {
    const bmp = await createImageBitmap(file);
    const w = bmp.width;
    const h = bmp.height;
    const maxDim = 2200;
    const scale = Math.min(1, maxDim / Math.max(w, h, 1));
    const cw = Math.max(1, Math.round(w * scale));
    const ch = Math.max(1, Math.round(h * scale));
    const canvas = document.createElement("canvas");
    canvas.width = cw;
    canvas.height = ch;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) {
      bmp.close?.();
      return file;
    }
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
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob((b) => resolve(b), "image/png", 0.94));
    return blob ?? file;
  } catch {
    return file;
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
  if (asinLike && confidence >= 12) return true;
  if ((slipIdLike || fnskuLike) && confidence >= 14) return true;
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
  storeLabel: string | null;
  palletLabel: string | null;
  shipmentIdLabel: string | null;
  /** Shown only after a package/carton barcode is locked or an item-phase box is selected. */
  boxBarcode: string | null;
  className?: string;
}) {
  const { storeLabel, palletLabel, shipmentIdLabel, boxBarcode, className } = props;
  const sep = (
    <span className="mx-0.5 font-semibold tabular-nums text-slate-600" aria-hidden>
      &gt;
    </span>
  );
  const boxId = boxBarcode?.trim() ?? "";
  const boxHot = Boolean(boxId);

  return (
    <nav
      className={`mt-1 flex max-w-full flex-wrap items-center justify-center gap-y-0.5 px-1 text-[10px] font-bold leading-tight tracking-tight ${className ?? ""}`}
      aria-label="Warehouse path"
    >
      <span style={{ color: MUTED_LABEL }}>Store</span>
      {sep}
      <span className="max-w-[28vw] truncate sm:max-w-[140px]" style={{ color: storeLabel?.trim() ? TEAL_STEP : MUTED_LABEL }}>
        {storeLabel?.trim() || "—"}
      </span>
      {sep}
      <span style={{ color: MUTED_LABEL }}>Pallet</span>
      {sep}
      <span className="max-w-[22vw] truncate font-mono sm:max-w-[100px]" style={{ color: palletLabel?.trim() ? TEAL_STEP : MUTED_LABEL }}>
        {palletLabel ?? "—"}
      </span>
      {sep}
      <span style={{ color: MUTED_LABEL }}>Shipment</span>
      {sep}
      <span className="max-w-[28vw] truncate font-mono sm:max-w-[160px]" style={{ color: shipmentIdLabel?.trim() ? TEXT_PRIMARY : MUTED_LABEL }}>
        {shipmentIdLabel ?? "—"}
      </span>
      {boxHot ? (
        <>
          {sep}
          <span style={{ color: MUTED_LABEL }}>Box</span>
          {sep}
          <span className="max-w-[30vw] truncate font-mono sm:max-w-[160px]" style={{ color: SUCCESS }}>
            {boxId}
          </span>
        </>
      ) : null}
    </nav>
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
  const orgId = resolveOrganizationId();
  const {
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
  const slip1Ref = useRef<HTMLInputElement>(null);
  const slip2Ref = useRef<HTMLInputElement>(null);
  const cartonPhotoRef = useRef<HTMLInputElement>(null);
  const trackerPhotoRef = useRef<HTMLInputElement>(null);
  const cartonPhotoUrlRef = useRef<string | null>(null);
  const trackerPhotoUrlRef = useRef<string | null>(null);

  const [flowPhase, setFlowPhase] = useState<FlowPhase>("scan");
  const [scanLine, setScanLine] = useState("");
  const [manualOpen, setManualOpen] = useState(false);
  const [scanBarcodeHelpOpen, setScanBarcodeHelpOpen] = useState(false);

  const [activePallet, setActivePallet] = useState<{ id: string; pallet_number: string } | null>(null);
  const [activeTracking, setActiveTracking] = useState<string | null>(null);
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
  const [slipPhoto1Url, setSlipPhoto1Url] = useState<string | null>(null);
  const [slipPhoto2Url, setSlipPhoto2Url] = useState<string | null>(null);
  const slipPhoto1UrlRef = useRef<string | null>(null);
  const slipPhoto2UrlRef = useRef<string | null>(null);

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
  const identifyGateCameraInputRef = useRef<HTMLInputElement>(null);
  const identifyGateOcrBusyRef = useRef(false);

  const laserEnabled =
    ((!isIdentified && flowPhase === "scan") ||
      (isIdentified && (flowPhase === "scan" || flowPhase === "package_scan" || flowPhase === "items"))) &&
    !manualOpen &&
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
    const run = () => {
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
                ? "Select an active store in the header before searching."
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
    if (!activeTracking && !activePallet?.id) {
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
            if (activeTracking) {
              const snap = mockTrackingExpectationSnapshot(activeTracking);
              setExpectedPkgLines(snap.lines);
              setExpectedPkgTotals(snap.totals);
              setExpectedPackagesRawRowCount(snap.rawRowCount);
              setExpectedPkgTrackingNumbers(snap.expectedTrackingNumbers);
              setExpectedPkgError(null);
            } else if (activePallet?.id) {
              const snap = mockPalletExpectationSnapshot();
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
                    ? "Select an active store in the header to load expected_packages for that location."
                    : operatorStores.length === 0
                      ? "No active stores for this organization — add a store in Settings."
                      : "Select or configure a store to load expected_packages.",
              );
            }
          }
          return;
        }

        if (activeTracking) {
          const snap = await loadTrackingExpectationSnapshot(supabase, orgId, sessionStoreId, activeTracking);
          if (cancelled) return;
          setExpectedPkgLines(snap.lines);
          setExpectedPkgTotals(snap.totals);
          setExpectedPackagesRawRowCount(snap.rawRowCount);
          setExpectedPkgTrackingNumbers(snap.expectedTrackingNumbers);
          setExpectedPkgError(
            snap.rawRowCount === 0 ? "No expected_packages rows for this tracking in the current store." : null,
          );
          return;
        }

        if (activePallet?.id) {
          const snap = await loadPalletExpectationSnapshot(supabase, orgId, sessionStoreId, activePallet.id);
          if (cancelled) return;
          setExpectedPkgLines(snap.lines);
          setExpectedPkgTotals(snap.totals);
          setExpectedPackagesRawRowCount(snap.rawRowCount);
          setExpectedPkgTrackingNumbers(snap.expectedTrackingNumbers);
          setExpectedPkgError(
            snap.rawRowCount === 0
              ? "No expected_packages rows for package trackings on this pallet (link trackings on packages or worklist)."
              : null,
          );
        }
      } catch (e) {
        console.error(e);
        if (!cancelled) {
          setExpectedPkgError("Could not load expected_packages.");
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
        const rows = await fetchExpectedPackageDetailRowsForParent(supabase, orgId, sessionStoreId, {
          trackingNumber: activeTracking,
          palletId: activePallet?.id ?? null,
        });
        if (cancelled) return;
        const data = rows ?? [];
        const safe = Array.isArray(data) ? data : [];
        setExpectedPkgDetailRows(safe);
        if (activeTracking?.trim() && safe.length === 0) {
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
  }, [flowPhase, sessionStoreId, orgId, activeTracking, activePallet?.id]);

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
    if (r.kind === "pallet") {
      const id = String(r.row.id ?? "");
      const num = String(r.row.pallet_number ?? "");
      if (id && num) {
        setActivePallet({ id, pallet_number: num });
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

  useEffect(() => {
    const raw = searchParams.get("code") ?? searchParams.get("q");
    if (!raw?.trim()) return;
    const code = raw.trim();
    setScanLine(code);
    router.replace(pathname, { scroll: false });
    queueMicrotask(() => {
      void runIdentificationGateSearch(code);
    });
  }, [searchParams, pathname, router, runIdentificationGateSearch]);

  const resolveSlipEpContext = useCallback(
    async (extract: SlipVisionExtract): Promise<{ tracking: string | null; rows: Record<string, unknown>[] }> => {
      const uniq = slipIdLookupCandidates(extract.shipment_id, extract.vret_id, activeTracking);

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
    [activeTracking, orgId, sessionStoreId],
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
      } catch (e) {
        setSyncErrorToast(e instanceof Error ? e.message : "Slip OCR failed.");
      } finally {
        setSlipVisionProcessing(false);
        scheduleFocusScanner();
      }
    },
    [orgId, resolveSlipEpContext, scheduleFocusScanner],
  );

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

      if (looksLikePackingSlipScan(trimmed)) {
        setBusy(true);
        try {
          setAiSlipReaderPhase("reading");
          await new Promise((r) => window.setTimeout(r, 650));
          const extracted = extractSlipIdsFromScan(trimmed);
          const shipment =
            (extracted.shipmentId?.trim() || activeTracking?.trim() || "").trim() || null;
          if (shipment) setActiveTracking(shipment);
          setSlipBarcodeExtract(extracted);
          setAiSlipReaderPhase("matched");
          setIntakeToast(
            slipPhoto1Url
              ? "Parsed slip barcode — tap “Run slip OCR” on Review if you want Vision, then scan the carton barcode."
              : "Parsed slip barcode — capture Slip Photo 1 on Review, optionally run slip OCR, then scan the carton barcode.",
          );
        } finally {
          setBusy(false);
          scheduleFocusScanner();
        }
        return;
      }

      setBusy(true);
      try {
        if (!isSupabaseConfigured()) {
          setActiveBoxSession({ barcode: trimmed, packageId: `demo-${Date.now()}` });
          const tnHit = expectedPkgTrackingNumbers.some((t) => trackingKeysEqual(t, trimmed));
          if (tnHit) setIntakeToast("Tracking Matched to Package");
          playOperatorSuccessBeep();
          setScanSuccessFlash(true);
          return;
        }
        if (!sessionStoreId) {
          setBoxIntakeError("Configure a store before recording boxes.");
          return;
        }
        const res = await insertIntakeBoxPackage(supabase, {
          organizationId: orgId,
          palletId: activePallet?.id ?? null,
          packageNumber: trimmed,
        });
        if (!res.ok) {
          setBoxIntakeError(res.message);
          return;
        }
        setActiveBoxSession({ barcode: trimmed, packageId: res.packageId });
        const tnHit = expectedPkgTrackingNumbers.some((t) => trackingKeysEqual(t, trimmed));
        if (tnHit) setIntakeToast("Tracking Matched to Package");
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
      activeTracking,
      sessionStoreId,
      orgId,
      activePallet?.id,
      expectedPkgTrackingNumbers,
      slipPhoto1Url,
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
    if (trackingToActivate) setActiveTracking(trackingToActivate);
    setSlipBarcodeExtract({
      vretId: extract.vret_id,
      shipmentId: extract.shipment_id,
    });
    setSlipVisionModal(null);
    modalOpenRef.current = false;
    setIntakeToast("Slip confirmed — shipment context applied for receiving.");
    scheduleFocusScanner();
  }, [slipVisionModal, scheduleFocusScanner]);

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
        setItemReceiveError("Expected package id missing — cannot update counts.");
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

  const openIdentifyGateCameraCapture = useCallback(() => {
    identifyGateCameraInputRef.current?.click();
  }, []);

  const onIdentifyGateCameraFileChange = useCallback(async (e: ChangeEvent<HTMLInputElement>) => {
    const input = e.currentTarget;
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    if (identifyGateOcrBusyRef.current) return;
    if (!file.type.startsWith("image/")) {
      setIdentifyGatePhotoOcrToast("Could not read text clearly. Please try manual entry.");
      return;
    }
    identifyGateOcrBusyRef.current = true;
    setIdentifyGateOcrReading(true);
    try {
      const { createWorker, PSM } = await import("tesseract.js");
      const worker = await createWorker("eng", undefined, {
        logger: () => {},
      });
      try {
        await worker.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_BLOCK });
        const ocrSource = await preprocessIdentifyGatePhotoForOcr(file);
        const { data } = await worker.recognize(ocrSource);
        const raw = String(data.text ?? "");
        const picked = pickBestIdentifyGateOcrLine(raw);
        const cleaned = stripIdentifyGateOcrEdges(picked);
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
    }
  }, []);

  const onSubmitScan = useCallback(
    async (e?: FormEvent) => {
      e?.preventDefault();
      const code = scanLine.trim();
      setScanLine("");
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
      const res = await insertUnknownPackageForTrackingCode(supabase, {
        organizationId: orgId,
        storeId: sessionStoreId,
        scannedCode: code,
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

    const ensureReceivingPalletForShipment = async (
      tn: string,
    ): Promise<{ id: string; pallet_number: string; created: boolean } | null> => {
      if (!isSupabaseConfigured() || !sessionStoreId) return null;
      const { data: hitTn, error: eTn } = await supabase
        .from("pallets")
        .select("id, pallet_number")
        .eq("organization_id", orgId)
        .is("deleted_at", null)
        .eq("tracking_number", tn)
        .limit(1)
        .maybeSingle();
      if (!eTn && hitTn && (hitTn as { id?: string }).id) {
        return {
          id: String((hitTn as { id: string }).id),
          pallet_number: String((hitTn as { pallet_number: string }).pallet_number),
          created: false,
        };
      }
      if (orderId) {
        const { data: hitOrd, error: eOrd } = await supabase
          .from("pallets")
          .select("id, pallet_number")
          .eq("organization_id", orgId)
          .is("deleted_at", null)
          .eq("order_id", orderId)
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
      const palletNumber = `RCV-${tn.replace(/\s+/g, "").slice(0, 48) || "TRACK"}`;
      const insertPayload: Record<string, unknown> = {
        organization_id: orgId,
        store_id: sessionStoreId,
        pallet_number: palletNumber,
        status: "open",
        tracking_number: tn,
      };
      if (orderId) insertPayload.order_id = orderId;
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
    };

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

      let effectiveTracking = tracking;
      if (lastResolve?.kind === "tracking") {
        effectiveTracking = String(lastResolve.row.tracking_number ?? "").trim() || effectiveTracking;
      }

      if (shipContinueVisual) {
        setActiveSlipOrPackage(null);
        setActiveTracking(effectiveTracking);
        setDirectBox(false);
        let receiving: { id: string; pallet_number: string; created: boolean } | null = null;
        if (isSupabaseConfigured() && sessionStoreId) {
          receiving = await ensureReceivingPalletForShipment(effectiveTracking);
        }
        if (receiving) {
          setActivePallet({ id: receiving.id, pallet_number: receiving.pallet_number });
        } else {
          setActivePallet(null);
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
        const { data, error } = await supabase
          .from("pallets")
          .insert({
            organization_id: orgId,
            store_id: sessionStoreId,
            pallet_number: code,
            status: "open",
            tracking_number: code,
            operator_package_count: boxN ?? null,
          })
          .select("id, pallet_number")
          .maybeSingle();
        if (error) throw new Error(error.message);
        const row = data as { id: string; pallet_number: string } | null;
        if (!row?.id) throw new Error("Pallet insert returned no row.");
        if (boxN != null) {
          setPhysicalBoxCount(boxN);
          setBoxScanTargetDenominator(boxN);
        }
        setActivePallet({ id: row.id, pallet_number: row.pallet_number });
        setActiveTracking(null);
        setActiveSlipOrPackage(null);
        setDirectBox(false);
        setFlowPhase("scan");
      } else if (identifyGateEntity === "package") {
        if (!allowOperatorUnknownPackageCreate()) {
          throw new Error("Unknown package creation is disabled for this deployment.");
        }
        const res = await insertUnknownPackageForTrackingCode(supabase, {
          organizationId: orgId,
          storeId: sessionStoreId,
          scannedCode: code,
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
  ]);

  const handleIdentificationGatePrimaryCta = useCallback(() => {
    const visual = identifyGateInventoryVisual;
    if (!visual) return;
    if (visual === "completed") return;
    if (visual === "manual_new") void handleIdentifyNewCreateAndStart();
    else void handleIdentifyMatchedStartWorkflow();
  }, [identifyGateInventoryVisual, handleIdentifyNewCreateAndStart, handleIdentifyMatchedStartWorkflow]);

  const palletIdentified = Boolean(activePallet);
  const trackingIdentified = Boolean(activeTracking);
  const parentIdentified = palletIdentified || trackingIdentified;

  const stepIndex = flowPhase === "scan" ? 0 : flowPhase === "package_scan" ? 1 : 2;

  const scanStepMeta = SCANNER_STEPS[stepIndex] ?? SCANNER_STEPS[0];
  const headerTitle = "Shipment Entry";
  const headerSubtitle = isIdentified ? `${scanStepMeta.title} · ${scanStepMeta.subtitle}` : null;

  /** Operator package count is collected only when entity type is Pallet (saved as pallets.operator_package_count). */
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
    : activeTracking
      ? "Active Tracking"
      : activeSlipOrPackage
        ? "Active Scan"
        : directBox
          ? "Direct Box Scan"
          : "Awaiting Pallet";

  const contextId =
    activePallet?.pallet_number ??
    activeTracking ??
    activeSlipOrPackage ??
    (directBox ? "No pallet locked" : "—");

  const contextTone = activePallet
    ? "blue"
    : activeTracking
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
    Boolean(slipPhoto1Url) &&
    typeof physicalBoxCount === "number" &&
    physicalBoxCount > 0 &&
    parentIdentified &&
    !slipVisionProcessing;

  const totalSkuUnits =
    expectedPkgTotals?.expectedUnits ?? expectedPkgLines.reduce((s, l) => s + l.expectedQty, 0);

  const expectedBoxesForProgress = Math.max(0, physicalBoxCount ?? 0);
  const physicalDenomFloor = Math.max(expectedBoxesForProgress, 1);
  /** Denominator for Box N of M — locked at confirm from Step 2; otherwise preview from `physicalBoxCount`. */
  const boxIntakeDenom =
    (flowPhase === "package_scan" || flowPhase === "items") && boxScanTargetDenominator != null
      ? boxScanTargetDenominator
      : physicalDenomFloor;

  const handleConfirmStartBoxScan = useCallback(() => {
    if (!parentIdentified || slipVisionProcessing) return;
    if (!slipPhoto1Url) return;
    if (typeof physicalBoxCount !== "number" || physicalBoxCount <= 0) {
      setPhysicalCountShakeSeq((s) => s + 1);
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
    setBoxScanTargetDenominator(physicalBoxCount);
    setBoxIntakeError(null);
    setFlowPhase("package_scan");
  }, [
    parentIdentified,
    slipPhoto1Url,
    slipVisionProcessing,
    physicalBoxCount,
    expectedPackagesRawRowCount,
  ]);
  const boxOrdinal = Math.min(scannedBoxesSavedCount + 1, boxIntakeDenom);
  const slipPagesCaptured = (slipPhoto1Url ? 1 : 0) + (slipPhoto2Url ? 1 : 0);
  const matchedItemsPreviewCount = aiSlipReaderPhase === "matched" ? expectedPkgLines.length : 0;
  const showSlipMatchedBadge =
    aiSlipReaderPhase === "matched" &&
    expectedPkgLines.length > 0 &&
    (!slipBarcodeExtract?.shipmentId ||
      trackingKeysEqual(slipBarcodeExtract.shipmentId, activeTracking ?? ""));
  const showWarehouseTrail = isIdentified && (parentIdentified || directBox || flowPhase !== "scan");
  const warehousePalletLabel = activePallet?.pallet_number ?? (directBox ? "Direct" : null);
  const warehouseShipmentIdLabel =
    activeTracking?.trim() || slipBarcodeExtract?.shipmentId?.trim() || null;
  const contextTrailBoxBarcode = activeBoxSession?.barcode ?? itemScanPackageLabel ?? null;

  useEffect(() => {
    if (flowPhase !== "scan" || !parentIdentified) return;
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
  }, [flowPhase, parentIdentified]);

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
        value={scanLine}
        onChange={(e) => setScanLine(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            void onSubmitScan();
          }
        }}
        onBlur={() => {
          window.setTimeout(() => {
            if (!modalOpenRef.current && !manualOpen && laserEnabled) focusScannerAggressive();
          }, 100);
        }}
        className="sr-only"
        aria-hidden
        tabIndex={0}
      />

      <header
        ref={scanPageHeaderRef}
        className="relative z-[110] shrink-0 border-b pt-[max(0.2rem,env(safe-area-inset-top))]"
        style={{
          borderColor: BORDER,
          background: "var(--scanner-header-gradient)",
        }}
      >
        <div className="grid grid-cols-[2.5rem_minmax(0,1fr)_auto] items-start gap-x-1 px-3 pb-0.5 pt-1 sm:px-4">
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
            <h1
              className="operator-heading text-[1.28rem] font-semibold leading-tight tracking-tight sm:text-[1.42rem]"
              style={{ color: TEXT_PRIMARY }}
            >
              {headerTitle}
            </h1>
            {headerSubtitle ? (
              <p className="mt-0.5 text-[11px] font-semibold sm:text-[12px]" style={{ color: MUTED_LABEL }}>
                {headerSubtitle}
              </p>
            ) : null}
            {showWarehouseTrail ? (
              <WarehouseBreadcrumb
                storeLabel={activeStoreLabel}
                palletLabel={warehousePalletLabel}
                shipmentIdLabel={warehouseShipmentIdLabel}
                boxBarcode={contextTrailBoxBarcode}
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
          </div>
          <div className="flex shrink-0 items-start justify-end gap-0.5">
            <OperatorThemeToggle />
            <button
              type="button"
              className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-amber-600 transition hover:bg-amber-500/12 active:scale-95 dark:text-amber-200/90 dark:hover:bg-amber-500/15"
              aria-label="Hard reset session"
              title="Clear local storage and reload"
              onClick={() => {
                if (typeof window !== "undefined" && !window.confirm("Hard reset: clear all local data and reload this page?")) {
                  return;
                }
                try {
                  localStorage.clear();
                } catch {
                  /* ignore quota / private mode */
                }
                window.location.reload();
              }}
            >
              <RotateCcw className="h-5 w-5" strokeWidth={2} />
            </button>
          </div>
        </div>

        {isIdentified ? (
          <div className="border-t px-2 pb-2.5 pt-2" style={{ borderColor: BORDER }}>
          <div className="flex flex-row items-start justify-center gap-0">
            {SCANNER_STEPS.map((step, index) => {
              const active = index === stepIndex;
              const done = index < stepIndex;
              const boxesStepIndex = 1;
              const isBoxesStep = index === boxesStepIndex;
              /** Progress connectors: teal only (never purple). */
              const segmentFilled = index <= stepIndex;
              const segmentColor = index === 0 ? CARD_INNER : segmentFilled ? TEAL_STEP : CARD_INNER;

              const doneNode: CSSProperties = {
                backgroundColor: TEAL_STEP,
                color: "#042f2e",
                boxShadow: `0 0 0 3px ${TEAL_STEP_MUTED}`,
              };
              const inactiveNode: CSSProperties = {
                backgroundColor: BG,
                color: MUTED_LABEL,
                border: `1px solid ${BORDER}`,
              };
              /** Completed steps = teal check never purple. Active Step 3 (boxes) = purple; other active = teal. */
              let nodeFill: CSSProperties;
              if (done) {
                nodeFill = doneNode;
              } else if (active) {
                nodeFill = isBoxesStep
                  ? {
                      backgroundColor: ACTION_PURPLE,
                      color: "#1e1b4b",
                      boxShadow: `0 0 0 3px ${PURPLE_GLOW}`,
                    }
                  : doneNode;
              } else {
                nodeFill = inactiveNode;
              }

              return (
                <Fragment key={step.key}>
                  {index > 0 ? (
                    <div
                      className="mx-1 mt-[14px] h-[3px] min-w-[10px] flex-1 max-w-[52px] rounded-full sm:max-w-none"
                      style={{
                        backgroundColor: segmentColor,
                      }}
                      aria-hidden
                    />
                  ) : null}
                  <div className="flex w-[4.5rem] shrink-0 flex-col items-center sm:w-[5rem]">
                    <div className="flex h-7 w-7 items-center justify-center rounded-full text-[10px] font-bold" style={nodeFill}>
                      {done ? "✓" : step.id}
                    </div>
                    <span
                      className="mt-1.5 text-center text-[9px] font-bold leading-tight sm:text-[10px]"
                      style={{ color: active ? TEXT_PRIMARY : MUTED_LABEL }}
                    >
                      {step.label}
                    </span>
                  </div>
                </Fragment>
              );
            })}
          </div>
        </div>
        ) : null}

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
                  <p className="mt-0.5 truncate font-mono text-xs font-bold" style={{ color: ACCENT_BLUE }}>
                    {contextId}
                  </p>
                  {activeStoreLabel ? (
                    <p className="mt-0.5 truncate text-[10px] font-semibold" style={{ color: MUTED_LABEL }}>
                      Store · <span style={{ color: TEXT_PRIMARY }}>{activeStoreLabel}</span>
                    </p>
                  ) : null}
                </div>
              </div>
              <p className="sr-only" aria-live="polite">
                {scanLine ? `Buffer: ${scanLine}` : "Scanner ready"}
              </p>
            </div>
          </div>
        ) : null}
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
                shipmentIdLabel={warehouseShipmentIdLabel}
                boxBarcode={contextTrailBoxBarcode}
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
        className={`min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-4 ${flowPhase === "items" ? "" : "pt-4"} ${mainScrollClass}`}
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
                Could not activate a store — pick one in the header or verify your connection.
              </p>
            ) : null}

            <section className={`mb-4 rounded-[22px] p-4 sm:p-5 ${glassCard}`} style={{ backgroundColor: CARD, borderColor: BORDER }}>
              <div className="flex items-start gap-3">
                <div
                  className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl ring-1"
                  style={{
                    backgroundColor: "rgba(56,189,248,0.1)",
                    borderColor: "rgba(56,189,248,0.2)",
                    boxShadow: "0 0 12px rgba(56,189,248,0.15)",
                  }}
                >
                  <Barcode className="h-6 w-6" strokeWidth={2} style={{ color: ACCENT_BLUE }} />
                </div>
                <div ref={gateTrackingHelpRef} className="relative min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <h2 className="text-[17px] font-bold leading-tight sm:text-[18px]" style={{ color: TEXT_PRIMARY }}>
                      Tracking or slip code
                    </h2>
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
                  </div>
                  {gateTrackingHelpOpen ? (
                    <div
                      className="absolute left-0 right-0 top-full z-30 mt-2 rounded-xl border px-3 py-2.5 text-left text-[12px] font-medium leading-snug shadow-lg sm:right-auto sm:min-w-[260px] sm:max-w-[min(20rem,calc(100vw-2rem))]"
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
              <div className="mt-4">
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
              </div>
              <div className="mt-4">
                <label
                  htmlFor={`${formId}-gate-manual`}
                  className="mb-1.5 block text-[11px] font-semibold leading-snug text-slate-500 sm:text-[12px]"
                >
                  Tracking or slip code (Scan, Type, or Photo)
                </label>
                <input
                  ref={identifyGateCameraInputRef}
                  type="file"
                  accept="image/*"
                  capture="environment"
                  className="sr-only"
                  tabIndex={-1}
                  aria-hidden
                  onChange={onIdentifyGateCameraFileChange}
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
                    placeholder="Tracking or slip code (Scan, Type, or Photo)"
                    className="scanner-input-glass min-h-[3.25rem] w-full rounded-xl border py-2.5 pl-3.5 pr-[4.75rem] font-mono text-[17px] outline-none transition placeholder:opacity-50 focus:border-teal-400/45 focus:shadow-[0_0_0_2px_rgba(45,212,191,0.22)] sm:pr-[5.25rem] sm:text-[18px]"
                    style={{ color: TEXT_PRIMARY }}
                  />
                  <div className="absolute right-1.5 top-1/2 z-[1] flex -translate-y-1/2 items-center gap-0.5">
                    <button
                      type="button"
                      disabled={busy || identifyGateOcrReading}
                      onClick={openIdentifyGateCameraCapture}
                      className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg outline-none transition hover:bg-sky-500/15 focus-visible:ring-2 focus-visible:ring-sky-400/50 disabled:cursor-not-allowed disabled:opacity-35"
                      style={{
                        color: ACCENT_BLUE,
                        filter: "drop-shadow(0 0 5px rgba(56,189,248,0.65)) drop-shadow(0 0 12px rgba(34,211,238,0.35))",
                      }}
                      aria-label="Read code from photo"
                      title="Take or choose a photo of the label (on-device OCR)"
                    >
                      <Camera className="h-5 w-5" strokeWidth={2.25} aria-hidden />
                    </button>
                    <button
                      type="button"
                      disabled={busy || identifyGateOcrReading || !scanLine.trim()}
                      onClick={() => void onSubmitScan()}
                      className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-teal-100/95 transition hover:bg-teal-500/15 disabled:cursor-not-allowed disabled:opacity-35"
                      style={{ color: "#99f6e4" }}
                      aria-label={busy ? "Searching" : "Search"}
                    >
                      {busy ? <Loader2 className="h-5 w-5 animate-spin" strokeWidth={2} /> : <Search className="h-5 w-5" strokeWidth={2.25} />}
                    </button>
                  </div>
                  {identifyGateOcrReading ? (
                    <div
                      className="absolute inset-0 z-[5] flex flex-col items-center justify-center gap-2 rounded-xl border px-3 py-2 backdrop-blur-md"
                      style={{
                        borderColor: "rgba(56,189,248,0.45)",
                        backgroundColor: "rgba(15,23,42,0.78)",
                        boxShadow: "0 0 32px rgba(56,189,248,0.28), inset 0 0 24px rgba(45,212,191,0.08)",
                      }}
                      role="status"
                      aria-live="polite"
                    >
                      <Loader2
                        className="h-7 w-7 animate-spin"
                        strokeWidth={2}
                        style={{ color: ACCENT_BLUE, filter: "drop-shadow(0 0 10px rgba(56,189,248,0.7))" }}
                      />
                      <span className="text-center text-[12px] font-bold tracking-wide text-sky-100/95">Reading code...</span>
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
                className={`animate-scanner-results-enter relative mb-4 w-full max-w-full overflow-hidden rounded-[22px] border-2 px-6 py-6 sm:px-8 sm:py-7 ${glassCard}`}
                style={{
                  backgroundColor: CARD,
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
                        ["package", "Package"],
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
                    <div className="mt-5">
                      <label
                        htmlFor={`${formId}-gate-physical`}
                        className="mb-2 block text-center text-[11px] font-bold uppercase tracking-widest text-slate-300"
                      >
                        Operator package count
                      </label>
                      <input
                        id={`${formId}-gate-physical`}
                        type="text"
                        inputMode="numeric"
                        autoComplete="off"
                        enterKeyHint="done"
                        value={identifyGatePhysicalBoxStr === "" ? "" : identifyGatePhysicalBoxStr}
                        onFocus={() => setManualOpen(true)}
                        onBlur={() => {
                          window.setTimeout(() => setManualOpen(false), 120);
                        }}
                        onChange={(e) => {
                          const v = e.target.value.replace(/\D/g, "");
                          setIdentifyGatePhysicalBoxStr(v);
                        }}
                        placeholder="e.g. 120"
                        aria-invalid={identifyGateBoxCountShowsError}
                        aria-label="Operator package count for pallet"
                        className={`mx-auto block min-h-[88px] w-full max-w-[min(100%,320px)] rounded-2xl border-2 bg-[#060a10] px-4 py-3 text-center font-mono text-[40px] font-black tabular-nums leading-none text-white shadow-[inset_0_4px_24px_rgba(0,0,0,0.65)] outline-none transition placeholder:text-slate-600 sm:min-h-[96px] sm:text-[48px] ${
                          identifyGateBoxCountShowsError
                            ? "border-red-500/80 focus:border-red-400 focus:shadow-[inset_0_4px_24px_rgba(0,0,0,0.65),0_0_0_3px_rgba(248,113,113,0.35)]"
                            : "border-slate-600/80 focus:border-sky-400/65 focus:shadow-[inset_0_4px_24px_rgba(0,0,0,0.65),0_0_0_3px_rgba(56,189,248,0.22)]"
                        }`}
                      />
                      {identifyGateBoxCountShowsError ? (
                        <p className="mt-2 text-center text-[12px] font-bold text-red-400" role="alert">
                          Enter package count (integer ≥ 1).
                        </p>
                      ) : (
                        <p className="mt-2 text-center text-[11px] font-semibold" style={{ color: MUTED_LABEL }}>
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
                    ) : (
                      <ScanLine className="h-5 w-5" strokeWidth={2.25} />
                    )}
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
            Demo — PLT-, TRACK-, PKG-, SLIP-, or SKU patterns. Supabase optional.
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
            Pick a store in the header to continue.
          </p>
        ) : null}

        {parentIdentified && expectedPkgError && flowPhase !== "items" ? (
          <p
            className="mb-4 rounded-[20px] border px-3.5 py-2.5 text-[12px] font-semibold"
            style={{ borderColor: "rgba(251,191,36,0.35)", backgroundColor: "rgba(69,26,3,0.35)", color: "#fde68a" }}
          >
            {expectedPkgError}
          </p>
        ) : null}

        {flowPhase === "scan" && parentIdentified ? (
          <>
            {/* Parent information — reference layout */}
            <section
              className={`mb-5 rounded-[24px] p-4 ${glassCard}`}
              style={{ backgroundColor: CARD, borderColor: BORDER }}
            >
              <div className="flex gap-4">
                {trackingIdentified ? <TrackingParentIcon /> : <ParentType3DIcon />}
                <dl className="min-w-0 flex-1 space-y-3.5">
                  <div>
                    <dt className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: MUTED_LABEL }}>
                      Parent Type
                    </dt>
                    <dd className="mt-0.5 text-[15px] font-bold text-white">
                      {trackingIdentified ? "Tracking shipment" : "Pallet"}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: MUTED_LABEL }}>
                      {trackingIdentified ? "Tracking number" : "Pallet Code"}
                    </dt>
                    <dd className="mt-0.5 font-mono text-[17px] font-bold" style={{ color: ACCENT_BLUE }}>
                      {trackingIdentified ? activeTracking : activePallet?.pallet_number}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: MUTED_LABEL }}>
                      Boxes {trackingIdentified ? "on shipment" : "on pallet"}
                    </dt>
                    <dd className="mt-0.5 text-[15px] font-bold text-white">
                      {trackingIdentified ? "—" : stats?.totalBoxes ?? "—"}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: MUTED_LABEL }}>
                      Expected units <span className="font-mono text-[9px] normal-case">(expected_packages)</span>
                    </dt>
                    <dd className="mt-0.5 text-[15px] font-bold text-white">
                      {expectedPkgTotals?.expectedUnits ?? "—"}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: MUTED_LABEL }}>
                      Line groups <span className="font-normal">(SKU·FNSKU·disposition)</span>
                    </dt>
                    <dd className="mt-0.5 text-[15px] font-bold text-white">{expectedPkgLines.length}</dd>
                  </div>
                  <div>
                    <dt className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: MUTED_LABEL }}>
                      Status
                    </dt>
                    <dd className="mt-1.5">
                      <span
                        className="inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[11px] font-bold"
                        style={{
                          backgroundColor: SUCCESS_BG,
                          border: `1px solid rgba(52,211,153,0.35)`,
                          color: SUCCESS,
                        }}
                      >
                        <CheckCircle2 className="h-3.5 w-3.5" strokeWidth={2.5} />
                        Ready for slip capture.
                      </span>
                    </dd>
                  </div>
                </dl>
              </div>
            </section>

            {/* Physical box count — industrial numeric field; drives Box N of M */}
            <section className="mb-5">
              <div
                className={`overflow-hidden rounded-[22px] border ${glassCard}`}
                style={{
                  backgroundColor: CARD,
                  borderColor: BORDER,
                  boxShadow: "0 16px 40px -16px rgba(0,0,0,0.65), inset 0 1px 0 rgba(255,255,255,0.05)",
                }}
              >
                <div className="px-4 pb-4 pt-3.5 sm:px-5 sm:pb-5 sm:pt-4">
                  <h2 className="text-center text-base font-bold tracking-tight text-white sm:text-lg">
                    Physical box intake
                  </h2>
                  <p className="mt-1.5 text-center text-[11px] font-medium leading-snug text-slate-400 sm:text-[12px]">
                    Next step shows{" "}
                    <span className="font-mono font-semibold text-slate-200">
                      Box 1 of {typeof physicalBoxCount === "number" && physicalBoxCount > 0 ? physicalBoxCount : "—"}
                    </span>
                    . {!trackingIdentified ? (
                      <>
                        {" "}
                        System packages on pallet:{" "}
                        <span className="font-mono font-semibold text-slate-300">{stats?.totalBoxes ?? "—"}</span>.
                      </>
                    ) : null}{" "}
                    Expected units:{" "}
                    <span className="font-semibold text-slate-300">{expectedPkgTotals?.expectedUnits ?? "—"}</span>.
                    {expectedPackagesRawRowCount != null && expectedPackagesRawRowCount > 0 ? (
                      <>
                        {" "}
                        <span className="text-slate-500">·</span> expected_packages rows:{" "}
                        <span className="font-mono font-semibold text-slate-300">{expectedPackagesRawRowCount}</span>.
                      </>
                    ) : null}
                  </p>
                  {expectedPackagesRawRowCount != null &&
                  expectedPackagesRawRowCount > 0 &&
                  typeof physicalBoxCount === "number" &&
                  physicalBoxCount > 0 &&
                  physicalBoxCount !== expectedPackagesRawRowCount ? (
                    <div
                      className="mt-3 rounded-xl border border-amber-500/20 bg-amber-500/10 px-3 py-2.5 text-center text-[11px] font-medium leading-snug text-amber-200 backdrop-blur-sm sm:text-[12px]"
                      role="status"
                    >
                      Note: You are receiving {physicalBoxCount} boxes, but the system expected {expectedPackagesRawRowCount}.
                      Discrepancy will be logged.
                    </div>
                  ) : null}
                  <label
                    htmlFor={`${formId}-physical-boxes`}
                    className="mt-4 block text-center text-[11px] font-semibold uppercase tracking-widest text-slate-400"
                  >
                    Total Physical Boxes Found
                  </label>
                  <div
                    key={`physical-shake-${physicalCountShakeSeq}`}
                    className={physicalCountShakeSeq > 0 ? "operator-physical-count-shake mt-2" : "mt-2"}
                  >
                    <input
                      ref={physicalBoxCountInputRef}
                      id={`${formId}-physical-boxes`}
                      type="tel"
                      inputMode="numeric"
                      pattern="[0-9]*"
                      autoComplete="off"
                      enterKeyHint="done"
                      className="mx-auto block min-h-[88px] w-full max-w-[280px] rounded-xl border-2 border-slate-600/80 bg-[#060a10] px-4 text-center font-mono text-[44px] font-black tabular-nums leading-none text-white shadow-[inset_0_4px_24px_rgba(0,0,0,0.65)] outline-none transition placeholder:text-slate-600 focus:border-teal-400/65 focus:shadow-[inset_0_4px_24px_rgba(0,0,0,0.65),0_0_0_3px_rgba(45,212,191,0.22)] sm:min-h-[96px] sm:max-w-[320px] sm:text-[52px]"
                      value={physicalBoxCount ?? ""}
                      placeholder="0"
                      onChange={(e) => {
                        const raw = e.target.value.replace(/\D/g, "");
                        if (raw === "") setPhysicalBoxCount(null);
                        else {
                          const n = Number.parseInt(raw, 10);
                          if (!Number.isNaN(n)) setPhysicalBoxCount(n);
                        }
                      }}
                      aria-label="Total physical boxes found"
                    />
                  </div>
                  <p
                    className="mt-3 text-center text-[11px] font-semibold sm:text-[12px]"
                    style={{
                      color:
                        typeof physicalBoxCount === "number" &&
                        physicalBoxCount > 0 &&
                        slipPhoto1Url
                          ? SUCCESS
                          : "rgba(251,191,113,0.95)",
                    }}
                  >
                    {typeof physicalBoxCount === "number" && physicalBoxCount > 0 ? (
                      slipPhoto1Url ? (
                        <>
                          <CheckCircle2 className="-mt-0.5 mr-1 inline-block h-3.5 w-3.5 align-middle" strokeWidth={2} />
                          Count set — tap Confirm & Start Box Scan when ready.
                        </>
                      ) : (
                        <>Count set — capture slip photo 1 below, then confirm.</>
                      )
                    ) : (
                      <>Physical box count is required (greater than zero) before you can start box scan.</>
                    )}
                  </p>
                </div>
              </div>
            </section>

            {/* Expected inventory summary */}
            <section
              className={`mb-5 rounded-[24px] p-4 ${glassCard}`}
              style={{
                backgroundColor: CARD,
                borderColor: trackingIdentified ? PURPLE_RING : "rgba(45,212,191,0.35)",
                boxShadow: trackingIdentified
                  ? `inset 0 0 0 1px rgba(167,139,250,0.12)`
                  : `inset 0 0 0 1px rgba(45,212,191,0.1)`,
              }}
            >
              <div className="mb-3 flex flex-col gap-1.5">
                <div className="flex items-center gap-2">
                  <Package
                    className="h-4 w-4"
                    strokeWidth={2}
                    style={{ color: trackingIdentified ? ACTION_PURPLE : TEAL_STEP }}
                  />
                  <h2 className="text-sm font-bold tracking-tight text-slate-400">Expected Inventory Summary</h2>
                </div>
                <p className="text-[12px] font-semibold leading-snug" style={{ color: MUTED_LABEL }}>
                  From <span className="font-mono text-[11px]">expected_packages</span>, aggregated by SKU · FNSKU · disposition.
                  Parent:{" "}
                  <span className="font-mono font-bold" style={{ color: trackingIdentified ? ACTION_PURPLE : TEAL_STEP }}>
                    {trackingIdentified ? activeTracking : activePallet?.pallet_number}
                  </span>
                  {trackingIdentified ? "" : " (all package trackings on pallet)"}.
                </p>
              </div>
              {expectedPkgLines.length === 0 ? (
                <p className="text-[13px] font-medium" style={{ color: MUTED_LABEL }}>
                  No expected_packages lines for this parent in the current store.
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
              <div
                className="mt-4 flex flex-wrap items-center justify-center gap-x-2 gap-y-1 border-t pt-3 text-[11px] font-semibold sm:text-[12px]"
                style={{
                  borderColor: BORDER,
                  color: trackingIdentified ? ACTION_PURPLE : TEAL_STEP,
                }}
              >
                <span className="text-center opacity-90">
                  {expectedPkgLines.length} SKUs · {totalSkuUnits} units total
                </span>
                <Info className="h-3.5 w-3.5 shrink-0 opacity-70" strokeWidth={2} aria-hidden />
              </div>
            </section>

            {/* Capture slip photos */}
            <section className="mb-5">
              <div className="mb-3 flex items-center gap-2">
                <Camera className="h-4 w-4" style={{ color: ACCENT_BLUE }} strokeWidth={2} />
                <h2 className="text-[15px] font-bold text-white">Capture Slip Photos</h2>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <input
                    ref={slip1Ref}
                    type="file"
                    accept="image/*"
                    capture="environment"
                    className="hidden"
                    onChange={(e) => onSlipFile(1, e.target.files?.[0])}
                  />
                  <div
                    role="button"
                    tabIndex={0}
                    onClick={() => slip1Ref.current?.click()}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        slip1Ref.current?.click();
                      }
                    }}
                    className={`relative flex aspect-[4/5] w-full cursor-pointer flex-col overflow-hidden rounded-[20px] border-2 border-dashed outline-none transition hover:brightness-105 focus-visible:ring-2 focus-visible:ring-sky-500/50 ${glassCard} ${slipVisionProcessing ? "pointer-events-none" : ""}`}
                    style={{
                      borderColor: slipPhoto1Url ? "rgba(52,211,153,0.4)" : "rgba(56,189,248,0.35)",
                      backgroundColor: slipPhoto1Url ? CARD : CARD_INNER,
                    }}
                  >
                    <span
                      className="absolute right-2 top-2 z-[2] rounded-md px-2 py-0.5 text-[10px] font-bold"
                      style={{
                        backgroundColor: "rgba(52,211,153,0.2)",
                        color: SUCCESS,
                        border: "1px solid rgba(52,211,153,0.45)",
                      }}
                    >
                      Required
                    </span>
                    {slipPhoto1Url ? (
                      <>
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={slipPhoto1Url} alt="Slip capture 1" className="h-full w-full object-cover" />
                        {slipVisionProcessing ? (
                          <div className="absolute inset-0 z-[4] flex flex-col items-center justify-center gap-3 bg-black/65 backdrop-blur-[2px]">
                            <div className="relative h-16 w-[88%] overflow-hidden rounded-lg">
                              <div
                                className="pointer-events-none absolute inset-0 overflow-hidden rounded-[inherit]"
                                aria-hidden
                              >
                                <div
                                  className="operator-scan-laser-beam absolute left-1/2 top-1/2 h-[3px] w-[92%] -translate-x-1/2 rounded-full shadow-[0_0_18px_rgba(45,212,191,0.95)]"
                                  style={{
                                    background: `linear-gradient(90deg, transparent 0%, ${TEAL_STEP} 45%, transparent 100%)`,
                                  }}
                                />
                              </div>
                            </div>
                            <div className="flex items-center gap-2 px-3 text-center text-[13px] font-bold text-white">
                              <Loader2 className="h-5 w-5 shrink-0 animate-spin" style={{ color: TEAL_STEP }} strokeWidth={2.25} />
                              Processing Slip with AI…
                            </div>
                            <p className="max-w-[220px] text-center text-[10px] font-semibold leading-snug text-white/75">
                              GPT-4o Vision · extracting VRET, shipment ID, and line items
                            </p>
                          </div>
                        ) : null}
                        <div
                          className="absolute left-2 top-10 flex h-9 w-9 items-center justify-center rounded-full shadow-lg ring-2 ring-emerald-400/50"
                          style={{ backgroundColor: "rgba(6,78,59,0.95)", color: SUCCESS }}
                          aria-hidden
                        >
                          <CheckCircle2 className="h-5 w-5" strokeWidth={2.5} />
                        </div>
                        <div
                          className="absolute bottom-0 left-0 right-0 flex items-center justify-center gap-1 py-2 text-[11px] font-bold"
                          style={{ backgroundColor: "rgba(6,78,59,0.92)", color: SUCCESS }}
                        >
                          <CheckCircle2 className="h-3.5 w-3.5" />
                          Photo captured
                        </div>
                      </>
                    ) : (
                      <div className="flex flex-1 flex-col items-center justify-center gap-2 px-2 pb-4 pt-8">
                        <Camera className="h-8 w-8" style={{ color: ACTION_BLUE }} strokeWidth={1.75} />
                        <span className="text-center text-[12px] font-semibold" style={{ color: ACCENT_BLUE }}>
                          Add Photo
                        </span>
                        <span className="text-center text-[11px] font-medium" style={{ color: ACTION_BLUE }}>
                          Tap to capture
                        </span>
                      </div>
                    )}
                  </div>
                  <p className="mt-1.5 text-center text-[11px] font-semibold" style={{ color: MUTED_LABEL }}>
                    Slip Photo 1
                  </p>
                </div>
                <div>
                  <input
                    ref={slip2Ref}
                    type="file"
                    accept="image/*"
                    capture="environment"
                    className="hidden"
                    onChange={(e) => onSlipFile(2, e.target.files?.[0])}
                  />
                  <div
                    role="button"
                    tabIndex={0}
                    onClick={() => slip2Ref.current?.click()}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        slip2Ref.current?.click();
                      }
                    }}
                    className={`relative flex aspect-[4/5] w-full cursor-pointer flex-col overflow-hidden rounded-[20px] border-2 border-dashed outline-none transition hover:brightness-105 focus-visible:ring-2 focus-visible:ring-violet-500/45 ${glassCard}`}
                    style={{
                      borderColor: "rgba(139,92,246,0.35)",
                      backgroundColor: slipPhoto2Url ? CARD : CARD_INNER,
                    }}
                  >
                    <span
                      className="absolute right-2 top-2 z-[1] rounded-md px-2 py-0.5 text-[10px] font-bold"
                      style={{
                        backgroundColor: "rgba(139,92,246,0.15)",
                        color: "#c4b5fd",
                        border: "1px solid rgba(167,139,250,0.35)",
                      }}
                    >
                      Optional
                    </span>
                    {slipPhoto2Url ? (
                      <>
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={slipPhoto2Url} alt="Slip capture 2" className="h-full w-full object-cover" />
                        <button
                          type="button"
                          onClick={(ev) => {
                            ev.stopPropagation();
                            revokeSlip(2);
                          }}
                          className="absolute right-2 top-9 z-[2] rounded-full bg-black/55 p-1 text-white"
                          aria-label="Remove photo"
                        >
                          <X className="h-4 w-4" />
                        </button>
                      </>
                    ) : (
                      <div className="flex flex-1 flex-col items-center justify-center gap-2 px-2 pb-4 pt-8">
                        <Camera className="h-8 w-8 text-violet-400/90" strokeWidth={1.75} />
                        <span className="text-center text-[12px] font-semibold text-violet-300/90">Add Photo</span>
                        <span className="text-center text-[11px] font-medium text-violet-400/90">Tap to capture</span>
                      </div>
                    )}
                  </div>
                  <p className="mt-1.5 text-center text-[11px] font-semibold" style={{ color: MUTED_LABEL }}>
                    Slip Photo 2
                  </p>
                </div>
              </div>
            </section>

            <div className="mb-5">
              <button
                type="button"
                disabled={
                  !slipPhoto1Url ||
                  slipVisionProcessing ||
                  !(getAIUnifiedKeyFromStorage() || getOpenAIApiKeyFromStorage())
                }
                onClick={() => void runManualSlipVisionFromCapture()}
                className="flex h-[48px] w-full items-center justify-center gap-2 rounded-[16px] text-[14px] font-bold transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-45"
                style={{
                  background: `linear-gradient(180deg, ${ACTION_BLUE} 0%, ${ACTION_BLUE_DEEP} 100%)`,
                  boxShadow: "0 6px 18px rgba(14,165,233,0.35)",
                  color: "#0f172a",
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
              <p className="mt-2 text-center text-[11px] font-semibold" style={{ color: MUTED_LABEL }}>
                Requires Slip Photo 1 and an API key in Settings. Scans no longer trigger Vision automatically.
              </p>
            </div>

            <button
              type="button"
              disabled={!parentIdentified || !slipPhoto1Url || slipVisionProcessing}
              onClick={handleConfirmStartBoxScan}
              className="mb-3 flex h-[52px] w-full items-center justify-center gap-2 rounded-[18px] text-[15px] font-bold text-white shadow-[0_8px_24px_rgba(14,165,233,0.35)] transition hover:brightness-110 active:scale-95 disabled:cursor-not-allowed disabled:opacity-35"
              style={{
                background: `linear-gradient(180deg, ${ACTION_BLUE} 0%, ${ACTION_BLUE_DEEP} 100%)`,
                boxShadow: isReadyForBoxScan ? `0 10px 28px rgba(14,165,233,0.4)` : undefined,
              }}
            >
              <ScanLine className="h-5 w-5" strokeWidth={2.25} />
              Confirm & Start Box Scan
            </button>
            <button
              type="button"
              onClick={editParent}
              className="mb-6 flex h-[48px] w-full items-center justify-center gap-2 rounded-[18px] border-2 bg-transparent text-[14px] font-bold transition hover:bg-white/5"
              style={{ borderColor: ACTION_BLUE, color: ACCENT_BLUE }}
            >
              <Pencil className="h-4 w-4" strokeWidth={2} />
              Edit Parent
            </button>
          </>
        ) : null}

        {flowPhase === "scan" ? (
          <>
            <section className={`mb-4 rounded-[22px] p-3 ${glassCard}`} style={{ backgroundColor: CARD, borderColor: BORDER }}>
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
                                  Expected lines come from <span className="font-mono text-[11px] text-sky-200/90">expected_packages</span>{" "}
                                  for this tracking and store. Capture slip photos on this step, then start box scan.
                                </>
                              ) : (
                                <>
                                  Scan a pallet label, tracking label, carton, slip, or item code. When you lock onto a tracking,
                                  lines match <span className="font-mono text-[11px] text-sky-200/90">expected_packages</span> for this
                                  org and store.
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
                    {activeTracking}
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
                    label="Expected"
                    value={expectedPkgTotals ? String(expectedPkgTotals.expectedUnits) : "—"}
                    icon={ClipboardList}
                    glow="blue"
                    iconColor={ACCENT_BLUE}
                    valueColor={ACTION_BLUE}
                  />
                  <PalletScanStatTile
                    label="Scanned"
                    value={expectedPkgTotals ? String(expectedPkgTotals.scannedUnits) : "—"}
                    icon={ScanLine}
                    glow="green"
                    iconColor={SUCCESS}
                    valueColor={SUCCESS}
                  />
                  <PalletScanStatTile
                    label="Remaining"
                    value={expectedPkgTotals ? String(expectedPkgTotals.remainingUnits) : "—"}
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
                    label="Expected"
                    value={stats ? String(stats.expectedItems) : "—"}
                    icon={ClipboardList}
                    glow="blue"
                    iconColor={ACCENT_BLUE}
                    valueColor={TEXT_PRIMARY}
                  />
                  <PalletScanStatTile
                    label="Scanned"
                    value={stats ? String(stats.scannedItems) : "—"}
                    icon={ScanLine}
                    glow="green"
                    iconColor={SUCCESS}
                    valueColor={SUCCESS}
                  />
                  <PalletScanStatTile
                    label="Remaining"
                    value={stats ? String(stats.remainingItems) : "—"}
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
                backgroundColor: CARD,
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
                      {trackingIdentified ? activeTracking : activePallet?.pallet_number}
                    </span>
                  </p>
                ) : (
                  <p className="text-[12px] font-medium" style={{ color: MUTED_LABEL }}>
                    Scan a pallet or tracking to load <span className="font-mono text-[11px]">expected_packages</span>.
                  </p>
                )}
              </div>
              {!parentIdentified ? (
                <p className="text-[13px] font-medium" style={{ color: MUTED_LABEL }}>
                  No parent selected.
                </p>
              ) : expectedPkgLines.length === 0 ? (
                <p className="text-[13px] font-medium" style={{ color: MUTED_LABEL }}>
                  No expected_packages rows for this parent (store + worklist).
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
                    No active stores for this organization — add a store in Settings before saving packages.
                  </p>
                ) : null}

                {isSupabaseConfigured() && !operatorStoresLoading && operatorStores.length > 0 && !sessionStoreId ? (
                  <p
                    className="mb-4 rounded-[20px] border px-3.5 py-2.5 text-[12px] font-semibold"
                    style={{ borderColor: "rgba(248,113,113,0.35)", backgroundColor: "rgba(69,10,10,0.35)", color: "#fecaca" }}
                  >
                    Select an active store in the header — packages require a store scope.
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

                {/* Step 3 — Box intake only (package + carton evidence). Item barcodes belong in Step 4. */}
                <section
                  className={`mb-4 rounded-[24px] border p-4 ${glassCard}`}
                  style={{
                    backgroundColor: CARD,
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
                          {trackingIdentified ? "Shipment" : "Pallet"} ID
                        </p>
                        <p className="mt-0.5 font-mono text-[17px] font-bold" style={{ color: ACTION_PURPLE }}>
                          {trackingIdentified ? activeTracking : activePallet?.pallet_number}
                        </p>
                      </div>
                      <div className="flex flex-wrap gap-x-8 gap-y-2">
                        <div>
                          <p className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: MUTED_LABEL }}>
                            Expected boxes
                          </p>
                          <p className="text-[20px] font-bold tabular-nums text-white">{physicalBoxCount ?? "—"}</p>
                        </div>
                        <div>
                          <p className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: MUTED_LABEL }}>
                            Scanned boxes
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
                    Locked: {activeBoxSession.barcode}
                  </p>
                ) : null}

                <section
                  className={`mb-4 rounded-[24px] p-4 ${glassCard}`}
                  style={{
                    backgroundColor: CARD,
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
                        placeholder="Type box barcode if scanner fails"
                        disabled={Boolean(activeBoxSession)}
                        className="scanner-input-glass h-11 min-w-0 flex-1 rounded-xl border px-3 font-mono text-[14px] outline-none focus:ring-2 focus:ring-violet-500/40 disabled:opacity-45"
                        style={{ borderColor: PURPLE_RING, color: TEXT_PRIMARY }}
                      />
                    </div>
                  </div>
                  <button
                    type="button"
                    disabled={busy || !scanLine.trim() || Boolean(activeBoxSession)}
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
                  style={{ backgroundColor: CARD, borderColor: PURPLE_RING }}
                >
                  <h2 className="mb-4 text-[15px] font-bold text-white">Required Box Photos</h2>
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
                  style={{ backgroundColor: CARD, borderColor: PURPLE_RING }}
                >
                  <h3 className="text-[15px] font-bold text-white">AI Slip Reading</h3>
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
                    style={{ backgroundColor: CARD, borderColor: PURPLE_RING }}
                  >
                    <div className="mb-3 flex flex-col gap-1">
                      <h3 className="text-[14px] font-bold text-white">Shipment lines (reference)</h3>
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
              <section className={`rounded-[24px] border p-5 ${glassCard}`} style={{ borderColor: BORDER, backgroundColor: CARD }}>
                <p className="text-[15px] font-bold leading-snug text-white">Select or scan a box before inspecting items.</p>
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
                Select an active store in the header to save returns and bump expected_packages.
              </p>
            ) : null}

            {itemScanPackageId && !isUuidString(itemScanPackageId) && isSupabaseConfigured() ? (
              <p
                className="mb-4 rounded-[20px] border px-3.5 py-2.5 text-[12px] font-semibold"
                style={{ borderColor: "rgba(251,191,36,0.45)", backgroundColor: "rgba(69,26,3,0.35)", color: "#fde68a" }}
              >
                Demo package id — saves use <span className="font-mono">package_id = null</span> until you intake a live box.
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
                style={{ backgroundColor: CARD, borderColor: "rgba(45,212,191,0.22)" }}
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
                backgroundColor: CARD,
                borderColor: "rgba(45,212,191,0.35)",
                boxShadow: `inset 0 0 0 1px rgba(45,212,191,0.08)`,
              }}
            >
              <p className="text-center text-[16px] font-bold text-white">Scan product barcode</p>
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

            <section className={`mb-4 rounded-[24px] border p-4 ${glassCard}`} style={{ backgroundColor: CARD, borderColor: BORDER }}>
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

            <section className={`mb-4 rounded-[24px] border p-4 ${glassCard}`} style={{ backgroundColor: CARD, borderColor: BORDER }}>
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
              <section className={`mb-6 rounded-[24px] p-4 ${glassCard}`} style={{ backgroundColor: CARD, borderColor: BORDER }}>
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
                  Review extracted IDs and line items. Confirm applies shipment context before you save boxes to{" "}
                  <span className="font-mono text-[10px]">packages</span>.
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
                  <span className="font-mono text-emerald-50">expected_packages</span> · tracking{" "}
                  <span className="font-mono text-white">{slipVisionModal.suggestedTracking}</span>
                </div>
              ) : (
                <div className="mt-3 rounded-xl border border-amber-500/35 bg-amber-500/10 px-3 py-2.5 text-[11px] font-semibold leading-relaxed text-amber-100 shadow-[0_0_22px_rgba(245,158,11,0.12)]">
                  <span className="mr-2 inline-block rounded-full border border-amber-500/30 bg-amber-500/20 px-2 py-0.5 text-[10px] font-black uppercase tracking-wide text-amber-400 shadow-[0_0_14px_rgba(245,158,11,0.22)]">
                    Not confirmed
                  </span>
                  <AlertTriangle className="mr-1 inline-block h-4 w-4 align-text-bottom text-amber-400" strokeWidth={2} />
                  No <span className="font-mono text-amber-50/95">expected_packages</span> row for these IDs (space/case-insensitive
                  tracking search was tried). You can still confirm slip labels; scan or set tracking manually.
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
                            No expected_packages line matched (SKU / FNSKU / description heuristic).
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
                  Choose match type: Tracking → Package → Slip → Pallet → Item
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
                  ["package", "Package"],
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
                  Tracking not found in the database. Create a new unknown package with this scan as{" "}
                  <span className="font-mono text-amber-50/95">tracking_number</span>? You can continue receiving; worklist data may
                  arrive later.
                </p>
                {operatorStoresLoading ? (
                  <p className="mt-2 text-[11px] font-semibold text-amber-200/75">Loading stores…</p>
                ) : !sessionStoreId ? (
                  <p className="mt-2 text-[11px] font-semibold text-amber-200/75">
                    {operatorStores.length === 0 && !kioskStoreLocked
                      ? "Add an active store for this organization in Settings, or set NEXT_PUBLIC_STORE_ID for kiosk mode."
                      : "Select an active store in the header (or configure NEXT_PUBLIC_STORE_ID) before creating a package."}
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
                    Create unknown package
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
