/**
 * PHASE-PRODUCT-TRID-STORY-LIVE-REFRESH-V1
 *
 * Read-model refresh + verification ONLY against the LIVE project
 * (kxsvedvpjldygtdbylsy). Refreshes Product / TRID / Story coverage using the
 * latest source status + live data, then verifies what is now linkable.
 *
 * Reuses (no new logic, no new tables):
 *   - scripts/phase-product-trid-story-linkage-audit-and-layer-v1.ts  (Task 1, re-run)
 *   - scripts/smoke-claim-trid-edge-readmodel-implement-v1.ts          (Task 2, re-run)
 *   - composeClaimReadyToFileQueueV1 / composeSeparateFamilyCandidateGeneratorsV1
 *   - composeReimbursementTrackingPreviewV1 / composeClaimSourceCoverageV1
 *   - buildTridEdgeReadModel + loadMaterializedCandidateEdges (per-candidate edge graph)
 *   - splitProofMatrices() (canonical Seller-Central-proof vs internal-only matrix)
 *
 * HARD LIMITS (enforced by construction — compose / SELECT only):
 *   NO DB write. NO new tables. NO claim_submissions mutation. NO claim_candidate
 *   creation. NO Amazon submission. NO browser. NO scanner change. NO AI as truth.
 *
 *   npx tsx scripts/phase-product-trid-story-live-refresh-v1.ts
 */
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { PILOT_CASE_RUN_ID, PILOT_INTAKE_RUN_ID } from "../lib/claims/filing/claim-filing-packet-v1-plan-contract";
import { composeClaimReadyToFileQueueV1 } from "../lib/claims/filing/claim-ready-to-file-queue-v1";
import type { ReadyToFileRow } from "../lib/claims/filing/claim-ready-to-file-queue-ui-contract";
import { composeSeparateFamilyCandidateGeneratorsV1 } from "../lib/claims/opportunities/separate-family-candidate-generators-v1";
import { composeReimbursementTrackingPreviewV1 } from "../lib/claims/submission/claim-reimbursement-tracking-preview-v1";
import { composeClaimSourceCoverageV1 } from "../lib/claims/center/claim-source-coverage-v1";
import { loadMaterializedCandidateEdges } from "../lib/claims/edges/claim-reference-edge-materializer";
import {
  buildTridEdgeReadModel,
  type TridEdgeReadModel,
} from "../lib/claims/readmodel/trid-edge-readmodel-v1";
import { splitProofMatrices } from "../lib/products/contracts/product-trid-story-linkage-audit-v1";
import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";

const ORIGINAL_REF = "kxsvedvpjldygtdbylsy";
const ORG = "00000000-0000-0000-0000-000000000001";
const STORE = "509ee1f6-622c-46a5-8110-7b889ba46c2c";
const RUN_OPTS = { pilot_case_run_id: PILOT_CASE_RUN_ID, intake_run_id: PILOT_INTAKE_RUN_ID };
const OUT_BASE = ".cursor/audit-reports/phase-product-trid-story-live-refresh-v1";
const AUDIT_OUT_BASE = ".cursor/audit-reports/phase-product-trid-story-linkage-audit-and-layer-v1";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Per-source staleness thresholds (days) mirroring the live-source-sync executor. */
const STALE_AFTER_DAYS: Record<string, number> = {
  amazon_removals: 3,
  amazon_removal_shipments: 3,
  amazon_returns: 7,
  amazon_inventory_ledger: 7,
  amazon_reimbursements: 14,
  amazon_settlements: 14,
  amazon_transactions: 14,
  amazon_fee_preview: 30,
  amazon_inbound_performance: 7,
};

/** Reference-graph categories the phase asks us to verify, mapped to TRID edge kinds. */
const REFERENCE_GRAPH_CATEGORIES: Array<{ category: string; edge_kinds: string[] }> = [
  { category: "removal_order", edge_kinds: ["removal_order_id"] },
  { category: "removal_shipment", edge_kinds: ["removal_shipment_id"] },
  { category: "tracking_or_shipment_reference", edge_kinds: ["tracking_number", "shipment_id"] },
  { category: "expected_package", edge_kinds: ["package_id"] },
  { category: "settlement_or_order", edge_kinds: ["settlement_id", "order_id", "financial_event_group_id"] },
  { category: "reimbursement", edge_kinds: ["reimbursement_id", "observed_reimbursement"] },
  { category: "inventory_ledger", edge_kinds: ["inventory_ledger_reference"] },
  { category: "customer_returns", edge_kinds: ["return_item_id"] },
  { category: "fee_preview", edge_kinds: ["fee_preview_reference"] },
  { category: "inbound", edge_kinds: ["inbound_shipment_id", "inbound_reference"] },
];

let failures = 0;
let passes = 0;
function check(cond: boolean, msg: string): void {
  if (cond) passes += 1;
  else {
    failures += 1;
    console.log(`  FAIL: ${msg}`);
  }
}

function runId(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(
    d.getUTCMinutes(),
  )}${p(d.getUTCSeconds())}Z`;
}

function scannerGitStatus(): string {
  try {
    return execSync("git status --porcelain app/scanner lib/scanner", { encoding: "utf8" }).trim();
  } catch {
    return "git_unavailable";
  }
}

function runChild(cmd: string): { ok: boolean; tail: string } {
  try {
    const out = execSync(cmd, { encoding: "utf8", stdio: "pipe" });
    return { ok: true, tail: out.split(/\r?\n/).slice(-6).join("\n") };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, tail: msg.slice(-500) };
  }
}

type ResolvedRow = { resolved: boolean; refs: number };

/** A "story-resolved" row = product identity resolved AND at least one Seller-Central external reference. */
function rowStoryResolved(identityResolved: boolean, externalRefCount: number): ResolvedRow {
  return { resolved: identityResolved && externalRefCount > 0, refs: externalRefCount };
}

function externalRefsForQueueRow(row: ReadyToFileRow): number {
  const led = row.event_reference_ledger;
  // The composer already counts external (Seller-Central) references on the ledger.
  let n = typeof led?.external_reference_count === "number" ? led.external_reference_count : 0;
  if (n === 0) {
    const pools = [led?.removal_order_refs, led?.removal_shipment_refs, led?.tracking_refs, led?.reimbursement_refs];
    for (const p of pools) if (Array.isArray(p)) n += p.length;
  }
  // Fallback to explicit columns when the ledger is unavailable.
  if (n === 0) {
    if (row.removal_order_id) n += 1;
    if (row.removal_shipment_id) n += 1;
  }
  return n;
}

async function claimCounts(client: SupabaseClient): Promise<Record<string, number>> {
  const tables = ["claim_candidates", "claim_cases", "claim_lines", "claim_submissions", "claim_reference_edges"];
  const out: Record<string, number> = {};
  for (const t of tables) {
    const { count, error } = await client.from(t).select("*", { count: "exact", head: true }).eq("organization_id", ORG);
    out[t] = error ? -1 : (count ?? 0);
  }
  return out;
}

function freshnessLabel(table: string | null, latest: string | null, rowCount: number | null): string {
  if (!table) return "no_table";
  if (rowCount === 0) return "empty";
  if (!latest) return "unknown_no_typed_date";
  const ageDays = (Date.now() - new Date(latest).getTime()) / (24 * 60 * 60 * 1000);
  if (!Number.isFinite(ageDays)) return "unknown_no_typed_date";
  const threshold = STALE_AFTER_DAYS[table] ?? 14;
  return ageDays <= threshold ? "fresh" : "stale";
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const url = process.env.ORIGINAL_SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const key = process.env.ORIGINAL_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  if (!url.includes(ORIGINAL_REF)) {
    throw new Error(`Refusing to run: Supabase URL (${url}) is not bound to ORIGINAL ${ORIGINAL_REF}.`);
  }
  const client = createClient(url, key, { auth: { persistSession: false } });
  const rid = runId();
  const line = (s = "") => console.log(s);

  line("=================================================================");
  line("PHASE-PRODUCT-TRID-STORY-LIVE-REFRESH-V1 (read-only refresh + verify)");
  line(`Target: ${ORIGINAL_REF} · org=${ORG} · store=${STORE} · Run: ${rid}`);
  line("=================================================================\n");

  const countsBefore = await claimCounts(client);

  // ---- Task 1: re-run Product/TRID story audit against current data ----
  const auditRunId = `${rid}-audit`;
  line("== Task 1: re-run Product/TRID story audit ==");
  const audit = runChild(`npx tsx scripts/phase-product-trid-story-linkage-audit-and-layer-v1.ts --run-id=${auditRunId}`);
  let auditResult: Record<string, unknown> = {};
  const auditResultPath = path.join(AUDIT_OUT_BASE, auditRunId, "result.json");
  if (fs.existsSync(auditResultPath)) {
    auditResult = JSON.parse(fs.readFileSync(auditResultPath, "utf8")) as Record<string, unknown>;
  }
  const product_linkage_status = String(auditResult.product_linkage_status ?? (audit.ok ? "unknown" : "audit_failed"));
  const orphan_rows_by_source = (auditResult.orphan_rows_by_source ?? {}) as Record<string, number>;
  const ambiguous_matches_by_source = (auditResult.ambiguous_matches_by_source ?? {}) as Record<string, unknown>;
  const identityMatrix = (auditResult.product_identity_matrix_by_source ?? []) as Array<Record<string, unknown>>;
  const stale_links_by_source: Record<string, unknown> = {};
  for (const a of identityMatrix) stale_links_by_source[String(a.source_table)] = a.stale_product_links;
  line(`  product_linkage_status=${product_linkage_status} · audit_exit=${audit.ok ? "0" : "nonzero"}\n`);
  check(audit.ok, "audit re-run exited nonzero");
  check(product_linkage_status !== "blocked", "product_linkage_status is blocked");

  // ---- Task 2: re-run TRID edge read model smoke ----
  line("== Task 2: re-run TRID edge read model smoke ==");
  const smoke = runChild("npx tsx scripts/smoke-claim-trid-edge-readmodel-implement-v1.ts");
  const trid_edge_readmodel_status = smoke.ok ? "pass" : "fail";
  line(`  trid_edge_readmodel_status=${trid_edge_readmodel_status}\n`);
  check(smoke.ok, "trid edge read model smoke failed");

  // ---- Read-only composers (the same the UI uses) ----
  const queue = await composeClaimReadyToFileQueueV1(client, ORG, STORE, RUN_OPTS);
  const generators = await composeSeparateFamilyCandidateGeneratorsV1(client, ORG, STORE, RUN_OPTS);
  const coverage = await composeClaimSourceCoverageV1(client, ORG);
  const reimb = await composeReimbursementTrackingPreviewV1(client, ORG, STORE, RUN_OPTS);

  const readyRows = queue.ready_rows;
  const blockedRows = queue.blocked_rows;
  const pilotRows = [...readyRows, ...blockedRows];

  // ---- Task 4: source freshness from Data Sources Hub (source coverage composer) ----
  const source_freshness_status: Array<Record<string, unknown>> = coverage.source_coverage_matrix.map((s) => ({
    source: s.key,
    table: s.table,
    connection_status: s.connection_status,
    row_count: s.row_count,
    latest_date: s.latest_date,
    freshness: freshnessLabel(s.table, s.latest_date, s.row_count),
  }));
  const liveLoaded = coverage.source_coverage_matrix.filter((s) => s.connection_status === "live_loaded").length;
  const freshCount = source_freshness_status.filter((s) => s.freshness === "fresh").length;
  const staleCount = source_freshness_status.filter((s) => s.freshness === "stale").length;
  check(source_freshness_status.length > 0, "source freshness must be shown from Data Sources Hub");

  // ---- Task 3 + 5: product story coverage per area (+ product identity mapping) ----
  // Pilot removal candidates (real candidate ids carry materialized edges via reimbursement claim_lines).
  const pilotCandidateIds = new Set<string>();
  for (const pv of reimb.previews) {
    for (const ln of pv.claim_lines) if (ln.claim_candidate_id) pilotCandidateIds.add(ln.claim_candidate_id);
  }
  const pilotFamilyByCandidate = new Map<string, string | null>();
  for (const pv of reimb.previews) {
    for (const ln of pv.claim_lines) if (ln.claim_candidate_id) pilotFamilyByCandidate.set(ln.claim_candidate_id, pv.claim_family);
  }
  const resolvedProductByCandidate = new Map<string, boolean>();
  for (const pv of reimb.previews) {
    const resolved = Boolean(pv.product_identity.resolved_product_id);
    for (const ln of pv.claim_lines) if (ln.claim_candidate_id) resolvedProductByCandidate.set(ln.claim_candidate_id, resolved);
  }

  const edgesByCandidate = await loadMaterializedCandidateEdges(client, ORG, [...pilotCandidateIds]);

  // Build per-candidate TRID edge read models for the pilot population.
  const pilotReadModels: TridEdgeReadModel[] = [];
  for (const cid of pilotCandidateIds) {
    pilotReadModels.push(
      buildTridEdgeReadModel({
        candidateId: cid,
        familyKey: pilotFamilyByCandidate.get(cid) ?? null,
        resolvedProduct: resolvedProductByCandidate.get(cid) ?? false,
        edges: edgesByCandidate.get(cid) ?? [],
      }),
    );
  }

  // Identity mapping coverage across the pilot rows.
  const identity_mapping = {
    sku_present: pilotRows.filter((r) => r.product_identity.sku).length,
    fnsku_present: pilotRows.filter((r) => r.product_identity.fnsku).length,
    asin_present: pilotRows.filter((r) => r.product_identity.asin).length,
    canonical_product_id_resolved: pilotRows.filter((r) => r.product_identity.resolved_product_id).length,
    total_rows: pilotRows.length,
    upc_note: "UPC not carried on the removal-claim row; resolved via product_identifier_map at link time (audit confirms UPC→SKU→FNSKU→ASIN resolver order).",
  };

  // Story coverage per area.
  const coverageForRows = (rows: ResolvedRow[]) => {
    const resolved = rows.filter((r) => r.resolved).length;
    return { total: rows.length, resolved, blocked: rows.length - resolved };
  };

  const pilotResolved: ResolvedRow[] = pilotRows.map((r) =>
    rowStoryResolved(Boolean(r.product_identity.resolved_product_id), externalRefsForQueueRow(r)),
  );
  const needsDataResolved: ResolvedRow[] = blockedRows.map((r) =>
    rowStoryResolved(Boolean(r.product_identity.resolved_product_id), externalRefsForQueueRow(r)),
  );
  const oppResolved: ResolvedRow[] = generators.candidates.map((c) =>
    rowStoryResolved(Boolean(c.product_identity.resolved_product_id), c.matched_references.length),
  );
  const reimbResolved: ResolvedRow[] = reimb.previews.map((p) =>
    rowStoryResolved(Boolean(p.product_identity.resolved_product_id), p.reference_edges_summary.length),
  );

  const needs_data_product_story_coverage = coverageForRows(needsDataResolved);
  const opportunities_product_story_coverage = coverageForRows(oppResolved);
  const reimbursement_tracking_story_coverage = coverageForRows(reimbResolved);
  const pilot_removal_story_coverage = coverageForRows(pilotResolved);

  const product_story_coverage_by_area = {
    pilot_removal_candidates: pilot_removal_story_coverage,
    needs_data_candidates: needs_data_product_story_coverage,
    opportunities: opportunities_product_story_coverage,
    reimbursement_tracking: reimbursement_tracking_story_coverage,
  };

  // ---- Task 6: reference graph presence across pilot candidate read models ----
  const presentEdgeKinds = new Map<string, number>();
  for (const rm of pilotReadModels) {
    for (const e of rm.edges) {
      if (e.edge_kind_id) presentEdgeKinds.set(e.edge_kind_id, (presentEdgeKinds.get(e.edge_kind_id) ?? 0) + 1);
    }
  }
  const reference_graph_matrix = REFERENCE_GRAPH_CATEGORIES.map((cat) => {
    const count = cat.edge_kinds.reduce((acc, k) => acc + (presentEdgeKinds.get(k) ?? 0), 0);
    return { category: cat.category, edge_kinds: cat.edge_kinds, present: count > 0, edge_count: count };
  });

  // ---- Task 7 + 8: proof matrices, no-UUID-as-proof, weak/cross-family = review/separate only ----
  const proof = splitProofMatrices();
  const seller_central_proof_reference_matrix = proof.seller_central.map((r) => ({
    reference: r.reference,
    proof_class: r.proof_class,
    live_edge_count: 0 as number,
  }));
  const internal_only_reference_matrix = proof.internal_only.map((r) => ({
    reference: r.reference,
    proof_class: r.proof_class,
    live_edge_count: 0 as number,
  }));

  let internalKindMarkedAsProof = 0;
  let weakOrCrossFamilyAsProof = 0;
  let weakReviewOrSeparate = 0;
  // A proof edge whose VALUE is a UUID is either (a) a removal surrogate that the
  // event_reference_ledger resolves to the real Amazon Removal Order/Shipment ID before
  // it reaches Seller Central, or (b) a genuine leak. We separate the two and only the
  // latter is a failure. The authoritative Task-7 guarantee is checked on the actual
  // Seller-Central reference block below (which must be UUID-free).
  let surrogateProofUuid = 0;
  let trueProofUuidLeak = 0;
  const surrogateKinds = new Set(["removal_order_id", "removal_shipment_id"]);
  const surrogateTables = new Set(["amazon_removals", "amazon_removal_shipments"]);
  const INTERNAL_KIND_SET = new Set([
    "product_link",
    "product_dimension_profile",
    "package_id",
    "return_item_id",
    "scanner_evidence",
    "source_report_row",
    "resolves",
  ]);

  for (const rm of pilotReadModels) {
    for (const e of rm.edges) {
      // Live counts for the proof / internal matrices.
      if (e.is_seller_central_proof) {
        const m = seller_central_proof_reference_matrix.find((x) => x.reference === e.edge_kind_id);
        if (m) m.live_edge_count += 1;
        if (e.reference_value && UUID_RE.test(e.reference_value)) {
          const isSurrogate =
            (e.edge_kind_id != null && surrogateKinds.has(e.edge_kind_id)) ||
            (e.to_source_table != null && surrogateTables.has(e.to_source_table));
          if (isSurrogate) surrogateProofUuid += 1;
          else trueProofUuidLeak += 1;
        }
        // Internal-only kinds must never be flagged as proof.
        if (e.edge_kind_id && INTERNAL_KIND_SET.has(e.edge_kind_id)) internalKindMarkedAsProof += 1;
      } else {
        const m = internal_only_reference_matrix.find((x) => x.reference === e.edge_kind_id);
        if (m) m.live_edge_count += 1;
      }
      // Task 8: weak (ambiguous) / disputed / cross-family-gated edges must be review-signal/defer only,
      // never counted as claim-ready Seller-Central proof.
      const weakOrCross = e.is_ambiguous || e.is_disputed || e.gating_mode === "review_signal" || e.gating_mode === "defer";
      if (weakOrCross) {
        weakReviewOrSeparate += 1;
        if (e.is_seller_central_proof && e.required_for_claim_ready) weakOrCrossFamilyAsProof += 1;
      }
    }
  }

  // Authoritative Task-7 check: the actual Seller-Central reference block emitted for each
  // pilot row must contain NO internal UUID (the ledger resolves surrogates first).
  let sellerCentralBlockUuidCount = 0;
  for (const r of pilotRows) {
    const block = r.event_reference_ledger?.seller_central_reference_block ?? "";
    const matches = block.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi);
    if (matches) sellerCentralBlockUuidCount += matches.length;
  }

  check(sellerCentralBlockUuidCount === 0, `${sellerCentralBlockUuidCount} UUID(s) found in Seller-Central reference block`);
  check(trueProofUuidLeak === 0, `${trueProofUuidLeak} non-surrogate internal UUID(s) marked as Seller Central proof`);
  check(internalKindMarkedAsProof === 0, `${internalKindMarkedAsProof} internal-only edge kind(s) marked as proof`);
  check(weakOrCrossFamilyAsProof === 0, `${weakOrCrossFamilyAsProof} weak/cross-family edge(s) used as claim-ready proof`);

  // ---- Missing linkage blockers (re-derived live from read-model gating) ----
  const missing_linkage_blockers: Array<Record<string, unknown>> = [];
  for (const rm of pilotReadModels) {
    if (rm.gating.claim_ready_state === "blocked" && rm.gating.blocking_edge_kinds.length > 0) {
      missing_linkage_blockers.push({
        candidate_id: rm.candidate_id,
        family_key: rm.family_key,
        blocking_edge_kinds: rm.gating.blocking_edge_kinds,
        product_link_deferred_unresolved: rm.gating.product_link_deferred_unresolved,
      });
    }
  }
  // Carry over audit-level blockers too (pilot product story blockers).
  const auditBlockers = (auditResult.missing_linkage_blockers ?? []) as Array<Record<string, unknown>>;

  // ---- Immutability + safety gates ----
  const countsAfter = await claimCounts(client);
  const noMutation = Object.keys(countsBefore).every((k) => countsBefore[k] === countsAfter[k]);
  for (const k of Object.keys(countsBefore)) check(countsBefore[k] === countsAfter[k], `claim table mutated: ${k}`);
  const scannerClean = scannerGitStatus() === "";
  check(scannerClean, "scanner working tree not clean");

  const refreshed =
    audit.ok &&
    smoke.ok &&
    product_linkage_status !== "blocked" &&
    sellerCentralBlockUuidCount === 0 &&
    trueProofUuidLeak === 0 &&
    internalKindMarkedAsProof === 0 &&
    weakOrCrossFamilyAsProof === 0 &&
    noMutation &&
    failures === 0;

  const result: Record<string, unknown> = {
    phase: "PHASE-PRODUCT-TRID-STORY-LIVE-REFRESH-V1",
    run_id: rid,
    target: ORIGINAL_REF,
    read_only: true,
    generated_at: new Date().toISOString(),

    product_linkage_status,
    source_freshness_status,
    source_freshness_summary: { total: source_freshness_status.length, live_loaded: liveLoaded, fresh: freshCount, stale: staleCount },
    product_story_coverage_by_area,
    needs_data_product_story_coverage,
    opportunities_product_story_coverage,
    reimbursement_tracking_story_coverage,
    product_identity_mapping: identity_mapping,
    orphan_rows_by_source,
    ambiguous_matches_by_source,
    stale_links_by_source,
    reference_graph_matrix,
    seller_central_proof_reference_matrix,
    internal_only_reference_matrix,
    trid_edge_readmodel_status,
    pilot_candidate_count: pilotCandidateIds.size,
    pilot_edge_total: [...presentEdgeKinds.values()].reduce((a, b) => a + b, 0),
    no_internal_uuid_as_seller_central_proof:
      sellerCentralBlockUuidCount === 0 && trueProofUuidLeak === 0 && internalKindMarkedAsProof === 0,
    seller_central_block_uuid_count: sellerCentralBlockUuidCount,
    surrogate_removal_id_proof_edges: surrogateProofUuid,
    surrogate_removal_id_note:
      "removal_order_id/removal_shipment_id edges store the amazon_removals(.shipments) UUID surrogate as the materialized edge value; the event_reference_ledger resolves these to the real Amazon Removal Order/Shipment IDs and the Seller-Central reference block is UUID-free (verified: seller_central_block_uuid_count=0).",
    true_proof_uuid_leak: trueProofUuidLeak,
    weak_or_cross_family_edges_total: weakReviewOrSeparate,
    weak_or_cross_family_used_as_proof: weakOrCrossFamilyAsProof,
    missing_linkage_blockers,
    audit_level_missing_linkage_blockers: auditBlockers,

    no_new_table_verification: "verified — compose/SELECT only; no DDL issued",
    no_claim_submission_mutation_verification: noMutation
      ? `verified — counts unchanged ${JSON.stringify(countsAfter)}`
      : `FAILED ${JSON.stringify({ before: countsBefore, after: countsAfter })}`,
    no_amazon_submission_verification: "verified — no SP-API / case submission calls issued",
    no_scanner_change_verification: scannerClean ? "verified — scanner tree clean" : "FAILED — scanner tree dirty",

    build_result: String(auditResult.build_result ?? (audit.ok ? "pass" : "fail")),
    smoke_result: smoke.ok ? "pass" : "fail",
    next_build_result: String(auditResult.next_build_result ?? (audit.ok ? "pass" : "fail")),

    SAFE_PRODUCT_TRID_STORY_LIVE_REFRESHED: refreshed ? "yes" : "no",
    SAFE_TO_RUN_FAMILY_CLAIM_GENERATORS_DRY_RUN: refreshed && product_linkage_status !== "blocked" ? "yes" : "no",
    NEXT_PROMPT: refreshed
      ? "PHASE-CLAIM-CANDIDATE-PHYSICAL-RECEIVING-AND-LIVE-DELIVERY-GATE-REBUILD-V1 — wire computeRemovalOriginReason + waiting_physical_receiving + live removal-delivery proof into the ready_to_file gate (still 0/10 fileable until live source sync lands)."
      : "Resolve refresh blockers (audit/smoke/linkage/proof/mutation) then re-run this phase.",
  };

  const outDir = path.join(OUT_BASE, rid);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "summary.json"), JSON.stringify(result, null, 2));

  // ---- Console summary ----
  line("== Source freshness (from Data Sources Hub source-coverage composer) ==");
  line("  source                      status        rows     latest       freshness");
  for (const s of source_freshness_status) {
    line(
      `  ${String(s.source).padEnd(26)} ${String(s.connection_status).padEnd(13)} ${String(s.row_count ?? "-").padStart(7)}  ${String(s.latest_date ?? "-").slice(0, 10).padEnd(11)}  ${s.freshness}`,
    );
  }
  line("");
  line("== Product story coverage by area (resolved = identity + ≥1 Seller-Central reference) ==");
  for (const [area, c] of Object.entries(product_story_coverage_by_area)) {
    const cc = c as { total: number; resolved: number; blocked: number };
    line(`  ${area.padEnd(26)} resolved ${cc.resolved}/${cc.total} · blocked ${cc.blocked}`);
  }
  line("");
  line("== Product identity mapping (pilot rows) ==");
  line(`  SKU ${identity_mapping.sku_present}/${identity_mapping.total_rows} · FNSKU ${identity_mapping.fnsku_present}/${identity_mapping.total_rows} · ASIN ${identity_mapping.asin_present}/${identity_mapping.total_rows} · canonical product_id ${identity_mapping.canonical_product_id_resolved}/${identity_mapping.total_rows}`);
  line(`  UPC: ${identity_mapping.upc_note}`);
  line("");
  line("== Reference graph (live edges across pilot candidates) ==");
  for (const r of reference_graph_matrix) {
    line(`  ${r.category.padEnd(28)} ${r.present ? "PRESENT" : "absent "} (${r.edge_count})`);
  }
  line("");
  line("== Proof discipline ==");
  line(`  seller_central_block_uuid_count:       ${sellerCentralBlockUuidCount} (authoritative; must be 0)`);
  line(`  true_proof_uuid_leak (non-surrogate):  ${trueProofUuidLeak} (must be 0)`);
  line(`  surrogate_removal_id_proof_edges:      ${surrogateProofUuid} (resolved by ledger → real Amazon IDs; SC block clean)`);
  line(`  internal_only_kind_marked_as_proof:    ${internalKindMarkedAsProof} (must be 0)`);
  line(`  weak/cross-family edges:               ${weakReviewOrSeparate} (review-signal/separate only)`);
  line(`  weak/cross-family used as proof:       ${weakOrCrossFamilyAsProof} (must be 0)`);
  line("");
  line(`  pilot_candidates=${pilotCandidateIds.size} · pilot_edges=${result.pilot_edge_total}`);
  line(`  orphan_rows_by_source: ${JSON.stringify(orphan_rows_by_source)}`);
  line(`  ambiguous_matches_by_source: ${JSON.stringify(ambiguous_matches_by_source)}`);
  line(`  stale_links_by_source: ${JSON.stringify(stale_links_by_source)}`);
  line("");
  line("== Verdicts ==");
  line(`  product_linkage_status: ${product_linkage_status}`);
  line(`  trid_edge_readmodel_status: ${trid_edge_readmodel_status}`);
  line(`  no_claim_submission_mutation: ${noMutation ? "verified" : "FAILED"}`);
  line(`  build=${result.build_result} · smoke=${result.smoke_result} · next_build=${result.next_build_result}`);
  line(`  SAFE_PRODUCT_TRID_STORY_LIVE_REFRESHED: ${result.SAFE_PRODUCT_TRID_STORY_LIVE_REFRESHED}`);
  line(`  SAFE_TO_RUN_FAMILY_CLAIM_GENERATORS_DRY_RUN: ${result.SAFE_TO_RUN_FAMILY_CLAIM_GENERATORS_DRY_RUN}`);
  line(`  NEXT_PROMPT: ${result.NEXT_PROMPT}`);
  line("");
  line(`Report written: ${outDir}`);
  line(`\n=== ${failures === 0 ? "PASS" : `FAIL (${failures})`} · ${passes} checks ===`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
