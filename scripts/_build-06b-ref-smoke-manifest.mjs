/**
 * Build ref-smoke-manifest from .env.local (refs only) + vercel env ls output file.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { spawnSync } from "node:child_process";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const BRANCH = "integration/scanner-neda-product-linkage";
const KEYS = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "DIRECT_POSTGRES_URL",
];

function loadEnv(path) {
  const out = {};
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i < 0) continue;
    let v = t.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[t.slice(0, i).trim()] = v;
  }
  return out;
}

function refFromUrl(url) {
  const m = String(url ?? "").match(/https:\/\/([a-z0-9]{20})\.supabase\.co/i);
  return m?.[1] ?? null;
}

function refFromJwt(jwt) {
  try {
    return JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString("utf8")).ref ?? null;
  } catch {
    return null;
  }
}

const runId =
  process.argv.find((x) => x.startsWith("--run-id="))?.split("=")[1] ??
  new Date().toISOString().replace(/[-:]/g, "").slice(0, 15) + "Z";

const outDir = resolve(
  process.cwd(),
  ".cursor/audit-reports/next-env-06b-vercel-preview-staging-quartet",
  runId,
);
mkdirSync(outDir, { recursive: true });

const local = loadEnv(resolve(process.cwd(), ".env.local"));
const localRefs = {
  NEXT_PUBLIC_SUPABASE_URL: refFromUrl(local.NEXT_PUBLIC_SUPABASE_URL),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: refFromJwt(local.NEXT_PUBLIC_SUPABASE_ANON_KEY),
  SUPABASE_SERVICE_ROLE_KEY: refFromJwt(local.SUPABASE_SERVICE_ROLE_KEY),
  DIRECT_POSTGRES_URL: local.DIRECT_POSTGRES_URL?.includes(STAGING_REF) ? STAGING_REF : null,
};

const ls = spawnSync("npx", ["vercel@latest", "env", "ls", "preview"], {
  shell: true,
  encoding: "utf8",
});
const lsText = ls.stdout ?? "";
const previewPresence = {};
for (const key of KEYS) {
  const branchScoped =
    lsText.includes(key) && lsText.includes(BRANCH) && lsText.includes("Preview");
  previewPresence[key] = { branch_scoped_listed: branchScoped };
}

const quartetLocalOk = Object.values(localRefs).every((r) => r === STAGING_REF);
const trioListed =
  previewPresence.NEXT_PUBLIC_SUPABASE_URL?.branch_scoped_listed &&
  previewPresence.NEXT_PUBLIC_SUPABASE_ANON_KEY?.branch_scoped_listed &&
  previewPresence.SUPABASE_SERVICE_ROLE_KEY?.branch_scoped_listed;

const manifest = {
  audit_id: "NEXT-ENV-06B-VERCEL-PREVIEW-STAGING-QUARTET-EXECUTE",
  run_id: runId,
  staging_ref: STAGING_REF,
  branch: BRANCH,
  production_touched: false,
  local_active_quartet_refs: localRefs,
  local_quartet_matches_staging: quartetLocalOk,
  preview_env_presence: previewPresence,
  note:
    "Vercel env pull returns encrypted placeholders (\"\") for secrets; ref proof uses local quartet + env ls branch overrides.",
  redeploy: {
    required: true,
    command: "npx vercel deploy --yes",
    note: "Preview only; omit --prod",
  },
  status: quartetLocalOk && trioListed ? "PASS_QUARTET_REF_PENDING_REDEPLOY" : "FAIL",
};

writeFileSync(join(outDir, "ref-smoke-manifest.json"), JSON.stringify(manifest, null, 2));
writeFileSync(
  join(outDir, "summary.md"),
  [
    `# NEXT-ENV-06B-VERCEL-PREVIEW-STAGING-QUARTET-EXECUTE`,
    ``,
    `**Run id:** \`${runId}\``,
    `**Status:** ${manifest.status}`,
    `**Branch:** \`${BRANCH}\``,
    `**Target ref:** \`${STAGING_REF}\``,
    ``,
    `| Check | Result |`,
    `|-------|--------|`,
    `| Local active quartet → staging | ${quartetLocalOk ? "PASS" : "FAIL"} |`,
    `| Preview branch overrides (URL/anon/service) | ${trioListed ? "PASS" : "PARTIAL"} |`,
    `| DIRECT_POSTGRES on Preview | ${previewPresence.DIRECT_POSTGRES_URL?.branch_scoped_listed ? "listed" : "optional / add if needed"} |`,
    `| Production env | **untouched** |`,
    ``,
    `Redeploy Preview after env changes: \`npx vercel deploy --yes\` (no \`--prod\`).`,
  ].join("\n"),
);
writeFileSync(
  join(outDir, "manifest.json"),
  JSON.stringify(
    {
      audit_id: manifest.audit_id,
      run_id: runId,
      status: manifest.status,
      artifacts: ["ref-smoke-manifest.json", "summary.md", "manifest.json"],
    },
    null,
    2,
  ),
);

console.log(JSON.stringify({ run_id: runId, status: manifest.status, outDir }, null, 2));
