"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import {
  Bell,
  CheckCircle2,
  ChevronRight,
  Circle,
  Lock,
  Pencil,
  PlusSquare,
  ScanBarcode,
  Search,
  Trash2,
  X,
} from "lucide-react";
import {
  ScannerBottomNav,
  SCANNER_OPERATOR_SCAN_PATH,
} from "./_components/ScannerBottomNav";
import { operatorHapticTap, operatorUiAcknowledge } from "./_lib/operator-haptics";

const glassCard = "operator-glass-card-home rounded-2xl";

const mainScrollClass =
  "[scrollbar-width:thin] [scrollbar-color:var(--scanner-border)_var(--scanner-bg)] [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-[var(--scanner-border)]/90 hover:[&::-webkit-scrollbar-thumb]:opacity-80";

type TaskRow = {
  id: string;
  label: string;
  done: number;
  total: number;
  complete: boolean;
  tube: "gold" | "blue" | "success";
};

const TASKS: TaskRow[] = [
  { id: "pallets", label: "Receive assigned pallets", done: 12, total: 18, complete: true, tube: "gold" },
  { id: "boxes", label: "Open and scan boxes", done: 24, total: 37, complete: true, tube: "blue" },
  { id: "inspect", label: "Inspect items", done: 68, total: 142, complete: false, tube: "success" },
];

type RecentRow = {
  sku: string;
  name: string;
  pallet: string;
  status: "In Progress" | "Received";
  kind: "pallet" | "box" | "item";
  imageUrl?: string | null;
};

const homeMetricArtClass = "operator-home-metric-art h-[34px] w-[34px] shrink-0";
const homeRecentArtClass = "operator-home-recent-art h-[32px] w-[32px] shrink-0";

function HomeMetricIconPallet() {
  return (
    <svg viewBox="0 0 32 32" className={homeMetricArtClass} aria-hidden>
      <ellipse cx="16" cy="27.5" rx="10" ry="1.6" fill="#000" fillOpacity="0.35" />
      <rect x="6.5" y="22.5" width="2.2" height="4.2" rx="0.45" fill="#6b5a38" stroke="#c9ab6a" strokeWidth="0.65" />
      <rect x="14" y="22.5" width="2.2" height="4.2" rx="0.45" fill="#6b5a38" stroke="#c9ab6a" strokeWidth="0.65" />
      <rect x="21.5" y="22.5" width="2.2" height="4.2" rx="0.45" fill="#6b5a38" stroke="#c9ab6a" strokeWidth="0.65" />
      <rect x="4" y="19.2" width="24" height="3.4" rx="0.55" fill="#8a7348" stroke="#e8d4a8" strokeWidth="0.85" />
      <path d="M5.5 20.1h21" stroke="#f5ecd4" strokeWidth="0.55" strokeOpacity="0.65" />
      <rect x="5" y="15.2" width="22" height="3" rx="0.45" fill="#7a6842" stroke="#d6b76e" strokeWidth="0.75" />
      <path d="M6.5 15.9h19M6.5 16.8h19M6.5 17.7h19" stroke="#3d3422" strokeWidth="0.55" strokeOpacity="0.55" />
      <rect x="5.5" y="11.2" width="21" height="2.8" rx="0.4" fill="#6f5f3d" stroke="#c4a96a" strokeWidth="0.7" />
      <path d="M7 12h18M7 12.85h18M7 13.7h18" stroke="#2e2818" strokeWidth="0.5" strokeOpacity="0.5" />
      <rect x="6" y="7.4" width="20" height="2.6" rx="0.38" fill="#5c5034" stroke="#b89958" strokeWidth="0.65" />
      <path d="M7.5 8.1h17M7.5 8.85h17" stroke="#252018" strokeWidth="0.48" strokeOpacity="0.45" />
      <path d="M6 7.2h20" stroke="#f0e2bc" strokeWidth="0.7" strokeLinecap="round" strokeOpacity="0.5" />
    </svg>
  );
}

function HomeMetricIconBox() {
  return (
    <svg viewBox="0 0 32 32" className={homeMetricArtClass} aria-hidden>
      <path d="M6 12.5 16 7.5 26 12.5v11L16 28.5 6 23.5v-11z" fill="#4a4030" stroke="#8a7348" strokeWidth="0.7" />
      <path d="M16 7.5 26 12.5v11L16 28.5V7.5z" fill="#6b5a38" stroke="#c9ab6a" strokeWidth="0.75" />
      <path d="M6 12.5 16 17.5 26 12.5 16 7.5 6 12.5z" fill="#9a8458" stroke="#e8d4a8" strokeWidth="0.85" />
      <path d="M11 12.5 16 9.8 21 12.5 16 15.2 11 12.5z" fill="#b89958" stroke="#f0e2bc" strokeWidth="0.65" />
      <path d="M13.5 10.2 18.5 12.5 13.5 14.8 8.5 12.5 13.5 10.2z" fill="#d6b76e" stroke="#faf6ed" strokeWidth="0.55" />
      <path d="M10 14.5h12" stroke="#3d3422" strokeWidth="0.55" strokeOpacity="0.4" />
      <path d="M14 17.5v5.5M18 16.8v6.2" stroke="#e8d4a8" strokeWidth="1.1" strokeLinecap="round" />
      <rect x="13.5" y="18.8" width="5" height="0.9" rx="0.2" fill="#c4a96a" />
    </svg>
  );
}

function HomeMetricIconItemInspect() {
  return (
    <svg viewBox="0 0 32 32" className={homeMetricArtClass} aria-hidden>
      <rect x="5.5" y="6.5" width="14.5" height="19.5" rx="1.4" fill="#5c5034" stroke="#d6b76e" strokeWidth="0.9" />
      <path d="M9.5 6.5V4.8a1.6 1.6 0 0 1 1.6-1.6h5.8a1.6 1.6 0 0 1 1.6 1.6V6.5" fill="#8a7348" stroke="#e8d4a8" strokeWidth="0.8" />
      <rect x="8" y="10.5" width="9.5" height="1.1" rx="0.25" fill="#c4a96a" />
      <rect x="8" y="13.2" width="7" height="1" rx="0.2" fill="#9a8458" fillOpacity="0.85" />
      <rect x="8" y="15.6" width="8.5" height="1" rx="0.2" fill="#9a8458" fillOpacity="0.7" />
      <circle cx="11.5" cy="19.2" r="1.1" fill="none" stroke="#e8d4a8" strokeWidth="0.75" />
      <path d="M10.8 19.2l.5.5 1.4-1.4" stroke="#f0e2bc" strokeWidth="0.7" strokeLinecap="round" strokeLinejoin="round" />
      <rect x="19" y="11.5" width="7.5" height="12" rx="1" fill="#6b5a38" stroke="#e8d4a8" strokeWidth="0.85" />
      <rect x="20.2" y="13" width="1" height="9" fill="#2a2418" />
      <rect x="22" y="13" width="1.6" height="9" fill="#1a1610" />
      <rect x="24.2" y="13" width="0.9" height="9" fill="#2a2418" />
      <rect x="25.6" y="13" width="1.4" height="9" fill="#1a1610" />
      <path d="M6.5 8.5h12.5" stroke="#f5ecd4" strokeWidth="0.55" strokeOpacity="0.45" />
    </svg>
  );
}

function HomeMetricIconAlert() {
  return (
    <svg viewBox="0 0 32 32" className={homeMetricArtClass} aria-hidden>
      <path
        d="M16 4.5 27.2 24.8a1.8 1.8 0 0 1-1.56 2.7H6.36a1.8 1.8 0 0 1-1.56-2.7L16 4.5z"
        fill="#8b4a3a"
        stroke="#f0b090"
        strokeWidth="1.05"
        strokeLinejoin="round"
      />
      <path
        d="M16 6.8 24.8 23.2H7.2L16 6.8z"
        fill="#c46850"
        fillOpacity="0.55"
      />
      <path d="M13.2 6.5 16 4.5 18.8 6.5" stroke="#ffd4c4" strokeWidth="0.65" strokeLinecap="round" strokeOpacity="0.55" />
      <rect x="14.85" y="12.5" width="2.3" height="6.2" rx="0.55" fill="#fff5f0" />
      <circle cx="16" cy="21.8" r="1.35" fill="#fff5f0" />
    </svg>
  );
}

function HomeRecentIconPallet() {
  return (
    <svg viewBox="0 0 32 32" className={homeRecentArtClass} aria-hidden>
      <rect x="5" y="20.5" width="22" height="3.2" rx="0.5" fill="#8a7348" stroke="#e8d4a8" strokeWidth="0.75" />
      <path d="M6.5 21.3h19" stroke="#f5ecd4" strokeWidth="0.5" strokeOpacity="0.55" />
      <rect x="5.5" y="16.2" width="21" height="2.8" rx="0.4" fill="#6f5f3d" stroke="#d6b76e" strokeWidth="0.65" />
      <path d="M7 17h18M7 17.9h18" stroke="#2e2818" strokeWidth="0.45" strokeOpacity="0.5" />
      <rect x="6" y="12.5" width="20" height="2.5" rx="0.38" fill="#5c5034" stroke="#c4a96a" strokeWidth="0.6" />
      <rect x="7" y="23.2" width="2" height="3" rx="0.35" fill="#6b5a38" stroke="#c9ab6a" strokeWidth="0.55" />
      <rect x="14" y="23.2" width="2" height="3" rx="0.35" fill="#6b5a38" stroke="#c9ab6a" strokeWidth="0.55" />
      <rect x="21" y="23.2" width="2" height="3" rx="0.35" fill="#6b5a38" stroke="#c9ab6a" strokeWidth="0.55" />
    </svg>
  );
}

function HomeRecentIconBox() {
  return (
    <svg viewBox="0 0 32 32" className={homeRecentArtClass} aria-hidden>
      <path d="M6 13 16 8 26 13v10L16 28 6 23V13z" fill="#6b5a38" stroke="#d6b76e" strokeWidth="0.75" />
      <path d="M16 8 26 13v10L16 28V8z" fill="#8a7348" stroke="#e8d4a8" strokeWidth="0.7" />
      <path d="M6 13 16 18 26 13 16 8 6 13z" fill="#b89958" stroke="#f0e2bc" strokeWidth="0.7" />
      <path d="M11.5 11.5 16 9.2 20.5 11.5 16 13.8 11.5 11.5z" fill="#d6b76e" stroke="#faf6ed" strokeWidth="0.55" />
      <path d="M13 20v4.5M19 19.2v5.3" stroke="#e8d4a8" strokeWidth="0.9" strokeLinecap="round" />
    </svg>
  );
}

function HomeRecentIconItem() {
  return (
    <svg viewBox="0 0 32 32" className={homeRecentArtClass} aria-hidden>
      <rect x="5" y="7" width="16" height="18" rx="1.5" fill="#5c5034" stroke="#d6b76e" strokeWidth="0.85" />
      <path d="M7 8.2h12" stroke="#f0e2bc" strokeWidth="0.55" strokeOpacity="0.5" />
      <path d="M18 7 22.5 9.5v15.5l-4.5 2.2H5V7l3.5-1.8 9.5 1.8z" fill="#6f5f3d" fillOpacity="0.45" />
      <rect x="8" y="11" width="10" height="8" rx="0.8" fill="#3d3422" stroke="#c4a96a" strokeWidth="0.65" />
      <circle cx="13" cy="15" r="2.8" fill="#b89958" stroke="#f5ecd4" strokeWidth="0.6" />
      <path d="M11.5 15h3v3.2" stroke="#2a2418" strokeWidth="0.65" strokeLinecap="round" />
      <rect x="19.5" y="14" width="5.5" height="9" rx="0.8" fill="#4a4030" stroke="#c9ab6a" strokeWidth="0.65" />
      <rect x="20.5" y="15.2" width="0.9" height="6.5" fill="#1a1610" />
      <rect x="22" y="15.2" width="1.3" height="6.5" fill="#2a2418" />
      <rect x="23.8" y="15.2" width="0.8" height="6.5" fill="#1a1610" />
      <rect x="7" y="22.5" width="14" height="1.6" rx="0.25" fill="#8a7348" />
      <path d="M8 23.1h2M10.8 23.1h1.2M12.8 23.1h2M15.4 23.1h1.4M17.4 23.1h2" stroke="#2a2418" strokeWidth="0.55" />
    </svg>
  );
}

const RECENT: RecentRow[] = [
  {
    sku: "SKU-20034",
    name: "Wireless Headset Pro",
    pallet: "PLT-000123",
    status: "In Progress",
    kind: "item",
  },
  {
    sku: "SKU-08891",
    name: "USB-C Hub 7-port",
    pallet: "PLT-000104",
    status: "Received",
    kind: "box",
  },
];

function BellHeader({ count }: { count: number }) {
  return (
    <button
      type="button"
      className="operator-icon-plate relative flex h-10 w-10 shrink-0 items-center justify-center transition active:scale-95"
      style={{ color: "var(--scanner-text)" }}
      aria-label={`Notifications, ${count} unread`}
    >
      <Bell className="h-5 w-5" strokeWidth={2.65} aria-hidden />
      {count > 0 ? (
        <span
          className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full px-0.5 text-[9px] font-bold text-white"
          style={{ backgroundColor: "var(--op-danger)" }}
        >
          {count > 9 ? "9+" : count}
        </span>
      ) : null}
    </button>
  );
}

function StatCard({
  value,
  label,
  wellClass,
  children,
}: {
  value: string;
  label: string;
  wellClass: string;
  children: ReactNode;
}) {
  return (
    <div className="operator-stat-card-premium flex min-w-0 flex-1 flex-col gap-2 px-3 py-3.5 sm:px-3.5">
      <div className={`operator-home-stat-well ${wellClass}`}>
        <span className="operator-home-stat-icon flex items-center justify-center">{children}</span>
      </div>
      <p className="operator-stat-value tabular-nums">{value}</p>
      <p className="operator-stat-label">{label}</p>
    </div>
  );
}

function ProgressBar({ ratio, tube }: { ratio: number; tube: TaskRow["tube"] }) {
  const pct = Math.min(100, Math.max(0, ratio * 100));
  const fill =
    tube === "gold"
      ? "operator-progress-fill operator-progress-fill--gold"
      : tube === "blue"
        ? "operator-progress-fill operator-progress-fill--blue"
        : "operator-progress-fill operator-progress-fill--success";
  return (
    <div className="operator-progress-shell" aria-hidden>
      <div className={fill} style={{ width: `${pct}%` }} />
    </div>
  );
}

function StatusPill({ status }: { status: RecentRow["status"] }) {
  if (status === "Received") {
    return <span className="operator-status-pill operator-status-pill--received">{status}</span>;
  }
  return <span className="operator-status-pill operator-status-pill--progress">{status}</span>;
}

function RecentThumbnail({ row }: { row: RecentRow }) {
  if (row.imageUrl) {
    return (
      <div className="operator-home-thumbnail" aria-hidden>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={row.imageUrl} alt="" className="h-full w-full object-cover" loading="lazy" decoding="async" />
      </div>
    );
  }

  const Icon =
    row.kind === "pallet" ? HomeRecentIconPallet : row.kind === "box" ? HomeRecentIconBox : HomeRecentIconItem;

  return (
    <div className="operator-home-thumbnail" aria-hidden>
      <Icon />
    </div>
  );
}

function SearchCodeOverlay(props: {
  open: boolean;
  onClose: () => void;
  onSubmitCode: (code: string) => void;
}) {
  const { open, onClose, onSubmitCode } = props;
  const inputRef = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState("");

  useEffect(() => {
    if (!open) return;
    const t = window.setTimeout(() => inputRef.current?.focus(), 50);
    return () => window.clearTimeout(t);
  }, [open]);

  if (!open) return null;

  const submit = () => {
    const code = draft.trim();
    if (!code) return;
    onSubmitCode(code);
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/65 p-4 pb-[max(1rem,env(safe-area-inset-bottom))] backdrop-blur-md sm:items-center"
      role="dialog"
      aria-modal="true"
      aria-labelledby="operator-search-title"
    >
      <button
        type="button"
        className="absolute inset-0 z-[1] cursor-default"
        aria-label="Dismiss overlay"
        onClick={onClose}
      />
      <div
        className="relative z-[2] w-full max-w-md rounded-2xl border p-4 backdrop-blur-xl"
        style={{
          borderColor: "var(--scanner-border)",
          backgroundColor: "var(--scanner-card-inner)",
          boxShadow: "inset 0 1px 0 rgba(255,255,255,0.1), 0 24px 48px -12px rgba(0,0,0,0.55)",
        }}
      >
        <div className="flex items-start justify-between gap-2">
          <div>
            <h2 id="operator-search-title" className="text-lg font-bold tracking-tight" style={{ color: "var(--scanner-text)" }}>
              Find record
            </h2>
            <p className="mt-0.5 text-sm" style={{ color: "var(--op-text-secondary)" }}>
              Type or scan a pallet, box, or item code
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="operator-action-icon-btn"
            aria-label="Close"
          >
            <X className="h-5 w-5" strokeWidth={2.5} />
          </button>
        </div>
        <input
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              submit();
            }
          }}
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          enterKeyHint="search"
          placeholder="Barcode, tracking, SKU…"
          className="scanner-input-glass mt-4 w-full rounded-xl border px-3 py-3 font-mono text-sm tracking-tight outline-none ring-0"
          style={{ color: "var(--scanner-text)" }}
        />
        <div className="mt-3 flex gap-2">
          <button
            type="button"
            onClick={onClose}
            className="operator-secondary-btn flex-1 py-2.5 text-sm font-semibold"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={!draft.trim()}
            className="operator-primary-chassis-btn flex flex-1 items-center justify-center gap-2 py-2.5 text-sm font-bold disabled:opacity-45"
          >
            <ScanBarcode className="h-4 w-4" strokeWidth={2.5} />
            Search
          </button>
        </div>
      </div>
    </div>
  );
}

export default function OperatorMobileHomePage() {
  const router = useRouter();
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchOverlayKey, setSearchOverlayKey] = useState(0);
  const [hubFlashToast, setHubFlashToast] = useState<string | null>(null);

  useEffect(() => {
    try {
      const msg = sessionStorage.getItem("operatorMobile:hubToast");
      if (!msg) return;
      sessionStorage.removeItem("operatorMobile:hubToast");
      setHubFlashToast(msg);
      const t = window.setTimeout(() => setHubFlashToast(null), 4500);
      return () => window.clearTimeout(t);
    } catch {
      /* ignore */
    }
  }, []);

  const goSearch = (code: string) => {
    router.push(`${SCANNER_OPERATOR_SCAN_PATH}?code=${encodeURIComponent(code)}`);
  };

  const openSearchOverlay = () => {
    setSearchOverlayKey((k) => k + 1);
    setSearchOpen(true);
  };

  return (
    <div
      className="operator-home-page flex min-h-0 min-w-0 flex-1 flex-col font-sans tracking-tight antialiased"
      style={{
        backgroundColor: "var(--scanner-bg)",
        color: "var(--scanner-text)",
        fontFamily: "var(--font-inter), ui-sans-serif, system-ui, sans-serif",
      }}
    >
      <SearchCodeOverlay
        key={searchOverlayKey}
        open={searchOpen}
        onClose={() => setSearchOpen(false)}
        onSubmitCode={goSearch}
      />

      <header
        className="operator-home-header shrink-0 border-b px-4 pb-1.5 pt-1.5"
        style={{
          borderColor: "var(--scanner-border)",
          background: "var(--scanner-header-gradient)",
        }}
      >
        <div className="flex items-center justify-between gap-2">
          <div className="operator-home-header-row flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
            <h1 className="operator-heading text-base font-semibold tracking-tight sm:text-lg" style={{ color: "var(--scanner-text)" }}>
              HOME
            </h1>
            <span className="operator-home-role-pill">Operator</span>
            <span className="operator-home-header-sep" aria-hidden>
              ·
            </span>
            <span className="truncate text-xs font-medium" style={{ color: "var(--op-text-secondary)" }}>
              Warehouse receiving
            </span>
          </div>
          <BellHeader count={2} />
        </div>
      </header>

      <main className={`min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-4 ${mainScrollClass}`}>
        <section className="flex flex-row gap-2.5" aria-label="Receiving stats">
          <StatCard value="18" label="Assigned Pallets" wellClass="operator-home-stat-well--gold">
            <HomeMetricIconPallet />
          </StatCard>
          <StatCard value="37" label="Open Boxes" wellClass="operator-home-stat-well--gold">
            <HomeMetricIconBox />
          </StatCard>
          <StatCard value="142" label="Items to Inspect" wellClass="operator-home-stat-well--gold">
            <HomeMetricIconItemInspect />
          </StatCard>
          <StatCard value="5" label="Alerts" wellClass="operator-home-stat-well--alert">
            <HomeMetricIconAlert />
          </StatCard>
        </section>

        <section className="mt-4 grid grid-cols-2 gap-3">
          <button
            type="button"
            onClick={() => {
              operatorUiAcknowledge();
              router.push(SCANNER_OPERATOR_SCAN_PATH);
            }}
            className="operator-primary-chassis-btn relative flex min-h-[92px] items-stretch gap-2.5 px-3 py-3.5 text-left"
          >
            <span className="relative flex shrink-0 items-center justify-center">
              <span className="operator-primary-chassis-btn__icon-plate">
                <PlusSquare className="h-6 w-6" strokeWidth={2.65} aria-hidden />
              </span>
            </span>
            <span className="relative z-[1] min-w-0">
              <span className="block text-[13px] font-bold leading-snug">Start New Receiving</span>
              <span className="operator-primary-chassis-btn__sub mt-0.5 block">New pallet / box</span>
            </span>
          </button>
          <button
            type="button"
            onClick={() => {
              operatorUiAcknowledge();
              router.push(SCANNER_OPERATOR_SCAN_PATH);
            }}
            className="operator-secondary-btn relative flex min-h-[92px] items-stretch gap-2.5 px-3 py-3.5 text-left"
          >
            <span className="operator-secondary-btn__icon-plate operator-home-continue-scan-plate">
              <ScanBarcode className="h-5 w-5" strokeWidth={2.75} fill="currentColor" fillOpacity={0.14} aria-hidden />
            </span>
            <span className="min-w-0">
              <span className="block text-[13px] font-bold leading-snug">Continue Scan</span>
              <span className="operator-secondary-btn__sub mt-0.5 block">Resume session</span>
            </span>
          </button>
        </section>

        <button
          type="button"
          onClick={() => {
            operatorUiAcknowledge();
            openSearchOverlay();
          }}
          className={`operator-search-trigger mt-4 flex w-full items-center gap-3 rounded-2xl px-4 py-3.5 text-left ${glassCard}`}
        >
          <span className="operator-icon-plate h-10 w-10" style={{ color: "var(--op-accent-gold)" }}>
            <Search className="h-5 w-5" strokeWidth={2.65} aria-hidden />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-semibold" style={{ color: "var(--scanner-text)" }}>
              Search pallet / box / item
            </span>
            <span className="mt-0.5 block text-[13px] font-medium" style={{ color: "var(--op-text-secondary)" }}>
              Barcode, label, or serial
            </span>
          </span>
          <ChevronRight className="h-4 w-4 shrink-0" strokeWidth={2.5} style={{ color: "var(--op-text-secondary)" }} />
        </button>

        <section className="mt-6">
          <h2 className="operator-heading text-[15px] font-semibold tracking-tight" style={{ color: "var(--scanner-text)" }}>
            Today&apos;s tasks
          </h2>
          <ul className="mt-3 space-y-3">
            {TASKS.map((task) => {
              const ratio = task.total > 0 ? task.done / task.total : 0;
              return (
                <li key={task.id}>
                  <button
                    type="button"
                    onClick={() => operatorHapticTap(10)}
                    className={`flex w-full items-start gap-3 rounded-2xl px-4 py-3.5 text-left ${glassCard}`}
                  >
                    <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center">
                      {task.complete ? (
                        <CheckCircle2 className="h-7 w-7" strokeWidth={2.65} style={{ color: "var(--op-success)" }} />
                      ) : (
                        <Circle className="h-7 w-7" strokeWidth={2.5} style={{ color: "var(--op-text-secondary)" }} />
                      )}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-start justify-between gap-2">
                        <span className="text-sm font-semibold" style={{ color: "var(--scanner-text)" }}>
                          {task.label}
                        </span>
                        <span className="shrink-0 text-xs font-bold tabular-nums" style={{ color: "var(--op-text-secondary)" }}>
                          {task.done} / {task.total}
                        </span>
                      </span>
                      <ProgressBar ratio={ratio} tube={task.tube} />
                    </span>
                    <ChevronRight className="mt-1 h-4 w-4 shrink-0" strokeWidth={2.5} style={{ color: "var(--op-text-secondary)" }} />
                  </button>
                </li>
              );
            })}
          </ul>
        </section>

        <section className="mt-6">
          <div className="flex items-center justify-between gap-2">
            <h2 className="operator-heading text-[15px] font-semibold tracking-tight" style={{ color: "var(--scanner-text)" }}>
              Recent items
            </h2>
            <Link href="#" className="operator-view-all-link">
              View all
            </Link>
          </div>
          <ul className="mt-3 space-y-0">
            {RECENT.map((row, i) => (
              <li key={row.sku}>
                {i > 0 ? <div className="operator-recent-divider-glow my-3 w-full" aria-hidden /> : null}
                <div className="operator-recent-row px-4 py-3.5">
                  <div className="flex gap-3">
                  <RecentThumbnail row={row} />
                  <div className="min-w-0 flex-1">
                    <p className="font-mono text-[11px] font-bold" style={{ color: "var(--scanner-text)" }}>
                      {row.sku}
                    </p>
                    <p className="mt-0.5 truncate text-sm font-medium" style={{ color: "var(--scanner-text)" }}>
                      {row.name}
                    </p>
                    <p
                      className="mt-0.5 font-mono text-[11px] font-bold uppercase tracking-wide"
                      style={{ color: "var(--op-text-secondary)" }}
                    >
                      Pallet {row.pallet}
                    </p>
                    <StatusPill status={row.status} />
                  </div>
                  <div className="flex shrink-0 items-start gap-0.5">
                    <button type="button" className="operator-action-icon-btn operator-home-recent-action-btn" aria-label="Locked">
                      <Lock className="h-4 w-4" strokeWidth={2.65} />
                    </button>
                    <button type="button" className="operator-action-icon-btn operator-home-recent-action-btn" aria-label="Edit">
                      <Pencil className="h-4 w-4" strokeWidth={2.65} />
                    </button>
                    <button type="button" className="operator-action-icon-btn operator-home-recent-action-btn" aria-label="Delete">
                      <Trash2 className="h-4 w-4" strokeWidth={2.65} />
                    </button>
                  </div>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </section>
      </main>

      {hubFlashToast ? (
        <div
          className="pointer-events-none fixed bottom-[calc(4.25rem+env(safe-area-inset-bottom))] left-1/2 z-[130] w-[min(calc(100vw-2rem),22rem)] -translate-x-1/2 rounded-2xl border px-4 py-3 shadow-[0_12px_40px_rgba(0,0,0,0.55)]"
          style={{
            borderColor: "color-mix(in srgb, var(--op-success) 45%, transparent)",
            backgroundColor: "var(--scanner-card-inner)",
            boxShadow: "var(--op-shadow-soft)",
          }}
          role="status"
        >
          <p
            className="flex items-center gap-2 text-center text-[13px] font-bold leading-snug"
            style={{ color: "var(--scanner-text)" }}
          >
            <CheckCircle2 className="h-5 w-5 shrink-0" strokeWidth={2.5} style={{ color: "var(--op-success)" }} aria-hidden />
            {hubFlashToast}
          </p>
        </div>
      ) : null}

      <ScannerBottomNav active="home" alertCount={2} />
    </div>
  );
}
