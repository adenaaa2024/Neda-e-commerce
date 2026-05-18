/**
 * NEXT-CLAIM-CANONICAL-04 — smoke checks for claim drafts feature flag (no live HTTP).
 *
 * Spawns isolated tsx processes so module cache respects ENABLE_CLAIM_DRAFTS_REVIEW per case.
 */
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

function runFlagCase(envValue: string | undefined, expectEnabled: boolean): void {
  const env = { ...process.env, NODE_OPTIONS: process.env.NODE_OPTIONS ?? "" };
  if (envValue === undefined) delete env.ENABLE_CLAIM_DRAFTS_REVIEW;
  else env.ENABLE_CLAIM_DRAFTS_REVIEW = envValue;

  const code = `(async () => {
  const mod = await import("./lib/claim-drafts-api.ts");
  const api = mod.default ?? mod;
  const { isClaimDraftsReviewEnabled } = api;
  if (isClaimDraftsReviewEnabled() !== ${expectEnabled}) {
    console.error("Expected", ${expectEnabled}, "got", isClaimDraftsReviewEnabled());
    process.exit(1);
  }
  console.log("ok");
})().catch((e) => { console.error(e); process.exit(1); });`;

  const tsxCli = path.join(root, "node_modules", "tsx", "dist", "cli.mjs");
  const r = spawnSync(process.execPath, [tsxCli, "-e", code], { cwd: root, env, encoding: "utf8" });
  if (r.status !== 0) {
    console.error("flag smoke subprocess failed", { status: r.status, signal: r.signal, error: r.error });
    if (r.stdout) console.error(r.stdout);
    if (r.stderr) console.error(r.stderr);
    process.exit(1);
  }
}

function assertRouteImportsProjection(): void {
  const routePath = path.join(root, "app", "api", "claims", "drafts", "route.ts");
  const src = readFileSync(routePath, "utf8");
  if (!src.includes("projectClaimCandidateDraftsBatch")) {
    console.error("drafts route missing projectClaimCandidateDraftsBatch import/call");
    process.exit(1);
  }
  if (!src.includes("projectionRequested")) {
    console.error("drafts route missing projection query handling");
    process.exit(1);
  }
}

function main(): void {
  assertRouteImportsProjection();
  runFlagCase(undefined, false);
  runFlagCase("", false);
  runFlagCase("false", false);
  runFlagCase("0", false);
  runFlagCase("true", true);
  runFlagCase("1", true);
  console.log("claim-drafts-projection-smoke: all checks passed");
}

main();
