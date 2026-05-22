/**
 * RETURN-ITEMS-FAKE-TEST-CLEANUP-EXECUTE-V186
 *
 * Soft-delete exactly 4 PK-allowlisted fake/test return_items on staging.
 *
 *   npx tsx scripts/return-items-fake-test-cleanup-execute-v186.ts --run-id=<id>
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
const OUT_BASE = ".cursor/audit-reports/return-items-fake-test-cleanup-execute-v186";
const APPROVAL_PATH = ".cursor/operator-approvals/return-items-fake-test-cleanup-v186-approval.md";
const BD5BF0D6 = "bd5bf0d6-500a-4696-80c6-7c0e65f539b6";

const PK_ALLOWLIST = [
  "23ccf73f-cbda-485e-9ebb-cc8e365b9172",
  "3270ee19-441d-4b30-9d66-0273c46ea247",
  "ccffe8b3-87ea-4b7b-bfd5-4cf9cc16d663",
  "e08156b5-6f59-4bad-9a33-330c500df9cd",
] as const;

function runIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function readApproval(): { approved: boolean; method: "soft_delete" | "hard_delete" } {
  const raw = fs.readFileSync(path.join(process.cwd(), APPROVAL_PATH), "utf8");
  const approved = /APPROVED_TO_RUN_STAGING\s*=\s*true/i.test(raw);
  const method = /CLEANUP_METHOD\s*=\s*hard_delete/i.test(raw) ? "hard_delete" : "soft_delete";
  return { approved, method };
}

function csvEscape(v: unknown): string {
  const s = v == null ? "" : String(v);
  if (s.includes(",") || s.includes('"') || s.includes("\n") || s.includes("\r")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

async function main(): Promise<void> {
  const runId = runIdArg();
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  const approval = readApproval();
  if (!approval.approved) {
    throw new Error(`Approval required: set APPROVED_TO_RUN_STAGING=true in ${APPROVAL_PATH}`);
  }
  if (approval.method !== "soft_delete") {
    throw new Error("This prompt requires soft_delete; hard_delete not requested.");
  }
  if (PK_ALLOWLIST.includes(BD5BF0D6 as (typeof PK_ALLOWLIST)[number])) {
    throw new Error("Allowlist must not include bd5bf0d6 Sam row");
  }

  loadEnvLocalIntoProcess();
  const dbUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() || "";
  const stagingRef = getStagingProjectRef({ loadEnv: false });
  if (!dbUrl || stagingRef !== STAGING_REF || !supabaseUrlMatchesStagingRef(dbUrl, STAGING_REF)) {
    throw new Error(`Staging guard failed (expected ${STAGING_REF})`);
  }

  const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();

  const pre = await client.query(
    `SELECT id::text, organization_id::text, store_id::text, sku, fnsku, asin,
            product_identifier, package_id::text, notes, deleted_at, created_at, updated_at
     FROM public.return_items WHERE id = ANY($1::uuid[]) ORDER BY id`,
    [PK_ALLOWLIST],
  );

  if (pre.rows.length !== PK_ALLOWLIST.length) {
    const found = new Set(pre.rows.map((r: { id: string }) => r.id));
    const missing = PK_ALLOWLIST.filter((id) => !found.has(id));
    throw new Error(`Allowlist mismatch: missing rows ${missing.join(", ")}`);
  }

  const headers = [
    "id",
    "organization_id",
    "store_id",
    "sku",
    "fnsku",
    "asin",
    "product_identifier",
    "package_id",
    "notes",
    "deleted_at",
    "created_at",
    "updated_at",
  ];
  const csvLines = [headers.join(",")];
  for (const row of pre.rows) {
    csvLines.push(headers.map((h) => csvEscape((row as Record<string, unknown>)[h])).join(","));
  }
  const preimagePath = path.join(outDir, "preimage-return-items.csv");
  fs.writeFileSync(preimagePath, csvLines.join("\n"), "utf8");
  fs.writeFileSync(path.join(outDir, "preimage-rows.json"), JSON.stringify(pre.rows, null, 2));

  const alreadyDeleted = pre.rows.filter((r: { deleted_at: unknown }) => r.deleted_at != null);
  const pending = pre.rows.filter((r: { deleted_at: unknown }) => r.deleted_at == null);

  const postCount = await client.query(
    `SELECT COUNT(*)::int AS active_count FROM public.return_items WHERE deleted_at IS NULL`,
  );
  const activeBefore = (postCount.rows[0]?.active_count as number) + pending.length;

  if (pending.length === 0) {
    const manifest = {
      prompt: "RETURN-ITEMS-FAKE-TEST-CLEANUP-EXECUTE-V186",
      run_id: runId,
      staging_ref: STAGING_REF,
      mode: "execute_idempotent_skip",
      cleanup_method: approval.method,
      pk_allowlist: [...PK_ALLOWLIST],
      rows_updated: 0,
      already_soft_deleted: alreadyDeleted.length,
      active_return_items_after: postCount.rows[0]?.active_count ?? null,
      preimage_csv: preimagePath.replace(/\\/g, "/"),
      prior_track_a_run_id: "20260521T200000Z",
      excluded_sam_row: BD5BF0D6,
    };
    fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
    fs.writeFileSync(
      path.join(outDir, "execute-summary.md"),
      [
        "# Fake/test cleanup execute — idempotent",
        "",
        "All 4 allowlisted rows already have `deleted_at` set (Track A `20260521T200000Z`).",
        "",
        `- active return_items: **${postCount.rows[0]?.active_count ?? "?"}**`,
        `- preimage refreshed: \`preimage-return-items.csv\``,
      ].join("\n"),
    );
    await client.end();
    console.log(JSON.stringify(manifest, null, 2));
    return;
  }

  const update = await client.query(
    `UPDATE public.return_items
     SET deleted_at = COALESCE(deleted_at, now()), updated_at = now()
     WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL
     RETURNING id::text, deleted_at`,
    [PK_ALLOWLIST],
  );

  const post = await client.query(
    `SELECT COUNT(*)::int AS active_count FROM public.return_items WHERE deleted_at IS NULL`,
  );

  const rollbackSql = pre.rows
    .map((r: { id: string; deleted_at: unknown }) => {
      const del = r.deleted_at == null ? "NULL" : `'${new Date(r.deleted_at as string).toISOString()}'::timestamptz`;
      return `UPDATE public.return_items SET deleted_at = ${del}, updated_at = now() WHERE id = '${r.id}'::uuid;`;
    })
    .join("\n");

  fs.writeFileSync(
    path.join(outDir, "rollback.sql"),
    ["-- RETURN-ITEMS-FAKE-TEST-CLEANUP-EXECUTE-V186 rollback", rollbackSql].join("\n"),
  );

  const manifest = {
    prompt: "RETURN-ITEMS-FAKE-TEST-CLEANUP-EXECUTE-V186",
    run_id: runId,
    staging_ref: STAGING_REF,
    mode: "execute",
    cleanup_method: approval.method,
    pk_allowlist: [...PK_ALLOWLIST],
    rows_updated: update.rowCount ?? 0,
    already_soft_deleted_before: alreadyDeleted.length,
    active_return_items_before_estimate: activeBefore,
    active_return_items_after: post.rows[0]?.active_count ?? null,
    preimage_csv: preimagePath.replace(/\\/g, "/"),
    excluded_sam_row: BD5BF0D6,
    write_mode: "execute_staging",
  };

  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(
    path.join(outDir, "execute-summary.md"),
    [
      "# Fake/test cleanup execute V186",
      "",
      `- rows soft-deleted: **${update.rowCount ?? 0}**`,
      `- already deleted (skipped): **${alreadyDeleted.length}**`,
      `- active return_items after: **${post.rows[0]?.active_count ?? "?"}**`,
      `- preimage: \`preimage-return-items.csv\``,
      "",
      "Sam row `bd5bf0d6` was **not** touched.",
    ].join("\n"),
  );

  await client.end();
  console.log(JSON.stringify(manifest, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
