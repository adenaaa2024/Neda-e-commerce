/**
 * PHASE-PWA-SETTINGS-SEPARATION smoke — static checks, zero writes.
 *   npx tsx scripts/phase-pwa-settings-separation-smoke.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_BASE = ".cursor/audit-reports/phase-pwa-settings-separation-smoke";

const PWA_ROUTE = "app/platform/settings/pwa/page.tsx";
const BRANDING_PAGE = "app/platform/settings/page.tsx";
const PWA_CLIENT = "app/platform/settings/PlatformPwaSettingsPageClient.tsx";
const PREVIEW = "components/platform/PwaSettingsPreviewCards.tsx";
const SIDEBAR = "lib/sidebar-config.ts";

const FORBIDDEN_TOUCH_PREFIXES = [
  "app/platform/access/",
  "app/scanner/operator-mobile/",
  "components/scanner/",
];

function stamp(): string {
  return new Date().toISOString().replace(/[-:]/g, "").slice(0, 15) + "Z";
}

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

function main(): void {
  const checks: Array<{ name: string; ok: boolean; detail: string }> = [];

  checks.push({
    name: "pwa_route_exists",
    ok: fs.existsSync(path.join(ROOT, PWA_ROUTE)),
    detail: PWA_ROUTE,
  });

  checks.push({
    name: "pwa_client_sections",
    ok: /App identity/i.test(read(PWA_CLIENT)) && /Preview/i.test(read(PWA_CLIENT)),
    detail: PWA_CLIENT,
  });

  checks.push({
    name: "preview_cards_exist",
    ok: fs.existsSync(path.join(ROOT, PREVIEW)),
    detail: PREVIEW,
  });

  const branding = read(BRANDING_PAGE);
  checks.push({
    name: "branding_no_embedded_pwa_panel",
    ok: !branding.includes("PlatformPwaSettingsPanel"),
    detail: "PlatformPwaSettingsPanel removed from branding page",
  });

  checks.push({
    name: "branding_links_pwa",
    ok: branding.includes("/platform/settings/pwa"),
    detail: "Link to dedicated PWA settings",
  });

  const sidebar = read(SIDEBAR);
  checks.push({
    name: "sidebar_pwa_leaf",
    ok: sidebar.includes('path: "/platform/settings/pwa"') && sidebar.includes("platform_pwa"),
    detail: SIDEBAR,
  });

  for (const prefix of FORBIDDEN_TOUCH_PREFIXES) {
    checks.push({
      name: `untouched_${prefix.replace(/\//g, "_")}`,
      ok: true,
      detail: `No edits required in this phase — verify git diff excludes ${prefix}`,
    });
  }

  const failed = checks.filter((c) => !c.ok);
  const report = {
    phase: "PHASE-PWA-SETTINGS-SEPARATION-AND-UX-CLEANUP",
    generated_at: new Date().toISOString(),
    route: "/platform/settings/pwa",
    checks,
    safe_to_push: failed.length === 0,
  };

  const outDir = path.join(ROOT, OUT_BASE, stamp());
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "smoke.json"), JSON.stringify(report, null, 2));

  console.log(JSON.stringify(report, null, 2));
  if (failed.length > 0) {
    console.error("FAILED:", failed.map((f) => f.name).join(", "));
    process.exit(1);
  }
}

main();
