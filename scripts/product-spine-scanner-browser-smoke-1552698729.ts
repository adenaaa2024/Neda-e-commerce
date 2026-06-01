/**
 * PRODUCT-SPINE-SCANNER-BROWSER-SMOKE-1552698729
 * Read-only env verify + server gate replay + operator-mobile browser smoke.
 *
 *   npx tsx scripts/product-spine-scanner-browser-smoke-1552698729.ts --run-id=20260530T180000Z
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createClient } from "@supabase/supabase-js";
import pg from "pg";
import { chromium, type Page } from "playwright";

import { buildInventoryViewProductLinkage } from "../lib/scanner/expected-packages-read-contract";
import {
  PRODUCT_LINKAGE_UNMAPPED_LABEL,
  productLinkageOperatorPrimaryDisplayLabel,
} from "../lib/scanner/product-linkage-display-contract";
import { lookupShipmentEntryScanCode } from "../lib/scanner/shipment-entry-lookup";
import type { VInventoryStatusRow } from "../lib/scanner/v-inventory-status";
import {
  loadEnvLocalIntoProcess,
  refFromSupabaseUrl,
  supabaseUrlMatchesStagingRef,
} from "../lib/staging-project-ref";

const OUT_BASE = ".cursor/audit-reports/product-spine-scanner-browser-smoke-1552698729";
const STAGING_REF = "eiqfaapyumhixxoeltgu";
const STORE_ID = "509ee1f6-622c-46a5-8110-7b889ba46c2c";
const TRACKING = "1552698729";
const FNSKU = "X003S8RCBH";
const TYPO_FNSKU = "X003SRBCH";
const EXPECTED_NAME = "Bobs Red Mill GF Baking Soda 4/16 Oz";
const PRODUCT_ID = "e3832e25-275f-4124-906b-f2d6b7931b86";
const EXPECTED_EP_ID = "68f71d9c-b79c-4ff4-8a5a-6aa1b7c8b289";

function runIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function gateProductDisplayLabel(shipmentLines: VInventoryStatusRow[]): string {
  if (!shipmentLines.length) return PRODUCT_LINKAGE_UNMAPPED_LABEL;
  const labels = new Set<string>();
  const nameMap = new Map<string, string>();
  for (const row of shipmentLines) {
    for (const key of [row.resolved_product_id, row.product_id, row.resolved_catalog_product_id]) {
      const id = String(key ?? "").trim();
      const nm = row.product_display_name?.trim() || row.product_name?.trim() || "";
      if (id && nm) nameMap.set(id, nm);
    }
    const linkage = buildInventoryViewProductLinkage(row, undefined, nameMap);
    labels.add(productLinkageOperatorPrimaryDisplayLabel(linkage));
  }
  if (labels.size === 1) return [...labels][0]!;
  if (labels.size > 1) return `${labels.size} products`;
  return PRODUCT_LINKAGE_UNMAPPED_LABEL;
}

async function resolveOrgIdForStore(dbUrl: string, storeId: string): Promise<string | null> {
  const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();
  const r = await client.query(
    `SELECT organization_id::text AS organization_id FROM stores WHERE id = $1 LIMIT 1`,
    [storeId],
  );
  await client.end();
  return (r.rows[0]?.organization_id as string | undefined)?.trim() || null;
}

async function waitForAuthenticated(page: Page, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!page.url().includes("/login") && !page.url().includes("/auth/")) return true;
    await page.waitForTimeout(400);
  }
  return !page.url().includes("/login");
}

function buildSupabaseAuthCookies(
  baseUrl: string,
  ref: string,
  session: {
    access_token: string;
    refresh_token: string;
    expires_in?: number;
    expires_at?: number;
    token_type?: string;
    user: Record<string, unknown> | { id: string; email?: string };
  },
): { name: string; value: string; domain: string; path: string }[] {
  const host = new URL(baseUrl).hostname;
  const storageValue = JSON.stringify({
    access_token: session.access_token,
    refresh_token: session.refresh_token,
    expires_in: session.expires_in ?? 3600,
    expires_at: session.expires_at ?? Math.floor(Date.now() / 1000) + (session.expires_in ?? 3600),
    token_type: session.token_type ?? "bearer",
    user: session.user,
  });
  const cookieName = `sb-${ref}-auth-token`;
  return [
    { name: cookieName, value: storageValue, domain: host, path: "/" },
    { name: `${cookieName}.0`, value: storageValue.slice(0, 3180), domain: host, path: "/" },
    ...(storageValue.length > 3180
      ? [{ name: `${cookieName}.1`, value: storageValue.slice(3180), domain: host, path: "/" }]
      : []),
  ];
}

async function resolveLoginEmail(dbUrl: string, supabaseUrl: string, serviceKey: string): Promise<string | null> {
  const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
  const { data, error } = await admin.auth.admin.listUsers({ perPage: 1 });
  if (!error && data.users[0]?.email) return data.users[0].email.trim();
  const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();
  const r = await client.query(
    `SELECT email FROM auth.users WHERE email IS NOT NULL AND email <> '' ORDER BY created_at DESC LIMIT 1`,
  );
  await client.end();
  return (r.rows[0]?.email as string | undefined)?.trim() || null;
}

async function browserLoginViaMagicLink(page: Page, baseUrl: string): Promise<boolean> {
  loadEnvLocalIntoProcess();
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ?? "";
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim() ?? "";
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ?? "";
  const dbUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ?? "";
  const email = await resolveLoginEmail(dbUrl, url, serviceKey);
  const ref = refFromSupabaseUrl(url);
  if (!url || !anon || !serviceKey || !email || !ref) return false;

  const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await admin.auth.admin.generateLink({
    type: "magiclink",
    email,
    options: { redirectTo: `${baseUrl}/scanner/operator-mobile/scan` },
  });
  const tokenHash = data?.properties?.hashed_token;
  if (error || !tokenHash) return false;

  const anonClient = createClient(url, anon, { auth: { persistSession: false } });
  const { data: otpData, error: otpError } = await anonClient.auth.verifyOtp({
    type: "email",
    token_hash: tokenHash,
  });
  if (otpError || !otpData.session?.access_token) return false;

  const cookies = buildSupabaseAuthCookies(baseUrl, ref, otpData.session);
  await page.context().addCookies(cookies);
  await page.goto(`${baseUrl}/scanner/operator-mobile/scan`, { waitUntil: "domcontentloaded", timeout: 90_000 });
  return waitForAuthenticated(page, 15_000);
}

async function runGateSearchInBrowser(
  page: Page,
  code: string,
): Promise<{ productName: string | null; noLinkYet: boolean; bodySnippet: string }> {
  await page.goto(`${page.url().split("/scanner")[0]}/scanner/operator-mobile/scan`, {
    waitUntil: "domcontentloaded",
    timeout: 90_000,
  });
  await page.waitForTimeout(1500);

  const tapToType = page.locator(".operator-shipment-entry-gate__tap-to-type").first();
  if (await tapToType.isVisible().catch(() => false)) {
    await page.locator(".operator-shipment-entry-gate__input").first().click({ timeout: 10_000 });
    await page.waitForTimeout(400);
  }

  const input = page.locator('input.operator-shipment-entry-gate__input[aria-label*="Type tracking"]').first();
  if (!(await input.isVisible().catch(() => false))) {
    await page.locator(".operator-shipment-entry-gate__input").first().click({ timeout: 10_000 });
    await page.waitForTimeout(400);
  }

  const activeInput = page.locator("input.operator-shipment-entry-gate__input").first();
  await activeInput.waitFor({ state: "visible", timeout: 15_000 });
  await activeInput.fill(code);
  await page.locator(".operator-shipment-entry-gate__search-btn").click({ timeout: 10_000 });

  await page
    .locator(".operator-shipment-entry-gate__results")
    .waitFor({ state: "visible", timeout: 45_000 })
    .catch(() => {});
  await page.waitForTimeout(2500);

  const bodyText = await page.locator("body").innerText().catch(() => "");
  const productRow = page.locator('dt:has-text("Product name") + dd').first();
  const productName = (await productRow.innerText().catch(() => "")).trim() || null;
  const noLinkYet = /No product link yet/i.test(bodyText);
  return { productName, noLinkYet, bodySnippet: bodyText.slice(0, 2500) };
}

async function main(): Promise<void> {
  const runId = runIdArg();
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  const shotDir = path.join(outDir, "screenshots");
  fs.mkdirSync(shotDir, { recursive: true });

  loadEnvLocalIntoProcess();
  const baseUrl = (process.env.SMOKE_BASE_URL ?? "http://127.0.0.1:3000").replace(/\/$/, "");
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ?? "";
  const storeIdEnv = process.env.NEXT_PUBLIC_STORE_ID?.trim() ?? "";
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ?? "";
  const dbUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ?? "";

  const envVerified =
    supabaseUrlMatchesStagingRef(supabaseUrl, STAGING_REF) && storeIdEnv === STORE_ID && Boolean(serviceKey);

  const envProof = {
    env_verified: envVerified,
    next_public_store_id: storeIdEnv || null,
    next_public_supabase_url_ref: refFromSupabaseUrl(supabaseUrl),
    expected_store_id: STORE_ID,
    expected_staging_ref: STAGING_REF,
  };
  fs.writeFileSync(path.join(outDir, "env-verification.json"), JSON.stringify(envProof, null, 2));

  if (!envVerified) {
    fs.writeFileSync(
      path.join(outDir, "smoke-summary.md"),
      `# PRODUCT-SPINE-SCANNER-BROWSER-SMOKE-1552698729\n\n**FAIL** — env not verified.\n\nSee \`env-verification.json\`.\n`,
    );
    process.exit(2);
  }

  const orgId =
    (await resolveOrgIdForStore(dbUrl, STORE_ID)) ?? "00000000-0000-0000-0000-000000000001";
  const supabase = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

  type GateCase = {
    code: string;
    label: string;
    lookup: Awaited<ReturnType<typeof lookupShipmentEntryScanCode>>;
    displayLabel: string;
    expected_package_ids: string[];
    resolved_product_ids: string[];
  };

  const gateCases: GateCase[] = [];
  for (const [code, label] of [
    [TRACKING, "tracking"],
    [FNSKU, "fnsku"],
    [TYPO_FNSKU, "typo_fnsku"],
  ] as const) {
    const lookup = await lookupShipmentEntryScanCode(supabase, orgId, STORE_ID, code);
    const lines = lookup.inventory_rows;
    gateCases.push({
      code,
      label,
      lookup,
      displayLabel: gateProductDisplayLabel(lines),
      expected_package_ids: [...new Set(lines.map((r) => r.expected_package_id).filter(Boolean))],
      resolved_product_ids: [
        ...new Set(
          lines
            .map((r) => String(r.resolved_product_id ?? r.product_id ?? "").trim())
            .filter(Boolean),
        ),
      ],
    });
  }

  const trackingCase = gateCases.find((c) => c.label === "tracking")!;
  const fnskuCase = gateCases.find((c) => c.label === "fnsku")!;
  const typoCase = gateCases.find((c) => c.label === "typo_fnsku")!;

  const serverGateProof = {
    organization_id: orgId,
    store_id: STORE_ID,
    tracking: {
      match_status: trackingCase.lookup.match_status,
      expected_package_ids: trackingCase.expected_package_ids,
      resolved_product_ids: trackingCase.resolved_product_ids,
      display_label: trackingCase.displayLabel,
      pass:
        trackingCase.expected_package_ids.includes(EXPECTED_EP_ID) &&
        trackingCase.resolved_product_ids.includes(PRODUCT_ID) &&
        trackingCase.displayLabel === EXPECTED_NAME,
    },
    fnsku: {
      match_status: fnskuCase.lookup.match_status,
      display_label: fnskuCase.displayLabel,
      pass: fnskuCase.displayLabel === EXPECTED_NAME,
    },
    typo_fnsku: {
      inventory_row_count: typoCase.lookup.inventory_rows.length,
      display_label: typoCase.displayLabel,
      pass: typoCase.lookup.inventory_rows.length === 0,
    },
  };
  fs.writeFileSync(path.join(outDir, "server-gate-replay.json"), JSON.stringify(serverGateProof, null, 2));

  let browser = {
    attempted: false,
    authenticated: false,
    tracking: { product_name_visible: false, linked_state: false, product_name: null as string | null },
    fnsku: { product_name_visible: false, linked_state: false, product_name: null as string | null },
    typo: { pass: false, product_name: null as string | null, no_link_yet: false },
    error: null as string | null,
  };

  try {
    const probe = await fetch(`${baseUrl}/scanner/operator-mobile/scan`, { redirect: "manual" });
    if (probe.status === 0) throw new Error(`Dev server unreachable at ${baseUrl}`);

    browser.attempted = true;
    const pw = await chromium.launch({ headless: true });
    const context = await pw.newContext({ viewport: { width: 430, height: 932 } });
    const page = await context.newPage();
    const authed = await browserLoginViaMagicLink(page, baseUrl);
    browser.authenticated = authed;

    if (authed) {
      const trackingUi = await runGateSearchInBrowser(page, TRACKING);
      browser.tracking = {
        product_name: trackingUi.productName,
        product_name_visible: trackingUi.productName === EXPECTED_NAME,
        linked_state: Boolean(trackingUi.productName) && !trackingUi.noLinkYet,
      };
      await page.screenshot({ path: path.join(shotDir, "01-tracking-gate-results.png"), fullPage: true });
      fs.writeFileSync(
        path.join(outDir, "browser-tracking-log.txt"),
        JSON.stringify(trackingUi, null, 2),
      );

      const fnskuUi = await runGateSearchInBrowser(page, FNSKU);
      browser.fnsku = {
        product_name: fnskuUi.productName,
        product_name_visible: fnskuUi.productName === EXPECTED_NAME,
        linked_state: Boolean(fnskuUi.productName) && !fnskuUi.noLinkYet,
      };
      await page.screenshot({ path: path.join(shotDir, "02-fnsku-gate-results.png"), fullPage: true });
      fs.writeFileSync(path.join(outDir, "browser-fnsku-log.txt"), JSON.stringify(fnskuUi, null, 2));

      const typoUi = await runGateSearchInBrowser(page, TYPO_FNSKU);
      browser.typo = {
        product_name: typoUi.productName,
        no_link_yet: typoUi.noLinkYet,
        pass:
          typoUi.productName !== EXPECTED_NAME &&
          (typoUi.noLinkYet ||
            typoUi.productName === PRODUCT_LINKAGE_UNMAPPED_LABEL ||
            !typoUi.productName),
      };
      await page.screenshot({ path: path.join(shotDir, "03-typo-fnsku-gate-results.png"), fullPage: true });
      fs.writeFileSync(path.join(outDir, "browser-typo-log.txt"), JSON.stringify(typoUi, null, 2));
    } else {
      await page.screenshot({ path: path.join(shotDir, "00-login-failed.png"), fullPage: true });
    }

    await pw.close();
  } catch (e) {
    browser.error = e instanceof Error ? e.message : String(e);
  }

  const expectedPackageIdProof =
    serverGateProof.tracking.pass && trackingCase.expected_package_ids.includes(EXPECTED_EP_ID);

  const browserProductNameVisible =
    browser.tracking.product_name_visible && browser.fnsku.product_name_visible;
  const browserLinkedState = browser.tracking.linked_state && browser.fnsku.linked_state;
  const typoNegativePass = serverGateProof.typo_fnsku.pass && (browser.typo.pass || !browser.authenticated);

  const blockers: string[] = [];
  if (!browser.authenticated) blockers.push("Browser magic-link auth failed — UI DOM proof incomplete.");
  if (!browserProductNameVisible && browser.authenticated) {
    blockers.push("Browser did not show expected product name on tracking/FNSKU gate searches.");
  }
  if (!browser.typo.pass && browser.authenticated) {
    blockers.push("Typo FNSKU X003SRBCH may show false link in UI.");
  }

  const overallPass =
    envVerified &&
    serverGateProof.tracking.pass &&
    serverGateProof.fnsku.pass &&
    serverGateProof.typo_fnsku.pass &&
    expectedPackageIdProof &&
    typoNegativePass &&
    (browser.authenticated ? browserProductNameVisible && browserLinkedState && browser.typo.pass : false);

  const report = {
    audit: "product-spine-scanner-browser-smoke-1552698729",
    run_id: runId,
    owner: "Main/user",
    branch: "feature/product-canonicalization-v3",
    env_verified: envVerified,
    browser_product_name_visible: browserProductNameVisible,
    browser_linked_state: browserLinkedState,
    expected_package_id_proof: expectedPackageIdProof,
    expected_package_id: EXPECTED_EP_ID,
    resolved_product_id: PRODUCT_ID,
    negative_typo_test_pass: typoNegativePass,
    server_gate_pass:
      serverGateProof.tracking.pass && serverGateProof.fnsku.pass && serverGateProof.typo_fnsku.pass,
    overall_pass: overallPass,
    remaining_blockers: blockers,
    browser,
    server_gate: serverGateProof,
  };

  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(report, null, 2));
  fs.writeFileSync(
    path.join(outDir, "smoke-summary.md"),
    `# PRODUCT-SPINE-SCANNER-BROWSER-SMOKE-1552698729

| Check | Result |
|-------|--------|
| Env verified | ${envVerified ? "**yes**" : "**no**"} |
| Browser product name visible | ${browserProductNameVisible ? "**yes**" : browser.authenticated ? "**no**" : "**skipped (auth)**"} |
| Linked state (not "No product link yet") | ${browserLinkedState ? "**yes**" : browser.authenticated ? "**no**" : "**skipped (auth)**"} |
| \`expected_package_id\` proof | ${expectedPackageIdProof ? "**yes**" : "**no**"} (\`${EXPECTED_EP_ID}\`) |
| Negative typo test (\`X003SRBCH\`) | ${typoNegativePass ? "**pass**" : "**fail**"} |
| Server gate replay | ${report.server_gate_pass ? "**pass**" : "**fail**"} |

## Tracking \`${TRACKING}\`
- Server display: \`${trackingCase.displayLabel}\`
- Browser product name: \`${browser.tracking.product_name ?? "—"}\`

## FNSKU \`${FNSKU}\`
- Server display: \`${fnskuCase.displayLabel}\`
- Browser product name: \`${browser.fnsku.product_name ?? "—"}\`

## Remaining blockers
${blockers.length ? blockers.map((b) => `- ${b}`).join("\n") : "- None"}

**Overall:** ${overallPass ? "**PASS**" : "**FAIL**"}
`,
  );

  console.log(JSON.stringify(report, null, 2));
  process.exit(overallPass ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
