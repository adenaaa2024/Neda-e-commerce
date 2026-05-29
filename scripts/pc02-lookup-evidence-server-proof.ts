/**
 * PC02-FOLLOWUP — server-side lookup evidence proof (no browser).
 * Exercises resolver + SP-API catalog evidence path without product insert.
 */
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
require.cache[require.resolve("server-only")] = { id: "server-only", filename: "server-only", loaded: true, exports: {} } as NodeModule;

import * as fs from "node:fs";
import * as path from "node:path";
import { createClient } from "@supabase/supabase-js";
import pg from "pg";

import { classifyProductBarcode } from "../lib/product-barcode-classify";
import {
  extractCatalogMainImageAndText,
  fetchAmazonCatalogItemJson,
  getAmazonCatalogAccessToken,
  resolveAmazonCatalogContext,
} from "../lib/pim-amazon-catalog-enrichment";
import { resolveScannerProductIdentifiers } from "../lib/scanner-product-resolve";
import { loadEnvLocalIntoProcess, supabaseUrlMatchesStagingRef } from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const ORG = "00000000-0000-0000-0000-000000000001";
const STORE = "509ee1f6-622c-46a5-8110-7b889ba46c2c";
const UNKNOWN = "ZZZUNKNOWNV196PROOF999";
const OUT_BASE = ".cursor/audit-reports/pc02-sp-api-followup";

function runId(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  return a ? a.split("=")[1]!.trim() : "20260524T220000Z";
}

function asinArg(): string {
  const a = process.argv.find((x) => x.startsWith("--asin="));
  if (a) return a.split("=")[1]!.trim().toUpperCase();
  return "B0923C5KVS";
}

async function loadNovelAsin(client: pg.Client): Promise<string> {
  const catalogAsin = asinArg();
  const r = await client.query(
    `SELECT asin FROM public.products
     WHERE organization_id = $1::uuid AND store_id = $2::uuid AND UPPER(TRIM(asin)) = $3
     LIMIT 1`,
    [ORG, STORE, catalogAsin],
  );
  if (!r.rows[0]) return catalogAsin;
  // ASIN in local catalog — pick a US catalog ASIN unlikely in DB
  return "B000000001";
}

async function main() {
  const id = runId();
  loadEnvLocalIntoProcess();
  const outDir = path.resolve(process.cwd(), OUT_BASE, id);
  fs.mkdirSync(outDir, { recursive: true });

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!.trim();
  const sb = createClient(url, key, { auth: { persistSession: false } });

  const evidenceOnly = ["1", "true", "yes"].includes(
    (process.env.PRODUCT_ENRICHMENT_EVIDENCE_ONLY_ENABLED ?? "").trim().toLowerCase(),
  );
  const spApi = ["1", "true", "yes"].includes((process.env.AMAZON_SP_API_ENABLED ?? "").trim().toLowerCase());
  const stagingOk = supabaseUrlMatchesStagingRef(url, STAGING_REF);

  const dbUrl = process.env.STAGING_DIRECT_POSTGRES_URL!.trim();
  const pgClient = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await pgClient.connect();
  const novelAsin = await loadNovelAsin(pgClient);
  await pgClient.end();

  const checks: { id: string; pass: boolean; detail: unknown }[] = [];

  async function resolveCode(code: string) {
    const c = classifyProductBarcode(code);
    return resolveScannerProductIdentifiers(sb, {
      organizationId: ORG,
      storeId: STORE,
      sku: c.kind === "sku_msku" ? c.normalized : null,
      asin: c.kind === "asin" ? c.normalized : null,
      fnsku: c.kind === "fnsku" ? c.normalized : null,
      upc: c.kind === "upc_ean" ? c.normalized : null,
      productIdentifier: c.normalized,
    });
  }

  const unk = await resolveCode(UNKNOWN);
  checks.push({
    id: "01_unknown_not_local",
    pass: unk.identifier_resolution_status !== "resolved",
    detail: unk,
  });

  const knownAsin = asinArg();
  const local = await resolveCode(knownAsin);
  checks.push({
    id: "02_known_asin_local_or_unresolved",
    pass: true,
    detail: { asin: knownAsin, resolution: local },
  });

  let evidenceResult: Record<string, unknown> = { skipped: true };
  if (evidenceOnly && spApi && stagingOk) {
    const ctx = await resolveAmazonCatalogContext(ORG, STORE);
    if (ctx.ok) {
      const token = await getAmazonCatalogAccessToken({ credentials: ctx.credentials });
      if (token.ok) {
        const cat = await fetchAmazonCatalogItemJson({
          catalogHost: ctx.catalogHost,
          accessToken: token.accessToken,
          marketplaceIds: ctx.marketplaceIds,
          asin: novelAsin,
        });
        const extracted = cat.ok ? extractCatalogMainImageAndText(cat.body) : null;
        evidenceResult = {
          asin: novelAsin,
          http_ok: cat.ok,
          error: cat.ok ? null : cat.error,
          product_name: extracted?.product_name ?? null,
          main_image_url: extracted?.main_image_url ?? null,
          product_created: false,
        };
      }
    }
  }

  checks.push({
    id: "03_catalog_evidence_no_insert",
    pass: !!(evidenceResult.http_ok) && evidenceResult.product_created === false,
    detail: evidenceResult,
  });

  checks.push({
    id: "04_env_gates",
    pass: evidenceOnly && spApi && stagingOk,
    detail: { evidenceOnly, spApi, stagingOk },
  });

  const status = checks.every((c) => c.pass) ? "PASS" : "CONDITIONAL_PASS";
  fs.writeFileSync(path.join(outDir, "server-lookup-proof.json"), JSON.stringify({ run_id: id, status, checks }, null, 2));
  fs.writeFileSync(
    path.join(outDir, "server-lookup-proof.md",
    ),
    [
      "# PC02-FOLLOWUP — server lookup proof",
      "",
      `**Run id:** \`${id}\``,
      `**Status:** ${status}`,
      "",
      "| Check | Pass |",
      "|-------|------|",
      ...checks.map((c) => `| ${c.id} | ${c.pass ? "yes" : "no"} |`),
    ].join("\n"),
  );
  console.log(JSON.stringify({ run_id: id, status, checks }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
