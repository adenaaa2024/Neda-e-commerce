import type { ClaimCandidateIntakePolicy } from "@/lib/claim-candidate-intake-policy";
import type { buildClaimCandidateIntakeResolutionSteps } from "@/lib/claim-candidate-intake-policy-resolution";
import type { ClaimIntakeSettings } from "@/lib/claims/intake/claim-intake-types";
import type { ClaimPoolGenerationSchedule } from "@/lib/platform-automation-settings-types";

export type ClaimCandidateIntakePolicyScope = "platform" | "company" | "store";

export type ClaimCandidateIntakePolicyBundle = {
  organization_id: string;
  store_id: string;
  platform: {
    candidate_intake: ClaimCandidateIntakePolicy;
    intake: ClaimIntakeSettings;
    candidate_intake_configured: boolean;
    intake_configured: boolean;
  };
  company: {
    candidate_intake: ClaimCandidateIntakePolicy;
    intake: ClaimIntakeSettings;
    allow_manual_override: boolean;
    candidate_intake_configured: boolean;
    intake_configured: boolean;
  };
  store: {
    candidate_intake: ClaimCandidateIntakePolicy | null;
    claim_pool: ClaimPoolGenerationSchedule;
    candidate_intake_configured: boolean;
  };
  effective: {
    candidate_intake: ClaimCandidateIntakePolicy;
    intake: ClaimIntakeSettings;
  };
  resolution_steps: ReturnType<typeof buildClaimCandidateIntakeResolutionSteps>;
};
