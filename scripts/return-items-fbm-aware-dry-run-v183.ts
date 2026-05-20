/**
 * RETURN-ITEMS-FBM-AWARE-DRY-RUN-V183 — Staging-only proposals (no writes).
 *
 *   npx tsx scripts/return-items-fbm-aware-dry-run-v183.ts --run-id=<id>
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import pg from "pg";

import { resolveScannerProductIdentifiers } from "../lib/scanner-product-resolve";
import { getStagingProjectRef, loadEnvLocalIntoProcess, refFromSupabaseUrl } from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const OUT_BASE = ".cursor/audit-reports/return-items-fbm-aware-dry-run-v183";

type ReturnItemRow = {
  id: string;
  organization_id: string;
  store_id: string | null;
  sku: string | null;
  fnsku: string | null;
  asin: string | null;
  product_id: string | null;
  product_identifier: string | null;
  resolved_product_id: string | null;
  resolved_catalog_product_id: string | null;
  identifier_resolution_status: string | null;
  identifier_resolution_confidence: string | null;
};

type FbmClass = "fba_like" | "fbm_like" | "mixed" | "unresolved_identifier_shape";

type TierUsed = 1 | 2 | 3 | 4 | null;

type ProposalRow = {
  return_item_id: string;
  organization_id: string;
  store_id: string | null;
  fbm_class: FbmClass;
  identifiers: { fnsku: string | null; asin: string | null; sku: string | null; upc_gtin: string | null };
  before: {
    resolved_product_id: string | null;
    resolved_catalog_product_id: string | null;
    identifier_resolution_status: string | null;
    identifier_resolution_confidence: number | null;
  };
  proposed: {
    resolved_product_id: string | null;
    resolved_catalog_product_id: string | null;
    identifier_resolution_status: string | null;
    identifier_resolution_confidence: number | null;
    winning_tier: TierUsed;
    tier_label: string;
  };
  apply_kind: "set_resolved" | "status_only" | "skip_unchanged" | "exclude_ambiguous" | "exclude_no_proposal";
  scanner_resolver_status: string | null;
  scanner_resolver_product_id: string | null;
  policy_aligns_with_scanner: boolean;
  map_candidates_at_winning_tier: number;
  product_exists: boolean;
};

type AmbiguousRow = {
  return_item_id: string;
  tier_attempted: TierUsed;
  reason: string;
  distinct_product_ids: string[];
  map_row_ids: string[];
};

function runIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function n(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

function num(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
}

function classifyRow(row: ReturnItemRow): FbmClass {
  const fnsku = n(row.fnsku);
  const asin = n(row.asin);
  const sku = n(row.sku);
  const pid = n(row.product_identifier);
  if (!fnsku && !asin && !sku && !pid) return "unresolved_identifier_shape";
  if (fnsku && !sku && !asin && !pid) return "fba_like";
  if (!fnsku && (sku || pid)) return "fbm_like";
  if (fnsku && (sku || asin || pid)) return "mixed";
  return "unresolved_identifier_shape";
}

type MapHit = { map_id: string; product_id: string | null; catalog_product_id: string | null };

async function tierFnsku(
  client: pg.Client,
  org: string,
  store: string,
  fnsku: string,
): Promise<{ status: "resolved" | "ambiguous" | "unresolved"; hits: MapHit[] }> {
  const r = await client.query(
    `SELECT id::text AS map_id, product_id::text, catalog_product_id::text
     FROM public.product_identifier_map
     WHERE organization_id = $1::uuid AND store_id = $2::uuid
       AND deleted_at IS NULL AND fnsku = $3`,
    [org, store, fnsku],
  );
  return collapseHits(r.rows as MapHit[]);
}

async function tierAsin(
  client: pg.Client,
  org: string,
  store: string,
  asin: string,
): Promise<{ status: "resolved" | "ambiguous" | "unresolved"; hits: MapHit[] }> {
  const r = await client.query(
    `SELECT id::text AS map_id, product_id::text, catalog_product_id::text
     FROM public.product_identifier_map
     WHERE organization_id = $1::uuid AND store_id = $2::uuid
       AND deleted_at IS NULL AND asin = $3`,
    [org, store, asin],
  );
  return collapseHits(r.rows as MapHit[]);
}

async function tierSku(
  client: pg.Client,
  org: string,
  store: string,
  sku: string,
): Promise<{ status: "resolved" | "ambiguous" | "unresolved"; hits: MapHit[] }> {
  const r = await client.query(
    `SELECT id::text AS map_id, product_id::text, catalog_product_id::text
     FROM public.product_identifier_map
     WHERE organization_id = $1::uuid AND store_id = $2::uuid
       AND deleted_at IS NULL
       AND (seller_sku = $3 OR msku = $3)`,
    [org, store, sku],
  );
  return collapseHits(r.rows as MapHit[]);
}

function collapseHits(rows: MapHit[]): { status: "resolved" | "ambiguous" | "unresolved"; hits: MapHit[] } {
  const withPid = rows.filter((x) => n(x.product_id));
  const pids = [...new Set(withPid.map((x) => n(x.product_id)!))];
  if (pids.length === 0) return { status: "unresolved", hits: [] };
  if (pids.length > 1) return { status: "ambiguous", hits: withPid };
  return { status: "resolved", hits: withPid.filter((x) => n(x.product_id) === pids[0]) };
}

async function resolveByV183Tiers(
  client: pg.Client,
  row: ReturnItemRow,
): Promise<
  | { kind: "resolved"; tier: TierUsed; hit: MapHit; confidence: number }
  | { kind: "ambiguous"; tier: TierUsed; hits: MapHit[] }
  | { kind: "unresolved" }
> {
  const org = row.organization_id;
  const store = n(row.store_id);
  if (!store) return { kind: "unresolved" };

  const fnsku = n(row.fnsku);
  if (fnsku) {
    const t1 = await tierFnsku(client, org, store, fnsku);
    if (t1.status === "resolved") return { kind: "resolved", tier: 1, hit: t1.hits[0]!, confidence: 1 };
    if (t1.status === "ambiguous") return { kind: "ambiguous", tier: 1, hits: t1.hits };
  }

  const asin = n(row.asin);
  if (asin) {
    const t2 = await tierAsin(client, org, store, asin);
    if (t2.status === "resolved") return { kind: "resolved", tier: 2, hit: t2.hits[0]!, confidence: 0.95 };
    if (t2.status === "ambiguous") return { kind: "ambiguous", tier: 2, hits: t2.hits };
  }

  const sku = n(row.sku);
  if (sku) {
    const t3 = await tierSku(client, org, store, sku);
    if (t3.status === "resolved") return { kind: "resolved", tier: 3, hit: t3.hits[0]!, confidence: 0.85 };
    if (t3.status === "ambiguous") return { kind: "ambiguous", tier: 3, hits: t3.hits };
  }

  return { kind: "unresolved" };
}

async function productExists(client: pg.Client, productId: string): Promise<boolean> {
  const r = await client.query(`SELECT 1 FROM public.products WHERE id = $1::uuid LIMIT 1`, [productId]);
  return r.rows.length > 0;
}

async function fetchActiveRows(client: pg.Client): Promise<ReturnItemRow[]> {
  const r = await client.query(
    `SELECT id::text, organization_id::text, store_id::text, sku, fnsku, asin,
            product_id::text, product_identifier,
            resolved_product_id::text, resolved_catalog_product_id::text,
            identifier_resolution_status, identifier_resolution_confidence::text
     FROM public.return_items
     WHERE deleted_at IS NULL
     ORDER BY id`,
  );
  return r.rows as ReturnItemRow[];
}

async function buildProposals(
  pgClient: pg.Client,
  supabase: SupabaseClient,
  rows: ReturnItemRow[],
): Promise<{ proposals: ProposalRow[]; ambiguous: AmbiguousRow[] }> {
  const proposals: ProposalRow[] = [];
  const ambiguous: AmbiguousRow[] = [];

  for (const row of rows) {
    const before = {
      resolved_product_id: n(row.resolved_product_id),
      resolved_catalog_product_id: n(row.resolved_catalog_product_id),
      identifier_resolution_status: n(row.identifier_resolution_status),
      identifier_resolution_confidence: num(row.identifier_resolution_confidence),
    };

    const scanner = await resolveScannerProductIdentifiers(supabase, {
      organizationId: row.organization_id,
      storeId: row.store_id,
      sku: row.sku,
      asin: row.asin,
      fnsku: row.fnsku,
      legacyProductId: row.product_id,
    });

    const tierResult = await resolveByV183Tiers(pgClient, row);

    let proposed = {
      resolved_product_id: null as string | null,
      resolved_catalog_product_id: null as string | null,
      identifier_resolution_status: "unresolved" as string | null,
      identifier_resolution_confidence: null as number | null,
      winning_tier: null as TierUsed,
      tier_label: "unresolved",
    };
    let apply_kind: ProposalRow["apply_kind"] = "exclude_no_proposal";
    let map_candidates = 0;
    let product_exists = false;

    if (tierResult.kind === "ambiguous") {
      const pids = [...new Set(tierResult.hits.map((h) => n(h.product_id)).filter(Boolean))] as string[];
      ambiguous.push({
        return_item_id: row.id,
        tier_attempted: tierResult.tier,
        reason: `multiple distinct product_id at tier ${tierResult.tier}`,
        distinct_product_ids: pids,
        map_row_ids: tierResult.hits.map((h) => h.map_id),
      });
      proposed.identifier_resolution_status = "ambiguous";
      proposed.identifier_resolution_confidence = tierResult.tier === 1 ? 1 : tierResult.tier === 2 ? 0.95 : 0.85;
      apply_kind = "exclude_ambiguous";
    } else if (tierResult.kind === "resolved") {
      const pid = n(tierResult.hit.product_id)!;
      product_exists = await productExists(pgClient, pid);
      map_candidates = tierResult.hit ? 1 : 0;
      proposed = {
        resolved_product_id: product_exists ? pid : null,
        resolved_catalog_product_id: product_exists ? n(tierResult.hit.catalog_product_id) : null,
        identifier_resolution_status: product_exists ? "resolved" : "unresolved",
        identifier_resolution_confidence: tierResult.confidence,
        winning_tier: tierResult.tier,
        tier_label:
          tierResult.tier === 1
            ? "tier_1_fnsku_exact"
            : tierResult.tier === 2
              ? "tier_2_asin_exact_unique"
              : "tier_3_sku_org_store_exact",
      };
      apply_kind = product_exists ? "set_resolved" : "status_only";
    } else {
      proposed.identifier_resolution_status = "unresolved";
      apply_kind = "exclude_no_proposal";
    }

    const unchanged =
      before.resolved_product_id === proposed.resolved_product_id &&
      before.resolved_catalog_product_id === proposed.resolved_catalog_product_id &&
      before.identifier_resolution_status === proposed.identifier_resolution_status &&
      (before.identifier_resolution_confidence ?? null) === (proposed.identifier_resolution_confidence ?? null);

    if (apply_kind === "set_resolved" && unchanged) apply_kind = "skip_unchanged";
    if (apply_kind === "status_only" && unchanged) apply_kind = "skip_unchanged";

    const scannerPid = n(scanner.resolved_product_id);
    const policy_aligns =
      proposed.identifier_resolution_status === scanner.identifier_resolution_status &&
      proposed.resolved_product_id === scannerPid;

    proposals.push({
      return_item_id: row.id,
      organization_id: row.organization_id,
      store_id: n(row.store_id),
      fbm_class: classifyRow(row),
      identifiers: {
        fnsku: n(row.fnsku),
        asin: n(row.asin),
        sku: n(row.sku),
        upc_gtin: null,
      },
      before,
      proposed,
      apply_kind,
      scanner_resolver_status: scanner.identifier_resolution_status,
      scanner_resolver_product_id: scannerPid,
      policy_aligns_with_scanner: policy_aligns,
      map_candidates_at_winning_tier: map_candidates,
      product_exists,
    });
  }

  return { proposals, ambiguous };
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const runId = runIdArg();
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  const dbUrl =
    process.env.STAGING_DIRECT_POSTGRES_URL?.trim() || process.env.DIRECT_POSTGRES_URL?.trim() || "";
  const publicUrl = process.env.STAGING_SUPABASE_URL?.trim() || process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() || "";
  const ref = refFromSupabaseUrl(publicUrl) || refFromSupabaseUrl(dbUrl);
  if (!dbUrl || ref !== STAGING_REF || getStagingProjectRef({ loadEnv: false }) !== STAGING_REF) {
    throw new Error(`Staging ref guard failed (expected ${STAGING_REF})`);
  }

  const pgClient = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await pgClient.connect();

  const rows = await fetchActiveRows(pgClient);
  const supabase = createClient(
    publicUrl,
    process.env.STAGING_SERVICE_ROLE_KEY?.trim() || process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() || "",
    { auth: { persistSession: false } },
  );

  const { proposals, ambiguous } = await buildProposals(pgClient, supabase, rows);

  const setResolved = proposals.filter((p) => p.apply_kind === "set_resolved");
  const statusOnly = proposals.filter((p) => p.apply_kind === "status_only");
  const skip = proposals.filter((p) => p.apply_kind === "skip_unchanged");
  const excludedAmb = proposals.filter((p) => p.apply_kind === "exclude_ambiguous");
  const noProposal = proposals.filter((p) => p.apply_kind === "exclude_no_proposal");

  const gainNewResolved = setResolved.filter((p) => !p.before.resolved_product_id).length;
  const gainRefresh = setResolved.filter((p) => p.before.resolved_product_id).length;

  const tier4Note = {
    tier: 4,
    status: "disabled",
    reason:
      "product_identifier_map.upc_code exists; return_items has no UPC/GTIN column; shared matcher does not consume UPC/GTIN",
  };

  const preimageRows = proposals
    .filter((p) => p.apply_kind === "set_resolved" || p.apply_kind === "status_only")
    .map((p) => ({
      id: p.return_item_id,
      old_resolved_product_id: p.before.resolved_product_id,
      old_resolved_catalog_product_id: p.before.resolved_catalog_product_id,
      old_identifier_resolution_status: p.before.identifier_resolution_status,
      old_identifier_resolution_confidence: p.before.identifier_resolution_confidence,
    }));

  const rollbackSql = preimageRows.map((r) => {
    const rp = r.old_resolved_product_id === null ? "NULL" : `'${r.old_resolved_product_id}'::uuid`;
    const rc =
      r.old_resolved_catalog_product_id === null ? "NULL" : `'${r.old_resolved_catalog_product_id}'::uuid`;
    const st =
      r.old_identifier_resolution_status === null ? "NULL" : `'${r.old_identifier_resolution_status}'`;
    const conf =
      r.old_identifier_resolution_confidence === null ? "NULL" : String(r.old_identifier_resolution_confidence);
    return `UPDATE public.return_items SET resolved_product_id=${rp}, resolved_catalog_product_id=${rc}, identifier_resolution_status=${st}, identifier_resolution_confidence=${conf}, updated_at=now() WHERE id='${r.id}'::uuid;`;
  });

  const misaligned = proposals.filter((p) => !p.policy_aligns_with_scanner);

  const executeReadiness = {
    v182_readiness_score: 72,
    dry_run_status: "PASS",
    execute_recommendation:
      misaligned.length > 0 || excludedAmb.length > 0
        ? "blocked_review_policy_vs_scanner_tiers"
        : setResolved.length === 0
          ? "blocked_no_eligible_set_resolved"
          : "ready_pending_v181_operator_approval_and_execute_flag",
    blockers: [
      ...(tier4Note.status === "disabled" ? ["tier_4_upc_gtin_disabled"] : []),
      ...(excludedAmb.length > 0 ? [`ambiguous_rows:${excludedAmb.length}`] : []),
      ...(misaligned.length > 0 ? [`scanner_policy_misaligned:${misaligned.length}`] : []),
    ],
    expected_gain: {
      active_rows: rows.length,
      new_resolved_product_id: gainNewResolved,
      refresh_existing_resolved: gainRefresh,
      set_resolved_total: setResolved.length,
      status_only: statusOnly.length,
      skip_unchanged: skip.length,
      remain_unresolved: noProposal.length + excludedAmb.length,
    },
  };

  fs.writeFileSync(path.join(outDir, "proposal-rows.json"), JSON.stringify(proposals, null, 2));
  fs.writeFileSync(path.join(outDir, "excluded-ambiguous-rows.json"), JSON.stringify(ambiguous, null, 2));
  fs.writeFileSync(path.join(outDir, "tier-4-upc-gtin.json"), JSON.stringify(tier4Note, null, 2));
  fs.writeFileSync(path.join(outDir, "execute-readiness.json"), JSON.stringify(executeReadiness, null, 2));
  fs.writeFileSync(path.join(outDir, "rollback-preimage-rows.json"), JSON.stringify(preimageRows, null, 2));
  fs.writeFileSync(
    path.join(outDir, "rollback.sql"),
    ["-- RETURN-ITEMS-FBM-AWARE-DRY-RUN-V183 rollback (if execute ever applied)", ...rollbackSql].join("\n"),
    "utf8",
  );

  if (misaligned.length > 0) {
    fs.writeFileSync(
      path.join(outDir, "scanner-policy-divergence.json"),
      JSON.stringify(misaligned, null, 2),
    );
  }

  const manifest = {
    prompt: "RETURN-ITEMS-FBM-AWARE-DRY-RUN-V183",
    run_id: runId,
    v182_run_id: "20260520T180000Z",
    staging_ref: STAGING_REF,
    mode: "dry_run_no_writes",
    active_return_items: rows.length,
    ...executeReadiness.expected_gain,
    execute_recommendation: executeReadiness.execute_recommendation,
    status: "PASS",
  };

  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(
    path.join(outDir, "summary.md"),
    [
      "# RETURN-ITEMS-FBM-AWARE-DRY-RUN-V183",
      "",
      `- run_id: \`${runId}\``,
      `- staging: \`${STAGING_REF}\``,
      `- v182 basis: \`return-items-resolver-backfill-fbm-aware-v182/20260520T180000Z\``,
      `- active rows: ${rows.length}`,
      `- set_resolved proposals: ${setResolved.length} (new: ${gainNewResolved}, refresh: ${gainRefresh})`,
      `- excluded ambiguous: ${excludedAmb.length}`,
      `- scanner misaligned: ${misaligned.length}`,
      `- tier 4 UPC/GTIN: disabled`,
      `- execute: **${executeReadiness.execute_recommendation}**`,
      "",
      "No database writes were performed.",
    ].join("\n"),
    "utf8",
  );

  await pgClient.end();
  console.log(JSON.stringify(manifest, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
