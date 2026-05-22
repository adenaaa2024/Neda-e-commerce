/**
 * NEXT-UNIVERSAL-RESOLVER-12 — Read-only rollback rehearsal for Manage FBA resolver pilots.
 *
 * Reads a preimage JSON export, validates its upload scope, compares it with current DB row ids/status,
 * and writes a rehearsal summary. It does not UPDATE, INSERT, DELETE, or call external APIs.
 */

import fs from "node:fs";
import path from "node:path";
import pg from "pg";

const DEFAULT_UPLOAD_ID = "47f68c9a-07fa-4472-81a2-52517db5fa57";
const DEFAULT_PREIMAGE = path.join(
  ".cursor",
  "audit-reports",
  "next-universal-resolver-11",
  "20260514T153700Z",
  "snapshots",
  `amazon_manage_fba_inventory-${DEFAULT_UPLOAD_ID}-preimage.json`,
);

type Args = {
  runId: string;
  uploadId: string;
  preimagePath: string;
};

type PreimageRow = {
  id?: string;
  organization_id?: string;
  store_id?: string;
  source_upload_id?: string;
  resolved_product_id?: string | null;
  resolved_catalog_product_id?: string | null;
  identifier_resolution_status?: string | null;
  identifier_resolution_confidence?: string | number | null;
};

type NdJson = Record<string, unknown>;

function loadEnvLocal(): Record<string, string> {
  const p = path.join(process.cwd(), ".env.local");
  const raw = fs.readFileSync(p, "utf8");
  const out: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    let v = line.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[line.slice(0, eq).trim()] = v;
  }
  return out;
}

function parseArgs(argv: string[]): Args {
  let runId = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15) + "Z";
  let uploadId = DEFAULT_UPLOAD_ID;
  let preimagePath = DEFAULT_PREIMAGE;
  for (const a of argv) {
    if (a.startsWith("--run-id=")) runId = a.slice("--run-id=".length).trim() || runId;
    else if (a.startsWith("--upload-id=")) uploadId = a.slice("--upload-id=".length).trim() || uploadId;
    else if (a.startsWith("--preimage=")) preimagePath = a.slice("--preimage=".length).trim() || preimagePath;
  }
  return { runId, uploadId, preimagePath };
}

function appendNdjson(file: string, row: NdJson) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(row) + "\n", "utf8");
}

function readPreimage(file: string): PreimageRow[] {
  const abs = path.isAbsolute(file) ? file : path.join(process.cwd(), file);
  const parsed = JSON.parse(fs.readFileSync(abs, "utf8")) as unknown;
  if (!Array.isArray(parsed)) throw new Error("preimage JSON must be an array");
  return parsed as PreimageRow[];
}

function unique(values: Array<string | undefined | null>): string[] {
  return [...new Set(values.map((v) => String(v ?? "").trim()).filter(Boolean))];
}

function rollbackSqlTemplate(uploadId: string): string {
  return [
    "-- TEMPLATE ONLY — DO NOT RUN without replacing the JSON payload from the reviewed preimage.",
    "-- Restores resolver fields for a single amazon_manage_fba_inventory upload scope.",
    "WITH preimage AS (",
    "  SELECT * FROM jsonb_to_recordset($$",
    "  []",
    "  $$::jsonb) AS x(",
    "    id uuid,",
    "    organization_id uuid,",
    "    store_id uuid,",
    "    source_upload_id uuid,",
    "    resolved_product_id uuid,",
    "    resolved_catalog_product_id uuid,",
    "    identifier_resolution_status text,",
    "    identifier_resolution_confidence numeric",
    "  )",
    ")",
    "UPDATE public.amazon_manage_fba_inventory tgt",
    "SET resolved_product_id = preimage.resolved_product_id,",
    "    resolved_catalog_product_id = preimage.resolved_catalog_product_id,",
    "    identifier_resolution_status = preimage.identifier_resolution_status,",
    "    identifier_resolution_confidence = preimage.identifier_resolution_confidence",
    "FROM preimage",
    "WHERE tgt.id = preimage.id",
    "  AND tgt.organization_id = preimage.organization_id",
    "  AND tgt.store_id = preimage.store_id",
    `  AND tgt.source_upload_id = '${uploadId}'::uuid`,
    "RETURNING tgt.id;",
  ].join("\n");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const env = loadEnvLocal();
  const direct = env.DIRECT_POSTGRES_URL?.trim();
  if (!direct) throw new Error("DIRECT_POSTGRES_URL missing in .env.local");

  const outDir = path.join(process.cwd(), ".cursor", "audit-reports", "next-universal-resolver-12", args.runId);
  const logPath = path.join(outDir, "logs", "universal-resolver-12.ndjson");
  const rollbackTemplatePath = path.join(outDir, "rollback-sql-template_DO_NOT_RUN.sql");
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  if (fs.existsSync(logPath)) fs.unlinkSync(logPath);

  const stamp = () => new Date().toISOString();
  const log = (row: NdJson) => appendNdjson(logPath, row);

  log({ event: "start", ts: stamp(), args });

  const preimage = readPreimage(args.preimagePath);
  const preimageIds = unique(preimage.map((r) => r.id));
  const orgIds = unique(preimage.map((r) => r.organization_id));
  const storeIds = unique(preimage.map((r) => r.store_id));
  const uploadIds = unique(preimage.map((r) => r.source_upload_id));

  const preimageScopeOk =
    orgIds.length === 1 &&
    storeIds.length === 1 &&
    uploadIds.length === 1 &&
    uploadIds[0] === args.uploadId &&
    preimageIds.length === preimage.length;

  log({
    event: "preimage_loaded",
    ts: stamp(),
    rowCount: preimage.length,
    uniqueIds: preimageIds.length,
    orgIds,
    storeIds,
    uploadIds,
    preimageScopeOk,
  });

  const client = new pg.Client({ connectionString: direct, ssl: { rejectUnauthorized: false } });
  await client.connect();
  try {
    const { rows: dbRows } = await client.query<{ id: string }>(
      `SELECT id::text
       FROM public.amazon_manage_fba_inventory
       WHERE organization_id = $1::uuid
         AND store_id = $2::uuid
         AND source_upload_id = $3::uuid
       ORDER BY id`,
      [orgIds[0], storeIds[0], args.uploadId],
    );
    const dbIds = dbRows.map((r) => r.id);
    const dbSet = new Set(dbIds);
    const preSet = new Set(preimageIds);
    const missingInDb = preimageIds.filter((id) => !dbSet.has(id));
    const extraInDb = dbIds.filter((id) => !preSet.has(id));

    const { rows: statusDist } = await client.query<{ status: string; n: number }>(
      `SELECT coalesce(identifier_resolution_status::text, '(null)') AS status,
              count(*)::int AS n
       FROM public.amazon_manage_fba_inventory
       WHERE organization_id = $1::uuid
         AND store_id = $2::uuid
         AND source_upload_id = $3::uuid
       GROUP BY 1
       ORDER BY n DESC`,
      [orgIds[0], storeIds[0], args.uploadId],
    );

    const rehearsal = {
      preimageRows: preimage.length,
      dbRows: dbIds.length,
      missingInDbCount: missingInDb.length,
      extraInDbCount: extraInDb.length,
      targetingMatches: preimageScopeOk && missingInDb.length === 0 && extraInDb.length === 0,
      statusDist,
    };
    log({ event: "rollback_targeting_rehearsed", ts: stamp(), rehearsal });

    fs.writeFileSync(rollbackTemplatePath, rollbackSqlTemplate(args.uploadId), "utf8");
    log({
      event: "rollback_sql_template_written",
      ts: stamp(),
      path: path.relative(process.cwd(), rollbackTemplatePath),
    });

    log({ event: "done", ts: stamp() });
    console.log(JSON.stringify({ ok: true, run_id: args.runId, rehearsal }));
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
