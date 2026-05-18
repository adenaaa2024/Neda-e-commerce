/**
 * SCANNER-02I — read-only staging DB verification + product display column probe.
 * Run: npx tsx scripts/scanner-02i-db-verify.ts --run-id=20260517T100000Z
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createClient } from "@supabase/supabase-js";
import { pickProductRowDisplayName } from "../lib/scanner-product-linkage-ui";

const ORG = "00000000-0000-0000-0000-000000000001";
const RETURN_ROW = "f3a3ad84-4115-4cf2-8926-915434dc034a";
const SLIP_PACKAGE = "b59c36f0-2b93-4fb5-a49e-f9c192358d7c";
const LINKED_PRODUCT = "246d6e3e-fcb5-406d-8087-e66cdcda2ce7";

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
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))
      v = v.slice(1, -1);
    if (process.env[k] == null || process.env[k] === "") process.env[k] = v;
  }
}

function runIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!;
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

type Check = { id: string; pass: boolean; detail: string };

async function main(): Promise<void> {
  loadEnvLocal();
  const runId = runIdArg();
  const outDir = path.join(process.cwd(), ".cursor/audit-reports/scanner-02i", runId);
  fs.mkdirSync(outDir, { recursive: true });

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!.trim();
  const sb = createClient(url, key, { auth: { persistSession: false } });

  const checks: Check[] = [];

  const { data: returnRow, error: returnErr } = await sb
    .from("return_items")
    .select(
      "id, sku, asin, fnsku, store_id, item_name, identifier_resolution_status, resolved_product_id, resolved_catalog_product_id, identifier_resolution_confidence",
    )
    .eq("id", RETURN_ROW)
    .single();

  if (returnErr) checks.push({ id: "return_items.read", pass: false, detail: returnErr.message });
  else {
    checks.push({ id: "return_items.read", pass: true, detail: "fixture row loaded" });
    const resolved = returnRow?.identifier_resolution_status === "resolved";
    checks.push({
      id: "return_items.resolver_status",
      pass: resolved,
      detail: `status=${returnRow?.identifier_resolution_status ?? "null"}`,
    });
    checks.push({
      id: "return_items.resolved_product_id",
      pass: !!returnRow?.resolved_product_id,
      detail: String(returnRow?.resolved_product_id ?? "null"),
    });
  }

  const { data: slips, error: slipErr } = await sb
    .from("slip_contents")
    .select("id, fnsku, identifier_resolution_status, resolved_product_id")
    .eq("package_id", SLIP_PACKAGE)
    .order("fnsku");

  if (slipErr) checks.push({ id: "slip_contents.read", pass: false, detail: slipErr.message });
  else {
    const rows = slips ?? [];
    const patched = rows.filter((r) => r.identifier_resolution_status != null).length;
    checks.push({
      id: "slip_contents.read",
      pass: rows.length > 0,
      detail: `${rows.length} rows, ${patched} with resolver status`,
    });
    checks.push({
      id: "slip_contents.patch_present",
      pass: patched === rows.length && rows.length > 0,
      detail: patched === rows.length ? "all lines have status" : "partial or empty",
    });
  }

  const productId =
    (returnRow?.resolved_product_id as string | undefined) ?? LINKED_PRODUCT;

  let productRow: Record<string, unknown> | null = null;
  let productProbeError: string | null = null;
  let usedNameColumnFallback = false;

  const primary = await sb
    .from("products")
    .select("id, name, product_name, sku")
    .eq("id", productId)
    .eq("organization_id", ORG)
    .maybeSingle();

  if (primary.error) {
    const fallback = await sb
      .from("products")
      .select("id, product_name, sku")
      .eq("id", productId)
      .eq("organization_id", ORG)
      .maybeSingle();
    if (fallback.error) productProbeError = fallback.error.message;
    else {
      usedNameColumnFallback = true;
      productRow = (fallback.data as unknown as Record<string, unknown> | null) ?? null;
    }
  } else {
    productRow = (primary.data as unknown as Record<string, unknown> | null) ?? null;
  }

  const nameVal = typeof productRow?.name === "string" ? productRow.name : null;
  const productNameVal =
    typeof productRow?.product_name === "string" ? productRow.product_name : null;
  const simulatedTitle = pickProductRowDisplayName({
    name: nameVal,
    product_name: productNameVal,
  });

  checks.push({
    id: "products.display_probe",
    pass: !productProbeError && !!productRow,
    detail:
      productProbeError ??
      (usedNameColumnFallback
        ? `id=${productId} (staging: no products.name; used product_name select)`
        : `id=${productId}`),
  });
  checks.push({
    id: "products.title_chain",
    pass: !!simulatedTitle?.trim(),
    detail: `name=${nameVal ? "set" : "empty"} product_name=${productNameVal ? "set" : "empty"} → "${simulatedTitle ?? ""}"`,
  });

  const { count: productCount } = await sb
    .from("products")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", ORG);

  const allPass = checks.every((c) => c.pass);

  const payload = {
    run_id: runId,
    prompt: "SCANNER-02I",
    verified_at: new Date().toISOString(),
    staging_project_ref: "kxsvedvpjldygtdbylsy",
    overall: allPass ? "PASS" : "FAIL",
    checks,
    return_row: returnRow,
    slip_contents: slips,
    product_display_probe: {
      product_id: productId,
      name: nameVal,
      product_name: productNameVal,
      used_name_column_fallback: usedNameColumnFallback,
      simulated_canonical_title: simulatedTitle,
    },
    product_count_org: productCount,
  };

  fs.writeFileSync(path.join(outDir, "db-verify-snapshot.json"), JSON.stringify(payload, null, 2));
  fs.writeFileSync(
    path.join(outDir, "validation-checks.json"),
    JSON.stringify({ checks, overall: payload.overall }, null, 2),
  );
  console.log(JSON.stringify(payload, null, 2));
  if (!allPass) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
