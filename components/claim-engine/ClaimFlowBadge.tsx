import {
  CLAIM_FLOW_STAGE_BADGE_CLASS,
  CLAIM_FLOW_STAGE_LABELS,
  claimFlowStageHint,
  type ClaimFlowStage,
} from "@/lib/claim-flow-status-badges";

export function ClaimFlowBadge({
  stage,
  showHint = true,
  className = "",
}: {
  stage: ClaimFlowStage;
  showHint?: boolean;
  className?: string;
}) {
  const hint = showHint ? claimFlowStageHint(stage) : undefined;
  return (
    <span
      title={hint}
      className={`inline-flex ${CLAIM_FLOW_STAGE_BADGE_CLASS[stage]} ${className}`}
    >
      {CLAIM_FLOW_STAGE_LABELS[stage]}
    </span>
  );
}
