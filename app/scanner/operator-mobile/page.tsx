"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
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
import { operatorHapticTap, operatorUiAcknowledge } from "./_lib/operator-haptics";

/** Industrial glass panels — blur + 0.5px edge (see `.operator-glass-card-home` in globals.css) */
const glassCard = "operator-glass-card-home rounded-2xl";

const mainScrollClass =
  "[scrollbar-width:thin] [scrollbar-color:var(--scanner-border)_var(--scanner-bg)] [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-[var(--scanner-border)]/90 hover:[&::-webkit-scrollbar-thumb]:opacity-80";

type TaskRow = {
  id: string;
  label: string;
  done: number;
  total: number;
  complete: boolean;
  tube: "sky" | "violet" | "emerald";
};

const TASKS: TaskRow[] = [
  { id: "pallets", label: "Receive assigned pallets", done: 12, total: 18, complete: true, tube: "sky" },
  { id: "boxes", label: "Open and scan boxes", done: 24, total: 37, complete: true, tube: "violet" },
  { id: "inspect", label: "Inspect items", done: 68, total: 142, complete: false, tube: "emerald" },
];

const RECENT = [
  { sku: "SKU-20034", name: "Wireless Headset Pro", pallet: "PLT-000123", status: "In Progress" as const },
  { sku: "SKU-08891", name: "USB-C Hub 7-port", pallet: "PLT-000104", status: "Received" as const },
];

const PalletStatIcon = Warehouse;

function BellHeader({ count }: { count: number }) {
  return (
    <button
      type="button"
      className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-zinc-800 transition hover:bg-black/[0.05] active:scale-95 dark:text-zinc-50 dark:hover:bg-white/5"
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
      className={`operator-glass-card-home flex min-w-0 flex-1 flex-col gap-1.5 rounded-xl px-3 py-3.5 sm:px-3.5`}
      style={{
        boxShadow: `
          0 0 0 0.5px rgba(34, 211, 238, 0.1),
          inset 0 1px 0 0 rgba(255, 255, 255, 0.06),
          inset 0 0 0 1px ${accentRing},
          0 12px 36px -18px rgba(0, 0, 0, 0.45)
        `,
      }}
    >
      {children}
      <p className="text-xl font-bold tabular-nums tracking-tight text-zinc-900 dark:text-zinc-50">{value}</p>
      <p className="text-[10px] font-semibold uppercase tracking-wide text-zinc-700 dark:text-zinc-400">{label}</p>
    </div>
  );
}

function ProgressBar({ ratio, tube }: { ratio: number; tube: TaskRow["tube"] }) {
  const pct = Math.min(100, Math.max(0, ratio * 100));
  const fill =
    tube === "sky"
      ? "operator-progress-fill operator-progress-fill--sky"
      : tube === "violet"
        ? "operator-progress-fill operator-progress-fill--violet"
        : "operator-progress-fill operator-progress-fill--emerald";
  return (
    <div className="operator-progress-shell" aria-hidden>
      <div className={fill} style={{ width: `${pct}%` }} />
    </div>
  );
}

function StatusPill({ status }: { status: (typeof RECENT)[number]["status"] }) {
  const base =
    "mt-1 inline-flex w-fit rounded-full px-1.5 py-px text-[8px] font-bold uppercase tracking-wide backdrop-blur-sm";
  if (status === "Received") {
    return (
      <span
        className={`${base} border border-emerald-600/35 bg-emerald-500/12 text-emerald-800 shadow-none dark:border-emerald-500/35 dark:bg-emerald-500/15 dark:text-emerald-400 dark:shadow-[0_0_10px_rgba(16,185,129,0.22)]`}
      >
        {status}
      </span>
    );
  }
  return (
    <span
      className={`${base} border border-sky-600/35 bg-sky-500/12 text-sky-800 shadow-none dark:border-sky-500/30 dark:bg-sky-500/15 dark:text-sky-300 dark:shadow-[0_0_10px_rgba(14,165,233,0.2)]`}
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

      {/* Slim single-row header — Home title and "Warehouse receiving" subtitle merged
          into one line to save vertical space (per mobile-operator UX request). */}
      <header
        className="shrink-0 border-b px-4 pb-1.5 pt-1.5"
        style={{
          borderColor: "var(--scanner-border)",
          background: "var(--scanner-header-gradient)",
        }}
      >
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <h1 className="operator-heading text-base font-semibold tracking-tight text-zinc-900 dark:text-zinc-50 sm:text-lg">
              Home
            </h1>
            <span className="rounded-full border border-black/10 bg-black/[0.04] px-1.5 py-0.5 text-[10px] font-semibold text-zinc-900 backdrop-blur-md dark:border-white/10 dark:bg-white/5 dark:text-zinc-50">
              Operator
            </span>
            <span className="text-[11px] font-medium text-zinc-500 dark:text-zinc-500">·</span>
            <span className="truncate text-xs font-medium text-zinc-700 dark:text-zinc-400">
              Warehouse receiving
            </span>
          </div>
          <div className="flex shrink-0 items-center gap-0.5">
            <BellHeader count={2} />
          </div>
        </div>
      </header>

      <main className={`min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-4 ${mainScrollClass}`}>
        <section className="flex flex-row gap-2.5" aria-label="Receiving stats">
          <StatCard value="18" label="Assigned Pallets" accentRing="rgba(59, 130, 246, 0.22)">
            <div className="operator-stat-well operator-stat-well--blue">
              <PalletStatIcon className="operator-stat-icon-neon-blue h-5 w-5 text-blue-700 dark:text-blue-300" strokeWidth={2.25} />
            </div>
          </StatCard>
          <StatCard value="37" label="Open Boxes" accentRing="rgba(168, 85, 247, 0.22)">
            <div className="operator-stat-well operator-stat-well--violet">
              <Package className="operator-stat-icon-neon-violet h-5 w-5 text-violet-700 dark:text-violet-300" strokeWidth={2.25} />
            </div>
          </StatCard>
          <StatCard value="142" label="Items to Inspect" accentRing="rgba(16, 185, 129, 0.18)">
            <div className="operator-stat-well operator-stat-well--emerald">
              <Search className="operator-stat-icon-neon-emerald h-5 w-5 text-emerald-700 dark:text-emerald-300" strokeWidth={2.25} />
            </div>
          </StatCard>
          <StatCard value="5" label="Alerts" accentRing="rgba(248, 113, 113, 0.2)">
            <div className="operator-stat-well operator-stat-well--red">
              <AlertTriangle className="operator-stat-icon-neon-red h-5 w-5 text-red-700 dark:text-red-300" strokeWidth={2.25} />
            </div>
          </StatCard>
        </section>

        <section className="mt-4 grid grid-cols-2 gap-3">
          <button
            type="button"
            onClick={() => {
              operatorUiAcknowledge();
              router.push(SCANNER_OPERATOR_SCAN_PATH);
            }}
            className="operator-neumo-blue relative flex min-h-[92px] items-stretch gap-2.5 overflow-hidden px-3 py-3.5 text-left"
          >
            <span
              className="pointer-events-none absolute inset-0 bg-[radial-gradient(90%_65%_at_28%_0%,rgba(255,255,255,0.2),transparent_58%)]"
              aria-hidden
            />
            <span className="relative flex shrink-0 items-center justify-center">
              <PlusSquare className="h-10 w-10 text-white drop-shadow-[0_2px_12px_rgba(0,0,0,0.35)]" strokeWidth={2.35} />
            </span>
            <span className="relative min-w-0">
              <span className="block text-[13px] font-bold leading-snug text-white">Start New Receiving</span>
              <span className="mt-0.5 block text-[11px] font-medium leading-snug text-blue-100/90">New pallet / box</span>
            </span>
          </button>
          <button
            type="button"
            onClick={() => {
              operatorUiAcknowledge();
              router.push(SCANNER_OPERATOR_SCAN_PATH);
            }}
            className="operator-neumo-continue relative flex min-h-[92px] items-stretch gap-2.5 px-3 py-3.5 text-left"
          >
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-zinc-300/90 text-zinc-800 shadow-[inset_0_1px_0_rgba(255,255,255,0.85)] ring-[0.5px] ring-zinc-400/50 dark:bg-white/15 dark:text-white dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.18)] dark:ring-white/12">
              <ScanBarcode className="h-5 w-5" strokeWidth={2.1} />
            </span>
            <span className="min-w-0">
              <span className="block text-[13px] font-bold leading-snug text-zinc-900 dark:text-white">Continue Scan</span>
              <span className="mt-0.5 block text-[11px] font-medium leading-snug text-zinc-600 dark:text-zinc-400">
                Resume session
              </span>
            </span>
          </button>
        </section>

        <button
          type="button"
          onClick={() => {
            operatorUiAcknowledge();
            openSearchOverlay();
          }}
          className={`mt-4 flex w-full items-center gap-3 rounded-2xl px-4 py-3.5 text-left ${glassCard}`}
        >
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-sky-500/15 text-sky-700 ring-1 ring-sky-600/25 dark:bg-sky-500/10 dark:text-sky-400 dark:ring-sky-500/15">
            <Search className="h-4 w-4" strokeWidth={2.25} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-semibold text-zinc-900 dark:text-zinc-50">Search pallet / box / item</span>
            <span className="mt-0.5 block text-xs font-medium text-zinc-700 dark:text-zinc-400">
              Barcode, label, or serial
            </span>
          </span>
          <ChevronRight className="h-4 w-4 shrink-0 text-zinc-500 dark:text-zinc-500" strokeWidth={2} />
        </button>

        <section className="mt-6">
          <h2 className="operator-heading text-base font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
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
                        <CheckCircle2
                          className="h-7 w-7 text-emerald-500 drop-shadow-[0_0_6px_rgba(16,185,129,0.45)]"
                          strokeWidth={2.35}
                        />
                      ) : (
                        <Circle className="h-7 w-7 text-zinc-400 dark:text-zinc-500" strokeWidth={2} />
                      )}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-start justify-between gap-2">
                        <span className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">{task.label}</span>
                        <span className="shrink-0 text-xs font-bold tabular-nums text-zinc-700 dark:text-zinc-400">
                          {task.done} / {task.total}
                        </span>
                      </span>
                      <ProgressBar ratio={ratio} tube={task.tube} />
                    </span>
                    <ChevronRight className="mt-1 h-4 w-4 shrink-0 text-zinc-500 dark:text-zinc-500" strokeWidth={2} />
                  </button>
                </li>
              );
            })}
          </ul>
        </section>

        <section className="mt-6">
          <div className="flex items-center justify-between gap-2">
            <h2 className="operator-heading text-base font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
              Recent items
            </h2>
            <Link
              href="#"
              className="text-sm font-semibold text-teal-700 transition hover:text-teal-900 dark:text-teal-400 dark:hover:text-teal-300"
            >
              View all
            </Link>
          </div>
          <ul className="mt-3 space-y-0">
            {RECENT.map((row, i) => (
              <li key={row.sku}>
                {i > 0 ? <div className="operator-recent-divider-glow my-3 w-full" aria-hidden /> : null}
                <div className="operator-recent-row px-4 py-3.5">
                  <div className="flex gap-3">
                  <div
                    className="relative flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-zinc-200 bg-gradient-to-br from-amber-50 via-white to-zinc-100 shadow-[inset_0_1px_0_rgba(255,255,255,0.9)] dark:border-white/10 dark:from-amber-950/35 dark:via-slate-900/80 dark:to-[#0c1220] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]"
                    aria-hidden
                  >
                    <PackageOpen className="h-6 w-6 text-amber-800 dark:text-amber-400" strokeWidth={2} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="font-mono text-[11px] font-bold text-zinc-900 dark:text-zinc-50">{row.sku}</p>
                    <p className="mt-0.5 truncate text-sm font-medium text-zinc-900 dark:text-zinc-50">{row.name}</p>
                    <p className="mt-0.5 font-mono text-[11px] font-bold uppercase tracking-wide text-sky-700 dark:text-cyan-200 dark:drop-shadow-[0_0_10px_rgba(34,211,238,0.35)]">
                      Pallet {row.pallet}
                    </p>
                    <StatusPill status={row.status} />
                  </div>
                  <div className="flex shrink-0 flex-col items-end justify-start gap-1">
                    <div className="flex items-center gap-0.5 text-zinc-600 dark:text-zinc-400">
                      <button
                        type="button"
                        className="rounded-md p-1 transition hover:bg-black/[0.06] active:scale-95 dark:hover:bg-white/10"
                        aria-label="Locked"
                      >
                        <Lock className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        className="rounded-md p-1 transition hover:bg-black/[0.06] active:scale-95 dark:hover:bg-white/10"
                        aria-label="Edit"
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        className="rounded-md p-1 transition hover:bg-black/[0.06] active:scale-95 dark:hover:bg-white/10"
                        aria-label="Delete"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
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
