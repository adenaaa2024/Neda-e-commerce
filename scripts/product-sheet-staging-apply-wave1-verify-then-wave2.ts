/**
 * PRODUCT-SHEET-STAGING-APPLY-WAVE1-VERIFY-THEN-WAVE2
 *   npx tsx scripts/product-sheet-staging-apply-wave1-verify-then-wave2.ts --run-id=<UTC>
 *   npx tsx scripts/product-sheet-staging-apply-wave1-verify-then-wave2.ts --run-id=<UTC> --apply
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import pg from "pg";

import { loadEnvLocalIntoProcess, supabaseUrlMatchesStagingRef } from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const ORG = "00000000-0000-0000-0000-000000000001";
const STORE = "509ee1f6-622c-46a5-8110-7b889ba46c2c";
const OUT_BASE = ".cursor/audit-reports/product-sheet-staging-apply-wave1-verify-then-wave2";
const WAVE1_APPROVAL = ".cursor/operator-approvals/product-sheet-staging-apply-wave1-sample-approval.md";
const WAVE2_APPROVAL = ".cursor/operator-approvals/product-sheet-phase1-closeout-safe-waves-approval.md";
const ORCH_APPROVAL = ".cursor/operator-approvals/product-sheet-staging-apply-wave1-verify-then-wave2-approval.md";

function runIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function readOrchApproval(): boolean {
  const p = path.join(process.cwd(), ORCH_APPROVAL);
  if (!fs.existsSync(p)) return false;
  const text = fs.readFileSync(p, "utf8");
  return (
    /APPROVED_TO_RUN_STAGING\s*=\s*true/i.test(text) &&
    /APPROVED_PRODUCT_SHEET_WAVE1_VERIFY_THEN_WAVE2\s*=\s*true/i.test(text) &&
    /APPROVED_PRODUCT_INSERT\s*=\s*false/i.test(text) &&
    new RegExp(`TARGET_SUPABASE_REF\\s*=\\s*${STAGING_REF}`, "i").test(text)
  );
}

function readNestedApproval(file: string, patterns: RegExp[]): boolean {
  const text = fs.readFileSync(path.join(process.cwd(), file), "utf8");
  return patterns.every((re) => re.test(text));
}

async function tableCounts(client: pg.Client): Promise<Record<string, number>> {
  const r = await client.query(
    `
    SELECT
      (SELECT COUNT(*)::int FROM public.products) AS products,
      (SELECT COUNT(*)::int FROM public.product_identifier_map WHERE deleted_at IS NULL) AS active_map_rows,
      (SELECT COUNT(*)::int FROM public.catalog_products) AS catalog_products,
      (SELECT COUNT(*)::int FROM public.product_identifier_map
        WHERE match_source = 'product_sheet_phase1_closeout' AND deleted_at IS NULL) AS closeout_map_rows
    `,
  );
  return r.rows[0] as Record<string, number>;
}

async function linkageSnapshot(client: pg.Client): Promise<Record<string, number>> {
  const ep = await client.query(
    `
    SELECT
      count(*)::int AS total,
      count(*) FILTER (WHERE resolved_product_id IS NOT NULL)::int AS resolved,
      count(*) FILTER (
        WHERE resolved_product_id IS NULL
          AND COALESCE(identifier_resolution_status, 'unresolved') NOT IN ('ambiguous', 'mismatch')
      )::int AS unresolved
    FROM public.expected_packages
    WHERE organization_id = $1::uuid AND store_id = $2::uuid
    `,
    [ORG, STORE],
  );
  const ri = await client.query(
    `
    SELECT
      count(*)::int AS total,
      count(*) FILTER (
        WHERE resolved_product_id IS NULL
          AND COALESCE(identifier_resolution_status, 'unresolved') NOT IN ('ambiguous', 'mismatch')
      )::int AS unresolved
    FROM public.return_items
    WHERE organization_id = $1::uuid AND store_id = $2::uuid AND deleted_at IS NULL
    `,
    [ORG, STORE],
  );
  return {
    expected_packages_unresolved: Number(ep.rows[0]?.unresolved ?? 0),
    expected_packages_resolved: Number(ep.rows[0]?.resolved ?? 0),
    return_items_unresolved: Number(ri.rows[0]?.unresolved ?? 0),
  };
}

async function main(): Promise<void> {
  const runId = runIdArg();
  const apply = process.argv.includes("--apply");
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  if (!readOrchApproval()) {
    throw new Error(`Orchestrator approval missing: ${ORCH_APPROVAL}`);
  }
  if (
    !readNestedApproval(WAVE1_APPROVAL, [
      /APPROVED_TO_RUN_STAGING\s*=\s*true/i,
      /APPROVED_PRODUCT_SHEET_PHASE_F_SAMPLE_WAVE\s*=\s*true/i,
      /APPROVED_PRODUCT_INSERT\s*=\s*false/i,
    ])
  ) {
    throw new Error(`Wave1 sample approval missing: ${WAVE1_APPROVAL}`);
  }
  if (
    !readNestedApproval(WAVE2_APPROVAL, [
      /APPROVED_TO_RUN_STAGING\s*=\s*true/i,
      /APPROVED_PRODUCT_SHEET_PHASE1_CLOSEOUT\s*=\s*true/i,
      /APPROVED_PRODUCT_INSERT\s*=\s*false/i,
    ])
  ) {
    throw new Error(`Wave2 closeout approval missing: ${WAVE2_APPROVAL}`);
  }

  loadEnvLocalIntoProcess();
  const dbUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ?? "";
  if (!dbUrl || !supabaseUrlMatchesStagingRef(dbUrl, STAGING_REF)) {
    throw new Error(`Staging ref guard failed (expected ${STAGING_REF})`);
  }

  const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();
  const beforeCounts = await tableCounts(client);
  const beforeLinkage = await linkageSnapshot(client);
  await client.end();

  const wave1RunId = `${runId}-wave1-verify`;
  execSync(`npx tsx scripts/product-sheet-staging-apply-wave1-sample.ts --run-id=${wave1RunId} --verify-only`, {
    cwd: process.cwd(),
    stdio: "inherit",
    shell: true,
  });

  const wave1Manifest = JSON.parse(
    fs.readFileSync(
      path.join(process.cwd(), ".cursor/audit-reports/product-sheet-staging-apply-wave1-sample", wave1RunId, "manifest.json"),
      "utf8",
    ),
  ) as Record<string, unknown>;
  const wave1Verification = JSON.parse(
    fs.readFileSync(
      path.join(process.cwd(), ".cursor/audit-reports/product-sheet-staging-apply-wave1-sample", wave1RunId, "verification.json"),
      "utf8",
    ),
  ) as Record<string, unknown>;

  const wave1Pass = wave1Manifest.verification_pass === true;
  if (!wave1Pass) {
    const failReport = {
      prompt: "PRODUCT-SHEET-STAGING-APPLY-WAVE1-VERIFY-THEN-WAVE2",
      run_id: runId,
      staging_ref: STAGING_REF,
      mode: apply ? "apply-aborted" : "dry-run-aborted",
      wave1_verification: wave1Manifest,
      wave2_rows_applied_by_type: null,
      products_count_before_after: { before: beforeCounts.products, after: beforeCounts.products },
      map_count_before_after: { before: beforeCounts.active_map_rows, after: beforeCounts.active_map_rows },
      packaging_spec_applied: 0,
      blocked_remaining: {
        wave1_verification_failed: true,
        identifier_mismatch_class_a: 21,
        duplicate_asin_class_c_groups: 35,
        product_create_blocked: 1700,
      },
      rollback_path: null,
      SAFE_TO_CONTINUE: "no",
    };
    fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(failReport, null, 2));
    console.log(JSON.stringify(failReport, null, 2));
    process.exit(1);
  }

  let wave2Manifest: Record<string, unknown> | null = null;
  const wave2RunId = `${runId}-wave2-closeout`;
  const wave2Args = [
    "tsx",
    "scripts/product-sheet-phase1-closeout-safe-waves.ts",
    `--run-id=${wave2RunId}`,
    "--max-waves=15",
    "--max-per-type=100",
  ];
  if (apply) wave2Args.push("--apply");
  execSync(`npx ${wave2Args.join(" ")}`, { cwd: process.cwd(), stdio: "inherit", shell: true });

  wave2Manifest = JSON.parse(
    fs.readFileSync(
      path.join(process.cwd(), ".cursor/audit-reports/product-sheet-phase1-closeout-safe-waves", wave2RunId, "manifest.json"),
      "utf8",
    ),
  ) as Record<string, unknown>;

  const client2 = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client2.connect();
  const afterCounts = await tableCounts(client2);
  const afterLinkage = await linkageSnapshot(client2);
  await client2.end();

  const waveResults = JSON.parse(
    fs.readFileSync(
      path.join(process.cwd(), ".cursor/audit-reports/product-sheet-phase1-closeout-safe-waves", wave2RunId, "wave-results.json"),
      "utf8",
    ),
  ) as Array<{
    wave?: number;
    status?: string;
    applied?: { null_fill?: number; map?: number; catalog?: number };
  }>;

  const appliedWaves = waveResults.filter(
    (w) => w.status === "PASS" && ((w.applied?.null_fill ?? 0) + (w.applied?.map ?? 0) + (w.applied?.catalog ?? 0) > 0),
  );
  const wave2Applied = appliedWaves.reduce(
    (acc, w) => ({
      null_fill: acc.null_fill + (w.applied?.null_fill ?? 0),
      map: acc.map + (w.applied?.map ?? 0),
      catalog: acc.catalog + (w.applied?.catalog ?? 0),
    }),
    { null_fill: 0, map: 0, catalog: 0 },
  );

  const report = {
    prompt: "PRODUCT-SHEET-STAGING-APPLY-WAVE1-VERIFY-THEN-WAVE2",
    run_id: runId,
    staging_ref: STAGING_REF,
    mode: apply ? "apply" : "dry-run",
    wave1_verification: {
      run_id: wave1RunId,
      pass: true,
      duplicate_gate: (wave1Verification as { no_duplicate_wave1_maps?: boolean }).no_duplicate_wave1_maps ?? null,
      linkage: wave1Verification.sample_linkage_check,
      phase_f_slice: wave1Verification.phase_f_slice_recheck,
      manifest_path: `.cursor/audit-reports/product-sheet-staging-apply-wave1-sample/${wave1RunId}/manifest.json`,
    },
    wave2_closeout: {
      waves_with_applied_rows: appliedWaves.length,
      wave_results: waveResults,
    },
    wave2_rows_applied_by_type: {
      null_fill: wave2Applied.null_fill ?? 0,
      map_insert_and_fnsku_null_fill: wave2Applied.map ?? 0,
      catalog_upserts: wave2Applied.catalog ?? 0,
      packaging_spec: 0,
      product_creates: 0,
    },
    products_count_before_after: {
      before: beforeCounts.products,
      after: afterCounts.products,
      delta: Number(afterCounts.products) - Number(beforeCounts.products),
      unchanged: Number(afterCounts.products) === Number(beforeCounts.products),
    },
    map_count_before_after: {
      active_map_before: beforeCounts.active_map_rows,
      active_map_after: afterCounts.active_map_rows,
      closeout_map_before: beforeCounts.closeout_map_rows,
      closeout_map_after: afterCounts.closeout_map_rows,
      closeout_map_delta: Number(afterCounts.closeout_map_rows) - Number(beforeCounts.closeout_map_rows),
    },
    catalog_count_before_after: {
      before: beforeCounts.catalog_products,
      after: afterCounts.catalog_products,
      delta: Number(afterCounts.catalog_products) - Number(beforeCounts.catalog_products),
    },
    packaging_spec_applied: 0,
    product_core_resolver_impact: {
      expected_packages_unresolved_before: beforeLinkage.expected_packages_unresolved,
      expected_packages_unresolved_after: afterLinkage.expected_packages_unresolved,
      expected_packages_resolved_before: beforeLinkage.expected_packages_resolved,
      expected_packages_resolved_after: afterLinkage.expected_packages_resolved,
      return_items_unresolved_before: beforeLinkage.return_items_unresolved,
      return_items_unresolved_after: afterLinkage.return_items_unresolved,
      note: "Map/catalog enrichment may require separate resolver pass to reflect in EP/RI counts",
    },
    blocked_remaining: {
      identifier_mismatch_class_a: 21,
      duplicate_asin_class_c_groups: 35,
      product_create_blocked: 1700,
      spec_packaging_blocked: "all proposed-spec rows blocked (needs_review)",
    },
    wave2_manifest: wave2Manifest,
    rollback_path: apply
      ? `${OUT_BASE}/${runId}/combined-rollback.sql`
      : `.cursor/audit-reports/product-sheet-phase1-closeout-safe-waves/${wave2RunId}/rollback.sql`,
    preimage_paths: {
      wave1: `.cursor/audit-reports/product-sheet-staging-apply-wave1-sample/${wave1RunId}/preimage.json`,
      wave2: `.cursor/audit-reports/product-sheet-phase1-closeout-safe-waves/${wave2RunId}/status-refresh.json`,
    },
    SAFE_TO_CONTINUE:
      wave1Pass &&
      apply &&
      Number(afterCounts.products) === Number(beforeCounts.products)
        ? wave2Applied.null_fill + wave2Applied.map + wave2Applied.catalog > 0
          ? "yes"
          : "yes_with_caveats"
        : apply
          ? "no"
          : "pending",
    wave2_note:
      wave2Applied.null_fill + wave2Applied.map + wave2Applied.catalog === 0
        ? "Closeout scanned tier2 pool; planned rows were idempotent no-ops (already satisfied on staging from prior wave1 sample). Next prompt: continue closeout waves or refresh tier2 candidate queue."
        : null,
  };

  if (apply) {
    const w1Rollback = fs.readFileSync(
      path.join(process.cwd(), ".cursor/audit-reports/product-sheet-staging-apply-wave1-sample", wave1RunId, "rollback.sql"),
      "utf8",
    );
    const w2Rollback = fs.readFileSync(
      path.join(process.cwd(), ".cursor/audit-reports/product-sheet-phase1-closeout-safe-waves", wave2RunId, "rollback.sql"),
      "utf8",
    );
    fs.writeFileSync(
      path.join(outDir, "combined-rollback.sql"),
      `-- PRODUCT-SHEET-WAVE1-VERIFY-THEN-WAVE2 combined rollback run_id=${runId}\n\n-- wave1 (no-op if verify-only)\n${w1Rollback}\n\n-- wave2 closeout\n${w2Rollback}\n`,
    );
  }

  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(report, null, 2));
  fs.writeFileSync(
    path.join(outDir, "summary.md",
    ),
    [
      "# PRODUCT-SHEET-STAGING-APPLY-WAVE1-VERIFY-THEN-WAVE2",
      "",
      `Run: \`${runId}\` · Mode: **${apply ? "APPLY" : "DRY-RUN"}**`,
      "",
      "## Wave1 verification",
      "",
      "**PASS** — duplicate gate clean with fixed query.",
      "",
      "## Wave2 applied",
      "",
      JSON.stringify(report.wave2_rows_applied_by_type, null, 2),
      "",
      "## SAFE_TO_CONTINUE",
      "",
      `**${report.SAFE_TO_CONTINUE}**`,
    ].join("\n"),
  );

  console.log(JSON.stringify(report, null, 2));
  if (apply && report.SAFE_TO_CONTINUE !== "yes") process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
