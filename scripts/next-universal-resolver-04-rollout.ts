/**
 * NEXT-UNIVERSAL-RESOLVER-04 — Controlled amazon_returns resolver rollout helper.
 *
 * Usage (from repo root):
 *   npx tsx scripts/next-universal-resolver-04-rollout.ts --run-id=20260514T090000Z --migrate
 *   npx tsx scripts/next-universal-resolver-04-rollout.ts --run-id=... --dry-run
 *   npx tsx scripts/next-universal-resolver-04-rollout.ts --run-id=... --write
 *
 * --migrate: apply supabase/migrations/20260815140000_amazon_returns_resolver_columns.sql via DIRECT_POSTGRES_URL
 * --dry-run: resolveAmazonImportProducts(..., dryRun: true) for pilot upload only
 * --write:   resolver writeback for same pilot upload (scoped slice, not whole table)
 *
 * Default pilot = single (organization_id, store_id, upload_id) with largest row count.
 */

import fs from "node:fs";
import path from "node:path";
import pg from "pg";
import { createClient } from "@supabase/supabase-js";
import { resolveAmazonImportProducts } from "../lib/amazon-import-product-resolver";

function loadEnvLocal(): Record<string, string> {
  const p = path.join(process.cwd(), ".env.local");
  const raw = fs.readFileSync(p, "utf8");
  const out: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const k = line.slice(0, eq).trim();
    let v = line.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out[k] = v;
  }
  return out;
}

function parseArgs(argv: string[]) {
  const flags = new Set<string>();
  let runId = "20260514T090000Z";
  for (const a of argv) {
    if (a === "--migrate") flags.add("migrate");
    if (a === "--dry-run") flags.add("dry-run");
    if (a === "--write") flags.add("write");
    if (a.startsWith("--run-id=")) runId = a.slice("--run-id=".length).trim() || runId;
  }
  return { flags, runId };
}

type NdJson = Record<string, unknown>;

function appendNdjson(file: string, row: NdJson) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(row) + "\n", "utf8");
}

async function main() {
  const { flags, runId } = parseArgs(process.argv.slice(2));
  const env = loadEnvLocal();
  const direct = env.DIRECT_POSTGRES_URL;
  const url = env.NEXT_PUBLIC_SUPABASE_URL;
  const service = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!direct) throw new Error("DIRECT_POSTGRES_URL missing in .env.local");
  if (!url || !service) throw new Error("NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing");

  const outDir = path.join(process.cwd(), ".cursor", "audit-reports", "next-universal-resolver-04", runId);
  const logPath = path.join(outDir, "logs", "universal-resolver-04.ndjson");
  const stamp = () => new Date().toISOString();

  appendNdjson(logPath, { event: "start", ts: stamp(), flags: [...flags] });

  if (flags.has("migrate")) {
    const sqlPath = path.join(
      process.cwd(),
      "supabase",
      "migrations",
      "20260815140000_amazon_returns_resolver_columns.sql",
    );
    const sql = fs.readFileSync(sqlPath, "utf8");
    const c = new pg.Client({ connectionString: direct, ssl: { rejectUnauthorized: false } });
    await c.connect();
    try {
      await c.query(sql);
      appendNdjson(logPath, { event: "migration_applied", ts: stamp(), file: path.basename(sqlPath) });
    } finally {
      await c.end();
    }
  }

  const pgRead = new pg.Client({ connectionString: direct, ssl: { rejectUnauthorized: false } });
  await pgRead.connect();
  let pilot: { organization_id: string; store_id: string; upload_id: string; row_count: string } | null = null;
  try {
    const { rows } = await pgRead.query<{
      organization_id: string;
      store_id: string;
      upload_id: string;
      row_count: string;
    }>(
      `SELECT organization_id::text, store_id::text, upload_id::text, count(*)::text AS row_count
       FROM public.amazon_returns
       WHERE upload_id IS NOT NULL AND store_id IS NOT NULL
       GROUP BY organization_id, store_id, upload_id
       ORDER BY count(*) DESC
       LIMIT 1`,
    );
    pilot = rows[0] ?? null;
  } finally {
    await pgRead.end();
  }

  if (!pilot) {
    appendNdjson(logPath, { event: "no_pilot_upload", ts: stamp() });
    console.log(JSON.stringify({ ok: false, reason: "no_pilot_upload" }));
    return;
  }

  appendNdjson(logPath, { event: "pilot_selected", ts: stamp(), pilot });

  const supabase = createClient(url, service, { auth: { persistSession: false } });

  if (flags.has("dry-run")) {
    const m = await resolveAmazonImportProducts({
      supabase,
      organizationId: pilot.organization_id,
      uploadId: pilot.upload_id,
      storeId: pilot.store_id,
      table: "amazon_returns",
      dryRun: true,
      pageSize: 400,
    });
    appendNdjson(logPath, { event: "dry_run_metrics", ts: stamp(), metrics: m });
    console.log("[dry-run]", m);
  }

  if (flags.has("write")) {
    const m = await resolveAmazonImportProducts({
      supabase,
      organizationId: pilot.organization_id,
      uploadId: pilot.upload_id,
      storeId: pilot.store_id,
      table: "amazon_returns",
      dryRun: false,
      pageSize: 400,
    });
    appendNdjson(logPath, { event: "write_metrics", ts: stamp(), metrics: m });
    console.log("[write]", m);
  }

  const verify = new pg.Client({ connectionString: direct, ssl: { rejectUnauthorized: false } });
  await verify.connect();
  try {
    const { rows: dist } = await verify.query(
      `SELECT identifier_resolution_status, count(*)::int AS n
       FROM public.amazon_returns
       WHERE organization_id = $1::uuid AND upload_id = $2::uuid
       GROUP BY 1 ORDER BY n DESC`,
      [pilot.organization_id, pilot.upload_id],
    );
    const { rows: tot } = await verify.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM public.amazon_returns
       WHERE organization_id = $1::uuid AND upload_id = $2::uuid`,
      [pilot.organization_id, pilot.upload_id],
    );
    appendNdjson(logPath, {
      event: "verify_pilot_upload",
      ts: stamp(),
      pilot,
      total: tot[0]?.n,
      status_dist: dist,
    });
    console.log("[verify]", { total: tot[0]?.n, dist });
  } finally {
    await verify.end();
  }

  appendNdjson(logPath, { event: "done", ts: stamp() });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
