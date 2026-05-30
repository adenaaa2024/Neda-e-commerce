/** Read-only verify Neda on original — no secrets logged */
import { createClient } from "@supabase/supabase-js";
import * as fs from "node:fs";

const NEDA_ID = "c4c8d0c1-e734-4cc7-b2a0-4cda409d9dfc";
const env = {};
for (const line of fs.readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const t = line.trim();
  if (!t || t.startsWith("#")) continue;
  const eq = t.indexOf("=");
  if (eq <= 0) continue;
  let v = t.slice(eq + 1).trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
  env[t.slice(0, eq)] = v;
}

const sb = createClient(env.ORIGINAL_SUPABASE_URL, env.ORIGINAL_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const { data: auth } = await sb.auth.admin.getUserById(NEDA_ID);
const { data: prof } = await sb
  .from("profiles")
  .select("id, full_name, organization_id, role, role_id, roles(key, name, scope)")
  .eq("id", NEDA_ID)
  .maybeSingle();
const orgId = prof?.organization_id ?? "";
const { data: org } = orgId
  ? await sb.from("organizations").select("name").eq("id", orgId).maybeSingle()
  : { data: null };

const baselineLastSignIn = "2026-05-06T19:22:13.283279Z";
const current = auth.user?.last_sign_in_at ?? null;
const loginLikelyPass = current && current > baselineLastSignIn;

console.log(
  JSON.stringify(
    {
      ref: "kxsvedvpjldygtdbylsy",
      email: auth.user?.email,
      email_confirmed_at: auth.user?.email_confirmed_at,
      last_sign_in_at: current,
      updated_at: auth.user?.updated_at,
      recovery_sent_at: auth.user?.recovery_sent_at ?? null,
      baseline_last_sign_in_at: baselineLastSignIn,
      original_login_since_baseline: loginLikelyPass,
      profile: {
        full_name: prof?.full_name,
        role: prof?.roles?.key ?? prof?.role,
        organization_id: prof?.organization_id,
        organization_name: org?.name ?? null,
      },
    },
    null,
    2,
  ),
);
