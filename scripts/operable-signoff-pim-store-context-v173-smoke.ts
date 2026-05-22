/**
 * OPERABLE-SIGNOFF-PIM-STORE-CONTEXT-V173
 * Proves Sam Distribution + Sam AM catalog count (~17,001) and optional browser PIM grid.
 *
 * Usage:
 *   npx tsx scripts/operable-signoff-pim-store-context-v173-smoke.ts --run-id=20260518T200000Z
 *   npx tsx scripts/operable-signoff-pim-store-context-v173-smoke.ts --reuse-auth --browser
 *
 * API-only by default. Pass --browser when `npm run dev` is up (uses v172 auth-state if present).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createClient } from "@supabase/supabase-js";
import { chromium, type Page } from "playwright";

import {
  buildPimCatalogDeepLink,
  OPERABLE_SAM_AM_STORE_ID,
  OPERABLE_SAM_DISTRIBUTION_ORG_ID,
} from "../lib/workspace-url-context";
import {
  getStagingProjectRef,
  loadEnvLocalIntoProcess,
  refFromSupabaseUrl,
} from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const TARGET_PRODUCT_COUNT = 17_001;
const COUNT_TOLERANCE = 50;
const V172_AUTH = path.resolve(
  process.cwd(),
  ".cursor/audit-reports/manual-ui-operable-browser-smoke-v172/auth-state.json",
);

type Check = { id: string; pass: boolean; detail: string };

function runId(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCSeconds())}Z`;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

async function waitForAuthenticated(page: Page, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!page.url().includes("/login")) return true;
    await page.waitForTimeout(400);
  }
  return !page.url().includes("/login");
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const id = runId();
  const withBrowser = hasFlag("--browser");
  const baseUrl = (process.env.SMOKE_BASE_URL ?? "http://127.0.0.1:3000").replace(/\/$/, "");
  const outDir = path.resolve(
    process.cwd(),
    ".cursor/audit-reports/operable-signoff-pim-store-context-v173",
    id,
  );
  fs.mkdirSync(outDir, { recursive: true });

  const checks: Check[] = [];
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ?? "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ?? "";
  const ref = refFromSupabaseUrl(url);

  checks.push({
    id: "01_staging_ref",
    pass: ref === STAGING_REF && getStagingProjectRef({ loadEnv: false }) === STAGING_REF,
    detail: `ref=${ref ?? "?"}`,
  });

  if (!url || !key || ref !== STAGING_REF) {
    writeArtifacts(outDir, id, checks, "FAIL", { browserSkipped: true });
    process.exit(2);
  }

  const sb = createClient(url, key, { auth: { persistSession: false } });

  const { data: orgRow } = await sb
    .from("organizations")
    .select("name")
    .eq("id", OPERABLE_SAM_DISTRIBUTION_ORG_ID)
    .maybeSingle();
  const { data: storeRow } = await sb
    .from("stores")
    .select("name, organization_id")
    .eq("id", OPERABLE_SAM_AM_STORE_ID)
    .maybeSingle();

  const orgName = String((orgRow as { name?: string } | null)?.name ?? "");
  const storeName = String((storeRow as { name?: string } | null)?.name ?? "");
  const storeOrg = String((storeRow as { organization_id?: string } | null)?.organization_id ?? "");

  checks.push({
    id: "02_sam_distribution_org",
    pass: /sam distribution/i.test(orgName),
    detail: `org name="${orgName}" id=${OPERABLE_SAM_DISTRIBUTION_ORG_ID}`,
  });
  checks.push({
    id: "03_sam_am_store",
    pass: /sam am/i.test(storeName) && storeOrg === OPERABLE_SAM_DISTRIBUTION_ORG_ID,
    detail: `store name="${storeName}" org_id=${storeOrg}`,
  });

  const { count: productCount } = await sb
    .from("products")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", OPERABLE_SAM_DISTRIBUTION_ORG_ID)
    .eq("store_id", OPERABLE_SAM_AM_STORE_ID)
    .is("deleted_at", null);

  const n = productCount ?? 0;
  checks.push({
    id: "04_api_product_count",
    pass: Math.abs(n - TARGET_PRODUCT_COUNT) <= COUNT_TOLERANCE,
    detail: `products=${n} target=${TARGET_PRODUCT_COUNT} ±${COUNT_TOLERANCE}`,
  });

  const deepLink = buildPimCatalogDeepLink();
  checks.push({
    id: "05_deep_link_shape",
    pass: deepLink.includes("workspace_org=") && deepLink.includes(`store=${OPERABLE_SAM_AM_STORE_ID}`),
    detail: deepLink,
  });

  let browserSkipped = !withBrowser;
  if (withBrowser) {
    const authPath = fs.existsSync(V172_AUTH) ? V172_AUTH : null;
    if (!authPath) {
      checks.push({
        id: "06_browser_pim_grid",
        pass: false,
        detail: "No auth-state — run v172 smoke with --manual-login first or omit --browser",
      });
      browserSkipped = true;
    } else {
      const browser = await chromium.launch({ headless: true });
      const context = await browser.newContext({ storageState: authPath });
      const page = await context.newPage();
      try {
        await page.goto(`${baseUrl}${deepLink}`, { waitUntil: "networkidle", timeout: 120_000 });
        const authed = await waitForAuthenticated(page, 5_000);
        if (!authed) {
          checks.push({
            id: "06_browser_pim_grid",
            pass: false,
            detail: "Not authenticated",
          });
        } else {
          await page
            .getByText(/of\s+[\d,]+\s+product/i)
            .first()
            .waitFor({ timeout: 90_000 })
            .catch(() => null);
          const body = await page.locator("body").innerText();
          const storeSelect = page.locator('select').filter({ hasText: /sam am/i }).first();
          const storeOk = (await storeSelect.count()) > 0 || /sam am/i.test(body);
          const countOk =
            body.includes("17,001") ||
            body.includes("17001") ||
            new RegExp(`of\\s+${TARGET_PRODUCT_COUNT.toLocaleString()}\\s+product`, "i").test(body);
          const noStoresOnly = /no stores/i.test(body) && !countOk;
          checks.push({
            id: "06_browser_sam_am_selected",
            pass: storeOk && !/no stores/i.test(body),
            detail: storeOk ? "Sam AM visible in store control" : "Sam AM not found in PIM chrome",
          });
          checks.push({
            id: "07_browser_pim_grid_count",
            pass: countOk && !noStoresOnly,
            detail: countOk ? "Grid total ~17,001" : "Product total not shown (wrong workspace/store?)",
          });
          fs.writeFileSync(
            path.join(outDir, "browser-body-snippet.txt"),
            body.slice(0, 8000),
            "utf8",
          );
        }
      } finally {
        await browser.close();
      }
    }
  }

  const failed = checks.filter((c) => !c.pass);
  const status =
    failed.length === 0 ? "PASS" : failed.every((c) => c.id.startsWith("06_") || c.id.startsWith("07_")) ? "PARTIAL_PASS" : "FAIL";

  writeArtifacts(outDir, id, checks, status, { browserSkipped, productCount: n, deepLink });
  process.exit(failed.some((c) => !c.id.startsWith("06_") && !c.id.startsWith("07_")) ? 1 : failed.length ? 0 : 0);
}

function writeArtifacts(
  outDir: string,
  id: string,
  checks: Check[],
  status: string,
  extra: { browserSkipped: boolean; productCount?: number; deepLink?: string },
): void {
  fs.writeFileSync(
    path.join(outDir, "manifest.json"),
    JSON.stringify(
      {
        prompt_id: "OPERABLE-SIGNOFF-PIM-STORE-CONTEXT-V173",
        run_id: id,
        status,
        checks,
        ...extra,
      },
      null,
      2,
    ),
    "utf8",
  );
  fs.writeFileSync(
    path.join(outDir, "validation-results.json"),
    JSON.stringify({ run_id: id, status, checks }, null, 2),
    "utf8",
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
