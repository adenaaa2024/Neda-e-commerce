/**
 * Static guard: Finances ingest modules must not import FRR / domain financial writers.
 * Run: npm run test:finances-api-no-frr-import
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(process.cwd(), "lib/amazon");
const FINANCES_PREFIX = "finances-api";
const WORKER_ROUTES = join(process.cwd(), "app/api/settings/imports/finances-api");

const FORBIDDEN_PATTERNS = [
  /financial_reference_resolver/,
  /\.from\s*\(\s*["']amazon_staging["']/,
  /\.from\s*\(\s*["']claims["']/,
  /\.from\s*\(\s*["']products["']/,
  /\.from\s*\(\s*["']product_identifier_map["']/,
  /reports-api-pipeline-handoff/,
  /runReportsApiImportPipeline/,
  /openai/i,
];

function collectTsFiles(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) collectTsFiles(p, out);
    else if (name.endsWith(".ts")) out.push(p);
  }
}

function scanFile(path: string): string[] {
  const text = readFileSync(path, "utf8");
  const hits: string[] = [];
  for (const pat of FORBIDDEN_PATTERNS) {
    if (pat.test(text)) hits.push(pat.source);
  }
  return hits;
}

function main(): void {
  const files: string[] = [];
  for (const name of readdirSync(ROOT)) {
    if (!name.startsWith(FINANCES_PREFIX) || !name.endsWith(".ts")) continue;
    files.push(join(ROOT, name));
  }
  collectTsFiles(WORKER_ROUTES, files);

  const violations: Array<{ file: string; patterns: string[] }> = [];
  for (const f of files) {
    const patterns = scanFile(f);
    if (patterns.length) violations.push({ file: f, patterns });
  }

  if (violations.length) {
    console.error("Finances ingest no-FRR guard FAILED:\n");
    for (const v of violations) {
      console.error(`  ${v.file}`);
      for (const p of v.patterns) console.error(`    - ${p}`);
    }
    process.exit(1);
  }

  console.log(`  ok scanned ${files.length} finances-api module(s) — no FRR/domain imports`);
  console.log("\n1/1 finances no-FRR import guard passed");
}

main();
