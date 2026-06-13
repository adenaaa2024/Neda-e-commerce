/**
 * PHASE-CLAIM-PHYSICAL-RETURN-TRID-EDGE-RULES-DRYRUN-V1 — staging dry-run only.
 *
 *   npx tsx scripts/phase-claim-physical-return-trid-edge-rules-dryrun-v1.ts [--run-id=UTC]
 *
 * READ-ONLY: SELECT-only session. No edge inserts, no migrations, no DDL,
 * no claim_candidates mutation, no scanner changes, no cases/submissions/PDFs.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";

import { getStagingProjectRef, loadEnvLocalIntoProcess } from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const OUT_BASE = ".cursor/audit-reports/phase-claim-physical-return-trid-edge-rules-dryrun-v1";
const MEMORY_FILE = ".cursor/.ai-memory/CLAIMS_TRID_STATE.md";

type Row = Record<string, unknown>;

type EdgeProposal = {
  rule: string;
  from_candidate_id: string;
  to_entity: string;
  to_table: string | null;
  to_row_id: string | null;
  edge_type: string;
  reference_type: string;
  reference_value: string | null;
  confidence: number;
  source_field: string;
  dedupe_key: string;
  already_materialized: boolean;
  would_insert: "yes" | "no";
  blocker_reason: string | null;
};

function runIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function str(v: unknown): string | null {
  const s = String(v ?? "").trim();
  return s || null;
}

async function connectPg(): Promise<pg.Client> {
  const url = process.env.STAGING_DIRECT_POSTGRES_URL?.trim();
  if (!url) throw new Error("STAGING_DIRECT_POSTGRES_URL unset");
  if (!url.includes(STAGING_REF)) {
    throw new Error(`BLOCKED: STAGING_DIRECT_POSTGRES_URL must target ref ${STAGING_REF}`);
  }
  const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await c.connect();
  await c.query("SET statement_timeout = '300s'");
  await c.query("SET default_transaction_read_only = on");
  return c;
}

function dedupeKey(p: {
  org: string;
  candidate: string;
  edge_type: string;
  to_table: string | null;
  to_row: string | null;
  kind: string;
  value: string | null;
}): string {
  return [p.org, p.candidate, p.edge_type, p.to_table ?? "", p.to_row ?? "", p.kind, p.value ?? ""].join("|");
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const runId = runIdArg();
  const outDir = path.join(OUT_BASE, runId);

  const stagingRef = getStagingProjectRef();
  if (stagingRef !== STAGING_REF) {
    throw new Error(`BLOCKED: expected staging ref ${STAGING_REF}, got ${stagingRef}`);
  }

  const c = await connectPg();

  // ── Physical candidates (trusted physical-return lane) + joined context ──
  const cands = (
    await c.query(`
      SELECT
        cc.id::text, cc.organization_id::text AS org, cc.source_kind, cc.claim_family, cc.claim_reason,
        cc.source_table, cc.source_row_id::text AS source_row_id,
        cc.return_item_id::text AS return_item_id, cc.package_id::text AS package_id,
        cc.shipment_scope_key, cc.resolved_product_id::text AS resolved_product_id,
        cc.sku, cc.fnsku, cc.asin, cc.metadata,
        ri.id::text AS ri_id, ri.order_id AS ri_order_id, ri.package_id::text AS ri_package_id,
        ri.product_identifier AS ri_product_identifier, ri.notes AS ri_notes,
        ri.photo_evidence AS ri_photos,
        p.id::text AS pkg_id, p.package_code, p.tracking_number,
        (SELECT COUNT(*)::int FROM public.claim_evidence ce
          WHERE ce.organization_id = cc.organization_id
            AND (ce.claim_candidate_id = cc.id OR (ce.return_item_id IS NOT NULL AND ce.return_item_id = COALESCE(cc.return_item_id, CASE WHEN cc.source_table = 'return_items' THEN cc.source_row_id END)))
        ) AS claim_evidence_count
      FROM public.claim_candidates cc
      LEFT JOIN public.return_items ri
        ON ri.id = COALESCE(cc.return_item_id, CASE WHEN cc.source_table = 'return_items' THEN cc.source_row_id END)
      LEFT JOIN public.packages p
        ON p.id = COALESCE(cc.package_id, ri.package_id)
      WHERE cc.source_kind <> 'legacy_seed'
        AND (cc.source_kind = 'scanner_physical_review'
             OR (cc.source_kind = 'orbit_fra' AND cc.source_table = 'return_items')
             OR cc.claim_family IN ('physical_return_issue', 'physical_return_off_manifest', 'physical_return_damaged'))
        AND cc.quarantined_at IS NULL AND cc.rejected_at IS NULL
      ORDER BY cc.created_at DESC
      LIMIT 50
    `)
  ).rows as Row[];

  console.log(JSON.stringify({ phase: "candidates_loaded", n: cands.length }));

  // Existing candidate edges for dedupe.
  const existing = new Set<string>();
  if (cands.length) {
    const er = await c.query(
      `SELECT organization_id::text AS org, candidate_id::text AS cand, edge_type,
        COALESCE(to_source_table, '') AS tt, COALESCE(to_source_row_id, '') AS tr,
        COALESCE(reference_kind, '') AS rk, COALESCE(reference_value, '') AS rv
       FROM public.claim_reference_edges
       WHERE candidate_id::text = ANY($1)`,
      [cands.map((x) => String(x.id))],
    );
    for (const e of er.rows as Row[]) {
      existing.add([e.org, e.cand, e.edge_type, e.tt, e.tr, e.rk, e.rv].join("|"));
    }
  }

  // ── Edge rule matrix (6 rules per candidate) ──
  const matrix: EdgeProposal[] = [];
  const propose = (p: Omit<EdgeProposal, "dedupe_key" | "already_materialized" | "would_insert">, org: string) => {
    const key = dedupeKey({
      org,
      candidate: p.from_candidate_id,
      edge_type: p.edge_type,
      to_table: p.to_table,
      to_row: p.to_row_id,
      kind: p.reference_type,
      value: p.reference_value,
    });
    const dup = existing.has(key);
    matrix.push({
      ...p,
      dedupe_key: key,
      already_materialized: dup,
      would_insert: p.blocker_reason == null && !dup ? "yes" : "no",
    });
  };

  let orbitGapCount = 0;

  for (const cc of cands) {
    const org = String(cc.org);
    const id = String(cc.id);
    const riId = str(cc.return_item_id) ?? str(cc.ri_id);
    const riViaSourceRow = !str(cc.return_item_id) && str(cc.ri_id) != null;
    if (cc.source_kind === "orbit_fra" && cc.source_table === "return_items" && !str(cc.return_item_id)) {
      orbitGapCount += 1;
    }

    // 1) candidate -> return_item
    propose(
      {
        rule: "1_return_item",
        from_candidate_id: id,
        to_entity: "return_item",
        to_table: "return_items",
        to_row_id: riId,
        edge_type: "source_evidence",
        reference_type: "return_item_id",
        reference_value: riId,
        confidence: riViaSourceRow ? 0.95 : 1.0,
        source_field: str(cc.return_item_id)
          ? "claim_candidates.return_item_id"
          : riId
            ? "claim_candidates.source_row_id (source_table=return_items fallback)"
            : "none",
        blocker_reason: riId ? null : "no return_item linkage (no return_item_id, source_table not return_items)",
      },
      org,
    );

    // 2) candidate -> package
    const pkgId = str(cc.pkg_id);
    propose(
      {
        rule: "2_package",
        from_candidate_id: id,
        to_entity: "package",
        to_table: "packages",
        to_row_id: pkgId,
        edge_type: "shipment_scope",
        reference_type: "package_code",
        reference_value: str(cc.package_code) ?? pkgId,
        confidence: str(cc.package_id) ? 1.0 : 0.9,
        source_field: str(cc.package_id)
          ? "claim_candidates.package_id"
          : pkgId
            ? "return_items.package_id (join fallback)"
            : "none",
        blocker_reason: pkgId ? null : "no package linkage on candidate or joined return_item",
      },
      org,
    );

    // 3) candidate -> tracking number
    const tracking = str(cc.tracking_number) ?? str(cc.shipment_scope_key);
    propose(
      {
        rule: "3_tracking",
        from_candidate_id: id,
        to_entity: "shipment_tracking",
        to_table: pkgId ? "packages" : null,
        to_row_id: pkgId,
        edge_type: "shipment_scope",
        reference_type: "tracking_number",
        reference_value: tracking,
        confidence: str(cc.tracking_number) ? 1.0 : 0.9,
        source_field: str(cc.tracking_number)
          ? "packages.tracking_number"
          : str(cc.shipment_scope_key)
            ? "claim_candidates.shipment_scope_key"
            : "none",
        blocker_reason: tracking ? null : "no tracking on package and no shipment_scope_key",
      },
      org,
    );

    // 4) candidate -> product identifier
    const productId = str(cc.resolved_product_id);
    const identifier = str(cc.fnsku) ?? str(cc.sku) ?? str(cc.asin) ?? str(cc.ri_product_identifier);
    propose(
      {
        rule: "4_product_identifier",
        from_candidate_id: id,
        to_entity: "product",
        to_table: "products",
        to_row_id: productId,
        edge_type: "product_link",
        reference_type: "product_id",
        reference_value: productId,
        confidence: productId ? 1.0 : 0,
        source_field: productId
          ? "claim_candidates.resolved_product_id"
          : identifier
            ? `identifier only (${identifier})`
            : "none",
        blocker_reason: productId
          ? null
          : identifier
            ? `unresolved product — identifier ${identifier} has no deterministic resolver match (PIM review needed)`
            : "no product identifiers at all",
      },
      org,
    );

    // 5) candidate -> evidence / photo / source note
    const photos = Array.isArray(cc.ri_photos) ? (cc.ri_photos as unknown[]).length : 0;
    const evidenceRows = Number(cc.claim_evidence_count ?? 0);
    const notes = str(cc.ri_notes);
    const hasHardEvidence = photos > 0 || evidenceRows > 0;
    propose(
      {
        rule: "5_evidence",
        from_candidate_id: id,
        to_entity: hasHardEvidence ? "evidence" : notes ? "source_note" : "evidence",
        to_table: evidenceRows > 0 ? "claim_evidence" : photos > 0 ? "return_items" : notes ? "return_items" : null,
        to_row_id: evidenceRows > 0 ? null : riId,
        edge_type: "source_evidence",
        reference_type: hasHardEvidence ? "evidence" : "scan_note",
        reference_value: hasHardEvidence
          ? `${evidenceRows} claim_evidence + ${photos} photos`
          : notes
            ? notes.slice(0, 60)
            : null,
        confidence: hasHardEvidence ? 1.0 : notes ? 0.5 : 0,
        source_field:
          evidenceRows > 0
            ? "claim_evidence rows"
            : photos > 0
              ? "return_items.photo_evidence"
              : notes
                ? "return_items.notes (scan note only)"
                : "none",
        blocker_reason: hasHardEvidence || notes ? null : "no photos, claim_evidence rows, or scan notes",
      },
      org,
    );

    // 6) candidate -> order / shipment
    const orderId = str(cc.ri_order_id);
    propose(
      {
        rule: "6_order_or_shipment",
        from_candidate_id: id,
        to_entity: orderId ? "order" : "shipment",
        to_table: null,
        to_row_id: null,
        edge_type: orderId ? "order_reference" : "shipment_scope",
        reference_type: orderId ? "amazon_order_id" : "tracking_number",
        reference_value: orderId ?? tracking,
        confidence: orderId ? 0.9 : tracking ? 0.8 : 0,
        source_field: orderId ? "return_items.order_id" : tracking ? "package/scope tracking" : "none",
        blocker_reason: orderId || tracking ? null : "no order id and no tracking available",
      },
      org,
    );
  }

  await c.end();

  // ── Aggregates ──
  const wouldInsert = matrix.filter((m) => m.would_insert === "yes");
  const duplicates = matrix.filter((m) => m.already_materialized);
  const blocked = matrix.filter((m) => m.blocker_reason != null);
  const blockedReasons: Record<string, number> = {};
  for (const b of blocked) {
    const k = `${b.rule}: ${b.blocker_reason}`;
    blockedReasons[k] = (blockedReasons[k] ?? 0) + 1;
  }
  const byRule: Record<string, { proposed: number; would_insert: number; blocked: number; duplicate: number }> = {};
  for (const m of matrix) {
    const r = (byRule[m.rule] ??= { proposed: 0, would_insert: 0, blocked: 0, duplicate: 0 });
    r.proposed += 1;
    if (m.would_insert === "yes") r.would_insert += 1;
    if (m.blocker_reason) r.blocked += 1;
    if (m.already_materialized) r.duplicate += 1;
  }

  const orbitGap = {
    affected_candidates: orbitGapCount,
    gap: "orbit_fra return_items-sourced candidates have NULL return_item_id/package_id/pallet_id columns; linkage only recoverable via source_row_id fallback",
    exact_fix_location:
      "lib/claims/intake/claim-orbit-fra-generator.ts — `generate` of the orbit_fra ClaimGeneratorDefinition, the makeDraft({ ... extra_metadata: { orbit_category, ... } }) call (~line 835): for categories with source_table='return_items' add extra_metadata.return_item_id = str(hit.row.id), package_id = str(hit.row.package_id), pallet_id = str(hit.row.pallet_id). draftToInsertRow in lib/claims/intake/claim-generator-registry.ts already maps these metadata keys to the physical columns — no registry change needed.",
    fixed_in_this_phase: "no (not allowed)",
  };

  const payload: Record<string, unknown> = {
    phase: "PHASE-CLAIM-PHYSICAL-RETURN-TRID-EDGE-RULES-DRYRUN-V1",
    run_id: runId,
    staging_ref: STAGING_REF,
    mode: "dry_run_read_only",
    physical_candidates_checked: cands.length,
    candidates: cands.map((x) => ({
      id: String(x.id),
      source_kind: x.source_kind,
      claim_family: x.claim_family,
      return_item_id_column: x.return_item_id ?? null,
      return_item_via_source_row: !x.return_item_id && !!x.ri_id,
    })),
    edge_rule_matrix: matrix,
    would_insert_counts: {
      total_proposed: matrix.length,
      would_insert: wouldInsert.length,
      by_rule: byRule,
    },
    duplicate_counts: duplicates.length,
    blocked_edge_reasons: blockedReasons,
    orbit_fra_return_item_link_gap: orbitGap,
    evidence_edge_gap:
      "No candidate has photos or claim_evidence rows; scan notes exist only as low-confidence (0.5) source_note edges. MVP needs evidence upload nudge in Claim Center before Proof tile is useful.",
    product_edge_gap:
      "All physical candidates share unresolved identifier X006OFFM01 — zero product_link edges possible until PIM resolves it (review queue entry, not a resolver rewrite).",
    dedupe_strategy:
      "dedupe_key = org|candidate|edge_type|to_table|to_row|reference_kind|reference_value — identical to uq_claim_reference_edges_candidate_natural; apply uses ON CONFLICT DO NOTHING.",
    proposed_apply_phase: {
      name: "PHASE-CLAIM-PHYSICAL-RETURN-TRID-EDGES-APPLY-V1",
      mechanism:
        "Add 6 physical-return rules to lib/claims/edges/claim-reference-discovery-engine.ts (return_item/package/tracking/product/evidence/order with source_row_id fallback for orbit_fra), then governed apply via scripts/phase-trid-discovery-engine-staging.ts --apply.",
      prerequisite_fix: "orbit_fra generator metadata fix (see orbit_fra_return_item_link_gap) — optional; source_row_id fallback works without it.",
    },
    schema_needed: "no",
    SAFE_TO_APPLY_PHYSICAL_RETURN_TRID_EDGES_STAGING: wouldInsert.length > 0 ? "yes" : "no",
    NEXT_EXACT_PROMPT:
      "PHASE-CLAIM-PHYSICAL-RETURN-TRID-EDGES-APPLY-V1\n\nMode: staging apply.\nScope:\n1. Fix orbit_fra generator metadata (lib/claims/intake/claim-orbit-fra-generator.ts makeDraft extra_metadata: add return_item_id/package_id/pallet_id for return_items-sourced categories).\n2. Add 6 physical-return edge rules to the discovery engine (source_row_id fallback for orbit_fra candidates).\n3. APPROVED_TRID_DISCOVERY_STAGING_APPLY=true npx tsx scripts/phase-trid-discovery-engine-staging.ts --apply\n4. Verify would_insert edges materialized, duplicates 0, npm run build, append memory.\nNo claim_cases, no submissions, no scanner UI changes, no schema.",
    verification: [
      "read-only session (default_transaction_read_only = on) — zero DB writes",
      "no claim_reference_edges inserts",
      "no scanner/operator-mobile changes",
      "no claim_candidates mutation, no cases, no submissions, no PDFs",
      "generator gap reported, NOT fixed (per phase constraint)",
    ],
  };

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "results.json"), JSON.stringify(payload, null, 2));

  const md = `# Physical return TRID edge rules — DRY-RUN V1 (staging, read-only)

| Field | Value |
|-------|-------|
| run_id | ${runId} |
| physical_candidates_checked | ${cands.length} |
| total edge proposals | ${matrix.length} |
| would_insert | ${wouldInsert.length} |
| duplicates | ${duplicates.length} |
| blocked | ${blocked.length} |
| schema_needed | no |
| SAFE_TO_APPLY_PHYSICAL_RETURN_TRID_EDGES_STAGING | ${payload.SAFE_TO_APPLY_PHYSICAL_RETURN_TRID_EDGES_STAGING} |

## Per-rule counts

| Rule | Proposed | Would insert | Blocked | Duplicate |
|------|---------:|-------------:|--------:|----------:|
${Object.entries(byRule)
  .map(([r, v]) => `| ${r} | ${v.proposed} | ${v.would_insert} | ${v.blocked} | ${v.duplicate} |`)
  .join("\n")}

## Blocked reasons

${Object.entries(blockedReasons)
  .map(([k, v]) => `- ${v}x ${k}`)
  .join("\n")}

## ORBIT-FRA return_item link gap

\`\`\`json
${JSON.stringify(orbitGap, null, 2)}
\`\`\`

## Edge rule matrix (full)

\`\`\`json
${JSON.stringify(matrix, null, 2)}
\`\`\`

## NEXT_EXACT_PROMPT

\`\`\`
${payload.NEXT_EXACT_PROMPT}
\`\`\`
`;
  fs.writeFileSync(path.join(outDir, "summary.md"), md);

  const memo = `

## Physical return TRID edge rules dry-run V1 (append ${new Date().toISOString().slice(0, 10)})

- **Run:** \`${runId}\` — \`.cursor/audit-reports/phase-claim-physical-return-trid-edge-rules-dryrun-v1/${runId}/\`
- ${cands.length} physical candidates checked; ${matrix.length} edge proposals (6 rules each): **${wouldInsert.length} would insert**, ${blocked.length} blocked, ${duplicates.length} duplicates. **No edges inserted** (read-only).
- **Generator gap confirmed:** orbit_fra return_items candidates drop return_item_id/package_id — exact fix: \`lib/claims/intake/claim-orbit-fra-generator.ts\` makeDraft extra_metadata (~line 835); registry mapping already supports it. NOT fixed this phase. source_row_id fallback recovers linkage meanwhile.
- Product edge gap: identifier X006OFFM01 unresolved (PIM review). Evidence gap: no photos/claim_evidence; notes only (0.5 confidence source_note).
- schema_needed=no. SAFE_TO_APPLY_PHYSICAL_RETURN_TRID_EDGES_STAGING=${payload.SAFE_TO_APPLY_PHYSICAL_RETURN_TRID_EDGES_STAGING}.
- Next: \`PHASE-CLAIM-PHYSICAL-RETURN-TRID-EDGES-APPLY-V1\`
`;
  fs.appendFileSync(path.join(process.cwd(), MEMORY_FILE), memo, "utf8");

  console.log(JSON.stringify(payload, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
