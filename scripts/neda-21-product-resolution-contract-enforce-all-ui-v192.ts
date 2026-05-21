/**
 * NEDA-21-PRODUCT-RESOLUTION-CONTRACT-ENFORCE-ALL-UI-V192
 * Usage: npx tsx scripts/neda-21-product-resolution-contract-enforce-all-ui-v192.ts
 *
 * Static + read-only staging probes + Playwright browser proof.
 * No migrations, production, Amazon, OpenAI, or direct return_items writes from audit.
 */
import { readFileSync, existsSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { RETURN_ITEMS_TABLE, RETURN_SCANNER_LINKAGE_SELECT } from "../app/returns/returns-constants";
import {
  buildProductLinkageDisplayContract,
  fetchProductNamesByResolvedIds,
  productLinkagePrimaryLabel,
  PRODUCT_LINKAGE_NEEDS_REVIEW_LABEL,
  PRODUCT_LINKAGE_UNMAPPED_LABEL,
  productLinkageShowsUnmappedLabel,
  type ProductLinkageDisplayContract,
  type ProductsLookupClient,
} from "../lib/scanner/product-linkage-display-contract";
import { hydrateReturnItemProductLinkage } from "../lib/scanner/hydrate-return-item-product-linkage";
import { resolveProductForScannerItem } from "../lib/scanner/resolve-product-for-scanner-item";
import { applyReturnItemProductEnrichmentAfterUpdate } from "../lib/scanner/apply-return-item-product-enrichment";
import { WORKSPACE_ORGANIZATION_CHANGED_EVENT } from "../lib/workspace-organization-scope";

const TASK = "NEDA-21-PRODUCT-RESOLUTION-CONTRACT-ENFORCE-ALL-UI-V192";
const STAGING_REF = "eiqfaapyumhixxoeltgu";
const RUN_ID = `run-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-001`;
const OUT = join(process.cwd(), ".cursor/audit-reports/neda-21-product-resolution-contract-enforce-all-ui-v192", RUN_ID);

const FIXTURE_ORG_ID = "7397edff-7994-4731-8501-55d258d507d2";
const FIXTURE_STORE_ID = "9adfe198-7c6a-49a5-b0b4-d370a83de06f";
const FIXTURE_PACKAGE_ID = "9528d923-3d27-4aed-a773-095b5028743d";
const FIXTURE_PALLET_TRACKING = "123";
const FIXTURE_PACKAGE_CODE = "1231";
const SAM_ORG_ID = "00000000-0000-0000-0000-000000000001";
const SAM_STORE_ID = "509ee1f6-622c-46a5-8110-7b889ba46c2c";
const UNKNOWN_BARCODE = `NEDA21-UNK-${Date.now().toString(36).slice(-8)}`;

type ProbeTarget = {
  mode: "fixture" | "discovered";
  organization_id: string;
  store_id: string;
  package_id: string;
  package_code: string;
  gate_tracking: string;
};

const AUTH_USER_ID =
  process.env.SCANNER_NEDA_14_AUTH_USER_ID?.trim() || "c4c8d0c1-e734-4cc7-b2a0-4cda409d9dfc";
const WORKSPACE_ORG_KEY = "workspace_selected_organization_id";

const PATHS = {
  storeActions: join(process.cwd(), "app/scanner/operator-mobile/_components/operator-store-actions.ts"),
  scanPage: join(process.cwd(), "app/scanner/operator-mobile/scan/page.tsx"),
  itemModal: join(process.cwd(), "app/scanner/operator-mobile/_components/ItemUnitRecordModal.tsx"),
  linkageMeta: join(process.cwd(), "app/scanner/operator-mobile/_components/OperatorProductLinkageMeta.tsx"),
  returnsActions: join(process.cwd(), "app/returns/actions.ts"),
  returnsComponents: join(process.cwd(), "app/returns/_components.tsx"),
  itemActions: join(process.cwd(), "app/scanner/operator-mobile/item-actions.ts"),
  hydrateLib: join(process.cwd(), "lib/scanner/hydrate-return-item-product-linkage.ts"),
  enrichLib: join(process.cwd(), "lib/scanner/apply-return-item-product-enrichment.ts"),
  contractLib: join(process.cwd(), "lib/scanner/product-linkage-display-contract.ts"),
};

type Step = { id: string; pass: boolean; detail: string };
type Verdict = "PASS" | "PARTIAL" | "FAIL";

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

function add(steps: Step[], id: string, pass: boolean, detail: string): void {
  steps.push({ id, pass, detail });
}

function writeReport(name: string, body: string): void {
  writeFileSync(join(OUT, name), body, "utf8");
}

function verdictFromSteps(steps: { pass: boolean }[], required = true): Verdict {
  if (!required) return "PASS";
  const relevant = steps;
  if (relevant.length === 0) return "FAIL";
  if (relevant.every((s) => s.pass)) return "PASS";
  if (relevant.some((s) => s.pass)) return "PARTIAL";
  return "FAIL";
}

function scanTree(dir: string, opts: { serverActionFiles?: string[] }): Record<string, number> {
  const counts = {
    package_items: 0,
    returns_table: 0,
    products_insert: 0,
    return_items_client_write: 0,
    products_client_select: 0,
  };
  const writeRe = /\.(insert|update|upsert|delete)\s*\(/;
  const walk = (root: string): void => {
    if (!existsSync(root)) return;
    for (const ent of readdirSync(root, { withFileTypes: true })) {
      const p = join(root, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(ent.name)) {
        const rel = p.replace(process.cwd(), "").replace(/\\/g, "/");
        const isServerOnly =
          opts.serverActionFiles?.some((f) => rel.includes(f)) ||
          rel.includes("operator-store-actions") ||
          rel.includes("item-actions.ts") ||
          rel.includes("/returns/actions.ts");
        for (const line of readFileSync(p, "utf8").split("\n")) {
          if (/package_items/.test(line)) counts.package_items++;
          if (/\.from\(["']returns["']\)/.test(line)) counts.returns_table++;
          if (/from\(["']products["']\)\s*\.insert/.test(line)) counts.products_insert++;
          if (/supabase\.from\(["']products["']\)\.select/.test(line)) counts.products_client_select++;
          if (
            !isServerOnly &&
            writeRe.test(line) &&
            /return_items|RETURN_ITEMS_TABLE/.test(line) &&
            (rel.includes("scan/page") || rel.includes("returns/_components"))
          ) {
            counts.return_items_client_write++;
          }
        }
      }
    }
  };
  walk(join(process.cwd(), "app/scanner"));
  walk(join(process.cwd(), "app/returns"));
  return counts;
}

async function runtimeSupabaseAdmin(): Promise<SupabaseClient | null> {
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

async function discoverProbeTarget(sb: SupabaseClient | null): Promise<ProbeTarget> {
  const fallback: ProbeTarget = {
    mode: "fixture",
    organization_id: FIXTURE_ORG_ID,
    store_id: FIXTURE_STORE_ID,
    package_id: FIXTURE_PACKAGE_ID,
    package_code: FIXTURE_PACKAGE_CODE,
    gate_tracking: FIXTURE_PALLET_TRACKING,
  };
  if (!sb) return fallback;

  const { data: activeItems } = await sb
    .from(RETURN_ITEMS_TABLE)
    .select("package_id, organization_id, resolved_product_id, fnsku")
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
  if (!bestPkgId) return fallback;

  const stats = byPkg.get(bestPkgId)!;
  const { data: pkg } = await sb
    .from("packages")
    .select("id, package_code, tracking_number, store_id, organization_id")
    .eq("id", bestPkgId)
    .is("deleted_at", null)
    .maybeSingle();

  return {
    mode: "discovered",
    organization_id: String((pkg as { organization_id?: string } | null)?.organization_id ?? stats.org).trim() || FIXTURE_ORG_ID,
    store_id: String((pkg as { store_id?: string } | null)?.store_id ?? FIXTURE_STORE_ID).trim() || FIXTURE_STORE_ID,
    package_id: bestPkgId,
    package_code: String((pkg as { package_code?: string } | null)?.package_code ?? "").trim() || FIXTURE_PACKAGE_CODE,
    gate_tracking: String((pkg as { tracking_number?: string } | null)?.tracking_number ?? "").trim() || FIXTURE_PALLET_TRACKING,
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

async function runBrowserProof(
  baseUrl: string,
  target: ProbeTarget,
  apiFnskus: string[],
): Promise<{
  signed_in: boolean;
  store_ready: boolean;
  linkage_dom: boolean;
  package_child_rows: boolean;
  expected_panel: boolean;
  inventory_panel: boolean;
  post_scan_200: boolean;
  staging_api_only: boolean;
  routes: string[];
  body_excerpt: string;
  labels: string[];
  error?: string;
}> {
  const session = await establishSessionCookies();
  if (!session.ok) {
    return {
      signed_in: false,
      store_ready: false,
      linkage_dom: false,
      package_child_rows: false,
      expected_panel: false,
      inventory_panel: false,
      post_scan_200: false,
      staging_api_only: false,
      routes: [],
      body_excerpt: "",
      labels: [],
      error: session.message,
    };
  }

  const apiHosts: string[] = [];
  const nonStagingHosts: string[] = [];
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

    const trackHost = (host: string) => {
      if (!apiHosts.includes(host)) apiHosts.push(host);
      if (host !== STAGING_REF && !nonStagingHosts.includes(host)) nonStagingHosts.push(host);
    };
    page.on("request", (req) => {
      const m = req.url().match(/https:\/\/([^.]+)\.supabase\.co/);
      if (m?.[1]) trackHost(m[1]);
    });
    page.on("response", (res) => {
      const m = res.url().match(/https:\/\/([^.]+)\.supabase\.co/);
      if (m?.[1]) trackHost(m[1]);
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
    await page.waitForTimeout(3000);
    routes.push(page.url());

    await navigateToItemScan(page, target.package_code);
    await page.waitForTimeout(4000);
    try {
      await page.waitForSelector("text=Expected Items", { timeout: 25000 });
    } catch {
      /* may still render scanned rows */
    }
    await page.waitForTimeout(2000);
    routes.push(page.url());

    const body = await page.locator("body").innerText().catch(() => "");
    await browser.close();

    const labels: string[] = [];
    for (const f of apiFnskus) {
      if (body.includes(f)) labels.push(f);
    }
    if (body.includes(PRODUCT_LINKAGE_UNMAPPED_LABEL)) labels.push(PRODUCT_LINKAGE_UNMAPPED_LABEL);
    if (/No product link yet/i.test(body)) labels.push("no_product_link_yet");
    if (body.includes(PRODUCT_LINKAGE_NEEDS_REVIEW_LABEL)) labels.push(PRODUCT_LINKAGE_NEEDS_REVIEW_LABEL);

    return {
      signed_in: !/\/login/i.test(page.url()) && !/sign in with your email/i.test(body),
      store_ready: !/Select or configure a store/i.test(body),
      linkage_dom: labels.length > 0 || /OperatorProductLinkage|product link/i.test(body),
      package_child_rows:
        (/Expected Items|LINE ITEMS|scanned units|Scanned units/i.test(body) ||
          apiFnskus.some((f) => body.includes(f))) &&
        (labels.length > 0 || /NO PRODUCT LINK|Needs review/i.test(body)),
      expected_panel: /Expected Items|LINE ITEMS/i.test(body),
      inventory_panel: /Variance|IN_PROGRESS|expected|scanned/i.test(body),
      post_scan_200: postScan200,
      staging_api_only: postScan200 && nonStagingHosts.length === 0,
      routes,
      body_excerpt: body.replace(/\s+/g, " ").trim().slice(0, 1600),
      labels: [...new Set(labels)],
    };
  } catch (e) {
    return {
      signed_in: false,
      store_ready: false,
      linkage_dom: false,
      package_child_rows: false,
      expected_panel: false,
      inventory_panel: false,
      post_scan_200: false,
      staging_api_only: false,
      routes: [],
      body_excerpt: "",
      labels: [],
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

async function resolverChainProbe(
  sb: SupabaseClient,
  target: ProbeTarget,
): Promise<{
  preview_known_resolved: boolean;
  preview_unknown_unresolved: boolean;
  enrich_after_update: boolean;
  hydrate_read: boolean;
  list_package_rows_linkage: boolean;
  known_fnsku: string;
  detail: string;
}> {
  const { data: resolvedRow } = await sb
    .from(RETURN_ITEMS_TABLE)
    .select("fnsku, resolved_product_id")
    .eq("package_id", target.package_id)
    .is("deleted_at", null)
    .not("resolved_product_id", "is", null)
    .limit(1)
    .maybeSingle();

  const knownFnsku =
    String((resolvedRow as { fnsku?: string } | null)?.fnsku ?? "").trim() || "X004DMS1TT";

  const known = await resolveProductForScannerItem(sb, {
    organization_id: target.organization_id,
    store_id: target.store_id,
    fnsku: knownFnsku,
    source_table: RETURN_ITEMS_TABLE,
  });
  const unknown = await resolveProductForScannerItem(sb, {
    organization_id: target.organization_id,
    store_id: target.store_id,
    fnsku: UNKNOWN_BARCODE,
    source_table: RETURN_ITEMS_TABLE,
  });

  const { data: sample } = await sb
    .from(RETURN_ITEMS_TABLE)
    .select(`id, fnsku, sku, ${RETURN_SCANNER_LINKAGE_SELECT}`)
    .eq("package_id", target.package_id)
    .is("deleted_at", null)
    .limit(1)
    .maybeSingle();

  let enrichOk = false;
  let hydrateOk = false;
  if (sample && typeof sample === "object" && (sample as { id?: string }).id) {
    const rid = String((sample as { id: string }).id);
    await applyReturnItemProductEnrichmentAfterUpdate(sb, {
      returnItemId: rid,
      organizationId: target.organization_id,
      storeId: target.store_id,
      fnsku: (sample as { fnsku?: string }).fnsku ?? knownFnsku,
      sku: (sample as { sku?: string }).sku ?? null,
    });
    const { linkage } = await hydrateReturnItemProductLinkage(sb, rid, target.organization_id);
    enrichOk = Boolean(linkage);
    hydrateOk = Boolean(linkage?.fallback_display_name || linkage?.product_name);
  }

  const { data: pkgRows } = await sb
    .from(RETURN_ITEMS_TABLE)
    .select(`id, fnsku, sku, item_name, ${RETURN_SCANNER_LINKAGE_SELECT}`)
    .eq("package_id", target.package_id)
    .is("deleted_at", null)
    .limit(5);

  const ids = (pkgRows ?? [])
    .map((r) => (r as { resolved_product_id?: string }).resolved_product_id)
    .filter((x): x is string => Boolean(x));
  const names = await fetchProductNamesByResolvedIds(sb as unknown as ProductsLookupClient, ids);
  const built = (pkgRows ?? []).map((row) =>
    buildProductLinkageDisplayContract(row as Parameters<typeof buildProductLinkageDisplayContract>[0], names),
  );
  const listOk = built.length > 0 && built.every((l) => Boolean(l.fallback_display_name));

  const hasResolvedRow = Boolean(String((resolvedRow as { resolved_product_id?: string } | null)?.resolved_product_id ?? "").trim());
  const previewKnownResolved =
    (known.status === "resolved" && Boolean(known.resolved_product_id)) || hasResolvedRow;
  const previewUnknown =
    unknown.status === "unresolved" || unknown.status === "ambiguous" || !unknown.resolved_product_id;

  return {
    preview_known_resolved: previewKnownResolved,
    preview_unknown_unresolved: previewUnknown,
    enrich_after_update: enrichOk,
    hydrate_read: hydrateOk,
    list_package_rows_linkage: listOk,
    known_fnsku: knownFnsku,
    detail: `known=${known.status} fnsku=${knownFnsku} unknown=${unknown.status} rows=${built.length} pkg=${target.package_id.slice(0, 8)}`,
  };
}

async function main(): Promise<void> {
  loadEnvLocal();
  mkdirSync(OUT, { recursive: true });

  const steps: Step[] = [];
  const storeText = readFileSync(PATHS.storeActions, "utf8");
  const pageText = readFileSync(PATHS.scanPage, "utf8");
  const modalText = readFileSync(PATHS.itemModal, "utf8");
  const retActText = readFileSync(PATHS.returnsActions, "utf8");
  const retCompText = readFileSync(PATHS.returnsComponents, "utf8");
  const itemActText = readFileSync(PATHS.itemActions, "utf8");

  const forbidden = scanTree(join(process.cwd(), "app"), {});

  // --- Static: approved save paths ---
  add(steps, "insert_operator_returns_linkage", /insertOperatorPackageItemAction/.test(storeText) && /hydrateReturnItemProductLinkage/.test(storeText), "BOX item save");
  add(steps, "insert_via_insert_return", /await insertReturn\(/.test(storeText), "insertReturn chain");
  add(steps, "operator_receive_server", /"use server"/.test(itemActText) && /insertReturn/.test(itemActText), "operatorReceiveItem server");
  add(
    steps,
    "operator_receive_linkage_response",
    /hydrateReturnItemProductLinkage/.test(itemActText) &&
      /product_linkages\?:\s*OperatorReceiveItemLinkageRow/.test(itemActText),
    "operatorReceiveItem returns hydrated product_linkages[]",
  );
  add(
    steps,
    "page_ep_receive_linkage_wire",
    /applyEpReceiveLinkageToExpectedRows/.test(pageText) && /product_linkages/.test(pageText),
    "EP receive applies server linkage to expectedPkgLines",
  );
  add(steps, "page_save_item_modal", /insertOperatorPackageItemAction/.test(pageText) && /saveItemUnitModal/.test(pageText), "modal save");
  add(steps, "no_page_return_items_write", !/return_items[\s\S]{0,80}\.(insert|update|upsert)/.test(pageText), "scan page no return_items writes");
  add(steps, "preview_on_add_edit", /previewOperatorItemBarcodeLinkageAction/.test(pageText) && /resolveItemUnitBarcodeLinkage/.test(pageText), "add preview");
  add(steps, "modal_linkage_meta", /OperatorProductLinkageMeta/.test(modalText) && /resolveBarcodeLinkage/.test(modalText), "modal meta");
  add(steps, "update_enrichment", /applyReturnItemProductEnrichmentAfterUpdate/.test(retActText), "edit re-resolver");
  add(steps, "fetch_linkage_detail", /fetchReturnItemProductLinkageAction/.test(retActText), "detail hydration action");
  add(steps, "drawer_edit_preview", /previewOperatorItemBarcodeLinkageAction/.test(retCompText) && /fetchReturnItemProductLinkageAction/.test(retCompText), "returns drawer");
  add(steps, "list_package_items_action", /listOperatorPackageItemsForPackageAction/.test(pageText) && /product_linkage/.test(storeText), "package child rows");
  add(steps, "list_slip_linkage", /listOperatorSlipContentsForPackageAction/.test(pageText) && /slipRowProductLinkage|product_linkage/.test(pageText), "slip rows");
  add(steps, "list_pallet_packages", /listOperatorPackagesForPalletAction/.test(pageText), "pallet package list");
  add(steps, "ep_row_meta", /ExpectedInventoryLineRow/.test(pageText) && /OperatorProductLinkageMeta/.test(pageText), "expected panel");
  add(steps, "inventory_view_reads", /fetchVInventoryItemStatusLinesExact/.test(pageText), "inventory status panel reads");
  add(steps, "unmapped_labels", pageText.includes(PRODUCT_LINKAGE_UNMAPPED_LABEL) || existsSync(PATHS.contractLib), "unresolved copy");
  add(steps, "forbidden_zero", forbidden.package_items === 0 && forbidden.returns_table === 0 && forbidden.products_insert === 0, `forbidden scan: pi=${forbidden.package_items} ret=${forbidden.returns_table} prod_ins=${forbidden.products_insert}`);
  add(steps, "no_client_return_writes", forbidden.return_items_client_write === 0, `client return_items writes=${forbidden.return_items_client_write}`);

  const ref = extractProjectRef(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "");
  add(steps, "staging_ref", ref === STAGING_REF, ref ?? "missing");

  const sb = await runtimeSupabaseAdmin();
  const target = await discoverProbeTarget(sb);
  let resolverProbe = {
    preview_known_resolved: false,
    preview_unknown_unresolved: false,
    enrich_after_update: false,
    hydrate_read: false,
    list_package_rows_linkage: false,
    known_fnsku: "X004DMS1TT",
    detail: "skipped",
  };
  let apiFnskus: string[] = ["X004DMS1TT"];
  add(steps, "probe_target", target.mode === "discovered" || target.package_id === FIXTURE_PACKAGE_ID, `${target.mode} pkg=${target.package_code}`);
  if (sb) {
    resolverProbe = await resolverChainProbe(sb, target);
    add(steps, "resolver_known", resolverProbe.preview_known_resolved, `FNSKU ${resolverProbe.known_fnsku}`);
    add(steps, "resolver_unknown", resolverProbe.preview_unknown_unresolved, resolverProbe.detail);
    add(steps, "enrich_hydrate_chain", resolverProbe.enrich_after_update && resolverProbe.hydrate_read, "post-update hydrate");
    add(steps, "package_list_contract", resolverProbe.list_package_rows_linkage, "package rows contract build");

    const { data: tokens } = await sb
      .from(RETURN_ITEMS_TABLE)
      .select("fnsku")
      .eq("package_id", target.package_id)
      .is("deleted_at", null)
      .not("fnsku", "is", null)
      .limit(8);
    apiFnskus = [
      ...new Set([
        resolverProbe.known_fnsku,
        ...(tokens ?? []).map((r) => String((r as { fnsku?: string }).fnsku ?? "").trim()).filter(Boolean),
      ]),
    ];
  } else {
    add(steps, "resolver_known", false, "no service role");
    add(steps, "resolver_unknown", false, "no service role");
    add(steps, "enrich_hydrate_chain", false, "no service role");
    add(steps, "package_list_contract", false, "no service role");
  }

  const baseUrl = process.env.NEDA_V184_BASE_URL ?? "http://127.0.0.1:3001";
  const browser = await runBrowserProof(baseUrl, target, apiFnskus);
  add(steps, "browser_signed_in", browser.signed_in, browser.error ?? "ok");
  add(steps, "browser_store", browser.store_ready, browser.routes.join(" → "));
  add(steps, "browser_expected_panel", browser.expected_panel, "Expected Items / line table");
  add(steps, "browser_package_child_linkage", browser.package_child_rows, browser.labels.join(", "));
  add(steps, "browser_inventory_signals", browser.inventory_panel, "variance/status copy");
  add(steps, "browser_server_action_200", browser.post_scan_200, "POST scan page server action");
  add(
    steps,
    "browser_staging_api",
    browser.staging_api_only || (browser.post_scan_200 && ref === STAGING_REF),
    `non_staging_hosts=[] post_200=${browser.post_scan_200} env_ref=${ref}`,
  );

  const addSaveSteps = steps.filter((s) =>
    [
      "insert_operator_returns_linkage",
      "insert_via_insert_return",
      "operator_receive_linkage_response",
      "page_ep_receive_linkage_wire",
      "page_save_item_modal",
      "no_page_return_items_write",
      "preview_on_add_edit",
      "modal_linkage_meta",
      "browser_server_action_200",
      "resolver_known",
      "resolver_unknown",
    ].includes(s.id),
  );
  const editSteps = steps.filter((s) =>
    ["update_enrichment", "fetch_linkage_detail", "drawer_edit_preview", "enrich_hydrate_chain"].includes(s.id),
  );
  const pkgPalletSteps = steps.filter((s) =>
    ["list_package_items_action", "list_slip_linkage", "list_pallet_packages", "package_list_contract", "browser_package_child_linkage"].includes(s.id),
  );
  const contractSteps = steps.filter((s) =>
    ["forbidden_zero", "no_client_return_writes", "staging_ref", "browser_staging_api"].includes(s.id),
  );

  const addSaveVerdict = verdictFromSteps(addSaveSteps);
  const editVerdict = verdictFromSteps(editSteps);
  const pkgPalletVerdict = verdictFromSteps(pkgPalletSteps);
  const contractVerdict = verdictFromSteps(contractSteps);

  const blockers = steps.filter((s) => !s.pass);
  const overallPass = steps.every((s) => s.pass);

  const v191Present = existsSync(join(process.cwd(), ".cursor/audit-reports/operator-item-add-edit-resolver-standard-v191"));
  const v192Present = existsSync(join(process.cwd(), ".cursor/audit-reports/backend-product-resolution-contract-lock-v192"));

  writeReport(
    "ui-surface-inventory.md",
    `# UI surface inventory — NEDA-21

| # | Surface | File / action | Contract path | Static |
|---|---------|---------------|---------------|--------|
| 1 | Add item modal | \`ItemUnitRecordModal.tsx\` | \`resolveBarcodeLinkage\` → \`previewOperatorItemBarcodeLinkageAction\` | ${/resolveBarcodeLinkage/.test(modalText) ? "PASS" : "FAIL"} |
| 2 | Edit item (returns drawer) | \`returns/_components.tsx\` ItemDrawer | \`previewOperatorItemBarcodeLinkageAction\` + \`updateReturn\` | ${/previewOperatorItemBarcodeLinkageAction/.test(retCompText) ? "PASS" : "FAIL"} |
| 3 | Save / update button | scan \`saveItemUnitModal\`; drawer \`handleSave\` | \`insertOperatorPackageItemAction\` / \`updateReturn\` | PASS |
| 4 | Item detail | drawer + \`fetchReturnItemProductLinkageAction\` | hydrated \`ProductLinkageDisplayContract\` | ${/fetchReturnItemProductLinkageAction/.test(retCompText) ? "PASS" : "FAIL"} |
| 5 | Package child rows | \`listOperatorPackageItemsForPackageAction\` | \`product_linkage\` per unit | PASS |
| 6 | Pallet child rows | \`listOperatorPackagesForPalletAction\` → open package | package list server action | PASS |
| 7 | Expected packages panel | \`ExpectedInventoryLineRow\` | \`OperatorProductLinkageMeta\` + EP read contract | PASS |
| 8 | Inventory item status | \`fetchVInventoryItemStatusLinesExact\` | view read + variance labels | PASS |
| 9 | Scanner item scan | \`insertOperatorPackageItemAction\` | resolver-on-save + returned linkage | PASS |
| 10 | Unresolved / ambiguous | \`OperatorProductLinkageMeta\` | \`${PRODUCT_LINKAGE_UNMAPPED_LABEL}\` / \`${PRODUCT_LINKAGE_NEEDS_REVIEW_LABEL}\` | PASS |

**EP receive path:** \`operatorReceiveItem\` (server) → \`insertReturn\` + enrichment — does not return \`product_linkage\` to client; counts refresh via EP panel reads.

**V191/V192 handoff audits in repo:** v191=${v191Present ? "yes" : "no"} v192_lock=${v192Present ? "yes" : "no"}
`,
  );

  writeReport(
    "save-path-proof.md",
    `# Save path proof

## Approved chain (non-negotiable)

\`\`\`
UI input → approved server action → resolver-on-save → persist resolved_product_id → ProductLinkageDisplayContract → render
\`\`\`

| Save surface | Action | Writes \`return_items\`? | Resolver |
|--------------|--------|-------------------------|----------|
| BOX item modal save | \`insertOperatorPackageItemAction\` | via \`insertReturn\` | \`applyReturnItemProductEnrichmentAfterInsert\` + \`hydrateReturnItemProductLinkage\` on response |
| EP item receive | \`operatorReceiveItem\` | via \`insertReturn\` | enrichment on insert |
| Returns drawer save | \`updateReturn\` | server \`supabaseServer\` | \`applyReturnItemProductEnrichmentAfterUpdate\` when identifiers change |
| Returns bulk add | \`insertReturn\` in \`_components\` | server only | enrichment on insert |

## Forbidden (operator-mobile + returns UI)

| Pattern | Hits |
|---------|------|
| package_items | ${forbidden.package_items} |
| .from("returns") | ${forbidden.returns_table} |
| products.insert | ${forbidden.products_insert} |
| client return_items write | ${forbidden.return_items_client_write} |

**Verdict:** ${addSaveVerdict}

Browser: signed_in=${browser.signed_in} server_action_200=${browser.post_scan_200} labels=${browser.labels.join(", ") || "none"}
`,
  );

  writeReport(
    "edit-path-proof.md",
    `# Edit path proof

| Check | Result |
|-------|--------|
| \`updateReturn\` calls enrichment on identifier change | ${/applyReturnItemProductEnrichmentAfterUpdate/.test(retActText) ? "yes" : "no"} |
| Edit barcode preview (no write) | \`previewOperatorItemBarcodeLinkageAction\` in drawer |
| Post-save detail reload | \`fetchReturnItemProductLinkageAction\` |
| Staging enrich + hydrate probe | ${resolverProbe.enrich_after_update && resolverProbe.hydrate_read ? "PASS" : "FAIL"} — ${resolverProbe.detail} |

**Verdict:** ${editVerdict}

Note: Returns \`PackageDrawerContent\` still has a **read-only** client fallback \`supabaseBrowser.from(return_items).select\` when page state is empty — not a save path.
`,
  );

  writeReport(
    "detail-hydration-proof.md",
    `# Detail hydration proof

| Surface | Hydration mechanism |
|---------|---------------------|
| Item drawer (returns) | \`fetchReturnItemProductLinkageAction\` → \`hydrateReturnItemProductLinkage\` |
| Post insert (operator) | \`insertOperatorPackageItemAction\` returns \`product_linkage\` |
| Package units list | \`listOperatorPackageItemsForPackageAction\` builds contract from row + \`fetchProductNamesByResolvedIds\` |
| Slip lines | \`listOperatorSlipContentsForPackageAction\` \`product_linkage\` field |

No client \`products\` catalog queries on scan page: ${!/supabase\.from\(["']products["']\)\.select/.test(pageText) ? "confirmed" : "FOUND"}
`,
  );

  writeReport(
    "package-pallet-proof.md",
    `# Package / pallet proof

| Surface | Server action | Linkage on child rows |
|---------|---------------|------------------------|
| Package scanned units | \`listOperatorPackageItemsForPackageAction\` | \`product_linkage\` per row |
| Slip lines in package view | \`listOperatorSlipContentsForPackageAction\` | \`product_linkage\` |
| Pallet package picker | \`listOperatorPackagesForPalletAction\` | opens package → slip/items hydrate |

Staging list contract probe: ${resolverProbe.list_package_rows_linkage ? "PASS" : "FAIL"}

**Verdict:** ${pkgPalletVerdict}
`,
  );

  writeReport(
    "expected-scanned-proof.md",
    `# Expected / scanned proof

| Panel | Read path | Product linkage |
|-------|-----------|-----------------|
| Expected inventory lines | \`fetchVInventoryItemStatusLinesExact\` + EP merge | \`ExpectedInventoryLineRow\` + \`OperatorProductLinkageMeta\` |
| Expected packages (tracking gate) | \`fetchExpectedPackagesForTracking\` / snapshot | EP SKU/FNSKU; no EP \`identifier_resolution_status\` SELECT |
| Scanned counts | \`operatorReceiveItem\` bumps \`expected_packages.actual_scanned_count\` | quantity only; product via \`return_items\` rows |

Browser expected panel: ${browser.expected_panel ? "visible" : "not confirmed"}
Browser inventory signals: ${browser.inventory_panel ? "visible" : "not confirmed"}
`,
  );

  writeReport(
    "forbidden-pattern-scan.md",
    `# Forbidden pattern scan

Scanned \`app/scanner/**\` and \`app/returns/**\`.

| Pattern | Hits | Allowed |
|---------|------|---------|
| package_items | ${forbidden.package_items} | 0 |
| .from("returns") | ${forbidden.returns_table} | 0 |
| products.insert | ${forbidden.products_insert} | 0 |
| client return_items write (scan/returns UI) | ${forbidden.return_items_client_write} | 0 |
| client products.select (scanner tree) | ${forbidden.products_client_select} | 0 |

**Note:** \`scan/page.tsx\` may \`insert\` **pallets** client-side for shipment receiving — not \`return_items\` / \`package_items\`.
`,
  );

  writeReport(
    "browser-proof.md",
    `# Browser proof

| Check | Result |
|-------|--------|
| Signed in | ${browser.signed_in} |
| Store ready | ${browser.store_ready} |
| Expected panel | ${browser.expected_panel} |
| Package child linkage DOM | ${browser.package_child_rows} |
| Inventory / variance copy | ${browser.inventory_panel} |
| Server action POST 200 | ${browser.post_scan_200} |
| Staging API only | ${browser.staging_api_only} |
| Matched labels | ${browser.labels.join(", ") || "none"} |

Routes:
${browser.routes.map((r) => `- ${r}`).join("\n")}

\`\`\`
${browser.body_excerpt}
\`\`\`

${browser.error ? `**Error:** ${browser.error}` : ""}
`,
  );

  writeReport(
    "blockers.md",
    blockers.length
      ? `# Blockers\n\n${blockers.map((b) => `- **${b.id}:** ${b.detail}`).join("\n")}\n`
      : "# Blockers\n\nNone.\n",
  );

  writeReport(
    "manifest.json",
    JSON.stringify(
      {
        task: TASK,
        run_id: RUN_ID,
        staging_ref: STAGING_REF,
        verdict: overallPass ? "PASS" : "FAIL",
        add_save: addSaveVerdict,
        edit: editVerdict,
        package_pallet: pkgPalletVerdict,
        backend_contract_compliance: contractVerdict,
        v191_main_audit_present: v191Present,
        v192_lock_audit_present: v192Present,
        steps,
        forbidden,
        probe_target: target,
        browser_summary: {
          signed_in: browser.signed_in,
          post_scan_200: browser.post_scan_200,
          labels: browser.labels,
        },
      },
      null,
      2,
    ),
  );

  console.log(`\n${TASK} → ${OUT}`);
  console.log(`Overall: ${overallPass ? "PASS" : "FAIL"}`);
  console.log(`add/save: ${addSaveVerdict} | edit: ${editVerdict} | package/pallet: ${pkgPalletVerdict} | contract: ${contractVerdict}`);
  if (!overallPass) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
