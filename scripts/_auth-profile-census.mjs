import { createClient } from "@supabase/supabase-js";
import * as fs from "node:fs";
import * as path from "node:path";

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

async function census(refLabel, url, key) {
  const sb = createClient(url, key, { auth: { persistSession: false } });
  const ids = {
    neda: "c4c8d0c1-e734-4cc7-b2a0-4cda409d9dfc",
    maysam: "0cae8ddc-de0f-477d-99ec-d52e3e937dd5",
  };
  const out = { refLabel };
  for (const [name, id] of Object.entries(ids)) {
    const { data: prof, error: pErr } = await sb
      .from("profiles")
      .select("id, organization_id, full_name, role, role_id, deleted_at, roles(key, name, scope)")
      .eq("id", id)
      .maybeSingle();
    const { data: auth } = await sb.auth.admin.getUserById(id);
    out[name] = {
      auth_email: auth.user?.email,
      email_confirmed_at: auth.user?.email_confirmed_at,
      last_sign_in_at: auth.user?.last_sign_in_at,
      identities: (auth.user?.identities ?? []).map((i) => i.provider),
      profile: prof,
      profile_error: pErr?.message ?? null,
    };
  }
  return out;
}

async function main() {
  const original = await census("original", env.ORIGINAL_SUPABASE_URL, env.ORIGINAL_SERVICE_ROLE_KEY);
  const staging = await census("staging", env.STAGING_SUPABASE_URL, env.STAGING_SERVICE_ROLE_KEY);
  const outArg = process.argv.find((a) => a.startsWith("--out="))?.slice(6) ?? "";
  const json = JSON.stringify({ original, staging }, null, 2);
  if (outArg) {
    fs.mkdirSync(path.dirname(outArg), { recursive: true });
    fs.writeFileSync(outArg, json);
    console.log("wrote", outArg);
  } else console.log(json);
}

void main();
