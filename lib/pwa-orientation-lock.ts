/** Portrait-primary lock for Menorix operator-mobile — scoped to mobile scanner runtimes only. */

import { isMobileUserAgent, isZebraDevice } from "./pwa-device-support";
import { isDesktopBrowser, isStandalonePwa } from "./pwa-runtime-detection";

export const OPERATOR_ORIENTATION_LOCK = "portrait-primary" as const;

type OrientationLockType = typeof OPERATOR_ORIENTATION_LOCK;

type ScreenWithLegacyLock = Screen & {
  orientation?: ScreenOrientation & {
    lock?: (orientation: OrientationLockType) => Promise<void>;
    unlock?: () => void;
  };
  lockOrientation?: (orientation: string) => boolean;
  mozLockOrientation?: (orientation: string) => boolean;
  msLockOrientation?: (orientation: string) => boolean;
  unlockOrientation?: () => void;
  mozUnlockOrientation?: () => void;
  msUnlockOrientation?: () => void;
};

/**
 * Portrait lock targets only operator-mobile scanner runtimes — never desktop/laptop browsers.
 * Zebra / Android phones / Android PWA / iPhone PWA.
 */
export function isOperatorMobileOrientationLockTarget(): boolean {
  if (typeof navigator === "undefined") return false;
  if (isDesktopBrowser()) return false;

  const ua = navigator.userAgent;
  if (isZebraDevice()) return true;
  if (/Android/i.test(ua) && isMobileUserAgent()) return true;
  if (isStandalonePwa() && /iPhone|iPod/i.test(ua)) return true;

  return false;
}

function tryLegacyOrientationLock(screenObj: ScreenWithLegacyLock): void {
  const lock =
    screenObj.lockOrientation ?? screenObj.mozLockOrientation ?? screenObj.msLockOrientation;
  if (!lock) return;
  try {
    lock.call(screenObj, OPERATOR_ORIENTATION_LOCK);
  } catch {
    try {
      lock.call(screenObj, "portrait");
    } catch {
      /* non-fatal — Zebra / older WebViews may ignore */
    }
  }
}

function tryLegacyOrientationUnlock(screenObj: ScreenWithLegacyLock): void {
  const unlock =
    screenObj.unlockOrientation ?? screenObj.mozUnlockOrientation ?? screenObj.msUnlockOrientation;
  if (!unlock) return;
  try {
    unlock.call(screenObj);
  } catch {
    /* non-fatal */
  }
}

/** No-op on desktop/laptop — only locks on operator-mobile scanner device targets. */
export function lockOperatorPortraitOrientation(): void {
  if (typeof window === "undefined") return;
  if (!isOperatorMobileOrientationLockTarget()) return;
  try {
    const screenObj = window.screen as ScreenWithLegacyLock;
    const orientation = screenObj.orientation;
    if (orientation?.lock) {
      void orientation.lock(OPERATOR_ORIENTATION_LOCK).catch(() => {
        tryLegacyOrientationLock(screenObj);
      });
      return;
    }
    tryLegacyOrientationLock(screenObj);
  } catch {
    /* non-fatal */
  }
}

export function unlockOperatorPortraitOrientation(): void {
  if (typeof window === "undefined") return;
  try {
    const screenObj = window.screen as ScreenWithLegacyLock;
    screenObj.orientation?.unlock?.();
    tryLegacyOrientationUnlock(screenObj);
  } catch {
    /* non-fatal */
  }
}

export const OPERATOR_ORIENTATION_RELOCK_EVENTS = [
  "orientationchange",
  "resize",
  "visibilitychange",
  "pageshow",
  "focus",
] as const;
