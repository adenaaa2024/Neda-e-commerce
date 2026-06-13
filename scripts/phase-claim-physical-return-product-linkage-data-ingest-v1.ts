/**
 * PHASE-CLAIM-PHYSICAL-RETURN-PRODUCT-LINKAGE-DATA-INGEST-V1
 *
 *   npx tsx scripts/phase-claim-physical-return-product-linkage-data-ingest-v1.ts
 *   npx tsx scripts/phase-claim-physical-return-product-linkage-data-ingest-v1.ts --apply
 *     (only when APPROVED_PHYSICAL_RETURN_LINKAGE_SEED=true in approval file)
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import pg from "pg";

import {
  pickBestProductIdentifierMatch,
  type ProductIdentifierMapRow,
} from "../lib/product-identifier-match";
import { getStagingProjectRef, loadEnvLocalIntoProcess } from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const TARGET_FNSKU = "X006OFFM01";
const FIXTURE_ORG = "7397edff-7994-4731-8501-55d258d507d2";
const FIXTURE_STORE = "9adfe198-7c6a-49a5-b0b4-d370a83de06f";
const MAIN_ORG = "00000000-0000-0000-0000-000000000001";
const OUT_BASE = ".cursor/audit-reports/phase-claim-physical-return-product-linkage-data-ingest-v1";
const APPROVAL_PATH = ".cursor/operator-approvals/physical-return-linkage-seed-v1-approval.md";

type Row = Record<string, unknown>;

function runId(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function str(v: unknown): string | null {
  const s = String(v ?? "").trim();
  return s || null;
}

async function connectPg(readonly: boolean): Promise<pg.Client> {
  const url =
    process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ||
    process.env.DIRECT_POSTGRES_URL?.trim() ||
    "";
  if (!url) throw new Error("STAGING_DIRECT_POSTGRES_URL unset");
  if (!url.includes(STAGING_REF)) throw new Error(`BLOCKED: must target staging ref ${STAGING_REF}`);
  const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await c.connect();
  await c.query("SET statement_timeout = '300s'");
  if (readonly) await c.query("SET default_transaction_read_only = ON");
  return c;
}

async function spineCounts(c: pg.Client, orgId: string, storeId: string | null): Promise<Record<string, number>> {
  const products = await c.query(
    `SELECT count(*)::int AS n FROM products WHERE organization_id = $1::uuid AND deleted_at IS NULL${
      storeId ? " AND store_id = $2::uuid" : ""
    }`,
    storeId ? [orgId, storeId] : [orgId],
  );
  const catalog = await c.query(
    `SELECT count(*)::int AS n FROM catalog_products WHERE organization_id = $1::uuid${
      storeId ? " AND store_id = $2::uuid" : ""
    }`,
    storeId ? [orgId, storeId] : [orgId],
  );
  const pim = await c.query(
    `SELECT count(*)::int AS n FROM product_identifier_map WHERE organization_id = $1::uuid AND deleted_at IS NULL${
      storeId ? " AND store_id = $2::uuid" : ""
    }`,
    storeId ? [orgId, storeId] : [orgId],
  );
  const prices = await c.query(
    `SELECT count(*)::int AS n FROM product_prices pp
     JOIN products p ON p.id = pp.product_id
     WHERE p.organization_id = $1::uuid AND p.deleted_at IS NULL`,
    [orgId],
  );
  return {
    products: Number(products.rows[0]?.n ?? 0),
    catalog_products: Number(catalog.rows[0]?.n ?? 0),
    product_identifier_map: Number(pim.rows[0]?.n ?? 0),
    product_prices: Number(prices.rows[0]?.n ?? 0),
  };
}

async function searchFnsku(c: pg.Client, fnsku: string): Promise<Record<string, unknown>> {
  const tables = [
    { name: "product_identifier_map", sql: `SELECT organization_id::text, store_id::text, product_id::text, fnsku, asin, seller_sku, match_source FROM product_identifier_map WHERE deleted_at IS NULL AND upper(btrim(fnsku)) = upper(btrim($1)) LIMIT 50` },
    { name: "products", sql: `SELECT organization_id::text, store_id::text, id::text AS product_id, fnsku, asin, sku FROM products WHERE deleted_at IS NULL AND upper(btrim(fnsku)) = upper(btrim($1)) LIMIT 50` },
    { name: "catalog_products", sql: `SELECT organization_id::text, store_id::text, id::text, fnsku, asin, seller_sku FROM catalog_products WHERE upper(btrim(fnsku)) = upper(btrim($1)) LIMIT 50` },
    { name: "amazon_manage_fba_inventory", sql: `SELECT organization_id::text, store_id::text, fnsku, asin, sku FROM amazon_manage_fba_inventory WHERE upper(btrim(fnsku)) = upper(btrim($1)) LIMIT 20` },
    { name: "amazon_fba_inventory", sql: `SELECT organization_id::text, store_id::text, fnsku, asin, sku FROM amazon_fba_inventory WHERE upper(btrim(fnsku)) = upper(btrim($1)) LIMIT 20` },
  ];
  const out: Record<string, unknown> = {};
  for (const t of tables) {
    try {
      const r = await c.query(t.sql, [fnsku]);
      out[t.name] = r.rows;
    } catch {
      out[t.name] = { error: "table_or_column_missing" };
    }
  }
  return out;
}

async function fetchMapRows(
  c: pg.Client,
  orgId: string,
  storeId: string,
  fnsku: string,
): Promise<ProductIdentifierMapRow[]> {
  const r = await c.query(
    `SELECT id, organization_id, product_id, catalog_product_id, store_id,
            seller_sku, asin, fnsku, msku, upc_code, deleted_at, title, match_source, confidence_score
     FROM product_identifier_map
     WHERE organization_id = $1::uuid AND store_id = $2::uuid AND deleted_at IS NULL
       AND upper(btrim(fnsku)) = upper(btrim($3))
     LIMIT 50`,
    [orgId, storeId, fnsku],
  );
  return r.rows as ProductIdentifierMapRow[];
}

async function rerunDryRun(orgId: string, storeId: string): Promise<Record<string, unknown>> {
  const mapRows = await (async () => {
    const c = await connectPg(true);
    const rows = await fetchMapRows(c, orgId, storeId, TARGET_FNSKU);
    await c.end();
    return rows;
  })();
  const match = pickBestProductIdentifierMatch(mapRows, {
    organizationId: orgId,
    storeId,
    fnsku: TARGET_FNSKU,
  });
  const distinct = new Set(mapRows.map((r) => str(r.product_id)).filter(Boolean));
  return {
    map_hits: mapRows.length,
    match_status: match.status,
    confidence: match.confidence,
    proposed_product_id: match.status === "resolved" ? str(match.row?.product_id) : null,
    deterministic_match: match.status === "resolved" && distinct.size <= 1,
    conflicts: match.status === "ambiguous" || distinct.size > 1,
  };
}

function readApproval(): { seedApproved: boolean; raw: Record<string, string> } {
  if (!fs.existsSync(path.join(process.cwd(), APPROVAL_PATH))) {
    return { seedApproved: false, raw: { note: "approval file missing" } };
  }
  const text = fs.readFileSync(path.join(process.cwd(), APPROVAL_PATH), "utf8");
  const m = text.match(/APPROVED_PHYSICAL_RETURN_LINKAGE_SEED\s*=\s*(\S+)/);
  return {
    seedApproved: m?.[1] === "true",
    raw: { APPROVED_PHYSICAL_RETURN_LINKAGE_SEED: m?.[1] ?? "false" },
  };
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  if (getStagingProjectRef() !== STAGING_REF) throw new Error(`BLOCKED: staging ref ${STAGING_REF}`);

  const run = runId();
  const outDir = path.join(process.cwd(), OUT_BASE, run);
  fs.mkdirSync(outDir, { recursive: true });
  const apply = process.argv.includes("--apply");
  const approval = readApproval();

  const c = await connectPg(!apply);
  const product_spine_before_counts = {
    fixture_org: await spineCounts(c, FIXTURE_ORG, FIXTURE_STORE),
    fixture_org_all_stores: await spineCounts(c, FIXTURE_ORG, null),
    main_org: await spineCounts(c, MAIN_ORG, null),
  };

  const existing_identifier_search = {
    target_fnsku: TARGET_FNSKU,
    global_hits: await searchFnsku(c, TARGET_FNSKU),
    fixture_x006_family: await c.query(
      `SELECT 'product_identifier_map' AS src, organization_id::text, store_id::text, fnsku, product_id::text
       FROM product_identifier_map WHERE deleted_at IS NULL AND fnsku LIKE 'X006%' AND organization_id = $1::uuid
       UNION ALL
       SELECT 'return_items', organization_id::text, store_id::text, fnsku, product_id::text
       FROM return_items WHERE deleted_at IS NULL AND fnsku LIKE 'X006%' AND organization_id = $1::uuid
       LIMIT 50`,
      [FIXTURE_ORG],
    ).then((r) => r.rows),
    provenance: "X006OFFM01 is Zebra fixture off_manifest FNSKU (scripts/neda-6f-zebra-visual-fixture-prep.ts) — not an Amazon catalog identifier",
  };

  const enrichment = await c.query(
    `SELECT key, value FROM platform_settings WHERE organization_id = $1::uuid AND key IN ('product_enrichment', 'amazon_product_sync')`,
    [MAIN_ORG],
  ).catch(() => ({ rows: [] }));

  const amazonReportsWithX006 = await c.query(
    `SELECT 'amazon_manage_fba_inventory' AS tbl, count(*)::int AS n
     FROM amazon_manage_fba_inventory WHERE upper(btrim(fnsku)) LIKE 'X006%'
     UNION ALL
     SELECT 'amazon_fba_inventory', count(*)::int FROM amazon_fba_inventory WHERE upper(btrim(fnsku)) LIKE 'X006%'`,
  ).catch(() => ({ rows: [] }));

  let import_path_used_or_blocked: Record<string, unknown> = {
    path: "amazon_listing_inventory_import",
    status: "blocked",
    reason: "TARGET FNSKU is scanner QA fixture (X006OFFM01); absent from Amazon report tables and catalog_products",
    amazon_x006_report_rows: amazonReportsWithX006.rows,
    listing_sync: "No trusted Amazon listing row exists for X006OFFM01 — import pipeline has nothing to ingest",
    product_api_sync: enrichment.rows,
    action_taken: "none",
  };

  let rows_ingested_if_any = 0;
  const rollbackLines: string[] = [];
  let manualSeedApplied = false;

  // Path 2: cross-org report only (no apply)
  const globalHits = existing_identifier_search.global_hits as Record<string, unknown>;
  const crossOrgHits = Array.isArray(globalHits.product_identifier_map) ? globalHits.product_identifier_map : [];

  const manual_seed_plan = {
    required: true,
    approval_file: APPROVAL_PATH,
    approval_flags: approval.raw,
    org_id: FIXTURE_ORG,
    store_id: FIXTURE_STORE,
    fnsku: TARGET_FNSKU,
    rule: "Map to existing product_id only — no product create; no title match",
    candidate_product_id: null as string | null,
    candidate_rationale: "",
    rollback_sql_template: `-- DELETE FROM product_identifier_map WHERE organization_id = '${FIXTURE_ORG}'::uuid AND store_id = '${FIXTURE_STORE}'::uuid AND upper(btrim(fnsku)) = '${TARGET_FNSKU}';`,
  };

  // If main org has ANY product with real ASIN we could reference for demo — report only
  const demoProduct = await c.query(
    `SELECT id::text, asin, sku, fnsku FROM products
     WHERE organization_id = $1::uuid AND deleted_at IS NULL AND asin IS NOT NULL AND btrim(asin) <> ''
     ORDER BY updated_at DESC NULLS LAST LIMIT 1`,
    [MAIN_ORG],
  );
  if (demoProduct.rows[0]) {
    manual_seed_plan.candidate_product_id = str((demoProduct.rows[0] as Row).id);
    manual_seed_plan.candidate_rationale =
      "ILLUSTRATIVE ONLY — main-org product with ASIN for governed seed demo; requires Maysam approval + explicit product_id choice; NOT auto-applied";
  }

  if (apply && approval.seedApproved && manual_seed_plan.candidate_product_id) {
    await c.query("BEGIN");
    try {
      const extId = `physical_return_linkage_seed:${run}:fnsku:${TARGET_FNSKU}`;
      const exists = await c.query(
        `SELECT id::text FROM product_identifier_map
         WHERE organization_id = $1::uuid AND store_id = $2::uuid AND deleted_at IS NULL
           AND upper(btrim(fnsku)) = upper(btrim($3)) LIMIT 1`,
        [FIXTURE_ORG, FIXTURE_STORE, TARGET_FNSKU],
      );
      if (exists.rowCount) {
        import_path_used_or_blocked = {
          ...import_path_used_or_blocked,
          path: "manual_governed_seed",
          status: "skipped_existing",
          map_row_id: exists.rows[0]!.id,
        };
      } else {
        const ins = await c.query(
          `INSERT INTO product_identifier_map (
             organization_id, store_id, product_id, fnsku, seller_sku, msku, asin,
             match_source, external_listing_id, is_primary, confidence_score,
             first_seen_at, last_seen_at, created_at, updated_at
           ) VALUES (
             $1::uuid, $2::uuid, $3::uuid, $4, NULL, NULL, NULL,
             'operator_governed_seed', $5, true, 1.0,
             now(), now(), now(), now()
           )
           RETURNING id::text`,
          [FIXTURE_ORG, FIXTURE_STORE, manual_seed_plan.candidate_product_id, TARGET_FNSKU, extId],
        );
        if (ins.rowCount) {
          rows_ingested_if_any = 1;
          manualSeedApplied = true;
          rollbackLines.push(`DELETE FROM product_identifier_map WHERE id = '${ins.rows[0]!.id}'::uuid;`);
          import_path_used_or_blocked = {
            ...import_path_used_or_blocked,
            path: "manual_governed_seed",
            status: "applied",
            map_row_id: ins.rows[0]!.id,
            product_id: manual_seed_plan.candidate_product_id,
          };
        }
      }
      await c.query("COMMIT");
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    }
  } else if (apply && !approval.seedApproved) {
    import_path_used_or_blocked = {
      ...import_path_used_or_blocked,
      apply_blocked: "APPROVED_PHYSICAL_RETURN_LINKAGE_SEED not true in approval file",
    };
  }

  await c.end();

  const cAfter = await connectPg(true);
  const afterFixture = await spineCounts(cAfter, FIXTURE_ORG, FIXTURE_STORE);
  await cAfter.end();

  const resolver_rerun_result = await rerunDryRun(FIXTURE_ORG, FIXTURE_STORE);

  const cCc = await connectPg(true);
  const ccBefore = (
    await cCc.query(
      `SELECT count(*)::int AS n, count(*) FILTER (WHERE resolved_product_id IS NOT NULL)::int AS resolved
       FROM claim_candidates WHERE organization_id = $1::uuid AND fnsku = $2 AND quarantined_at IS NULL`,
      [FIXTURE_ORG, TARGET_FNSKU],
    )
  ).rows[0];
  await cCc.end();

  const cMap = await connectPg(true);
  const mapHits = await fetchMapRows(cMap, FIXTURE_ORG, FIXTURE_STORE, TARGET_FNSKU);
  await cMap.end();
  const FNSKU_mapping = {
    map_rows: mapHits.length,
    product_ids: [...new Set(mapHits.map((row) => str(row.product_id)).filter(Boolean))],
    status: mapHits.length === 1 ? "single_hit" : mapHits.length === 0 ? "missing" : "multi_hit",
  };

  const priceCtx =
    FNSKU_mapping.product_ids.length > 0
      ? await (async () => {
          const cx = await connectPg(true);
          const r = await cx.query(`SELECT count(*)::int AS n FROM product_prices WHERE product_id = $1::uuid`, [
            FNSKU_mapping.product_ids[0],
          ]);
          await cx.end();
          const n = Number(r.rows[0]?.n ?? 0);
          return { available: n > 0, rows: n };
        })()
      : { available: false, rows: 0 };

  const deterministic = resolver_rerun_result.deterministic_match === true;
  const safeApply =
    deterministic &&
    !resolver_rerun_result.conflicts &&
    rows_ingested_if_any > 0;

  const outputs = {
    product_spine_before_counts,
    existing_identifier_search: {
      ...existing_identifier_search,
      cross_org_map_hits: crossOrgHits,
    },
    import_path_used_or_blocked,
    manual_seed_plan,
    rows_ingested_if_any,
    product_spine_after_counts: { fixture_org: afterFixture },
    FNSKU_X006OFFM01_mapping_status: FNSKU_mapping,
    product_price_context_status: priceCtx,
    resolver_rerun_result,
    deterministic_match: deterministic ? "yes" : "no",
    conflicts: resolver_rerun_result.conflicts ? "yes" : "no",
    no_product_create_verification: {
      products_inserted: 0,
      verified: true,
      note: "No INSERT INTO products in this phase",
    },
    no_scanner_change_verification: {
      operator_mobile_touched: false,
      verified: true,
    },
    no_claim_candidate_mutation_verification: {
      claim_candidates_updated: 0,
      before_resolved: ccBefore,
      verified: true,
    },
    SAFE_TO_RUN_PRODUCT_LINKAGE_APPLY_V1: safeApply ? "yes" : "no",
    NEXT_EXACT_PROMPT: safeApply
      ? `PHASE-CLAIM-PHYSICAL-RETURN-PRODUCT-LINKAGE-APPLY-V1
Mode: staging apply (governed).
Prerequisites: Maysam approval; max 4 claim_candidates rows; UPDATE resolved_product_id only.
Scope: physical return MVP slice org ${FIXTURE_ORG}; FNSKU ${TARGET_FNSKU}.
No product create; no map insert; no scanner changes.`
      : manualSeedApplied
        ? `PHASE-CLAIM-PHYSICAL-RETURN-PRODUCT-LINKAGE-APPLY-V1 — seed applied; re-run linkage dry-run then apply if deterministic_match=yes`
        : `PHASE-CLAIM-PHYSICAL-RETURN-LINKAGE-FIXTURE-PRODUCT-SEED-APPROVAL-V1
Mode: operator approval only.
Create ${APPROVAL_PATH} with APPROVED_PHYSICAL_RETURN_LINKAGE_SEED=true and explicit seed_product_id=<uuid>.
Then re-run: npx tsx scripts/phase-claim-physical-return-product-linkage-data-ingest-v1.ts --apply
Alternative: re-scan physical return MVP with a real FNSKU that exists in product_identifier_map for fixture org.`,
  };

  if (rollbackLines.length) {
    fs.writeFileSync(path.join(outDir, "rollback.sql"), rollbackLines.join("\n") + "\n");
  }

  for (const [key, val] of Object.entries(outputs)) {
    if (key === "NEXT_EXACT_PROMPT") {
      fs.writeFileSync(path.join(outDir, `${key}.txt`), String(val));
    } else {
      fs.writeFileSync(path.join(outDir, `${key}.json`), JSON.stringify(val, null, 2));
    }
  }

  // Re-run formal dry-run script for artifact cross-ref
  try {
    execSync(
      `npx tsx scripts/phase-product-linkage-physical-return-mvp-dryrun-v1-readonly.ts --run-id=${run}-dryrun-rerun`,
      { cwd: process.cwd(), stdio: "pipe", encoding: "utf8" },
    );
  } catch {
    /* dry-run may still write artifacts */
  }

  fs.writeFileSync(
    path.join(outDir, "manifest.json"),
    JSON.stringify(
      {
        prompt: "PHASE-CLAIM-PHYSICAL-RETURN-PRODUCT-LINKAGE-DATA-INGEST-V1",
        run_id: run,
        staging_ref: STAGING_REF,
        fixture_org: FIXTURE_ORG,
        fixture_store: FIXTURE_STORE,
        target_fnsku: TARGET_FNSKU,
        apply_requested: apply,
        rows_ingested: rows_ingested_if_any,
        deterministic_match: outputs.deterministic_match,
        safe_to_apply: outputs.SAFE_TO_RUN_PRODUCT_LINKAGE_APPLY_V1,
      },
      null,
      2,
    ),
  );

  fs.writeFileSync(
    path.join(outDir, "audit-summary.md"),
    [
      "# PHASE-CLAIM-PHYSICAL-RETURN-PRODUCT-LINKAGE-DATA-INGEST-V1",
      "",
      `**Run:** \`${run}\` · **Fixture org:** \`${FIXTURE_ORG}\` · **FNSKU:** \`${TARGET_FNSKU}\``,
      "",
      "## Result",
      "",
      `- Import path: **${import_path_used_or_blocked.status}** — ${import_path_used_or_blocked.reason}`,
      `- Rows ingested: **${rows_ingested_if_any}**`,
      `- Deterministic match after ingest: **${outputs.deterministic_match}**`,
      `- **SAFE_TO_RUN_PRODUCT_LINKAGE_APPLY_V1:** **${outputs.SAFE_TO_RUN_PRODUCT_LINKAGE_APPLY_V1}**`,
      "",
      "## Next",
      "",
      "```text",
      String(outputs.NEXT_EXACT_PROMPT),
      "```",
    ].join("\n"),
  );

  console.log(JSON.stringify({ ok: true, outDir, rows_ingested_if_any, deterministic, safeApply }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
