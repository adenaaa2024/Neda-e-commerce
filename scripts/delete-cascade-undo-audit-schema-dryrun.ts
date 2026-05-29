/**
 * DELETE-CASCADE-UNDO-AUDIT-SCHEMA-DRYRUN — migration draft validation (no apply)
 *
 *   npx tsx scripts/delete-cascade-undo-audit-schema-dryrun.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import pg from "pg";

import { loadEnvLocalIntoProcess, refFromSupabaseUrl } from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const REQUIRED_BRANCH = "feature/product-canonicalization-v2";
const OUT_BASE = ".cursor/audit-reports/delete-cascade-undo-audit-schema-dryrun";
const ARCH_PLAN_GLOB = ".cursor/audit-reports/delete-cascade-undo-audit-architecture-plan";
const MIGRATION_PATH = "supabase/migrations/20260901120000_delete_cascade_undo_audit_foundation.sql";
const ITEM_LEVEL_MIGRATION = "supabase/migrations/20260830120000_expected_receive_split_item_level.sql";

const REQUIRED_OBJECTS = [
  "public.audit_events",
  "public.undo_snapshots",
  "public.restore_conflicts",
  "public.delete_pallet_cascade",
  "public.delete_package_cascade",
  "public.delete_return_item_with_expected_release",
  "public.move_return_item_parent",
  "public.restore_deleted_entity",
] as const;

const PERMISSION_KEYS = [
  "ops.delete_pallet_cascade",
  "ops.delete_package_cascade",
  "ops.delete_return_item",
  "ops.move_return_item_parent",
  "ops.restore_deleted_entity",
  "ops.view_undo_history",
] as const;

function runIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function findLatestArchPlan(): { runId: string | null; path: string | null } {
  const base = path.join(process.cwd(), ARCH_PLAN_GLOB);
  if (!fs.existsSync(base)) return { runId: null, path: null };
  const dirs = fs
    .readdirSync(base)
    .filter((d) => fs.statSync(path.join(base, d)).isDirectory())
    .sort();
  const last = dirs[dirs.length - 1];
  return last ? { runId: last, path: path.join(base, last) } : { runId: null, path: null };
}

async function readOnlySchemaChecks(): Promise<{
  ok: boolean;
  checks: Record<string, string>;
}> {
  const dbUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ?? "";
  const checks: Record<string, string> = {};
  if (!dbUrl) {
    checks.db = "skipped — STAGING_DIRECT_POSTGRES_URL unset";
    return { ok: true, checks };
  }

  const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();
  try {
    for (const obj of REQUIRED_OBJECTS) {
      const [schema, name] = obj.replace("public.", "").split(".");
      const kind = name?.includes("_") && obj.includes("delete_") ? "function" : "table";
      const r = await client.query(
        `SELECT 1 FROM pg_catalog.pg_${kind === "function" ? "proc" : "class"} c
         JOIN pg_catalog.pg_namespace n ON n.oid = c.${kind === "function" ? "pronamespace" : "relnamespace"}
         WHERE n.nspname = $1 AND c.${kind === "function" ? "proname" : "relname"} = $2
         LIMIT 1`,
        [schema, name],
      );
      checks[obj] = r.rowCount ? "exists (already applied?)" : "not_present (expected pre-migration)";
    }

    for (const col of ["deleted_at", "deleted_by", "undo_batch_id"] as const) {
      for (const tbl of ["pallets", "packages", "return_items"] as const) {
        const r = await client.query(
          `SELECT 1 FROM information_schema.columns
           WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
          [tbl, col],
        );
        const key = `${tbl}.${col}`;
        checks[key] = r.rowCount
          ? col === "deleted_at"
            ? "present"
            : "missing (migration will add)"
          : "missing";
      }
    }

    const fn = await client.query(
      `SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'release_expected_item_unit'`,
    );
    checks["release_expected_item_unit"] = fn.rowCount ? "present" : "MISSING — apply item-level migration first";

    const orgCol = await client.query(
      `SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'organization_settings'
         AND column_name = 'undo_snapshot_retention_days'`,
    );
    checks["organization_settings.undo_snapshot_retention_days"] = orgCol.rowCount
      ? "exists"
      : "not_present (expected pre-migration)";
  } finally {
    await client.end();
  }

  const ok = !Object.values(checks).some((v) => v.startsWith("MISSING"));
  return { ok, checks };
}

async function main(): Promise<void> {
  const runId = runIdArg();
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  loadEnvLocalIntoProcess();
  const blockers: string[] = [];
  const warnings: string[] = [];

  let branch = "unknown";
  try {
    branch = execSync("git branch --show-current", { encoding: "utf8" }).trim();
  } catch {
    blockers.push("Could not read git branch");
  }
  if (branch !== REQUIRED_BRANCH) {
    blockers.push(`Branch \`${branch}\` !== \`${REQUIRED_BRANCH}\``);
  }

  const urlRef = refFromSupabaseUrl(process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ?? "");
  if (urlRef && urlRef !== STAGING_REF) {
    blockers.push(`NEXT_PUBLIC_SUPABASE_URL ref ${urlRef} !== staging ${STAGING_REF}`);
  }

  const arch = findLatestArchPlan();
  if (!arch.runId) {
    warnings.push(
      "DELETE CASCADE + UNDO AUDIT ARCHITECTURE PLAN artifact not found under .cursor/audit-reports/delete-cascade-undo-audit-architecture-plan/ — draft follows operational chain + item-level split",
    );
  }

  if (!fs.existsSync(path.join(process.cwd(), MIGRATION_PATH))) {
    blockers.push(`Migration file missing: ${MIGRATION_PATH}`);
  }
  if (!fs.existsSync(path.join(process.cwd(), ITEM_LEVEL_MIGRATION))) {
    blockers.push(`Prerequisite missing: ${ITEM_LEVEL_MIGRATION}`);
  }

  const migrationSql = fs.readFileSync(path.join(process.cwd(), MIGRATION_PATH), "utf8");
  fs.writeFileSync(path.join(outDir, "delete-cascade-undo-migration-draft.sql"), migrationSql);

  const schemaChecks = await readOnlySchemaChecks();
  if (!schemaChecks.ok) {
    blockers.push("Prerequisite function release_expected_item_unit not on staging — apply item-level migration first");
  }

  fs.writeFileSync(
    path.join(outDir, "schema-preflight.json"),
    JSON.stringify(schemaChecks, null, 2),
  );

  fs.writeFileSync(
    path.join(outDir, "architecture-reference.md"),
    [
      "# Architecture alignment (draft)",
      "",
      arch.runId
        ? `Source plan: \`${ARCH_PLAN_GLOB}/${arch.runId}/\``
        : "**Plan artifact missing** — inferred from repo:",
      "",
      "## Operational chain",
      "",
      "`pallets` → `packages` → `return_items` (soft-delete only)",
      "",
      "## Item-level expected integration",
      "",
      "| Action | RPC |",
      "|--------|-----|",
      "| Delete return item | `release_expected_item_unit` before soft-delete |",
      "| Move parent (allocated) | `move_expected_item_unit` |",
      "| Restore | Row restore only; EP re-allocate via `allocate_expected_item_unit` (deferred in restore) |",
      "",
      "## Undo model",
      "",
      "- Single `undo_batch_id` per cascade (shared across pallet/package/items)",
      "- `undo_snapshots` row JSON + `expected_allocation` jsonb",
      "- `restore_conflicts` for duplicate LPN/tracking, claims, retention",
      "- `organization_settings.undo_snapshot_retention_days` default 30",
      "",
      "## Forbidden",
      "",
      "- No `package_items`",
      "- No hard DELETE on operational entities",
    ].join("\n") + "\n",
  );

  fs.writeFileSync(
    path.join(outDir, "functions-contract.md"),
    [
      "# RPC contract (draft)",
      "",
      "| Function | Permission | Notes |",
      "|----------|------------|-------|",
      "| `delete_pallet_cascade` | ops.delete_pallet_cascade | Packages on pallet + orphan pallet return_items |",
      "| `delete_package_cascade` | ops.delete_package_cascade | All return_items on package |",
      "| `delete_return_item_with_expected_release` | ops.delete_return_item | Calls release_expected_item_unit |",
      "| `move_return_item_parent` | ops.move_return_item_parent | Adjusts counts; move_expected_item_unit when allocated |",
      "| `restore_deleted_entity` | ops.restore_deleted_entity | Conflict-aware; EP re-link manual post-restore |",
    ].join("\n") + "\n",
  );

  fs.writeFileSync(
    path.join(outDir, "permissions-seed.md"),
    PERMISSION_KEYS.map((k) => `- \`${k}\``).join("\n") + "\n",
  );

  fs.writeFileSync(
    path.join(outDir, "blockers.md"),
    [
      ...(blockers.length ? blockers.map((b) => `- ${b}`) : ["- None (apply blocked until operator approval)"]),
      "",
      "## Warnings",
      "",
      ...(warnings.length ? warnings.map((w) => `- ${w}`) : ["- None"]),
    ].join("\n") + "\n",
  );

  const exactNextPrompt =
    arch.runId
      ? "DELETE-CASCADE-UNDO-AUDIT-MIGRATION-STAGING-APPLY — operator approval + apply 20260901120000 on staging + server actions wiring"
      : "DELETE-CASCADE-UNDO-AUDIT-ARCHITECTURE-PLAN — publish plan artifact, then DELETE-CASCADE-UNDO-AUDIT-MIGRATION-STAGING-APPLY";

  fs.writeFileSync(
    path.join(outDir, "manifest.json"),
    JSON.stringify(
      {
        prompt: "DELETE-CASCADE-UNDO-AUDIT-SCHEMA-DRYRUN",
        run_id: runId,
        ok: blockers.length === 0,
        migration_drafted: fs.existsSync(path.join(process.cwd(), MIGRATION_PATH)),
        migration_path: MIGRATION_PATH,
        architecture_plan_run_id: arch.runId,
        schema_preflight: schemaChecks,
        permission_keys: PERMISSION_KEYS,
        exact_next_prompt: exactNextPrompt,
        db_mutated: false,
      },
      null,
      2,
    ),
  );

  console.log(
    JSON.stringify(
      {
        ok: blockers.length === 0,
        outDir,
        migration_drafted: true,
        blockers,
        warnings,
        exact_next_prompt: exactNextPrompt,
      },
      null,
      2,
    ),
  );
  if (blockers.length) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
