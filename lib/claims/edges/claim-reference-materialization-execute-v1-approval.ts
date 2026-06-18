/**
 * PHASE-CLAIM-REFERENCE-MATERIALIZATION-EXECUTE-V1 — approval gate.
 *
 * Governed write of deterministic claim_reference_edges for the 10 pilot submissions.
 * Requires Maysam approval token in the operator-approval markdown file.
 * Read-only here: parses the token only; never sets it.
 */
export const REFERENCE_MATERIALIZATION_EXECUTE_V1_APPROVAL_TOKEN =
  "APPROVED_CLAIM_REFERENCE_MATERIALIZATION_WRITE_V1" as const;

export const REFERENCE_MATERIALIZATION_EXECUTE_V1_APPROVAL_PATH =
  ".cursor/operator-approvals/claim-reference-materialization-execute-v1-approval.md" as const;

export const REFERENCE_MATERIALIZATION_EXECUTE_V1_ORIGIN =
  "pilot_reference_edge_materialization_v1" as const;

export type ReferenceMaterializationExecuteApproval = {
  approved: boolean;
  token: typeof REFERENCE_MATERIALIZATION_EXECUTE_V1_APPROVAL_TOKEN;
  raw: "yes" | "no_or_missing";
  file_present: boolean;
};

/**
 * Parses the V1 materialization write approval token from a markdown approval file.
 * Accepts `=yes` or `=true` (case-insensitive, whole-line) to flip approval on.
 */
export function readReferenceMaterializationExecuteApproval(
  raw: string,
  filePresent: boolean,
): ReferenceMaterializationExecuteApproval {
  const approved =
    /^APPROVED_CLAIM_REFERENCE_MATERIALIZATION_WRITE_V1\s*=\s*(yes|true)\s*$/im.test(raw);
  return {
    approved,
    token: REFERENCE_MATERIALIZATION_EXECUTE_V1_APPROVAL_TOKEN,
    raw: approved ? "yes" : "no_or_missing",
    file_present: filePresent,
  };
}
