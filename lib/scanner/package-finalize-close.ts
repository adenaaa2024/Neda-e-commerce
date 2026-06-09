/** Phase 6B — server finalize package receive (shortage + empty box). */

export type FinalizePackageReceiveCloseRpcResult = {
  ok: boolean;
  error?: string;
  schema_approval_required?: boolean;
  package_id?: string;
  status?: string;
  shortage_lines_created?: number;
  shortage_lines_touched?: number;
  empty_box_case_id?: string | null;
  empty_box_evidence_count?: number;
  claim_cases_available?: boolean;
  claim_evidence_available?: boolean;
};

export function packageFinalizeEmptyBoxHeuristic(args: {
  expectedUnits: number;
  scannedUnits: number;
}): boolean {
  const expected = Math.max(0, Math.floor(Number(args.expectedUnits) || 0));
  const scanned = Math.max(0, Math.floor(Number(args.scannedUnits) || 0));
  return expected > 0 && scanned === 0;
}

export function buildPackageFinalizeDiscrepancyNote(expected: number, scanned: number): string {
  return `System Auto-Note: Discrepancy found (Expected ${expected}, Scanned ${scanned})`;
}
