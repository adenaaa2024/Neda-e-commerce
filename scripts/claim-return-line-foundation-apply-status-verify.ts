/**
 * CLAIM-RETURN-LINE-FOUNDATION APPLY STATUS VERIFY — read-only staging + audit inspection.
 *
 *   npx tsx scripts/claim-return-line-foundation-apply-status-verify.ts [--run-id=<UTC_Z>]
 */
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";

import { getStagingProjectRef, loadEnvLocalIntoProcess, refFromSupabaseUrl } from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const APPLY_AUDIT_BASE = ".cursor/audit-reports/claim-return-line-foundation-schema-apply";
const OUT_BASE = ".cursor/audit-reports/claim-return-line-foundation-apply-status-verify";

const EXPECTED_INDEXES = [
  "idx_claim_lines_org_store_status",
  "idx_claim_lines_org_return_item",
  "idx_claim_lines_org_expected_package",
  "idx_claim_lines_org_expected_root",
  "idx_claim_lines_claim_candidate",
  "idx_claim_lines_org_source",
  "idx_claim_lines_org_resolved_product",
] as const;

const EXPECTED_COLUMNS = [
  "id",
  "organization_id",
  "store_id",
  "claim_candidate_id",
  "claim_candidate_draft_id",
  "return_item_id",
  "expected_package_id",
  "expected_package_root_id",
  "product_id",
  "resolved_product_id",
  "package_id",
  "pallet_id",
  "slip_content_id",
  "tracking_number",
  "order_id",
  "sku",
  "fnsku",
  "asin",
  "source_table",
  "source_row_id",
  "source_detail_row_id",
  "source_shipment_row_id",
  "line_grain",
  "discrepancy_kind",
  "quantity_basis",
  "count_basis",
  "quantity_expected",
  "quantity_actual",
  "quantity_delta",
  "status",
  "status_reason",
  "idempotency_key",
  "metadata",
  "created_at",
  "updated_at",
] as const;

type ApplyStatus = "APPLIED" | "FAILED" | "PARTIAL" | "NOT_RUN";

function runIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function listApplyAuditRuns(): { run_id: string; manifest: Record<string, unknown> | null }[] {
  const base = path.join(process.cwd(), APPLY_AUDIT_BASE);
  if (!fs.existsSync(base)) return [];
  return fs
    .readdirSync(base, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort()
    .reverse()
    .map((run_id) => {
      const mp = path.join(base, run_id, "manifest.json");
      let manifest: Record<string, unknown> | null = null;
      if (fs.existsSync(mp)) {
        try {
          manifest = JSON.parse(fs.readFileSync(mp, "utf8")) as Record<string, unknown>;
        } catch {
          manifest = null;
        }
      }
      return { run_id, manifest };
    });
}

function classifyStatus(live: {
  table_exists: boolean;
  missing_columns: string[];
  missing_indexes: string[];
  rls_enabled: boolean;
  fk_count: number;
  row_count: number;
}, audit: { run_id: string; manifest: Record<string, unknown> | null } | null): ApplyStatus {
  if (!live.table_exists) {
    if (!audit?.manifest) return "NOT_RUN";
    const st = String(audit.manifest.status ?? "");
    return st === "FAIL" ? "FAILED" : "NOT_RUN";
  }

  const schemaComplete =
    live.missing_columns.length === 0 &&
    live.missing_indexes.length === 0 &&
    live.rls_enabled &&
    live.fk_count >= 10;

  if (!schemaComplete) return "PARTIAL";

  if (audit?.manifest) {
    const st = String(audit.manifest.status ?? "");
    const applied = audit.manifest.migration_applied === true;
    const exists = audit.manifest.claim_lines_exists === true;
    if (st === "FAIL" || (!applied && !exists)) return "FAILED";
    if (st === "PASS" && (applied || exists)) return "APPLIED";
  }

  return "APPLIED";
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const runId = runIdArg();
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });
  const branch = execSync("git branch --show-current", { encoding: "utf8" }).trim();

  const dbUrl =
    process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ||
    process.env.DIRECT_POSTGRES_URL?.trim() ||
    "";
  const publicUrl = process.env.STAGING_SUPABASE_URL?.trim() || process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() || "";
  const ref = refFromSupabaseUrl(publicUrl) || refFromSupabaseUrl(dbUrl);
  if (!dbUrl || ref !== STAGING_REF || getStagingProjectRef({ loadEnv: false }) !== STAGING_REF) {
    throw new Error(`Staging guard failed (expected ${STAGING_REF})`);
  }

  const auditRuns = listApplyAuditRuns();
  const latestAudit = auditRuns[0] ?? null;

  const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();

  const existsR = await client.query(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.tables
       WHERE table_schema='public' AND table_name='claim_lines'
     ) AS ok`,
  );
  const table_exists = Boolean((existsR.rows[0] as { ok: boolean }).ok);

  let missing_columns: string[] = [...EXPECTED_COLUMNS];
  let missing_indexes: string[] = [...EXPECTED_INDEXES];
  let columns: string[] = [];
  let indexes: string[] = [];
  let rls_enabled = false;
  let policies: string[] = [];
  let fk_count = 0;
  let row_count = 0;

  if (table_exists) {
    const cols = await client.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema='public' AND table_name='claim_lines' ORDER BY ordinal_position`,
    );
    columns = cols.rows.map((r: { column_name: string }) => r.column_name);
    missing_columns = EXPECTED_COLUMNS.filter((c) => !columns.includes(c));

    const idx = await client.query(
      `SELECT indexname FROM pg_indexes WHERE schemaname='public' AND tablename='claim_lines'`,
    );
    indexes = idx.rows.map((r: { indexname: string }) => r.indexname);
    missing_indexes = EXPECTED_INDEXES.filter((i) => !indexes.includes(i));

    const rls = await client.query(
      `SELECT relrowsecurity FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname='public' AND c.relname='claim_lines'`,
    );
    rls_enabled = Boolean((rls.rows[0] as { relrowsecurity?: boolean })?.relrowsecurity);

    const pol = await client.query(
      `SELECT policyname FROM pg_policies WHERE schemaname='public' AND tablename='claim_lines'`,
    );
    policies = pol.rows.map((r: { policyname: string }) => r.policyname);

    const fks = await client.query(
      `SELECT conname FROM pg_constraint c
       JOIN pg_class t ON t.oid = c.conrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
       WHERE n.nspname='public' AND t.relname='claim_lines' AND c.contype='f'`,
    );
    fk_count = fks.rowCount ?? 0;

    const rc = await client.query(`SELECT COUNT(*)::int AS c FROM public.claim_lines`);
    row_count = (rc.rows[0] as { c: number }).c;
  }

  await client.end();

  const live = { table_exists, missing_columns, missing_indexes, rls_enabled, fk_count, row_count, columns, indexes, policies };
  const status = classifyStatus(live, latestAudit);

  const backfillDryrunExists = fs.existsSync(
    path.join(process.cwd(), ".cursor/audit-reports/claim-return-line-backfill-dryrun"),
  );

  let nextPrompt: string;
  if (status === "NOT_RUN" || status === "FAILED") {
    nextPrompt = "CLAIM-RETURN-LINE-FOUNDATION-SCHEMA-APPLY — apply claim_lines migration on staging after approval";
  } else if (status === "PARTIAL") {
    nextPrompt = "CLAIM-RETURN-LINE-FOUNDATION-SCHEMA-APPLY-RETRY — reconcile partial claim_lines schema";
  } else if (row_count > 0) {
    nextPrompt = "CLAIM-RETURN-LINE-BACKFILL-VERIFY — reconcile existing claim_lines rows vs backfill plan";
  } else if (backfillDryrunExists) {
    nextPrompt = "CLAIM-RETURN-LINE-BACKFILL-EXECUTE — governed staging INSERT after approval";
  } else {
    nextPrompt = "CLAIM-RETURN-LINE-BACKFILL-DRYRUN — governed backfill census + execute plan (separate approval)";
  }

  fs.writeFileSync(
    path.join(outDir, "staging-live-verify.md"),
    [
      "# Staging live verify",
      "",
      `- **Staging ref:** \`${STAGING_REF}\``,
      `- **claim_lines exists:** ${table_exists}`,
      `- **row_count:** ${row_count}`,
      `- **RLS enabled:** ${rls_enabled}`,
      `- **FK count:** ${fk_count}`,
      `- **Policies:** ${policies.join(", ") || "(none)"}`,
      `- **Missing columns:** ${missing_columns.length ? missing_columns.join(", ") : "none"}`,
      `- **Missing indexes:** ${missing_indexes.length ? missing_indexes.join(", ") : "none"}`,
      "",
      "## Classification",
      "",
      `**Status:** \`${status}\``,
    ].join("\n") + "\n",
  );

  fs.writeFileSync(
    path.join(outDir, "audit-apply-history.md"),
    [
      "# Audit apply history",
      "",
      `Base: \`${APPLY_AUDIT_BASE}/\``,
      "",
      auditRuns.length
        ? auditRuns
            .map((r) => {
              const m = r.manifest;
              return [
                `## ${r.run_id}`,
                "",
                m
                  ? `- status: \`${m.status}\``
                  : "- manifest: missing",
                m ? `- migration_applied: \`${m.migration_applied}\`` : "",
                m ? `- claim_lines_exists: \`${m.claim_lines_exists}\`` : "",
                m ? `- row_count (at apply): \`${m.row_count}\`` : "",
                m ? `- apply_mode: \`${(m as { apply_mode?: string }).apply_mode ?? "executed"}\`` : "",
              ]
                .filter(Boolean)
                .join("\n");
            })
            .join("\n\n")
        : "- No apply audit runs found on disk",
      "",
      latestAudit ? `**Latest run:** \`${latestAudit.run_id}\`` : "**Latest run:** none",
    ].join("\n") + "\n",
  );

  fs.writeFileSync(
    path.join(outDir, "status-classification.md"),
    [
      "# Status classification",
      "",
      "| Value | Meaning |",
      "|-------|---------|",
      "| `APPLIED` | Table exists with full schema contract; audit PASS or live-only proof |",
      "| `FAILED` | Audit FAIL or apply error; table missing after claimed apply |",
      "| `PARTIAL` | Table exists but missing columns/indexes/RLS/FKs |",
      "| `NOT_RUN` | No table and no successful apply audit |",
      "",
      `**This run:** \`${status}\``,
      "",
      status === "APPLIED" && latestAudit?.manifest
        ? `Prior apply was **${String((latestAudit.manifest as { apply_mode?: string }).apply_mode ?? "executed")}** (audit \`${latestAudit.run_id}\`).`
        : "",
    ]
      .filter(Boolean)
      .join("\n") + "\n",
  );

  const manifest = {
    prompt: "CLAIM-RETURN-LINE-FOUNDATION-APPLY-STATUS-VERIFY",
    run_id: runId,
    branch,
    staging_ref: STAGING_REF,
    claim_lines_exists: table_exists,
    row_count,
    status,
    latest_apply_audit_run_id: latestAudit?.run_id ?? null,
    latest_apply_audit_status: latestAudit?.manifest?.status ?? null,
    schema_complete: status === "APPLIED",
    missing_columns,
    missing_indexes,
    next_prompt: nextPrompt,
  };

  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  console.log(JSON.stringify(manifest, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
