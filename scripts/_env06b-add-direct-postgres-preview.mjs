/** Add DIRECT_POSTGRES_URL to Preview branch override only (4th quartet key). */
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const BRANCH = "integration/scanner-neda-product-linkage";
const KEY = "DIRECT_POSTGRES_URL";
const env = {};
for (const line of readFileSync(resolve(process.cwd(), ".env.local"), "utf8").split(/\r?\n/)) {
  const t = line.trim();
  if (!t || t.startsWith("#")) continue;
  const i = t.indexOf("=");
  if (i < 0) continue;
  let v = t.slice(i + 1).trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
  env[t.slice(0, i).trim()] = v;
}
const value = env[KEY]?.trim();
if (!value || !value.includes("eiqfaapyumhixxoeltgu")) {
  console.error("Refusing: DIRECT_POSTGRES_URL must point at staging");
  process.exit(1);
}
spawnSync("npx", ["vercel@latest", "env", "rm", KEY, "preview", "--yes"], { shell: true, stdio: "inherit" });
const add = spawnSync(
  "npx",
  ["vercel@latest", "env", "add", KEY, "preview", BRANCH, "--yes", "--value", value, "--force"],
  { shell: true, stdio: "inherit" },
);
process.exit(add.status === 0 ? 0 : add.status ?? 1);
