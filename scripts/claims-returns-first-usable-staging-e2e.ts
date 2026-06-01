/**
 * CLAIMS-RETURNS-FIRST-USABLE-STAGING-E2E — prepare one demo scenario + manual draft.
 *
 *   npx tsx scripts/claims-returns-first-usable-staging-e2e.ts [--apply] [--run-id=<UTC>]
 */
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Module } from "node:module";
import pg from "pg";
import { createClient } from "@supabase/supabase-js";

import { loadClaimPolicy } from "../lib/claim-eligibility-policy";
import { pickPrimaryScannerIssueFromConditions } from "../lib/scanner-claim-issue-pick";
import {
  buildReturnsClaimQueueRow,
  isPhysicalReturnItemForClaims,
  packageStatusIsClosed,
  returnHasScannerPhotoEvidence,
  returnItemHasScannerClaimIssue,
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
const ORIGINAL_REF = "kxsvedvpjldygtdbylsy";
const REQUIRED_BRANCH = "feature/phase1-latest-stash-land";
const APPROVAL_PATH = ".cursor/operator-approvals/claims-returns-first-usable-staging-e2e-approval.md";
const OUT_BASE = ".cursor/audit-reports/claims-returns-first-usable-staging-e2e";
const ORG = "00000000-0000-0000-0000-000000000001";

const DEMO_NOTE = "[phase1-demo] Operator note for returns-first staging E2E.";
const DEMO_EVIDENCE = {
  front: { url: "https://staging-demo.invalid/evidence-front.jpg", captured_at: "2026-06-01T12:00:00Z" },
} as const;

function runIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function readApproval(): boolean {
  const text = fs.readFileSync(path.join(process.cwd(), APPROVAL_PATH), "utf8");
  return (
    /APPROVED_TO_RUN_STAGING\s*=\s*true/i.test(text) &&
    /APPROVED_CLAIMS_RETURNS_FIRST_USABLE_STAGING_E2E\s*=\s*true/i.test(text)
  );
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

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const runId = runIdArg();
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  loadEnvLocalIntoProcess();
  const branch = execSync("git branch --show-current", { encoding: "utf8" }).trim();
  const dbUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ?? "";
  const stagingUrl = process.env.STAGING_SUPABASE_URL?.trim() || process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() || "";
  const serviceKey = process.env.STAGING_SERVICE_ROLE_KEY?.trim() || process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() || "";
  const autoPromote =
    process.env.CLAIM_SCANNER_AUTO_PROMOTE_ENABLED?.trim().toLowerCase() === "1" ||
    process.env.CLAIM_SCANNER_AUTO_PROMOTE_ENABLED?.trim().toLowerCase() === "true";

  const blockers: string[] = [];
  if (branch !== REQUIRED_BRANCH) blockers.push(`Branch must be ${REQUIRED_BRANCH}`);
  if (!readApproval()) blockers.push(`Missing approval: ${APPROVAL_PATH}`);
  if (getStagingProjectRef({ loadEnv: false }) !== STAGING_REF) blockers.push("Staging ref guard");
  if (!dbUrl.includes(STAGING_REF)) blockers.push("STAGING_DIRECT_POSTGRES_URL must target staging");
  if (dbUrl.includes(ORIGINAL_REF)) blockers.push("BLOCKED: original ref");
  if (autoPromote) blockers.push("CLAIM_SCANNER_AUTO_PROMOTE_ENABLED must be off");

  const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  const actions: string[] = [];
  let scenario: Record<string, unknown> = {};
  let eligibilityBefore: Record<string, unknown> = {};
  let createdDraft: Record<string, unknown> | null = null;
  let claimLines: unknown[] = [];
  let blockedGrainsConfirmation: Record<string, unknown> = {};

  try {
    if (!blockers.length) await client.connect();

    const candidates = blockers.length
      ? []
      : (
          await client.query<Row>(
            `SELECT ri.id::text AS return_item_id, ri.package_id::text, pkg.status AS package_status,
                    ri.conditions, ri.notes, ri.photo_evidence, ri.resolved_product_id::text,
                    ri.created_at::text, ri.store_id::text, ri.pallet_id::text, ri.expected_item_id::text
             FROM return_items ri
             JOIN packages pkg ON pkg.id = ri.package_id
             WHERE ri.deleted_at IS NULL AND ri.organization_id = $1 AND ri.package_id IS NOT NULL
             ORDER BY (ri.resolved_product_id IS NOT NULL) DESC,
                      (ri.conditions && ARRAY['damaged_box','wrong_item_different','damaged_product']::text[]) DESC,
                      ri.created_at DESC
             LIMIT 20`,
            [ORG],
          )
        ).rows;

    const sb = createClient(stagingUrl, serviceKey, { auth: { persistSession: false } });
    const policy = blockers.length ? null : await loadClaimPolicy(sb, ORG);

    const score = (r: Row) => {
      const issue = pickPrimaryScannerIssueFromConditions(r.conditions);
      const claimable = returnItemHasScannerClaimIssue(r.conditions);
      const resolved = Boolean(r.resolved_product_id);
      const closed = packageStatusIsClosed(r.package_status) === true;
      return (claimable ? 10 : 0) + (resolved ? 5 : 0) + (closed ? 8 : 0) + (issue?.canonical !== "operator_other" ? 2 : 0);
    };

    const pick = [...candidates].sort((a, b) => score(b) - score(a))[0] ?? null;

    if (!pick) blockers.push("No physical return_item candidate found");

    if (pick && policy) {
      const gateBefore = (row: Row, closed: boolean) =>
        evaluateManualDraftPolicyGate(
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

      const closedBefore = packageStatusIsClosed(pick.package_status) === true;
      eligibilityBefore = {
        return_item_id: pick.return_item_id,
        package_id: pick.package_id,
        package_status: pick.package_status,
        package_closed: closedBefore,
        conditions: pick.conditions,
        resolved_product_id: pick.resolved_product_id,
        issue: pickPrimaryScannerIssueFromConditions(pick.conditions),
        policy_gate: gateBefore(pick, closedBefore),
        queue: buildReturnsClaimQueueRow(
          {
            return_item_id: pick.return_item_id,
            organization_id: ORG,
            store_id: pick.store_id,
            package_id: pick.package_id,
            pallet_id: pick.pallet_id,
            expected_item_id: pick.expected_item_id,
            created_at: pick.created_at,
            conditions: pick.conditions,
            photo_evidence: pick.photo_evidence as never,
            notes: pick.notes,
            resolved_product_id: pick.resolved_product_id,
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
          closedBefore,
        ),
        draft_eligibility: evaluateManualDraftEligibility(
          buildReturnsClaimQueueRow(
            {
              return_item_id: pick.return_item_id,
              organization_id: ORG,
              store_id: pick.store_id,
              package_id: pick.package_id,
              pallet_id: pick.pallet_id,
              expected_item_id: pick.expected_item_id,
              created_at: pick.created_at,
              conditions: pick.conditions,
              photo_evidence: pick.photo_evidence as never,
              notes: pick.notes,
              resolved_product_id: pick.resolved_product_id,
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
            closedBefore,
          ),
          policy,
        ),
      };

      scenario = {
        return_item_id: pick.return_item_id,
        package_id: pick.package_id,
        organization_id: ORG,
        label: "phase1_returns_first_demo",
      };

      if (apply) {
        const issue = pickPrimaryScannerIssueFromConditions(pick.conditions);
        const needsNote = issue?.canonical === "operator_other";
        const needsEvidence = true;

        if (needsNote && !String(pick.notes ?? "").trim()) {
          await client.query(`UPDATE return_items SET notes = $2 WHERE id = $1`, [
            pick.return_item_id,
            DEMO_NOTE,
          ]);
          actions.push(`SET notes on return_item ${pick.return_item_id}`);
        } else if (needsNote) {
          actions.push("notes already present");
        }

        if (needsEvidence && !returnHasScannerPhotoEvidence(pick.photo_evidence ?? {})) {
          const evidencePayload = {
            urls: ["https://staging-demo.invalid/phase1-evidence.jpg"],
            damage_closeup: 1,
          };
          await client.query(`UPDATE return_items SET photo_evidence = $2::jsonb WHERE id = $1`, [
            pick.return_item_id,
            JSON.stringify(evidencePayload),
          ]);
          actions.push(`SET photo_evidence (urls) on return_item ${pick.return_item_id}`);
        } else {
          actions.push("photo_evidence already sufficient");
        }

        if (!closedBefore) {
          await client.query(`UPDATE packages SET status = 'closed' WHERE id = $1`, [pick.package_id]);
          actions.push(`SET packages.status=closed for ${pick.package_id}`);
        } else {
          actions.push("package already closed");
        }

        if (!pick.resolved_product_id) {
          const prod = await client.query<{ id: string }>(
            `SELECT id::text FROM products WHERE organization_id = $1 AND deleted_at IS NULL LIMIT 1`,
            [ORG],
          );
          if (prod.rows[0]?.id) {
            await client.query(`UPDATE return_items SET resolved_product_id = $2 WHERE id = $1`, [
              pick.return_item_id,
              prod.rows[0].id,
            ]);
            actions.push(`SET resolved_product_id=${prod.rows[0].id}`);
          }
        }

        const refreshed = (
          await client.query<Row>(
            `SELECT ri.id::text AS return_item_id, ri.package_id::text, pkg.status AS package_status,
                    ri.conditions, ri.notes, ri.photo_evidence, ri.resolved_product_id::text,
                    ri.created_at::text, ri.store_id::text, ri.pallet_id::text, ri.expected_item_id::text
             FROM return_items ri JOIN packages pkg ON pkg.id = ri.package_id WHERE ri.id = $1`,
            [pick.return_item_id],
          )
        ).rows[0]!;

        const closedAfter = packageStatusIsClosed(refreshed.package_status) === true;
        const gateAfter = gateBefore(refreshed, closedAfter);
        if (!gateAfter.allowed) {
          blockers.push(`Post-prep gate still blocked: ${gateAfter.reason}`);
        } else {
          const { createManualReturnsClaimDraft } = await import(
            "../app/returns/returns-manual-claim-grouping-actions"
          );
          createdDraft = await createManualReturnsClaimDraft([refreshed.return_item_id], {
            grouping_dimension: "issue",
            tenant: { actorProfileId: null, filterOrganizationId: ORG },
          });

          if ((createdDraft as { ok?: boolean }).ok && (createdDraft as { claim_case_id?: string }).claim_case_id) {
            const caseId = (createdDraft as { claim_case_id: string }).claim_case_id;
            const { data: lines } = await sb
              .from("claim_lines")
              .select("id, line_grain, source_table, return_item_id, claim_case_id")
              .eq("claim_case_id", caseId);
            claimLines = lines ?? [];
            const bad = (lines ?? []).filter((l) => {
              const grain = String((l as { line_grain: string }).line_grain);
              const st = String((l as { source_table?: string }).source_table ?? "");
              return isBlockedGrainForManualDraftCreation(grain, st);
            });
            if (bad.length) blockers.push(`Blocked grains attached: ${JSON.stringify(bad)}`);
          } else {
            blockers.push(`Draft create failed: ${JSON.stringify(createdDraft)}`);
          }
        }
      }

      const fakeImportRow = {
        return_item_id: "00000000-0000-0000-0000-000000000099",
        organization_id: ORG,
        package_id: null,
        pallet_id: null,
        expected_item_id: null,
        conditions: ["damaged_box"],
        photo_evidence: DEMO_EVIDENCE,
        notes: DEMO_NOTE,
        resolved_product_id: pick.resolved_product_id,
        created_at: pick.created_at,
      };
      const importBlocked = validateManualGroupingSelection([fakeImportRow], policy);
      const bulkOrphanBlocked = validateManualGroupingSelection(
        [
          {
            ...fakeImportRow,
            return_item_id: "00000000-0000-0000-0000-000000000098",
            expected_item_id: "46fdd28e-a4bd-47d6-b2f0-4e4b4709ca31",
            package_id: null,
            pallet_id: null,
          },
        ],
        policy,
      );

      blockedGrainsConfirmation = {
        manual_draft_import_source_row_rejected: !importBlocked.ok,
        manual_draft_bulk_orphan_rejected: !bulkOrphanBlocked.ok,
        isBlockedGrain_expected_group: isBlockedGrainForManualDraftCreation("expected_group", ""),
        isBlockedGrain_import_source: isBlockedGrainForManualDraftCreation("import_source", "amazon_returns"),
        auto_promote_env: autoPromote,
        marketplace_submit_run: false,
        backfill_execute_run: false,
      };
    }

    const safeToDemo =
      blockers.length === 0 &&
      apply &&
      (createdDraft as { ok?: boolean } | null)?.ok === true &&
      claimLines.length > 0 &&
      (claimLines as { line_grain: string }[]).every((l) => l.line_grain === "return_item");

    const report = {
      SCENARIO: scenario,
      ELIGIBILITY_BEFORE: eligibilityBefore,
      ACTIONS_TAKEN: actions,
      CREATED_DRAFT_CASE: createdDraft,
      CLAIM_LINES: claimLines,
      BLOCKED_GRAINS_CONFIRMATION: blockedGrainsConfirmation,
      SAFE_TO_DEMO: safeToDemo ? "yes" : apply ? "no" : "pending_apply",
      blockers,
      apply,
    };

    fs.writeFileSync(path.join(outDir, "e2e-report.json"), JSON.stringify(report, null, 2));
    fs.writeFileSync(
      path.join(outDir, "REPORT.md"),
      [
        "# CLAIMS-RETURNS-FIRST-USABLE-STAGING-E2E",
        "",
        `**SAFE_TO_DEMO:** ${report.SAFE_TO_DEMO}`,
        "",
        "## SCENARIO",
        "```json",
        JSON.stringify(scenario, null, 2),
        "```",
        "",
        "## ELIGIBILITY_BEFORE",
        "```json",
        JSON.stringify(eligibilityBefore, null, 2),
        "```",
        "",
        "## ACTIONS_TAKEN",
        actions.length ? actions.map((a) => `- ${a}`).join("\n") : "- (dry-run)",
        "",
        "## CREATED_DRAFT_CASE",
        "```json",
        JSON.stringify(createdDraft, null, 2),
        "```",
        "",
        "## CLAIM_LINES",
        "```json",
        JSON.stringify(claimLines, null, 2),
        "```",
        "",
        "## BLOCKED_GRAINS_CONFIRMATION",
        "```json",
        JSON.stringify(blockedGrainsConfirmation, null, 2),
        "```",
        "",
        ...(blockers.length ? ["## Blockers", "", ...blockers.map((b) => `- ${b}`)] : []),
      ].join("\n"),
    );

    console.log(JSON.stringify(report, null, 2));
    if (!safeToDemo && apply) process.exit(1);
  } finally {
    await client.end().catch(() => {});
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
