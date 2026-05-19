/**
 * Preview-only: point NEXT_PUBLIC_* + SUPABASE_SERVICE_ROLE_KEY at staging (.env.local).
 * Does not modify Production. No secrets logged.
 */
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const ENV_FILE = resolve(process.cwd(), ".env.local");
const KEYS = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
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
const url = env.NEXT_PUBLIC_SUPABASE_URL?.trim();
const ref = refFromUrl(url);
const expected = "eiqfaapyumhixxoeltgu";

if (ref !== expected) {
  console.error(`Refusing: .env.local NEXT_PUBLIC_SUPABASE_URL ref=${ref ?? "?"} expected ${expected}`);
  process.exit(1);
}

const results = [];
for (const key of KEYS) {
  const value = env[key]?.trim();
  if (!value) {
    console.error(`Missing ${key} in .env.local`);
    process.exit(1);
  }
  spawnSync("npx", ["vercel@latest", "env", "rm", key, "preview", "--yes"], {
    stdio: "inherit",
    shell: true,
    cwd: process.cwd(),
  });
  const branch = "integration/scanner-neda-product-linkage";
  const add = spawnSync(
    "npx",
    [
      "vercel@latest",
      "env",
      "add",
      key,
      "preview",
      branch,
      "--yes",
      "--value",
      value,
      "--force",
    ],
    { stdio: "inherit", shell: true, cwd: process.cwd() },
  );
  results.push({ key, ok: add.status === 0 });
  if (add.status !== 0) process.exit(add.status ?? 1);
}

console.log(JSON.stringify({ preview_ref: ref, updated: results }, null, 2));
