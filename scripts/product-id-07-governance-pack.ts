/**
 * NEXT-PRODUCT-ID-07 — Authority governance decision matrix (read-only artifacts).
 *
 *   npx tsx scripts/product-id-07-governance-pack.ts \
 *     --id06-dir=.cursor/audit-reports/next-product-id-06/20260513T200105Z \
 *     --id05-dir=.cursor/audit-reports/next-product-id-05/20260513T194738Z
 */

import * as fs from "node:fs";
import * as path from "node:path";
import csv from "csv-parser";
import { mkRunDir, mkRunId, writeCsv } from "../lib/audits/product-seed-output";

type AmbRow = Record<string, string>;
type CrossRow = Record<string, string>;
type SafeRow = Record<string, unknown>;

async function readCsv(filePath: string): Promise<Record<string, string>[]> {
  return new Promise((resolve, reject) => {
    const rows: Record<string, string>[] = [];
    fs.createReadStream(filePath, "utf8")
      .pipe(csv())
      .on("data", (r: Record<string, string>) => rows.push(r))
      .on("end", () => resolve(rows))
      .on("error", reject);
  });
}

function parseJsonArray(s: string): string[] {
  try {
    const a = JSON.parse(s) as unknown;
    return Array.isArray(a) ? a.map((x) => String(x)) : [];
  } catch {
    return [];
  }
}

function decideForAmbiguous(r: AmbRow, crossByAsin: Map<string, CrossRow>): Record<string, string> {
  const primary = r.primary_reason ?? "";
  const sec = (r.secondary_reasons_json ?? "").toLowerCase();
  const pids = parseJsonArray(r.conflict_product_ids_json ?? "[]");
  const asin = (r.asin ?? "").trim();
  const cross = asin ? crossByAsin.get(asin) : undefined;
  const winnerNote = cross?.possible_authority_winner_note ?? "";
  const threeWay = pids.length >= 3;

  let suggested = "manual_review";
  let tier: "T0" | "T1" | "T2" | "T3" = "T2";
  let reason = "";
  let human = "yes";

  if (primary === "f3_shape_invalid_alongside_valid") {
    suggested = "quarantine";
    tier = "T0";
    reason = "Invalid FNSKU/SKU shape vs ASIN; fix inbound listing/file before any identity write.";
    human = "yes";
  } else if (primary === "f2_cross_product_conflict") {
    suggested = "map_cleanup_required";
    tier = "T3";
    reason = "Multiple product_id for same identifier evidence path; clean map or merge with reversibility plan.";
    if (sec.includes("f1_identifier_fan_out")) {
      tier = "T3";
      reason += " ASIN fan-out flagged as secondary signal.";
    }
    if (threeWay) {
      suggested = "manual_review";
      tier = "T3";
      reason = "Three+ product_ids for one operational row; ASIN-only insufficient — pack/size/condition review.";
    } else if (winnerNote.startsWith("prefer_product_id_if_sku_match=")) {
      suggested = "link_existing";
      tier = "T2";
      reason = `Heuristic SKU match suggests winner ${winnerNote.replace("prefer_product_id_if_sku_match=", "")}; operator must confirm before link.`;
    } else if (winnerNote === "not_obvious") {
      suggested = "merge_candidate_later";
      tier = "T3";
      reason = "No clear SKU-aligned winner in enrichment pack; do not auto-link.";
    }
  }

  return { suggested_decision: suggested, confidence_tier: tier, reason, required_human_signoff: human };
}

async function main(): Promise<void> {
  const id06 =
    process.argv.find((a) => a.startsWith("--id06-dir="))?.split("=")[1]?.trim() ??
    path.join(".cursor", "audit-reports", "next-product-id-06", "20260513T200105Z");
  const id05 =
    process.argv.find((a) => a.startsWith("--id05-dir="))?.split("=")[1]?.trim() ??
    path.join(".cursor", "audit-reports", "next-product-id-05", "20260513T194738Z");

  const ambPath = path.join(id06, "ambiguous-review-pack.csv");
  const crossPath = path.join(id06, "cross-product-conflict-review-pack.csv");
  const safeNd = path.join(id05, "safe-new-candidates.ndjson");

  const amb = (await readCsv(ambPath)) as AmbRow[];
  const cross = (await readCsv(crossPath)) as CrossRow[];
  const crossByAsin = new Map<string, CrossRow>();
  for (const c of cross) {
    if (c.identifier_type === "asin" && c.identifier_value) crossByAsin.set(c.identifier_value.trim(), c);
  }

  const matrixHeaders = [
    "matrix_row_kind",
    "row_or_group_id",
    "source_row_id",
    "organization_id",
    "store_id",
    "sku",
    "asin",
    "fnsku",
    "product_name",
    "candidate_product_ids",
    "conflict_driver",
    "suggested_decision",
    "confidence_tier",
    "reason",
    "required_human_signoff",
  ] as const;

  const matrixRows: Record<string, unknown>[] = [];

  for (const r of amb) {
    const d = decideForAmbiguous(r, crossByAsin);
    const driver =
      r.primary_reason === "f2_cross_product_conflict"
        ? `cross_product:${r.asin || "?"}`
        : `shape_invalid:${r.seller_sku || "?"}`;
    matrixRows.push({
      matrix_row_kind: "inventory_ambiguous_row",
      row_or_group_id: r.source_row_id,
      source_row_id: r.source_row_id,
      organization_id: r.organization_id,
      store_id: r.store_id,
      sku: r.seller_sku,
      asin: r.asin,
      fnsku: r.fnsku,
      product_name: r.product_name,
      candidate_product_ids: r.conflict_product_ids_json,
      conflict_driver: driver,
      suggested_decision: d.suggested_decision,
      confidence_tier: d.confidence_tier,
      reason: d.reason,
      required_human_signoff: d.required_human_signoff,
    });
  }

  for (const c of cross) {
    matrixRows.push({
      matrix_row_kind: "asin_driver_group",
      row_or_group_id: `asin:${c.identifier_value}`,
      source_row_id: c.source_row_ids_affected ?? "",
      organization_id: amb[0]?.organization_id ?? "",
      store_id: amb[0]?.store_id ?? "",
      sku: "",
      asin: c.identifier_value,
      fnsku: "",
      product_name: "",
      candidate_product_ids: c.product_ids_json,
      conflict_driver: `asin_fanout_pair:${c.identifier_value}`,
      suggested_decision:
        c.possible_authority_winner_note?.startsWith("prefer_product_id_if_sku_match=") ? "link_existing" : "map_cleanup_required",
      confidence_tier: c.possible_authority_winner_note === "not_obvious" ? "T3" : "T2",
      reason: `Driver group; affected_rows=${c.affected_row_count}; winner_hint=${c.possible_authority_winner_note}`,
      required_human_signoff: "yes",
    });
  }

  const runId = mkRunId();
  const outDir = mkRunDir(path.join(".cursor", "audit-reports", "next-product-id-07"), runId);
  writeCsv(path.join(outDir, "conflict-decision-matrix.csv"), matrixHeaders, matrixRows);

  const safeText = fs.readFileSync(safeNd, "utf8").trim();
  const safeLines = safeText ? safeText.split(/\n/) : [];
  const safeHeaders = [
    "source_row_id",
    "organization_id",
    "store_id",
    "sku",
    "asin",
    "fnsku",
    "completeness_profile",
    "fan_out_key_overlap_this_slice",
    "approval_band",
    "confidence_tier_after_signoff",
    "no_writes_until_governance_signoff",
    "notes",
  ] as const;
  const safeRows: Record<string, unknown>[] = [];
  for (const line of safeLines) {
    const o = JSON.parse(line) as SafeRow;
    const ids = (o.identifiers as Record<string, string>) ?? {};
    safeRows.push({
      source_row_id: String(o.source_row_id ?? ""),
      organization_id: String(o.organization_id ?? ""),
      store_id: String(o.store_id ?? ""),
      sku: ids.seller_sku ?? "",
      asin: ids.asin ?? "",
      fnsku: ids.fnsku ?? "",
      completeness_profile: "sku+asin+fnsku+title",
      fan_out_key_overlap_this_slice: "false",
      approval_band: "post_signoff_auto_create_eligible_subject_to_map_policy",
      confidence_tier_after_signoff: "T1_candidate_only_after_org_map_review",
      no_writes_until_governance_signoff: "TRUE",
      notes: "Do not INSERT products or backfill resolver until authority matrix signed off; org still has 2485 unrelated fan-out rows.",
    });
  }
  writeCsv(path.join(outDir, "safe-new-approval-matrix.csv"), safeHeaders, safeRows);

  let invT0 = 0,
    invT2 = 0,
    invT3 = 0,
    invManualSuggest = 0;
  for (const r of amb) {
    const d = decideForAmbiguous(r, crossByAsin);
    if (d.confidence_tier === "T0") invT0++;
    if (d.confidence_tier === "T2") invT2++;
    if (d.confidence_tier === "T3") invT3++;
    if (
      d.suggested_decision === "manual_review" ||
      d.suggested_decision === "merge_candidate_later" ||
      d.suggested_decision === "map_cleanup_required" ||
      d.suggested_decision === "quarantine"
    )
      invManualSuggest++;
  }
  const linkExistingInv = amb.filter((r) => decideForAmbiguous(r, crossByAsin).suggested_decision === "link_existing").length;
  let invMapCleanup = 0,
    invMergeLater = 0,
    invManualReview = 0,
    invQuarantine = 0;
  for (const r of amb) {
    const d = decideForAmbiguous(r, crossByAsin);
    if (d.suggested_decision === "map_cleanup_required") invMapCleanup++;
    if (d.suggested_decision === "merge_candidate_later") invMergeLater++;
    if (d.suggested_decision === "manual_review") invManualReview++;
    if (d.suggested_decision === "quarantine") invQuarantine++;
  }

  const logPath = path.join(outDir, "logs", "product-id-07.ndjson");
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.writeFileSync(
    logPath,
    [
      JSON.stringify({ ts: new Date().toISOString(), event: "pack_complete", runId, id06, id05 }),
      JSON.stringify({
        matrix_inventory_rows: amb.length,
        matrix_driver_group_rows: cross.length,
        matrix_total_rows: matrixRows.length,
        safe_new_rows: safeRows.length,
        inventory_row_tiers: { T0: invT0, T2: invT2, T3: invT3 },
        inventory_suggested_not_auto_link: invManualSuggest,
        inventory_suggested_link_existing_after_confirm: linkExistingInv,
      }),
    ].join("\n") + "\n",
    "utf8",
  );

  const manifest = {
    auditPrompt: "NEXT-PRODUCT-ID-07",
    runId,
    inputs: { id06_dir: id06, id05_dir: id05 },
    counts: {
      conflict_decision_matrix_rows: matrixRows.length,
      asin_driver_groups: cross.length,
      safe_new_approval_rows: safeRows.length,
      ambiguous_source_rows: amb.length,
    },
    tier_counts_on_inventory_rows_only: {
      note: "42 inventory_ambiguous_row lines",
      T0: invT0,
      T2: invT2,
      T3: invT3,
      suggested_link_existing: linkExistingInv,
      suggested_manual_or_cleanup: invManualSuggest,
      suggested_decision_breakdown: {
        map_cleanup_required: invMapCleanup,
        merge_candidate_later: invMergeLater,
        manual_review: invManualReview,
        quarantine: invQuarantine,
        link_existing: linkExistingInv,
      },
    },
  };
  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");

  const asinDriverMd = [
    `# ASIN driver groups — governance review (NEXT-PRODUCT-ID-07)`,
    ``,
    `Source: NEXT-PRODUCT-ID-06 \`cross-product-conflict-review-pack.csv\` — **${cross.length}** ASIN driver groups (same org/store slice).`,
    ``,
    `| ASIN | Affected FBA source_row_id(s) | product_ids (fan-out pair) | Winner hint (SKU match) | ASIN alone sufficient? | Recommended handling |`,
    `|------|------------------------------|----------------------------|-------------------------|--------------------------|------------------------|`,
    ...cross.map((c) => {
      const suff = c.possible_authority_winner_note === "not_obvious" ? "No" : "Partial — confirm with FNSKU/pack";
      const handle =
        c.possible_authority_winner_note?.startsWith("prefer_product_id_if_sku_match=")
          ? "Operator confirm → optional link_existing to hinted product_id after map review"
          : "manual_review + map_cleanup_required; merge_candidate_later only with hot-loser check (NEXT-18M)";
      return `| ${c.identifier_value} | ${(c.source_row_ids_affected ?? "").replace(/\|/g, " ")} | ${c.product_ids_json} | ${c.possible_authority_winner_note} | ${suff} | ${handle} |`;
    }),
    ``,
    `## Notes`,
    ``,
    `- **Same org/store:** all rows marked \`false_single_org_slice\` / \`false_single_store_slice\` in ID-06 pack.`,
    `- **Three-product row** (tennis balls) is not split into a separate ASIN group row when fan-out index only lists two IDs; still covered in **inventory** matrix rows.`,
    ``,
  ].join("\n");
  fs.writeFileSync(path.join(outDir, "asin-driver-groups-review.md"), asinDriverMd, "utf8");

  const govSummary = [
    `# Authority governance summary (NEXT-PRODUCT-ID-07)`,
    ``,
    `## Inputs`,
    ``,
    `- NEXT-PRODUCT-ID-06: \`${id06.replace(/\\/g, "/")}\``,
    `- NEXT-PRODUCT-ID-05 (safe-new NDJSON): \`${id05.replace(/\\/g, "/")}\``,
    ``,
    `## Deliverables`,
    ``,
    `- \`conflict-decision-matrix.csv\` — **${matrixRows.length}** rows (**${amb.length}** inventory ambiguous + **${cross.length}** ASIN driver groups).`,
    `- \`safe-new-approval-matrix.csv\` — **${safeRows.length}** rows.`,
    `- Tier governance drafts: \`proposed-tier-rules.md\`, \`backfill-blockers.md\`, \`signoff-checklist.md\`.`,
    ``,
    `## Inventory-row tier counts (42 ambiguous FBA rows)`,
    ``,
    `| Tier | Count |`,
    `|------|------:|`,
    `| T0 | ${invT0} |`,
    `| T2 | ${invT2} |`,
    `| T3 | ${invT3} |`,
    ``,
    `| Suggested decision (heuristic) | Count |`,
    `|-------------------------------|------:|`,
    `| link_existing (after operator confirm) | ${linkExistingInv} |`,
    `| map_cleanup_required | ${invMapCleanup} |`,
    `| merge_candidate_later | ${invMergeLater} |`,
    `| manual_review (three-way / ASIN-only) | ${invManualReview} |`,
    `| quarantine (shape invalid) | ${invQuarantine} |`,
    `| **Subtotal needing non-auto path** | ${invManualSuggest} |`,
    ``,
    `**No database writes** in this pack.`,
    ``,
  ].join("\n");
  fs.writeFileSync(path.join(outDir, "authority-governance-summary.md"), govSummary, "utf8");

  const backfillMd = [
    `# Backfill blockers — \`resolved_product_id\` / \`product_id\` (NEXT-PRODUCT-ID-07)`,
    ``,
    `Until governance sign-off, **block**:`,
    ``,
    `1. **Bulk backfill** of \`amazon_fba_inventory.resolved_product_id\` while **${invT3 + invT2}** ambiguous rows remain in **T2/T3** (and **${invT0}** **T0** hard-stop shape rows).`,
    `2. **Auto map writes** on \`product_identifier_map\` for ASINs in the **${cross.length}** driver groups without operator-chosen canonical \`product_id\`.`,
    `3. **Product merges** driven only by ASIN overlap — hot-loser / NEXT-18M merge risk still applies.`,
    `4. **Safe-new → product INSERT** for **${safeRows.length}** SKUs — blocked until signoff checklist complete (even though fan-out key overlap is **0** in this slice).`,
    ``,
    `**Not a blocker for read-only audits** — dry-runs and UI read paths remain allowed.`,
    ``,
  ].join("\n");
  fs.writeFileSync(path.join(outDir, "backfill-blockers.md"), backfillMd, "utf8");

  const tierRules = [
    `# Proposed tier rules — resolver governance (NEXT-PRODUCT-ID-07)`,
    ``,
    `## T0 — hard stop`,
    ``,
    `- Cross-org identifier use on a tenant row (not seen in this slice; policy placeholder).`,
    `- Missing \`organization_id\` / \`store_id\` where required for SKU-scoped joins.`,
    `- **Invalid identifier shapes** with conflicting “valid” signals — \`f3_shape_invalid_alongside_valid\` (**${invT0}** rows here).`,
    `- Conflicting \`product_id\` sets with **no** approved merge plan.`,
    `- Broken operational / upload lineage for identity (separate claim-style audits).`,
    ``,
    `## T1 — auto-link (post-policy + post-signoff only)`,
    ``,
    `- Unanimous \`product_identifier_map\` match on **(org, store, seller_sku)** with **no** fan-out on used keys.`,
    `- Candidate already carries consistent \`resolved_product_id\` matching map (not applicable to ambiguous slice).`,
    ``,
    `## T2 — human review`,
    ``,
    `- **ASIN-only** or **UPC-only** disambiguation when multiple internal products share catalog id.`,
    `- **Heuristic SKU winner** (\`prefer_product_id_if_sku_match=\`) — **${linkExistingInv}** inventory rows flagged; operator must confirm.`,
    `- **Safe-new** before any auto-create (**${safeRows.length}** rows) — governance signoff + org-wide map health.`,
    `- **Title disagreement** between operational title and catalog product name — never sole authority.`,
    ``,
    `## T3 — quarantine / map cleanup`,
    ``,
    `- **Fan-out unresolved** on chosen key (org-wide **2485** findings; operational slice uses index-aware fan-out).`,
    `- **Cross-product conflict** / ambiguous map match (**${invT3}** inventory rows at T3 in this heuristic).`,
    `- **Hot-loser / merge danger** — consult NEXT-18M-style protections before destructive merges.`,
    ``,
  ].join("\n");
  fs.writeFileSync(path.join(outDir, "proposed-tier-rules.md"), tierRules, "utf8");

  const checklist = [
    `# Governance signoff checklist (NEXT-PRODUCT-ID-07)`,
    ``,
    `Before **product_identifier_map cleanup**, **product creation**, **resolved_product_id backfill**, **product merge**, or **resolver auto-write ingestion**:`,
    ``,
    `- [ ] **Owner assigned** for canonical product choice per **${cross.length}** ASIN driver groups (and any non-ASIN conflicts outside this CSV).`,
    `- [ ] **Review** \`conflict-decision-matrix.csv\` inventory rows (**${amb.length}**) — especially **T0** (**${invT0}**) and three-product conflicts.`,
    `- [ ] **Hot-loser / merge** consult: cross-check NEXT-18M (or successor) for merge losers when choosing “merge later”.`,
    `- [ ] **Safe-new** (**${safeRows.length}**): confirm org policy for auto-create vs always-manual; acknowledge **0** fan-out overlap for these keys in this audit slice only.`,
    `- [ ] **Evidence** that operational titles / packs align with chosen \`product_id\` where ASIN is shared.`,
    `- [ ] **Rollback plan** for map deletes/redirects (snapshot or staged migration).`,
    ``,
    `**Until all applicable boxes are checked:** no writes listed above.`,
    ``,
  ].join("\n");
  fs.writeFileSync(path.join(outDir, "signoff-checklist.md"), checklist, "utf8");

  const nextStep = [
    `# Next step recommendation (NEXT-PRODUCT-ID-07)`,
    ``,
    `1. **Manual operator review / signoff** using \`conflict-decision-matrix.csv\` + \`asin-driver-groups-review.md\`.`,
    `2. **Resolver confidence policy** — encode \`proposed-tier-rules.md\` into resolver status / enums in a future code change (separate ticket; not in this read-only pack).`,
    `3. **Safe-new** — optional **dry-run product creation** script (read-only simulation) only after checklist progress; **no** DB INSERT until explicit approval.`,
    `4. **Backfill plan** — document only after signoff; execution remains **out of scope** for Phase B until governance locks.`,
    ``,
    `**Recommended immediate action:** signoff meeting + per-ASIN canonical \`product_id\` decisions; **no backfill yet.**`,
    ``,
  ].join("\n");
  fs.writeFileSync(path.join(outDir, "next-step-recommendation.md"), nextStep, "utf8");

  console.log(`[product-id-07] out_dir=${outDir}`);
  console.log(
    `[product-id-07] matrix_rows=${matrixRows.length} safe_new=${safeRows.length} asin_groups=${cross.length}`,
  );
  console.log(`[product-id-07] inventory T0=${invT0} T2=${invT2} T3=${invT3} link_existing_hint=${linkExistingInv}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
