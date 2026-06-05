"use client";

import { useEffect } from "react";
import { isOperatorMobileOrientationLockTarget } from "@/lib/pwa-orientation-lock";
import {
  lockOperatorPortraitOrientation,
  OPERATOR_ORIENTATION_RELOCK_EVENTS,
  unlockOperatorPortraitOrientation,
} from "@/lib/pwa-orientation-lock";

/**
 * Portrait-primary lock for operator-mobile scanner runtimes only.
 * Desktop/laptop browsers: no-op — normal ERP layout is unchanged.
 */
export function OperatorOrientationLock() {
  useEffect(() => {
    if (!isOperatorMobileOrientationLockTarget()) return;

    const relock = () => {
      lockOperatorPortraitOrientation();
    };

    relock();

    for (const eventName of OPERATOR_ORIENTATION_RELOCK_EVENTS) {
      window.addEventListener(eventName, relock);
    }

    const orientation = window.screen?.orientation;
    orientation?.addEventListener?.("change", relock);

    // Some installed PWAs / Zebra WebViews only allow lock after a user gesture.
    window.addEventListener("pointerdown", relock, { once: true, passive: true });
    window.addEventListener("touchstart", relock, { once: true, passive: true });

    return () => {
      for (const eventName of OPERATOR_ORIENTATION_RELOCK_EVENTS) {
        window.removeEventListener(eventName, relock);
      }
      orientation?.removeEventListener?.("change", relock);
      unlockOperatorPortraitOrientation();
    };
  }, []);

  return null;
}
