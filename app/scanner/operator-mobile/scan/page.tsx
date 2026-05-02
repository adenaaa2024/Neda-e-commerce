"use client";

import {
  Component,
  Fragment,
  Suspense,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
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
import { useOperatorSessionStore } from "../_components/OperatorSessionStoreProvider";

/** Reference palette (pallet review mockup) */
const BG = "#0B1218";
const CARD = "#16212B";
const CARD_INNER = "#1a2835";
const BORDER = "#243241";
const MUTED_LABEL = "#8ba3b8";
const TEXT_PRIMARY = "#f1f5f9";
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

const glassCard = `border shadow-[0_12px_40px_-18px_rgba(0,0,0,0.65),inset_0_1px_0_0_rgba(255,255,255,0.06)]`;

const mainScrollClass =
  "[scrollbar-width:thin] [scrollbar-color:#243241_#0B1218] [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-[#243241]/90 hover:[&::-webkit-scrollbar-thumb]:bg-[#334155]/90";

/** Step indices 0–3: Parent (scan) → Review → Box Scan → Item Scan */
const STEPPER = [{ label: "Parent" }, { label: "Review" }, { label: "Box Scan" }, { label: "Item Scan" }] as const;

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

type FlowPhase = "scan" | "review" | "boxes" | "items";

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
    successFlash = false,
  } = props;
  const isLg = cornerSize === "lg";
  const tlCls = isLg ? "left-4 top-4 h-10 w-10 rounded-tl-[14px]" : "left-3 top-3 h-9 w-9 rounded-tl-[12px]";
  const trCls = isLg ? "right-4 top-4 h-10 w-10 rounded-tr-[14px]" : "right-3 top-3 h-9 w-9 rounded-tr-[12px]";
  const blCls = isLg ? "bottom-4 left-4 h-10 w-10 rounded-bl-[14px]" : "bottom-3 left-3 h-9 w-9 rounded-bl-[12px]";
  const brCls = isLg ? "bottom-4 right-4 h-10 w-10 rounded-br-[14px]" : "bottom-3 right-3 h-9 w-9 rounded-br-[12px]";
  return (
    <div
      className={`relative flex flex-col items-center justify-center overflow-hidden rounded-[22px] border shadow-inner ${dashedBorder ? "border-dashed" : ""}`}
      style={{ ...frameStyle, minHeight }}
    >
      <span className={`pointer-events-none absolute ${tlCls}`} style={{ borderLeft: `3px solid ${cornerColor}`, borderTop: `3px solid ${cornerColor}` }} />
      <span className={`pointer-events-none absolute ${trCls}`} style={{ borderRight: `3px solid ${cornerColor}`, borderTop: `3px solid ${cornerColor}` }} />
      <span className={`pointer-events-none absolute ${blCls}`} style={{ borderBottom: `3px solid ${cornerColor}`, borderLeft: `3px solid ${cornerColor}` }} />
      <span className={`pointer-events-none absolute ${brCls}`} style={{ borderBottom: `3px solid ${cornerColor}`, borderRight: `3px solid ${cornerColor}` }} />
      <div className="pointer-events-none absolute inset-0 overflow-hidden rounded-[inherit]" aria-hidden>
        <div className="operator-handheld-red-laser" />
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

function ExpectedInventoryLineRow(props: {
  line: TrackingOperatorLine;
  accent: ExpectedInventoryAccent;
}) {
  const { line, accent } = props;
  const iconWrapStyle: CSSProperties =
    accent === "teal"
      ? {
          borderColor: "rgba(45,212,191,0.35)",
          boxShadow: "inset 0 1px 0 rgba(255,255,255,0.06), 0 0 14px rgba(45,212,191,0.12)",
        }
      : accent === "purple"
        ? {
            borderColor: PURPLE_RING,
            boxShadow: "inset 0 1px 0 rgba(255,255,255,0.06), 0 0 14px rgba(139,92,246,0.12)",
          }
        : {
            borderColor: BORDER,
            boxShadow: "inset 0 1px 0 rgba(255,255,255,0.04)",
          };
  const iconColor = accent === "teal" ? TEAL_STEP : accent === "purple" ? ACTION_PURPLE : "rgba(196,181,253,0.9)";

  return (
    <li className="grid grid-cols-1 gap-3 border-b border-[#243241] py-4 first:pt-0 last:border-b-0 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start">
      <div className="flex min-w-0 gap-3">
        <div
          className="flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-xl border ring-1"
          style={{ backgroundColor: CARD_INNER, ...iconWrapStyle }}
          aria-hidden
        >
          <PackageOpen className="h-7 w-7" strokeWidth={2} style={{ color: iconColor }} />
        </div>
        <div className="min-w-0 flex-1 space-y-1">
          <p className="text-[17px] font-bold leading-snug tracking-tight text-white">{line.productLabel}</p>
          <p className="text-[11px] font-semibold leading-snug" style={{ color: MUTED_LABEL }}>
            <span className="font-mono text-[11px]" style={{ color: "rgba(148,163,184,0.95)" }}>
              {line.asin?.trim() ? line.asin.trim() : "—"}
            </span>
            <span className="mx-1.5 font-normal opacity-50" aria-hidden>
              ·
            </span>
            <span className="font-mono text-[11px]" style={{ color: "rgba(148,163,184,0.85)" }}>
              {line.sku?.trim() ? line.sku.trim() : "—"}
            </span>
          </p>
          <p className="text-[10px] font-semibold" style={{ color: "rgba(56,189,248,0.55)" }}>
            FNSKU <span className="font-mono text-[11px] text-sky-200/80">{line.fnsku || "—"}</span>
            {line.disposition ? (
              <>
                <span className="mx-1.5 opacity-40" aria-hidden>
                  ·
                </span>
                <span style={{ color: accent === "purple" ? "rgba(196,181,253,0.95)" : "rgba(45,212,191,0.85)" }}>{line.disposition}</span>
              </>
            ) : null}
          </p>
        </div>
      </div>
      <div className="flex shrink-0 gap-6 sm:flex-col sm:gap-2 sm:text-right">
        <div>
          <p className="text-[9px] font-bold uppercase tracking-wide" style={{ color: MUTED_LABEL }}>
            Expected
          </p>
          <p className="mt-0.5 text-[20px] font-bold tabular-nums leading-none" style={{ color: ACTION_BLUE }}>
            {line.expectedQty}
          </p>
        </div>
        <div>
          <p className="text-[9px] font-bold uppercase tracking-wide" style={{ color: MUTED_LABEL }}>
            Scanned
          </p>
          <p
            className="mt-0.5 text-[20px] font-bold tabular-nums leading-none"
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
  palletLabel: string | null;
  shipmentIdLabel: string | null;
  boxVretOrBarcode: string | null;
  flowPhase: FlowPhase;
}) {
  const { palletLabel, shipmentIdLabel, boxVretOrBarcode, flowPhase } = props;
  const sep = (
    <span className="mx-0.5 font-black tabular-nums" style={{ color: BORDER }}>
      ›
    </span>
  );
  const palletHot = Boolean(palletLabel) || flowPhase !== "scan";
  const shipmentHot = Boolean(shipmentIdLabel);
  const boxHot = flowPhase === "boxes" || flowPhase === "items";
  const boxParen = boxVretOrBarcode?.trim() ? boxVretOrBarcode.trim() : "—";
  const itemsHot = flowPhase === "items";

  return (
    <nav
      className="mt-1.5 flex flex-wrap items-center justify-center gap-y-0.5 px-1 text-[11px] font-bold leading-tight"
      aria-label="Warehouse path"
    >
      <span style={{ color: MUTED_LABEL }}>Pallet</span>
      {sep}
      <span className="max-w-[26vw] truncate font-mono sm:max-w-[120px]" style={{ color: palletHot ? TEAL_STEP : MUTED_LABEL }}>
        {palletLabel ?? "—"}
      </span>
      {sep}
      <span className="max-w-[32vw] truncate font-mono text-[11px] sm:max-w-[200px]" style={{ color: shipmentHot ? TEXT_PRIMARY : MUTED_LABEL }}>
        {shipmentIdLabel ?? "—"}
      </span>
      {sep}
      <span style={{ color: MUTED_LABEL }}>Box</span>
      <span className="max-w-[30vw] truncate font-mono sm:max-w-[160px]" style={{ color: boxHot && boxParen !== "—" ? SUCCESS : MUTED_LABEL }}>
        ({boxParen})
      </span>
      {sep}
      <span style={{ color: itemsHot ? TEAL_STEP : MUTED_LABEL }}>Items</span>
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
  /** Chrome height for fixed Item-phase Active Context bar (`padding-top` under `top: 0`). */
  const scanPageHeaderRef = useRef<HTMLElement>(null);
  const [itemsContextBarInsetPx, setItemsContextBarInsetPx] = useState(0);
  const modalOpenRef = useRef(false);
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
  const [itemBarcodeMiss, setItemBarcodeMiss] = useState<string | null>(null);
  const [syncErrorToast, setSyncErrorToast] = useState<string | null>(null);

  const [expectedPkgLines, setExpectedPkgLines] = useState<TrackingOperatorLine[]>([]);
  const [expectedPkgTotals, setExpectedPkgTotals] = useState<TrackingExpectationTotals | null>(null);
  const [expectedPkgError, setExpectedPkgError] = useState<string | null>(null);
  /** Distinct `tracking_number` values present on loaded `expected_packages` rows — for carton scan match toast. */
  const [expectedPkgTrackingNumbers, setExpectedPkgTrackingNumbers] = useState<string[]>([]);
  const [intakeToast, setIntakeToast] = useState<string | null>(null);

  const laserEnabled = (flowPhase === "scan" || flowPhase === "boxes" || flowPhase === "items") && !manualOpen;

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

  useLayoutEffect(() => {
    if (flowPhase !== "items") return;
    const el = scanPageHeaderRef.current;
    if (!el) return;
    const measure = () => setItemsContextBarInsetPx(el.offsetHeight);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [flowPhase]);

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
              setExpectedPkgTrackingNumbers(snap.expectedTrackingNumbers);
              setExpectedPkgError(null);
            } else if (activePallet?.id) {
              const snap = mockPalletExpectationSnapshot();
              setExpectedPkgLines(snap.lines);
              setExpectedPkgTotals(snap.totals);
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
    if (flowPhase !== "boxes") {
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
    if (!scanSuccessFlash) return;
    const t = window.setTimeout(() => setScanSuccessFlash(false), 300);
    return () => window.clearTimeout(t);
  }, [scanSuccessFlash]);

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
      void runResolve(code);
    });
  }, [searchParams, pathname, router, runResolve]);

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
    [busy, expectedPkgDetailRows, populateDraftFromEpRow, scheduleFocusScanner],
  );

  const beginItemPhase = useCallback(() => {
    if (activeBoxSession?.packageId) {
      setItemScanPackageId(activeBoxSession.packageId);
      setItemScanPackageLabel(activeBoxSession.barcode);
    }
    setFlowPhase("items");
    scheduleFocusScanner();
  }, [activeBoxSession, scheduleFocusScanner]);

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

  const onSubmitScan = useCallback(
    async (e?: FormEvent) => {
      e?.preventDefault();
      const code = scanLine.trim();
      setScanLine("");
      if (flowPhase === "boxes") {
        await handleBoxIntakeScan(code);
        return;
      }
      if (flowPhase === "items") {
        await handleItemBarcodeScan(code);
        return;
      }
      await runResolve(code);
    },
    [scanLine, flowPhase, handleBoxIntakeScan, handleItemBarcodeScan, runResolve],
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

  const palletIdentified = Boolean(activePallet);
  const trackingIdentified = Boolean(activeTracking);
  const parentIdentified = palletIdentified || trackingIdentified;

  const stepIndex =
    flowPhase === "scan" ? 0 : flowPhase === "review" ? 1 : flowPhase === "boxes" ? 2 : 3;

  const headerTitle =
    flowPhase === "scan"
      ? "Receiving Scan"
      : flowPhase === "review"
        ? trackingIdentified
          ? "Shipment Review"
          : "Pallet Review"
        : flowPhase === "boxes"
          ? "Box Scan"
          : "Item Scan & Inspection";

  const headerSubtitle = `Step ${stepIndex + 1} of ${STEPPER.length}`;

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
    scheduleFocusScanner();
  };

  const canContinueToBoxScan =
    Boolean(slipPhoto1Url) &&
    typeof physicalBoxCount === "number" &&
    physicalBoxCount > 0 &&
    parentIdentified;

  const totalSkuUnits =
    expectedPkgTotals?.expectedUnits ?? expectedPkgLines.reduce((s, l) => s + l.expectedQty, 0);

  const expectedBoxesForProgress = Math.max(0, physicalBoxCount ?? 0);
  /** Denominator for Box N of M — always from Review step `physicalBoxCount`. */
  const boxIntakeDenom = Math.max(expectedBoxesForProgress, 1);
  const boxOrdinal = Math.min(scannedBoxesSavedCount + 1, boxIntakeDenom);
  const slipPagesCaptured = (slipPhoto1Url ? 1 : 0) + (slipPhoto2Url ? 1 : 0);
  const matchedItemsPreviewCount = aiSlipReaderPhase === "matched" ? expectedPkgLines.length : 0;
  const showSlipMatchedBadge =
    aiSlipReaderPhase === "matched" &&
    expectedPkgLines.length > 0 &&
    (!slipBarcodeExtract?.shipmentId ||
      trackingKeysEqual(slipBarcodeExtract.shipmentId, activeTracking ?? ""));
  const showWarehouseTrail = parentIdentified || directBox || flowPhase !== "scan";
  const warehousePalletLabel = activePallet?.pallet_number ?? (directBox ? "Direct" : null);
  const warehouseShipmentIdLabel =
    activeTracking?.trim() || slipBarcodeExtract?.shipmentId?.trim() || null;
  const warehouseBoxLabel =
    slipBarcodeExtract?.vretId ?? activeBoxSession?.barcode ?? itemScanPackageLabel ?? null;

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

  const showContextHeader = flowPhase !== "review" && flowPhase !== "boxes" && flowPhase !== "items";

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
        className="relative z-[110] shrink-0 border-b pt-[max(0.35rem,env(safe-area-inset-top))]"
        style={{
          borderColor: BORDER,
          background: `linear-gradient(180deg, rgba(22,33,43,0.95) 0%, ${BG} 100%)`,
        }}
      >
        <div className="flex items-start gap-1 px-3 pb-1 pt-2 sm:px-4">
          <button
            type="button"
            onClick={() => {
              if (flowPhase === "items") setFlowPhase("boxes");
              else if (flowPhase === "boxes") setFlowPhase("review");
              else if (flowPhase === "review") setFlowPhase("scan");
              else router.back();
            }}
            className="mt-0.5 flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-white transition hover:bg-white/8 active:scale-95"
            aria-label="Go back"
          >
            <ArrowLeft className="h-5 w-5" strokeWidth={2} />
          </button>
          <div className="min-w-0 flex-1 text-center">
            <h1 className="text-[1.35rem] font-bold tracking-tight text-white">{headerTitle}</h1>
            <p className="mt-0.5 text-[11px] font-semibold" style={{ color: MUTED_LABEL }}>
              {headerSubtitle}
            </p>
            {showWarehouseTrail ? (
              <WarehouseBreadcrumb
                palletLabel={warehousePalletLabel}
                shipmentIdLabel={warehouseShipmentIdLabel}
                boxVretOrBarcode={warehouseBoxLabel}
                flowPhase={flowPhase}
              />
            ) : null}
            {flowPhase === "boxes" ? (
              <p className="mt-0.5 text-[11px] font-bold tabular-nums" style={{ color: ACTION_PURPLE }}>
                Box {boxOrdinal} of {boxIntakeDenom}
                <span className="font-semibold text-white/45"> · Package intake</span>
              </p>
            ) : null}
            {flowPhase === "items" ? (
              <p className="mt-0.5 text-[11px] font-bold tabular-nums text-white/90">
                Item {itemProgressNumerator} of {itemProgressDenom}
                <span className="font-normal text-white/50"> · Expected units (parent scope)</span>
              </p>
            ) : null}
          </div>
          <button
            type="button"
            className="mt-0.5 flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-amber-200/90 transition hover:bg-amber-500/15 active:scale-95"
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

        <div className="border-t px-2 pb-4 pt-3" style={{ borderColor: BORDER }}>
          <div className="flex flex-row items-start justify-center gap-0">
            {STEPPER.map((step, index) => {
              const active = index === stepIndex;
              const done = index < stepIndex;
              const boxLane = index === 2;
              const segmentColor =
                index === 0
                  ? CARD_INNER
                  : index <= stepIndex
                    ? index === 2
                      ? ACTION_PURPLE
                      : TEAL_STEP
                    : CARD_INNER;
              const nodeFill =
                done || active
                  ? boxLane
                    ? {
                        backgroundColor: ACTION_PURPLE,
                        color: "#1e1b4b",
                        boxShadow: `0 0 0 3px ${PURPLE_GLOW}`,
                      }
                    : {
                        backgroundColor: TEAL_STEP,
                        color: "#042f2e",
                        boxShadow: `0 0 0 3px ${TEAL_STEP_MUTED}`,
                      }
                  : {
                      backgroundColor: BG,
                      color: MUTED_LABEL,
                      border: `1px solid ${BORDER}`,
                    };
              return (
                <Fragment key={`step-${index}`}>
                  {index > 0 ? (
                    <div
                      className="mx-1 mt-[18px] h-[3px] min-w-[10px] flex-1 max-w-[52px] rounded-full sm:max-w-none"
                      style={{
                        backgroundColor: segmentColor,
                      }}
                      aria-hidden
                    />
                  ) : null}
                  <div className="flex w-[4.5rem] shrink-0 flex-col items-center sm:w-[5rem]">
                    <div className="flex h-8 w-8 items-center justify-center rounded-full text-[11px] font-bold" style={nodeFill}>
                      {done ? "✓" : index + 1}
                    </div>
                    <span
                      className="mt-2 text-center text-[10px] font-bold leading-tight"
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

        {showContextHeader ? (
          <div className="sticky top-0 z-20 px-4 pb-3">
            <div
              className={`rounded-[20px] border-x border-slate-500/25 border-y border-white/10 bg-slate-900/80 px-3.5 py-3.5 shadow-[inset_0_1px_0_0_rgba(255,255,255,0.07)] backdrop-blur-md ${toneRing}`}
            >
              <div className="flex items-center gap-3">
                <span
                  className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl ring-1"
                  style={{
                    backgroundColor: "rgba(56,189,248,0.12)",
                    color: ACCENT_BLUE,
                    boxShadow: "0 0 16px rgba(56,189,248,0.2)",
                    borderColor: "rgba(56,189,248,0.25)",
                  }}
                >
                  {trackingIdentified ? (
                    <ScanLine className="h-6 w-6" strokeWidth={2.25} />
                  ) : (
                    <Warehouse className="h-6 w-6" strokeWidth={2.25} />
                  )}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-sm font-bold tracking-tight text-white">{contextHeadline}</p>
                    <span
                      className="rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide"
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
                  <p className="mt-1 truncate font-mono text-base font-bold" style={{ color: ACCENT_BLUE }}>
                    {contextId}
                  </p>
                  {activeStoreLabel ? (
                    <p className="mt-1.5 truncate text-[12px] font-bold" style={{ color: MUTED_LABEL }}>
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
          aria-label="Active context"
          className="fixed left-1/2 top-0 z-[100] w-full max-w-[430px] -translate-x-1/2 border-b-2 border-white/20 bg-slate-950 px-4 pb-5 shadow-2xl"
          style={{ paddingTop: itemsContextBarInsetPx }}
        >
          <div className="flex gap-3 py-5">
            <div className="shrink-0" aria-hidden>
              {trackingIdentified ? <TrackingParentIcon /> : <ParentType3DIcon />}
            </div>
            <div className="min-w-0 flex-1 space-y-2">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Active context</p>
              {activeStoreLabel ? (
                <p className="text-[12px] font-bold leading-snug text-white/90">
                  Store · <span style={{ color: TEAL_STEP }}>{activeStoreLabel}</span>
                </p>
              ) : null}
              <p className="font-mono text-[15px] font-bold leading-snug" style={{ color: TEAL_STEP }}>
                {activePallet?.pallet_number
                  ? `Pallet ${activePallet.pallet_number}`
                  : trackingIdentified
                    ? `Shipment ${activeTracking}`
                    : directBox
                      ? "Direct box"
                      : "—"}
                <span className="text-white/70"> · </span>
                Box {itemScanPackageLabel ?? activeBoxSession?.barcode ?? "—"}
              </p>
              <div className="flex flex-wrap gap-x-6 gap-y-1 text-[12px] tabular-nums">
                <span className="font-bold text-emerald-400/95">
                  Slip matched: <span className="text-[13px] font-extrabold text-emerald-300">Yes</span>
                </span>
                <span className="font-semibold text-white/75">
                  <span className="font-extrabold text-white">Expected:</span>{" "}
                  <span className="text-[13px] font-extrabold text-teal-300">{itemExpectedUnitsTotal}</span>
                </span>
                <span className="font-semibold text-white/75">
                  <span className="font-extrabold text-white">Scanned:</span>{" "}
                  <span className="text-[13px] font-extrabold text-emerald-300">{itemScannedUnitsTotal}</span>
                </span>
                <span className="font-semibold text-white/75">
                  <span className="font-extrabold text-white">Remaining:</span>{" "}
                  <span
                    className={`text-[13px] font-extrabold ${itemAggRemaining > 0 ? "text-amber-300" : "text-emerald-400"}`}
                  >
                    {itemAggRemaining}
                  </span>
                </span>
              </div>
            </div>
          </div>
        </section>
      ) : null}

      <main className={`min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-4 pt-4 ${mainScrollClass}`}>
        {!isSupabaseConfigured() && flowPhase === "scan" ? (
          <p
            className="mb-4 rounded-[20px] border px-3.5 py-2.5 text-[12px] font-semibold"
            style={{ borderColor: "rgba(251,191,36,0.35)", backgroundColor: "rgba(69,26,3,0.35)", color: "#fde68a" }}
          >
            Demo mode: scan PLT-…, TRACK-…, PKG-…, SLIP-…, or SKU patterns. Configure Supabase for live data.
          </p>
        ) : null}

        {isSupabaseConfigured() && !operatorStoresLoading && flowPhase === "scan" && !kioskStoreLocked && operatorStores.length === 0 ? (
          <p
            className="mb-4 rounded-[20px] border px-3.5 py-2.5 text-[12px] font-semibold"
            style={{ borderColor: "rgba(248,113,113,0.35)", backgroundColor: "rgba(69,10,10,0.35)", color: "#fecaca" }}
          >
            No active stores for this organization. Add a store in Settings (Stores and adapters), then refresh.
          </p>
        ) : null}

        {isSupabaseConfigured() && !operatorStoresLoading && flowPhase === "scan" && operatorStores.length > 0 && !sessionStoreId ? (
          <p
            className="mb-4 rounded-[20px] border px-3.5 py-2.5 text-[12px] font-semibold"
            style={{ borderColor: "rgba(248,113,113,0.35)", backgroundColor: "rgba(69,10,10,0.35)", color: "#fecaca" }}
          >
            Could not activate a store — pick one in the header or verify your connection.
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

        {flowPhase === "review" && parentIdentified ? (
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

            {/* Actual boxes received — denominator for Box intake progress (must be &gt; 0 to continue) */}
            <section className="mb-5">
              <div className="mb-3 flex flex-col gap-1">
                <h2 className="text-[17px] font-bold tracking-tight text-white">Actual Boxes Received</h2>
                <p className="text-[12px] font-medium leading-relaxed" style={{ color: MUTED_LABEL }}>
                  Count every carton you physically see on this pallet or shipment. This number drives{" "}
                  <span className="font-semibold text-slate-300">Box N of M</span> on the next step.
                  {!trackingIdentified ? (
                    <>
                      {" "}
                      System rows on pallet: <span className="font-mono font-bold text-slate-200">{stats?.totalBoxes ?? "—"}</span>.
                    </>
                  ) : null}{" "}
                  Expected units from <span className="font-mono text-[11px]">expected_packages</span>:{" "}
                  <span className="font-bold text-slate-300">{expectedPkgTotals?.expectedUnits ?? "—"}</span>.
                </p>
              </div>

              <div
                className="rounded-[22px] p-4 shadow-[inset_0_2px_12px_rgba(0,0,0,0.45)]"
                style={{
                  backgroundColor: CARD,
                  border: `1px solid ${BORDER}`,
                  boxShadow: "0 12px 32px -18px rgba(0,0,0,0.65), inset 0 1px 0 rgba(255,255,255,0.05)",
                }}
              >
                <div
                  className="rounded-[18px] bg-[#090E1A] p-3 sm:p-4"
                  style={{ border: "1px solid #243241" }}
                >
                  <label htmlFor={`${formId}-physical-boxes`} className="sr-only">
                    Actual boxes received
                  </label>
                  <div className="flex items-stretch gap-2 sm:gap-3">
                    <button
                      type="button"
                      onClick={() => setPhysicalBoxCount((n) => Math.max(0, (n ?? 0) - 1))}
                      className="flex h-[58px] min-h-[52px] w-[58px] min-w-[52px] shrink-0 items-center justify-center rounded-2xl border text-white transition hover:brightness-110 active:scale-95 sm:h-[64px] sm:w-[64px]"
                      style={{
                        borderColor: BORDER,
                        backgroundColor: CARD_INNER,
                        boxShadow: "inset 0 -2px 0 rgba(0,0,0,0.35)",
                      }}
                      aria-label="Decrease box count"
                    >
                      <Minus className="h-8 w-8 sm:h-9 sm:w-9" strokeWidth={2.75} />
                    </button>
                    <input
                      id={`${formId}-physical-boxes`}
                      type="number"
                      inputMode="numeric"
                      min={0}
                      className="min-h-[52px] min-w-0 flex-1 rounded-2xl bg-[#090E1A] px-2 py-3 text-center font-mono text-[30px] font-bold tabular-nums leading-none text-white outline-none ring-2 ring-transparent transition focus:ring-[rgba(14,165,233,0.5)] sm:text-[34px]"
                      style={{
                        border: "1px solid #334155",
                        boxShadow: "inset 0 3px 10px rgba(0,0,0,0.55)",
                      }}
                      value={physicalBoxCount ?? ""}
                      placeholder="0"
                      onChange={(e) => {
                        const v = e.target.value;
                        if (v === "") setPhysicalBoxCount(null);
                        else {
                          const n = Number.parseInt(v, 10);
                          if (!Number.isNaN(n) && n >= 0) setPhysicalBoxCount(n);
                        }
                      }}
                      aria-label="Actual boxes received count"
                    />
                    <button
                      type="button"
                      onClick={() => setPhysicalBoxCount((n) => (n ?? 0) + 1)}
                      className="flex h-[58px] min-h-[52px] w-[58px] min-w-[52px] shrink-0 items-center justify-center rounded-2xl border text-white transition hover:brightness-110 active:scale-95 sm:h-[64px] sm:w-[64px]"
                      style={{
                        borderColor: "rgba(14,165,233,0.5)",
                        background: `linear-gradient(180deg, ${ACTION_BLUE} 0%, ${ACTION_BLUE_DEEP} 100%)`,
                        boxShadow: "0 6px 18px rgba(14,165,233,0.38), inset 0 1px 0 rgba(255,255,255,0.12)",
                      }}
                      aria-label="Increase box count"
                    >
                      <Plus className="h-8 w-8 sm:h-9 sm:w-9" strokeWidth={2.75} />
                    </button>
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
                          Box count set — continue to Box Scan when ready.
                        </>
                      ) : (
                        <>Box count OK — capture slip photo 1 below to continue.</>
                      )
                    ) : (
                      <>Enter a count greater than zero to unlock Continue to Box Scan.</>
                    )}
                  </p>
                </div>
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
                  <h2 className="text-[15px] font-bold text-white">Expected Inventory Summary</h2>
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
                <ul className="list-none">
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

            <button
              type="button"
              disabled={!canContinueToBoxScan}
              onClick={() => {
                setBoxIntakeError(null);
                setFlowPhase("boxes");
              }}
              className="mb-3 flex h-[52px] w-full items-center justify-center gap-2 rounded-[18px] text-[15px] font-bold text-white shadow-[0_8px_24px_rgba(14,165,233,0.35)] transition hover:brightness-110 active:scale-95 disabled:cursor-not-allowed disabled:opacity-35"
              style={{
                background: `linear-gradient(180deg, ${ACTION_BLUE} 0%, ${ACTION_BLUE_DEEP} 100%)`,
                boxShadow: canContinueToBoxScan ? `0 10px 28px rgba(14,165,233,0.4)` : undefined,
              }}
            >
              <ScanLine className="h-5 w-5" strokeWidth={2.25} />
              Continue to Box Scan
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
            <section className={`mb-4 rounded-[24px] p-4 ${glassCard}`} style={{ backgroundColor: CARD, borderColor: BORDER }}>
              <div className="flex gap-3">
                <div
                  className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl ring-1"
                  style={{
                    backgroundColor: "rgba(56,189,248,0.1)",
                    borderColor: "rgba(56,189,248,0.2)",
                    boxShadow: "0 0 14px rgba(56,189,248,0.18)",
                  }}
                >
                  <div className="relative flex items-end gap-0.5 pb-0.5">
                    <Package className="relative z-[1] h-7 w-7 drop-shadow-[0_3px_6px_rgba(37,99,235,0.45)]" style={{ color: ACCENT_BLUE }} strokeWidth={2} />
                    <Warehouse className="-ml-2.5 h-6 w-6 opacity-90" style={{ color: ACTION_BLUE }} strokeWidth={2} />
                  </div>
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-start justify-between gap-2">
                    <h2 className="text-[17px] font-bold tracking-tight text-white">
                      {trackingIdentified ? "Tracking locked" : "Scan barcode"}
                    </h2>
                    <div className="relative shrink-0">
                      <button
                        type="button"
                        aria-expanded={scanBarcodeHelpOpen}
                        aria-label="Scan instructions"
                        onClick={() => setScanBarcodeHelpOpen((o) => !o)}
                        className="flex h-8 w-8 items-center justify-center rounded-full border transition hover:bg-white/8 active:scale-95"
                        style={{ borderColor: "rgba(56,189,248,0.4)", color: ACCENT_BLUE, boxShadow: "0 0 12px rgba(56,189,248,0.15)" }}
                      >
                        <Info className="h-4 w-4" strokeWidth={2.5} />
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
                                  for this tracking and store. Continue to Review for slips, then box and item scans.
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

              <div className="mt-4">
                <ScanFrameWithLaser
                  minHeight="104px"
                  laserColor={ACCENT_BLUE}
                  cornerColor="rgba(56,189,248,0.75)"
                  cornerSize="sm"
                  dashedBorder={false}
                  successFlash={scanSuccessFlash}
                  frameStyle={{
                    borderColor: BORDER,
                    backgroundColor: BG,
                    boxShadow: "inset 0 2px 12px rgba(0,0,0,0.35)",
                  }}
                >
                  <Barcode className="h-10 w-10 opacity-45" strokeWidth={1.25} style={{ color: MUTED_LABEL }} />
                </ScanFrameWithLaser>
              </div>

              <div className="mt-3">
                <label htmlFor={`${formId}-scan-manual`} className="text-[10px] font-bold uppercase tracking-[0.08em]" style={{ color: MUTED_LABEL }}>
                  Manual entry
                </label>
                <div className="mt-1.5 flex gap-2">
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
                    placeholder="Type barcode if scanner fails"
                    className="h-11 min-w-0 flex-1 rounded-xl border px-3 font-mono text-[14px] text-white outline-none focus:ring-2 focus:ring-sky-500/40"
                    style={{ borderColor: BORDER, backgroundColor: BG }}
                  />
                  <button
                    type="button"
                    disabled={busy || !scanLine.trim()}
                    onClick={() => void onSubmitScan()}
                    className="h-11 shrink-0 rounded-xl px-4 text-[13px] font-bold text-white transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
                    style={{
                      background: `linear-gradient(180deg, ${ACTION_BLUE} 0%, ${ACTION_BLUE_DEEP} 100%)`,
                      boxShadow: "0 4px 14px rgba(14,165,233,0.3)",
                      color: "#0f172a",
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

            <section
              className={`mb-4 grid gap-2.5 ${parentIdentified ? "grid-cols-3" : "grid-cols-2 sm:grid-cols-4"}`}
            >
              {parentIdentified
                ? (
                    [
                      {
                        label: "Expected Qty",
                        value: expectedPkgTotals ? String(expectedPkgTotals.expectedUnits) : "—",
                        icon: ClipboardList,
                        ic: ACCENT_BLUE,
                        num: ACTION_BLUE,
                      },
                      {
                        label: "Scanned Qty",
                        value: expectedPkgTotals ? String(expectedPkgTotals.scannedUnits) : "—",
                        icon: ScanLine,
                        ic: SUCCESS,
                        num: SUCCESS,
                      },
                      {
                        label: "Remaining",
                        value: expectedPkgTotals ? String(expectedPkgTotals.remainingUnits) : "—",
                        icon: Package,
                        ic: "#c4b5fd",
                        num: "#ddd6fe",
                      },
                    ] as const
                  ).map(({ label, value, icon: Icon, ic, num }) => (
                    <div key={label} className={`rounded-[22px] border p-3 ${glassCard}`} style={{ backgroundColor: CARD, borderColor: BORDER }}>
                      <div
                        className="mx-auto mb-2 flex h-10 w-10 items-center justify-center rounded-xl ring-1"
                        style={{ backgroundColor: CARD_INNER, borderColor: BORDER }}
                      >
                        <Icon className="h-5 w-5" style={{ color: ic }} strokeWidth={2.25} />
                      </div>
                      <p className="text-center text-[10px] font-bold uppercase tracking-[0.06em]" style={{ color: MUTED_LABEL }}>
                        {label}
                      </p>
                      <p className="mt-1 text-center text-[22px] font-bold tabular-nums tracking-tight sm:text-[26px]" style={{ color: num }}>
                        {value}
                      </p>
                    </div>
                  ))
                : (
                    [
                      {
                        label: "Total Boxes",
                        value: typeof physicalBoxCount === "number" ? String(physicalBoxCount) : "—",
                        icon: Package,
                        ic: trackingIdentified ? ACTION_PURPLE : TEAL_STEP,
                        num: trackingIdentified ? ACTION_PURPLE : TEAL_STEP,
                      },
                      {
                        label: "Expected Items",
                        value: stats ? String(stats.expectedItems) : "—",
                        icon: ClipboardList,
                        ic: "rgba(56,189,248,0.85)",
                        num: TEXT_PRIMARY,
                      },
                      {
                        label: "Scanned",
                        value: stats ? String(stats.scannedItems) : "—",
                        icon: ScanLine,
                        ic: SUCCESS,
                        num: SUCCESS,
                      },
                      {
                        label: "Remaining",
                        value: stats ? String(stats.remainingItems) : "—",
                        icon: Package,
                        ic: "#c4b5fd",
                        num: "#ddd6fe",
                      },
                    ] as const
                  ).map(({ label, value, icon: Icon, ic, num }) => (
                    <div key={label} className={`rounded-[22px] border p-3 ${glassCard}`} style={{ backgroundColor: CARD, borderColor: BORDER }}>
                      <div
                        className="mx-auto mb-2 flex h-10 w-10 items-center justify-center rounded-xl ring-1"
                        style={{ backgroundColor: CARD_INNER, borderColor: BORDER }}
                      >
                        <Icon className="h-5 w-5" style={{ color: ic }} strokeWidth={2.25} />
                      </div>
                      <p className="text-center text-[10px] font-bold uppercase tracking-[0.08em]" style={{ color: MUTED_LABEL }}>
                        {label}
                      </p>
                      <p className="mt-1 text-center text-[26px] font-bold tabular-nums tracking-tight" style={{ color: num }}>
                        {value}
                      </p>
                    </div>
                  ))}
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
                  <h3 className="text-[15px] font-bold tracking-tight text-white">Expected Inventory Summary</h3>
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
                <ul className="list-none">
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
              disabled={!parentIdentified}
              onClick={() => {
                setPhysicalBoxCount(null);
                setFlowPhase("review");
              }}
              className="mb-2 flex h-[50px] w-full items-center justify-center gap-2 rounded-[16px] text-[14px] font-bold text-white transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-35"
              style={{
                background: parentIdentified
                  ? `linear-gradient(180deg, ${ACTION_BLUE} 0%, ${ACTION_BLUE_DEEP} 100%)`
                  : CARD_INNER,
                boxShadow: parentIdentified ? "0 6px 18px rgba(14,165,233,0.28)" : undefined,
              }}
            >
              Continue to Review
            </button>

            <button
              type="button"
              onClick={() => {
                setDirectBox(true);
                setActivePallet(null);
                setActiveTracking(null);
                setActiveSlipOrPackage(null);
                setExpectedPkgLines([]);
                setExpectedPkgTotals(null);
                beginItemPhase();
              }}
              className="mb-4 w-full rounded-[16px] border py-3 text-[11px] font-bold uppercase tracking-wide transition hover:bg-white/5"
              style={{ borderColor: "rgba(56,189,248,0.25)", color: ACCENT_BLUE, backgroundColor: "rgba(56,189,248,0.06)" }}
            >
              No Pallet / Direct Box Scan
            </button>
          </>
        ) : null}

        {flowPhase === "boxes" ? (
          <>
            {!parentIdentified ? (
              <p
                className="mb-4 rounded-[20px] border px-3.5 py-2.5 text-[12px] font-semibold"
                style={{ borderColor: "rgba(248,113,113,0.35)", backgroundColor: "rgba(69,10,10,0.35)", color: "#fecaca" }}
              >
                Identify a pallet or tracking parent before box intake.
              </p>
            ) : (
              <>
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

                {/* Box Scan — purple lane (package intake between Review and Item Scan) */}
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
                  Box {boxOrdinal} of {boxIntakeDenom}
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
                    cornerColor={ACTION_PURPLE}
                    successFlash={scanSuccessFlash}
                    frameStyle={{
                      borderColor: "rgba(167,139,250,0.55)",
                      backgroundColor: "#090E1A",
                      boxShadow: "inset 0 2px 12px rgba(0,0,0,0.45)",
                    }}
                  >
                    <Barcode className="mb-2 h-12 w-12 opacity-50" strokeWidth={1.25} style={{ color: ACTION_PURPLE }} />
                    <p className="text-[15px] font-bold text-white">Scan packing slip or box barcode</p>
                    <p className="mt-1 max-w-[280px] text-center text-[12px] font-medium" style={{ color: MUTED_LABEL }}>
                      Slip barcode scans parse IDs locally. Use{" "}
                      <span className="font-semibold text-white/85">Run slip OCR (manual)</span> on Review when you want GPT-4o Vision;
                      then scan the carton barcode to create the <span className="font-mono text-[11px] text-white/90">packages</span>{" "}
                      row.
                    </p>
                  </ScanFrameWithLaser>
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
                    <div className="mb-3 flex items-center justify-between gap-2">
                      <h3 className="text-[14px] font-bold text-white">Expected Items Preview</h3>
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
                  Continue to Item Scan →
                </button>
              </>
            )}
          </>
        ) : null}

        {flowPhase === "items" ? (
          <>
            <div className="h-32 w-full shrink-0" aria-hidden />
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
              <p className="text-center text-[16px] font-bold text-white">Scan Item Barcode</p>
              <p className="mt-1 text-center text-[12px] font-medium" style={{ color: MUTED_LABEL }}>
                UPC / FNSKU / ASIN / Seller SKU — smart resolver (expected lines only)
              </p>
              <div className="mt-4">
                <ScanFrameWithLaser
                  laserColor={TEAL_STEP}
                  cornerColor={TEAL_STEP}
                  successFlash={scanSuccessFlash}
                  frameStyle={{
                    borderColor: "rgba(45,212,191,0.45)",
                    backgroundColor: "#090E1A",
                    boxShadow: "inset 0 2px 12px rgba(0,0,0,0.45)",
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
              <h3 className="mb-3 text-[14px] font-bold text-white">Condition</h3>
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
                Save &amp; next item
                <ChevronRight className="h-5 w-5" strokeWidth={2.5} />
              </button>
            </div>

            <p className="mb-6 flex items-center justify-start gap-2 rounded-[16px] border px-3 py-2.5 text-[11px] font-semibold leading-relaxed" style={{ borderColor: "rgba(56,189,248,0.25)", backgroundColor: "rgba(14,165,233,0.08)", color: ACCENT_BLUE }}>
              <Info className="h-4 w-4 shrink-0" strokeWidth={2} />
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
        ) : null}
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
