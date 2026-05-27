/**
 * Product dimensions spreadsheet intake audit (read-only).
 *
 *   npx tsx scripts/product-dimensions-spreadsheet-intake-audit.ts
 */
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const SHEET_ID = "1T66cBdEUXSdTFasNZ0ax1AtlwbI_89Fk3ZinpX07Mu8";
const SHEET_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit`;
const OUT_BASE = ".cursor/audit-reports/product-dimensions-spreadsheet-intake-audit";
const DEFAULT_XLSX = path.join(OUT_BASE, "_tmp", "dims-sheet.xlsx");

function runIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function xlsxArg(): string {
  const a = process.argv.find((x) => x.startsWith("--xlsx="));
  return a ? a.split("=")[1]!.trim() : DEFAULT_XLSX;
}

async function ensureXlsx(xlsxPath: string): Promise<void> {
  if (fs.existsSync(xlsxPath)) return;
  fs.mkdirSync(path.dirname(xlsxPath), { recursive: true });
  const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=xlsx`;
  execSync(
    `powershell -NoProfile -Command "Invoke-WebRequest -Uri '${url}' -OutFile '${xlsxPath.replace(/'/g, "''")}' -UseBasicParsing"`,
    { stdio: "inherit" },
  );
}

async function main(): Promise<void> {
  const runId = runIdArg();
  const xlsxPath = path.resolve(process.cwd(), xlsxArg());
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  await ensureXlsx(xlsxPath);

  const pyScript = path.join(process.cwd(), "scripts", "product-dimensions-spreadsheet-intake-analyze.py");
  const pyOut = execSync(`python "${pyScript}" "${xlsxPath}" "${SHEET_URL}"`, {
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
  const result = JSON.parse(pyOut) as Record<string, unknown>;

  fs.writeFileSync(path.join(outDir, "spreadsheet-schema-report.md"), String(result.spreadsheet_schema_report_md));
  fs.writeFileSync(path.join(outDir, "column-classification.json"), JSON.stringify(result.column_classification, null, 2));
  fs.writeFileSync(path.join(outDir, "identifier-quality-report.md"), String(result.identifier_quality_report_md));
  fs.writeFileSync(path.join(outDir, "dimensions-unit-report.md"), String(result.dimensions_unit_report_md));
  fs.writeFileSync(path.join(outDir, "import-readiness-report.md"), String(result.import_readiness_report_md));
  fs.writeFileSync(path.join(outDir, "recommended-import-strategy.md"), String(result.recommended_import_strategy_md));
  fs.writeFileSync(
    path.join(outDir, "manifest.json"),
    JSON.stringify(
      {
        prompt: "PRODUCT DIMENSIONS SPREADSHEET INTAKE AUDIT",
        run_id: runId,
        sheet_url: SHEET_URL,
        sheet_id: SHEET_ID,
        xlsx_path: xlsxPath,
        read_only: true,
        no_db_writes: true,
        summary: result.summary,
      },
      null,
      2,
    ),
  );

  console.log(JSON.stringify({ ok: true, outDir, summary: result.summary }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
