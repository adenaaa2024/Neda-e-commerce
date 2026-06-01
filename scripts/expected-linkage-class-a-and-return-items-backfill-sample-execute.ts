/**
 * EXPECTED-LINKAGE-CLASS-A-AND-RETURN-ITEMS-BACKFILL-SAMPLE-EXECUTE
 *   npx tsx scripts/expected-linkage-class-a-and-return-items-backfill-sample-execute.ts --run-id=<UTC>
 *   npx tsx scripts/expected-linkage-class-a-and-return-items-backfill-sample-execute.ts --run-id=<UTC> --apply
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
const PLAN_RUN_ID = "20260607T170000Z";
const PLAN_DIR = `.cursor/audit-reports/expected-linkage-class-a-and-return-items-backfill-plan/${PLAN_RUN_ID}`;
const APPROVAL_PATH =
  ".cursor/operator-approvals/expected-linkage-class-a-and-return-items-backfill-sample-approval.md";
const OUT_BASE = ".cursor/audit-reports/expected-linkage-class-a-and-return-items-backfill-sample-execute";
const ORG = "00000000-0000-0000-0000-000000000001";
const STORE = "509ee1f6-622c-46a5-8110-7b889ba46c2c";
const MAX_CLASS_A = 2;
const MAX_RETURN_SAMPLE = 50;

type Row = Record<string, string>;

type ClassARow = {
  expected_package_id: string;
  proposed_resolved_product_id: string;
  tracking_number: string;
  sku: string;
  fnsku: string;
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

function parseCsv(text: string): Row[] {
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length < 2) return [];
  const headers = parseCsvLine(lines[0]!);
  return lines.slice(1).map((line) => {
    const vals = parseCsvLine(line);
    const o: Row = {};
    headers.forEach((h, i) => {
      o[h] = vals[i] ?? "";
    });
    return o;
  });
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

function sqlLit(v: string | null | undefined): string {
  if (v == null || v === "") return "NULL";
  return `'${String(v).replace(/'/g, "''")}'`;
}

function readApproval(): boolean {
  const p = path.join(process.cwd(), APPROVAL_PATH);
  if (!fs.existsSync(p)) return false;
  const text = fs.readFileSync(p, "utf8");
  return (
    /APPROVED_TO_RUN_STAGING\s*=\s*true/i.test(text) &&
    /APPROVED_CLASS_A_EP_BACKFILL\s*=\s*true/i.test(text) &&
    /APPROVED_CLASS_A_EP_MAX_2\s*=\s*true/i.test(text) &&
    /APPROVED_RETURN_ITEMS_EP_COPY_SAMPLE\s*=\s*true/i.test(text) &&
    /APPROVED_RETURN_ITEMS_SAMPLE_MAX_50\s*=\s*true/i.test(text) &&
    /APPROVED_PRODUCT_CREATE\s*=\s*false/i.test(text) &&
    /APPROVED_MAP_INSERT\s*=\s*false/i.test(text) &&
    new RegExp(`TARGET_SUPABASE_REF\\s*=\\s*${STAGING_REF}`, "i").test(text)
  );
}

function loadClassA(): ClassARow[] {
  const raw = JSON.parse(fs.readFileSync(path.join(process.cwd(), PLAN_DIR, "class-a-rows.json"), "utf8")) as ClassARow[];
  if (raw.length > MAX_CLASS_A) {
    throw new Error(`Class A plan exceeds max ${MAX_CLASS_A}: ${raw.length}`);
  }
  return raw;
}

function loadReturnSample(): Row[] {
  const rows = parseCsv(fs.readFileSync(path.join(process.cwd(), PLAN_DIR, "sample-50-return-items.csv"), "utf8"));
  if (rows.length > MAX_RETURN_SAMPLE) {
    throw new Error(`Return sample exceeds max ${MAX_RETURN_SAMPLE}: ${rows.length}`);
  }
  return rows;
}

async function linkageCounts(client: pg.Client): Promise<Record<string, number>> {
  const r = await client.query(`
    SELECT
      (SELECT COUNT(*)::int FROM public.products) AS products,
      (SELECT COUNT(*)::int FROM public.expected_packages) AS expected_packages,
      (SELECT COUNT(*)::int FROM public.expected_packages WHERE resolved_product_id IS NOT NULL) AS ep_resolved,
      (SELECT COUNT(*)::int FROM public.return_items WHERE deleted_at IS NULL) AS return_items_active,
      (SELECT COUNT(*)::int FROM public.return_items WHERE deleted_at IS NULL AND resolved_product_id IS NOT NULL) AS return_items_resolved,
      (SELECT COUNT(*)::int
         FROM public.return_items ri
         JOIN public.expected_packages ep ON ep.id = ri.expected_item_id
        WHERE ri.deleted_at IS NULL
          AND ri.resolved_product_id IS NULL
          AND ep.resolved_product_id IS NOT NULL) AS ep_resolved_return_not
  `);
  return r.rows[0] as Record<string, number>;
}

async function main(): Promise<void> {
  const runId = runIdArg();
  const apply = process.argv.includes("--apply");
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  if (!readApproval()) {
    throw new Error(`Approval flags missing or false in ${APPROVAL_PATH}`);
  }

  const classAPlan = loadClassA();
  const returnSample = loadReturnSample();
  if (classAPlan.length === 0) throw new Error("No Class A rows in plan");
  if (returnSample.length === 0) throw new Error("No return_items sample rows");

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
  await client.query("SET statement_timeout = '120s'");

  const beforeCounts = await linkageCounts(client);

  const classAPre = await client.query(
    `
    WITH plan AS (
      SELECT *
      FROM jsonb_to_recordset($1::jsonb) AS x(
        expected_package_id uuid,
        proposed_resolved_product_id uuid
      )
    )
    SELECT
      ep.id::text,
      ep.resolved_product_id::text,
      ep.identifier_resolution_status,
      ep.tracking_number,
      ep.sku,
      ep.fnsku,
      COUNT(DISTINCT m.product_id) FILTER (WHERE m.product_id IS NOT NULL)::int AS map_product_count,
      MIN(m.product_id::text) FILTER (WHERE m.product_id IS NOT NULL) AS map_product_id
    FROM plan p
    JOIN public.expected_packages ep ON ep.id = p.expected_package_id
    LEFT JOIN public.product_identifier_map m
      ON m.organization_id = ep.organization_id
     AND m.store_id = ep.store_id
     AND m.deleted_at IS NULL
     AND m.product_id IS NOT NULL
     AND (
       (NULLIF(btrim(ep.fnsku), '') IS NOT NULL AND upper(btrim(m.fnsku)) = upper(btrim(ep.fnsku)))
       OR (NULLIF(btrim(ep.sku), '') IS NOT NULL AND upper(btrim(m.seller_sku)) = upper(btrim(ep.sku)))
     )
    GROUP BY ep.id, ep.resolved_product_id, ep.identifier_resolution_status, ep.tracking_number, ep.sku, ep.fnsku
    `,
    [
      JSON.stringify(
        classAPlan.map((r) => ({
          expected_package_id: r.expected_package_id,
          proposed_resolved_product_id: r.proposed_resolved_product_id,
        })),
      ),
    ],
  );

  const returnPre = await client.query(
    `
    WITH sample AS (
      SELECT *
      FROM jsonb_to_recordset($1::jsonb) AS x(
        return_item_id uuid,
        expected_item_id uuid,
        ep_resolved_product_id uuid
      )
    )
    SELECT
      ri.id::text AS return_item_id,
      ri.resolved_product_id::text AS current_resolved_product_id,
      ri.product_id::text AS legacy_product_id,
      ri.identifier_resolution_status,
      ri.identifier_resolution_confidence::text,
      ep.resolved_product_id::text AS ep_resolved_product_id
    FROM sample s
    JOIN public.return_items ri ON ri.id = s.return_item_id
    JOIN public.expected_packages ep ON ep.id = s.expected_item_id
    WHERE ri.deleted_at IS NULL
    `,
    [
      JSON.stringify(
        returnSample.map((r) => ({
          return_item_id: r.return_item_id,
          expected_item_id: r.expected_item_id,
          ep_resolved_product_id: r.ep_resolved_product_id,
        })),
      ),
    ],
  );

  const blockers: string[] = [];
  for (const row of classAPre.rows) {
    if (Number(row.map_product_count) !== 1) {
      blockers.push(`Class A EP ${row.id}: map_product_count=${row.map_product_count}`);
    }
    if (row.resolved_product_id != null) {
      blockers.push(`Class A EP ${row.id}: already has resolved_product_id`);
    }
    if (String(row.map_product_id) !== classAPlan.find((p) => p.expected_package_id === row.id)?.proposed_resolved_product_id) {
      blockers.push(`Class A EP ${row.id}: map product mismatch vs plan`);
    }
  }
  if (returnPre.rows.length !== returnSample.length) {
    blockers.push(`Return sample row count mismatch: expected ${returnSample.length}, found ${returnPre.rows.length}`);
  }
  for (const row of returnPre.rows) {
    if (row.current_resolved_product_id != null) {
      blockers.push(`Return item ${row.return_item_id}: already resolved`);
    }
    if (row.ep_resolved_product_id == null) {
      blockers.push(`Return item ${row.return_item_id}: linked EP unresolved`);
    }
    if (
      row.legacy_product_id != null &&
      row.legacy_product_id !== row.ep_resolved_product_id
    ) {
      blockers.push(`Return item ${row.return_item_id}: legacy product_id conflicts EP target`);
    }
  }

  fs.writeFileSync(
    path.join(outDir, "preimage.json"),
    JSON.stringify(
      { before_counts: beforeCounts, class_a_pre: classAPre.rows, return_pre: returnPre.rows, blockers },
      null,
      2,
    ),
  );

  if (blockers.length > 0) {
    fs.writeFileSync(path.join(outDir, "blockers.md"), `# Blocked\n\n${blockers.map((b) => `- ${b}`).join("\n")}\n`);
    await client.end();
    throw new Error(`Pre-flight blockers: ${blockers.join("; ")}`);
  }

  let classAApplied: Record<string, unknown>[] = [];
  let returnApplied: Record<string, unknown>[] = [];

  if (apply) {
    await client.query("BEGIN");
    try {
      for (const row of classAPlan) {
        const upd = await client.query(
          `
          UPDATE public.expected_packages ep
          SET resolved_product_id = $2::uuid,
              identifier_resolution_status = 'resolved',
              updated_at = now()
          WHERE ep.id = $1::uuid
            AND ep.resolved_product_id IS NULL
            AND EXISTS (
              SELECT 1
              FROM public.product_identifier_map m
              WHERE m.organization_id = ep.organization_id
                AND m.store_id = ep.store_id
                AND m.deleted_at IS NULL
                AND m.product_id = $2::uuid
                AND (
                  (NULLIF(btrim(ep.fnsku), '') IS NOT NULL AND upper(btrim(m.fnsku)) = upper(btrim(ep.fnsku)))
                  OR (NULLIF(btrim(ep.sku), '') IS NOT NULL AND upper(btrim(m.seller_sku)) = upper(btrim(ep.sku)))
                )
            )
          RETURNING ep.id::text, ep.resolved_product_id::text, ep.tracking_number
          `,
          [row.expected_package_id, row.proposed_resolved_product_id],
        );
        if (upd.rowCount) classAApplied.push({ ...row, after: upd.rows[0] });
      }

      const retUpd = await client.query(
        `
        WITH sample AS (
          SELECT *
          FROM jsonb_to_recordset($1::jsonb) AS x(return_item_id uuid)
        ),
        updated AS (
          UPDATE public.return_items ri
          SET resolved_product_id = ep.resolved_product_id,
              identifier_resolution_status = 'resolved',
              identifier_resolution_confidence = 1.0,
              updated_at = now()
          FROM public.expected_packages ep, sample s
          WHERE ri.id = s.return_item_id
            AND ri.expected_item_id = ep.id
            AND ri.deleted_at IS NULL
            AND ri.resolved_product_id IS NULL
            AND ep.resolved_product_id IS NOT NULL
            AND (ri.product_id IS NULL OR ri.product_id = ep.resolved_product_id)
          RETURNING ri.id::text, ri.resolved_product_id::text, ep.id::text AS expected_item_id
        )
        SELECT * FROM updated
        `,
        [JSON.stringify(returnSample.map((r) => ({ return_item_id: r.return_item_id })))],
      );
      returnApplied = retUpd.rows;

      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    }
  }

  const afterCounts = await linkageCounts(client);
  await client.end();

  const productCountUnchanged = beforeCounts.products === afterCounts.products;
  const classAOk = classAApplied.length === classAPlan.length || !apply;
  const returnOk = returnApplied.length === returnSample.length || !apply;

  const rollbackLines = [
    "-- Rollback EXPECTED-LINKAGE-CLASS-A-AND-RETURN-ITEMS-BACKFILL-SAMPLE-EXECUTE",
    `-- execute run_id: ${runId}`,
    "",
  ];
  for (const row of classAPre.rows) {
    rollbackLines.push(
      `UPDATE public.expected_packages SET resolved_product_id = ${row.resolved_product_id == null ? "NULL" : `${sqlLit(String(row.resolved_product_id))}::uuid`}, identifier_resolution_status = ${sqlLit(row.identifier_resolution_status as string | null)}, updated_at = now() WHERE id = ${sqlLit(String(row.id))}::uuid;`,
    );
  }
  for (const row of returnPre.rows) {
    rollbackLines.push(
      `UPDATE public.return_items SET resolved_product_id = ${row.current_resolved_product_id == null ? "NULL" : `${sqlLit(String(row.current_resolved_product_id))}::uuid`}, identifier_resolution_status = ${sqlLit(row.identifier_resolution_status as string | null)}, identifier_resolution_confidence = ${row.identifier_resolution_confidence ?? "NULL"}, updated_at = now() WHERE id = ${sqlLit(String(row.return_item_id))}::uuid;`,
    );
  }
  fs.writeFileSync(path.join(outDir, "rollback.sql"), `${rollbackLines.join("\n")}\n`);
  fs.writeFileSync(path.join(outDir, "class-a-applied.json"), JSON.stringify(classAApplied, null, 2));
  fs.writeFileSync(path.join(outDir, "return-items-applied.json"), JSON.stringify(returnApplied, null, 2));

  const verificationPass =
    apply && productCountUnchanged && classAOk && returnOk && blockers.length === 0;

  const remainingOrphans = Number(afterCounts.ep_resolved_return_not ?? 0);

  fs.writeFileSync(
    path.join(outDir, "apply-result.md"),
    [
      "# Expected linkage Class A + return_items sample execute",
      "",
      `- Mode: **${apply ? "APPLY" : "DRY-RUN"}**`,
      `- Plan: \`${PLAN_DIR}\``,
      `- Plan A (Class A EP): **${classAApplied.length}** / ${classAPlan.length}`,
      `- Plan B (return_items): **${returnApplied.length}** / ${returnSample.length}`,
      "",
      "## Counts",
      "",
      `| Metric | Before | After |`,
      `|--------|-------:|------:|`,
      `| products | ${beforeCounts.products} | ${afterCounts.products} |`,
      `| EP resolved | ${beforeCounts.ep_resolved} | ${afterCounts.ep_resolved} |`,
      `| return_items resolved | ${beforeCounts.return_items_resolved} | ${afterCounts.return_items_resolved} |`,
      `| EP resolved / return not | ${beforeCounts.ep_resolved_return_not} | ${afterCounts.ep_resolved_return_not} |`,
      "",
      "## Verification",
      "",
      `- Product count unchanged: ${productCountUnchanged ? "PASS" : "FAIL"}`,
      `- Class A applied: ${classAOk ? "PASS" : "FAIL"}`,
      `- Return sample applied: ${returnOk ? "PASS" : "FAIL"}`,
      `- Overall: **${verificationPass ? "PASS" : apply ? "FAIL" : "PENDING (--apply)"}**`,
      "",
      "## Rollback",
      "",
      `- \`rollback.sql\` in this folder`,
      "",
      "## Next",
      "",
      remainingOrphans > 0
        ? `Scale prompt safe after sample PASS: remaining orphans **${remainingOrphans}** (~2315 before sample). Class C seed remains separate approval.`
        : "Sample cleared orphan pool; Class C seed still separate approval.",
    ].join("\n"),
  );

  fs.writeFileSync(
    path.join(outDir, "exact-scale-prompt.md"),
    `# EXPECTED-LINKAGE-RETURN-ITEMS-BACKFILL-SCALE-WAVE2

Owner: Main/user
Branch: feature/phase1-latest-stash-land
Mode: APPROVAL-GATED STAGING SCALE APPLY
Target: staging only (\`${STAGING_REF}\`)

Precondition:
- Sample execute PASS at \`${OUT_BASE}/${runId}/\`
- Signed approval for scale (max batch size TBD, e.g. 500)
- Re-verify orphan pool count

Goal:
Copy \`expected_packages.resolved_product_id\` → \`return_items.resolved_product_id\` for remaining ~${remainingOrphans} orphan rows (same rules as sample).

Forbidden:
- Class C product seed
- product_identifier_map insert
- product create

Output:
.cursor/audit-reports/expected-linkage-return-items-backfill-scale-wave2/<run_id>/
`,
  );

  const manifest = {
    prompt: "EXPECTED-LINKAGE-CLASS-A-AND-RETURN-ITEMS-BACKFILL-SAMPLE-EXECUTE",
    run_id: runId,
    plan_run_id: PLAN_RUN_ID,
    staging_ref: STAGING_REF,
    mode: apply ? "apply" : "dry-run",
    status: verificationPass ? "PASS" : apply ? "FAIL" : "DRY-RUN",
    rows_applied: {
      class_a_ep: classAApplied.length,
      return_items: returnApplied.length,
    },
    verification_pass: verificationPass,
    rollback_path: `${OUT_BASE}/${runId}/rollback.sql`,
    remaining_orphans: remainingOrphans,
    scale_wave2_safe: verificationPass,
  };
  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  console.log(JSON.stringify(manifest, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
