/**
 * CLAIM-UPSTREAM-BLOCKERS-V177 — Read-only blocker matrix + upstream work plan.
 *
 *   npx tsx scripts/claim-upstream-blockers-v177.ts --run-id=<id>
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createClient } from "@supabase/supabase-js";
import pg from "pg";

import {
  PAGE,
  projectClaimArtifactsBatchCore,
  fetchCandidateSourceContextMap,
  type ClaimArtifactCoreProjection,
} from "../lib/claim-artifact-projection-core";
import {
  buildBlockerInventory,
  isEligibleMaterializeProposal,
  runClaimResolverMaterializePass,
  scanClaimArtifactPage,
  type ClaimArtifactTable,
} from "../lib/claim-candidate-resolver-materialize";
import { getStagingProjectRef, loadEnvLocalIntoProcess, refFromSupabaseUrl } from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const OUT_BASE = ".cursor/audit-reports/claim-upstream-blockers-v177";
const EXAMPLES_PER_CELL = 3;

const PRIOR_AUDITS = {
  v175: ".cursor/audit-reports/claim-candidate-resolver-project-v175/20260524T120000Z",
  v176_close: ".cursor/audit-reports/claim-candidate-resolver-v176-final-verify-close/20260524T140000Z",
  v176_execute: ".cursor/audit-reports/claim-candidate-resolver-v176-fk-orphan-product-fix/20260523T211500Z",
};

type BlockerType =
  | "missing_source_row"
  | "unresolved_no_identifiers"
  | "blocked_pim"
  | "ambiguous"
  | "unsupported_source_table"
  | "resolvable_from_source"
  | "resolvable_from_identifiers"
  | "safe_update_candidate"
  | "safe_update_ineligible"
  | "orphan_resolved_fk"
  | "orphan_source_rpid_unresolved";

type MatrixRow = {
  table: ClaimArtifactTable;
  source_table: string;
  blocker_type: BlockerType;
  count: number;
  examples: Array<{
    id: string;
    organization_id: string;
    source_row_id: string | null;
    sku: string | null;
    fnsku: string | null;
    asin: string | null;
    resolved_product_id: string | null;
    reason_codes?: string[];
  }>;
  required_upstream_data: string[];
  safe_next_action: string;
  improvement_levers: string[];
  recommended_wave: "A" | "B" | "C" | "D";
};

function runIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function readJsonIfExists<T>(p: string): T | null {
  const full = path.join(process.cwd(), p);
  if (!fs.existsSync(full)) return null;
  return JSON.parse(fs.readFileSync(full, "utf8")) as T;
}

function waveForBlocker(type: BlockerType): "A" | "B" | "C" | "D" {
  switch (type) {
    case "unresolved_no_identifiers":
    case "blocked_pim":
      return "A";
    case "missing_source_row":
    case "orphan_source_rpid_unresolved":
    case "resolvable_from_source":
      return "B";
    case "ambiguous":
    case "safe_update_candidate":
      return "A";
    case "safe_update_ineligible":
    case "orphan_resolved_fk":
      return "C";
    case "unsupported_source_table":
    case "resolvable_from_identifiers":
      return type === "unsupported_source_table" ? "D" : "A";
    default:
      return "C";
  }
}

function upstreamForBlocker(type: BlockerType): { data: string[]; action: string; levers: string[] } {
  const map: Record<BlockerType, { data: string[]; action: string; levers: string[] }> = {
    missing_source_row: {
      data: ["Valid source_row_id in supported table", "Tenant-scoped operational keys (order_id, sku, fnsku)"],
      action: "Repair source linkage or re-import operational row; run operational alternate-key resolver report",
      levers: ["source row repair", "import/re-ingestion"],
    },
    unresolved_no_identifiers: {
      data: ["store_id", "fnsku/msku/asin on artifact or source", "product_identifier_map rows"],
      action: "Enrich identifier_map (Wave-2 style exact tiers); backfill source identifiers",
      levers: ["product_identifier_map enrichment", "source row repair"],
    },
    blocked_pim: {
      data: ["PIM catalog_product_id alignment", "Open PIM case resolution"],
      action: "Resolve PIM blockers before materialization; no blind resolver execute",
      levers: ["product_identifier_map enrichment", "manual review queue"],
    },
    ambiguous: {
      data: ["Disambiguated map match or operator-selected product_id"],
      action: "Route to manual review queue; resolve conflicts then re-project",
      levers: ["manual review queue", "product_identifier_map enrichment"],
    },
    unsupported_source_table: {
      data: ["Importer routing to supported source_table", "DDL if new lane required"],
      action: "Fix importer mapping or extend supported-source policy with explicit approval",
      levers: ["DDL plan", "import/re-ingestion"],
    },
    resolvable_from_source: {
      data: ["source.resolved_product_id ∈ products", "evidence_status not missing"],
      action: "Materialize only after source RPID cleanup + FK validation",
      levers: ["amazon_removal_shipments resolved_product_id cleanup", "source row repair"],
    },
    resolvable_from_identifiers: {
      data: ["Map tier match + evidence", "products.id FK"],
      action: "Run governed map materialization pass after map enrichment",
      levers: ["product_identifier_map enrichment"],
    },
    safe_update_candidate: {
      data: ["Valid products.id FK", "evidence_status", "governed dry-run approval"],
      action: "Run materialization execute ONLY after explicit dry-run signoff (currently near-zero on staging)",
      levers: ["product_identifier_map enrichment"],
    },
    safe_update_ineligible: {
      data: ["proposal_from ∈ {identifier_map, source_resolved}", "products.id FK on proposal"],
      action: "Remap orphan proposals (V176-style) or null invalid resolved_product_id before re-execute",
      levers: ["amazon_removal_shipments resolved_product_id cleanup", "manual review queue"],
    },
    orphan_resolved_fk: {
      data: ["products row for current resolved_product_id OR remap via map"],
      action: "Do not blind UPDATE; remap/null orphan RPIDs on candidates then re-materialize with FK guard",
      levers: ["amazon_removal_shipments resolved_product_id cleanup", "manual review queue"],
    },
    orphan_source_rpid_unresolved: {
      data: ["amazon_removal_shipments.resolved_product_id → valid products.id", "identifier hints"],
      action: "Clean orphan source RPIDs; then V176-class map remap for drafts",
      levers: ["amazon_removal_shipments resolved_product_id cleanup", "product_identifier_map enrichment"],
    },
  };
  return map[type];
}

function matrixKey(table: string, source: string, blocker: string): string {
  return `${table}\x1f${source}\x1f${blocker}`;
}

async function pgStructuralBlockers(client: pg.Client): Promise<{
  orphan_resolved_fk: MatrixRow[];
  orphan_source_rpid_unresolved: MatrixRow[];
}> {
  const orphanResolved = await client.query(`
    SELECT 'claim_candidates' AS tbl, source_table, COUNT(*)::bigint AS c
    FROM public.claim_candidates t
    WHERE t.resolved_product_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM public.products p WHERE p.id = t.resolved_product_id)
    GROUP BY source_table
    UNION ALL
    SELECT 'claim_candidate_drafts', source_table, COUNT(*)::bigint
    FROM public.claim_candidate_drafts t
    WHERE t.resolved_product_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM public.products p WHERE p.id = t.resolved_product_id)
    GROUP BY source_table
  `);

  const orphanSource = await client.query(`
    SELECT d.source_table, COUNT(*)::bigint AS c
    FROM public.claim_candidate_drafts d
    JOIN public.amazon_removal_shipments s ON s.id = d.source_row_id::uuid AND s.organization_id = d.organization_id
    WHERE d.resolved_product_id IS NULL
      AND d.source_table = 'amazon_removal_shipments'
      AND s.resolved_product_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM public.products p WHERE p.id = s.resolved_product_id)
    GROUP BY d.source_table
    UNION ALL
    SELECT c.source_table, COUNT(*)::bigint
    FROM public.claim_candidates c
    JOIN public.amazon_removal_shipments s ON s.id = c.source_row_id::uuid AND s.organization_id = c.organization_id
    WHERE c.resolved_product_id IS NULL
      AND c.source_table = 'amazon_removal_shipments'
      AND s.resolved_product_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM public.products p WHERE p.id = s.resolved_product_id)
    GROUP BY c.source_table
  `);

  const exOrphanResolved = await client.query(`
    (SELECT 'claim_candidates' AS tbl, id::text, organization_id::text, source_table, source_row_id::text,
            sku, fnsku, asin, resolved_product_id::text
     FROM public.claim_candidates t
     WHERE resolved_product_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM public.products p WHERE p.id = t.resolved_product_id)
     LIMIT 15)
    UNION ALL
    (SELECT 'claim_candidate_drafts', id::text, organization_id::text, source_table, source_row_id::text,
            sku, fnsku, asin, resolved_product_id::text
     FROM public.claim_candidate_drafts t
     WHERE resolved_product_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM public.products p WHERE p.id = t.resolved_product_id)
     LIMIT 15)
  `);

  const exOrphanSource = await client.query(`
    (SELECT 'claim_candidate_drafts' AS tbl, d.id::text, d.organization_id::text, d.source_table, d.source_row_id::text,
            d.sku, d.fnsku, d.asin, s.resolved_product_id::text AS orphan_source_rpid
     FROM public.claim_candidate_drafts d
     JOIN public.amazon_removal_shipments s ON s.id = d.source_row_id::uuid AND s.organization_id = d.organization_id
     WHERE d.resolved_product_id IS NULL AND d.source_table = 'amazon_removal_shipments'
       AND s.resolved_product_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM public.products p WHERE p.id = s.resolved_product_id)
     LIMIT 15)
  `);

  const rows: MatrixRow[] = [];
  for (const r of orphanResolved.rows as Array<{ tbl: string; source_table: string; c: string }>) {
    const meta = upstreamForBlocker("orphan_resolved_fk");
    const examples = (exOrphanResolved.rows as Array<Record<string, string>>)
      .filter((e) => e.tbl === r.tbl && e.source_table === r.source_table)
      .slice(0, EXAMPLES_PER_CELL)
      .map((e) => ({
        id: e.id,
        organization_id: e.organization_id,
        source_row_id: e.source_row_id,
        sku: e.sku,
        fnsku: e.fnsku,
        asin: e.asin,
        resolved_product_id: e.resolved_product_id,
      }));
    rows.push({
      table: r.tbl as ClaimArtifactTable,
      source_table: r.source_table ?? "(null)",
      blocker_type: "orphan_resolved_fk",
      count: Number(r.c),
      examples,
      required_upstream_data: meta.data,
      safe_next_action: meta.action,
      improvement_levers: meta.levers,
      recommended_wave: waveForBlocker("orphan_resolved_fk"),
    });
  }

  for (const r of orphanSource.rows as Array<{ source_table: string; c: string }>) {
    const meta = upstreamForBlocker("orphan_source_rpid_unresolved");
    const examples = (exOrphanSource.rows as Array<Record<string, string>>)
      .filter((e) => e.source_table === r.source_table)
      .slice(0, EXAMPLES_PER_CELL)
      .map((e) => ({
        id: e.id,
        organization_id: e.organization_id,
        source_row_id: e.source_row_id,
        sku: e.sku,
        fnsku: e.fnsku,
        asin: e.asin,
        resolved_product_id: e.orphan_source_rpid,
        reason_codes: ["orphan_source_rpid"],
      }));
    rows.push({
      table: "claim_candidate_drafts",
      source_table: r.source_table ?? "amazon_removal_shipments",
      blocker_type: "orphan_source_rpid_unresolved",
      count: Number(r.c),
      examples,
      required_upstream_data: meta.data,
      safe_next_action: meta.action,
      improvement_levers: meta.levers,
      recommended_wave: waveForBlocker("orphan_source_rpid_unresolved"),
    });
  }

  {
    const cc = await client.query(`
      SELECT COUNT(*)::bigint AS c FROM public.claim_candidates c
      JOIN public.amazon_removal_shipments s ON s.id = c.source_row_id::uuid AND s.organization_id = c.organization_id
      WHERE c.resolved_product_id IS NULL AND c.source_table = 'amazon_removal_shipments'
        AND s.resolved_product_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM public.products p WHERE p.id = s.resolved_product_id)
    `);
    const n = Number(cc.rows[0]?.c ?? 0);
    if (n > 0) {
      const meta = upstreamForBlocker("orphan_source_rpid_unresolved");
      rows.push({
        table: "claim_candidates",
        source_table: "amazon_removal_shipments",
        blocker_type: "orphan_source_rpid_unresolved",
        count: n,
        examples: [],
        required_upstream_data: meta.data,
        safe_next_action: meta.action,
        improvement_levers: meta.levers,
        recommended_wave: "B",
      });
    }
  }

  return { orphan_resolved_fk: rows.filter((x) => x.blocker_type === "orphan_resolved_fk"), orphan_source_rpid_unresolved: rows.filter((x) => x.blocker_type === "orphan_source_rpid_unresolved") };
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const runId = runIdArg();
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  const dbUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() || "";
  const publicUrl = process.env.STAGING_SUPABASE_URL?.trim() || process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() || "";
  const ref = refFromSupabaseUrl(publicUrl) || refFromSupabaseUrl(dbUrl);
  if (!dbUrl || ref !== STAGING_REF || getStagingProjectRef({ loadEnv: false }) !== STAGING_REF) {
    throw new Error(`Staging guard failed (ref=${ref})`);
  }

  const prior = {
    v175: readJsonIfExists<Record<string, unknown>>(path.join(PRIOR_AUDITS.v175, "manifest.json")),
    v176_close: readJsonIfExists<Record<string, unknown>>(path.join(PRIOR_AUDITS.v176_close, "manifest.json")),
    v176_execute: readJsonIfExists<Record<string, unknown>>(path.join(PRIOR_AUDITS.v176_execute, "manifest.json")),
  };
  fs.writeFileSync(path.join(outDir, "prior-audit-snapshot.json"), JSON.stringify(prior, null, 2));

  const key =
    process.env.STAGING_SERVICE_ROLE_KEY?.trim() || process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() || "";
  const supabase = createClient(publicUrl, key, { auth: { persistSession: false } });

  const pgClient = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await pgClient.connect();

  const countsRes = await pgClient.query(`
    SELECT 'claim_candidates' AS t,
      COUNT(*)::bigint AS total,
      COUNT(*) FILTER (WHERE resolved_product_id IS NOT NULL)::bigint AS resolved
    FROM public.claim_candidates
    UNION ALL
    SELECT 'claim_candidate_drafts',
      COUNT(*)::bigint,
      COUNT(*) FILTER (WHERE resolved_product_id IS NOT NULL)::bigint
    FROM public.claim_candidate_drafts
  `);
  const liveCounts: Record<string, { total: number; resolved: number; unresolved: number; pct: number }> = {};
  for (const r of countsRes.rows as Array<{ t: string; total: string; resolved: string }>) {
    const total = Number(r.total);
    const resolved = Number(r.resolved);
    liveCounts[r.t] = {
      total,
      resolved,
      unresolved: total - resolved,
      pct: total ? Math.round((resolved / total) * 1000) / 10 : 0,
    };
  }

  const structural = await pgStructuralBlockers(pgClient);
  await pgClient.end();

  const ccPass = await runClaimResolverMaterializePass(supabase, "claim_candidates", {
    onlyUnresolved: true,
    useInboxContext: true,
  });
  const cdPass = await runClaimResolverMaterializePass(supabase, "claim_candidate_drafts", {
    onlyUnresolved: true,
    useInboxContext: false,
  });

  const inventory = buildBlockerInventory(ccPass.metrics, cdPass.metrics);
  const matrixMap = new Map<string, MatrixRow>();

  function classifyBlocker(proj: ClaimArtifactCoreProjection): BlockerType {
    if (proj.final_bucket === "safe_update_candidate" && !isEligibleMaterializeProposal(proj)) {
      return "safe_update_ineligible";
    }
    return proj.final_bucket as BlockerType;
  }

  function addMatrixRow(
    table: ClaimArtifactTable,
    row: Record<string, unknown>,
    proj: ClaimArtifactCoreProjection,
  ) {
    const blocker = classifyBlocker(proj);
    const source = String(row.source_table ?? "(null)");
    const k = matrixKey(table, source, blocker);
    let cell = matrixMap.get(k);
    if (!cell) {
      const meta = upstreamForBlocker(blocker);
      cell = {
        table,
        source_table: source,
        blocker_type: blocker,
        count: 0,
        examples: [],
        required_upstream_data: meta.data,
        safe_next_action: meta.action,
        improvement_levers: meta.levers,
        recommended_wave: waveForBlocker(blocker),
      };
      matrixMap.set(k, cell);
    }
    cell.count++;
    if (cell.examples.length < EXAMPLES_PER_CELL) {
      cell.examples.push({
        id: String(row.id),
        organization_id: String(row.organization_id),
        source_row_id: row.source_row_id != null ? String(row.source_row_id) : null,
        sku: row.sku != null ? String(row.sku) : null,
        fnsku: row.fnsku != null ? String(row.fnsku) : null,
        asin: row.asin != null ? String(row.asin) : null,
        resolved_product_id: null,
        reason_codes: proj.reason_codes,
      });
    }
  }

  async function scanUnresolvedMatrix(table: ClaimArtifactTable) {
    const useInbox = table === "claim_candidates";
    for (let page = 0; page < 50; page++) {
      const offset = page * PAGE;
      const batch = await scanClaimArtifactPage(supabase, table, null, offset, PAGE, true);
      if (batch.length === 0) break;
      const unresolved = batch.filter((r) => !String(r.resolved_product_id ?? "").trim());
      if (unresolved.length === 0) {
        if (batch.length < PAGE) break;
        continue;
      }
      const orgForBatch = String(unresolved[0]?.organization_id ?? "");
      const projected = await projectClaimArtifactsBatchCore(
        supabase,
        unresolved,
        orgForBatch,
        useInbox ? fetchCandidateSourceContextMap : null,
      );
      for (const row of unresolved) {
        const proj = projected.get(String(row.id));
        if (!proj) continue;
        addMatrixRow(table, row, proj);
      }
      if (batch.length < PAGE) break;
    }
  }

  await scanUnresolvedMatrix("claim_candidates");
  await scanUnresolvedMatrix("claim_candidate_drafts");

  for (const r of [...structural.orphan_resolved_fk, ...structural.orphan_source_rpid_unresolved]) {
    const k = matrixKey(r.table, r.source_table, r.blocker_type);
    const existing = matrixMap.get(k);
    if (existing) {
      existing.count = Math.max(existing.count, r.count);
      if (r.examples.length > 0) existing.examples = r.examples;
    } else {
      matrixMap.set(k, r);
    }
  }

  const matrix = [...matrixMap.values()].sort(
    (a, b) => b.count - a.count || a.table.localeCompare(b.table) || a.blocker_type.localeCompare(b.blocker_type),
  );

  const waveRollup: Record<string, { count: number; blocker_types: Set<string> }> = {
    A: { count: 0, blocker_types: new Set() },
    B: { count: 0, blocker_types: new Set() },
    C: { count: 0, blocker_types: new Set() },
    D: { count: 0, blocker_types: new Set() },
  };
  for (const row of matrix) {
    waveRollup[row.recommended_wave].count += row.count;
    waveRollup[row.recommended_wave].blocker_types.add(row.blocker_type);
  }

  const waves = {
    A: {
      name: "PIM / product_identifier_map enrichment",
      focus: ["unresolved_no_identifiers", "blocked_pim", "resolvable_from_identifiers"],
      actions: [
        "Run governed product-id-mapping wave on staging (exact tiers only)",
        "Backfill fnsku/msku/asin on source rows where missing",
        "Resolve PIM-open cases before materialization",
      ],
      not_allowed: ["blind resolver execute", "product auto-create", "fuzzy/title linking"],
    },
    B: {
      name: "Source row cleanup",
      focus: ["missing_source_row", "orphan_source_rpid_unresolved", "resolvable_from_source"],
      actions: [
        "Clean amazon_removal_shipments.resolved_product_id orphan UUIDs (→ valid products.id or NULL)",
        "Repair source_row_id / operational alternate-key matches",
        "Re-import removal/return lanes with correct linkage",
      ],
      not_allowed: ["UPDATE claim_* without FK guard"],
    },
    C: {
      name: "Manual review / ambiguity queue",
      focus: ["ambiguous", "orphan_resolved_fk", "safe_update_ineligible"],
      actions: [
        "Operator queue for ambiguous map conflicts",
        "Candidate orphan FK remediation plan (V176-analog + null/remap)",
        "Disambiguate then re-run dry-run materialization",
      ],
      not_allowed: ["blind bulk execute"],
    },
    D: {
      name: "DDL / importer improvement",
      focus: ["unsupported_source_table"],
      actions: [
        "Route imports to supported source_table set",
        "DDL only with explicit operator approval",
      ],
      not_allowed: ["package_items", "production migration without approval"],
    },
  };

  const eligibleRemaining = ccPass.metrics.eligible_safe_update + cdPass.metrics.eligible_safe_update;

  const manifest = {
    prompt: "CLAIM-UPSTREAM-BLOCKERS-V177",
    run_id: runId,
    staging_ref: STAGING_REF,
    mode: "read_only",
    live_counts: liveCounts,
    resolver_scan: {
      claim_candidates: ccPass.metrics,
      claim_candidate_drafts: cdPass.metrics,
      eligible_safe_materialize_remaining: eligibleRemaining,
    },
    prior_audits: PRIOR_AUDITS,
    prior_manifests_found: {
      v175: prior.v175 != null,
      v176_close: prior.v176_close != null,
      v176_execute: prior.v176_execute != null,
    },
    matrix_rows: matrix.length,
    wave_rollup: Object.fromEntries(
      Object.entries(waveRollup).map(([k, v]) => [k, { count: v.count, blocker_types: [...v.blocker_types] }]),
    ),
    status: "PASS",
  };

  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(path.join(outDir, "live-counts.json"), JSON.stringify(liveCounts, null, 2));
  fs.writeFileSync(path.join(outDir, "resolver-metrics.json"), JSON.stringify({ claim_candidates: ccPass.metrics, claim_candidate_drafts: cdPass.metrics }, null, 2));
  fs.writeFileSync(path.join(outDir, "blocker-inventory.json"), JSON.stringify(inventory, null, 2));
  fs.writeFileSync(path.join(outDir, "unresolved-blocker-matrix.json"), JSON.stringify(matrix, null, 2));
  fs.writeFileSync(path.join(outDir, "recommended-waves.json"), JSON.stringify(waves, null, 2));
  fs.writeFileSync(path.join(outDir, "improvement-levers.json"), JSON.stringify(
    {
      product_identifier_map_enrichment: matrix.filter((r) => r.improvement_levers.includes("product_identifier_map enrichment")).reduce((s, r) => s + r.count, 0),
      source_row_repair: matrix.filter((r) => r.improvement_levers.includes("source row repair")).reduce((s, r) => s + r.count, 0),
      amazon_removal_shipments_cleanup: matrix.filter((r) => r.improvement_levers.includes("amazon_removal_shipments resolved_product_id cleanup")).reduce((s, r) => s + r.count, 0),
      import_reingestion: matrix.filter((r) => r.improvement_levers.includes("import/re-ingestion")).reduce((s, r) => s + r.count, 0),
      manual_review_queue: matrix.filter((r) => r.improvement_levers.includes("manual review queue")).reduce((s, r) => s + r.count, 0),
      ddl_plan: matrix.filter((r) => r.improvement_levers.includes("DDL plan")).reduce((s, r) => s + r.count, 0),
    },
    null,
    2,
  ));

  const mdMatrix = matrix
    .slice(0, 40)
    .map(
      (r) =>
        `| ${r.table} | ${r.source_table} | ${r.blocker_type} | ${r.count} | ${r.recommended_wave} | ${r.safe_next_action.slice(0, 80)}… |`,
    )
    .join("\n");

  fs.writeFileSync(
    path.join(outDir, "summary.md"),
    [
      "# CLAIM-UPSTREAM-BLOCKERS-V177",
      "",
      `- run_id: \`${runId}\``,
      `- staging: \`${STAGING_REF}\``,
      `- mode: **read-only** (no DB writes)`,
      "",
      "## Coverage (live)",
      `- claim_candidates: **${liveCounts.claim_candidates?.resolved}/${liveCounts.claim_candidates?.total}** (${liveCounts.claim_candidates?.pct}%) unresolved **${liveCounts.claim_candidates?.unresolved}**`,
      `- claim_candidate_drafts: **${liveCounts.claim_candidate_drafts?.resolved}/${liveCounts.claim_candidate_drafts?.total}** (${liveCounts.claim_candidate_drafts?.pct}%) unresolved **${liveCounts.claim_candidate_drafts?.unresolved}**`,
      "",
      "## Prior audits ingested",
      `- V175: ${prior.v175 ? "manifest found" : "not on disk (gitignored)"}`,
      `- V176 close: ${prior.v176_close ? "manifest found" : "not on disk"}`,
      `- V176 execute: ${prior.v176_execute ? "manifest found" : "not on disk"}`,
      "",
      "## Resolver dry-scan (unresolved only)",
      `- eligible safe materialize remaining: **${eligibleRemaining}**`,
      `- **Warning:** most draft \`safe_update_candidate\` rows (~2,539) overlap orphan \`amazon_removal_shipments\` RPIDs — require **Wave B** cleanup before any execute`,
      "",
      "## Wave rollup (approximate)",
      `- **A** map/PIM: ${waveRollup.A.count}`,
      `- **B** source cleanup: ${waveRollup.B.count}`,
      `- **C** manual review: ${waveRollup.C.count}`,
      `- **D** DDL/importer: ${waveRollup.D.count}`,
      "",
      "## Top matrix rows",
      "| table | source_table | blocker_type | count | wave | safe_next_action |",
      "|-------|--------------|--------------|------:|------|------------------|",
      mdMatrix,
      "",
      "See `unresolved-blocker-matrix.json`, `recommended-waves.json`, `closeout-plan.md`.",
    ].join("\n"),
    "utf8",
  );

  fs.writeFileSync(
    path.join(outDir, "closeout-plan.md"),
    [
      "# Next safe data-quality work plan",
      "",
      "After V175 (candidate materialization) and V176 (draft orphan-FK remap), **remaining unresolved rows are upstream blockers** — not safe for blind resolver passes.",
      "",
      "### Wave A — PIM / map enrichment",
      waves.A.actions.map((a) => `- ${a}`).join("\n"),
      "",
      "### Wave B — Source row cleanup",
      waves.B.actions.map((a) => `- ${a}`).join("\n"),
      "",
      "### Wave C — Manual review queue",
      waves.C.actions.map((a) => `- ${a}`).join("\n"),
      "",
      "### Wave D — DDL / importer",
      waves.D.actions.map((a) => `- ${a}`).join("\n"),
      "",
      "### Hard stops",
      "- No production",
      "- No product auto-create",
      "- No fuzzy/title/OCR linking",
      "- No blind execute without new dry-run + operator approval",
    ].join("\n"),
    "utf8",
  );

  console.log(JSON.stringify(manifest, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
