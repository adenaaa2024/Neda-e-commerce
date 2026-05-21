/**
 * NEDA-ENV-STAGING-ALIGNMENT-V180 — diagnostics only (no DB writes).
 * Usage: npx tsx scripts/neda-env-staging-alignment-v180.ts
 */
import { readFileSync, existsSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const RUN_ID = `run-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-001`;
const OUT = join(process.cwd(), ".cursor/audit-reports/neda-env-staging-alignment-v180", RUN_ID);
const SCANNER_ROOT = join(process.cwd(), "app/scanner");

type Step = { id: string; pass: boolean; detail: string };

function parseEnvFile(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i === -1) continue;
    const k = t.slice(0, i).trim();
    let v = t.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[k] = v;
  }
  return out;
}

function classifyValue(v: string | undefined): "BLANK" | "STAGING_REF" | "OTHER" {
  const s = String(v ?? "").trim();
  if (!s) return "BLANK";
  if (s.includes(STAGING_REF)) return "STAGING_REF";
  return "OTHER";
}

function walkTs(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) walkTs(p, out);
    else if (/\.(ts|tsx)$/.test(ent.name)) out.push(p);
  }
  return out;
}

function scanStale(): Record<string, number> {
  const counts = {
    package_items: 0,
    returns_table: 0,
    packages_package_number_select: 0,
    pallets_photo_url_select: 0,
    products_insert: 0,
    browser_db_writes: 0,
  };
  const writeRe =
    /supabase\.(from|rpc)\([^)]+\)\s*\.(insert|update|upsert|delete)\s*\(|\.from\([^)]+\)\s*\.(insert|update|upsert|delete)\s*\(/;
  for (const file of walkTs(SCANNER_ROOT)) {
    const rel = file.replace(process.cwd(), "").replace(/\\/g, "/");
    const isServer = rel.includes("operator-store-actions") || rel.includes("item-actions");
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (/package_items/.test(line)) counts.package_items++;
      if (/\.from\(["']returns["']\)/.test(line)) counts.returns_table++;
      if (/\.from\(["']packages["']\)[\s\S]{0,80}package_number|select\([^)]*package_number[^)]*\)[\s\S]{0,40}\.from\(["']packages["']\)/.test(line)) {
        counts.packages_package_number_select++;
      }
      if (/\.from\(["']pallets["']\)[\s\S]{0,80}photo_url|pallets\.photo_url/.test(line)) counts.pallets_photo_url_select++;
      if (/from\(["']products["']\)\s*\.insert|\.from\("products"\)\.insert/.test(line)) counts.products_insert++;
      if (!isServer && writeRe.test(line) && rel.includes("scan/page")) counts.browser_db_writes++;
    }
  }
  return counts;
}

function codePresence(): Record<string, boolean> {
  const read = (p: string) => (existsSync(p) ? readFileSync(p, "utf8") : "");
  const tracking = read(join(process.cwd(), "lib/scanner/operator-tracking-expectations.ts"));
  const vinv = read(join(process.cwd(), "lib/scanner/v-inventory-status.ts"));
  const epRead = read(join(process.cwd(), "lib/scanner/expected-packages-read-contract.ts"));
  const contract = read(join(process.cwd(), "lib/scanner/product-linkage-display-contract.ts"));
  const page = read(join(process.cwd(), "app/scanner/operator-mobile/scan/page.tsx"));
  const meta = read(join(process.cwd(), "app/scanner/operator-mobile/_components/OperatorProductLinkageMeta.tsx"));
  return {
    fetchExpectedPackagesNedaRead_alias: /fetchExpectedPackagesForTracking|loadTrackingExpectationSnapshot|enrichTrackingOperatorLinesWithProductLinkage/.test(
      tracking + epRead,
    ),
    fetchInventoryItemStatusForNeda_alias: /fetchVInventoryStatusForScanCode|fetchVInventoryItemStatusLinesExact/.test(
      vinv + page,
    ),
    ProductLinkageDisplayContract: contract.includes("export type ProductLinkageDisplayContract"),
    ProductLinkageDisplayBlock_alias: meta.includes("OperatorProductLinkageMeta"),
    inventory_views_ui_v180: /formatScanVarianceLabel|buildInventoryViewProductLinkage|identifyGateShipmentLines/.test(
      page,
    ),
    expected_packages_read_contract: existsSync(join(process.cwd(), "lib/scanner/expected-packages-read-contract.ts")),
  };
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const steps: Step[] = [];
  const add = (id: string, pass: boolean, detail: string) => steps.push({ id, pass, detail });

  const env = parseEnvFile(join(process.cwd(), ".env.local"));
  const envProof: Record<string, string> = {};
  for (const k of [
    "NEXT_PUBLIC_SUPABASE_URL",
    "NEXT_PUBLIC_SUPABASE_ANON_KEY",
    "SUPABASE_SERVICE_ROLE_KEY",
    "DIRECT_POSTGRES_URL",
    "STAGING_SUPABASE_URL",
    "STAGING_DIRECT_POSTGRES_URL",
    "STAGING_PROJECT_REF",
    "ORIGINAL_DIRECT_POSTGRES_URL",
  ]) {
    if (env[k] !== undefined) envProof[k] = classifyValue(env[k]);
  }
  const prodKeys = Object.keys(env).filter((k) => k.startsWith("PRODUCTION"));
  const prodBlank = prodKeys.length === 0 || prodKeys.every((k) => classifyValue(env[k]) === "BLANK");

  add(
    "env_next_public_supabase_staging",
    envProof.NEXT_PUBLIC_SUPABASE_URL === "STAGING_REF",
    envProof.NEXT_PUBLIC_SUPABASE_URL ?? "missing",
  );
  add(
    "env_direct_postgres_staging",
    envProof.DIRECT_POSTGRES_URL === "STAGING_REF" || envProof.STAGING_DIRECT_POSTGRES_URL === "STAGING_REF",
    `DIRECT_POSTGRES_URL=${envProof.DIRECT_POSTGRES_URL ?? "n/a"}; STAGING_DIRECT=${envProof.STAGING_DIRECT_POSTGRES_URL ?? "n/a"}`,
  );
  add("env_production_vars_blank", prodBlank, prodKeys.length ? prodKeys.map((k) => `${k}=${classifyValue(env[k])}`).join("; ") : "no PRODUCTION_* keys");

  const code = codePresence();
  for (const [k, v] of Object.entries(code)) {
    add(`code_${k}`, v, v ? "present" : "missing");
  }

  const stale = scanStale();
  add("stale_package_items", stale.package_items === 0, `refs=${stale.package_items}`);
  add("stale_returns_table", stale.returns_table === 0, `refs=${stale.returns_table}`);
  add("stale_packages_package_number", stale.packages_package_number_select === 0, `refs=${stale.packages_package_number_select}`);
  add("stale_pallets_photo_url", stale.pallets_photo_url_select === 0, `refs=${stale.pallets_photo_url_select}`);
  add("stale_products_insert", stale.products_insert === 0, `refs=${stale.products_insert}`);
  add("stale_browser_writes", stale.browser_db_writes === 0, `refs=${stale.browser_db_writes}`);

  const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as { scripts?: Record<string, string> };
  const smokeEp = Boolean(pkg.scripts?.["smoke:expected-packages-ui-wire-v179"]);
  const smokeInv = Boolean(pkg.scripts?.["smoke:inventory-views-ui-wire-v180"]);
  add("smoke_expected_packages_script", smokeEp, smokeEp ? "defined" : "not in package.json");
  add("smoke_inventory_views_script", smokeInv, smokeInv ? "defined" : "not in package.json");

  const branch = existsSync(join(process.cwd(), ".git", "HEAD"))
    ? readFileSync(join(process.cwd(), ".git", "HEAD"), "utf8").trim()
    : "unknown";

  const envAligned = steps.find((s) => s.id === "env_next_public_supabase_staging")?.pass === true;
  const overall = envAligned && steps.filter((s) => s.id.startsWith("stale_") && !s.pass).length === 0 ? "PASS" : "FAIL";

  writeFileSync(join(OUT, "env-ref-proof.md"), envRefMd(envProof, prodKeys, env));
  writeFileSync(join(OUT, "code-presence.md"), codePresenceMd(code));
  writeFileSync(join(OUT, "stale-ref-scan.md"), staleMd(stale));
  writeFileSync(
    join(OUT, "build-and-tsc.md"),
    `# Build / tsc\n\nRun separately: \`npm run build\`, \`npx tsc --noEmit --pretty false\`.\n`,
  );
  writeFileSync(join(OUT, "smoke-scripts.md"), smokeMd(smokeEp, smokeInv));
  writeFileSync(join(OUT, "blockers.md"), blockersMd(steps, envAligned));
  writeFileSync(
    join(OUT, "manifest.json"),
    JSON.stringify({ run_id: RUN_ID, staging_ref: STAGING_REF, overall, branch, envProof, code, stale, steps }, null, 2),
  );

  console.log(`\nNEDA-ENV-STAGING-ALIGNMENT-V180 → ${OUT}`);
  console.log(`overall: ${overall}`);
  console.log(`NEXT_PUBLIC_SUPABASE_URL: ${envProof.NEXT_PUBLIC_SUPABASE_URL ?? "missing"}`);
  process.exit(overall === "PASS" ? 0 : 1);
}

function envRefMd(proof: Record<string, string>, prodKeys: string[], env: Record<string, string>): string {
  return `# Env ref proof (safe)

**Required staging ref:** \`${STAGING_REF}\` (substring only — no secrets logged)

| Variable | Classification |
|----------|----------------|
${Object.entries(proof)
  .map(([k, v]) => `| ${k} | ${v} |`)
  .join("\n")}

**PRODUCTION_***: ${prodKeys.length ? prodKeys.map((k) => `${k}=${classifyValue(env[k])}`).join(", ") : "none defined"}

## Runtime wiring

Next.js / \`lib/supabase-server.ts\` use **\`NEXT_PUBLIC_SUPABASE_URL\`** + service role — not \`STAGING_SUPABASE_URL\` unless you copy staging values into the NEXT_PUBLIC_* pair.
`;
}

function codePresenceMd(code: Record<string, boolean>): string {
  return `# Code presence (V179/V180 names vs repo)

| Symbol (prompt) | Repo equivalent | Present |
|-----------------|-----------------|---------|
| fetchExpectedPackagesNedaRead | fetchExpectedPackagesForTracking / loadTrackingExpectationSnapshot / expected-packages-read-contract | ${code.fetchExpectedPackagesNedaRead_alias ? "yes" : "no"} |
| fetchInventoryItemStatusForNeda | fetchVInventoryStatusForScanCode / fetchVInventoryItemStatusLinesExact | ${code.fetchInventoryItemStatusForNeda_alias ? "yes" : "no"} |
| ProductLinkageDisplayContract | lib/scanner/product-linkage-display-contract.ts | ${code.ProductLinkageDisplayContract ? "yes" : "no"} |
| ProductLinkageDisplayBlock | OperatorProductLinkageMeta | ${code.ProductLinkageDisplayBlock_alias ? "yes" : "no"} |
| inventory views UI V180 | formatScanVarianceLabel, buildInventoryViewProductLinkage, identifyGateShipmentLines | ${code.inventory_views_ui_v180 ? "yes" : "no"} |
`;
}

function staleMd(s: Record<string, number>): string {
  return `# Stale ref scan (app/scanner)

| Pattern | Count |
|---------|------:|
| package_items | ${s.package_items} |
| .from("returns") | ${s.returns_table} |
| packages.package_number (select) | ${s.packages_package_number_select} |
| pallets.photo_url | ${s.pallets_photo_url_select} |
| products.insert | ${s.products_insert} |
| browser supabase writes (scan page) | ${s.browser_db_writes} |
`;
}

function smokeMd(ep: boolean, inv: boolean): string {
  return `# Smoke scripts

| Script | In package.json |
|--------|-----------------|
| smoke:expected-packages-ui-wire-v179 | ${ep ? "yes" : "**no**"} |
| smoke:inventory-views-ui-wire-v180 | ${inv ? "yes" : "**no**"} |
`;
}

function blockersMd(steps: Step[], envAligned: boolean): string {
  const fails = steps.filter((s) => !s.pass);
  return `# Blockers

${envAligned ? "" : "- **CRITICAL:** Point `NEXT_PUBLIC_SUPABASE_URL` (and matching anon + service role) at staging project `eiqfaapyumhixxoeltgu`. `STAGING_*` vars alone do not wire Next.js.\n"}
${fails.map((f) => `- ${f.id}: ${f.detail}`).join("\n") || "- None from static gates"}
`;
}

void main();
