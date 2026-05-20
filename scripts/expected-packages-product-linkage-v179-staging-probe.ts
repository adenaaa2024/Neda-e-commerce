/**
 * EXPECTED-PACKAGES-PRODUCT-LINKAGE-V179 — staging schema + linkage probe (read-only).
 *
 *   npx tsx scripts/expected-packages-product-linkage-v179-staging-probe.ts --run-id=<id>
 */
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";
import { createClient } from "@supabase/supabase-js";

import {
  assessLinkageReadiness,
  buildNedaExpectedPackageReadRow,
  type ExpectedPackageDbRow,
} from "../lib/expected-packages-product-linkage";
import { getStagingProjectRef, loadEnvLocalIntoProcess, refFromSupabaseUrl } from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";

function runIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

async function columnList(client: pg.Client, table: string): Promise<string[]> {
  const r = await client.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position`,
    [table],
  );
  return r.rows.map((x: { column_name: string }) => x.column_name);
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const runId = runIdArg();
  const outDir = path.join(
    process.cwd(),
    ".cursor/audit-reports/expected-packages-product-linkage-v179",
    runId,
  );
  fs.mkdirSync(outDir, { recursive: true });

  const dbUrl =
    process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ||
    process.env.DIRECT_POSTGRES_URL?.trim() ||
    "";
  const url = process.env.STAGING_SUPABASE_URL?.trim() || process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() || "";
  const key = process.env.STAGING_SERVICE_ROLE_KEY?.trim() || process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() || "";
  const ref = refFromSupabaseUrl(url) || refFromSupabaseUrl(dbUrl);

  if (!dbUrl || ref !== STAGING_REF || getStagingProjectRef({ loadEnv: false }) !== STAGING_REF) {
    fs.writeFileSync(
      path.join(outDir, "manifest.json"),
      JSON.stringify({ run_id: runId, status: "FAIL", error: "staging ref guard" }, null, 2),
    );
    process.exit(2);
  }

  const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();
  await client.query(`SET statement_timeout = '120s'`);

  const pkgItemsForbidden = await client.query(
    `SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='package_items'`,
  );
  if ((pkgItemsForbidden.rowCount ?? 0) > 0) {
    await client.end();
    fs.writeFileSync(
      path.join(outDir, "blockers.md"),
      "# Blockers\n\n**FAIL:** `package_items` table exists (forbidden).\n",
    );
    process.exit(2);
  }

  const cols = await columnList(client, "expected_packages");
  const hasResolver = cols.includes("resolved_product_id");
  const idCols = ["sku", "fnsku", "asin", "upc", "upc_code", "product_id", "store_id", "organization_id"];

  const countRes = await client.query(`SELECT COUNT(*)::bigint AS n FROM public.expected_packages`);
  const total = Number(countRes.rows[0]?.n ?? 0);

  const resolvedCol = hasResolver
    ? await client.query(
        `SELECT COUNT(*)::bigint AS n FROM public.expected_packages WHERE resolved_product_id IS NOT NULL`,
      )
    : { rows: [{ n: "0" }] };
  const resolvedPersisted = Number(resolvedCol.rows[0]?.n ?? 0);

  const viewsRes = await client.query(`
    SELECT c.relname AS view_name
    FROM pg_depend d
    JOIN pg_rewrite r ON r.oid = d.objid
    JOIN pg_class c ON c.oid = r.ev_class
    JOIN pg_class t ON t.oid = d.refobjid
    WHERE t.relname = 'expected_packages' AND c.relkind = 'v'
    GROUP BY c.relname
    ORDER BY c.relname
  `);

  const sampleRes = await client.query(`SELECT * FROM public.expected_packages ORDER BY updated_at DESC NULLS LAST LIMIT 25`);
  const sampleRows = sampleRes.rows as ExpectedPackageDbRow[];

  await client.end();

  const supabase = createClient(url, key, { auth: { persistSession: false } });
  const nedaRows = [];
  for (const row of sampleRows.slice(0, 15)) {
    nedaRows.push(await buildNedaExpectedPackageReadRow(supabase, row, 0));
  }
  const readiness = assessLinkageReadiness(
    {
      table_exists: true,
      columns: cols,
      has_store_id: cols.includes("store_id"),
      has_resolver_columns: hasResolver,
      has_identifiers: idCols.some((c) => cols.includes(c)),
      row_count: total,
    },
    nedaRows,
  );

  const mapResolved = nedaRows.filter((r) => r.product_linkage.is_resolved).length;
  const mapAmbiguous = nedaRows.filter(
    (r) => r.product_linkage.identifier_resolution_status === "ambiguous",
  ).length;

  const ddlNeeded = !hasResolver;

  fs.writeFileSync(
    path.join(outDir, "expected-packages-schema.md"),
    [
      "# expected_packages schema (staging)",
      "",
      `**Staging ref:** \`${STAGING_REF}\``,
      `**Probed:** ${new Date().toISOString()}`,
      `**Row count:** ${total}`,
      "",
      "## Columns",
      "",
      cols.map((c) => `- \`${c}\``).join("\n"),
      "",
      "## Identifier / scope fields",
      "",
      idCols
        .filter((c) => cols.includes(c))
        .map((c) => `- \`${c}\` ✓`)
        .join("\n") || "- _(none of sku/fnsku/asin/upc/product_id)_",
      "",
      "## Resolver columns",
      "",
      hasResolver
        ? "- `resolved_product_id`, `resolved_catalog_product_id`, `identifier_resolution_status`, `identifier_resolution_confidence` **present**"
        : "- **Not present** — linkage is **read-time** via `product_identifier_map` only (V179).",
      "",
      resolvedPersisted > 0
        ? `**${resolvedPersisted}** rows with persisted resolved_product_id`
        : "**0** rows with persisted resolved_product_id",
    ].join("\n"),
  );

  fs.writeFileSync(
    path.join(outDir, "expected-packages-linkage-status.md"),
    [
      "# Linkage status",
      "",
      `**Readiness:** **${readiness}**`,
      "",
      "| Mechanism | Status |",
      "|-----------|--------|",
      "| Direct `resolved_product_id` on row | " + (hasResolver ? "column exists" : "**no column**") + " |",
      "| Persisted values populated | " + (resolvedPersisted > 0 ? `${resolvedPersisted} rows` : "none") + " |",
      "| Read-time `product_identifier_map` (sku/fnsku/asin + org/store) | **enabled** (`resolveScannerProductIdentifiers`) |",
      "| Sample resolved (n=15) | " + mapResolved + " |",
      "| Sample ambiguous (n=15) | " + mapAmbiguous + " |",
      "",
      "**Classification:** identifier-only but **resolvable at read** when `store_id` + identifiers present.",
      "",
      "Prior V174 exempt note is superseded for **read path** — still **no blind DB backfill** without approval.",
    ].join("\n"),
  );

  fs.writeFileSync(
    path.join(outDir, "expected-packages-neda-read-contract.md"),
    [
      "# Neda read contract (V179)",
      "",
      "Types: `lib/expected-packages-neda-read-contract.ts`",
      "Server: `app/returns/expected-packages-linkage-actions.ts` → `fetchExpectedPackagesNedaRead`",
      "",
      "## Row shape (`NedaExpectedPackageReadRow`)",
      "",
      "- `expected_package_id`, `organization_id`, `store_id`, `order_id`, `tracking_number`",
      "- `sku`, `fnsku`, `asin`, `disposition`",
      "- `expected_quantity` — `expected_scan_quantity` → `shipped_quantity` → `1`",
      "- `scanned_quantity` — count `return_items` on `packages` matching tracking/order + sku/fnsku",
      "- `variance_status` — `matched` | `under_scanned` | `over_scanned` | `unknown` | `no_scan_target`",
      "- `product_linkage` — `ProductLinkageDisplayContract`",
      "- `linkage_source` — `persisted_column` | `identifier_map` | `unresolved`",
      "",
      "## Scanned join strategy",
      "",
      "1. Find `packages.id` where `organization_id` matches and `tracking_number` ILIKE expected row (fallback `order_id`).",
      "2. Count `return_items` with `package_id` IN those packages, same org/store, match `fnsku` else `sku`.",
      "",
      "**Note:** Staging `return_items` is mostly test data — variance counts are illustrative only.",
    ].join("\n"),
  );

  fs.writeFileSync(
    path.join(outDir, "deterministic-mapping-plan.md"),
    [
      "# Deterministic mapping plan (read-only)",
      "",
      "Allowed tiers (same as V176):",
      "",
      "1. FNSKU exact + org + store",
      "2. SKU + ASIN exact + org + store",
      "3. SKU exact + org + store",
      "4. ASIN exact + org + store (from row or `amazon_removals` via `source_detail_row_id`)",
      "",
      "Forbidden: title/OCR/fuzzy, auto-create product, UI writes, production.",
      "",
      "## Optional future backfill (operator approval only)",
      "",
      "If `resolved_product_id` columns are added, run tiered SQL backfill mirroring V176 keyed-map pattern.",
      "Until then: **no writes**; `fetchExpectedPackagesNedaRead` resolves in memory per request.",
    ].join("\n"),
  );

  fs.writeFileSync(
    path.join(outDir, "ddl-plan-if-needed.md"),
    ddlNeeded
      ? [
          "# DDL plan (recommended — not applied in V179)",
          "",
          "Add nullable resolver quad to `expected_packages` (idempotent):",
          "",
          "```sql",
          "ALTER TABLE public.expected_packages",
          "  ADD COLUMN IF NOT EXISTS resolved_product_id uuid,",
          "  ADD COLUMN IF NOT EXISTS resolved_catalog_product_id uuid,",
          "  ADD COLUMN IF NOT EXISTS identifier_resolution_status text,",
          "  ADD COLUMN IF NOT EXISTS identifier_resolution_confidence numeric(10,4);",
          "",
          "CREATE INDEX IF NOT EXISTS idx_expected_packages_org_resolved",
          "  ON public.expected_packages (organization_id, resolved_product_id)",
          "  WHERE resolved_product_id IS NOT NULL;",
          "```",
          "",
          "**Does not authorize backfill.** Separate approval + audit required.",
        ].join("\n")
      : [
          "# DDL plan",
          "",
          "Resolver columns **already exist** on staging. No DDL required for read path.",
          "Optional: backfill only with separate operator approval.",
        ].join("\n"),
  );

  const views = viewsRes.rows.map((v: { view_name: string }) => v.view_name);
  fs.writeFileSync(
    path.join(outDir, "validation-results.md"),
    [
      "# Validation results",
      "",
      `**Run:** ${runId}`,
      `**Staging ref:** \`${STAGING_REF}\``,
      "",
      "## Probe",
      "",
      "| Check | Result |",
      "|-------|--------|",
      "| `package_items` absent | PASS |",
      `| expected_packages row count | ${total} |`,
      `| resolver columns on table | ${hasResolver ? "yes" : "no"} |`,
      `| persisted resolved_product_id rows | ${resolvedPersisted} |`,
      `| sample linkage readiness (n=15) | **${readiness}** |`,
      `| sample resolved | ${mapResolved}/15 |`,
      `| sample ambiguous | ${mapAmbiguous}/15 |`,
      "",
      "## Views referencing expected_packages",
      "",
      views.length > 0 ? views.map((v) => `- \`${v}\``).join("\n") : "- _(none found via pg_depend)_",
      "",
      "## Build",
      "",
      "_See npm run build output appended after local run._",
    ].join("\n"),
  );

  fs.writeFileSync(
    path.join(outDir, "blockers.md"),
    [
      "# Blockers",
      "",
      readiness === "FAIL"
        ? "- Linkage readiness FAIL — missing identifiers or table."
        : "- None blocking read path.",
      "",
      "- Staging `return_items` test data limits variance validation.",
      "- Full-table tier-2 SKU+ASIN **count** on expected_packages can be slow — use filtered `fetchExpectedPackagesNedaRead` (order/tracking).",
      "",
      ddlNeeded ? "- **DDL optional** for persisted resolver columns (see ddl-plan-if-needed.md)." : "",
    ]
      .filter(Boolean)
      .join("\n"),
  );

  fs.writeFileSync(
    path.join(outDir, "manifest.json"),
    JSON.stringify(
      {
        prompt_id: "EXPECTED-PACKAGES-PRODUCT-LINKAGE-V179",
        run_id: runId,
        status: readiness === "FAIL" ? "FAIL" : "PASS",
        linkage_readiness: readiness,
        ddl_needed: ddlNeeded,
        neda_can_read_now: readiness !== "FAIL",
        artifacts: [
          "expected-packages-schema.md",
          "expected-packages-linkage-status.md",
          "expected-packages-neda-read-contract.md",
          "deterministic-mapping-plan.md",
          "ddl-plan-if-needed.md",
          "validation-results.md",
          "blockers.md",
          "manifest.json",
        ],
      },
      null,
      2,
    ),
  );

  console.log(
    JSON.stringify(
      {
        run_id: runId,
        outDir,
        linkage_readiness: readiness,
        ddl_needed: ddlNeeded,
        neda_can_read_now: readiness !== "FAIL",
      },
      null,
      2,
    ),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
