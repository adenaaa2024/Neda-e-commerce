/**
 * CLAIM-INBOX-AUDIT-10 helper — apply 20260814120000_claim_candidate_drafts.sql then run verify SQL.
 *
 * Requires direct Postgres connection string, e.g. Supabase (Settings → Database):
 *   PowerShell:
 *     $env:DATABASE_URL = "postgresql://postgres.[PROJECT-REF]:[PASSWORD]@aws-0-[REGION].pooler.supabase.com:6543/postgres"
 *     node scripts/claim-candidate-drafts-migration-verify.mjs
 *
 * Do NOT commit passwords. Do NOT commit DATABASE_URL.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

function splitSqlStatements(sql) {
  const noLineComments = sql.replace(/^--[^\n]*/gm, "");
  return noLineComments
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

async function main() {
  const url = process.env.DATABASE_URL?.trim();
  if (!url) {
    console.error("Missing DATABASE_URL (Postgres connection string). Cannot run migration.");
    process.exit(1);
  }
  const { default: pg } = await import("pg");
  const client = new pg.Client({
    connectionString: url,
    ssl: url.includes("supabase.com") ? { rejectUnauthorized: false } : undefined,
  });
  await client.connect();
  try {
    const migPath = path.join(root, "supabase", "migrations", "20260814120000_claim_candidate_drafts.sql");
    const migrationSql = fs.readFileSync(migPath, "utf8");
    console.log("Applying migration…");
    await client.query(migrationSql);
    console.log("Migration applied.");

    const verifyPath = path.join(root, "docs", "claims", "sql", "claim_candidate_drafts_verify.sql");
    const verifySql = fs.readFileSync(verifyPath, "utf8");
    const stmts = splitSqlStatements(verifySql);
    console.log(`Running ${stmts.length} verify statement(s)…`);
    for (let i = 0; i < stmts.length; i++) {
      const q = `${stmts[i]};`;
      const { rows } = await client.query(q);
      console.log(`\n--- verify ${i + 1} ---\n`, JSON.stringify(rows, null, 2));
    }

    const { rows: cnt } = await client.query("SELECT count(*)::int AS row_count FROM public.claim_candidate_drafts");
    console.log("\nrow_count:", cnt[0]?.row_count);
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
