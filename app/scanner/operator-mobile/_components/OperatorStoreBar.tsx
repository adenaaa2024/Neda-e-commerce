"use client";

import { useId } from "react";
import { useOperatorSessionStore } from "./OperatorSessionStoreProvider";
import { isSupabaseConfigured } from "@/src/lib/supabase";

const storeGlass =
  "rounded-xl border px-2.5 py-1.5 text-xs font-bold shadow-[inset_0_1px_0_rgba(255,255,255,0.65)] backdrop-blur-md tracking-tight dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]";

/**
 * Store scope for operator mobile: loads active `stores` for the effective organization.
 * — One store: read-only label (auto-selected session).
 * — Several: combobox; user must pick a store (no implicit first-store default).
 */
export function OperatorStoreBar() {
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
      <div className="flex w-full min-w-0 items-center gap-2">
        <span className="text-[9px] font-bold uppercase tracking-widest text-teal-700/90 dark:text-teal-200/70">
          Store
        </span>
        <span
          className={`${storeGlass} border-black/10 bg-white/70 text-zinc-700 dark:border-white/10 dark:bg-zinc-900/90 dark:text-zinc-400`}
        >
          Demo mode
        </span>
      </div>
    );
  }

  if (operatorStoresLoading) {
    return (
      <div className="flex w-full min-w-0 items-center gap-2">
        <span className="text-[9px] font-bold uppercase tracking-widest text-teal-700/90 dark:text-teal-200/70">
          Store
        </span>
        <span
          className={`${storeGlass} border-teal-600/20 bg-white/75 text-zinc-700 dark:border-teal-400/20 dark:bg-zinc-900/90 dark:text-zinc-400`}
        >
          Loading…
        </span>
      </div>
    );
  }

  if (kioskStoreLocked) {
    return (
      <div className="flex w-full min-w-0 items-center gap-2">
        <span className="text-[9px] font-bold uppercase tracking-widest text-teal-700/90 dark:text-teal-200/70">
          Store
        </span>
        {activeStoreLabel ? (
          <span
            className={`${storeGlass} min-w-0 flex-1 truncate border-teal-600/25 bg-white/75 text-zinc-900 dark:border-teal-400/25 dark:bg-zinc-900/90 dark:text-zinc-50`}
            title={activeStoreLabel}
          >
            {activeStoreLabel}
          </span>
        ) : (
          <span
            className={`${storeGlass} border-teal-600/25 bg-teal-50/90 text-teal-900 dark:border-teal-400/25 dark:bg-zinc-900/90 dark:text-teal-100/90`}
          >
            Kiosk store
          </span>
        )}
      </div>
    );
  }

  if (operatorStores.length === 0) {
    return (
      <div className="flex w-full min-w-0 items-center gap-2">
        <span className="text-[9px] font-bold uppercase tracking-widest text-teal-700/90 dark:text-teal-200/70">
          Store
        </span>
        <span
          className={`${storeGlass} min-w-0 flex-1 border-amber-500/35 bg-amber-50/95 text-amber-950 dark:border-amber-400/30 dark:bg-amber-950/30 dark:text-amber-100`}
        >
          No stores for this organization
        </span>
      </div>
    );
  }

  if (operatorStores.length === 1) {
    const name = operatorStores[0].name;
    return (
      <div className="flex w-full min-w-0 items-center gap-2">
        <span className="text-[9px] font-bold uppercase tracking-widest text-teal-700/90 dark:text-teal-200/70">
          Store
        </span>
        <span
          className={`${storeGlass} min-w-0 flex-1 truncate border-teal-600/25 bg-white/75 text-zinc-900 dark:border-teal-400/25 dark:bg-zinc-900/90 dark:text-zinc-50`}
          title={name}
        >
          {name}
        </span>
      </div>
    );
  }

  return (
    <div className="flex w-full min-w-0 flex-col gap-0.5">
      <label
        htmlFor={selId}
        className="text-[9px] font-bold uppercase tracking-widest text-teal-700/90 dark:text-teal-200/70"
      >
        Store <span className="text-amber-600/90 dark:text-amber-400/80">(required)</span>
      </label>
      <select
        id={selId}
        required
        value={sessionStoreId ?? ""}
        onChange={(e) => selectSessionStoreId(e.target.value)}
        className={`${storeGlass} w-full min-w-0 cursor-pointer appearance-none border-teal-600/25 bg-white/80 py-2 pl-2.5 pr-8 text-xs text-zinc-900 outline-none transition hover:bg-white/95 dark:border-teal-400/25 dark:bg-zinc-900/95 dark:text-zinc-50 dark:hover:bg-zinc-800/95`}
        style={{
          backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='14' height='14' viewBox='0 0 24 24' fill='none' stroke='%232dd4bf' stroke-width='2.5'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E")`,
          backgroundRepeat: "no-repeat",
          backgroundPosition: "right 0.45rem center",
        }}
        aria-invalid={!sessionStoreId}
      >
        <option value="" disabled className="bg-[var(--scanner-card)] text-[var(--scanner-muted)]">
          Select a store…
        </option>
        {operatorStores.map((s) => (
          <option key={s.id} value={s.id} className="bg-[var(--scanner-card)] text-[var(--scanner-text)]">
            {s.name}
          </option>
        ))}
      </select>
    </div>
  );
}
