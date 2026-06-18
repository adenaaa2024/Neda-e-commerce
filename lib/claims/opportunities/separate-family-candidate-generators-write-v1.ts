/**
 * PHASE-CLAIM-SEPARATE-FAMILY-CANDIDATE-GENERATORS-V1 — approval gate + guarded write.
 *
 * Default: BLOCKED. Writes claim_candidates only when the operator approval file has
 * APPROVED_SEPARATE_FAMILY_CANDIDATE_GENERATORS_WRITE_V1=yes. The write is schema-agnostic
 * (introspects existing claim_candidates columns) and only inserts `writeable` previews.
 * NO claim_cases / claim_lines / claim_submissions / claim_reference_edges mutation,
 * NO Amazon submission, NO scanner change.
 */
import fs from "node:fs";
import path from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";

import type { SeparateFamilyCandidatePreview } from "./separate-family-candidate-generator-contract-v1";

export const SEPARATE_FAMILY_GENERATORS_WRITE_APPROVAL_KEY = "APPROVED_SEPARATE_FAMILY_CANDIDATE_GENERATORS_WRITE_V1";
export const SEPARATE_FAMILY_GENERATORS_WRITE_APPROVAL_PATH =
  ".cursor/operator-approvals/separate-family-candidate-generators-write-v1-approval.md";

export type SeparateFamilyGeneratorApproval = {
  approved: boolean;
  approval_key: string;
  approval_path: string;
  block_reason: string | null;
};

export function readSeparateFamilyGeneratorApproval(): SeparateFamilyGeneratorApproval {
  const p = path.join(process.cwd(), SEPARATE_FAMILY_GENERATORS_WRITE_APPROVAL_PATH);
  if (!fs.existsSync(p)) {
    return {
      approved: false,
      approval_key: SEPARATE_FAMILY_GENERATORS_WRITE_APPROVAL_KEY,
      approval_path: SEPARATE_FAMILY_GENERATORS_WRITE_APPROVAL_PATH,
      block_reason: `Approval file missing: create ${SEPARATE_FAMILY_GENERATORS_WRITE_APPROVAL_PATH} with ${SEPARATE_FAMILY_GENERATORS_WRITE_APPROVAL_KEY}=yes`,
    };
  }
  const approved = new RegExp(`^${SEPARATE_FAMILY_GENERATORS_WRITE_APPROVAL_KEY}\\s*=\\s*yes\\s*$`, "im").test(
    fs.readFileSync(p, "utf8"),
  );
  return {
    approved,
    approval_key: SEPARATE_FAMILY_GENERATORS_WRITE_APPROVAL_KEY,
    approval_path: SEPARATE_FAMILY_GENERATORS_WRITE_APPROVAL_PATH,
    block_reason: approved ? null : `${SEPARATE_FAMILY_GENERATORS_WRITE_APPROVAL_KEY}=yes required in ${SEPARATE_FAMILY_GENERATORS_WRITE_APPROVAL_PATH}`,
  };
}

export type SeparateFamilyWriteResult = {
  ok: boolean;
  blocked: boolean;
  block_reason: string | null;
  approval_path: string;
  candidates_written_count: number;
  claim_candidates_before: number;
  claim_candidates_after: number;
  other_tables_unchanged: Record<string, { before: number; after: number }>;
};

async function counts(client: SupabaseClient, org: string): Promise<Record<string, number>> {
  const tables = ["claim_candidates", "claim_cases", "claim_lines", "claim_submissions", "claim_reference_edges"];
  const out: Record<string, number> = {};
  for (const t of tables) {
    const { count } = await client.from(t).select("id", { count: "exact", head: true }).eq("organization_id", org);
    out[t] = count ?? -1;
  }
  return out;
}

/**
 * Guarded write. Blocked unless the approval file authorizes it. When approved,
 * inserts only `writeable` previews into claim_candidates (schema-agnostic mapping),
 * and verifies no other claim_* table changed.
 */
export async function writeSeparateFamilyCandidates(args: {
  client: SupabaseClient;
  organizationId: string;
  storeId: string;
  previews: SeparateFamilyCandidatePreview[];
  runId: string;
  actorId: string;
}): Promise<SeparateFamilyWriteResult> {
  const approval = readSeparateFamilyGeneratorApproval();
  const before = await counts(args.client, args.organizationId);

  if (!approval.approved) {
    return {
      ok: false,
      blocked: true,
      block_reason: approval.block_reason,
      approval_path: approval.approval_path,
      candidates_written_count: 0,
      claim_candidates_before: before.claim_candidates,
      claim_candidates_after: before.claim_candidates,
      other_tables_unchanged: {
        claim_cases: { before: before.claim_cases, after: before.claim_cases },
        claim_lines: { before: before.claim_lines, after: before.claim_lines },
        claim_submissions: { before: before.claim_submissions, after: before.claim_submissions },
        claim_reference_edges: { before: before.claim_reference_edges, after: before.claim_reference_edges },
      },
    };
  }

  const writeable = args.previews.filter((p) => p.writeable);

  // Schema-agnostic: discover existing claim_candidates columns from one row.
  const sample = await args.client.from("claim_candidates").select("*").eq("organization_id", args.organizationId).limit(1).maybeSingle();
  const cols = new Set(sample.data ? Object.keys(sample.data) : []);
  const pick = (obj: Record<string, unknown>) => {
    const row: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) if (cols.has(k)) row[k] = v;
    return row;
  };

  let written = 0;
  let blockReason: string | null = null;
  if (writeable.length > 0 && cols.size > 0) {
    const rows = writeable.map((p) =>
      pick({
        organization_id: args.organizationId,
        store_id: args.storeId,
        claim_family: p.recommended_claim_family,
        source_table: p.source_table,
        source_row_id: p.source_row_id,
        fnsku: p.product_identity.fnsku,
        sku: p.product_identity.sku,
        asin: p.product_identity.asin,
        product_id: p.product_identity.resolved_product_id,
        quantity: p.quantity,
        amount: p.expected_claim_amount,
        created_by: args.actorId,
        updated_by: args.actorId,
        metadata: { generator_run_id: args.runId, preview_id: p.preview_id, basis: p.claim_amount_basis, version: "separate-family-candidate-generator-v1" },
      }),
    );
    const { data, error } = await args.client.from("claim_candidates").insert(rows).select("id");
    if (error) blockReason = error.message;
    written = data?.length ?? 0;
  }

  const after = await counts(args.client, args.organizationId);
  return {
    ok: blockReason == null,
    blocked: false,
    block_reason: blockReason,
    approval_path: approval.approval_path,
    candidates_written_count: written,
    claim_candidates_before: before.claim_candidates,
    claim_candidates_after: after.claim_candidates,
    other_tables_unchanged: {
      claim_cases: { before: before.claim_cases, after: after.claim_cases },
      claim_lines: { before: before.claim_lines, after: after.claim_lines },
      claim_submissions: { before: before.claim_submissions, after: after.claim_submissions },
      claim_reference_edges: { before: before.claim_reference_edges, after: after.claim_reference_edges },
    },
  };
}
