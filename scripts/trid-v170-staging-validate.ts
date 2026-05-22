/**
 * TRID-V170 — Staging validate reference candidates API/data + UI markers.
 *
 *   npm run verify:trid-v170-staging
 *   TRID_V170_RUN_ID=20260519T120000Z npm run verify:trid-v170-staging
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createClient } from "@supabase/supabase-js";

import { buildReferenceCandidatesResponseForDraftId } from "../lib/claim-reference-candidates";
import { resolveCandidateForDraft } from "../lib/claim-evidence-preview";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const ORG_ID = "00000000-0000-0000-0000-000000000001";
const DRAFT_ID = "003db7ff-23f5-4d28-b13e-e13198ea38d8";
const RUN_ID = process.env.TRID_V170_RUN_ID?.trim() || "20260519T120000Z";

const REQUIRED_CANDIDATE_FIELDS = [
  "reference_value",
  "reference_type",
  "source_table",
  "source_row_id",
  "event_date",
  "amount",
  "confidence",
  "claim_case_join_reason",
  "lineage",
] as const;

function loadEnvFile(filePath: string): void {
  if (!fs.existsSync(filePath)) return;
  for (const line of fs.readFileSync(filePath, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq <= 0) continue;
    const k = t.slice(0, eq).trim();
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[k] == null || process.env[k] === "") process.env[k] = v;
  }
}

function loadEnvLocal(): void {
  loadEnvFile(path.join(process.cwd(), ".env.local"));
}

function checkEnvGates(): Record<string, unknown> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ?? "";
  const prodUrl = process.env.PRODUCTION_SUPABASE_URL?.trim() ?? "";
  const prodRef = process.env.PRODUCTION_PROJECT_REF?.trim() ?? "";
  const prodKey = process.env.PRODUCTION_SERVICE_ROLE_KEY?.trim() ?? "";
  const prodPg = process.env.PRODUCTION_DIRECT_POSTGRES_URL?.trim() ?? "";

  return {
    next_public_supabase_url: url.replace(/https:\/\/([^.]+)\.supabase\.co.*/, "https://$1.supabase.co"),
    staging_ref_match: url.includes(STAGING_REF),
    production_supabase_url_blank: prodUrl === "",
    production_project_ref_blank: prodRef === "",
    production_service_role_blank: prodKey === "",
    production_direct_postgres_blank: prodPg === "",
    all_production_blank:
      prodUrl === "" && prodRef === "" && prodKey === "" && prodPg === "",
    active_points_to_staging: url.includes(STAGING_REF),
  };
}

function verifyUiMarkers(): Record<string, boolean> {
  const panelPath = path.join(process.cwd(), "components", "claims", "ClaimReferenceCandidatesPanel.tsx");
  const panel = fs.readFileSync(panelPath, "utf8");
  const draftClient = fs.readFileSync(
    path.join(process.cwd(), "app", "claim-engine", "evidence", "ClaimDraftEvidenceClient.tsx"),
    "utf8",
  );
  const inboxClient = fs.readFileSync(
    path.join(process.cwd(), "app", "claim-engine", "inbox", "ClaimInboxClient.tsx"),
    "utf8",
  );
  const draftRoute = fs.readFileSync(
    path.join(process.cwd(), "app", "api", "claims", "drafts", "[draftId]", "reference-candidates", "route.ts"),
    "utf8",
  );
  const inboxRoute = fs.readFileSync(
    path.join(process.cwd(), "app", "api", "claims", "inbox", "[candidateId]", "reference-candidates", "route.ts"),
    "utf8",
  );

  return {
    panel_reference_value: panel.includes("reference_value"),
    panel_reference_type: panel.includes("reference_type"),
    panel_source_table: panel.includes("source_table"),
    panel_confidence: panel.includes("confidence"),
    panel_copy_button: panel.includes("CopyButton") && panel.includes("clipboard.writeText"),
    panel_lineage_details: panel.includes("Lineage"),
    panel_read_only_note: panel.includes("read-only"),
    draft_client_wires_panel: draftClient.includes("ClaimReferenceCandidatesPanel"),
    inbox_client_wires_panel: inboxClient.includes("ClaimReferenceCandidatesPanel"),
    draft_api_route_exists: draftRoute.includes("buildReferenceCandidatesResponseForDraftId"),
    inbox_api_route_exists: inboxRoute.includes("loadAndBuildReferenceCandidatesForDraft"),
    draft_api_no_submit: draftRoute.includes("NextResponse.json") && !draftRoute.includes("filing-requests"),
    no_amazon_in_builder: !fs
      .readFileSync(path.join(process.cwd(), "lib", "claim-reference-candidates.ts"), "utf8")
      .match(/sellingpartner|amazon\.com\/sp-api/i),
  };
}

function validateCandidateShape(
  candidates: Record<string, unknown>[],
): { ok: boolean; missing_by_index: { index: number; missing: string[] }[] } {
  const missing_by_index: { index: number; missing: string[] }[] = [];
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i]!;
    const missing: string[] = [];
    for (const f of REQUIRED_CANDIDATE_FIELDS) {
      if (!(f in c)) missing.push(f);
    }
    if (c.lineage == null || typeof c.lineage !== "object") missing.push("lineage.object");
    if (missing.length) missing_by_index.push({ index: i, missing });
  }
  return { ok: missing_by_index.length === 0, missing_by_index };
}

function topSources(candidates: { source_table: string; confidence: number }[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const c of candidates) {
    counts[c.source_table] = (counts[c.source_table] ?? 0) + 1;
  }
  return Object.fromEntries(
    Object.entries(counts).sort((a, b) => b[1] - a[1]),
  );
}

async function tryHttpDraftApi(baseUrl: string, orgId: string): Promise<Record<string, unknown>> {
  const url = `${baseUrl}/api/claims/drafts/${DRAFT_ID}/reference-candidates?organization_id=${orgId}`;
  try {
    const res = await fetch(url, { method: "GET" });
    const text = await res.text();
    let body: unknown = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = { raw: text.slice(0, 500) };
    }
    const contentType = res.headers.get("content-type") ?? "";
    const isJson =
      contentType.includes("application/json") &&
      body &&
      typeof body === "object" &&
      !Array.isArray(body);
    const jsonBody = isJson ? (body as Record<string, unknown>) : null;
    return {
      attempted: true,
      url_path: `/api/claims/drafts/${DRAFT_ID}/reference-candidates`,
      status: res.status,
      content_type: contentType,
      ok: Boolean(res.ok && isJson),
      note: !isJson
        ? res.status === 401 || res.status === 403
          ? "Auth required — validate in browser while signed in."
          : "Response is not JSON (likely HTML without session). Data-layer validation is authoritative."
        : "HTTP JSON OK",
      schema_version:
        jsonBody && "schema_version" in jsonBody ? String(jsonBody.schema_version) : null,
      candidate_count_returned:
        jsonBody && "candidate_count_returned" in jsonBody
          ? Number(jsonBody.candidate_count_returned)
          : null,
    };
  } catch (e) {
    return {
      attempted: true,
      url_path: `/api/claims/drafts/${DRAFT_ID}/reference-candidates`,
      ok: false,
      error: e instanceof Error ? e.message : String(e),
      note: "Dev server not reachable — use data-layer validation only.",
    };
  }
}

async function main(): Promise<void> {
  loadEnvLocal();
  const outDir = path.resolve(process.cwd(), ".cursor/audit-reports/trid-v170-staging-validate", RUN_ID);
  fs.mkdirSync(outDir, { recursive: true });

  const envGates = checkEnvGates();
  const uiMarkers = verifyUiMarkers();
  const uiAllTrue = Object.values(uiMarkers).every(Boolean);

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  const baseUrl = (process.env.TRID_V170_BASE_URL ?? "http://127.0.0.1:3000").replace(/\/$/, "");

  if (!url || !key) {
    const fail = { env_gates: envGates, ui_markers: uiMarkers, error: "Missing Supabase env" };
    fs.writeFileSync(path.join(outDir, "validation.json"), JSON.stringify(fail, null, 2));
    process.exitCode = 1;
    return;
  }

  if (!envGates.active_points_to_staging || !envGates.all_production_blank) {
    console.error("ENV GATE FAIL: staging ref or PRODUCTION_* not blank");
    process.exitCode = 1;
  }

  const client = createClient(url, key, { auth: { persistSession: false } });

  const draftResponse = await buildReferenceCandidatesResponseForDraftId(client, ORG_ID, DRAFT_ID);
  if (!draftResponse) throw new Error(`Draft ${DRAFT_ID} not found on staging.`);

  const shape = validateCandidateShape(draftResponse.candidates as unknown as Record<string, unknown>[]);
  const sources = topSources(draftResponse.candidates);
  const sample = draftResponse.candidates.slice(0, 3).map((c) => ({
    reference_value: c.reference_value.slice(0, 48),
    reference_type: c.reference_type,
    source_table: c.source_table,
    source_row_id: c.source_row_id,
    event_date: c.event_date,
    amount: c.amount,
    confidence: c.confidence,
    claim_case_join_reason: c.claim_case_join_reason,
    lineage_keys: Object.keys(c.lineage ?? {}),
  }));

  let inboxResponse: Awaited<ReturnType<typeof buildReferenceCandidatesResponseForDraftId>> | null = null;
  let inboxCandidateId: string | null = null;
  const linked = await resolveCandidateForDraft(client, ORG_ID, {
    source_table: draftResponse.operational?.source_table ?? "amazon_removals",
    source_row_id: draftResponse.operational?.source_row_id ?? "",
    sku: draftResponse.operational?.sku ?? null,
    store_id: null,
  });
  if (linked?.id) {
    inboxCandidateId = linked.id;
    inboxResponse = await buildReferenceCandidatesResponseForDraftId(client, ORG_ID, DRAFT_ID, {
      claim_candidate_id: linked.id,
    });
  }

  const httpDraft = await tryHttpDraftApi(baseUrl, ORG_ID);
  let httpInbox: Record<string, unknown> = { attempted: false };
  if (inboxCandidateId) {
    const inboxUrl = `${baseUrl}/api/claims/inbox/${inboxCandidateId}/reference-candidates?organization_id=${ORG_ID}`;
    try {
      const res = await fetch(inboxUrl);
      httpInbox = {
        attempted: true,
        url_path: `/api/claims/inbox/${inboxCandidateId}/reference-candidates`,
        status: res.status,
        ok: res.ok,
      };
    } catch (e) {
      httpInbox = {
        attempted: true,
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  }

  const validation = {
    prompt_id: "TRID-V170-STAGING-VALIDATE",
    run_id: RUN_ID,
    staging_project_ref: STAGING_REF,
    draft_id: DRAFT_ID,
    organization_id: ORG_ID,
    env_gates: envGates,
    ui_markers: uiMarkers,
    ui_markers_all_true: uiAllTrue,
    data_layer: {
      draft_api_equivalent: "buildReferenceCandidatesResponseForDraftId",
      schema_version: draftResponse.schema_version,
      does_not_submit: draftResponse.does_not_submit,
      outcome: draftResponse.outcome,
      candidate_count: draftResponse.candidate_count,
      candidate_count_returned: draftResponse.candidate_count_returned,
      truncated: draftResponse.truncated,
      top_sources: sources,
      candidate_shape_valid: shape.ok,
      shape_issues: shape.missing_by_index,
      sample_candidates: sample,
      operational: draftResponse.operational,
      warnings_codes: draftResponse.warnings.map((w) => w.code),
    },
    inbox: inboxCandidateId
      ? {
          claim_candidate_id: inboxCandidateId,
          candidate_count: inboxResponse?.candidate_count ?? null,
          outcome: inboxResponse?.outcome ?? null,
          matches_draft_count:
            inboxResponse?.candidate_count === draftResponse.candidate_count,
        }
      : { claim_candidate_id: null, note: "No legacy claim_candidates row linked" },
    http: {
      draft: httpDraft,
      inbox: httpInbox,
    },
    guards: {
      no_claim_submission_code_in_routes: uiMarkers.draft_api_no_submit,
      no_amazon_api_in_builder: uiMarkers.no_amazon_in_builder,
      read_only_flag: draftResponse.does_not_submit === true,
    },
    ui_page: `/claim-engine/evidence?draft_id=${DRAFT_ID}`,
  };

  fs.writeFileSync(path.join(outDir, "validation.json"), JSON.stringify(validation, null, 2));
  fs.writeFileSync(
    path.join(outDir, "candidates-redacted.json"),
    JSON.stringify(
      {
        candidates: draftResponse.candidates.map((c) => ({
          reference_value: c.reference_value.slice(0, 64),
          reference_type: c.reference_type,
          source_table: c.source_table,
          source_row_id: c.source_row_id,
          event_date: c.event_date,
          amount: c.amount,
          currency: c.currency,
          confidence: c.confidence,
          claim_case_join_reason: c.claim_case_join_reason,
          operator_selected: c.operator_selected,
          lineage: c.lineage,
        })),
      },
      null,
      2,
    ),
  );

  const summaryLines = [
    "# TRID-V170 — Staging validation",
    "",
    `**Run:** \`${RUN_ID}\` · **Staging:** \`${STAGING_REF}\``,
    "",
    "## Environment",
    "",
    `- Active Supabase URL points to staging: **${envGates.active_points_to_staging ? "yes" : "NO"}**`,
    `- PRODUCTION_* blank: **${envGates.all_production_blank ? "yes" : "NO"}**`,
    "",
    "## Data layer (service role — same builder as GET routes)",
    "",
    `| Metric | Value |`,
    `|--------|-------|`,
    `| Draft | \`${DRAFT_ID}\` |`,
    `| Outcome | \`${draftResponse.outcome}\` |`,
    `| Candidate count | ${draftResponse.candidate_count} |`,
    `| Returned | ${draftResponse.candidate_count_returned} |`,
    `| does_not_submit | ${draftResponse.does_not_submit} |`,
    `| Shape valid | ${shape.ok ? "yes" : "NO"} |`,
    "",
    "### Top sources",
    "",
    ...Object.entries(sources).map(([t, n]) => `- \`${t}\`: ${n}`),
    "",
    "## HTTP routes",
    "",
    `- Draft route: status ${httpDraft.status ?? "n/a"} — ${httpDraft.note ?? ""}`,
    inboxCandidateId
      ? `- Inbox route (\`${inboxCandidateId}\`): status ${httpInbox.status ?? "n/a"}`
      : "- Inbox route: skipped (no linked candidate)",
    "",
    "## UI markers (static)",
    "",
    `All UI checks passed: **${uiAllTrue ? "yes" : "NO"}**`,
    "",
    `Operator page: [\`/claim-engine/evidence?draft_id=${DRAFT_ID}\`](${validation.ui_page})`,
    "",
    "## Guards",
    "",
    "- No claim submission in reference-candidates routes",
    "- No Amazon SP-API calls in builder",
    "",
  ];

  fs.writeFileSync(path.join(outDir, "summary.md"), summaryLines.join("\n"), "utf8");
  fs.writeFileSync(
    path.join(outDir, "manifest.json"),
    JSON.stringify(
      {
        prompt_id: "TRID-V170-STAGING-VALIDATE",
        run_id: RUN_ID,
        artifacts: ["summary.md", "validation.json", "candidates-redacted.json", "manifest.json"],
      },
      null,
      2,
    ),
  );

  console.log(JSON.stringify(validation, null, 2));

  const pass =
    envGates.active_points_to_staging &&
    envGates.all_production_blank &&
    shape.ok &&
    uiAllTrue &&
    draftResponse.does_not_submit === true;

  if (!pass) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
