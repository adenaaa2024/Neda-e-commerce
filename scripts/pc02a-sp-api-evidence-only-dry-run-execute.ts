/**
 * PC02A — SP-API EVIDENCE-ONLY DRY-RUN EXECUTE
 *
 * Governed catalog GET for PC02 cohort (5 expected_packages / 3 ASINs).
 * No products.insert, no map insert, no expected_packages update.
 *
 *   npx tsx scripts/pc02a-sp-api-evidence-only-dry-run-execute.ts --run-id=<id>
 *   npx tsx scripts/pc02a-sp-api-evidence-only-dry-run-execute.ts --dry-run-id=20260522T210000Z
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import pg from "pg";

import { getAmazonAccessToken, type AmazonSpApiCredentials } from "../lib/amazon/sp-api";
import { extractBestMainImageFromCatalogItem } from "../lib/amazon-catalog-image-extract";
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
const PC02_APPROVAL = ".cursor/operator-approvals/sp-api-product-evidence-dry-run-pc02-approval.md";
const V202_DRY_BASE = ".cursor/audit-reports/expected-packages-amazon-api-evidence-dry-run-v202";
const OUT_BASE = ".cursor/audit-reports/pc02a-sp-api-evidence-only-dry-run-execute";
const DELAY_MS = 400;
const COHORT_ASINS = ["B0CQKPKKCM", "B0CS88T6FR", "B0DMQCZPQN"] as const;

type CohortRow = {
  expected_package_id: string;
  organization_id: string;
  store_id: string;
  asin: string;
  sku: string | null;
  fnsku: string | null;
};

type AsinJob = {
  asin: string;
  organization_id: string;
  store_id: string;
  sku: string | null;
  fnsku: string | null;
  expected_package_ids: string[];
};

function runId(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function dryRunId(): string {
  const a = process.argv.find((x) => x.startsWith("--dry-run-id="));
  return a ? a.split("=")[1]!.trim() : "20260522T210000Z";
}

function envFlag(name: string): boolean {
  const v = process.env[name]?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

function readPc02Approval(): { valid: boolean; runStaging: boolean; evidenceDryRun: boolean } {
  const p = path.join(process.cwd(), PC02_APPROVAL);
  if (!fs.existsSync(p)) return { valid: false, runStaging: false, evidenceDryRun: false };
  const text = fs.readFileSync(p, "utf8");
  const runStaging = /APPROVED_TO_RUN_STAGING\s*=\s*true/i.test(text);
  const evidenceDryRun = /APPROVED_SP_API_EVIDENCE_DRY_RUN\s*=\s*true/i.test(text);
  return { valid: runStaging && evidenceDryRun, runStaging, evidenceDryRun };
}

function currentBranch(): string {
  try {
    return execSync("git branch --show-current", { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

const DEFAULT_CATALOG_HOST = "https://sellingpartnerapi-na.amazon.com";
const DEFAULT_MARKETPLACE_ID = "ATVPDKIKX0DER";

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

function extractCatalogMainImageAndText(item: unknown): {
  main_image_url: string | null;
  product_name: string | null;
  brand: string | null;
} {
  if (!item || typeof item !== "object" || Array.isArray(item)) {
    return { main_image_url: null, product_name: null, brand: null };
  }
  const root = item as Record<string, unknown>;
  const summaries = root.summaries;
  let product_name: string | null = null;
  let brand: string | null = null;
  if (Array.isArray(summaries) && summaries[0] && typeof summaries[0] === "object") {
    const s0 = summaries[0] as Record<string, unknown>;
    const n = s0.itemName ?? s0.item_name;
    const b = s0.brand;
    if (typeof n === "string" && n.trim()) product_name = n.trim();
    if (typeof b === "string" && b.trim()) brand = b.trim();
  }
  const { bestUrl: main_image_url } = extractBestMainImageFromCatalogItem(item);
  return { main_image_url, product_name, brand };
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
    includedData: "summaries,attributes,images,productTypes,salesRanks",
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

function loadJobsFromV202DryRun(dryRunIdArg: string): AsinJob[] | null {
  const linesPath = path.join(process.cwd(), V202_DRY_BASE, dryRunIdArg, "dry-run-lines.json");
  const cohortPath = path.join(process.cwd(), V202_DRY_BASE, dryRunIdArg, "api-evidence-cohort.json");
  if (!fs.existsSync(linesPath) || !fs.existsSync(cohortPath)) return null;

  const lines = JSON.parse(fs.readFileSync(linesPath, "utf8")) as Array<{
    asin: string;
    would_execute: string;
  }>;
  const cohort = JSON.parse(fs.readFileSync(cohortPath, "utf8")) as { rows: CohortRow[] };
  const callAsins = new Set(
    lines.filter((l) => l.would_execute === "WOULD_CALL_API").map((l) => l.asin.trim().toUpperCase()),
  );
  const rows = (cohort.rows ?? []).filter((r) => callAsins.has(r.asin.trim().toUpperCase()));
  if (!rows.length) return null;

  const map = new Map<string, AsinJob>();
  for (const r of rows) {
    const asin = r.asin.trim().toUpperCase();
    const key = `${r.organization_id}|${r.store_id}|${asin}`;
    const ex = map.get(key);
    if (!ex) {
      map.set(key, {
        asin,
        organization_id: r.organization_id,
        store_id: r.store_id,
        sku: r.sku?.trim() || null,
        fnsku: r.fnsku?.trim() || null,
        expected_package_ids: [r.expected_package_id],
      });
    } else {
      ex.expected_package_ids.push(r.expected_package_id);
    }
  }
  return [...map.values()].sort((a, b) => a.asin.localeCompare(b.asin));
}

async function loadCohortFromStaging(client: pg.Client): Promise<{ rows: CohortRow[]; jobs: AsinJob[] }> {
  const r = await client.query(
    `
    SELECT id::text AS expected_package_id,
           organization_id::text,
           store_id::text,
           UPPER(TRIM(asin)) AS asin,
           NULLIF(TRIM(sku), '') AS sku,
           NULLIF(TRIM(fnsku), '') AS fnsku
    FROM public.expected_packages
    WHERE organization_id = $1::uuid
      AND store_id = $2::uuid
      AND UPPER(TRIM(asin)) = ANY($3::text[])
    ORDER BY asin, id
  `,
    [ORG, STORE, COHORT_ASINS],
  );
  const rows = r.rows as CohortRow[];
  const map = new Map<string, AsinJob>();
  for (const row of rows) {
    const asin = row.asin.trim().toUpperCase();
    const key = `${row.organization_id}|${row.store_id}|${asin}`;
    const ex = map.get(key);
    if (!ex) {
      map.set(key, {
        asin,
        organization_id: row.organization_id,
        store_id: row.store_id,
        sku: row.sku,
        fnsku: row.fnsku,
        expected_package_ids: [row.expected_package_id],
      });
    } else {
      ex.expected_package_ids.push(row.expected_package_id);
    }
  }
  return { rows, jobs: [...map.values()].sort((a, b) => a.asin.localeCompare(b.asin)) };
}

type WriteSnapshot = {
  products_total: number;
  map_total: number;
  cohort_ep_count: number;
  cohort_ep_max_updated_at: string | null;
};

async function writeSnapshot(client: pg.Client, epIds: string[]): Promise<WriteSnapshot> {
  const [p, m, ep] = await Promise.all([
    client.query(`SELECT COUNT(*)::int AS c FROM public.products WHERE organization_id = $1::uuid`, [ORG]),
    client.query(`SELECT COUNT(*)::int AS c FROM public.product_identifier_map WHERE organization_id = $1::uuid`, [ORG]),
    epIds.length
      ? client.query(
          `SELECT COUNT(*)::int AS c, MAX(updated_at)::text AS max_u FROM public.expected_packages WHERE id = ANY($1::uuid[])`,
          [epIds],
        )
      : Promise.resolve({ rows: [{ c: 0, max_u: null }] }),
  ]);
  return {
    products_total: (p.rows[0] as { c: number }).c,
    map_total: (m.rows[0] as { c: number }).c,
    cohort_ep_count: (ep.rows[0] as { c: number }).c,
    cohort_ep_max_updated_at: (ep.rows[0] as { max_u: string | null }).max_u,
  };
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const id = runId();
  const outDir = path.join(process.cwd(), OUT_BASE, id);
  fs.mkdirSync(outDir, { recursive: true });

  const branch = currentBranch();
  const approval = readPc02Approval();
  const spApiEnabled = envFlag("AMAZON_SP_API_ENABLED");
  const stagingUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ?? "";
  const stagingOk = supabaseUrlMatchesStagingRef(stagingUrl, STAGING_REF);
  const stagingRef = getStagingProjectRef({ loadEnv: false });
  const originalUrl = process.env.ORIGINAL_SUPABASE_URL?.trim() ?? "";
  const originalTargeted = refFromSupabaseUrl(stagingUrl) === ORIGINAL_REF || stagingRef === ORIGINAL_REF;

  const blockers: string[] = [];
  if (branch !== "feature/product-canonicalization-v2") blockers.push(`branch=${branch} (expected feature/product-canonicalization-v2)`);
  if (!approval.valid) blockers.push(`approval invalid (runStaging=${approval.runStaging}, evidenceDryRun=${approval.evidenceDryRun})`);
  if (!spApiEnabled) blockers.push("AMAZON_SP_API_ENABLED not true");
  if (!stagingOk || stagingRef !== STAGING_REF) blockers.push(`staging ref guard failed (${stagingRef})`);
  if (originalTargeted) blockers.push("original project ref targeted — forbidden");

  fs.writeFileSync(
    path.join(outDir, "approval-proof.md"),
    [
      "# Approval proof — PC02A",
      "",
      "| Check | Result |",
      "|-------|--------|",
      `| Branch | \`${branch}\` |`,
      `| APPROVED_TO_RUN_STAGING | **${approval.runStaging}** |`,
      `| APPROVED_SP_API_EVIDENCE_DRY_RUN | **${approval.evidenceDryRun}** |`,
      `| Approval valid | **${approval.valid ? "yes" : "no"}** |`,
      `| Staging ref | \`${stagingRef}\` |`,
      `| Original ref blocked | \`${ORIGINAL_REF}\` not targeted |`,
      `| AMAZON_SP_API_ENABLED | ${spApiEnabled} |`,
    ].join("\n"),
  );

  if (blockers.length) {
    fs.writeFileSync(path.join(outDir, "blockers.md"), ["# Blockers", "", ...blockers.map((b) => `- ${b}`)].join("\n"));
    fs.writeFileSync(
      path.join(outDir, "manifest.json"),
      JSON.stringify({ prompt: "PC02A", run_id: id, status: "BLOCKED", blockers, approval_valid: approval.valid }, null, 2),
    );
    throw new Error(blockers.join("; "));
  }

  const dbUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() || "";
  const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();
  await client.query(`SET statement_timeout = '120s'`);

  const dryId = dryRunId();
  let cohortRows: CohortRow[];
  let jobs: AsinJob[];
  const fromV202 = loadJobsFromV202DryRun(dryId);
  if (fromV202?.length) {
    jobs = fromV202;
    const cohortPath = path.join(process.cwd(), V202_DRY_BASE, dryId, "api-evidence-cohort.json");
    cohortRows = (JSON.parse(fs.readFileSync(cohortPath, "utf8")) as { rows: CohortRow[] }).rows;
  } else {
    const loaded = await loadCohortFromStaging(client);
    cohortRows = loaded.rows;
    jobs = loaded.jobs;
  }

  const epIds = [...new Set(cohortRows.map((r) => r.expected_package_id))];
  const beforeSnap = await writeSnapshot(client, epIds);

  fs.writeFileSync(
    path.join(outDir, "candidate-cohort.md"),
    [
      "# Candidate cohort — PC02A",
      "",
      `**Source:** ${fromV202 ? `V202 dry-run \`${dryId}\`` : "staging expected_packages query"}`,
      "",
      `| Metric | Value |`,
      `|--------|-------|`,
      `| expected_packages rows | **${cohortRows.length}** |`,
      `| distinct ASINs | **${jobs.length}** |`,
      `| organization_id | \`${ORG}\` |`,
      `| store_id | \`${STORE}\` |`,
      "",
      "## ASINs",
      "",
      ...jobs.map(
        (j) =>
          `- \`${j.asin}\` — ${j.expected_package_ids.length} expected_package row(s): ${j.expected_package_ids.map((x) => `\`${x}\``).join(", ")}`,
      ),
      "",
      "## Row detail",
      "",
      "| expected_package_id | asin | sku | fnsku |",
      "|---------------------|------|-----|-------|",
      ...cohortRows.map(
        (r) => `| \`${r.expected_package_id}\` | \`${r.asin}\` | ${r.sku ?? "—"} | ${r.fnsku ?? "—"} |`,
      ),
    ].join("\n"),
  );

  fs.writeFileSync(
    path.join(outDir, "api-call-plan.md"),
    [
      "# API call plan — PC02A evidence-only",
      "",
      "**Mode:** evidence-only (catalog GET). No DB writes.",
      "",
      "| # | ASIN | endpoint | marketplace_ids | expected_package_ids |",
      "|---|------|----------|-----------------|----------------------|",
      ...jobs.map(
        (j, i) =>
          `| ${i + 1} | \`${j.asin}\` | \`GET /catalog/2022-04-01/items/{asin}\` | ATVPDKIKX0DER | ${j.expected_package_ids.length} |`,
      ),
      "",
      `**Total API calls planned:** ${jobs.length}`,
      "",
      "**Forbidden:** products.insert, product_identifier_map.insert, expected_packages UPDATE, return_items/slip_contents UPDATE.",
    ].join("\n"),
  );

  const ctx = await resolveAmazonCatalogContextPg(client, ORG, STORE);
  if (!ctx.ok) {
    fs.writeFileSync(path.join(outDir, "blockers.md"), `# Blockers\n\n- ${ctx.error}\n`);
    await client.end();
    throw new Error(ctx.error);
  }

  let accessToken: string;
  try {
    accessToken = (await getAmazonAccessToken(ctx.credentials)).accessToken;
  } catch (e) {
    const msg = e instanceof Error ? e.message : "token_failed";
    fs.writeFileSync(path.join(outDir, "blockers.md"), `# Blockers\n\n- token: ${msg}\n`);
    await client.end();
    throw new Error(msg);
  }

  const evidenceResults: Record<string, unknown>[] = [];
  let apiCallCount = 0;
  let evidenceFoundCount = 0;

  for (let i = 0; i < jobs.length; i++) {
    const job = jobs[i]!;
    const cat = await fetchCatalogJson(ctx.catalogHost, accessToken, ctx.marketplaceIds, job.asin);
    apiCallCount += 1;
    const extracted = cat.ok ? extractCatalogMainImageAndText(cat.body) : null;
    const row = {
      asin: job.asin,
      expected_package_ids: job.expected_package_ids,
      http_ok: cat.ok,
      http_status: cat.ok ? 200 : cat.status,
      attempts: cat.attempts,
      error: cat.ok ? null : cat.error,
      product_name: extracted?.product_name ?? null,
      main_image_url: extracted?.main_image_url ?? null,
      brand: extracted?.brand ?? null,
      evidence_found: cat.ok && !!extracted?.product_name,
      product_created: false,
      map_inserted: false,
      expected_packages_updated: false,
    };
    evidenceResults.push(row);
    if (row.evidence_found) evidenceFoundCount += 1;
    if (i + 1 < jobs.length) await sleep(DELAY_MS);
  }

  const afterSnap = await writeSnapshot(client, epIds);
  await client.end();

  fs.writeFileSync(path.join(outDir, "evidence-results.json"), JSON.stringify(evidenceResults, null, 2));

  const noWrites =
    beforeSnap.products_total === afterSnap.products_total &&
    beforeSnap.map_total === afterSnap.map_total &&
    beforeSnap.cohort_ep_max_updated_at === afterSnap.cohort_ep_max_updated_at;

  fs.writeFileSync(
    path.join(outDir, "no-write-proof.md"),
    [
      "# No-write proof — PC02A",
      "",
      "| Table / check | Before | After | Delta |",
      "|---------------|--------|-------|-------|",
      `| products (org) | ${beforeSnap.products_total} | ${afterSnap.products_total} | ${afterSnap.products_total - beforeSnap.products_total} |`,
      `| product_identifier_map (org) | ${beforeSnap.map_total} | ${afterSnap.map_total} | ${afterSnap.map_total - beforeSnap.map_total} |`,
      `| cohort expected_packages max(updated_at) | ${beforeSnap.cohort_ep_max_updated_at ?? "null"} | ${afterSnap.cohort_ep_max_updated_at ?? "null"} | unchanged=${beforeSnap.cohort_ep_max_updated_at === afterSnap.cohort_ep_max_updated_at} |`,
      "",
      "| Write type | Count |",
      "|------------|-------|",
      "| product inserts | **0** |",
      "| map inserts | **0** |",
      "| expected_packages updates | **0** |",
      "",
      `**No-write verified:** ${noWrites ? "yes" : "no — investigate"}`,
      "",
      "Evidence persisted to filesystem only (`evidence-results.json`). No DB evidence cache table used.",
    ].join("\n"),
  );

  fs.writeFileSync(path.join(outDir, "blockers.md"), "# Blockers\n\nNone — execute completed.\n");

  const status =
    apiCallCount === jobs.length && noWrites
      ? evidenceFoundCount > 0
        ? "PASS"
        : "PASS_CATALOG_NOT_FOUND"
      : "FAIL";

  const manifest = {
    prompt: "PC02A-SP-API-EVIDENCE-ONLY-DRY-RUN-EXECUTE",
    run_id: id,
    branch,
    mode: "evidence_only",
    staging_ref: STAGING_REF,
    original_ref_blocked: ORIGINAL_REF,
    approval_valid: approval.valid,
    status,
    cohort_expected_packages_rows: cohortRows.length,
    distinct_asins: jobs.length,
    api_calls_made: apiCallCount,
    evidence_found_count: evidenceFoundCount,
    product_writes: 0,
    map_writes: 0,
    expected_packages_updates: 0,
    no_write_verified: noWrites,
    dry_run_id: dryId,
    forbidden: {
      product_create: false,
      map_insert: false,
      expected_packages_update: false,
      return_items_update: false,
      slip_contents_update: false,
      production: false,
      original: false,
      ai: false,
    },
  };

  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  console.log(JSON.stringify({ outDir, ...manifest }, null, 2));
  process.exit(status.startsWith("PASS") ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
