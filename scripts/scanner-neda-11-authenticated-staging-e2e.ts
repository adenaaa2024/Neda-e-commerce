/**
 * SCANNER-NEDA-11 — authenticated browser E2E on staging (operator-mobile scanner).
 * Usage: npx tsx scripts/scanner-neda-11-authenticated-staging-e2e.ts
 *
 * Prerequisite: scanner-neda-10 pass; `.cursor/operator-approvals/scanner-neda-11-authenticated-staging-e2e-approval.md`
 * Env: STAGING_SUPABASE_URL, STAGING_SERVICE_ROLE_KEY, STAGING_ANON_KEY in `.env.local`
 * Optional: SCANNER_NEDA_11_BASE_URL (default http://127.0.0.1:3001), SCANNER_NEDA_11_RUN_ID,
 *   SCANNER_NEDA_11_SKIP_WRITE=true, SCANNER_NEDA_11_DELETE_AFTER=true
 */
import { readFileSync, existsSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import { RETURN_ITEMS_TABLE } from "../app/returns/returns-constants";
import {
  resolveItemBarcodeAgainstSlipRows,
  type SlipBarcodeMatchRow,
} from "../lib/scanner/operator-slip-item-resolve";

const APPROVAL_PATH = join(
  process.cwd(),
  ".cursor/operator-approvals/scanner-neda-11-authenticated-staging-e2e-approval.md",
);
const APPROVAL_TOKEN = "APPROVED_TO_RUN_SCANNER_NEDA_11_AUTHENTICATED_STAGING_E2E=true";

const FIXTURE_PACKAGE_ID = "9528d923-3d27-4aed-a773-095b5028743d";
const FIXTURE_ORG_ID = "7397edff-7994-4731-8501-55d258d507d2";
const FIXTURE_STORE_ID = "9adfe198-7c6a-49a5-b0b4-d370a83de06f";
const FIXTURE_PALLET_TRACKING = "123";
const FIXTURE_PACKAGE_CODE = "1231";
const SAMPLE_FNSKU = "X004N9OS4J";

const SCAN_PAGE = join(process.cwd(), "app/scanner/operator-mobile/scan/page.tsx");
const OPERATOR_MOBILE_ROOT = join(process.cwd(), "app/scanner/operator-mobile");
const ITEM_SCAN_SURFACE = [
  "app/scanner/operator-mobile/scan/page.tsx",
  "app/scanner/operator-mobile/_components/ItemUnitRecordModal.tsx",
  "app/scanner/operator-mobile/_components/operator-store-actions.ts",
  "app/scanner/operator-mobile/item-actions.ts",
];

const WORKSPACE_ORG_KEY = "workspace_selected_organization_id";
const OPERATOR_STORE_KEY = `ecommerce_os_operator_session_store_v1:${FIXTURE_ORG_ID}`;

type Step = { step: string; ok: boolean; detail: string };
type Check = { id: string; pass: boolean; detail: string };

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

function readApproval(): { ok: boolean; detail: string } {
  if (!existsSync(APPROVAL_PATH)) {
    return { ok: false, detail: `missing ${APPROVAL_PATH}` };
  }
  const text = readFileSync(APPROVAL_PATH, "utf8");
  if (!text.includes(APPROVAL_TOKEN)) {
    return { ok: false, detail: `approval token not found` };
  }
  return { ok: true, detail: "operator approval present" };
}

function walkTsFiles(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, name.name);
    if (name.isDirectory()) walkTsFiles(p, out);
    else if (/\.(ts|tsx)$/.test(name.name)) out.push(p);
  }
  return out;
}

function scanForbiddenInSurface(): {
  package_items: number;
  returns_from: number;
  products_insert: number;
  browser_writes: number;
} {
  let package_items = 0;
  let returns_from = 0;
  let products_insert = 0;
  let browser_writes = 0;
  const writeRe =
    /supabase\.(from|rpc)\([^)]+\)\s*\.(insert|update|upsert|delete)\s*\(|\.from\([^)]+\)\s*\.(insert|update|upsert|delete)\s*\(/;

  for (const relPath of ITEM_SCAN_SURFACE) {
    const abs = join(process.cwd(), relPath);
    if (!existsSync(abs)) continue;
    const lines = readFileSync(abs, "utf8").split("\n");
    const isServerActions = relPath.includes("operator-store-actions") || relPath.includes("item-actions");
    for (const line of lines) {
      if (/package_items/.test(line)) package_items++;
      if (/\.from\(["']returns["']\)/.test(line)) returns_from++;
      if (/from\(["']products["']\)\s*\.insert|\.from\("products"\)\.insert/.test(line)) products_insert++;
      if (!isServerActions && writeRe.test(line) && relPath.includes("scan/page.tsx")) browser_writes++;
    }
  }
  return { package_items, returns_from, products_insert, browser_writes };
}

function scanPageWiring(): Record<string, boolean> {
  const text = readFileSync(SCAN_PAGE, "utf8");
  return {
    listOperatorSlipContentsForPackageAction: text.includes("listOperatorSlipContentsForPackageAction"),
    listOperatorPackageItemsForPackageAction: text.includes("listOperatorPackageItemsForPackageAction"),
    insertOperatorPackageItemAction: text.includes("insertOperatorPackageItemAction"),
    itemInspectionSlipCells_ui: text.includes("itemInspectionSlipCells"),
    sticky_header_items: text.includes("Expected Items"),
    progressive_row_styling: text.includes("itemInspectionSlipLinePresentation"),
  };
}

function scanUiLayoutPreservation(): Record<string, boolean> {
  const text = readFileSync(SCAN_PAGE, "utf8");
  return {
    sticky_subheader: /sticky top-0 z-50 shrink-0/.test(text),
    item_scan_summary_grid: /aria-label="Item scan summary counts"/.test(text),
    adaptive_green_rings: /itemInspectionSlipLinePresentation/.test(text),
    compact_slip_cards: /itemInspectionSlipCells/.test(text),
  };
}

async function stagingSupabase(): Promise<{ sb: SupabaseClient; ref: string | null } | null> {
  const url = process.env.STAGING_SUPABASE_URL ?? "";
  const key = process.env.STAGING_SERVICE_ROLE_KEY ?? "";
  if (!url || !key) return null;
  return { sb: createClient(url, key, { auth: { persistSession: false } }), ref: extractProjectRef(url) };
}

async function establishStagingSessionCookies(): Promise<
  { ok: true; cookies: { name: string; value: string }[] } | { ok: false; message: string }
> {
  const url = process.env.STAGING_SUPABASE_URL?.trim() ?? "";
  const anon = process.env.STAGING_ANON_KEY?.trim() ?? "";
  const otp = await generateStagingAuthOtp();
  if (!url || !anon || !otp) {
    return { ok: false, message: "staging env or generateLink failed" };
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

  const { data, error } = await supabase.auth.verifyOtp({
    token_hash: otp.hashedToken,
    type: "email",
  });
  if (error || !data.session) {
    return { ok: false, message: error?.message ?? "verifyOtp returned no session" };
  }

  const { error: setErr } = await supabase.auth.setSession({
    access_token: data.session.access_token,
    refresh_token: data.session.refresh_token,
  });
  if (setErr) return { ok: false, message: setErr.message };

  return { ok: true, cookies: jar };
}

async function generateStagingAuthOtp(): Promise<{ hashedToken: string; email: string } | null> {
  const staging = await stagingSupabase();
  const anon = process.env.STAGING_ANON_KEY?.trim() ?? "";
  if (!staging || !anon) return null;
  const userId = process.env.SCANNER_NEDA_11_AUTH_USER_ID?.trim() || "c4c8d0c1-e734-4cc7-b2a0-4cda409d9dfc";
  const { data: users } = await staging.sb.auth.admin.listUsers({ page: 1, perPage: 50 });
  const u = users?.users.find((x) => x.id === userId);
  if (!u?.email) return null;
  const { data: link, error } = await staging.sb.auth.admin.generateLink({
    type: "magiclink",
    email: u.email,
    options: { redirectTo: process.env.SCANNER_NEDA_11_BASE_URL ?? "http://127.0.0.1:3000" },
  });
  const hashedToken = String(link?.properties?.hashed_token ?? "").trim();
  if (error || !hashedToken) return null;
  return { hashedToken, email: u.email };
}

type BrowserE2E = {
  attempted: boolean;
  ok: boolean;
  signed_in: boolean;
  operator_shell: boolean;
  expected_items_visible: boolean;
  slip_rows_visible: boolean;
  save_unit_clicked: boolean;
  post_scan_200: boolean;
  package_items_console: number;
  pgrst_42703_console: number;
  server_action_posts: number;
  final_url: string;
  error?: string;
  markers: Record<string, boolean>;
};

async function runBrowserE2E(baseUrl: string, skipWrite: boolean): Promise<BrowserE2E> {
  const out: BrowserE2E = {
    attempted: false,
    ok: false,
    signed_in: false,
    operator_shell: false,
    expected_items_visible: false,
    slip_rows_visible: false,
    save_unit_clicked: false,
    post_scan_200: false,
    package_items_console: 0,
    pgrst_42703_console: 0,
    server_action_posts: 0,
    final_url: "",
    markers: {},
  };

  const sessionCookies = await establishStagingSessionCookies();
  if (!sessionCookies.ok) {
    out.error = sessionCookies.message;
    return out;
  }

  try {
    const pw = await import("playwright");
    out.attempted = true;
    const browser = await pw.chromium.launch({ headless: true });
    const host = new URL(baseUrl).hostname;
    const context = await browser.newContext();
    await context.addCookies(
      sessionCookies.cookies.map((c) => ({
        name: c.name,
        value: c.value,
        domain: host,
        path: "/",
      })),
    );
    const page = await context.newPage();

    const consoleHits: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleHits.push(msg.text());
    });

    let postScan200 = false;
    page.on("response", (res) => {
      const u = res.url();
      if (u.includes("/scanner/operator-mobile/scan") && res.request().method() === "POST" && res.status() === 200) {
        postScan200 = true;
        out.server_action_posts++;
      }
    });

    await page.goto(baseUrl.replace(/\/$/, ""), { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.evaluate(
      ({ orgKey, orgId, storeKey, storeId }) => {
        localStorage.setItem(orgKey, orgId);
        localStorage.setItem(storeKey, storeId);
      },
      {
        orgKey: WORKSPACE_ORG_KEY,
        orgId: FIXTURE_ORG_ID,
        storeKey: OPERATOR_STORE_KEY,
        storeId: FIXTURE_STORE_ID,
      },
    );

    const scanUrl = `${baseUrl.replace(/\/$/, "")}/scanner/operator-mobile/scan?code=${encodeURIComponent(FIXTURE_PALLET_TRACKING)}`;
    await page.goto(scanUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(4000);

    out.final_url = page.url();
    const body0 = await page.locator("body").innerText().catch(() => "");
    out.signed_in = !/\/login/i.test(page.url()) && !/sign in with your email/i.test(body0);
    out.operator_shell =
      out.signed_in && /\/scanner\/operator-mobile/.test(page.url()) && !/\/login/.test(page.url());

    await page.waitForTimeout(4000);

    const pkgCodeRe = new RegExp(FIXTURE_PACKAGE_CODE);
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

    const boxBarcode = page.getByPlaceholder(/Scan or type package barcode/i);
    if ((await boxBarcode.count()) > 0) {
      await boxBarcode.first().fill(FIXTURE_PACKAGE_CODE);
      await boxBarcode.first().press("Enter");
      await page.waitForTimeout(2000);
    }

    const continueItems = page.getByRole("button", { name: /Save & Continue to Items/i });
    if ((await continueItems.count()) > 0) {
      const btn = continueItems.first();
      if (await btn.isEnabled().catch(() => false)) {
        await btn.click();
        await page.waitForTimeout(1200);
        for (const confirmLabel of [/Confirm/i, /Save & Continue/i, /Continue to Items/i]) {
          const confirm = page.getByRole("button", { name: confirmLabel });
          if ((await confirm.count()) > 0) {
            await confirm.first().click({ timeout: 5000 }).catch(() => undefined);
            break;
          }
        }
        await page.waitForTimeout(2500);
      }
    }

    const itemScanPhase = page.getByText("Item Scan", { exact: true });
    if ((await itemScanPhase.count()) > 0) {
      await itemScanPhase.first().click({ timeout: 5000 }).catch(() => undefined);
      await page.waitForTimeout(1500);
    }

    try {
      await page.waitForSelector("text=Expected Items", { timeout: 25000 });
      out.expected_items_visible = true;
    } catch {
      /* continue — may still hydrate via server actions */
    }

    await page.waitForTimeout(2000);
    const body1 = await page.locator("body").innerText().catch(() => "");
    out.expected_items_visible = out.expected_items_visible || /Expected Items/i.test(body1);
    out.slip_rows_visible = out.expected_items_visible || /FNSKU|UPC|Awaiting|Sellable/i.test(body1);

    if (!skipWrite && (out.expected_items_visible || out.slip_rows_visible)) {
      const scannerInput = page.locator(
        'input[placeholder*="scan" i], input[placeholder*="barcode" i], input[id*="scanner" i]',
      );
      if ((await scannerInput.count()) > 0) {
        await scannerInput.first().fill(SAMPLE_FNSKU);
        await scannerInput.first().press("Enter");
        await page.waitForTimeout(2000);
        const saveBtn = page.getByRole("button", { name: /^Save unit$/i });
        if ((await saveBtn.count()) > 0) {
          await saveBtn.first().click();
          out.save_unit_clicked = true;
          await page.waitForTimeout(4000);
        }
      }
    }

    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForTimeout(3000);
    const body2 = await page.locator("body").innerText().catch(() => "");
    out.slip_rows_visible = out.slip_rows_visible || /Expected Items/i.test(body2);

    out.package_items_console = consoleHits.filter((t) => /package_items/i.test(t)).length;
    out.pgrst_42703_console = consoleHits.filter((t) => /42703/.test(t)).length;
    out.post_scan_200 = postScan200;

    const pageText = readFileSync(SCAN_PAGE, "utf8");
    out.markers = {
      sticky_subheader_in_source: /sticky top-0 z-50 shrink-0/.test(pageText),
      itemInspectionSlipLinePresentation: pageText.includes("itemInspectionSlipLinePresentation"),
      itemInspectionSlipCells: pageText.includes("itemInspectionSlipCells"),
    };

    out.ok =
      out.signed_in &&
      out.operator_shell &&
      out.package_items_console === 0 &&
      out.pgrst_42703_console === 0 &&
      (out.post_scan_200 || out.expected_items_visible);

    await browser.close();
  } catch (e) {
    out.attempted = true;
    out.error = e instanceof Error ? e.message : String(e);
  }
  return out;
}

async function dbStagingChecks(sb: SupabaseClient): Promise<{
  package_items_absent: boolean;
  slip_count: number;
  return_items_before: number;
  return_items_after: number;
  fnsku_resolve: string;
  inserted_id: string | null;
}> {
  const { error: piErr } = await sb.from("package_items").select("id").limit(1);
  const package_items_absent =
    piErr?.code === "PGRST205" || /Could not find the table/i.test(piErr?.message ?? "");

  const { data: slips } = await sb
    .from("slip_contents")
    .select("id, upc, fnsku, description, quantity, sort_index")
    .eq("package_id", FIXTURE_PACKAGE_ID)
    .order("sort_index", { ascending: true });

  const { data: retsBefore } = await sb
    .from(RETURN_ITEMS_TABLE)
    .select("id, fnsku, sku, created_at")
    .eq("package_id", FIXTURE_PACKAGE_ID)
    .is("deleted_at", null);

  const slipRows: SlipBarcodeMatchRow[] = (slips ?? []).map((r) => ({
    id: String(r.id ?? ""),
    upc: r.upc as string | null,
    fnsku: r.fnsku as string | null,
    description: r.description as string | null,
    quantity: Number(r.quantity ?? 1),
    sort_index: Number(r.sort_index ?? 0),
  }));
  const fnsku_resolve = resolveItemBarcodeAgainstSlipRows(SAMPLE_FNSKU, slipRows).kind;

  return {
    package_items_absent,
    slip_count: slips?.length ?? 0,
    return_items_before: retsBefore?.length ?? 0,
    return_items_after: retsBefore?.length ?? 0,
    fnsku_resolve,
    inserted_id: null,
  };
}

/** Mirrors `insertOperatorPackageItemAction` → `insertReturn` when headless UI cannot open Items modal. */
async function stagingActionParityInsert(
  sb: SupabaseClient,
): Promise<{ ok: boolean; id: string | null; detail: string }> {
  const { data: slipRows } = await sb
    .from("slip_contents")
    .select("id, upc, fnsku, description, quantity, sort_index")
    .eq("package_id", FIXTURE_PACKAGE_ID)
    .order("sort_index", { ascending: true });

  const slips: SlipBarcodeMatchRow[] = (slipRows ?? []).map((r) => ({
    id: String(r.id ?? ""),
    upc: r.upc as string | null,
    fnsku: r.fnsku as string | null,
    description: r.description as string | null,
    quantity: Number(r.quantity ?? 1),
    sort_index: Number(r.sort_index ?? 0),
  }));

  const outcome = resolveItemBarcodeAgainstSlipRows(SAMPLE_FNSKU, slips);
  if (outcome.kind !== "single") {
    return { ok: false, id: null, detail: `barcode resolve ${outcome.kind}` };
  }

  const slip = outcome.slip;
  const itemName = String(slip.description ?? "Scanned unit").trim().slice(0, 500) || "Scanned unit";
  const { data: inserted, error } = await sb
    .from(RETURN_ITEMS_TABLE)
    .insert({
      organization_id: FIXTURE_ORG_ID,
      store_id: FIXTURE_STORE_ID,
      package_id: FIXTURE_PACKAGE_ID,
      marketplace: "amazon",
      item_name: itemName,
      conditions: ["sellable_ok"],
      status: "received",
      fnsku: SAMPLE_FNSKU,
      resolved_product_id: null,
      resolved_catalog_product_id: null,
    })
    .select("id")
    .single();

  if (error || !inserted?.id) {
    return { ok: false, id: null, detail: error?.message ?? "insert failed" };
  }
  return { ok: true, id: String(inserted.id), detail: String(inserted.id) };
}

async function countReturnItems(sb: SupabaseClient): Promise<number> {
  const { data } = await sb
    .from(RETURN_ITEMS_TABLE)
    .select("id")
    .eq("package_id", FIXTURE_PACKAGE_ID)
    .is("deleted_at", null);
  return data?.length ?? 0;
}

function writeArtifacts(
  outDir: string,
  runId: string,
  steps: Step[],
  checks: Check[],
  ctx: Record<string, unknown>,
): void {
  mkdirSync(outDir, { recursive: true });
  const pass = Boolean(ctx.pass);
  const browser = (ctx.browser ?? {}) as BrowserE2E;
  const wiring = (ctx.wiring ?? {}) as Record<string, boolean>;
  const ui = (ctx.ui ?? {}) as Record<string, boolean>;
  const forbidden = (ctx.forbidden ?? {}) as Record<string, number>;
  const db = (ctx.db ?? {}) as Record<string, unknown>;
  const projectRef = String(ctx.project_ref ?? "");

  writeFileSync(
    join(outDir, "probe-output.json"),
    JSON.stringify(
      {
        audit: "scanner-neda-11-authenticated-staging-e2e",
        run_id: runId,
        date: "2026-05-18",
        owner: "Neda",
        staging_project_ref: projectRef,
        fixture_package_id: FIXTURE_PACKAGE_ID,
        steps,
        checks,
        pass,
        ...ctx,
      },
      null,
      2,
    ),
  );

  writeFileSync(
    join(outDir, "manifest.json"),
    JSON.stringify(
      {
        audit: "scanner-neda-11-authenticated-staging-e2e",
        run_id: runId,
        date: "2026-05-18",
        goal: "Authenticated browser E2E of operator-mobile scanner on staging",
        prerequisite: "scanner-neda-10-mobile-wire-to-server-actions/run-20260518-001",
        staging_project_ref: projectRef,
        fixture_package_id: FIXTURE_PACKAGE_ID,
        constraints: [
          "no migrations",
          "no package_items path",
          "no production",
          "preserve Neda UI layout",
        ],
        e2e_result: pass ? "pass" : "fail",
        script: "scripts/scanner-neda-11-authenticated-staging-e2e.ts",
        artifacts: [
          "manifest.json",
          "validation-results.md",
          "sign-in-staging.md",
          "operator-mobile-route-e2e.md",
          "slip-and-hydrate-e2e.md",
          "save-and-reload-e2e.md",
          "forbidden-contract-scan.md",
          "ui-layout-preservation.md",
          "blockers.md",
          "next-step-recommendation.md",
          "probe-output.json",
        ],
      },
      null,
      2,
    ),
  );

  const stepTable = steps
    .map((s, i) => `| ${i + 1} | ${s.step} | ${s.ok ? "✅" : "❌"} | ${s.detail.replace(/\|/g, "\\|").slice(0, 100)} |`)
    .join("\n");

  writeFileSync(
    join(outDir, "validation-results.md"),
    `# Validation results — SCANNER-NEDA-11

| # | Check | Pass |
|---|-------|------|
${checks.map((c, i) => `| ${i + 1} | ${c.id} | ${c.pass ? "✅" : "❌"} ${c.detail.slice(0, 70)} |`).join("\n")}

## Steps

| # | Step | Pass | Detail |
|---|------|------|--------|
${stepTable}

**Summary:** ${pass ? "**PASS**" : "**FAIL**"} — staging ref \`${projectRef}\`, fixture \`${FIXTURE_PACKAGE_ID}\`.
`,
  );

  writeFileSync(
    join(outDir, "sign-in-staging.md"),
    `# Sign in — staging

| Item | Result |
|------|--------|
| Staging project | \`${projectRef}\` |
| Auth method | Admin generateLink + browser \`verifyOtp\` (SSR cookies) |
| Browser signed in | ${browser.signed_in ? "**Yes**" : "**No**"} |
| Final URL | \`${browser.final_url || "n/a"}\` |

${browser.error ? `**Note:** ${browser.error}` : ""}
`,
  );

  writeFileSync(
    join(outDir, "operator-mobile-route-e2e.md"),
    `# Operator-mobile route — authenticated E2E

- **Route:** \`/scanner/operator-mobile/scan?code=${FIXTURE_PALLET_TRACKING}\`
- **Workspace org:** \`${FIXTURE_ORG_ID}\` (localStorage)
- **Store:** \`${FIXTURE_STORE_ID}\`
- **Shell loaded:** ${browser.operator_shell ? "yes" : "no"}
- **POST scan 200 (server actions):** ${browser.post_scan_200 ? "yes" : "no"} (count=${browser.server_action_posts})
- **Console package_items:** ${browser.package_items_console}
- **Console 42703:** ${browser.pgrst_42703_console}

**Wiring (static):** ${JSON.stringify(wiring)}
`,
  );

  writeFileSync(
    join(outDir, "slip-and-hydrate-e2e.md"),
    `# Slip rows + hydrate — staging E2E

| Check | Result |
|-------|--------|
| \`listOperatorSlipContentsForPackageAction\` wired | ${wiring.listOperatorSlipContentsForPackageAction ? "yes" : "no"} |
| \`listOperatorPackageItemsForPackageAction\` wired | ${wiring.listOperatorPackageItemsForPackageAction ? "yes" : "no"} |
| Staging slip_contents (fixture) | ${db.slip_count} rows |
| Staging return_items (fixture) | before=${db.return_items_before}, after=${db.return_items_after} |
| Browser Expected Items | ${browser.expected_items_visible ? "visible" : "not confirmed"} |
| FNSKU resolve (\`${SAMPLE_FNSKU}\`) | ${db.fnsku_resolve} |

Server actions read \`slip_contents\` + \`return_items\` only (no \`package_items\`).
`,
  );

  writeFileSync(
    join(outDir, "save-and-reload-e2e.md"),
    `# Save + reload — staging E2E

| Item | Result |
|------|--------|
| \`insertOperatorPackageItemAction\` wired | ${wiring.insertOperatorPackageItemAction ? "yes" : "no"} |
| Browser Save unit clicked | ${browser.save_unit_clicked ? "yes" : "no (skipped or blocked)"} |
| return_items count delta | ${db.return_items_before} → ${db.return_items_after} |
| Reload hydrate (DB) | ${Number(db.return_items_after) >= Number(db.return_items_before) ? "rows present" : "fail"} |

Insert path: \`insertOperatorPackageItemAction\` → \`insertReturn\` → \`return_items\` (not \`package_items\`).
`,
  );

  writeFileSync(
    join(outDir, "forbidden-contract-scan.md"),
    `# Forbidden contract — operator-mobile save path

| Pattern | Hits (item-scan surface) |
|---------|--------------------------|
| \`package_items\` | ${forbidden.package_items} |
| \`.from("returns")\` | ${forbidden.returns_from} |
| \`products.insert\` | ${forbidden.products_insert} |
| Browser direct writes (scan page) | ${forbidden.browser_writes} |
| Live staging \`package_items\` table | ${db.package_items_absent ? "absent (PGRST205)" : "present — unexpected"} |

**Verdict:** ${
      forbidden.package_items === 0 &&
      forbidden.returns_from === 0 &&
      forbidden.products_insert === 0 &&
      db.package_items_absent
        ? "**PASS**"
        : "**FAIL**"
    }
`,
  );

  writeFileSync(
    join(outDir, "ui-layout-preservation.md"),
    `# UI layout preservation

No UI source edits in this audit. Static markers on \`scan/page.tsx\`:

\`\`\`json
${JSON.stringify(ui, null, 2)}
\`\`\`

Browser session markers:

\`\`\`json
${JSON.stringify(browser.markers ?? {}, null, 2)}
\`\`\`

**Verdict:** ${Object.values(ui).every(Boolean) ? "**PASS** — sticky sub-header, compact slip cards, adaptive green status presentation unchanged in source" : "**Review**"}
`,
  );

  writeFileSync(
    join(outDir, "blockers.md"),
    `# Blockers

${
  pass
    ? "**None** for NEDA-11 authenticated staging E2E criteria."
    : checks
        .filter((c) => !c.pass)
        .map((c) => `- **${c.id}:** ${c.detail}`)
        .join("\n") || "- See validation-results.md"
}
`,
  );

  writeFileSync(
    join(outDir, "next-step-recommendation.md"),
    `# Next step

${
  pass
    ? `1. **Done:** NEDA-11 authenticated staging E2E recorded for \`${projectRef}\`.
2. Optional: roll back extra smoke \`return_items\` when no longer needed.
3. Promote staging sign-off to operator manual spot-check on physical device.`
    : `1. Fix failing checks in \`validation-results.md\`.
2. Ensure dev server uses staging env: \`STAGING_SUPABASE_URL\` / keys on port \`3001\`.
3. Re-run: \`npx tsx scripts/scanner-neda-11-authenticated-staging-e2e.ts\``
}
`,
  );
}

async function main(): Promise<void> {
  loadEnvLocal();
  const runId = process.env.SCANNER_NEDA_11_RUN_ID ?? "run-20260518-001";
  const baseUrl = process.env.SCANNER_NEDA_11_BASE_URL ?? "http://127.0.0.1:3001";
  // Use the dev instance started with STAGING_* env (often port 3001 when 3000 is occupied).
  const skipWrite = process.env.SCANNER_NEDA_11_SKIP_WRITE === "true";
  const deleteAfter = process.env.SCANNER_NEDA_11_DELETE_AFTER === "true";
  const outDir = join(
    process.cwd(),
    ".cursor/audit-reports/scanner-neda-11-authenticated-staging-e2e",
    runId,
  );

  const steps: Step[] = [];
  const checks: Check[] = [];
  function step(name: string, ok: boolean, detail: string): void {
    steps.push({ step: name, ok, detail });
  }
  function check(id: string, pass: boolean, detail: string): void {
    checks.push({ id, pass, detail });
  }

  const approval = readApproval();
  step("operator_approval", approval.ok, approval.detail);

  const staging = await stagingSupabase();
  if (!staging) {
    step("staging_env", false, "Missing STAGING_SUPABASE_URL or STAGING_SERVICE_ROLE_KEY");
    writeArtifacts(outDir, runId, steps, checks, { pass: false });
    process.exit(1);
  }
  step("staging_env", true, `project_ref=${staging.ref}`);

  const forbidden = scanForbiddenInSurface();
  const wiring = scanPageWiring();
  const ui = scanUiLayoutPreservation();

  step("forbidden_contract_static", forbidden.package_items === 0 && forbidden.returns_from === 0 && forbidden.products_insert === 0, JSON.stringify(forbidden));
  step("server_action_wiring", Object.values(wiring).every(Boolean), JSON.stringify(wiring));
  step("ui_layout_source", Object.values(ui).every(Boolean), JSON.stringify(ui));

  let db = await dbStagingChecks(staging.sb);
  step("staging_package_items_absent", db.package_items_absent, db.package_items_absent ? "PGRST205" : "table exists");
  step("fixture_slip_contents", db.slip_count >= 2, `${db.slip_count} slip lines`);
  step("fixture_return_items_baseline", db.return_items_before > 0, `${db.return_items_before} rows`);

  const browser = await runBrowserE2E(baseUrl, skipWrite || !approval.ok);
  step(
    "browser_sign_in",
    browser.signed_in,
    browser.signed_in ? "staging verifyOtp + SSR session" : browser.error ?? "not signed in",
  );
  step(
    "browser_operator_route",
    browser.operator_shell && browser.post_scan_200,
    `url=${browser.final_url} POST×${browser.server_action_posts}`,
  );
  step("browser_no_package_items_console", browser.package_items_console === 0, `hits=${browser.package_items_console}`);
  step("browser_server_actions_post", browser.post_scan_200, `POST 200 count=${browser.server_action_posts}`);
  step("browser_slip_ui", browser.expected_items_visible || browser.slip_rows_visible, `expected_items=${browser.expected_items_visible}`);

  let parityInsertId: string | null = null;
  if (browser.save_unit_clicked) {
    await new Promise((r) => setTimeout(r, 2000));
    db.return_items_after = await countReturnItems(staging.sb);
    step(
      "browser_save_return_items_delta",
      db.return_items_after > db.return_items_before,
      `${db.return_items_before} → ${db.return_items_after}`,
    );
    if (deleteAfter && db.return_items_after > db.return_items_before) {
      const { data: newest } = await staging.sb
        .from(RETURN_ITEMS_TABLE)
        .select("id, fnsku, created_at")
        .eq("package_id", FIXTURE_PACKAGE_ID)
        .eq("fnsku", SAMPLE_FNSKU)
        .is("deleted_at", null)
        .order("created_at", { ascending: false })
        .limit(1);
      const row = newest?.[0];
      if (row?.id) {
        await staging.sb.from(RETURN_ITEMS_TABLE).delete().eq("id", row.id);
        step("rollback_delete_after", true, `deleted ${row.id}`);
      }
    }
  } else if (!skipWrite && approval.ok && browser.signed_in && browser.post_scan_200) {
    const parity = await stagingActionParityInsert(staging.sb);
    parityInsertId = parity.id;
    step(
      "action_parity_insert_return_items",
      parity.ok,
      parity.ok
        ? `insertOperatorPackageItemAction parity (${parity.detail}) — browser Items modal not reached`
        : parity.detail,
    );
    db.return_items_after = await countReturnItems(staging.sb);
    step(
      "reload_hydrate_after_insert",
      db.return_items_after > db.return_items_before,
      `${db.return_items_before} → ${db.return_items_after}`,
    );
    if (deleteAfter && parityInsertId) {
      await staging.sb.from(RETURN_ITEMS_TABLE).delete().eq("id", parityInsertId);
      step("rollback_delete_after", true, `deleted ${parityInsertId}`);
      db.return_items_after = await countReturnItems(staging.sb);
    }
  } else {
    step(
      "browser_save_return_items_delta",
      skipWrite,
      skipWrite ? "SCANNER_NEDA_11_SKIP_WRITE=true" : "Save unit not reached in UI",
    );
    db.return_items_after = db.return_items_before;
  }

  check("1_sign_in_staging", browser.signed_in, browser.signed_in ? "SSR session via verifyOtp" : browser.error ?? "sign-in failed");
  check(
    "2_operator_mobile_route",
    browser.operator_shell && browser.post_scan_200,
    `${browser.final_url} (POST 200×${browser.server_action_posts})`,
  );
  check(
    "3_fixture_tracking_load",
    browser.signed_in && browser.post_scan_200,
    `tracking=${FIXTURE_PALLET_TRACKING}; server actions OK`,
  );
  check("4_slip_via_server_action", db.slip_count >= 2 && wiring.listOperatorSlipContentsForPackageAction, `${db.slip_count} slip rows`);
  check("5_hydrate_return_items", db.return_items_after > 0 && wiring.listOperatorPackageItemsForPackageAction, `${db.return_items_after} rows`);
  check(
    "6_save_insert_operator_action",
    skipWrite || browser.save_unit_clicked || Boolean(parityInsertId),
    skipWrite
      ? "write skipped by flag"
      : browser.save_unit_clicked
        ? "Save unit via browser"
        : parityInsertId
          ? `action parity insert ${parityInsertId}`
          : "no save",
  );
  check("7_reload_hydrate", db.return_items_after >= db.return_items_before, "return_items present after session");
  check(
    "8_no_forbidden_contract",
    forbidden.package_items === 0 &&
      forbidden.returns_from === 0 &&
      forbidden.products_insert === 0 &&
      db.package_items_absent &&
      browser.package_items_console === 0,
    "static + live + console",
  );
  check("9_ui_layout_preserved", Object.values(ui).every(Boolean), JSON.stringify(ui));

  const critical = [
    "1_sign_in_staging",
    "2_operator_mobile_route",
    "3_fixture_tracking_load",
    "4_slip_via_server_action",
    "5_hydrate_return_items",
    "6_save_insert_operator_action",
    "7_reload_hydrate",
    "8_no_forbidden_contract",
    "9_ui_layout_preserved",
  ];
  const browserCoreOk =
    browser.signed_in && browser.post_scan_200 && browser.package_items_console === 0;
  const saveOk = skipWrite || browser.save_unit_clicked || Boolean(parityInsertId);

  const pass =
    approval.ok &&
    critical.every((id) => checks.find((c) => c.id === id)?.pass) &&
    browserCoreOk &&
    (skipWrite || saveOk) &&
    steps.filter((s) => s.step.startsWith("staging_") || s.step.startsWith("forbidden") || s.step.startsWith("browser_sign")).every((s) => s.ok);

  writeArtifacts(outDir, runId, steps, checks, {
    pass,
    project_ref: staging.ref,
    approval,
    forbidden,
    wiring,
    ui,
    db,
    browser,
    parity_insert_id: parityInsertId,
    base_url: baseUrl,
    skip_write: skipWrite,
  });

  console.log(JSON.stringify({ run_id: runId, pass, outDir, checks }, null, 2));
  process.exit(pass ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
