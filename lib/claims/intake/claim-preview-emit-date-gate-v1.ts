/**
 * @deprecated Import from @/lib/claims/effective-date/claim-effective-date-gate-v1
 * Retained for emit pilot backward compatibility.
 */
export {
  EFFECTIVE_DATE_GATE_VERSION as EMIT_DATE_GATE_VERSION,
  type EffectiveDateSourceField,
  type EffectiveDateGateSkipReason as EmitDateGateSkipReason,
  resolveEffectiveDateForSource,
  evaluateClaimEffectiveDateGate as evaluateClaimPreviewEmitDateGate,
  type EffectiveDateGateEvaluation as EmitDateGateEvaluation,
  effectiveDateGateMetadata as emitDateGateMetadata,
} from "@/lib/claims/effective-date/claim-effective-date-gate-v1";
