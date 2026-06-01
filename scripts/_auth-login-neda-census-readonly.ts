/**
 * READ-ONLY auth census — original vs staging. No secrets in stdout.
 * npx tsx scripts/_auth-login-neda-census-readonly.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createClient } from "@supabase/supabase-js";

const ORIGINAL_REF = "kxsvedvpjldygtdbylsy";
const STAGING_REF = "eiqfaapyumhixxoeltgu";

function loadEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  const p = path.join(process.cwd(), ".env.local");
  if (!fs.existsSync(p)) return out;
  for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq <= 0) continue;
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[t.slice(0, eq).trim()] = v;
  }
  return out;
}

function refFromUrl(url: string): string | null {
  const m = url.match(/https:\/\/([a-z0-9]{20})\.supabase\.co/i);
  return m?.[1] ?? null;
}

type AuthUserRow = {
  id: string;
  email: string | null;
  email_confirmed_at: string | null;
  confirmed_at: string | null;
  banned_until: string | null;
  deleted_at: string | null;
  is_anonymous: boolean;
  raw_app_meta: Record<string, unknown>;
  raw_user_meta: Record<string, unknown>;
  identities: Array<{ provider: string; identity_data?: Record<string, unknown> }>;
};

async function censusProject(label: string, url: string, serviceKey: string, emailPatterns: string[]) {
  const ref = refFromUrl(url);
  const sb = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

  const { data: listData, error: listErr } = await sb.auth.admin.listUsers({ perPage: 1000 });
  const users = listData?.users ?? [];

  const patternMatch = (email: string | undefined) => {
    const e = (email ?? "").toLowerCase();
    return emailPatterns.some((p) => e.includes(p.toLowerCase()));
  };

  const matched = users.filter((u) => patternMatch(u.email ?? undefined));
  const maysam = users.filter((u) => /maysam|mebrahim/i.test(u.email ?? ""));
  const neda = users.filter((u) => /neda/i.test(u.email ?? "") || /neda/i.test(JSON.stringify(u.user_metadata ?? {})));

  async function profileFor(uid: string) {
    const { data, error } = await sb
      .from("profiles")
      .select("id, email, full_name, organization_id, role_id, is_active, deleted_at, roles(key, name)")
      .eq("id", uid)
      .maybeSingle();
    return { data, error: error?.message ?? null };
  }

  async function orgMembers(uid: string) {
    const { data, error } = await sb
      .from("organization_members")
      .select("organization_id, role, is_active, organizations(name)")
      .eq("user_id", uid);
    return { data: data ?? [], error: error?.message ?? null };
  }

  async function enrich(u: (typeof users)[0]) {
    const [prof, mem] = await Promise.all([profileFor(u.id), orgMembers(u.id)]);
    const identities = (u.identities ?? []).map((i) => ({
      provider: i.provider,
      email: (i.identity_data as { email?: string })?.email ?? null,
    }));
    return {
      id: u.id,
      email: u.email,
      email_confirmed_at: u.email_confirmed_at,
      confirmed_at: (u as { confirmed_at?: string }).confirmed_at ?? null,
      banned_until: (u as { banned_until?: string }).banned_until ?? null,
      deleted_at: (u as { deleted_at?: string }).deleted_at ?? null,
      last_sign_in_at: u.last_sign_in_at,
      created_at: u.created_at,
      providers: identities,
      user_metadata: u.user_metadata,
      profile: prof.data,
      profile_error: prof.error,
      organization_members: mem.data,
      org_members_error: mem.error,
    };
  }

  const enrichedNeda = await Promise.all(neda.map(enrich));
  const enrichedMaysam = await Promise.all(maysam.map(enrich));
  const enrichedMatched = await Promise.all(matched.map(enrich));

  return {
    label,
    ref,
    list_error: listErr?.message ?? null,
    total_auth_users: users.length,
    neda_matches: enrichedNeda,
    maysam_matches: enrichedMaysam,
    pattern_matches: enrichedMatched,
  };
}

async function main() {
  const env = loadEnv();
  const patterns = (process.env.CENSUS_EMAIL_PATTERNS ?? "neda,maysam,mebrahim").split(",").map((s) => s.trim());

  const projects = [
    {
      label: "original",
      url: env.ORIGINAL_SUPABASE_URL ?? "",
      key: env.ORIGINAL_SERVICE_ROLE_KEY ?? "",
    },
    {
      label: "staging",
      url: env.STAGING_SUPABASE_URL ?? env.NEXT_PUBLIC_SUPABASE_URL ?? "",
      key: env.STAGING_SERVICE_ROLE_KEY ?? env.SUPABASE_SERVICE_ROLE_KEY ?? "",
    },
    {
      label: "local_active",
      url: env.NEXT_PUBLIC_SUPABASE_URL ?? "",
      key: env.SUPABASE_SERVICE_ROLE_KEY ?? "",
    },
  ];

  const results = [];
  for (const p of projects) {
    if (!p.url || !p.key) {
      results.push({ label: p.label, error: "missing url or service key in .env.local" });
      continue;
    }
    results.push(await censusProject(p.label, p.url, p.key, patterns));
  }

  const outPath = process.argv.find((a) => a.startsWith("--out="))?.split("=").slice(1).join("=");
  const json = JSON.stringify({ generated_at: new Date().toISOString(), projects: results }, null, 2);
  if (outPath) {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, json);
    console.log(JSON.stringify({ out: outPath, refs: results.map((r: { ref?: string; label?: string }) => ({ label: r.label, ref: r.ref })) }));
  } else {
    console.log(json);
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
