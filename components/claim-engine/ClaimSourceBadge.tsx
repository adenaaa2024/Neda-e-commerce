import {
  CLAIM_SOURCE_BADGE_CLASS,
  CLAIM_SOURCE_LABEL,
  resolveClaimSourceKind,
} from "@/lib/claim-source-display";
import type { ClaimIntakeSourceKind } from "@/lib/claim-intake-sources";

export function ClaimSourceBadge({
  source_table,
  claim_source,
  kind,
  className = "",
}: {
  source_table?: string | null;
  claim_source?: string | null;
  kind?: ClaimIntakeSourceKind;
  className?: string;
}) {
  const resolved = kind ?? resolveClaimSourceKind({ source_table, claim_source });
  return (
    <span
      className={`inline-flex ${CLAIM_SOURCE_BADGE_CLASS[resolved]} ${className}`}
    >
      {CLAIM_SOURCE_LABEL[resolved]}
    </span>
  );
}
