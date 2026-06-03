import type { ReactNode } from "react";
import { Oswald } from "next/font/google";
import { OperatorSessionStoreProvider } from "./_components/OperatorSessionStoreProvider";
import { OperatorProductBrandingStrip } from "./_components/OperatorProductBrandingStrip";
import { OperatorPwaInstallHint } from "./_components/OperatorPwaInstallHint";
import { OperatorUtilityRow } from "./_components/OperatorUtilityRow";

import { OperatorMobileIntroShell } from "./_components/OperatorMobileIntroShell";

const operatorDisplay = Oswald({
  variable: "--font-operator-display",
  subsets: ["latin"],
  display: "swap",
  weight: ["500", "600", "700"],
});

/**
 * Centered 430px “native app” shell: LTR, full-height column, no horizontal padding on the shell itself
 * (pages use `px-4` on scrollable content). Bottom nav is anchored inside this column via page flex layout.
 *
 * Header stack (top → down):
 *   1. Slim Utility Row (Refresh + Theme toggle, top-right) — 24px tall.
 *   2. Brand Header Row (squircle logo + company name | store name) — 48px tall.
 *   3. {children} — page content (scan page injects a sticky 3-box status dashboard at top).
 */
export default function OperatorMobileLayout({ children }: { children: ReactNode }) {
  return (
    <OperatorMobileIntroShell>
    <div
      dir="ltr"
      lang="en"
      className="operator-mobile-canvas flex min-h-dvh w-full justify-center p-0 antialiased"
      style={{
        backgroundColor: "var(--op-canvas-bg, #050607)",
        color: "var(--scanner-text, #faf6ed)",
      }}
    >
      <div
        className={`${operatorDisplay.variable} operator-mobile-app-shell flex h-[100dvh] max-h-[100dvh] w-full max-w-[430px] flex-col overflow-hidden shadow-[0_0_0_1px_rgba(31,41,55,0.35),0_28px_64px_-12px_rgba(0,0,0,0.55)] ring-1 ring-black/25 dark:shadow-[0_0_0_1px_rgba(31,41,55,0.9),0_28px_64px_-12px_rgba(0,0,0,0.72)] dark:ring-black/40`}
        style={{
          background: "var(--op-app-bg, #050607)",
          borderLeft: "1px solid var(--scanner-border, #323c48)",
          borderRight: "1px solid var(--scanner-border, #323c48)",
        }}
      >
        <OperatorSessionStoreProvider>
          <div
            className="shrink-0 border-b px-3 sm:px-4 pb-1 pt-[max(0.15rem,env(safe-area-inset-top))]"
            style={{
              borderColor: "var(--scanner-border, #323c48)",
              background: "var(--scanner-header-gradient)",
            }}
          >
            <OperatorUtilityRow />
          </div>
          <div
            className="shrink-0 border-b px-3 sm:px-4 py-1.5"
            style={{
              borderColor: "var(--scanner-border, #323c48)",
              background: "var(--scanner-header-gradient)",
            }}
          >
            <OperatorProductBrandingStrip className="w-full" />
          </div>
          <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-visible">{children}</div>
          <OperatorPwaInstallHint />
        </OperatorSessionStoreProvider>
      </div>
    </div>
    </OperatorMobileIntroShell>
  );
}
