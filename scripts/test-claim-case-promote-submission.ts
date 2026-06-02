/**
 * Dry-run / optional apply: promote claim_case → claim_submission (+ PDF).
 *
 *   npx tsx scripts/test-claim-case-promote-submission.ts --case-id=<uuid>
 *   npx tsx scripts/test-claim-case-promote-submission.ts --case-id=<uuid> --apply
 *   npx tsx scripts/test-claim-case-promote-submission.ts --case-id=<uuid> --apply --no-pdf
 */
import type { Module } from "node:module";
import { createClient } from "@supabase/supabase-js";

import { loadEnvLocalIntoProcess, getStagingProjectRef } from "../lib/staging-project-ref";
import { isUuidString } from "../lib/uuid";

require.cache[require.resolve("server-only")] = { exports: {} } as Module;

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const DEFAULT_ORG = "00000000-0000-0000-0000-000000000001";

function arg(name: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=")[1]!.trim() : "";
}

async function main(): Promise<void> {
  const caseId = arg("case-id");
  const orgId = arg("org") || DEFAULT_ORG;
  const apply = process.argv.includes("--apply");
  const noPdf = process.argv.includes("--no-pdf");

  if (!isUuidString(caseId)) {
    console.error("Usage: --case-id=<claim_cases.uuid> [--org=<org>] [--apply] [--no-pdf]");
    process.exit(1);
  }

  loadEnvLocalIntoProcess();
  if (getStagingProjectRef({ loadEnv: false }) !== STAGING_REF) {
    console.error(`Ref guard: expected ${STAGING_REF}`);
    process.exit(1);
  }

  const url = process.env.STAGING_SUPABASE_URL?.trim() || process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() || "";
  const key =
    process.env.STAGING_SERVICE_ROLE_KEY?.trim() || process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() || "";
  if (!url || !key) {
    console.error("Missing STAGING_SUPABASE_URL / STAGING_SERVICE_ROLE_KEY");
    process.exit(1);
  }

  const sb = createClient(url, key, { auth: { persistSession: false } });

  const { data: claimCase, error: caseErr } = await sb
    .from("claim_cases")
    .select("id, organization_id, status, primary_return_item_id, metadata")
    .eq("id", caseId)
    .eq("organization_id", orgId)
    .maybeSingle();
  if (caseErr) throw new Error(caseErr.message);
  if (!claimCase) {
    console.error("claim_case_not_found", { caseId, orgId });
    process.exit(1);
  }

  const returnId = String(claimCase.primary_return_item_id ?? "").trim();
  const meta = (claimCase.metadata as Record<string, unknown> | null) ?? {};
  const existingSub = String(meta.claim_submission_id ?? "").trim();

  const { data: lines } = await sb
    .from("claim_lines")
    .select("id, line_grain, status")
    .eq("claim_case_id", caseId);
  const returnItemLines = (lines ?? []).filter((l) => (l as { line_grain: string }).line_grain === "return_item");

  let returnRow: Record<string, unknown> | null = null;
  if (returnId) {
    const { data: ri } = await sb
      .from("return_items")
      .select("id, resolved_product_id, conditions, notes, photo_evidence, package_id")
      .eq("id", returnId)
      .maybeSingle();
    returnRow = ri as Record<string, unknown> | null;
  }

  const { data: existingSubmission } =
    returnId && isUuidString(returnId)
      ? await sb
          .from("claim_submissions")
          .select("id, report_url, status")
          .eq("return_id", returnId)
          .eq("organization_id", orgId)
          .maybeSingle()
      : { data: null };

  const plan = {
    mode: apply ? "apply" : "dry_run",
    claim_case_id: caseId,
    organization_id: orgId,
    primary_return_item_id: returnId || null,
    return_item_lines: returnItemLines.length,
    metadata_submission_id: existingSub || null,
    existing_submission_by_return: existingSubmission ?? null,
    resolved_product_id: returnRow?.resolved_product_id ?? null,
    generate_pdf: !noPdf,
  };

  console.log(JSON.stringify({ step: "preflight", plan }, null, 2));

  if (!apply) {
    console.log("Dry-run complete. Pass --apply to run promoteClaimCaseToSubmissionPackage.");
    return;
  }

  const { promoteClaimCaseToSubmissionPackage } = await import("../lib/claim-case-promote-submission");
  const result = await promoteClaimCaseToSubmissionPackage(caseId, {
    organizationId: orgId,
    generatePdf: !noPdf,
    client: sb,
  });

  console.log(JSON.stringify({ step: "promote", result }, null, 2));
  process.exit(result.ok ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
