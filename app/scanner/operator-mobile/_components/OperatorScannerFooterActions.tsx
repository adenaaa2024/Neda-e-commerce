"use client";

import type { ReactNode } from "react";

type OperatorScannerFooterActionsProps = {
  primary: ReactNode;
  secondary: ReactNode;
  className?: string;
};

/**
 * Zebra/narrow: primary action stacks on top; secondary below.
 * Wider (≥480px): secondary left, primary right (legacy grid).
 */
export function OperatorScannerFooterActions({
  primary,
  secondary,
  className = "",
}: OperatorScannerFooterActionsProps) {
  return (
    <div
      className={`operator-scanner-footer-actions flex flex-col gap-3 min-[480px]:grid min-[480px]:grid-cols-2 ${className}`.trim()}
    >
      <div className="operator-scanner-footer-actions__primary order-1 min-[480px]:order-2">{primary}</div>
      <div className="operator-scanner-footer-actions__secondary order-2 min-[480px]:order-1">{secondary}</div>
    </div>
  );
}
