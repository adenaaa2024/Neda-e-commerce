"use client";

import { claimCenterBadgeTone } from "@/components/claim-center/claim-center-ui";
import type { FeeLabel } from "@/lib/claims/submission/claim-money-lane-preview-v2-profit-loss-v1";
import {
  feeLabelDisplay,
  feeLabelBadgeTone,
} from "@/lib/claims/submission/claim-money-lane-profit-loss-ui-contract";

type Props = {
  label: FeeLabel;
  className?: string;
};

export function MoneyLaneLabelBadge({ label, className = "" }: Props) {
  return (
    <span className={`${claimCenterBadgeTone(feeLabelBadgeTone(label))} ${className}`}>
      {feeLabelDisplay(label)}
    </span>
  );
}

export function MoneyLaneStatusBadge({
  kind,
  className = "",
}: {
  kind: "needs_cogs" | "no_reimb_match" | "informational";
  className?: string;
}) {
  const map = {
    needs_cogs: { tone: "warning" as const, text: "COGS missing" },
    no_reimb_match: { tone: "neutral" as const, text: "Not filed / no safe match" },
    informational: { tone: "info" as const, text: "Informational estimate" },
  };
  const item = map[kind];
  return (
    <span className={`${claimCenterBadgeTone(item.tone)} ${className}`}>{item.text}</span>
  );
}

export function MoneyLaneUnknownBadge({ className = "" }: { className?: string }) {
  return (
    <span
      className={`${claimCenterBadgeTone("warning")} ${className}`}
      title="Unknown values are not treated as zero."
    >
      Unknown
    </span>
  );
}
