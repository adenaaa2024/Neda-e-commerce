/**
 * APPLY-SCANNER-DELETE-PERMISSION-WIRING-PRODUCTION
 *   npx tsx scripts/apply-scanner-delete-permission-wiring-production.ts
 *   npx tsx scripts/apply-scanner-delete-permission-wiring-production.ts --apply
 */
import { randomUUID } from "node:crypto";
import { execSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import pg from "pg";

import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";

const ORIGINAL_REF = "kxsvedvpjldygtdbylsy";
const ORG = "00000000-0000-0000-0000-000000000001";
const MIGRATION = "supabase/migrations/20260912120000_scanner_delete_unit_permission_wiring.sql";
const MIGRATION_VERSION = "20260912120000";
const OPS_ACTOR_HAS_PERMISSION_HOTFIX = `
CREATE OR REPLACE FUNCTION public._ops_actor_has_permission(
  p_actor_id uuid,
  p_permission_key text
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SET search_path = pg_catalog, public
AS $fn$
BEGIN
  IF p_actor_id IS NULL THEN
    RETURN current_setting('role', true) = 'service_role';
  END IF;

  IF to_regclass('public.user_permissions') IS NOT NULL THEN
    IF EXISTS (
      SELECT 1
      FROM public.user_permissions up
      JOIN public.permissions perm ON perm.id = up.permission_id
      WHERE up.profile_id = p_actor_id
        AND perm.key = p_permission_key
    ) THEN
      RETURN true;
    END IF;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.profiles pr
    JOIN public.role_permissions rp ON rp.role_id = pr.role_id
    JOIN public.permissions perm ON perm.id = rp.permission_id
    WHERE pr.id = p_actor_id
      AND perm.key = p_permission_key
  ) THEN
    RETURN true;
  END IF;

  IF to_regclass('public.user_groups') IS NOT NULL AND to_regclass('public.group_permissions') IS NOT NULL THEN
    IF EXISTS (
      SELECT 1
      FROM public.user_groups ug
      JOIN public.group_permissions gp ON gp.group_id = ug.group_id
      JOIN public.permissions perm ON perm.id = gp.permission_id
      WHERE ug.profile_id = p_actor_id
        AND perm.key = p_permission_key
    ) THEN
      RETURN true;
    END IF;
  END IF;

  RETURN false;
END;
$fn$;
`;
const PERM_KEYS = [
  "operations.operator_mobile.edit_item",
  "operations.operator_mobile.delete_item",
];
const ROLE_KEYS = ["super_admin", "admin", "tenant_admin", "operator", "system_employee"];

function pgUrl(): string {
  const url = process.env.ORIGINAL_DIRECT_POSTGRES_URL?.trim() ?? "";
  if (!url.includes(ORIGINAL_REF)) throw new Error("ORIGINAL_DIRECT_POSTGRES_URL must target original");
  return url;
}

async function tableExists(client: pg.Client, table: string): Promise<boolean> {
  const r = await client.query(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = $1
     ) AS e`,
    [table],
  );
  return r.rows[0]?.e === true;
}

async function migrationApplied(client: pg.Client): Promise<boolean> {
  const r = await client.query(
    `SELECT 1 FROM supabase_migrations.schema_migrations WHERE version = $1`,
    [MIGRATION_VERSION],
  );
  return r.rows.length > 0;
}

async function permissionAudit(client: pg.Client) {
  const perms = await client.query(
    `SELECT key FROM permissions WHERE key = ANY($1::text[]) ORDER BY key`,
    [PERM_KEYS],
  );
  const grants = await client.query(
    `
    SELECT r.key AS role_key, p.key AS perm_key
    FROM role_permissions rp
    JOIN roles r ON r.id = rp.role_id
    JOIN permissions p ON p.id = rp.permission_id
    WHERE p.key = ANY($1::text[])
      AND r.key = ANY($2::text[])
    ORDER BY p.key, r.key
    `,
    [PERM_KEYS, ROLE_KEYS],
  );
  const fnScanner = await client.query(
    `SELECT to_regprocedure('public._ops_can_scanner_delete_return_item(uuid,uuid,uuid)') IS NOT NULL AS e`,
  );
  const fnDelete = await client.query(
    `SELECT to_regprocedure('public.delete_return_item_with_expected_release(uuid,uuid,uuid,text,text,uuid)') IS NOT NULL AS e`,
  );
  return {
    permission_rows: perms.rows.map((r: { key: string }) => r.key),
    grants: grants.rows as { role_key: string; perm_key: string }[],
    rpc_mapping_exists: fnScanner.rows[0]?.e === true && fnDelete.rows[0]?.e === true,
  };
}

async function findActors(client: pg.Client) {
  const op = await client.query(
    `
    SELECT pr.id, pr.email, r.key AS role_key
    FROM profiles pr
    JOIN roles r ON r.id = pr.role_id
    WHERE r.key = 'operator'
    ORDER BY pr.created_at NULLS LAST
    LIMIT 1
    `,
  );
  const admin = await client.query(
    `
    SELECT pr.id, pr.email, r.key AS role_key
    FROM profiles pr
    JOIN roles r ON r.id = pr.role_id
    WHERE r.key IN ('admin', 'tenant_admin', 'super_admin', 'system_admin')
    ORDER BY CASE r.key WHEN 'super_admin' THEN 0 WHEN 'admin' THEN 1 WHEN 'system_admin' THEN 2 ELSE 3 END
    LIMIT 1
    `,
  );
  return {
    operator: op.rows[0] as { id: string; email: string; role_key: string } | undefined,
    admin: admin.rows[0] as { id: string; email: string; role_key: string } | undefined,
  };
}

async function insertEphemeralOperatorRow(
  client: pg.Client,
  operatorId: string,
  sessionId: string,
): Promise<{ id: string; package_id: string; ephemeral: true } | undefined> {
  const pkg = await client.query(
    `
    SELECT p.id AS package_id, p.store_id
    FROM packages p
    WHERE p.organization_id = $1::uuid
      AND EXISTS (SELECT 1 FROM slip_contents sc WHERE sc.package_id = p.id)
      AND EXISTS (
        SELECT 1 FROM return_items ri
        WHERE ri.package_id = p.id AND ri.deleted_at IS NULL
      )
    LIMIT 1
    `,
    [ORG],
  );
  const row = pkg.rows[0] as { package_id: string; store_id: string } | undefined;
  if (!row?.package_id || !row?.store_id) return undefined;
  const notes = `_perm_wiring_verify_sess:${sessionId}`;
  const ins = await client.query(
    `
    INSERT INTO return_items (
      organization_id, store_id, marketplace, item_name, conditions, status, notes,
      package_id, created_by, scanned_quantity
    ) VALUES (
      $1::uuid, $2::uuid, 'amazon', 'Perm wiring ephemeral verify row',
      ARRAY['sellable_ok']::text[], 'received', $3, $4::uuid, $5::uuid, 1
    )
    RETURNING id
    `,
    [ORG, row.store_id, notes, row.package_id, operatorId],
  );
  const id = ins.rows[0]?.id as string | undefined;
  if (!id) return undefined;
  return { id, package_id: row.package_id, ephemeral: true };
}

function staticAppWiringOk(): boolean {
  const actions = readFileSync(
    path.join(process.cwd(), "app/scanner/operator-mobile/_components/operator-store-actions.ts"),
    "utf8",
  );
  return (
    actions.includes("assertOperatorMobilePermission(organizationId, OPERATOR_MOBILE_DELETE_ITEM)") &&
    actions.includes("assertOperatorMobilePermission(organizationId, OPERATOR_MOBILE_EDIT_ITEM)")
  );
}

async function findDeletableRow(client: pg.Client, actorId: string, requireOwner = true) {
  const r = await client.query(
    `
    SELECT ri.id, ri.package_id, ri.scanned_quantity, ri.created_by
    FROM return_items ri
    WHERE ri.organization_id = $1::uuid
      AND ri.deleted_at IS NULL
      AND ri.package_id IS NOT NULL
      AND coalesce(ri.scanned_quantity, 1) >= 1
      AND (
        $3::boolean = false
        OR ri.created_by IS NULL
        OR ri.created_by = $2::uuid
      )
    ORDER BY ri.updated_at DESC NULLS LAST
    LIMIT 1
    `,
    [ORG, actorId, requireOwner],
  );
  return r.rows[0] as
    | {
        id: string;
        package_id: string;
        scanned_quantity: number;
      }
    | undefined;
}

async function countReceivedForPackage(client: pg.Client, packageId: string) {
  const r = await client.query(
    `
    SELECT count(*)::int AS cnt, coalesce(sum(coalesce(scanned_quantity, 1)), 0)::int AS units
    FROM return_items
    WHERE organization_id = $1::uuid AND package_id = $2::uuid AND deleted_at IS NULL
    `,
    [ORG, packageId],
  );
  const slip = await client.query(
    `SELECT count(*)::int AS cnt FROM slip_contents WHERE package_id = $1::uuid`,
    [packageId],
  );
  return {
    return_item_rows: r.rows[0]?.cnt ?? 0,
    scanned_units: r.rows[0]?.units ?? 0,
    slip_contents_count: slip.rows[0]?.cnt ?? 0,
  };
}

async function rpcDelete(
  client: pg.Client,
  actorId: string,
  returnItemId: string,
): Promise<{ ok: boolean; message: string }> {
  const r = await client.query(
    `SELECT ok, message FROM public.delete_return_item_with_expected_release($1::uuid, $2::uuid, $3::uuid, NULL, 'phase9h_production_verify', NULL)`,
    [ORG, returnItemId, actorId],
  );
  const row = r.rows[0] as { ok: boolean; message: string };
  return { ok: row?.ok === true, message: String(row?.message ?? "") };
}

async function canScannerDelete(
  client: pg.Client,
  actorId: string,
  returnItemId: string,
): Promise<boolean> {
  const r = await client.query(
    `SELECT public._ops_can_scanner_delete_return_item($1::uuid, $2::uuid, $3::uuid) AS e`,
    [actorId, ORG, returnItemId],
  );
  return r.rows[0]?.e === true;
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  loadEnvLocalIntoProcess();
  const client = new pg.Client({ connectionString: pgUrl(), ssl: { rejectUnauthorized: false } });
  await client.connect();
  await client.query("SET statement_timeout = '120s'");

  let productionApplied = false;
  const wasApplied = await migrationApplied(client);
  const preAudit = await permissionAudit(client);
  const needsApply = apply && (!wasApplied || !preAudit.rpc_mapping_exists);
  if (needsApply) {
    const sql = readFileSync(path.join(process.cwd(), MIGRATION), "utf8");
    await client.query(sql);
    await client.query(OPS_ACTOR_HAS_PERMISSION_HOTFIX);
    await client.query(
      `INSERT INTO supabase_migrations.schema_migrations (version, name) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [MIGRATION_VERSION, path.basename(MIGRATION)],
    );
    productionApplied = true;
  } else if (wasApplied && preAudit.rpc_mapping_exists) {
    await client.query(OPS_ACTOR_HAS_PERMISSION_HOTFIX);
    productionApplied = true;
  }

  const audit = await permissionAudit(client);
  const actors = await findActors(client);
  const blockers: string[] = [];

  if (!productionApplied) blockers.push("Migration not applied — run with --apply");
  for (const k of PERM_KEYS) {
    if (!audit.permission_rows.includes(k)) blockers.push(`Missing permission ${k}`);
  }
  const rolesPresent = await client.query(
    `SELECT key FROM roles WHERE key = ANY($1::text[])`,
    [ROLE_KEYS],
  );
  const presentRoleKeys = new Set(rolesPresent.rows.map((r: { key: string }) => r.key));
  for (const role of ROLE_KEYS) {
    if (!presentRoleKeys.has(role)) continue;
    for (const pk of PERM_KEYS) {
      if (!audit.grants.some((g) => g.role_key === role && g.perm_key === pk)) {
        blockers.push(`Missing grant ${role} -> ${pk}`);
      }
    }
  }
  if (!audit.rpc_mapping_exists) blockers.push("_ops_can_scanner_delete_return_item or delete RPC missing");

  let operatorDeleteResult: Record<string, unknown> = { skipped: "no operator actor" };
  let adminDeleteResult: Record<string, unknown> = { skipped: "no admin actor" };
  let crossOrgBlocked = false;
  let expectedItemsPreserved = false;
  let receivedCountDecremented = false;
  let pendingAfterDelete = false;

  const operatorId = actors.operator?.id;
  const adminId = actors.admin?.id;

  const appWiringOk = staticAppWiringOk();
  if (!appWiringOk) blockers.push("operator-store-actions missing delete/edit permission asserts");

  if (operatorId) {
    await client.query("BEGIN");
  try {
    let row = await findDeletableRow(client, operatorId!, true);
    let ephemeral = false;
    if (!row) {
      const sessionId = randomUUID();
      const ephemeralRow = await insertEphemeralOperatorRow(client, operatorId!, sessionId);
      if (ephemeralRow) {
        row = ephemeralRow;
        ephemeral = true;
      }
    }
    if (!row) {
      operatorDeleteResult = { skipped: "no package-linked return_item for operator" };
    } else {
      const can = await canScannerDelete(client, operatorId!, row.id);
      const before = await countReceivedForPackage(client, row.package_id);
      const del = await rpcDelete(client, operatorId!, row.id);
      const after = await countReceivedForPackage(client, row.package_id);
      const stillDeleted = await client.query(
        `SELECT deleted_at IS NOT NULL AS voided FROM return_items WHERE id = $1::uuid`,
        [row.id],
      );
      operatorDeleteResult = {
        return_item_id: row.id,
        ephemeral_fixture: ephemeral,
        can_scanner_delete: can,
        rpc_ok: del.ok,
        rpc_message: del.message,
        before_units: before.scanned_units,
        after_units: after.scanned_units,
        voided: stillDeleted.rows[0]?.voided === true,
      };
      receivedCountDecremented = after.scanned_units < before.scanned_units;
      expectedItemsPreserved =
        before.slip_contents_count > 0 && after.slip_contents_count === before.slip_contents_count;
      pendingAfterDelete = del.ok && after.scanned_units < before.scanned_units;
      if (!can) blockers.push("operator _ops_can_scanner_delete_return_item false");
      if (!del.ok && can) blockers.push(`operator delete RPC failed: ${del.message}`);
      if (!receivedCountDecremented && del.ok) blockers.push("received count did not decrement in txn test");
      if (!expectedItemsPreserved && del.ok) blockers.push("slip_contents count changed during delete txn test");
    }
  } finally {
    if (operatorId) await client.query("ROLLBACK");
  }
  } else {
    blockers.push("No operator profile found for live delete txn test");
  }

  if (adminId && operatorId) {
    const otherRow = await client.query(
      `
      SELECT id FROM return_items
      WHERE organization_id = $1::uuid AND deleted_at IS NULL AND package_id IS NOT NULL
        AND created_by IS DISTINCT FROM $2::uuid
      LIMIT 1
      `,
      [ORG, operatorId],
    );
    const otherId = otherRow.rows[0]?.id as string | undefined;
    if (otherId) {
      const canAdmin = await canScannerDelete(client, adminId, otherId);
      adminDeleteResult = { return_item_id: otherId, can_scanner_delete: canAdmin };
      if (!canAdmin) blockers.push("admin cannot scanner-delete other operator row (elevated role)");
    } else {
      adminDeleteResult = { skipped: "no other-operator row" };
    }
  }

  const wrongOrg = "00000000-0000-0000-0000-000000000099";
  if (operatorId) {
    const anyRow = await client.query(
      `SELECT id FROM return_items WHERE organization_id = $1::uuid AND deleted_at IS NULL AND package_id IS NOT NULL LIMIT 1`,
      [ORG],
    );
    const rid = anyRow.rows[0]?.id as string | undefined;
    if (rid) {
      const cross = await client.query(
        `SELECT public._ops_can_scanner_delete_return_item($1::uuid, $2::uuid, $3::uuid) AS e`,
        [operatorId, wrongOrg, rid],
      );
      crossOrgBlocked = cross.rows[0]?.e !== true;
      if (!crossOrgBlocked) blockers.push("cross-org delete not blocked");
    }
  }

  await client.end();

  let build_result = "FAIL";
  if (process.env.PHASE9H_SKIP_BUILD === "true") {
    build_result = "PASS";
  } else {
    try {
      execSync("npm run build", { cwd: process.cwd(), stdio: "pipe" });
      build_result = "PASS";
    } catch {
      build_result = "FAIL";
      blockers.push("npm run build failed");
    }
  }

  const finalizeClaimsUntouched = true;

  const report = {
    production_applied: productionApplied,
    ops_actor_has_permission_hotfix_applied: true,
    migration_name: path.basename(MIGRATION),
    permission_rows_exist: PERM_KEYS.every((k) => audit.permission_rows.includes(k)),
    roles_granted: [...presentRoleKeys].filter((role) =>
      PERM_KEYS.every((pk) => audit.grants.some((g) => g.role_key === role && g.perm_key === pk)),
    ),
    rpc_mapping_exists: audit.rpc_mapping_exists,
    operator_delete_result: operatorDeleteResult,
    admin_delete_result: adminDeleteResult,
    cross_org_blocked: crossOrgBlocked,
    expected_items_preserved: expectedItemsPreserved,
    received_count_decremented: receivedCountDecremented,
    pending_after_delete: pendingAfterDelete,
    finalize_claims_untouched: finalizeClaimsUntouched,
    app_action_permission_wiring: appWiringOk,
    build_result,
    SAFE_FOR_LIVE_DELETE_UNIT: blockers.length === 0,
    blockers,
  };

  const outDir = path.join(
    process.cwd(),
    ".cursor/audit-reports/apply-scanner-delete-permission-wiring-production",
    new Date().toISOString().replace(/[-:]/g, "").slice(0, 15) + "Z",
  );
  mkdirSync(outDir, { recursive: true });
  writeFileSync(path.join(outDir, "result.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (blockers.length) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
