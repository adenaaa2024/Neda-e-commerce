"use client";

import type { ReactNode } from "react";
import { useCallback, useLayoutEffect, useState } from "react";
import { MenorixIntroSplash } from "@/components/MenorixIntroSplash";
import { shouldPlayOperatorMobileEntryIntro } from "@/lib/operator-mobile-intro";

export { markOperatorMobileSkipIntroOnce } from "@/lib/operator-mobile-intro";

/**
 * Entry splash (~2.8s) when opening the scanner app or returning after a full reload.
 * Skipped during in-app use: soft refresh, pull-to-refresh, back/forward, route changes inside layout.
 */
export function OperatorMobileIntroShell({ children }: { children: ReactNode }) {
  const [skipIntro, setSkipIntro] = useState(false);

  useLayoutEffect(() => {
    setSkipIntro(!shouldPlayOperatorMobileEntryIntro());
  }, []);

  const markIntroFinished = useCallback(() => {
    setSkipIntro(true);
  }, []);

  if (skipIntro) {
    return <>{children}</>;
  }

  return (
    <MenorixIntroSplash durationMs={2800} variant="scanner" skippable onFinished={markIntroFinished}>
      {children}
    </MenorixIntroSplash>
  );
}
