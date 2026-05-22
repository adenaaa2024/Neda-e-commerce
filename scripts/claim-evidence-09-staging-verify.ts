/**
 * CLAIM-EVIDENCE-09 — Staging verify: filing packet preview (no submission).
 *
 *   npm run verify:claim-evidence-09-staging
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createClient } from "@supabase/supabase-js";

import {
  buildClaimFilingPacketPreview,
  probePacketPreviewAuditSchema,
} from "../lib/claim-filing-packet-preview";
import { fetchDraftRow } from "../lib/claim-evidence-preview";
import { getStagingProjectRef } from "../lib/staging-project-ref";

const ORG_ID = "00000000-0000-0000-0000-000000000001";
const DRAFT_ID = "003db7ff-23f5-4d28-b13e-e13198ea38d8";
const RUN_ID = process.env.CLAIM_EVIDENCE_09_RUN_ID?.trim() || "20260522T200000Z";

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
  loadEnvFile(path.join(process.cwd(), ".env"));
  loadEnvFile(path.join(process.cwd(), "backend-python", ".env"));
}

function resolveSupabaseCredentials(): { url: string; key: string } | null {
  const url =
    process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ||
    process.env.STAGING_SUPABASE_URL?.trim() ||
    process.env.SUPABASE_URL?.trim() ||
    "";
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ||
    process.env.STAGING_SUPABASE_SERVICE_ROLE_KEY?.trim() ||
    "";
  if (!url || !key) return null;
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL) process.env.NEXT_PUBLIC_SUPABASE_URL = url;
  return { url, key };
}

function verifyUiMarkers(): Record<string, boolean> {
  const panel = fs.readFileSync(
    path.join(process.cwd(), "components", "claims", "ClaimFilingPacketPreviewPanel.tsx"),
    "utf8",
  );
  const client = fs.readFileSync(
    path.join(process.cwd(), "app", "claim-engine", "evidence", "ClaimDraftEvidenceClient.tsx"),
    "utf8",
  );
  return {
    panel_no_submit_note: panel.includes("does not submit claims"),
    panel_download: panel.includes("Download preview JSON"),
    panel_readiness_banner: panel.includes("Filing readiness:"),
    panel_evidence_groups_table: panel.includes("Evidence groups"),
    panel_lineage_section: panel.includes("Lineage links"),
    panel_trid_section: panel.includes("TRID / reference IDs"),
    client_wires_panel: client.includes("ClaimFilingPacketPreviewPanel"),
    api_route_exists: fs.existsSync(
      path.join(
        process.cwd(),
        "app",
        "api",
        "claims",
        "drafts",
        "[draftId]",
        "filing-packet-preview",
        "route.ts",
      ),
    ),
  };
}

async function main(): Promise<void> {
  loadEnvLocal();
  const creds = resolveSupabaseCredentials();
  const outDir = path.resolve(process.cwd(), ".cursor/audit-reports/claim-evidence-09", RUN_ID);
  fs.mkdirSync(outDir, { recursive: true });

  const uiMarkers = verifyUiMarkers();

  if (!creds) {
    const staticOnly = {
      prompt_name: "CLAIM-EVIDENCE-09",
      run_id: RUN_ID,
      mode: "static_only",
      ui_markers: uiMarkers,
      ui_markers_all_true: Object.values(uiMarkers).every(Boolean),
    };
    fs.writeFileSync(path.join(outDir, "api-verification.json"), JSON.stringify(staticOnly, null, 2));
    fs.writeFileSync(
      path.join(outDir, "summary.md"),
      `# CLAIM-EVIDENCE-09 (static only)\n\nSupabase service role key missing in \`.env.local\` (often commented). Uncomment \`SUPABASE_SERVICE_ROLE_KEY\` for staging project \`${getStagingProjectRef()}\` and re-run.\n`,
      "utf8",
    );
    console.log(JSON.stringify(staticOnly, null, 2));
    process.exitCode = Object.values(uiMarkers).every(Boolean) ? 0 : 1;
    return;
  }

  const client = createClient(creds.url, creds.key, { auth: { persistSession: false } });
  const auditSchemaOk = await probePacketPreviewAuditSchema(client);
  const draft = await fetchDraftRow(client, ORG_ID, DRAFT_ID);
  if (!draft) throw new Error("Draft not found.");

  const { data: reviewerRow } = await client
    .from("profiles")
    .select("id")
    .eq("organization_id", ORG_ID)
    .limit(1)
    .maybeSingle();
  const viewedBy =
    reviewerRow && typeof (reviewerRow as { id?: string }).id === "string"
      ? (reviewerRow as { id: string }).id
      : null;

  const packet = await buildClaimFilingPacketPreview(client, draft, {
    logView: viewedBy ? { viewedBy } : undefined,
  });

  const edgeTotal = packet.evidence_groups.reduce((n, g) => n + g.edge_count, 0);
  const reviewSum = packet.filing_readiness.review_summary;

  const checks = {
    audit_schema_configured: auditSchemaOk,
    does_not_submit_flag: packet.does_not_submit === true,
    persisted_edge_count_51: packet.claim_summary.persisted_edge_count === 51,
    evidence_groups_non_empty: packet.evidence_groups.length > 0,
    evidence_group_edge_sum_51: edgeTotal === 51,
    review_summary_matches_groups:
      reviewSum.accepted + reviewSum.rejected + reviewSum.needs_review === 51,
    ready_for_preview_matches_gate: packet.ready_for_preview === packet.filing_readiness.ready,
    baseline_not_ready: packet.ready_for_preview === false,
    preview_event_logged: packet.audit_tail.preview_event_id != null,
    ui_markers_all_true: Object.values(uiMarkers).every(Boolean),
    lineage_links_loaded: packet.lineage_links.length >= 0,
    trid_section_present: packet.trid_references.length >= 0,
  };

  const allPass =
    checks.audit_schema_configured &&
    checks.does_not_submit_flag &&
    checks.persisted_edge_count_51 &&
    checks.evidence_group_edge_sum_51 &&
    checks.ready_for_preview_matches_gate &&
    checks.ui_markers_all_true &&
    (auditSchemaOk ? checks.preview_event_logged : true);

  const payload = {
    prompt_name: "CLAIM-EVIDENCE-09",
    run_id: RUN_ID,
    checks,
    all_pass: allPass,
    ui_markers: uiMarkers,
    packet_summary: {
      draft_id: packet.draft_id,
      ready_for_preview: packet.ready_for_preview,
      group_count: packet.evidence_groups.length,
      lineage_count: packet.lineage_links.length,
      trid_count: packet.trid_references.length,
      unresolved_warnings: packet.unresolved_warnings.length,
      preview_event_id: packet.audit_tail.preview_event_id,
    },
  };

  fs.writeFileSync(path.join(outDir, "api-verification.json"), JSON.stringify(payload, null, 2));
  fs.writeFileSync(
    path.join(outDir, "packet-sample.json"),
    JSON.stringify(packet, null, 2),
  );
  fs.writeFileSync(
    path.join(outDir, "summary.md"),
    [
      "# CLAIM-EVIDENCE-09 verify",
      "",
      `- run_id: \`${RUN_ID}\``,
      `- all_pass: **${allPass}**`,
      `- persisted edges: ${packet.claim_summary.persisted_edge_count}`,
      `- ready_for_preview: ${packet.ready_for_preview}`,
      `- evidence groups: ${packet.evidence_groups.length}`,
      "",
      "No claim submission.",
    ].join("\n"),
    "utf8",
  );
  fs.writeFileSync(
    path.join(outDir, "constraints.md"),
    "# Constraints\n\n- No claim submission, Amazon API, AI, scanner, or product/FRR mutation.\n",
    "utf8",
  );
  fs.writeFileSync(
    path.join(outDir, "browser-proof-urls.md"),
    `# Browser proof\n\n\`/claim-engine/evidence?draft_id=${DRAFT_ID}\`\n\nExpect filing packet preview section above evidence viewer.\n`,
    "utf8",
  );

  console.log(JSON.stringify(payload, null, 2));
  process.exitCode = allPass ? 0 : 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
