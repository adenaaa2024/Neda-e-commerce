/**
 * NEDA-ENV-STAGING-FIX-AND-VERIFY-V183 — post env-fix verification (no DB writes).
 * Usage: npx tsx scripts/neda-env-staging-fix-verify-v183.ts
 */
import { execSync } from "node:child_process";
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@supabase/supabase-js";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const SAM_ORG = "00000000-0000-0000-0000-000000000001";
const SAM_STORE = "509ee1f6-622c-46a5-8110-7b889ba46c2c";
const RUN_ID = `run-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-001`;
const OUT = join(process.cwd(), ".cursor/audit-reports/neda-env-staging-fix-verify-v183", RUN_ID);

type Step = { id: string; pass: boolean; detail: string };

function parseEnv(path: string): Record<string, string> {
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

function classify(v: string | undefined): "BLANK" | "STAGING_REF" | "OTHER" {
  const s = String(v ?? "").trim();
  if (!s) return "BLANK";
  if (s.includes(STAGING_REF)) return "STAGING_REF";
  return "OTHER";
}

function runCmd(cmd: string): { ok: boolean; detail: string } {
  try {
    const out = execSync(cmd, { encoding: "utf8", cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"] });
    const tail = out.length > 8000 ? out.slice(-8000) : out;
    return { ok: true, detail: tail.trim() || "exit 0" };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    const msg = [err.stderr, err.stdout, err.message].filter(Boolean).join("\n");
    return { ok: false, detail: msg.slice(-8000) || "failed" };
  }
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const steps: Step[] = [];
  const add = (id: string, pass: boolean, detail: string) => steps.push({ id, pass, detail });

  const env = parseEnv(join(process.cwd(), ".env.local"));
  const proof: Record<string, string> = {};
  for (const k of [
    "NEXT_PUBLIC_SUPABASE_URL",
    "NEXT_PUBLIC_SUPABASE_ANON_KEY",
    "SUPABASE_SERVICE_ROLE_KEY",
    "DIRECT_POSTGRES_URL",
    "STAGING_SUPABASE_URL",
    "STAGING_ANON_KEY",
    "STAGING_SERVICE_ROLE_KEY",
    "STAGING_DIRECT_POSTGRES_URL",
    "ORIGINAL_SUPABASE_URL",
  ]) {
    if (env[k] !== undefined) proof[k] = classify(env[k]);
  }

  const activeUrlStaging = proof.NEXT_PUBLIC_SUPABASE_URL === "STAGING_REF";
  const anonMatchesStaging = env.NEXT_PUBLIC_SUPABASE_ANON_KEY === env.STAGING_ANON_KEY;
  const srMatchesStaging = env.SUPABASE_SERVICE_ROLE_KEY === env.STAGING_SERVICE_ROLE_KEY;
  const directStaging =
    proof.DIRECT_POSTGRES_URL === "STAGING_REF" || proof.STAGING_DIRECT_POSTGRES_URL === "STAGING_REF";
  const quartetAligned =
    activeUrlStaging &&
    anonMatchesStaging &&
    srMatchesStaging &&
    directStaging &&
    env.NEXT_PUBLIC_SUPABASE_URL === env.STAGING_SUPABASE_URL &&
    (env.DIRECT_POSTGRES_URL === env.STAGING_DIRECT_POSTGRES_URL ||
      proof.DIRECT_POSTGRES_URL === "STAGING_REF");
  if (anonMatchesStaging) proof.NEXT_PUBLIC_SUPABASE_ANON_KEY = "MATCHES_STAGING_COPY";
  if (srMatchesStaging) proof.SUPABASE_SERVICE_ROLE_KEY = "MATCHES_STAGING_COPY";

  add("env_active_url_staging", activeUrlStaging, proof.NEXT_PUBLIC_SUPABASE_URL ?? "missing");
  add("env_active_anon_staging", anonMatchesStaging, proof.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "missing");
  add("env_active_service_role_staging", srMatchesStaging, proof.SUPABASE_SERVICE_ROLE_KEY ?? "missing");
  add("env_direct_postgres_staging", directStaging, proof.DIRECT_POSTGRES_URL ?? "missing");
  add("env_quartet_matches_staging_vars", quartetAligned, quartetAligned ? "active quartet = STAGING_*" : "mismatch vs STAGING_*");
  add(
    "env_original_preserved",
    proof.ORIGINAL_SUPABASE_URL === "OTHER",
    proof.ORIGINAL_SUPABASE_URL ?? "missing",
  );

  const prodKeys = Object.keys(env).filter((k) => k.startsWith("PRODUCTION"));
  add("env_production_blank", prodKeys.length === 0, prodKeys.length ? `${prodKeys.length} keys` : "none");

  let alignOk = false;
  let alignOut = "";
  try {
    alignOut = execSync("npx tsx scripts/neda-env-staging-alignment-v180.ts", {
      encoding: "utf8",
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    alignOk = true;
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string };
    alignOut = [err.stdout, err.stderr].filter(Boolean).join("\n");
  }
  add("neda_env_staging_alignment_v180", alignOk, alignOk ? "exit 0" : "exit non-zero");

  const build = runCmd("npm run build");
  add("npm_run_build", build.ok, build.ok ? "exit 0" : "failed");

  const tsc = runCmd("npx tsc --noEmit --pretty false");
  add("tsc_no_emit", tsc.ok, tsc.ok ? "exit 0" : "failed");

  const smokeEp = runCmd("npm run smoke:expected-packages-ui-wire-v179");
  add("smoke_expected_packages_v179", smokeEp.ok, smokeEp.ok ? "PASS" : "FAIL");

  const smokeInv = runCmd("npm run smoke:inventory-views-ui-wire-v180");
  add("smoke_inventory_views_v180", smokeInv.ok, smokeInv.ok ? "PASS" : "FAIL");

  const url = env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key = env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (url && key && url.includes(STAGING_REF)) {
    const sb = createClient(url, key, { auth: { persistSession: false } });
    const { data, error } = await sb
      .from("expected_packages")
      .select("id")
      .eq("organization_id", SAM_ORG)
      .eq("store_id", SAM_STORE)
      .limit(1);
    add("runtime_read_staging_sam_store", !error && (data?.length ?? 0) >= 0, error?.message ?? `rows=${data?.length ?? 0}`);
  } else {
    add("runtime_read_staging_sam_store", false, "active env not staging");
  }

  let devProbe = "not attempted";
  let devOk = false;
  for (const port of [3001, 3000]) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/scanner/operator-mobile/scan`, {
        signal: AbortSignal.timeout(12000),
      });
      devProbe = `:${port} HTTP ${res.status}`;
      devOk = res.ok || res.status === 307 || res.status === 302;
      if (devOk) break;
    } catch {
      /* try next port */
    }
  }
  add(
    "dev_scan_route_reachable",
    devOk,
    devOk ? devProbe : "not reachable on :3001 or :3000 — restart `npm run dev` after .env.local change",
  );

  const coreOk = quartetAligned && alignOk && build.ok && tsc.ok;
  const overall = coreOk && steps.every((s) => s.pass) ? "PASS" : coreOk ? "PARTIAL_PASS" : "FAIL";

  writeFileSync(
    join(OUT, "manifest.json"),
    JSON.stringify({ run_id: RUN_ID, staging_ref: STAGING_REF, overall, envProof: proof, steps }, null, 2),
  );
  writeFileSync(
    join(OUT, "env-fix-proof.md"),
    `# Env fix proof (no secrets)

**Staging ref:** \`${STAGING_REF}\`

| Variable | Classification |
|----------|----------------|
${Object.entries(proof)
  .map(([k, v]) => `| ${k} | ${v} |`)
  .join("\n")}

## Active quartet

| Check | Result |
|-------|--------|
| NEXT_PUBLIC_SUPABASE_URL | ${proof.NEXT_PUBLIC_SUPABASE_URL} |
| NEXT_PUBLIC_SUPABASE_ANON_KEY | ${proof.NEXT_PUBLIC_SUPABASE_ANON_KEY} |
| SUPABASE_SERVICE_ROLE_KEY | ${proof.SUPABASE_SERVICE_ROLE_KEY} |
| DIRECT_POSTGRES_URL | ${proof.DIRECT_POSTGRES_URL} |
| Matches STAGING_* copies | ${quartetAligned ? "**yes**" : "**no**"} |
| ORIGINAL_* preserved | ${proof.ORIGINAL_SUPABASE_URL === "OTHER" ? "yes (OTHER)" : "check"} |
`,
  );
  writeFileSync(
    join(OUT, "validation-results.md"),
    `# Validation results\n\n**Overall:** **${overall}**\n\n${steps.map((s) => `- **${s.id}**: ${s.pass ? "PASS" : "FAIL"} — ${s.detail}`).join("\n")}\n`,
  );
  writeFileSync(
    join(OUT, "alignment-v180-run.md"),
    `# neda-env-staging-alignment-v180\n\n**Exit:** ${alignOk ? "0" : "non-zero"}\n\n\`\`\`\n${alignOut.slice(-4000) || "(no output)"}\n\`\`\`\n`,
  );
  writeFileSync(
    join(OUT, "build-and-tsc.md"),
    `# Build / tsc\n\n| Command | Result |\n|---------|--------|\n| npm run build | ${build.ok ? "PASS" : "FAIL"} |\n| npx tsc --noEmit | ${tsc.ok ? "PASS" : "FAIL"} |\n`,
  );
  writeFileSync(
    join(OUT, "smoke-results.md"),
    `# Smoke\n\n| Script | Result |\n|--------|--------|\n| smoke:expected-packages-ui-wire-v179 | ${smokeEp.ok ? "PASS" : "FAIL"} |\n| smoke:inventory-views-ui-wire-v180 | ${smokeInv.ok ? "PASS" : "FAIL"} |\n`,
  );
  writeFileSync(
    join(OUT, "blockers.md"),
    `# Blockers\n\n**Overall:** ${overall}\n\n${steps
      .filter((s) => !s.pass)
      .map((s) => `- ${s.id}: ${s.detail}`)
      .join("\n") || "- None"}\n`,
  );

  console.log(`\nNEDA-ENV-STAGING-FIX-VERIFY-V183 → ${OUT}`);
  console.log(`overall: ${overall}`);
  process.exit(overall === "FAIL" ? 1 : 0);
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
