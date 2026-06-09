"use client";

import { useCallback, useEffect, useState } from "react";
import { RefreshCw, X } from "lucide-react";
import { usePathname } from "next/navigation";
import { performMenorixPwaUpdate } from "@/lib/pwa-cache-reset";
import {
  refreshPwaUpdateBannerAvailability,
  runPwaVersionBootCheckOnce,
} from "@/lib/pwa-version-boot";
import { subscribeSwUpdate } from "@/lib/pwa-sw-update";

const CHECK_FAILED_DISMISS_KEY = "menorix:pwaVersionCheckWarnDismissed:v1";

function wasCheckFailedDismissed(): boolean {
  try {
    return sessionStorage.getItem(CHECK_FAILED_DISMISS_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * Non-blocking "New version available" banner — one policy check per tab boot.
 * Does not gate routes, sessions, or store selection.
 */
export function PwaSoftUpdateBanner() {
  const pathname = usePathname();
  const isScanner = pathname.startsWith("/scanner/operator-mobile");
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [checkFailed, setCheckFailed] = useState(false);
  const [checkFailedDismissed, setCheckFailedDismissed] = useState(wasCheckFailedDismissed);
  const [updating, setUpdating] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void runPwaVersionBootCheckOnce().then((state) => {
      if (cancelled) return;
      setUpdateAvailable(state.updateAvailable);
      setCheckFailed(state.checkFailed);
    });
    const unsub = subscribeSwUpdate(() => {
      if (cancelled) return;
      setUpdateAvailable(refreshPwaUpdateBannerAvailability());
    });
    return () => {
      cancelled = true;
      unsub();
    };
  }, []);

  const handleUpdate = useCallback(async () => {
    setUpdating(true);
    try {
      await performMenorixPwaUpdate();
    } finally {
      setUpdating(false);
    }
  }, []);

  const dismissCheckFailed = useCallback(() => {
    try {
      sessionStorage.setItem(CHECK_FAILED_DISMISS_KEY, "1");
    } catch {
      /* ignore */
    }
    setCheckFailedDismissed(true);
  }, []);

  if (updateAvailable) {
    const shellClass = isScanner
      ? "flex w-full max-w-[430px] items-center justify-between gap-3 rounded-t-xl border px-3 py-2.5 shadow-lg"
      : "mx-auto flex w-full max-w-3xl items-center justify-between gap-3 rounded-xl border border-border bg-card px-4 py-3 text-foreground shadow-lg";
    const wrapClass = isScanner
      ? "pointer-events-auto fixed inset-x-0 bottom-0 z-[600] flex justify-center px-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]"
      : "pointer-events-auto fixed inset-x-0 bottom-0 z-[600] px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-4";
    const buttonClass = isScanner
      ? "inline-flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-bold disabled:opacity-60"
      : "inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground disabled:opacity-60";

    return (
      <div className={wrapClass} role="region" aria-label="App update available">
        <div
          className={shellClass}
          style={
            isScanner
              ? {
                  borderColor: "var(--scanner-border, #323c48)",
                  background: "var(--scanner-header-gradient, #0a0e14)",
                  color: "var(--scanner-text, #faf6ed)",
                }
              : undefined
          }
        >
          <p className="min-w-0 text-sm font-semibold leading-snug">New version available</p>
          <button
            type="button"
            onClick={() => void handleUpdate()}
            disabled={updating}
            className={buttonClass}
            style={
              isScanner
                ? {
                    color: "var(--op-app-bg, #050607)",
                    background: "var(--op-accent-gold, #d6b76e)",
                  }
                : undefined
            }
          >
            <RefreshCw className={`h-3.5 w-3.5 shrink-0 ${updating ? "animate-spin" : ""}`} aria-hidden />
            {updating ? "Updating…" : "Update"}
          </button>
        </div>
      </div>
    );
  }

  if (checkFailed && !checkFailedDismissed) {
    return (
      <div
        className="pointer-events-auto fixed inset-x-0 bottom-0 z-[590] px-3 pb-[max(0.5rem,env(safe-area-inset-bottom))] sm:px-4"
        role="status"
        aria-live="polite"
      >
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-2 rounded-lg border border-amber-200/80 bg-amber-50/95 px-3 py-2 text-xs text-amber-950 dark:border-amber-800/60 dark:bg-amber-950/90 dark:text-amber-100">
          <span>Could not check for app updates. You can keep working.</span>
          <button
            type="button"
            onClick={dismissCheckFailed}
            className="inline-flex shrink-0 items-center rounded p-1 hover:bg-amber-100/80 dark:hover:bg-amber-900/50"
            aria-label="Dismiss update check notice"
          >
            <X className="h-3.5 w-3.5" aria-hidden />
          </button>
        </div>
      </div>
    );
  }

  return null;
}
