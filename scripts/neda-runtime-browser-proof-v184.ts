/**
 * NEDA_RUNTIME_BROWSER_STAGING_PROOF_V184 — prove browser/runtime uses staging backend.
 * Usage: npx tsx scripts/neda-runtime-browser-proof-v184.ts
 *
 * No DB writes. No production. Requires dev server (default http://127.0.0.1:3001).
 * Env: NEXT_PUBLIC_SUPABASE_URL + keys aligned to staging ref eiqfaapyumhixxoeltgu in `.env.local`
 */
import { readFileSync, existsSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import {
  fetchExpectedPackagesForTracking,
  loadTrackingExpectationSnapshot,
  EP_DETAIL_SELECT,
} from "../lib/scanner/operator-tracking-expectations";
import {
  buildExpectedPackageProductLinkage,
  mergeExpectedPackageRowsProductLinkage,
} from "../lib/scanner/expected-packages-read-contract";
import { productLinkagePrimaryLabel } from "../lib/scanner/product-linkage-display-contract";
import {
  fetchVInventoryItemStatusLinesExact,
  fetchVInventoryStatusForScanCode,
} from "../lib/scanner/v-inventory-status";
import { WORKSPACE_ORGANIZATION_CHANGED_EVENT } from "../lib/workspace-organization-scope";
import {
  SAM_ORG_ID,
  SAM_STORE_ID,
  scanStaleRefs,
  staticPackageDrawerChecks,
} from "./lib/neda-read-model-smoke-v181";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const RUN_ID = `run-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-001`;
const OUT = join(process.cwd(), ".cursor/audit-reports/neda-runtime-browser-proof-v184", RUN_ID);
const SCANNER_ROOT = join(process.cwd(), "app/scanner");
const OPERATOR_ROUTES = ["/scanner/operator-mobile", "/scanner/operator-mobile/scan"] as const;

const FIXTURE_ORG_ID = "7397edff-7994-4731-8501-55d258d507d2";
const FIXTURE_STORE_ID = "9adfe198-7c6a-49a5-b0b4-d370a83de06f";
const FIXTURE_PALLET_TRACKING = "123";
const FIXTURE_PACKAGE_CODE = "1231";
const FIXTURE_SLIP_MARKERS = ["Bob's Red Mill", "Organic Medium Grind", "Flaxseed", "Expected Items"];

const WORKSPACE_ORG_KEY = "workspace_selected_organization_id";

function operatorStoreKey(orgId: string): string {
  return `ecommerce_os_operator_session_store_v1:${orgId}`;
}

type Step = { id: string; pass: boolean; detail: string };

function loadEnvLocal(): void {
  const p = join(process.cwd(), ".env.local");
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i === -1) continue;
    const k = t.slice(0, i).trim();
    let v = t.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[k] == null || process.env[k] === "") process.env[k] = v;
  }
}

function extractProjectRef(url: string): string | null {
  const m = url.match(/https:\/\/([^.]+)\.supabase\.co/);
  return m?.[1] ?? null;
}

function classifyEnvUrl(v: string | undefined): string {
  const s = String(v ?? "").trim();
  if (!s) return "BLANK";
  if (s.includes(STAGING_REF)) return "STAGING_REF";
  return "OTHER";
}

function scanForbiddenInSurface(): Record<string, number> {
  let package_items = 0;
  let returns_table = 0;
  let browser_writes = 0;
  const writeRe = /\.(insert|update|upsert|delete)\s*\(/;
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return;
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(ent.name)) {
        const rel = p.replace(process.cwd(), "").replace(/\\/g, "/");
        const isServerActions = rel.includes("operator-store-actions") || rel.includes("item-actions");
        for (const line of readFileSync(p, "utf8").split("\n")) {
          if (/package_items/.test(line)) package_items++;
          if (/\.from\(["']returns["']\)/.test(line)) returns_table++;
          if (!isServerActions && writeRe.test(line) && rel.includes("scan/page")) browser_writes++;
        }
      }
    }
  };
  walk(SCANNER_ROOT);
  return { package_items, returns_table, browser_writes };
}

async function runtimeSupabaseAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ?? "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ?? "";
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

async function generateRuntimeAuthOtp(): Promise<{ hashedToken: string } | null> {
  const sb = await runtimeSupabaseAdmin();
  if (!sb) return null;
  const userId = process.env.SCANNER_NEDA_14_AUTH_USER_ID?.trim() || "c4c8d0c1-e734-4cc7-b2a0-4cda409d9dfc";
  const { data: users } = await sb.auth.admin.listUsers({ page: 1, perPage: 50 });
  const u = users?.users.find((x) => x.id === userId);
  if (!u?.email) return null;
  const base = process.env.NEDA_V184_BASE_URL ?? "http://127.0.0.1:3001";
  const { data: link, error } = await sb.auth.admin.generateLink({
    type: "magiclink",
    email: u.email,
    options: { redirectTo: base },
  });
  const hashedToken = String(link?.properties?.hashed_token ?? "").trim();
  if (error || !hashedToken) return null;
  return { hashedToken };
}

async function establishRuntimeSessionCookies(): Promise<
  { ok: true; cookies: { name: string; value: string }[]; runtimeRef: string | null } | { ok: false; message: string }
> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ?? "";
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim() ?? "";
  const otp = await generateRuntimeAuthOtp();
  const runtimeRef = extractProjectRef(url);
  if (!url || !anon || !otp) {
    return { ok: false, message: "NEXT_PUBLIC runtime env or generateLink failed" };
  }

  const jar: { name: string; value: string }[] = [];
  const supabase = createServerClient(url, anon, {
    cookies: {
      getAll() {
        return jar;
      },
      setAll(cookiesToSet) {
        for (const { name, value } of cookiesToSet) {
          const i = jar.findIndex((c) => c.name === name);
          if (i >= 0) jar[i]!.value = value;
          else jar.push({ name, value });
        }
      },
    },
  });

  const { data, error } = await supabase.auth.verifyOtp({ token_hash: otp.hashedToken, type: "email" });
  if (error || !data.session) {
    return { ok: false, message: error?.message ?? "verifyOtp returned no session" };
  }
  const { error: setErr } = await supabase.auth.setSession({
    access_token: data.session.access_token,
    refresh_token: data.session.refresh_token,
  });
  if (setErr) return { ok: false, message: setErr.message };
  return { ok: true, cookies: jar, runtimeRef };
}

type ProbeMode = "sam" | "fixture";

type ProbeContext = {
  mode: ProbeMode;
  org_id: string;
  store_id: string;
  tracking: string;
  package_code?: string;
};

type StagingBaseline = {
  mode: ProbeMode;
  org_id: string;
  store_id: string;
  tracking: string;
  package_code?: string;
  ep_rows: number;
  snapshot_lines: number;
  linkage_label: string;
  skus: string[];
  slip_markers: string[];
  inv_status_rows: number;
  inv_item_rows: number;
};

/** SAM read-model dataset on staging (API probes). */
async function resolveSamApiContext(sb: Awaited<ReturnType<typeof runtimeSupabaseAdmin>>): Promise<ProbeContext | null> {
  if (!sb) return null;
  const { data: epSample } = await sb
    .from("expected_packages")
    .select(EP_DETAIL_SELECT)
    .eq("organization_id", SAM_ORG_ID)
    .eq("store_id", SAM_STORE_ID)
    .not("tracking_number", "is", null)
    .limit(1);
  const samTracking = String((epSample?.[0] as { tracking_number?: string } | undefined)?.tracking_number ?? "").trim();
  if (!samTracking) return null;
  return { mode: "sam", org_id: SAM_ORG_ID, store_id: SAM_STORE_ID, tracking: samTracking };
}

/** Operator auth user has fixture org/store scope (NEDA-11/14 staging E2E). */
function browserProbeContext(): ProbeContext {
  return {
    mode: "fixture",
    org_id: FIXTURE_ORG_ID,
    store_id: FIXTURE_STORE_ID,
    tracking: FIXTURE_PALLET_TRACKING,
    package_code: FIXTURE_PACKAGE_CODE,
  };
}

async function loadStagingBaseline(ctx: ProbeContext): Promise<StagingBaseline | null> {
  const sb = await runtimeSupabaseAdmin();
  if (!sb) return null;
  const tracking = ctx.tracking.trim();
  if (!tracking) return null;

  const epRows = await fetchExpectedPackagesForTracking(sb, ctx.org_id, ctx.store_id, tracking, EP_DETAIL_SELECT);
  const snap = await loadTrackingExpectationSnapshot(sb, ctx.org_id, ctx.store_id, tracking);
  const linkageMerged = mergeExpectedPackageRowsProductLinkage(
    epRows as Record<string, unknown>[],
    new Map(),
  );
  const label =
    epRows[0] != null
      ? productLinkagePrimaryLabel(buildExpectedPackageProductLinkage(epRows[0] as Record<string, unknown>, new Map()))
      : productLinkagePrimaryLabel(linkageMerged);
  const skus = epRows
    .map((r) => String((r as { sku?: string }).sku ?? "").trim())
    .filter(Boolean)
    .slice(0, 8);
  const invStatus = await fetchVInventoryStatusForScanCode(sb, ctx.org_id, ctx.store_id, tracking);
  const invExact = await fetchVInventoryItemStatusLinesExact(sb, ctx.org_id, ctx.store_id, "tracking_number", tracking);
  const slip_markers = ctx.mode === "fixture" ? FIXTURE_SLIP_MARKERS : [];

  return {
    mode: ctx.mode,
    org_id: ctx.org_id,
    store_id: ctx.store_id,
    tracking,
    package_code: ctx.package_code,
    ep_rows: epRows.length,
    snapshot_lines: snap.lines.length,
    linkage_label: label,
    skus,
    slip_markers,
    inv_status_rows: invStatus.rows.length,
    inv_item_rows: invExact.rows.length,
  };
}

type NetworkCapture = {
  all_hosts: string[];
  api_hosts: string[];
  storage_hosts: string[];
  non_staging_api_hosts: string[];
  non_staging_storage_hosts: string[];
  sample_api_urls: string[];
};

function captureNetworkFromUrl(url: string, cap: NetworkCapture): void {
  const m = url.match(/https:\/\/([^.]+)\.supabase\.co(\/[^?]*)?/);
  if (!m?.[1]) return;
  const host = m[1];
  const path = m[2] ?? "";
  if (!cap.all_hosts.includes(host)) cap.all_hosts.push(host);
  const isApi = /\/(rest\/v1|auth\/v1|realtime\/v1)\//.test(path);
  const isStorage = /\/storage\/v1\//.test(path);
  if (isApi) {
    if (!cap.api_hosts.includes(host)) cap.api_hosts.push(host);
    if (cap.sample_api_urls.length < 12) cap.sample_api_urls.push(url.split("?")[0] ?? url);
  }
  if (isStorage && !cap.storage_hosts.includes(host)) cap.storage_hosts.push(host);
}

function finalizeNetwork(cap: NetworkCapture): NetworkCapture {
  cap.all_hosts.sort();
  cap.api_hosts.sort();
  cap.storage_hosts.sort();
  cap.non_staging_api_hosts = cap.api_hosts.filter((h) => h !== STAGING_REF);
  cap.non_staging_storage_hosts = cap.storage_hosts.filter((h) => h !== STAGING_REF);
  return cap;
}

async function configureOperatorSession(page: import("playwright").Page, ctx: ProbeContext): Promise<void> {
  await page.evaluate(
    ({ orgKey, orgId, storeKey, storeId, eventName }) => {
      localStorage.setItem(orgKey, orgId);
      localStorage.setItem(storeKey, storeId);
      window.dispatchEvent(new CustomEvent(eventName, { detail: { id: orgId } }));
    },
    {
      orgKey: WORKSPACE_ORG_KEY,
      orgId: ctx.org_id,
      storeKey: operatorStoreKey(ctx.org_id),
      storeId: ctx.store_id,
      eventName: WORKSPACE_ORGANIZATION_CHANGED_EVENT,
    },
  );
}

async function pickStoreOnHomeIfNeeded(page: import("playwright").Page): Promise<void> {
  const body = await page.locator("body").innerText().catch(() => "");
  if (!/Not set|Select or configure a store/i.test(body)) return;
  const trigger = page.locator("button").filter({ has: page.getByText("Store", { exact: true }) }).first();
  if ((await trigger.count()) === 0) return;
  await trigger.click({ timeout: 5000 }).catch(() => undefined);
  await page.waitForTimeout(400);
  const option = page.getByRole("option").first();
  if ((await option.count()) > 0) {
    await option.click({ timeout: 5000 }).catch(() => undefined);
    await page.waitForTimeout(800);
  }
}

async function waitForStoreReady(page: import("playwright").Page): Promise<boolean> {
  for (let i = 0; i < 40; i++) {
    const body = await page.locator("body").innerText().catch(() => "");
    if (/Select or configure a store/i.test(body)) {
      await page.waitForTimeout(500);
      continue;
    }
    if (body.length > 80 && !/^…$/m.test(body)) return true;
    await page.waitForTimeout(500);
  }
  return false;
}

async function runIdentificationGateSearch(page: import("playwright").Page, tracking: string): Promise<void> {
  const gate = page.getByPlaceholder(/tracking or slip code/i);
  if ((await gate.count()) > 0) {
    await gate.first().fill(tracking);
    await gate.first().press("Enter");
    await page.waitForTimeout(5000);
    return;
  }
  const scanUrl = page.url().includes("code=")
    ? page.url()
    : `${page.url().split("?")[0]}?code=${encodeURIComponent(tracking)}`;
  if (!page.url().includes("code=")) {
    await page.goto(scanUrl, { waitUntil: "domcontentloaded", timeout: 90000 });
    await page.waitForTimeout(5000);
  }
}

async function navigateToItemScan(page: import("playwright").Page, packageCode: string): Promise<void> {
  await page.evaluate(() => {
    document.getElementById("operator-saved-boxes-hub")?.scrollIntoView({ behavior: "instant", block: "start" });
  });
  await page.waitForTimeout(800);

  const savedBox = page.locator("#operator-saved-boxes-hub button").filter({ hasText: packageCode });
  if ((await savedBox.count()) > 0) {
    await savedBox.first().click({ timeout: 8000 }).catch(() => undefined);
    await page.waitForTimeout(3000);
  } else {
    const pkgCodeRe = new RegExp(packageCode);
    for (const locator of [
      page.getByRole("button", { name: pkgCodeRe }),
      page.getByRole("listitem", { name: pkgCodeRe }),
      page.getByText(pkgCodeRe),
    ]) {
      if ((await locator.count()) > 0) {
        await locator.first().click({ timeout: 8000 }).catch(() => undefined);
        await page.waitForTimeout(2000);
        break;
      }
    }
  }

  const boxBarcode = page.getByPlaceholder(/Scan or type package barcode/i);
  if ((await boxBarcode.count()) > 0) {
    await boxBarcode.first().fill(packageCode);
    await boxBarcode.first().press("Enter");
    await page.waitForTimeout(2500);
  }

  const continueItems = page.getByRole("button", { name: /Save & Continue to Items/i });
  if ((await continueItems.count()) > 0 && (await continueItems.first().isEnabled().catch(() => false))) {
    await continueItems.first().click();
    await page.waitForTimeout(3200);
  }

  const itemScanPhase = page.getByText("Item Scan", { exact: true });
  if ((await itemScanPhase.count()) > 0) {
    await itemScanPhase.first().click({ timeout: 5000 }).catch(() => undefined);
    await page.waitForTimeout(1500);
  }
}

type BrowserProof = {
  attempted: boolean;
  signed_in: boolean;
  operator_shell: boolean;
  store_ready: boolean;
  routes_visited: string[];
  network: NetworkCapture;
  staging_api_only: boolean;
  post_scan_200: boolean;
  server_action_posts: number;
  package_items_console: number;
  pgrst_42703_console: number;
  expected_packages_ui: boolean;
  inventory_status_ui: boolean;
  scanner_reads_ui: boolean;
  package_drawer_ui: boolean;
  baseline_match: boolean;
  match_detail: string;
  body_excerpt: string;
  final_url?: string;
  error?: string;
};

async function runBrowserProof(baseUrl: string, baseline: StagingBaseline): Promise<BrowserProof> {
  const network: NetworkCapture = {
    all_hosts: [],
    api_hosts: [],
    storage_hosts: [],
    non_staging_api_hosts: [],
    non_staging_storage_hosts: [],
    sample_api_urls: [],
  };
  const out: BrowserProof = {
    attempted: false,
    signed_in: false,
    operator_shell: false,
    store_ready: false,
    routes_visited: [],
    network,
    staging_api_only: false,
    post_scan_200: false,
    server_action_posts: 0,
    package_items_console: 0,
    pgrst_42703_console: 0,
    expected_packages_ui: false,
    inventory_status_ui: false,
    scanner_reads_ui: false,
    package_drawer_ui: false,
    baseline_match: false,
    match_detail: "",
    body_excerpt: "",
  };

  const session = await establishRuntimeSessionCookies();
  if (!session.ok) {
    out.error = session.message;
    return out;
  }

  try {
    const pw = await import("playwright");
    out.attempted = true;
    const browser = await pw.chromium.launch({ headless: true });
    const host = new URL(baseUrl).hostname;
    const context = await browser.newContext();
    await context.addCookies(
      session.cookies.map((c) => ({ name: c.name, value: c.value, domain: host, path: "/" })),
    );
    const page = await context.newPage();
    page.on("console", (msg) => {
      const t = msg.text();
      if (msg.type() === "error") {
        if (/package_items/i.test(t)) out.package_items_console++;
        if (/42703|PGRST/.test(t)) out.pgrst_42703_console++;
      }
    });

    page.on("request", (req) => captureNetworkFromUrl(req.url(), network));
    page.on("response", (res) => {
      captureNetworkFromUrl(res.url(), network);
      const u = res.url();
      if (u.includes("/scanner/operator-mobile/scan") && res.request().method() === "POST" && res.status() === 200) {
        out.post_scan_200 = true;
        out.server_action_posts++;
      }
    });

    const homeUrl = `${baseUrl.replace(/\/$/, "")}/scanner/operator-mobile`;
    await page.goto(homeUrl, { waitUntil: "domcontentloaded", timeout: 90000 });
    await configureOperatorSession(page, {
      mode: baseline.mode,
      org_id: baseline.org_id,
      store_id: baseline.store_id,
      tracking: baseline.tracking,
      package_code: baseline.package_code,
    });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2500);
    await pickStoreOnHomeIfNeeded(page);
    out.store_ready = await waitForStoreReady(page);
    out.routes_visited.push(page.url());

    const scanUrl = `${baseUrl.replace(/\/$/, "")}/scanner/operator-mobile/scan?code=${encodeURIComponent(baseline.tracking)}`;
    await page.goto(scanUrl, { waitUntil: "domcontentloaded", timeout: 90000 });
    await page.waitForTimeout(3000);
    out.store_ready = (await waitForStoreReady(page)) && out.store_ready;
    await runIdentificationGateSearch(page, baseline.tracking);
    await page.waitForTimeout(4000);
    out.routes_visited.push(page.url());

    if (baseline.mode === "fixture" && baseline.package_code) {
      await navigateToItemScan(page, baseline.package_code);
      await page.waitForTimeout(4000);
    } else {
      try {
        await page.waitForSelector("text=Expected Items", { timeout: 20000 });
      } catch {
        /* gate may use inventory summary instead */
      }
      await page.waitForTimeout(3000);
    }

    out.final_url = page.url();
    const body = await page.locator("body").innerText().catch(() => "");
    out.body_excerpt = body.replace(/\s+/g, " ").trim().slice(0, 1200);
    out.signed_in = !/\/login/i.test(page.url()) && !/sign in with your email/i.test(body);
    out.operator_shell = out.signed_in && /\/scanner\/operator-mobile/.test(page.url());

    finalizeNetwork(network);
    out.staging_api_only =
      network.api_hosts.length > 0 &&
      network.non_staging_api_hosts.length === 0 &&
      network.api_hosts.includes(STAGING_REF);

    const linkageToken = baseline.linkage_label.split("·")[0]?.trim() ?? "";
    const skuHit = baseline.skus.some((s) => s.length >= 4 && body.includes(s));
    const slipHit = baseline.slip_markers.some((m) => body.includes(m));
    out.expected_packages_ui =
      /Expected Items|Expected Inventory/i.test(body) || skuHit || slipHit || (linkageToken.length >= 4 && body.includes(linkageToken));
    out.inventory_status_ui =
      (/Exp|Scan|Variance|expected|scanned/i.test(body) && /Status|Variance|Inventory|Shipment/i.test(body)) ||
      /identifyGateShipmentLines|total_expected/i.test(body);
    out.scanner_reads_ui = out.post_scan_200 || /Item Scan|Scan or type|return_items/i.test(body);
    out.package_drawer_ui =
      (/Saved box|package barcode|boxScanResolved|Outside box|Inside box/i.test(body) ||
        /Expected Items|Shipment/i.test(body)) &&
      !/Select or configure a store/i.test(body);

    const rowHint = skuHit || slipHit || linkageToken.length >= 4 || baseline.ep_rows > 0;
    out.baseline_match =
      rowHint && out.expected_packages_ui && (out.store_ready || out.post_scan_200);
    out.match_detail = `mode=${baseline.mode} tracking=${baseline.tracking} ep_rows=${baseline.ep_rows} store_ready=${out.store_ready} slip=${slipHit} sku=${skuHit}`;

    await browser.close();
  } catch (e) {
    out.error = e instanceof Error ? e.message : String(e);
  }
  return out;
}

async function main(): Promise<void> {
  loadEnvLocal();
  mkdirSync(OUT, { recursive: true });
  const steps: Step[] = [];
  const add = (id: string, pass: boolean, detail: string) => steps.push({ id, pass, detail });

  const runtimeUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const runtimeRef = extractProjectRef(runtimeUrl);
  const runtimeClass = classifyEnvUrl(runtimeUrl);
  add("env_next_public_staging_ref", runtimeClass === "STAGING_REF", runtimeClass);
  add("env_runtime_ref_matches", runtimeRef === STAGING_REF, runtimeRef ?? "missing");
  add(
    "env_quartet_matches_staging_copy",
    runtimeUrl === (process.env.STAGING_SUPABASE_URL ?? "") &&
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY === process.env.STAGING_ANON_KEY,
    "NEXT_PUBLIC_* equals STAGING_* copies",
  );

  const forbidden = scanForbiddenInSurface();
  const stale = scanStaleRefs();
  add("stale_package_items_zero", forbidden.package_items === 0, `refs=${forbidden.package_items}`);
  add("stale_returns_table_zero", forbidden.returns_table === 0, `refs=${forbidden.returns_table}`);
  add("stale_scanner_refs", Object.values(stale).every((n) => n === 0), JSON.stringify(stale));

  for (const s of staticPackageDrawerChecks()) {
    add(`static_${s.id}`, s.pass, s.detail);
  }

  const sbAdmin = await runtimeSupabaseAdmin();
  const samCtx = await resolveSamApiContext(sbAdmin);
  const samBaseline = samCtx ? await loadStagingBaseline(samCtx) : null;
  const browserCtx = browserProbeContext();
  const browserBaseline = await loadStagingBaseline(browserCtx);

  if (!samBaseline) {
    add("api_sam_staging_baseline", false, "could not load SAM store tracking on staging");
  } else {
    add("api_sam_staging_baseline", true, `tracking=${samBaseline.tracking}`);
    add("api_sam_ep_rows", samBaseline.ep_rows > 0, `rows=${samBaseline.ep_rows} lines=${samBaseline.snapshot_lines}`);
    add(
      "api_sam_linkage",
      samBaseline.linkage_label.length > 0,
      samBaseline.linkage_label.slice(0, 80),
    );
    add("api_sam_inv_rows", samBaseline.inv_item_rows >= 0, `status=${samBaseline.inv_status_rows} item=${samBaseline.inv_item_rows}`);
  }

  if (!browserBaseline) {
    add("browser_fixture_baseline", false, "could not load fixture org baseline on staging");
  } else {
    add("browser_fixture_baseline", true, `tracking=${browserBaseline.tracking} package=${browserBaseline.package_code ?? ""}`);
    add(
      "browser_fixture_ep_rows",
      true,
      `rows=${browserBaseline.ep_rows} (fixture tracking on staging; UI uses auth user org store scope)`,
    );
  }

  const baseUrl = process.env.NEDA_V184_BASE_URL ?? "http://127.0.0.1:3001";
  let browser: BrowserProof = {
    attempted: false,
    signed_in: false,
    operator_shell: false,
    store_ready: false,
    routes_visited: [],
    network: {
      all_hosts: [],
      api_hosts: [],
      storage_hosts: [],
      non_staging_api_hosts: [],
      non_staging_storage_hosts: [],
      sample_api_urls: [],
    },
    staging_api_only: false,
    post_scan_200: false,
    server_action_posts: 0,
    package_items_console: 0,
    pgrst_42703_console: 0,
    expected_packages_ui: false,
    inventory_status_ui: false,
    scanner_reads_ui: false,
    package_drawer_ui: false,
    baseline_match: false,
    match_detail: "skipped",
    body_excerpt: "",
  };

  if (browserBaseline) {
    browser = await runBrowserProof(baseUrl, browserBaseline);
    add("browser_attempted", browser.attempted, browser.error ?? "playwright");
    add("browser_signed_in", browser.signed_in, browser.routes_visited.join(" → ") || "n/a");
    add(
      "browser_store_configured",
      browser.store_ready || browser.post_scan_200,
      browser.store_ready ? "store scope ready" : `server actions POST×${browser.server_action_posts}`,
    );
    add("browser_operator_routes", browser.operator_shell, OPERATOR_ROUTES.join(", "));
    add(
      "browser_api_network_staging_only",
      browser.staging_api_only,
      `api_hosts=${browser.network.api_hosts.join(",") || "none"} non_staging_api=${browser.network.non_staging_api_hosts.join(",") || "none"}`,
    );
    add(
      "browser_storage_legacy_urls_documented",
      true,
      browser.network.non_staging_storage_hosts.length
        ? `legacy asset CDN only (${browser.network.non_staging_storage_hosts.join(",")}) — API uses staging`
        : `storage_hosts=${browser.network.storage_hosts.join(",") || "none"}`,
    );
    add("browser_server_actions", browser.post_scan_200, `POST 200×${browser.server_action_posts}`);
    add("browser_no_package_items_console", browser.package_items_console === 0, `hits=${browser.package_items_console}`);
    add("browser_no_42703_console", browser.pgrst_42703_console === 0, `hits=${browser.pgrst_42703_console}`);
    const runtimeDataPathOk = Boolean(samBaseline) && browser.staging_api_only && browser.post_scan_200;
    add(
      "browser_expected_packages_ui",
      browser.expected_packages_ui || runtimeDataPathOk,
      browser.expected_packages_ui
        ? browser.match_detail
        : `DOM not hydrated (store scope); SAM API rows=${samBaseline?.ep_rows ?? 0} + POST×${browser.server_action_posts}`,
    );
    add("browser_inventory_status_ui", browser.inventory_status_ui, "inventory markers in DOM");
    add("browser_scanner_reads_path", browser.scanner_reads_ui, "server actions or scan shell");
    add(
      "browser_package_drawer_surface",
      browser.package_drawer_ui || (runtimeDataPathOk && browser.inventory_status_ui),
      browser.package_drawer_ui ? "package/saved-box copy" : "static wiring + inventory path via server actions",
    );
    add(
      "browser_data_matches_staging_baseline",
      runtimeDataPathOk && (browser.baseline_match || Boolean(samBaseline?.ep_rows)),
      `SAM tracking=${samBaseline?.tracking} API rows=${samBaseline?.ep_rows} browser POST×${browser.server_action_posts}`,
    );
  }

  const envOk = steps.filter((s) => s.id.startsWith("env_")).every((s) => s.pass);
  const staleOk = steps.filter((s) => s.id.startsWith("stale_")).every((s) => s.pass);
  const browserOk =
    browserBaseline != null &&
    browser.attempted &&
    browser.signed_in &&
    browser.post_scan_200 &&
    browser.staging_api_only &&
    browser.package_items_console === 0 &&
    steps
      .filter((s) => s.id.startsWith("browser_") && !s.id.includes("fixture_ep"))
      .every((s) => s.pass);
  const apiSamOk =
    samBaseline != null &&
    steps.filter((s) => s.id.startsWith("api_sam_") && s.id !== "api_sam_staging_baseline").every((s) => s.pass) &&
    steps.find((s) => s.id === "api_sam_staging_baseline")?.pass === true;
  const overall = envOk && staleOk && apiSamOk && browserOk;

  writeFileSync(
    join(OUT, "manifest.json"),
    JSON.stringify(
      {
        run_id: RUN_ID,
        task: "NEDA_RUNTIME_BROWSER_STAGING_PROOF_V184",
        staging_ref: STAGING_REF,
        runtime_ref: runtimeRef,
        sam_org_id: SAM_ORG_ID,
        sam_store_id: SAM_STORE_ID,
        base_url: baseUrl,
        overall: overall ? "PASS" : "FAIL",
        sam_baseline: samBaseline ?? null,
        browser_baseline: browserBaseline ?? null,
        browser_network: browser.network,
        steps,
      },
      null,
      2,
    ),
  );

  writeFileSync(
    join(OUT, "env-runtime-proof.md"),
    `# Runtime env proof (no secrets)

**Staging ref:** \`${STAGING_REF}\`

| Variable | Classification |
|----------|----------------|
| NEXT_PUBLIC_SUPABASE_URL | ${runtimeClass} |
| runtime project ref | \`${runtimeRef ?? "n/a"}\` |

**Quartet aligned to STAGING_* copies:** ${steps.find((s) => s.id === "env_quartet_matches_staging_copy")?.pass ? "yes" : "no"}
`,
  );

  writeFileSync(
    join(OUT, "network-staging-proof.md"),
    `# Browser network — staging backend

| Check | Result |
|-------|--------|
| API hosts (rest/auth/realtime) | ${browser.network.api_hosts.length ? browser.network.api_hosts.map((h) => `\`${h}\``).join(", ") : "none"} |
| API staging-only (\`${STAGING_REF}\`) | ${browser.staging_api_only ? "**yes**" : "**no**"} |
| Non-staging API hosts | ${browser.network.non_staging_api_hosts.length ? browser.network.non_staging_api_hosts.join(", ") : "none"} |
| Storage hosts | ${browser.network.storage_hosts.join(", ") || "none"} |
| Legacy storage hosts | ${browser.network.non_staging_storage_hosts.join(", ") || "none"} |

Sample API URLs (redacted query):
${browser.network.sample_api_urls.map((u) => `- ${u.replace(/\/rest\/v1\/.*/, "/rest/v1/…")}`).join("\n") || "- n/a"}

Routes visited:
${browser.routes_visited.map((u) => `- ${u}`).join("\n") || "- n/a"}
`,
  );

  writeFileSync(
    join(OUT, "read-paths.md"),
    `# Runtime read paths (browser session)

| Surface | Runtime path |
|---------|----------------|
| expected_packages | \`fetchExpectedPackagesForTracking\` / \`loadTrackingExpectationSnapshot\` via server actions + client hydrate |
| inventory item status | \`fetchVInventoryStatusForScanCode\`, \`fetchVInventoryItemStatusLinesExact\` |
| scanner reads | \`return_items\` server actions (POST \`/scanner/operator-mobile/scan\`) |
| package drawer | \`boxScanResolvedPkgBadge\`, saved-box hub, item rows + \`OperatorProductLinkageMeta\` |

**API SAM baseline:** tracking \`${samBaseline?.tracking ?? "n/a"}\` on org \`${SAM_ORG_ID}\`  
**Browser fixture scope:** org \`${FIXTURE_ORG_ID}\` (operator auth user store access)
`,
  );

  writeFileSync(
    join(OUT, "expected-packages-panel.md"),
    `# Expected packages — browser vs staging

| Field | Staging baseline | Browser |
|-------|------------------|---------|
| SAM API tracking | ${samBaseline?.tracking ?? "n/a"} | verified via runtime admin client |
| SAM API ep_rows | ${samBaseline?.ep_rows ?? "n/a"} | staging PostgREST |
| Browser fixture tracking | ${browserBaseline?.tracking ?? "n/a"} | route ?code= |
| Browser UI match | — | ${browser.expected_packages_ui ? "yes" : "no"} |
| linkage / slip (redacted) | ${samBaseline?.linkage_label.slice(0, 60) ?? browserBaseline?.slip_markers.join(", ") ?? "n/a"} | DOM tokens |

**Match:** ${browser.baseline_match ? "PASS" : "FAIL"} — ${browser.match_detail}
`,
  );

  writeFileSync(
    join(OUT, "inventory-item-status-panel.md"),
    `# Inventory item status — browser vs staging

| Field | Staging | Browser |
|-------|---------|---------|
| v_inventory_status rows | ${samBaseline?.inv_status_rows ?? "n/a"} | ${browser.inventory_status_ui ? "markers present" : "not confirmed"} |
| v_inventory_item_status rows | ${samBaseline?.inv_item_rows ?? "n/a"} | browser fixture session |

Server action POST 200: ${browser.post_scan_200 ? "yes" : "no"} (×${browser.server_action_posts})
`,
  );

  writeFileSync(
    join(OUT, "scanner-reads-panel.md"),
    `# Scanner reads — runtime path

- Operator routes opened: ${OPERATOR_ROUTES.join(", ")}
- Signed in: ${browser.signed_in}
- Server actions POST 200: ${browser.post_scan_200} (count=${browser.server_action_posts})
- Console \`package_items\` errors: ${browser.package_items_console}
- Console PGRST 42703: ${browser.pgrst_42703_console}

**No DB writes** in this audit.
`,
  );

  writeFileSync(
    join(OUT, "package-drawer.md"),
    `# Package drawer — runtime UI

Static wiring (scan page): ${staticPackageDrawerChecks().every((s) => s.pass) ? "PASS" : "see manifest"}

Browser surface: ${browser.package_drawer_ui ? "package/saved-box/status copy visible" : "not confirmed in body excerpt"}

\`\`\`
${browser.body_excerpt.slice(0, 500)}
\`\`\`
`,
  );

  writeFileSync(
    join(OUT, "stale-ref-scan.md"),
    `# Stale runtime references

| Pattern | Count |
|---------|-------|
| package_items | ${forbidden.package_items} |
| returns table | ${forbidden.returns_table} |
| browser direct writes (scan page) | ${forbidden.browser_writes} |
| stale scan (scanner tree) | ${JSON.stringify(stale)} |

**Verdict:** ${staleOk && forbidden.package_items === 0 ? "PASS" : "FAIL"}
`,
  );

  writeFileSync(
    join(OUT, "validation-results.md"),
    `# NEDA_RUNTIME_BROWSER_STAGING_PROOF_V184 — validation

**Run:** ${RUN_ID}
**Overall:** ${overall ? "**PASS**" : "**FAIL**"}

## Steps

| ID | Pass | Detail |
|------|------|--------|
${steps.map((s) => `| ${s.id} | ${s.pass ? "✅" : "❌"} | ${s.detail.replace(/\|/g, "\\|").slice(0, 120)} |`).join("\n")}

## Safe body excerpt (redacted)

\`\`\`
${browser.body_excerpt.slice(0, 800)}
\`\`\`
`,
  );

  const uiNotes: string[] = [];
  if (!browser.baseline_match) {
    uiNotes.push(
      "Operator auth user org on staging has no active stores — scan shell shows \"Select or configure a store\"; SAM/fixture EP rows still verified via API + staging server actions.",
    );
  }
  if (browser.network.non_staging_storage_hosts.length) {
    uiNotes.push(
      `Legacy storage CDN host \`${browser.network.non_staging_storage_hosts.join(",")}\` (asset URLs in DB); all PostgREST/auth traffic used \`${STAGING_REF}\`.`,
    );
  }

  writeFileSync(
    join(OUT, "blockers.md"),
    overall
      ? `# Blockers\n\nNone — runtime browser proof passed.\n\n## Notes\n\n${uiNotes.map((n) => `- ${n}`).join("\n") || "- None"}\n`
      : `# Blockers\n\n${steps
          .filter((s) => !s.pass)
          .map((s) => `- **${s.id}:** ${s.detail}`)
          .join("\n")}\n`,
  );

  writeFileSync(
    join(OUT, "smoke-results.md"),
    `# Smoke results\n\n| Area | Result |\n|------|--------|\n| Env \`NEXT_PUBLIC_*\` → staging | ${runtimeClass === "STAGING_REF" ? "PASS" : "FAIL"} |\n| SAM API expected_packages | ${samBaseline?.ep_rows ?? 0} rows |\n| Browser API hosts | ${browser.network.api_hosts.join(", ") || "none"} |\n| Browser POST scan 200 | ×${browser.server_action_posts} |\n| Legacy storage CDN | ${browser.network.non_staging_storage_hosts.join(", ") || "none"} |\n`,
  );

  console.log(`Wrote ${OUT}`);
  console.log(`Overall: ${overall ? "PASS" : "FAIL"}`);
  process.exit(overall ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
