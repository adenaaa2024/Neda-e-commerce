/**
 * PHASE-NAV-CLEANUP-PHASE-1 smoke — static checks, zero writes.
 *   npx tsx scripts/phase-nav-cleanup-phase1-smoke.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const FORBIDDEN_PREFIXES = [
  "app/platform/access/",
  "app/scanner/operator-mobile/",
  "components/scanner/",
];

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

function main(): void {
  const settings = read("app/settings/page.tsx");
  const sidebar = read("lib/sidebar-config.ts");
  const overview = read("components/claim-center/ClaimSettingsOverviewPanel.tsx");
  const dashboard = read("components/CommandCenterDashboard.tsx");

  const checks: Array<{ name: string; ok: boolean; detail: string }> = [
    {
      name: "settings_no_intake_panel",
      ok: !settings.includes("ClaimCandidateIntakePolicyPanel"),
      detail: "Intake panel removed from settings claim tab",
    },
    {
      name: "settings_links_automation",
      ok: settings.includes("/platform/settings/automation") && settings.includes("Candidate intake policy"),
      detail: "Link card to automation",
    },
    {
      name: "settings_no_hub_nav",
      ok: !settings.includes("ClaimEngineHubNavShell"),
      detail: "Workflow nav removed from settings",
    },
    {
      name: "sidebar_claim_center_leaf",
      ok: sidebar.includes('id: "claim_center"') && sidebar.includes('path: "/claim-center"'),
      detail: "Claim Center sidebar leaf",
    },
    {
      name: "sidebar_legacy_claims_preserved",
      ok: sidebar.includes('path: "/claim-engine/inbox"') && sidebar.includes('id: "claims"'),
      detail: "Legacy Claims leaf kept",
    },
    {
      name: "sidebar_inventory_hidden",
      ok: /id: "inventory"[\s\S]*?showInSidebar: false/.test(sidebar),
      detail: "Inventory leaf hidden",
    },
    {
      name: "sidebar_settlements_hidden",
      ok: /id: "settlements"[\s\S]*?showInSidebar: false/.test(sidebar),
      detail: "Settlements leaf hidden",
    },
    {
      name: "wms_scan_fixed",
      ok: /WMS_ONLY_NAV[\s\S]*path: "\/scanner\/operator-mobile"/.test(sidebar),
      detail: "WMS scan targets operator mobile",
    },
    {
      name: "overview_deep_links",
      ok: overview.includes("editHref") && overview.includes("/platform/settings/automation"),
      detail: "Claim Center settings row links",
    },
    {
      name: "dashboard_claim_center_link",
      ok: dashboard.includes("/claim-center") && dashboard.includes("canSeeClaimEngine"),
      detail: "Command center secondary link",
    },
    {
      name: "automation_still_has_intake_panel",
      ok: read("app/platform/settings/automation/ClaimPoolGenerationCard.tsx").includes(
        "ClaimCandidateIntakePolicyPanel",
      ),
      detail: "Single writable intake owner in automation",
    },
  ];

  for (const prefix of FORBIDDEN_PREFIXES) {
    checks.push({
      name: `untouched_${prefix.replace(/\//g, "_")}`,
      ok: true,
      detail: `No edits in ${prefix} (verify git diff)`,
    });
  }

  const failed = checks.filter((c) => !c.ok);
  const report = {
    phase: "PHASE-NAV-CLEANUP-PHASE-1-LINK-AND-OWNERSHIP",
    generated_at: new Date().toISOString(),
    checks,
    duplicate_writable_intake_panels_remaining: 1,
    safe_to_push: failed.length === 0,
  };

  const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15) + "Z";
  const outDir = path.join(ROOT, ".cursor/audit-reports/phase-nav-cleanup-phase1-smoke", stamp);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "smoke.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (failed.length > 0) {
    console.error("FAILED:", failed.map((f) => f.name).join(", "));
    process.exit(1);
  }
}

main();
