/**
 * EXPECTED-RECEIVE-SPLIT-ITEM-ROW-REPAIR EXECUTE (staging only)
 * Usage: npx tsx scripts/expected-receive-split-item-row-repair-execute-staging.ts --apply
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { refFromSupabaseUrl } from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const MIGRATION = "supabase/migrations/20260830120000_expected_receive_split_item_level.sql";
const AUDIT_ROOT = ".cursor/audit-reports/expected-receive-split-item-row-repair-execute";
const APPROVAL = ".cursor/operator-approvals/item-level-receive-split-fix-approval.md";

const FUNCTIONS = [
  "allocate_expected_item_unit",
  "allocate_expected_items_for_return_item_ids",
  "release_expected_item_unit",
  "move_expected_item_unit",
] as const;

function loadEnvLocal(): void {
  const p = join(process.cwd(), ".env.local");
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i === -1) continue;
    const k = t.slice(0, i).trim();
    let v = t.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (!process.env[k]) process.env[k] = v;
  }
}

function runId(): string {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

async function probeFunctions(client: pg.Client): Promise<Record<string, boolean>> {
  const out: Record<string, boolean> = {};
  for (const fn of FUNCTIONS) {
    const { rows } = await client.query(
      `select 1 from pg_proc p
       join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = $1 limit 1`,
      [fn],
    );
    out[fn] = rows.length > 0;
  }
  return out;
}

async function main(): Promise<void> {
  loadEnvLocal();
  const apply = process.argv.includes("--apply");
  const run_id = runId();
  const outDir = join(process.cwd(), AUDIT_ROOT, run_id);
  mkdirSync(outDir, { recursive: true });

  const url =
    String(process.env.STAGING_DIRECT_POSTGRES_URL ?? process.env.DIRECT_POSTGRES_URL ?? "").trim();
  const ref = refFromSupabaseUrl(String(process.env.NEXT_PUBLIC_SUPABASE_URL ?? ""));
  if (ref !== STAGING_REF) throw new Error(`Staging ref mismatch: ${ref}`);

  const sql = readFileSync(join(process.cwd(), MIGRATION), "utf8");
  const client = new pg.Client({ connectionString: url });
  await client.connect();

  const before = await probeFunctions(client);
  let applied = false;

  if (apply) {
    await client.query(sql);
    applied = true;
  }

  const after = await probeFunctions(client);
  await client.end();

  const pass = FUNCTIONS.every((f) => after[f]);
  writeFileSync(
    join(outDir, "manifest.json"),
    JSON.stringify(
      {
        run_id,
        status: pass ? "PASS" : apply ? "FAIL" : "DRY_RUN",
        staging_ref: STAGING_REF,
        migration: MIGRATION,
        applied,
        functions_before: before,
        functions_after: after,
      },
      null,
      2,
    ),
  );

  writeFileSync(
    join(outDir, "migration-function-check.md"),
    `# Migration / function check

| Function | Before | After |
|----------|--------|-------|
${FUNCTIONS.map((f) => `| \`${f}\` | ${before[f] ? "yes" : "no"} | ${after[f] ? "yes" : "no"} |`).join("\n")}

- Apply run: **${applied ? "yes" : "no"}**
- Verdict: **${pass ? "PASS" : "FAIL"}**
`,
  );

  console.log(JSON.stringify({ run_id, outDir, pass, applied, after }, null, 2));
  if (!pass) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
