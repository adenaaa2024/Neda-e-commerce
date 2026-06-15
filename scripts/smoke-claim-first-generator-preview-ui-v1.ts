/**
 * Smoke — claim first generator preview UI V1
 *   npx tsx scripts/smoke-claim-first-generator-preview-ui-v1.ts --run-id=<UTC>
 */
import * as fs from "node:fs";
import * as path from "node:path";

const OUT = ".cursor/audit-reports/smoke-claim-first-generator-preview-ui-v1";
const ROOT = process.cwd();

function runId(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

function main(): void {
  const id = runId();
  const outDir = path.join(ROOT, OUT, id);
  fs.mkdirSync(outDir, { recursive: true });

  const view = read("components/claim-center/preview/ClaimPreviewGeneratorsView.tsx");
  const table = read("components/claim-center/preview/ClaimPreviewGeneratorsTable.tsx");
  const disabled = read("components/claim-center/preview/ClaimPreviewGeneratorsDisabledActions.tsx");
  const contract = read("lib/claims/preview/claim-preview-generators-ui-contract.ts");
  const nav = read("components/claim-center/claim-center-nav-config.ts");

  const checks = {
    page_route: fs.existsSync(path.join(ROOT, "app/claim-center/preview-generators/page.tsx")),
    view_component: fs.existsSync(
      path.join(ROOT, "components/claim-center/preview/ClaimPreviewGeneratorsView.tsx"),
    ),
    api_wired: view.includes("/api/claims/center/preview-generators"),
    summary_cards: view.includes("ClaimPreviewGeneratorsSummary"),
    table_columns: table.includes("preview_id") && table.includes("date_gate_passed"),
    filters: view.includes("ClaimPreviewGeneratorsFilters"),
    family_filter: contract.includes("family_key"),
    status_filter: contract.includes("claim_ready_only"),
    date_filter: contract.includes("date_from"),
    badges: contract.includes("previewGeneratorBadges"),
    group_builder_link: contract.includes("buildGroupBuilderHref"),
    nav_entry: nav.includes("/claim-center/preview-generators"),
    disabled_actions_component: fs.existsSync(
      path.join(ROOT, "components/claim-center/preview/ClaimPreviewGeneratorsDisabledActions.tsx"),
    ),
    disabled_emit: contract.includes("emit_candidates") && disabled.includes("PREVIEW_GENERATORS_DISABLED_ACTIONS"),
    disabled_create_case: contract.includes("create_case"),
    no_emit_button_enabled: !view.match(/onClick[^]*emit/i),
    no_db_write_in_view: !view.includes(".insert(") && !view.includes(".update("),
    no_scanner: !view.includes("operator-mobile"),
    read_only_banner: view.includes("Read-only preview generators"),
  };

  const failures = Object.entries(checks)
    .filter(([, v]) => !v)
    .map(([k]) => k);

  const results = {
    prompt: "PHASE-CLAIM-FIRST-GENERATOR-PREVIEW-UI-V1",
    run_id: id,
    checks,
    pass: failures.length === 0,
    smoke_result: failures.length === 0 ? "PASS" : "FAIL",
  };

  fs.writeFileSync(path.join(outDir, "results.json"), JSON.stringify(results, null, 2));
  if (failures.length) {
    console.error("FAIL:", failures.join(", "));
    process.exit(1);
  }
  console.log(JSON.stringify({ ok: true, run_id: id, smoke: "PASS" }));
}

main();
