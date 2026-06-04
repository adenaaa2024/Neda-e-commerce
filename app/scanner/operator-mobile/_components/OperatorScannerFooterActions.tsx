"use client";

import type { ReactNode } from "react";

type OperatorScannerFooterActionsProps = {
  primary: ReactNode;
  secondary: ReactNode;
  className?: string;
};

/** LTR: secondary (cancel/stay) left, primary (save/confirm) right — one row on handheld. */
export function OperatorScannerFooterActions({
  primary,
  secondary,
  className = "",
}: OperatorScannerFooterActionsProps) {
  return (
    <div className={`operator-scanner-footer-actions ${className}`.trim()}>
      <div className="operator-scanner-footer-actions__secondary">{secondary}</div>
      <div className="operator-scanner-footer-actions__primary">{primary}</div>
    </div>
  );
}
