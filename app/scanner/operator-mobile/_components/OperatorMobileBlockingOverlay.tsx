"use client";

import type { ReactNode } from "react";

type OperatorMobileBlockingOverlayProps = {
  title: string;
  message: ReactNode;
  ariaLabel: string;
  children?: ReactNode;
};

/** Full-screen blocking gate — no close button, no bypass affordance. */
export function OperatorMobileBlockingOverlay({
  title,
  message,
  ariaLabel,
  children,
}: OperatorMobileBlockingOverlayProps) {
  return (
    <div
      className="fixed inset-0 z-[500] flex items-center justify-center bg-black/90 p-6"
      role="dialog"
      aria-modal="true"
      aria-label={ariaLabel}
    >
      <div
        className="w-full max-w-sm rounded-[24px] border p-6 text-center"
        style={{
          borderColor: "var(--op-accent-gold, #d6b76e)",
          background: "var(--scanner-bg, #0a0e14)",
        }}
      >
        <p
          className="text-[18px] font-black leading-snug"
          style={{ color: "var(--op-accent-gold, #d6b76e)" }}
        >
          {title}
        </p>
        <div
          className="mt-3 text-[13px] font-semibold leading-relaxed"
          style={{ color: "var(--op-text-secondary, #b9c2cc)" }}
        >
          {message}
        </div>
        {children ? <div className="mt-5 space-y-3">{children}</div> : null}
      </div>
    </div>
  );
}
