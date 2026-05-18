/**
 * SCANNER-02F — staging smoke preflight (approval + local env; DB checks via Supabase MCP separately).
 * Run: npm run smoke:scanner-02f-preflight
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

function loadEnvLocal(): void {
  const p = join(process.cwd(), ".env.local");
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq <= 0) continue;
    const k = t.slice(0, eq).trim();
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))
      v = v.slice(1, -1);
    if (process.env[k] == null || process.env[k] === "") process.env[k] = v;
  }
}

const APPROVAL_PATH = join(
  process.cwd(),
  ".cursor/operator-approvals/scanner-02f-staging-smoke-approval.md",
);

type Gate = { id: string; pass: boolean; detail: string };

function approvalOk(content: string): boolean {
  return /^APPROVED_TO_RUN_SCANNER_02F_STAGING_SMOKE\s*=\s*true\s*$/im.test(content);
}

function main(): void {
  loadEnvLocal();
  const gates: Gate[] = [];

  if (!existsSync(APPROVAL_PATH)) {
    gates.push({ id: "approval_file", pass: false, detail: "Approval file missing." });
  } else {
    const content = readFileSync(APPROVAL_PATH, "utf8");
    gates.push({
      id: "approval_flag",
      pass: approvalOk(content),
      detail: approvalOk(content)
        ? "APPROVED_TO_RUN_SCANNER_02F_STAGING_SMOKE=true"
        : "Flag not true in approval file.",
    });
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ?? "";
  gates.push({
    id: "staging_url",
    pass: url.includes("kxsvedvpjldygtdbylsy"),
    detail: url
      ? url.includes("kxsvedvpjldygtdbylsy")
        ? "Staging Supabase URL configured."
        : "URL does not match staging ref."
      : "NEXT_PUBLIC_SUPABASE_URL unset.",
  });

  gates.push({
    id: "service_role",
    pass: !!process.env.SUPABASE_SERVICE_ROLE_KEY?.trim(),
    detail: process.env.SUPABASE_SERVICE_ROLE_KEY
      ? "Service role present (not logged)."
      : "SUPABASE_SERVICE_ROLE_KEY unset.",
  });

  let failed = 0;
  console.log("SCANNER-02F preflight (local gates)\n");
  for (const g of gates) {
    const mark = g.pass ? "PASS" : "FAIL";
    if (!g.pass) failed++;
    console.log(`  [${mark}] ${g.id}: ${g.detail}`);
  }
  console.log(
    failed
      ? "\nBLOCKED — fix gates; run staging DB verification via Supabase MCP or linked project."
      : "\nLocal gates OK — proceed with manual UI smoke charter.",
  );
  if (failed) process.exit(1);
}

main();
