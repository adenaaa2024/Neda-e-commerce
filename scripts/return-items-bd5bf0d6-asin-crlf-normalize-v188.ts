/**
 * RETURN-ITEMS-BD5BF0D6-ASIN-CRLF-NORMALIZE-V188
 *
 * Trim `return_items.asin` for bd5bf0d6 only (staging). Does not touch resolver columns.
 *
 *   npx tsx scripts/return-items-bd5bf0d6-asin-crlf-normalize-v188.ts --run-id=<id>
 *   npx tsx scripts/return-items-bd5bf0d6-asin-crlf-normalize-v188.ts --run-id=<id> --execute
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
const OUT_BASE = ".cursor/audit-reports/return-items-bd5bf0d6-asin-crlf-normalize-v188";
const APPROVAL_PATH = ".cursor/operator-approvals/return-items-bd5bf0d6-asin-crlf-normalize-v188-approval.md";
const RETURN_ITEM_ID = "bd5bf0d6-500a-4696-80c6-7c0e65f539b6";
const EXPECTED_ASIN = "B0BSDRJ85M";

function runIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function readApproval(): boolean {
  return /APPROVED_TO_RUN_STAGING\s*=\s*true/i.test(
    fs.readFileSync(path.join(process.cwd(), APPROVAL_PATH), "utf8"),
  );
}

function normalizeAsin(raw: string | null): string | null {
  if (raw == null) return null;
  const t = raw.replace(/\r/g, "").replace(/\n/g, "").trim();
  return t === "" ? null : t;
}

function csvEscape(v: unknown): string {
  const s = v == null ? "" : String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

async function main(): Promise<void> {
  const runId = runIdArg();
  const execute = process.argv.includes("--execute");
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  loadEnvLocalIntoProcess();
  const dbUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() || "";
  const stagingRef = getStagingProjectRef({ loadEnv: false });
  if (!dbUrl || stagingRef !== STAGING_REF || !supabaseUrlMatchesStagingRef(dbUrl, STAGING_REF)) {
    throw new Error(`Staging guard failed (expected ${STAGING_REF})`);
  }

  const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();

  const row = (
    await client.query(
      `SELECT id::text, asin, sku, fnsku, resolved_product_id::text,
              identifier_resolution_status, deleted_at
       FROM public.return_items WHERE id = $1::uuid`,
      [RETURN_ITEM_ID],
    )
  ).rows[0];

  if (!row) throw new Error(`return_item ${RETURN_ITEM_ID} not found`);
  if (row.deleted_at != null) throw new Error("return_item is soft-deleted");

  const asinRaw = row.asin != null ? String(row.asin) : null;
  const asinNormalized = normalizeAsin(asinRaw);
  const needsUpdate = asinNormalized !== asinRaw || asinNormalized !== EXPECTED_ASIN;

  const pre = {
    return_item_id: RETURN_ITEM_ID,
    asin_raw: asinRaw,
    asin_raw_json: JSON.stringify(asinRaw),
    asin_normalized: asinNormalized,
    expected: EXPECTED_ASIN,
    needs_update: needsUpdate && asinNormalized === EXPECTED_ASIN,
    already_clean: asinNormalized === EXPECTED_ASIN && asinNormalized === asinRaw,
  };

  fs.writeFileSync(path.join(outDir, "preimage-bd5bf0d6.json"), JSON.stringify(row, null, 2));
  fs.writeFileSync(
    path.join(outDir, "preimage-return-item.csv"),
    ["id,asin,sku,fnsku,resolved_product_id,identifier_resolution_status", [RETURN_ITEM_ID, csvEscape(asinRaw), row.sku, row.fnsku, row.resolved_product_id, row.identifier_resolution_status].join(",")].join("\n"),
  );
  fs.writeFileSync(path.join(outDir, "normalize-plan.json"), JSON.stringify(pre, null, 2));

  if (asinNormalized !== EXPECTED_ASIN) {
    throw new Error(
      `Normalized ASIN "${asinNormalized}" does not match expected "${EXPECTED_ASIN}" — manual review required`,
    );
  }

  if (!execute) {
    fs.writeFileSync(
      path.join(outDir, "plan-summary.md"),
      [
        "# ASIN CRLF normalize — plan",
        "",
        `- asin raw: ${JSON.stringify(asinRaw)}`,
        `- asin after trim: \`${asinNormalized}\``,
        `- already clean: **${pre.already_clean}**`,
        `- will update: **${pre.needs_update && !pre.already_clean}**`,
        "",
        "Run with `--execute` after approval.",
      ].join("\n"),
    );
    await client.end();
    console.log(JSON.stringify({ mode: "plan", ...pre }, null, 2));
    return;
  }

  if (!readApproval()) {
    throw new Error(`Set APPROVED_TO_RUN_STAGING=true in ${APPROVAL_PATH}`);
  }

  if (pre.already_clean) {
    const manifest = {
      prompt: "RETURN-ITEMS-BD5BF0D6-ASIN-CRLF-NORMALIZE-V188",
      run_id: runId,
      staging_ref: STAGING_REF,
      mode: "execute_idempotent_skip",
      asin: asinNormalized,
      rows_updated: 0,
      prior_execute_run_id: "20260522T160000Z",
      note: "ASIN already B0BSDRJ85M; no UPDATE",
    };
    fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
    fs.writeFileSync(
      path.join(outDir, "execute-summary.md"),
      [
        "# ASIN CRLF normalize — idempotent",
        "",
        "asin already `B0BSDRJ85M`. First execute: `20260522T160000Z`.",
        "",
        "Resolver columns not touched.",
      ].join("\n"),
    );
    await client.end();
    console.log(JSON.stringify(manifest, null, 2));
    return;
  }

  const upd = await client.query(
    `UPDATE public.return_items
     SET asin = $2, updated_at = now()
     WHERE id = $1::uuid AND deleted_at IS NULL
     RETURNING id::text, asin`,
    [RETURN_ITEM_ID, EXPECTED_ASIN],
  );

  if ((upd.rowCount ?? 0) !== 1) throw new Error("UPDATE did not affect exactly one row");

  const manifest = {
    prompt: "RETURN-ITEMS-BD5BF0D6-ASIN-CRLF-NORMALIZE-V188",
    run_id: runId,
    staging_ref: STAGING_REF,
    mode: "execute",
    asin_before: asinRaw,
    asin_after: upd.rows[0]?.asin,
    rows_updated: 1,
    resolver_columns_touched: false,
  };

  fs.writeFileSync(
    path.join(outDir, "rollback.sql"),
    `-- Rollback ASIN normalize V188\nUPDATE public.return_items SET asin = ${asinRaw == null ? "NULL" : `'${String(asinRaw).replace(/'/g, "''")}'`}, updated_at = now() WHERE id = '${RETURN_ITEM_ID}'::uuid;\n`,
  );
  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(
    path.join(outDir, "execute-summary.md"),
    [
      "# ASIN CRLF normalize V188",
      "",
      `- asin before: ${JSON.stringify(asinRaw)}`,
      `- asin after: \`${manifest.asin_after}\``,
      "- resolver columns: **unchanged**",
    ].join("\n"),
  );

  await client.end();
  console.log(JSON.stringify(manifest, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
