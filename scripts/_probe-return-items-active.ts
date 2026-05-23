import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { createClient } from "@supabase/supabase-js";

function loadEnv() {
  const p = join(process.cwd(), ".env.local");
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i === -1) continue;
    const k = t.slice(0, i).trim();
    let v = t.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!process.env[k]) process.env[k] = v;
  }
}
loadEnv();
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false },
});

const orgs = [
  { name: "fixture", org: "7397edff-7994-4731-8501-55d258d507d2", store: "9adfe198-7c6a-49a5-b0b4-d370a83de06f" },
  { name: "sam", org: "00000000-0000-0000-0000-000000000001", store: "509ee1f6-622c-46a5-8110-7b889ba46c2c" },
];

(async () => {
  for (const { name, org, store } of orgs) {
    const { data: pkgs } = await sb
      .from("packages")
      .select("id, package_code, actual_item_count, tracking_number")
      .eq("organization_id", org)
      .eq("store_id", store)
      .gt("actual_item_count", 0)
      .is("deleted_at", null)
      .limit(5);
    console.log(name, "packages_with_items", pkgs?.length ?? 0);
    for (const p of pkgs ?? []) {
      const pkgId = (p as { id: string }).id;
      const { count: active } = await sb
        .from("return_items")
        .select("id", { count: "exact", head: true })
        .eq("package_id", pkgId)
        .is("deleted_at", null);
      const { count: del } = await sb
        .from("return_items")
        .select("id", { count: "exact", head: true })
        .eq("package_id", pkgId)
        .not("deleted_at", "is", null);
      console.log(" ", (p as { package_code?: string }).package_code, "active_ri", active, "soft_del", del);
    }
  }
  const { data: anyRi } = await sb
    .from("return_items")
    .select("id, package_id, organization_id, resolved_product_id, identifier_resolution_status, fnsku")
    .is("deleted_at", null)
    .not("package_id", "is", null)
    .limit(5);
  console.log("any_active_return_items_sample", anyRi);
})();
