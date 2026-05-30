/**
 * Read-only census: platform + org branding logo URLs (no writes).
 * Run: npx tsx scripts/_menorix-pwa-brand-icon-discovery-readonly.ts
 */
import { createClient } from "@supabase/supabase-js";
import { readFileSync, existsSync } from "fs";
import { join } from "path";

function loadEnvLocal() {
  const p = join(process.cwd(), ".env.local");
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i <= 0) continue;
    const k = t.slice(0, i).trim();
    let v = t.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (!process.env[k]) process.env[k] = v;
  }
}

async function main() {
  loadEnvLocal();
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ?? "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ?? "";
  if (!url || !key) {
    console.error(JSON.stringify({ ok: false, error: "missing supabase env" }));
    process.exit(1);
  }

  const admin = createClient(url, key, { auth: { persistSession: false } });

  const { data: platform, error: pErr } = await admin
    .from("platform_settings")
    .select("app_name, logo_url, updated_at")
    .eq("id", true)
    .maybeSingle();

  const { data: orgs, error: oErr } = await admin
    .from("organizations")
    .select("id, name, type")
    .ilike("name", "%menorix%")
    .limit(10);

  const orgIds = (orgs ?? []).map((o) => String((o as { id: string }).id));
  let orgSettings: unknown[] = [];
  if (orgIds.length) {
    const { data } = await admin
      .from("organization_settings")
      .select("organization_id, company_display_name, logo_url, updated_at")
      .in("organization_id", orgIds);
    orgSettings = data ?? [];
  }

  // List platform logo objects in logos bucket under _platform/
  const { data: platformObjects } = await admin.storage.from("logos").list("_platform", { limit: 20 });

  const out = {
    ok: true,
    platform_settings: platform ?? null,
    platform_error: pErr?.message ?? null,
    organizations_menorix: orgs ?? [],
    org_settings: orgSettings,
    org_error: oErr?.message ?? null,
    storage_logos_platform_prefix: (platformObjects ?? []).map((o) => ({
      name: o.name,
      id: o.id,
      updated_at: o.updated_at,
    })),
  };
  console.log(JSON.stringify(out, null, 2));
}

main().catch((e) => {
  console.error(JSON.stringify({ ok: false, error: String(e) }));
  process.exit(1);
});
