"use client";

import type { ReactNode } from "react";
import { useCallback, useEffect, useState } from "react";
import { MenorixIntroSplash } from "@/components/MenorixIntroSplash";

const INTRO_PLAYED_KEY = "operatorMobile:introPlayed";

function introAlreadyPlayed(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return sessionStorage.getItem(INTRO_PLAYED_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * Operator-mobile splash — once per browser session (cold PWA/tab open).
 * In-session refresh must not replay the intro.
 */
export function OperatorMobileIntroShell({ children }: { children: ReactNode }) {
  const [introState, setIntroState] = useState<"pending" | "show" | "skip">("pending");

  useEffect(() => {
    setIntroState(introAlreadyPlayed() ? "skip" : "show");
  }, []);

  const markIntroPlayed = useCallback(() => {
    try {
      sessionStorage.setItem(INTRO_PLAYED_KEY, "1");
    } catch {
      /* ignore */
    }
    setIntroState("skip");
  }, []);

  if (introState === "pending") {
    return (
      <div
        className="min-h-dvh w-full"
        style={{ backgroundColor: "var(--op-app-bg, #050607)" }}
        aria-hidden
      />
    );
  }

  if (introState === "skip") {
    return <>{children}</>;
  }

  return (
    <MenorixIntroSplash durationMs={2800} variant="scanner" skippable onFinished={markIntroPlayed}>
      {children}
    </MenorixIntroSplash>
  );
}
