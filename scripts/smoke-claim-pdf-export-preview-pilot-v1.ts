/**
 * Smoke — claim PDF export preview pilot V1
 *   npx tsx scripts/smoke-claim-pdf-export-preview-pilot-v1.ts --run-id=<UTC>
 */
import * as fs from "node:fs";
import * as path from "node:path";

const OUT = ".cursor/audit-reports/phase-claim-pdf-export-preview-pilot-v1";
const HTML = "lib/claims/filing/claim-filing-packet-preview-html.ts";
const EXPORT = "lib/claims/filing/claim-filing-packet-export-pilot-v1.ts";
const PILOT = "scripts/phase-claim-pdf-export-preview-pilot-v1.ts";
const APPROVAL = ".cursor/operator-approvals/claim-pdf-export-preview-pilot-v1-approval.md";

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
  const id = process.argv.find((x) => x.startsWith("--run-id="))?.split("=")[1]?.trim() ?? runId();
  const outDir = path.join(process.cwd(), OUT, id);
  const smokeOut = path.join(process.cwd(), ".cursor/audit-reports/smoke-claim-pdf-export-preview-pilot-v1", id);
  fs.mkdirSync(smokeOut, { recursive: true });

  const htmlSrc = fs.readFileSync(path.join(process.cwd(), HTML), "utf8");
  const exportSrc = fs.readFileSync(path.join(process.cwd(), EXPORT), "utf8");
  const pilotSrc = fs.readFileSync(path.join(process.cwd(), PILOT), "utf8");
  const approval = fs.existsSync(path.join(process.cwd(), APPROVAL))
    ? fs.readFileSync(path.join(process.cwd(), APPROVAL), "utf8")
    : "";

  const hasRunArtifacts = fs.existsSync(path.join(outDir, "manifest.json"));
  const manifest = hasRunArtifacts
    ? (JSON.parse(fs.readFileSync(path.join(outDir, "manifest.json"), "utf8")) as {
        generated_case_count?: number;
      })
    : null;

  const checks = {
    html_renderer_exists: fs.existsSync(path.join(process.cwd(), HTML)),
    export_module_exists: fs.existsSync(path.join(process.cwd(), EXPORT)),
    pilot_script_exists: fs.existsSync(path.join(process.cwd(), PILOT)),
    approval_exists: fs.existsSync(path.join(process.cwd(), APPROVAL)),
    approval_yes: approval.includes("APPROVED_CLAIM_PDF_EXPORT_PREVIEW_PILOT_V1=yes"),
    draft_banner:
      htmlSrc.includes("draft-banner") &&
      htmlSrc.includes("SAFETY_LABELS.draft_only") &&
      htmlSrc.includes("SAFETY_LABELS.not_submitted_amazon"),
    no_ai: !htmlSrc.includes("openai") && htmlSrc.includes("SAFETY_LABELS.no_ai_text"),
    export_html_json_txt: exportSrc.includes(".html") && exportSrc.includes(".json") && exportSrc.includes(".txt"),
    no_db_insert: !exportSrc.includes(".insert(") && !pilotSrc.includes(".insert("),
    no_upload: !exportSrc.includes("supabase.storage") && !pilotSrc.includes("supabase.storage"),
    no_scanner: !exportSrc.includes("operator-mobile"),
    manifest_exists: hasRunArtifacts,
    generated_ten_cases: manifest?.generated_case_count === 10,
  };

  const failures = Object.entries(checks)
    .filter(([, v]) => !v)
    .map(([k]) => k);

  const results = {
    prompt: "PHASE-CLAIM-PDF-EXPORT-PREVIEW-PILOT-V1",
    run_id: id,
    checks,
    failures,
    smoke_result: failures.length === 0 ? "pass" : "fail",
  };

  fs.writeFileSync(path.join(smokeOut, "results.json"), JSON.stringify(results, null, 2));
  console.log(JSON.stringify(results, null, 2));
  if (failures.length > 0) process.exitCode = 1;
}

main();
