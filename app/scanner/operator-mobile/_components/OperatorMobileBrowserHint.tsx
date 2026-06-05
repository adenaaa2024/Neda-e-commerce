"use client";

import { useEffect, useState } from "react";
import { Info, X } from "lucide-react";
import { isDesktopBrowser } from "@/lib/pwa-runtime-detection";

const DISMISS_KEY = "operatorMobile:desktopBrowserHintDismissed";

/**
 * Non-blocking note for desktop/laptop browser — scanner works; PWA is optional.
 */
export function OperatorMobileBrowserHint() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!isDesktopBrowser()) {
      setVisible(false);
      return;
    }
    try {
      setVisible(localStorage.getItem(DISMISS_KEY) !== "1");
    } catch {
      setVisible(true);
    }
  }, []);

  if (!visible) return null;

  return (
    <div
      className="shrink-0 border-b px-3 py-2 sm:px-4"
      style={{
        borderColor: "var(--scanner-border, #323c48)",
        background: "var(--scanner-header-gradient)",
      }}
      role="note"
      aria-label="Desktop browser scanner note"
    >
      <div className="flex items-start gap-2">
        <Info
          className="mt-0.5 h-3.5 w-3.5 shrink-0"
          style={{ color: "var(--op-accent-gold, #d6b76e)" }}
          aria-hidden
        />
        <p className="min-w-0 flex-1 text-[11px] leading-snug" style={{ color: "var(--op-text-secondary, #b9c2cc)" }}>
          Mobile scanner is optimized for the installed Menorix app. You can continue here in your browser.
        </p>
        <button
          type="button"
          onClick={() => {
            try {
              localStorage.setItem(DISMISS_KEY, "1");
            } catch {
              /* ignore */
            }
            setVisible(false);
          }}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md transition hover:bg-black/[0.06] dark:hover:bg-white/[0.06]"
          aria-label="Dismiss note"
        >
          <X className="h-3.5 w-3.5" style={{ color: "var(--scanner-text)" }} aria-hidden />
        </button>
      </div>
    </div>
  );
}
