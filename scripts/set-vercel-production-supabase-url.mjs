/**
 * Production: set NEXT_PUBLIC_SUPABASE_URL (and quartet) from ORIGINAL_* in .env.local.
 * Does not log secret values.
 */
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const ENV_FILE = resolve(process.cwd(), ".env.local");
const PRODUCTION_KEYS = [
  ["NEXT_PUBLIC_SUPABASE_URL", "ORIGINAL_SUPABASE_URL"],
  ["NEXT_PUBLIC_SUPABASE_ANON_KEY", "ORIGINAL_ANON_KEY"],
  ["SUPABASE_SERVICE_ROLE_KEY", "ORIGINAL_SERVICE_ROLE_KEY"],
];

function loadEnv(path) {
  const out = {};
  const raw = readFileSync(path, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i < 0) continue;
    out[t.slice(0, i)] = t.slice(i + 1).replace(/^"|"$/g, "");
  }
  return out;
}

function refFromUrl(url) {
  const m = String(url ?? "").match(/https:\/\/([a-z0-9]{20})\.supabase\.co/i);
  return m?.[1] ?? null;
}

const env = loadEnv(ENV_FILE);
const expectedOriginal = env.ORIGINAL_PROJECT_REF?.trim() || "kxsvedvpjldygtdbylsy";

const results = [];
for (const [vercelKey, sourceKey] of PRODUCTION_KEYS) {
  const value = env[sourceKey]?.trim();
  if (!value) {
    console.error(`Missing ${sourceKey} in .env.local`);
    process.exit(1);
  }
  if (vercelKey === "NEXT_PUBLIC_SUPABASE_URL") {
    const ref = refFromUrl(value);
    if (ref !== expectedOriginal) {
      console.error(`Refusing: ${sourceKey} ref=${ref ?? "?"} expected ${expectedOriginal}`);
      process.exit(1);
    }
  }
  spawnSync("npx", ["vercel@latest", "env", "rm", vercelKey, "production", "--yes"], {
    stdio: "inherit",
    shell: true,
    cwd: process.cwd(),
  });
  const add = spawnSync(
    "npx",
    ["vercel@latest", "env", "add", vercelKey, "production", "--yes", "--value", value, "--force"],
    { stdio: "inherit", shell: true, cwd: process.cwd() },
  );
  results.push({ key: vercelKey, source: sourceKey, ok: add.status === 0 });
  if (add.status !== 0) process.exit(add.status ?? 1);
}

console.log(
  JSON.stringify(
    { production_ref: expectedOriginal, updated: results, note: "Redeploy Production after this." },
    null,
    2,
  ),
);
