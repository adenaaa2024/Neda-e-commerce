"use client";

import { useEffect } from "react";
import {
  logScannerFocusEvent,
  logScannerVisibilityEvent,
} from "@/lib/scanner/scanner-focus-instrumentation";

/**
 * Dev-only: log focus/visibility/pageshow/online events for scanner route debugging.
 */
export function OperatorMobileFocusInstrumentation() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "development") return;

    const onFocus = () => {
      logScannerFocusEvent("window_focus");
    };
    const onVisibility = () => {
      logScannerVisibilityEvent(document.visibilityState);
    };
    const onPageShow = (event: PageTransitionEvent) => {
      logScannerFocusEvent("pageshow", { persisted: event.persisted });
    };
    const onOnline = () => {
      logScannerFocusEvent("online");
    };
    const onOffline = () => {
      logScannerFocusEvent("offline");
    };

    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pageshow", onPageShow);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);

    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pageshow", onPageShow);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }, []);

  return null;
}
