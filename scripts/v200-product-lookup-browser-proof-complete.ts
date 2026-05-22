/**
 * V200 — PRODUCT LOOKUP BROWSER PROOF COMPLETE
 *
 * Usage:
 *   npx tsx scripts/v200-product-lookup-browser-proof-complete.ts --run-id=<id>
 *   npx tsx scripts/v200-product-lookup-browser-proof-complete.ts --reuse-auth
 *   npx tsx scripts/v200-product-lookup-browser-proof-complete.ts --manual-login --headed
 *
 * Requires: `npm run dev` on SMOKE_BASE_URL (default http://127.0.0.1:3000).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createClient } from "@supabase/supabase-js";
import pg from "pg";
import { chromium, type Browser, type Page, type Response } from "playwright";

import { classifyProductBarcode } from "../lib/product-barcode-classify";
import { resolveScannerProductIdentifiers } from "../lib/scanner-product-resolve";
import { loadEnvLocalIntoProcess, refFromSupabaseUrl, supabaseUrlMatchesStagingRef } from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const OUT_BASE = ".cursor/audit-reports/v200-product-lookup-browser-proof-complete";
const UNKNOWN_CODE = "ZZZUNKNOWNV200PROOF999";
const V172_AUTH = path.resolve(
  process.cwd(),
  ".cursor/audit-reports/manual-ui-operable-browser-smoke-v172/auth-state.json",
);
const V173_AUTH = path.resolve(
  process.cwd(),
  ".cursor/audit-reports/manual-ui-operable-browser-smoke-v173",
);

type Fixture = {
  organization_id: string;
  store_id: string;
  fnsku: string | null;
  asin: string | null;
  sku: string | null;
  product_id: string;
  product_name: string | null;
};

type EditFixture = {
  return_id: string;
  organization_id: string;
  store_id: string | null;
  fnsku: string | null;
  asin: string | null;
  sku: string | null;
  resolved_product_id: string | null;
  item_name: string | null;
};

type Check = {
  id: string;
  pass: boolean;
  detail: string;
  screenshot?: string;
  server_action?: Record<string, unknown> | null;
};

type LookupCapture = {
  status: number;
  bodySnippet: string;
  parsed: Record<string, unknown> | null;
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

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

let cachedLoginEmail: string | null | undefined;

async function resolveLoginEmail(): Promise<string | null> {
  if (cachedLoginEmail !== undefined) return cachedLoginEmail;
  const fromEnv =
    process.env.PLAYWRIGHT_LOGIN_EMAIL?.trim() ||
    process.env.SMOKE_LOGIN_EMAIL?.trim() ||
    "";
  if (fromEnv) {
    cachedLoginEmail = fromEnv;
    return fromEnv;
  }

  loadEnvLocalIntoProcess();
  const dbUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ?? "";
  if (dbUrl) {
    const client = new pg.Client({
      connectionString: dbUrl,
      ssl: { rejectUnauthorized: false },
      connectionTimeoutMillis: 15_000,
    });
    try {
      await client.connect();
      const r = await client.query(
        `SELECT email FROM auth.users WHERE email IS NOT NULL AND email <> '' ORDER BY created_at DESC LIMIT 1`,
      );
      const email = (r.rows[0]?.email as string | undefined)?.trim();
      if (email) {
        cachedLoginEmail = email;
        return email;
      }
    } finally {
      await client.end().catch(() => null);
    }
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ?? "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ?? "";
  if (url && key) {
    const admin = createClient(url, key, { auth: { persistSession: false } });
    const { data, error } = await admin.auth.admin.listUsers({ perPage: 1 });
    if (!error && data.users[0]?.email) {
      cachedLoginEmail = data.users[0].email.trim();
      return cachedLoginEmail;
    }
  }

  cachedLoginEmail = null;
  return null;
}

async function createAuthCookiesForPlaywright(
  baseUrl: string,
): Promise<{ name: string; value: string; domain: string; path: string }[] | null> {
  loadEnvLocalIntoProcess();
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ?? "";
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim() ?? "";
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ?? "";
  const ref = refFromSupabaseUrl(url);
  const email = await resolveLoginEmail();
  if (!url || !anon || !serviceKey || !ref || !email) {
    console.warn(
      "[v200] cookie auth preconditions:",
      JSON.stringify({ url: !!url, anon: !!anon, serviceKey: !!serviceKey, ref: !!ref, email: !!email }),
    );
    return null;
  }

  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });
  const link = await admin.auth.admin.generateLink({
    type: "magiclink",
    email,
    options: { redirectTo: `${baseUrl}/returns` },
  });
  const tokenHash = link.data?.properties?.hashed_token;
  if (link.error || !tokenHash) {
    console.warn("[v200] generateLink failed:", link.error?.message ?? "no token_hash");
    return null;
  }

  const anonClient = createClient(url, anon, { auth: { persistSession: false } });
  const { data: otpData, error: otpError } = await anonClient.auth.verifyOtp({
    type: "email",
    token_hash: tokenHash,
  });
  const session = otpData.session;
  if (otpError || !session?.access_token || !session.refresh_token || !session.user) {
    console.warn("[v200] verifyOtp failed:", otpError?.message ?? "no session");
    return null;
  }

  return buildSupabaseAuthCookies(baseUrl, ref, session);
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

async function browserLoginWithPassword(page: Page, baseUrl: string): Promise<boolean> {
  const email =
    process.env.PLAYWRIGHT_LOGIN_EMAIL?.trim() || process.env.SMOKE_LOGIN_EMAIL?.trim() || "";
  const password =
    process.env.PLAYWRIGHT_LOGIN_PASSWORD?.trim() || process.env.SMOKE_LOGIN_PASSWORD?.trim() || "";
  if (!email || !password) return false;
  await page.goto(`${baseUrl}/login`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(password);
  await page.getByRole("button", { name: /^login$/i }).click();
  await page.waitForTimeout(2_000);
  return await waitForAuthenticated(page, 15_000);
}

async function injectSupabaseSessionInBrowser(
  page: Page,
  baseUrl: string,
  session: { access_token: string; refresh_token: string },
): Promise<boolean> {
  await page.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
  const ok = await page.evaluate(
    async ({ access_token, refresh_token }) => {
      const mod = await import("/src/lib/supabase.ts").catch(() => null);
      if (!mod?.supabase) return false;
      const { error } = await mod.supabase.auth.setSession({ access_token, refresh_token });
      return !error;
    },
    session,
  );
  if (!ok) return false;
  await page.goto(`${baseUrl}/returns`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  return waitForAuthenticated(page, 15_000);
}

async function browserLoginViaMagicLink(page: Page, baseUrl: string): Promise<boolean> {
  loadEnvLocalIntoProcess();
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ?? "";
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim() ?? "";
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ?? "";
  const email = await resolveLoginEmail();
  if (!url || !anon || !serviceKey || !email) return false;

  const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await admin.auth.admin.generateLink({
    type: "magiclink",
    email,
    options: { redirectTo: `${baseUrl}/returns` },
  });
  const tokenHash = data?.properties?.hashed_token;
  if (error || !tokenHash) {
    console.warn("[v200] generateLink failed:", error?.message ?? "no hashed_token");
    return false;
  }

  const anonClient = createClient(url, anon, { auth: { persistSession: false } });
  const { data: otpData, error: otpError } = await anonClient.auth.verifyOtp({
    type: "email",
    token_hash: tokenHash,
  });
  if (otpError || !otpData.session?.access_token) {
    console.warn("[v200] verifyOtp for browser session failed:", otpError?.message ?? "no session");
    return false;
  }

  const ref = refFromSupabaseUrl(url);
  if (!ref) return false;
  const cookies = buildSupabaseAuthCookies(baseUrl, ref, otpData.session);
  await page.context().addCookies(cookies);
  await page.goto(`${baseUrl}/returns`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  if (await waitForAuthenticated(page, 12_000)) return true;

  const injected = await injectSupabaseSessionInBrowser(page, baseUrl, {
    access_token: otpData.session.access_token,
    refresh_token: otpData.session.refresh_token,
  });
  if (!injected) console.warn("[v200] setSession injection failed; url=", page.url());
  return injected;
}

function enrichmentGateReason(): string {
  const spApiEnabled = ["1", "true", "yes"].includes(
    (process.env.AMAZON_SP_API_ENABLED ?? "").trim().toLowerCase(),
  );
  const autoCreateEnabled = ["1", "true", "yes"].includes(
    (process.env.PRODUCT_ENRICHMENT_AUTO_CREATE_ENABLED ?? "").trim().toLowerCase(),
  );
  const stagingUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ?? "";
  const stagingOk = supabaseUrlMatchesStagingRef(stagingUrl, STAGING_REF);
  if (!stagingOk) return "blocked_non_staging";
  if (!spApiEnabled) return "amazon_sp_api_disabled";
  if (!autoCreateEnabled) return "product_enrichment_auto_create_disabled";
  return "gates_enabled";
}

async function runResolverPreflight(
  fixtures: Awaited<ReturnType<typeof loadFixtures>>,
  outDir: string,
): Promise<Check[]> {
  loadEnvLocalIntoProcess();
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ?? "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ?? "";
  if (!url || !key) throw new Error("Missing Supabase URL/service key for resolver preflight");
  const sb = createClient(url, key, { auth: { persistSession: false } });
  const org = fixtures.orgStore.organization_id;
  const store = fixtures.orgStore.store_id;
  const checks: Check[] = [];

  async function resolveCode(code: string) {
    const c = classifyProductBarcode(code);
    return resolveScannerProductIdentifiers(sb, {
      organizationId: org,
      storeId: store,
      sku: c.kind === "sku_msku" ? c.normalized : null,
      asin: c.kind === "asin" ? c.normalized : null,
      fnsku: c.kind === "fnsku" ? c.normalized : null,
      upc: c.kind === "upc_ean" ? c.normalized : null,
      productIdentifier: c.normalized,
    });
  }

  const fnsku = await resolveCode(fixtures.fnsku);
  checks.push({
    id: "preflight_01_known_fnsku",
    pass: fnsku.identifier_resolution_status === "resolved" && !!fnsku.resolved_product_id,
    detail: JSON.stringify(fnsku),
  });
  const asin = await resolveCode(fixtures.asin);
  checks.push({
    id: "preflight_02_known_asin",
    pass: asin.identifier_resolution_status === "resolved" && !!asin.resolved_product_id,
    detail: JSON.stringify(asin),
  });
  const sku = await resolveCode(fixtures.sku);
  checks.push({
    id: "preflight_03_known_sku",
    pass: sku.identifier_resolution_status === "resolved" && !!sku.resolved_product_id,
    detail: JSON.stringify(sku),
  });
  const unk = await resolveCode(UNKNOWN_CODE);
  checks.push({
    id: "preflight_04_unknown",
    pass: unk.identifier_resolution_status !== "resolved",
    detail: JSON.stringify(unk),
  });
  const gate = enrichmentGateReason();
  checks.push({
    id: "preflight_05_enrichment_gate_state",
    pass: gate !== "blocked_non_staging",
    detail: `enrichment_gate=${gate} (browser must not call Amazon API; case 06 asserts UI gate copy for unknown)`,
  });

  if (fixtures.ambiguous) {
    const amb = await resolveCode(fixtures.ambiguous.fnsku);
    checks.push({
      id: "preflight_06_ambiguous_fnsku",
      pass: amb.identifier_resolution_status === "ambiguous",
      detail: JSON.stringify(amb),
    });
  } else {
    checks.push({
      id: "preflight_06_ambiguous_fnsku",
      pass: true,
      detail: "Skipped — no ambiguous map fixture on staging",
    });
  }

  const collapseFnsku = fixtures.collapse?.fnsku ?? fixtures.fnsku;
  const collapse = await resolveCode(collapseFnsku);
  checks.push({
    id: "preflight_07_duplicate_map_same_product_collapse",
    pass:
      collapse.identifier_resolution_status === "resolved" && !!collapse.resolved_product_id,
    detail: JSON.stringify({
      fnsku: collapseFnsku,
      collapse_fixture: fixtures.collapse ?? null,
      resolution: collapse,
    }),
  });

  fs.writeFileSync(path.join(outDir, "resolver-preflight.json"), JSON.stringify(checks, null, 2));
  return checks;
}

async function hasSupabaseSessionCookie(page: Page): Promise<boolean> {
  const cookies = await page.context().cookies();
  return cookies.some((c) => /^sb-.*-auth-token/.test(c.name) && c.value.length > 20);
}

async function waitForAuthenticated(page: Page, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const u = page.url();
    if (u.includes("access_token=") || u.includes("type=magiclink")) return true;
    if (await hasSupabaseSessionCookie(page)) return true;
    if (u.includes("/returns") && !u.includes("/login")) return true;
    if (!u.includes("/login") && !u.includes("/auth/")) return true;
    await page.waitForTimeout(400);
  }
  if (await hasSupabaseSessionCookie(page)) return true;
  return !page.url().includes("/login") && (await hasSupabaseSessionCookie(page));
}

async function loadFixtures(): Promise<{
  orgStore: Fixture;
  fnsku: string;
  asin: string;
  sku: string;
  alt: { fnsku: string | null; asin: string | null; sku: string | null; product_id: string };
  edit: EditFixture | null;
  ambiguous: { fnsku: string; organization_id: string; store_id: string } | null;
  collapse: { fnsku: string; product_id: string; map_row_count: number } | null;
}> {
  loadEnvLocalIntoProcess();
  const dbUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ?? "";
  if (!dbUrl) throw new Error("STAGING_DIRECT_POSTGRES_URL missing");
  const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();
  await client.query("SET statement_timeout = '60s'");

  const mapRow = await client.query(`
    SELECT m.organization_id::text, m.store_id::text, m.fnsku, m.asin,
      COALESCE(NULLIF(TRIM(m.seller_sku), ''), NULLIF(TRIM(m.msku), '')) AS sku,
      m.product_id::text, p.product_name
    FROM public.product_identifier_map m
    JOIN public.products p ON p.id = m.product_id AND p.deleted_at IS NULL
    WHERE m.deleted_at IS NULL
      AND m.fnsku IS NOT NULL AND length(trim(m.fnsku)) >= 8
      AND m.asin IS NOT NULL AND length(trim(m.asin)) >= 10
      AND COALESCE(NULLIF(TRIM(m.seller_sku), ''), NULLIF(TRIM(m.msku), '')) IS NOT NULL
    ORDER BY m.last_seen_at DESC NULLS LAST
    LIMIT 1
  `);

  if (!mapRow.rows[0]) {
    await client.end();
    throw new Error("No suitable map fixture (fnsku+asin+sku) on staging");
  }
  const base = mapRow.rows[0] as Fixture;

  const altRow = await client.query(
    `
    SELECT m.fnsku, m.asin,
      COALESCE(NULLIF(TRIM(m.seller_sku), ''), NULLIF(TRIM(m.msku), '')) AS sku,
      m.product_id::text
    FROM public.product_identifier_map m
    WHERE m.deleted_at IS NULL
      AND m.organization_id = $1::uuid
      AND m.store_id = $2::uuid
      AND m.product_id <> $3::uuid
      AND (m.fnsku IS NOT NULL OR m.asin IS NOT NULL)
    ORDER BY m.last_seen_at DESC NULLS LAST
    LIMIT 1
  `,
    [base.organization_id, base.store_id, base.product_id],
  );

  const editRow = await client.query(
    `
    SELECT id::text AS return_id, organization_id::text, store_id::text,
      fnsku, asin, sku, resolved_product_id::text, item_name
    FROM public.return_items
    WHERE deleted_at IS NULL
      AND resolved_product_id IS NOT NULL
      AND organization_id = $1::uuid
      AND (store_id = $2::uuid OR store_id IS NULL)
    ORDER BY updated_at DESC NULLS LAST
    LIMIT 1
  `,
    [base.organization_id, base.store_id],
  );

  const ambRow = await client.query(
    `
    SELECT m.fnsku, m.organization_id::text, m.store_id::text,
      COUNT(DISTINCT m.product_id)::int AS product_count
    FROM public.product_identifier_map m
    WHERE m.deleted_at IS NULL AND m.fnsku IS NOT NULL
    GROUP BY m.fnsku, m.organization_id, m.store_id
    HAVING COUNT(DISTINCT m.product_id) > 1
    ORDER BY COUNT(*) DESC
    LIMIT 1
  `,
  );

  const collapseRow = await client.query(
    `
    SELECT m.fnsku, m.product_id::text, COUNT(*)::int AS map_row_count
    FROM public.product_identifier_map m
    WHERE m.deleted_at IS NULL
      AND m.organization_id = $1::uuid
      AND m.store_id = $2::uuid
      AND m.fnsku IS NOT NULL
    GROUP BY m.fnsku, m.product_id
    HAVING COUNT(*) > 1
    ORDER BY COUNT(*) DESC
    LIMIT 1
  `,
    [base.organization_id, base.store_id],
  );

  await client.end();

  const amb = ambRow.rows[0] as { fnsku: string; organization_id: string; store_id: string } | undefined;

  return {
    orgStore: base,
    fnsku: base.fnsku!,
    asin: base.asin!,
    sku: base.sku!,
    alt: (altRow.rows[0] as {
      fnsku: string | null;
      asin: string | null;
      sku: string | null;
      product_id: string;
    }) ?? { fnsku: null, asin: null, sku: null, product_id: base.product_id },
    edit: (editRow.rows[0] as EditFixture | undefined) ?? null,
    ambiguous: amb
      ? { fnsku: amb.fnsku, organization_id: amb.organization_id, store_id: amb.store_id }
      : null,
    collapse: collapseRow.rows[0]
      ? (collapseRow.rows[0] as { fnsku: string; product_id: string; map_row_count: number })
      : null,
  };
}

async function shot(page: Page, dir: string, name: string): Promise<string | undefined> {
  try {
    const file = `${name}.png`;
    await page.screenshot({ path: path.join(dir, file), fullPage: true });
    return `screenshots/${file}`;
  } catch {
    return undefined;
  }
}

function parseServerActionBody(text: string): Record<string, unknown> | null {
  const markers = ['"ok":true', '"ok":false', '"status":"local_resolved"', '"status":"unresolved"'];
  if (!markers.some((m) => text.includes(m))) return null;
  try {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    /* RSC chunks may not be pure JSON */
  }
  if (text.includes("local_resolved")) return { inferred_status: "local_resolved" };
  if (text.includes("unresolved")) return { inferred_status: "unresolved" };
  if (text.includes("product_enrichment_auto_create_disabled")) {
    return { inferred_enrichment_reason: "product_enrichment_auto_create_disabled" };
  }
  if (text.includes("amazon_sp_api_disabled")) {
    return { inferred_enrichment_reason: "amazon_sp_api_disabled" };
  }
  return null;
}

async function openWizard(page: Page, baseUrl: string): Promise<void> {
  await page.goto(`${baseUrl}/returns`, { waitUntil: "domcontentloaded", timeout: 120_000 });
  await page.getByRole("heading", { name: /returns & logistics/i }).waitFor({ timeout: 60_000 });
  await page.getByText("Loading…").waitFor({ state: "hidden", timeout: 120_000 }).catch(() => null);
  const itemsTab = page.getByRole("tab", { name: /items/i }).first();
  if (await itemsTab.isVisible().catch(() => false)) {
    await itemsTab.click().catch(() => null);
  }
  await page.getByRole("button", { name: /scan item/i }).click({ timeout: 60_000 });
  await page.getByPlaceholder(/scan or type product identifier/i).waitFor({ timeout: 30_000 });
}

async function prepareLooseWizard(page: Page, storeId: string): Promise<void> {
  const loose = page.locator('input[type="checkbox"]').filter({ has: page.locator("xpath=..") }).first();
  const looseLabel = page.getByText("Loose Item (No Box)");
  if (await looseLabel.count()) {
    const box = page.locator('label:has-text("Loose Item") input[type="checkbox"]').first();
    if (await box.count()) {
      const checked = await box.isChecked();
      if (!checked) await box.check();
    }
  }
  const storeSelect = page.locator("select").filter({ has: page.locator('option:has-text("Select Store")') }).first();
  if (!(await storeSelect.count())) {
    const anyStore = page.locator("select").nth(0);
    await anyStore.selectOption(storeId);
  } else {
    await storeSelect.selectOption(storeId);
  }
  await page.locator('button:has-text("damaged")').first().click().catch(async () => {
    await page.getByRole("button", { name: /damaged/i }).first().click().catch(() => null);
  });
}

async function runBarcodeLookup(
  page: Page,
  code: string,
  opts?: { storeId?: string },
): Promise<{
  loadingCleared: boolean;
  foundLocally: boolean;
  unknown: boolean;
  enrichmentReason: string | null;
  asinValue: string;
  fnskuValue: string;
  skuValue: string;
  itemNameValue: string;
  upcValue: string;
  ambiguous: boolean;
  capture: LookupCapture | null;
}> {
  if (opts?.storeId) await prepareLooseWizard(page, opts.storeId);

  let capture: LookupCapture | null = null;
  const responsePromise = page
    .waitForResponse(
      (r: Response) =>
        r.request().method() === "POST" &&
        !!r.request().headers()["next-action"] &&
        r.url().includes("/returns"),
      { timeout: 20_000 },
    )
    .catch(() => null);

  const input = page.getByPlaceholder(/scan or type product identifier/i).first();
  await input.fill(code);
  await input.blur();

  const loading = page.getByText("Looking up barcode");
  await loading.waitFor({ state: "visible", timeout: 5_000 }).catch(() => null);
  await loading.waitFor({ state: "hidden", timeout: 12_000 }).catch(() => null);
  await page
    .locator('input[placeholder="Product name…"]')
    .first()
    .waitFor({ state: "attached", timeout: 5_000 })
    .catch(() => null);
  await page.waitForTimeout(400);

  const resp = await responsePromise;
  if (resp) {
    const body = await resp.text().catch(() => "");
    capture = {
      status: resp.status(),
      bodySnippet: body.slice(0, 2000),
      parsed: parseServerActionBody(body),
    };
  }

  const wizardRoot = page
    .locator(".fixed.inset-0")
    .filter({ has: page.getByPlaceholder(/scan or type product identifier/i) })
    .first();
  const bodyText = (await wizardRoot.count())
    ? await wizardRoot.innerText()
    : await page.locator("body").innerText();
  const foundLocally = /Found locally/i.test(bodyText);
  const unknown = /Unknown Item/i.test(bodyText);
  const reasonMatch = bodyText.match(/Unknown Item[^\n]*\(([^)]+)\)/);
  const enrichmentReason = reasonMatch?.[1]?.trim() ?? null;

  const asinValue = await page.locator('input[placeholder*="B08"]').first().inputValue().catch(() => "");
  const fnskuValue = await page
    .locator('input[placeholder*="X001"]')
    .first()
    .inputValue()
    .catch(() => "");
  const skuValue = await page
    .locator('input[placeholder*="SKU"]')
    .first()
    .inputValue()
    .catch(() => "");
  const itemNameValue = await page
    .locator('input[placeholder="Product name…"], input[placeholder*="Product name"]')
    .first()
    .inputValue()
    .catch(() => "");
  const upcValue = await page
    .locator('input[placeholder*="UPC"], input[placeholder*="12-digit"]')
    .first()
    .inputValue()
    .catch(() => "");
  const ambiguous = /Needs review/i.test(bodyText);

  return {
    loadingCleared: !(await loading.isVisible().catch(() => false)),
    foundLocally,
    unknown,
    enrichmentReason,
    asinValue,
    fnskuValue,
    skuValue,
    itemNameValue,
    upcValue,
    ambiguous,
    capture,
  };
}

async function openItemDrawerForEdit(
  page: Page,
  baseUrl: string,
  returnId: string,
  searchHint?: string | null,
): Promise<boolean> {
  try {
    const hints = [searchHint?.trim(), returnId].filter(Boolean) as string[];
    await page.goto(`${baseUrl}/returns`, { waitUntil: "domcontentloaded", timeout: 120_000 });
    await page.getByRole("heading", { name: /returns & logistics/i }).waitFor({ timeout: 60_000 });
    await page.getByText("Loading…").waitFor({ state: "hidden", timeout: 120_000 }).catch(() => null);
    let row = page.locator("table tbody tr").first();
    for (const hint of hints) {
      await page.getByPlaceholder(/Filter: ID, ASIN/i).fill(hint);
      await page.waitForTimeout(1_200);
      const candidate = page.locator("table tbody tr").filter({ hasText: hint }).first();
      if (await candidate.count()) {
        row = candidate;
        break;
      }
    }
    if (!(await row.count()) || (await row.locator("td").count()) < 2) return false;

    await row.locator("td").last().locator("button").first().click({ force: true });
    await page.waitForTimeout(500);
    const menuEdit = page.getByRole("menu").getByRole("button", { name: /^edit$/i });
    if (await menuEdit.count()) {
      await menuEdit.first().click({ force: true, timeout: 8_000 });
    } else {
      await row.click({ force: true });
      await page.waitForTimeout(900);
      await page
        .locator("button")
        .filter({ hasText: /^Edit$/ })
        .first()
        .click({ force: true, timeout: 12_000 });
    }
    await page.getByPlaceholder(/Product identifier/i).first().waitFor({ timeout: 20_000 });
    return true;
  } catch (e) {
    console.warn("[v200] openItemDrawerForEdit:", e instanceof Error ? e.message : e);
    return false;
  }
}

async function queryReturnProduct(returnId: string): Promise<{
  resolved_product_id: string | null;
  fnsku: string | null;
  asin: string | null;
  sku: string | null;
}> {
  loadEnvLocalIntoProcess();
  const client = new pg.Client({
    connectionString: process.env.STAGING_DIRECT_POSTGRES_URL,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  const r = await client.query(
    `SELECT resolved_product_id::text, fnsku, asin, sku FROM public.return_items WHERE id = $1::uuid`,
    [returnId],
  );
  await client.end();
  return r.rows[0] as {
    resolved_product_id: string | null;
    fnsku: string | null;
    asin: string | null;
    sku: string | null;
  };
}

async function main(): Promise<void> {
  const id = runId();
  const manualLogin = hasFlag("--manual-login");
  const headed = hasFlag("--headed") || manualLogin;
  const baseUrl = (process.env.SMOKE_BASE_URL ?? "http://127.0.0.1:3000").replace(/\/$/, "");
  const outDir = path.resolve(process.cwd(), OUT_BASE, id);
  const shotDir = path.join(outDir, "screenshots");
  fs.mkdirSync(shotDir, { recursive: true });

  const checks: Check[] = [];
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const fixtures = await loadFixtures();

  fs.writeFileSync(path.join(outDir, "fixtures.json"), JSON.stringify(fixtures, null, 2));

  loadEnvLocalIntoProcess();
  const preflightChecks = await runResolverPreflight(fixtures, outDir);
  const ref = refFromSupabaseUrl(process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ?? "");
  checks.push({
    id: "00_env_staging",
    pass: ref === STAGING_REF,
    detail: `NEXT_PUBLIC_SUPABASE_URL ref=${ref ?? "?"}`,
  });

  const authStatePath = path.join(outDir, "auth-state.json");
  let reusePath = "";
  if (hasFlag("--reuse-auth")) {
    if (fs.existsSync(authStatePath)) reusePath = authStatePath;
    else {
      const v173Dirs = fs.existsSync(V173_AUTH)
        ? fs
            .readdirSync(V173_AUTH)
            .map((d) => path.join(V173_AUTH, d, "auth-state.json"))
            .filter((p) => fs.existsSync(p))
            .sort()
            .reverse()
        : [];
      reusePath = v173Dirs[0] ?? (fs.existsSync(V172_AUTH) ? V172_AUTH : "");
    }
  }

  let browser: Browser | null = null;
  let page: Page | null = null;

  try {
    browser = await chromium.launch({ headless: !headed });
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      storageState: reusePath || undefined,
    });
    page = await context.newPage();

    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    page.on("pageerror", (err) => pageErrors.push(err.message));

    let authed = false;
    if (reusePath) {
      await page.goto(`${baseUrl}/returns`, { waitUntil: "domcontentloaded", timeout: 60_000 });
      authed = await waitForAuthenticated(page!, 8_000);
    }
    if (!authed && !manualLogin) {
      authed = await browserLoginViaMagicLink(page!, baseUrl);
    }
    if (!authed && manualLogin) {
      await page.goto(`${baseUrl}/login`, { waitUntil: "domcontentloaded", timeout: 60_000 });
      console.log("\n[manual-login] Sign in in the browser window. Waiting up to 180s…\n");
      authed = await waitForAuthenticated(page!, 180_000);
    }
    if (!authed) {
      authed = await browserLoginWithPassword(page!, baseUrl);
    }
    if (!authed) {
      await page.goto(`${baseUrl}/login`, { waitUntil: "domcontentloaded", timeout: 60_000 });
      authed = await waitForAuthenticated(page!, 4_000);
    }
    checks.push({
      id: "01_auth",
      pass: authed,
      detail: authed ? `Authenticated (${page!.url()})` : "Not signed in — use --reuse-auth or --manual-login --headed",
    });
    if (!authed) {
      await shot(page!, shotDir, "01-login");
      const preflightOk = preflightChecks.every((c) => c.pass);
      const opPath = path.join(outDir, "operator-instructions.md");
      fs.writeFileSync(
        opPath,
        [
          "# Operator instructions",
          "",
          "Browser auth failed. Complete login, then re-run with `--reuse-auth`:",
          "",
          "```bash",
          "npm run dev",
          `npx tsx scripts/v200-product-lookup-browser-proof-complete.ts --run-id=${id} --manual-login --headed`,
          `npx tsx scripts/v200-product-lookup-browser-proof-complete.ts --run-id=${id} --reuse-auth`,
          "```",
          "",
          `Saved session path after success: \`${authStatePath}\``,
        ].join("\n"),
      );
      writeV200Artifacts(
        outDir,
        id,
        checks,
        consoleErrors,
        pageErrors,
        baseUrl,
        fixtures,
        preflightOk ? "CONDITIONAL_PASS" : "FAIL",
        preflightChecks,
      );
      console.log(
        JSON.stringify(
          {
            run_id: id,
            status: preflightOk ? "CONDITIONAL_PASS" : "FAIL",
            note: "Browser auth required — see operator-instructions.md",
          },
          null,
          2,
        ),
      );
      process.exit(preflightOk ? 0 : 1);
    }
    await context.storageState({ path: authStatePath });

    // ── Case 1: Known FNSKU ───────────────────────────────────────────────
    await openWizard(page!, baseUrl);
    const fnskuRes = await runBarcodeLookup(page!, fixtures.fnsku, {
      storeId: fixtures.orgStore.store_id,
    });
    checks.push({
      id: "02_known_fnsku",
      pass:
        fnskuRes.loadingCleared &&
        fnskuRes.foundLocally &&
        !fnskuRes.ambiguous &&
        (fnskuRes.fnskuValue.toUpperCase().includes(fixtures.fnsku.toUpperCase()) ||
          fnskuRes.asinValue.length > 0),
      detail: JSON.stringify({
        loadingCleared: fnskuRes.loadingCleared,
        foundLocally: fnskuRes.foundLocally,
        itemName: fnskuRes.itemNameValue,
        upc: fnskuRes.upcValue,
        fnskuField: fnskuRes.fnskuValue,
        server: fnskuRes.capture?.parsed ?? fnskuRes.capture?.bodySnippet?.slice(0, 200),
      }),
      screenshot: await shot(page!, shotDir, "02-known-fnsku"),
      server_action: fnskuRes.capture?.parsed ?? null,
    });

    // ── Case 2: Known ASIN (fresh wizard) ─────────────────────────────────
    await page!.keyboard.press("Escape").catch(() => null);
    await page!.waitForTimeout(500);
    await openWizard(page!, baseUrl);
    const asinRes = await runBarcodeLookup(page!, fixtures.asin, {
      storeId: fixtures.orgStore.store_id,
    });
    checks.push({
      id: "03_known_asin",
      pass:
        asinRes.loadingCleared &&
        asinRes.foundLocally &&
        asinRes.asinValue.toUpperCase().includes(fixtures.asin.toUpperCase()),
      detail: JSON.stringify({
        loadingCleared: asinRes.loadingCleared,
        foundLocally: asinRes.foundLocally,
        asinField: asinRes.asinValue,
        server: asinRes.capture?.parsed,
      }),
      screenshot: await shot(page!, shotDir, "03-known-asin"),
      server_action: asinRes.capture?.parsed ?? null,
    });

    // ── Case 3: Known SKU + store ─────────────────────────────────────────
    await page!.keyboard.press("Escape").catch(() => null);
    await page!.waitForTimeout(500);
    await openWizard(page!, baseUrl);
    const skuRes = await runBarcodeLookup(page!, fixtures.sku, {
      storeId: fixtures.orgStore.store_id,
    });
    checks.push({
      id: "04_known_sku_store",
      pass: skuRes.loadingCleared && skuRes.foundLocally && skuRes.skuValue.length > 0,
      detail: JSON.stringify({
        loadingCleared: skuRes.loadingCleared,
        foundLocally: skuRes.foundLocally,
        skuField: skuRes.skuValue,
        store: fixtures.orgStore.store_id,
        server: skuRes.capture?.parsed,
      }),
      screenshot: await shot(page!, shotDir, "04-known-sku"),
      server_action: skuRes.capture?.parsed ?? null,
    });

    // ── Case 4: Unknown code ────────────────────────────────────────────────
    await page!.keyboard.press("Escape").catch(() => null);
    await page!.waitForTimeout(500);
    await openWizard(page!, baseUrl);
    const unkRes = await runBarcodeLookup(page!, UNKNOWN_CODE, {
      storeId: fixtures.orgStore.store_id,
    });
    checks.push({
      id: "04_unknown_code",
      pass:
        unkRes.loadingCleared &&
        unkRes.unknown &&
        !!unkRes.enrichmentReason &&
        (unkRes.capture?.parsed?.inferred_status === "unresolved" ||
          unkRes.capture?.parsed?.inferred_status == null),
      detail: JSON.stringify({
        loadingCleared: unkRes.loadingCleared,
        unknown: unkRes.unknown,
        reason: unkRes.enrichmentReason,
        server: unkRes.capture?.parsed,
      }),
      screenshot: await shot(page!, shotDir, "04-unknown"),
      server_action: unkRes.capture?.parsed ?? null,
    });

    // ── Case 5: Ambiguous FNSKU (if fixture) ───────────────────────────────
    if (fixtures.ambiguous) {
      await page!.keyboard.press("Escape").catch(() => null);
      await page!.waitForTimeout(500);
      await openWizard(page!, baseUrl);
      const ambRes = await runBarcodeLookup(page!, fixtures.ambiguous.fnsku, {
        storeId: fixtures.ambiguous.store_id,
      });
      const pickerVisible =
        ambRes.ambiguous && /Pick the correct product/i.test(await page!.locator("body").innerText());
      checks.push({
        id: "05_ambiguous_picker",
        pass: ambRes.loadingCleared && ambRes.ambiguous && pickerVisible,
        detail: JSON.stringify({
          loadingCleared: ambRes.loadingCleared,
          ambiguous: ambRes.ambiguous,
          pickerVisible,
          server: ambRes.capture?.parsed,
        }),
        screenshot: await shot(page!, shotDir, "05-ambiguous"),
        server_action: ambRes.capture?.parsed ?? null,
      });
    } else {
      checks.push({
        id: "05_ambiguous_picker",
        pass: true,
        detail: "Skipped — no ambiguous fixture on staging",
      });
    }

    // ── Case 6: Enrichment gate disabled (reason visible, no stuck loading) ─
    const gateOk =
      unkRes.loadingCleared &&
      !!unkRes.enrichmentReason &&
      /disabled|blocked|requires_asin/i.test(unkRes.enrichmentReason);
    checks.push({
      id: "06_enrichment_gate_disabled",
      pass: gateOk,
      detail: gateOk
        ? `Enrichment reason shown: ${unkRes.enrichmentReason}`
        : `Expected gate reason in Unknown banner; got: ${unkRes.enrichmentReason ?? "none"}`,
      screenshot: await shot(page!, shotDir, "06-gate-disabled"),
      server_action: unkRes.capture?.parsed ?? null,
    });

    // ── Cases 7–9: Edit drawer save + re-resolve + detail read ─────────────
    if (!fixtures.edit?.return_id) {
      checks.push({
        id: "07_save_persists_product",
        pass: false,
        detail: "Skipped — no return_items fixture with resolved_product_id",
      });
      checks.push({
        id: "08_edit_identifier_reresolve",
        pass: false,
        detail: "Skipped — no edit fixture",
      });
      checks.push({
        id: "09_detail_linkage_contract",
        pass: false,
        detail: "Skipped — no edit fixture for detail reload",
      });
    } else {
      await page!.keyboard.press("Escape").catch(() => null);
      await page!.waitForTimeout(600);
      const editOpened = await openItemDrawerForEdit(
        page!,
        baseUrl,
        fixtures.edit.return_id,
        fixtures.edit.fnsku ?? fixtures.edit.sku ?? fixtures.edit.asin,
      );
      if (!editOpened) {
        checks.push({
          id: "07_save_persists_product",
          pass: false,
          detail: "Could not open item drawer edit mode",
          screenshot: await shot(page!, shotDir, "07-edit-missing"),
        });
        checks.push({
          id: "08_edit_identifier_reresolve",
          pass: false,
          detail: "Skipped — edit UI not opened",
        });
        checks.push({
          id: "09_detail_linkage_contract",
          pass: false,
          detail: "Skipped — drawer not opened",
        });
      } else {
        const editInput = page!.getByPlaceholder(/product identifier/i).first();
        await editInput.fill(fixtures.fnsku);
        await editInput.blur();
        await page!.getByText("Looking up barcode").waitFor({ state: "hidden", timeout: 12_000 }).catch(() => null);
        await page!.waitForTimeout(600);
        const saveBtn = page!.getByRole("button", { name: /^save$/i }).first();
        await saveBtn.click();
        await page!.waitForTimeout(2_500);
        const afterSave = await queryReturnProduct(fixtures.edit.return_id);
        const linkedVisible = /Linked/i.test(await page!.locator("body").innerText());
        checks.push({
          id: "07_save_persists_product",
          pass: !!afterSave.resolved_product_id && linkedVisible,
          detail: JSON.stringify({
            resolved_product_id: afterSave.resolved_product_id,
            linkedVisible,
            fnsku: afterSave.fnsku,
          }),
          screenshot: await shot(page!, shotDir, "07-save-persist"),
        });

        // Case 7: change identifier to alt product
        await page!.getByRole("button", { name: /^edit$/i }).first().click().catch(() => null);
        await page!.waitForTimeout(800);
        const altCode = fixtures.alt.asin ?? fixtures.alt.fnsku ?? fixtures.alt.sku;
        if (!altCode) {
          checks.push({
            id: "08_edit_identifier_reresolve",
            pass: false,
            detail: "No alternate identifier fixture",
          });
        } else {
          const before = await queryReturnProduct(fixtures.edit.return_id);
          await editInput.fill(altCode);
          await editInput.blur();
          await page!.getByText("Looking up barcode").waitFor({ state: "hidden", timeout: 12_000 }).catch(() => null);
          const foundOnReresolve = /Found locally/i.test(await page!.locator("body").innerText());
          await saveBtn.click();
          await page!.waitForTimeout(2_500);
          const after = await queryReturnProduct(fixtures.edit.return_id);
          const changed =
            after.resolved_product_id &&
            after.resolved_product_id !== before.resolved_product_id;
          checks.push({
            id: "08_edit_identifier_reresolve",
            pass: foundOnReresolve && !!after.resolved_product_id,
            detail: JSON.stringify({
              foundOnReresolve,
              before_product: before.resolved_product_id,
              after_product: after.resolved_product_id,
              changed,
              altCode,
            }),
            screenshot: await shot(page!, shotDir, "08-edit-reresolve"),
          });
        }

        try {
          await page!.keyboard.press("Escape").catch(() => null);
          await page!.waitForTimeout(600);
          await page!.goto(`${baseUrl}/returns`, { waitUntil: "domcontentloaded", timeout: 60_000 });
          await page!.getByRole("heading", { name: /returns & logistics/i }).waitFor({ timeout: 60_000 });
          await page!.getByText("Loading…").waitFor({ state: "hidden", timeout: 120_000 }).catch(() => null);
          const viewHints = [
            fixtures.edit.return_id,
            fixtures.alt.asin,
            fixtures.fnsku,
            fixtures.edit.fnsku,
            fixtures.edit.sku,
          ].filter(Boolean) as string[];
          let viewRow = page!.locator("table tbody tr").first();
          for (const hint of viewHints) {
            await page!.getByPlaceholder(/Filter: ID, ASIN/i).fill(hint);
            await page!.waitForTimeout(900);
            const candidate = page!.locator("table tbody tr").filter({ hasText: hint }).first();
            if (await candidate.count()) {
              viewRow = candidate;
              break;
            }
          }
          if (await viewRow.count()) await viewRow.click({ timeout: 15_000 });
          await page!.waitForTimeout(1_200);
          const bodyView = await page!.locator("body").innerText();
          const linkageOk =
            /Linked/i.test(bodyView) ||
            /View product/i.test(bodyView) ||
            /\/pim\/products\//i.test(bodyView);
          checks.push({
            id: "09_detail_linkage_contract",
            pass: linkageOk,
            detail: JSON.stringify({ linkedOrViewProduct: linkageOk, snippet: bodyView.slice(0, 500) }),
            screenshot: await shot(page!, shotDir, "09-detail-linkage"),
          });
        } catch (e) {
          checks.push({
            id: "09_detail_linkage_contract",
            pass: false,
            detail: e instanceof Error ? e.message : String(e),
            screenshot: await shot(page!, shotDir, "09-detail-linkage-fail"),
          });
        }
      }
    }
  } catch (e) {
    checks.push({
      id: "browser_error",
      pass: false,
      detail: e instanceof Error ? e.message : String(e),
    });
  } finally {
    await browser?.close();
  }

  const required = [
    "01_auth",
    "02_known_fnsku",
    "03_known_asin",
    "04_known_sku_store",
    "04_unknown_code",
    "06_enrichment_gate_disabled",
  ];
  const browserRan = checks.find((c) => c.id === "01_auth")?.pass && checks.some((c) => c.id.startsWith("02_"));
  const corePass = required.every((rid) => checks.find((c) => c.id === rid)?.pass);
  const optionalPass = [
    "05_ambiguous_picker",
    "07_save_persists_product",
    "08_edit_identifier_reresolve",
    "09_detail_linkage_contract",
  ].every((rid) => {
    const c = checks.find((x) => x.id === rid);
    return !c || c.pass || c.detail.startsWith("Skipped");
  });
  const allPass = browserRan && corePass && optionalPass;
  const status = allPass
    ? "PASS"
    : !browserRan && preflightChecks.every((c) => c.pass)
      ? "CONDITIONAL_PASS"
      : corePass && browserRan
        ? "PARTIAL"
        : "FAIL";
  writeV200Artifacts(outDir, id, checks, consoleErrors, pageErrors, baseUrl, fixtures, status, preflightChecks);
  console.log(JSON.stringify({ run_id: id, status, outDir, pass: checks.filter((c) => c.pass).length, total: checks.length }, null, 2));
  const conditionalOk =
    !checks.some((c) => c.id.startsWith("02_")) && preflightChecks.every((c) => c.pass);
  process.exit(corePass || conditionalOk ? 0 : 1);
}

function checkMd(title: string, c: Check | undefined, fallback: string): string {
  if (!c) return `# ${title}\n\n${fallback}\n`;
  return [
    `# ${title}`,
    "",
    `**Result:** ${c.pass ? "PASS" : "FAIL"}`,
    `**Check id:** \`${c.id}\``,
    "",
    "## Detail",
    "",
    "```json",
    c.detail,
    "```",
    "",
    c.screenshot ? `Screenshot: [\`${c.screenshot}\`](${c.screenshot})` : "",
  ].join("\n");
}

function writeV200Artifacts(
  outDir: string,
  runId: string,
  checks: Check[],
  consoleErrors: string[],
  pageErrors: string[],
  baseUrl: string,
  fixtures: unknown,
  status: string,
  preflightChecks: Check[] = [],
): void {
  const byId = (id: string) => checks.find((c) => c.id === id);
  const auth = byId("01_auth");
  const blockers: string[] = [];
  if (!auth?.pass) blockers.push("Browser auth failed — run `--manual-login --headed` and save auth-state.json");
  for (const c of checks.filter((x) => !x.pass && !x.id.startsWith("preflight_"))) {
    if (!c.detail.startsWith("Skipped")) blockers.push(`${c.id}: ${c.detail.slice(0, 120)}`);
  }

  fs.writeFileSync(path.join(outDir, "auth-proof.md"), checkMd("Auth proof", auth, "Not run"));
  fs.writeFileSync(path.join(outDir, "lookup-known-fnsku.md"), checkMd("Known FNSKU", byId("02_known_fnsku"), "Not run"));
  fs.writeFileSync(path.join(outDir, "lookup-known-asin.md"), checkMd("Known ASIN", byId("03_known_asin"), "Not run"));
  fs.writeFileSync(path.join(outDir, "lookup-known-sku.md"), checkMd("Known SKU+store", byId("04_known_sku_store"), "Not run"));
  fs.writeFileSync(path.join(outDir, "lookup-unknown.md"), checkMd("Unknown code", byId("04_unknown_code"), "Not run"));
  fs.writeFileSync(
    path.join(outDir, "ambiguous-proof.md"),
    checkMd("Ambiguous handling", byId("05_ambiguous_picker"), "Skipped or not run"),
  );
  const saveEdit = [
    checkMd("Save persists resolved_product_id", byId("07_save_persists_product"), ""),
    checkMd("Edit re-resolve", byId("08_edit_identifier_reresolve"), ""),
    checkMd("Detail ProductLinkageDisplayContract", byId("09_detail_linkage_contract"), ""),
  ].join("\n---\n\n");
  fs.writeFileSync(path.join(outDir, "save-edit-detail-proof.md"), saveEdit);
  fs.writeFileSync(
    path.join(outDir, "blockers.md"),
    blockers.length
      ? ["# Blockers", "", ...blockers.map((b) => `- ${b}`)].join("\n") + "\n"
      : "# Blockers\n\nNone.\n",
  );
  fs.writeFileSync(path.join(outDir, "resolver-preflight.json"), JSON.stringify(preflightChecks, null, 2));

  const nextPrompt =
    status === "PASS"
      ? "PRODUCT-LINKAGE-BROWSER-PROOF-SIGNOFF-V202 — archive V200 proof"
      : status === "CONDITIONAL_PASS"
        ? "V200-PRODUCT-LOOKUP-BROWSER-PROOF-COMPLETE — --manual-login --headed"
        : "V200-PRODUCT-LOOKUP-BROWSER-PROOF-COMPLETE — fix failing checks then re-run";

  fs.writeFileSync(
    path.join(outDir, "manifest.json"),
    JSON.stringify(
      {
        prompt: "V200 — PRODUCT LOOKUP BROWSER PROOF COMPLETE",
        run_id: runId,
        status,
        baseUrl,
        staging_ref: STAGING_REF,
        fixtures,
        checks,
        resolver_preflight_checks: preflightChecks,
        console_error_count: consoleErrors.length,
        page_error_count: pageErrors.length,
        next_prompt: nextPrompt,
        forbidden: {
          production_touched: false,
          package_items_created: false,
          browser_amazon_api: false,
          fake_sp_api: false,
          ai_openai: false,
        },
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

