/**
 * VENDOR-1883-CLEANUP ORIGINAL PARITY PLAN (read-only)
 *
 *   npx tsx scripts/vendor-1883-cleanup-original-parity-plan.ts --run-id=<UTC_Z>
 *   npx tsx scripts/vendor-1883-cleanup-original-parity-plan.ts --plan-run-id=20260528T120000Z --execute-run-id=20260528T150000Z
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import pg from "pg";

import {
  loadEnvLocalIntoProcess,
  refFromSupabaseUrl,
} from "../lib/staging-project-ref";

function refFromConnectionUrl(url: string): string | null {
  const fromHost = refFromSupabaseUrl(url);
  if (fromHost) return fromHost;
  const m = url.match(/\.([a-z]{20})\./i) ?? url.match(/postgres\.([a-z]{20})/i);
  return m?.[1]?.toLowerCase() ?? null;
}

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const ORIGINAL_REF = "kxsvedvpjldygtdbylsy";
const SAM_ORG_ID = "00000000-0000-0000-0000-000000000001";
const SAM_STORE_ID = "509ee1f6-622c-46a5-8110-7b889ba46c2c";
const REQUIRED_BRANCH = "feature/product-canonicalization-v2";
const PLAN_DEFAULT = "20260528T120000Z";
const EXECUTE_DEFAULT = "20260528T150000Z";
const PLAN_BASE = ".cursor/audit-reports/vendor-1883-cleanup-plan-review";
const EXECUTE_BASE = ".cursor/audit-reports/vendor-1883-cleanup-staging-execute";
const APPROVAL_REL = ".cursor/operator-approvals/vendor-1883-cleanup-original-parity-approval.md";
const OUT_BASE = ".cursor/audit-reports/vendor-1883-cleanup-original-parity-plan";

type PlanRow = {
  product_id: string;
  seller_sku: string;
  sheet_row: number;
  sheet_brand: string;
  sheet_asin: string;
  proposed_vendor_name: string;
  before_vendor_name: string;
};

type LiveProduct = {
  id: string;
  sku: string | null;
  asin: string | null;
  vendor_name: string | null;
};

type Classification =
  | "already_clean_on_original"
  | "missing_or_different_on_original"
  | "conflict_manual_review"
  | "unsafe";

type ParityRow = PlanRow & {
  classification: Classification;
  blockers: string[];
  staging_vendor_name: string | null;
  original_vendor_name: string | null;
  original_product_found: boolean;
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

function planRunIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--plan-run-id="));
  return a ? a.split("=")[1]!.trim() : PLAN_DEFAULT;
}

function executeRunIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--execute-run-id="));
  return a ? a.split("=")[1]!.trim() : EXECUTE_DEFAULT;
}

function normSku(s: string | null | undefined): string {
  return (s ?? "").trim().toUpperCase();
}

function trimV(v: string | null | undefined): string {
  return (v ?? "").trim();
}

function isBare1883(v: string | null | undefined): boolean {
  return trimV(v) === "1883";
}

function approvalFileContent(planRunId: string, executeRunId: string, updateCount: number): string {
  return `# Vendor 1883 cleanup — original parity approval

**Default:** not approved until plan review.

| Field | Value |
|-------|--------|
| Original ref | \`${ORIGINAL_REF}\` |
| Staging execute proof | \`${EXECUTE_BASE}/${executeRunId}/\` |
| Deterministic plan | \`${PLAN_BASE}/${planRunId}/deterministic-update-plan.json\` |
| Planned original updates | **${updateCount}** |

\`\`\`text
APPROVED_TO_RUN_ORIGINAL=false
APPROVED_VENDOR_1883_CLEANUP_ORIGINAL_PARITY=false
\`\`\`

## Allowed when approved

| Allowed | Forbidden |
|---------|-----------|
| Original \`UPDATE products SET vendor_name = ...\` for \`original-update-plan.json\` rows only | Staging writes |
| Guard \`btrim(vendor_name) = '1883'\` on each update | \`product_identifier_map\` |
| Rollback from execute audit | Packaging tables |
| | Product auto-create |
| | Amazon SP-API |

## Sign-off

\`\`\`
APPROVED_TO_RUN_ORIGINAL=false
APPROVED_VENDOR_1883_CLEANUP_ORIGINAL_PARITY=false
Approved by:
UTC date:
Plan run_id:
\`\`\`
`;
}

function classifyRow(
  plan: PlanRow,
  staging: LiveProduct | undefined,
  original: LiveProduct | undefined,
  dupIds: string[],
): ParityRow {
  const blockers: string[] = [];
  const target = plan.sheet_brand;

  if (!original) {
    return {
      ...plan,
      classification: "unsafe",
      blockers: ["product_missing_on_original"],
      staging_vendor_name: staging?.vendor_name ?? null,
      original_vendor_name: null,
      original_product_found: false,
    };
  }

  if (dupIds.length > 0) {
    blockers.push("duplicate_sku_on_original");
  }

  const stgVn = trimV(staging?.vendor_name);
  const origVn = trimV(original.vendor_name);

  if (normSku(original.sku) !== normSku(plan.seller_sku)) {
    blockers.push("original_sku_mismatch");
  }

  if (staging && stgVn !== target) {
    blockers.push("staging_not_post_cleanup_target");
  }

  if (origVn === target) {
    return {
      ...plan,
      classification: "already_clean_on_original",
      blockers,
      staging_vendor_name: staging?.vendor_name ?? null,
      original_vendor_name: original.vendor_name,
      original_product_found: true,
    };
  }

  if (blockers.some((b) => b.startsWith("duplicate_") || b === "original_sku_mismatch")) {
    return {
      ...plan,
      classification: "conflict_manual_review",
      blockers,
      staging_vendor_name: staging?.vendor_name ?? null,
      original_vendor_name: original.vendor_name,
      original_product_found: true,
    };
  }

  if (blockers.includes("staging_not_post_cleanup_target")) {
    return {
      ...plan,
      classification: "conflict_manual_review",
      blockers,
      staging_vendor_name: staging?.vendor_name ?? null,
      original_vendor_name: original.vendor_name,
      original_product_found: true,
    };
  }

  if (!isBare1883(original.vendor_name) && origVn !== "" && origVn !== target) {
    return {
      ...plan,
      classification: "conflict_manual_review",
      blockers: [...blockers, "original_vendor_unexpected_value"],
      staging_vendor_name: staging?.vendor_name ?? null,
      original_vendor_name: original.vendor_name,
      original_product_found: true,
    };
  }

  return {
    ...plan,
    classification: "missing_or_different_on_original",
    blockers,
    staging_vendor_name: staging?.vendor_name ?? null,
    original_vendor_name: original.vendor_name,
    original_product_found: true,
  };
}

async function fetchProducts(
  client: pg.Client,
  ids: string[],
): Promise<Map<string, LiveProduct>> {
  const r = await client.query(
    `SELECT id::text, NULLIF(TRIM(sku),'') AS sku, NULLIF(TRIM(asin),'') AS asin,
            vendor_name
     FROM public.products
     WHERE organization_id = $1::uuid AND store_id = $2::uuid
       AND deleted_at IS NULL AND id = ANY($3::uuid[])`,
    [SAM_ORG_ID, SAM_STORE_ID, ids],
  );
  return new Map(
    (r.rows as LiveProduct[]).map((row) => [row.id, row]),
  );
}

async function duplicateSkus(client: pg.Client): Promise<Map<string, string[]>> {
  const r = await client.query(
    `SELECT UPPER(TRIM(sku)) AS sku_norm, array_agg(id::text ORDER BY id::text) AS product_ids
     FROM public.products
     WHERE organization_id = $1::uuid AND store_id = $2::uuid
       AND deleted_at IS NULL AND sku IS NOT NULL AND TRIM(sku) <> ''
     GROUP BY UPPER(TRIM(sku))
     HAVING COUNT(*) > 1`,
    [SAM_ORG_ID, SAM_STORE_ID],
  );
  const out = new Map<string, string[]>();
  for (const row of r.rows as Array<{ sku_norm: string; product_ids: string[] }>) {
    out.set(row.sku_norm, row.product_ids);
  }
  return out;
}

async function countBare1883(client: pg.Client): Promise<number> {
  const r = await client.query(
    `SELECT COUNT(*)::int AS c FROM public.products
     WHERE organization_id = $1::uuid AND store_id = $2::uuid
       AND deleted_at IS NULL AND btrim(coalesce(vendor_name, '')) = '1883'`,
    [SAM_ORG_ID, SAM_STORE_ID],
  );
  return (r.rows[0] as { c: number }).c;
}

async function main(): Promise<void> {
  const runId = runIdArg();
  const planRunId = planRunIdArg();
  const executeRunId = executeRunIdArg();
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  loadEnvLocalIntoProcess();
  const branch = execSync("git branch --show-current", { encoding: "utf8" }).trim();
  const stagingUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ?? "";
  const originalUrl = process.env.ORIGINAL_DIRECT_POSTGRES_URL?.trim() ?? "";
  const stagingRef = refFromConnectionUrl(stagingUrl);
  const originalRef = refFromConnectionUrl(originalUrl);

  const planPath = path.join(process.cwd(), PLAN_BASE, planRunId, "deterministic-update-plan.json");
  const executeManifestPath = path.join(process.cwd(), EXECUTE_BASE, executeRunId, "manifest.json");

  const blockers: string[] = [];
  if (branch !== REQUIRED_BRANCH) blockers.push(`Branch must be ${REQUIRED_BRANCH}`);
  if (stagingRef !== STAGING_REF) blockers.push(`Staging ref must be ${STAGING_REF}`);
  if (originalRef !== ORIGINAL_REF) blockers.push(`Original ref must be ${ORIGINAL_REF}`);
  if (!stagingUrl || !originalUrl) blockers.push("Missing STAGING_DIRECT_POSTGRES_URL or ORIGINAL_DIRECT_POSTGRES_URL");
  if (stagingUrl === originalUrl) blockers.push("Staging and original URLs must differ");
  if (!fs.existsSync(planPath)) blockers.push(`Missing ${planPath}`);

  let planRows: PlanRow[] = [];
  if (fs.existsSync(planPath)) {
    const parsed = JSON.parse(fs.readFileSync(planPath, "utf8")) as { rows: PlanRow[] };
    planRows = parsed.rows ?? [];
    if (planRows.length !== 454) blockers.push(`Expected 454 plan rows, got ${planRows.length}`);
  }

  if (fs.existsSync(executeManifestPath)) {
    const em = JSON.parse(fs.readFileSync(executeManifestPath, "utf8")) as {
      updated_count?: number;
      status?: string;
    };
    if (em.status !== "PASS" || em.updated_count !== 454) {
      blockers.push(`Staging execute proof ${executeRunId} must show 454 updated PASS`);
    }
  } else {
    blockers.push(`Missing staging execute manifest ${executeManifestPath}`);
  }

  let parityRows: ParityRow[] = [];
  let stagingBare = 0;
  let originalBare = 0;

  if (blockers.length === 0) {
    const stagingClient = new pg.Client({ connectionString: stagingUrl, ssl: { rejectUnauthorized: false } });
    const originalClient = new pg.Client({ connectionString: originalUrl, ssl: { rejectUnauthorized: false } });
    await stagingClient.connect();
    await originalClient.connect();
    await stagingClient.query("SET statement_timeout = '180s'");
    await originalClient.query("SET statement_timeout = '180s'");

    const ids = planRows.map((r) => r.product_id);
    const [stagingById, originalById, dupOrig] = await Promise.all([
      fetchProducts(stagingClient, ids),
      fetchProducts(originalClient, ids),
      duplicateSkus(originalClient),
    ]);
    stagingBare = await countBare1883(stagingClient);
    originalBare = await countBare1883(originalClient);
    await stagingClient.end();
    await originalClient.end();

    parityRows = planRows.map((plan) => {
      const skuNorm = normSku(plan.seller_sku);
      const dupIds = (dupOrig.get(skuNorm) ?? []).filter((id) => id !== plan.product_id);
      return classifyRow(
        plan,
        stagingById.get(plan.product_id),
        originalById.get(plan.product_id),
        dupIds,
      );
    });
  }

  const counts = {
    plan_rows: planRows.length,
    already_clean_on_original: parityRows.filter((r) => r.classification === "already_clean_on_original").length,
    missing_or_different_on_original: parityRows.filter(
      (r) => r.classification === "missing_or_different_on_original",
    ).length,
    conflict_manual_review: parityRows.filter((r) => r.classification === "conflict_manual_review").length,
    unsafe: parityRows.filter((r) => r.classification === "unsafe").length,
  };

  const originalUpdatePlan = parityRows
    .filter((r) => r.classification === "missing_or_different_on_original")
    .map((r) => ({
      product_id: r.product_id,
      seller_sku: r.seller_sku,
      sheet_row: r.sheet_row,
      sheet_brand: r.sheet_brand,
      sheet_asin: r.sheet_asin,
      staging_vendor_name: r.staging_vendor_name,
      original_vendor_name: r.original_vendor_name,
      after_vendor_name: r.sheet_brand,
      proposed_vendor_name: r.sheet_brand,
      update_sql_hint: `UPDATE products SET vendor_name = '${r.sheet_brand.replace(/'/g, "''")}', updated_at = now() WHERE id = '${r.product_id}' AND btrim(vendor_name) = '1883'`,
    }));

  const conflictRows = parityRows.filter((r) => r.classification === "conflict_manual_review");
  const unsafeRows = parityRows.filter((r) => r.classification === "unsafe");
  const alreadyClean = parityRows.filter((r) => r.classification === "already_clean_on_original");

  fs.writeFileSync(path.join(outDir, "parity-diff.json"), JSON.stringify({ run_id: runId, counts, rows: parityRows }, null, 2));
  fs.writeFileSync(
    path.join(outDir, "original-update-plan.json"),
    JSON.stringify({ run_id: runId, count: originalUpdatePlan.length, rows: originalUpdatePlan }, null, 2),
  );
  fs.writeFileSync(path.join(outDir, "conflict-rows.json"), JSON.stringify({ count: conflictRows.length, rows: conflictRows }, null, 2));
  fs.writeFileSync(path.join(outDir, "unsafe-rows.json"), JSON.stringify({ count: unsafeRows.length, rows: unsafeRows }, null, 2));
  fs.writeFileSync(
    path.join(outDir, "already-clean-rows.json"),
    JSON.stringify({ count: alreadyClean.length, rows: alreadyClean }, null, 2),
  );

  fs.writeFileSync(
    path.join(outDir, "original-parity-plan.md"),
    [
      "# Vendor 1883 original parity plan",
      "",
      `**Run id:** \`${runId}\``,
      `**Plan review:** \`${PLAN_BASE}/${planRunId}/\``,
      `**Staging execute:** \`${EXECUTE_BASE}/${executeRunId}/\` (454 updated)`,
      `**Mode:** read-only — no original writes`,
      "",
      "## Classification summary",
      "",
      "| Classification | Count |",
      "|----------------|------:|",
      `| already_clean_on_original | **${counts.already_clean_on_original}** |`,
      `| missing_or_different_on_original | **${counts.missing_or_different_on_original}** |`,
      `| conflict_manual_review | **${counts.conflict_manual_review}** |`,
      `| unsafe | **${counts.unsafe}** |`,
      "",
      "## Bare \`1883\` vendor_name (store scope)",
      "",
      `| Project | Count |`,
      `|---------|------:|`,
      `| Staging (\`${STAGING_REF}\`) | ${stagingBare} |`,
      `| Original (\`${ORIGINAL_REF}\`) | ${originalBare} |`,
      "",
      "## Original update plan",
      "",
      `**${originalUpdatePlan.length}** rows — same guard as staging: \`btrim(vendor_name) = '1883'\` → \`sheet_brand\`.`,
      "",
      "Unique target vendor: **1883 Maison Routin**",
      "",
      "## Sample conflicts",
      "",
      conflictRows.length
        ? conflictRows
            .slice(0, 5)
            .map(
              (r) =>
                `- \`${r.product_id.slice(0, 8)}…\` sku=${r.seller_sku} orig=\`${r.original_vendor_name}\` blockers=${r.blockers.join(", ")}`,
            )
            .join("\n")
        : "- None",
      "",
      "## Sample unsafe",
      "",
      unsafeRows.length
        ? unsafeRows
            .slice(0, 5)
            .map((r) => `- \`${r.product_id.slice(0, 8)}…\` ${r.blockers.join(", ")}`)
            .join("\n")
        : "- None",
    ].join("\n") + "\n",
  );

  fs.writeFileSync(
    path.join(outDir, "blockers.md"),
    blockers.length ? blockers.map((b) => `- ${b}`).join("\n") + "\n" : "- None (plan completed).\n",
  );

  const nextPrompt =
    originalUpdatePlan.length > 0
      ? "VENDOR-1883-CLEANUP-ORIGINAL-PARITY-EXECUTE — apply original-update-plan.json after approval"
      : "VENDOR-1883-CLEANUP-ORIGINAL-PARITY-VERIFY — confirm original already clean for deterministic cohort";

  if (!fs.existsSync(path.join(process.cwd(), APPROVAL_REL))) {
    fs.mkdirSync(path.dirname(path.join(process.cwd(), APPROVAL_REL)), { recursive: true });
  }
  fs.writeFileSync(
    path.join(process.cwd(), APPROVAL_REL),
    approvalFileContent(planRunId, executeRunId, originalUpdatePlan.length),
  );

  fs.writeFileSync(
    path.join(outDir, "manifest.json"),
    JSON.stringify(
      {
        prompt: "VENDOR-1883-CLEANUP ORIGINAL PARITY PLAN",
        run_id: runId,
        plan_run_id: planRunId,
        execute_run_id: executeRunId,
        branch,
        staging_ref: STAGING_REF,
        original_ref: ORIGINAL_REF,
        status: blockers.length ? "BLOCKED" : "PASS",
        classification_counts: counts,
        original_update_count: originalUpdatePlan.length,
        conflict_count: conflictRows.length,
        unsafe_count: unsafeRows.length,
        already_clean_count: alreadyClean.length,
        staging_bare_1883_after_execute: stagingBare,
        original_bare_1883_in_cohort_scope: originalBare,
        approval_file: APPROVAL_REL,
        exact_next_prompt: nextPrompt,
        forbidden: { original_writes: true },
      },
      null,
      2,
    ),
  );

  console.log(
    JSON.stringify(
      {
        ok: !blockers.length,
        outDir,
        original_update_count: originalUpdatePlan.length,
        conflict_count: conflictRows.length,
        unsafe_count: unsafeRows.length,
        already_clean_count: alreadyClean.length,
        blockers,
        next_prompt: nextPrompt,
      },
      null,
      2,
    ),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
