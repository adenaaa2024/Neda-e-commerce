/**
 * NEXT-CLAIM-33 — Read-only smoke for claim permission guard (no DB writes).
 *
 *   npx tsx scripts/claim-permission-guard-smoke.ts
 *   CLAIM_PERM_SMOKE_USER_ID=<uuid> npx tsx scripts/claim-permission-guard-smoke.ts
 *
 * Uses SUPABASE_SERVICE_ROLE_KEY + NEXT_PUBLIC_SUPABASE_URL (loads .env.local when present).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import {
  CLAIM_PERMISSION_CATALOG,
  type ClaimPermissionKey,
} from "../lib/claim-permissions";
import {
  evaluateClaimPermissionForActor,
  getUserStoreAccessForOrganization,
} from "../lib/claim-permission-evaluate";

const DEFAULT_ORG = "00000000-0000-0000-0000-000000000001";

function loadEnvLocal(): void {
  const p = path.join(process.cwd(), ".env.local");
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq <= 0) continue;
    const k = t.slice(0, eq).trim();
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[k] == null || process.env[k] === "") process.env[k] = v;
  }
}

function isoRunId(): string {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z/, "Z");
}

function ensureAuditDir(): string {
  const runId = isoRunId();
  const dir = path.join(process.cwd(), ".cursor", "audit-reports", "next-claim-33", runId);
  fs.mkdirSync(path.join(dir, "logs"), { recursive: true });
  return dir;
}

function appendNd(logPath: string, row: Record<string, unknown>): void {
  fs.appendFileSync(logPath, `${JSON.stringify(row)}\n`, "utf8");
}

function supabaseFromEnv(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  }
  return createClient(url, key, { auth: { persistSession: false } });
}

async function pickActor(
  supabase: SupabaseClient,
  explicitUserId: string | null,
): Promise<{ userId: string; organizationId: string; storeId: string } | null> {
  if (explicitUserId) {
    const { data: prof } = await supabase
      .from("profiles")
      .select("id, organization_id")
      .eq("id", explicitUserId)
      .maybeSingle();
    if (!prof?.organization_id) return null;
    const orgId = String(prof.organization_id);
    const { data: store } = await supabase
      .from("stores")
      .select("id")
      .eq("organization_id", orgId)
      .limit(1)
      .maybeSingle();
    if (!store?.id) return { userId: explicitUserId, organizationId: orgId, storeId: "" };
    return { userId: explicitUserId, organizationId: orgId, storeId: String(store.id) };
  }

  const { data: row } = await supabase
    .from("stores")
    .select("id, organization_id")
    .limit(1)
    .maybeSingle();
  if (!row?.organization_id || !row.id) return null;
  const orgId = String(row.organization_id);
  const { data: prof } = await supabase
    .from("profiles")
    .select("id")
    .eq("organization_id", orgId)
    .limit(1)
    .maybeSingle();
  if (!prof?.id) return null;
  return { userId: String(prof.id), organizationId: orgId, storeId: String(row.id) };
}

async function main(): Promise<void> {
  loadEnvLocal();
  const auditDir = ensureAuditDir();
  const logPath = path.join(auditDir, "logs", "permission-guard.ndjson");
  const explicitUser = process.env.CLAIM_PERM_SMOKE_USER_ID?.trim() || null;

  appendNd(logPath, { ts: new Date().toISOString(), event: "start", auditDir });

  let supabase: SupabaseClient;
  try {
    supabase = supabaseFromEnv();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    appendNd(logPath, { ts: new Date().toISOString(), event: "env_error", msg });
    console.error(msg);
    process.exitCode = 1;
    return;
  }

  const picked = await pickActor(supabase, explicitUser);
  if (!picked) {
    appendNd(logPath, { ts: new Date().toISOString(), event: "no_actor", note: "No profile/store pair found" });
    console.log(JSON.stringify({ ok: true, note: "no_actor", message: "No assignments/profile-store sample; denial tests still run with synthetic ids." }));
  } else {
    appendNd(logPath, { ts: new Date().toISOString(), event: "picked", ...picked });
    const assign = await getUserStoreAccessForOrganization(picked.userId, picked.organizationId);
    console.log(JSON.stringify({ phase: "assignments", assignments: assign }, null, 2));
    appendNd(logPath, { ts: new Date().toISOString(), event: "assignments", result: assign });
  }

  const orgId = picked?.organizationId ?? DEFAULT_ORG;
  const userId = picked?.userId ?? "00000000-0000-0000-0000-000000000000";

  const denyMarketplace = await evaluateClaimPermissionForActor("claims.marketplace.submit", userId, {
    organizationId: orgId,
  });
  appendNd(logPath, { ts: new Date().toISOString(), event: "deny_marketplace_no_store", result: denyMarketplace });
  console.log("deny marketplace (no store):", denyMarketplace);

  const denyBadStore = await evaluateClaimPermissionForActor("claims.inbox.view", userId, {
    organizationId: orgId,
    storeId: "00000000-0000-0000-0000-000000000099",
  });
  appendNd(logPath, { ts: new Date().toISOString(), event: "deny_bad_store", result: denyBadStore });
  console.log("deny bad store:", denyBadStore);

  if (picked?.storeId) {
    const inbox = await evaluateClaimPermissionForActor("claims.inbox.view", userId, {
      organizationId: picked.organizationId,
      storeId: picked.storeId,
    });
    appendNd(logPath, { ts: new Date().toISOString(), event: "inbox_with_store", result: inbox });
    console.log("inbox with store:", inbox);
  }

  const catalogLines = (Object.keys(CLAIM_PERMISSION_CATALOG) as ClaimPermissionKey[])
    .map((k) => {
      const m = CLAIM_PERMISSION_CATALOG[k];
      return `- \`${k}\` — risk ${m.risk}, requiredStore=${m.requiredStore}, min=${m.minimumStoreAccess}`;
    })
    .join("\n");

  fs.writeFileSync(
    path.join(auditDir, "permission-catalog.md"),
    `<!-- markdownlint-disable MD013 -->\n# Permission catalog (generated)\n\n${catalogLines}\n`,
    "utf8",
  );

  fs.writeFileSync(
    path.join(auditDir, "store-assignment-read.md"),
    "<!-- markdownlint-disable MD013 -->\n# Store assignment read\n\n" +
      "Helper: `getUserStoreAccessForOrganization(userId, organizationId)` in `lib/claim-permission-evaluate.ts`.\n\n" +
      "Last smoke: see `logs/permission-guard.ndjson` event `assignments`.\n",
    "utf8",
  );

  fs.writeFileSync(
    path.join(auditDir, "denial-cases.md"),
    "<!-- markdownlint-disable MD013 -->\n# Denial cases exercised\n\n" +
      "- `claims.marketplace.submit` without `storeId` → `STORE_REQUIRED` (or `ORG_DENIED` if user id invalid).\n" +
      "- `claims.inbox.view` with fake store id → `STORE_DENIED`.\n",
    "utf8",
  );

  fs.writeFileSync(
    path.join(auditDir, "rls-policy-checks.md"),
    "<!-- markdownlint-disable MD013 -->\n# RLS policy checks\n\n" +
      "Guard uses service-role reads for `user_store_assignments`. Postgres RLS applies to authenticated clients only.\n",
    "utf8",
  );

  fs.writeFileSync(
    path.join(auditDir, "unresolved-risks.md"),
    "<!-- markdownlint-disable MD013 -->\n# Unresolved risks\n\n" +
      "- Profile vs assignment `organization_id` not enforced in DB.\n" +
      "- `claimFamily` / entity scoping not implemented (skeleton).\n" +
      "- Tenant admin implicit `submit` on store rows without `user_store_assignments` except when `requireExplicitAssignmentForTenantAdmin` is set (marketplace/evidence.delete/etc.).\n",
    "utf8",
  );

  fs.writeFileSync(
    path.join(auditDir, "permission-guard-summary.md"),
    "<!-- markdownlint-disable MD013 -->\n# NEXT-CLAIM-33 — permission guard summary\n\n" +
      `- Run: ${path.basename(auditDir)}\n` +
      "- Modules: `lib/claim-permissions.ts`, `lib/claim-permission-evaluate.ts`, `lib/claim-permission-guard.ts`\n" +
      "- Claim Inbox UI: not wired (helper-only).\n" +
      "- Next: wire `assertClaimPermission` into read APIs incrementally.\n",
    "utf8",
  );

  fs.writeFileSync(
    path.join(auditDir, "manifest.json"),
    JSON.stringify(
      {
        audit: "next-claim-33",
        run_id: path.basename(auditDir),
        smoke: "scripts/claim-permission-guard-smoke.ts",
        permanent_inserts: false,
        artifacts: [
          "permission-guard-summary.md",
          "permission-catalog.md",
          "store-assignment-read.md",
          "denial-cases.md",
          "rls-policy-checks.md",
          "unresolved-risks.md",
          "logs/permission-guard.ndjson",
          "manifest.json",
        ],
      },
      null,
      2,
    ),
    "utf8",
  );

  console.log("auditDir:", auditDir);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
