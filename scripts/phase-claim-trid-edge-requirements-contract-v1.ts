/**
 * PHASE-CLAIM-TRID-EDGE-REQUIREMENTS-CONTRACT-V1 — read-only export (no DB)
 *   npx tsx scripts/phase-claim-trid-edge-requirements-contract-v1.ts --run-id=<UTC>
 */
import * as fs from "node:fs";
import * as path from "node:path";

import {
  buildTridEdgeRequirementsContractPayload,
  FAMILY_EDGE_REQUIREMENTS,
  TRID_EDGE_KIND_CATALOG,
} from "../lib/claims/contracts/trid-edge-requirements-contract-v1";

const OUT = ".cursor/audit-reports/phase-claim-trid-edge-requirements-contract-v1";

function runId(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function main(): void {
  const id = runId();
  const outDir = path.join(process.cwd(), OUT, id);
  fs.mkdirSync(outDir, { recursive: true });

  const payload = buildTridEdgeRequirementsContractPayload();

  const claimReadyEdgeCounts = FAMILY_EDGE_REQUIREMENTS.map((f) => ({
    family_key: f.family_key,
    claim_ready_edges: f.edges.filter((e) => e.required_for_claim_ready).length,
    money_edges: f.edges.filter((e) => e.required_for_money).length,
    story_edges: f.edges.filter((e) => e.required_for_product_story).length,
  }));

  const results = {
    ...payload,
    edge_kind_catalog: TRID_EDGE_KIND_CATALOG,
    per_family_edge_counts: claimReadyEdgeCounts,
    checks: {
      family_count_is_41: payload.family_count === 41,
      edge_kind_count: TRID_EDGE_KIND_CATALOG.length,
      all_families_have_product_link_rule:
        FAMILY_EDGE_REQUIREMENTS.filter((f) =>
          f.edges.some((e) => e.edge_kind_id === "product_link"),
        ).length,
      review_signal_families: FAMILY_EDGE_REQUIREMENTS.filter(
        (f) => f.classification === "review_signal_only",
      ).map((f) => f.family_key),
    },
  };

  fs.writeFileSync(path.join(outDir, "results.json"), JSON.stringify(results, null, 2));

  const summary = [
    "# PHASE-CLAIM-TRID-EDGE-REQUIREMENTS-CONTRACT-V1",
    "",
    `**Run:** ${id}`,
    `**Mode:** read-only contract — no DB writes`,
    "",
    "## Summary",
    "",
    `- **Families:** ${payload.family_count}`,
    `- **Edge kinds (catalog):** ${payload.edge_kind_count}`,
    `- **SAFE_TO_IMPLEMENT_TRID_EDGE_READMODEL:** ${payload.SAFE_TO_IMPLEMENT_TRID_EDGE_READMODEL}`,
    "",
    "## Global rules (locked)",
    "",
    "### Product Story",
    ...payload.Product_Story_lineage_rules.map((r) => `- ${r}`),
    "",
    "### Claim-ready",
    ...payload.claim_ready_lineage_rules.map((r) => `- ${r}`),
    "",
    "### Money",
    ...payload.money_lineage_rules.map((r) => `- ${r}`),
    "",
    "## Duplicate prevention",
    "",
    `- Index: \`${payload.duplicate_prevention_keys.natural_key_index}\``,
    `- Fields: ${payload.duplicate_prevention_keys.key_fields.join(", ")}`,
    "",
    "## Implementation priority",
    "",
    `- P0: ${payload.implementation_priority.P0_physical_and_core.join(", ")}`,
    `- P1: ${payload.implementation_priority.P1_financial_and_fees.join(", ")}`,
    `- P2: ${payload.implementation_priority.P2_signals_and_gaps.join(", ")}`,
  ].join("\n");

  fs.writeFileSync(path.join(outDir, "summary.md"), summary);

  console.log(JSON.stringify({ ok: true, run_id: id, out_dir: outDir, family_count: payload.family_count }));
}

main();
