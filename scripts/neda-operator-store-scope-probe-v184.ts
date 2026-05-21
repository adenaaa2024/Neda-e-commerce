/**
 * Read-only staging probe for NEDA-OPERATOR-STORE-SCOPE-FIX-V184.
 * Usage: npx tsx scripts/neda-operator-store-scope-probe-v184.ts
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@supabase/supabase-js";

const SAM_ORG = "00000000-0000-0000-0000-000000000001";
const SAM_STORE = "509ee1f6-622c-46a5-8110-7b889ba46c2c";

function loadEnvLocal(): void {
  const p = join(process.cwd(), ".env.local");
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i === -1) continue;
    const k = t.slice(0, i).trim();
    let v = t.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (!process.env[k]) process.env[k] = v;
  }
}

async function main(): Promise<void> {
  loadEnvLocal();
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ?? "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ?? "";
  if (!url || !key) {
    console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
    process.exit(1);
  }

  const userId =
    process.env.SCANNER_NEDA_14_AUTH_USER_ID?.trim() || "c4c8d0c1-e734-4cc7-b2a0-4cda409d9dfc";
  const sb = createClient(url, key, { auth: { persistSession: false } });

  const { data: prof, error: profErr } = await sb
    .from("profiles")
    .select("id, organization_id, full_name, role, roles!profiles_role_id_fkey(key, name)")
    .eq("id", userId)
    .maybeSingle();

  if (profErr) {
    console.error("profile error", profErr.message);
    process.exit(1);
  }

  const homeOrg = String((prof as { organization_id?: string })?.organization_id ?? "").trim();
  console.log(JSON.stringify({ profile: prof, sam_org_id: SAM_ORG, sam_store_id: SAM_STORE }, null, 2));

  if (homeOrg) {
    const [{ data: org }, { data: stores }, { data: settings }] = await Promise.all([
      sb.from("organizations").select("id,name,type").eq("id", homeOrg).maybeSingle(),
      sb.from("stores").select("id,name,is_active,platform").eq("organization_id", homeOrg).order("name"),
      sb.from("organization_settings").select("default_store_id").eq("organization_id", homeOrg).maybeSingle(),
    ]);
    console.log(
      JSON.stringify(
        { scope: "home_org", org, active_stores: (stores ?? []).filter((s) => s.is_active), settings },
        null,
        2,
      ),
    );
  }

  const [{ data: samOrg }, { data: samStores }, { data: samSettings }] = await Promise.all([
    sb.from("organizations").select("id,name,type").eq("id", SAM_ORG).maybeSingle(),
    sb
      .from("stores")
      .select("id,name,is_active,platform")
      .eq("organization_id", SAM_ORG)
      .eq("is_active", true)
      .order("name"),
    sb.from("organization_settings").select("default_store_id").eq("organization_id", SAM_ORG).maybeSingle(),
  ]);
  console.log(
    JSON.stringify(
      {
        scope: "sam_org",
        org: samOrg,
        active_stores: samStores,
        default_store_id: samSettings?.default_store_id,
        sam_am_present: Boolean(samStores?.some((s) => s.id === SAM_STORE)),
      },
      null,
      2,
    ),
  );
}

void main();
