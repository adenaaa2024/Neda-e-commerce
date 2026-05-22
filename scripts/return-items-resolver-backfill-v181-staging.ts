/**
 * RETURN-ITEMS-RESOLVER-BACKFILL-V181 — Dry-run + optional execute on staging return_items.
 *
 *   npx tsx scripts/return-items-resolver-backfill-v181-staging.ts --run-id=<id>
 *   npx tsx scripts/return-items-resolver-backfill-v181-staging.ts --run-id=<id> --execute
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createClient } from "@supabase/supabase-js";
import pg from "pg";

import { resolveScannerProductIdentifiers } from "../lib/scanner-product-resolve";
import { getStagingProjectRef, loadEnvLocalIntoProcess, refFromSupabaseUrl } from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const OUT_BASE = ".cursor/audit-reports/return-items-resolver-backfill-v181-execute";

type ReturnItemRow = {
  id: string;
  organization_id: string;
  store_id: string | null;
  sku: string | null;
  fnsku: string | null;
  asin: string | null;
  product_id: string | null;
  resolved_product_id: string | null;
  resolved_catalog_product_id: string | null;
  identifier_resolution_status: string | null;
  identifier_resolution_confidence: string | null;
};

type BackfillProposal = {
  id: string;
  organization_id: string;
  before: {
    resolved_product_id: string | null;
    resolved_catalog_product_id: string | null;
    identifier_resolution_status: string | null;
    identifier_resolution_confidence: number | null;
  };
  after: {
    resolved_product_id: string | null;
    resolved_catalog_product_id: string | null;
    identifier_resolution_status: string | null;
    identifier_resolution_confidence: number | null;
  };
  apply_kind: "set_resolved" | "status_only" | "skip_unchanged";
  tier_note: string;
};

function runIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

function n(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

function num(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
}

function tierNote(res: Awaited<ReturnType<typeof resolveScannerProductIdentifiers>>): string {
  if (res.identifier_resolution_status === "resolved") return "identifier_map_match";
  if (res.identifier_resolution_status === "ambiguous") return "ambiguous";
  if (res.identifier_resolution_status === "mismatch") return "legacy_mismatch";
  return "unresolved";
}

async function probeCounts(client: pg.Client): Promise<Record<string, unknown>> {
  const r = await client.query(`
    SELECT
      COUNT(*)::bigint AS active,
      COUNT(*) FILTER (WHERE resolved_product_id IS NOT NULL)::bigint AS resolved,
      COUNT(*) FILTER (WHERE identifier_resolution_status = 'resolved')::bigint AS status_resolved,
      COUNT(*) FILTER (WHERE identifier_resolution_status = 'ambiguous')::bigint AS ambiguous,
      COUNT(*) FILTER (WHERE identifier_resolution_status = 'unresolved' OR identifier_resolution_status IS NULL)::bigint AS unresolved_or_null
    FROM public.return_items WHERE deleted_at IS NULL`);
  return r.rows[0] as Record<string, unknown>;
}

async function fetchCandidateRows(client: pg.Client, cursor: string, limit: number): Promise<ReturnItemRow[]> {
  const res = await client.query(
    `SELECT id::text, organization_id::text, store_id::text, sku, fnsku, asin,
            product_id::text, resolved_product_id::text, resolved_catalog_product_id::text,
            identifier_resolution_status, identifier_resolution_confidence::text
     FROM public.return_items
     WHERE deleted_at IS NULL
       AND organization_id IS NOT NULL
       AND store_id IS NOT NULL
       AND (
         resolved_product_id IS NULL
         OR identifier_resolution_status IS DISTINCT FROM 'resolved'
         OR identifier_resolution_status IS NULL
       )
       AND id > $1::uuid
     ORDER BY id
     LIMIT $2`,
    [cursor, limit],
  );
  return res.rows as ReturnItemRow[];
}

async function productExists(client: pg.Client, productId: string): Promise<boolean> {
  const r = await client.query(`SELECT 1 FROM public.products WHERE id = $1::uuid LIMIT 1`, [productId]);
  return r.rows.length > 0;
}

async function buildProposals(
  supabase: ReturnType<typeof createClient>,
  pgClient: pg.Client,
  rows: ReturnItemRow[],
): Promise<BackfillProposal[]> {
  const out: BackfillProposal[] = [];
  for (const row of rows) {
    const before = {
      resolved_product_id: n(row.resolved_product_id),
      resolved_catalog_product_id: n(row.resolved_catalog_product_id),
      identifier_resolution_status: n(row.identifier_resolution_status),
      identifier_resolution_confidence: num(row.identifier_resolution_confidence),
    };

    const resolved = await resolveScannerProductIdentifiers(supabase, {
      organizationId: row.organization_id,
      storeId: row.store_id,
      sku: row.sku,
      asin: row.asin,
      fnsku: row.fnsku,
      legacyProductId: row.product_id,
    });

    let after = {
      resolved_product_id: resolved.resolved_product_id,
      resolved_catalog_product_id: resolved.resolved_catalog_product_id,
      identifier_resolution_status: resolved.identifier_resolution_status,
      identifier_resolution_confidence: resolved.identifier_resolution_confidence,
    };

    let apply_kind: BackfillProposal["apply_kind"] = "status_only";

    if (after.identifier_resolution_status === "resolved" && after.resolved_product_id) {
      const ok = await productExists(pgClient, after.resolved_product_id);
      if (ok) {
        apply_kind = "set_resolved";
      } else {
        after = {
          ...after,
          resolved_product_id: null,
          resolved_catalog_product_id: null,
          identifier_resolution_status: "unresolved",
        };
        apply_kind = "status_only";
      }
    } else {
      after = {
        resolved_product_id: null,
        resolved_catalog_product_id: null,
        identifier_resolution_status: after.identifier_resolution_status,
        identifier_resolution_confidence: after.identifier_resolution_confidence,
      };
    }

    const unchanged =
      before.resolved_product_id === after.resolved_product_id &&
      before.resolved_catalog_product_id === after.resolved_catalog_product_id &&
      before.identifier_resolution_status === after.identifier_resolution_status &&
      before.identifier_resolution_confidence === after.identifier_resolution_confidence;

    if (unchanged) apply_kind = "skip_unchanged";

    out.push({
      id: row.id,
      organization_id: row.organization_id,
      before,
      after,
      apply_kind,
      tier_note: tierNote(resolved),
    });
  }
  return out;
}

async function applyProposals(client: pg.Client, proposals: BackfillProposal[]): Promise<number> {
  let applied = 0;
  const CHUNK = 100;
  const toApply = proposals.filter((p) => p.apply_kind !== "skip_unchanged");
  for (let i = 0; i < toApply.length; i += CHUNK) {
    const slice = toApply.slice(i, i + CHUNK);
    for (const p of slice) {
      if (p.apply_kind === "set_resolved") {
        const r = await client.query(
          `UPDATE public.return_items t
           SET resolved_product_id = $2::uuid,
               resolved_catalog_product_id = $3::uuid,
               identifier_resolution_status = $4,
               identifier_resolution_confidence = $5,
               updated_at = now()
           FROM public.products pr
           WHERE t.id = $1::uuid
             AND t.deleted_at IS NULL
             AND pr.id = $2::uuid
           RETURNING t.id::text`,
          [
            p.id,
            p.after.resolved_product_id,
            p.after.resolved_catalog_product_id,
            p.after.identifier_resolution_status,
            p.after.identifier_resolution_confidence,
          ],
        );
        if (r.rowCount) applied += 1;
      } else {
        const r = await client.query(
          `UPDATE public.return_items
           SET resolved_product_id = NULL,
               resolved_catalog_product_id = NULL,
               identifier_resolution_status = $2,
               identifier_resolution_confidence = $3,
               updated_at = now()
           WHERE id = $1::uuid AND deleted_at IS NULL
           RETURNING id::text`,
          [p.id, p.after.identifier_resolution_status, p.after.identifier_resolution_confidence],
        );
        if (r.rowCount) applied += 1;
      }
    }
  }
  return applied;
}

function readApprovalFlag(): boolean {
  const p = path.join(
    process.cwd(),
    ".cursor/operator-approvals/return-items-resolver-backfill-v181-approval.md",
  );
  if (!fs.existsSync(p)) return false;
  return /APPROVED_TO_RUN_RETURN_ITEMS_RESOLVER_BACKFILL_STAGING\s*=\s*true/i.test(
    fs.readFileSync(p, "utf8"),
  );
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const runId = runIdArg();
  const execute = hasFlag("--execute");
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  const dbUrl =
    process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ||
    process.env.DIRECT_POSTGRES_URL?.trim() ||
    "";
  const publicUrl = process.env.STAGING_SUPABASE_URL?.trim() || process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() || "";
  const ref = refFromSupabaseUrl(publicUrl) || refFromSupabaseUrl(dbUrl);
  if (!dbUrl || ref !== STAGING_REF || getStagingProjectRef({ loadEnv: false }) !== STAGING_REF) {
    throw new Error(`Staging ref guard failed (expected ${STAGING_REF})`);
  }

  if (execute && !readApprovalFlag()) {
    throw new Error(
      "Execute blocked: set APPROVED_TO_RUN_RETURN_ITEMS_RESOLVER_BACKFILL_STAGING=true in .cursor/operator-approvals/return-items-resolver-backfill-v181-approval.md",
    );
  }

  const pgClient = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await pgClient.connect();
  const preCounts = await probeCounts(pgClient);

  const supabase = createClient(
    publicUrl,
    process.env.STAGING_SERVICE_ROLE_KEY?.trim() || process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() || "",
    { auth: { persistSession: false } },
  );

  const allProposals: BackfillProposal[] = [];
  let cursor = "00000000-0000-0000-0000-000000000000";
  const PAGE = 500;
  for (;;) {
    const batch = await fetchCandidateRows(pgClient, cursor, PAGE);
    if (batch.length === 0) break;
    allProposals.push(...(await buildProposals(supabase, pgClient, batch)));
    cursor = batch[batch.length - 1]!.id;
    if (batch.length < PAGE) break;
  }

  const summary = {
    candidates_scanned: allProposals.length,
    set_resolved: allProposals.filter((p) => p.apply_kind === "set_resolved").length,
    status_only: allProposals.filter((p) => p.apply_kind === "status_only").length,
    skip_unchanged: allProposals.filter((p) => p.apply_kind === "skip_unchanged").length,
    by_tier_note: allProposals.reduce(
      (acc, p) => {
        acc[p.tier_note] = (acc[p.tier_note] ?? 0) + 1;
        return acc;
      },
      {} as Record<string, number>,
    ),
  };

  const preimageRows = allProposals
    .filter((p) => p.apply_kind !== "skip_unchanged")
    .map((p) => ({
      id: p.id,
      old_resolved_product_id: p.before.resolved_product_id,
      old_resolved_catalog_product_id: p.before.resolved_catalog_product_id,
      old_identifier_resolution_status: p.before.identifier_resolution_status,
      old_identifier_resolution_confidence: p.before.identifier_resolution_confidence,
    }));

  fs.writeFileSync(path.join(outDir, "rollback-preimage-rows.json"), JSON.stringify(preimageRows, null, 2));
  fs.writeFileSync(
    path.join(outDir, "rollback-preimage-proposals.json"),
    JSON.stringify({ updates: allProposals.filter((p) => p.apply_kind !== "skip_unchanged") }, null, 2),
  );
  const rollbackSql = preimageRows.map((r) => {
    const rp =
      r.old_resolved_product_id === null ? "NULL" : `'${r.old_resolved_product_id}'::uuid`;
    const rc =
      r.old_resolved_catalog_product_id === null
        ? "NULL"
        : `'${r.old_resolved_catalog_product_id}'::uuid`;
    const st =
      r.old_identifier_resolution_status === null
        ? "NULL"
        : `'${r.old_identifier_resolution_status}'`;
    const conf =
      r.old_identifier_resolution_confidence === null
        ? "NULL"
        : String(r.old_identifier_resolution_confidence);
    return `UPDATE public.return_items SET resolved_product_id=${rp}, resolved_catalog_product_id=${rc}, identifier_resolution_status=${st}, identifier_resolution_confidence=${conf}, updated_at=now() WHERE id='${r.id}'::uuid;`;
  });
  fs.writeFileSync(
    path.join(outDir, "rollback.sql"),
    ["-- RETURN-ITEMS-RESOLVER-BACKFILL-V181 rollback", ...rollbackSql].join("\n"),
    "utf8",
  );
  fs.writeFileSync(path.join(outDir, "dry-run-summary.json"), JSON.stringify(summary, null, 2));
  fs.writeFileSync(
    path.join(outDir, "tier-breakdown.json"),
    JSON.stringify(summary.by_tier_note, null, 2),
  );
  fs.writeFileSync(path.join(outDir, "pre-counts.json"), JSON.stringify(preCounts, null, 2));

  let applied = 0;
  if (execute) {
    applied = await applyProposals(pgClient, allProposals);
  }

  const postCounts = execute ? await probeCounts(pgClient) : null;
  await pgClient.end();

  const manifest = {
    prompt: execute ? "RETURN-ITEMS-RESOLVER-BACKFILL-V181-EXECUTE" : "RETURN-ITEMS-RESOLVER-BACKFILL-V181-DRY-RUN",
    run_id: runId,
    staging_ref: STAGING_REF,
    mode: execute ? "execute" : "dry_run",
    ...summary,
    eligible_apply: summary.set_resolved + summary.status_only,
    applied,
    pre_counts: preCounts,
    post_counts: postCounts,
    status: "PASS",
  };

  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  if (postCounts) fs.writeFileSync(path.join(outDir, "post-counts.json"), JSON.stringify(postCounts, null, 2));
  fs.writeFileSync(
    path.join(outDir, "summary.md"),
    [
      `# ${manifest.prompt}`,
      "",
      `- run_id: \`${runId}\``,
      `- staging: \`${STAGING_REF}\``,
      `- candidates: ${summary.candidates_scanned}`,
      `- set_resolved (FK-safe): ${summary.set_resolved}`,
      `- status_only: ${summary.status_only}`,
      `- applied: ${applied}`,
      "",
      preCounts.resolved != null
        ? `- resolved rows: ${preCounts.resolved} → ${postCounts?.resolved ?? "n/a"}`
        : "",
    ].join("\n"),
    "utf8",
  );

  console.log(JSON.stringify(manifest, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
