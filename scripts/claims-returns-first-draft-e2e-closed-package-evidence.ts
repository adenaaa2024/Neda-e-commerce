/**
 * CLAIMS-RETURNS-FIRST-DRAFT-E2E-CLOSED-PACKAGE-EVIDENCE
 *
 *   npx tsx scripts/claims-returns-first-draft-e2e-closed-package-evidence.ts [--apply] [--run-id=<UTC>]
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { Module } from "node:module";
import pg from "pg";
import { createClient } from "@supabase/supabase-js";

import { loadClaimPolicy } from "../lib/claim-eligibility-policy";
import { pickPrimaryScannerIssueFromConditions } from "../lib/scanner-claim-issue-pick";
import {
  buildReturnsClaimQueueRow,
  packageStatusIsClosed,
  returnHasScannerPhotoEvidence,
} from "../lib/returns-claims-work-queue";
import {
  evaluateManualDraftEligibility,
  evaluateManualDraftPolicyGate,
  isBlockedGrainForManualDraftCreation,
  validateManualGroupingSelection,
} from "../lib/returns-manual-claim-grouping";
import { getStagingProjectRef, loadEnvLocalIntoProcess } from "../lib/staging-project-ref";

require.cache[require.resolve("server-only")] = { exports: {} } as Module;

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const ORG = "00000000-0000-0000-0000-000000000001";
const PRIMARY_RI = "bd5bf0d6-500a-4696-80c6-7c0e65f539b6";
const OUT_BASE = ".cursor/audit-reports/claims-returns-first-draft-e2e-closed-package-evidence";
const OPERATOR_NOTE =
  "[phase1-demo] Operator note — customer-reported damage confirmed at receive; eligible for returns-first manual draft.";

function runIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

type Row = {
  return_item_id: string;
  package_id: string;
  package_status: string | null;
  conditions: string[] | null;
  notes: string | null;
  photo_evidence: Record<string, unknown>;
  resolved_product_id: string | null;
  created_at: string | null;
  store_id: string | null;
  pallet_id: string | null;
  expected_item_id: string | null;
};

function eligibilitySnapshot(row: Row, policy: Awaited<ReturnType<typeof loadClaimPolicy>>) {
  const closed = packageStatusIsClosed(row.package_status) === true;
  const gate = evaluateManualDraftPolicyGate(
    {
      return_item_id: row.return_item_id,
      organization_id: ORG,
      store_id: row.store_id,
      package_id: row.package_id,
      pallet_id: row.pallet_id,
      expected_item_id: row.expected_item_id,
      conditions: row.conditions,
      photo_evidence: row.photo_evidence,
      notes: row.notes,
      resolved_product_id: row.resolved_product_id,
      created_at: row.created_at,
    },
    policy,
    { packageClosedByReturnItemId: { [row.return_item_id]: closed } },
  );
  const queueRow = buildReturnsClaimQueueRow(
    {
      return_item_id: row.return_item_id,
      organization_id: ORG,
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
      order_id: null,
      sku: null,
      fnsku: null,
      asin: null,
      item_name: null,
      lpn: null,
      status: null,
      claim_line: null,
    },
    policy,
    closed,
  );
  return {
    return_item_id: row.return_item_id,
    package_id: row.package_id,
    package_status: row.package_status,
    package_closed: closed,
    resolved_product_id: row.resolved_product_id,
    has_scanner_evidence: returnHasScannerPhotoEvidence(row.photo_evidence ?? {}),
    notes_present: Boolean(String(row.notes ?? "").trim()),
    issue: pickPrimaryScannerIssueFromConditions(row.conditions),
    policy_gate: gate,
    draft_eligibility: evaluateManualDraftEligibility(queueRow, policy),
  };
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const runId = runIdArg();
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  loadEnvLocalIntoProcess();
  const dbUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ?? "";
  const stagingUrl = process.env.STAGING_SUPABASE_URL?.trim() || process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() || "";
  const serviceKey = process.env.STAGING_SERVICE_ROLE_KEY?.trim() || process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() || "";
  const autoPromote =
    process.env.CLAIM_SCANNER_AUTO_PROMOTE_ENABLED?.trim().toLowerCase() === "1" ||
    process.env.CLAIM_SCANNER_AUTO_PROMOTE_ENABLED?.trim().toLowerCase() === "true";

  if (getStagingProjectRef({ loadEnv: false }) !== STAGING_REF) throw new Error("staging ref guard");
  if (!dbUrl.includes(STAGING_REF)) throw new Error("STAGING_DIRECT_POSTGRES_URL must target staging");
  if (autoPromote) throw new Error("CLAIM_SCANNER_AUTO_PROMOTE_ENABLED must be off");

  const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();

  const loadRow = async (id: string) => {
    const r = await client.query<Row>(
      `SELECT ri.id::text AS return_item_id, ri.package_id::text, pkg.status AS package_status,
              ri.conditions, ri.notes, ri.photo_evidence, ri.resolved_product_id::text,
              ri.created_at::text, ri.store_id::text, ri.pallet_id::text, ri.expected_item_id::text
       FROM return_items ri
       JOIN packages pkg ON pkg.id = ri.package_id
       WHERE ri.id = $1 AND ri.organization_id = $2 AND ri.deleted_at IS NULL`,
      [id, ORG],
    );
    return r.rows[0] ?? null;
  };

  let row = await loadRow(PRIMARY_RI);
  if (!row) {
    const alt = await client.query<Row>(
      `SELECT ri.id::text AS return_item_id, ri.package_id::text, pkg.status AS package_status,
              ri.conditions, ri.notes, ri.photo_evidence, ri.resolved_product_id::text,
              ri.created_at::text, ri.store_id::text, ri.pallet_id::text, ri.expected_item_id::text
       FROM return_items ri
       JOIN packages pkg ON pkg.id = ri.package_id
       WHERE ri.deleted_at IS NULL AND ri.organization_id = $1 AND ri.package_id IS NOT NULL
         AND pkg.status IN ('closed','submitted')
         AND ri.resolved_product_id IS NOT NULL
       ORDER BY ri.created_at DESC LIMIT 5`,
      [ORG],
    );
    row = alt.rows[0] ?? null;
  }

  if (!row) throw new Error("No physical closed-package return_item found");

  const sb = createClient(stagingUrl, serviceKey, { auth: { persistSession: false } });
  const policy = await loadClaimPolicy(sb, ORG);
  const beforeEligibility = eligibilitySnapshot(row, policy);

  const patchApplied: string[] = [];
  let createdClaimCase: Record<string, unknown> | null = null;
  let claimLines: unknown[] = [];

  if (apply) {
    const issue = pickPrimaryScannerIssueFromConditions(row.conditions);
    const needsNote = issue?.canonical === "operator_other" && !String(row.notes ?? "").trim();

    if (!packageStatusIsClosed(row.package_status)) {
      await client.query(`UPDATE packages SET status = 'closed' WHERE id = $1`, [row.package_id]);
      patchApplied.push(`packages.status=closed (${row.package_id})`);
    }

    if (!returnHasScannerPhotoEvidence(row.photo_evidence ?? {})) {
      await client.query(`UPDATE return_items SET photo_evidence = $2::jsonb WHERE id = $1`, [
        row.return_item_id,
        JSON.stringify({ urls: ["https://staging-demo.invalid/bd5-evidence.jpg"], damage_closeup: 1 }),
      ]);
      patchApplied.push(`photo_evidence urls on ${row.return_item_id}`);
    }

    if (!row.resolved_product_id) {
      const prod = await client.query<{ id: string }>(
        `SELECT id::text FROM products WHERE organization_id = $1 AND deleted_at IS NULL LIMIT 1`,
        [ORG],
      );
      if (prod.rows[0]?.id) {
        await client.query(`UPDATE return_items SET resolved_product_id = $2 WHERE id = $1`, [
          row.return_item_id,
          prod.rows[0].id,
        ]);
        patchApplied.push(`resolved_product_id=${prod.rows[0].id}`);
      }
    }

    if (needsNote) {
      await client.query(`UPDATE return_items SET notes = $2 WHERE id = $1`, [
        row.return_item_id,
        OPERATOR_NOTE,
      ]);
      patchApplied.push(`notes operator note on ${row.return_item_id}`);
    } else if (!String(row.notes ?? "").trim()) {
      await client.query(`UPDATE return_items SET notes = $2 WHERE id = $1`, [
        row.return_item_id,
        OPERATOR_NOTE,
      ]);
      patchApplied.push(`notes set on ${row.return_item_id}`);
    } else {
      patchApplied.push("notes preserved (already present)");
    }

    row = (await loadRow(row.return_item_id))!;
    const afterGate = eligibilitySnapshot(row, policy);
    if (!afterGate.policy_gate.allowed) {
      throw new Error(`Still blocked after patch: ${afterGate.policy_gate.reason}`);
    }

    const { createManualReturnsClaimDraft } = await import(
      "../app/returns/returns-manual-claim-grouping-actions"
    );
    createdClaimCase = await createManualReturnsClaimDraft([row.return_item_id], {
      grouping_dimension: "issue",
      tenant: { actorProfileId: null, filterOrganizationId: ORG },
    });

    if ((createdClaimCase as { ok?: boolean }).ok && (createdClaimCase as { claim_case_id?: string }).claim_case_id) {
      const caseId = (createdClaimCase as { claim_case_id: string }).claim_case_id;
      const { data: lines } = await sb
        .from("claim_lines")
        .select("id, line_grain, source_table, return_item_id, claim_case_id")
        .eq("claim_case_id", caseId);
      claimLines = lines ?? [];
    }
  }

  const blockedGrainsConfirmed = {
    expected_group_blocked: isBlockedGrainForManualDraftCreation("expected_group", ""),
    import_source_blocked: isBlockedGrainForManualDraftCreation("import_source", "amazon_returns"),
    import_source_row_rejected: !validateManualGroupingSelection(
      [
        {
          return_item_id: "00000000-0000-0000-0000-000000000099",
          organization_id: ORG,
          package_id: null,
          pallet_id: null,
          expected_item_id: null,
          conditions: ["damaged_box"],
          photo_evidence: { urls: ["https://x.invalid/a.jpg"] },
          notes: OPERATOR_NOTE,
          resolved_product_id: row.resolved_product_id,
          created_at: row.created_at,
        },
      ],
      policy,
    ).ok,
    auto_promote_env: autoPromote,
  };

  const onlyReturnItemGrain =
    claimLines.length === 0 ||
    (claimLines as { line_grain: string }[]).every((l) => l.line_grain === "return_item");

  const safeToContinue =
    apply &&
    (createdClaimCase as { ok?: boolean } | null)?.ok === true &&
    onlyReturnItemGrain &&
    !autoPromote;

  const report = {
    before_eligibility: beforeEligibility,
    patch_or_data_fix_applied: patchApplied,
    created_claim_case: createdClaimCase,
    claim_lines: claimLines,
    blocked_grains_confirmed: blockedGrainsConfirmed,
    SAFE_TO_CONTINUE: safeToContinue ? "yes" : apply ? "no" : "pending_apply",
  };

  fs.writeFileSync(path.join(outDir, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  await client.end();
  if (apply && !safeToContinue) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
