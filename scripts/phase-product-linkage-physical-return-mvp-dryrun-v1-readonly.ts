/**
 * PHASE-PRODUCT-LINKAGE-PHYSICAL-RETURN-MVP-DRYRUN-V1 (read-only)
 *
 *   npx tsx scripts/phase-product-linkage-physical-return-mvp-dryrun-v1-readonly.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";

import {
  pickBestProductIdentifierMatch,
  type ProductIdentifierMapRow,
} from "../lib/product-identifier-match";
import { getStagingProjectRef, loadEnvLocalIntoProcess } from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const FALLBACK_ORG = "00000000-0000-0000-0000-000000000001";
const OUT_BASE = ".cursor/audit-reports/phase-product-linkage-physical-return-mvp-dryrun-v1";
const PILOT_MAX = 25;

type Row = Record<string, unknown>;

function runId(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(
    d.getUTCHours(),
  )}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function str(v: unknown): string | null {
  const s = String(v ?? "").trim();
  return s || null;
}

async function connectPg(): Promise<pg.Client> {
  const url =
    process.env.STAGING_DIRECT_POSTGRES_URL?.trim() ||
    process.env.DIRECT_POSTGRES_URL?.trim() ||
    "";
  if (!url) throw new Error("STAGING_DIRECT_POSTGRES_URL unset");
  if (!url.includes(STAGING_REF)) {
    throw new Error(`BLOCKED: postgres URL must target staging ref ${STAGING_REF}`);
  }
  const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await c.connect();
  await c.query("SET statement_timeout = '300s'");
  await c.query("SET default_transaction_read_only = on");
  return c;
}

async function detectSmokeOrg(c: pg.Client): Promise<string> {
  const r = await c.query(
    `SELECT organization_id::text AS org, COUNT(*)::int AS n
     FROM public.claim_candidates
     WHERE source_kind <> 'legacy_seed'
       AND source_table = 'return_items'
       AND (
         (source_kind = 'scanner_physical_review'
          AND claim_family IN ('physical_return_issue', 'physical_return_off_manifest'))
         OR (source_kind = 'orbit_fra'
             AND claim_family IN ('physical_return_off_manifest', 'physical_return_damaged'))
       )
     GROUP BY 1 ORDER BY n DESC LIMIT 1`,
  );
  return str((r.rows[0] as Row | undefined)?.org) ?? FALLBACK_ORG;
}

async function fetchMapRows(
  c: pg.Client,
  orgId: string,
  storeId: string,
  hints: { fnsku?: string | null; asin?: string | null; msku?: string | null; upc?: string | null },
): Promise<ProductIdentifierMapRow[]> {
  const collected: ProductIdentifierMapRow[] = [];
  const seen = new Set<string>();
  const push = (rows: Row[]) => {
    for (const r of rows) {
      const id = str(r.id);
      if (!id || seen.has(id) || r.deleted_at != null) continue;
      seen.add(id);
      collected.push(r as unknown as ProductIdentifierMapRow);
    }
  };

  const base = `SELECT id, organization_id, product_id, catalog_product_id, store_id,
    seller_sku, asin, fnsku, msku, upc_code, deleted_at, title, match_source, confidence_score
    FROM public.product_identifier_map
    WHERE organization_id = $1::uuid AND store_id = $2::uuid AND deleted_at IS NULL`;

  if (hints.fnsku) {
    push(
      (
        await c.query(`${base} AND UPPER(BTRIM(fnsku)) = UPPER(BTRIM($3::text)) LIMIT 120`, [
          orgId,
          storeId,
          hints.fnsku,
        ])
      ).rows as Row[],
    );
  }
  if (hints.asin) {
    push(
      (
        await c.query(`${base} AND UPPER(BTRIM(asin)) = UPPER(BTRIM($3::text)) LIMIT 120`, [
          orgId,
          storeId,
          hints.asin,
        ])
      ).rows as Row[],
    );
  }
  const sku = hints.msku;
  if (sku) {
    push(
      (
        await c.query(
          `${base} AND (UPPER(BTRIM(seller_sku)) = UPPER(BTRIM($3::text)) OR UPPER(BTRIM(msku)) = UPPER(BTRIM($3::text))) LIMIT 200`,
          [orgId, storeId, sku],
        )
      ).rows as Row[],
    );
  }
  if (hints.upc) {
    push(
      (
        await c.query(`${base} AND BTRIM(upc_code) = BTRIM($3::text) LIMIT 120`, [orgId, storeId, hints.upc])
      ).rows as Row[],
    );
  }
  return collected;
}

async function loadPimBlocked(c: pg.Client): Promise<Set<string>> {
  const set = new Set<string>();
  const r = await c.query(
    `SELECT members FROM public.pim_identifier_dispute WHERE status = 'open' LIMIT 5000`,
  );
  for (const row of r.rows as Row[]) {
    if (Array.isArray(row.members)) {
      for (const m of row.members) {
        const s = str(m);
        if (s) set.add(s);
      }
    }
  }
  return set;
}

async function productPriceContext(c: pg.Client, productId: string | null): Promise<Record<string, unknown>> {
  if (!productId) return { available: false };
  const cols = await c.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema='public' AND table_name='product_prices'`,
  );
  const names = new Set(cols.rows.map((x: { column_name: string }) => x.column_name));
  if (!names.has("product_id")) return { available: false, reason: "no product_id column" };
  const priceCol = ["sale_price", "price", "unit_price", "list_price", "cost_price"].find((x) => names.has(x));
  const r = await c.query(
    `SELECT COUNT(*)::int AS n${
      priceCol ? `, MAX(${priceCol})::numeric AS max_price, MIN(${priceCol})::numeric AS min_price` : ""
    }
     FROM public.product_prices WHERE product_id = $1::uuid`,
    [productId],
  );
  const row = r.rows[0] as Row;
  return {
    available: Number(row.n ?? 0) > 0,
    row_count: Number(row.n ?? 0),
    price_column: priceCol ?? null,
    max_price: row.max_price ?? null,
    min_price: row.min_price ?? null,
  };
}

async function productCostContext(c: pg.Client, productId: string | null): Promise<Record<string, unknown>> {
  if (!productId) return { available: false };
  const cols = await c.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema='public' AND table_name='products'`,
  );
  const names = new Set(cols.rows.map((x: { column_name: string }) => x.column_name));
  const costCol = ["cost_price", "cost", "unit_cost", "cogs", "purchase_price"].find((x) => names.has(x));
  if (!costCol) return { available: false, reason: "no cost column on products" };
  const r = await c.query(`SELECT ${costCol}::numeric AS v FROM public.products WHERE id = $1::uuid`, [productId]);
  const v = (r.rows[0] as Row | undefined)?.v;
  return { available: v != null, column: costCol, value: v ?? null };
}

async function catalogContext(
  c: pg.Client,
  orgId: string,
  hints: { asin?: string | null; sku?: string | null },
): Promise<Record<string, unknown>> {
  const asin = hints.asin;
  const sku = hints.sku;
  if (!asin && !sku) return { hits: 0 };
  const parts: string[] = [];
  const params: unknown[] = [orgId];
  if (asin) {
    params.push(asin);
    parts.push(`UPPER(BTRIM(asin)) = UPPER(BTRIM($${params.length}::text))`);
  }
  if (sku) {
    params.push(sku);
    parts.push(`UPPER(BTRIM(seller_sku)) = UPPER(BTRIM($${params.length}::text))`);
  }
  const r = await c.query(
    `SELECT COUNT(*)::int AS n FROM public.catalog_products
     WHERE organization_id = $1::uuid AND (${parts.join(" OR ")})`,
    params,
  );
  return { hits: Number((r.rows[0] as Row).n ?? 0), asin, sku };
}

function tierLabel(tier: number | null): string {
  if (tier === 1) return "fnsku_exact";
  if (tier === 2) return "asin_exact";
  if (tier === 3) return "sku_msku_exact";
  if (tier === 4) return "upc_ean_exact";
  return "none";
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const run = runId();
  const outDir = path.join(process.cwd(), OUT_BASE, run);
  fs.mkdirSync(outDir, { recursive: true });

  if (getStagingProjectRef() !== STAGING_REF) {
    throw new Error(`BLOCKED: expected staging ref ${STAGING_REF}`);
  }

  const c = await connectPg();
  const orgId = await detectSmokeOrg(c);
  const pimBlocked = await loadPimBlocked(c);

  const pool = await c.query(
    `SELECT cc.*
     FROM public.claim_candidates cc
     WHERE cc.organization_id = $1::uuid
       AND cc.quarantined_at IS NULL AND cc.rejected_at IS NULL
       AND cc.source_kind <> 'legacy_seed'
       AND cc.source_table = 'return_items'
       AND (
         (cc.source_kind = 'scanner_physical_review'
          AND cc.claim_family IN ('physical_return_issue', 'physical_return_off_manifest'))
         OR (cc.source_kind = 'orbit_fra'
             AND cc.claim_family IN ('physical_return_off_manifest', 'physical_return_damaged'))
       )
     ORDER BY cc.created_at DESC`,
    [orgId],
  );
  const candidates = pool.rows as Row[];

  const ccCols = await c.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema='public' AND table_name='claim_candidates'`,
  );
  const ccColSet = new Set(ccCols.rows.map((x: { column_name: string }) => x.column_name));

  const identifierInventory: Record<string, unknown>[] = [];
  const existingMappingStatus: Record<string, unknown>[] = [];
  const deterministicMatches: Record<string, unknown>[] = [];
  const conflicts: Record<string, unknown>[] = [];
  const proposedLinkageRows: Record<string, unknown>[] = [];
  const missingRequirements: Record<string, unknown>[] = [];
  const perCandidate: Record<string, unknown>[] = [];

  for (const cc of candidates) {
    const claimCandidateId = str(cc.id)!;
    const sourceRowId = str(cc.source_row_id);
    const storeId = str(cc.store_id);
    const org = str(cc.organization_id) ?? orgId;

    const ri = sourceRowId
      ? (
          await c.query(
            `SELECT id::text, package_id::text, sku, fnsku, asin, product_identifier, resolved_product_id,
                    product_id, store_id, organization_id
             FROM public.return_items WHERE id = $1::uuid AND deleted_at IS NULL`,
            [sourceRowId],
          )
        ).rows[0] as Row | undefined
      : undefined;

    const sku = str(cc.sku) ?? str(ri?.sku);
    const fnsku = str(cc.fnsku) ?? str(ri?.fnsku);
    const asin = str(cc.asin) ?? str(ri?.asin);
    const msku = (ccColSet.has("msku") ? str(cc.msku) : null) ?? sku;
    const upc =
      (ccColSet.has("upc") ? str(cc.upc) : null) ??
      (ccColSet.has("upc_code") ? str(cc.upc_code) : null) ??
      str(ri?.product_identifier)?.match(/^\d{8,14}$/)?.[0] ??
      null;
    const packageId = str(cc.package_id) ?? str(ri?.package_id);
    const returnItemId = str(cc.return_item_id) ?? sourceRowId;
    const currentProductId = str(cc.resolved_product_id) ?? str(ri?.resolved_product_id);
    const riProductId = str(ri?.product_id);

    const identifierRow = {
      claim_candidate_id: claimCandidateId,
      source_kind: cc.source_kind,
      claim_family: cc.claim_family,
      return_item_id: returnItemId,
      package_id: packageId,
      sku,
      fnsku,
      asin,
      msku,
      upc_ean: upc,
      product_id_current: currentProductId,
      catalog_product_id:
        (ccColSet.has("resolved_catalog_product_id") ? str(cc.resolved_catalog_product_id) : null) ??
        (ccColSet.has("catalog_product_id") ? str(cc.catalog_product_id) : null),
      store_id: storeId,
      organization_id: org,
      return_item_resolved_product_id: str(ri?.resolved_product_id),
      return_item_product_id: riProductId,
    };
    identifierInventory.push(identifierRow);

    const mapRows =
      storeId && (fnsku || asin || msku || upc)
        ? await fetchMapRows(c, org, storeId, { fnsku, asin, msku, upc })
        : [];

    const match =
      storeId && mapRows.length
        ? pickBestProductIdentifierMatch(mapRows, {
            organizationId: org,
            storeId,
            fnsku,
            msku,
            asin,
            upc,
          })
        : {
            row: null,
            status: "unresolved" as const,
            tier: null,
            confidence: 0,
            candidatesConsidered: mapRows.length,
          };

    const distinctProducts = new Set(
      mapRows.map((r) => str(r.product_id)).filter(Boolean) as string[],
    );
    const isConflict = match.status === "ambiguous" || distinctProducts.size > 1;
    const proposedProductId =
      match.status === "resolved" && match.row?.product_id ? str(match.row.product_id) : null;
    const deterministic = match.status === "resolved" && !isConflict && proposedProductId != null;
    const pimBlock = !!(proposedProductId && pimBlocked.has(proposedProductId));
    const alreadyLinked = !!currentProductId;
    const linkageAligned =
      !currentProductId || !proposedProductId || currentProductId === proposedProductId;

    const priceCtx = await productPriceContext(c, proposedProductId ?? currentProductId);
    const costCtx = await productCostContext(c, proposedProductId ?? currentProductId);
    const catalogCtx = await catalogContext(c, org, { asin, sku });

    const missing: string[] = [];
    if (!storeId) missing.push("store_id");
    if (!fnsku && !asin && !msku && !upc) missing.push("trusted_identifier (fnsku/asin/sku/upc)");
    if (match.status === "unresolved" && !currentProductId) missing.push("product_identifier_map match");
    if (isConflict) missing.push("resolve identifier conflict before apply");
    if (pimBlock) missing.push("PIM open dispute blocks proposed product");

    const safeApply =
      deterministic &&
      !pimBlock &&
      linkageAligned &&
      (!currentProductId || currentProductId !== proposedProductId);

    const record = {
      claim_candidate_id: claimCandidateId,
      source_kind: cc.source_kind,
      claim_family: cc.claim_family,
      identifiers: identifierRow,
      current_linkage_status: alreadyLinked
        ? linkageAligned
          ? "resolved_aligned"
          : currentProductId !== proposedProductId
            ? "resolved_mismatch_with_map"
            : "resolved"
        : "unresolved",
      current_resolved_product_id: currentProductId,
      deterministic_match: deterministic,
      conflict: isConflict,
      proposed_product_id: safeApply ? proposedProductId : deterministic ? proposedProductId : null,
      confidence_score: match.confidence,
      match_source: tierLabel(match.tier),
      map_hits: mapRows.length,
      distinct_product_ids_in_map: distinctProducts.size,
      missing_data: missing,
      pim_blocked: pimBlock,
      product_price_context: priceCtx,
      product_cost_context: costCtx,
      catalog_products_hits: catalogCtx.hits,
      product_story_impact: alreadyLinked
        ? "Product Story identity block available"
        : deterministic
          ? "Would unlock Product Story identity + spine edges"
          : "Product Story blocked — no product spine",
      claim_center_impact: alreadyLinked
        ? costCtx.available || (priceCtx.available as boolean)
          ? "Money lane can compute recovery"
          : "Product linked but cost/price may still show UNPRICED"
        : deterministic
          ? "Would clear 'Product not matched' badge"
          : "Find Money / Review blocked on product linkage",
      trid_edge_impact: alreadyLinked
        ? "product_link edge can materialize"
        : deterministic
          ? "Would enable product_spine TRID edge"
          : "product_link edge missing — TRID graph incomplete",
      money_impact: alreadyLinked || deterministic
        ? costCtx.available || (priceCtx.available as boolean)
          ? "Recovery estimate possible (COGS/price)"
          : "Linked but cogs_unit/products cost/product_prices still empty"
        : "recovery_value stays null without product_id",
    };
    perCandidate.push(record);

    existingMappingStatus.push({
      claim_candidate_id: claimCandidateId,
      resolved_product_id: currentProductId,
      return_item_resolved_product_id: str(ri?.resolved_product_id),
      map_match_status: match.status,
      aligned: linkageAligned,
    });

    if (deterministic) {
      deterministicMatches.push({
        claim_candidate_id: claimCandidateId,
        proposed_product_id: proposedProductId,
        match_source: tierLabel(match.tier),
        confidence: match.confidence,
      });
    }
    if (isConflict) {
      conflicts.push({
        claim_candidate_id: claimCandidateId,
        identifiers: { fnsku, asin, msku, upc },
        distinct_product_ids: [...distinctProducts],
        map_hits: mapRows.length,
      });
    }
    if (safeApply) {
      proposedLinkageRows.push({
        claim_candidate_id: claimCandidateId,
        field: "resolved_product_id",
        from: currentProductId,
        to: proposedProductId,
        match_source: tierLabel(match.tier),
        confidence: match.confidence,
        also_update_return_item: returnItemId && str(ri?.resolved_product_id) !== proposedProductId,
        return_item_id: returnItemId,
      });
    }
    if (missing.length && !alreadyLinked) {
      missingRequirements.push({
        claim_candidate_id: claimCandidateId,
        missing,
        identifiers_present: { fnsku: !!fnsku, asin: !!asin, sku: !!msku, upc: !!upc },
      });
    }
  }

  await c.end();

  const pilotRows = proposedLinkageRows.slice(0, PILOT_MAX);
  const safeToApply =
    pilotRows.length > 0 &&
    conflicts.length === 0 &&
    pilotRows.every((r) => r.to != null);

  const outputs = {
    candidates_checked: candidates.length,
    smoke_org: orgId,
    identifier_inventory: identifierInventory,
    existing_mapping_status: existingMappingStatus,
    deterministic_matches: deterministicMatches,
    conflicts,
    proposed_linkage_rows_if_safe: pilotRows,
    missing_identifier_requirements: missingRequirements,
    product_price_context_available: perCandidate.filter(
      (p) => (p.product_price_context as Row)?.available === true,
    ).length,
    product_cost_context_available: perCandidate.filter(
      (p) => (p.product_cost_context as Row)?.available === true,
    ).length,
    product_story_impact: perCandidate.map((p) => ({
      claim_candidate_id: p.claim_candidate_id,
      impact: p.product_story_impact,
    })),
    claim_center_impact: perCandidate.map((p) => ({
      claim_candidate_id: p.claim_candidate_id,
      impact: p.claim_center_impact,
    })),
    per_candidate_detail: perCandidate,
    SAFE_TO_APPLY_PRODUCT_LINKAGE_PILOT: safeToApply ? "yes" : "no",
    APPROVAL_REQUIRED_FROM_MAYSAM: "yes",
    NEXT_EXACT_PROMPT: safeToApply
      ? `PHASE-PRODUCT-LINKAGE-PHYSICAL-RETURN-MVP-PILOT-APPLY-V1
Mode: staging apply (governed).
Prerequisites: Maysam approval; max ${Math.min(pilotRows.length, PILOT_MAX)} rows.
Scope: UPDATE claim_candidates.resolved_product_id (+ matching return_items.resolved_product_id where dry-run proposed) for physical-return MVP slice only.
Rules: exact identifier map match only; no product create; no map insert; no title match; rollback SQL required.
Run: npx tsx scripts/phase-product-linkage-physical-return-mvp-pilot-apply-v1.ts --run-id=<UTC> --execute
After: npm run build; Claim Center smoke; append memory.`
      : `PHASE-PRODUCT-LINKAGE-PHYSICAL-RETURN-MVP-IDENTIFIER-REPAIR-V1
Mode: read-only identifier repair plan (no apply).
Blockers: ${conflicts.length} conflict(s); ${missingRequirements.length} missing identifier row(s); ${deterministicMatches.length} deterministic match(es) found.
Scope: enrich return_items / claim_candidates identifiers from scanner capture or EP copy; resolve PIM disputes; then re-run dry-run.`,
  };

  for (const [key, val] of Object.entries(outputs)) {
    if (key === "NEXT_EXACT_PROMPT") {
      fs.writeFileSync(path.join(outDir, `${key}.txt`), String(val));
    } else {
      fs.writeFileSync(path.join(outDir, `${key}.json`), JSON.stringify(val, null, 2));
    }
  }

  const summary = [
    "# PHASE-PRODUCT-LINKAGE-PHYSICAL-RETURN-MVP-DRYRUN-V1",
    "",
    `**Run:** \`${run}\` · **Org:** \`${orgId}\` · **Read-only:** yes`,
    "",
    "| Metric | Count |",
    "|--------|------:|",
    `| Candidates checked | **${candidates.length}** |`,
    `| Already resolved | **${existingMappingStatus.filter((x) => x.resolved_product_id).length}** |`,
    `| Deterministic map matches | **${deterministicMatches.length}** |`,
    `| Conflicts | **${conflicts.length}** |`,
    `| Safe pilot linkage rows | **${pilotRows.length}** |`,
    `| Missing identifiers | **${missingRequirements.length}** |`,
    `| Price context available | **${outputs.product_price_context_available}** |`,
    `| Cost context available | **${outputs.product_cost_context_available}** |`,
    "",
    `- **SAFE_TO_APPLY_PRODUCT_LINKAGE_PILOT:** **${outputs.SAFE_TO_APPLY_PRODUCT_LINKAGE_PILOT}**`,
    `- **APPROVAL_REQUIRED_FROM_MAYSAM:** **yes**`,
    "",
    "## Next prompt",
    "",
    "```text",
    String(outputs.NEXT_EXACT_PROMPT),
    "```",
  ].join("\n");

  fs.writeFileSync(path.join(outDir, "audit-summary.md"), summary);
  fs.writeFileSync(
    path.join(outDir, "manifest.json"),
    JSON.stringify(
      {
        prompt: "PHASE-PRODUCT-LINKAGE-PHYSICAL-RETURN-MVP-DRYRUN-V1",
        run_id: run,
        staging_ref: STAGING_REF,
        read_only: true,
        candidates_checked: candidates.length,
        deterministic_matches: deterministicMatches.length,
        safe_pilot_rows: pilotRows.length,
        safe_to_apply: outputs.SAFE_TO_APPLY_PRODUCT_LINKAGE_PILOT,
      },
      null,
      2,
    ),
  );

  console.log(
    JSON.stringify(
      {
        ok: true,
        outDir,
        candidates: candidates.length,
        deterministic: deterministicMatches.length,
        pilot: pilotRows.length,
        safeToApply: outputs.SAFE_TO_APPLY_PRODUCT_LINKAGE_PILOT,
      },
      null,
      2,
    ),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
