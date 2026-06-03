"use client";

import type { ReactNode } from "react";
import { MenorixIntroSplash } from "@/components/MenorixIntroSplash";

/** First-open splash for operator-mobile only (~2.5s, tap to skip). */
export function OperatorMobileIntroShell({ children }: { children: ReactNode }) {
  return (
    <MenorixIntroSplash durationMs={2800} variant="scanner" skippable>
      {children}
    </MenorixIntroSplash>
  );
}
