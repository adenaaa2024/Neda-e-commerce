/**
 * RETURN-ITEMS-RESOLVER-EXECUTE-PRECHECK-V184 — read-only staging validation (no writes).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";

import { getStagingProjectRef, loadEnvLocalIntoProcess, refFromSupabaseUrl } from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const V183_RUN = "20260520T220000Z";
const V183_DIR = path.join(
  process.cwd(),
  ".cursor/audit-reports/return-items-fbm-aware-dry-run-v183",
  V183_RUN,
);
const V184_REVIEW = path.join(
  process.cwd(),
  ".cursor/audit-reports/return-items-fbm-dry-run-result-review-v184",
  "20260520T193000Z",
);

type Proposal = {
  return_item_id: string;
  apply_kind: string;
  before: { resolved_product_id: string | null };
  proposed: { resolved_product_id: string | null };
};

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const dbUrl =
    process.env.STAGING_DIRECT_POSTGRES_URL?.trim() || process.env.DIRECT_POSTGRES_URL?.trim() || "";
  const ref = refFromSupabaseUrl(dbUrl) || getStagingProjectRef({ loadEnv: false });
  if (!dbUrl || ref !== STAGING_REF) throw new Error(`staging ref guard failed (expected ${STAGING_REF})`);

  const proposals = JSON.parse(
    fs.readFileSync(path.join(V183_DIR, "proposal-rows.json"), "utf8"),
  ) as Proposal[];
  const ambiguous = JSON.parse(
    fs.readFileSync(path.join(V183_DIR, "excluded-ambiguous-rows.json"), "utf8"),
  ) as unknown[];

  const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();

  const pkgItems = await client.query(
    `SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='package_items'`,
  );
  const counts = await client.query(`
    SELECT COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE resolved_product_id IS NOT NULL)::int AS resolved,
      COUNT(DISTINCT organization_id)::int AS orgs
    FROM return_items WHERE deleted_at IS NULL`);

  const setResolved = proposals.filter((p) => p.apply_kind === "set_resolved");
  const pids = [
    ...new Set(
      proposals
        .map((p) => p.proposed?.resolved_product_id?.trim())
        .filter((x): x is string => !!x),
    ),
  ];

  let fkMissing: string[] = [];
  if (pids.length > 0) {
    const fk = await client.query("SELECT id::text FROM products WHERE id = ANY($1::uuid[])", [pids]);
    const found = new Set(fk.rows.map((r: { id: string }) => r.id));
    fkMissing = pids.filter((id) => !found.has(id));
  }

  const conflicts = setResolved.filter(
    (p) =>
      p.before.resolved_product_id &&
      p.proposed.resolved_product_id &&
      p.before.resolved_product_id !== p.proposed.resolved_product_id,
  );

  const dupIds = setResolved
    .map((p) => p.return_item_id)
    .filter((id, i, arr) => arr.indexOf(id) !== i);

  const v184Manifest = fs.existsSync(path.join(V184_REVIEW, "manifest.json"));
  const v184Verdict = v184Manifest
    ? (JSON.parse(fs.readFileSync(path.join(V184_REVIEW, "manifest.json"), "utf8")) as {
        verdict?: { execute_precheck_recommended?: boolean };
      }).verdict?.execute_precheck_recommended
    : null;

  await client.end();

  const rollbackFiles = ["rollback-preimage-rows.json", "rollback.sql", "rollback-preimage-plan.md"].map(
    (f) => ({ file: f, exists: fs.existsSync(path.join(V183_DIR, f)) }),
  );

  console.log(
    JSON.stringify(
      {
        staging_ref: ref,
        package_items_absent: (pkgItems.rowCount ?? 0) === 0,
        return_items: counts.rows[0],
        v184_review_present: v184Manifest,
        v184_execute_precheck_recommended: v184Verdict,
        v184_gate_execute_may_be_possible: setResolved.length > 0,
        set_resolved_count: setResolved.length,
        proposed_product_ids_checked: pids,
        fk_missing: fkMissing,
        ambiguous_rows: ambiguous.length,
        duplicate_return_item_ids_in_set_resolved: dupIds,
        conflicting_reassignments: conflicts.length,
        rollback_artifacts: rollbackFiles,
        v182_audit_folder_on_disk: fs.existsSync(
          path.join(
            process.cwd(),
            ".cursor/audit-reports/return-items-resolver-backfill-fbm-aware-v182",
            "20260520T180000Z",
          ),
        ),
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
