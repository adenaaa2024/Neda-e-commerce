import type { ReactNode } from "react";
import { OperatorSessionStoreProvider } from "./_components/OperatorSessionStoreProvider";

/** Outside the “phone” frame — slightly different from app bg so the device shell reads clearly. */
const CANVAS_BG = "#030712";
/** Align with scan / review reference (#0B1218). */
const APP_BG = "#0B1218";
const SHELL_BORDER = "#1F2937";

/**
 * Centered 430px “native app” shell: LTR, full-height column, no horizontal padding on the shell itself
 * (pages use `px-4` on scrollable content). Bottom nav is anchored inside this column via page flex layout.
 */
export default function OperatorMobileLayout({ children }: { children: ReactNode }) {
  return (
    <div
      dir="ltr"
      lang="en"
      className="flex min-h-dvh w-full justify-center p-0 text-slate-100 antialiased"
      style={{ backgroundColor: CANVAS_BG }}
    >
      <div
        className="flex h-[100dvh] max-h-[100dvh] w-full max-w-[430px] flex-col overflow-hidden shadow-[0_0_0_1px_rgba(31,41,55,0.9),0_28px_64px_-12px_rgba(0,0,0,0.72)] ring-1 ring-black/40"
        style={{
          backgroundColor: APP_BG,
          borderLeft: `1px solid ${SHELL_BORDER}`,
          borderRight: `1px solid ${SHELL_BORDER}`,
        }}
      >
        <OperatorSessionStoreProvider>
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">{children}</div>
        </OperatorSessionStoreProvider>
      </div>
    </div>
  );
}
