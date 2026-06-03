"use client";

import { useEffect } from "react";
import { initPwaInstallPromptCapture } from "@/lib/pwa-install-prompt";
import { setSwUpdateAvailable } from "@/lib/pwa-sw-update";

function watchRegistration(registration: ServiceWorkerRegistration) {
  const flagUpdate = () => {
    if (registration.waiting && navigator.serviceWorker.controller) {
      setSwUpdateAvailable(true);
    }
  };

  flagUpdate();

  registration.addEventListener("updatefound", () => {
    const installing = registration.installing;
    if (!installing) return;
    installing.addEventListener("statechange", () => {
      if (installing.state === "installed") flagUpdate();
    });
  });
}

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
      .then((registration) => {
        watchRegistration(registration);
        registration.update().catch(() => {
          /* non-fatal */
        });
      })
      .catch(() => {
        /* non-fatal — install hint falls back to browser menu */
      });
  }, []);

  return null;
}
