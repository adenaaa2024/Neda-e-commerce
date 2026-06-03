"use client";

import { useEffect } from "react";
import { initPwaInstallPromptCapture } from "@/lib/pwa-install-prompt";

/**
 * Registers `/sw.js` so Chrome/Edge treat install as a real PWA (standalone),
 * not merely a bookmark shortcut.
 */
export function PwaServiceWorkerRegister() {
  useEffect(() => {
    initPwaInstallPromptCapture();

    if (typeof window === "undefined" || !("serviceWorker" in navigator)) return;

    void navigator.serviceWorker
      .register("/sw.js", { scope: "/", updateViaCache: "none" })
      .catch(() => {
        /* non-fatal — install hint falls back to browser menu */
      });
  }, []);

  return null;
}
