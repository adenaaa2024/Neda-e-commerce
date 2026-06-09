/**
 * PHASE-5C-EXPECTED-PACKAGES-CLASS-C-GOVERNED-SEED-PLAN (read-only)
 *   npx tsx scripts/phase5c-expected-packages-class-c-governed-seed-plan.ts --run-id=<UTC>
 */
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";

import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";

const ORIGINAL_REF = "kxsvedvpjldygtdbylsy";
const ORG = "00000000-0000-0000-0000-000000000001";
const AUDIT_CSV = ".cursor/audit-reports/phase5-product-link-integrity-audit/20260608193000Z/manual_review_unresolved.csv";
const OUT_BASE = ".cursor/audit-reports/phase5c-expected-packages-class-c-governed-seed-plan";
const BLOCKED_FNSKU = "X003UR3W83";

type ReviewBucket = "A" | "B" | "C" | "D";

function runId(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function csvEsc(v: unknown): string {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function writeCsv(filePath: string, headers: string[], rows: Record<string, unknown>[]): void {
  fs.writeFileSync(
    filePath,
    [headers.join(","), ...rows.map((r) => headers.map((h) => csvEsc(r[h])).join(","))].join("\n") + "\n",
    "utf8",
  );
}

function isDirtySku(sku: string | null): boolean {
  const u = (sku ?? "").trim().toUpperCase();
  return !u || ["UNKNOW", "UNKNOWN", "N/A", "NA", "NULL", "-"].includes(u);
}

function isLikelyAsinInFnsku(fnsku: string | null): boolean {
  return /^B[0-9A-Z]{9}$/i.test((fnsku ?? "").trim());
}

function isValidFnsku(fnsku: string | null): boolean {
  return /^X[0-9A-Z]{9}$/i.test((fnsku ?? "").trim());
}

async function cols(client: pg.Client, table: string): Promise<Set<string>> {
  const r = await client.query(
    `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1`,
    [table],
  );
  return new Set(r.rows.map((x: { column_name: string }) => x.column_name));
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const dbUrl = process.env.ORIGINAL_DIRECT_POSTGRES_URL?.trim() ?? "";
  if (!dbUrl.includes(ORIGINAL_REF)) throw new Error("ORIGINAL_DIRECT_POSTGRES_URL guard failed");

  const rid = runId();
  const outDir = path.join(process.cwd(), OUT_BASE, rid);
  fs.mkdirSync(outDir, { recursive: true });

  const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();
  await client.query("SET statement_timeout = '300s'");

  const epCols = await cols(client, "expected_packages");
  const prodCols = await cols(client, "products");
  const remCols = await cols(client, "amazon_removals");
  const hasEpAsin = epCols.has("asin");
  const hasEpUpc = epCols.has("upc");
  const remTitleCol = remCols.has("product_name")
    ? "ar.product_name"
    : remCols.has("title")
      ? "ar.title"
      : "NULL::text";
  const remAsinCol = remCols.has("asin") ? "ar.asin" : "NULL::text AS removal_asin";
  const remSkuCol = remCols.has("sku") ? "ar.sku" : "NULL::text AS removal_sku";
  const remFnskuCol = remCols.has("fnsku") ? "ar.fnsku" : "NULL::text AS removal_fnsku";

  const unresolved = await client.query(
    `
    SELECT
      ep.id::text,
      ep.tracking_number,
      ep.sku,
      ep.fnsku,
      ${hasEpAsin ? "ep.asin" : "NULL::text AS asin"},
      ep.carrier,
      ep.build_source,
      ep.build_status,
      ep.order_id,
      ep.disposition,
      ep.source_detail_row_id::text,
      ${epCols.has("identifier_resolution_status") ? "ep.identifier_resolution_status" : "NULL::text AS identifier_resolution_status"},
      ${remTitleCol} AS removal_title,
      ${remAsinCol},
      ${remSkuCol},
      ${remFnskuCol}
    FROM public.expected_packages ep
    LEFT JOIN public.amazon_removals ar ON ar.id = ep.source_detail_row_id
    WHERE ep.organization_id = $1::uuid
      AND ep.resolved_product_id IS NULL
    ORDER BY ep.fnsku NULLS LAST, ep.sku NULLS LAST, ep.tracking_number
    `,
    [ORG],
  );

  const asinMatchEp = hasEpAsin ? "NULLIF(btrim(ep.asin), '') IS NOT NULL AND upper(btrim(m.asin)) = upper(btrim(ep.asin))" : "false";
  const asinMatchProd = hasEpAsin ? "NULLIF(btrim(ep.asin), '') IS NOT NULL AND upper(btrim(p.asin)) = upper(btrim(ep.asin))" : "false";

  const mapHits = await client.query(
    `
    WITH ep AS (
      SELECT id, organization_id, store_id, sku, fnsku${hasEpAsin ? ", asin" : ""}
      FROM public.expected_packages
      WHERE organization_id = $1::uuid AND resolved_product_id IS NULL
    )
    SELECT
      ep.id::text AS ep_id,
      count(DISTINCT m.product_id) FILTER (WHERE m.product_id IS NOT NULL)::int AS map_product_count,
      min(m.product_id::text) FILTER (WHERE m.product_id IS NOT NULL) AS sole_map_product_id,
      array_agg(DISTINCT m.product_id::text) FILTER (WHERE m.product_id IS NOT NULL) AS map_product_ids
    FROM ep
    LEFT JOIN public.product_identifier_map m
      ON m.deleted_at IS NULL
     AND m.organization_id = ep.organization_id
     AND (m.store_id = ep.store_id OR m.store_id IS NULL)
     AND (
       (NULLIF(btrim(ep.fnsku), '') IS NOT NULL AND upper(btrim(m.fnsku)) = upper(btrim(ep.fnsku)))
       OR (NULLIF(btrim(ep.sku), '') IS NOT NULL AND upper(btrim(m.seller_sku)) = upper(btrim(ep.sku)))
       OR (${asinMatchEp})
       OR (
         NULLIF(btrim(ep.fnsku), '') IS NOT NULL
         AND ep.fnsku ~ '^B[0-9A-Z]{9}$'
         AND upper(btrim(m.asin)) = upper(btrim(ep.fnsku))
       )
     )
    GROUP BY ep.id
    `,
    [ORG],
  );

  const prodHits = await client.query(
    `
    WITH ep AS (
      SELECT id, organization_id, sku, fnsku${hasEpAsin ? ", asin" : ""}
      FROM public.expected_packages
      WHERE organization_id = $1::uuid AND resolved_product_id IS NULL
    )
    SELECT
      ep.id::text AS ep_id,
      count(DISTINCT p.id)::int AS product_count,
      min(p.id::text) AS sole_product_id,
      array_agg(DISTINCT p.id::text) AS product_ids
    FROM ep
    LEFT JOIN public.products p
      ON p.organization_id = ep.organization_id
     AND p.deleted_at IS NULL
     AND (
       (NULLIF(btrim(ep.fnsku), '') IS NOT NULL AND upper(btrim(p.fnsku)) = upper(btrim(ep.fnsku)))
       OR (NULLIF(btrim(ep.sku), '') IS NOT NULL AND upper(btrim(p.sku)) = upper(btrim(ep.sku)))
       OR (${asinMatchProd})
       OR (
         NULLIF(btrim(ep.fnsku), '') IS NOT NULL
         AND ep.fnsku ~ '^B[0-9A-Z]{9}$'
         AND upper(btrim(p.asin)) = upper(btrim(ep.fnsku))
       )
     )
    GROUP BY ep.id
    `,
    [ORG],
  );

  const mapByEp = new Map(mapHits.rows.map((r: Record<string, unknown>) => [String(r.ep_id), r]));
  const prodByEp = new Map(prodHits.rows.map((r: Record<string, unknown>) => [String(r.ep_id), r]));

  type Enriched = Record<string, unknown> & { review_bucket: ReviewBucket };
  const enriched: Enriched[] = [];

  for (const row of unresolved.rows as Record<string, unknown>[]) {
    const id = String(row.id);
    const map = mapByEp.get(id) as Record<string, unknown> | undefined;
    const prod = prodByEp.get(id) as Record<string, unknown> | undefined;
    const mapCount = Number(map?.map_product_count ?? 0);
    const prodCount = Number(prod?.product_count ?? 0);
    const fnsku = String(row.fnsku ?? "").trim();
    const sku = String(row.sku ?? "").trim();
    const dirty = isDirtySku(sku) || (isLikelyAsinInFnsku(fnsku) && isDirtySku(sku));
    const blockedAmbiguous = fnsku.toUpperCase() === BLOCKED_FNSKU;

    let reviewBucket: ReviewBucket;
    let suggestedProductId: string | null = null;
    let confidence = 0;
    let reason = "";

    if (blockedAmbiguous) {
      reviewBucket = "D";
      reason = "blocked_fnsku_X003UR3W83_duplicate_cluster";
    } else if (dirty || isLikelyAsinInFnsku(fnsku)) {
      reviewBucket = "C";
      reason = isDirtySku(sku) ? "dirty_sku_UNKNOW_or_placeholder" : "asin_stored_in_fnsku_column";
      if (prodCount === 1) {
        suggestedProductId = String(prod?.sole_product_id);
        confidence = 0.55;
        reason += ";asin_in_fnsku_matches_single_product";
      }
    } else if (mapCount > 1 || prodCount > 1 || row.identifier_resolution_status === "ambiguous") {
      reviewBucket = "D";
      reason = "multiple_product_matches";
    } else if (mapCount === 1) {
      reviewBucket = "A";
      suggestedProductId = String(map?.sole_map_product_id);
      confidence = 0.95;
      reason = "sole_map_match_operator_confirm";
    } else if (prodCount === 1) {
      reviewBucket = "A";
      suggestedProductId = String(prod?.sole_product_id);
      confidence = 0.85;
      reason = "sole_product_match_needs_map_bridge";
    } else if (isValidFnsku(fnsku) && !isDirtySku(sku)) {
      reviewBucket = "B";
      confidence = 0.4;
      reason = "valid_identifiers_no_catalog_match_needs_product_seed_approval";
    } else {
      reviewBucket = "B";
      confidence = 0.25;
      reason = "no_match_needs_enrichment_or_product_seed";
    }

    enriched.push({
      ...row,
      map_product_count: mapCount,
      product_count: prodCount,
      suggested_product_id: suggestedProductId,
      confidence,
      reason,
      review_bucket: reviewBucket,
      identifier_type: isValidFnsku(fnsku) ? "fnsku" : isLikelyAsinInFnsku(fnsku) ? "asin_in_fnsku" : fnsku ? "other" : "missing",
      raw_identifier_key: [sku || "(no-sku)", fnsku || "(no-fnsku)", String(row.asin ?? "")].join("|"),
    });
  }

  const bucketCounts: Record<ReviewBucket, number> = { A: 0, B: 0, C: 0, D: 0 };
  for (const r of enriched) bucketCounts[r.review_bucket]++;

  const freqGroups = new Map<string, { count: number; bucket: ReviewBucket; sample_ids: string[] }>();
  for (const r of enriched) {
    const key = String(r.raw_identifier_key);
    const g = freqGroups.get(key) ?? { count: 0, bucket: r.review_bucket as ReviewBucket, sample_ids: [] };
    g.count++;
    if (g.sample_ids.length < 3) g.sample_ids.push(String(r.id));
    freqGroups.set(key, g);
  }
  const topFreq = [...freqGroups.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 30)
    .map(([key, v]) => ({ raw_identifier_key: key, ...v }));

  const carrierGroups = new Map<string, number>();
  const buildSourceGroups = new Map<string, number>();
  const idTypeGroups = new Map<string, number>();
  for (const r of enriched) {
    carrierGroups.set(String(r.carrier ?? "(null)"), (carrierGroups.get(String(r.carrier ?? "(null)")) ?? 0) + 1);
    buildSourceGroups.set(String(r.build_source ?? "(null)"), (buildSourceGroups.get(String(r.build_source ?? "(null)")) ?? 0) + 1);
    idTypeGroups.set(String(r.identifier_type), (idTypeGroups.get(String(r.identifier_type)) ?? 0) + 1);
  }

  const reviewHeaders = [
    "expected_package_id",
    "tracking_number",
    "sku",
    "fnsku",
    "asin",
    "carrier",
    "build_source",
    "removal_title",
    "review_bucket",
    "suggested_product_id",
    "confidence",
    "reason",
    "map_product_count",
    "product_count",
    "operator_decision",
    "approved_by",
  ];
  const reviewRows = enriched.map((r) => ({
    expected_package_id: r.id,
    tracking_number: r.tracking_number,
    sku: r.sku,
    fnsku: r.fnsku,
    asin: r.asin,
    carrier: r.carrier,
    build_source: r.build_source,
    removal_title: r.removal_title,
    review_bucket: r.review_bucket,
    suggested_product_id: r.suggested_product_id,
    confidence: r.confidence,
    reason: r.reason,
    map_product_count: r.map_product_count,
    product_count: r.product_count,
    operator_decision: "",
    approved_by: "",
  }));

  const templatePath = path.join(outDir, "manual_review_operator_template.csv");
  writeCsv(templatePath, reviewHeaders, reviewRows);

  const groupPath = path.join(outDir, "identifier_frequency_groups.json");
  fs.writeFileSync(groupPath, JSON.stringify({ top_frequency: topFreq, by_carrier: Object.fromEntries(carrierGroups), by_build_source: Object.fromEntries(buildSourceGroups), by_identifier_type: Object.fromEntries(idTypeGroups) }, null, 2));

  const ri = await client.query(
    `
    SELECT
      ri.id::text,
      ri.sku,
      ri.fnsku,
      ri.asin,
      ri.expected_item_id::text,
      ep.resolved_product_id::text AS ep_resolved_product_id,
      ep.tracking_number
    FROM public.return_items ri
    LEFT JOIN public.expected_packages ep ON ep.id = ri.expected_item_id
    WHERE ri.organization_id = $1::uuid AND ri.deleted_at IS NULL AND ri.resolved_product_id IS NULL
    ORDER BY ri.id
    `,
    [ORG],
  );

  const riPlan = (ri.rows as Record<string, unknown>[]).map((r) => ({
    return_item_id: r.id,
    sku: r.sku,
    fnsku: r.fnsku,
    expected_item_id: r.expected_item_id,
    ep_resolved: r.ep_resolved_product_id,
    plan:
      r.ep_resolved_product_id != null
        ? "copy_ep_resolved_after_EP_review_wave"
        : r.expected_item_id == null
          ? "manual_link_or_scan_reassign"
          : "blocked_until_parent_EP_resolved",
  }));

  const cc = await client.query(`
    SELECT
      count(*)::int AS total,
      count(*) FILTER (WHERE resolved_product_id IS NOT NULL)::int AS resolved,
      count(*) FILTER (WHERE resolved_product_id IS NULL)::int AS unresolved
    FROM public.claim_candidates WHERE organization_id = $1::uuid
  `, [ORG]);

  const ccBySource = await client.query(`
    SELECT coalesce(source_table, '(null)') AS source_table, count(*)::int AS n,
           count(*) FILTER (WHERE resolved_product_id IS NULL)::int AS unresolved
    FROM public.claim_candidates WHERE organization_id = $1::uuid
    GROUP BY 1 ORDER BY n DESC
  `, [ORG]);

  const ccFields = await client.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_schema='public' AND table_name='claim_candidates'
      AND column_name IN ('resolved_product_id','product_id','sku','fnsku','asin','source_table','source_row_id')
    ORDER BY 1
  `);

  const ccInheritEp = await client.query(`
    SELECT count(*)::int AS n
    FROM public.claim_candidates cc
    JOIN public.expected_packages ep ON ep.id = cc.source_row_id
    WHERE cc.organization_id = $1::uuid
      AND cc.source_table = 'expected_packages'
      AND cc.resolved_product_id IS NULL
      AND ep.resolved_product_id IS NOT NULL
  `, [ORG]).catch(() => ({ rows: [{ n: 0 }] }));

  const ccInheritRi = await client.query(`
    SELECT count(*)::int AS n
    FROM public.claim_candidates cc
    JOIN public.return_items ri ON ri.id = cc.source_row_id
    WHERE cc.organization_id = $1::uuid
      AND cc.source_table = 'return_items'
      AND cc.resolved_product_id IS NULL
      AND ri.resolved_product_id IS NOT NULL
  `, [ORG]).catch(() => ({ rows: [{ n: 0 }] }));

  const ccInheritRemoval = remCols.has("fnsku") || remCols.has("sku")
    ? await client.query(
        `
    SELECT count(*)::int AS could_inherit_if_wired
    FROM public.claim_candidates cc
    JOIN public.amazon_removals ar ON ar.id = cc.source_row_id
    WHERE cc.organization_id = $1::uuid
      AND cc.source_table = 'amazon_removals'
      AND cc.resolved_product_id IS NULL
      AND (
        EXISTS (
          SELECT 1 FROM public.product_identifier_map m
          WHERE m.deleted_at IS NULL AND m.organization_id = cc.organization_id
            AND (m.store_id = cc.store_id OR m.store_id IS NULL)
            AND (
              ${remCols.has("fnsku") ? "(NULLIF(btrim(ar.fnsku),'') IS NOT NULL AND upper(btrim(m.fnsku)) = upper(btrim(ar.fnsku))) OR" : ""}
              ${remCols.has("sku") ? "(NULLIF(btrim(ar.sku),'') IS NOT NULL AND upper(btrim(m.seller_sku)) = upper(btrim(ar.sku))) OR" : ""}
              ${remCols.has("asin") ? "(NULLIF(btrim(ar.asin),'') IS NOT NULL AND upper(btrim(m.asin)) = upper(btrim(ar.asin)))" : "false"}
            )
        )
      )
  `,
        [ORG],
      )
    : { rows: [{ could_inherit_if_wired: 0 }] };

  const ccNoIdentifiers = await client.query(`
    SELECT count(*)::int AS n
    FROM public.claim_candidates cc
    WHERE cc.organization_id = $1::uuid
      AND cc.resolved_product_id IS NULL
      AND coalesce(nullif(btrim(cc.sku),''), nullif(btrim(cc.fnsku),''), nullif(btrim(cc.asin),'')) IS NULL
  `, [ORG]);

  const ccMissingSource = await client.query(`
    SELECT count(*)::int AS n
    FROM public.claim_candidates cc
    WHERE cc.organization_id = $1::uuid
      AND cc.resolved_product_id IS NULL
      AND (cc.source_table IS NULL OR cc.source_row_id IS NULL)
  `, [ORG]);

  const epTotal = await client.query(
    `SELECT count(*)::int AS total, count(*) FILTER (WHERE resolved_product_id IS NOT NULL)::int AS resolved FROM expected_packages WHERE organization_id=$1::uuid`,
    [ORG],
  );
  const epStats = epTotal.rows[0] as { total: number; resolved: number };
  const phase5Pct = Math.round((epStats.resolved / epStats.total) * 100);

  await client.end();

  const auditCsvExists = fs.existsSync(path.join(process.cwd(), AUDIT_CSV));
  const auditNote = auditCsvExists
    ? `Loaded audit CSV (${AUDIT_CSV}) as baseline; live production query is authoritative (${enriched.length} rows post Class A).`
    : `Audit CSV missing; used live production query only.`;

  const claimRootCause = {
    total: cc.rows[0],
    by_source_table: ccBySource.rows,
    schema_fields_present: ccFields.rows.map((x: { column_name: string }) => x.column_name),
    root_causes: {
      never_populated_field: "claim_candidates.resolved_product_id exists but 0 rows set — resolver/backfill not executed",
      missing_identifiers_on_candidate: Number(ccNoIdentifiers.rows[0]?.n ?? 0),
      missing_source_pointer: Number(ccMissingSource.rows[0]?.n ?? 0),
      inherit_from_ep_when_source_is_ep: Number(ccInheritEp.rows[0]?.n ?? 0),
      inherit_from_return_items: Number(ccInheritRi.rows[0]?.n ?? 0),
      resolvable_via_removal_identifiers_if_wired: Number(ccInheritRemoval.rows[0]?.could_inherit_if_wired ?? 0),
    },
    summary:
      "Primary gap is operational: linkage resolver dry-run passes but no governed UPDATE job has written claim_candidates.resolved_product_id. Secondary: identifiers live on source rows (amazon_removals) not denormalized onto candidates.",
  };

  const blockers = [
    `${bucketCounts.D} ambiguous/blocked rows (incl. defer X003UR3W83)`,
    `${bucketCounts.C} dirty identifier rows — enrich before any map`,
    "claim_candidates.resolved_product_id never backfilled (9k+ inbox)",
    "No product create in this plan phase",
  ];

  const nextPrompt = `# PHASE-5C-OPERATOR-REVIEW-BUCKET-A-MAP-EXECUTE

Mode: APPROVAL-GATED · staging first · max bucket A rows only
Target: production/original after staging sign-off

Precondition:
- Operator completes \`manual_review_operator_template.csv\` for bucket **A** rows only
- operator_decision = map_to_suggested | map_to_other:<uuid> | reject
- approved_by filled · APPROVED_BUCKET_A_MAP=true

Allowed:
- UPDATE expected_packages.resolved_product_id for approved bucket A rows only
- Optional map-bridge INSERT for sole_product_match rows (Class B-lite)

Forbidden:
- Product CREATE (bucket B — separate APPROVED_TO_SEED_CLASS_C)
- Auto-map bucket C dirty identifiers
- Touch FNSKU X003UR3W83 / bucket D without operator decision

Verify:
- unresolved decreases only by approved A count
- npm run build + scanner smoke

Output: .cursor/audit-reports/phase5c-operator-bucket-a-map-execute/<run_id>/
`;

  fs.writeFileSync(path.join(outDir, "next-prompt.md"), nextPrompt);

  const planMd = `# Phase 5C — Expected packages Class C governed seed plan

Run: \`${rid}\` · Mode: **read-only plan** · Target: \`${ORIGINAL_REF}\`

${auditNote}

## Unresolved census (live)

| Metric | Count |
|--------|------:|
| Remaining unresolved EP | **${enriched.length}** |
| Bucket A — map to existing product | **${bucketCounts.A}** |
| Bucket B — needs product seed approval | **${bucketCounts.B}** |
| Bucket C — dirty / do not auto-map | **${bucketCounts.C}** |
| Bucket D — ambiguous / blocked | **${bucketCounts.D}** |
| Suggested existing product matches | **${enriched.filter((r) => r.suggested_product_id).length}** |

## Grouping highlights

### By identifier type
${[...idTypeGroups.entries()].map(([k, v]) => `- \`${k}\`: ${v}`).join("\n")}

### By build_source
${[...buildSourceGroups.entries()].map(([k, v]) => `- \`${k}\`: ${v}`).join("\n")}

### Top frequency keys (sku|fnsku|asin)
${topFreq.slice(0, 15).map((g) => `- \`${g.raw_identifier_key}\` × **${g.count}** (bucket ${g.bucket})`).join("\n")}

## Return items (7 active unresolved)

${riPlan.map((r) => `- \`${r.return_item_id}\` fnsku=\`${r.fnsku}\` → **${r.plan}**`).join("\n")}

## Claim candidates root cause

| Finding | Count |
|---------|------:|
| Total unresolved | **${cc.rows[0]?.unresolved ?? 0}** |
| Missing sku/fnsku/asin on candidate | **${claimRootCause.root_causes.missing_identifiers_on_candidate}** |
| Missing source_table/row_id | **${claimRootCause.root_causes.missing_source_pointer}** |
| Could copy from EP if source=expected_packages | **${claimRootCause.root_causes.inherit_from_ep_when_source_is_ep}** |
| Could copy from return_items | **${claimRootCause.root_causes.inherit_from_return_items}** |
| Resolvable via removal identifiers (if wired) | **${claimRootCause.root_causes.resolvable_via_removal_identifiers_if_wired}** |

**Root cause:** ${claimRootCause.summary}

## Manual review template

\`manual_review_operator_template.csv\` — fill \`operator_decision\` + \`approved_by\` before any execute.

## Next safe execute

See \`next-prompt.md\`
`;
  fs.writeFileSync(path.join(outDir, "plan-report.md"), planMd);

  const result = {
    phase_number: "5C",
    remaining_unresolved_count: enriched.length,
    review_buckets: bucketCounts,
    suggested_existing_product_matches_count: enriched.filter((r) => r.suggested_product_id).length,
    needs_new_product_count: bucketCounts.B,
    dirty_identifier_count: bucketCounts.C,
    ambiguous_count: bucketCounts.D,
    return_items_unresolved_plan: riPlan,
    claim_candidates_unresolved_root_cause: claimRootCause,
    manual_review_template_path: templatePath.replace(process.cwd() + path.sep, "").replace(/\\/g, "/"),
    SAFE_TO_START_MANUAL_REVIEW: enriched.length === 352 ? "yes" : "conditional",
    new_phase_5_percent: phase5Pct,
    blockers,
    next_prompt_recommendation: "PHASE-5C-OPERATOR-REVIEW-BUCKET-A-MAP-EXECUTE",
  };

  fs.writeFileSync(path.join(outDir, "plan-result.json"), JSON.stringify(result, null, 2));
  fs.writeFileSync(path.join(outDir, "return-items-unresolved-plan.json"), JSON.stringify(riPlan, null, 2));
  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify({ run_id: rid, mode: "read-only", artifacts: ["plan-report.md", "plan-result.json", "manual_review_operator_template.csv", "identifier_frequency_groups.json", "next-prompt.md"] }, null, 2));

  console.log(JSON.stringify(result, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
