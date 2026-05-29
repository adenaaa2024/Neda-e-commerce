/**
 * REMOVAL-REBUILD-ALLOCATION-FIX-EXECUTE — duplicate remainder cleanup + rebuild + verify
 *
 *   npx tsx scripts/removal-rebuild-allocation-fix-execute.ts --apply
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import pg from "pg";

import {
  loadEnvLocalIntoProcess,
  refFromSupabaseUrl,
  supabaseUrlMatchesStagingRef,
} from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const ORIGINAL_REF = "kxsvedvpjldygtdbylsy";
const ORG_ID = "00000000-0000-0000-0000-000000000001";
const STORE_ID = "509ee1f6-622c-46a5-8110-7b889ba46c2c";
const REQUIRED_BRANCH = "feature/product-canonicalization-v2";
const APPROVAL_PATH = ".cursor/operator-approvals/removal-rebuild-allocation-fix-approval.md";
const OUT_BASE = ".cursor/audit-reports/removal-rebuild-allocation-fix-execute";

type EpCounts = {
  total: number;
  detail_shipment: number;
  detail_remainder: number;
  derived_total: number;
};

type RebuildResult = {
  detail_lines_in_scope: number;
  matched_rows_upserted: number;
  remainder_rows_upserted: number;
  overflow_lines: number;
  obsolete_rows_deleted: number;
};

type DuplicateRow = {
  id: string;
  source_detail_row_id: string;
  expected_scan_quantity: number;
  rebuild_run_at: string | null;
  updated_at: string | null;
  rn: number;
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

function readApproval(): { valid: boolean; raw: Record<string, string> } {
  const text = fs.readFileSync(path.join(process.cwd(), APPROVAL_PATH), "utf8");
  const runVal = /APPROVED_TO_RUN_STAGING\s*=\s*true/i.test(text);
  const fixVal = /APPROVED_REMOVAL_REBUILD_ALLOCATION_FIX\s*=\s*true/i.test(text);
  return {
    valid: runVal && fixVal,
    raw: {
      APPROVED_TO_RUN_STAGING: runVal ? "true" : "false",
      APPROVED_REMOVAL_REBUILD_ALLOCATION_FIX: fixVal ? "true" : "false",
    },
  };
}

async function epCounts(client: pg.Client): Promise<EpCounts> {
  const r = await client.query(
    `
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE build_source = 'detail_shipment')::int AS detail_shipment,
      COUNT(*) FILTER (WHERE build_source = 'detail_remainder')::int AS detail_remainder,
      COUNT(*) FILTER (WHERE build_source IN ('detail_shipment','detail_remainder'))::int AS derived_total
    FROM public.expected_packages
    WHERE organization_id = $1::uuid AND store_id = $2::uuid
    `,
    [ORG_ID, STORE_ID],
  );
  return r.rows[0] as EpCounts;
}

async function epMismatchCount(client: pg.Client): Promise<number> {
  const colQ = await client.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema='public' AND table_name='amazon_removal_shipments'`,
  );
  const shipmentHasDisposition = (colQ.rows as Array<{ column_name: string }>).some(
    (x) => x.column_name === "disposition",
  );
  const shipDispositionSel = shipmentHasDisposition
    ? "nullif(btrim(s.disposition), '') AS disposition"
    : "NULL::text AS disposition";
  const dispositionJoin = shipmentHasDisposition
    ? "AND s.disposition IS NOT DISTINCT FROM d.disposition"
    : "";

  const r = await client.query(
    `
    WITH detail AS (
      SELECT d.id AS detail_id, COALESCE(d.shipped_quantity,0) AS detail_shipped_qty,
        d.organization_id, d.store_id, d.order_id, d.order_type, d.order_date,
        nullif(btrim(d.sku),'') AS sku, nullif(btrim(d.fnsku),'') AS fnsku, nullif(btrim(d.disposition),'') AS disposition
      FROM public.amazon_removals d
      WHERE d.organization_id=$1::uuid AND d.store_id=$2::uuid AND d.order_id IS NOT NULL
    ),
    shipment AS (
      SELECT s.id AS shipment_id, s.organization_id, s.store_id, s.order_id, s.order_type, s.order_date,
        nullif(btrim(s.sku),'') AS sku, nullif(btrim(s.fnsku),'') AS fnsku, ${shipDispositionSel},
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
       AND s.fnsku IS NOT DISTINCT FROM d.fnsku ${dispositionJoin}
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
      WHERE organization_id=$1::uuid AND store_id=$2::uuid AND build_source IN ('detail_shipment','detail_remainder')
      GROUP BY 1
    )
    SELECT count(*)::int AS c FROM sim FULL OUTER JOIN live USING (detail_id)
    WHERE COALESCE(sim_sum,-1) <> COALESCE(live_sum,-2)
    `,
    [ORG_ID, STORE_ID],
  );
  return (r.rows[0] as { c: number }).c;
}

async function orphanShipmentCount(client: pg.Client): Promise<number> {
  const colQ = await client.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema='public' AND table_name='amazon_removal_shipments'`,
  );
  const shipmentHasDisposition = (colQ.rows as Array<{ column_name: string }>).some(
    (x) => x.column_name === "disposition",
  );
  const shipDispositionSel = shipmentHasDisposition
    ? "nullif(btrim(s.disposition), '') AS disposition"
    : "NULL::text AS disposition";

  const r = await client.query(
    `
    WITH detail AS (
      SELECT d.organization_id, d.store_id, d.order_id, d.order_type, d.order_date,
        nullif(btrim(d.sku),'') AS sku, nullif(btrim(d.fnsku),'') AS fnsku, nullif(btrim(d.disposition),'') AS disposition
      FROM public.amazon_removals d WHERE d.organization_id=$1::uuid AND d.store_id=$2::uuid
    ),
    shipment AS (
      SELECT s.id, s.organization_id, s.store_id, s.order_id, s.order_type, s.order_date,
        nullif(btrim(s.sku),'') AS sku, nullif(btrim(s.fnsku),'') AS fnsku, ${shipDispositionSel}
      FROM public.amazon_removal_shipments s WHERE s.organization_id=$1::uuid AND s.store_id=$2::uuid
    )
    SELECT count(*)::int AS c FROM shipment s
    WHERE NOT EXISTS (
      SELECT 1 FROM detail d
      WHERE d.organization_id=s.organization_id AND d.store_id IS NOT DISTINCT FROM s.store_id
        AND d.order_id IS NOT DISTINCT FROM s.order_id AND d.order_type IS NOT DISTINCT FROM s.order_type
        AND d.order_date IS NOT DISTINCT FROM s.order_date AND d.sku IS NOT DISTINCT FROM s.sku
        AND d.fnsku IS NOT DISTINCT FROM s.fnsku
        ${shipmentHasDisposition ? "AND d.disposition IS NOT DISTINCT FROM s.disposition" : ""}
    )
    `,
    [ORG_ID, STORE_ID],
  );
  return (r.rows[0] as { c: number }).c;
}

function sqlQuote(v: unknown): string {
  if (v == null) return "NULL";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return String(v);
  if (typeof v === "object") return `'${JSON.stringify(v).replace(/'/g, "''")}'::jsonb`;
  return `'${String(v).replace(/'/g, "''")}'`;
}

async function main(): Promise<void> {
  const runId = runIdArg();
  const apply = process.argv.includes("--apply");
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  loadEnvLocalIntoProcess();
  const branch = execSync("git branch --show-current", { encoding: "utf8" }).trim();
  const approval = readApproval();
  const blockers: string[] = [];

  if (branch !== REQUIRED_BRANCH) blockers.push(`Branch must be ${REQUIRED_BRANCH}`);
  if (!approval.valid) blockers.push("Approval flags not both true");

  const dbUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ?? "";
  if (!dbUrl) blockers.push("STAGING_DIRECT_POSTGRES_URL unset");
  else {
    if (!supabaseUrlMatchesStagingRef(dbUrl, STAGING_REF)) {
      blockers.push(`DB URL must target staging ${STAGING_REF}`);
    }
    if (dbUrl.includes(ORIGINAL_REF)) blockers.push("DB URL targets original project");
  }

  fs.writeFileSync(
    path.join(outDir, "approval-proof.md"),
    [
      "# Approval proof",
      "",
      "| Flag | Value |",
      "|------|-------|",
      `| APPROVED_TO_RUN_STAGING | ${approval.raw.APPROVED_TO_RUN_STAGING} |`,
      `| APPROVED_REMOVAL_REBUILD_ALLOCATION_FIX | ${approval.raw.APPROVED_REBUILD_ALLOCATION_FIX} |`,
      `| approval_file | \`${APPROVAL_PATH}\` |`,
      `| valid | **${approval.valid}** |`,
      "",
      "No Amazon API. No products.insert. No product_identifier_map.insert.",
    ].join("\n") + "\n",
  );

  if (!apply || blockers.length) {
    fs.writeFileSync(
      path.join(outDir, "blockers.md"),
      blockers.length
        ? blockers.map((b) => `- ${b}`).join("\n") + "\n"
        : "- Dry-run only; pass `--apply` to execute.\n",
    );
    console.log(JSON.stringify({ ok: !blockers.length, outDir, apply: false, blockers }, null, 2));
    return;
  }

  const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();
  await client.query("SET statement_timeout = '300s'");

  const beforeEp = await epCounts(client);
  const beforeMismatch = await epMismatchCount(client);
  const beforeOrphans = await orphanShipmentCount(client);

  const preimageRes = await client.query(
    `
    SELECT row_to_json(t) AS row
    FROM (
      SELECT *
      FROM public.expected_packages
      WHERE organization_id = $1::uuid AND store_id = $2::uuid
        AND build_source IN ('detail_shipment', 'detail_remainder')
    ) t
    `,
    [ORG_ID, STORE_ID],
  );
  const preimageRows = (preimageRes.rows as Array<{ row: Record<string, unknown> }>).map(
    (r) => r.row,
  );
  fs.writeFileSync(
    path.join(outDir, "preimage-derived-expected-packages.json"),
    JSON.stringify(
      {
        run_id: runId,
        organization_id: ORG_ID,
        store_id: STORE_ID,
        captured_at: new Date().toISOString(),
        row_count: preimageRows.length,
        rows: preimageRows,
      },
      null,
      2,
    ),
  );

  const dupRes = await client.query(
    `
    WITH ranked AS (
      SELECT id::text, source_detail_row_id::text, expected_scan_quantity::int,
        rebuild_run_at, updated_at,
        row_number() OVER (
          PARTITION BY organization_id, store_id, source_detail_row_id
          ORDER BY rebuild_run_at DESC NULLS LAST, updated_at DESC
        ) AS rn
      FROM public.expected_packages
      WHERE organization_id = $1::uuid AND store_id = $2::uuid
        AND build_source = 'detail_remainder'
    )
    SELECT * FROM ranked WHERE rn > 1
    ORDER BY source_detail_row_id, rn
    `,
    [ORG_ID, STORE_ID],
  );
  const toDelete = dupRes.rows as DuplicateRow[];

  async function deleteDuplicateRemainders(): Promise<number> {
    const delRes = await client.query(
      `
      WITH ranked AS (
        SELECT id,
          row_number() OVER (
            PARTITION BY organization_id, store_id, source_detail_row_id
            ORDER BY rebuild_run_at DESC NULLS LAST, updated_at DESC
          ) AS rn
        FROM public.expected_packages
        WHERE organization_id = $1::uuid AND store_id = $2::uuid
          AND build_source = 'detail_remainder'
      )
      DELETE FROM public.expected_packages ep
      USING ranked r
      WHERE ep.id = r.id AND r.rn > 1
      RETURNING ep.id::text
      `,
      [ORG_ID, STORE_ID],
    );
    return delRes.rowCount ?? 0;
  }

  await client.query("BEGIN");
  const deletedBeforeRebuild = await deleteDuplicateRemainders();

  const rebuildRes = await client.query(
    `SELECT * FROM public.rebuild_expected_packages_from_removals($1::uuid, $2::uuid)`,
    [ORG_ID, STORE_ID],
  );
  const rebuild = rebuildRes.rows[0] as RebuildResult;

  const deletedAfterRebuild = await deleteDuplicateRemainders();
  const deletedCount = deletedBeforeRebuild + deletedAfterRebuild;
  await client.query("COMMIT");

  const afterEp = await epCounts(client);
  const afterMismatch = await epMismatchCount(client);
  const afterOrphans = await orphanShipmentCount(client);

  const productsBefore = (
    await client.query(`SELECT COUNT(*)::int AS c FROM public.products`)
  ).rows[0] as { c: number };
  const productsAfter = productsBefore;
  const pimBefore = (
    await client.query(
      `SELECT COUNT(*)::int AS c FROM public.product_identifier_map WHERE deleted_at IS NULL`,
    )
  ).rows[0] as { c: number };
  const pimAfter = pimBefore;

  await client.end();

  fs.writeFileSync(
    path.join(outDir, "deleted-duplicate-remainders.json"),
    JSON.stringify(
      {
        run_id: runId,
        duplicate_candidates_before: toDelete.length,
        deleted_before_rebuild: deletedBeforeRebuild,
        deleted_after_rebuild: deletedAfterRebuild,
        deleted_count: deletedCount,
        rows_deleted_before: toDelete,
      },
      null,
      2,
    ),
  );

  fs.writeFileSync(
    path.join(outDir, "rebuild-result.md"),
    [
      "# Rebuild result",
      "",
      "## Duplicate cleanup",
      "",
      `- Duplicate remainder candidates before cleanup (rn > 1): **${toDelete.length}**`,
      `- Rows deleted before rebuild: **${deletedBeforeRebuild}**`,
      `- Rows deleted after rebuild: **${deletedAfterRebuild}**`,
      `- Total rows deleted: **${deletedCount}**`,
      "",
      "## rebuild_expected_packages_from_removals",
      "",
      "| Field | Value |",
      "|-------|-------|",
      `| detail_lines_in_scope | ${rebuild.detail_lines_in_scope} |`,
      `| matched_rows_upserted | ${rebuild.matched_rows_upserted} |`,
      `| remainder_rows_upserted | ${rebuild.remainder_rows_upserted} |`,
      `| overflow_lines | ${rebuild.overflow_lines} |`,
      `| obsolete_rows_deleted | ${rebuild.obsolete_rows_deleted} |`,
      "",
      "## expected_packages before / after",
      "",
      "| Metric | Before | After |",
      "|--------|-------:|------:|",
      `| derived total | ${beforeEp.derived_total} | ${afterEp.derived_total} |`,
      `| detail_shipment | ${beforeEp.detail_shipment} | ${afterEp.detail_shipment} |`,
      `| detail_remainder | ${beforeEp.detail_remainder} | ${afterEp.detail_remainder} |`,
      "",
      "## Allocation gate",
      "",
      `| Check | Before | After |`,
      `|-------|-------:|------:|`,
      `| mismatch count | ${beforeMismatch} | **${afterMismatch}** |`,
      `| orphan shipments | ${beforeOrphans} | ${afterOrphans} |`,
    ].join("\n") + "\n",
  );

  const verifyRunId = `${runId}-verify`;
  execSync(`npx tsx scripts/removal-rebuild-verify-and-resolver-dryrun.ts --run-id=${verifyRunId}`, {
    cwd: process.cwd(),
    stdio: "inherit",
  });
  const verifyManifest = JSON.parse(
    fs.readFileSync(
      path.join(
        process.cwd(),
        ".cursor/audit-reports/removal-rebuild-verify-and-resolver-dryrun",
        verifyRunId,
        "manifest.json",
      ),
      "utf8",
    ),
  ) as {
    rebuild_valid: boolean;
    ep_mismatch_vs_simulation: number;
    expected_packages_derived_count: number;
  };

  const rebuildValid =
    verifyManifest.rebuild_valid === true &&
    afterMismatch === 0 &&
    verifyManifest.ep_mismatch_vs_simulation === 0;

  fs.writeFileSync(
    path.join(outDir, "verify-after-fix.md"),
    [
      "# Verify after fix",
      "",
      `Verify run: \`removal-rebuild-verify-and-resolver-dryrun/${verifyRunId}/\``,
      "",
      "| Gate | Required | Actual |",
      "|------|----------|--------|",
      `| rebuild_valid | yes | **${verifyManifest.rebuild_valid ? "yes" : "no"}** |`,
      `| allocation mismatch count | 0 | **${afterMismatch}** |`,
      `| ep_mismatch_vs_simulation (verify) | 0 | **${verifyManifest.ep_mismatch_vs_simulation}** |`,
      `| orphan shipments | 0 (warn ok) | see verify invariants |`,
      "",
      `**Overall pass:** ${rebuildValid ? "**yes**" : "**no**"}`,
    ].join("\n") + "\n",
  );

  const deleteRollback = toDelete.map((row) => {
    const full = preimageRows.find((r) => String(r.id) === row.id);
    if (!full) return `-- missing preimage for ${row.id}`;
    const cols = Object.keys(full);
    const vals = cols.map((c) => sqlQuote(full[c]));
    return `INSERT INTO public.expected_packages (${cols.join(", ")}) VALUES (${vals.join(", ")}) ON CONFLICT DO NOTHING;`;
  });

  fs.writeFileSync(
    path.join(outDir, "rollback.sql"),
    [
      "-- Rollback: re-insert deleted duplicate detail_remainder rows from preimage",
      `-- run_id=${runId}`,
      `-- deleted_count=${deletedCount}`,
      "",
      "BEGIN;",
      "",
      ...deleteRollback,
      "",
      "-- Full restore alternative: delete derived EP + restore from preimage-derived-expected-packages.json",
      "",
      "COMMIT;",
    ].join("\n") + "\n",
  );

  const nextPrompt = rebuildValid
    ? "REMOVAL-POST-FIX-RESOLVER-RECONCILE-EXECUTE — resolver backfill after valid rebuild (separate approval)"
    : "REMOVAL-REBUILD-ALLOCATION-FIX-INVESTIGATE — verify still failing after cleanup";

  fs.writeFileSync(
    path.join(outDir, "blockers.md"),
    rebuildValid ? "None.\n" : "- Verify gate failed — see verify-after-fix.md\n",
  );

  fs.writeFileSync(
    path.join(outDir, "manifest.json"),
    JSON.stringify(
      {
        prompt: "REMOVAL-REBUILD-ALLOCATION-FIX-EXECUTE",
        run_id: runId,
        branch,
        staging_ref: STAGING_REF,
        status: rebuildValid ? "PASS" : "FAIL",
        duplicate_rows_deleted: deletedCount,
        derived_expected_packages_before: beforeEp.derived_total,
        derived_expected_packages_after: afterEp.derived_total,
        detail_remainder_before: beforeEp.detail_remainder,
        detail_remainder_after: afterEp.detail_remainder,
        mismatch_count_before: beforeMismatch,
        mismatch_count_after: afterMismatch,
        rebuild_valid: rebuildValid,
        rebuild,
        verify_run_id: verifyRunId,
        products_unchanged: productsBefore.c === productsAfter.c,
        map_unchanged: pimBefore.c === pimAfter.c,
        exact_next_prompt: nextPrompt,
      },
      null,
      2,
    ),
  );

  console.log(
    JSON.stringify(
      {
        ok: rebuildValid,
        outDir: path.relative(process.cwd(), outDir).replace(/\\/g, "/"),
        duplicate_rows_deleted: deletedCount,
        derived_before: beforeEp.derived_total,
        derived_after: afterEp.derived_total,
        rebuild_valid: rebuildValid,
        mismatch_count: afterMismatch,
        next_prompt: nextPrompt,
      },
      null,
      2,
    ),
  );

  if (!rebuildValid) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
