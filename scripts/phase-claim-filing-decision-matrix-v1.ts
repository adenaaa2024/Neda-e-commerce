/**
 * PHASE-CLAIM-FILING-DECISION-MATRIX-V1
 *
 * Read-only filing-decision audit for the 10 pilot ready-to-file claims. For each
 * claim, applies the deterministic decision rules (strong external reference +
 * product identity + positive quantity + COGS-based recovery → safe_to_file; weak
 * FNSKU/date-window candidates never qualify on their own; internal-only → do_not_file)
 * and emits the full per-claim matrix + global counts. Verifies Seller Central text
 * excludes internal UUIDs / weak refs and uses COGS recovery.
 *
 * No DB writes. No claim_* mutation. No Amazon. No scanner change. No AI.
 *
 *   npx tsx scripts/phase-claim-filing-decision-matrix-v1.ts
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { composeClaimReadyToFileQueueV1 } from "../lib/claims/filing/claim-ready-to-file-queue-v1";
import {
  PILOT_CASE_RUN_ID,
  PILOT_INTAKE_RUN_ID,
} from "../lib/claims/filing/claim-filing-packet-v1-plan-contract";
import {
  buildReferenceBlockText,
  computeFilingDecision,
} from "../lib/claims/filing/claim-ready-to-file-queue-ui-contract";
import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";

const ORG = "00000000-0000-0000-0000-000000000001";
const STORE = "509ee1f6-622c-46a5-8110-7b889ba46c2c";
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

let failures = 0;
function check(cond: boolean, msg: string): void {
  if (!cond) {
    failures += 1;
    console.log(`  FAIL: ${msg}`);
  }
}

async function tableCount(client: SupabaseClient, table: string): Promise<number> {
  const { count } = await client
    .from(table)
    .select("id", { count: "exact", head: true })
    .eq("organization_id", ORG);
  return count ?? -1;
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const client = createClient(
    process.env.ORIGINAL_SUPABASE_URL!,
    process.env.ORIGINAL_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } },
  );

  console.log("=== PHASE-CLAIM-FILING-DECISION-MATRIX-V1 (read-only) ===");

  const before = {
    submissions: await tableCount(client, "claim_submissions"),
    cases: await tableCount(client, "claim_cases"),
    lines: await tableCount(client, "claim_lines"),
    candidates: await tableCount(client, "claim_candidates"),
    edges: await tableCount(client, "claim_reference_edges"),
  };

  const payload = await composeClaimReadyToFileQueueV1(client, ORG, STORE, {
    pilot_case_run_id: PILOT_CASE_RUN_ID,
    intake_run_id: PILOT_INTAKE_RUN_ID,
  });

  const allRows = [...payload.ready_rows, ...payload.blocked_rows];
  check(allRows.length === 10, `expected 10 pilot rows, got ${allRows.length}`);

  let safe = 0;
  let needsReview = 0;
  let doNotFile = 0;
  let sellerCentralExcludesUuid = true;
  let sellerCentralExcludesWeak = true;
  let sellerCentralUsesCogs = true;

  for (const row of allRows) {
    const d = computeFilingDecision(row);
    const led = row.event_reference_ledger;
    const block = buildReferenceBlockText(row);
    const subject = row.packet.seller_central_case_subject;
    const body = row.packet.seller_central_message_body;

    if (d.decision === "safe_to_file") safe += 1;
    else if (d.decision === "needs_reference_review") needsReview += 1;
    else doNotFile += 1;

    console.log(`\n──── ${row.claim_submission_id} · ${row.claim_family} → ${d.decision.toUpperCase()} ────`);
    console.log(`  case_id=${row.claim_case_id ?? "—"}`);
    console.log(`  product: fnsku=${row.fnsku ?? "—"} sku=${row.sku ?? "—"} asin=${row.asin ?? "—"} rpid=${row.product_identity.resolved_product_id ?? "—"}`);
    console.log(`  qty=${row.clean_quantity ?? "—"} cogs/u=${row.approved_cogs_unit ?? "—"} recovery=${row.recovery_value ?? "—"}`);
    console.log(`  decision_reason: ${d.reason}`);
    console.log(`  high_confidence_refs: ${d.high_confidence_refs.length ? d.high_confidence_refs.join(" | ") : "—"}`);
    console.log(`  weak_refs_excluded: ${d.weak_refs_excluded.length ? d.weak_refs_excluded.join(" | ") : "—"}`);
    console.log(`  internal_anchors_excluded: ${d.internal_anchors_excluded.length ? d.internal_anchors_excluded.join(", ") : "—"}`);
    console.log(`  evidence_packet: ${row.packet.evidence_packet_path}`);
    console.log(`  attachments: [${row.packet.attachments_to_include.join(", ")}]`);
    console.log(`  seller_central_subject: ${subject}`);
    console.log(`  reference_block:\n    ${block.replace(/\n/g, "\n    ")}`);

    // ---- Assertions ----
    // Decision sanity: safe_to_file requires a strong removal/shipment/tracking ref.
    const hasStrong =
      led.removal_order_refs.length > 0 || led.removal_shipment_refs.length > 0 || led.tracking_refs.length > 0;
    if (d.decision === "safe_to_file") {
      check(hasStrong, `${row.claim_submission_id}: safe_to_file requires a strong external reference`);
      check((row.clean_quantity ?? 0) > 0, `${row.claim_submission_id}: safe_to_file requires positive quantity`);
      check((row.recovery_value ?? 0) > 0 && (row.approved_cogs_unit ?? 0) > 0, `${row.claim_submission_id}: safe_to_file requires COGS recovery`);
      check(!row.uses_sale_price_as_amount, `${row.claim_submission_id}: safe_to_file must not use sale price as amount`);
    }
    if (led.external_reference_count === 0) {
      check(d.decision === "do_not_file", `${row.claim_submission_id}: internal-only claim must be do_not_file`);
    }

    // Seller Central text must exclude internal UUIDs, weak refs, and "TRID" mislabels.
    const sc = `${subject}\n${body}\n${block}`;
    if (UUID_RE.test(sc)) sellerCentralExcludesUuid = false;
    check(!UUID_RE.test(sc), `${row.claim_submission_id}: Seller Central text must contain NO internal UUID`);
    check(!/TRID/i.test(block), `${row.claim_submission_id}: reference block must not label anything "TRID"`);
    // Weak FNSKU/date-window candidate ids must not appear in the block.
    for (const g of led.source_groups) {
      if (g.status === "found_weak_ambiguous") {
        for (const cand of g.candidate_samples) {
          if (cand.reference_id && block.includes(cand.reference_id)) {
            sellerCentralExcludesWeak = false;
            check(false, `${row.claim_submission_id}: weak candidate ${cand.reference_id} leaked into reference block`);
          }
        }
      }
    }
    // COGS recovery wording present where recovery exists.
    if ((row.recovery_value ?? 0) > 0 && !/COGS/i.test(row.recovery_formula)) {
      sellerCentralUsesCogs = false;
      check(false, `${row.claim_submission_id}: recovery_formula must reference COGS`);
    }
  }

  const after = {
    submissions: await tableCount(client, "claim_submissions"),
    cases: await tableCount(client, "claim_cases"),
    lines: await tableCount(client, "claim_lines"),
    candidates: await tableCount(client, "claim_candidates"),
    edges: await tableCount(client, "claim_reference_edges"),
  };
  const noWrite =
    before.submissions === after.submissions &&
    before.cases === after.cases &&
    before.lines === after.lines &&
    before.candidates === after.candidates &&
    before.edges === after.edges;
  check(noWrite, `no-write verification failed: ${JSON.stringify({ before, after })}`);

  console.log("\n=== GLOBAL OUTPUT ===");
  console.log(`total_claims = ${allRows.length}`);
  console.log(`safe_to_file_count = ${safe}`);
  console.log(`needs_reference_review_count = ${needsReview}`);
  console.log(`do_not_file_count = ${doNotFile}`);
  console.log(`seller_central_text_excludes_internal_uuids = ${sellerCentralExcludesUuid ? "yes" : "no"}`);
  console.log(`seller_central_text_excludes_weak_refs = ${sellerCentralExcludesWeak ? "yes" : "no"}`);
  console.log(`seller_central_text_uses_cogs_recovery = ${sellerCentralUsesCogs ? "yes" : "no"}`);
  console.log(`no_db_write_verification = ${noWrite ? "PASS" : "FAIL"} (counts ${JSON.stringify(after)})`);
  console.log(`\n${failures === 0 ? "PHASE OK — filing decision matrix checks passed" : `PHASE FAILED — ${failures} check(s) failed`}`);
  if (failures > 0) process.exitCode = 1;
}

void main();
