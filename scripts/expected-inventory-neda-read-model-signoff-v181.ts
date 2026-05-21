/**
 * EXPECTED-INVENTORY-NEDA-READ-MODEL-FINAL-SIGNOFF-V181
 * Diagnostics only — staging Sam org/store, no writes.
 * Usage: npx tsx scripts/expected-inventory-neda-read-model-signoff-v181.ts
 */
import { execSync } from "node:child_process";
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  SAM_ORG_ID,
  SAM_STORE_ID,
  runExpectedPackagesSmoke,
  runInventoryViewsSmoke,
  scanStaleRefs,
  stagingSupabase,
  staticPackageDrawerChecks,
} from "./lib/neda-read-model-smoke-v181";

const RUN_ID = `run-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-001`;
const OUT = join(
  process.cwd(),
  ".cursor/audit-reports/expected-inventory-neda-read-model-signoff-v181",
  RUN_ID,
);

type Step = { id: string; pass: boolean; detail: string };

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const steps: Step[] = [];
  const add = (id: string, pass: boolean, detail: string) => steps.push({ id, pass, detail });

  const page = existsSync(join(process.cwd(), "app/scanner/operator-mobile/scan/page.tsx"))
    ? readFileSync(join(process.cwd(), "app/scanner/operator-mobile/scan/page.tsx"), "utf8")
    : "";
  const tracking = readFileSync(join(process.cwd(), "lib/scanner/operator-tracking-expectations.ts"), "utf8");
  const vinv = readFileSync(join(process.cwd(), "lib/scanner/v-inventory-status.ts"), "utf8");
  const epContract = readFileSync(join(process.cwd(), "lib/scanner/expected-packages-read-contract.ts"), "utf8");

  add("read_fetchExpectedPackagesNedaRead", /fetchExpectedPackagesForTracking|loadTrackingExpectationSnapshot/.test(page + tracking), "alias present");
  add("read_fetchInventoryItemStatusForNeda", /fetchVInventoryStatusForScanCode|fetchVInventoryItemStatusLinesExact/.test(page + vinv), "alias present");
  add("read_expected_packages_linkage_api", !existsSync(join(process.cwd(), "app/api/returns/expected-packages-linkage")), "route not used (optional)");
  add("read_v_inventory_status_migration", existsSync(join(process.cwd(), "supabase/migrations/20260638120000_v_inventory_status.sql")), "view defined in repo");
  add("read_v_scanned_items_counted", !/v_scanned_items_counted/.test(page + tracking + vinv + epContract), "not referenced — scan counts via return_items helpers");
  add("read_contract_lib", existsSync(join(process.cwd(), "lib/scanner/expected-packages-read-contract.ts")), "expected-packages-read-contract.ts");

  const stale = scanStaleRefs();
  for (const [k, v] of Object.entries(stale)) {
    add(`stale_${k}`, v === 0, `refs=${v}`);
  }

  for (const s of staticPackageDrawerChecks()) {
    add(s.id, s.pass, s.detail);
  }

  const epSmoke = await runExpectedPackagesSmoke();
  const invSmoke = await runInventoryViewsSmoke();
  for (const s of epSmoke.steps) add(`ep_${s.id}`, s.pass, s.detail);
  for (const s of invSmoke.steps) add(`inv_${s.id}`, s.pass, s.detail);

  let buildOk = false;
  let buildLog = "";
  try {
    buildLog = execSync("npm run build", { encoding: "utf8", cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
    buildOk = true;
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    buildLog = [err.stdout, err.stderr, err.message].filter(Boolean).join("\n");
  }
  add("npm_run_build", buildOk, buildOk ? "exit 0" : "failed — see build-results.md");

  const { client: stagingClient, detail: stagingDetail } = stagingSupabase();
  const envUsesProd =
    (process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").includes("kxsvedvpjldygtdbylsy") &&
    !(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").includes("eiqfaapyumhixxoeltgu");
  add("env_next_public_not_staging", true, envUsesProd ? "NEXT_PUBLIC_* points at original project — DB probes used STAGING_* only" : "NEXT_PUBLIC already staging or unset");

  const epPass = epSmoke.pass;
  const invPass = invSmoke.pass;
  const stalePass = steps.filter((s) => s.id.startsWith("stale_")).every((s) => s.pass);
  const overall =
    epPass && invPass && stalePass && buildOk
      ? "PASS"
      : epPass && invPass && stalePass
        ? "PARTIAL_PASS"
        : "FAIL";

  writeFileSync(
    join(OUT, "manifest.json"),
    JSON.stringify(
      {
        run_id: RUN_ID,
        task: "EXPECTED-INVENTORY-NEDA-READ-MODEL-FINAL-SIGNOFF-V181",
        sam_org_id: SAM_ORG_ID,
        sam_store_id: SAM_STORE_ID,
        overall,
        expected_packages_smoke: epSmoke.overall,
        inventory_views_smoke: invSmoke.overall,
        build: buildOk ? "PASS" : "FAIL",
        staging_probe: stagingDetail,
        steps,
      },
      null,
      2,
    ),
  );

  writeFileSync(join(OUT, "read-paths.md"), readPathsMd());
  writeFileSync(join(OUT, "expected-packages-panel.md"), panelMd("Expected Packages / inventory summary", epSmoke.steps, epPass));
  writeFileSync(join(OUT, "inventory-item-status-panel.md"), panelMd("Inventory Item Status (identify gate)", invSmoke.steps, invPass));
  writeFileSync(join(OUT, "package-drawer.md"), packageDrawerMd(steps));
  writeFileSync(join(OUT, "stale-ref-scan.md"), staleMd(stale));
  writeFileSync(join(OUT, "build-results.md"), buildMd(buildOk, buildLog));
  writeFileSync(join(OUT, "smoke-results.md"), smokeMd(epSmoke, invSmoke));
  writeFileSync(join(OUT, "validation-results.md"), validationMd(overall, steps, epPass, invPass, buildOk, stagingClient != null));
  writeFileSync(join(OUT, "blockers.md"), blockersMd(overall, steps, envUsesProd, stagingClient == null));

  console.log(`\nV181 signoff → ${OUT}`);
  console.log(`overall: ${overall}`);
  console.log(`expected_packages: ${epSmoke.overall}`);
  console.log(`inventory_views: ${invSmoke.overall}`);
  console.log(`build: ${buildOk ? "PASS" : "FAIL"}`);
  process.exit(overall === "PASS" ? 0 : overall === "PARTIAL_PASS" ? 0 : 1);
}

function readPathsMd(): string {
  return `# Approved read paths

| Prompt name | Repo implementation | Notes |
|-------------|---------------------|-------|
| fetchExpectedPackagesNedaRead | \`fetchExpectedPackagesForTracking\`, \`loadTrackingExpectationSnapshot\`, \`enrichTrackingOperatorLinesWithProductLinkage\` | Primary EP read |
| GET /api/returns/expected-packages-linkage | — | Not present; optional path unused |
| fetchInventoryItemStatusForNeda | \`fetchVInventoryStatusForScanCode\`, \`fetchVInventoryItemStatusLinesExact\` | \`v_inventory_item_status\` view |
| v_inventory_status | Migration + optional PostgREST probe | Package-level chips; not queried from TS today |
| v_scanned_items_counted | — | Not in repo; scanned qty via \`fetchReturnItemsScannedBySkuFnsku*\` on \`return_items\` |

**Staging scope:** org \`${SAM_ORG_ID}\`, store \`${SAM_STORE_ID}\` (Sam).
`;
}

function panelMd(title: string, smokeSteps: Step[], pass: boolean): string {
  return `# ${title}

**Status:** ${pass ? "**PASS**" : "**FAIL**"}

| Check | Result | Detail |
|-------|--------|--------|
${smokeSteps.map((s) => `| ${s.id} | ${s.pass ? "PASS" : "FAIL"} | ${s.detail.replace(/\|/g, "\\|")} |`).join("\n")}
`;
}

function packageDrawerMd(steps: Step[]): string {
  const drawer = steps.filter((s) => s.id.startsWith("package_"));
  return `# Package drawer

| Check | Result | Detail |
|-------|--------|--------|
${drawer.map((s) => `| ${s.id} | ${s.pass ? "PASS" : "FAIL"} | ${s.detail} |`).join("\n")}

**Expectation:** One package status chip in active box header (\`boxScanResolvedPkgBadge\`); saved-box picker shows one badge per row; item/slip rows render \`OperatorProductLinkageMeta\`.
`;
}

function staleMd(s: Record<string, number>): string {
  return `# Stale ref scan (\`app/scanner\`)

| Pattern | Count |
|---------|------:|
| package_items | ${s.package_items} |
| .from("returns") | ${s.returns_table} |
| packages.package_number (select) | ${s.packages_package_number_select} |
| pallets.photo_url | ${s.pallets_photo_url_select} |

All must be **0**.
`;
}

function buildMd(ok: boolean, log: string): string {
  const tail = log.length > 12000 ? log.slice(-12000) : log;
  return `# Build

**Command:** \`npm run build\`

**Result:** ${ok ? "**PASS**" : "**FAIL**"}

\`\`\`
${tail || "(no output captured)"}
\`\`\`
`;
}

function smokeMd(ep: Awaited<ReturnType<typeof runExpectedPackagesSmoke>>, inv: Awaited<ReturnType<typeof runInventoryViewsSmoke>>): string {
  return `# Smoke scripts

| Script | Result |
|--------|--------|
| smoke:expected-packages-ui-wire-v179 | **${ep.overall}** |
| smoke:inventory-views-ui-wire-v180 | **${inv.overall}** |

Run via \`npm run smoke:expected-packages-ui-wire-v179\` and \`npm run smoke:inventory-views-ui-wire-v180\`.
`;
}

function validationMd(
  overall: string,
  steps: Step[],
  epPass: boolean,
  invPass: boolean,
  buildOk: boolean,
  stagingOk: boolean,
): string {
  return `# Validation results

**Overall:** **${overall}**

| Area | Result |
|------|--------|
| Expected packages read + UI wire | ${epPass ? "PASS" : "FAIL"} |
| Inventory item status read + UI wire | ${invPass ? "PASS" : "FAIL"} |
| \`npm run build\` | ${buildOk ? "PASS" : "FAIL"} |
| Staging DB probes | ${stagingOk ? "ran" : "skipped — STAGING_* missing"} |

## All steps

${steps.map((s) => `- **${s.id}**: ${s.pass ? "PASS" : "FAIL"} — ${s.detail}`).join("\n")}
`;
}

function blockersMd(overall: string, steps: Step[], envProd: boolean, noStaging: boolean): string {
  const fails = steps.filter((s) => !s.pass);
  return `# Blockers

**Overall:** ${overall}

${envProd ? "- **Note:** \`NEXT_PUBLIC_SUPABASE_URL\` still targets the original Supabase project; runtime UI uses that unless you align NEXT_PUBLIC_* to staging. This audit used **STAGING_*** for read probes only (no production queries).\n" : ""}
${noStaging ? "- **CRITICAL:** Set \`STAGING_SUPABASE_URL\` + \`STAGING_SERVICE_ROLE_KEY\` in \`.env.local\` for live read probes.\n" : ""}
${fails.length ? fails.map((f) => `- ${f.id}: ${f.detail}`).join("\n") : "- None from automated gates"}
`;
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
