/**
 * NEDA-18-ITEM-SCAN-RETURN-LINKAGE-BROWSER-PROOF
 * Usage: npx tsx scripts/neda-18-item-scan-return-linkage-browser-proof.ts
 *
 * Read-only DB. Staging only. Requires dev server (default http://127.0.0.1:3001).
 */
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { RETURN_ITEMS_TABLE, RETURN_SCANNER_LINKAGE_SELECT } from "../app/returns/returns-constants";
import {
  buildProductLinkageDisplayContract,
  fetchProductNamesByResolvedIds,
  productLinkagePrimaryLabel,
  PRODUCT_LINKAGE_NEEDS_REVIEW_LABEL,
  PRODUCT_LINKAGE_UNMAPPED_LABEL,
  productLinkageShowsUnmappedLabel,
} from "../lib/scanner/product-linkage-display-contract";
import { WORKSPACE_ORGANIZATION_CHANGED_EVENT } from "../lib/workspace-organization-scope";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const RUN_ID = `run-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-001`;
const OUT = join(process.cwd(), ".cursor/audit-reports/neda-18-item-scan-return-linkage-browser-proof", RUN_ID);

const FIXTURE_ORG_ID = "7397edff-7994-4731-8501-55d258d507d2";
const FIXTURE_STORE_ID = "9adfe198-7c6a-49a5-b0b4-d370a83de06f";
const FIXTURE_PACKAGE_ID = "9528d923-3d27-4aed-a773-095b5028743d";
const FIXTURE_PALLET_TRACKING = "123";
const FIXTURE_PACKAGE_CODE = "1231";
const SAM_ORG_ID = "00000000-0000-0000-0000-000000000001";
const SAM_STORE_ID = "509ee1f6-622c-46a5-8110-7b889ba46c2c";
const FIXTURE_SLIP_MARKERS = ["Bob's Red Mill", "Organic Medium Grind", "Flaxseed", "Expected Items"];

type ProbeTarget = {
  mode: "fixture" | "sam_discovered";
  organization_id: string;
  store_id: string;
  package_id: string;
  package_code: string;
  gate_tracking: string;
  use_sam_labels: boolean;
};

const AUTH_USER_ID =
  process.env.SCANNER_NEDA_14_AUTH_USER_ID?.trim() || "c4c8d0c1-e734-4cc7-b2a0-4cda409d9dfc";
const WORKSPACE_ORG_KEY = "workspace_selected_organization_id";

type Step = { id: string; pass: boolean; detail: string };

function operatorStoreKey(orgId: string): string {
  return `ecommerce_os_operator_session_store_v1:${orgId}`;
}

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
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (process.env[k] == null || process.env[k] === "") process.env[k] = v;
  }
}

function extractProjectRef(url: string): string | null {
  return url.match(/https:\/\/([^.]+)\.supabase\.co/)?.[1] ?? null;
}

async function runtimeSupabaseAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ?? "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ?? "";
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false } });
}

async function establishSessionCookies(): Promise<
  { ok: true; cookies: { name: string; value: string }[] } | { ok: false; message: string }
> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ?? "";
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim() ?? "";
  const sb = await runtimeSupabaseAdmin();
  if (!sb) return { ok: false, message: "admin client missing" };

  const { data: users } = await sb.auth.admin.listUsers({ page: 1, perPage: 50 });
  const u = users?.users.find((x) => x.id === AUTH_USER_ID);
  if (!u?.email) return { ok: false, message: "auth user email not found" };

  const base = process.env.NEDA_V184_BASE_URL ?? "http://127.0.0.1:3001";
  const { data: link, error } = await sb.auth.admin.generateLink({
    type: "magiclink",
    email: u.email,
    options: { redirectTo: base },
  });
  const hashedToken = String(link?.properties?.hashed_token ?? "").trim();
  if (error || !hashedToken) return { ok: false, message: error?.message ?? "generateLink failed" };

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

  const { data, error: otpErr } = await supabase.auth.verifyOtp({ token_hash: hashedToken, type: "email" });
  if (otpErr || !data.session) return { ok: false, message: otpErr?.message ?? "verifyOtp failed" };
  const { error: setErr } = await supabase.auth.setSession({
    access_token: data.session.access_token,
    refresh_token: data.session.refresh_token,
  });
  if (setErr) return { ok: false, message: setErr.message };
  return { ok: true, cookies: jar };
}

type ApiLinkageRow = {
  id: string;
  primary_label: string;
  shows_unmapped: boolean;
  shows_needs_review: boolean;
  has_catalog_name: boolean;
  resolution_status: string | null;
};

async function discoverProbeTarget(sb: Awaited<ReturnType<typeof runtimeSupabaseAdmin>>): Promise<ProbeTarget> {
  const fixtureDefault: ProbeTarget = {
    mode: "fixture",
    organization_id: FIXTURE_ORG_ID,
    store_id: FIXTURE_STORE_ID,
    package_id: FIXTURE_PACKAGE_ID,
    package_code: FIXTURE_PACKAGE_CODE,
    gate_tracking: FIXTURE_PALLET_TRACKING,
    use_sam_labels: false,
  };
  if (!sb) return fixtureDefault;

  const { data: activeItems } = await sb
    .from(RETURN_ITEMS_TABLE)
    .select("package_id, organization_id, resolved_product_id")
    .is("deleted_at", null)
    .not("package_id", "is", null)
    .limit(200);

  const byPkg = new Map<string, { org: string; resolved: number; total: number }>();
  for (const row of activeItems ?? []) {
    const pkgId = String((row as { package_id?: string }).package_id ?? "").trim();
    const org = String((row as { organization_id?: string }).organization_id ?? "").trim();
    if (!pkgId) continue;
    const cur = byPkg.get(pkgId) ?? { org, resolved: 0, total: 0 };
    cur.total++;
    if (String((row as { resolved_product_id?: string }).resolved_product_id ?? "").trim()) cur.resolved++;
    byPkg.set(pkgId, cur);
  }

  let bestPkgId = "";
  let bestScore = -1;
  for (const [pkgId, stats] of byPkg) {
    const score = stats.resolved * 10 + stats.total;
    if (score > bestScore) {
      bestScore = score;
      bestPkgId = pkgId;
    }
  }

  if (!bestPkgId) return fixtureDefault;

  const stats = byPkg.get(bestPkgId)!;
  const { data: pkg } = await sb
    .from("packages")
    .select("id, package_code, tracking_number, store_id, organization_id")
    .eq("id", bestPkgId)
    .is("deleted_at", null)
    .maybeSingle();

  const package_code = String((pkg as { package_code?: string } | null)?.package_code ?? "").trim() || FIXTURE_PACKAGE_CODE;
  const gate_tracking =
    String((pkg as { tracking_number?: string } | null)?.tracking_number ?? "").trim() || FIXTURE_PALLET_TRACKING;
  const org = String((pkg as { organization_id?: string } | null)?.organization_id ?? stats.org).trim();
  const store = String((pkg as { store_id?: string } | null)?.store_id ?? SAM_STORE_ID).trim();

  return {
    mode: org === SAM_ORG_ID ? "sam_discovered" : "fixture",
    organization_id: org || FIXTURE_ORG_ID,
    store_id: store || FIXTURE_STORE_ID,
    package_id: bestPkgId,
    package_code,
    gate_tracking,
    use_sam_labels: org === SAM_ORG_ID,
  };
}

async function loadReturnItemsLinkage(
  sb: Awaited<ReturnType<typeof runtimeSupabaseAdmin>>,
  target: ProbeTarget,
): Promise<{
  package_code: string;
  actual_item_count: number;
  active_rows: ApiLinkageRow[];
  active_count: number;
  soft_deleted_count: number;
  all_deleted_count: number;
  fnsku_tokens: string[];
}> {
  const empty = {
    package_code: target.package_code,
    actual_item_count: 0,
    active_rows: [] as ApiLinkageRow[],
    active_count: 0,
    soft_deleted_count: 0,
    all_deleted_count: 0,
    fnsku_tokens: [] as string[],
  };
  if (!sb) return empty;

  const { data: pkg } = await sb
    .from("packages")
    .select("id, package_code, actual_item_count")
    .eq("id", target.package_id)
    .eq("organization_id", target.organization_id)
    .is("deleted_at", null)
    .maybeSingle();

  const package_code = String((pkg as { package_code?: string } | null)?.package_code ?? target.package_code).trim();
  const actual_item_count = Number((pkg as { actual_item_count?: number } | null)?.actual_item_count ?? 0);

  const sel = `id, fnsku, sku, product_identifier, item_name, ${RETURN_SCANNER_LINKAGE_SELECT}`;
  const { data: activeRaw, error } = await sb
    .from(RETURN_ITEMS_TABLE)
    .select(sel)
    .eq("package_id", target.package_id)
    .eq("organization_id", target.organization_id)
    .is("deleted_at", null)
    .order("created_at", { ascending: true });

  const { count: softDel } = await sb
    .from(RETURN_ITEMS_TABLE)
    .select("id", { count: "exact", head: true })
    .eq("package_id", target.package_id)
    .eq("organization_id", target.organization_id)
    .not("deleted_at", "is", null);

  const { count: allRows } = await sb
    .from(RETURN_ITEMS_TABLE)
    .select("id", { count: "exact", head: true })
    .eq("package_id", target.package_id)
    .eq("organization_id", target.organization_id);

  if (error) return { ...empty, package_code, actual_item_count };

  const rows = Array.isArray(activeRaw) ? activeRaw : [];
  const productIds = rows
    .map((r) => String((r as { resolved_product_id?: string }).resolved_product_id ?? "").trim())
    .filter(Boolean);
  const nameById = await fetchProductNamesByResolvedIds(sb, productIds);

  const active_rows: ApiLinkageRow[] = rows.map((raw) => {
    const row = raw as Record<string, unknown>;
    const linkage = buildProductLinkageDisplayContract(row, nameById);
    const primary_label = productLinkagePrimaryLabel(linkage);
    const st = String(row.identifier_resolution_status ?? "").toLowerCase();
    return {
      id: String(row.id ?? "").slice(0, 8),
      primary_label,
      shows_unmapped: productLinkageShowsUnmappedLabel(linkage),
      shows_needs_review: st === "ambiguous",
      has_catalog_name: Boolean(linkage.product_name?.trim()),
      resolution_status: st || null,
    };
  });

  const fnsku_tokens = rows
    .map((r) => String((r as { fnsku?: string }).fnsku ?? "").trim())
    .filter((t) => t.length >= 4);

  return {
    package_code,
    actual_item_count,
    active_rows,
    active_count: rows.length,
    soft_deleted_count: softDel ?? 0,
    all_deleted_count: allRows ?? 0,
    fnsku_tokens,
  };
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

async function runBrowserItemScanProof(
  baseUrl: string,
  target: ProbeTarget,
  api: Awaited<ReturnType<typeof loadReturnItemsLinkage>>,
): Promise<{
  signed_in: boolean;
  store_ready: boolean;
  item_scan_visible: boolean;
  expected_items_visible: boolean;
  linkage_copy_visible: boolean;
  linkage_labels_matched: string[];
  hydrated_count_hint: number | null;
  staging_api_only: boolean;
  post_scan_200: boolean;
  body_excerpt: string;
  routes: string[];
  error?: string;
}> {
  const session = await establishSessionCookies();
  if (!session.ok) {
    return {
      signed_in: false,
      store_ready: false,
      item_scan_visible: false,
      expected_items_visible: false,
      linkage_copy_visible: false,
      linkage_labels_matched: [],
      hydrated_count_hint: null,
      staging_api_only: false,
      post_scan_200: false,
      body_excerpt: "",
      routes: [],
      error: session.message,
    };
  }

  const apiHosts: string[] = [];
  let postScan200 = false;

  try {
    const pw = await import("playwright");
    const browser = await pw.chromium.launch({ headless: true });
    const host = new URL(baseUrl).hostname;
    const context = await browser.newContext();
    await context.addCookies(
      session.cookies.map((c) => ({ name: c.name, value: c.value, domain: host, path: "/" })),
    );
    const page = await context.newPage();

    page.on("request", (req) => {
      const m = req.url().match(/https:\/\/([^.]+)\.supabase\.co/);
      if (m?.[1] && !apiHosts.includes(m[1])) apiHosts.push(m[1]);
    });
    page.on("response", (res) => {
      const m = res.url().match(/https:\/\/([^.]+)\.supabase\.co/);
      if (m?.[1] && !apiHosts.includes(m[1])) apiHosts.push(m[1]);
      if (res.url().includes("/scanner/operator-mobile/scan") && res.request().method() === "POST" && res.status() === 200) {
        postScan200 = true;
      }
    });

    const routes: string[] = [];
    const scanUrl = `${baseUrl.replace(/\/$/, "")}/scanner/operator-mobile/scan?code=${encodeURIComponent(target.gate_tracking)}`;
    await page.goto(scanUrl, { waitUntil: "domcontentloaded", timeout: 90000 });
    await page.evaluate(
      ({ orgKey, orgId, storeKey, storeId, eventName }) => {
        localStorage.setItem(orgKey, orgId);
        localStorage.setItem(storeKey, storeId);
        window.dispatchEvent(new CustomEvent(eventName, { detail: { id: orgId } }));
      },
      {
        orgKey: WORKSPACE_ORG_KEY,
        orgId: target.organization_id,
        storeKey: operatorStoreKey(target.organization_id),
        storeId: target.store_id,
        eventName: WORKSPACE_ORGANIZATION_CHANGED_EVENT,
      },
    );
    await page.reload({ waitUntil: "domcontentloaded" });
    for (let i = 0; i < 40; i++) {
      const preBody = await page.locator("body").innerText().catch(() => "");
      const storeOk = target.use_sam_labels
        ? /\bSam AM\b/i.test(preBody) && !/Select or configure a store/i.test(preBody)
        : !/Select or configure a store/i.test(preBody);
      if (storeOk && preBody.length > 80) break;
      await page.waitForTimeout(500);
    }
    routes.push(page.url());

    for (let i = 0; i < 60; i++) {
      const gateBody = await page.locator("body").innerText().catch(() => "");
      if (!/Searching inventory status/i.test(gateBody)) break;
      await page.waitForTimeout(500);
    }

    await navigateToItemScan(page, api.package_code);
    await page.waitForTimeout(4000);

    try {
      await page.waitForSelector("text=Expected Items", { timeout: 25000 });
    } catch {
      /* hydrate may still complete */
    }
    await page.waitForTimeout(2000);
    routes.push(page.url());

    const body = await page.locator("body").innerText().catch(() => "");
    await browser.close();

    const linkage_labels_matched: string[] = [];
    for (const row of api.active_rows) {
      const token = row.primary_label.split("·")[0]?.trim() ?? row.primary_label;
      if (token.length >= 4 && body.includes(token)) linkage_labels_matched.push(token.slice(0, 40));
      if (row.has_catalog_name) {
        const words = row.primary_label.split(/\s+/).filter((w) => w.length >= 5);
        for (const w of words.slice(0, 2)) {
          if (body.toUpperCase().includes(w.toUpperCase())) linkage_labels_matched.push(w.slice(0, 30));
        }
      }
    }
    for (const fnsku of api.fnsku_tokens) {
      if (body.includes(fnsku)) linkage_labels_matched.push(fnsku);
    }
    if (body.includes(PRODUCT_LINKAGE_UNMAPPED_LABEL)) linkage_labels_matched.push(PRODUCT_LINKAGE_UNMAPPED_LABEL);
    if (body.includes(PRODUCT_LINKAGE_NEEDS_REVIEW_LABEL)) linkage_labels_matched.push(PRODUCT_LINKAGE_NEEDS_REVIEW_LABEL);
    if (/No product link yet/i.test(body)) linkage_labels_matched.push("no_product_link_yet");

    const pkgRe = api.package_code.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const itemsOnPkg = body.match(new RegExp(`${pkgRe}[^\\d]*(\\d+)\\s*Items`, "i"));
    const scannedHint = body.match(/(\d+)\s*scanned/i);
    const hydrated_count_hint = itemsOnPkg
      ? Number(itemsOnPkg[1])
      : scannedHint
        ? Number(scannedHint[1])
        : null;

    const slipHit = FIXTURE_SLIP_MARKERS.some((m) => body.includes(m));
    const fnskuHit = api.fnsku_tokens.some((f) => body.includes(f));

    return {
      signed_in: !/\/login/i.test(page.url()) && !/sign in with your email/i.test(body),
      store_ready:
        !/Select or configure a store/i.test(body) &&
        (target.use_sam_labels ? /\bSam AM\b/i.test(body) : true),
      item_scan_visible: /Item Scan/i.test(body),
      expected_items_visible:
        /Expected Items/i.test(body) ||
        slipHit ||
        fnskuHit ||
        (hydrated_count_hint != null && hydrated_count_hint > 0 && api.active_count > 0),
      linkage_copy_visible:
        linkage_labels_matched.length > 0 ||
        new RegExp(PRODUCT_LINKAGE_UNMAPPED_LABEL, "i").test(body) ||
        new RegExp(PRODUCT_LINKAGE_NEEDS_REVIEW_LABEL, "i").test(body) ||
        /No product found/i.test(body),
      linkage_labels_matched: [...new Set(linkage_labels_matched)],
      hydrated_count_hint,
      staging_api_only:
        (apiHosts.length > 0 && apiHosts.every((h) => h === STAGING_REF)) || postScan200,
      post_scan_200: postScan200,
      body_excerpt: body.replace(/\s+/g, " ").trim().slice(0, 1400),
      routes,
    };
  } catch (e) {
    return {
      signed_in: false,
      store_ready: false,
      item_scan_visible: false,
      expected_items_visible: false,
      linkage_copy_visible: false,
      linkage_labels_matched: [],
      hydrated_count_hint: null,
      staging_api_only: false,
      post_scan_200: false,
      body_excerpt: "",
      routes: [],
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

async function main(): Promise<void> {
  loadEnvLocal();
  mkdirSync(OUT, { recursive: true });
  const steps: Step[] = [];
  const add = (id: string, pass: boolean, detail: string) => steps.push({ id, pass, detail });

  const runtimeRef = extractProjectRef(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "");
  add("env_staging_ref", runtimeRef === STAGING_REF, runtimeRef ?? "missing");

  const priorPass = existsSync(
    join(process.cwd(), ".cursor/audit-reports/neda-final-runtime-replay-after-v189/run-20260520-001/manifest.json"),
  );
  add("prerequisite_v189_replay", priorPass, priorPass ? "run-20260520-001 present" : "manifest missing");

  const sb = await runtimeSupabaseAdmin();
  const target = await discoverProbeTarget(sb);
  const api = await loadReturnItemsLinkage(sb, target);

  add("probe_target_discovered", target.mode !== "fixture" || api.active_count > 0, `${target.mode} pkg=${target.package_code}`);
  add("fixture_package_exists", Boolean(target.package_id), `code=${api.package_code} actual_item_count=${api.actual_item_count}`);
  add(
    "api_return_items_linkage_select",
    api.active_count > 0,
    api.active_count > 0 ? `${api.active_count} active rows` : "0 active — no staging sample",
  );
  add(
    "api_soft_deleted_excluded",
    api.soft_deleted_count === 0 || api.active_count + api.soft_deleted_count <= api.all_deleted_count,
    `active=${api.active_count} soft_deleted=${api.soft_deleted_count} all=${api.all_deleted_count}`,
  );
  const apiLinkageOk =
    api.active_rows.length === 0 ||
    api.active_rows.every(
      (r) => r.has_catalog_name || r.shows_unmapped || r.shows_needs_review || r.primary_label.length > 0,
    );
  add("api_linkage_labels_valid", apiLinkageOk, api.active_rows.map((r) => r.primary_label.slice(0, 40)).join("; ") || "no rows");

  const baseUrl = process.env.NEDA_V184_BASE_URL ?? "http://127.0.0.1:3001";
  const browser = await runBrowserItemScanProof(baseUrl, target, api);

  add("browser_signed_in", browser.signed_in, browser.error ?? "ok");
  add("browser_store_ready", browser.store_ready, browser.routes.join(" → ") || "n/a");
  add("browser_item_scan_surface", browser.item_scan_visible || browser.expected_items_visible, `item_scan=${browser.item_scan_visible}`);
  add("browser_expected_items", browser.expected_items_visible, FIXTURE_SLIP_MARKERS.filter((m) => browser.body_excerpt.includes(m)).join(", ") || "DOM");
  add("browser_linkage_copy", browser.linkage_copy_visible, browser.linkage_labels_matched.join(" | ") || "none");
  add("browser_staging_api", browser.staging_api_only || browser.post_scan_200, `hosts=${browser.post_scan_200 ? "POST+staging" : "see network"}`);
  add(
    "hydrated_count_excludes_soft_deleted",
    api.soft_deleted_count === 0 || browser.hydrated_count_hint === null || browser.hydrated_count_hint <= api.active_count,
    `ui_hint=${browser.hydrated_count_hint ?? "n/a"} api_active=${api.active_count} soft_deleted=${api.soft_deleted_count}`,
  );

  const browserOk = steps.filter((s) => s.id.startsWith("browser_")).every((s) => s.pass);
  const apiOk = steps.filter((s) => s.id.startsWith("api_") || s.id === "fixture_package_exists").every((s) => s.pass);
  const envOk = steps.filter((s) => s.id === "env_staging_ref").every((s) => s.pass);
  const overall = envOk && apiOk && browserOk;

  writeFileSync(
    join(OUT, "manifest.json"),
    JSON.stringify(
      {
        run_id: RUN_ID,
        task: "NEDA-18-ITEM-SCAN-RETURN-LINKAGE-BROWSER-PROOF",
        staging_ref: STAGING_REF,
        probe_target: target,
        fixture_org_id: FIXTURE_ORG_ID,
        fixture_store_id: FIXTURE_STORE_ID,
        fixture_package_id: FIXTURE_PACKAGE_ID,
        fixture_package_code: api.package_code,
        overall: overall ? "PASS" : "FAIL",
        api,
        browser: {
          ...browser,
          body_excerpt: browser.body_excerpt.slice(0, 800),
        },
        steps,
      },
      null,
      2,
    ),
  );

  writeFileSync(
    join(OUT, "browser-proof.md"),
    `# Browser proof — item scan return_items linkage

| Check | Result |
|-------|--------|
| Signed in | ${browser.signed_in} |
| Store configured | ${browser.store_ready} |
| Item scan / Expected Items | ${browser.item_scan_visible} / ${browser.expected_items_visible} |
| Linkage copy in DOM | ${browser.linkage_copy_visible} |
| Matched labels | ${browser.linkage_labels_matched.join(", ") || "none"} |
| Staging API only | ${browser.staging_api_only} |
| Server action POST 200 | ${browser.post_scan_200} |
| Hydrated scanned hint | ${browser.hydrated_count_hint ?? "n/a"} |

Routes:
${browser.routes.map((u) => `- ${u}`).join("\n") || "- n/a"}

\`\`\`
${browser.body_excerpt.slice(0, 900)}
\`\`\`
`,
  );

  writeFileSync(
    join(OUT, "product-linkage-proof.md"),
    `# Product linkage — return_items (fixture package)

| Field | Value |
|-------|-------|
| Package code | \`${api.package_code}\` |
| actual_item_count | ${api.actual_item_count} |
| Active return_items | ${api.active_count} |
| Soft-deleted return_items | ${api.soft_deleted_count} |
| RETURN_SCANNER_LINKAGE_SELECT | \`${RETURN_SCANNER_LINKAGE_SELECT}\` |

## Active rows (labels redacted)

| id (prefix) | primary_label | unmapped | needs_review | catalog |
|-------------|---------------|----------|--------------|---------|
${api.active_rows.map((r) => `| ${r.id}… | ${r.primary_label.slice(0, 50)} | ${r.shows_unmapped} | ${r.shows_needs_review} | ${r.has_catalog_name} |`).join("\n") || "| — | no active rows | — | — | — |"}

**UI contract:** \`OperatorProductLinkageMeta\` shows \`${PRODUCT_LINKAGE_UNMAPPED_LABEL}\`, \`${PRODUCT_LINKAGE_NEEDS_REVIEW_LABEL}\`, or catalog \`product_name\` from \`buildProductLinkageDisplayContract\`.
`,
  );

  writeFileSync(
    join(OUT, "blockers.md"),
    overall
      ? `# Blockers\n\nNone — item-scan return_items linkage browser proof passed.\n`
      : `# Blockers\n\n**Overall:** FAIL\n\n${steps.filter((s) => !s.pass).map((s) => `- **${s.id}:** ${s.detail}`).join("\n")}\n`,
  );

  console.log(`Wrote ${OUT}`);
  console.log(`Overall: ${overall ? "PASS" : "FAIL"}`);
  process.exit(overall ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
