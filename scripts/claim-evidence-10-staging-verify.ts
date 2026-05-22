/**
 * CLAIM-EVIDENCE-10 — Staging verify: filing packet validation.
 *
 *   npm run verify:claim-evidence-10-staging
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createClient } from "@supabase/supabase-js";

import { buildClaimFilingPacketValidation } from "../lib/claim-filing-packet-validation";
import { fetchDraftRow } from "../lib/claim-evidence-preview";

const ORG_ID = "00000000-0000-0000-0000-000000000001";
const DRAFT_ID = "003db7ff-23f5-4d28-b13e-e13198ea38d8";
const RUN_ID = process.env.CLAIM_EVIDENCE_10_RUN_ID?.trim() || "20260522T220000Z";

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

function resolveSupabaseCredentials(): { url: string; key: string } | null {
  loadEnvFile(path.join(process.cwd(), ".env.local"));
  loadEnvFile(path.join(process.cwd(), ".env"));
  const url =
    process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ||
    process.env.STAGING_SUPABASE_URL?.trim() ||
    "";
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ||
    process.env.STAGING_SUPABASE_SERVICE_ROLE_KEY?.trim() ||
    "";
  if (!url || !key) return null;
  return { url, key };
}

function verifyUiMarkers(): Record<string, boolean> {
  const panel = fs.readFileSync(
    path.join(process.cwd(), "components", "claims", "ClaimFilingPacketValidationPanel.tsx"),
    "utf8",
  );
  const client = fs.readFileSync(
    path.join(process.cwd(), "app", "claim-engine", "evidence", "ClaimDraftEvidenceClient.tsx"),
    "utf8",
  );
  return {
    validation_panel_matrix: panel.includes("Filing-readiness matrix"),
    validation_panel_blockers: panel.includes("Blocker inventory"),
    validation_no_submit: panel.includes("does not file claims"),
    client_wires_validation: client.includes("ClaimFilingPacketValidationPanel"),
    api_route_exists: fs.existsSync(
      path.join(
        process.cwd(),
        "app",
        "api",
        "claims",
        "drafts",
        "[draftId]",
        "filing-packet-validation",
        "route.ts",
      ),
    ),
  };
}

async function main(): Promise<void> {
  const outDir = path.resolve(process.cwd(), ".cursor/audit-reports/claim-evidence-10", RUN_ID);
  fs.mkdirSync(outDir, { recursive: true });

  const uiMarkers = verifyUiMarkers();
  const creds = resolveSupabaseCredentials();

  if (!creds) {
    const staticOnly = {
      prompt_name: "CLAIM-EVIDENCE-10",
      run_id: RUN_ID,
      mode: "static_only",
      ui_markers: uiMarkers,
      ui_markers_all_true: Object.values(uiMarkers).every(Boolean),
    };
    fs.writeFileSync(path.join(outDir, "api-verification.json"), JSON.stringify(staticOnly, null, 2));
    fs.writeFileSync(
      path.join(outDir, "summary.md"),
      "# CLAIM-EVIDENCE-10 (static)\n\nSet SUPABASE_SERVICE_ROLE_KEY and re-run for live validation.\n",
      "utf8",
    );
    console.log(JSON.stringify(staticOnly, null, 2));
    process.exitCode = Object.values(uiMarkers).every(Boolean) ? 0 : 1;
    return;
  }

  const client = createClient(creds.url, creds.key, { auth: { persistSession: false } });
  const draft = await fetchDraftRow(client, ORG_ID, DRAFT_ID);
  if (!draft) throw new Error("Draft not found.");

  const validation = await buildClaimFilingPacketValidation(client, draft);

  const categories = new Set(validation.matrix.map((m) => m.category));
  const requiredCategories = [
    "lineage",
    "trid",
    "warnings",
    "grouping",
    "attachments",
    "operator_review",
    "filing_gate",
  ] as const;

  const checks = {
    matrix_row_count: validation.matrix.length,
    all_categories_present: requiredCategories.every((c) =>
      (categories as Set<string>).has(c),
    ),
    blocker_inventory_is_array: Array.isArray(validation.blocker_inventory),
    baseline_not_future_ready: validation.ready_for_future_submission_layer === false,
    persisted_51_in_packet:
      validation.matrix.find((c) => c.id === "evidence_group_count_match")?.message.includes("51") ??
      false,
    ui_markers_all_true: Object.values(uiMarkers).every(Boolean),
    does_not_submit: validation.does_not_submit === true,
  };

  const allPass =
    checks.all_categories_present &&
    checks.matrix_row_count >= 14 &&
    checks.ui_markers_all_true &&
    checks.does_not_submit;

  fs.writeFileSync(path.join(outDir, "filing-readiness-matrix.json"), JSON.stringify(validation.matrix, null, 2));
  fs.writeFileSync(
    path.join(outDir, "blocker-inventory.json"),
    JSON.stringify(validation.blocker_inventory, null, 2),
  );
  fs.writeFileSync(path.join(outDir, "validation-full.json"), JSON.stringify(validation, null, 2));
  fs.writeFileSync(
    path.join(outDir, "api-verification.json"),
    JSON.stringify(
      {
        prompt_name: "CLAIM-EVIDENCE-10",
        run_id: RUN_ID,
        checks,
        all_pass: allPass,
        overall_valid: validation.overall_valid,
        ready_for_future_submission_layer: validation.ready_for_future_submission_layer,
      },
      null,
      2,
    ),
  );
  fs.writeFileSync(
    path.join(outDir, "summary.md"),
    [
      "# CLAIM-EVIDENCE-10",
      "",
      `- run_id: \`${RUN_ID}\``,
      `- all_pass: **${allPass}**`,
      `- overall_valid: ${validation.overall_valid}`,
      `- future submission layer ready: ${validation.ready_for_future_submission_layer}`,
      `- matrix checks: ${validation.matrix.length}`,
      `- blockers: ${validation.blocker_inventory.filter((b) => b.severity === "blocker").length}`,
      `- warnings: ${validation.blocker_inventory.filter((b) => b.severity === "warn").length}`,
      "",
      "No claim submission.",
    ].join("\n"),
    "utf8",
  );
  fs.writeFileSync(
    path.join(outDir, "constraints.md"),
    "# Constraints\n\nNo claim submission, Amazon API, AI, production, or product/scanner mutation.\n",
    "utf8",
  );

  console.log(JSON.stringify({ checks, all_pass: allPass, blocker_count: validation.blocker_inventory.length }, null, 2));
  process.exitCode = allPass ? 0 : 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
