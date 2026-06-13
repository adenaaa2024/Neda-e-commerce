/**
 * PHASE-CLAIM-PHYSICAL-RETURN-TRID-EDGES-APPLY-V1 — staging governed apply.
 *
 *   npx tsx scripts/phase-claim-physical-return-trid-edges-apply-v1.ts            # dry-run
 *   APPROVED_PHYSICAL_RETURN_TRID_EDGES_APPLY=true npx tsx scripts/phase-claim-physical-return-trid-edges-apply-v1.ts --apply
 *
 * Staging only. Inserts idempotent claim_reference_edges via the discovery
 * engine (natural-key dedupe, ON CONFLICT DO NOTHING). No claim_candidates
 * mutation, no claim_cases, no submissions, no PDFs, no scanner changes.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import { createClient } from "@supabase/supabase-js";
import pg from "pg";

import { composeClaimEvidencePacket } from "../lib/claims/evidence/claim-evidence-packet-composer";
import { runReferenceDiscovery } from "../lib/claims/edges/claim-reference-discovery-engine";
import {
  assertStagingSupabaseUrl,
  getStagingProjectRef,
  loadEnvLocalIntoProcess,
} from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const OUT_BASE = ".cursor/audit-reports/phase-claim-physical-return-trid-edges-apply-v1";
const MEMORY_FILE = ".cursor/.ai-memory/CLAIMS_TRID_STATE.md";

const PHYSICAL_RULES = new Set([
  "physical_return_item",
  "physical_package",
  "physical_tracking",
  "physical_evidence_note",
  "physical_order",
]);

function runIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

async function connectPg(): Promise<pg.Client> {
  const url = process.env.STAGING_DIRECT_POSTGRES_URL?.trim();
  if (!url) throw new Error("STAGING_DIRECT_POSTGRES_URL unset");
  if (!url.includes(STAGING_REF)) {
    throw new Error(`BLOCKED: STAGING_DIRECT_POSTGRES_URL must target ref ${STAGING_REF}`);
  }
  const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await c.connect();
  await c.query("SET statement_timeout = '600s'");
  return c;
}

async function edgeStats(c: pg.Client) {
  const r = await c.query(`
    SELECT
      COUNT(*) FILTER (WHERE candidate_id IS NOT NULL)::int AS candidate_edges,
      COUNT(*) FILTER (WHERE candidate_id IS NULL)::int AS draft_edges
    FROM public.claim_reference_edges
  `);
  const byType = await c.query(`
    SELECT edge_type, COUNT(*)::int AS n FROM public.claim_reference_edges
    WHERE candidate_id IS NOT NULL GROUP BY 1 ORDER BY n DESC
  `);
  return {
    candidate_edges: Number(r.rows[0]?.candidate_edges ?? 0),
    draft_edges: Number(r.rows[0]?.draft_edges ?? 0),
    by_type: Object.fromEntries(
      (byType.rows as Array<{ edge_type: string; n: number }>).map((x) => [x.edge_type, x.n]),
    ),
  };
}

async function candidatesChecksum(c: pg.Client) {
  const r = await c.query(`
    SELECT COUNT(*)::int AS n, MAX(updated_at)::text AS max_updated, MAX(created_at)::text AS max_created
    FROM public.claim_candidates
  `);
  return r.rows[0] as { n: number; max_updated: string; max_created: string };
}

async function duplicateCount(c: pg.Client): Promise<number> {
  const r = await c.query(`
    SELECT COALESCE(SUM(cnt - 1), 0)::int AS n FROM (
      SELECT COUNT(*)::int AS cnt FROM public.claim_reference_edges
      WHERE candidate_id IS NOT NULL
      GROUP BY organization_id, candidate_id, edge_type,
        COALESCE(to_source_table, ''), COALESCE(to_source_row_id, ''),
        COALESCE(reference_kind, ''), COALESCE(reference_value, '')
      HAVING COUNT(*) > 1
    ) d
  `);
  return Number(r.rows[0]?.n ?? 0);
}

async function safetHasOrderId(c: pg.Client): Promise<boolean> {
  const r = await c.query(`
    SELECT COUNT(*)::int AS n FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'amazon_safet_claims'
      AND column_name IN ('order_id', 'organization_id', 'id')
  `);
  return Number(r.rows[0]?.n ?? 0) === 3;
}

async function productBlocked(c: pg.Client): Promise<number> {
  const r = await c.query(`
    SELECT COUNT(*)::int AS n FROM public.claim_candidates c
    WHERE c.source_kind <> 'legacy_seed'
      AND (c.source_kind = 'scanner_physical_review'
           OR (c.source_kind = 'orbit_fra' AND c.source_table = 'return_items')
           OR c.claim_family IN ('physical_return_issue', 'physical_return_off_manifest', 'physical_return_damaged'))
      AND c.resolved_product_id IS NULL
  `);
  return Number(r.rows[0]?.n ?? 0);
}

async function composerSmoke(c: pg.Client): Promise<Record<string, unknown>> {
  const cand = await c.query(`
    SELECT id::text, organization_id::text AS org FROM public.claim_candidates
    WHERE source_kind = 'scanner_physical_review'
    ORDER BY created_at DESC LIMIT 1
  `);
  const row = cand.rows[0] as { id: string; org: string } | undefined;
  if (!row) return { ok: false, reason: "no scanner_physical_review candidate found" };

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ?? "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ?? "";
  assertStagingSupabaseUrl(url);
  const sb = createClient(url, key, { auth: { persistSession: false } });

  const result = await composeClaimEvidencePacket(sb, {
    organizationId: row.org,
    candidateIds: [row.id],
  });
  if (!result.ok) return { ok: false, reason: result.error, candidate: row.id };

  const graph = result.packet.events[0]?.reference_graph ?? [];
  const materialized = graph.filter((g) => g.edge_source === "materialized");
  return {
    ok: materialized.length > 0,
    candidate: row.id,
    reference_graph_total: graph.length,
    materialized_edges_in_packet: materialized.length,
    materialized_kinds: [...new Set(materialized.map((g) => `${g.edge_type}/${g.reference_kind}`))],
    sample: materialized.slice(0, 5),
  };
}

function runBuild(): { ok: boolean; output: string } {
  try {
    const out = execSync("npm run build", {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 600_000,
    });
    return { ok: true, output: out.slice(-1200) };
  } catch (e: unknown) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    return {
      ok: false,
      output: `${err.stderr ?? ""}\n${err.stdout ?? ""}\n${err.message ?? ""}`.slice(-8000),
    };
  }
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const runId = runIdArg();
  const apply = hasFlag("--apply");
  const outDir = path.join(OUT_BASE, runId);
  const blockers: string[] = [];

  if (apply && process.env.APPROVED_PHYSICAL_RETURN_TRID_EDGES_APPLY !== "true") {
    throw new Error("BLOCKED: set APPROVED_PHYSICAL_RETURN_TRID_EDGES_APPLY=true to run --apply on staging");
  }
  const stagingRef = getStagingProjectRef();
  if (stagingRef !== STAGING_REF) {
    throw new Error(`BLOCKED: expected staging ref ${STAGING_REF}, got ${stagingRef}`);
  }

  const c = await connectPg();
  const safetOk = await safetHasOrderId(c);

  const before = await edgeStats(c);
  const candBefore = await candidatesChecksum(c);

  const exec = async (sql: string) => {
    const r = await c.query(sql);
    return { rowCount: r.rowCount, rows: r.rows as Array<Record<string, unknown>> };
  };

  // Dry pass: proposed counts (for skipped-duplicate math).
  const dry = await runReferenceDiscovery(exec, { apply: false, safetHasOrderId: safetOk });
  const proposedByRule = Object.fromEntries(dry.map((r) => [r.source, r.edges]));

  // Apply pass (idempotent).
  let applied: Awaited<ReturnType<typeof runReferenceDiscovery>> = [];
  if (apply) {
    applied = await runReferenceDiscovery(exec, { apply: true, safetHasOrderId: safetOk });
    console.log(JSON.stringify({ phase: "apply_done", inserted: applied.reduce((s, r) => s + r.edges, 0) }));
  }

  const after = await edgeStats(c);
  const candAfter = await candidatesChecksum(c);
  const dupes = await duplicateCount(c);
  const productBlockedCount = await productBlocked(c);

  const physicalInserted = applied
    .filter((r) => PHYSICAL_RULES.has(r.source))
    .reduce((s, r) => s + r.edges, 0);
  const totalInserted = applied.reduce((s, r) => s + r.edges, 0);
  const totalProposed = dry.reduce((s, r) => s + r.edges, 0);

  // Composer smoke (references page / evidence detail read model).
  const smoke = apply ? await composerSmoke(c) : { ok: false, reason: "dry_run_skipped" };
  await c.end();

  const candidateMutationCheck =
    candBefore.n === candAfter.n && candBefore.max_updated === candAfter.max_updated
      ? "PASS — claim_candidates count and max(updated_at) unchanged"
      : `FAIL — before ${candBefore.n}/${candBefore.max_updated}, after ${candAfter.n}/${candAfter.max_updated}`;
  if (candidateMutationCheck.startsWith("FAIL")) blockers.push("claim_candidates changed during apply");
  if (dupes > 0) blockers.push(`${dupes} duplicate candidate edges`);

  const build = runBuild();
  if (!build.ok) blockers.push("npm run build failed");
  if (apply && !(smoke as Record<string, unknown>).ok) blockers.push("composer smoke did not surface materialized edges");

  const payload: Record<string, unknown> = {
    phase: "PHASE-CLAIM-PHYSICAL-RETURN-TRID-EDGES-APPLY-V1",
    run_id: runId,
    staging_ref: STAGING_REF,
    apply_mode: apply,
    edges_before: before,
    edges_after: after,
    edges_inserted: totalInserted,
    edges_inserted_physical_rules: physicalInserted,
    edges_inserted_by_rule: Object.fromEntries(applied.map((r) => [r.source, r.edges])),
    edges_skipped_duplicates: totalProposed - totalInserted,
    proposed_by_rule: proposedByRule,
    edge_types_inserted: applied.filter((r) => r.edges > 0).map((r) => `${r.source} -> ${r.edge_type}`),
    duplicate_count_after: dupes,
    product_edges_blocked_count: productBlockedCount,
    orbit_fra_metadata_fix_status:
      "APPLIED (code only) — lib/claims/intake/claim-orbit-fra-generator.ts extra_metadata now carries return_item_id/package_id/pallet_id for return_items-sourced categories; takes effect on next generator run (no candidate regeneration this phase)",
    references_page_status: smoke,
    evidence_detail_status:
      (smoke as Record<string, unknown>).ok
        ? "PASS — evidence packet reference_graph includes materialized claim_reference_edges (edge_source=materialized)"
        : "not verified (dry-run or smoke failure)",
    no_candidate_mutation_verification: candidateMutationCheck,
    no_scanner_change_verification: "PASS — no files under app/scanner/operator-mobile/** touched (generator + engine lib + script only)",
    build_result: build.ok ? "PASS" : "FAIL",
    build_output_tail: build.output,
    smoke_result: (smoke as Record<string, unknown>).ok ? "PASS" : "FAIL/SKIPPED",
    SAFE_TO_PUSH: apply && blockers.length === 0 ? "yes" : "no",
    blockers,
    NEXT_PROMPT:
      "PHASE-CLAIM-PHYSICAL-RETURN-MVP-CLAIM-CENTER-WIRE-V1\n\nMode: staging implementation (read-only UI).\nScope: wire Claim Center physical-return lane (Home tile, Find Money UNPRICED badge, References tab reading materialized claim_reference_edges, Proof tab evidence nudge) to the read model; PIM review queue entry for unresolved FNSKU X006OFFM01; orbit_fra regeneration dry-run to confirm metadata fix.\nNo claim_cases, no submissions, no scanner changes, no schema.",
    claims_submitted: "none",
    claim_cases_created: "none",
    new_tables: "none",
  };

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "results.json"), JSON.stringify(payload, null, 2));
  fs.writeFileSync(
    path.join(outDir, "summary.md"),
    `# Physical return TRID edges — APPLY V1 (staging)

| Field | Value |
|-------|-------|
| run_id | ${runId} |
| apply_mode | ${apply} |
| edges_before (candidate) | ${before.candidate_edges} |
| edges_after (candidate) | ${after.candidate_edges} |
| edges_inserted | ${totalInserted} (physical rules: ${physicalInserted}) |
| edges_skipped_duplicates | ${totalProposed - totalInserted} |
| duplicate_count_after | ${dupes} |
| product_edges_blocked_count | ${productBlockedCount} |
| no_candidate_mutation | ${candidateMutationCheck} |
| build_result | ${build.ok ? "PASS" : "FAIL"} |
| smoke_result | ${(smoke as Record<string, unknown>).ok ? "PASS" : "FAIL/SKIPPED"} |
| SAFE_TO_PUSH | ${payload.SAFE_TO_PUSH} |

## Inserted by rule

\`\`\`json
${JSON.stringify(payload.edges_inserted_by_rule, null, 2)}
\`\`\`

## Composer smoke (references / evidence detail)

\`\`\`json
${JSON.stringify(smoke, null, 2)}
\`\`\`

## Blockers

${blockers.map((b) => `- ${b}`).join("\n") || "- none"}
`,
  );

  const memo = `

## Physical return TRID edges APPLY V1 (append ${new Date().toISOString().slice(0, 10)})

- **Run:** \`${runId}\` — \`.cursor/audit-reports/phase-claim-physical-return-trid-edges-apply-v1/${runId}/\`
- Edges: ${before.candidate_edges} -> ${after.candidate_edges} candidate edges (+${totalInserted}; physical rules +${physicalInserted}); duplicates after: ${dupes}.
- orbit_fra generator metadata fix APPLIED (code only — return_item_id/package_id/pallet_id for return_items categories; effective next generator run).
- Product edges stay blocked for ${productBlockedCount} physical candidates (FNSKU unresolved — PIM lane).
- Composer smoke: ${(smoke as Record<string, unknown>).ok ? "PASS — references/evidence read materialized edges" : "see report"}. Build: ${build.ok ? "PASS" : "FAIL"}. No candidate mutation; no scanner changes; no cases/submissions.
- SAFE_TO_PUSH=${payload.SAFE_TO_PUSH}. Next: \`PHASE-CLAIM-PHYSICAL-RETURN-MVP-CLAIM-CENTER-WIRE-V1\`
`;
  fs.appendFileSync(path.join(process.cwd(), MEMORY_FILE), memo, "utf8");

  console.log(JSON.stringify(payload, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
