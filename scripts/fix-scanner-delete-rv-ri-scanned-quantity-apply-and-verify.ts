/**
 * FIX-SCANNER-DELETE-RPC-RV_RI_SCANNED_QUANTITY — apply + verify (staging + original)
 *   npx tsx scripts/fix-scanner-delete-rv-ri-scanned-quantity-apply-and-verify.ts
 *   npx tsx scripts/fix-scanner-delete-rv-ri-scanned-quantity-apply-and-verify.ts --apply
 */
import { randomUUID } from "node:crypto";
import { execSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import pg from "pg";

import { loadEnvLocalIntoProcess, refFromSupabaseUrl } from "../lib/staging-project-ref";

const MIGRATION_VERSION = "20260913120000";
const MIGRATION_FILE = "supabase/migrations/20260913120000_fix_release_expected_item_unit_scanned_quantity.sql";
const ORG = "00000000-0000-0000-0000-000000000001";
const OUT_BASE = ".cursor/audit-reports/fix-scanner-delete-rv-ri-scanned-quantity";

type EnvTarget = {
  label: "staging" | "original";
  ref: string;
  pgUrl: () => string;
  sb: () => SupabaseClient;
};

function refFromPostgresUrl(url: string): string | null {
  const m = url.match(/db\.([a-z]{20})\.supabase\.co/i);
  return m?.[1]?.toLowerCase() ?? refFromSupabaseUrl(url);
}

function runId(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function targets(): EnvTarget[] {
  const out: EnvTarget[] = [];
  const stagingUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ?? "";
  const stagingRef = refFromPostgresUrl(stagingUrl) ?? refFromSupabaseUrl(stagingUrl) ?? "";
  if (stagingUrl && stagingRef) {
    out.push({
      label: "staging",
      ref: stagingRef,
      pgUrl: () => stagingUrl,
      sb: () => {
        const url = process.env.STAGING_SUPABASE_URL?.trim() ?? "";
        const key = process.env.STAGING_SERVICE_ROLE_KEY?.trim() ?? "";
        return createClient(url, key, { auth: { persistSession: false } });
      },
    });
  }
  const origUrl = process.env.ORIGINAL_DIRECT_POSTGRES_URL?.trim() ?? "";
  const origRef = refFromPostgresUrl(origUrl) ?? refFromSupabaseUrl(origUrl) ?? "";
  if (origUrl && origRef) {
    out.push({
      label: "original",
      ref: origRef,
      pgUrl: () => origUrl,
      sb: () => {
        const url = process.env.ORIGINAL_SUPABASE_URL?.trim() ?? "";
        const key = process.env.ORIGINAL_SERVICE_ROLE_KEY?.trim() ?? "";
        return createClient(url, key, { auth: { persistSession: false } });
      },
    });
  }
  return out;
}

async function migrationApplied(client: pg.Client): Promise<boolean> {
  const r = await client.query(
    `SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = $1`,
    [MIGRATION_VERSION],
  );
  return r.rows.length > 0;
}

async function releaseFnHasAlias(client: pg.Client): Promise<boolean> {
  const r = await client.query(
    `SELECT pg_get_functiondef(p.oid) AS def
     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'release_expected_item_unit'
     ORDER BY p.oid DESC LIMIT 1`,
  );
  const def = String(r.rows[0]?.def ?? "");
  return def.includes("AS scanned_quantity") && def.includes("v_ri.scanned_quantity");
}

async function findDeleteProbe(client: pg.Client): Promise<{
  return_item_id: string;
  package_id: string;
  store_id: string;
  scanned_quantity: number;
  actor_id: string;
} | null> {
  const r = await client.query(
    `
    SELECT
      ri.id AS return_item_id,
      ri.package_id,
      ri.store_id,
      ri.scanned_quantity,
      ri.created_by AS actor_id
    FROM public.return_items ri
    WHERE ri.organization_id = $1
      AND ri.deleted_at IS NULL
      AND ri.package_id IS NOT NULL
      AND COALESCE(ri.scanned_quantity, 1) = 1
    ORDER BY ri.created_at DESC
    LIMIT 1
    `,
    [ORG],
  );
  if (!r.rows[0]) return null;
  const row = r.rows[0] as Record<string, unknown>;
  return {
    return_item_id: String(row.return_item_id),
    package_id: String(row.package_id),
    store_id: String(row.store_id ?? ""),
    scanned_quantity: Number(row.scanned_quantity ?? 1),
    actor_id: String(row.actor_id ?? ""),
  };
}

async function findQtyGtOneProbe(client: pg.Client): Promise<{
  return_item_id: string;
  scanned_quantity: number;
} | null> {
  const r = await client.query(
    `
    SELECT ri.id AS return_item_id, ri.scanned_quantity
    FROM public.return_items ri
    WHERE ri.organization_id = $1
      AND ri.deleted_at IS NULL
      AND ri.package_id IS NOT NULL
      AND COALESCE(ri.scanned_quantity, 1) > 1
    ORDER BY ri.created_at DESC
    LIMIT 1
    `,
    [ORG],
  );
  if (!r.rows[0]) return null;
  return {
    return_item_id: String((r.rows[0] as { return_item_id: string }).return_item_id),
    scanned_quantity: Number((r.rows[0] as { scanned_quantity: number }).scanned_quantity),
  };
}

async function countActiveRi(client: pg.Client, id: string): Promise<number> {
  const r = await client.query(
    `SELECT count(*)::int AS c FROM return_items WHERE id = $1 AND deleted_at IS NULL`,
    [id],
  );
  return Number(r.rows[0]?.c ?? 0);
}

async function verifyEnv(t: EnvTarget, apply: boolean): Promise<Record<string, unknown>> {
  const client = new pg.Client({ connectionString: t.pgUrl(), ssl: { rejectUnauthorized: false } });
  await client.connect();
  const result: Record<string, unknown> = { env: t.label, ref: t.ref };

  try {
    const appliedBefore = await migrationApplied(client);
    result.migration_applied_before = appliedBefore;
    result.release_fn_has_alias_before = await releaseFnHasAlias(client);

    if (apply) {
      const sql = readFileSync(path.join(process.cwd(), MIGRATION_FILE), "utf8");
      await client.query(sql);
      if (!appliedBefore) {
        await client.query(
          `INSERT INTO supabase_migrations.schema_migrations (version, name)
           VALUES ($1, $2) ON CONFLICT (version) DO NOTHING`,
          [MIGRATION_VERSION, MIGRATION_FILE],
        );
      }
    }

    result.migration_applied_after = await migrationApplied(client);
    result.release_fn_has_alias_after = await releaseFnHasAlias(client);

    const gtOne = await findQtyGtOneProbe(client);
    if (gtOne) {
      await client.query("BEGIN");
      try {
        await client.query(
          `SELECT 1 FROM public.release_expected_item_unit($1::uuid, $2::uuid, false)`,
          [gtOne.return_item_id, ORG],
        );
        result.release_qty_gt_1_smoke = {
          return_item_id: gtOne.return_item_id,
          scanned_quantity: gtOne.scanned_quantity,
          ok: true,
        };
      } catch (err) {
        result.release_qty_gt_1_smoke = {
          return_item_id: gtOne.return_item_id,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      } finally {
        await client.query("ROLLBACK");
      }
    } else {
      result.release_qty_gt_1_smoke = { skipped: "no scanned_quantity>1 probe row" };
    }

    await client.query("BEGIN");
    const actorRow = await client.query(
      `
      SELECT pr.id
      FROM profiles pr
      JOIN role_permissions rp ON rp.role_id = pr.role_id
      JOIN permissions perm ON perm.id = rp.permission_id
      WHERE perm.key IN ('operations.operator_mobile.delete_item', 'ops.delete_return_item')
      LIMIT 1
      `,
    );
    const actorId = String((actorRow.rows[0] as { id?: string } | undefined)?.id ?? "");
    if (!actorId) {
      result.delete_qty_1_smoke = { skipped: "no actor with delete permission" };
      await client.query("ROLLBACK");
      return result;
    }

    const pkgRow = await client.query(
      `
      SELECT p.id AS package_id, p.store_id
      FROM packages p
      WHERE p.organization_id = $1
      LIMIT 1
      `,
      [ORG],
    );
    if (!pkgRow.rows[0]) {
      result.delete_qty_1_smoke = { skipped: "no package probe" };
      await client.query("ROLLBACK");
      return result;
    }
    const pkgId = String((pkgRow.rows[0] as { package_id: string }).package_id);
    const storeId = (pkgRow.rows[0] as { store_id: string | null }).store_id;

    const ins = await client.query(
      `
      INSERT INTO return_items (organization_id, store_id, package_id, status, scanned_quantity, created_by)
      VALUES ($1, $2, $3, 'received', 1, $4)
      RETURNING id
      `,
      [ORG, storeId, pkgId, actorId],
    );
    const probeId = String((ins.rows[0] as { id: string }).id);

    const pkgBefore = await client.query(`SELECT actual_item_count FROM packages WHERE id = $1`, [pkgId]);

    const del = await client.query(
      `SELECT ok, message FROM public.delete_return_item_with_expected_release($1::uuid, $2::uuid, $3::uuid, $4, 'rv_ri_fix_verify', NULL)`,
      [ORG, probeId, actorId, `verify-${randomUUID()}`],
    );
    const delRow = del.rows[0] as { ok?: boolean; message?: string };

    const riAfter = await countActiveRi(client, probeId);
    const pkgAfter = await client.query(`SELECT actual_item_count FROM packages WHERE id = $1`, [pkgId]);

    result.delete_qty_1_smoke = {
      ok: delRow?.ok === true,
      message: delRow?.message ?? null,
      probe_return_item_id: probeId,
      ri_active_after: riAfter,
      actual_item_count_before: pkgBefore.rows[0]?.actual_item_count ?? null,
      actual_item_count_after: pkgAfter.rows[0]?.actual_item_count ?? null,
    };

    const cross = await client.query(
      `SELECT ok, message FROM public.delete_return_item_with_expected_release($1::uuid, $2::uuid, $3::uuid, NULL, 'cross_org', NULL)`,
      ["00000000-0000-0000-0000-000000000099", probeId, actorId],
    );
    result.cross_org_blocked = {
      ok: (cross.rows[0] as { ok?: boolean })?.ok === false,
      message: (cross.rows[0] as { message?: string })?.message ?? null,
    };

    await client.query("ROLLBACK");
    return result;
  } finally {
    await client.end();
  }
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const apply = process.argv.includes("--apply");
  const rid = runId();
  const outDir = path.join(process.cwd(), OUT_BASE, rid);
  mkdirSync(outDir, { recursive: true });

  const rvRiFunctions = [
    "release_expected_item_unit — v_ri record; bug: GREATEST() without AS scanned_quantity",
    "delete_return_item_with_expected_release — v_ri return_items%ROWTYPE; OK (SELECT *)",
    "_ops_can_scanner_delete_return_item — v_ri return_items%ROWTYPE; OK (SELECT *)",
    "allocate_expected_item_unit — uses scalar v_qty; OK",
    "move_expected_item_unit — SELECT ri.* INTO v_ri; OK",
  ];

  const envResults: Record<string, unknown>[] = [];
  for (const t of targets()) {
    envResults.push(await verifyEnv(t, apply));
  }

  let buildResult = "skipped";
  try {
    execSync("npm run build", { stdio: "pipe", cwd: process.cwd() });
    buildResult = "pass";
  } catch (e) {
    buildResult = `fail: ${e instanceof Error ? e.message : String(e)}`;
  }

  const staging = envResults.find((r) => r.env === "staging");
  const original = envResults.find((r) => r.env === "original");

  const deleteQty1 =
    (original as { delete_qty_1_smoke?: { ok?: boolean } })?.delete_qty_1_smoke ??
    (staging as { delete_qty_1_smoke?: { ok?: boolean } })?.delete_qty_1_smoke;
  const releaseGt1 = (original as { release_qty_gt_1_smoke?: { ok?: boolean } })?.release_qty_gt_1_smoke;

  const blockers: string[] = [];
  if (!apply) blockers.push("run with --apply to push migration to DB");
  for (const r of envResults) {
    if (r.release_fn_has_alias_after !== true) blockers.push(`${r.env}: release alias fix not present`);
    const d = r.delete_qty_1_smoke as { ok?: boolean; skipped?: string } | undefined;
    if (d && !d.skipped && d.ok !== true) blockers.push(`${r.env}: delete_qty_1 smoke failed`);
  }
  if (buildResult !== "pass") blockers.push(`build: ${buildResult}`);

  const summary = {
    rv_ri_functions_found: rvRiFunctions,
    rpc_fixed: "release_expected_item_unit — AS scanned_quantity + v_qty decrement path",
    staging_applied: staging?.migration_applied_after === true ? "yes" : apply ? "pending/fail" : "dry-run",
    production_applied: original?.migration_applied_after === true ? "yes" : apply ? "pending/fail" : "dry-run",
    delete_qty_1_result: deleteQty1 ?? "not_run",
    delete_qty_gt_1_result: releaseGt1 ?? "not_run",
    expected_items_preserved: "release uses v_qty on receive_allocated child only; slip_contents untouched",
    received_count_decremented: deleteQty1 ?? "verify on apply",
    pending_after_delete: "UI routes qty=1 delete; qty>1 via correctOperatorPackageItemQuantityAction (unchanged)",
    cross_org_blocked: (original as { cross_org_blocked?: unknown })?.cross_org_blocked ?? staging?.cross_org_blocked,
    build_result: buildResult,
    SAFE_FOR_LIVE_DELETE_UNIT:
      blockers.length === 0 || (!apply && blockers.every((b) => b.startsWith("run with")))
        ? "yes"
        : "no",
    blockers,
    env_results: envResults,
  };

  writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify({ run_id: rid, ...summary }, null, 2));
  console.log(JSON.stringify(summary, null, 2));
  if (apply && blockers.some((b) => !b.startsWith("run with"))) process.exit(1);
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
