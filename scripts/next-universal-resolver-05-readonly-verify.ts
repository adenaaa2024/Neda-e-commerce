/**
 * NEXT-UNIVERSAL-RESOLVER-05 — read-only DB verification for amazon_returns resolver columns.
 * Uses DIRECT_POSTGRES_URL from .env.local (no secrets logged).
 *
 * Usage: npx tsx scripts/next-universal-resolver-05-readonly-verify.ts
 */

import fs from "node:fs";
import path from "node:path";
import pg from "pg";

const RUN_ID = "20260514T120000Z";
const PILOT_UPLOAD_ID = "3a9aa983-7197-41b3-a306-9435f99f06b3";
const MIGRATION_BASENAME = "20260815140000_amazon_returns_resolver_columns.sql";

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

type NdJson = Record<string, unknown>;

function appendNdjson(file: string, row: NdJson) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(row) + "\n", "utf8");
}

function stamp() {
  return new Date().toISOString();
}

async function main() {
  const env = loadEnvLocal();
  const direct = env.DIRECT_POSTGRES_URL?.trim();
  if (!direct) throw new Error("DIRECT_POSTGRES_URL missing in .env.local");

  const outDir = path.join(
    process.cwd(),
    ".cursor",
    "audit-reports",
    "next-universal-resolver-05",
    RUN_ID,
  );
  const logPath = path.join(outDir, "logs", "universal-resolver-05.ndjson");
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  if (fs.existsSync(logPath)) fs.unlinkSync(logPath);

  const migrationPath = path.join(
    process.cwd(),
    "supabase",
    "migrations",
    MIGRATION_BASENAME,
  );
  const migrationExists = fs.existsSync(migrationPath);
  appendNdjson(logPath, {
    event: "migration_file_check",
    ts: stamp(),
    migrationPathRelative: `supabase/migrations/${MIGRATION_BASENAME}`,
    exists: migrationExists,
  });

  const client = new pg.Client({ connectionString: direct, ssl: { rejectUnauthorized: false } });
  await client.connect();

  const logQuery = async (event: string, summary: Record<string, unknown>) => {
    appendNdjson(logPath, { event, ts: stamp(), summary });
  };

  try {
    const { rows: colRows } = await client.query<{ column_name: string; data_type: string }>(
      `SELECT column_name, data_type
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'amazon_returns'
         AND column_name IN (
           'resolved_product_id',
           'resolved_catalog_product_id',
           'identifier_resolution_status',
           'identifier_resolution_confidence'
         )
       ORDER BY column_name`,
    );
    await logQuery("information_schema_resolver_columns", {
      foundColumns: colRows.length,
      columns: colRows.map((r) => ({ name: r.column_name, type: r.data_type })),
    });

    await client.query(
      `SELECT resolved_product_id, resolved_catalog_product_id,
              identifier_resolution_status, identifier_resolution_confidence
       FROM public.amazon_returns LIMIT 0`,
    );
    await logQuery("select_limit_zero_resolver_columns", { ok: true });

    const { rows: pilotDist } = await client.query<{ status: string | null; c: string }>(
      `SELECT identifier_resolution_status AS status, count(*)::text AS c
       FROM public.amazon_returns
       WHERE upload_id = $1::uuid
       GROUP BY identifier_resolution_status
       ORDER BY count(*) DESC`,
      [PILOT_UPLOAD_ID],
    );
    const { rows: pilotTotalRows } = await client.query<{ c: string }>(
      `SELECT count(*)::text AS c FROM public.amazon_returns WHERE upload_id = $1::uuid`,
      [PILOT_UPLOAD_ID],
    );
    const pilotTotal = Number(pilotTotalRows[0]?.c ?? 0);
    await logQuery("pilot_upload_status_distribution", {
      uploadId: PILOT_UPLOAD_ID,
      totalRows: pilotTotal,
      byStatus: pilotDist.map((r) => ({ status: r.status, count: Number(r.c) })),
    });

    const { rows: totalRow } = await client.query<{ c: string }>(
      `SELECT count(*)::text AS c FROM public.amazon_returns`,
    );
    const total = Number(totalRow[0]?.c ?? 0);

    const { rows: statusDist } = await client.query<{ status: string | null; c: string }>(
      `SELECT identifier_resolution_status AS status, count(*)::text AS c
       FROM public.amazon_returns
       GROUP BY identifier_resolution_status
       ORDER BY count(*) DESC`,
    );

    const { rows: topUploads } = await client.query<{ upload_id: string; c: string }>(
      `SELECT upload_id::text, count(*)::text AS c
       FROM public.amazon_returns
       WHERE upload_id IS NOT NULL
       GROUP BY upload_id
       ORDER BY count(*) DESC
       LIMIT 20`,
    );

    await logQuery("global_amazon_returns_counts", {
      totalRows: total,
      byStatus: statusDist.map((r) => ({ status: r.status, count: Number(r.c) })),
    });

    await logQuery("top_uploads_by_row_count", {
      limit: 20,
      uploads: topUploads.map((r) => ({ upload_id: r.upload_id, count: Number(r.c) })),
    });

    const { rows: ambRows } = await client.query<{ c: string }>(
      `SELECT count(*)::text AS c
       FROM public.amazon_returns
       WHERE identifier_resolution_status = 'ambiguous'
         AND resolved_product_id IS NOT NULL`,
    );
    const ambiguousWithResolved = Number(ambRows[0]?.c ?? 0);
    await logQuery("ambiguity_isolation_invariant", {
      ambiguousWithResolvedProductId: ambiguousWithResolved,
      invariantOk: ambiguousWithResolved === 0,
    });

    const { rows: nonPilotRows } = await client.query<{ c: string }>(
      `SELECT count(*)::text AS c
       FROM public.amazon_returns
       WHERE upload_id IS DISTINCT FROM $1::uuid`,
      [PILOT_UPLOAD_ID],
    );
    await logQuery("rows_upload_id_distinct_from_pilot", {
      pilotUploadId: PILOT_UPLOAD_ID,
      rowCountDistinctFromPilot: Number(nonPilotRows[0]?.c ?? 0),
    });

    const statusMap: Record<string, number> = {};
    for (const r of statusDist) {
      const k = r.status === null || r.status === undefined ? "(null)" : r.status;
      statusMap[k] = Number(r.c);
    }

    const ambiguous = statusMap["ambiguous"] ?? 0;
    const ambiguousPct = total > 0 ? (ambiguous / total) * 100 : 0;

    let pilotAmbiguous = 0;
    for (const r of pilotDist) {
      if (r.status === "ambiguous") pilotAmbiguous = Number(r.c);
    }
    const pilotAmbiguousPct = pilotTotal > 0 ? (pilotAmbiguous / pilotTotal) * 100 : 0;

    const result = {
      runId: RUN_ID,
      outDir,
      logPath,
      migrationExists,
      migrationPathRelative: `supabase/migrations/${MIGRATION_BASENAME}`,
      columnVerification: {
        expectedCount: 4,
        foundCount: colRows.length,
        columns: colRows,
      },
      pilotUploadId: PILOT_UPLOAD_ID,
      pilotTotalRows: pilotTotal,
      pilotStatusDistribution: pilotDist.map((r) => ({ status: r.status, count: Number(r.c) })),
      globalTotalRows: total,
      globalStatusDistribution: statusDist.map((r) => ({ status: r.status, count: Number(r.c) })),
      statusMap,
      topUploads: topUploads.map((r) => ({ upload_id: r.upload_id, count: Number(r.c) })),
      ambiguousWithResolvedProductId: ambiguousWithResolved,
      ambiguousPctGlobal: ambiguousPct,
      ambiguousPctPilot: pilotAmbiguousPct,
    };

    console.log(JSON.stringify({ ok: true, ...result, logPath: path.relative(process.cwd(), logPath) }));
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error(String(e?.message ?? e));
  process.exit(1);
});
