/**
 * NEXT-PRODUCT-20 — Product propagation dry-run orchestrator.
 *
 * READ-ONLY. This script performs SELECTs and writes audit artifacts only.
 * It never writes product_id/resolved_product_id, never creates products,
 * never mutates product_identifier_map, never runs migrations, and never calls
 * AI/OpenAI or external APIs.
 *
 * Usage:
 *   npx tsx scripts/product-propagation-dry-run.ts
 *   npx tsx scripts/product-propagation-dry-run.ts --organization-id=<uuid> [--store-id=<uuid>]
 *   npx tsx scripts/product-propagation-dry-run.ts --next-18m-dir=.cursor/audit-reports/next-18m/<run_id>
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import {
  runProductPropagationDryRun,
  type ProductPropagationDryRunOptions,
} from "../lib/audits/product-propagation-dryrun";
import { isUuidString } from "../lib/uuid";

type CliArgs = {
  organizationId: string | null;
  storeId: string | null;
  outputBaseDir: string | null;
  runId: string | null;
  next18mDir: string | null;
  maxRowsPerTable: number | null;
};

function loadEnvLocal(): void {
  const envPath = path.join(process.cwd(), ".env.local");
  if (!fs.existsSync(envPath)) return;
  const raw = fs.readFileSync(envPath, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key && !process.env[key]) process.env[key] = value;
  }
}

function parseArgs(argv: string[]): CliArgs {
  let organizationId: string | null = null;
  let storeId: string | null = null;
  let outputBaseDir: string | null = null;
  let runId: string | null = null;
  let next18mDir: string | null = null;
  let maxRowsPerTable: number | null = null;

  for (const arg of argv) {
    let match: RegExpMatchArray | null;
    if ((match = arg.match(/^--organization-id=(.+)$/))) {
      organizationId = match[1].trim() || null;
    } else if ((match = arg.match(/^--org-id=(.+)$/))) {
      organizationId = match[1].trim() || null;
    } else if ((match = arg.match(/^--store-id=(.+)$/))) {
      storeId = match[1].trim() || null;
    } else if ((match = arg.match(/^--output-base-dir=(.+)$/))) {
      outputBaseDir = match[1].trim() || null;
    } else if ((match = arg.match(/^--output-dir=(.+)$/))) {
      outputBaseDir = match[1].trim() || null;
    } else if ((match = arg.match(/^--run-id=(.+)$/))) {
      runId = match[1].trim() || null;
    } else if ((match = arg.match(/^--next-18m-dir=(.+)$/))) {
      next18mDir = match[1].trim() || null;
    } else if ((match = arg.match(/^--max-rows-per-table=(\d+)$/))) {
      maxRowsPerTable = Number.parseInt(match[1], 10);
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else if (arg.startsWith("--")) {
      throw new Error(`Unknown CLI flag: ${arg}`);
    }
  }

  if (organizationId && !isUuidString(organizationId)) {
    throw new Error(`Invalid --organization-id: "${organizationId}" is not a UUID.`);
  }
  if (storeId && !isUuidString(storeId)) {
    throw new Error(`Invalid --store-id: "${storeId}" is not a UUID.`);
  }
  if (storeId && !organizationId) {
    throw new Error("--store-id requires --organization-id.");
  }
  if (maxRowsPerTable != null && (!Number.isFinite(maxRowsPerTable) || maxRowsPerTable < 1)) {
    throw new Error("--max-rows-per-table must be a positive integer.");
  }

  return {
    organizationId,
    storeId,
    outputBaseDir,
    runId,
    next18mDir,
    maxRowsPerTable,
  };
}

function printHelp(): void {
  process.stdout.write(
    [
      "NEXT-PRODUCT-20 — Product propagation dry-run orchestrator (read-only).",
      "",
      "Usage: npx tsx scripts/product-propagation-dry-run.ts [flags]",
      "",
      "Flags:",
      "  --organization-id=<uuid>       Optional tenant filter",
      "  --store-id=<uuid>              Optional store filter; requires organization-id",
      "  --next-18m-dir=<path>          NEXT-18M dispute artifact directory",
      "  --output-base-dir=<path>       Output base directory",
      "  --run-id=<id>                  Override generated run id",
      "  --max-rows-per-table=<n>       Test-only cap per table/pair",
      "  --help, -h                     Show this help",
      "",
    ].join("\n"),
  );
}

function createServiceClient(): { client: SupabaseClient; url: string } {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !key) {
    throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in env / .env.local.");
  }
  return {
    client: createClient(url, key, { auth: { persistSession: false } }),
    url,
  };
}

function getSupabaseJsVersion(): string | null {
  try {
    const pkg = require("@supabase/supabase-js/package.json") as { version?: string };
    return pkg.version ?? null;
  } catch {
    return null;
  }
}

function readGitSha(): string | null {
  try {
    return execSync("git rev-parse HEAD", { encoding: "utf8" }).trim() || null;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  loadEnvLocal();
  const cli = parseArgs(process.argv.slice(2));
  const { client, url } = createServiceClient();

  const options: ProductPropagationDryRunOptions = {
    supabase: client,
    outputBaseDir: cli.outputBaseDir,
    runId: cli.runId,
    organizationId: cli.organizationId,
    storeId: cli.storeId,
    maxRowsPerTable: cli.maxRowsPerTable,
    next18mDir: cli.next18mDir,
    envHashInput: url,
    supabaseJsVersion: getSupabaseJsVersion(),
    generatorGitSha: readGitSha(),
    cliArgs: {
      organizationId: cli.organizationId,
      storeId: cli.storeId,
      outputBaseDir: cli.outputBaseDir,
      runId: cli.runId,
      next18mDir: cli.next18mDir,
      maxRowsPerTable: cli.maxRowsPerTable,
    },
  };

  const result = await runProductPropagationDryRun(options);
  process.stdout.write(
    [
      `[product-propagation-dry-run] run_id=${result.runId}`,
      `[product-propagation-dry-run] output_dir=${result.runDir}`,
      `[product-propagation-dry-run] rows_analyzed_by_table=${JSON.stringify(result.rowsAnalyzedByTable)}`,
      `[product-propagation-dry-run] would_write=${result.wouldWriteCount}`,
      `[product-propagation-dry-run] would_review=${result.wouldReviewCount}`,
      `[product-propagation-dry-run] blocked_by_dispute=${result.blockedByDisputeCount}`,
      `[product-propagation-dry-run] validation=${result.validationChecks.map((c) => `${c.name}:${c.pass ? "PASS" : "FAIL"}`).join(",")}`,
      "",
    ].join("\n"),
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
