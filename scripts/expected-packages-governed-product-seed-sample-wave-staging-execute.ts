/**
 * EXPECTED-PACKAGES-GOVERNED-PRODUCT-SEED-SAMPLE-WAVE-STAGING
 *
 *   npx tsx scripts/expected-packages-governed-product-seed-sample-wave-staging-execute.ts --run-id=<UTC>
 *   npx tsx scripts/expected-packages-governed-product-seed-sample-wave-staging-execute.ts --run-id=<UTC> --apply
 */
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";

import {
  getStagingProjectRef,
  loadEnvLocalIntoProcess,
  supabaseUrlMatchesStagingRef,
} from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const ORG = "00000000-0000-0000-0000-000000000001";
const STORE = "509ee1f6-622c-46a5-8110-7b889ba46c2c";
const PLAN_RUN = "20260601T100000Z";
const CANDIDATES_CSV = `.cursor/audit-reports/expected-packages-governed-product-seed-plan/${PLAN_RUN}/safe-seed-candidates-max25.csv`;
const MISMATCH_CSV =
  ".cursor/audit-reports/product-sheet-phase-f-resolve-readonly/20260607T160000Z/identifier-mismatch-review-queue.csv";
const APPROVAL_PATH = ".cursor/operator-approvals/expected-packages-governed-product-seed-sample-approval.md";
const OUT_BASE = ".cursor/audit-reports/expected-packages-governed-product-seed-sample-wave-staging-execute";
const MATCH_SOURCE = "ep_governed_product_seed_sample_v1";
const MAX_FNSKU = 25;

type CandidateRow = {
  fnsku: string;
  ep_count: number;
  proposed_seller_sku: string;
  proposed_asin: string;
};

function runIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (q) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ",") {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  out.push(cur);
  return out;
}

function loadCandidates(): CandidateRow[] {
  const text = fs.readFileSync(path.join(process.cwd(), CANDIDATES_CSV), "utf8");
  const lines = text.split(/\r?\n/).filter(Boolean);
  const headers = parseCsvLine(lines[0]!);
  const rows: CandidateRow[] = [];
  for (const line of lines.slice(1)) {
    const vals = parseCsvLine(line);
    const o: Record<string, string> = {};
    headers.forEach((h, i) => {
      o[h] = vals[i] ?? "";
    });
    rows.push({
      fnsku: (o.fnsku ?? "").trim().toUpperCase(),
      ep_count: Number(o.ep_count ?? 0),
      proposed_seller_sku: (o.proposed_seller_sku ?? "").trim(),
      proposed_asin: (o.proposed_asin ?? "").trim().toUpperCase(),
    });
  }
  if (rows.length > MAX_FNSKU) {
    throw new Error(`Candidate CSV exceeds max ${MAX_FNSKU}: ${rows.length}`);
  }
  return rows;
}

function loadMismatchFnskus(): Set<string> {
  const out = new Set<string>();
  if (!fs.existsSync(path.join(process.cwd(), MISMATCH_CSV))) return out;
  const lines = fs.readFileSync(path.join(process.cwd(), MISMATCH_CSV), "utf8").split(/\r?\n/).filter(Boolean);
  const headers = parseCsvLine(lines[0]!);
  const fi = headers.indexOf("sheet_fnsku");
  for (const line of lines.slice(1)) {
    const f = parseCsvLine(line)[fi]?.trim();
    if (f) out.add(f.toUpperCase());
  }
  return out;
}

function readApproval(): boolean {
  const text = fs.readFileSync(path.join(process.cwd(), APPROVAL_PATH), "utf8");
  return (
    /APPROVED_TO_RUN_STAGING\s*=\s*true/i.test(text) &&
    /APPROVED_EP_GOVERNED_PRODUCT_SEED_SAMPLE\s*=\s*true/i.test(text) &&
    /APPROVED_PRODUCT_INSERT_MAX_25\s*=\s*true/i.test(text) &&
    new RegExp(`TARGET_SUPABASE_REF\\s*=\\s*${STAGING_REF}`, "i").test(text)
  );
}

function sqlLit(v: string): string {
  return `'${v.replace(/'/g, "''")}'`;
}

async function resolveProductName(
  client: pg.Client,
  sellerSku: string,
  asin: string,
  fnsku: string,
): Promise<string | null> {
  const catSku = await client.query(
    `SELECT item_name FROM public.catalog_products
     WHERE organization_id = $1::uuid AND store_id = $2::uuid
       AND seller_sku = $3 AND asin = $4
       AND NULLIF(btrim(item_name), '') IS NOT NULL
     ORDER BY updated_at DESC NULLS LAST LIMIT 1`,
    [ORG, STORE, sellerSku, asin],
  );
  if (catSku.rows[0]?.item_name) return String(catSku.rows[0].item_name);

  const catAsin = await client.query(
    `SELECT item_name FROM public.catalog_products
     WHERE organization_id = $1::uuid AND store_id = $2::uuid AND asin = $3
       AND NULLIF(btrim(item_name), '') IS NOT NULL
     ORDER BY updated_at DESC NULLS LAST LIMIT 1`,
    [ORG, STORE, asin],
  );
  if (catAsin.rows[0]?.item_name) return String(catAsin.rows[0].item_name);

  const catFnsku = await client.query(
    `SELECT item_name FROM public.catalog_products
     WHERE organization_id = $1::uuid AND store_id = $2::uuid AND upper(btrim(fnsku)) = upper(btrim($3))
       AND NULLIF(btrim(item_name), '') IS NOT NULL
     ORDER BY updated_at DESC NULLS LAST LIMIT 1`,
    [ORG, STORE, fnsku],
  );
  if (catFnsku.rows[0]?.item_name) return String(catFnsku.rows[0].item_name);

  const catPayload = await client.query(
    `SELECT NULLIF(btrim(raw_payload->'attributes'->'item_name'->0->>'value'), '') AS item_name
     FROM public.catalog_products
     WHERE organization_id = $1::uuid AND store_id = $2::uuid AND asin = $3
       AND NULLIF(btrim(raw_payload->'attributes'->'item_name'->0->>'value'), '') IS NOT NULL
     ORDER BY updated_at DESC NULLS LAST LIMIT 1`,
    [ORG, STORE, asin],
  );
  if (catPayload.rows[0]?.item_name) return String(catPayload.rows[0].item_name);

  for (const table of ["amazon_fba_inventory", "amazon_manage_fba_inventory"] as const) {
    const r = await client.query(
      `SELECT NULLIF(btrim(product_name), '') AS product_name FROM public.${table}
       WHERE organization_id = $1::uuid AND store_id = $2::uuid
         AND upper(btrim(fnsku)) = upper(btrim($3))
         AND NULLIF(btrim(product_name), '') IS NOT NULL
       ORDER BY updated_at DESC NULLS LAST LIMIT 1`,
      [ORG, STORE, fnsku],
    );
    if (r.rows[0]?.product_name) return String(r.rows[0].product_name);
  }

  for (const table of ["amazon_fba_inventory", "amazon_manage_fba_inventory"] as const) {
    const r = await client.query(
      `SELECT NULLIF(btrim(product_name), '') AS product_name FROM public.${table}
       WHERE organization_id = $1::uuid AND store_id = $2::uuid AND asin = $3
         AND NULLIF(btrim(product_name), '') IS NOT NULL
       ORDER BY updated_at DESC NULLS LAST LIMIT 1`,
      [ORG, STORE, asin],
    );
    if (r.rows[0]?.product_name) return String(r.rows[0].product_name);
  }

  const spine = await client.query(
    `SELECT NULLIF(btrim(product_name), '') AS product_name FROM public.products
     WHERE organization_id = $1::uuid AND store_id = $2::uuid AND asin = $3 AND deleted_at IS NULL
       AND NULLIF(btrim(product_name), '') IS NOT NULL
     ORDER BY updated_at DESC NULLS LAST LIMIT 1`,
    [ORG, STORE, asin],
  );
  if (spine.rows[0]?.product_name) return String(spine.rows[0].product_name);

  for (const spec of [
    { table: "amazon_removals", rawCol: "raw_data" },
    { table: "amazon_removal_shipments", rawCol: "raw_row" },
  ] as const) {
    const cols = await client.query(
      `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1`,
      [spec.table],
    );
    const cset = new Set(cols.rows.map((r: { column_name: string }) => r.column_name));
    const fnskuCol = cset.has("fnsku") ? "fnsku" : cset.has("fulfillment_channel_sku") ? "fulfillment_channel_sku" : null;
    if (!fnskuCol || !cset.has(spec.rawCol)) continue;
    const nameParts = [
      `NULLIF(btrim(${spec.rawCol}->>'product-name'), '')`,
      `NULLIF(btrim(${spec.rawCol}->>'product_name'), '')`,
      `NULLIF(btrim(${spec.rawCol}->>'Product Name'), '')`,
    ];
    if (cset.has("product_name")) nameParts.push("NULLIF(btrim(product_name), '')");
    const nameExpr = `COALESCE(${nameParts.join(", ")})`;
    const r = await client.query(
      `SELECT ${nameExpr} AS product_name
       FROM public.${spec.table}
       WHERE organization_id = $1::uuid AND upper(btrim(${fnskuCol})) = upper(btrim($2))
         AND ${nameExpr} IS NOT NULL
       LIMIT 1`,
      [ORG, fnsku],
    );
    if (r.rows[0]?.product_name) return String(r.rows[0].product_name);
  }
  return null;
}

async function main(): Promise<void> {
  const runId = runIdArg();
  const apply = process.argv.includes("--apply");
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  if (!readApproval()) throw new Error(`Approval missing: ${APPROVAL_PATH}`);
  const candidates = loadCandidates();
  const mismatch = loadMismatchFnskus();
  const blocked = candidates.filter((c) => mismatch.has(c.fnsku));
  if (blocked.length) {
    throw new Error(`Blocked identifier mismatch FNSKUs: ${blocked.map((b) => b.fnsku).join(", ")}`);
  }

  loadEnvLocalIntoProcess();
  const dbUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() || "";
  if (
    !dbUrl ||
    getStagingProjectRef({ loadEnv: false }) !== STAGING_REF ||
    !supabaseUrlMatchesStagingRef(dbUrl, STAGING_REF)
  ) {
    throw new Error(`Staging ref guard failed (expected ${STAGING_REF})`);
  }

  const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();
  await client.query("SET statement_timeout = '300s'");

  const fnskuList = candidates.map((c) => c.fnsku);
  const beforeProducts = await client.query(`SELECT COUNT(*)::int AS c FROM public.products`);
  const beforeMaps = await client.query(
    `SELECT COUNT(*)::int AS c FROM public.product_identifier_map WHERE deleted_at IS NULL`,
  );
  const beforeEpUnresolved = await client.query(
    `SELECT COUNT(*)::int AS c FROM public.expected_packages
     WHERE organization_id = $1::uuid AND store_id = $2::uuid AND resolved_product_id IS NULL`,
    [ORG, STORE],
  );
  const beforeTargetEp = await client.query(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE resolved_product_id IS NULL)::int AS unresolved,
            COUNT(*) FILTER (WHERE resolved_product_id IS NOT NULL)::int AS resolved
     FROM public.expected_packages
     WHERE organization_id = $1::uuid AND store_id = $2::uuid
       AND upper(btrim(fnsku)) = ANY($3::text[])`,
    [ORG, STORE, fnskuList],
  );

  const preimage = {
    candidates,
    before_counts: {
      products: beforeProducts.rows[0]?.c,
      active_map: beforeMaps.rows[0]?.c,
      ep_unresolved_org_store: beforeEpUnresolved.rows[0]?.c,
      target_fnsku_ep: beforeTargetEp.rows[0],
    },
  };
  fs.writeFileSync(path.join(outDir, "preimage.json"), JSON.stringify(preimage, null, 2));

  const productsInserted: Record<string, unknown>[] = [];
  const existingLinked: Record<string, unknown>[] = [];
  const mapsInserted: Record<string, unknown>[] = [];
  const skipped: Record<string, unknown>[] = [];
  const rollbackLines: string[] = [
    `-- Rollback EXPECTED-PACKAGES-GOVERNED-PRODUCT-SEED-SAMPLE-WAVE-STAGING run_id=${runId}`,
    "",
  ];

  if (apply) {
    await client.query("BEGIN");
    try {
      for (const row of candidates) {
        if (!/^B[0-9A-Z]{9}$/.test(row.proposed_asin)) {
          throw new Error(`Invalid ASIN for ${row.fnsku}: ${row.proposed_asin}`);
        }
        if (!/^X[0-9A-Z]{9}$/.test(row.fnsku)) {
          throw new Error(`Invalid FNSKU shape: ${row.fnsku}`);
        }

        const existing = await client.query(
          `SELECT id::text, sku, asin, fnsku, product_name FROM public.products
           WHERE organization_id = $1::uuid AND store_id = $2::uuid AND deleted_at IS NULL
             AND (
               upper(btrim(fnsku)) = upper(btrim($3))
               OR (sku IS NOT DISTINCT FROM $4 AND asin IS NOT DISTINCT FROM $5)
             )
           ORDER BY created_at DESC LIMIT 1`,
          [ORG, STORE, row.fnsku, row.proposed_seller_sku, row.proposed_asin],
        );

        let productId: string;
        let linkedExisting = false;

        if (existing.rows.length > 0) {
          productId = String(existing.rows[0]!.id);
          linkedExisting = true;
          existingLinked.push({
            fnsku: row.fnsku,
            product_id: productId,
            action: "linked_existing_product",
          });
        } else {
          const productName = await resolveProductName(
            client,
            row.proposed_seller_sku,
            row.proposed_asin,
            row.fnsku,
          );
          if (!productName) {
            throw new Error(
              `No governed product_name for FNSKU ${row.fnsku} — catalog/removal evidence required (no title-only path)`,
            );
          }
          const ins = await client.query(
            `INSERT INTO public.products (
              organization_id, store_id, product_name, sku, fnsku, asin, status,
              metadata, first_seen_at, last_seen_at, created_at, updated_at
            ) VALUES (
              $1::uuid, $2::uuid, $3, $4, $5, $6, 'active',
              jsonb_build_object('source', $7::text, 'governed_seed_plan', $8::text, 'fnsku', $5::text),
              now(), now(), now(), now()
            )
            RETURNING id::text, product_name, sku, fnsku, asin`,
            [ORG, STORE, productName, row.proposed_seller_sku, row.fnsku, row.proposed_asin, MATCH_SOURCE, PLAN_RUN],
          );
          productId = String(ins.rows[0]!.id);
          productsInserted.push({ fnsku: row.fnsku, ...ins.rows[0] });
          rollbackLines.push(`DELETE FROM public.products WHERE id = ${sqlLit(productId)}::uuid;`);
        }

        const extId = `${MATCH_SOURCE}:fnsku:${row.fnsku}`;
        const mapHit = await client.query(
          `SELECT id::text FROM public.product_identifier_map
           WHERE organization_id = $1::uuid AND store_id = $2::uuid AND deleted_at IS NULL
             AND (
               external_listing_id = $3
               OR (upper(btrim(fnsku)) = upper(btrim($4)) AND seller_sku IS NOT DISTINCT FROM $5)
             )
           LIMIT 1`,
          [ORG, STORE, extId, row.fnsku, row.proposed_seller_sku],
        );

        if (mapHit.rows.length === 0) {
          const mapIns = await client.query(
            `INSERT INTO public.product_identifier_map (
              organization_id, store_id, product_id, seller_sku, msku, asin, fnsku,
              match_source, source_report_type, external_listing_id, is_primary,
              first_seen_at, last_seen_at, created_at, updated_at
            ) VALUES (
              $1::uuid, $2::uuid, $3::uuid, $4, $4, $5, $6,
              $7, $7, $8, true, now(), now(), now(), now()
            )
            RETURNING id::text, product_id::text, external_listing_id`,
            [ORG, STORE, productId, row.proposed_seller_sku, row.proposed_asin, row.fnsku, MATCH_SOURCE, extId],
          );
          mapsInserted.push({ fnsku: row.fnsku, ...mapIns.rows[0] });
          rollbackLines.push(
            `DELETE FROM public.product_identifier_map WHERE id = ${sqlLit(String(mapIns.rows[0]!.id))}::uuid;`,
          );
        } else {
          skipped.push({ fnsku: row.fnsku, reason: "map_already_exists", map_id: mapHit.rows[0]!.id });
        }
      }

      const resolver = await client.query(
        `
        WITH target AS (
          SELECT t.id
          FROM public.expected_packages t
          WHERE t.organization_id = $1::uuid AND t.store_id = $2::uuid
            AND t.resolved_product_id IS NULL
            AND upper(btrim(t.fnsku)) = ANY($3::text[])
        ),
        winners AS (
          SELECT p.id AS row_id,
            (array_agg(m.product_id ORDER BY m.product_id))[1] AS product_id,
            (array_agg(m.catalog_product_id ORDER BY m.catalog_product_id))[1] AS catalog_product_id
          FROM target p
          INNER JOIN public.expected_packages t ON t.id = p.id
          INNER JOIN public.product_identifier_map m
            ON m.organization_id = t.organization_id AND m.store_id = t.store_id
           AND m.deleted_at IS NULL
           AND upper(btrim(m.fnsku)) = upper(btrim(t.fnsku))
          WHERE m.product_id IS NOT NULL
          GROUP BY p.id
          HAVING COUNT(DISTINCT m.product_id) = 1
        ),
        updated AS (
          UPDATE public.expected_packages t
          SET
            resolved_product_id = w.product_id,
            resolved_catalog_product_id = w.catalog_product_id,
            identifier_resolution_status = 'resolved',
            identifier_resolution_confidence = 1,
            updated_at = now()
          FROM winners w
          WHERE t.id = w.row_id
          RETURNING t.id::text, t.fnsku, w.product_id::text
        )
        SELECT * FROM updated
        `,
        [ORG, STORE, fnskuList],
      );

      fs.writeFileSync(path.join(outDir, "ep-resolver-updates.json"), JSON.stringify(resolver.rows, null, 2));
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    }
  }

  const afterProducts = await client.query(`SELECT COUNT(*)::int AS c FROM public.products`);
  const afterMaps = await client.query(
    `SELECT COUNT(*)::int AS c FROM public.product_identifier_map WHERE deleted_at IS NULL`,
  );
  const afterEpUnresolved = await client.query(
    `SELECT COUNT(*)::int AS c FROM public.expected_packages
     WHERE organization_id = $1::uuid AND store_id = $2::uuid AND resolved_product_id IS NULL`,
    [ORG, STORE],
  );
  const afterTargetEp = await client.query(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE resolved_product_id IS NULL)::int AS unresolved,
            COUNT(*) FILTER (WHERE resolved_product_id IS NOT NULL)::int AS resolved
     FROM public.expected_packages
     WHERE organization_id = $1::uuid AND store_id = $2::uuid
       AND upper(btrim(fnsku)) = ANY($3::text[])`,
    [ORG, STORE, fnskuList],
  );

  const epResolverUpdates = apply
    ? JSON.parse(fs.readFileSync(path.join(outDir, "ep-resolver-updates.json"), "utf8"))
    : [];

  const expectedPackagesResolved = apply ? epResolverUpdates.length : 0;
  const productCountDelta = Number(afterProducts.rows[0]?.c) - Number(beforeProducts.rows[0]?.c);

  fs.writeFileSync(path.join(outDir, "rollback.sql"), `${rollbackLines.join("\n")}\n`);
  fs.writeFileSync(path.join(outDir, "products-inserted.json"), JSON.stringify(productsInserted, null, 2));
  fs.writeFileSync(path.join(outDir, "existing-products-linked.json"), JSON.stringify(existingLinked, null, 2));
  fs.writeFileSync(path.join(outDir, "maps-inserted.json"), JSON.stringify(mapsInserted, null, 2));

  const safeToContinue =
    apply &&
    productCountDelta === productsInserted.length &&
    productsInserted.length + existingLinked.length === candidates.length &&
    Number(afterTargetEp.rows[0]?.unresolved ?? 0) === 0 &&
    expectedPackagesResolved > 0;

  const manifest = {
    prompt: "EXPECTED-PACKAGES-GOVERNED-PRODUCT-SEED-SAMPLE-WAVE-STAGING",
    run_id: runId,
    staging_ref: STAGING_REF,
    mode: apply ? "apply" : "dry-run",
    plan_run_id: PLAN_RUN,
    candidates_count: candidates.length,
    products_inserted: productsInserted.length,
    existing_products_linked: existingLinked.length,
    maps_inserted: mapsInserted.length,
    expected_packages_resolved: expectedPackagesResolved,
    target_fnsku_ep_before: beforeTargetEp.rows[0],
    target_fnsku_ep_after: afterTargetEp.rows[0],
    remaining_unresolved: afterEpUnresolved.rows[0]?.c,
    products_count_before_after: {
      before: Number(beforeProducts.rows[0]?.c),
      after: Number(afterProducts.rows[0]?.c),
      delta: productCountDelta,
    },
    map_count_before_after: {
      before: Number(beforeMaps.rows[0]?.c),
      after: Number(afterMaps.rows[0]?.c),
      delta: Number(afterMaps.rows[0]?.c) - Number(beforeMaps.rows[0]?.c),
    },
    rollback_path: `${OUT_BASE}/${runId}/rollback.sql`,
    SAFE_TO_CONTINUE: safeToContinue ? "yes" : apply ? "no" : "pending",
  };

  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(
    path.join(outDir, "apply-result.md",
    ),
    [
      "# EXPECTED-PACKAGES-GOVERNED-PRODUCT-SEED-SAMPLE-WAVE-STAGING",
      "",
      `- Mode: **${apply ? "APPLY" : "DRY-RUN"}**`,
      `- Candidates: **${candidates.length}** FNSKUs`,
      `- Products inserted: **${productsInserted.length}**`,
      `- Existing products linked: **${existingLinked.length}**`,
      `- Maps inserted: **${mapsInserted.length}**`,
      `- EP rows resolved (target FNSKUs): **${expectedPackagesResolved}**`,
      `- Remaining EP unresolved (org/store): **${afterEpUnresolved.rows[0]?.c}**`,
      "",
      `SAFE_TO_CONTINUE: **${manifest.SAFE_TO_CONTINUE}**`,
    ].join("\n"),
  );

  await client.end();
  console.log(JSON.stringify(manifest, null, 2));
  if (apply && !safeToContinue) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
