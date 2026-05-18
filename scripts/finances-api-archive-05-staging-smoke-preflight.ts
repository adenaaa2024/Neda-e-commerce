/**
 * NEXT-FINANCES-API-ARCHIVE-05 — staging smoke preflight (no live Amazon, no server-only imports).
 * Run: npm run smoke:finances-api-archive-05-preflight
 *
 * Full ingest requires approval + env on a host that can call finances-api routes
 * (staging deploy or local dev with .env.local pointing at kxsvedvpjldygtdbylsy).
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const APPROVAL_PATH = join(
  process.cwd(),
  ".cursor/operator-approvals/finances-api-archive-05-staging-smoke-approval.md",
);
const STAGING_REF = "kxsvedvpjldygtdbylsy";
const MAX_WINDOW_DAYS = 7;

type GateResult = { id: string; pass: boolean; detail: string };

function parseApprovalFlag(content: string): boolean {
  return /^APPROVED_TO_RUN_FINANCES_API_ARCHIVE_05_STAGING_SMOKE\s*=\s*true\s*$/im.test(
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
  const worker = envFlag("ENABLE_AMAZON_FINANCES_API_WORKER");
  const ingest = envFlag("ENABLE_AMAZON_FINANCES_API_INGEST");
  return [
    {
      id: "flag_worker",
      pass: worker,
      detail: worker
        ? "ENABLE_AMAZON_FINANCES_API_WORKER=true"
        : "ENABLE_AMAZON_FINANCES_API_WORKER not enabled.",
    },
    {
      id: "flag_ingest",
      pass: ingest && worker,
      detail: ingest && worker
        ? "ENABLE_AMAZON_FINANCES_API_INGEST=true (with worker)"
        : "Ingest flag off or worker off.",
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
      ? "APPROVED_TO_RUN_FINANCES_API_ARCHIVE_05_STAGING_SMOKE=true"
      : "Approval file present but flag not true.",
  };
}

function checkWindowEnv(): GateResult {
  const start = process.env.FINANCES_SMOKE_WINDOW_START?.trim() ?? "";
  const end = process.env.FINANCES_SMOKE_WINDOW_END?.trim() ?? "";
  if (!start || !end) {
    return {
      id: "smoke_window",
      pass: false,
      detail:
        "Optional FINANCES_SMOKE_WINDOW_START / FINANCES_SMOKE_WINDOW_END not set (required at execute time).",
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
      pass: !!(process.env.FINANCES_SMOKE_ORG_ID?.trim() && process.env.FINANCES_SMOKE_STORE_ID?.trim()),
      detail:
        process.env.FINANCES_SMOKE_ORG_ID && process.env.FINANCES_SMOKE_STORE_ID
          ? "FINANCES_SMOKE_ORG_ID and FINANCES_SMOKE_STORE_ID set."
          : "Set FINANCES_SMOKE_ORG_ID and FINANCES_SMOKE_STORE_ID for execute step.",
    },
  ];

  let failed = 0;
  console.log("NEXT-FINANCES-API-ARCHIVE-05 preflight\n");
  for (const g of gates) {
    const mark = g.pass ? "PASS" : "FAIL";
    if (!g.pass) failed++;
    console.log(`  [${mark}] ${g.id}: ${g.detail}`);
  }

  const executeReady = gates.every((g) => g.pass);
  console.log(
    executeReady
      ? "\nAll gates passed — run ingest via staging UI or POST …/finances-api/run (see audit smoke-execution-charter.md)."
      : "\nBLOCKED — fix failing gates before live smoke.",
  );

  if (!executeReady) process.exit(1);
}

main();
