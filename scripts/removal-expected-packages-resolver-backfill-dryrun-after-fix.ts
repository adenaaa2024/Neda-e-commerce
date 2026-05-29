/**
 * REMOVAL-EXPECTED-PACKAGES-RESOLVER-BACKFILL-DRYRUN-AFTER-FIX (read-only)
 *
 *   npx tsx scripts/removal-expected-packages-resolver-backfill-dryrun-after-fix.ts
 *   npx tsx scripts/removal-expected-packages-resolver-backfill-dryrun-after-fix.ts --force
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createClient } from "@supabase/supabase-js";
import pg from "pg";

import {
  parseRemovalRawDataHints,
  resolveExpectedPackageProduct,
  type RemovalExpectedPackageRow,
} from "../lib/removal/resolve-expected-package-product";
import type { ScannerResolutionColumns } from "../lib/scanner-product-resolve";
import {
  getStagingProjectRef,
  loadEnvLocalIntoProcess,
  refFromSupabaseUrl,
  supabaseUrlMatchesStagingRef,
} from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const SAM_ORG = "00000000-0000-0000-0000-000000000001";
const SAM_STORE = "509ee1f6-622c-46a5-8110-7b889ba46c2c";
const OUT_BASE = ".cursor/audit-reports/removal-expected-packages-resolver-backfill-dryrun-after-fix";
const APPROVAL_PATH = ".cursor/operator-approvals/removal-expected-packages-resolver-backfill-approval.md";
const DERIVED_SOURCES = ["detail_shipment", "detail_remainder"] as const;

type Proposal = {
  id: string;
  bucket: string;
  apply_kind: string;
  hints: { sku: string | null; fnsku: string | null; asin: string | null; upc: string | null };
  unresolved_class: string;
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

function n(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

function unresolvedClass(bucket: string, hints: Proposal["hints"]): string {
  if (bucket === "resolved") return "resolved";
  if (bucket === "ambiguous") return "ambiguous";
  if (bucket === "missing_product_needs_evidence") {
    if (!hints.fnsku && !hints.sku && !hints.asin && !hints.upc) return "missing_map_no_identifiers";
    return "product_missing_needs_amazon_evidence";
  }
  if (bucket === "product_promotion_candidate") return "product_missing_needs_amazon_evidence";
  return "unresolved_other";
}

async function allocationMismatchCount(client: pg.Client): Promise<number> {
  const colQ = await client.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema='public' AND table_name='amazon_removal_shipments'`,
  );
  const hasDisp = (colQ.rows as Array<{ column_name: string }>).some((c) => c.column_name === "disposition");
  const dispSel = hasDisp ? "nullif(btrim(s.disposition), '') AS disposition" : "NULL::text AS disposition";
  const dispJoin = hasDisp ? "AND s.disposition IS NOT DISTINCT FROM d.disposition" : "";

  const r = await client.query(
    `
    WITH detail AS (
      SELECT d.id AS detail_id, COALESCE(d.shipped_quantity, 0) AS detail_shipped_qty,
        d.organization_id, d.store_id, d.order_id, d.order_type, d.order_date,
        nullif(btrim(d.sku),'') AS sku, nullif(btrim(d.fnsku),'') AS fnsku, nullif(btrim(d.disposition),'') AS disposition
      FROM public.amazon_removals d
      WHERE d.organization_id=$1::uuid AND d.store_id=$2::uuid AND d.order_id IS NOT NULL
    ),
    shipment AS (
      SELECT s.id AS shipment_id, s.organization_id, s.store_id, s.order_id, s.order_type, s.order_date,
        nullif(btrim(s.sku),'') AS sku, nullif(btrim(s.fnsku),'') AS fnsku, ${dispSel},
        COALESCE(s.shipped_quantity,0) AS shipment_shipped_qty
      FROM public.amazon_removal_shipments s
      WHERE s.organization_id=$1::uuid AND s.store_id=$2::uuid
    ),
    pair AS (
      SELECT d.detail_id, d.detail_shipped_qty, s.shipment_id, s.shipment_shipped_qty
      FROM detail d LEFT JOIN shipment s
        ON s.organization_id=d.organization_id AND s.store_id IS NOT DISTINCT FROM d.store_id
       AND s.order_id IS NOT DISTINCT FROM d.order_id AND s.order_type IS NOT DISTINCT FROM d.order_type
       AND s.order_date IS NOT DISTINCT FROM d.order_date AND s.sku IS NOT DISTINCT FROM d.sku
       AND s.fnsku IS NOT DISTINCT FROM d.fnsku ${dispJoin}
    ),
    matched AS (
      SELECT p.detail_id, p.shipment_shipped_qty AS qty FROM pair p WHERE p.shipment_id IS NOT NULL
    ),
    rem AS (
      SELECT DISTINCT ON (p.detail_id) p.detail_id,
        GREATEST(max(p.detail_shipped_qty) OVER (PARTITION BY p.detail_id)
          - coalesce(sum(p.shipment_shipped_qty) OVER (PARTITION BY p.detail_id),0), 0)::int AS qty
      FROM pair p ORDER BY p.detail_id
    ),
    agg AS (
      SELECT detail_id FROM pair GROUP BY detail_id
      HAVING COALESCE((SELECT sum(qty) FROM matched m WHERE m.detail_id=pair.detail_id),0)
           + CASE WHEN EXISTS (
             SELECT 1 FROM pair p2 WHERE p2.detail_id=pair.detail_id AND (
               NOT EXISTS (SELECT 1 FROM pair p3 WHERE p3.detail_id=pair.detail_id AND p3.shipment_id IS NOT NULL)
               OR (SELECT max(detail_shipped_qty) FROM pair px WHERE px.detail_id=pair.detail_id)
                  > coalesce((SELECT sum(shipment_shipped_qty) FROM pair py WHERE py.detail_id=pair.detail_id AND py.shipment_id IS NOT NULL),0)
             )
           ) THEN coalesce((SELECT qty FROM rem r WHERE r.detail_id=pair.detail_id),0) ELSE 0 END
           <> coalesce((SELECT sum(expected_scan_quantity) FROM public.expected_packages ep
             WHERE ep.source_detail_row_id=pair.detail_id AND ep.organization_id=$1::uuid AND ep.store_id=$2::uuid
               AND ep.build_source IN ('detail_shipment','detail_remainder')), -999)
    )
    SELECT count(*)::int AS c FROM agg
    `,
    [SAM_ORG, SAM_STORE],
  );
  // Simpler mismatch query (same as verify script)
  const simple = await client.query(
    `
    WITH detail AS (
      SELECT d.id AS detail_id, COALESCE(d.shipped_quantity, 0) AS detail_shipped_qty,
        d.organization_id, d.store_id, d.order_id, d.order_type, d.order_date,
        nullif(btrim(d.sku),'') AS sku, nullif(btrim(d.fnsku),'') AS fnsku, nullif(btrim(d.disposition),'') AS disposition
      FROM public.amazon_removals d
      WHERE d.organization_id=$1::uuid AND d.store_id=$2::uuid AND d.order_id IS NOT NULL
    ),
    shipment AS (
      SELECT s.id AS shipment_id, s.organization_id, s.store_id, s.order_id, s.order_type, s.order_date,
        nullif(btrim(s.sku),'') AS sku, nullif(btrim(s.fnsku),'') AS fnsku, ${dispSel},
        COALESCE(s.shipped_quantity,0) AS shipment_shipped_qty
      FROM public.amazon_removal_shipments s
      WHERE s.organization_id=$1::uuid AND s.store_id=$2::uuid
    ),
    pair AS (
      SELECT d.detail_id, d.detail_shipped_qty, s.shipment_id, s.shipment_shipped_qty
      FROM detail d LEFT JOIN shipment s
        ON s.organization_id=d.organization_id AND s.store_id IS NOT DISTINCT FROM d.store_id
       AND s.order_id IS NOT DISTINCT FROM d.order_id AND s.order_type IS NOT DISTINCT FROM d.order_type
       AND s.order_date IS NOT DISTINCT FROM d.order_date AND s.sku IS NOT DISTINCT FROM d.sku
       AND s.fnsku IS NOT DISTINCT FROM d.fnsku ${dispJoin}
    ),
    agg AS (
      SELECT detail_id, max(detail_shipped_qty) AS detail_total,
        sum(COALESCE(shipment_shipped_qty,0)) FILTER (WHERE shipment_id IS NOT NULL) AS shipment_total,
        count(*) FILTER (WHERE shipment_id IS NOT NULL) AS shipment_count
      FROM pair GROUP BY detail_id
    ),
    matched_emitted AS (
      SELECT p.detail_id, p.shipment_shipped_qty AS qty FROM pair p JOIN agg a USING (detail_id) WHERE p.shipment_id IS NOT NULL
    ),
    remainder_emitted AS (
      SELECT DISTINCT ON (p.detail_id) p.detail_id,
        GREATEST(a.detail_total - COALESCE(a.shipment_total,0),0)::int AS qty
      FROM pair p JOIN agg a USING (detail_id)
      WHERE COALESCE(a.shipment_count,0)=0 OR a.detail_total > COALESCE(a.shipment_total,0)
      ORDER BY p.detail_id
    ),
    emitted AS (
      SELECT detail_id, qty FROM matched_emitted UNION ALL SELECT detail_id, qty FROM remainder_emitted
    ),
    sim AS (SELECT detail_id, sum(qty)::int AS sim_sum FROM emitted GROUP BY 1),
    live AS (
      SELECT source_detail_row_id AS detail_id, sum(expected_scan_quantity)::int AS live_sum
      FROM public.expected_packages
      WHERE organization_id=$1::uuid AND store_id=$2::uuid
        AND build_source IN ('detail_shipment','detail_remainder')
      GROUP BY 1
    )
    SELECT count(*)::int AS c FROM sim FULL OUTER JOIN live USING (detail_id)
    WHERE COALESCE(sim_sum,-1) <> COALESCE(live_sum,-2)
    `,
    [SAM_ORG, SAM_STORE],
  );
  return (simple.rows[0] as { c: number }).c;
}

async function main(): Promise<void> {
  const runId = runIdArg();
  const force = process.argv.includes("--force");
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  loadEnvLocalIntoProcess();
  const dbUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ?? "";
  const publicUrl =
    process.env.STAGING_SUPABASE_URL?.trim() || process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() || "";
  if (!dbUrl || !supabaseUrlMatchesStagingRef(dbUrl, STAGING_REF)) {
    throw new Error(`STAGING_DIRECT_POSTGRES_URL must target ${STAGING_REF}`);
  }
  if (getStagingProjectRef({ loadEnv: false }) !== STAGING_REF) {
    throw new Error("Staging ref guard failed");
  }

  const pgClient = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await pgClient.connect();
  await pgClient.query("SET statement_timeout = '600s'");

  const epMismatch = await allocationMismatchCount(pgClient);
  const derivedCount = await pgClient.query(
    `SELECT COUNT(*)::int AS c FROM public.expected_packages
     WHERE organization_id=$1::uuid AND store_id=$2::uuid
       AND build_source = ANY($3::text[])`,
    [SAM_ORG, SAM_STORE, DERIVED_SOURCES],
  );
  const derivedTotal = (derivedCount.rows[0] as { c: number }).c;

  const blockers: string[] = [];
  if (epMismatch > 0) {
    blockers.push(`Allocation mismatch: ${epMismatch} detail lines (run REMOVAL-REBUILD-ALLOCATION-FIX-EXECUTE first)`);
  }

  const supabase = createClient(
    publicUrl,
    process.env.STAGING_SERVICE_ROLE_KEY?.trim() || process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() || "",
    { auth: { persistSession: false } },
  );

  const proposals: Proposal[] = [];
  if (!blockers.length || force) {
    let cursor = "00000000-0000-0000-0000-000000000000";
    const PAGE = 500;
    const CONCURRENCY = 32;

    async function resolveBatch(batch: RemovalExpectedPackageRow[]) {
      const detailIds = [
        ...new Set(batch.map((r) => n(r.source_detail_row_id)).filter((x): x is string => !!x)),
      ];
      const hydration = new Map<string, { asin: string | null; upc: string | null }>();
      if (detailIds.length) {
        const h = await pgClient.query(
          `SELECT id::text, raw_data FROM public.amazon_removals WHERE id = ANY($1::uuid[])`,
          [detailIds],
        );
        for (const row of h.rows) {
          hydration.set(String(row.id), parseRemovalRawDataHints(row.raw_data));
        }
      }

      async function one(row: RemovalExpectedPackageRow): Promise<Proposal> {
        const detailId = n(row.source_detail_row_id);
        const hintsRaw = detailId ? hydration.get(detailId) : undefined;
        const resolved = await resolveExpectedPackageProduct(supabase, row, {
          asinFromRemoval: hintsRaw?.asin ?? null,
          upcFromRemoval: hintsRaw?.upc ?? null,
        });
        let apply_kind = "status_only";
        if (resolved.columns.identifier_resolution_status === "resolved" && resolved.columns.resolved_product_id) {
          const ex = await pgClient.query(`SELECT 1 FROM public.products WHERE id=$1::uuid LIMIT 1`, [
            resolved.columns.resolved_product_id,
          ]);
          if (ex.rows.length) apply_kind = "set_resolved";
        }
        const hints = resolved.hints;
        return {
          id: row.id,
          bucket: resolved.bucket,
          apply_kind,
          hints: { sku: hints.sku, fnsku: hints.fnsku, asin: hints.asin, upc: hints.upc },
          unresolved_class: unresolvedClass(resolved.bucket, hints),
        };
      }

      const out: Proposal[] = new Array(batch.length);
      let i = 0;
      async function worker() {
        for (;;) {
          const idx = i++;
          if (idx >= batch.length) return;
          out[idx] = await one(batch[idx]!);
        }
      }
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, batch.length) }, () => worker()));
      return out;
    }

    for (;;) {
      const res = await pgClient.query(
        `SELECT id::text, organization_id::text, store_id::text, sku, fnsku,
          resolved_product_id::text, source_detail_row_id::text, order_id, build_source
         FROM public.expected_packages
         WHERE build_source = ANY($3::text[])
           AND organization_id = $4::uuid AND store_id = $5::uuid
           AND id > $1::uuid
         ORDER BY id LIMIT $2`,
        [cursor, PAGE, DERIVED_SOURCES, SAM_ORG, SAM_STORE],
      );
      const batch = res.rows as RemovalExpectedPackageRow[];
      if (!batch.length) break;
      proposals.push(...(await resolveBatch(batch)));
      cursor = batch[batch.length - 1]!.id;
      if (batch.length < PAGE) break;
    }
  }

  await pgClient.end();

  const resolvedCount = proposals.filter((p) => p.bucket === "resolved").length;
  const unresolvedCount = proposals.length - resolvedCount;
  const byClass = proposals.reduce(
    (acc, p) => {
      acc[p.unresolved_class] = (acc[p.unresolved_class] ?? 0) + 1;
      return acc;
    },
    {} as Record<string, number>,
  );

  const rebuildValid = epMismatch === 0;
  const status = blockers.length && !force ? "BLOCKED" : rebuildValid ? "PASS" : "WARN";

  const nextPrompt = rebuildValid
    ? "REMOVAL-EXPECTED-PACKAGES-RESOLVER-BACKFILL-EXECUTE — set approval flags true and run resolver backfill with --execute"
    : "REMOVAL-REBUILD-ALLOCATION-FIX-EXECUTE — clear allocation mismatches before resolver backfill";

  fs.writeFileSync(
    path.join(outDir, "preconditions.md"),
    [
      "# Preconditions",
      "",
      `| Check | Result |`,
      `|-------|--------|`,
      `| rebuild verify (ep mismatch) | **${epMismatch}** (${rebuildValid ? "PASS" : "FAIL"}) |`,
      `| derived EP rows | ${derivedTotal} |`,
      `| force mode | ${force} |`,
      "",
      blockers.length ? blockers.map((b) => `- ${b}`).join("\n") : "- None",
    ].join("\n") + "\n",
  );

  fs.writeFileSync(path.join(outDir, "resolver-summary.json"), JSON.stringify({
    candidates_scanned: proposals.length,
    queue_resolved: resolvedCount,
    queue_unresolved: unresolvedCount,
    by_bucket: proposals.reduce((a, p) => { a[p.bucket] = (a[p.bucket] ?? 0) + 1; return a; }, {} as Record<string, number>),
    by_unresolved_class: byClass,
    set_resolved_apply: proposals.filter((p) => p.apply_kind === "set_resolved").length,
  }, null, 2));

  fs.writeFileSync(
    path.join(outDir, "unresolved-classification.json"),
    JSON.stringify(byClass, null, 2),
  );

  fs.writeFileSync(
    path.join(outDir, "execute-plan.md"),
    [
      "# Execute plan (after approval)",
      "",
      "1. Set `APPROVED_TO_RUN_STAGING=true` and `APPROVED_REMOVAL_EXPECTED_PACKAGES_RESOLVER_BACKFILL=true`",
      "2. `npx tsx scripts/removal-expected-packages-resolver-backfill-execute.ts --execute`",
      "3. Post-verify: persisted `resolved_product_id` count vs dry-run `set_resolved`",
      "4. Queue PC03D evidence for `product_missing_needs_amazon_evidence` rows",
      "",
      "No products.insert. No product_identifier_map.insert.",
    ].join("\n") + "\n",
  );

  fs.writeFileSync(
    path.join(outDir, "queue-resolved.jsonl"),
    proposals.filter((p) => p.bucket === "resolved").map((p) => JSON.stringify(p)).join("\n") + "\n",
  );
  fs.writeFileSync(
    path.join(outDir, "queue-unresolved.jsonl"),
    proposals.filter((p) => p.bucket !== "resolved").map((p) => JSON.stringify(p)).join("\n") + "\n",
  );

  fs.writeFileSync(
    path.join(outDir, "manifest.json"),
    JSON.stringify({
      prompt: "REMOVAL-EXPECTED-PACKAGES-RESOLVER-BACKFILL-DRYRUN-AFTER-FIX",
      run_id: runId,
      staging_ref: STAGING_REF,
      status,
      rebuild_valid: rebuildValid,
      ep_mismatch_detail_lines: epMismatch,
      derived_total: derivedTotal,
      resolved_count: resolvedCount,
      unresolved_count: unresolvedCount,
      by_unresolved_class: byClass,
      approval_file: APPROVAL_PATH,
      exact_next_prompt: nextPrompt,
      no_db_writes: true,
      blockers,
    }, null, 2),
  );

  if (blockers.length && !force) {
    fs.writeFileSync(path.join(outDir, "blockers.md"), blockers.map((b) => `- ${b}`).join("\n") + "\n");
  }

  console.log(JSON.stringify({
    ok: status !== "BLOCKED",
    outDir: path.relative(process.cwd(), outDir).replace(/\\/g, "/"),
    status,
    rebuild_valid: rebuildValid,
    resolved_count: resolvedCount,
    unresolved_count: unresolvedCount,
    approval_file: APPROVAL_PATH,
    next_prompt: nextPrompt,
  }, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
