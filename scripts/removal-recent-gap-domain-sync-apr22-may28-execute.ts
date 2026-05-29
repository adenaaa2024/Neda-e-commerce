/**
 * REMOVAL-RECENT-GAP-DOMAIN-SYNC-APR22-MAY28 — staging only
 *
 *   npx tsx scripts/removal-recent-gap-domain-sync-apr22-may28-execute.ts --apply
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import { createRequire, type Module } from "node:module";
import { createClient } from "@supabase/supabase-js";
import pg from "pg";

import {
  loadEnvLocalIntoProcess,
  refFromSupabaseUrl,
  supabaseUrlMatchesStagingRef,
} from "../lib/staging-project-ref";
import {
  parseRemovalRawDataHints,
  resolveExpectedPackageProduct,
  type RemovalExpectedPackageRow,
} from "../lib/removal/resolve-expected-package-product";
import type { ScannerResolutionColumns } from "../lib/scanner-product-resolve";

const require = createRequire(import.meta.url);
require.cache[require.resolve("server-only")] = { exports: {} } as Module;

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const ORIGINAL_REF = "kxsvedvpjldygtdbylsy";
const ORG_ID = "00000000-0000-0000-0000-000000000001";
const STORE_ID = "509ee1f6-622c-46a5-8110-7b889ba46c2c";
const REQUIRED_BRANCH = "feature/product-canonicalization-v2";
const DOMAIN_APPROVAL = ".cursor/operator-approvals/sp-api-removal-reports-domain-sync-approval.md";
const RESOLVER_APPROVAL = ".cursor/operator-approvals/removal-expected-packages-resolver-backfill-approval.md";
const OUT_BASE = ".cursor/audit-reports/removal-recent-gap-domain-sync-apr22-may28";

const GAP_WINDOW = {
  start: "2026-04-22T00:00:00.000Z",
  end: "2026-05-28T23:59:59.999Z",
};
const ORDER_UPLOAD_ID = "85940f07-f8f9-4b74-b7ab-9a146d091abb";
const SHIPMENT_UPLOAD_ID = "0c8e1630-dc9f-4e01-9605-c3969d8f9414";
const RESOLVER_SOURCES = ["detail_shipment", "detail_remainder", "receive_allocated"] as const;

function runIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function readFlags(approvalPath: string, keys: string[]): Record<string, string> {
  const text = fs.readFileSync(path.join(process.cwd(), approvalPath), "utf8");
  const out: Record<string, string> = {};
  for (const k of keys) {
    out[k] = new RegExp(`${k}\\s*=\\s*true`, "i").test(text) ? "true" : "false";
  }
  return out;
}

async function domainCounts(client: pg.Client) {
  const r = await client.query(
    `SELECT
      (SELECT COUNT(*)::int FROM public.amazon_removals WHERE organization_id=$1::uuid AND store_id=$2::uuid) AS removals,
      (SELECT COUNT(*)::int FROM public.amazon_removal_shipments WHERE organization_id=$1::uuid AND store_id=$2::uuid) AS shipments`,
    [ORG_ID, STORE_ID],
  );
  return r.rows[0] as { removals: number; shipments: number };
}

async function uploadDomainCount(client: pg.Client, uploadId: string, table: string): Promise<number> {
  const r = await client.query(`SELECT COUNT(*)::int AS c FROM public.${table} WHERE upload_id = $1::uuid`, [uploadId]);
  return (r.rows[0] as { c: number }).c;
}

async function epCounts(client: pg.Client) {
  const r = await client.query(
    `SELECT COUNT(*)::int AS derived_total,
      COUNT(*) FILTER (WHERE build_source='detail_shipment')::int AS detail_shipment,
      COUNT(*) FILTER (WHERE build_source='detail_remainder')::int AS detail_remainder,
      COUNT(*) FILTER (WHERE resolved_product_id IS NOT NULL)::int AS resolved_total
     FROM public.expected_packages WHERE organization_id=$1::uuid AND store_id=$2::uuid
       AND build_source = ANY($3::text[])`,
    [ORG_ID, STORE_ID, RESOLVER_SOURCES],
  );
  return r.rows[0] as Record<string, number>;
}

async function epMismatchCount(client: pg.Client): Promise<number> {
  const r = await client.query(
    `SELECT COUNT(*)::int AS c FROM (
      SELECT d.id FROM public.amazon_removals d
      LEFT JOIN public.expected_packages ep ON ep.source_detail_row_id = d.id
        AND ep.organization_id = d.organization_id
        AND ep.store_id IS NOT DISTINCT FROM d.store_id
        AND ep.build_source IN ('detail_shipment','detail_remainder')
      WHERE d.organization_id=$1::uuid AND d.store_id=$2::uuid AND d.order_id IS NOT NULL
      GROUP BY d.id, d.shipped_quantity
      HAVING COALESCE(d.shipped_quantity,0) IS DISTINCT FROM COALESCE(SUM(COALESCE(ep.expected_scan_quantity,0)),0)
    ) x`,
    [ORG_ID, STORE_ID],
  );
  return (r.rows[0] as { c: number }).c;
}

async function runPipeline(uploadId: string, reportType: string) {
  const { supabaseServer } = await import("../lib/supabase-server");
  const { parseSourceRun } = await import("../lib/amazon/reports-api-source-run");
  const { runReportsApiImportPipeline } = await import("../lib/amazon/reports-api-pipeline-handoff");
  const { data: upRow } = await supabaseServer
    .from("raw_report_uploads")
    .select("metadata, report_type")
    .eq("id", uploadId)
    .eq("organization_id", ORG_ID)
    .maybeSingle();
  const sr = parseSourceRun(upRow?.metadata);
  if (!sr) return { ok: false, state: "failed", error: "missing_source_run" };
  const t0 = performance.now();
  const pipe = await runReportsApiImportPipeline({
    uploadId,
    organizationId: ORG_ID,
    sourceRun: sr,
    importFullFile: true,
  });
  return { ...pipe, report_type: reportType, upload_id: uploadId, wall_ms: Math.round(performance.now() - t0) };
}

function n(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

async function resolverBackfillChunk(client: pg.Client, supabase: ReturnType<typeof createClient>) {
  const batchRes = await client.query(
    `SELECT ep.id::text, ep.organization_id::text, ep.store_id::text, ep.sku, ep.fnsku,
      ep.resolved_product_id::text, ep.resolved_catalog_product_id::text,
      ep.identifier_resolution_status, ep.identifier_resolution_confidence::text,
      COALESCE(ep.source_detail_row_id, parent.source_detail_row_id)::text AS source_detail_row_id,
      ep.order_id, ep.build_source, ep.tracking_number
     FROM public.expected_packages ep
     LEFT JOIN public.expected_packages parent ON parent.id = ep.parent_expected_package_id
     WHERE ep.organization_id = $1::uuid AND ep.store_id = $2::uuid
       AND ep.build_source = ANY($3::text[])
       AND (
         ep.source_detail_row_id IN (
           SELECT id FROM public.amazon_removals WHERE upload_id = $4::uuid
         )
         OR ep.source_shipment_row_id IN (
           SELECT id FROM public.amazon_removal_shipments WHERE upload_id = $5::uuid
         )
       )
     ORDER BY ep.id`,
    [ORG_ID, STORE_ID, RESOLVER_SOURCES, ORDER_UPLOAD_ID, SHIPMENT_UPLOAD_ID],
  );
  const batch = batchRes.rows as RemovalExpectedPackageRow[];
  let applied = 0;
  const detailIds = [...new Set(batch.map((r) => n(r.source_detail_row_id)).filter(Boolean))] as string[];
  const hydration = new Map<string, { asin: string | null; upc: string | null }>();
  if (detailIds.length) {
    const h = await client.query(`SELECT id::text, raw_data FROM public.amazon_removals WHERE id = ANY($1::uuid[])`, [detailIds]);
    for (const row of h.rows) hydration.set(String(row.id), parseRemovalRawDataHints(row.raw_data));
  }
  for (const row of batch) {
    const beforeStatus = n(row.identifier_resolution_status);
    const beforePid = n(row.resolved_product_id);
    const detailId = n(row.source_detail_row_id);
    const hints = detailId ? hydration.get(detailId) : undefined;
    const resolved = await resolveExpectedPackageProduct(supabase, row, {
      asinFromRemoval: hints?.asin ?? null,
      upcFromRemoval: hints?.upc ?? null,
    });
    let after: ScannerResolutionColumns = { ...resolved.columns };
    if (after.identifier_resolution_status === "resolved" && after.resolved_product_id) {
      const ex = await client.query(`SELECT 1 FROM public.products WHERE id=$1::uuid LIMIT 1`, [after.resolved_product_id]);
      if (!ex.rowCount) {
        after = { ...after, resolved_product_id: null, resolved_catalog_product_id: null, identifier_resolution_status: "unresolved" };
      }
    } else {
      after = {
        resolved_product_id: null,
        resolved_catalog_product_id: null,
        identifier_resolution_status: after.identifier_resolution_status,
        identifier_resolution_confidence: after.identifier_resolution_confidence,
      };
    }
    const unchanged =
      beforePid === after.resolved_product_id && beforeStatus === after.identifier_resolution_status;
    if (unchanged) continue;
    if (after.resolved_product_id) {
      const u = await client.query(
        `UPDATE public.expected_packages t SET resolved_product_id=$2::uuid, resolved_catalog_product_id=$3::uuid,
         identifier_resolution_status=$4, identifier_resolution_confidence=$5, updated_at=now()
         FROM public.products pr WHERE t.id=$1::uuid AND pr.id=$2::uuid RETURNING t.id`,
        [row.id, after.resolved_product_id, after.resolved_catalog_product_id, after.identifier_resolution_status, after.identifier_resolution_confidence],
      );
      if (u.rowCount) applied += 1;
    } else {
      const u = await client.query(
        `UPDATE public.expected_packages SET resolved_product_id=NULL, resolved_catalog_product_id=NULL,
         identifier_resolution_status=$2, identifier_resolution_confidence=$3, updated_at=now()
         WHERE id=$1::uuid RETURNING id`,
        [row.id, after.identifier_resolution_status, after.identifier_resolution_confidence],
      );
      if (u.rowCount) applied += 1;
    }
  }
  return { scanned: batch.length, applied };
}

async function main(): Promise<void> {
  const runId = runIdArg();
  const apply = process.argv.includes("--apply");
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  loadEnvLocalIntoProcess();
  const branch = execSync("git branch --show-current", { encoding: "utf8" }).trim();
  const domainFlags = readFlags(DOMAIN_APPROVAL, [
    "APPROVED_TO_RUN_STAGING",
    "APPROVED_SP_API_REMOVAL_REPORTS_DOMAIN_SYNC",
  ]);
  const resolverFlags = readFlags(RESOLVER_APPROVAL, [
    "APPROVED_TO_RUN_STAGING",
    "APPROVED_REMOVAL_EXPECTED_PACKAGES_RESOLVER_BACKFILL",
  ]);
  const blockers: string[] = [];
  if (branch !== REQUIRED_BRANCH) blockers.push(`Branch must be ${REQUIRED_BRANCH}`);
  if (domainFlags.APPROVED_TO_RUN_STAGING !== "true" || domainFlags.APPROVED_SP_API_REMOVAL_REPORTS_DOMAIN_SYNC !== "true") {
    blockers.push("Domain sync approval flags not both true");
  }
  if (apply && (resolverFlags.APPROVED_TO_RUN_STAGING !== "true" || resolverFlags.APPROVED_REMOVAL_EXPECTED_PACKAGES_RESOLVER_BACKFILL !== "true")) {
    blockers.push("Resolver backfill approval flags not both true (required for --apply)");
  }

  const dbUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ?? "";
  if (!dbUrl) blockers.push("STAGING_DIRECT_POSTGRES_URL unset");
  else {
    if (!supabaseUrlMatchesStagingRef(dbUrl, STAGING_REF)) blockers.push(`DB must target ${STAGING_REF}`);
    if (dbUrl.includes(ORIGINAL_REF)) blockers.push("DB targets original");
  }
  const publicUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ?? "";
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()) blockers.push("SUPABASE_SERVICE_ROLE_KEY missing");
  if (publicUrl && refFromSupabaseUrl(publicUrl) !== STAGING_REF) blockers.push("NEXT_PUBLIC_SUPABASE_URL not staging");

  fs.writeFileSync(
    path.join(outDir, "approval-proof.md"),
    [
      "# Approval proof",
      "",
      "## Domain sync",
      ...Object.entries(domainFlags).map(([k, v]) => `- ${k}: **${v}**`),
      "",
      "## Resolver backfill",
      ...Object.entries(resolverFlags).map(([k, v]) => `- ${k}: **${v}**`),
      "",
      `| gap window | ${GAP_WINDOW.start} → ${GAP_WINDOW.end} |`,
      `| order upload | \`${ORDER_UPLOAD_ID}\` |`,
      `| shipment upload | \`${SHIPMENT_UPLOAD_ID}\` |`,
    ].join("\n") + "\n",
  );

  fs.writeFileSync(
    path.join(outDir, "raw-upload-ids.json"),
    JSON.stringify(
      {
        window: GAP_WINDOW,
        fetch_expected_rows: { order: 341, shipment: 708 },
        uploads: [
          { report_type: "REMOVAL_ORDER", upload_id: ORDER_UPLOAD_ID },
          { report_type: "REMOVAL_SHIPMENT", upload_id: SHIPMENT_UPLOAD_ID },
        ],
      },
      null,
      2,
    ),
  );

  if (!apply || blockers.length) {
    fs.writeFileSync(path.join(outDir, "blockers.md"), blockers.map((b) => `- ${b}`).join("\n") + "\n");
    fs.writeFileSync(
      path.join(outDir, "manifest.json"),
      JSON.stringify(
        {
          prompt: "REMOVAL-RECENT-GAP-DOMAIN-SYNC-APR22-MAY28",
          run_id: runId,
          ok: !blockers.length,
          apply: false,
          blockers,
          exact_next_prompt: "npx tsx scripts/removal-recent-gap-domain-sync-apr22-may28-execute.ts --apply",
        },
        null,
        2,
      ),
    );
    console.log(JSON.stringify({ ok: !blockers.length, outDir, apply: false, blockers }, null, 2));
    return;
  }

  const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();
  await client.query("SET statement_timeout = '600s'");

  const beforeDomain = await domainCounts(client);
  const beforeEp = await epCounts(client);
  const productsBefore = (await client.query(`SELECT COUNT(*)::int AS c FROM public.products WHERE organization_id=$1::uuid`, [ORG_ID])).rows[0] as { c: number };

  const orderBefore = await uploadDomainCount(client, ORDER_UPLOAD_ID, "amazon_removals");
  const shipBefore = await uploadDomainCount(client, SHIPMENT_UPLOAD_ID, "amazon_removal_shipments");

  const orderPipe = await runPipeline(ORDER_UPLOAD_ID, "REMOVAL_ORDER");
  const shipPipe = await runPipeline(SHIPMENT_UPLOAD_ID, "REMOVAL_SHIPMENT");

  const orderAfter = await uploadDomainCount(client, ORDER_UPLOAD_ID, "amazon_removals");
  const shipAfter = await uploadDomainCount(client, SHIPMENT_UPLOAD_ID, "amazon_removal_shipments");
  const afterSyncDomain = await domainCounts(client);

  const rebuildRes = await client.query(
    `SELECT * FROM public.rebuild_expected_packages_from_removals($1::uuid, $2::uuid)`,
    [ORG_ID, STORE_ID],
  );
  const rebuild = rebuildRes.rows[0] as Record<string, number>;

  const afterEpPreResolver = await epCounts(client);
  const mismatchCount = await epMismatchCount(client);
  const rebuildValid = mismatchCount === 0;

  const supabase = createClient(publicUrl, process.env.SUPABASE_SERVICE_ROLE_KEY!.trim(), {
    auth: { persistSession: false },
  });
  const resolverStats = await resolverBackfillChunk(client, supabase);
  const afterEp = await epCounts(client);
  const productsAfter = (await client.query(`SELECT COUNT(*)::int AS c FROM public.products WHERE organization_id=$1::uuid`, [ORG_ID])).rows[0] as { c: number };

  await client.end();

  const execBlockers: string[] = [];
  if (!orderPipe.ok) execBlockers.push(`REMOVAL_ORDER pipeline: ${orderPipe.error ?? orderPipe.state}`);
  if (!shipPipe.ok) execBlockers.push(`REMOVAL_SHIPMENT pipeline: ${shipPipe.error ?? shipPipe.state}`);
  if (!rebuildValid) execBlockers.push(`rebuild_valid=no mismatch=${mismatchCount}`);
  if (productsAfter.c !== productsBefore.c) execBlockers.push("products count changed");

  fs.writeFileSync(
    path.join(outDir, "domain-sync-result.md"),
    [
      "# Domain sync result",
      "",
      `| Upload | Domain before → after | New rows |`,
      `|--------|----------------------|----------|`,
      `| ORDER \`${ORDER_UPLOAD_ID}\` | ${orderBefore} → ${orderAfter} | **+${orderAfter - orderBefore}** |`,
      `| SHIPMENT \`${SHIPMENT_UPLOAD_ID}\` | ${shipBefore} → ${shipAfter} | **+${shipAfter - shipBefore}** |`,
      "",
      `Net org/store: removals +${afterSyncDomain.removals - beforeDomain.removals}, shipments +${afterSyncDomain.shipments - beforeDomain.shipments}`,
      "",
      "## Pipelines",
      "",
      `| Report | ok | state | wall_ms |`,
      `|--------|----|-------|--------:|`,
      `| REMOVAL_ORDER | ${orderPipe.ok} | \`${orderPipe.state}\` | ${orderPipe.wall_ms} |`,
      `| REMOVAL_SHIPMENT | ${shipPipe.ok} | \`${shipPipe.state}\` | ${shipPipe.wall_ms} |`,
    ].join("\n") + "\n",
  );

  fs.writeFileSync(
    path.join(outDir, "expected-packages-rebuild-result.md"),
    [
      "# Expected packages rebuild",
      "",
      "| Metric | Before | After | Delta |",
      "|--------|-------:|------:|------:|",
      `| derived total | ${beforeEp.derived_total} | ${afterEp.derived_total} | ${afterEp.derived_total - beforeEp.derived_total} |`,
      `| detail_shipment | ${beforeEp.detail_shipment} | ${afterEp.detail_shipment} | ${afterEp.detail_shipment - beforeEp.detail_shipment} |`,
      `| detail_remainder | ${beforeEp.detail_remainder} | ${afterEp.detail_remainder} | ${afterEp.detail_remainder - beforeEp.detail_remainder} |`,
      `| resolved (derived cohort) | ${beforeEp.resolved_total} | ${afterEp.resolved_total} | ${afterEp.resolved_total - beforeEp.resolved_total} |`,
      "",
      "## rebuild_expected_packages_from_removals",
      "",
      `| detail_lines_in_scope | ${rebuild.detail_lines_in_scope} |`,
      `| matched_rows_upserted | ${rebuild.matched_rows_upserted} |`,
      `| remainder_rows_upserted | ${rebuild.remainder_rows_upserted} |`,
      `| overflow_lines | ${rebuild.overflow_lines} |`,
      `| obsolete_rows_deleted | ${rebuild.obsolete_rows_deleted} |`,
      "",
      `rebuild_valid: **${rebuildValid ? "yes" : "no"}** (allocation mismatch=${mismatchCount})`,
    ].join("\n") + "\n",
  );

  fs.writeFileSync(
    path.join(outDir, "resolver-backfill-result.md"),
    [
      "# Resolver backfill (gap-scoped)",
      "",
      `| scanned | ${resolverStats.scanned} |`,
      `| applied | ${resolverStats.applied} |`,
    ].join("\n") + "\n",
  );

  fs.writeFileSync(
    path.join(outDir, "smoke-before-after.json"),
    JSON.stringify(
      {
        gap_window: GAP_WINDOW,
        domain: {
          before: beforeDomain,
          after: afterSyncDomain,
          gap_order_rows: orderAfter - orderBefore,
          gap_shipment_rows: shipAfter - shipBefore,
        },
        expected_packages: { before: beforeEp, after_pre_resolver: afterEpPreResolver, after: afterEp },
        rebuild,
        rebuild_valid: rebuildValid,
        mismatch_count: mismatchCount,
        resolver: resolverStats,
        pipelines: { order: orderPipe, shipment: shipPipe },
      },
      null,
      2,
    ),
  );

  fs.writeFileSync(
    path.join(outDir, "rollback.sql"),
    [
      `-- Rollback recent-gap domain sync run_id=${runId}`,
      `DELETE FROM public.amazon_removal_shipments WHERE upload_id = '${SHIPMENT_UPLOAD_ID}'::uuid;`,
      `DELETE FROM public.amazon_removals WHERE upload_id = '${ORDER_UPLOAD_ID}'::uuid;`,
      `SELECT public.rebuild_expected_packages_from_removals('${ORG_ID}'::uuid, '${STORE_ID}'::uuid);`,
    ].join("\n") + "\n",
  );

  fs.writeFileSync(
    path.join(outDir, "blockers.md"),
    execBlockers.length ? execBlockers.map((b) => `- ${b}`).join("\n") + "\n" : "- None\n",
  );

  const ok = execBlockers.length === 0;
  const nextPrompt = ok
    ? "REMOVAL-9-MONTH-BACKFILL-DOMAIN-SYNC-CHUNK2 — recent Apr22–May28 gap synced; proceed chunk2 domain sync for remaining backfill window"
    : "REMOVAL-RECENT-GAP-DOMAIN-SYNC-APR22-MAY28 — fix blockers and re-run with --apply";

  fs.writeFileSync(
    path.join(outDir, "manifest.json"),
    JSON.stringify(
      {
        prompt: "REMOVAL-RECENT-GAP-DOMAIN-SYNC-APR22-MAY28",
        run_id: runId,
        status: ok ? "PASS" : "FAIL",
        gap_window: GAP_WINDOW,
        order_upload_id: ORDER_UPLOAD_ID,
        shipment_upload_id: SHIPMENT_UPLOAD_ID,
        new_order_rows: orderAfter - orderBefore,
        new_shipment_rows: shipAfter - shipBefore,
        expected_packages_before: beforeEp.derived_total,
        expected_packages_after: afterEp.derived_total,
        resolved_count_cohort: afterEp.resolved_total,
        resolver_applied: resolverStats.applied,
        rebuild_valid: rebuildValid,
        exact_next_prompt: nextPrompt,
      },
      null,
      2,
    ),
  );

  console.log(
    JSON.stringify(
      {
        ok,
        outDir: path.relative(process.cwd(), outDir).replace(/\\/g, "/"),
        new_order_rows: orderAfter - orderBefore,
        new_shipment_rows: shipAfter - shipBefore,
        expected_packages_before: beforeEp.derived_total,
        expected_packages_after: afterEp.derived_total,
        resolved_count: afterEp.resolved_total,
        resolver_applied: resolverStats.applied,
        rebuild_valid: rebuildValid,
        blockers: execBlockers,
        next_prompt: nextPrompt,
      },
      null,
      2,
    ),
  );
  if (!ok) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
