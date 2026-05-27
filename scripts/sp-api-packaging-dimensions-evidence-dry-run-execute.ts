/**
 * SP-API packaging dimensions evidence — dry-run execute (catalog GET, no DB writes).
 *
 *   npx tsx scripts/sp-api-packaging-dimensions-evidence-dry-run-execute.ts --apply
 *   npx tsx scripts/sp-api-packaging-dimensions-evidence-dry-run-execute.ts --apply --pilot
 *   npx tsx scripts/sp-api-packaging-dimensions-evidence-dry-run-execute.ts --apply --tier-a-full
 */
import { createReadStream } from "node:fs";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import pg from "pg";

import { getAmazonAccessToken, type AmazonSpApiCredentials } from "../lib/amazon/sp-api";
import { amazonSpCredentialsLookComplete } from "../lib/amazon-marketplace-credentials";
import { filterValidAmazonRetailMarketplaceIds } from "../lib/amazon-retail-marketplace-ids";
import {
  getStagingProjectRef,
  loadEnvLocalIntoProcess,
  refFromSupabaseUrl,
  supabaseUrlMatchesStagingRef,
} from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const ORIGINAL_REF = "kxsvedvpjldygtdbylsy";
const ORG = "00000000-0000-0000-0000-000000000001";
const STORE = "509ee1f6-622c-46a5-8110-7b889ba46c2c";
const REQUIRED_BRANCH = "feature/product-canonicalization-v2";
const APPROVAL_PATH = ".cursor/operator-approvals/sp-api-packaging-dimensions-evidence-approval.md";
const PLAN_BASE = ".cursor/audit-reports/sp-api-packaging-dimensions-evidence-plan";
const PLAN_DEFAULT = "20260526T230000Z";
const OUT_BASE = ".cursor/audit-reports/sp-api-packaging-dimensions-evidence-dry-run-execute";
const DELAY_MS = 1000;
const DEFAULT_CATALOG_HOST = "https://sellingpartnerapi-na.amazon.com";
const DEFAULT_MARKETPLACE_ID = "ATVPDKIKX0DER";

type QualityClass = "valid_dimensions" | "partial_dimensions" | "missing" | "conflict" | "unsafe";

type CandidateRow = {
  candidate_id: string;
  product_id: string;
  sku: string;
  packaging_level: string;
  fulfillment_context: string;
  source_table: string;
  confidence_score: string;
  blockers: string;
};

type ParsedDims = {
  length: number | null;
  width: number | null;
  height: number | null;
  unit: string | null;
  weight: number | null;
  weight_unit: string | null;
};

type EvidenceRow = {
  candidate_id: string;
  product_id: string;
  sku: string;
  identifier_tier: "a" | "b" | "c";
  asin: string | null;
  api_called: boolean;
  http_ok: boolean;
  http_status: number | null;
  attempts: number;
  error: string | null;
  quality: QualityClass;
  quality_reason: string;
  item_dimensions: ParsedDims | null;
  package_dimensions: ParsedDims | null;
};

function runIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function planRunIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--plan-run-id="));
  return a ? a.split("=")[1]!.trim() : PLAN_DEFAULT;
}

function apiLimitArg(): number {
  if (process.argv.includes("--tier-a-full")) return 9999;
  if (process.argv.includes("--pilot")) return 10;
  const a = process.argv.find((x) => x.startsWith("--api-limit="));
  return a ? Number(a.split("=")[1]) : 50;
}

function envFlag(name: string): boolean {
  const v = process.env[name]?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

function readApproval(): { valid: boolean; run: boolean; evidence: boolean } {
  const text = fs.readFileSync(path.join(process.cwd(), APPROVAL_PATH), "utf8");
  const run = /APPROVED_TO_RUN_STAGING\s*=\s*true/i.test(text);
  const evidence = /APPROVED_SP_API_PACKAGING_DIMENSIONS_EVIDENCE\s*=\s*true/i.test(text);
  return { valid: run && evidence, run, evidence };
}

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else inQuotes = false;
      } else cur += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

async function loadCandidates(csvPath: string): Promise<CandidateRow[]> {
  const rows: CandidateRow[] = [];
  const rl = readline.createInterface({ input: createReadStream(csvPath, "utf8"), crlfDelay: Infinity });
  let headers: string[] = [];
  let first = true;
  for await (const line of rl) {
    if (!line.trim()) continue;
    const cols = parseCsvLine(line);
    if (first) {
      headers = cols;
      first = false;
      continue;
    }
    const row: Record<string, string> = {};
    headers.forEach((h, i) => {
      row[h] = cols[i] ?? "";
    });
    rows.push(row as unknown as CandidateRow);
  }
  return rows;
}

function parseAsinFromSku(sku: string): string | null {
  const m = sku.match(/(B0[A-Z0-9]{8})/i);
  return m ? m[1]!.toUpperCase() : null;
}

function identifierTier(sku: string): "a" | "b" | "c" {
  if (parseAsinFromSku(sku)) return "a";
  if (/^X0[A-Z0-9]{8}/i.test(sku.trim())) return "b";
  return "c";
}

function emptyDims(): ParsedDims {
  return { length: null, width: null, height: null, unit: null, weight: null, weight_unit: null };
}

function parseMeasure(v: unknown): { value: number | null; unit: string | null } {
  if (v == null) return { value: null, unit: null };
  if (typeof v === "number" && Number.isFinite(v)) return { value: v, unit: null };
  if (typeof v === "object" && !Array.isArray(v)) {
    const o = v as Record<string, unknown>;
    const val = Number(o.value);
    const unit = typeof o.unit === "string" ? o.unit : null;
    return { value: Number.isFinite(val) ? val : null, unit };
  }
  return { value: null, unit: null };
}

function parseDimensionBlock(block: unknown): ParsedDims {
  if (!block || typeof block !== "object" || Array.isArray(block)) return emptyDims();
  const b = block as Record<string, unknown>;
  const l = parseMeasure(b.length);
  const w = parseMeasure(b.width);
  const h = parseMeasure(b.height);
  const wt = parseMeasure(b.weight);
  const unit = l.unit ?? w.unit ?? h.unit ?? null;
  return {
    length: l.value,
    width: w.value,
    height: h.value,
    unit,
    weight: wt.value,
    weight_unit: wt.unit,
  };
}

function extractCatalogDimensions(body: unknown, marketplaceId: string): { item: ParsedDims; package: ParsedDims } {
  const root = body as Record<string, unknown>;
  const dims = root.dimensions;
  if (!Array.isArray(dims)) return { item: emptyDims(), package: emptyDims() };
  const entry =
    dims.find((d) => d && typeof d === "object" && (d as Record<string, unknown>).marketplaceId === marketplaceId) ??
    dims[0];
  if (!entry || typeof entry !== "object") return { item: emptyDims(), package: emptyDims() };
  const e = entry as Record<string, unknown>;
  return { item: parseDimensionBlock(e.item), package: parseDimensionBlock(e.package) };
}

function hasFullLwh(d: ParsedDims): boolean {
  return [d.length, d.width, d.height].every((n) => n != null && n > 0);
}

function hasPartialLwh(d: ParsedDims): boolean {
  const present = [d.length, d.width, d.height].filter((n) => n != null && n > 0).length;
  return present > 0 && present < 3;
}

function dimsConflict(a: ParsedDims, b: ParsedDims): boolean {
  if (!hasFullLwh(a) || !hasFullLwh(b)) return false;
  const fields: (keyof ParsedDims)[] = ["length", "width", "height"];
  for (const f of fields) {
    const av = a[f] as number | null;
    const bv = b[f] as number | null;
    if (av == null || bv == null) continue;
    const denom = Math.max(av, bv, 0.001);
    if (Math.abs(av - bv) / denom > 0.15) return true;
  }
  return false;
}

function classifyQuality(
  tier: "a" | "b" | "c",
  httpOk: boolean,
  httpStatus: number | null,
  item: ParsedDims,
  pkg: ParsedDims,
): { quality: QualityClass; reason: string } {
  if (tier === "c") return { quality: "missing", reason: "sku_only_no_asin" };
  if (tier === "b") return { quality: "missing", reason: "fnsku_only_no_asin" };
  if (!httpOk) {
    if (httpStatus === 404) return { quality: "missing", reason: "catalog_404" };
    return { quality: "unsafe", reason: `catalog_http_${httpStatus ?? 0}` };
  }
  const itemFull = hasFullLwh(item);
  const pkgFull = hasFullLwh(pkg);
  if (!itemFull && !pkgFull && !hasPartialLwh(item) && !hasPartialLwh(pkg)) {
    return { quality: "missing", reason: "no_dimensions_in_catalog_response" };
  }
  if (itemFull && pkgFull && dimsConflict(item, pkg)) {
    return { quality: "conflict", reason: "item_vs_package_lwh_mismatch" };
  }
  if (itemFull || pkgFull) {
    return { quality: "valid_dimensions", reason: itemFull ? "item_lwh_complete" : "package_lwh_complete" };
  }
  return { quality: "partial_dimensions", reason: "incomplete_lwh_set" };
}

function trimHost(h: string): string {
  return h.replace(/\/+$/, "");
}

function credsRecordToLwa(credentials: Record<string, unknown>): AmazonSpApiCredentials | null {
  const lwaClientId = String(credentials.lwa_client_id ?? credentials.lwaClientId ?? credentials.client_id ?? "").trim();
  const lwaClientSecret = String(
    credentials.lwa_client_secret ?? credentials.lwaClientSecret ?? credentials.client_secret ?? "",
  ).trim();
  const refreshToken = String(credentials.refresh_token ?? credentials.refreshToken ?? "").trim();
  if (!lwaClientId || !lwaClientSecret || !refreshToken) return null;
  return { lwaClientId, lwaClientSecret, refreshToken };
}

function marketplaceIdsFromCredentials(credentials: Record<string, unknown>): string[] {
  const single = String(credentials.marketplace_id ?? credentials.marketplaceId ?? "").trim();
  if (single) return [single];
  const multi = String(credentials.marketplace_ids ?? credentials.marketplaceIds ?? "").trim();
  if (multi) return multi.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
  return [DEFAULT_MARKETPLACE_ID];
}

function catalogHostFromCredentials(credentials: Record<string, unknown>): string {
  const ep = String(credentials.endpoint ?? credentials.sp_api_endpoint ?? "").trim();
  return trimHost(ep || DEFAULT_CATALOG_HOST);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchCatalogJson(
  catalogHost: string,
  accessToken: string,
  marketplaceIds: string[],
  asin: string,
): Promise<{ ok: true; body: unknown; attempts: number } | { ok: false; status: number; error: string; attempts: number }> {
  const base = trimHost(catalogHost);
  const mids = marketplaceIds.map((s) => s.trim()).filter(Boolean);
  if (!mids.length) return { ok: false, status: 0, error: "No marketplace ids", attempts: 0 };
  const qp = new URLSearchParams({
    marketplaceIds: mids.join(","),
    includedData: "dimensions,attributes,summaries",
  });
  const url = `${base}/catalog/2022-04-01/items/${encodeURIComponent(asin)}?${qp}`;
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(url, {
      headers: { "x-amz-access-token": accessToken, "Content-Type": "application/json" },
      method: "GET",
      cache: "no-store",
    });
    const text = await res.text();
    if (res.ok) {
      try {
        return { ok: true, body: JSON.parse(text) as unknown, attempts: attempt + 1 };
      } catch {
        return { ok: false, status: res.status, error: "catalog_json_parse_failed", attempts: attempt + 1 };
      }
    }
    if (res.status === 429 || res.status === 503) {
      await sleep(500 * (attempt + 1));
      continue;
    }
    return { ok: false, status: res.status, error: `catalog_http_${res.status}: ${text.slice(0, 200)}`, attempts: attempt + 1 };
  }
  return { ok: false, status: 0, error: "catalog_max_retries", attempts: 5 };
}

async function resolveAmazonCatalogContextPg(
  client: pg.Client,
  organizationId: string,
  storeId: string,
): Promise<
  | { ok: true; credentials: AmazonSpApiCredentials; marketplaceIds: string[]; catalogHost: string }
  | { ok: false; error: string }
> {
  const storeRes = await client.query(
    `SELECT s.marketplace_id::text, m.provider, m.credentials
     FROM public.stores s
     LEFT JOIN public.marketplaces m ON m.id = s.marketplace_id
     WHERE s.id = $1::uuid AND s.organization_id = $2::uuid`,
    [storeId, organizationId],
  );
  const store = storeRes.rows[0] as { provider?: string; credentials?: unknown } | undefined;
  if (!store) return { ok: false, error: "Store not found" };

  if (store.credentials && typeof store.credentials === "object" && store.provider === "amazon_sp_api") {
    const credObj = store.credentials as Record<string, unknown>;
    if (amazonSpCredentialsLookComplete(credObj)) {
      const lwa = credsRecordToLwa(credObj);
      if (lwa) {
        const valid = filterValidAmazonRetailMarketplaceIds(marketplaceIdsFromCredentials(credObj));
        return {
          ok: true,
          credentials: lwa,
          marketplaceIds: valid.length ? valid : [DEFAULT_MARKETPLACE_ID],
          catalogHost: catalogHostFromCredentials(credObj),
        };
      }
    }
  }

  const mpRes = await client.query(
    `SELECT credentials FROM public.marketplaces
     WHERE organization_id = $1::uuid AND provider = 'amazon_sp_api'`,
    [organizationId],
  );
  for (const row of mpRes.rows) {
    const credObj = (row as { credentials?: unknown }).credentials;
    if (!credObj || typeof credObj !== "object") continue;
    const c = credObj as Record<string, unknown>;
    if (!amazonSpCredentialsLookComplete(c)) continue;
    const lwa = credsRecordToLwa(c);
    if (lwa) {
      const valid = filterValidAmazonRetailMarketplaceIds(marketplaceIdsFromCredentials(c));
      return {
        ok: true,
        credentials: lwa,
        marketplaceIds: valid.length ? valid : [DEFAULT_MARKETPLACE_ID],
        catalogHost: catalogHostFromCredentials(c),
      };
    }
  }
  return { ok: false, error: "Amazon SP-API credentials not configured" };
}

async function packagingSnapshot(client: pg.Client): Promise<Record<string, number>> {
  const r = await client.query(
    `SELECT
       (SELECT count(*)::int FROM public.product_packaging_profiles) AS profiles,
       (SELECT count(*)::int FROM public.product_packaging_profile_versions) AS versions,
       (SELECT count(*)::int FROM public.product_packaging_dimensions_current) AS dimensions_current,
       (SELECT count(*)::int FROM public.products) AS products`,
  );
  return r.rows[0] as Record<string, number>;
}

async function main(): Promise<void> {
  const runId = runIdArg();
  const planRunId = planRunIdArg();
  const apply = process.argv.includes("--apply");
  const apiLimit = apiLimitArg();
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  const cacheDir = path.join(outDir, "catalog-evidence");
  fs.mkdirSync(cacheDir, { recursive: true });

  loadEnvLocalIntoProcess();
  const branch = execSync("git branch --show-current", { encoding: "utf8" }).trim();
  const approval = readApproval();
  const spApiEnabled = envFlag("AMAZON_SP_API_ENABLED");
  const evidenceOnly = envFlag("PRODUCT_ENRICHMENT_EVIDENCE_ONLY_ENABLED");
  const autoCreateOff = !envFlag("PRODUCT_ENRICHMENT_AUTO_CREATE_ENABLED");
  const stagingUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ?? "";
  const stagingOk = supabaseUrlMatchesStagingRef(stagingUrl, STAGING_REF);
  const stagingRef = getStagingProjectRef({ loadEnv: false });

  const planDir = path.join(process.cwd(), PLAN_BASE, planRunId);
  const manifestPath = path.join(planDir, "manifest.json");
  const csvPath = path.join(
    process.cwd(),
    ".cursor/audit-reports/pc05-manual-review-queue-plan/20260526T220000Z/sp-api-dimensions-evidence-candidates.csv",
  );

  const blockers: string[] = [];
  if (branch !== REQUIRED_BRANCH) blockers.push(`Branch must be ${REQUIRED_BRANCH}`);
  if (!approval.valid) blockers.push("Approval flags not both true");
  if (!apply) blockers.push("Pass --apply to run catalog GET");
  if (!spApiEnabled) blockers.push("AMAZON_SP_API_ENABLED must be true for execute window");
  if (!evidenceOnly) blockers.push("PRODUCT_ENRICHMENT_EVIDENCE_ONLY_ENABLED must be true");
  if (!autoCreateOff) blockers.push("PRODUCT_ENRICHMENT_AUTO_CREATE_ENABLED must be false");
  if (!stagingOk || stagingRef !== STAGING_REF) blockers.push(`Staging ref guard failed (${stagingRef})`);
  if (!fs.existsSync(manifestPath)) blockers.push(`Missing plan: ${planRunId}`);
  if (!fs.existsSync(csvPath)) blockers.push(`Missing candidates CSV`);

  const candidates = fs.existsSync(csvPath) ? await loadCandidates(csvPath) : [];
  const evidenceRows: EvidenceRow[] = [];

  let apiCallCount = 0;
  let beforeSnap: Record<string, number> = {};
  let afterSnap: Record<string, number> = {};

  if (blockers.length === 0) {
    const dbUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() || "";
    const originalUrl = process.env.ORIGINAL_DIRECT_POSTGRES_URL?.trim() || "";
    if (originalUrl && dbUrl === originalUrl) blockers.push("Must not use original URL as staging");
    if (!dbUrl) blockers.push("Missing STAGING_DIRECT_POSTGRES_URL");

    if (blockers.length === 0) {
      const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
      await client.connect();
      beforeSnap = await packagingSnapshot(client);

      const ctx = await resolveAmazonCatalogContextPg(client, ORG, STORE);
      if (!ctx.ok) {
        blockers.push(ctx.error);
      } else {
        let accessToken: string;
        try {
          accessToken = (await getAmazonAccessToken(ctx.credentials)).accessToken;
        } catch (e) {
          blockers.push(e instanceof Error ? e.message : "token_failed");
          accessToken = "";
        }

        if (accessToken) {
          const asinJobs = new Map<string, CandidateRow[]>();
          for (const c of candidates) {
            const tier = identifierTier(c.sku);
            const asin = parseAsinFromSku(c.sku);
            if (tier !== "a" || !asin) {
              const q = classifyQuality(tier, false, null, emptyDims(), emptyDims());
              evidenceRows.push({
                candidate_id: c.candidate_id,
                product_id: c.product_id,
                sku: c.sku,
                identifier_tier: tier,
                asin: null,
                api_called: false,
                http_ok: false,
                http_status: null,
                attempts: 0,
                error: null,
                quality: q.quality,
                quality_reason: q.reason,
                item_dimensions: null,
                package_dimensions: null,
              });
              continue;
            }
            const list = asinJobs.get(asin) ?? [];
            list.push(c);
            asinJobs.set(asin, list);
          }

          const asins = [...asinJobs.keys()].sort();
          const asinsToCall = asins.slice(0, apiLimit);
          const asinSet = new Set(asinsToCall);

          const catalogByAsin = new Map<string, { http_ok: boolean; status: number; body?: unknown; error?: string; attempts: number }>();

          for (let i = 0; i < asinsToCall.length; i++) {
            const asin = asinsToCall[i]!;
            const cat = await fetchCatalogJson(ctx.catalogHost, accessToken, ctx.marketplaceIds, asin);
            apiCallCount++;
            if (cat.ok) {
              catalogByAsin.set(asin, { http_ok: true, status: 200, body: cat.body, attempts: cat.attempts });
              fs.writeFileSync(path.join(cacheDir, `${asin}.json`), JSON.stringify(cat.body, null, 2));
            } else {
              catalogByAsin.set(asin, {
                http_ok: false,
                status: cat.status,
                error: cat.error,
                attempts: cat.attempts,
              });
            }
            if (i + 1 < asinsToCall.length) await sleep(DELAY_MS);
          }

          const marketplaceId = ctx.marketplaceIds[0] ?? DEFAULT_MARKETPLACE_ID;

          for (const c of candidates) {
            const tier = identifierTier(c.sku);
            const asin = parseAsinFromSku(c.sku);
            if (tier !== "a" || !asin) {
              if (evidenceRows.some((e) => e.candidate_id === c.candidate_id)) continue;
              const q = classifyQuality(tier, false, null, emptyDims(), emptyDims());
              evidenceRows.push({
                candidate_id: c.candidate_id,
                product_id: c.product_id,
                sku: c.sku,
                identifier_tier: tier,
                asin: null,
                api_called: false,
                http_ok: false,
                http_status: null,
                attempts: 0,
                error: null,
                quality: q.quality,
                quality_reason: q.reason,
                item_dimensions: null,
                package_dimensions: null,
              });
              continue;
            }

            const called = asinSet.has(asin);
            const cat = catalogByAsin.get(asin);
            if (!called) {
              evidenceRows.push({
                candidate_id: c.candidate_id,
                product_id: c.product_id,
                sku: c.sku,
                identifier_tier: "a",
                asin,
                api_called: false,
                http_ok: false,
                http_status: null,
                attempts: 0,
                error: "api_limit_not_reached",
                quality: "missing",
                quality_reason: "tier_a_deferred_api_limit",
                item_dimensions: null,
                package_dimensions: null,
              });
              continue;
            }

            const httpOk = cat?.http_ok ?? false;
            const status = cat?.status ?? null;
            const dims = httpOk && cat?.body ? extractCatalogDimensions(cat.body, marketplaceId) : { item: emptyDims(), package: emptyDims() };
            const q = classifyQuality("a", httpOk, status, dims.item, dims.package);
            evidenceRows.push({
              candidate_id: c.candidate_id,
              product_id: c.product_id,
              sku: c.sku,
              identifier_tier: "a",
              asin,
              api_called: true,
              http_ok: httpOk,
              http_status: status,
              attempts: cat?.attempts ?? 0,
              error: cat && !cat.http_ok ? cat.error ?? null : null,
              quality: q.quality,
              quality_reason: q.reason,
              item_dimensions: dims.item,
              package_dimensions: dims.package,
            });
          }
        }
      }

      afterSnap = await packagingSnapshot(client);
      await client.end();
    }
  }

  const qualityCounts: Record<QualityClass, number> = {
    valid_dimensions: 0,
    partial_dimensions: 0,
    missing: 0,
    conflict: 0,
    unsafe: 0,
  };
  for (const r of evidenceRows) qualityCounts[r.quality]++;

  const safeImport = evidenceRows.filter((r) => r.quality === "valid_dimensions");
  const conflicts = evidenceRows.filter((r) => r.quality === "conflict");
  const unsafe = evidenceRows.filter((r) => r.quality === "unsafe");

  const noWriteOk =
    beforeSnap.profiles === afterSnap.profiles &&
    beforeSnap.versions === afterSnap.versions &&
    beforeSnap.dimensions_current === afterSnap.dimensions_current &&
    beforeSnap.products === afterSnap.products;

  fs.writeFileSync(
    path.join(outDir, "api-response-summary.json"),
    JSON.stringify(
      {
        run_id: runId,
        plan_run_id: planRunId,
        branch,
        staging_ref: STAGING_REF,
        approval_valid: approval.valid,
        api_limit: apiLimit,
        api_calls_made: apiCallCount,
        candidates_total: candidates.length,
        evidence_rows: evidenceRows.length,
        quality_counts: qualityCounts,
        no_db_writes: noWriteOk,
        packaging_snapshot_before: beforeSnap,
        packaging_snapshot_after: afterSnap,
      },
      null,
      2,
    ),
  );

  fs.writeFileSync(
    path.join(outDir, "evidence-quality-report.md"),
    [
      "# Evidence quality report — SP-API packaging dimensions dry-run",
      "",
      `**Run:** \`${runId}\``,
      `**Plan:** \`${planRunId}\``,
      `**API calls:** ${apiCallCount} (limit ${apiLimit === 9999 ? "tier-A full" : apiLimit})`,
      "",
      "## Quality classification",
      "",
      "| Class | Count |",
      "|-------|------:|",
      `| valid_dimensions | ${qualityCounts.valid_dimensions} |`,
      `| partial_dimensions | ${qualityCounts.partial_dimensions} |`,
      `| missing | ${qualityCounts.missing} |`,
      `| conflict | ${qualityCounts.conflict} |`,
      `| unsafe | ${qualityCounts.unsafe} |`,
      "",
      "## No-write proof",
      "",
      `| Table | Before | After |`,
      "|-------|-------:|------:|",
      `| product_packaging_profiles | ${beforeSnap.profiles ?? "?"} | ${afterSnap.profiles ?? "?"} |`,
      `| product_packaging_dimensions_current | ${beforeSnap.dimensions_current ?? "?"} | ${afterSnap.dimensions_current ?? "?"} |`,
      `| products | ${beforeSnap.products ?? "?"} | ${afterSnap.products ?? "?"} |`,
      "",
      `**No DB writes:** ${noWriteOk ? "**YES**" : "**NO**"}`,
    ].join("\n"),
  );

  fs.writeFileSync(path.join(outDir, "safe-import-candidates.json"), JSON.stringify(safeImport, null, 2));
  fs.writeFileSync(path.join(outDir, "conflict-candidates.json"), JSON.stringify(conflicts, null, 2));
  fs.writeFileSync(path.join(outDir, "unsafe-candidates.json"), JSON.stringify(unsafe, null, 2));

  fs.writeFileSync(
    path.join(outDir, "no-write-proof.md"),
    [
      "# No-write proof",
      "",
      "- Catalog GET only; JSON cached under `catalog-evidence/`",
      "- No `product_packaging_*` INSERT/UPDATE",
      "- No `products` UPDATE",
      "- No `product_identifier_map` INSERT",
      "- Script: `scripts/sp-api-packaging-dimensions-evidence-dry-run-execute.ts`",
    ].join("\n"),
  );

  fs.writeFileSync(path.join(outDir, "blockers.md"), blockers.length ? blockers.map((b) => `- ${b}`).join("\n") : "None.");

  const ok = blockers.length === 0 && noWriteOk && evidenceRows.length === candidates.length;
  fs.writeFileSync(
    path.join(outDir, "manifest.json"),
    JSON.stringify(
      {
        prompt: "SP-API DIMENSIONS EVIDENCE DRY RUN EXECUTE",
        run_id: runId,
        plan_run_id: planRunId,
        ok,
        quality_counts: qualityCounts,
        api_calls_made: apiCallCount,
        no_db_writes: noWriteOk,
      },
      null,
      2,
    ),
  );

  console.log(
    JSON.stringify(
      {
        ok,
        outDir,
        api_calls_made: apiCallCount,
        quality_counts: qualityCounts,
        safe_import: safeImport.length,
        conflicts: conflicts.length,
        unsafe: unsafe.length,
        no_db_writes: noWriteOk,
        blockers,
      },
      null,
      2,
    ),
  );
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
