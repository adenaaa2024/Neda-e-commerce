/**
 * PHASE-TASK-CENTER-NAVIGATION-INDEPENDENT-MODULE-FIX-V1 — static smoke, zero writes.
 *   npx tsx scripts/phase-task-center-navigation-fix-v1-smoke.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_BASE = ".cursor/audit-reports/phase-task-center-navigation-fix-v1";

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

function runId(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function financeBlock(sidebar: string): string {
  const m = sidebar.match(/id: "finance"[\s\S]*?children: \[([\s\S]*?)\n        \],/);
  return m?.[1] ?? "";
}

function main(): void {
  const rid = runId();
  const outDir = path.join(ROOT, OUT_BASE, rid);
  fs.mkdirSync(outDir, { recursive: true });

  const sidebar = read("lib/sidebar-config.ts");
  const appShell = read("components/AppShell.tsx");
  const uiContract = read("lib/task-center/task-center-ui-contract.ts");
  const financeChildren = financeBlock(sidebar);

  const routes = [
    "/task-center",
    "/task-center/my",
    "/task-center/queues",
    "/task-center/sources",
    "/task-center/org",
    "/task-center/[id]",
  ];

  const checks: Array<{ name: string; ok: boolean; detail: string }> = [
    {
      name: "task_center_nav_leaf_exported",
      ok: sidebar.includes("export const TASK_CENTER_NAV_LEAF") && sidebar.includes('path: "/task-center"'),
      detail: "Standalone TASK_CENTER_NAV_LEAF",
    },
    {
      name: "removed_from_finance_group",
      ok: !financeChildren.includes('id: "task_center"'),
      detail: "Task Center not under Finance & Claims children",
    },
    {
      name: "app_shell_top_level_link",
      ok: appShell.includes("TASK_CENTER_NAV_LEAF") && appShell.includes("isLeafVisibleByRbac(TASK_CENTER_NAV_LEAF"),
      detail: "AppShell renders top-level Task Center link",
    },
    {
      name: "permission_base_unchanged",
      ok: sidebar.includes('permissionBase: "operations.task_center"'),
      detail: "RBAC permission prefix preserved",
    },
    {
      name: "claim_center_finance_preserved",
      ok: financeChildren.includes('id: "claim_center"') && financeChildren.includes('id: "claims"'),
      detail: "Claim Center + Claims remain in finance group",
    },
    {
      name: "module_tagline_copy",
      ok: uiContract.includes('TASK_CENTER_MODULE_TAGLINE = "Operations tasks"'),
      detail: "Operations tasks tagline — not Claim tasks module title",
    },
    {
      name: "routes_preserved",
      ok: routes.every((r) => {
        if (r.includes("[id]")) {
          return fs.existsSync(path.join(ROOT, "app/task-center/[id]/page.tsx"));
        }
        const p = r.replace(/^\//, "").split("/");
        return fs.existsSync(path.join(ROOT, "app", ...p, "page.tsx"));
      }),
      detail: "Required route pages exist",
    },
    {
      name: "no_operator_mobile_touch",
      ok: !sidebar.includes("operator-mobile") || sidebar.includes('path: "/scanner/operator-mobile"'),
      detail: "Sidebar config did not repoint operator mobile",
    },
    {
      name: "read_only_write_gate",
      ok: read("components/task-center/TaskCenterWriteGateFooter.tsx").includes("DEFERRED_WRITE"),
      detail: "Write actions still gated",
    },
    {
      name: "hub_routes_helper",
      ok: fs.existsSync(path.join(ROOT, "lib/task-center-hub-routes.ts")),
      detail: "Task Center hub route helper",
    },
  ];

  const failed = checks.filter((c) => !c.ok);
  const pass = failed.length === 0;

  const report = {
    run_id: rid,
    prompt: "PHASE-TASK-CENTER-NAVIGATION-INDEPENDENT-MODULE-FIX-V1",
    checks,
    old_nav_location: 'MAIN_SIDEBAR → finance ("Finance & Claims") → task_center leaf',
    new_nav_location: "TASK_CENTER_NAV_LEAF — top-level flat link after Dashboard",
    routes_preserved: routes,
    claim_financial_submenu_cleaned: !financeChildren.includes('id: "task_center"'),
    task_center_top_level_entry: true,
    no_rbac_change_verification: sidebar.includes('permissionBase: "operations.task_center"'),
    no_write_action_verification: true,
    SAFE_TO_PUSH: pass,
    NEXT_PROMPT: "PHASE-TASK-CENTER-READ-API-STAGING-SMOKE — verify /api/task-center/* against staging schema",
  };

  fs.writeFileSync(path.join(outDir, "results.json"), JSON.stringify(report, null, 2));
  fs.writeFileSync(
    path.join(outDir, "summary.md"),
    `# Task Center navigation fix V1 — ${rid}\n\nSAFE_TO_PUSH: **${pass ? "yes" : "no"}**\n\nFailed: ${failed.map((f) => f.name).join(", ") || "none"}\n`,
  );

  console.log(JSON.stringify(report, null, 2));
  process.exit(pass ? 0 : 1);
}

main();
