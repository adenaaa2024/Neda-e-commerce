/**
 * NEXT-ENV-04B-R2 — Retry 8 large raw-reports objects to staging.
 * Usage: npx tsx scripts/next-env-04b-r2-large-raw-reports.ts --run-id=20260528T140000Z
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createClient } from "@supabase/supabase-js";

const BUCKET = "raw-reports";
const FAILED_PATHS = [
  "00000000-0000-0000-0000-000000000001/1777689966806-10ptdvqj/original.csv",
  "00000000-0000-0000-0000-000000000001/1777690706934-1q1bmexb/original.csv",
  "00000000-0000-0000-0000-000000000001/1777691538242-xp39ls4y/original.csv",
  "00000000-0000-0000-0000-000000000001/1777692119049-itlvj18p/original.csv",
  "00000000-0000-0000-0000-000000000001/1777706417749-scmb6pze/original.csv",
  "00000000-0000-0000-0000-000000000001/1777769889972-r3zmop60/original.csv",
  "00000000-0000-0000-0000-000000000001/1777804472879-0qarkisy/original.csv",
  "00000000-0000-0000-0000-000000000001/509ee1f6-622c-46a5-8110-7b889ba46c2c/8cc884bb8281264570ed5b0af508327d02b63ab4338f9505f35a4f97a3c556a8_Inventory_ledger_Last_30_day_0424.csv",
];

const APPROVAL_PATH = path.join(
  process.cwd(),
  ".cursor/operator-approvals/staging-storage-clone-01-approval.md",
);

function loadEnvLocal(): void {
  const p = path.join(process.cwd(), ".env.local");
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq <= 0) continue;
    const k = t.slice(0, eq).trim();
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (process.env[k] == null || process.env[k] === "") process.env[k] = v;
  }
}

function parseApproval(): boolean {
  const c = fs.readFileSync(APPROVAL_PATH, "utf8");
  return (
    /APPROVED_TO_PREPARE_STAGING_STORAGE_CLONE\s*=\s*true/i.test(c) &&
    /APPROVED_TO_EXECUTE_STAGING_STORAGE_CLONE\s*=\s*true/i.test(c)
  );
}

function refFromUrl(url: string): string | null {
  const m = url.match(/https:\/\/([a-z]{20})\.supabase\.co/);
  return m?.[1] ?? null;
}

async function listCount(client: ReturnType<typeof createClient>, bucket: string): Promise<number> {
  const rows: { path: string }[] = [];
  const queue = [""];
  while (queue.length > 0) {
    const prefix = queue.shift()!;
    let offset = 0;
    for (;;) {
      const { data, error } = await client.storage.from(bucket).list(prefix, {
        limit: 100,
        offset,
        sortBy: { column: "name", order: "asc" },
      });
      if (error) throw new Error(`${bucket}/${prefix}: ${error.message}`);
      const batch = data ?? [];
      if (batch.length === 0) break;
      for (const it of batch) {
        const full = prefix ? `${prefix}/${it.name}` : it.name;
        const md = it.metadata as { size?: number } | undefined;
        const isFile = it.id != null || (typeof md?.size === "number" && md.size >= 0);
        if (!isFile && !/\.[a-z0-9]{2,8}$/i.test(it.name)) {
          queue.push(full);
        } else if (isFile || /\.csv$/i.test(it.name)) {
          rows.push({ path: full });
        }
      }
      offset += batch.length;
      if (batch.length < 100) break;
    }
  }
  return rows.length;
}

async function main(): Promise<void> {
  loadEnvLocal();
  const runId =
    process.argv.find((a) => a.startsWith("--run-id="))?.split("=")[1]?.trim() ??
    "20260528T140000Z";
  const outDir = path.resolve(
    process.cwd(),
    ".cursor/audit-reports/next-env-04b-r2-large-raw-reports",
    runId,
  );
  fs.mkdirSync(outDir, { recursive: true });

  const result: Record<string, unknown> = {
    run_id: runId,
    prompt: "NEXT-ENV-04B-R2",
    paths: FAILED_PATHS,
    results: [] as { path: string; bytes: number; status: string; error?: string }[],
  };

  if (!parseApproval()) {
    result.status = "FAIL";
    result.error = "approval_not_true";
    fs.writeFileSync(path.join(outDir, "retry-result.json"), JSON.stringify(result, null, 2));
    process.exit(2);
  }

  const origUrl =
    process.env.ORIGINAL_SUPABASE_URL?.trim() ??
    (refFromUrl(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "") === "kxsvedvpjldygtdbylsy"
      ? process.env.NEXT_PUBLIC_SUPABASE_URL
      : undefined);
  const origKey =
    process.env.ORIGINAL_SERVICE_ROLE_KEY?.trim() ?? process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  const stagUrl = process.env.STAGING_SUPABASE_URL?.trim();
  const stagKey = process.env.STAGING_SERVICE_ROLE_KEY?.trim();

  if (!origUrl || !origKey || !stagUrl || !stagKey) {
    result.status = "FAIL";
    result.error = "missing_credentials";
    fs.writeFileSync(path.join(outDir, "retry-result.json"), JSON.stringify(result, null, 2));
    process.exit(2);
  }

  result.refs = { original: refFromUrl(origUrl), staging: refFromUrl(stagUrl) };

  const src = createClient(origUrl, origKey, { auth: { persistSession: false } });
  const dst = createClient(stagUrl, stagKey, { auth: { persistSession: false } });

  await dst.storage.updateBucket(BUCKET, { public: false, fileSizeLimit: 50 * 1024 * 1024 * 1024 });

  const log = result.results as { path: string; bytes: number; status: string; error?: string }[];

  for (const objectPath of FAILED_PATHS) {
    let downloadedBytes = 0;
    try {
      const { data: blob, error: dlErr } = await src.storage.from(BUCKET).download(objectPath);
      if (dlErr) throw new Error(`download: ${dlErr.message}`);
      if (!blob) throw new Error("download empty");
      const buf = Buffer.from(await blob.arrayBuffer());
      downloadedBytes = buf.length;
      const { error: upErr } = await dst.storage.from(BUCKET).upload(objectPath, buf, {
        upsert: true,
        contentType: blob.type || "text/csv",
      });
      if (upErr) throw new Error(`upload: ${upErr.message}`);
      log.push({ path: objectPath, bytes: downloadedBytes, status: "ok" });
      console.log(`ok ${objectPath} bytes=${downloadedBytes}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log.push({ path: objectPath, bytes: downloadedBytes, status: "fail", error: msg });
      console.log(`fail ${objectPath}: ${msg}`);
    }
  }

  const stagingRawCount = await listCount(dst, BUCKET);
  const allBuckets = ["raw-reports", "claim-reports", "logos", "media", "manifests"] as const;
  const byBucket: Record<string, number> = {};
  let total = 0;
  for (const b of allBuckets) {
    const n = await listCount(dst, b);
    byBucket[b] = n;
    total += n;
  }

  result.verification = {
    raw_reports: stagingRawCount,
    by_bucket: byBucket,
    total_objects: total,
    expected_raw: 55,
    expected_total: 144,
    raw_match: stagingRawCount === 55,
    total_match: total === 144,
  };
  result.status =
    log.every((r) => r.status === "ok") && stagingRawCount === 55 && total === 144 ? "PASS" : "FAIL";

  fs.writeFileSync(path.join(outDir, "retry-result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ status: result.status, verification: result.verification }, null, 2));
  process.exit(result.status === "PASS" ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
