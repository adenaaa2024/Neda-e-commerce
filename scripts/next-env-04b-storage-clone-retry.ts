/**
 * NEXT-ENV-04B-R — Copy Supabase Storage original → staging.
 * Usage: npx tsx scripts/next-env-04b-storage-clone-retry.ts --run-id=20260527T120000Z
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const BUCKETS = ["raw-reports", "claim-reports", "logos", "media", "manifests"] as const;
const LIST_PAGE = 100;
const APPROVAL_PATH = path.join(
  process.cwd(),
  ".cursor/operator-approvals/staging-storage-clone-01-approval.md",
);

type BucketMeta = { id: string; public: boolean };
type ObjRow = { path: string; size: number | null };

type CloneRetryResult = {
  run_id: string;
  approval: ReturnType<typeof parseApproval>;
  refs: { original: string | null; staging: string | null };
  credentials: {
    original_url: boolean;
    original_key: boolean;
    staging_url: boolean;
    staging_key: boolean;
  };
  bucket_create_log: string[];
  copy_log: { bucket: string; copied: number; failed: number }[];
  errors: string[];
  status?: string;
  source_buckets?: BucketMeta[];
  source_inventory?: unknown;
  staging_inventory?: unknown;
};

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

function parseApproval(): {
  prepare: boolean;
  execute: boolean;
  originalRef: string | null;
  stagingRef: string | null;
} {
  const content = fs.readFileSync(APPROVAL_PATH, "utf8");
  const prepare = /APPROVED_TO_PREPARE_STAGING_STORAGE_CLONE\s*=\s*true/i.test(content);
  const execute = /APPROVED_TO_EXECUTE_STAGING_STORAGE_CLONE\s*=\s*true/i.test(content);
  const origM = content.match(/ORIGINAL_PROJECT_REF\s*=\s*([a-z]{20})/i);
  const stagM = content.match(/STAGING_PROJECT_REF\s*=\s*([a-z]{20})/i);
  return {
    prepare,
    execute,
    originalRef: origM?.[1] ?? null,
    stagingRef: stagM?.[1] ?? null,
  };
}

function refFromUrl(url: string): string | null {
  const m = url.match(/https:\/\/([a-z]{20})\.supabase\.co/);
  return m?.[1] ?? null;
}

function isFolder(item: { id?: string | null; name: string; metadata?: { size?: number } }): boolean {
  if (item.id) return false;
  const n = item.name;
  if (/^part-\d{6}$/.test(n)) return false;
  if (/\.[a-z0-9]{2,8}$/i.test(n)) return false;
  return true;
}

async function listAllFiles(client: SupabaseClient, bucket: string): Promise<ObjRow[]> {
  const out: ObjRow[] = [];
  const queue: string[] = [""];
  while (queue.length > 0) {
    const prefix = queue.shift()!;
    let offset = 0;
    for (;;) {
      const { data, error } = await client.storage.from(bucket).list(prefix, {
        limit: LIST_PAGE,
        offset,
        sortBy: { column: "name", order: "asc" },
      });
      if (error) throw new Error(`${bucket}/${prefix}: ${error.message}`);
      const batch = data ?? [];
      if (batch.length === 0) break;
      for (const it of batch) {
        const full = prefix ? `${prefix}/${it.name}` : it.name;
        if (isFolder(it as { id?: string | null; name: string; metadata?: { size?: number } })) {
          queue.push(full);
        } else {
          const md = it.metadata as { size?: number } | undefined;
          out.push({
            path: full,
            size: typeof md?.size === "number" ? md.size : null,
          });
        }
      }
      offset += batch.length;
      if (batch.length < LIST_PAGE) break;
    }
  }
  return out;
}

async function getSourceBuckets(client: SupabaseClient): Promise<BucketMeta[]> {
  const found: BucketMeta[] = [];
  for (const id of BUCKETS) {
    const { data, error } = await client.storage.getBucket(id);
    if (error && /not found/i.test(error.message)) continue;
    if (error) throw new Error(`getBucket ${id}: ${error.message}`);
    if (data) found.push({ id: data.name, public: data.public });
  }
  return found;
}

async function ensureStagingBucket(
  client: SupabaseClient,
  meta: BucketMeta,
  log: string[],
): Promise<void> {
  const { data: existing } = await client.storage.getBucket(meta.id);
  if (existing) {
    log.push(`bucket_exists:${meta.id}`);
    return;
  }
  const { error } = await client.storage.createBucket(meta.id, { public: meta.public });
  if (error) throw new Error(`createBucket ${meta.id}: ${error.message}`);
  log.push(`bucket_created:${meta.id}:public=${meta.public}`);
}

async function copyObject(
  src: SupabaseClient,
  dst: SupabaseClient,
  bucket: string,
  objectPath: string,
): Promise<number> {
  const { data: blob, error: dlErr } = await src.storage.from(bucket).download(objectPath);
  if (dlErr) throw new Error(`download ${bucket}/${objectPath}: ${dlErr.message}`);
  if (!blob) throw new Error(`download empty ${bucket}/${objectPath}`);
  const buf = Buffer.from(await blob.arrayBuffer());
  const contentType = blob.type || undefined;
  const { error: upErr } = await dst.storage.from(bucket).upload(objectPath, buf, {
    upsert: true,
    contentType,
  });
  if (upErr) throw new Error(`upload ${bucket}/${objectPath}: ${upErr.message}`);
  return buf.length;
}

async function inventoryViaList(client: SupabaseClient, buckets: string[]) {
  const byBucket: Record<string, { objects: number; bytes: number }> = {};
  let totalObjects = 0;
  let totalBytes = 0;
  for (const b of buckets) {
    const files = await listAllFiles(client, b);
    const bytes = files.reduce((s, f) => s + (f.size ?? 0), 0);
    byBucket[b] = { objects: files.length, bytes };
    totalObjects += files.length;
    totalBytes += bytes;
  }
  return { byBucket, totalObjects, totalBytes };
}

async function main(): Promise<void> {
  loadEnvLocal();
  const runId =
    process.argv.find((a) => a.startsWith("--run-id="))?.split("=")[1]?.trim() ??
    new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z").slice(0, 15) + "000Z";
  const outDir = path.resolve(
    process.cwd(),
    ".cursor/audit-reports/next-env-04b-storage-retry",
    runId,
  );
  fs.mkdirSync(outDir, { recursive: true });

  const approval = parseApproval();
  const origUrl =
    process.env.ORIGINAL_SUPABASE_URL?.trim() ??
    process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ??
    "";
  const origKey =
    process.env.ORIGINAL_SERVICE_ROLE_KEY?.trim() ??
    process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ??
    "";
  const stagUrl = process.env.STAGING_SUPABASE_URL?.trim() ?? "";
  const stagKey = process.env.STAGING_SERVICE_ROLE_KEY?.trim() ?? "";

  const result: CloneRetryResult = {
    run_id: runId,
    approval,
    refs: {
      original: refFromUrl(origUrl),
      staging: refFromUrl(stagUrl),
    },
    credentials: {
      original_url: !!origUrl,
      original_key: !!origKey,
      staging_url: !!stagUrl,
      staging_key: !!stagKey,
    },
    bucket_create_log: [],
    copy_log: [],
    errors: [],
  };

  if (!approval.prepare || !approval.execute) {
    result.status = "FAIL";
    result.errors.push("approval_flags_not_true");
    fs.writeFileSync(path.join(outDir, "clone-result.json"), JSON.stringify(result, null, 2));
    console.error("BLOCKED: approval flags not true");
    process.exit(2);
  }
  if (!origUrl || !origKey || !stagUrl || !stagKey) {
    result.status = "FAIL";
    result.errors.push("missing_credentials");
    fs.writeFileSync(path.join(outDir, "clone-result.json"), JSON.stringify(result, null, 2));
    console.error("BLOCKED: missing storage credentials");
    process.exit(2);
  }

  const origRef = refFromUrl(origUrl);
  const stagRef = refFromUrl(stagUrl);
  if (approval.originalRef && origRef !== approval.originalRef) {
    result.errors.push("original_ref_mismatch");
  }
  if (approval.stagingRef && stagRef !== approval.stagingRef) {
    result.errors.push("staging_ref_mismatch");
  }
  if (result.errors.length) {
    result.status = "FAIL";
    fs.writeFileSync(path.join(outDir, "clone-result.json"), JSON.stringify(result, null, 2));
    process.exit(2);
  }

  const src = createClient(origUrl, origKey, { auth: { persistSession: false } });
  const dst = createClient(stagUrl, stagKey, { auth: { persistSession: false } });

  const sourceBuckets = await getSourceBuckets(src);
  result.source_buckets = sourceBuckets;

  const bucketLog = result.bucket_create_log;
  for (const meta of sourceBuckets) {
    await ensureStagingBucket(dst, meta, bucketLog);
  }

  const copyLog = result.copy_log;
  for (const meta of sourceBuckets) {
    const files = await listAllFiles(src, meta.id);
    let copied = 0;
    let failed = 0;
    for (const f of files) {
      try {
        await copyObject(src, dst, meta.id, f.path);
        copied++;
        if (copied % 10 === 0) {
          console.log(`copy ${meta.id}: ${copied}/${files.length}`);
        }
      } catch (e) {
        failed++;
        result.errors.push(
          `${meta.id}/${f.path}: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
    copyLog.push({ bucket: meta.id, copied, failed });
    console.log(`done ${meta.id}: copied=${copied} failed=${failed}`);
  }

  const sourceInv = await inventoryViaList(
    src,
    sourceBuckets.map((b) => b.id),
  );
  const stagingInv = await inventoryViaList(
    dst,
    sourceBuckets.map((b) => b.id),
  );
  result.source_inventory = sourceInv;
  result.staging_inventory = stagingInv;
  result.status =
    result.errors.length === 0 && sourceInv.totalObjects === stagingInv.totalObjects
      ? "PASS"
      : "FAIL";

  fs.writeFileSync(path.join(outDir, "clone-result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ status: result.status, run_id: runId, outDir }, null, 2));
  process.exit(result.status === "PASS" ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
