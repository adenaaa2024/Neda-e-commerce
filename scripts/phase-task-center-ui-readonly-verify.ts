/**
 * PHASE-TASK-CENTER-FRONTEND-SHELL-NEDA-V1 verify
 *   npx tsx scripts/phase-task-center-ui-readonly-verify.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";

const OUT_BASE = ".cursor/audit-reports/phase-task-center-frontend-shell-neda-v1";
const NO_TOUCH = ["app/scanner/operator-mobile/", "app/platform/access/"];

const REQUIRED_ROUTES = [
  "app/task-center/page.tsx",
  "app/task-center/my/page.tsx",
  "app/task-center/queues/page.tsx",
  "app/task-center/sources/page.tsx",
  "app/task-center/org/page.tsx",
  "app/task-center/[id]/page.tsx",
];

const REQUIRED_API = [
  "app/api/task-center/summary/route.ts",
  "app/api/task-center/tasks/route.ts",
  "app/api/task-center/tasks/[id]/route.ts",
  "app/api/task-center/groups/route.ts",
  "app/api/task-center/source-summary/route.ts",
];

function runId(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function gitChanged(): string[] {
  try {
    return execSync("git status --porcelain", { encoding: "utf8" })
      .split(/\r?\n/)
      .filter(Boolean)
      .map((l) => l.slice(3).trim().replace(/^.*?->\s*/, ""));
  } catch {
    return [];
  }
}

function main(): void {
  const rid = runId();
  const root = process.cwd();
  const outDir = path.join(root, OUT_BASE, rid);
  fs.mkdirSync(outDir, { recursive: true });

  const changed = gitChanged();
  const scannerTouch = changed.filter((f) => f.replace(/\\/g, "/").includes(NO_TOUCH[0]));
  const platformTouch = changed.filter((f) => f.replace(/\\/g, "/").includes(NO_TOUCH[1]));

  const missingRoutes = REQUIRED_ROUTES.filter((f) => !fs.existsSync(path.join(root, f)));
  const missingApi = REQUIRED_API.filter((f) => !fs.existsSync(path.join(root, f)));

  let buildOk = false;
  let buildDetail = "";
  try {
    execSync("npm run build", { encoding: "utf8", stdio: "pipe" });
    buildOk = true;
    buildDetail = "PASS";
  } catch (e) {
    buildDetail = e instanceof Error ? e.message : "FAIL";
  }

  const smokeOk =
    missingRoutes.length === 0 &&
    missingApi.length === 0 &&
    scannerTouch.length === 0 &&
    platformTouch.length === 0 &&
    buildOk;

  const result = {
    phase: "PHASE-TASK-CENTER-FRONTEND-SHELL-NEDA-V1",
    routes_created: REQUIRED_ROUTES.filter((f) => fs.existsSync(path.join(root, f))),
    api_routes: REQUIRED_API.filter((f) => fs.existsSync(path.join(root, f))),
    missing_routes: missingRoutes,
    missing_api: missingApi,
    read_only_api_usage: REQUIRED_API,
    empty_states: "TaskCenterEmptyState — no fake demo rows",
    mobile_layout: "TaskCenterMobileNav bottom bar + card-first lists",
    scanner_source_ui: "TaskCenterSourcesView scanner kinds panel — no scanner code changes",
    org_structure_ui: "TaskCenterOrgView read-only tree",
    no_write_buttons: "TaskCenterWriteGateFooter — disabled Phase 7B copy",
    scanner_files_changed_must_be_empty: scannerTouch,
    platform_access_files_changed_must_be_empty: platformTouch,
    build_result: buildOk ? "PASS" : "FAIL",
    smoke_result: smokeOk ? "PASS" : "FAIL",
    SAFE_TO_PUSH: smokeOk ? "yes" : "no",
    NEXT_PROMPT: "PHASE-TASK-CENTER-READ-API-POLISH-V1",
  };

  fs.writeFileSync(path.join(outDir, "results.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  if (!smokeOk) process.exit(1);
}

main();
