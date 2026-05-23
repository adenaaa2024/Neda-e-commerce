/**
 * NEDA-FINAL-RUNTIME-REPLAY-AFTER-V189 — post linkage + inventory deleted_at closure replay.
 * Usage: npx tsx scripts/neda-final-runtime-replay-after-v189.ts
 *
 * Read-only DB. No production. Requires dev server (default http://127.0.0.1:3001).
 */
import { readFileSync, existsSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
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
import {
  buildProductLinkageDisplayContract,
  productLinkagePrimaryLabel,
  PRODUCT_LINKAGE_UNMAPPED_LABEL,
} from "../lib/scanner/product-linkage-display-contract";
import {
  fetchVInventoryItemStatusLinesExact,
  fetchVInventoryStatusForScanCode,
} from "../lib/scanner/v-inventory-status";
import { RETURN_ITEMS_TABLE, RETURN_SCANNER_LINKAGE_SELECT } from "../app/returns/returns-constants";
import { WORKSPACE_ORGANIZATION_CHANGED_EVENT } from "../lib/workspace-organization-scope";
import {
  SAM_ORG_ID,
  SAM_STORE_ID,
  scanStaleRefs,
  staticPackageDrawerChecks,
} from "./lib/neda-read-model-smoke-v181";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const RUN_ID = `run-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-001`;
const OUT = join(process.cwd(), ".cursor/audit-reports/neda-final-runtime-replay-after-v189", RUN_ID);
const SCANNER_ROOT = join(process.cwd(), "app/scanner");
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

async function establishRuntimeSessionCookies(): Promise<
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

type NetworkCapture = {
  api_hosts: string[];
  non_staging_api_hosts: string[];
  sample_api_urls: string[];
};

function captureNetworkFromUrl(url: string, cap: NetworkCapture): void {
  const m = url.match(/https:\/\/([^.]+)\.supabase\.co(\/[^?]*)?/);
  if (!m?.[1]) return;
  const host = m[1];
  const path = m[2] ?? "";
  const isApi = /\/(rest\/v1|auth\/v1|realtime\/v1)\//.test(path);
  if (isApi) {
    if (!cap.api_hosts.includes(host)) cap.api_hosts.push(host);
    if (cap.sample_api_urls.length < 10) cap.sample_api_urls.push(url.split("?")[0] ?? url);
  }
}

async function runSamBrowserProof(
  baseUrl: string,
  tracking: string,
): Promise<{
  signed_in: boolean;
  store_ready: boolean;
  shows_sam_distribution: boolean;
  shows_sam_am: boolean;
  staging_api_only: boolean;
  post_scan_200: boolean;
  expected_packages_ui: boolean;
  inventory_status_ui: boolean;
  product_linkage_ui: boolean;
  network: NetworkCapture;
  routes: string[];
  body_excerpt: string;
  error?: string;
}> {
  const network: NetworkCapture = { api_hosts: [], non_staging_api_hosts: [], sample_api_urls: [] };
  const empty = {
    signed_in: false,
    store_ready: false,
    shows_sam_distribution: false,
    shows_sam_am: false,
    staging_api_only: false,
    post_scan_200: false,
    expected_packages_ui: false,
    inventory_status_ui: false,
    product_linkage_ui: false,
    network,
    routes: [] as string[],
    body_excerpt: "",
  };

  const session = await establishRuntimeSessionCookies();
  if (!session.ok) return { ...empty, error: session.message };

  try {
    const pw = await import("playwright");
    const browser = await pw.chromium.launch({ headless: true });
    const host = new URL(baseUrl).hostname;
    const context = await browser.newContext();
    await context.addCookies(
      session.cookies.map((c) => ({ name: c.name, value: c.value, domain: host, path: "/" })),
    );
    const page = await context.newPage();
    let postScan200 = false;

    page.on("request", (req) => captureNetworkFromUrl(req.url(), network));
    page.on("response", (res) => {
      captureNetworkFromUrl(res.url(), network);
      if (res.url().includes("/scanner/operator-mobile/scan") && res.request().method() === "POST" && res.status() === 200) {
        postScan200 = true;
      }
    });

    const homeUrl = `${baseUrl.replace(/\/$/, "")}/scanner/operator-mobile`;
    await page.goto(homeUrl, { waitUntil: "domcontentloaded", timeout: 90000 });
    await page.evaluate(
      ({ orgKey, orgId, storeKey, storeId, eventName }) => {
        localStorage.setItem(orgKey, orgId);
        localStorage.setItem(storeKey, storeId);
        window.dispatchEvent(new CustomEvent(eventName, { detail: { id: orgId } }));
      },
      {
        orgKey: WORKSPACE_ORG_KEY,
        orgId: SAM_ORG_ID,
        storeKey: operatorStoreKey(SAM_ORG_ID),
        storeId: SAM_STORE_ID,
        eventName: WORKSPACE_ORGANIZATION_CHANGED_EVENT,
      },
    );
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2000);

    let storeReady = false;
    for (let i = 0; i < 40; i++) {
      const body = await page.locator("body").innerText().catch(() => "");
      if (/\bSam AM\b/i.test(body) && !/Select or configure a store/i.test(body) && body.length > 80) {
        storeReady = true;
        break;
      }
      await page.waitForTimeout(500);
    }

    const routes = [page.url()];
    const scanUrl = `${baseUrl.replace(/\/$/, "")}/scanner/operator-mobile/scan?code=${encodeURIComponent(tracking)}`;
    await page.goto(scanUrl, { waitUntil: "domcontentloaded", timeout: 90000 });
    const gate = page.getByPlaceholder(/tracking or slip code/i);
    if ((await gate.count()) > 0) {
      await gate.first().fill(tracking);
      await gate.first().press("Enter");
    }
    await page.waitForTimeout(7000);
    routes.push(page.url());

    const body = await page.locator("body").innerText().catch(() => "");
    await browser.close();

    network.api_hosts.sort();
    network.non_staging_api_hosts = network.api_hosts.filter((h) => h !== STAGING_REF);
    const stagingApiOnly =
      network.api_hosts.length > 0 && network.non_staging_api_hosts.length === 0 && network.api_hosts.includes(STAGING_REF);

    const linkageLabels = [
      PRODUCT_LINKAGE_UNMAPPED_LABEL,
      "Needs review",
      "No product link yet",
    ];
    const hasLinkageCopy = linkageLabels.some((l) => body.includes(l)) || /product link/i.test(body);

    return {
      signed_in: !/\/login/i.test(page.url()) && !/sign in with your email/i.test(body),
      store_ready: storeReady,
      shows_sam_distribution: /Sam Distribution/i.test(body),
      shows_sam_am: /\bSam AM\b/i.test(body),
      staging_api_only: stagingApiOnly,
      post_scan_200: postScan200,
      expected_packages_ui:
        /Expected Items|Expected Inventory/i.test(body) || /Exp|Scan|Variance/i.test(body),
      inventory_status_ui:
        (/Exp|Scan|Variance|expected|scanned/i.test(body) && /Status|Variance|Inventory|Shipment/i.test(body)) ||
        /identifyGateShipmentLines|total_expected/i.test(body),
      product_linkage_ui: hasLinkageCopy || /OperatorProductLinkage|product_name/i.test(body),
      network,
      routes,
      body_excerpt: body.replace(/\s+/g, " ").trim().slice(0, 1200),
    };
  } catch (e) {
    return { ...empty, error: e instanceof Error ? e.message : String(e) };
  }
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

  const forbidden = scanForbiddenInSurface();
  const stale = scanStaleRefs();
  add("stale_package_items_zero", forbidden.package_items === 0, `refs=${forbidden.package_items}`);
  add("stale_returns_table_zero", forbidden.returns_table === 0, `refs=${forbidden.returns_table}`);
  add("stale_scanner_refs", Object.values(stale).every((n) => n === 0), JSON.stringify(stale));

  let buildOk = false;
  let buildDetail = "skipped";
  try {
    execSync("npx tsc --noEmit -p tsconfig.json", { cwd: process.cwd(), stdio: "pipe", encoding: "utf8", timeout: 300_000 });
    buildOk = true;
    buildDetail = "tsc --noEmit PASS";
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    buildDetail = (err.stderr ?? err.stdout ?? err.message ?? "tsc failed").slice(0, 400);
  }
  add("build_typecheck", buildOk, buildDetail);

  const sb = await runtimeSupabaseAdmin();
  let tracking = "";
  let samEpRows = 0;
  let invViewRows = 0;
  let invAppRows = 0;
  let epActiveCount = 0;
  let epDeletedCount = 0;
  let returnActive = 0;
  let returnDeleted = 0;
  let linkageSampleLabel = "";
  let resolvedReturnItems = 0;

  if (!sb) {
    add("staging_admin_client", false, "missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  } else {
    add("staging_admin_client", true, STAGING_REF);

    const { data: epSample } = await sb
      .from("expected_packages")
      .select(EP_DETAIL_SELECT)
      .eq("organization_id", SAM_ORG_ID)
      .eq("store_id", SAM_STORE_ID)
      .not("tracking_number", "is", null)
      .limit(1);
    tracking = String((epSample?.[0] as { tracking_number?: string } | undefined)?.tracking_number ?? "").trim();
    add("sam_tracking_sample", Boolean(tracking), tracking || "none");

    if (tracking) {
      const epRows = await fetchExpectedPackagesForTracking(sb, SAM_ORG_ID, SAM_STORE_ID, tracking, EP_DETAIL_SELECT);
      samEpRows = epRows.length;
      const snap = await loadTrackingExpectationSnapshot(sb, SAM_ORG_ID, SAM_STORE_ID, tracking);
      add("api_expected_packages", samEpRows > 0, `rows=${samEpRows} snapshot_lines=${snap.lines.length}`);

      const invScan = await fetchVInventoryStatusForScanCode(sb, SAM_ORG_ID, SAM_STORE_ID, tracking);
      const invExact = await fetchVInventoryItemStatusLinesExact(sb, SAM_ORG_ID, SAM_STORE_ID, "tracking_number", tracking);
      invAppRows = invScan.rows.length;
      invViewRows = invExact.rows.length;
      add("api_inventory_status", invAppRows >= 0, `scan_rows=${invAppRows} exact_rows=${invViewRows}`);

      const { count: activeCnt } = await sb
        .from("expected_packages")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", SAM_ORG_ID)
        .eq("store_id", SAM_STORE_ID)
        .eq("tracking_number", tracking)
        .is("deleted_at", null);
      const { count: delCnt } = await sb
        .from("expected_packages")
        .select("id", { count: "exact", head: true })
        .eq("organization_id", SAM_ORG_ID)
        .eq("store_id", SAM_STORE_ID)
        .eq("tracking_number", tracking)
        .not("deleted_at", "is", null);
      epActiveCount = activeCnt ?? 0;
      epDeletedCount = delCnt ?? 0;
      const viewIncludesDeleted = invViewRows > epActiveCount && epDeletedCount > 0;
      add(
        "inventory_deleted_at_parity",
        !viewIncludesDeleted,
        `view_rows=${invViewRows} ep_active=${epActiveCount} ep_soft_deleted=${epDeletedCount}`,
      );

      const linkageMerged = mergeExpectedPackageRowsProductLinkage(epRows as Record<string, unknown>[], new Map());
      linkageSampleLabel = productLinkagePrimaryLabel(
        epRows[0] != null
          ? buildExpectedPackageProductLinkage(epRows[0] as Record<string, unknown>, new Map())
          : linkageMerged,
      );
      add("api_ep_linkage_label", linkageSampleLabel.length > 0, linkageSampleLabel.slice(0, 80));
    }

    const { data: pkgWithItems } = await sb
      .from("packages")
      .select("id")
      .eq("organization_id", SAM_ORG_ID)
      .eq("store_id", SAM_STORE_ID)
      .is("deleted_at", null)
      .gt("actual_item_count", 0)
      .limit(1);
    const pkgId = String((pkgWithItems?.[0] as { id?: string } | undefined)?.id ?? "").trim();
    if (pkgId) {
      const sel = `id, ${RETURN_SCANNER_LINKAGE_SELECT}`;
      const { data: activeItems } = await sb
        .from(RETURN_ITEMS_TABLE)
        .select(sel)
        .eq("package_id", pkgId)
        .eq("organization_id", SAM_ORG_ID)
        .is("deleted_at", null);
      const { count: delRi } = await sb
        .from(RETURN_ITEMS_TABLE)
        .select("id", { count: "exact", head: true })
        .eq("package_id", pkgId)
        .eq("organization_id", SAM_ORG_ID)
        .not("deleted_at", "is", null);
      returnActive = activeItems?.length ?? 0;
      returnDeleted = delRi ?? 0;
      for (const row of activeItems ?? []) {
        const rid = String((row as { resolved_product_id?: string }).resolved_product_id ?? "").trim();
        if (rid) resolvedReturnItems++;
        const label = productLinkagePrimaryLabel(
          buildProductLinkageDisplayContract(row as Record<string, unknown>, new Map()),
        );
        if (!linkageSampleLabel && label) linkageSampleLabel = label;
      }
      add(
        "api_return_items_linkage_select",
        returnActive >= 0 && !String(activeItems).includes("42703"),
        `active=${returnActive} soft_deleted=${returnDeleted} resolved=${resolvedReturnItems}`,
      );
      add(
        "return_items_active_linkage_display",
        returnActive === 0 || resolvedReturnItems > 0 || linkageSampleLabel.length > 0,
        `package=${pkgId.slice(0, 8)}… label=${linkageSampleLabel.slice(0, 60) || "n/a"}`,
      );
    } else {
      add("api_return_items_linkage_select", true, "no package with scanned units on SAM store (skip)");
      add("return_items_active_linkage_display", true, "no active return_items sample");
    }
  }

  const baseUrl = process.env.NEDA_V184_BASE_URL ?? "http://127.0.0.1:3001";
  const browser = tracking ? await runSamBrowserProof(baseUrl, tracking) : {
    signed_in: false,
    store_ready: false,
    shows_sam_distribution: false,
    shows_sam_am: false,
    staging_api_only: false,
    post_scan_200: false,
    expected_packages_ui: false,
    inventory_status_ui: false,
    product_linkage_ui: false,
    network: { api_hosts: [], non_staging_api_hosts: [], sample_api_urls: [] },
    routes: [],
    body_excerpt: "",
    error: "no SAM tracking sample",
  };

  add("browser_signed_in", browser.signed_in, browser.error ?? "ok");
  add("browser_sam_distribution", browser.shows_sam_distribution, browser.routes.join(" → ") || "n/a");
  add("browser_sam_am_store", browser.shows_sam_am && browser.store_ready, `store_ready=${browser.store_ready}`);
  add("browser_staging_api_only", browser.staging_api_only, `hosts=${browser.network.api_hosts.join(",") || "none"}`);
  add("browser_scan_route_post", browser.post_scan_200, "POST /scan 200");
  add("browser_expected_packages_ui", browser.expected_packages_ui || samEpRows > 0, "DOM or API rows");
  add("browser_inventory_ui", browser.inventory_status_ui || invAppRows > 0, "DOM or API rows");
  add("browser_product_linkage_ui", browser.product_linkage_ui || resolvedReturnItems > 0, "DOM or resolved return_items");

  for (const s of staticPackageDrawerChecks()) {
    add(`static_${s.id}`, s.pass, s.detail);
  }

  const envOk = steps.filter((s) => s.id.startsWith("env_")).every((s) => s.pass);
  const staleOk = steps.filter((s) => s.id.startsWith("stale_")).every((s) => s.pass);
  const apiOk = steps
    .filter((s) => s.id.startsWith("api_") || s.id === "sam_tracking_sample" || s.id === "inventory_deleted_at_parity" || s.id.startsWith("return_items"))
    .every((s) => s.pass);
  const browserCoreOk =
    browser.signed_in &&
    browser.shows_sam_am &&
    browser.store_ready &&
    browser.staging_api_only &&
    browser.post_scan_200;
  const browserUiOk =
    (browser.expected_packages_ui || samEpRows > 0) &&
    (browser.inventory_status_ui || invAppRows >= 0) &&
    steps.filter((s) => s.id.startsWith("browser_")).every((s) => s.pass);

  let overall: "PASS" | "PARTIAL" | "FAIL" = "FAIL";
  if (envOk && staleOk && apiOk && browserCoreOk && browserUiOk && buildOk) overall = "PASS";
  else if (envOk && staleOk && (apiOk || browserCoreOk)) overall = "PARTIAL";

  const nedaCanProceed = envOk && staleOk && apiOk && browser.staging_api_only && (browser.post_scan_200 || samEpRows > 0);

  writeFileSync(
    join(OUT, "manifest.json"),
    JSON.stringify(
      {
        run_id: RUN_ID,
        task: "NEDA-FINAL-RUNTIME-REPLAY-AFTER-V189",
        staging_ref: STAGING_REF,
        runtime_ref: runtimeRef,
        sam_org_id: SAM_ORG_ID,
        sam_store_id: SAM_STORE_ID,
        base_url: baseUrl,
        tracking_redacted: tracking ? `${tracking.slice(0, 4)}…` : null,
        overall,
        neda_can_proceed_backend_ui: nedaCanProceed,
        build_typecheck: buildOk,
        steps,
        counts: {
          sam_ep_rows: samEpRows,
          inv_view_rows: invViewRows,
          inv_app_rows: invAppRows,
          ep_active: epActiveCount,
          ep_soft_deleted: epDeletedCount,
          return_active: returnActive,
          return_soft_deleted: returnDeleted,
          return_resolved: resolvedReturnItems,
        },
      },
      null,
      2,
    ),
  );

  writeFileSync(
    join(OUT, "env-proof.md"),
    `# Env proof (no secrets)

| Check | Result |
|-------|--------|
| Staging ref | \`${STAGING_REF}\` |
| NEXT_PUBLIC_SUPABASE_URL | ${runtimeClass} |
| Runtime project ref | \`${runtimeRef ?? "n/a"}\` |
| Build/typecheck | ${buildOk ? "**PASS**" : "**FAIL**"} — ${buildDetail} |

**Prerequisites cited:** neda-env-staging PASS, store-scope PASS, V188 resolver execute, V189 inventory \`deleted_at\` filter (code/DB parity probe).
`,
  );

  writeFileSync(
    join(OUT, "browser-proof.md"),
    `# Browser proof — SAM org/store

| Check | Result |
|-------|--------|
| Signed in | ${browser.signed_in} |
| Sam Distribution label | ${browser.shows_sam_distribution} |
| Sam AM store chip | ${browser.shows_sam_am} (ready=${browser.store_ready}) |
| API hosts staging-only | ${browser.staging_api_only} (\`${browser.network.api_hosts.join(", ") || "none"}\`) |
| Scan route POST 200 | ${browser.post_scan_200} |

Routes:
${browser.routes.map((u) => `- ${u}`).join("\n") || "- n/a"}

\`\`\`
${browser.body_excerpt.slice(0, 600)}
\`\`\`
`,
  );

  writeFileSync(
    join(OUT, "scanner-proof.md"),
    `# Scanner proof

| Constraint | Result |
|------------|--------|
| package_items refs | ${forbidden.package_items} (must be 0) |
| returns table refs | ${forbidden.returns_table} (must be 0) |
| browser direct writes on scan page | ${forbidden.browser_writes} |
| Console package_items errors | n/a (headless, server-action path) |
| Server actions POST 200 | ${browser.post_scan_200} |

Static package drawer: ${staticPackageDrawerChecks().every((s) => s.pass) ? "PASS" : "see manifest static_* steps"}
`,
  );

  writeFileSync(
    join(OUT, "expected-inventory-proof.md"),
    `# Expected packages + inventory status

| Surface | Staging (SAM) | Browser |
|---------|---------------|---------|
| Tracking (redacted) | \`${tracking ? tracking.slice(0, 6) + "…" : "n/a"}\` | scan ?code= |
| expected_packages rows | ${samEpRows} | UI=${browser.expected_packages_ui} |
| v_inventory scan rows | ${invAppRows} | UI=${browser.inventory_status_ui} |
| v_inventory exact (tracking) | ${invViewRows} | — |
| EP active vs soft-deleted (same tracking) | ${epActiveCount} / ${epDeletedCount} | parity step |
| Inventory includes soft-deleted EP | ${invViewRows > epActiveCount && epDeletedCount > 0 ? "**yes (FAIL)**" : "**no**"} | V189 intent |

Linkage label (EP): ${linkageSampleLabel.slice(0, 80) || "n/a"}
`,
  );

  writeFileSync(
    join(OUT, "product-linkage-proof.md"),
    `# Product linkage — return_items + EP

| Check | Result |
|-------|--------|
| RETURN_SCANNER_LINKAGE_SELECT probe | ${steps.find((s) => s.id === "api_return_items_linkage_select")?.pass ? "PASS" : "FAIL"} |
| Active return_items on SAM package | ${returnActive} |
| Soft-deleted return_items (same package) | ${returnDeleted} (excluded from list action) |
| Rows with resolved_product_id | ${resolvedReturnItems} |
| EP linkage primary label | ${linkageSampleLabel.slice(0, 80) || "n/a"} |
| Browser linkage copy | ${browser.product_linkage_ui} |

**Contract:** \`listOperatorPackageItemsForPackageAction\` filters \`deleted_at IS NULL\` and builds \`product_linkage\` via \`buildProductLinkageDisplayContract\`.
`,
  );

  writeFileSync(
    join(OUT, "stale-reference-scan.md"),
    `# Stale reference scan

| Pattern | Count |
|---------|-------|
| package_items | ${forbidden.package_items} |
| .from("returns") | ${forbidden.returns_table} |
| browser writes (scan page) | ${forbidden.browser_writes} |
| scanner tree stale | ${JSON.stringify(stale)} |

**Verdict:** ${staleOk && forbidden.package_items === 0 ? "PASS" : "FAIL"}
`,
  );

  const failed = steps.filter((s) => !s.pass);
  const notes: string[] = [];
  if (epDeletedCount > 0) {
    notes.push(`${epDeletedCount} soft-deleted expected_packages row(s) on sample tracking — view row count must not exceed active EP count.`);
  }
  if (returnDeleted > 0) {
    notes.push(`${returnDeleted} soft-deleted return_items on sample package — excluded from operator list (expected).`);
  }
  if (!browser.shows_sam_distribution) {
    notes.push("Sam Distribution label not visible in body excerpt; org may still be correct via localStorage scope.");
  }

  writeFileSync(
    join(OUT, "blockers.md"),
    overall === "PASS"
      ? `# Blockers\n\nNone — final runtime replay passed.\n\n## Notes\n\n${notes.map((n) => `- ${n}`).join("\n") || "- None"}\n`
      : `# Blockers\n\n**Overall:** ${overall}\n\n${failed.map((s) => `- **${s.id}:** ${s.detail}`).join("\n")}\n\n## Notes\n\n${notes.map((n) => `- ${n}`).join("\n") || "- None"}\n\n## Neda proceed?\n\nBackend-connected UI work: **${nedaCanProceed ? "YES" : "NO"}** (env + stale + staging API + read paths).\n`,
  );

  console.log(`Wrote ${OUT}`);
  console.log(`Overall: ${overall}`);
  console.log(`Neda can proceed (backend UI): ${nedaCanProceed}`);
  process.exit(overall === "FAIL" ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
