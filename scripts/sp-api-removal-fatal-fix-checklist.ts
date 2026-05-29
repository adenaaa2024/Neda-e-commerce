/**
 * SP-API REMOVAL FATAL FIX CHECKLIST — credential path diagnostic (read-only, no Amazon calls)
 *
 *   npx tsx scripts/sp-api-removal-fatal-fix-checklist.ts
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";

import { amazonSpCredentialsLookComplete } from "../lib/amazon-marketplace-credentials";
import { loadEnvLocalIntoProcess, supabaseUrlMatchesStagingRef } from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const ORG_ID = "00000000-0000-0000-0000-000000000001";
const STORE_ID = "509ee1f6-622c-46a5-8110-7b889ba46c2c";
const OUT_BASE = ".cursor/audit-reports/sp-api-removal-fatal-fix-checklist";

const PRODUCT_BUTTON_PATH =
  "PimCatalogHub → POST /api/dashboard/products/catalog/enrich-images → resolveAmazonCatalogContext (lib/pim-amazon-catalog-enrichment.ts)";
const REMOVAL_WORKER_PATH =
  "removal-order|shipment routes / execute script → runReportsApiPullWorker → resolveReportsApiContext (lib/amazon/reports-api-credentials.ts)";

type CredFinger = {
  source: string;
  marketplace_row_id: string | null;
  lwa_client_id_suffix: string | null;
  refresh_token_fp: string | null;
  marketplace_ids: string[];
  endpoint_host: string | null;
  has_aws_in_blob: boolean;
  aws_from_env: boolean;
  lwa_complete: boolean;
  reports_ready: boolean;
};

function runIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function n(v: unknown): string {
  return String(v ?? "").trim();
}

function fpSecret(v: string): string | null {
  if (!v) return null;
  return crypto.createHash("sha256").update(v).digest("hex").slice(0, 12);
}

function lwaSuffix(c: Record<string, unknown>): string | null {
  const id = n(c.lwa_client_id ?? c.lwaClientId ?? c.client_id);
  return id.length >= 6 ? id.slice(-6) : id || null;
}

function refreshFp(c: Record<string, unknown>): string | null {
  return fpSecret(n(c.refresh_token ?? c.refreshToken));
}

function marketplaceIdsFromCredentials(c: Record<string, unknown>): string[] {
  const single = n(c.marketplace_id ?? c.marketplaceId);
  if (single) return [single];
  const multi = n(c.marketplace_ids ?? c.marketplaceIds);
  if (!multi) return [];
  return multi.split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean);
}

function hasAwsInBlob(c: Record<string, unknown>): boolean {
  const accessKeyId = n(
    c.aws_access_key ?? c.aws_access_key_id ?? c.awsAccessKeyId ?? "",
  );
  const secretAccessKey = n(
    c.aws_secret_key ?? c.aws_secret_access_key ?? c.awsSecretAccessKey ?? "",
  );
  return !!(accessKeyId && secretAccessKey);
}

function awsFromEnv(): boolean {
  return !!(process.env.AWS_ACCESS_KEY_ID?.trim() && process.env.AWS_SECRET_ACCESS_KEY?.trim());
}

function endpointHost(c: Record<string, unknown>, kind: "catalog" | "reports"): string | null {
  const ep = n(c.endpoint ?? c.sp_api_endpoint ?? (kind === "reports" ? c.reports_endpoint : ""));
  if (!ep) return kind === "catalog" ? "sellingpartnerapi-na.amazon.com (default)" : "sellingpartnerapi-na.amazon.com (default)";
  return ep.replace(/^https?:\/\//, "").replace(/\/$/, "");
}

function fingerFromCred(
  source: string,
  credObj: Record<string, unknown>,
  marketplaceRowId: string | null,
): CredFinger {
  const awsBlob = hasAwsInBlob(credObj);
  const awsEnv = awsFromEnv();
  return {
    source,
    marketplace_row_id: marketplaceRowId,
    lwa_client_id_suffix: lwaSuffix(credObj),
    refresh_token_fp: refreshFp(credObj),
    marketplace_ids: marketplaceIdsFromCredentials(credObj),
    endpoint_host: endpointHost(credObj, "reports"),
    has_aws_in_blob: awsBlob,
    aws_from_env: awsEnv,
    lwa_complete: amazonSpCredentialsLookComplete(credObj),
    reports_ready: amazonSpCredentialsLookComplete(credObj) && (awsBlob || awsEnv),
  };
}

/** Mirrors resolveAmazonCatalogContext priority (no token fetch). */
function traceCatalogContext(
  storeMpRaw: string | null,
  storeMarketplace: { id: string; provider: string; credentials: unknown } | null,
  orgKeyJson: Record<string, unknown> | null,
  orgMarketplaces: Array<{ id: string; credentials: unknown }>,
): CredFinger | null {
  if (
    storeMarketplace?.credentials &&
    typeof storeMarketplace.credentials === "object" &&
    !Array.isArray(storeMarketplace.credentials)
  ) {
    const credObj = storeMarketplace.credentials as Record<string, unknown>;
    if (
      n(storeMarketplace.provider) === "amazon_sp_api" &&
      amazonSpCredentialsLookComplete(credObj)
    ) {
      return fingerFromCred("store_linked_marketplaces", credObj, storeMarketplace.id);
    }
  }

  if (orgKeyJson && typeof orgKeyJson === "object") {
    const credObj = orgKeyJson;
    if (amazonSpCredentialsLookComplete(credObj)) {
      return fingerFromCred("organization_api_keys.amazon_sp_api", credObj, null);
    }
  }

  for (const row of orgMarketplaces) {
    if (!row.credentials || typeof row.credentials !== "object" || Array.isArray(row.credentials)) {
      continue;
    }
    const credObj = row.credentials as Record<string, unknown>;
    if (amazonSpCredentialsLookComplete(credObj)) {
      return fingerFromCred("marketplaces_scan (org)", credObj, row.id);
    }
  }
  return null;
}

/** Mirrors resolveReportsApiContext priority (no token fetch). */
function traceReportsContext(
  storeMarketplace: { id: string; provider: string; credentials: unknown } | null,
  orgKeyJson: Record<string, unknown> | null,
  orgMarketplaces: Array<{ id: string; credentials: unknown }>,
): { selected: CredFinger | null; store_attempt: CredFinger | null; store_block_reason: string | null } {
  if (
    storeMarketplace?.credentials &&
    typeof storeMarketplace.credentials === "object" &&
    !Array.isArray(storeMarketplace.credentials)
  ) {
    const credObj = storeMarketplace.credentials as Record<string, unknown>;
    if (n(storeMarketplace.provider) === "amazon_sp_api") {
      const f = fingerFromCred("store_linked_marketplaces", credObj, storeMarketplace.id);
      if (f.reports_ready) return { selected: f, store_attempt: f, store_block_reason: null };
      return {
        selected: null,
        store_attempt: f,
        store_block_reason: !f.lwa_complete
          ? "store marketplace LWA incomplete — resolver returns error (no fallthrough)"
          : "store marketplace missing AWS keys in blob and env — resolver returns error (no fallthrough)",
      };
    }
  }

  if (orgKeyJson && typeof orgKeyJson === "object") {
    const f = fingerFromCred("organization_api_keys.amazon_sp_api", orgKeyJson, null);
    if (f.reports_ready) return { selected: f, store_attempt: null, store_block_reason: null };
    if (f.lwa_complete) {
      return {
        selected: null,
        store_attempt: null,
        store_block_reason: "org_api_keys LWA ok but AWS missing — resolver returns error",
      };
    }
  }

  for (const row of orgMarketplaces) {
    if (!row.credentials || typeof row.credentials !== "object" || Array.isArray(row.credentials)) {
      continue;
    }
    const f = fingerFromCred("marketplaces_scan (org)", row.credentials as Record<string, unknown>, row.id);
    if (f.reports_ready) return { selected: f, store_attempt: null, store_block_reason: null };
  }

  return { selected: null, store_attempt: null, store_block_reason: "no reports-ready credential source" };
}

function sameSource(a: CredFinger | null, b: CredFinger | null): boolean {
  if (!a || !b) return false;
  return (
    a.source === b.source &&
    a.marketplace_row_id === b.marketplace_row_id &&
    a.refresh_token_fp === b.refresh_token_fp &&
    a.lwa_client_id_suffix === b.lwa_client_id_suffix
  );
}

async function main(): Promise<void> {
  const runId = runIdArg();
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  loadEnvLocalIntoProcess();
  const dbUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ?? "";
  if (!dbUrl || !supabaseUrlMatchesStagingRef(dbUrl, STAGING_REF)) {
    throw new Error(`STAGING_DIRECT_POSTGRES_URL must target ${STAGING_REF}`);
  }

  const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();

  const storeRes = await client.query(
    `SELECT s.id::text, s.name, s.platform, s.marketplace_id::text AS store_marketplace_id,
            m.id::text AS marketplace_row_id, m.provider, m.credentials
     FROM public.stores s
     LEFT JOIN public.marketplaces m ON m.id = s.marketplace_id
     WHERE s.id = $1::uuid AND s.organization_id = $2::uuid`,
    [STORE_ID, ORG_ID],
  );
  const store = storeRes.rows[0] as Record<string, unknown>;
  const storeMpRaw = n(store.store_marketplace_id) || null;

  const storeMarketplace =
    store.marketplace_row_id && store.credentials
      ? {
          id: String(store.marketplace_row_id),
          provider: String(store.provider ?? ""),
          credentials: store.credentials,
        }
      : null;

  const keyRes = await client.query(
    `SELECT api_key FROM public.organization_api_keys
     WHERE organization_id = $1::uuid AND name = 'amazon_sp_api' LIMIT 1`,
    [ORG_ID],
  );
  let orgKeyJson: Record<string, unknown> | null = null;
  const rawKey = (keyRes.rows[0] as { api_key?: string } | undefined)?.api_key;
  if (rawKey?.trim()) {
    try {
      const parsed = JSON.parse(rawKey) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        orgKeyJson = parsed as Record<string, unknown>;
      }
    } catch {
      orgKeyJson = null;
    }
  }

  const mpRes = await client.query(
    `SELECT id::text, provider, credentials FROM public.marketplaces
     WHERE organization_id = $1::uuid AND provider = 'amazon_sp_api' ORDER BY id LIMIT 5`,
    [ORG_ID],
  );
  const orgMarketplaces = mpRes.rows.map((r) => ({
    id: String((r as { id: string }).id),
    credentials: (r as { credentials: unknown }).credentials,
  }));

  await client.end();

  const catalog = traceCatalogContext(storeMpRaw, storeMarketplace, orgKeyJson, orgMarketplaces);
  const reportsTrace = traceReportsContext(storeMarketplace, orgKeyJson, orgMarketplaces);
  const reports = reportsTrace.selected;

  const same = sameSource(catalog, reports);

  const storeFinger = storeMarketplace?.credentials
    ? fingerFromCred("store_linked_marketplaces (audit)", storeMarketplace.credentials as Record<string, unknown>, storeMarketplace.id)
    : null;

  const likelyFixes: string[] = [];
  if (!same && catalog && reports) {
    likelyFixes.push(
      "Credential source mismatch: align removal worker with catalog resolver or consolidate to store-linked marketplaces row.",
    );
  } else if (
    storeFinger &&
    catalog?.source === "store_linked_marketplaces" &&
    reports?.source !== "store_linked_marketplaces"
  ) {
    likelyFixes.push(
      "Product API uses store-linked marketplace LWA; Reports resolver did not select store row — check provider=amazon_sp_api and AWS keys on marketplaces.credentials.",
    );
  }
  if (!likelyFixes.length) {
    likelyFixes.push(
      "Same credential source — FATAL is likely Developer Central role (FBA Reports / Inventory Reports), seller/token mismatch vs removal data seller, or report window/type unavailable. Human checklist items 1–3 remain primary.",
    );
  }

  const retryCommand =
    "npx tsx scripts/sp-api-removal-reports-fetch-retry-diagnostic.ts --probe --retry-run --window-start=2025-12-26 --window-end=2026-04-21";

  fs.writeFileSync(
    path.join(outDir, "credential-comparison.json"),
    JSON.stringify(
      {
        org_id: ORG_ID,
        store_id: STORE_ID,
        store_name: store.name,
        store_marketplace_id: storeMpRaw,
        product_button_path: PRODUCT_BUTTON_PATH,
        removal_worker_path: REMOVAL_WORKER_PATH,
        product_button_credential_source: catalog?.source ?? "none",
        removal_worker_credential_source: reports?.source ?? "none",
        same_credential_source: same,
        store_marketplace_skip_reason: reportsTrace.store_block_reason,
        store_marketplace_attempt: reportsTrace.store_attempt,
        product_button_fingerprint: catalog,
        removal_worker_fingerprint: reports,
        store_marketplace_fingerprint: storeFinger,
        org_api_key_present: !!orgKeyJson,
        org_marketplace_rows: orgMarketplaces.length,
        aws_env_present: awsFromEnv(),
      },
      null,
      2,
    ),
  );

  fs.writeFileSync(
    path.join(outDir, "human-checklist.md"),
    [
      "# SP-API removal FATAL — human checklist",
      "",
      "## Developer Central (Seller Central → Apps & Services → Develop Apps)",
      "",
      "- [ ] App registered with **Reports API** role",
      "- [ ] **FBA** / **Inventory** / **Fulfillment by Amazon** report permissions enabled",
      "- [ ] App authorized for **Sam AM** seller account that owns removal CSV data",
      "- [ ] Refresh token re-authorized after role changes",
      "",
      "## Credential alignment",
      "",
      `- Store marketplace id: \`${storeMpRaw ?? "null"}\``,
      `- Product button source: **${catalog?.source ?? "none"}**`,
      `- Removal worker source: **${reports?.source ?? "none"}**`,
      `- Same source: **${same ? "yes" : "no"}**`,
      reportsTrace.store_block_reason
        ? `- Store row block reason (reports): ${reportsTrace.store_block_reason}`
        : "",
      "",
      "## Marketplace",
      "",
      "- [ ] US marketplace `ATVPDKIKX0DER` on credential row and createReport body",
      "",
      "## Data sanity",
      "",
      "- [ ] Removal CSV data is from same seller as SP-API token",
      "- [ ] Date window overlaps known removal activity (2025-12-26 → 2026-04-21)",
    ]
      .filter(Boolean)
      .join("\n") + "\n",
  );

  fs.writeFileSync(
    path.join(outDir, "likely-fix.md"),
    [
      "# Likely fix",
      "",
      ...likelyFixes.map((x) => `- ${x}`),
      "",
      "## Code fix candidate (if AWS-on-store mismatch confirmed)",
      "",
      "In `lib/amazon/reports-api-credentials.ts`, when store-linked marketplace has complete LWA but AWS keys only in env, use store LWA + env AWS (mirror catalog priority) instead of falling through to a different org key/marketplace row.",
      "",
      "## Retry command (after human checklist + optional code fix)",
      "",
      "```bash",
      retryCommand,
      "```",
    ].join("\n") + "\n",
  );

  fs.writeFileSync(
    path.join(outDir, "manifest.json"),
    JSON.stringify(
      {
        prompt: "SP-API REMOVAL FATAL FIX CHECKLIST",
        run_id: runId,
        staging_ref: STAGING_REF,
        product_button_credential_source: catalog?.source ?? "none",
        removal_worker_credential_source: reports?.source ?? "none",
        same_credential_source: same,
        likely_fix: likelyFixes[0],
        exact_next_retry_command: retryCommand,
        no_amazon_calls: true,
        no_secrets_printed: true,
      },
      null,
      2,
    ),
  );

  console.log(
    JSON.stringify(
      {
        ok: true,
        outDir: path.relative(process.cwd(), outDir).replace(/\\/g, "/"),
        product_button_source: catalog?.source ?? "none",
        removal_worker_source: reports?.source ?? "none",
        same_source: same,
        likely_fix: likelyFixes[0],
        next_retry_command: retryCommand,
      },
      null,
      2,
    ),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
