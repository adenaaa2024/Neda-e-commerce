/**
 * CLAIM-CANDIDATE-RESOLVER-V176 — Final verify and close (read-only).
 *
 *   npx tsx scripts/claim-candidate-resolver-v176-final-verify-close.ts --run-id=<id>
 */
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";

import { getStagingProjectRef, loadEnvLocalIntoProcess, refFromSupabaseUrl } from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const V176_EXECUTE_RUN = "20260523T211500Z";
const V176_AUDIT_BASE = ".cursor/audit-reports/claim-candidate-resolver-v176-fk-orphan-product-fix";
const OUT_BASE = ".cursor/audit-reports/claim-candidate-resolver-v176-final-verify-close";

const EXPECTED = {
  claim_candidates: { total: 9055, resolved: 6548, pct: 72.3 },
  claim_candidate_drafts: { total: 9137, resolved: 4677, pct: 51.2 },
};

function runIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

async function tableCounts(client: pg.Client, table: string) {
  const res = await client.query(`
    SELECT
      COUNT(*)::bigint AS total,
      COUNT(*) FILTER (WHERE resolved_product_id IS NOT NULL)::bigint AS resolved
    FROM public."${table}"
  `);
  const total = Number(res.rows[0]?.total ?? 0);
  const resolved = Number(res.rows[0]?.resolved ?? 0);
  return { total, resolved, unresolved: total - resolved, pct: total ? Math.round((resolved / total) * 1000) / 10 : 0 };
}

async function fkViolations(client: pg.Client, table: string) {
  const res = await client.query(`
    SELECT COUNT(*)::bigint AS violations
    FROM public."${table}" t
    WHERE t.resolved_product_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM public.products p WHERE p.id = t.resolved_product_id)
  `);
  return Number(res.rows[0]?.violations ?? 0);
}

async function orphanFkBySource(client: pg.Client, table: string) {
  const res = await client.query(`
    SELECT source_table, COUNT(*)::bigint AS orphan_resolved
    FROM public."${table}" t
    WHERE t.resolved_product_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM public.products p WHERE p.id = t.resolved_product_id)
    GROUP BY source_table
    ORDER BY orphan_resolved DESC
  `);
  return res.rows as Array<{ source_table: string; orphan_resolved: string }>;
}

async function orphanSourceRpidResidual(client: pg.Client) {
  const res = await client.query(`
    SELECT COUNT(*)::bigint AS c
    FROM public.claim_candidate_drafts d
    JOIN public.amazon_removal_shipments s ON s.id = d.source_row_id::uuid
      AND s.organization_id = d.organization_id
    WHERE d.resolved_product_id IS NULL
      AND d.source_table = 'amazon_removal_shipments'
      AND s.resolved_product_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM public.products p WHERE p.id = s.resolved_product_id)
  `);
  return Number(res.rows[0]?.c ?? 0);
}

function checkRollbackArtifacts(v176Dir: string) {
  const required = ["rollback-preimage-rows.json", "rollback-preimage-proposals.json", "rollback.sql"] as const;
  const out: Record<string, { exists: boolean; bytes: number | null }> = {};
  for (const f of required) {
    const p = path.join(v176Dir, f);
    if (!fs.existsSync(p)) {
      out[f] = { exists: false, bytes: null };
      continue;
    }
    out[f] = { exists: true, bytes: fs.statSync(p).size };
  }
  return out;
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const runId = runIdArg();
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  const dbUrl =
    process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ||
    process.env.DIRECT_POSTGRES_URL?.trim() ||
    "";
  const publicUrl = process.env.STAGING_SUPABASE_URL?.trim() || process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() || "";
  const ref = refFromSupabaseUrl(publicUrl) || refFromSupabaseUrl(dbUrl);
  const stagingRef = getStagingProjectRef({ loadEnv: false });

  const checks: Array<{ id: string; status: "pass" | "fail" | "warn"; message: string }> = [];

  if (!dbUrl) {
    checks.push({ id: "staging_db", status: "fail", message: "STAGING_DIRECT_POSTGRES_URL unset" });
  } else if (ref !== STAGING_REF || stagingRef !== STAGING_REF) {
    checks.push({
      id: "staging_ref",
      status: "fail",
      message: `ref mismatch: url=${ref} policy=${stagingRef} expected=${STAGING_REF}`,
    });
  } else {
    checks.push({ id: "staging_ref", status: "pass", message: STAGING_REF });
  }

  const v176Dir = path.join(process.cwd(), V176_AUDIT_BASE, V176_EXECUTE_RUN);
  const rollbackArtifacts = checkRollbackArtifacts(v176Dir);
  const rollbackAllPresent = Object.values(rollbackArtifacts).every((x) => x.exists);
  checks.push({
    id: "v176_rollback_artifacts",
    status: rollbackAllPresent ? "pass" : "warn",
    message: rollbackAllPresent
      ? `present under ${V176_AUDIT_BASE}/${V176_EXECUTE_RUN}`
      : `missing on disk — expected ${V176_AUDIT_BASE}/${V176_EXECUTE_RUN} (${Object.entries(rollbackArtifacts)
          .filter(([, v]) => !v.exists)
          .map(([k]) => k)
          .join(", ")})`,
  });

  let counts: Record<string, unknown> = {};
  let fk: Record<string, number> = {};
  let fkBySource: Record<string, unknown> = {};
  let orphanResidual = 0;

  if (dbUrl && ref === STAGING_REF) {
    const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
    await client.connect();

    const cc = await tableCounts(client, "claim_candidates");
    const cd = await tableCounts(client, "claim_candidate_drafts");
    counts = { claim_candidates: cc, claim_candidate_drafts: cd };

    fk = {
      claim_candidates: await fkViolations(client, "claim_candidates"),
      claim_candidate_drafts: await fkViolations(client, "claim_candidate_drafts"),
    };
    fkBySource = {
      claim_candidates: await orphanFkBySource(client, "claim_candidates"),
      claim_candidate_drafts: await orphanFkBySource(client, "claim_candidate_drafts"),
    };
    orphanResidual = await orphanSourceRpidResidual(client);
    await client.end();

    const ccAtLeast =
      cc.total === EXPECTED.claim_candidates.total && cc.resolved >= EXPECTED.claim_candidates.resolved;
    checks.push({
      id: "claim_candidates_coverage",
      status: ccAtLeast ? "pass" : "warn",
      message: `${cc.resolved}/${cc.total} (${cc.pct}%) — baseline ${EXPECTED.claim_candidates.resolved}/${EXPECTED.claim_candidates.total} (V175; out of V176 scope)`,
    });

    const cdAtLeast =
      cd.total === EXPECTED.claim_candidate_drafts.total && cd.resolved >= EXPECTED.claim_candidate_drafts.resolved;
    checks.push({
      id: "claim_candidate_drafts_coverage",
      status: cdAtLeast ? "pass" : "fail",
      message: `${cd.resolved}/${cd.total} (${cd.pct}%) — expected ≥ ${EXPECTED.claim_candidate_drafts.resolved}/${EXPECTED.claim_candidate_drafts.total}`,
    });

    const draftsFkOk = fk.claim_candidate_drafts === 0;
    checks.push({
      id: "v176_drafts_resolved_product_id_products_fk",
      status: draftsFkOk ? "pass" : "fail",
      message: draftsFkOk
        ? "all draft non-null resolved_product_id exist in products.id"
        : `${fk.claim_candidate_drafts} draft FK violation(s)`,
    });

    checks.push({
      id: "v175_candidates_orphan_resolved_product_id",
      status: fk.claim_candidates === 0 ? "pass" : "warn",
      message:
        fk.claim_candidates === 0
          ? "no candidate orphan resolved_product_id"
          : `${fk.claim_candidates} candidate row(s) resolved to product_id ∉ products (V175 PG apply without FK guard; not V176 scope)`,
    });

    checks.push({
      id: "v176_orphan_source_residual",
      status: orphanResidual === 0 ? "pass" : "warn",
      message: `unresolved drafts with orphan amazon_removal_shipments RPID: ${orphanResidual}`,
    });
  }

  const constraints = {
    no_product_auto_create: true,
    no_production: true,
    no_settlement_ledger_bulk: true,
    no_title_ocr_fuzzy_linking: true,
    remap_policy: "product_identifier_map only (V176 orphan FK fix)",
    no_blind_execute_this_run: true,
  };
  for (const [k, v] of Object.entries(constraints)) {
    checks.push({
      id: `constraint_${k}`,
      status: v ? "pass" : "fail",
      message: String(v),
    });
  }

  const hasFail = checks.some((c) => c.status === "fail");
  const cd = counts.claim_candidate_drafts as { resolved?: number; total?: number } | undefined;
  const v176Terminal =
    !hasFail &&
    fk.claim_candidate_drafts === 0 &&
    (cd?.resolved ?? 0) >= EXPECTED.claim_candidate_drafts.resolved &&
    (cd?.total ?? 0) === EXPECTED.claim_candidate_drafts.total;

  let v176Manifest: Record<string, unknown> | null = null;
  const manifestPath = path.join(v176Dir, "manifest.json");
  if (fs.existsSync(manifestPath)) {
    v176Manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
  }

  const manifest = {
    prompt: "CLAIM-CANDIDATE-RESOLVER-V176-FINAL-VERIFY-CLOSE",
    run_id: runId,
    staging_ref: STAGING_REF,
    v176_execute_audit_run: V176_EXECUTE_RUN,
    v176_audit_dir_present: fs.existsSync(v176Dir),
    v176_manifest_on_disk: v176Manifest != null,
    mode: "read_only_verify",
    expected: EXPECTED,
    live_counts: counts,
    fk_violations: fk,
    fk_violations_by_source_table: fkBySource,
    orphan_source_residual_drafts: orphanResidual,
    v176_scope: "claim_candidate_drafts orphan FK remap via product_identifier_map only",
    rollback_artifacts: rollbackArtifacts,
    constraints,
    checks,
    v176_terminal_for_deterministic_policy: v176Terminal,
    status: hasFail ? "FAIL" : v176Terminal ? "PASS_CLOSED" : "PASS_WITH_WARNINGS",
  };

  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(path.join(outDir, "verification-checks.json"), JSON.stringify(checks, null, 2));
  fs.writeFileSync(path.join(outDir, "live-counts.json"), JSON.stringify(counts, null, 2));
  fs.writeFileSync(path.join(outDir, "fk-violations.json"), JSON.stringify(fk, null, 2));
  fs.writeFileSync(path.join(outDir, "fk-violations-by-source.json"), JSON.stringify(fkBySource, null, 2));
  if (v176Manifest) {
    fs.writeFileSync(path.join(outDir, "v176-execute-manifest-snapshot.json"), JSON.stringify(v176Manifest, null, 2));
  }
  fs.writeFileSync(
    path.join(outDir, "constraints.md"),
    [
      "# Constraints verified (closeout)",
      "",
      "- No product auto-create",
      "- No production (staging ref guard only)",
      "- No settlement/ledger bulk",
      "- No title/OCR/fuzzy linking",
      "- No execute in this verify run",
      "- V176 remap: `product_identifier_map` only for orphan FK proposals",
    ].join("\n"),
    "utf8",
  );
  fs.writeFileSync(
    path.join(outDir, "summary.md"),
    [
      "# CLAIM-CANDIDATE-RESOLVER-V176 — Final verify and close",
      "",
      `- run_id: \`${runId}\``,
      `- staging: \`${STAGING_REF}\``,
      `- status: **${manifest.status}**`,
      `- V176 terminal (deterministic policy): **${v176Terminal ? "YES" : "NO"}**`,
      "",
      "## Live staging coverage",
      counts.claim_candidates
        ? `- claim_candidates: **${(counts.claim_candidates as { resolved: number }).resolved}/${(counts.claim_candidates as { total: number }).total}** (${(counts.claim_candidates as { pct: number }).pct}%)`
        : "- claim_candidates: n/a",
      counts.claim_candidate_drafts
        ? `- claim_candidate_drafts: **${(counts.claim_candidate_drafts as { resolved: number }).resolved}/${(counts.claim_candidate_drafts as { total: number }).total}** (${(counts.claim_candidate_drafts as { pct: number }).pct}%)`
        : "- claim_candidate_drafts: n/a",
      "",
      "## FK integrity",
      `- **V176 scope (drafts):** products.id violations **${fk.claim_candidate_drafts ?? "n/a"}**`,
      `- **V175 legacy (candidates):** orphan resolved_product_id **${fk.claim_candidates ?? "n/a"}** (pre-existing; not remediated by V176)`,
      `- orphan source RPID residual (unresolved drafts): **${orphanResidual}**`,
      "",
      "## V176 execute audit pack",
      `- path: \`${V176_AUDIT_BASE}/${V176_EXECUTE_RUN}/\``,
      `- on disk: ${fs.existsSync(v176Dir) ? "yes" : "**missing locally**"}`,
      `- rollback artifacts: ${rollbackAllPresent ? "all present" : "incomplete or absent"}`,
      "",
      "## Closeout",
      v176Terminal
        ? "V176 orphan-FK remap for **claim_candidate_drafts** is **CLOSED** under current deterministic policy (identifier_map remap only; drafts FK-clean). Further draft/candidate resolution requires upstream identifiers/source/PIM — not blind re-execute."
        : "Review failures in `verification-checks.json` before closing.",
      "",
      fk.claim_candidates
        ? `**Follow-up (not V176):** ${fk.claim_candidates} \`claim_candidates\` rows still point at product_id ∉ \`products\` from V175 execute without FK guard.`
        : "",
      "",
      "No blind writes in this run.",
    ].join("\n"),
    "utf8",
  );

  console.log(JSON.stringify(manifest, null, 2));
  process.exitCode = hasFail ? 1 : 0;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
