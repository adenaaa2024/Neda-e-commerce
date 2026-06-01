"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { Check, ChevronDown, Lock, Search } from "lucide-react";
import { useBranding } from "@/components/BrandingContext";
import { useOperatorSessionStore } from "./OperatorSessionStoreProvider";
import { isSupabaseConfigured } from "@/src/lib/supabase";

/**
 * Operator-mobile home route. The store selector is only changeable on this
 * route; on every other route (e.g. /scanner/operator-mobile/scan) the chip
 * locks to the session store so the operator cannot accidentally change scope
 * mid-flow. To switch stores they must navigate Back to Home.
 */
const OPERATOR_HOME_ROUTE = "/scanner/operator-mobile";

function requestOperatorScanFocus() {
  try {
    window.dispatchEvent(new CustomEvent("operator-mobile:request-scan-focus"));
  } catch {
    /* ignore */
  }
}

/**
 * Brand header row for the operator-mobile shell:
 *   • Left: customer company name (text only — tenant logo removed per UX request).
 *   • Right: active store name (or selector when the operator has multiple stores).
 *
 * The platform/product brand lives in the slim utility row above and stays the
 * dominant identity; this row carries the secondary "which company / which store"
 * scope information.
 */
export function OperatorProductBrandingStrip({ className }: { className?: string }) {
  const { companyName, loading: tenantLoading } = useBranding();
  const tenantLabel = tenantLoading ? "" : companyName.trim();

  return (
    <div
      className={["flex w-full min-w-0 items-center justify-between gap-2", className].filter(Boolean).join(" ")}
    >
      {/* Left: customer company name. min-w-0 + truncate keeps long names from
          pushing the right-side store chip off-screen. */}
      <div className="flex min-w-0 flex-1 items-center">
        {tenantLoading ? (
          <span
            className="text-[11px] font-semibold opacity-60"
            style={{ color: "var(--scanner-text)" }}
            aria-hidden
          >
            …
          </span>
        ) : tenantLabel ? (
          <span
            className="operator-heading min-w-0 truncate text-[11px] font-semibold tracking-tight"
            style={{ color: "var(--scanner-text)" }}
            title={tenantLabel}
          >
            {tenantLabel}
          </span>
        ) : null}
      </div>

      {/* Right: active store name / selector */}
      <InlineStoreSelector />
    </div>
  );
}

/**
 * Returns true when the user is on the operator-mobile home page (and the
 * store dropdown should be editable). On any sub-route (scan, etc.) the
 * selection is locked-in for the session and rendered as a static status
 * chip with a lock icon.
 */
function useIsOperatorHomeRoute(): boolean {
  const pathname = usePathname() ?? "";
  return useMemo(() => {
    const normalized = pathname.replace(/\/+$/, "");
    return normalized === OPERATOR_HOME_ROUTE;
  }, [pathname]);
}

/**
 * Compact store identifier that fits inline with the brand row.
 *
 * Routes:
 *   • Home page → editable. Multiple stores render the {@link StoreCombobox};
 *     single store / kiosk render a read-only chip.
 *   • Any other route → locked. A static status chip with a 🔒 icon shows the
 *     active store name (no chevron, no hover-as-button affordance, cursor-default).
 *
 * Loading / unconfigured / "no stores" states keep their informational chips
 * unchanged so the operator still sees why the selector is unavailable.
 */
function InlineStoreSelector() {
  const {
    sessionStoreId,
    selectSessionStoreId,
    operatorStores,
    operatorStoresLoading,
    kioskStoreLocked,
    activeStoreLabel,
  } = useOperatorSessionStore();
  const selId = useId();
  const isHome = useIsOperatorHomeRoute();
  const lockedForSession = !isHome;

  const baseChip =
    "max-w-[min(9rem,38vw)] truncate rounded-md border px-1.5 py-0.5 text-[10px] font-semibold tabular-nums tracking-tight";
  const labelClass = "operator-store-label";

  if (!isSupabaseConfigured()) {
    return (
      <div className="flex shrink-0 items-center gap-1.5">
        <span className={labelClass}>Store</span>
        <span
          className={`${baseChip} border-black/10 bg-white/70 text-zinc-700 dark:border-white/10 dark:bg-zinc-900/90 dark:text-zinc-400`}
          title="Demo mode"
        >
          Demo
        </span>
      </div>
    );
  }

  if (operatorStoresLoading) {
    return (
      <div className="flex shrink-0 items-center gap-1.5">
        <span className={labelClass}>Store</span>
        <span
          className={baseChip}
          style={{
            borderColor: "var(--scanner-border)",
            backgroundColor: "var(--scanner-card)",
            color: "var(--scanner-text)",
          }}
        >
          …
        </span>
      </div>
    );
  }

  if (kioskStoreLocked) {
    return (
      <div className="flex shrink-0 items-center gap-1.5">
        <span className={labelClass}>Store</span>
        <LockedStoreChip
          baseChip={baseChip}
          name={activeStoreLabel ?? "Kiosk"}
          title={activeStoreLabel ?? "Kiosk store"}
          /* Kiosk mode is always locked regardless of route. */
          showLock
        />
      </div>
    );
  }

  if (operatorStores.length === 0) {
    return (
      <div className="flex shrink-0 items-center gap-1.5">
        <span className={labelClass}>Store</span>
        <span
          className={`${baseChip} border-amber-500/35 bg-amber-50/95 text-amber-950 dark:border-amber-400/30 dark:bg-amber-950/30 dark:text-amber-100`}
          title="No stores for this organization"
        >
          No stores
        </span>
      </div>
    );
  }

  // Single store: never editable, but only flag with a lock when we're off the
  // home page so the home page stays visually clean.
  if (operatorStores.length === 1) {
    const name = operatorStores[0].name;
    return (
      <div className="flex shrink-0 items-center gap-1.5">
        <span className={labelClass}>Store</span>
        <LockedStoreChip
          baseChip={baseChip}
          name={name}
          title={name}
          showLock={lockedForSession}
        />
      </div>
    );
  }

  // Multiple stores: editable on Home, locked status on every other route.
  if (lockedForSession) {
    const displayName = activeStoreLabel ?? "Not set";
    const titleText = activeStoreLabel
      ? `${activeStoreLabel} — locked for this session. Go Home to change.`
      : "No store selected — return Home to pick one.";
    return (
      <div className="flex shrink-0 items-center gap-1.5">
        <span className={labelClass}>Store</span>
        <LockedStoreChip
          baseChip={baseChip}
          name={displayName}
          title={titleText}
          showLock
          warn={!activeStoreLabel}
        />
      </div>
    );
  }

  return (
    <StoreCombobox
      triggerId={selId}
      labelClass={labelClass}
      baseChip={baseChip}
      stores={operatorStores}
      sessionStoreId={sessionStoreId}
      onSelect={selectSessionStoreId}
    />
  );
}

/**
 * Static-looking status chip: same chip dimensions as the editable trigger,
 * but rendered as a <span> (not a button), with no chevron, no hover affordance,
 * and an optional lock icon to communicate "fixed for this session."
 */
function LockedStoreChip(props: {
  baseChip: string;
  name: string;
  title: string;
  showLock?: boolean;
  /** Tints the chip amber when the locked-in value is missing/unset. */
  warn?: boolean;
}) {
  const { baseChip, name, title, showLock, warn } = props;
  const tone = warn
    ? "border-amber-500/40 bg-amber-50/90 text-amber-950 dark:border-amber-400/35 dark:bg-amber-950/30 dark:text-amber-100"
    : "";
  return (
    <span
      className={`${baseChip} inline-flex max-w-[min(11rem,46vw)] cursor-default items-center gap-1 ${tone}`}
      style={
        warn
          ? undefined
          : {
              borderColor: "var(--scanner-border)",
              backgroundColor: "var(--scanner-card)",
              color: "var(--scanner-text)",
            }
      }
      title={title}
      role="status"
      aria-label={`Active store: ${name}`}
    >
      {showLock ? (
        <Lock
          className={`h-2.5 w-2.5 shrink-0 ${warn ? "text-amber-600 dark:text-amber-300" : ""}`}
          style={warn ? undefined : { color: "var(--op-accent-gold)" }}
          strokeWidth={2.75}
          aria-hidden
        />
      ) : null}
      <span className="min-w-0 flex-1 truncate">{name}</span>
    </span>
  );
}

type StoreOption = { id: string; name: string };

function StoreCombobox(props: {
  triggerId: string;
  labelClass: string;
  baseChip: string;
  stores: StoreOption[];
  sessionStoreId: string | null;
  onSelect: (id: string) => void;
}) {
  const { triggerId, labelClass, baseChip, stores, sessionStoreId, onSelect } = props;

  const [open, setOpen] = useState(false);
  const [searchMode, setSearchMode] = useState(false);
  const [query, setQuery] = useState("");
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const closePanel = useCallback(() => {
    setOpen(false);
    setSearchMode(false);
    requestOperatorScanFocus();
  }, []);

  const enableStoreSearch = useCallback(() => {
    setSearchMode(true);
    window.setTimeout(() => searchRef.current?.focus(), 0);
  }, []);

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

  // Reset query/search mode when the panel closes.
  useEffect(() => {
    if (!open) {
      setQuery("");
      setSearchMode(false);
    }
  }, [open]);

  const selected = stores.find((s) => s.id === sessionStoreId) ?? null;
  const trimmedQuery = query.trim().toLowerCase();
  const filtered = trimmedQuery
    ? stores.filter((s) => s.name.toLowerCase().includes(trimmedQuery))
    : stores;
  const showSearch = stores.length > 6;
  const triggerLabel = selected ? selected.name : "Pick…";
  const triggerInvalid = !sessionStoreId;

  return (
    <div className="relative flex shrink-0 items-center gap-1.5">
      <label htmlFor={triggerId} className={labelClass}>
        Store
      </label>
      <button
        id={triggerId}
        ref={triggerRef}
        type="button"
        onClick={() => {
          if (open) closePanel();
          else setOpen(true);
        }}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-invalid={triggerInvalid}
        title={triggerLabel}
        className={`${baseChip} flex max-w-[min(11rem,46vw)] cursor-pointer items-center gap-1 pl-2 pr-1.5 text-left outline-none transition focus-visible:ring-2 ${
          triggerInvalid ? "border-amber-500/45 dark:border-amber-400/45" : ""
        }`}
        style={{
          borderColor: triggerInvalid ? undefined : "var(--scanner-border)",
          backgroundColor: "var(--scanner-card)",
          color: "var(--scanner-text)",
          boxShadow: "inset 0 1px 0 rgba(255,255,255,0.08)",
        }}
      >
        <span className="min-w-0 flex-1 truncate">{triggerLabel}</span>
        <ChevronDown
          className={`h-3 w-3 shrink-0 transition ${open ? "rotate-180" : ""}`}
          style={{ color: "var(--op-accent-gold)" }}
          strokeWidth={2.5}
        />
      </button>

      {open ? (
        <>
          {/* Backdrop swallows clicks outside the panel on touch devices where
              the document-level listener can race the new render. */}
          <div
            className="fixed inset-0 z-[140] cursor-default"
            aria-hidden
            onClick={closePanel}
          />
          <div
            ref={panelRef}
            role="listbox"
            aria-label="Active store"
            className="absolute right-0 top-[calc(100%+6px)] z-[141] w-[min(calc(100vw-1.5rem),22rem)] overflow-hidden rounded-xl border shadow-[0_16px_40px_rgba(0,0,0,0.45)]"
            style={{
              borderColor: "var(--scanner-border, #243241)",
              backgroundColor: "var(--scanner-card, #0e1620)",
              color: "var(--scanner-text, #f1f5f9)",
            }}
          >
            {showSearch ? (
              searchMode ? (
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
                    placeholder={`Search ${stores.length} stores…`}
                    className="min-w-0 flex-1 bg-transparent text-[12px] font-medium outline-none placeholder:opacity-50"
                    spellCheck={false}
                    autoComplete="off"
                    inputMode="search"
                  />
                </div>
              ) : (
                <button
                  type="button"
                  onClick={enableStoreSearch}
                  className="flex w-full items-center gap-1.5 border-b px-2.5 py-2 text-left text-[12px] font-semibold opacity-80 transition hover:bg-white/5 hover:opacity-100"
                  style={{ borderColor: "var(--scanner-border, #243241)" }}
                >
                  <Search className="h-3.5 w-3.5 shrink-0 opacity-60" strokeWidth={2.25} />
                  <span>Search stores</span>
                </button>
              )
            ) : null}
            <ul className="max-h-[min(60vh,360px)] list-none overflow-y-auto overscroll-contain py-1">
              {filtered.length === 0 ? (
                <li
                  className="px-3 py-2 text-[12px] font-medium opacity-70"
                  aria-live="polite"
                >
                  No matches
                </li>
              ) : (
                filtered.map((s) => {
                  const isSelected = s.id === sessionStoreId;
                  return (
                    <li key={s.id} role="option" aria-selected={isSelected}>
                      <button
                        type="button"
                        onClick={() => {
                          onSelect(s.id);
                          closePanel();
                        }}
                        className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-[12px] font-semibold transition hover:bg-white/5"
                        style={
                          isSelected
                            ? {
                                backgroundColor: "color-mix(in srgb, var(--op-accent-gold) 14%, transparent)",
                                color: "var(--scanner-text)",
                              }
                            : { color: "var(--scanner-text)" }
                        }
                      >
                        <span className="min-w-0 break-words">{s.name}</span>
                        {isSelected ? (
                          <Check className="h-3.5 w-3.5 shrink-0" style={{ color: "var(--op-accent-gold)" }} strokeWidth={2.5} />
                        ) : null}
                      </button>
                    </li>
                  );
                })
              )}
            </ul>
          </div>
        </>
      ) : null}
    </div>
  );
}
