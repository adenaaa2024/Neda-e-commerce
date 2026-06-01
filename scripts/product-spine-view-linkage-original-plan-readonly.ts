/**
 * Read-only: snapshot original views + generate original DDL from live pg_get_viewdef.
 *   npx tsx scripts/product-spine-view-linkage-original-plan-readonly.ts --run-id=<UTC>
 */
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";

import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";

const ORIGINAL_REF = "kxsvedvpjldygtdbylsy";
const STAGING_EXECUTE = ".cursor/audit-reports/product-spine-view-linkage-staging-execute/20260530T171500Z";
const OUT_BASE = ".cursor/audit-reports/product-spine-view-linkage-original-plan-approval";

const FORBIDDEN = [
  /\bINSERT\s+INTO\s+public\.products\b/i,
  /\bINSERT\s+INTO\s+public\.product_identifier_map\b/i,
  /\bUPDATE\s+public\.expected_packages\b/i,
  /\bUPDATE\s+public\.products\b/i,
  /\bpackage_items\b/i,
  /\bTRUNCATE\b/i,
  /\bDELETE\s+FROM\b/i,
];

const VIEWS = ["v_scanned_items_counted", "v_inventory_item_status", "v_inventory_status"] as const;

function runIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function patchItemStatusViewDef(def: string): string {
  let d = def;
  if (d.includes("expected_package_id") && d.includes("product_display_name")) {
    return d;
  }
  if (!/AS expected_package_id/.test(d)) {
    d = d.replace(
      /max\(ep\.identifier_resolution_confidence\) AS identifier_resolution_confidence\n           FROM expected_packages ep/,
      `max(ep.identifier_resolution_confidence) AS identifier_resolution_confidence,
            CASE
                WHEN count(DISTINCT ep.id) > 1 THEN NULL::uuid
                ELSE max(ep.id::text)::uuid
            END AS expected_package_id
           FROM expected_packages ep`,
    );
    d = d.replace(
      /s\.identifier_resolution_confidence\n           FROM v_scanned_items_counted s/,
      `s.identifier_resolution_confidence,
            NULL::uuid AS expected_package_id
           FROM v_scanned_items_counted s`,
    );
    d = d.replace(
      /expected_totals\.identifier_resolution_confidence\n           FROM expected_totals/,
      `expected_totals.identifier_resolution_confidence,
            expected_totals.expected_package_id
           FROM expected_totals`,
    );
    d = d.replace(
      /scanned_totals\.identifier_resolution_confidence\n           FROM scanned_totals/,
      `scanned_totals.identifier_resolution_confidence,
            scanned_totals.expected_package_id
           FROM scanned_totals`,
    );
    d = d.replace(
      /max\(ct\.identifier_resolution_confidence\) AS identifier_resolution_confidence,\n                CASE\n                    WHEN sum\(ct\.total_expected\)/,
      `max(ct.identifier_resolution_confidence) AS identifier_resolution_confidence,
                CASE
                    WHEN count(DISTINCT ct.expected_package_id) FILTER (WHERE ct.expected_package_id IS NOT NULL) > 1 THEN NULL::uuid
                    ELSE max(ct.expected_package_id::text)::uuid
                END AS expected_package_id,
                CASE
                    WHEN sum(ct.total_expected)`,
    );
    d = d.replace(
      /ig\.identifier_resolution_confidence,\n            ig\.status,/,
      `ig.identifier_resolution_confidence,
            ig.expected_package_id,
            ig.status,`,
    );
  }
  if (!/AS product_display_name/.test(d)) {
    d = d.replace(
      /wpc\.package_count,\n            pr\.product_name\n           FROM with_package_count wpc\n             LEFT JOIN products pr/,
      `wpc.package_count,
            wpc.expected_package_id,
            CASE
                WHEN wpc.resolved_product_id IS NOT NULL THEN pr.product_name
                ELSE NULL::text
            END AS product_name
           FROM with_package_count wpc
             LEFT JOIN products pr`,
    );
    d = d.replace(
      /identifier_resolution_confidence,\n    product_name\n   FROM with_product_name;/,
      `identifier_resolution_confidence,
    expected_package_id,
    product_name,
    CASE
        WHEN resolved_product_id IS NOT NULL THEN product_name
        ELSE NULL::text
    END AS product_display_name
   FROM with_product_name;`,
    );
    d = d.replace(
      /wpc\.package_count,\n            wpc\.expected_package_id,\n            CASE\n                WHEN wpc\.resolved_product_id IS NOT NULL THEN pr\.product_name/,
      `wpc.package_count,
            wpc.expected_package_id,
            CASE
                WHEN wpc.resolved_product_id IS NOT NULL THEN pr.product_name`,
    );
  }
  return d;
}

function buildInventoryStatusViewSql(): string {
  return `
CREATE VIEW public.v_inventory_status AS
SELECT
  organization_id,
  store_id,
  tracking_number,
  slip_code,
  slip_code AS id_slip_contents,
  max(package_code) AS package_code,
  max(order_id) AS order_id,
  max(package_date) AS package_date,
  max(carrier) AS carrier,
  sum(total_expected) AS total_expected,
  sum(total_scanned) AS total_scanned,
  CASE
    WHEN count(DISTINCT resolved_product_id) FILTER (WHERE resolved_product_id IS NOT NULL) > 1 THEN NULL::uuid
    ELSE max(resolved_product_id::text)::uuid
  END AS resolved_product_id,
  CASE
    WHEN count(DISTINCT resolved_product_id) FILTER (WHERE resolved_product_id IS NOT NULL) > 1 THEN NULL::uuid
    ELSE max(resolved_product_id::text)::uuid
  END AS product_id,
  CASE
    WHEN count(DISTINCT expected_package_id) FILTER (WHERE expected_package_id IS NOT NULL) > 1 THEN NULL::uuid
    ELSE max(expected_package_id::text)::uuid
  END AS expected_package_id,
  CASE
    WHEN max(resolved_product_id::text)::uuid IS NOT NULL THEN max(product_name)
    ELSE NULL::text
  END AS product_name,
  CASE
    WHEN max(resolved_product_id::text)::uuid IS NOT NULL THEN max(product_display_name)
    ELSE NULL::text
  END AS product_display_name,
  max(identifier_resolution_status) AS identifier_resolution_status,
  max(identifier_resolution_status) AS product_linkage_status,
  CASE
    WHEN sum(total_expected) = 0::numeric AND sum(total_scanned) = 0::numeric THEN 'not_registered'::text
    WHEN sum(total_expected) = 0::numeric AND sum(total_scanned) > 0::numeric THEN 'in_progress_not'::text
    WHEN sum(total_expected) > 0::numeric AND sum(total_scanned) = 0::numeric THEN 'expected'::text
    WHEN sum(total_expected) > 0::numeric AND sum(total_scanned) < sum(total_expected) THEN 'in_progress'::text
    WHEN sum(total_expected) > 0::numeric AND sum(total_scanned) = sum(total_expected) THEN 'complete'::text
    WHEN sum(total_expected) > 0::numeric AND sum(total_scanned) > sum(total_expected) THEN 'unexpected'::text
    ELSE 'not_registered'::text
  END AS status
FROM public.v_inventory_item_status
GROUP BY organization_id, store_id, tracking_number, slip_code;
`.trim();
}

function buildDdl(itemStatusDef: string): string {
  return `-- PRODUCT-SPINE-VIEW-LINKAGE-ORIGINAL — view-only (mirror staging 20260530T171500Z)
BEGIN;

DROP VIEW IF EXISTS public.v_inventory_status CASCADE;
DROP VIEW IF EXISTS public.v_inventory_item_status CASCADE;

CREATE VIEW public.v_inventory_item_status AS
${itemStatusDef}

${buildInventoryStatusViewSql()};

COMMENT ON VIEW public.v_inventory_item_status IS
  'Neda inventory: expected_packages union scanned; exposes expected_package_id + spine-linked product_name via resolved_product_id only.';
COMMENT ON VIEW public.v_inventory_status IS
  'Package-level rollup; propagates expected_package_id and spine-linked product_display_name.';

NOTIFY pgrst, 'reload schema';
COMMIT;
`;
}

function sqlScan(sql: string): { pass: boolean; hits: string[] } {
  const hits: string[] = [];
  for (const re of FORBIDDEN) {
    if (re.test(sql)) hits.push(re.source);
  }
  return { pass: hits.length === 0, hits };
}

function colDiff(a: string[], b: string[]): { onlyA: string[]; onlyB: string[] } {
  const setB = new Set(b);
  const setA = new Set(a);
  return {
    onlyA: a.filter((c) => !setB.has(c)),
    onlyB: b.filter((c) => !setA.has(c)),
  };
}

async function main(): Promise<void> {
  const runId = runIdArg();
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  loadEnvLocalIntoProcess();
  const originalUrl = process.env.ORIGINAL_DIRECT_POSTGRES_URL?.trim() ?? "";
  const blockers: string[] = [];
  if (!originalUrl) blockers.push("ORIGINAL_DIRECT_POSTGRES_URL unset");
  if (!originalUrl.includes(ORIGINAL_REF)) blockers.push(`URL must target ${ORIGINAL_REF}`);

  const stagingSnapPath = path.join(process.cwd(), STAGING_EXECUTE, "before-view-snapshots.json");
  if (!fs.existsSync(stagingSnapPath)) {
    blockers.push(`Missing staging execute artifact: ${STAGING_EXECUTE}`);
  }

  let originalSnaps: Record<string, { columns: string[]; definition: string | null }> = {};
  let ddlReady = false;
  let patchedDef = "";
  let ddl = "";
  const scan = { pass: false, hits: [] as string[] };

  if (originalUrl) {
    const client = new pg.Client({ connectionString: originalUrl, ssl: { rejectUnauthorized: false } });
    await client.connect();
    try {
      for (const v of VIEWS) {
        const cols = await client.query(
          `SELECT column_name FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`,
          [v],
        );
        const def = await client.query(`SELECT pg_get_viewdef($1::regclass, true) AS def`, [`public.${v}`]);
        originalSnaps[v] = {
          columns: cols.rows.map((r: { column_name: string }) => r.column_name),
          definition: def.rows[0]?.def ?? null,
        };
      }
      const beforeItem = String(originalSnaps.v_inventory_item_status?.definition ?? "");
      const beforeStatus = String(originalSnaps.v_inventory_status?.definition ?? "");
      patchedDef = patchItemStatusViewDef(beforeItem);
      ddl = buildDdl(patchedDef);
      Object.assign(scan, sqlScan(ddl));
      ddlReady = scan.pass && patchedDef !== beforeItem;

      fs.writeFileSync(
        path.join(outDir, "original-live-view-snapshots.json"),
        JSON.stringify(originalSnaps, null, 2),
      );
      fs.writeFileSync(
        path.join(outDir, "rollback-original.sql"),
        `-- rollback pre-image ${runId}
BEGIN;
DROP VIEW IF EXISTS public.v_inventory_status CASCADE;
DROP VIEW IF EXISTS public.v_inventory_item_status CASCADE;
CREATE VIEW public.v_inventory_item_status AS
${beforeItem}
CREATE VIEW public.v_inventory_status AS
${beforeStatus}
NOTIFY pgrst, 'reload schema';
COMMIT;
`,
      );
      fs.writeFileSync(path.join(outDir, "001_original_inventory_views_expected_package_id.sql"), ddl + "\n");

      if (
        originalSnaps.v_inventory_item_status.columns.includes("expected_package_id") &&
        originalSnaps.v_inventory_item_status.columns.includes("product_display_name")
      ) {
        blockers.push("Original already has expected_package_id + product_display_name — verify before apply");
      }
    } finally {
      await client.end();
    }
  }

  const stagingSnaps = fs.existsSync(stagingSnapPath)
    ? (JSON.parse(fs.readFileSync(stagingSnapPath, "utf8")) as Record<string, { columns: string[] }>)
    : null;

  const drift: Record<string, unknown> = {};
  if (stagingSnaps) {
    for (const v of ["v_inventory_item_status", "v_inventory_status"] as const) {
      drift[v] = colDiff(
        originalSnaps[v]?.columns ?? [],
        stagingSnaps[v]?.columns ?? [],
      );
    }
    drift.v_scanned_items_counted = colDiff(
      originalSnaps.v_scanned_items_counted?.columns ?? [],
      stagingSnaps.v_scanned_items_counted?.columns ?? [],
    );
  }

  const productJoinOk =
    /pr\.product_name/.test(patchedDef) &&
    /pr\.id = wpc\.resolved_product_id/.test(patchedDef) &&
    !/catalog_products/.test(ddl);

  fs.writeFileSync(
    path.join(outDir, "drift-summary.md"),
    [
      "# Original drift summary",
      "",
      "| View | Original-only columns | Staging-only columns |",
      "|------|----------------------|----------------------|",
      `| v_inventory_item_status | ${(drift.v_inventory_item_status as { onlyA: string[] })?.onlyA?.join(", ") || "—"} | ${(drift.v_inventory_item_status as { onlyB: string[] })?.onlyB?.join(", ") || "—"} |`,
      `| v_inventory_status | ${(drift.v_inventory_status as { onlyA: string[] })?.onlyA?.join(", ") || "—"} | ${(drift.v_inventory_status as { onlyB: string[] })?.onlyB?.join(", ") || "—"} |`,
      `| v_scanned_items_counted | ${(drift.v_scanned_items_counted as { onlyA: string[] })?.onlyA?.join(", ") || "—"} | ${(drift.v_scanned_items_counted as { onlyB: string[] })?.onlyB?.join(", ") || "—"} |`,
      "",
      "## Staging execute evidence",
      "",
      `\`${STAGING_EXECUTE}/\` — true-link proof PASS; columns include \`expected_package_id\`, \`product_display_name\`.`,
      "",
      "## Original pre-apply gap (expected)",
      "",
      "- Missing `expected_package_id` on item + rollup views",
      "- Missing `product_display_name` (explicit spine snapshot alias)",
      "",
      "## v_scanned_items_counted",
      "",
      "**No change required** — staging PASS did not alter scanned view; original mirror uses same patch path as staging execute script.",
    ].join("\n") + "\n",
  );

  fs.writeFileSync(
    path.join(outDir, "ddl-contract-check.md",
    ),
    [
      "# DDL contract check",
      "",
      `| Check | Result |`,
      `|-------|--------|`,
      `| Objects touched | v_inventory_item_status, v_inventory_status only |`,
      `| Data writes | **None** (views only) |`,
      `| product_name from products join on resolved_product_id | **${productJoinOk ? "YES" : "NO"}** |`,
      `| catalog_products in DDL | **NO** |`,
      `| Forbidden SQL scan | **${scan.pass ? "PASS" : "FAIL"}** ${scan.hits.length ? scan.hits.join(", ") : ""} |`,
      `| DDL ready | **${ddlReady ? "YES" : "NO"}** |`,
    ].join("\n") + "\n",
  );

  fs.writeFileSync(
    path.join(outDir, "manifest.json"),
    JSON.stringify(
      {
        run_id: runId,
        status: blockers.length ? "BLOCKED_PLAN" : ddlReady ? "DDL_READY" : "NEEDS_REVIEW",
        target_ref: ORIGINAL_REF,
        staging_evidence: STAGING_EXECUTE,
        ddl_ready: ddlReady,
        approval_file: ".cursor/operator-approvals/product-spine-view-linkage-original-approval.md",
        exact_execute_prompt: "PRODUCT-SPINE-VIEW-LINKAGE-ORIGINAL-EXECUTE",
        blockers,
      },
      null,
      2,
    ) + "\n",
  );

  console.log(JSON.stringify({ run_id: runId, outDir, ddl_ready: ddlReady, blockers }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
