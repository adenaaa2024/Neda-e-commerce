/**
 * Smoke — claim filing packet preview V1 (static checks)
 *   npx tsx scripts/smoke-claim-filing-packet-preview-v1.ts --run-id=<UTC>
 */
import * as fs from "node:fs";
import * as path from "node:path";

const OUT = ".cursor/audit-reports/smoke-claim-filing-packet-preview-v1";
const COMPOSER = "lib/claims/filing/claim-filing-packet-preview-v1.ts";
const API_ROUTE = "app/api/claims/center/filing-packet-preview/route.ts";
const HANDLERS = "lib/claims/center/claim-center-api-handlers.ts";

function runId(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function main(): void {
  const id = runId();
  const outDir = path.join(process.cwd(), OUT, id);
  fs.mkdirSync(outDir, { recursive: true });

  const composer = fs.readFileSync(path.join(process.cwd(), COMPOSER), "utf8");
  const api = fs.readFileSync(path.join(process.cwd(), API_ROUTE), "utf8");
  const handlers = fs.readFileSync(path.join(process.cwd(), HANDLERS), "utf8");

  const checks = {
    composer_exists: fs.existsSync(path.join(process.cwd(), COMPOSER)),
    api_route_exists: fs.existsSync(path.join(process.cwd(), API_ROUTE)),
    api_get_route: api.includes("export async function GET"),
    pilot_case_run_id_param: api.includes("pilot_case_run_id"),
    case_id_param: api.includes("case_id"),
    status_default_open: api.includes('"open"'),
    handler_wired: handlers.includes("getCenterFilingPacketPreviewPayload"),
    read_only_flag: composer.includes("read_only: true"),
    filing_packet_preview_id: composer.includes("filing_packet_preview_id"),
    ready_for_pdf_preview: composer.includes("ready_for_pdf_preview"),
    ready_for_manual_filing: composer.includes("ready_for_manual_filing"),
    pdf_export_deferred: composer.includes("pdf_export_deferred: true"),
    does_not_submit: composer.includes("does_not_submit: true"),
    no_insert: !composer.includes(".insert("),
    no_update: !composer.includes(".update("),
    no_pdf_lib: !composer.includes("@react-pdf"),
    no_amazon: !composer.includes("amazon-sp-api") && !api.includes("amazon"),
    no_scanner: !composer.includes("operator-mobile"),
    no_ai: !composer.includes("openai"),
    compose_fn: composer.includes("composeClaimFilingPacketPreviewV1"),
  };

  const failures = Object.entries(checks)
    .filter(([, v]) => !v)
    .map(([k]) => k);

  const results = {
    prompt: "PHASE-CLAIM-FILING-PACKET-PREVIEW-V1",
    run_id: id,
    checks,
    failures,
    smoke_result: failures.length === 0 ? "pass" : "fail",
  };

  fs.writeFileSync(path.join(outDir, "results.json"), JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
  if (failures.length > 0) process.exitCode = 1;
}

main();
