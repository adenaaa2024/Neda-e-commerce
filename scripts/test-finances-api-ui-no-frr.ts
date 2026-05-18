/**
 * UI modules must not reference FRR / claims / products writers.
 * Run: npm run test:finances-api-ui-no-frr
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

const FILES = [
  "lib/amazon/finances-api-ui.ts",
  "app/(admin)/imports/FinancesApiArchivePanel.tsx",
  "app/api/settings/imports/finances-api/status/route.ts",
];

const FORBIDDEN = [
  /financial_reference_resolver/,
  /\.from\s*\(\s*["']claims["']/,
  /\.from\s*\(\s*["']products["']/,
  /openai/i,
  /NEXT_PUBLIC_.*FINANCES/,
];

function main(): void {
  for (const rel of FILES) {
    const text = readFileSync(join(process.cwd(), rel), "utf8");
    for (const pat of FORBIDDEN) {
      if (pat.test(text)) {
        console.error(`FAIL ${rel}: matched ${pat.source}`);
        process.exit(1);
      }
    }
  }
  console.log(`  ok ${FILES.length} finances UI files — no FRR/domain patterns`);
  console.log("\n1/1 passed");
}

main();
