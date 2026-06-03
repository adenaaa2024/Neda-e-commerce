/**
 * ORIGINAL-STORAGE-PARITY-AUDIT — compare demo-related storage refs: staging vs original.
 *   npx tsx scripts/original-storage-parity-audit.ts
 *
 * Does NOT copy or mutate storage.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import pg from "pg";

import { loadEnvLocalIntoProcess, refFromSupabaseUrl } from "../lib/staging-project-ref";
import {
  getReturnPhotoEvidenceGalleryUrls,
  getReturnPhotoEvidenceUrls,
  RETURN_PHOTO_EVIDENCE_URL_KEYS,
} from "../lib/return-photo-evidence";

const ORIGINAL_REF = "kxsvedvpjldygtdbylsy";
const STAGING_REF = "eiqfaapyumhixxoeltgu";
const ORG_ID = "00000000-0000-0000-0000-000000000001";
const OUT_BASE = ".cursor/audit-reports/original-storage-parity";

const KNOWN_BUCKETS = [
  "claim-reports",
  "media",
  "manifests",
  "incident-photos",
  "profiles",
  "logos",
  "raw-reports",
] as const;

type FileRef = {
  id: string;
  bucket: string;
  path: string;
  raw: string;
  category: string;
  source_table: string;
  source_id: string;
  source_column: string;
  external_url: boolean;
  staging_host: boolean;
  original_host: boolean;
};

function runId(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function sbClient(urlKey: "ORIGINAL" | "STAGING"): SupabaseClient {
  loadEnvLocalIntoProcess();
  const url =
    urlKey === "ORIGINAL"
      ? process.env.ORIGINAL_SUPABASE_URL?.trim()
      : process.env.STAGING_SUPABASE_URL?.trim() || process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key =
    urlKey === "ORIGINAL"
      ? process.env.ORIGINAL_SERVICE_ROLE_KEY?.trim()
      : process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) throw new Error(`Missing ${urlKey} Supabase URL/key`);
  const ref = refFromSupabaseUrl(url);
  const expected = urlKey === "ORIGINAL" ? ORIGINAL_REF : STAGING_REF;
  if (ref !== expected) throw new Error(`${urlKey} ref mismatch: ${ref}`);
  return createClient(url, key, { auth: { persistSession: false } });
}

function extractStoragePathFromUrl(url: string, bucket: string): string | null {
  const markers = [`/object/public/${bucket}/`, `/object/sign/${bucket}/`, `/storage/v1/object/public/${bucket}/`];
  for (const m of markers) {
    const idx = url.indexOf(m);
    if (idx !== -1) {
      const rest = url.slice(idx + m.length).split("?")[0];
      try {
        return decodeURIComponent(rest);
      } catch {
        return rest;
      }
    }
  }
  return null;
}

function guessBucketForRelativePath(p: string): string {
  const lower = p.toLowerCase();
  if (lower.endsWith(".pdf")) return "claim-reports";
  if (lower.includes("/manifest") || lower.includes("manifests/")) return "manifests";
  if (lower.includes("incident")) return "incident-photos";
  return "media";
}

function parseToFileRef(
  raw: string,
  ctx: { category: string; source_table: string; source_id: string; source_column: string },
): Omit<FileRef, "id"> | null {
  const t = raw.trim();
  if (!t || t.startsWith("data:") || t.startsWith("blob:")) return null;

  if (/^https?:\/\//i.test(t) || t.startsWith("//")) {
    const full = t.startsWith("//") ? `https:${t}` : t;
    const stagingHost = full.includes(STAGING_REF);
    const originalHost = full.includes(ORIGINAL_REF);
    for (const bucket of KNOWN_BUCKETS) {
      const sp = extractStoragePathFromUrl(full, bucket);
      if (sp) {
        return {
          bucket,
          path: sp,
          raw: t,
          category: ctx.category,
          source_table: ctx.source_table,
          source_id: ctx.source_id,
          source_column: ctx.source_column,
          external_url: false,
          staging_host: stagingHost,
          original_host: originalHost,
        };
      }
    }
    // External CDN / Amazon image — not Supabase storage
    if (!full.includes(".supabase.co")) {
      return {
        bucket: "_external",
        path: full,
        raw: t,
        category: ctx.category,
        source_table: ctx.source_table,
        source_id: ctx.source_id,
        source_column: ctx.source_column,
        external_url: true,
        staging_host: false,
        original_host: false,
      };
    }
    return null;
  }

  const path = t.replace(/^\/+/, "");
  if (!path.includes("/")) return null;
  return {
    bucket: guessBucketForRelativePath(path),
    path,
    raw: t,
    category: ctx.category,
    source_table: ctx.source_table,
    source_id: ctx.source_id,
    source_column: ctx.source_column,
    external_url: false,
    staging_host: false,
    original_host: false,
  };
}

function pushUrlArray(
  refs: Omit<FileRef, "id">[],
  urls: unknown,
  ctx: { category: string; source_table: string; source_id: string; source_column: string },
): void {
  const list = Array.isArray(urls) ? urls : [];
  for (const u of list) {
    if (typeof u !== "string") continue;
    const r = parseToFileRef(u, ctx);
    if (r) refs.push(r);
  }
}

function refKey(r: Pick<FileRef, "bucket" | "path">): string {
  return `${r.bucket}::${r.path}`;
}

async function objectExists(client: SupabaseClient, bucket: string, objectPath: string): Promise<boolean> {
  if (bucket === "_external") return true;
  const { error } = await client.storage.from(bucket).download(objectPath);
  return !error;
}

async function listBuckets(client: SupabaseClient): Promise<string[]> {
  const { data, error } = await client.storage.listBuckets();
  if (error) throw new Error(error.message);
  return (data ?? []).map((b) => b.name).sort();
}

async function buildDemoScope(client: pg.Client): Promise<{
  returnItemIds: string[];
  packageIds: string[];
  palletIds: string[];
  claimCaseIds: string[];
  productIds: string[];
}> {
  const ri = await client.query(
    `SELECT id::text, package_id::text, pallet_id::text, resolved_product_id::text, product_id::text
     FROM return_items WHERE organization_id=$1::uuid AND deleted_at IS NULL`,
    [ORG_ID],
  );
  const returnItemIds = ri.rows.map((r) => r.id as string);
  const packageIds = [...new Set(ri.rows.map((r) => r.package_id).filter(Boolean) as string[])];
  const palletIds = [...new Set(ri.rows.map((r) => r.pallet_id).filter(Boolean) as string[])];
  const pkgAll = await client.query(`SELECT id::text FROM packages WHERE organization_id=$1::uuid`, [ORG_ID]);
  for (const r of pkgAll.rows) if (!packageIds.includes(r.id)) packageIds.push(r.id);
  const palAll = await client.query(
    `SELECT id::text FROM pallets WHERE organization_id=$1::uuid AND deleted_at IS NULL`,
    [ORG_ID],
  );
  for (const r of palAll.rows) if (!palletIds.includes(r.id)) palletIds.push(r.id);
  const cases = await client.query(`SELECT id::text FROM claim_cases WHERE organization_id=$1::uuid`, [ORG_ID]);
  const productIds = [
    ...new Set(
      ri.rows.flatMap((r) => [r.resolved_product_id, r.product_id].filter(Boolean) as string[]),
    ),
  ];
  return {
    returnItemIds,
    packageIds,
    palletIds,
    claimCaseIds: cases.rows.map((r) => r.id as string),
    productIds,
  };
}

async function collectRefs(client: pg.Client, scope: Awaited<ReturnType<typeof buildDemoScope>>): Promise<Omit<FileRef, "id">[]> {
  const refs: Omit<FileRef, "id">[] = [];

  if (scope.returnItemIds.length) {
    const { rows } = await client.query(
      `SELECT id::text, photo_evidence FROM return_items WHERE id = ANY($1::uuid[])`,
      [scope.returnItemIds],
    );
    for (const row of rows) {
      const id = row.id as string;
      const pe = row.photo_evidence as Record<string, unknown> | null;
      const urls = getReturnPhotoEvidenceUrls(pe);
      for (const k of RETURN_PHOTO_EVIDENCE_URL_KEYS) {
        const u = urls[k];
        if (u) {
          const r = parseToFileRef(u, {
            category: "return_item_photo",
            source_table: "return_items",
            source_id: id,
            source_column: `photo_evidence.${k}`,
          });
          if (r) refs.push(r);
        }
      }
      for (const u of getReturnPhotoEvidenceGalleryUrls(pe)) {
        const r = parseToFileRef(u, {
          category: "return_item_photo",
          source_table: "return_items",
          source_id: id,
          source_column: "photo_evidence.urls",
        });
        if (r) refs.push(r);
      }
    }
  }

  if (scope.packageIds.length) {
    const { rows } = await client.query(
      `SELECT id::text, inside_photo_urls, outside_photo_urls, slip_photo_urls, manifest_url
       FROM packages WHERE id = ANY($1::uuid[])`,
      [scope.packageIds],
    );
    for (const row of rows) {
      const id = row.id as string;
      pushUrlArray(refs, row.inside_photo_urls, {
        category: "package_photo",
        source_table: "packages",
        source_id: id,
        source_column: "inside_photo_urls",
      });
      pushUrlArray(refs, row.outside_photo_urls, {
        category: "package_photo",
        source_table: "packages",
        source_id: id,
        source_column: "outside_photo_urls",
      });
      pushUrlArray(refs, row.slip_photo_urls, {
        category: "slip_photo",
        source_table: "packages",
        source_id: id,
        source_column: "slip_photo_urls",
      });
      if (row.manifest_url) {
        const r = parseToFileRef(String(row.manifest_url), {
          category: "package_manifest",
          source_table: "packages",
          source_id: id,
          source_column: "manifest_url",
        });
        if (r) refs.push(r);
      }
    }
  }

  if (scope.palletIds.length) {
    const { rows } = await client.query(
      `SELECT id::text, shipping_label_urls, pallet_photo_urls, bol_photo_urls
       FROM pallets WHERE id = ANY($1::uuid[])`,
      [scope.palletIds],
    );
    for (const row of rows) {
      const id = row.id as string;
      pushUrlArray(refs, row.shipping_label_urls, {
        category: "shipment_photo",
        source_table: "pallets",
        source_id: id,
        source_column: "shipping_label_urls",
      });
      pushUrlArray(refs, row.pallet_photo_urls, {
        category: "shipment_photo",
        source_table: "pallets",
        source_id: id,
        source_column: "pallet_photo_urls",
      });
      pushUrlArray(refs, row.bol_photo_urls, {
        category: "shipment_photo",
        source_table: "pallets",
        source_id: id,
        source_column: "bol_photo_urls",
      });
    }
  }

  const { rows: subs } = await client.query(
    `SELECT id::text, report_url FROM claim_submissions
     WHERE organization_id=$1::uuid AND report_url IS NOT NULL AND report_url <> ''`,
    [ORG_ID],
  );
  for (const row of subs) {
    const r = parseToFileRef(String(row.report_url), {
      category: "claim_pdf",
      source_table: "claim_submissions",
      source_id: row.id as string,
      source_column: "report_url",
    });
    if (r) refs.push(r);
  }

  const { rows: ev } = await client.query(
    `SELECT id::text, public_url, storage_bucket, storage_path, claim_case_id::text
     FROM claim_evidence WHERE organization_id=$1::uuid`,
    [ORG_ID],
  );
  for (const row of ev) {
    const id = row.id as string;
    if (row.public_url) {
      const r = parseToFileRef(String(row.public_url), {
        category: "claim_evidence",
        source_table: "claim_evidence",
        source_id: id,
        source_column: "public_url",
      });
      if (r) refs.push(r);
    }
    if (row.storage_path) {
      const bucket = String(row.storage_bucket ?? "media").trim() || "media";
      refs.push({
        bucket,
        path: String(row.storage_path).replace(/^\/+/, ""),
        raw: `${bucket}/${row.storage_path}`,
        category: "claim_evidence",
        source_table: "claim_evidence",
        source_id: id,
        source_column: "storage_path",
        external_url: false,
        staging_host: false,
        original_host: false,
      });
    }
  }

  if (scope.productIds.length) {
    const { rows } = await client.query(
      `SELECT id::text, main_image_url, image_url FROM products WHERE id = ANY($1::uuid[])`,
      [scope.productIds],
    );
    for (const row of rows) {
      const id = row.id as string;
      for (const col of ["main_image_url", "image_url"] as const) {
        const v = row[col];
        if (!v) continue;
        const r = parseToFileRef(String(v), {
          category: "product_image",
          source_table: "products",
          source_id: id,
          source_column: col,
        });
        if (r) refs.push(r);
      }
    }
  }

  return refs;
}

function dedupeRefs(refs: Omit<FileRef, "id">[]): FileRef[] {
  const map = new Map<string, FileRef>();
  for (const r of refs) {
    const key = refKey(r);
    if (!map.has(key)) {
      map.set(key, { ...r, id: key });
    }
  }
  return [...map.values()];
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const rid = runId();
  const outDir = path.join(process.cwd(), OUT_BASE, rid);
  fs.mkdirSync(outDir, { recursive: true });

  const origSb = sbClient("ORIGINAL");
  const stagSb = sbClient("STAGING");

  const origBuckets = await listBuckets(origSb);
  const stagBuckets = await listBuckets(stagSb);

  const pgOrig = new pg.Client({ connectionString: process.env.ORIGINAL_DIRECT_POSTGRES_URL });
  await pgOrig.connect();
  const scope = await buildDemoScope(pgOrig);
  const rawRefs = await collectRefs(pgOrig, scope);
  await pgOrig.end();

  const refs = dedupeRefs(rawRefs);

  const results: {
    ref: FileRef;
    exists_original: boolean | null;
    exists_staging: boolean | null;
  }[] = [];

  for (const ref of refs) {
    if (ref.external_url) {
      results.push({ ref, exists_original: null, exists_staging: null });
      continue;
    }
    const [eo, es] = await Promise.all([
      objectExists(origSb, ref.bucket, ref.path),
      objectExists(stagSb, ref.bucket, ref.path),
    ]);
    results.push({ ref, exists_original: eo, exists_staging: es });
  }

  const storageRefs = results.filter((r) => !r.ref.external_url);
  const filesExistingInOriginal = storageRefs.filter((r) => r.exists_original).length;
  const filesOnlyInStaging = storageRefs.filter((r) => !r.exists_original && r.exists_staging).length;
  const filesMissingEntirely = storageRefs.filter((r) => !r.exists_original && !r.exists_staging).length;
  const filesInOriginal = storageRefs.filter((r) => r.exists_original).length;

  const brokenUrls = results.filter(
    (r) =>
      !r.ref.external_url &&
      !r.exists_original &&
      (r.ref.staging_host || r.ref.original_host || r.ref.raw.startsWith("http")),
  );

  const pathMismatches = results.filter(
    (r) => r.ref.staging_host && !r.ref.original_host && !r.exists_original,
  );

  const claimPdfs = results.filter((r) => r.ref.category === "claim_pdf");
  const scannerImages = results.filter((r) =>
    ["return_item_photo", "package_photo", "slip_photo", "shipment_photo"].includes(r.ref.category),
  );
  const packageImages = results.filter((r) => r.ref.category === "package_photo" || r.ref.category === "slip_photo");
  const shipmentImages = results.filter((r) => r.ref.category === "shipment_photo");
  const productImages = results.filter((r) => r.ref.category === "product_image");

  function statusSummary(
    items: typeof results,
  ): { total: number; in_original: number; only_staging: number; missing: number; external: number } {
    const storage = items.filter((x) => !x.ref.external_url);
    return {
      total: items.length,
      in_original: storage.filter((x) => x.exists_original).length,
      only_staging: storage.filter((x) => !x.exists_original && x.exists_staging).length,
      missing: storage.filter((x) => !x.exists_original && !x.exists_staging).length,
      external: items.filter((x) => x.ref.external_url).length,
    };
  }

  // Demo-critical: claim PDFs + any scanner photos referenced by demo rows
  const demoCriticalMissing = storageRefs.filter(
    (r) =>
      !r.exists_original &&
      (r.ref.category === "claim_pdf" ||
        (["return_item_photo", "package_photo", "slip_photo", "shipment_photo"].includes(r.ref.category) &&
          r.ref.raw.trim().length > 0)),
  );

  const safeToDemo =
    filesOnlyInStaging === 0 &&
    claimPdfs.every((p) => p.ref.external_url || p.exists_original || !p.exists_staging) &&
    demoCriticalMissing.filter((r) => r.ref.category !== "claim_pdf" || r.exists_staging).length <=
      claimPdfs.filter((p) => !p.exists_original && p.exists_staging).length;

  // More practical SAFE: scanner/claim photos that are referenced must exist on original OR be external CDN
  const blockingMissing = storageRefs.filter(
    (r) =>
      !r.exists_original &&
      !r.ref.external_url &&
      ["claim_pdf", "return_item_photo", "package_photo", "slip_photo", "shipment_photo", "claim_evidence"].includes(
        r.ref.category,
      ),
  );

  const SAFE_TO_DEMO_STORAGE =
    blockingMissing.filter((r) => r.exists_staging || r.ref.category === "claim_pdf").length ===
      blockingMissing.length &&
    blockingMissing.every((r) => r.ref.category === "claim_pdf" ? true : r.exists_staging || r.exists_original);

  // Recalculate clearer safe flag:
  // SAFE if every non-external storage ref either exists on original OR is optional (product external CDN)
  const requiredCategories = new Set([
    "claim_pdf",
    "claim_evidence",
    "return_item_photo",
    "package_photo",
    "slip_photo",
    "shipment_photo",
  ]);
  const requiredMissingOnOriginal = storageRefs.filter(
    (r) => requiredCategories.has(r.ref.category) && !r.exists_original,
  );
  const safe =
    requiredMissingOnOriginal.length === 0 ||
    requiredMissingOnOriginal.every((r) => r.ref.category === "claim_pdf" && !r.exists_staging);

  const manifest = {
    run_id: rid,
    original_ref: ORIGINAL_REF,
    staging_ref: STAGING_REF,
    demo_org: ORG_ID,
    scope,
    storage_buckets_found: { original: origBuckets, staging: stagBuckets },
    referenced_files_count: refs.length,
    storage_refs_count: storageRefs.length,
    external_urls_count: results.filter((r) => r.ref.external_url).length,
    files_existing_in_original: filesInOriginal,
    files_missing_in_original: storageRefs.filter((r) => !r.exists_original).length,
    files_only_in_staging: filesOnlyInStaging,
    files_missing_entirely: filesMissingEntirely,
    broken_urls: brokenUrls.map((r) => ({
      raw: r.ref.raw,
      bucket: r.ref.bucket,
      path: r.ref.path,
      source: `${r.ref.source_table}.${r.ref.source_column}`,
      staging_host: r.ref.staging_host,
      original_host: r.ref.original_host,
    })),
    path_mismatch_staging_host: pathMismatches.map((r) => r.ref.raw),
    claim_pdf_status: statusSummary(claimPdfs),
    claim_evidence_status: statusSummary(results.filter((r) => r.ref.category === "claim_evidence")),
    scanner_image_status: statusSummary(scannerImages),
    shipment_image_status: statusSummary(shipmentImages),
    package_image_status: statusSummary(packageImages),
    product_image_status: statusSummary(productImages),
    required_missing_on_original: requiredMissingOnOriginal.map((r) => ({
      category: r.ref.category,
      bucket: r.ref.bucket,
      path: r.ref.path,
      raw: r.ref.raw,
      exists_staging: r.exists_staging,
      exists_original: r.exists_original,
      source: `${r.ref.source_table}.${r.ref.source_column}`,
    })),
    all_refs: results.map((r) => ({
      category: r.ref.category,
      bucket: r.ref.bucket,
      path: r.ref.path,
      external: r.ref.external_url,
      exists_original: r.exists_original,
      exists_staging: r.exists_staging,
      source: `${r.ref.source_table}.${r.ref.source_column}`,
      source_id: r.ref.source_id,
    })),
    SAFE_TO_DEMO_STORAGE: safe ? "yes" : "no",
  };

  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));

  fs.writeFileSync(
    path.join(outDir, "00_audit_summary.md"),
    [
      "# Original storage parity audit",
      "",
      `**Run:** ${rid}`,
      `**Original:** ${ORIGINAL_REF} | **Staging:** ${STAGING_REF}`,
      "",
      "## Summary",
      "",
      `| Metric | Value |`,
      `|--------|------:|`,
      `| Referenced files (unique) | ${refs.length} |`,
      `| Storage-backed refs | ${storageRefs.length} |`,
      `| Exists on original | ${filesInOriginal} |`,
      `| Missing on original | ${storageRefs.filter((r) => !r.exists_original).length} |`,
      `| Only on staging | ${filesOnlyInStaging} |`,
      `| Missing entirely | ${filesMissingEntirely} |`,
      `| **SAFE_TO_DEMO_STORAGE** | **${safe ? "yes" : "no"}** |`,
      "",
      "## Category status",
      "",
      `- Claim PDFs: ${JSON.stringify(manifest.claim_pdf_status)}`,
      `- Scanner images: ${JSON.stringify(manifest.scanner_image_status)}`,
      `- Shipment images: ${JSON.stringify(manifest.shipment_image_status)}`,
      `- Package/slip images: ${JSON.stringify(manifest.package_image_status)}`,
      `- Product images: ${JSON.stringify(manifest.product_image_status)}`,
      "",
    ].join("\n"),
  );

  if (!safe) {
    const copyList = storageRefs
      .filter((r) => !r.exists_original && r.exists_staging)
      .map((r) => ({ bucket: r.ref.bucket, path: r.ref.path, category: r.ref.category }));

    fs.writeFileSync(
      path.join(outDir, "copy_storage_assets.ts"),
      `/**
 * GENERATED — demo storage copy plan (DO NOT RUN without approval).
 * Run: npx tsx .cursor/audit-reports/original-storage-parity/${rid}/copy_storage_assets.ts --dry-run
 * Apply: npx tsx ... --apply
 */
import { createClient } from "@supabase/supabase-js";
import { loadEnvLocalIntoProcess } from "../../../lib/staging-project-ref";

const COPY_PLAN: { bucket: string; path: string; category: string }[] = ${JSON.stringify(copyList, null, 2)};

async function main() {
  loadEnvLocalIntoProcess();
  const dryRun = !process.argv.includes("--apply");
  const stag = createClient(process.env.STAGING_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  const orig = createClient(process.env.ORIGINAL_SUPABASE_URL!, process.env.ORIGINAL_SERVICE_ROLE_KEY!);
  for (const item of COPY_PLAN) {
    if (dryRun) {
      console.log("would copy", item.bucket, item.path);
      continue;
    }
    const dl = await stag.storage.from(item.bucket).download(item.path);
    if (dl.error) {
      console.error("download failed", item, dl.error.message);
      continue;
    }
    const buf = Buffer.from(await dl.data!.arrayBuffer());
    const up = await orig.storage.from(item.bucket).upload(item.path, buf, { upsert: true });
    console.log(up.error ? "FAIL" : "OK", item.bucket, item.path);
  }
}
main();
`,
    );

    fs.writeFileSync(
      path.join(outDir, "05_copy_demo_storage_assets.sql"),
      `-- Storage objects cannot be copied via SQL.
-- Use copy_storage_assets.ts in this folder (${copyList.length} objects staged for copy).
-- Buckets: ${[...new Set(copyList.map((c) => c.bucket))].join(", ")}
SELECT 'use_copy_storage_assets_ts' AS notice, ${copyList.length}::int AS planned_copy_count;
`,
    );
  }

  console.log(
    JSON.stringify({
      ok: true,
      outDir,
      SAFE_TO_DEMO_STORAGE: safe ? "yes" : "no",
      referenced_files_count: refs.length,
      files_existing_in_original: filesInOriginal,
      files_missing_in_original: storageRefs.filter((r) => !r.exists_original).length,
      files_only_in_staging: filesOnlyInStaging,
      files_missing_entirely: filesMissingEntirely,
      claim_pdf_status: manifest.claim_pdf_status,
    }),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
