/**
 * NEXT-IMPORT-API-09 — Settlement Reports API staging smoke preflight (no live Amazon).
 * Run: npm run smoke:import-api-09-settlement-preflight
 *
 * Full pull requires approval + flags on a host that can call settlement routes
 * (staging deploy or local dev with .env.local pointing at kxsvedvpjldygtdbylsy).
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const APPROVAL_PATH = join(
  process.cwd(),
  ".cursor/operator-approvals/import-api-09-settlement-staging-smoke-approval.md",
);
const STAGING_REF = "kxsvedvpjldygtdbylsy";
const MAX_WINDOW_DAYS = 7;

type GateResult = { id: string; pass: boolean; detail: string };

function parseApprovalFlag(content: string): boolean {
  return /^APPROVED_TO_RUN_IMPORT_API_09_SETTLEMENT_STAGING_SMOKE\s*=\s*true\s*$/im.test(
    content,
  );
}

function envFlag(name: string): boolean {
  const v = process.env[name]?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

function checkStagingUrl(): GateResult {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ?? "";
  if (!url) {
    return { id: "staging_url", pass: false, detail: "NEXT_PUBLIC_SUPABASE_URL unset." };
  }
  if (!url.includes(STAGING_REF)) {
    return {
      id: "staging_url",
      pass: false,
      detail: `URL does not contain staging ref ${STAGING_REF} (host redacted).`,
    };
  }
  return { id: "staging_url", pass: true, detail: "Supabase URL matches staging project ref." };
}

function checkServiceRole(): GateResult {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ?? "";
  if (!key) {
    return { id: "service_role", pass: false, detail: "SUPABASE_SERVICE_ROLE_KEY unset." };
  }
  return { id: "service_role", pass: true, detail: "Service role key present (value not logged)." };
}

function checkFlags(): GateResult[] {
  const worker = envFlag("ENABLE_AMAZON_REPORTS_API_WORKER");
  const settlement = envFlag("ENABLE_AMAZON_REPORTS_API_SETTLEMENT");
  return [
    {
      id: "flag_worker",
      pass: worker,
      detail: worker
        ? "ENABLE_AMAZON_REPORTS_API_WORKER=true"
        : "ENABLE_AMAZON_REPORTS_API_WORKER not enabled.",
    },
    {
      id: "flag_settlement",
      pass: settlement && worker,
      detail: settlement && worker
        ? "ENABLE_AMAZON_REPORTS_API_SETTLEMENT=true (with worker)"
        : "Settlement flag off or worker off.",
    },
  ];
}

function checkApproval(): GateResult {
  if (!existsSync(APPROVAL_PATH)) {
    return {
      id: "approval_file",
      pass: false,
      detail: `Missing ${APPROVAL_PATH}`,
    };
  }
  const content = readFileSync(APPROVAL_PATH, "utf8");
  const approved = parseApprovalFlag(content);
  return {
    id: "approval_flag",
    pass: approved,
    detail: approved
      ? "APPROVED_TO_RUN_IMPORT_API_09_SETTLEMENT_STAGING_SMOKE=true"
      : "Approval file present but flag not true.",
  };
}

function checkWindowEnv(): GateResult {
  const start = process.env.REPORTS_API_SETTLEMENT_SMOKE_WINDOW_START?.trim() ?? "";
  const end = process.env.REPORTS_API_SETTLEMENT_SMOKE_WINDOW_END?.trim() ?? "";
  if (!start || !end) {
    return {
      id: "smoke_window",
      pass: false,
      detail:
        "REPORTS_API_SETTLEMENT_SMOKE_WINDOW_START / REPORTS_API_SETTLEMENT_SMOKE_WINDOW_END not set (required at execute time).",
    };
  }
  const s = new Date(start);
  const e = new Date(end);
  if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime())) {
    return { id: "smoke_window", pass: false, detail: "Invalid ISO window dates." };
  }
  const days = (e.getTime() - s.getTime()) / (86400 * 1000);
  if (days < 0) {
    return { id: "smoke_window", pass: false, detail: "Window end before start." };
  }
  if (days > MAX_WINDOW_DAYS) {
    return {
      id: "smoke_window",
      pass: false,
      detail: `Window ${days.toFixed(1)} days exceeds max ${MAX_WINDOW_DAYS} days.`,
    };
  }
  return {
    id: "smoke_window",
    pass: true,
    detail: `Window span ${days.toFixed(1)} days (within ${MAX_WINDOW_DAYS}d cap).`,
  };
}

function main(): void {
  const gates: GateResult[] = [
    checkApproval(),
    checkStagingUrl(),
    checkServiceRole(),
    ...checkFlags(),
    checkWindowEnv(),
    {
      id: "org_store",
      pass: !!(
        process.env.REPORTS_API_SETTLEMENT_SMOKE_ORG_ID?.trim() &&
        process.env.REPORTS_API_SETTLEMENT_SMOKE_STORE_ID?.trim()
      ),
      detail:
        process.env.REPORTS_API_SETTLEMENT_SMOKE_ORG_ID &&
        process.env.REPORTS_API_SETTLEMENT_SMOKE_STORE_ID
          ? "REPORTS_API_SETTLEMENT_SMOKE_ORG_ID and REPORTS_API_SETTLEMENT_SMOKE_STORE_ID set."
          : "Set org/store env for execute (staging Sam AM: org 00000000-0000-0000-0000-000000000001, store 509ee1f6-622c-46a5-8110-7b889ba46c2c).",
    },
  ];

  let failed = 0;
  console.log("NEXT-IMPORT-API-09 settlement staging preflight\n");
  for (const g of gates) {
    const mark = g.pass ? "PASS" : "FAIL";
    if (!g.pass) failed++;
    console.log(`  [${mark}] ${g.id}: ${g.detail}`);
  }

  const executeReady = gates.every((g) => g.pass);
  console.log(
    executeReady
      ? "\nAll gates passed — run via Imports → Settlement Reports API or POST …/reports-api/settlement/run (see audit smoke-execution-charter.md)."
      : "\nBLOCKED — fix failing gates before live smoke.",
  );

  if (!executeReady) process.exit(1);
}

main();
