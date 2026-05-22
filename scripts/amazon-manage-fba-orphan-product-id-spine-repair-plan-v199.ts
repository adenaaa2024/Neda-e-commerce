/**
 * AMAZON-MANAGE-FBA-ORPHAN-PRODUCT-ID-SPINE-REPAIR-PLAN-V199
 * Read-only staging plan for E1B-blocking orphan import product_ids.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";

import {
  getStagingProjectRef,
  loadEnvLocalIntoProcess,
  supabaseUrlMatchesStagingRef,
} from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const E1B_BLOCKERS_DEFAULT =
  ".cursor/audit-reports/expected-packages-e1b-map-bridge-execute-v198/20260522T140000Z/blockers.md";
const V199_PACK_DEFAULT =
  ".cursor/audit-reports/v199-expected-identifier-ambiguous-review-pack/20260519T230000Z";

function v199RunIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--v199-run-id="));
  return a ? a.split("=")[1]!.trim() : "20260519T230000Z";
}
const OUT_BASE =
  ".cursor/audit-reports/amazon-manage-fba-orphan-product-id-spine-repair-plan-v199";

const ORPHAN_IDS = [
  "f258ee8b-5138-4784-a5cc-6686656c37a1",
  "16c235bd-e4e2-4a4b-9c4a-cdd4b9108b90",
  "c810afa9-aa48-4838-b4b0-4a6619145d98",
  "5f932bdf-6b1e-48ca-a27a-96cc47747bcd",
  "90118ed3-f5b4-449f-aeec-421b94cf21ed",
  "b0139190-dfac-499b-b54e-580256b3735a",
  "7e23d35a-adf9-4c99-97e6-0e03fe8b9b3e",
  "74b59ac0-8577-480a-b7ac-7c94428c3595",
  "35802a3e-3755-42b5-a983-6516caf1082f",
  "7af5d0ee-8d7c-4624-8f90-6f7d99a4f75c",
];

type E1bCsvRow = {
  expected_package_id: string;
  organization_id: string;
  store_id: string;
  fnsku: string | null;
  sku: string | null;
  trusted_single_product_id: string;
};

type Candidate = {
  orphan_product_id: string;
  expected_package_count: number;
  expected_package_ids: string[];
  sample_sku: string | null;
  sample_fnsku: string | null;
  import_rows: Record<string, number>;
  products_any: unknown[];
  merged_targets: unknown[];
  map_on_orphan: unknown[];
  spine_by_ident: Record<string, unknown> | null;
  disposition: string;
  wave: string;
  recommended_action: string;
  target_product_id: string | null;
  e1b_ready_after_repair: boolean;
};

function runIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function loadE1bFromV199Csv(v199PackDir: string): E1bCsvRow[] {
  const csvPath = path.join(v199PackDir, "manual-review-queue.csv");
  const lines = fs.readFileSync(csvPath, "utf8").split(/\r?\n/).filter(Boolean);
  const header = lines[0]!.split(",");
  const idx = (name: string) => header.indexOf(name);
  const out: E1bCsvRow[] = [];
  for (const line of lines.slice(1)) {
    if (!line.includes("e1b_trusted_existing_product_map_missing")) continue;
    const parts: string[] = [];
    let cur = "";
    let inQ = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]!;
      if (ch === '"') {
        inQ = !inQ;
        continue;
      }
      if (ch === "," && !inQ) {
        parts.push(cur);
        cur = "";
      } else cur += ch;
    }
    parts.push(cur);
    const trustedCol = parts[idx("trusted_single_product_id")]?.trim() ?? "";
    const evidence = parts[idx("source_evidence")] ?? "";
    const trustedFromEvidence =
      evidence.match(/trusted_product_id=([0-9a-f-]{36})/i)?.[1] ?? "";
    out.push({
      expected_package_id: parts[idx("expected_package_id")] ?? "",
      organization_id: parts[idx("organization_id")] ?? "",
      store_id: parts[idx("store_id")] ?? "",
      fnsku: parts[idx("fnsku")] || null,
      sku: parts[idx("sku")] || null,
      trusted_single_product_id: trustedCol || trustedFromEvidence,
    });
  }
  return out;
}

async function probeOrphan(
  client: pg.Client,
  orphanId: string,
  epRows: E1bCsvRow[],
): Promise<Candidate> {
  const org = epRows[0]?.organization_id;
  const store = epRows[0]?.store_id;
  const sku = epRows[0]?.sku;
  const fnsku = epRows[0]?.fnsku;

  const [productsAny, mergedTargets, mapOnOrphan, manageRows, afiRows, fbaRows, spineByIdent] =
    await Promise.all([
      client.query(
        `SELECT id::text, sku, fnsku, asin, deleted_at::text, merge_status, merged_into_id::text
         FROM public.products WHERE id = $1::uuid`,
        [orphanId],
      ),
      client.query(
        `SELECT id::text AS product_id, sku, fnsku, asin, merge_status
         FROM public.products
         WHERE merged_into_id = $1::uuid AND deleted_at IS NULL
           AND (merge_status IS NULL OR merge_status <> 'merged')
         LIMIT 3`,
        [orphanId],
      ),
      client.query(
        `SELECT id::text, product_id::text, seller_sku, fnsku, match_source
         FROM public.product_identifier_map
         WHERE product_id = $1::uuid AND deleted_at IS NULL LIMIT 5`,
        [orphanId],
      ),
      client.query(
        `SELECT id::text, sku, fnsku, asin, product_id::text, resolved_product_id::text, product_name
         FROM public.amazon_manage_fba_inventory
         WHERE COALESCE(resolved_product_id, product_id) = $1::uuid LIMIT 10`,
        [orphanId],
      ),
      client.query(
        `SELECT id::text, seller_sku AS sku, fulfillment_channel_sku AS fnsku, asin,
                product_id::text, resolved_product_id::text
         FROM public.amazon_amazon_fulfilled_inventory
         WHERE COALESCE(resolved_product_id, product_id) = $1::uuid LIMIT 10`,
        [orphanId],
      ),
      client.query(
        `SELECT id::text, sku, fnsku, asin, product_id::text, resolved_product_id::text, product_name
         FROM public.amazon_fba_inventory
         WHERE COALESCE(resolved_product_id, product_id) = $1::uuid LIMIT 10`,
        [orphanId],
      ),
      org && store && (sku || fnsku)
        ? client.query(
            `SELECT id::text AS product_id, sku, fnsku, asin
             FROM public.products
             WHERE organization_id = $1::uuid AND store_id = $2::uuid
               AND deleted_at IS NULL AND (merge_status IS NULL OR merge_status <> 'merged')
               AND (($3::text IS NOT NULL AND fnsku = $3) OR ($4::text IS NOT NULL AND sku = $4))
             ORDER BY updated_at DESC NULLS LAST LIMIT 3`,
            [org, store, fnsku, sku],
          )
        : Promise.resolve({ rows: [] }),
    ]);

  const pa = productsAny.rows;
  const mt = mergedTargets.rows;
  const mo = mapOnOrphan.rows;
  const mr = manageRows.rows;
  const ar = afiRows.rows;
  const fr = fbaRows.rows;
  const sbi = spineByIdent.rows[0] as Record<string, unknown> | undefined;

  let disposition: string;
  let recommended_action: string;
  let target_product_id: string | null = null;
  let wave: string;

  if (sbi?.product_id) {
    disposition = "remap_import_to_active_spine_by_identifier";
    target_product_id = String(sbi.product_id);
    recommended_action = `Remap manage-FBA/AFI/FBA product_id from ${orphanId} to ${target_product_id}; then E1B map-only`;
    wave = "wave_a_remap_import";
  } else if (mt.length > 0) {
    disposition = "remap_import_to_merge_target";
    target_product_id = String((mt[0] as { product_id: string }).product_id);
    recommended_action = `Remap orphan to merge target ${target_product_id}`;
    wave = "wave_a_remap_import";
  } else if (pa.length > 0 && (pa[0] as { deleted_at: string | null }).deleted_at) {
    disposition = "orphan_was_soft_deleted_product";
    recommended_action = "Governed restore or identifier remap to replacement active product";
    wave = "wave_b_restore_or_remap";
  } else if (pa.length > 0) {
    disposition = "orphan_product_inactive_merge_state";
    recommended_action = "Resolve merge_status on products row before import remap";
    wave = "wave_b_merge_resolution";
  } else if (mr.length > 0 || ar.length > 0 || fr.length > 0) {
    const hasName = [...mr, ...fr].some((r) => (r as { product_name?: string }).product_name);
    if (hasName) {
      disposition = "governed_product_materialization";
      recommended_action =
        "E2-class governed product+map from trusted import (separate approval); not E1B until spine exists";
      wave = "wave_c_materialize";
    } else {
      disposition = "remap_import_after_spine_lookup_failed";
      recommended_action =
        "No active products match by org/store/sku/fnsku — operator review or identifier map bridge from AFI tier refresh";
      wave = "wave_d_manual";
    }
  } else {
    disposition = "stale_orphan_no_import_rows";
    recommended_action = "Reclassify expected_packages; clear stale trusted id";
    wave = "wave_d_manual";
  }

  return {
    orphan_product_id: orphanId,
    expected_package_count: epRows.length,
    expected_package_ids: epRows.map((r) => r.expected_package_id),
    sample_sku: sku,
    sample_fnsku: fnsku,
    import_rows: {
      amazon_manage_fba_inventory: mr.length,
      amazon_amazon_fulfilled_inventory: ar.length,
      amazon_fba_inventory: fr.length,
    },
    products_any: pa,
    merged_targets: mt,
    map_on_orphan: mo,
    spine_by_ident: sbi ?? null,
    disposition,
    wave,
    recommended_action,
    target_product_id,
    e1b_ready_after_repair: !!target_product_id,
  };
}

async function main(): Promise<void> {
  const runId = runIdArg();
  const v199RunId = v199RunIdArg();
  const v199Pack = path.join(
    process.cwd(),
    ".cursor",
    "audit-reports",
    "v199-expected-identifier-ambiguous-review-pack",
    v199RunId,
  );
  const e1bBlockers = E1B_BLOCKERS_DEFAULT;
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  loadEnvLocalIntoProcess();
  const dbUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() || "";
  if (
    !dbUrl ||
    getStagingProjectRef({ loadEnv: false }) !== STAGING_REF ||
    !supabaseUrlMatchesStagingRef(dbUrl, STAGING_REF)
  ) {
    throw new Error(`Staging ref guard failed (expected ${STAGING_REF})`);
  }

  const e1bRows = loadE1bFromV199Csv(v199Pack);
  if (e1bRows.length !== 28) {
    throw new Error(`Expected 28 E1B CSV rows, found ${e1bRows.length}`);
  }

  const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();
  await client.query("SET statement_timeout = '120s'");

  const pkgItems = await client.query(
    `SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='package_items'`,
  );
  if ((pkgItems.rowCount ?? 0) > 0) throw new Error("package_items exists (forbidden)");

  const byOrphan = new Map<string, E1bCsvRow[]>();
  for (const row of e1bRows) {
    const list = byOrphan.get(row.trusted_single_product_id) ?? [];
    list.push(row);
    byOrphan.set(row.trusted_single_product_id, list);
  }

  const candidates: Candidate[] = [];
  for (const orphanId of ORPHAN_IDS) {
    candidates.push(await probeOrphan(client, orphanId, byOrphan.get(orphanId) ?? []));
  }
  await client.end();

  const readyCount = candidates.filter((c) => c.e1b_ready_after_repair).length;
  const waveCounts = candidates.reduce(
    (acc, c) => {
      acc[c.wave] = (acc[c.wave] ?? 0) + 1;
      return acc;
    },
    {} as Record<string, number>,
  );

  const preimage = {
    run_id: runId,
    staging_ref: STAGING_REF,
    mode: "read_only_plan",
    orphan_product_id_count: ORPHAN_IDS.length,
    e1b_expected_package_rows: e1bRows.length,
    e1b_ready_after_repair_count: readyCount,
    spine_proof_passes: readyCount === ORPHAN_IDS.length,
    inputs: { e1b_blockers: e1bBlockers, v199_pack: v199Pack, v199_run_id: v199RunId },
    candidates,
    wave_counts: waveCounts,
  };

  fs.writeFileSync(path.join(outDir, "candidate-preimage.json"), JSON.stringify(preimage, null, 2));

  const planMd = [
    "# Amazon manage-FBA orphan product_id spine repair plan (V199)",
    "",
    `**Run id:** \`${runId}\``,
    `**Staging ref:** \`${STAGING_REF}\``,
    `**Mode:** read-only plan (no DB writes)`,
    "",
    "## Scope",
    "",
    "- **10** orphan import `product_id` values (E1B blockers)",
    "- **28** `expected_packages` rows in V199 E1B cohort",
    "- Primary source table: `amazon_manage_fba_inventory` (with AFI/FBA overlap)",
    "",
    "## Spine proof (plan-time)",
    "",
    "| Metric | Count |",
    "|--------|------:|",
    `| Orphan ids | ${ORPHAN_IDS.length} |`,
    `| With deterministic active \`products.id\` remap target | **${readyCount}** |`,
    `| E1B re-execute without prior import repair | **${readyCount === ORPHAN_IDS.length ? "YES" : "NO"}** |`,
    "",
    "## Wave summary",
    "",
    "| Wave | Count | Action |",
    "|------|------:|--------|",
    `| wave_a_remap_import | ${waveCounts.wave_a_remap_import ?? 0} | UPDATE import \`product_id\`/\`resolved_product_id\` → active spine (governed batch) |`,
    `| wave_b_restore_or_remap | ${waveCounts.wave_b_restore_or_remap ?? 0} | Soft-deleted orphan product — restore or replace |`,
    `| wave_b_merge_resolution | ${waveCounts.wave_b_merge_resolution ?? 0} | Merge metadata cleanup |`,
    `| wave_c_materialize | ${waveCounts.wave_c_materialize ?? 0} | E2-class product+map (not E1B) |`,
    `| wave_d_manual | ${waveCounts.wave_d_manual ?? 0} | Operator review |`,
    "",
    "## Per-orphan disposition",
    "",
    "| orphan_product_id | EP rows | disposition | target_product_id |",
    "|---|---:|---|---|",
    ...candidates.map(
      (c) =>
        `| \`${c.orphan_product_id}\` | ${c.expected_package_count} | ${c.disposition} | ${c.target_product_id ?? "—"} |`,
    ),
    "",
    "## Governed execute order",
    "",
    "1. Operator approval for import-table UPDATE scope (staging only, rollback per orphan batch).",
    "2. **Wave A** — remap manage-FBA (+ peers) `product_id` to `target_product_id` where plan shows `remap_import_*`.",
    "3. **Wave C** — only rows with `governed_product_materialization` (expected: majority when no `products` row exists).",
    "4. Re-run V199 review pack; confirm E1B cohort shrinks or spine_proof passes.",
    "5. `EXPECTED-PACKAGES-E1B-MAP-ONLY-REFRESH-EXECUTE-V198` only after all 10 ids resolve on active spine.",
    "",
    "## Hard stops",
    "",
    "- No blind bulk on full manage-FBA",
    "- No `package_items`; no legacy `returns`",
    "- No Amazon API; no AI",
    "",
    "## Next prompt",
    "",
    preimage.spine_proof_passes
      ? "EXPECTED-PACKAGES-E1B-MAP-ONLY-REFRESH-EXECUTE-V198"
      : "AMAZON-MANAGE-FBA-ORPHAN-PRODUCT-ID-SPINE-REPAIR-EXECUTE-V200",
  ];
  fs.writeFileSync(path.join(outDir, "repair-plan.md"), planMd.join("\n") + "\n");

  const manifest = {
    prompt: "AMAZON-MANAGE-FBA-ORPHAN-PRODUCT-ID-SPINE-REPAIR-PLAN-V199",
    run_id: runId,
    staging_ref: STAGING_REF,
    status: "PASS",
    mode: "read_only",
    orphan_ids: ORPHAN_IDS.length,
    e1b_rows: e1bRows.length,
    spine_proof_passes: preimage.spine_proof_passes,
    e1b_ready_after_repair: readyCount,
    wave_counts: waveCounts,
    next_prompt: preimage.spine_proof_passes
      ? "EXPECTED-PACKAGES-E1B-MAP-ONLY-REFRESH-EXECUTE-V198"
      : "AMAZON-MANAGE-FBA-ORPHAN-PRODUCT-ID-SPINE-REPAIR-EXECUTE-V200",
    forbidden: {
      db_mutations: false,
      production: false,
      amazon_api: false,
      ai: false,
      package_items: false,
      legacy_returns: false,
    },
    artifacts: ["repair-plan.md", "candidate-preimage.json", "manifest.json"],
  };
  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  console.log(JSON.stringify(manifest, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
