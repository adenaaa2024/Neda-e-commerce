/**
 * BACKEND-PRODUCT-RESOLUTION-CONTRACT-LOCK-V192
 *
 * Static guard for the non-negotiable product resolution contract.
 * This script is filesystem-only: no DB, no network, no Amazon API, no AI.
 */
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = process.cwd();
const SOURCE_DIRS = ["app", "components", "hooks", "lib"];
const CODE_EXT_RE = /\.(tsx?|jsx?)$/;
const PRODUCT_AWARE_TABLES = [
  "return_items",
  "expected_packages",
  "slip_contents",
  "products",
  "product_identifier_map",
  "amazon_amazon_fulfilled_inventory",
  "amazon_returns",
  "claim_candidates",
  "claim_candidate_drafts",
];
const OUT_DIR_ARG = "--out-dir=";

type Finding = {
  rule: string;
  severity: "error" | "info";
  file: string;
  line: number;
  snippet: string;
};

function collectFiles(rel: string): string[] {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) return [];
  const stat = fs.statSync(abs);
  if (stat.isFile()) return CODE_EXT_RE.test(rel) ? [rel.replace(/\\/g, "/")] : [];

  const out: string[] = [];
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const child = `${rel}/${entry.name}`.replace(/\\/g, "/");
    if (entry.isDirectory()) out.push(...collectFiles(child));
    else if (CODE_EXT_RE.test(entry.name)) out.push(child);
  }
  return out;
}

function lineForIndex(content: string, idx: number): number {
  return content.slice(0, idx).split(/\r?\n/).length;
}

function lineText(content: string, line: number): string {
  return content.split(/\r?\n/)[line - 1]?.trim().slice(0, 180) ?? "";
}

function isClientFile(content: string): boolean {
  return /^\s*["']use client["'];?/.test(content.slice(0, 300));
}

function tableRe(table: string): string {
  return String.raw`\.from\s*\(\s*["'\`]${table}["'\`]\s*\)`;
}

function addMatches(
  findings: Finding[],
  rule: string,
  severity: "error" | "info",
  file: string,
  content: string,
  re: RegExp,
): void {
  for (const match of content.matchAll(re)) {
    const idx = match.index ?? 0;
    const line = lineForIndex(content, idx);
    findings.push({ rule, severity, file, line, snippet: lineText(content, line) });
  }
}

function scanFile(file: string, findings: Finding[]): void {
  const abs = path.join(ROOT, file);
  const content = fs.readFileSync(abs, "utf8");
  const client = isClientFile(content);
  const tableGroup = PRODUCT_AWARE_TABLES.map(tableRe).join("|");

  if (client) {
    addMatches(
      findings,
      "direct-browser-supabase-write-product-aware-row",
      "error",
      file,
      content,
      new RegExp(String.raw`(?:${tableGroup})[\s\S]{0,240}\.(?:insert|update|upsert|delete)\s*\(`, "g"),
    );

    addMatches(
      findings,
      "products-insert-from-ui",
      "error",
      file,
      content,
      new RegExp(String.raw`${tableRe("products")}[\s\S]{0,160}\.(?:insert|upsert)\s*\(`, "g"),
    );

    addMatches(
      findings,
      "raw-return-items-client-read-without-server-hydration",
      "error",
      file,
      content,
      new RegExp(String.raw`${tableRe("return_items")}[\s\S]{0,200}\.select\s*\(`, "g"),
    );
  }

  addMatches(
    findings,
    "legacy-returns-table",
    "error",
    file,
    content,
    /\.from\s*\(\s*["'`]returns["'`]\s*\)/g,
  );

  addMatches(
    findings,
    "package-items-runtime-reference",
    "error",
    file,
    content,
    /\.from\s*\(\s*["'`]package_items["'`]\s*\)|\bpublic\.package_items\b|CREATE\s+TABLE\s+[^;]*package_items|INSERT\s+INTO\s+[^;]*package_items/gi,
  );

  addMatches(
    findings,
    "title-ocr-fuzzy-ai-auto-link-risk",
    "error",
    file,
    content,
    /resolved_product_id\s*[:=]\s*\b(?:title|ocr|product_name|item_name|fuzzy|ai)\b|resolved_product_id\s*[:=]\s*[^,\n}]*\b(?:title|ocr|product_name|item_name|fuzzy|ai)\b[^,\n}]*/gi,
  );
}

function scanInformational(findings: Finding[]): void {
  const knownServerAction = "app/returns/barcode-product-cache-actions.ts";
  const abs = path.join(ROOT, knownServerAction);
  if (!fs.existsSync(abs)) return;
  const content = fs.readFileSync(abs, "utf8");
  const re = new RegExp(String.raw`${tableRe("products")}[\s\S]{0,160}\.insert\s*\(`, "g");
  for (const match of content.matchAll(re)) {
    const line = lineForIndex(content, match.index ?? 0);
    findings.push({
      rule: "server-action-products-insert-existing-governed-exception",
      severity: "info",
      file: knownServerAction,
      line,
      snippet: lineText(content, line),
    });
  }
}

function outDirArg(): string | null {
  const arg = process.argv.find((value) => value.startsWith(OUT_DIR_ARG));
  return arg ? arg.slice(OUT_DIR_ARG.length) : null;
}

function writeArtifacts(outDir: string, payload: unknown, markdown: string): void {
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "guard-script-result.json"), JSON.stringify(payload, null, 2));
  fs.writeFileSync(path.join(outDir, "guard-script-result.md"), markdown);
}

function main(): void {
  const files = SOURCE_DIRS.flatMap(collectFiles);
  const findings: Finding[] = [];
  for (const file of files) scanFile(file, findings);
  scanInformational(findings);

  const errors = findings.filter((finding) => finding.severity === "error");
  const infos = findings.filter((finding) => finding.severity === "info");
  const status = errors.length === 0 ? "PASS" : "FAIL";
  const payload = {
    guard: "product-resolution-contract-guard-v192",
    status,
    scanned_files: files.length,
    errors,
    informational_findings: infos,
  };

  const markdown = [
    "# Product resolution contract guard V192",
    "",
    `Status: **${status}**`,
    `Files scanned: **${files.length}**`,
    `Errors: **${errors.length}**`,
    `Informational findings: **${infos.length}**`,
    "",
    "## Errors",
    "",
    errors.length
      ? errors.map((f) => `- ${f.rule}: \`${f.file}:${f.line}\` ${f.snippet}`).join("\n")
      : "None.",
    "",
    "## Informational Findings",
    "",
    infos.length
      ? infos.map((f) => `- ${f.rule}: \`${f.file}:${f.line}\` ${f.snippet}`).join("\n")
      : "None.",
    "",
  ].join("\n");

  const outDir = outDirArg();
  if (outDir) writeArtifacts(path.resolve(ROOT, outDir), payload, markdown);

  console.log(JSON.stringify(payload, null, 2));
  if (errors.length > 0) process.exit(1);
}

main();
