/**
 * NEXT-ENV-06B-VERCEL-PREVIEW-STAGING-QUARTET-EXECUTE
 * 1) set-vercel-preview-staging-env.mjs (3 runtime keys)
 * 2) optional DIRECT_POSTGRES_URL branch override
 * 3) ref-smoke manifest + Preview redeploy (no --prod)
 *
 *   node scripts/next-env-06b-vercel-preview-staging-quartet-execute.mjs
 *   node scripts/next-env-06b-vercel-preview-staging-quartet-execute.mjs --skip-env --skip-deploy
 */
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const args = process.argv.slice(2);
const skipEnv = args.includes("--skip-env");
const skipDeploy = args.includes("--skip-deploy");
const runIdArg = args.find((x) => x.startsWith("--run-id="))?.split("=")[1];

function run(cmd, argv, inherit = false) {
  const r = spawnSync(cmd, argv, {
    cwd: process.cwd(),
    shell: true,
    stdio: inherit ? "inherit" : "pipe",
    encoding: "utf8",
  });
  return r;
}

if (!skipEnv) {
  const trio = run("node", ["scripts/set-vercel-preview-staging-env.mjs"], true);
  if (trio.status !== 0) process.exit(trio.status ?? 1);
  const pg = run(
    "node",
    ["scripts/_env06b-add-direct-postgres-preview.mjs"],
    true,
  );
  if (pg.status !== 0 && pg.status !== 2) process.exit(pg.status ?? 1);
}

const manifestArgs = ["scripts/_build-06b-ref-smoke-manifest.mjs"];
if (runIdArg) manifestArgs.push(`--run-id=${runIdArg}`);
const manifest = run("node", manifestArgs);
if (manifest.status !== 0) {
  console.error(manifest.stderr || manifest.stdout);
  process.exit(1);
}
console.log(manifest.stdout?.trim());

if (!skipDeploy) {
  const deploy = run("npx", ["vercel@latest", "deploy", "--yes"], true);
  if (deploy.status !== 0) process.exit(deploy.status ?? 1);
}
