/**
 * NEXT-CLAIM-21 — Read-only dry-run: current-source amazon_removals → claim_candidate_drafts shape.
 *
 *   npx tsx scripts/claim21-removals-current-source-dryrun.ts --org-id=<uuid>
 *   npx tsx scripts/claim21-removals-current-source-dryrun.ts --org-id=<uuid> --limit-removals=5000
 *   npx tsx scripts/claim21-removals-current-source-dryrun.ts --org-id=<uuid> --run-id=customRunId
 *
 * SELECT only against Supabase. Writes local files under:
 *   .cursor/audit-reports/next-claim-21/<run_id>/
 *
 * Does NOT insert claim_candidate_drafts, claim_candidates, or repair source_row_id.
 *
 * Candidate shape must stay aligned with `buildFromAmazonRemoval` in
 * `scripts/claim-v2-candidate-generator-dryrun.ts`.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { fetchSourceRowsByIds } from "../lib/claim-inbox-projection";
import { CLAIM_SUPPORTED_SOURCE_TABLES } from "../lib/claim-operational-source-resolve";
import { removalAmazonRemovalsBusinessDedupKey } from "../lib/pipeline/amazon-removals-business-key";
import { isUuidString } from "../lib/uuid";

const SCRIPT_VERSION = "claim21-readonly-v1";
const PAGE = 800;
const SOURCE_FETCH_CHUNK = 200;
const SAMPLE_NDJSON = 150;

/** Keep aligned with claim-v2-candidate-generator-dryrun.ts GENERATOR_VERSION for shape comparison. */
const SHAPE_REFERENCE_VERSION = "0.1.0-dryrun";

type V2RemovalCandidate = {
  organization_id: string;
  store_id: string | null;
  source_table: "amazon_removals";
  source_row_id: string;
  claim_family: "AMAZON_REMOVALS";
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

const TERMINAL_DRAFT_LIFECYCLES = new Set(["archived", "rejected", "promoted_to_claim_candidates"]);

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

function removalsClaimReason(row: Record<string, unknown>): string {
  const d = nv(row.disposition) ?? nv(row.removal_disposition);
  return dispositionClaimReason(d, nv(row.detailed_disposition));
}

/** Mirror of `buildFromAmazonRemoval` in claim-v2-candidate-generator-dryrun.ts */
function buildFromAmazonRemoval(row: Record<string, unknown>): V2RemovalCandidate | null {
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
  const evidence: V2RemovalCandidate["evidence_status"] = sku || fnsku || asin ? "partial" : "missing";
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
    generator_version: SHAPE_REFERENCE_VERSION,
    idempotency_key: idempotencyKey(org, "amazon_removals", id, claimReason),
    generated_by: "dry_run",
    source_run_id: null,
    upload_id: nv(row.upload_id),
    blocker_reasons: blockers,
    recommended_action: "verify_removal_disposition_and_shipment_bridge",
  };
}

function isoRunId(d = new Date()): string {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

async function columnAvailable(client: SupabaseClient, table: string, column: string, orgId: string): Promise<boolean> {
  const { error } = await client.from(table).select(`id, ${column}`).eq("organization_id", orgId).limit(1);
  return !error;
}

async function buildRemovalSelect(client: SupabaseClient, orgId: string): Promise<string> {
  const base = [
    "id",
    "organization_id",
    "store_id",
    "upload_id",
    "order_id",
    "sku",
    "fnsku",
    "disposition",
    "requested_quantity",
    "shipped_quantity",
    "disposed_quantity",
    "cancelled_quantity",
    "order_date",
    "order_type",
  ];
  const optional = ["removal_disposition", "detailed_disposition", "asin"] as const;
  for (const col of optional) {
    if (await columnAvailable(client, "amazon_removals", col, orgId)) base.push(col);
  }
  return base.join(", ");
}

async function buildClaimCandidatesSelect(client: SupabaseClient, orgId: string): Promise<string> {
  const base = ["id", "organization_id", "store_id", "source_table", "source_row_id", "claim_reason", "sku", "fnsku", "asin"];
  const optional = [
    "order_id",
    "disposition",
    "requested_quantity",
    "shipped_quantity",
    "disposed_quantity",
    "cancelled_quantity",
    "order_date",
    "order_type",
  ];
  const cols = [...base];
  for (const col of optional) {
    if (await columnAvailable(client, "claim_candidates", col, orgId)) cols.push(col);
  }
  return cols.join(", ");
}

async function fetchAllRemovals(
  client: SupabaseClient,
  orgId: string,
  select: string,
  maxRows: number | null,
): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  let from = 0;
  for (;;) {
    let q = client
      .from("amazon_removals")
      .select(select)
      .eq("organization_id", orgId)
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);
    const { data, error } = await q;
    if (error) throw new Error(`amazon_removals: ${error.message}`);
    const batch = (data ?? []) as unknown as Record<string, unknown>[];
    out.push(...batch);
    if (batch.length < PAGE) break;
    from += PAGE;
    if (maxRows != null && out.length >= maxRows) return out.slice(0, maxRows);
  }
  return maxRows != null ? out.slice(0, maxRows) : out;
}

async function fetchAllDraftIdempotency(
  client: SupabaseClient,
  orgId: string,
): Promise<Map<string, { lifecycle_status: string; draft_id: string }>> {
  const map = new Map<string, { lifecycle_status: string; draft_id: string }>();
  let from = 0;
  for (;;) {
    const { data, error } = await client
      .from("claim_candidate_drafts")
      .select("id, idempotency_key, lifecycle_status")
      .eq("organization_id", orgId)
      .eq("source_table", "amazon_removals")
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`claim_candidate_drafts: ${error.message}`);
    const batch = (data ?? []) as unknown as Record<string, unknown>[];
    for (const row of batch) {
      const idem = nv(row.idempotency_key);
      const id = nv(row.id);
      const ls = nv(row.lifecycle_status) ?? "";
      if (idem && id) map.set(idem, { lifecycle_status: ls, draft_id: id });
    }
    if (batch.length < PAGE) break;
    from += PAGE;
  }
  return map;
}

async function fetchLegacyRemovalsCandidates(
  client: SupabaseClient,
  orgId: string,
  select: string,
): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  let from = 0;
  for (;;) {
    const { data, error } = await client
      .from("claim_candidates")
      .select(select)
      .eq("organization_id", orgId)
      .ilike("source_table", "amazon_removals")
      .not("source_row_id", "is", null)
      .order("created_at", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`claim_candidates: ${error.message}`);
    const batch = (data ?? []) as unknown as Record<string, unknown>[];
    out.push(...batch);
    if (batch.length < PAGE) break;
    from += PAGE;
  }
  return out;
}

function legacyKey(org: string, st: string, sid: string): string {
  return `${org.toLowerCase()}|${st.toLowerCase()}|${sid}`;
}

async function prefetchLegacyStrictRemovals(
  client: SupabaseClient,
  legacy: Record<string, unknown>[],
): Promise<Map<string, boolean>> {
  const keySet = new Map<string, boolean>();
  const byOrg = new Map<string, Record<string, unknown>[]>();
  for (const c of legacy) {
    const org = nv(c.organization_id);
    const st = nv(c.source_table)?.toLowerCase() ?? "";
    const sid = nv(c.source_row_id);
    if (!org || !st || !sid || st !== "amazon_removals" || !CLAIM_SUPPORTED_SOURCE_TABLES.has(st)) continue;
    if (!byOrg.has(org)) byOrg.set(org, []);
    byOrg.get(org)!.push(c);
  }
  for (const [org, rows] of byOrg) {
    const ids = [...new Set(rows.map((r) => nv(r.source_row_id)).filter(Boolean))] as string[];
    for (let i = 0; i < ids.length; i += SOURCE_FETCH_CHUNK) {
      const slice = ids.slice(i, i + SOURCE_FETCH_CHUNK);
      const { map, error } = await fetchSourceRowsByIds(client, "amazon_removals", slice, org);
      if (error) continue;
      for (const sid of slice) {
        const row = map.get(sid);
        const k = `${org}|amazon_removals|${sid}`;
        if (!row) keySet.set(k, false);
        else keySet.set(k, nv(row.organization_id) === org);
      }
    }
  }
  return keySet;
}

function v2FullKey(c: V2RemovalCandidate): string {
  return `${c.organization_id.toLowerCase()}|${c.source_table.toLowerCase()}|${c.source_row_id}|${c.claim_reason}`;
}

function parseArgs(argv: string[]): { orgId: string | null; limitRemovals: number | null; runId: string | null } {
  let orgId: string | null = null;
  let limitRemovals: number | null = null;
  let runId: string | null = null;
  for (const a of argv) {
    if (a.startsWith("--org-id=")) orgId = a.slice("--org-id=".length).trim() || null;
    if (a.startsWith("--organization-id=")) orgId = a.slice("--organization-id=".length).trim() || null;
    if (a.startsWith("--limit-removals=")) {
      const n = parseInt(a.slice("--limit-removals=".length), 10);
      limitRemovals = Number.isFinite(n) && n > 0 ? n : null;
    }
    if (a.startsWith("--run-id=")) runId = a.slice("--run-id=".length).trim() || null;
  }
  return { orgId, limitRemovals, runId };
}

async function main(): Promise<void> {
  loadEnvLocal();
  const { orgId, limitRemovals, runId: runIdArg } = parseArgs(process.argv.slice(2));
  if (!orgId || !isUuidString(orgId)) {
    console.error("Required: --org-id=<uuid> (or --organization-id=<uuid>).");
    process.exitCode = 1;
    return;
  }

  const runId = runIdArg ?? isoRunId();
  const outDir = path.resolve(process.cwd(), ".cursor", "audit-reports", "next-claim-21", runId);
  fs.mkdirSync(path.join(outDir, "logs"), { recursive: true });

  const client = createServiceClient();
  const [removalSelect, claimSelect] = await Promise.all([
    buildRemovalSelect(client, orgId),
    buildClaimCandidatesSelect(client, orgId),
  ]);

  const removals = await fetchAllRemovals(client, orgId, removalSelect, limitRemovals);
  const draftsByIdem = await fetchAllDraftIdempotency(client, orgId);
  const legacy = await fetchLegacyRemovalsCandidates(client, orgId, claimSelect);
  const strictMap = await prefetchLegacyStrictRemovals(client, legacy);

  let legacyBroken = 0;
  let legacyCurrent = 0;
  const legacyFullKeys = new Set<string>();
  const legacyBrokenByBizKey = new Map<string, string[]>();

  for (const row of legacy) {
    const org = nv(row.organization_id);
    const sid = nv(row.source_row_id);
    const cr = nv(row.claim_reason) ?? "";
    if (org && sid) {
      legacyFullKeys.add(`${org.toLowerCase()}|amazon_removals|${sid}|${cr}`);
      const sk = `${org}|amazon_removals|${sid}`;
      const ok = strictMap.get(sk);
      if (ok === true) legacyCurrent++;
      else if (ok === false) {
        legacyBroken++;
        const bk = removalAmazonRemovalsBusinessDedupKey(row);
        const list = legacyBrokenByBizKey.get(bk) ?? [];
        list.push(nv(row.id) ?? "?");
        legacyBrokenByBizKey.set(bk, list);
      }
    }
  }

  const liveBizKeyToIds = new Map<string, string[]>();
  const candidates: V2RemovalCandidate[] = [];
  for (const r of removals) {
    const c = buildFromAmazonRemoval(r);
    if (c) candidates.push(c);
    const id = nv(r.id);
    if (id) {
      const bk = removalAmazonRemovalsBusinessDedupKey(r);
      const arr = liveBizKeyToIds.get(bk) ?? [];
      arr.push(id);
      liveBizKeyToIds.set(bk, arr);
    }
  }

  let liveDuplicateBizKeys = 0;
  for (const ids of liveBizKeyToIds.values()) {
    if (ids.length > 1) liveDuplicateBizKeys++;
  }

  let wouldInsert = 0;
  let skipExistingDraft = 0;
  let skipDraftTerminal = 0;
  let skipDraftActive = 0;
  let overlapFullWithLegacy = 0;
  let legacyBrokenSameBizKeyAsLive = 0;
  const matchedBrokenCandidateIds = new Set<string>();

  const rowCsvLines: string[] = [
    "amazon_removals_id,idempotency_key,dry_run_outcome,draft_lifecycle_if_conflict,legacy_full_key_overlap,biz_key_duplicate_on_live",
  ];

  const samplePath = path.join(outDir, "03-sample-would-insert.ndjson");
  const sampleStream = fs.createWriteStream(samplePath, { encoding: "utf8" });
  let sampleWritten = 0;

  for (const c of candidates) {
    const removalRow = removals.find((x) => nv(x.id) === c.source_row_id) ?? {};
    const bizKey = removalAmazonRemovalsBusinessDedupKey(removalRow);
    const dupLive = (liveBizKeyToIds.get(bizKey) ?? []).length > 1;

    const draftHit = draftsByIdem.get(c.idempotency_key);
    const legacyHit = legacyFullKeys.has(v2FullKey(c));

    if (legacyHit) overlapFullWithLegacy++;

    const brokenIds = legacyBrokenByBizKey.get(bizKey);
    if (brokenIds?.length) {
      legacyBrokenSameBizKeyAsLive++;
      for (const bid of brokenIds) matchedBrokenCandidateIds.add(bid);
    }

    let outcome: string;
    if (draftHit) {
      skipExistingDraft++;
      if (TERMINAL_DRAFT_LIFECYCLES.has(draftHit.lifecycle_status)) skipDraftTerminal++;
      else skipDraftActive++;
      outcome = "skip_existing_draft_idempotency";
    } else {
      wouldInsert++;
      outcome = "would_insert_new_draft";
      if (sampleWritten < SAMPLE_NDJSON) {
        sampleStream.write(
          JSON.stringify({
            ...c,
            _claim21: {
              line: "current_source_regeneration_dry_run",
              dry_run_outcome: outcome,
              business_dedup_key: bizKey,
              biz_key_duplicate_on_live: dupLive,
            },
          }) + "\n",
        );
        sampleWritten++;
      }
    }

    rowCsvLines.push(
      [
        c.source_row_id,
        c.idempotency_key,
        outcome,
        draftHit?.lifecycle_status ?? "",
        legacyHit ? "yes" : "no",
        dupLive ? "yes" : "no",
      ]
        .map((x) => (x.includes(",") ? `"${x.replace(/"/g, '""')}"` : x))
        .join(","),
    );
  }

  sampleStream.end();

  const summary = {
    prompt_name: "NEXT-CLAIM-21",
    run_id: runId,
    generated_at_utc: new Date().toISOString(),
    script_version: SCRIPT_VERSION,
    organization_id: orgId,
    output_directory: path.relative(process.cwd(), outDir).replace(/\\/g, "/"),
    selects: { amazon_removals: removalSelect, claim_candidates: claimSelect },
    counts: {
      amazon_removals_rows_scanned: removals.length,
      synthetic_v2_candidates: candidates.length,
      would_insert_new_draft: wouldInsert,
      skip_existing_draft_idempotency: skipExistingDraft,
      skip_conflict_draft_lifecycle_terminal: skipDraftTerminal,
      skip_conflict_draft_lifecycle_active: skipDraftActive,
      existing_draft_rows_total: draftsByIdem.size,
      legacy_claim_candidates_removals: legacy.length,
      legacy_lineage_current_strict: legacyCurrent,
      legacy_lineage_broken_strict: legacyBroken,
      overlap_full_key_with_legacy_candidate: overlapFullWithLegacy,
      live_business_key_buckets_with_duplicate_ids: liveDuplicateBizKeys,
      live_rows_matching_biz_key_of_at_least_one_broken_legacy: legacyBrokenSameBizKeyAsLive,
      distinct_broken_legacy_candidates_with_biz_key_match_to_live: matchedBrokenCandidateIds.size,
    },
    shape_reference: {
      aligned_with_script: "scripts/claim-v2-candidate-generator-dryrun.ts",
      generator_version_field: SHAPE_REFERENCE_VERSION,
    },
  };

  fs.writeFileSync(path.join(outDir, "00-dryrun-summary.json"), JSON.stringify(summary, null, 2), "utf8");
  fs.writeFileSync(
    path.join(outDir, "01-skip-reason-counts.json"),
    JSON.stringify(
      {
        would_insert_new_draft: wouldInsert,
        skip_existing_draft_idempotency: skipExistingDraft,
        breakdown_existing_draft: { terminal_lifecycle: skipDraftTerminal, active_lifecycle: skipDraftActive },
      },
      null,
      2,
    ),
    "utf8",
  );
  fs.writeFileSync(
    path.join(outDir, "02-business-key-report.json"),
    JSON.stringify(
      {
        live_rows: removals.length,
        distinct_business_dedup_keys_on_live: liveBizKeyToIds.size,
        buckets_with_more_than_one_removal_id: liveDuplicateBizKeys,
        broken_legacy_candidates_total: legacyBroken,
        live_rows_whose_biz_key_matches_any_broken_legacy: legacyBrokenSameBizKeyAsLive,
        note: "Business-key match does not prove same physical row; advisory only for regeneration triage.",
      },
      null,
      2,
    ),
    "utf8",
  );
  fs.writeFileSync(path.join(outDir, "04-removals-dryrun-rows.csv"), rowCsvLines.join("\n") + "\n", "utf8");

  const validationMd = `# NEXT-CLAIM-21 validation

| Constraint | Result |
|------------|--------|
| DB writes (INSERT/UPDATE/DELETE) | **none** — SELECT only |
| claim_candidate_drafts created | **no** |
| claim_candidates mutated | **no** |
| source_row_id repair | **no** |
| migrations | **no** |
| external API / AI | **no** |
| Local audit artifacts | **yes** — this directory |

Run: \`${SCRIPT_VERSION}\`  
Org: \`${orgId}\`
`;

  fs.writeFileSync(path.join(outDir, "validation-results.md"), validationMd, "utf8");

  const nextStep = `# Next step

After review of \`00-dryrun-summary.json\` and \`04-removals-dryrun-rows.csv\`:

- **NEXT-CLAIM-22** (future): gated optional execution — load NDJSON via \`scripts/claim-v2-staging-load-audit11.ts\` only with explicit approval, org scope, and post-load verification.

Broken legacy rows remain immutable; regeneration uses **current** \`amazon_removals.id\` only.
`;

  fs.writeFileSync(path.join(outDir, "next-step-recommendation.md"), nextStep, "utf8");

  const manifest = {
    prompt_name: "NEXT-CLAIM-21",
    run_id: runId,
    created_at_utc: new Date().toISOString(),
    mode: "read_only_dry_run",
    output_directory: path.relative(process.cwd(), outDir).replace(/\\/g, "/"),
    script: "scripts/claim21-removals-current-source-dryrun.ts",
    script_version: SCRIPT_VERSION,
    inputs: { organization_id: orgId, limit_removals: limitRemovals },
    artifacts: [
      "00-dryrun-summary.json",
      "01-skip-reason-counts.json",
      "02-business-key-report.json",
      "03-sample-would-insert.ndjson",
      "04-removals-dryrun-rows.csv",
      "validation-results.md",
      "next-step-recommendation.md",
      "manifest.json",
    ],
    validation: {
      db_writes: false,
      claim_candidate_drafts_created: false,
      claim_candidates_mutated: false,
      source_row_id_repairs: false,
      migrations_created: false,
      claim_submissions: false,
      ai_or_external_api_calls: false,
      local_artifacts_only: true,
    },
    upstream: {
      next_claim_17: ".cursor/audit-reports/next-claim-17/claim17-real-org-readonly/",
      next_claim_18: ".cursor/audit-reports/next-claim-18/20260515T070100Z-removals-lineage-review-pack/",
    },
  };
  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");

  console.log(`NEXT-CLAIM-21 complete. Output: ${outDir}`);
  console.log(JSON.stringify(summary.counts, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
