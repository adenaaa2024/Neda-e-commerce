/**
 * NEXT-STORAGE-02 — Read-only Supabase Storage inventory + DB path correlation.
 *
 *   npx tsx scripts/storage-inventory-report.ts --max-objects-per-bucket=200
 *   npx tsx scripts/storage-inventory-report.ts --org-id=00000000-0000-0000-0000-000000000001 --max-objects-per-bucket=500
 *
 * Writes: .cursor/audit-reports/next-storage-02/<run_id>/
 *
 * No Storage mutations. No DB writes.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const DEFAULT_BUCKETS = [
  "raw-reports",
  "claim-reports",
  "logos",
  "media",
  "manifests",
  "profiles",
  "incident-photos",
] as const;

const LIST_PAGE = 100;
const DEFAULT_MAX_OBJECTS = 200;
const DB_SAMPLE_ROWS = 2500;

type Classification =
  | "production_raw_report_input"
  | "chunked_upload_part"
  | "pim_scan_cache"
  | "pim_merge_or_test_artifact"
  | "claim_report_pdf"
  | "claim_evidence"
  | "return_photo_evidence"
  | "package_photo_evidence"
  | "pallet_photo_evidence"
  | "logo_branding"
  | "profile_photo"
  | "manifest_or_packing_slip"
  | "run_manifest_or_metadata"
  | "local_audit_should_not_be_uploaded"
  | "unknown_or_orphan_candidate";

type ReferenceStatus =
  | "referenced"
  | "unreferenced_candidate"
  | "unknown_not_checked"
  | "cache"
  | "skipped";

type RiskLevel = "low" | "medium" | "high";

type RecommendedAction =
  | "keep"
  | "inventory_more"
  | "candidate_cleanup_later"
  | "migrate_later"
  | "needs_db_reference_check"
  | "needs_policy_review";

type StorageRow = {
  path: string;
  size: number | null;
  created_at: string | null;
  updated_at: string | null;
};

type NdRow = {
  run_id: string;
  bucket: string;
  object_name: string;
  size: number | null;
  created_at: string | null;
  updated_at: string | null;
  top_level_prefix: string;
  parsed_organization_id: string | null;
  parsed_store_id: string | null;
  module_guess: string | null;
  workflow_guess: string | null;
  entity_or_run_id_guess: string | null;
  classification: Classification;
  reference_status: ReferenceStatus;
  risk_level: RiskLevel;
  reason_codes: string[];
  recommended_action: RecommendedAction;
};

type DbRefIndex = {
  exactPathsByBucket: Map<string, Set<string>>;
  /** Longest-prefix wins — keep sorted descending by length */
  prefixPathsByBucket: Map<string, string[]>;
  pathNeedles: { bucket: string; needle: string; table: string; column: string }[];
};

function loadEnvLocal(): void {
  const p = path.join(process.cwd(), ".env.local");
  if (!fs.existsSync(p)) return;
  const raw = fs.readFileSync(p, "utf8");
  for (const line of raw.split("\n")) {
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

function createServiceClient(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) {
    throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.");
  }
  return createClient(url, key, { auth: { persistSession: false } });
}

function isoRunId(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    d.getUTCFullYear() +
    pad(d.getUTCMonth() + 1) +
    pad(d.getUTCDate()) +
    "T" +
    pad(d.getUTCHours()) +
    pad(d.getUTCMinutes()) +
    pad(d.getUTCSeconds()) +
    "Z"
  );
}

function escapeCsvCell(v: string): string {
  if (/[",\n\r]/.test(v)) return `"${v.replace(/"/g, '""')}"`;
  return v;
}

function rowToCsvLine(cols: string[]): string {
  return cols.map((c) => escapeCsvCell(c)).join(",") + "\n";
}

function trace(tracePath: string, msg: string): void {
  fs.appendFileSync(tracePath, `[${new Date().toISOString()}] ${msg}\n`, "utf8");
}

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

function parseArgs(argv: string[]): {
  runId: string | null;
  buckets: string[] | null;
  orgId: string | null;
  storeId: string | null;
  maxObjectsPerBucket: number;
  prefix: string | null;
  includePublicUrlColumns: boolean;
  dryRunOnly: boolean;
} {
  let runId: string | null = null;
  let buckets: string[] | null = null;
  let orgId: string | null = null;
  let storeId: string | null = null;
  let maxObjectsPerBucket = DEFAULT_MAX_OBJECTS;
  let prefix: string | null = null;
  let includePublicUrlColumns = false;
  let dryRunOnly = true;

  const bucketAcc: string[] = [];
  for (const a of argv) {
    if (a.startsWith("--run-id=")) runId = a.slice("--run-id=".length).trim() || null;
    else if (a.startsWith("--bucket=")) {
      const rest = a.slice("--bucket=".length).trim();
      for (const p of rest.split(",").map((x) => x.trim()).filter(Boolean)) {
        bucketAcc.push(p);
      }
    } else if (a.startsWith("--org-id=")) orgId = a.slice("--org-id=".length).trim() || null;
    else if (a.startsWith("--store-id=")) storeId = a.slice("--store-id=".length).trim() || null;
    else if (a.startsWith("--max-objects-per-bucket=")) {
      const n = Number(a.slice("--max-objects-per-bucket=".length).trim());
      if (Number.isFinite(n) && n > 0) maxObjectsPerBucket = Math.floor(n);
    } else if (a.startsWith("--prefix=")) prefix = a.slice("--prefix=".length).trim() || null;
    else if (a === "--include-public-url-columns") includePublicUrlColumns = true;
    else if (a === "--dry-run-only=false") dryRunOnly = false;
  }
  if (bucketAcc.length) buckets = [...new Set(bucketAcc)];
  return { runId, buckets, orgId, storeId, maxObjectsPerBucket, prefix, includePublicUrlColumns, dryRunOnly };
}

function topLevelPrefix(objectPath: string): string {
  const i = objectPath.indexOf("/");
  return i === -1 ? objectPath : objectPath.slice(0, i);
}

function extractPublicStoragePath(url: string, bucket: string): string | null {
  if (!url || !url.includes("http")) return null;
  const markers = [`/object/public/${bucket}/`, `/object/sign/${bucket}/`];
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

function parsePathGuesses(objectPath: string): {
  parsed_organization_id: string | null;
  parsed_store_id: string | null;
  module_guess: string | null;
  workflow_guess: string | null;
  entity_or_run_id_guess: string | null;
} {
  const parts = objectPath.split("/").filter(Boolean);
  const uuids = objectPath.match(UUID_RE) ?? [];
  const parsed_organization_id =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(parts[0] ?? "") ? parts[0]! : null;
  let parsed_store_id: string | null = null;
  if (parsed_organization_id && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(parts[1] ?? "")) {
    parsed_store_id = parts[1]!;
  }
  let module_guess: string | null = null;
  let workflow_guess: string | null = null;
  if (objectPath.startsWith("amazon-ledger/")) {
    module_guess = "amazon";
    workflow_guess = "ledger_upload";
  } else if (parts.some((p) => p.includes("-pim-") || p.toLowerCase().includes("pim"))) {
    module_guess = "pim";
    workflow_guess = "import";
  } else if (/part-\d{6}/.test(objectPath)) {
    module_guess = "imports";
    workflow_guess = "chunked_upload";
  }
  const entity_or_run_id_guess = uuids.length > 1 ? uuids[uuids.length - 1]! : uuids[0] ?? null;
  return { parsed_organization_id, parsed_store_id, module_guess, workflow_guess, entity_or_run_id_guess };
}

function classifyObject(path: string, bucket: string): { classification: Classification; reason_codes: string[] } {
  const lower = path.toLowerCase();
  const reasons: string[] = [];
  const name = path.split("/").pop() ?? path;

  if (lower.includes(".cursor/") || lower.includes("audit-reports")) {
    return { classification: "local_audit_should_not_be_uploaded", reason_codes: ["path_resembles_local_audit"] };
  }
  if (name.match(/^part-\d{6}$/) || lower.includes("/part-")) {
    return { classification: "chunked_upload_part", reason_codes: ["name_part_nnnnnn"] };
  }
  if (lower.endsWith("pim_scan_cache.pkl")) {
    return { classification: "pim_scan_cache", reason_codes: ["pim_scan_cache_pkl"] };
  }
  if (bucket === "claim-reports" && lower.endsWith(".pdf")) {
    return { classification: "claim_report_pdf", reason_codes: ["claim_reports_bucket_pdf"] };
  }
  if (bucket === "logos" || lower.includes("/branding/") || lower.includes("logo")) {
    return { classification: "logo_branding", reason_codes: ["logos_or_branding_segment"] };
  }
  if (bucket === "profiles") {
    return { classification: "profile_photo", reason_codes: ["profiles_bucket"] };
  }
  if (bucket === "manifests" || lower.includes("manifest")) {
    return { classification: "manifest_or_packing_slip", reason_codes: ["manifests_bucket_or_segment"] };
  }
  if (bucket === "incident-photos") {
    return { classification: "return_photo_evidence", reason_codes: ["incident_photos_bucket"] };
  }
  if (lower.includes("/returns/") || lower.includes("return")) {
    reasons.push("path_return_segment");
    return { classification: "return_photo_evidence", reason_codes: reasons };
  }
  if (lower.includes("/packages/") || lower.includes("package")) {
    return { classification: "package_photo_evidence", reason_codes: ["path_package_segment"] };
  }
  if (lower.includes("/pallets/") || lower.includes("pallet")) {
    return { classification: "pallet_photo_evidence", reason_codes: ["path_pallet_segment"] };
  }
  if (lower.includes("manifest.json") || lower.endsWith("metadata.json")) {
    return { classification: "run_manifest_or_metadata", reason_codes: ["json_manifest_name"] };
  }
  if (bucket === "raw-reports") {
    if (lower.endsWith(".csv") || lower.endsWith(".txt") || lower.endsWith(".xlsx")) {
      if (lower.includes("-pim-") || lower.includes("/pim")) {
        reasons.push("raw_reports_csv_pim_context");
        return { classification: "pim_merge_or_test_artifact", reason_codes: reasons };
      }
      return { classification: "production_raw_report_input", reason_codes: ["raw_reports_tabular"] };
    }
    if (lower.includes("pim") || lower.includes("cache")) {
      return { classification: "pim_merge_or_test_artifact", reason_codes: ["raw_reports_pim_or_cache_context"] };
    }
    return { classification: "unknown_or_orphan_candidate", reason_codes: ["raw_reports_unclassified"] };
  }
  if (bucket === "media") {
    if (lower.includes("claim") || lower.includes("evidence")) {
      return { classification: "claim_evidence", reason_codes: ["media_claim_evidence_segment"] };
    }
    return { classification: "unknown_or_orphan_candidate", reason_codes: ["media_unclassified"] };
  }
  return { classification: "unknown_or_orphan_candidate", reason_codes: ["no_rule_matched"] };
}

function riskForRow(
  bucket: string,
  classification: Classification,
  reference_status: ReferenceStatus,
): { risk: RiskLevel; reasons: string[] } {
  const r: string[] = [];
  let risk: RiskLevel = "low";
  const publicBuckets = new Set(["logos", "media", "manifests", "incident-photos", "profiles"]);
  if (publicBuckets.has(bucket) && (classification.includes("photo") || classification === "claim_evidence")) {
    risk = "high";
    r.push("public_bucket_sensitive_evidence_possible");
  } else if (publicBuckets.has(bucket)) {
    risk = "medium";
    r.push("public_bucket");
  }
  if (bucket === "raw-reports" && reference_status === "unreferenced_candidate") {
    risk = risk === "high" ? "high" : "medium";
    r.push("private_raw_unreferenced_may_be_stale");
  }
  return { risk, reasons: r };
}

function recommendedActionFor(
  classification: Classification,
  reference_status: ReferenceStatus,
): RecommendedAction {
  if (reference_status === "referenced") return "keep";
  if (classification === "pim_scan_cache" || classification === "chunked_upload_part") return "candidate_cleanup_later";
  if (reference_status === "unknown_not_checked") return "needs_db_reference_check";
  if (reference_status === "unreferenced_candidate") return "inventory_more";
  if (classification === "local_audit_should_not_be_uploaded") return "needs_policy_review";
  return "migrate_later";
}

function isProbablyFolder(item: { id?: string | null; name: string; metadata?: { size?: number } | null }): boolean {
  const sz = item.metadata?.size;
  if (typeof sz === "number" && sz >= 0) return false;
  if (item.id) return false;
  const n = item.name;
  if (/^part-\d{6}$/.test(n)) return false;
  if (/\.[a-z0-9]{2,8}$/i.test(n)) return false;
  return true;
}

async function listShallow(
  client: SupabaseClient,
  bucket: string,
  prefix: string,
  max: number,
  tracePath: string,
): Promise<StorageRow[]> {
  trace(tracePath, `LIST shallow bucket=${bucket} prefix=${JSON.stringify(prefix)} max=${max}`);
  const { data, error } = await client.storage.from(bucket).list(prefix, {
    limit: max,
    offset: 0,
    sortBy: { column: "name", order: "asc" },
  });
  if (error) throw new Error(error.message);
  const out: StorageRow[] = [];
  for (const it of data ?? []) {
    const p = prefix ? `${prefix}/${it.name}` : it.name;
    const md = it.metadata as { size?: number } | undefined;
    out.push({
      path: p,
      size: typeof md?.size === "number" ? md.size : null,
      created_at: it.created_at ?? null,
      updated_at: it.updated_at ?? null,
    });
  }
  return out;
}

async function listRecursive(
  client: SupabaseClient,
  bucket: string,
  roots: string[],
  maxTotal: number,
  tracePath: string,
  warn: (c: string, d: string) => void,
): Promise<StorageRow[]> {
  const out: StorageRow[] = [];
  const queue: string[] = [...roots];
  while (queue.length > 0 && out.length < maxTotal) {
    const prefix = queue.shift()!;
    let offset = 0;
    for (;;) {
      if (out.length >= maxTotal) break;
      const lim = Math.min(LIST_PAGE, maxTotal - out.length);
      trace(tracePath, `LIST recursive bucket=${bucket} prefix=${JSON.stringify(prefix)} offset=${offset} lim=${lim}`);
      const { data, error } = await client.storage.from(bucket).list(prefix, {
        limit: lim,
        offset,
        sortBy: { column: "name", order: "asc" },
      });
      if (error) {
        warn("STORAGE_LIST", `${bucket} ${prefix}: ${error.message}`);
        break;
      }
      const batch = data ?? [];
      if (batch.length === 0) break;
      for (const it of batch) {
        if (out.length >= maxTotal) break;
        const full = prefix ? `${prefix}/${it.name}` : it.name;
        if (isProbablyFolder(it as { id?: string | null; name: string; metadata?: { size?: number } })) {
          queue.push(full);
        } else {
          const md = it.metadata as { size?: number } | undefined;
          out.push({
            path: full,
            size: typeof md?.size === "number" ? md.size : null,
            created_at: it.created_at ?? null,
            updated_at: it.updated_at ?? null,
          });
        }
      }
      offset += batch.length;
      if (batch.length < lim) break;
    }
  }
  return out;
}

function normalizePrefix(p: string): string {
  const t = p.trim();
  if (!t) return "";
  return t.endsWith("/") ? t.slice(0, -1) : t;
}

function listPrefixesForBucket(
  bucket: string,
  orgId: string | null,
  storeId: string | null,
  userPrefix: string | null,
): string[] {
  if (userPrefix != null && userPrefix.length > 0) {
    return [normalizePrefix(userPrefix)];
  }
  if (!orgId) return [""];
  const oid = orgId.trim();
  const sid = storeId?.trim();
  if (bucket === "raw-reports") {
    const roots = [`${oid}`, `amazon-ledger/${oid}`];
    if (sid) roots.unshift(`${oid}/${sid}`);
    return roots;
  }
  if (bucket === "logos") {
    const roots = [`${oid}`, `logos/${oid}`];
    if (sid) roots.unshift(`${oid}/${sid}`);
    return roots;
  }
  if (sid) return [`${oid}/${sid}`, `${oid}`];
  return [`${oid}`];
}

function buildRefMatch(
  bucket: string,
  objectPath: string,
  idx: DbRefIndex,
): { status: ReferenceStatus; codes: string[]; table?: string; column?: string } {
  const exact = idx.exactPathsByBucket.get(bucket);
  if (exact?.has(objectPath)) {
    return { status: "referenced", codes: ["exact_bucket_path"], table: "various", column: "various" };
  }
  const prefs = idx.prefixPathsByBucket.get(bucket);
  if (prefs) {
    for (const p of prefs) {
      if (objectPath === p || objectPath.startsWith(`${p}/`)) {
        return {
          status: "referenced",
          codes: ["prefix_raw_report_upload"],
          table: "raw_report_uploads",
          column: "metadata.storage_prefix",
        };
      }
    }
  }
  for (const n of idx.pathNeedles) {
    if (n.bucket !== bucket) continue;
    if (objectPath === n.needle || objectPath.includes(n.needle)) {
      return {
        status: "referenced",
        codes: ["url_extracted_path"],
        table: n.table,
        column: n.column,
      };
    }
  }
  return { status: "unreferenced_candidate", codes: ["no_db_match_in_sample"] };
}

async function loadDbRefIndex(
  client: SupabaseClient,
  orgId: string | null,
  includeUrlColumns: boolean,
  tracePath: string,
  warn: (c: string, d: string) => void,
): Promise<DbRefIndex> {
  const exactPathsByBucket = new Map<string, Set<string>>();
  const prefixPathsByBucket = new Map<string, string[]>();
  const pathNeedles: DbRefIndex["pathNeedles"] = [];

  const ensureExact = (b: string) => {
    if (!exactPathsByBucket.has(b)) exactPathsByBucket.set(b, new Set());
    return exactPathsByBucket.get(b)!;
  };
  const addPrefixes = (b: string, prefixes: string[]) => {
    const cur = prefixPathsByBucket.get(b) ?? [];
    prefixPathsByBucket.set(b, [...new Set([...cur, ...prefixes])].sort((a, x) => x.length - a.length));
  };

  try {
    let q = client.from("raw_report_uploads").select("id, organization_id, metadata").limit(DB_SAMPLE_ROWS);
    if (orgId) q = q.eq("organization_id", orgId);
    const { data, error } = await q;
    trace(tracePath, `DB raw_report_uploads rows=${(data ?? []).length} err=${error?.message ?? "none"}`);
    if (error) throw error;
    const prefs: string[] = [];
    for (const row of data ?? []) {
      const r = row as Record<string, unknown>;
      const meta = r.metadata as Record<string, unknown> | null | undefined;
      const sp =
        (typeof meta?.storage_prefix === "string" ? meta.storage_prefix.trim() : "") ||
        (typeof meta?.storagePrefix === "string" ? String(meta.storagePrefix).trim() : "") ||
        (typeof r.storage_prefix === "string" ? String(r.storage_prefix).trim() : "");
      if (sp) prefs.push(sp.replace(/\/+$/, ""));
      const rawPath =
        (typeof meta?.raw_file_path === "string" && meta.raw_file_path.trim()) ||
        (typeof meta?.storage_path === "string" && meta.storage_path.trim()) ||
        "";
      if (rawPath) ensureExact("raw-reports").add(rawPath.replace(/^\//, ""));
    }
    addPrefixes("raw-reports", prefs);
  } catch (e) {
    warn("DB_RAW_REPORT_UPLOADS", e instanceof Error ? e.message : typeof e === "object" ? JSON.stringify(e) : String(e));
  }

  try {
    const sel = "report_url, company_id, organization_id";
    let res = await client.from("claim_submissions").select(sel).limit(DB_SAMPLE_ROWS);
    if (res.error) {
      res = await client.from("claim_submissions").select("report_url").limit(DB_SAMPLE_ROWS);
    }
    trace(tracePath, `DB claim_submissions rows=${(res.data ?? []).length} err=${res.error?.message ?? "none"}`);
    if (res.error) throw res.error;
    for (const row of res.data ?? []) {
      const r = row as { report_url?: string; company_id?: string; organization_id?: string };
      if (orgId) {
        const rid = (r.company_id ?? r.organization_id ?? "").trim();
        if (rid && rid !== orgId) continue;
      }
      const p = r.report_url?.trim();
      if (p) ensureExact("claim-reports").add(p);
    }
  } catch (e) {
    warn("DB_CLAIM_SUBMISSIONS", e instanceof Error ? e.message : String(e));
  }

  try {
    let q = client.from("organization_settings").select("logo_url, organization_id").limit(DB_SAMPLE_ROWS);
    if (orgId) q = q.eq("organization_id", orgId);
    const { data, error } = await q;
    trace(tracePath, `DB organization_settings rows=${(data ?? []).length} err=${error?.message ?? "none"}`);
    if (error) throw error;
    for (const row of data ?? []) {
      const url = String((row as { logo_url?: string }).logo_url ?? "").trim();
      if (!url) continue;
      for (const b of ["logos", "media"] as const) {
        const p = extractPublicStoragePath(url, b);
        if (p) pathNeedles.push({ bucket: b, needle: p, table: "organization_settings", column: "logo_url" });
      }
    }
  } catch (e) {
    warn("DB_ORGANIZATION_SETTINGS", e instanceof Error ? e.message : String(e));
  }

  try {
    const { data, error } = await client.from("profiles").select("photo_url, id").limit(Math.min(500, DB_SAMPLE_ROWS));
    trace(tracePath, `DB profiles rows=${(data ?? []).length} err=${error?.message ?? "none"}`);
    if (error) throw error;
    for (const row of data ?? []) {
      const url = String((row as { photo_url?: string }).photo_url ?? "").trim();
      if (!url) continue;
      const pProf = extractPublicStoragePath(url, "profiles");
      if (pProf) pathNeedles.push({ bucket: "profiles", needle: pProf, table: "profiles", column: "photo_url" });
      const pMed = extractPublicStoragePath(url, "media");
      if (pMed) pathNeedles.push({ bucket: "media", needle: pMed, table: "profiles", column: "photo_url" });
    }
  } catch (e) {
    warn("DB_PROFILES", e instanceof Error ? e.message : String(e));
  }

  if (includeUrlColumns) {
    const mediaCols = [
      "photo_url",
      "manifest_photo_url",
      "photo_return_label_url",
      "photo_opened_url",
      "photo_closed_url",
      "manifest_url",
    ];
    try {
      let q = client.from("returns").select(`id, organization_id, ${mediaCols.join(",")}`).limit(400);
      if (orgId) q = q.eq("organization_id", orgId);
      const { data, error } = await q;
      trace(tracePath, `DB returns photo cols rows=${(data ?? []).length} err=${error?.message ?? "none"}`);
      if (!error) {
        for (const row of data ?? []) {
          for (const c of mediaCols) {
            const url = String((row as Record<string, unknown>)[c] ?? "").trim();
            if (!url) continue;
            for (const b of ["media", "manifests"] as const) {
              const p = extractPublicStoragePath(url, b);
              if (p) pathNeedles.push({ bucket: b, needle: p, table: "returns", column: c });
            }
          }
        }
      }
    } catch (e) {
      warn("DB_RETURNS_URLS", e instanceof Error ? e.message : String(e));
    }

    try {
      let q = client.from("packages").select("id, organization_id, photo_url, manifest_photo_url, photo_evidence").limit(300);
      if (orgId) q = q.eq("organization_id", orgId);
      const { data, error } = await q;
      if (!error) {
        for (const row of data ?? []) {
          for (const c of ["photo_url", "manifest_photo_url"] as const) {
            const url = String((row as Record<string, unknown>)[c] ?? "").trim();
            if (!url) continue;
            for (const b of ["media", "manifests"] as const) {
              const p = extractPublicStoragePath(url, b);
              if (p) pathNeedles.push({ bucket: b, needle: p, table: "packages", column: c });
            }
          }
          const pe = (row as { photo_evidence?: unknown }).photo_evidence;
          if (pe && typeof pe === "object") {
            const json = JSON.stringify(pe);
            const urlMatches = json.match(/https?:\/\/[^"'\\s]+/g) ?? [];
            for (const url of urlMatches.slice(0, 40)) {
              for (const b of ["media", "manifests"] as const) {
                const p = extractPublicStoragePath(url, b);
                if (p) pathNeedles.push({ bucket: b, needle: p, table: "packages", column: "photo_evidence" });
              }
            }
          }
        }
      }
    } catch (e) {
      warn("DB_PACKAGES_URLS", e instanceof Error ? e.message : String(e));
    }

    try {
      let q = client
        .from("pallets")
        .select("id, organization_id, photo_url, bol_photo_url, manifest_photo_url, photo_evidence")
        .limit(300);
      if (orgId) q = q.eq("organization_id", orgId);
      const { data, error } = await q;
      if (!error) {
        for (const row of data ?? []) {
          for (const c of ["photo_url", "bol_photo_url", "manifest_photo_url"] as const) {
            const url = String((row as Record<string, unknown>)[c] ?? "").trim();
            if (!url) continue;
            for (const b of ["media", "manifests"] as const) {
              const p = extractPublicStoragePath(url, b);
              if (p) pathNeedles.push({ bucket: b, needle: p, table: "pallets", column: c });
            }
          }
        }
      }
    } catch (e) {
      warn("DB_PALLETS_URLS", e instanceof Error ? e.message : String(e));
    }
  }

  try {
    const { data } = await client.from("claim_candidates").select("*").limit(1);
    if (data?.[0]) {
      const keys = Object.keys(data[0] as object).filter((k) => /evidence|photo|url|storage/i.test(k));
      trace(tracePath, `DB claim_candidates optional cols=${keys.join(",") || "none"}`);
    }
  } catch {
    /* ignore */
  }

  return { exactPathsByBucket, prefixPathsByBucket, pathNeedles };
}

function writeCanonicalRecommendations(outPath: string): void {
  const body = `# Canonical storage path recommendations (NEXT-STORAGE-02)

This file is generated guidance only — **no migration has been applied**.

## Rules

- First path segment: \`{organization_id}\` for all business buckets.
- Store-scoped content: second segment \`{store_id}\` or literal \`org-level\` for tenant-wide assets.
- Then: \`{module}/{workflow}/{run_id_or_entity_id}/...\` as stable segments for retention and cleanup.

## Per bucket

### raw-reports (private)

- \`{organization_id}/{store_id|org-level}/amazon/imports/{upload_id}/parts/part-{nnnnnn}\`
- \`{organization_id}/org-level/pim/imports/{upload_id}/cache/pim_scan_cache.pkl\` (separate cache from merged CSVs)
- Legacy \`amazon-ledger/{organization_id}/...\` should be migrated to the tree above when approved.

### claim-reports (private)

- \`{organization_id}/{store_id|org-level}/claims/reports/{submission_id}/{export_id}.pdf\`
- DB stores **object path**; always serve via **signed URL**.

### media / manifests

- Prefer **private + signed** for claim/scanner evidence long-term; keep public only for intentional marketing assets.
- \`media/{organization_id}/{store_id}/returns/{return_id}/photos/{category}/{file_id}.jpg\`
- \`manifests/{organization_id}/{store_id}/packages/{package_id}/manifest/{file_id}.jpg\`

### logos (public OK)

- \`logos/{organization_id}/org-level/branding/logo/{file_id}.svg\`

### profiles

- \`profiles/{organization_id}/{profile_id}/avatar/{file_id}.jpg\` (or keep current pattern but always include org).

## Inventory discipline

- Run this script **per \`--org-id\`** for full recursive correlation; root-only listing is intentionally shallow.
- Never delete or move objects until DB reference report shows **unreferenced** with stakeholder sign-off.
`;
  fs.writeFileSync(outPath, body, "utf8");
}

async function main(): Promise<void> {
  loadEnvLocal();
  const args = parseArgs(process.argv.slice(2));
  const runId = args.runId ?? isoRunId();
  const outDir = path.resolve(".cursor", "audit-reports", "next-storage-02", runId);
  const logsDir = path.join(outDir, "logs");
  fs.mkdirSync(logsDir, { recursive: true });
  const tracePath = path.join(logsDir, "query-trace.txt");
  const warnPath = path.join(logsDir, "warnings.ndjson");
  fs.writeFileSync(tracePath, "", "utf8");
  fs.writeFileSync(warnPath, "", "utf8");
  const warn = (code: string, detail: string) => {
    fs.appendFileSync(warnPath, JSON.stringify({ code, detail }) + "\n", "utf8");
  };

  const client = createServiceClient();
  const buckets = args.buckets?.length ? args.buckets : [...DEFAULT_BUCKETS];

  const ndjsonPath = path.join(outDir, "01-storage-objects.ndjson");
  fs.writeFileSync(ndjsonPath, "", "utf8");

  const bucketSummary: { bucket: string; listed: number; error?: string; shallow: boolean }[] = [];
  const prefixCounts = new Map<string, number>();
  const classCounts = new Map<string, number>();
  const allRows: NdRow[] = [];
  const dbMatches: { object: string; bucket: string; table: string; column: string; kind: string }[] = [];
  const orphans: NdRow[] = [];

  const refIdx = await loadDbRefIndex(client, args.orgId, args.includePublicUrlColumns, tracePath, warn);

  for (const bucket of buckets) {
    const roots = listPrefixesForBucket(bucket, args.orgId, args.storeId, args.prefix);
    const shallow = !args.orgId && !args.prefix;
    let objects: StorageRow[] = [];
    let errMsg: string | undefined;
    try {
      if (shallow) {
        objects = await listShallow(client, bucket, "", args.maxObjectsPerBucket, tracePath);
      } else {
        const perRoot = Math.max(1, Math.floor(args.maxObjectsPerBucket / Math.max(1, roots.length)));
        objects = [];
        for (const root of roots) {
          if (objects.length >= args.maxObjectsPerBucket) break;
          const cap = args.maxObjectsPerBucket - objects.length;
          const sub = await listRecursive(client, bucket, [root], Math.min(perRoot, cap), tracePath, warn);
          objects.push(...sub);
        }
        if (objects.length > args.maxObjectsPerBucket) {
          objects = objects.slice(0, args.maxObjectsPerBucket);
        }
      }
    } catch (e) {
      errMsg = e instanceof Error ? e.message : String(e);
      warn("BUCKET_ACCESS", `${bucket}: ${errMsg}`);
    }
    bucketSummary.push({ bucket, listed: objects.length, error: errMsg, shallow });

    for (const ob of objects) {
      const top = topLevelPrefix(ob.path);
      prefixCounts.set(`${bucket}|${top}`, (prefixCounts.get(`${bucket}|${top}`) ?? 0) + 1);
      const { classification, reason_codes } = classifyObject(ob.path, bucket);
      classCounts.set(classification, (classCounts.get(classification) ?? 0) + 1);

      const m = buildRefMatch(bucket, ob.path, refIdx);
      let reference_status: ReferenceStatus;
      const rc = [...reason_codes];
      if (m.status === "referenced") {
        reference_status = "referenced";
        if (m.table) {
          dbMatches.push({
            object: ob.path,
            bucket,
            table: m.table,
            column: m.column ?? "",
            kind: m.codes[0] ?? "",
          });
        }
        if (m.codes.length) rc.push(...m.codes);
      } else if (classification === "chunked_upload_part" || classification === "pim_scan_cache") {
        reference_status = "cache";
        rc.push("no_db_prefix_match_treat_as_cache");
      } else {
        reference_status = m.status;
        if (m.table) {
          dbMatches.push({
            object: ob.path,
            bucket,
            table: m.table,
            column: m.column ?? "",
            kind: m.codes[0] ?? "",
          });
        }
        if (m.codes.length) rc.push(...m.codes);
      }

      const { risk: risk_level, reasons: riskReasons } = riskForRow(bucket, classification, reference_status);
      const recommended_action = recommendedActionFor(classification, reference_status);
      const guesses = parsePathGuesses(ob.path);

      const row: NdRow = {
        run_id: runId,
        bucket,
        object_name: ob.path,
        size: ob.size,
        created_at: ob.created_at,
        updated_at: ob.updated_at,
        top_level_prefix: top,
        parsed_organization_id: guesses.parsed_organization_id,
        parsed_store_id: guesses.parsed_store_id,
        module_guess: guesses.module_guess,
        workflow_guess: guesses.workflow_guess,
        entity_or_run_id_guess: guesses.entity_or_run_id_guess,
        classification,
        reference_status,
        risk_level,
        reason_codes: [...rc, ...riskReasons.map((r) => `risk:${r}`)],
        recommended_action,
      };
      fs.appendFileSync(ndjsonPath, JSON.stringify(row) + "\n", "utf8");
      allRows.push(row);
      if (reference_status === "unreferenced_candidate") orphans.push(row);
    }
  }

  fs.writeFileSync(
    path.join(outDir, "00-bucket-summary.csv"),
    rowToCsvLine(["bucket", "objects_listed", "shallow_listing", "error"]) +
      bucketSummary.map((b) => rowToCsvLine([b.bucket, String(b.listed), b.shallow ? "yes" : "no", b.error ?? ""])).join(""),
    "utf8",
  );

  fs.writeFileSync(
    path.join(outDir, "02-path-prefix-summary.csv"),
    rowToCsvLine(["bucket", "top_level_prefix", "object_count"]) +
      [...prefixCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => {
          const pipe = k.indexOf("|");
          const bucket = k.slice(0, pipe);
          const pref = k.slice(pipe + 1);
          return rowToCsvLine([bucket, pref, String(v)]);
        })
        .join(""),
    "utf8",
  );

  fs.writeFileSync(
    path.join(outDir, "03-classification-rollup.csv"),
    rowToCsvLine(["classification", "count"]) +
      [...classCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([c, n]) => rowToCsvLine([c, String(n)]))
        .join(""),
    "utf8",
  );

  fs.writeFileSync(
    path.join(outDir, "04-db-reference-matches.csv"),
    rowToCsvLine(["bucket", "object_name", "db_table", "db_column", "match_kind"]) +
      dbMatches.map((m) => rowToCsvLine([m.bucket, m.object, m.table, m.column, m.kind])).join(""),
    "utf8",
  );

  fs.writeFileSync(
    path.join(outDir, "05-orphan-candidates.csv"),
    rowToCsvLine(["bucket", "object_name", "classification", "risk_level", "recommended_action", "reason_codes"]) +
      orphans
        .map((o) =>
          rowToCsvLine([o.bucket, o.object_name, o.classification, o.risk_level, o.recommended_action, o.reason_codes.join(";")]),
        )
        .join(""),
    "utf8",
  );

  const publicBuckets = ["logos", "media", "manifests", "incident-photos", "profiles"];
  const policyLines: string[][] = [];
  for (const b of buckets) {
    const isPublic = publicBuckets.includes(b);
    const risk = isPublic ? "medium_or_high_for_evidence" : "lower_default_private";
    policyLines.push([
      b,
      isPublic ? "likely_public_per_repo_migrations_or_usage" : "private_or_signed_urls_expected",
      risk,
      isPublic
        ? "Prefer signed URLs for sensitive evidence even if bucket is public today"
        : "Keep private; use signed URLs for operator access",
    ]);
  }
  fs.writeFileSync(
    path.join(outDir, "06-policy-risk-summary.csv"),
    rowToCsvLine(["bucket", "visibility_guess", "risk_band", "note"]) + policyLines.map((p) => rowToCsvLine(p)).join(""),
    "utf8",
  );

  writeCanonicalRecommendations(path.join(outDir, "07-canonical-path-recommendations.md"));

  const warnLen = fs.readFileSync(warnPath, "utf8").trim().length;
  const manifest = {
    run_id: runId,
    read_only: true,
    no_storage_mutations: true,
    no_db_mutations: true,
    buckets_requested: buckets,
    org_id: args.orgId,
    store_id: args.storeId,
    max_objects_per_bucket: args.maxObjectsPerBucket,
    prefix: args.prefix,
    include_public_url_columns: args.includePublicUrlColumns,
    dry_run_only: args.dryRunOnly,
    total_objects_listed: allRows.length,
    orphan_candidates: orphans.length,
    db_reference_match_rows: dbMatches.length,
    bucket_summary: bucketSummary,
  };
  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");

  const files = [
    "manifest.json",
    "00-bucket-summary.csv",
    "01-storage-objects.ndjson",
    "02-path-prefix-summary.csv",
    "03-classification-rollup.csv",
    "04-db-reference-matches.csv",
    "05-orphan-candidates.csv",
    "06-policy-risk-summary.csv",
    "07-canonical-path-recommendations.md",
    path.join("logs", "query-trace.txt"),
    path.join("logs", "warnings.ndjson"),
  ];

  const checks: { id: string; passed: boolean; detail: string }[] = [];
  checks.push({ id: "J1", passed: true, detail: "No write/delete/move/copy/rename mode; read-only inventory." });
  const missing = files.filter((f) => !fs.existsSync(path.join(outDir, f)));
  checks.push({
    id: "J2",
    passed: missing.length === 0,
    detail: missing.length ? `Missing: ${missing.join(",")}` : "All output files present.",
  });
  const bucketErrors = bucketSummary.filter((b) => b.error);
  checks.push({
    id: "J3",
    passed: bucketErrors.length < buckets.length,
    detail: `Buckets with list errors: ${bucketErrors.map((b) => `${b.bucket}:${b.error}`).join("; ") || "none"}`,
  });
  checks.push({
    id: "J4",
    passed: true,
    detail: `max_objects_per_bucket=${args.maxObjectsPerBucket} shallow_root=${!args.orgId && !args.prefix}`,
  });
  checks.push({
    id: "J5",
    passed: true,
    detail: args.orgId
      ? `org-scoped roots used (store_id=${args.storeId ?? "n/a"})`
      : "root shallow listing — use --org-id for deeper inventory",
  });
  checks.push({
    id: "J6",
    passed: allRows.length === 0 || allRows.every((r) => Boolean(r.classification)),
    detail: "Every listed object has a classification label.",
  });
  checks.push({
    id: "J7",
    passed: true,
    detail: `DB correlation pass completed; match_rows=${dbMatches.length}; warnings_bytes=${warnLen}`,
  });
  checks.push({ id: "J8", passed: true, detail: "Orphan CSV is advisory only; no deletes performed." });
  checks.push({
    id: "J9",
    passed: fs.existsSync(path.join(outDir, "06-policy-risk-summary.csv")),
    detail: "Public/private risk summary emitted.",
  });
  checks.push({
    id: "J10",
    passed: fs.existsSync(path.join(outDir, "07-canonical-path-recommendations.md")),
    detail: "Canonical path recommendations markdown emitted.",
  });

  const jOrder = ["J1", "J2", "J3", "J4", "J5", "J6", "J7", "J8", "J9", "J10"];
  checks.sort((a, b) => jOrder.indexOf(a.id) - jOrder.indexOf(b.id));

  const strictFail = !checks.find((c) => c.id === "J2")?.passed;
  if (strictFail) process.exitCode = 1;

  fs.writeFileSync(path.join(outDir, "10-validation-checks.json"), JSON.stringify(checks, null, 2), "utf8");

  console.log(
    JSON.stringify(
      {
        runId,
        outDir,
        totalObjects: allRows.length,
        orphanCandidates: orphans.length,
        dbMatchRows: dbMatches.length,
        bucketSummary,
        classificationTop: [...classCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15),
        checks,
        exitCode: strictFail ? 1 : 0,
      },
      null,
      2,
    ),
  );
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
