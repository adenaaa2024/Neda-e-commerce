/**
 * V165 — static guard: no direct products.insert in returns/scanner paths except governed action.
 * Run: npx tsx scripts/check-returns-unguarded-products-insert.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = process.cwd();

const SCAN_DIRS = [
  "app/returns",
  "components/returns",
  "lib/scanner-product-resolve.ts",
  "lib/slip-contents-resolver-write.ts",
  "hooks/useBarcodeRouter.ts",
];

const ALLOWED_INSERT_FILES = new Set([
  path.normalize("app/returns/barcode-product-cache-actions.ts"),
]);

const INSERT_RE = /\.from\s*\(\s*["']products["']\s*\)[\s\S]{0,120}?\.insert\s*\(/;
const MAP_INSERT_RE =
  /\.from\s*\(\s*["']product_identifier_map["']\s*\)[\s\S]{0,120}?\.insert\s*\(/;

function collectFiles(rel: string): string[] {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) return [];
  const st = fs.statSync(abs);
  if (st.isFile()) return [rel.replace(/\\/g, "/")];
  const out: string[] = [];
  for (const ent of fs.readdirSync(abs, { withFileTypes: true })) {
    if (ent.name.startsWith(".")) continue;
    const child = `${rel}/${ent.name}`.replace(/\\/g, "/");
    if (ent.isDirectory()) out.push(...collectFiles(child));
    else if (/\.(tsx?|jsx?)$/.test(ent.name)) out.push(child);
  }
  return out;
}

function main(): void {
  const violations: { file: string; line: number; snippet: string }[] = [];
  const files = new Set<string>();
  for (const d of SCAN_DIRS) collectFiles(d).forEach((f) => files.add(f));

  for (const file of files) {
    const norm = path.normalize(file);
    if (ALLOWED_INSERT_FILES.has(norm)) continue;
    const content = fs.readFileSync(path.join(ROOT, file), "utf8");
    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const chunk = lines.slice(i, Math.min(i + 3, lines.length)).join("\n");
      if (INSERT_RE.test(chunk)) {
        violations.push({
          file,
          line: i + 1,
          snippet: `[products.insert] ${lines[i]!.trim().slice(0, 100)}`,
        });
        break;
      }
      if (MAP_INSERT_RE.test(chunk)) {
        violations.push({
          file,
          line: i + 1,
          snippet: `[product_identifier_map.insert] ${lines[i]!.trim().slice(0, 100)}`,
        });
        break;
      }
    }
  }

  if (violations.length) {
    console.error("check-returns-unguarded-products-insert: FAIL\n");
    for (const v of violations) {
      console.error(`  ${v.file}:${v.line}  ${v.snippet}`);
    }
    console.error(
      "\nUse cacheBarcodeProductFromAmazonLookup in app/returns/barcode-product-cache-actions.ts only.",
    );
    process.exit(1);
  }

  console.log(
    `check-returns-unguarded-products-insert: PASS (${files.size} files scanned, insert only in governed action)`,
  );
}

main();
