"use client";

import { usePathname, useRouter } from "next/navigation";
import { useLayoutEffect } from "react";
import { SCANNER_OPERATOR_HOME_PATH } from "@/lib/pwa-standalone";
import {
  hasOperatorMobileActiveSession,
  isColdAppEntryNavigation,
  markOperatorMobileActiveSession,
  shouldRedirectColdEntryToHome,
} from "@/lib/operator-mobile-session-route";

/**
 * Cold load (process killed) → operator home.
 * Warm resume (still in memory) → keep current URL via sessionStorage flag.
 */
export function OperatorMobileSessionRouteGuard() {
  const pathname = usePathname();
  const router = useRouter();

  useLayoutEffect(() => {
    const scanCode = new URLSearchParams(window.location.search).get("code");
    const hadSession = hasOperatorMobileActiveSession();

    if (
      !hadSession &&
      isColdAppEntryNavigation() &&
      shouldRedirectColdEntryToHome(pathname, scanCode)
    ) {
      router.replace(SCANNER_OPERATOR_HOME_PATH);
      return;
    }

    markOperatorMobileActiveSession();
  }, [pathname, router]);

  return null;
}
