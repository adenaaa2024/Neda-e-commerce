"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";
import {
  AlertTriangle,
  Bell,
  CheckCircle2,
  ChevronRight,
  Circle,
  Lock,
  Package,
  PackageOpen,
  Pencil,
  PlusSquare,
  ScanBarcode,
  Search,
  Trash2,
  Warehouse,
  X,
} from "lucide-react";
import {
  ScannerBottomNav,
  SCANNER_OPERATOR_SCAN_PATH,
} from "./_components/ScannerBottomNav";
import { useOperatorSessionStore } from "./_components/OperatorSessionStoreProvider";
import { isSupabaseConfigured } from "@/src/lib/supabase";

const BG = "#0B1218";
const CARD_ELEV = "#111827";
const TEAL = "#2dd4bf";

/** Minimal glass surface — light, consistent with scan flow */
const glassCard =
  "rounded-2xl border border-white/5 bg-slate-900/40 shadow-[inset_0_1px_0_0_rgba(255,255,255,0.05)] backdrop-blur-md transition-colors hover:border-white/20";
const glassCardQuiet =
  "rounded-2xl border border-white/5 bg-slate-900/40 shadow-[inset_0_1px_0_0_rgba(255,255,255,0.04)] backdrop-blur-md transition-colors hover:border-white/15";

const PALLET = { fg: "#38bdf8", border: "rgba(56, 189, 248, 0.45)", bg: "rgba(56, 189, 248, 0.1)" };

const mainScrollClass =
  "[scrollbar-width:thin] [scrollbar-color:#243241_#0B1218] [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-[#243241]/90 hover:[&::-webkit-scrollbar-thumb]:bg-[#334155]/90";

type TaskRow = {
  id: string;
  label: string;
  done: number;
  total: number;
  complete: boolean;
  barClass: string;
};

const TASKS: TaskRow[] = [
  { id: "pallets", label: "Receive assigned pallets", done: 12, total: 18, complete: true, barClass: "bg-sky-400" },
  { id: "boxes", label: "Open and scan boxes", done: 24, total: 37, complete: true, barClass: "bg-violet-400" },
  { id: "inspect", label: "Inspect items", done: 68, total: 142, complete: false, barClass: "bg-sky-300/80" },
];

const RECENT = [
  { sku: "SKU-20034", name: "Wireless Headset Pro", pallet: "PLT-000123", status: "In Progress" as const },
  { sku: "SKU-08891", name: "USB-C Hub 7-port", pallet: "PLT-000104", status: "Received" as const },
];

const PalletStatIcon = Warehouse;

const storeGlass =
  "rounded-xl border px-2.5 py-1.5 text-xs font-bold shadow-[inset_0_1px_0_rgba(255,255,255,0.06)] backdrop-blur-md tracking-tight";

function OperatorHomeStoreSelector() {
  const {
    sessionStoreId,
    selectSessionStoreId,
    operatorStores,
    operatorStoresLoading,
    kioskStoreLocked,
    activeStoreLabel,
  } = useOperatorSessionStore();
  const selId = useId();

  if (!isSupabaseConfigured()) {
    return (
      <span className={`${storeGlass} border-white/10 bg-slate-900/50 text-slate-400`}>Demo mode</span>
    );
  }

  if (operatorStoresLoading) {
    return <span className={`${storeGlass} border-teal-400/20 bg-slate-900/50 text-slate-400`}>Loading store…</span>;
  }

  if (kioskStoreLocked) {
    return activeStoreLabel ? (
      <span
        className={`${storeGlass} max-w-[min(200px,42vw)] truncate border-teal-400/25 bg-slate-900/50 text-white`}
        title={activeStoreLabel}
      >
        Store: {activeStoreLabel}
      </span>
    ) : (
      <span className={`${storeGlass} border-teal-400/25 bg-slate-900/50 text-teal-100/90`}>Kiosk store</span>
    );
  }

  if (operatorStores.length === 0) {
    return <span className={`${storeGlass} border-amber-400/30 bg-amber-950/30 text-amber-100`}>No stores</span>;
  }

  if (operatorStores.length === 1) {
    const name = operatorStores[0].name;
    return (
      <span
        className={`${storeGlass} max-w-[min(200px,42vw)] truncate border-teal-400/25 bg-slate-900/50 text-white`}
        title={name}
      >
        Store: {name}
      </span>
    );
  }

  return (
    <div className="flex flex-col items-end gap-0.5">
      <label htmlFor={selId} className="text-[8px] font-bold uppercase tracking-widest text-teal-200/70">
        Store
      </label>
      <select
        id={selId}
        value={sessionStoreId ?? ""}
        onChange={(e) => selectSessionStoreId(e.target.value)}
        className={`${storeGlass} max-w-[min(200px,42vw)] cursor-pointer appearance-none border-teal-400/25 bg-slate-900/55 py-2 pl-2.5 pr-8 text-xs text-white outline-none transition hover:bg-slate-900/70`}
        style={{
          backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='14' height='14' viewBox='0 0 24 24' fill='none' stroke='%232dd4bf' stroke-width='2.5'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E")`,
          backgroundRepeat: "no-repeat",
          backgroundPosition: "right 0.45rem center",
        }}
      >
        {operatorStores.map((s) => (
          <option key={s.id} value={s.id} className="bg-slate-950 text-white">
            {s.name}
          </option>
        ))}
      </select>
    </div>
  );
}

function BellHeader({ count }: { count: number }) {
  return (
    <button
      type="button"
      className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-white transition hover:bg-white/5 active:scale-95"
      aria-label={`Notifications, ${count} unread`}
    >
      <Bell className="h-5 w-5" strokeWidth={2} />
      {count > 0 ? (
        <span className="absolute right-0 top-0 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-red-500 px-0.5 text-[9px] font-bold text-white">
          {count > 9 ? "9+" : count}
        </span>
      ) : null}
    </button>
  );
}

function StatCard({
  value,
  label,
  accentRing,
  children,
}: {
  value: string;
  label: string;
  accentRing: string;
  children: ReactNode;
}) {
  return (
    <div
      className={`flex min-w-0 flex-1 flex-col gap-0.5 rounded-xl border border-white/5 bg-slate-900/40 px-2 py-2.5 backdrop-blur-md transition-colors hover:border-white/15 sm:px-2.5`}
      style={{
        boxShadow: `inset 0 1px 0 0 rgba(255,255,255,0.06), inset 0 0 0 1px ${accentRing}`,
      }}
    >
      {children}
      <p className="text-xl font-bold tabular-nums tracking-tight text-white">{value}</p>
      <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">{label}</p>
    </div>
  );
}

function ProgressBar({ ratio, barClass }: { ratio: number; barClass: string }) {
  const pct = Math.min(100, Math.max(0, ratio * 100));
  return (
    <div
      className="mt-1.5 h-2 w-full overflow-hidden rounded-full shadow-[inset_0_1px_2px_rgba(0,0,0,0.35)]"
      style={{ backgroundColor: CARD_ELEV }}
    >
      <div className={`h-full rounded-full transition-all ${barClass}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

function StatusPill({ status }: { status: (typeof RECENT)[number]["status"] }) {
  const base =
    "mt-1 inline-flex w-fit rounded-full px-1.5 py-px text-[8px] font-bold uppercase tracking-wide backdrop-blur-sm";
  if (status === "Received") {
    return (
      <span
        className={`${base} border border-emerald-500/30 bg-emerald-500/15 text-emerald-400 shadow-[0_0_10px_rgba(16,185,129,0.22)]`}
      >
        {status}
      </span>
    );
  }
  return (
    <span
      className={`${base} border border-sky-500/30 bg-sky-500/15 text-sky-300 shadow-[0_0_10px_rgba(14,165,233,0.2)]`}
    >
      {status}
    </span>
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
        className="relative z-[2] w-full max-w-md rounded-2xl border border-white/10 bg-slate-950/85 p-4 shadow-[0_24px_48px_-12px_rgba(0,0,0,0.65),inset_0_1px_0_rgba(255,255,255,0.08)] backdrop-blur-xl"
      >
        <div className="flex items-start justify-between gap-2">
          <div>
            <h2 id="operator-search-title" className="text-lg font-bold tracking-tight text-white">
              Find record
            </h2>
            <p className="mt-0.5 text-sm text-slate-400">Type or scan a pallet, box, or item code</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-slate-400 transition hover:bg-white/10 hover:text-white active:scale-95"
            aria-label="Close"
          >
            <X className="h-5 w-5" strokeWidth={2} />
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
          className="mt-4 w-full rounded-xl border border-white/10 bg-slate-900/60 px-3 py-3 font-mono text-sm tracking-tight text-white outline-none ring-0 placeholder:text-slate-500 focus:border-teal-500/40 focus:shadow-[0_0_0_3px_rgba(45,212,191,0.15)]"
        />
        <div className="mt-3 flex gap-2">
          <button
            type="button"
            onClick={onClose}
            className="flex-1 rounded-xl border border-white/10 py-2.5 text-sm font-semibold text-slate-300 transition hover:bg-white/5 active:scale-95"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={!draft.trim()}
            className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-teal-500 py-2.5 text-sm font-bold text-slate-950 shadow-[inset_0_1px_0_rgba(255,255,255,0.25),inset_0_-2px_8px_rgba(0,0,0,0.15)] transition hover:brightness-110 active:scale-95 disabled:opacity-40"
          >
            <ScanBarcode className="h-4 w-4" strokeWidth={2} />
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

  const goSearch = (code: string) => {
    router.push(`${SCANNER_OPERATOR_SCAN_PATH}?code=${encodeURIComponent(code)}`);
  };

  const openSearchOverlay = () => {
    setSearchOverlayKey((k) => k + 1);
    setSearchOpen(true);
  };

  return (
    <div
      className="flex min-h-0 min-w-0 flex-1 flex-col font-sans tracking-tight antialiased"
      style={{ backgroundColor: BG, fontFamily: "var(--font-inter), ui-sans-serif, system-ui, sans-serif" }}
    >
      <SearchCodeOverlay
        key={searchOverlayKey}
        open={searchOpen}
        onClose={() => setSearchOpen(false)}
        onSubmitCode={goSearch}
      />

      <header className="shrink-0 px-4 pt-[max(0.65rem,env(safe-area-inset-top))] pb-2.5" style={{ backgroundColor: BG }}>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-xl font-bold tracking-tight text-white sm:text-2xl">Home</h1>
              <span className="rounded-full border border-white/10 bg-white/5 px-2 py-0.5 text-xs font-semibold text-white/90 backdrop-blur-md">
                Operator
              </span>
            </div>
            <p className="mt-0.5 text-sm font-medium text-slate-500">Warehouse receiving</p>
          </div>
          <div className="flex shrink-0 flex-col items-end gap-1.5 pt-0.5">
            <OperatorHomeStoreSelector />
            <BellHeader count={2} />
          </div>
        </div>
      </header>

      <main className={`min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-4 ${mainScrollClass}`}>
        <section className="flex flex-row gap-2" aria-label="Receiving stats">
          <StatCard value="18" label="Assigned Pallets" accentRing="rgba(59, 130, 246, 0.22)">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-blue-500/10 p-1.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.08)] ring-1 ring-blue-500/15">
              <PalletStatIcon className="h-5 w-5 text-blue-400" strokeWidth={2.25} />
            </div>
          </StatCard>
          <StatCard value="37" label="Open Boxes" accentRing="rgba(168, 85, 247, 0.22)">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-purple-500/10 p-1.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.08)] ring-1 ring-purple-500/15">
              <Package className="h-5 w-5 text-purple-400" strokeWidth={2.25} />
            </div>
          </StatCard>
          <StatCard value="142" label="Items to Inspect" accentRing="rgba(16, 185, 129, 0.18)">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-emerald-500/10 p-1.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.08)] ring-1 ring-emerald-500/15">
              <Search className="h-5 w-5 text-emerald-400" strokeWidth={2.25} />
            </div>
          </StatCard>
          <StatCard value="5" label="Alerts" accentRing="rgba(248, 113, 113, 0.2)">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-red-500/10 p-1.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.08)] ring-1 ring-red-500/15">
              <AlertTriangle className="h-5 w-5 text-red-400" strokeWidth={2.25} />
            </div>
          </StatCard>
        </section>

        <section className="mt-3 grid grid-cols-2 gap-2.5">
          <button
            type="button"
            onClick={() => router.push(SCANNER_OPERATOR_SCAN_PATH)}
            className="relative flex min-h-[84px] items-stretch gap-2.5 overflow-hidden rounded-2xl border border-blue-400/20 bg-gradient-to-br from-blue-500 to-blue-700 px-2.5 py-3 text-left shadow-[0_12px_32px_-14px_rgba(37,99,235,0.5),inset_0_1px_0_rgba(255,255,255,0.22),inset_0_-3px_16px_rgba(0,0,0,0.18),inset_0_0_24px_-8px_rgba(255,255,255,0.08)] transition active:scale-[0.98]"
          >
            <span
              className="pointer-events-none absolute inset-0 bg-[radial-gradient(100%_70%_at_30%_0%,rgba(255,255,255,0.14),transparent_55%)]"
              aria-hidden
            />
            <span className="relative flex shrink-0 items-center justify-center">
              <PlusSquare className="h-10 w-10 text-white drop-shadow-[0_3px_8px_rgba(0,0,0,0.4)]" strokeWidth={2.35} />
            </span>
            <span className="relative min-w-0">
              <span className="block text-sm font-bold leading-snug text-white">Start New Receiving</span>
              <span className="mt-0.5 block text-xs font-medium leading-snug text-blue-100/85">New pallet / box</span>
            </span>
          </button>
          <button
            type="button"
            onClick={() => router.push(SCANNER_OPERATOR_SCAN_PATH)}
            className="relative flex min-h-[84px] items-stretch gap-2 rounded-2xl border border-white/10 bg-gradient-to-br from-slate-800 to-slate-950 px-2.5 py-3 text-left shadow-[0_10px_28px_-14px_rgba(0,0,0,0.55),inset_0_1px_0_rgba(255,255,255,0.12),inset_0_-2px_12px_rgba(0,0,0,0.25),inset_0_0_20px_-10px_rgba(255,255,255,0.04)] transition active:scale-[0.98]"
          >
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-white/15 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.15)] ring-1 ring-white/10">
              <ScanBarcode className="h-5 w-5" strokeWidth={2.1} />
            </span>
            <span className="min-w-0">
              <span className="block text-sm font-bold leading-snug text-white">Continue Scan</span>
              <span className="mt-0.5 block text-xs font-medium leading-snug text-slate-400">Resume session</span>
            </span>
          </button>
        </section>

        <button
          type="button"
          onClick={openSearchOverlay}
          className={`mt-3 flex w-full items-center gap-3 rounded-2xl px-3 py-3 text-left ${glassCard}`}
        >
          <span
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg"
            style={{ color: PALLET.fg, backgroundColor: PALLET.bg }}
          >
            <Search className="h-4 w-4" strokeWidth={2.25} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-semibold text-white">Search pallet / box / item</span>
            <span className="mt-0.5 block text-xs font-medium text-slate-500">Barcode, label, or serial</span>
          </span>
          <ChevronRight className="h-4 w-4 shrink-0 text-slate-500" strokeWidth={2} />
        </button>

        <section className="mt-5">
          <h2 className="text-lg font-bold tracking-tight text-white">Today&apos;s tasks</h2>
          <ul className="mt-2 space-y-2">
            {TASKS.map((task) => {
              const ratio = task.total > 0 ? task.done / task.total : 0;
              return (
                <li key={task.id}>
                  <button type="button" className={`flex w-full items-start gap-2.5 rounded-2xl px-3 py-2.5 text-left ${glassCard}`}>
                    <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center">
                      {task.complete ? (
                        <CheckCircle2
                          className="h-7 w-7 text-emerald-500 drop-shadow-[0_0_6px_rgba(16,185,129,0.45)]"
                          strokeWidth={2.35}
                        />
                      ) : (
                        <Circle className="h-7 w-7 text-slate-600" strokeWidth={2} />
                      )}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-start justify-between gap-2">
                        <span className="text-sm font-semibold text-white">{task.label}</span>
                        <span className="shrink-0 text-xs font-bold tabular-nums text-slate-500">
                          {task.done} / {task.total}
                        </span>
                      </span>
                      <ProgressBar ratio={ratio} barClass={task.barClass} />
                    </span>
                    <ChevronRight className="mt-1 h-4 w-4 shrink-0 text-slate-600" strokeWidth={2} />
                  </button>
                </li>
              );
            })}
          </ul>
        </section>

        <section className="mt-5">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-lg font-bold tracking-tight text-white">Recent items</h2>
            <Link href="#" className="text-sm font-semibold transition hover:text-teal-300" style={{ color: TEAL }}>
              View all
            </Link>
          </div>
          <ul className="mt-2 space-y-2">
            {RECENT.map((row) => (
              <li key={row.sku} className={`rounded-2xl px-3 py-2.5 ${glassCardQuiet}`}>
                <div className="flex gap-2.5">
                  <div
                    className="relative flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-white/5 bg-gradient-to-br from-amber-950/35 via-slate-900/80 to-[#0c1220] shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]"
                    aria-hidden
                  >
                    <PackageOpen className="h-6 w-6 text-amber-700/90" strokeWidth={2} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="font-mono text-[11px] font-bold text-white">{row.sku}</p>
                    <p className="mt-0.5 truncate text-sm font-medium text-slate-200">{row.name}</p>
                    <p className="mt-0.5 text-xs font-semibold" style={{ color: PALLET.fg }}>
                      Pallet {row.pallet}
                    </p>
                    <StatusPill status={row.status} />
                  </div>
                  <div className="flex shrink-0 flex-col items-end justify-start gap-1">
                    <div className="flex items-center gap-0.5 text-slate-500">
                      <button
                        type="button"
                        className="rounded-md p-1 transition hover:bg-white/5 active:scale-95"
                        aria-label="Locked"
                      >
                        <Lock className="h-3.5 w-3.5" />
                      </button>
                      <button type="button" className="rounded-md p-1 transition hover:bg-white/5 active:scale-95" aria-label="Edit">
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                      <button type="button" className="rounded-md p-1 transition hover:bg-white/5 active:scale-95" aria-label="Delete">
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </section>
      </main>

      <ScannerBottomNav active="home" alertCount={2} />
    </div>
  );
}
