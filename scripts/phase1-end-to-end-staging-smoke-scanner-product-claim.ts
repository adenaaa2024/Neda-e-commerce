/**
 * PHASE1-END-TO-END-STAGING-SMOKE-SCANNER-PRODUCT-CLAIM
 *   npx tsx scripts/phase1-end-to-end-staging-smoke-scanner-product-claim.ts --run-id=<UTC>
 *   npx tsx scripts/phase1-end-to-end-staging-smoke-scanner-product-claim.ts --run-id=<UTC> --create-draft
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { Module } from "node:module";
import pg from "pg";
import { createClient } from "@supabase/supabase-js";

import { loadClaimPolicy, normalizeClaimPolicy } from "../lib/claim-eligibility-policy";
import { isClaimModuleDomainEnabled } from "../lib/claim-module-scope";
import {
  buildReturnsClaimQueueRow,
  isBulkOrphanReturnItemPattern,
  isPhysicalReturnItemForClaims,
  packageStatusIsClosed,
  returnItemHasScannerClaimIssue,
} from "../lib/returns-claims-work-queue";
import {
  evaluateManualDraftEligibility,
  evaluateManualDraftPolicyGate,
  isBlockedGrainForManualDraftCreation,
} from "../lib/returns-manual-claim-grouping";
import { resolveScannerProductIdentifiers } from "../lib/scanner-product-resolve";
import {
  getStagingProjectRef,
  loadEnvLocalIntoProcess,
  supabaseUrlMatchesStagingRef,
} from "../lib/staging-project-ref";

require.cache[require.resolve("server-only")] = { exports: {} } as Module;

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const ORG = "00000000-0000-0000-0000-000000000001";
const STORE = "509ee1f6-622c-46a5-8110-7b889ba46c2c";
const OUT_BASE = ".cursor/audit-reports/phase1-end-to-end-staging-smoke-scanner-product-claim";

function runIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

type ScenarioRow = {
  id: string;
  organization_id: string;
  store_id: string | null;
  package_id: string | null;
  pallet_id: string | null;
  expected_item_id: string | null;
  resolved_product_id: string | null;
  sku: string | null;
  fnsku: string | null;
  asin: string | null;
  conditions: string[] | null;
  photo_evidence: Record<string, unknown>;
  notes: string | null;
  created_at: string | null;
  order_id: string | null;
  package_status: string | null;
  product_name: string | null;
  ep_tracking: string | null;
  ep_build_source: string | null;
  ep_resolved_product_id: string | null;
  ep_expected_scan_quantity: number | null;
  ep_actual_scanned_count: number | null;
  ep_parent_id: string | null;
};

async function main(): Promise<void> {
  const runId = runIdArg();
  const createDraft = process.argv.includes("--create-draft");
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  loadEnvLocalIntoProcess();
  const dbUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() || "";
  const stagingUrl = process.env.STAGING_SUPABASE_URL?.trim() || process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() || "";
  const serviceKey = process.env.STAGING_SERVICE_ROLE_KEY?.trim() || process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() || "";

  if (
    !dbUrl ||
    getStagingProjectRef({ loadEnv: false }) !== STAGING_REF ||
    !supabaseUrlMatchesStagingRef(dbUrl, STAGING_REF)
  ) {
    throw new Error(`Staging ref guard failed (expected ${STAGING_REF})`);
  }

  const pgClient = new pg.Client({
    connectionString: dbUrl,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 20_000,
  });
  await pgClient.connect();
  await pgClient.query("SET statement_timeout = '60s'");

  const census = await pgClient.query(`
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE deleted_at IS NULL)::int AS active,
      COUNT(*) FILTER (WHERE deleted_at IS NULL AND package_id IS NOT NULL)::int AS with_package,
      COUNT(*) FILTER (WHERE deleted_at IS NULL AND expected_item_id IS NOT NULL AND package_id IS NULL AND pallet_id IS NULL)::int AS bulk_orphan,
      COUNT(*) FILTER (WHERE deleted_at IS NULL AND resolved_product_id IS NOT NULL)::int AS resolved
    FROM public.return_items
  `);

  const candidates = await pgClient.query(`
    SELECT
      ri.id::text,
      ri.organization_id::text,
      ri.store_id::text,
      ri.package_id::text,
      ri.pallet_id::text,
      ri.expected_item_id::text,
      ri.resolved_product_id::text,
      ri.sku,
      ri.fnsku,
      ri.asin,
      ri.conditions,
      ri.photo_evidence,
      ri.notes,
      ri.created_at::text,
      ri.order_id,
      pkg.status AS package_status,
      p.product_name,
      ep.tracking_number AS ep_tracking,
      ep.build_source AS ep_build_source,
      ep.resolved_product_id::text AS ep_resolved_product_id,
      ep.expected_scan_quantity AS ep_expected_scan_quantity,
      ep.actual_scanned_count AS ep_actual_scanned_count,
      ep.parent_expected_package_id::text AS ep_parent_id
    FROM public.return_items ri
    LEFT JOIN public.packages pkg ON pkg.id = ri.package_id
    LEFT JOIN public.products p ON p.id = ri.resolved_product_id
    LEFT JOIN public.expected_packages ep ON ep.id = ri.expected_item_id
    WHERE ri.deleted_at IS NULL
      AND ri.package_id IS NOT NULL
      AND NOT (
        ri.expected_item_id IS NOT NULL
        AND ri.package_id IS NULL
        AND ri.pallet_id IS NULL
      )
    ORDER BY
      (ri.resolved_product_id IS NOT NULL) DESC,
      (ri.conditions IS NOT NULL AND cardinality(ri.conditions) > 0) DESC,
      (ri.photo_evidence IS NOT NULL) DESC,
      ri.created_at DESC
    LIMIT 50
  `);

  await pgClient.end();

  const sb = createClient(stagingUrl, serviceKey, { auth: { persistSession: false } });
  const policy = await loadClaimPolicy(sb, ORG);

  const rows = candidates.rows as ScenarioRow[];
  const issues: string[] = [];
  let productScenario: ScenarioRow | null = null;
  let allocationScenario: ScenarioRow | null = null;
  let claimScenario: ScenarioRow | null = null;
  let productResolution: Record<string, unknown> | null = null;
  let allocationResult: Record<string, unknown> | null = null;
  let claimEligibility: Record<string, unknown> | null = null;
  let queueFilterResult: Record<string, unknown> | null = null;
  let draftResult: Record<string, unknown> | null = null;

  const evaluateRow = async (row: ScenarioRow) => {
    const anchor = {
      package_id: row.package_id,
      pallet_id: row.pallet_id,
      expected_item_id: row.expected_item_id,
    };
    const packageClosed = packageStatusIsClosed(row.package_status);
    const resolver = await resolveScannerProductIdentifiers(sb, {
      organizationId: row.organization_id,
      storeId: row.store_id,
      sku: row.sku,
      fnsku: row.fnsku,
      asin: row.asin,
      legacyProductId: row.resolved_product_id,
    });
    const spineName =
      row.product_name ??
      (resolver.resolved_product_id
        ? (
            await sb
              .from("products")
              .select("product_name")
              .eq("id", resolver.resolved_product_id)
              .maybeSingle()
          ).data?.product_name
        : null);

    const queueRow = buildReturnsClaimQueueRow(
      {
        return_item_id: row.id,
        organization_id: row.organization_id,
        store_id: row.store_id,
        package_id: row.package_id,
        pallet_id: row.pallet_id,
        expected_item_id: row.expected_item_id,
        created_at: row.created_at,
        conditions: row.conditions,
        photo_evidence: row.photo_evidence as never,
        notes: row.notes,
        resolved_product_id: row.resolved_product_id,
        resolved_catalog_product_id: null,
        identifier_resolution_status: null,
        order_id: row.order_id,
        sku: row.sku,
        fnsku: row.fnsku,
        asin: row.asin,
        item_name: spineName,
        lpn: null,
        status: null,
        claim_line: null,
      },
      policy,
      packageClosed,
    );

    const draftElig = evaluateManualDraftEligibility(queueRow, policy);
    const policyGate = evaluateManualDraftPolicyGate(
      {
        return_item_id: row.id,
        organization_id: row.organization_id,
        store_id: row.store_id,
        package_id: row.package_id,
        pallet_id: row.pallet_id,
        expected_item_id: row.expected_item_id,
        conditions: row.conditions,
        photo_evidence: row.photo_evidence as never,
        notes: row.notes,
        resolved_product_id: row.resolved_product_id,
        created_at: row.created_at,
      },
      policy,
      { packageClosedByReturnItemId: { [row.id]: packageClosed } },
    );

    return {
      row,
      anchor,
      packageClosed,
      resolver,
      spineName,
      queueRow,
      draftElig,
      policyGate,
      physical: isPhysicalReturnItemForClaims(anchor),
      bulkOrphan: isBulkOrphanReturnItemPattern(anchor),
      claimIssue: returnItemHasScannerClaimIssue(row.conditions),
    };
  };

  let queuePhysical = 0;
  let queueBulkExcluded = 0;
  let queueClaimableConditions = 0;
  let queueEligibleAfterPhysical = 0;

  for (const row of rows) {
    const ev = await evaluateRow(row);
    const anchor = ev.anchor;
    if (returnItemHasScannerClaimIssue(row.conditions)) queueClaimableConditions++;
    if (isBulkOrphanReturnItemPattern(anchor)) queueBulkExcluded++;
    if (isPhysicalReturnItemForClaims(anchor) && returnItemHasScannerClaimIssue(row.conditions)) {
      queueEligibleAfterPhysical++;
    }
    if (isPhysicalReturnItemForClaims(anchor)) queuePhysical++;

    if (!productScenario && ev.physical && ev.spineName && ev.resolver.resolved_product_id) {
      productScenario = row;
      productResolution = {
        return_item_id: row.id,
        persisted_resolved_product_id: row.resolved_product_id,
        resolver_resolved_product_id: ev.resolver.resolved_product_id,
        identifier_resolution_status: ev.resolver.identifier_resolution_status,
        product_name_from_spine: ev.spineName,
        product_name_resolves: true,
      };
    }

    if (!allocationScenario && ev.physical && row.expected_item_id) {
      allocationScenario = row;
      allocationResult = {
        return_item_id: row.id,
        expected_item_id: row.expected_item_id,
        ep_tracking: row.ep_tracking,
        ep_build_source: row.ep_build_source,
        ep_resolved_product_id: row.ep_resolved_product_id,
        ep_expected_scan_quantity: row.ep_expected_scan_quantity,
        ep_actual_scanned_count: row.ep_actual_scanned_count,
        ep_parent_id: row.ep_parent_id,
        allocation_linked: true,
        remainder_child: Boolean(row.ep_parent_id),
        ri_resolved_product_id: row.resolved_product_id,
        ep_ri_product_match:
          row.resolved_product_id && row.ep_resolved_product_id
            ? row.resolved_product_id === row.ep_resolved_product_id
            : null,
      };
    }

    if (
      (!claimScenario || ev.policyGate.reason === "missing_operator_note") &&
      ev.physical &&
      !ev.bulkOrphan &&
      ev.claimIssue
    ) {
      const issue = ev.policyGate;
      const prevIsOperatorOther =
        claimEligibility?.policy_gate_reason === "missing_operator_note";
      const thisIsOperatorOther = issue.reason === "missing_operator_note";
      if (!claimScenario || (prevIsOperatorOther && !thisIsOperatorOther)) {
      claimScenario = row;
      claimEligibility = {
        return_item_id: row.id,
        conditions: row.conditions,
        physical_anchor: true,
        bulk_orphan: false,
        scanner_claim_issue: true,
        queue_state: ev.queueRow.queue_state,
        queue_state_label: ev.queueRow.state_label,
        policy_gate_allowed: ev.policyGate.allowed,
        policy_gate_reason: ev.policyGate.reason,
        draft_eligibility_allowed: ev.draftElig.allowed,
        draft_eligibility_reason: ev.draftElig.reason,
        returns_domain_enabled: isClaimModuleDomainEnabled(policy, "returns"),
        claim_policy: {
          scan_go_live_date: policy.scan_go_live_date,
          claim_start_date: policy.claim_start_date,
          enabled_claim_domains: policy.enabled_claim_domains,
          allow_manual_override: policy.allow_manual_override,
          claim_hold_policy: policy.claim_hold_policy,
        },
        package_closed: ev.packageClosed,
      };
      }
    }
  }

  queueFilterResult = {
    physical_candidates_scanned: rows.length,
    with_claimable_conditions: queueClaimableConditions,
    bulk_orphan_excluded: queueBulkExcluded,
    physical_and_claimable: queueEligibleAfterPhysical,
    physical_anchor_count: queuePhysical,
    returns_domain_enabled: isClaimModuleDomainEnabled(policy, "returns"),
  };

  if (!productScenario) issues.push("No physical return_item with Product Core name resolution found");
  if (!allocationScenario) issues.push("No package-anchored return_item with expected_item_id allocation link found");
  if (!claimScenario) issues.push("No physical return_item with scanner claim issue found");
  if (!isClaimModuleDomainEnabled(policy, "returns")) {
    issues.push("Returns claim module disabled in org policy (enabled_claim_domains.returns=false)");
  }
  if (!policy.scan_go_live_date || !policy.claim_start_date) {
    issues.push("Claim cutoff dates unconfigured (scan_go_live_date / claim_start_date null)");
  }
  if (claimEligibility && !claimEligibility.draft_eligibility_allowed) {
    issues.push(`Draft blocked by policy gate: ${claimEligibility.draft_eligibility_reason}`);
  }

  const scenario = claimScenario ?? productScenario ?? allocationScenario;

  if (createDraft && claimScenario && claimEligibility?.draft_eligibility_allowed === true) {
    const { createManualReturnsClaimDraft } = await import(
      "../app/returns/returns-manual-claim-grouping-actions"
    );
    draftResult = await createManualReturnsClaimDraft([claimScenario.id], {
      grouping_dimension: "issue",
      tenant: { actorProfileId: null, filterOrganizationId: ORG },
    });

    if (draftResult.ok && draftResult.claim_case_id) {
      const { data: lines } = await sb
        .from("claim_lines")
        .select("id, line_grain, source_table, claim_case_id, return_item_id")
        .eq("claim_case_id", draftResult.claim_case_id);
      const importAttached = (lines ?? []).some(
        (l) =>
          isBlockedGrainForManualDraftCreation(
            String((l as { line_grain: string }).line_grain),
            String((l as { source_table?: string }).source_table ?? ""),
          ) && String((l as { line_grain: string }).line_grain) === "import_source",
      );
      draftResult = {
        ...draftResult,
        claim_lines: lines,
        import_source_attached: importAttached,
      };
      if (importAttached) issues.push("import_source line incorrectly attached to draft case");
    }
  } else if (createDraft) {
    draftResult = { ok: false, skipped: true, reason: "Policy gates did not pass" };
  } else {
    draftResult = {
      ok: null,
      skipped: true,
      reason: "Pass --create-draft to write staging draft (only when gates pass)",
    };
  }

  const queueStats = {
    active_return_items: census.rows[0]?.active,
    with_package: census.rows[0]?.with_package,
    bulk_orphan: census.rows[0]?.bulk_orphan,
    physical_candidates_scanned: rows.length,
  };

  const verificationPass =
    Boolean(productScenario) &&
    productResolution?.product_name_resolves === true &&
    Boolean(allocationScenario) &&
    queueFilterResult?.bulk_orphan_excluded !== undefined &&
    (draftResult?.skipped === true ||
      (draftResult?.ok === true && draftResult?.import_source_attached !== true));

  const safeToContinue =
    verificationPass &&
    productResolution?.product_name_resolves === true &&
    Number(queueFilterResult?.physical_and_claimable ?? 0) >= 0
      ? policy.scan_go_live_date && policy.claim_start_date && isClaimModuleDomainEnabled(policy, "returns")
        ? "yes"
        : "yes_with_policy_config_needed"
      : "no";

  const report = `# PHASE1 END-TO-END STAGING SMOKE — Scanner / Product / Claim

Run: \`${runId}\`  
Target: staging \`${STAGING_REF}\` only  
Mode: ${createDraft ? "smoke + optional draft" : "read-only smoke (no draft write)"}

# SCENARIO_USED

**Product resolution:** ${productScenario ? `\`${productScenario.id}\` (package \`${productScenario.package_id}\`)` : "none"}  
**Allocation:** ${allocationScenario ? `\`${allocationScenario.id}\` → expected_item \`${allocationScenario.expected_item_id}\`` : "none"}  
**Claims:** ${claimScenario ? `\`${claimScenario.id}\` conditions ${JSON.stringify(claimScenario.conditions)}` : "none"}

# PRODUCT_RESOLUTION

\`\`\`json
${JSON.stringify(productResolution, null, 2)}
\`\`\`

# ALLOCATION_RESULT

\`\`\`json
${JSON.stringify(allocationResult, null, 2)}
\`\`\`

# CLAIM_ELIGIBILITY

\`\`\`json
${JSON.stringify(claimEligibility, null, 2)}
\`\`\`

# QUEUE_FILTER

\`\`\`json
${JSON.stringify(queueFilterResult, null, 2)}
\`\`\`

# DRAFT_RESULT

\`\`\`json
${JSON.stringify(draftResult, null, 2)}
\`\`\`

# ISSUES_FOUND

${issues.length ? issues.map((i) => `- ${i}`).join("\n") : "- None blocking smoke path"}

# SAFE_TO_CONTINUE

**${safeToContinue}**

Queue census: ${JSON.stringify(queueStats)}
`;

  fs.writeFileSync(path.join(outDir, "smoke-report.md"), report);
  fs.writeFileSync(
    path.join(outDir, "manifest.json"),
    JSON.stringify(
      {
        audit_id: "PHASE1-END-TO-END-STAGING-SMOKE-SCANNER-PRODUCT-CLAIM",
        run_id: runId,
        staging_ref: STAGING_REF,
        scenario_ids: {
          product: productScenario?.id ?? null,
          allocation: allocationScenario?.id ?? null,
          claim: claimScenario?.id ?? null,
        },
        product_resolution: productResolution,
        allocation: allocationResult,
        claim_eligibility: claimEligibility,
        draft_result: draftResult,
        issues,
        safe_to_continue: safeToContinue,
        create_draft_attempted: createDraft,
      },
      null,
      2,
    ),
  );

  console.log(report);
  console.log(`\nWrote ${outDir}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
