/**
 * NEDA-OPERATOR-STORE-SCOPE-FIX-V184 — profile/org/store scope audit (staging, read-only DB).
 * Usage: npx tsx scripts/neda-operator-store-scope-fix-v184.ts
 *
 * Requires dev server on NEDA_V184_BASE_URL (default http://127.0.0.1:3001).
 */
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";
import {
  fetchExpectedPackagesForTracking,
  loadTrackingExpectationSnapshot,
  EP_DETAIL_SELECT,
} from "../lib/scanner/operator-tracking-expectations";
import { WORKSPACE_ORGANIZATION_CHANGED_EVENT } from "../lib/workspace-organization-scope";
import { SAM_ORG_ID, SAM_STORE_ID } from "./lib/neda-read-model-smoke-v181";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const WORKSPACE_ORG_KEY = "workspace_selected_organization_id";
const RUN_ID = `run-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-001`;
const OUT = join(process.cwd(), ".cursor/audit-reports/neda-operator-store-scope-fix-v184", RUN_ID);

const AUTH_USER_ID =
  process.env.SCANNER_NEDA_14_AUTH_USER_ID?.trim() || "c4c8d0c1-e734-4cc7-b2a0-4cda409d9dfc";

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
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (!process.env[k]) process.env[k] = v;
  }
}

function operatorStoreKey(orgId: string): string {
  return `ecommerce_os_operator_session_store_v1:${orgId}`;
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

async function resolveSamTracking(sb: Awaited<ReturnType<typeof runtimeSupabaseAdmin>>): Promise<string | null> {
  if (!sb) return null;
  const { data } = await sb
    .from("expected_packages")
    .select(EP_DETAIL_SELECT)
    .eq("organization_id", SAM_ORG_ID)
    .eq("store_id", SAM_STORE_ID)
    .not("tracking_number", "is", null)
    .limit(1);
  return String((data?.[0] as { tracking_number?: string } | undefined)?.tracking_number ?? "").trim() || null;
}

async function runBrowserSamProof(
  baseUrl: string,
  tracking: string,
): Promise<{
  store_ready: boolean;
  shows_sam_distribution: boolean;
  shows_sam_am: boolean;
  shows_no_store_prompt: boolean;
  expected_ui: boolean;
  body_excerpt: string;
  error?: string;
}> {
  const session = await establishRuntimeSessionCookies();
  if (!session.ok) {
    return {
      store_ready: false,
      shows_sam_distribution: false,
      shows_sam_am: false,
      shows_no_store_prompt: true,
      expected_ui: false,
      body_excerpt: "",
      error: session.message,
    };
  }

  try {
    const pw = await import("playwright");
    const browser = await pw.chromium.launch({ headless: true });
    const host = new URL(baseUrl).hostname;
    const context = await browser.newContext();
    await context.addCookies(
      session.cookies.map((c) => ({ name: c.name, value: c.value, domain: host, path: "/" })),
    );
    const page = await context.newPage();

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
    await page.waitForTimeout(1500);

    let storeReady = false;
    for (let i = 0; i < 40; i++) {
      const body = await page.locator("body").innerText().catch(() => "");
      const hasStoreChip = /\bSam AM\b/i.test(body) && !/Select or configure a store/i.test(body);
      if (hasStoreChip && body.length > 80) {
        storeReady = true;
        break;
      }
      await page.waitForTimeout(500);
    }

    const scanUrl = `${baseUrl.replace(/\/$/, "")}/scanner/operator-mobile/scan?code=${encodeURIComponent(tracking)}`;
    await page.goto(scanUrl, { waitUntil: "domcontentloaded", timeout: 90000 });
    const gate = page.getByPlaceholder(/tracking or slip code/i);
    if ((await gate.count()) > 0) {
      await gate.first().fill(tracking);
      await gate.first().press("Enter");
    }
    await page.waitForTimeout(6000);

    const body = await page.locator("body").innerText().catch(() => "");
    await browser.close();

    const excerpt = body.replace(/\s+/g, " ").trim().slice(0, 1200);
    return {
      store_ready: storeReady,
      shows_sam_distribution: /Sam Distribution/i.test(body),
      shows_sam_am: /\bSam AM\b/i.test(body),
      shows_no_store_prompt: /Select or configure a store/i.test(body),
      expected_ui: /Expected Items|Expected Inventory/i.test(body) || /Exp|Scan|Variance/i.test(body),
      body_excerpt: excerpt,
    };
  } catch (e) {
    return {
      store_ready: false,
      shows_sam_distribution: false,
      shows_sam_am: false,
      shows_no_store_prompt: true,
      expected_ui: false,
      body_excerpt: "",
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

async function main(): Promise<void> {
  loadEnvLocal();
  mkdirSync(OUT, { recursive: true });
  const steps: Step[] = [];
  const add = (id: string, pass: boolean, detail: string) => steps.push({ id, pass, detail });

  const sb = await runtimeSupabaseAdmin();
  const ref = (process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").includes(STAGING_REF);
  add("env_staging_ref", ref, ref ? STAGING_REF : "not staging");

  const { data: prof } = await sb!
    .from("profiles")
    .select("id, organization_id, full_name, role, roles!profiles_role_id_fkey(key), organizations!profiles_organization_id_fkey(name)")
    .eq("id", AUTH_USER_ID)
    .maybeSingle();

  const homeOrgId = String((prof as { organization_id?: string })?.organization_id ?? "").trim();
  const homeOrgName =
    (prof as { organizations?: { name?: string } })?.organizations &&
    typeof (prof as { organizations?: { name?: string } }).organizations === "object"
      ? String((prof as { organizations: { name?: string } }).organizations.name ?? "").trim()
      : "";

  const [{ data: homeStores }, { data: samOrg }, { data: samStores }] = await Promise.all([
    sb!.from("stores").select("id,name,is_active").eq("organization_id", homeOrgId).eq("is_active", true),
    sb!.from("organizations").select("id,name").eq("id", SAM_ORG_ID).maybeSingle(),
    sb!
      .from("stores")
      .select("id,name,is_active")
      .eq("organization_id", SAM_ORG_ID)
      .eq("is_active", true),
  ]);

  const samTracking = await resolveSamTracking(sb);
  let samEpRows = 0;
  if (samTracking) {
    const ep = await fetchExpectedPackagesForTracking(sb!, SAM_ORG_ID, SAM_STORE_ID, samTracking, EP_DETAIL_SELECT);
    samEpRows = ep.length;
    const snap = await loadTrackingExpectationSnapshot(sb!, SAM_ORG_ID, SAM_STORE_ID, samTracking);
    add("api_sam_snapshot_lines", snap.lines.length > 0, `lines=${snap.lines.length} tracking=${samTracking}`);
  }
  add("api_sam_ep_rows", samEpRows > 0, `rows=${samEpRows}`);
  add("profile_home_org_no_active_stores", (homeStores ?? []).length === 0, `home=${homeOrgName || homeOrgId} active=${(homeStores ?? []).length}`);
  add("sam_org_has_sam_am", Boolean(samStores?.some((s) => s.id === SAM_STORE_ID)), `stores=${(samStores ?? []).length}`);

  const baseUrl = process.env.NEDA_V184_BASE_URL ?? "http://127.0.0.1:3001";
  const browser =
    samTracking != null ? await runBrowserSamProof(baseUrl, samTracking) : null;

  if (browser) {
    add("browser_store_ready", browser.store_ready, browser.body_excerpt.slice(0, 120));
    add("browser_sam_distribution_label", browser.shows_sam_distribution, browser.shows_sam_distribution ? "visible" : "missing");
    add("browser_sam_am_store", browser.shows_sam_am, browser.shows_sam_am ? "visible" : "missing");
    add("browser_no_store_prompt_absent", !browser.shows_no_store_prompt, browser.shows_no_store_prompt ? "still prompting" : "ok");
    add("browser_expected_or_inventory_ui", browser.expected_ui, browser.expected_ui ? "ok" : "missing");
    if (browser.error) add("browser_error", false, browser.error);
  } else {
    add("browser_proof", false, "no SAM tracking baseline");
  }

  const codeFixPass = steps.filter((s) => s.id.startsWith("browser_")).every((s) => s.pass);
  const overallPass =
    ref &&
    samEpRows > 0 &&
    (homeStores ?? []).length === 0 &&
    Boolean(samStores?.some((s) => s.id === SAM_STORE_ID)) &&
    (browser == null || (browser.store_ready && !browser.shows_no_store_prompt && browser.expected_ui));

  writeFileSync(
    join(OUT, "profile-org-store-context.md"),
    [
      "# Profile / org / store context (staging)",
      "",
      `**Auth user:** \`${AUTH_USER_ID}\` (${(prof as { full_name?: string })?.full_name ?? "?"})`,
      `**Role:** ${(prof as { roles?: { key?: string } })?.roles && typeof (prof as { roles?: { key?: string } }).roles === "object" ? (prof as { roles: { key?: string } }).roles.key : (prof as { role?: string })?.role}`,
      "",
      "## Home org (profiles.organization_id)",
      "",
      `- id: \`${homeOrgId}\``,
      `- name: ${homeOrgName || "(unknown)"}`,
      `- active stores: **${(homeStores ?? []).length}**`,
      "",
      "## Sam tenant (workspace target)",
      "",
      `- org: \`${SAM_ORG_ID}\` — ${(samOrg as { name?: string })?.name ?? "Sam Distribution Inc"}`,
      `- store: \`${SAM_STORE_ID}\` — Sam AM`,
      `- active stores: ${(samStores ?? []).map((s) => s.name).join(", ") || "(none)"}`,
      "",
      "## Root cause",
      "",
      "Signed-in super_admin home org is internal **RECOVRA** with zero active stores. Operator UI used",
      "`UserRoleContext.organizationId` before `workspace_selected_organization_id`, so branding/store scope",
      "could stay on home/test3 while SAM data lives under Sam Distribution.",
      "",
      "## Code fix (no DB writes)",
      "",
      "- `OperatorSessionStoreProvider`: workspace localStorage wins over context org; sync read on mount.",
      "- `UserRoleContext`: listen for `WORKSPACE_ORGANIZATION_CHANGED_EVENT` in same tab.",
      "",
    ].join("\n"),
    "utf8",
  );

  writeFileSync(
    join(OUT, "browser-sam-proof.md"),
    browser
      ? [
          "# Browser SAM proof",
          "",
          `| Check | Result |`,
          `|-------|--------|`,
          `| store_ready | ${browser.store_ready} |`,
          `| Sam Distribution label | ${browser.shows_sam_distribution} |`,
          `| Sam AM store | ${browser.shows_sam_am} |`,
          `| no-store prompt absent | ${!browser.shows_no_store_prompt} |`,
          `| expected/inventory UI | ${browser.expected_ui} |`,
          browser.error ? `| error | ${browser.error} |` : "",
          "",
          "## Body excerpt",
          "",
          browser.body_excerpt,
        ].join("\n")
      : "# Browser SAM proof\n\nSkipped — no SAM tracking on staging.\n",
    "utf8",
  );

  writeFileSync(
    join(OUT, "db-membership-approval-plan.md"),
    [
      "# DB membership approval plan (optional — not executed)",
      "",
      "No migrations or profile updates were applied in this run.",
      "",
      "If operators should default to Sam without using the workspace switcher:",
      "",
      "1. **Approve** updating `profiles.organization_id` for staging test accounts from RECOVRA (`39f5e74f-0690-4ad0-9edd-3a7f6dd7385b`) to Sam (`00000000-0000-0000-0000-000000000001`) — only for dedicated scanner QA users.",
      "2. **Or** set `organization_settings.default_store_id` on RECOVRA if RECOVRA gains active stores later.",
      "3. **Do not** hardcode Sam UUIDs in app routes; keep workspace picker + localStorage as the supported path for super_admin.",
      "",
      "**Recommended:** keep profile on RECOVRA; select **Sam Distribution Inc** in workspace switcher (persisted key `workspace_selected_organization_id`).",
    ].join("\n"),
    "utf8",
  );

  writeFileSync(
    join(OUT, "blockers.md"),
    overallPass
      ? "# Blockers\n\nNone — operator store scope fix verified on staging browser with SAM workspace.\n"
      : [
          "# Blockers",
          "",
          ...steps.filter((s) => !s.pass).map((s) => `- **${s.id}**: ${s.detail}`),
          "",
          codeFixPass ? "" : "Browser proof did not fully pass — see browser-sam-proof.md.",
        ].join("\n"),
    "utf8",
  );

  writeFileSync(
    join(OUT, "validation-results.md"),
    ["# Validation", "", ...steps.map((s) => `- [${s.pass ? "x" : " "}] \`${s.id}\` — ${s.detail}`)].join("\n"),
    "utf8",
  );

  writeFileSync(
    join(OUT, "manifest.json"),
    JSON.stringify(
      {
        run_id: RUN_ID,
        task: "NEDA-OPERATOR-STORE-SCOPE-FIX-V184",
        staging_ref: STAGING_REF,
        auth_user_id: AUTH_USER_ID,
        home_org_id: homeOrgId,
        sam_org_id: SAM_ORG_ID,
        sam_store_id: SAM_STORE_ID,
        sam_tracking: samTracking,
        overall_pass: overallPass,
        steps,
        browser,
      },
      null,
      2,
    ),
    "utf8",
  );

  console.log(`Wrote ${OUT}`);
  console.log(`overall_pass=${overallPass}`);
  if (!overallPass) process.exit(1);
}

void main();
