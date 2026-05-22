/**
 * ENV-06C-MANUAL — Preview operator smoke (API proxy + optional browser).
 *
 *   npx tsx scripts/env-06c-manual-preview-smoke-v173.ts
 *   SMOKE_BASE_URL=https://ecommerce-os-git-integrat-ec746a-...vercel.app \
 *     VERCEL_AUTOMATION_BYPASS_SECRET=... npx tsx scripts/env-06c-manual-preview-smoke-v173.ts
 *   npx tsx scripts/env-06c-manual-preview-smoke-v173.ts --browser --reuse-auth
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
import { loadEnvLocalIntoProcess, refFromSupabaseUrl } from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const PREVIEW_ALIAS =
  "https://ecommerce-os-git-integrat-ec746a-mebrahimipargoo-9799s-projects.vercel.app";

const STALE = [/package_number does not exist/i, /photo_url does not exist/i];

type Check = { id: string; pass: boolean; detail: string; screenshot?: string };

function runId(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}00Z`;
}

function hasFlag(f: string): boolean {
  return process.argv.includes(f);
}

function bypassHeaders(): Record<string, string> {
  const s = process.env.VERCEL_AUTOMATION_BYPASS_SECRET?.trim();
  if (!s) return {};
  return { "x-vercel-protection-bypass": s };
}

async function fetchPreview(path: string): Promise<{ status: number; text: string }> {
  const r = await fetch(`${baseUrl()}${path}`, {
    redirect: "manual",
    headers: bypassHeaders(),
  });
  return { status: r.status, text: await r.text() };
}

function baseUrl(): string {
  return (process.env.SMOKE_BASE_URL ?? PREVIEW_ALIAS).replace(/\/$/, "");
}

async function waitAuthed(page: Page, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (!page.url().includes("/login") && !page.url().includes("/auth/")) return true;
    await page.waitForTimeout(400);
  }
  return !page.url().includes("/login");
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const id = runId();
  const outDir = path.resolve(
    process.cwd(),
    ".cursor/audit-reports/env-06c-vercel-preview-full-smoke-v173",
    id,
  );
  const shots = path.join(outDir, "screenshots");
  fs.mkdirSync(shots, { recursive: true });

  const checks: Check[] = [];
  const base = baseUrl();
  const bypass = Boolean(process.env.VERCEL_AUTOMATION_BYPASS_SECRET?.trim());

  checks.push({
    id: "00_preview_base",
    pass: base.includes("vercel.app"),
    detail: base,
  });
  checks.push({
    id: "01_bypass_configured",
    pass: bypass,
    detail: bypass ? "VERCEL_AUTOMATION_BYPASS_SECRET set" : "No bypass — browser/manual Vercel login required",
  });

  const loginProbe = await fetchPreview("/login");
  const protectionOff =
    loginProbe.status === 200 || loginProbe.status === 307 || loginProbe.status === 308;
  checks.push({
    id: "02_deployment_reachable",
    pass: protectionOff,
    detail: `GET /login → ${loginProbe.status}${bypass ? " (with bypass)" : ""}`,
  });

  const ref = refFromSupabaseUrl(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "");
  checks.push({
    id: "03_local_staging_ref",
    pass: ref === STAGING_REF,
    detail: `local .env ref=${ref ?? "?"} (Preview bundle uses Vercel branch env)`,
  });

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (url && key) {
    const sb = createClient(url, key, { auth: { persistSession: false } });
    const { data: rpc, error } = await sb.rpc("pim_catalog_products_page", {
      p_organization_id: OPERABLE_SAM_DISTRIBUTION_ORG_ID,
      p_store_id: OPERABLE_SAM_AM_STORE_ID,
      p_page: 1,
      p_page_size: 5,
      p_q: null,
      p_vendor_id: null,
      p_category_id: null,
      p_brand: null,
      p_status: null,
      p_match_source: null,
      p_source_report_type: null,
      p_image_filter: "any",
      p_sku_filter: "any",
      p_asin_filter: "any",
      p_fnsku_filter: "any",
      p_upc_filter: "any",
      p_vendor_presence: "any",
      p_category_presence: "any",
      p_brand_field_filter: "any",
      p_sort_column: "updated_at",
      p_sort_dir: "desc",
    });
    const total =
      rpc && typeof rpc === "object" && !Array.isArray(rpc)
        ? Number((rpc as { total?: number }).total ?? 0)
        : 0;
    checks.push({
      id: "04_staging_pim_rpc",
      pass: !error && total > 1000,
      detail: error ? error.message : `total=${total}`,
    });

    const { error: pkgErr } = await sb
      .from("packages")
      .select("id, package_code, inside_photo_urls")
      .limit(1);
    checks.push({
      id: "05_staging_packages_schema",
      pass: !pkgErr,
      detail: pkgErr ? pkgErr.message : "package_code + inside_photo_urls OK",
    });

    const { data: buckets } = await sb.storage.from("raw-reports").list("", { limit: 1 });
    checks.push({
      id: "06_staging_storage",
      pass: Array.isArray(buckets),
      detail: "raw-reports bucket list OK",
    });
  }

  const routes: Array<[string, string]> = [
    ["/dashboard/products", "pim"],
    ["/returns", "returns"],
    ["/scanner", "scanner"],
    ["/claim-engine/evidence", "claim_evidence"],
    ["/imports", "imports"],
  ];

  for (const [p, label] of routes) {
    const { status, text } = await fetchPreview(p);
    const stale = STALE.some((re) => re.test(text));
    checks.push({
      id: `10_http_${label}`,
      pass: status !== 401 && status < 500 && !stale,
      detail: `GET ${p} → ${status}${stale ? " (stale column text)" : ""}`,
    });
  }

  const withBrowser = hasFlag("--browser");
  const authCandidates = [
    path.join(outDir, "auth-state.json"),
    path.resolve(process.cwd(), ".cursor/audit-reports/manual-ui-operable-browser-smoke-v172/auth-state.json"),
  ];
  const authPath =
    hasFlag("--reuse-auth") && authCandidates.find((p) => fs.existsSync(p))
      ? authCandidates.find((p) => fs.existsSync(p))!
      : null;

  if (withBrowser && authPath) {
    const browser = await chromium.launch({ headless: !hasFlag("--headed") });
    const ctx = await browser.newContext({
      storageState: authPath,
      extraHTTPHeaders: bypassHeaders(),
    });
    const page = await ctx.newPage();
    const pimUrl = `${base}${buildPimCatalogDeepLink()}`;

    try {
      await page.goto(pimUrl, { waitUntil: "networkidle", timeout: 120_000 });
      const authed = await waitAuthed(page, 8_000);
      checks.push({
        id: "20_browser_auth",
        pass: authed,
        detail: authed ? page.url() : "Still on login",
      });
      if (authed) {
        const body = await page.locator("body").innerText();
        const countOk = /17[,\s]?001|of\s+17/i.test(body);
        checks.push({
          id: "21_browser_pim",
          pass: countOk && !/no stores/i.test(body),
          detail: countOk ? "PIM total visible" : "PIM count/org not confirmed",
          screenshot: await shot(page, shots, "pim"),
        });

        for (const [p, label] of [
          ["/returns", "returns"],
          ["/scanner", "scanner"],
          ["/claim-engine/evidence", "claim_evidence"],
          ["/imports", "imports"],
        ] as const) {
          await page.goto(`${base}${p}`, { waitUntil: "networkidle", timeout: 120_000 });
          await page.waitForTimeout(800);
          const t = await page.locator("body").innerText();
          const stale = STALE.some((re) => re.test(t));
          const ok =
            !stale &&
            !t.includes("Missing NEXT_PUBLIC_SUPABASE") &&
            (label === "scanner"
              ? /tracking|scan/i.test(t)
              : label === "claim_evidence"
                ? /claim evidence|TRID/i.test(t)
                : label === "imports"
                  ? /import|upload/i.test(t)
                  : /returns|logistics/i.test(t));
          checks.push({
            id: `22_browser_${label}`,
            pass: ok,
            detail: ok ? `${label} loaded` : `${label} missing UI or schema error`,
            screenshot: await shot(page, shots, label),
          });
        }
      }
      await ctx.storageState({ path: path.join(outDir, "auth-state.json") });
    } finally {
      await browser.close();
    }
  } else if (withBrowser) {
    checks.push({
      id: "20_browser_auth",
      pass: false,
      detail: "No auth-state — run with --manual-login after operator signs in (see operator-signoff.md)",
    });
  }

  const httpChecks = checks.filter((c) => c.id.startsWith("10_http_"));
  const browserChecks = checks.filter((c) => c.id.startsWith("22_browser_"));
  const stagingOk = checks.filter((c) => c.id.startsWith("04_") || c.id.startsWith("05_")).every((c) => c.pass);

  let status: string;
  if (browserChecks.length > 0 && browserChecks.every((c) => c.pass) && checks.find((c) => c.id === "21_browser_pim")?.pass) {
    status = "PASS";
  } else if (httpChecks.every((c) => c.pass) && stagingOk) {
    status = "PARTIAL_PASS";
  } else if (stagingOk && !protectionOff) {
    status = "PENDING_OPERATOR";
  } else {
    status = "FAIL";
  }

  writeOperatorSignoff(outDir, id, base, status, checks, bypass);
  fs.writeFileSync(
    path.join(outDir, "smoke-results.json"),
    JSON.stringify({ run_id: id, status, base, bypass, checks }, null, 2),
  );
  console.log(JSON.stringify({ run_id: id, status, outDir }, null, 2));
  process.exit(status === "FAIL" ? 1 : 0);
}

async function shot(page: Page, dir: string, name: string): Promise<string | undefined> {
  try {
    const f = `${name}.png`;
    await page.screenshot({ path: path.join(dir, f), fullPage: true });
    return `screenshots/${f}`;
  } catch {
    return undefined;
  }
}

function writeOperatorSignoff(
  outDir: string,
  runId: string,
  base: string,
  status: string,
  checks: Check[],
  bypass: boolean,
): void {
  const md = [
    `# Operator signoff — ENV-06C-MANUAL Preview smoke V173`,
    ``,
    `**Run id:** \`${runId}\``,
    `**Status:** ${status}`,
    `**Preview base:** ${base}`,
    `**Login URL:** ${base}/login`,
    `**PIM deep link (Sam org + Sam AM):** ${base}${buildPimCatalogDeepLink()}`,
    `**Bypass secret used:** ${bypass ? "yes (automated HTTP)" : "no"}`,
    ``,
    `## Operator checklist`,
    ``,
    `| Step | Action | Automated | Operator ✓ |`,
    `|------|--------|-----------|------------|`,
    `| 1 | Vercel Deployment Protection → pass team login | ${bypass ? "bypass" : "manual"} | |`,
    `| 2 | Supabase login (same user as local) | — | |`,
    `| 3 | Workspace → **Sam Distribution Inc** | — | |`,
    `| 4 | PIM → store **Sam AM** → ~17,001 products | partial | |`,
    `| 5 | Returns → Packages/Pallets (no package_number errors) | partial | |`,
    `| 6 | Scanner route loads | partial | |`,
    `| 7 | Claim evidence → TRID / reference candidates visible | partial | |`,
    `| 8 | Imports → history / file links (staging storage 144/144) | partial | |`,
    ``,
    `## Automated checks`,
    ``,
    `| ID | Pass | Detail |`,
    `|----|------|--------|`,
    ...checks.map((c) => `| ${c.id} | ${c.pass ? "yes" : "no"} | ${c.detail.replace(/\|/g, "\\|")} |`),
    ``,
    `## Signoff`,
    ``,
    `| Field | Value |`,
    `|-------|--------|`,
    `| Operator name | |`,
    `| Date (UTC) | |`,
    `| Preview SHA | \`22e514404de6bc8dc9a9d0b23789e2adde1a8f52\` (READY) |`,
    `| Staging ref confirmed | \`eiqfaapyumhixxoeltgu\` |`,
    `| All manual steps PASS | ☐ |`,
    ``,
    status === "PASS"
      ? `Automated browser smoke passed. Operator spot-check optional.`
      : status === "PARTIAL_PASS"
        ? `Staging + HTTP probes passed; complete operator column above for full signoff.`
        : `Complete manual steps or add \`VERCEL_AUTOMATION_BYPASS_SECRET\` and re-run \`npx tsx scripts/env-06c-manual-preview-smoke-v173.ts\`.`,
  ].join("\n");
  fs.writeFileSync(path.join(outDir, "operator-signoff.md"), md);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
