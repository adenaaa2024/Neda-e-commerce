/**
 * Read-only rollback rehearsal: compare live `amazon_manage_fba_inventory`
 * rows for one upload against a preimage JSON snapshot (NEXT-UNIVERSAL-RESOLVER-12).
 *
 * Usage:
 *   node scripts/next-universal-resolver-12-rollback-rehearsal.mjs --preimage=<path> --out-json=<path>
 *
 * Loads DIRECT_POSTGRES_URL from .env.local (same as other resolver pilots).
 */
import fs from "node:fs";
import path from "node:path";
import pg from "pg";

function loadEnvLocal() {
  const p = path.join(process.cwd(), ".env.local");
  const raw = fs.readFileSync(p, "utf8");
  const out = {};
  for (const line of raw.split(/\r?\n/)) {
    if (!line || line.startsWith("#")) continue;
    const i = line.indexOf("=");
    if (i <= 0) continue;
    let k = line.slice(0, i).trim();
    let v = line.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[k] = v;
  }
  return out;
}

function norm(v) {
  if (v === undefined || v === null) return null;
  return String(v);
}

function parseArgs(argv) {
  let preimage = "";
  let outJson = "";
  for (const a of argv) {
    if (a.startsWith("--preimage=")) preimage = a.slice("--preimage=".length);
    else if (a.startsWith("--out-json=")) outJson = a.slice("--out-json=".length);
  }
  return { preimage, outJson };
}

const ROLLBACK_COLS = [
  "resolved_product_id",
  "resolved_catalog_product_id",
  "identifier_resolution_status",
  "identifier_resolution_confidence",
];

const { preimage: preimagePath, outJson } = parseArgs(process.argv.slice(2));
if (!preimagePath || !outJson) {
  console.error("Usage: node scripts/next-universal-resolver-12-rollback-rehearsal.mjs --preimage=<json> --out-json=<path>");
  process.exit(1);
}

const env = loadEnvLocal();
const direct = env.DIRECT_POSTGRES_URL?.trim();
if (!direct) throw new Error("DIRECT_POSTGRES_URL missing");

const rows = JSON.parse(fs.readFileSync(preimagePath, "utf8"));
if (!Array.isArray(rows)) throw new Error("preimage must be a JSON array");

const pilot = {
  organization_id: rows[0]?.organization_id,
  store_id: rows[0]?.store_id,
  upload_id: rows[0]?.source_upload_id,
};
if (!pilot.organization_id || !pilot.store_id || !pilot.upload_id) {
  throw new Error("preimage missing organization_id / store_id / source_upload_id on first row");
}

const client = new pg.Client({ connectionString: direct, ssl: { rejectUnauthorized: false } });
await client.connect();

const sel = `id::text, ${ROLLBACK_COLS.join(", ")}`;
const { rows: live } = await client.query(
  `SELECT ${sel}
   FROM public.amazon_manage_fba_inventory
   WHERE organization_id = $1::uuid
     AND store_id = $2::uuid
     AND source_upload_id = $3::uuid`,
  [pilot.organization_id, pilot.store_id, pilot.upload_id],
);
await client.end();

const liveById = new Map(live.map((r) => [String(r.id), r]));

let preimageRowCount = rows.length;
let liveRowCount = live.length;
let idMatchCount = 0;
let rollbackColMatchCount = 0;
const mismatches = [];
const missingInLive = [];
const extraInLive = new Set(liveById.keys());

for (const pr of rows) {
  const id = String(pr.id);
  extraInLive.delete(id);
  const lv = liveById.get(id);
  if (!lv) {
    missingInLive.push(id);
    continue;
  }
  idMatchCount++;
  let colsOk = true;
  const diff = { id };
  for (const c of ROLLBACK_COLS) {
    const a = norm(pr[c]);
    const b = norm(lv[c]);
    if (a !== b) {
      colsOk = false;
      diff[c] = { preimage: pr[c], live: lv[c] };
    }
  }
  if (colsOk) rollbackColMatchCount++;
  else if (mismatches.length < 50) mismatches.push(diff);
}

const extraIds = [...extraInLive];

const report = {
  pilot,
  preimage_path: preimagePath,
  preimage_row_count: preimageRowCount,
  live_row_count: liveRowCount,
  row_count_match: preimageRowCount === liveRowCount,
  id_coverage_match: missingInLive.length === 0 && extraIds.length === 0,
  ids_missing_in_live: missingInLive.length,
  ids_extra_in_live_not_in_preimage: extraIds.length,
  rollback_column_exact_matches: rollbackColMatchCount,
  rollback_column_mismatch_count: idMatchCount - rollbackColMatchCount,
  sample_mismatches: mismatches,
  targeting_matches:
    preimageRowCount === liveRowCount &&
    missingInLive.length === 0 &&
    extraIds.length === 0 &&
    idMatchCount === preimageRowCount,
};

fs.mkdirSync(path.dirname(outJson), { recursive: true });
fs.writeFileSync(outJson, JSON.stringify(report, null, 2), "utf8");
console.log(JSON.stringify(report));
