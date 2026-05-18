/**
 * CLAIM-INBOX-AUDIT-07 — Read-only v2 claim candidate generator dry-run.
 *
 *   npx tsx scripts/claim-v2-candidate-generator-dryrun.ts
 *   npx tsx scripts/claim-v2-candidate-generator-dryrun.ts --org-id=<uuid>
 *   npx tsx scripts/claim-v2-candidate-generator-dryrun.ts --limit-per-table=2000
 *   npx tsx scripts/claim-v2-candidate-generator-dryrun.ts --evidence-probe
 *
 * Writes: .cursor/audit-reports/claim-inbox-audit-07/<run_id>/
 * No INSERT/UPDATE/DELETE. No migrations. No APIs.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { fetchSourceRowsByIds } from "../lib/claim-inbox-projection";
import { CLAIM_SUPPORTED_SOURCE_TABLES } from "../lib/claim-operational-source-resolve";
import { mkRunDir, mkRunId, writeCsv } from "../lib/audits/product-seed-output";

const GENERATOR_VERSION = "0.1.0-dryrun";
const PAGE = 800;
const SOURCE_FETCH_CHUNK = 200;

export type V2Candidate = {
  organization_id: string;
  store_id: string | null;
  source_table: string;
  source_row_id: string;
  claim_family: string;
  claim_reason: string;
  evidence_status: "missing" | "partial" | "complete";
  confidence_score: number;
  sku: string | null;
  asin: string | null;
  fnsku: string | null;
  product_id: string | null;
  resolved_product_id: string | null;
  generator_version: string;
  idempotency_key: string;
  generated_by: "dry_run";
  source_run_id: string | null;
  upload_id: string | null;
  blocker_reasons: string[];
  recommended_action: string;
};

function loadEnvLocal(): void {
  const p = path.join(process.cwd(), ".env.local");
  if (!fs.existsSync(p)) return;
  const raw = fs.readFileSync(p, "utf8");
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq <= 0) continue;
    const k = t.slice(0, eq).trim();
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[k] == null || process.env[k] === "") process.env[k] = v;
  }
}

function createServiceClient(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.");
  return createClient(url, key, { auth: { persistSession: false } });
}

function nv(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

function idempotencyKey(org: string, sourceTable: string, sourceRowId: string, claimReason: string): string {
  const h = crypto.createHash("sha256");
  h.update(`${org}|${sourceTable}|${sourceRowId}|${claimReason}`);
  return h.digest("hex");
}

function dispositionClaimReason(disposition: string | null, detailed: string | null): string {
  const d = `${disposition ?? ""} ${detailed ?? ""}`.toLowerCase();
  if (d.includes("damage") || d.includes("damaged")) return "DISPOSITION_DAMAGE_OR_DAMAGED";
  if (d.includes("customer")) return "DISPOSITION_CUSTOMER_RELATED";
  if (d.includes("defect")) return "DISPOSITION_DEFECTIVE";
  if (d.includes("carrier") || d.includes("lost")) return "DISPOSITION_CARRIER_OR_LOST";
  if (d.includes("sellable") || d.includes("unsellable")) return "DISPOSITION_SELLABILITY_REVIEW";
  return "DISPOSITION_LINE_REVIEW";
}

function returnsClaimReason(row: Record<string, unknown>): string {
  return dispositionClaimReason(nv(row.disposition), nv(row.detailed_disposition) ?? nv(row.return_reason));
}

function removalsClaimReason(row: Record<string, unknown>): string {
  const d = nv(row.disposition) ?? nv(row.removal_disposition);
  return dispositionClaimReason(d, nv(row.detailed_disposition));
}

function shipmentsClaimReason(row: Record<string, unknown>): string {
  const rq = row.requested_quantity;
  const sq = row.shipped_quantity;
  const dq = row.disposed_quantity;
  const cq = row.cancelled_quantity;
  const nums = [rq, sq, dq, cq].map((x) => (typeof x === "number" ? x : Number(x))).filter((x) => Number.isFinite(x));
  if (nums.length >= 2) {
    const [a, b] = nums;
    if (a !== b) return "SHIPMENT_QUANTITY_MISMATCH";
  }
  return dispositionClaimReason(nv(row.disposition), null);
}

function buildFromAmazonReturn(row: Record<string, unknown>): V2Candidate | null {
  const org = nv(row.organization_id);
  const id = nv(row.id);
  if (!org || !id) return null;
  const storeId = nv(row.store_id);
  const sku = nv(row.sku) ?? nv(row.merchant_sku) ?? nv(row.seller_sku);
  const asin = nv(row.asin);
  const fnsku = nv(row.fnsku);
  const claimReason = returnsClaimReason(row);
  const returnBridge = nv(row.return_id) ?? nv(row.returns_id);
  const evidence: V2Candidate["evidence_status"] = returnBridge ? "partial" : "missing";
  const confidence = evidence === "partial" ? 0.52 : 0.28;
  const blockers: string[] = [];
  if (!sku && !asin && !fnsku) blockers.push("missing_sku_asin_fnsku");
  if (!returnBridge) blockers.push("missing_return_lineage_for_evidence");
  if (!storeId) blockers.push("nullable_store_policy_review");
  blockers.push("product_identity_unresolved");
  const rec =
    evidence === "missing"
      ? "triage_attach_return_bridge_then_package_evidence"
      : "triage_package_slip_photos_before_submit";
  return {
    organization_id: org,
    store_id: storeId,
    source_table: "amazon_returns",
    source_row_id: id,
    claim_family: "AMAZON_RETURNS_FBA",
    claim_reason: claimReason,
    evidence_status: evidence,
    confidence_score: confidence,
    sku,
    asin,
    fnsku,
    product_id: null,
    resolved_product_id: null,
    generator_version: GENERATOR_VERSION,
    idempotency_key: idempotencyKey(org, "amazon_returns", id, claimReason),
    generated_by: "dry_run",
    source_run_id: null,
    upload_id: nv(row.upload_id),
    blocker_reasons: blockers,
    recommended_action: rec,
  };
}

function buildFromAmazonRemoval(row: Record<string, unknown>): V2Candidate | null {
  const org = nv(row.organization_id);
  const id = nv(row.id);
  if (!org || !id) return null;
  const storeId = nv(row.store_id);
  const sku = nv(row.sku);
  const asin = nv(row.asin);
  const fnsku = nv(row.fnsku);
  const claimReason = removalsClaimReason(row);
  const blockers: string[] = ["product_identity_unresolved"];
  if (!sku && !asin && !fnsku) blockers.push("missing_sku_asin_fnsku");
  if (!storeId) blockers.push("nullable_store_policy_review");
  blockers.push("removal_evidence_spine_weak");
  const evidence: V2Candidate["evidence_status"] = sku || fnsku || asin ? "partial" : "missing";
  const confidence = evidence === "partial" ? 0.45 : 0.22;
  return {
    organization_id: org,
    store_id: storeId,
    source_table: "amazon_removals",
    source_row_id: id,
    claim_family: "AMAZON_REMOVALS",
    claim_reason: claimReason,
    evidence_status: evidence,
    confidence_score: confidence,
    sku,
    asin,
    fnsku,
    product_id: null,
    resolved_product_id: null,
    generator_version: GENERATOR_VERSION,
    idempotency_key: idempotencyKey(org, "amazon_removals", id, claimReason),
    generated_by: "dry_run",
    source_run_id: null,
    upload_id: nv(row.upload_id),
    blocker_reasons: blockers,
    recommended_action: "verify_removal_disposition_and_shipment_bridge",
  };
}

function buildFromRemovalShipment(row: Record<string, unknown>): V2Candidate | null {
  const org = nv(row.organization_id);
  const id = nv(row.id);
  if (!org || !id) return null;
  const storeId = nv(row.store_id);
  const sku = nv(row.sku);
  const asin = nv(row.asin);
  const fnsku = nv(row.fnsku);
  const claimReason = shipmentsClaimReason(row);
  const typed = !!(sku || fnsku || asin || nv(row.order_id) || nv(row.tracking_number));
  const evidence: V2Candidate["evidence_status"] = typed ? "partial" : "missing";
  const blockers: string[] = ["product_identity_unresolved", "shipment_row_requires_typed_columns_or_raw_parse"];
  if (!typed) blockers.push("raw_row_only_or_unenriched_shipment");
  if (!storeId) blockers.push("nullable_store_policy_review");
  const confidence = typed ? 0.42 : 0.2;
  return {
    organization_id: org,
    store_id: storeId,
    source_table: "amazon_removal_shipments",
    source_row_id: id,
    claim_family: "AMAZON_REMOVAL_SHIPMENTS",
    claim_reason: claimReason,
    evidence_status: evidence,
    confidence_score: confidence,
    sku,
    asin,
    fnsku,
    product_id: null,
    resolved_product_id: null,
    generator_version: GENERATOR_VERSION,
    idempotency_key: idempotencyKey(org, "amazon_removal_shipments", id, claimReason),
    generated_by: "dry_run",
    source_run_id: null,
    upload_id: nv(row.upload_id),
    blocker_reasons: blockers,
    recommended_action: "enrich_shipment_line_then_reassess_evidence",
  };
}

async function fetchAllPaged(
  sb: SupabaseClient,
  table: string,
  orgId: string | null,
  maxRows: number | null,
): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  let from = 0;
  for (;;) {
    let q = sb.from(table).select("*").order("id", { ascending: true }).range(from, from + PAGE - 1);
    if (orgId) q = q.eq("organization_id", orgId);
    const { data, error } = await q;
    if (error) throw new Error(`${table}: ${error.message}`);
    const batch = (data ?? []) as Record<string, unknown>[];
    out.push(...batch);
    if (batch.length < PAGE) break;
    from += PAGE;
    if (maxRows != null && out.length >= maxRows) return out.slice(0, maxRows);
  }
  return maxRows != null ? out.slice(0, maxRows) : out;
}

async function fetchLegacyCandidates(sb: SupabaseClient, orgId: string | null): Promise<Record<string, unknown>[]> {
  const tables = ["amazon_returns", "amazon_removals", "amazon_removal_shipments"];
  const out: Record<string, unknown>[] = [];
  let from = 0;
  for (;;) {
    let q = sb
      .from("claim_candidates")
      .select("id, organization_id, store_id, source_table, source_row_id, claim_family, claim_reason, evidence_status")
      .in("source_table", tables)
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (orgId) q = q.eq("organization_id", orgId);
    const { data, error } = await q;
    if (error) throw new Error(`claim_candidates: ${error.message}`);
    const batch = (data ?? []) as Record<string, unknown>[];
    out.push(...batch);
    if (batch.length < PAGE) break;
    from += PAGE;
  }
  return out;
}

function legacyKey(org: string | null, st: string | null, sid: string | null): string | null {
  if (!org || !st || !sid) return null;
  return `${org.toLowerCase()}|${st.toLowerCase()}|${sid}`;
}

function v2PointerKey(c: V2Candidate): string {
  return `${c.organization_id.toLowerCase()}|${c.source_table.toLowerCase()}|${c.source_row_id}`;
}

function v2FullKey(c: V2Candidate): string {
  return `${c.organization_id.toLowerCase()}|${c.source_table.toLowerCase()}|${c.source_row_id}|${c.claim_reason}`;
}

async function prefetchLegacyStrict(
  sb: SupabaseClient,
  legacy: Record<string, unknown>[],
  trace: (m: string) => void,
): Promise<Map<string, boolean>> {
  const keySet = new Map<string, boolean>();
  const byOrg = new Map<string, Record<string, unknown>[]>();
  for (const c of legacy) {
    const org = nv(c.organization_id);
    const st = nv(c.source_table)?.toLowerCase() ?? "";
    const sid = nv(c.source_row_id);
    if (!org || !st || !sid || !CLAIM_SUPPORTED_SOURCE_TABLES.has(st)) continue;
    if (!byOrg.has(org)) byOrg.set(org, []);
    byOrg.get(org)!.push(c);
  }
  for (const [org, rows] of byOrg) {
    const byTable = new Map<string, Set<string>>();
    for (const c of rows) {
      const st = nv(c.source_table)?.toLowerCase() ?? "";
      const sid = nv(c.source_row_id);
      if (!st || !sid) continue;
      if (!byTable.has(st)) byTable.set(st, new Set());
      byTable.get(st)!.add(sid);
    }
    for (const [tbl, idSet] of byTable) {
      const ids = [...idSet];
      for (let i = 0; i < ids.length; i += SOURCE_FETCH_CHUNK) {
        const slice = ids.slice(i, i + SOURCE_FETCH_CHUNK);
        const { map, error } = await fetchSourceRowsByIds(sb, tbl, slice, org);
        if (error) {
          trace(`fetchSourceRowsByIds ${tbl}: ${error}`);
          continue;
        }
        for (const sid of slice) {
          const row = map.get(sid);
          const k = `${org}|${tbl}|${sid}`;
          if (!row) keySet.set(k, false);
          else keySet.set(k, nv(row.organization_id) === org);
        }
      }
    }
  }
  return keySet;
}

async function evidenceProbeReturns(
  sb: SupabaseClient,
  candidates: V2Candidate[],
  orgId: string | null,
  trace: (m: string) => void,
): Promise<void> {
  const returnsCands = candidates.filter((c) => c.source_table === "amazon_returns");
  const byPk = new Map<string, V2Candidate>();
  for (const c of returnsCands) byPk.set(c.source_row_id, c);
  const ids = [...byPk.keys()];
  for (let i = 0; i < ids.length; i += SOURCE_FETCH_CHUNK) {
    const slice = ids.slice(i, i + SOURCE_FETCH_CHUNK);
    let q = sb.from("amazon_returns").select("id, return_id, returns_id, organization_id").in("id", slice);
    if (orgId) q = q.eq("organization_id", orgId);
    const { data, error } = await q;
    if (error) {
      trace(`evidence_probe amazon_returns: ${error.message}`);
      return;
    }
    const returnIds = new Set<string>();
    const pkToReturn = new Map<string, string>();
    for (const r of (data ?? []) as Record<string, unknown>[]) {
      const pk = nv(r.id);
      const rid = nv(r.return_id) ?? nv(r.returns_id);
      if (pk && rid) {
        pkToReturn.set(pk, rid);
        returnIds.add(rid);
      }
    }
    const returnList = [...returnIds];
    const withPackage = new Set<string>();
    for (let j = 0; j < returnList.length; j += SOURCE_FETCH_CHUNK) {
      const rslice = returnList.slice(j, j + SOURCE_FETCH_CHUNK);
      let q2 = sb.from("return_items").select("id, package_id").in("id", rslice);
      if (orgId) q2 = q2.eq("organization_id", orgId);
      const r2 = await q2;
      if (r2.error) {
        trace(`evidence_probe returns: ${r2.error.message}`);
        continue;
      }
      for (const row of (r2.data ?? []) as Record<string, unknown>[]) {
        const id = nv(row.id);
        if (id && nv(row.package_id)) withPackage.add(id);
      }
    }
    for (const [pk, cand] of byPk) {
      const rid = pkToReturn.get(pk);
      if (!rid) continue;
      if (withPackage.has(rid)) {
        cand.evidence_status = "complete";
        cand.confidence_score = Math.min(0.85, cand.confidence_score + 0.2);
        cand.blocker_reasons = cand.blocker_reasons.filter((b) => b !== "missing_return_lineage_for_evidence");
        cand.recommended_action = "operator_review_package_evidence_then_submit_gate";
      }
    }
  }
}

function parseArgs(argv: string[]): { orgId: string | null; maxPerTable: number | null; evidenceProbe: boolean } {
  let orgId: string | null = null;
  let maxPerTable: number | null = null;
  let evidenceProbe = false;
  for (const a of argv) {
    if (a.startsWith("--org-id=")) orgId = a.slice("--org-id=".length).trim() || null;
    if (a.startsWith("--organization-id=")) orgId = a.slice("--organization-id=".length).trim() || null;
    if (a.startsWith("--limit-per-table=")) {
      const n = parseInt(a.slice("--limit-per-table=".length), 10);
      maxPerTable = Number.isFinite(n) && n > 0 ? n : null;
    }
    if (a === "--evidence-probe") evidenceProbe = true;
  }
  return { orgId, maxPerTable, evidenceProbe };
}

function bump(m: Map<string, number>, k: string, n = 1): void {
  m.set(k, (m.get(k) ?? 0) + n);
}

async function main(): Promise<void> {
  loadEnvLocal();
  const { orgId, maxPerTable, evidenceProbe } = parseArgs(process.argv.slice(2));
  const sb = createServiceClient();
  const runId = mkRunId();
  const outDir = mkRunDir(path.join(".cursor", "audit-reports", "claim-inbox-audit-07"), runId);
  const logPath = path.join(outDir, "logs", "claim-inbox-audit-07.ndjson");
  const trace = (msg: string, extra?: Record<string, unknown>) => {
    fs.appendFileSync(logPath, JSON.stringify({ ts: new Date().toISOString(), msg, ...extra }) + "\n", "utf8");
  };

  trace("start", { runId, orgId, maxPerTable, evidenceProbe });

  const [rowsRet, rowsRm, rowsShip] = await Promise.all([
    fetchAllPaged(sb, "amazon_returns", orgId, maxPerTable),
    fetchAllPaged(sb, "amazon_removals", orgId, maxPerTable),
    fetchAllPaged(sb, "amazon_removal_shipments", orgId, maxPerTable),
  ]);
  trace("source_rows", { amazon_returns: rowsRet.length, amazon_removals: rowsRm.length, amazon_removal_shipments: rowsShip.length });

  const v2: V2Candidate[] = [];
  for (const r of rowsRet) {
    const c = buildFromAmazonReturn(r);
    if (c) v2.push(c);
  }
  for (const r of rowsRm) {
    const c = buildFromAmazonRemoval(r);
    if (c) v2.push(c);
  }
  for (const r of rowsShip) {
    const c = buildFromRemovalShipment(r);
    if (c) v2.push(c);
  }

  if (evidenceProbe) {
    await evidenceProbeReturns(sb, v2, orgId, trace);
    trace("evidence_probe_done");
  }

  const ndPath = path.join(outDir, "v2-candidates.ndjson");
  fs.writeFileSync(ndPath, v2.map((c) => JSON.stringify(c)).join("\n") + (v2.length ? "\n" : ""), "utf8");

  const csvHeaders = [
    "organization_id",
    "store_id",
    "source_table",
    "source_row_id",
    "claim_family",
    "claim_reason",
    "evidence_status",
    "confidence_score",
    "sku",
    "asin",
    "fnsku",
    "product_id",
    "resolved_product_id",
    "generator_version",
    "idempotency_key",
    "generated_by",
    "source_run_id",
    "upload_id",
    "blocker_reasons",
    "recommended_action",
  ] as const;
  writeCsv(
    path.join(outDir, "v2-candidates.csv"),
    csvHeaders,
    v2.map(
      (c): Record<string, unknown> => ({
        organization_id: c.organization_id,
        store_id: c.store_id,
        source_table: c.source_table,
        source_row_id: c.source_row_id,
        claim_family: c.claim_family,
        claim_reason: c.claim_reason,
        evidence_status: c.evidence_status,
        confidence_score: c.confidence_score,
        sku: c.sku,
        asin: c.asin,
        fnsku: c.fnsku,
        product_id: c.product_id,
        resolved_product_id: c.resolved_product_id,
        generator_version: c.generator_version,
        idempotency_key: c.idempotency_key,
        generated_by: c.generated_by,
        source_run_id: c.source_run_id,
        upload_id: c.upload_id,
        blocker_reasons: JSON.stringify(c.blocker_reasons),
        recommended_action: c.recommended_action,
      }),
    ),
  );

  const legacy = await fetchLegacyCandidates(sb, orgId);
  trace("legacy_rows", { count: legacy.length });
  const strictMap = await prefetchLegacyStrict(sb, legacy, trace);

  const v2PointerSet = new Set(v2.map(v2PointerKey));
  const v2FullSet = new Set(v2.map(v2FullKey));
  const legacyPointerSet = new Set<string>();
  const legacyFullSet = new Set<string>();
  let legacyBroken = 0;
  for (const row of legacy) {
    const org = nv(row.organization_id);
    const st = nv(row.source_table);
    const sid = nv(row.source_row_id);
    const pk = legacyKey(org, st, sid);
    if (pk) legacyPointerSet.add(pk);
    const lf = org && st && sid ? `${org.toLowerCase()}|${st.toLowerCase()}|${sid}|${nv(row.claim_reason) ?? ""}` : null;
    if (lf) legacyFullSet.add(lf);
    if (org && st && sid) {
      const sk = `${org}|${st.toLowerCase()}|${sid}`;
      const ok = strictMap.get(sk);
      if (ok === false || ok === undefined) {
        if (ok === false) legacyBroken++;
      }
    }
  }

  let matchingPointer = 0;
  let v2OnlyPointer = 0;
  let legacyOnlyPointer = 0;
  for (const k of v2PointerSet) if (legacyPointerSet.has(k)) matchingPointer++;
  for (const k of v2PointerSet) if (!legacyPointerSet.has(k)) v2OnlyPointer++;
  for (const k of legacyPointerSet) if (!v2PointerSet.has(k)) legacyOnlyPointer++;

  let overlapFull = 0;
  for (const k of v2FullSet) if (legacyFullSet.has(k)) overlapFull++;

  const byFamily = new Map<string, number>();
  const byEvidence = new Map<string, number>();
  for (const c of v2) {
    bump(byFamily, c.source_table);
    bump(byEvidence, c.evidence_status);
  }

  const evidenceMissing = v2.filter((c) => c.evidence_status === "missing").length;
  const productUnresolved = v2.filter((c) => !c.product_id && !c.resolved_product_id).length;
  const blockedEvidenceOrProduct = v2.filter(
    (c) => c.evidence_status === "missing" || c.blocker_reasons.includes("product_identity_unresolved"),
  ).length;
  const v2WouldNotRegenerateBrokenLegacy = legacyBroken;

  /** Staging DDL design can proceed once the dry-run emits rows; blockers are expected for triage. */
  const stagingReady = v2.length > 0;

  fs.writeFileSync(
    path.join(outDir, "manifest.json"),
    JSON.stringify(
      {
        auditPrompt: "CLAIM-INBOX-AUDIT-07",
        runId,
        generator_version: GENERATOR_VERSION,
        constraints: {
          db_writes: false,
          insert_claim_candidates: false,
          migrations: false,
        },
        cli: { orgId, maxPerTable, evidenceProbe },
        counts: {
          v2_candidate_count: v2.length,
          by_source_table: Object.fromEntries(byFamily),
          legacy_subset_rows: legacy.length,
          overlap_by_pointer_org_table_source_row: matchingPointer,
          overlap_by_full_key_including_legacy_claim_reason: overlapFull,
          v2_only_pointer: v2OnlyPointer,
          legacy_only_pointer: legacyOnlyPointer,
          broken_legacy_strict_source_miss: legacyBroken,
          evidence_status_missing: evidenceMissing,
          product_id_and_resolved_unresolved: productUnresolved,
          v2_flagged_missing_evidence_or_product_blocker: blockedEvidenceOrProduct,
        },
        staging_table_design_ready: stagingReady,
        artifacts: [
          "manifest.json",
          "v2-generator-summary.md",
          "v2-candidates.ndjson",
          "v2-candidates.csv",
          "legacy-vs-v2-comparison.md",
          "source-family-counts.md",
          "evidence-status-distribution.md",
          "product-identity-dependency.md",
          "blocker-reasons.md",
          "next-step-recommendation.md",
          "logs/claim-inbox-audit-07.ndjson",
        ],
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );

  const blockerHist = new Map<string, number>();
  for (const c of v2) for (const b of c.blocker_reasons) bump(blockerHist, b);

  const writeMd = (name: string, body: string) => fs.writeFileSync(path.join(outDir, name), body, "utf8");

  writeMd(
    "v2-generator-summary.md",
    `<!-- markdownlint-disable MD013 MD060 MD012 -->

# V2 generator dry-run summary — CLAIM-INBOX-AUDIT-07

**Run ID:** \`${runId}\`  
**Generator:** \`${GENERATOR_VERSION}\`  
**Org filter:** ${orgId ?? "(none — all tenants)"}  
**Limit per table:** ${maxPerTable ?? "(none)"}  
**Evidence probe:** ${evidenceProbe ? "on (returns → returns.package_id)" : "off"}

## Counts

| Metric | Value |
|--------|------:|
| **v2 candidate rows emitted** | **${v2.length}** |
| Legacy \`claim_candidates\` (3 source tables only) | ${legacy.length} |
| Overlap (same org + source_table + source_row_id) | ${matchingPointer} |
| Overlap (full key incl. legacy claim_reason string) | ${overlapFull} |
| v2-only pointers | ${v2OnlyPointer} |
| Legacy-only pointers | ${legacyOnlyPointer} |
| Broken legacy (strict source row miss) | ${legacyBroken} |
| v2 \`evidence_status = missing\` | ${evidenceMissing} |
| v2 unresolved product (both null) | ${productUnresolved} |
| v2 rows with missing evidence **or** product blocker | ${blockedEvidenceOrProduct} |

## Interpretation

- v2 rows are **triage-only**; they do **not** assert payable claims.
- Legacy cohort was **manual / ad-hoc SQL** per operator note — v2 uses **deterministic heuristics** from operational tables only.
- **Staging table design:** ${stagingReady ? "READY — define staging table + idempotency unique index (migration is a separate prompt; not executed here)" : "NOT READY — no v2 rows emitted (empty source tables or query failure)"}

`,
  );

  writeMd(
    "legacy-vs-v2-comparison.md",
    `<!-- markdownlint-disable MD013 MD060 MD012 -->

# Legacy vs v2 comparison — CLAIM-INBOX-AUDIT-07

**Run:** \`${runId}\`

## Overlap definitions

| Match | Definition |
|-------|------------|
| **Pointer overlap** | Same org + source_table + source_row_id (legacy claim_family often null). |
| **Full key overlap** | Pointer + same claim_reason as legacy (often 0 when legacy claim_reason unset). |

## Counts

| Bucket | Count |
|--------|------:|
| Matching (pointer) | ${matchingPointer} |
| v2-only | ${v2OnlyPointer} |
| Legacy-only | ${legacyOnlyPointer} |
| Broken legacy (v2 would not emit for missing source) | ${v2WouldNotRegenerateBrokenLegacy} |

## Notes

- **Legacy-only** rows point at operational keys no longer present (or org mismatch) — **do not auto-delete**; triage separately.
- **v2-only** rows are operational lines with no legacy candidate — backlog for controlled generator insert **later**.

`,
  );

  writeMd(
    "source-family-counts.md",
    `<!-- markdownlint-disable MD013 MD060 MD055 MD012 -->

# Source family counts — v2 dry-run

| source_table | v2 rows |
|--------------|--------:|
${[...byFamily.entries()].map(([k, v]) => `| \`${k}\` | ${v} |`).join("\n")}

`,
  );

  writeMd(
    "evidence-status-distribution.md",
    `<!-- markdownlint-disable MD013 MD060 MD055 MD012 -->

# Evidence status distribution — v2 dry-run

| evidence_status | count |
|-----------------|------:|
${[...byEvidence.entries()].map(([k, v]) => `| \`${k}\` | ${v} |`).join("\n")}

`,
  );

  writeMd(
    "product-identity-dependency.md",
    `<!-- markdownlint-disable MD013 MD060 MD012 -->

# Product identity dependency — v2 dry-run

All v2 rows intentionally leave \`product_id\` and \`resolved_product_id\` **NULL** in this dry-run (resolver gates / NEXT-PRODUCT-ID-08 not applied here).

| Metric | Count |
|--------|------:|
| Rows with both null | ${productUnresolved} |
| Total v2 | ${v2.length} |

**Next:** wire optional resolver pass **read-only** before any staging insert proposal.

`,
  );

  writeMd(
    "blocker-reasons.md",
    `<!-- markdownlint-disable MD013 MD060 MD055 MD012 -->

# Blocker reasons — v2 dry-run

Histogram of \`blocker_reasons[]\` values (multi-count per row).

| blocker | count |
|---------|------:|
${[...blockerHist.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `| \`${k}\` | ${v} |`).join("\n")}

`,
  );

  writeMd(
    "next-step-recommendation.md",
    `<!-- markdownlint-disable MD013 MD012 -->

# Next step — CLAIM-INBOX-AUDIT-07

1. Review \`v2-candidates.csv\` / \`v2-candidates.ndjson\` for false positives.
2. Lock \`claim_family\` / \`claim_reason\` vocabulary with finance/ops (heuristic disposition codes here).
3. Draft **staging table** DDL + unique index on \`idempotency_key\` (separate migration prompt — **not** executed here).
4. Optional: re-run with \`--evidence-probe\` to upgrade returns evidence where \`returns.package_id\` exists.
5. Do **not** delete legacy \`claim_candidates\` until v2 pipeline is validated side-by-side (CLAIM-INBOX-AUDIT-06).

`,
  );

  trace("complete", { v2: v2.length, outDir });
  console.log(`CLAIM-INBOX-AUDIT-07 complete → ${outDir}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
