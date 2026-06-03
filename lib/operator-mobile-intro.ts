const SKIP_INTRO_ONCE_KEY = "operatorMobile:skipIntroOnce";

/** Set before soft refresh so the entry splash does not replay. */
export function markOperatorMobileSkipIntroOnce(): void {
  try {
    sessionStorage.setItem(SKIP_INTRO_ONCE_KEY, "1");
  } catch {
    /* ignore */
  }
}

function consumeSkipIntroOnce(): boolean {
  try {
    if (sessionStorage.getItem(SKIP_INTRO_ONCE_KEY) !== "1") return false;
    sessionStorage.removeItem(SKIP_INTRO_ONCE_KEY);
    return true;
  } catch {
    return false;
  }
}

/**
 * Play scanner intro only on true app entry loads (cold open / return with reload),
 * not on in-app reload, back/forward, or header Refresh.
 */
export function shouldPlayOperatorMobileEntryIntro(): boolean {
  if (typeof window === "undefined") return false;
  if (consumeSkipIntroOnce()) return false;

  try {
    const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
    if (!nav) return true;
    return nav.type === "navigate";
  } catch {
    return true;
  }
}
