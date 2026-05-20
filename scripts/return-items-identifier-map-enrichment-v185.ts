/**
 * RETURN-ITEMS-IDENTIFIER-MAP-ENRICHMENT-V185 — Plan + optional map-only execute (staging).
 *
 *   npx tsx scripts/return-items-identifier-map-enrichment-v185.ts --run-id=<id>
 *   npx tsx scripts/return-items-identifier-map-enrichment-v185.ts --run-id=<id> --execute
 */
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";

import { getStagingProjectRef, loadEnvLocalIntoProcess, refFromSupabaseUrl } from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const OUT_BASE = ".cursor/audit-reports/return-items-identifier-map-enrichment-v185";
const APPROVAL_PATH = ".cursor/operator-approvals/product-identifier-map-enrichment-v185-approval.md";
const V183_RUN = "20260521T140000Z";

type UnresolvedRow = {
  return_item_id: string;
  organization_id: string;
  store_id: string;
  fbm_class: string;
  fnsku: string | null;
  asin: string | null;
  sku: string | null;
};

type ProductHit = { id: string; sku: string | null; asin: string | null; fnsku: string | null; product_name: string | null };
type MapHit = {
  id: string;
  product_id: string | null;
  seller_sku: string | null;
  asin: string | null;
  fnsku: string | null;
  store_id: string | null;
};

type Classification =
  | "enrichable_from_existing_product"
  | "source_identifier_dirty_or_test"
  | "no_existing_product"
  | "ambiguous_multiple_products"
  | "wrong_org_store_scope";

type ProductSearchResult = { store_scoped: ProductHit[]; org_wide: ProductHit[] };

type RowReview = {
  return_item_id: string;
  organization_id: string;
  store_id: string;
  fbm_class: string;
  identifiers: { fnsku: string | null; asin: string | null; sku: string | null };
  products_hits: Record<string, ProductSearchResult>;
  map_hits: Record<string, MapHit[]>;
  distinct_product_ids_from_products: string[];
  distinct_product_ids_from_map: string[];
  classification: Classification;
  classification_notes: string[];
  enrichment_candidates: EnrichmentCandidate[];
};

type EnrichmentCandidate = {
  return_item_id: string;
  organization_id: string;
  store_id: string;
  product_id: string;
  insert: {
    fnsku: string | null;
    asin: string | null;
    seller_sku: string | null;
    msku: string | null;
  };
  winning_identifier: string;
  rationale: string;
};

function runIdArg(): string {
  const a = process.argv.find((x) => x.startsWith("--run-id="));
  if (a) return a.split("=")[1]!.trim();
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function n(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

function isTestOrg(orgId: string): boolean {
  return orgId === "7397edff-7994-4731-8501-55d258d507d2";
}

function dirtyIdentifierHeuristics(row: UnresolvedRow): { notes: string[]; strongly_test: boolean } {
  const notes: string[] = [];
  const f = n(row.fnsku);
  const a = n(row.asin);
  const s = n(row.sku);
  let strongly_test = false;
  if (f?.match(/^X00X/i)) {
    notes.push("fnsku looks synthetic (X00X prefix)");
    strongly_test = true;
  }
  if (a?.match(/^B0X/i)) {
    notes.push("asin looks synthetic (B0X test prefix)");
    strongly_test = true;
  }
  if (s && /^\d{6,}$/.test(s)) {
    notes.push("sku is numeric-only (likely test/manual entry)");
    strongly_test = true;
  }
  if (isTestOrg(row.organization_id)) {
    notes.push("organization is test3 cohort (7397edff…)");
    strongly_test = true;
  }
  if (f === "X004N9OS4J" && !a && !s) {
    notes.push("fnsku-only test3 scanner pattern");
    strongly_test = true;
  }
  if (s === "X004N9OS4J" && !f && !a) {
    notes.push("sku reused as FNSKU test token on test3 row");
    strongly_test = true;
  }
  if (f === "4324567" && !a && !s) notes.push("fnsku-only numeric token (suspicious)");
  return { notes, strongly_test };
}

async function searchProducts(
  client: pg.Client,
  org: string,
  store: string | null,
  field: "fnsku" | "asin" | "sku",
  value: string,
): Promise<{ store_scoped: ProductHit[]; org_wide: ProductHit[] }> {
  const col = field === "sku" ? "sku" : field;
  const base = `SELECT id::text, sku, asin, fnsku, product_name
           FROM public.products
           WHERE organization_id = $1::uuid AND deleted_at IS NULL AND ${col} = $2`;
  const orgWide = await client.query(`${base} LIMIT 20`, [org, value]);
  let storeScoped: ProductHit[] = [];
  if (store) {
    const r = await client.query(`${base} AND store_id = $3::uuid LIMIT 20`, [org, value, store]);
    storeScoped = r.rows as ProductHit[];
  }
  return { store_scoped: storeScoped, org_wide: orgWide.rows as ProductHit[] };
}

async function searchMap(
  client: pg.Client,
  org: string,
  store: string,
  field: "fnsku" | "asin" | "sku",
  value: string,
): Promise<MapHit[]> {
  let q = `SELECT id::text, product_id::text, seller_sku, asin, fnsku, store_id::text
           FROM public.product_identifier_map
           WHERE organization_id = $1::uuid AND store_id = $2::uuid`;
  const params = [org, store, value];
  if (field === "fnsku") q += ` AND fnsku = $3`;
  else if (field === "asin") q += ` AND asin = $3`;
  else q += ` AND (seller_sku = $3 OR msku = $3)`;
  const hasDeleted = await client.query(
    `SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='product_identifier_map' AND column_name='deleted_at'`,
  );
  if ((hasDeleted.rowCount ?? 0) > 0) q += ` AND deleted_at IS NULL`;
  q += ` LIMIT 20`;
  const r = await client.query(q, params);
  return r.rows as MapHit[];
}

function distinctPids(hits: ProductHit[] | MapHit[]): string[] {
  const s = new Set<string>();
  for (const h of hits) {
    const pid = "product_id" in h ? n((h as MapHit).product_id) : n((h as ProductHit).id);
    if (pid) s.add(pid);
  }
  return [...s];
}

function buildEnrichmentCandidates(
  row: UnresolvedRow,
  productId: string,
  winning: { field: "fnsku" | "asin" | "sku"; value: string },
): EnrichmentCandidate[] {
  const ins = {
    fnsku: n(row.fnsku),
    asin: n(row.asin),
    seller_sku: n(row.sku),
    msku: n(row.sku),
  };
  return [
    {
      return_item_id: row.return_item_id,
      organization_id: row.organization_id,
      store_id: row.store_id,
      product_id: productId,
      insert: ins,
      winning_identifier: `${winning.field}=${winning.value}`,
      rationale: `Single product match; map row missing for ${winning.field}`,
    },
  ];
}

function allProductHitsFromSearch(hits: Record<string, ProductSearchResult>): ProductHit[] {
  const out: ProductHit[] = [];
  for (const v of Object.values(hits)) {
    out.push(...v.store_scoped, ...v.org_wide);
  }
  return out;
}

function classifyRow(
  row: UnresolvedRow,
  productsHits: Record<string, ProductSearchResult>,
  mapHits: Record<string, MapHit[]>,
): RowReview {
  const identifiers = { fnsku: n(row.fnsku), asin: n(row.asin), sku: n(row.sku) };
  const dirty = dirtyIdentifierHeuristics(row);
  const allProductIds = new Set<string>();
  for (const h of allProductHitsFromSearch(productsHits)) {
    if (h.id) allProductIds.add(h.id);
  }
  const allMapPids = new Set<string>();
  for (const hits of Object.values(mapHits)) {
    for (const h of hits) if (h.product_id) allMapPids.add(h.product_id!);
  }

  const notes: string[] = [...dirty];
  let classification: Classification = "no_existing_product";
  let enrichment: EnrichmentCandidate[] = [];

  const hasMapForAny =
    (mapHits.fnsku?.length ?? 0) > 0 || (mapHits.asin?.length ?? 0) > 0 || (mapHits.sku?.length ?? 0) > 0;

  if (dirty.length > 0 && allProductIds.size === 0 && !hasMapForAny) {
    classification = "source_identifier_dirty_or_test";
    notes.push("No product or map match; identifiers appear test/synthetic");
  } else if (allProductIds.size > 1) {
    classification = "ambiguous_multiple_products";
    notes.push(`products table returned ${allProductIds.size} distinct ids`);
  } else if (allProductIds.size === 1) {
    const pid = [...allProductIds][0]!;
    const mapPids = [...allMapPids];
    if (mapPids.length > 1 || (mapPids.length === 1 && mapPids[0] !== pid)) {
      classification = "ambiguous_multiple_products";
      notes.push("map product_id disagrees with products match");
    } else if (hasMapForAny && mapPids[0] === pid) {
      classification = "wrong_org_store_scope";
      notes.push("map exists but return_items resolver still unresolved — investigate map quality");
    } else if (!hasMapForAny) {
      classification = "enrichable_from_existing_product";
      const win = n(row.fnsku)
        ? ({ field: "fnsku" as const, value: row.fnsku! })
        : n(row.asin)
          ? ({ field: "asin" as const, value: row.asin! })
          : ({ field: "sku" as const, value: row.sku! });
      enrichment = buildEnrichmentCandidates(row, pid, win);
      notes.push(`product ${pid.slice(0, 8)}… exists; map missing`);
    }
  } else if (hasMapForAny && allMapPids.length === 1 && allProductIds.size === 0) {
    classification = "no_existing_product";
    notes.push("map row exists but products row missing for matched product_id");
  } else if (hasMapForAny && allMapPids.length > 1) {
    classification = "ambiguous_multiple_products";
    notes.push("multiple map product_ids");
  } else {
    classification = "no_existing_product";
    notes.push("No exact product or map match (store-scoped and org-wide products search)");
  }

  if (isTestOrg(row.organization_id) && classification === "enrichable_from_existing_product") {
    classification = "source_identifier_dirty_or_test";
    enrichment = [];
    notes.push("Downgraded: test3 org — no governed map insert without operator exception");
  }

  return {
    return_item_id: row.return_item_id,
    organization_id: row.organization_id,
    store_id: row.store_id,
    fbm_class: row.fbm_class,
    identifiers,
    products_hits: productsHits,
    map_hits: mapHits,
    distinct_product_ids_from_products: [...allProductIds],
    distinct_product_ids_from_map: [...allMapPids],
    classification,
    classification_notes: notes,
    enrichment_candidates: enrichment,
  };
}

function readApproval(): { approved: boolean; raw: string } {
  const p = path.join(process.cwd(), APPROVAL_PATH);
  if (!fs.existsSync(p)) return { approved: false, raw: "missing" };
  const raw = fs.readFileSync(p, "utf8");
  const approved =
    /APPROVED_TO_RUN_STAGING\s*=\s*true/i.test(raw) &&
    !/APPROVED_TO_RUN_STAGING\s*=\s*false/i.test(raw.replace(/APPROVED_TO_RUN_STAGING\s*=\s*true/gi, ""));
  return { approved: /APPROVED_TO_RUN_STAGING\s*=\s*true/i.test(raw), raw };
}

async function executeEnrichment(
  client: pg.Client,
  candidates: EnrichmentCandidate[],
): Promise<{ applied: number; errors: string[] }> {
  const errors: string[] = [];
  let applied = 0;
  for (const c of candidates) {
    try {
      const exists = await client.query(
        `SELECT id::text FROM public.product_identifier_map
         WHERE organization_id = $1::uuid AND store_id = $2::uuid AND product_id = $3::uuid
           AND COALESCE(fnsku,'') = COALESCE($4,'')
           AND COALESCE(asin,'') = COALESCE($5,'')
           AND COALESCE(seller_sku,'') = COALESCE($6,'')
         LIMIT 1`,
        [
          c.organization_id,
          c.store_id,
          c.product_id,
          c.insert.fnsku,
          c.insert.asin,
          c.insert.seller_sku,
        ],
      );
      if ((exists.rowCount ?? 0) > 0) continue;

      await client.query(
        `INSERT INTO public.product_identifier_map (
           organization_id, store_id, product_id, fnsku, asin, seller_sku, msku,
           match_source, confidence_score, is_primary, created_at, updated_at
         ) VALUES (
           $1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7,
           'return_items_v185_enrichment', 1.0, true, now(), now()
         )`,
        [
          c.organization_id,
          c.store_id,
          c.product_id,
          c.insert.fnsku,
          c.insert.asin,
          c.insert.seller_sku,
          c.insert.msku,
        ],
      );
      applied++;
    } catch (e) {
      errors.push(`${c.return_item_id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { applied, errors };
}

async function main(): Promise<void> {
  const runId = runIdArg();
  const execute = process.argv.includes("--execute");
  const outDir = path.join(process.cwd(), OUT_BASE, runId);
  fs.mkdirSync(outDir, { recursive: true });

  loadEnvLocalIntoProcess();
  const dbUrl = process.env.STAGING_DIRECT_POSTGRES_URL?.trim() || "";
  const ref = refFromSupabaseUrl(process.env.STAGING_SUPABASE_URL ?? "") || refFromSupabaseUrl(dbUrl);
  if (!dbUrl || ref !== STAGING_REF || getStagingProjectRef({ loadEnv: false }) !== STAGING_REF) {
    throw new Error(`Staging guard failed (expected ${STAGING_REF})`);
  }

  const proposalPath = path.join(
    process.cwd(),
    ".cursor/audit-reports/return-items-fbm-aware-dry-run-v183",
    V183_RUN,
    "proposal-rows.json",
  );
  const proposals = JSON.parse(fs.readFileSync(proposalPath, "utf8")) as Array<{
    return_item_id: string;
    organization_id: string;
    store_id: string | null;
    fbm_class: string;
    identifiers: { fnsku: string | null; asin: string | null; sku: string | null };
    apply_kind: string;
  }>;

  const unresolved: UnresolvedRow[] = proposals
    .filter((p) => p.apply_kind === "exclude_no_proposal")
    .map((p) => ({
      return_item_id: p.return_item_id,
      organization_id: p.organization_id,
      store_id: n(p.store_id) ?? "",
      fbm_class: p.fbm_class,
      fnsku: n(p.identifiers.fnsku),
      asin: n(p.identifiers.asin),
      sku: n(p.identifiers.sku),
    }))
    .filter((r) => r.store_id);

  const client = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();

  const reviews: RowReview[] = [];
  for (const row of unresolved) {
    const productsHits: Record<string, ProductSearchResult> = {};
    const mapHits: Record<string, MapHit[]> = {};
    if (row.fnsku) {
      productsHits.fnsku = await searchProducts(client, row.organization_id, row.store_id, "fnsku", row.fnsku);
      mapHits.fnsku = await searchMap(client, row.organization_id, row.store_id, "fnsku", row.fnsku);
    }
    if (row.asin) {
      productsHits.asin = await searchProducts(client, row.organization_id, row.store_id, "asin", row.asin);
      mapHits.asin = await searchMap(client, row.organization_id, row.store_id, "asin", row.asin);
    }
    if (row.sku) {
      productsHits.sku = await searchProducts(client, row.organization_id, row.store_id, "sku", row.sku);
      mapHits.sku = await searchMap(client, row.organization_id, row.store_id, "sku", row.sku);
    }
    reviews.push(classifyRow(row, productsHits, mapHits));
  }

  await client.end();

  const enrichable = reviews.filter((r) => r.classification === "enrichable_from_existing_product");
  const nonEnrichable = reviews.filter((r) => r.classification !== "enrichable_from_existing_product");
  const allCandidates = enrichable.flatMap((r) => r.enrichment_candidates);
  const approval = readApproval();

  let executeResult = { executed: false, applied: 0, errors: [] as string[] };
  if (execute && approval.approved && allCandidates.length > 0) {
    const c2 = new pg.Client({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
    await c2.connect();
    executeResult = { executed: true, ...(await executeEnrichment(c2, allCandidates)) };
    await c2.end();
  } else if (execute && !approval.approved) {
    executeResult = { executed: false, applied: 0, errors: ["execute blocked: approval not true"] };
  }

  const blockers = [
    "return_items backfill execute blocked until dry-run shows set_resolved > 0",
    ...(allCandidates.length === 0 ? ["no_safe_map_enrichment_candidates"] : []),
    ...(!approval.approved ? ["operator_approval_required"] : []),
    "tier_4_upc_gtin still disabled in matcher",
  ];

  fs.writeFileSync(
    path.join(outDir, "unresolved-return-items-review.md"),
    [
      "# Unresolved return_items review (V185)",
      "",
      `Source dry-run: \`return-items-fbm-aware-dry-run-v183/${V183_RUN}/proposal-rows.json\``,
      "",
      `Unresolved count: **${unresolved.length}** (of 7 active; 2 skip_unchanged excluded)`,
      "",
      ...reviews.map(
        (r) =>
          [
            `## ${r.return_item_id}`,
            "",
            `- org: \`${r.organization_id}\` store: \`${r.store_id}\` class: **${r.fbm_class}**`,
            `- identifiers: FNSKU \`${r.identifiers.fnsku ?? "—"}\` ASIN \`${r.identifiers.asin ?? "—"}\` SKU \`${r.identifiers.sku ?? "—"}\``,
            `- **classification:** \`${r.classification}\``,
            `- products ids: ${r.distinct_product_ids_from_products.join(", ") || "none"}`,
            `- map product ids: ${r.distinct_product_ids_from_map.join(", ") || "none"}`,
            `- notes: ${r.classification_notes.map((n) => `\n  - ${n}`).join("") || " —"}`,
            "",
          ].join("\n"),
      ),
    ].join("\n"),
    "utf8",
  );

  fs.writeFileSync(
    path.join(outDir, "product-search-results.md"),
    [
      "# Product + map search results",
      "",
      ...reviews.flatMap((r) => [
        `### ${r.return_item_id}`,
        "",
        "**products:**",
        "```json",
        JSON.stringify(r.products_hits, null, 2),
        "```",
        "",
        "**product_identifier_map:**",
        "```json",
        JSON.stringify(r.map_hits, null, 2),
        "```",
        "",
      ]),
    ].join("\n"),
    "utf8",
  );

  fs.writeFileSync(
    path.join(outDir, "enrichment-candidates.md"),
    allCandidates.length
      ? [
          "# Enrichment candidates (product_identifier_map only)",
          "",
          ...allCandidates.map(
            (c) =>
              `- **${c.return_item_id}** → product \`${c.product_id}\` | ${c.winning_identifier} | ${c.rationale}`,
          ),
        ].join("\n")
      : "# Enrichment candidates\n\n**None** — no row passed enrichable gate.\n",
    "utf8",
  );

  fs.writeFileSync(
    path.join(outDir, "non-enrichable-rows.md"),
    [
      "# Non-enrichable rows",
      "",
      ...nonEnrichable.map(
        (r) => `- \`${r.return_item_id}\` — **${r.classification}** — ${r.classification_notes[0] ?? ""}`,
      ),
    ].join("\n"),
    "utf8",
  );

  const approvalCopy = [
    "# product_identifier_map enrichment V185 — operator approval",
    "",
    "**Scope:** INSERT bridge rows on staging only when V185 audit lists safe candidates.",
    "",
    "| Field | Value |",
    "|-------|--------|",
    "| Staging ref | `eiqfaapyumhixxoeltgu` |",
    "| `APPROVED_TO_RUN_STAGING` | `false` |",
    "",
    "## Preconditions",
    "",
    "- [ ] Review `.cursor/audit-reports/return-items-identifier-map-enrichment-v185/<run_id>/enrichment-candidates.md`",
    "- [ ] No product auto-create",
    "- [ ] Re-run dry-run after enrichment (do not execute return_items backfill in same window)",
    "",
    "## Sign-off",
    "",
    "```",
    "APPROVED_TO_RUN_STAGING=false",
    "Approved by:",
    "UTC date:",
    "```",
  ].join("\n");

  const approvalOut = path.join(process.cwd(), APPROVAL_PATH);
  if (!fs.existsSync(approvalOut)) fs.writeFileSync(approvalOut, approvalCopy, "utf8");
  fs.copyFileSync(approvalOut, path.join(outDir, "approval-file.md"));

  fs.writeFileSync(
    path.join(outDir, "execute-result-if-approved.md"),
    [
      "# Execute result",
      "",
      `- approval \`APPROVED_TO_RUN_STAGING\`: **${approval.approved}**`,
      `- execute flag passed: **${execute}**`,
      `- enrichment executed: **${executeResult.executed}**`,
      `- map rows applied: **${executeResult.applied}**`,
      executeResult.errors.length ? `- errors: ${executeResult.errors.join("; ")}` : "",
      "",
      executeResult.executed
        ? "Re-run dry-run only — do not execute return_items backfill yet."
        : "No map writes performed.",
    ].join("\n"),
    "utf8",
  );

  fs.writeFileSync(
    path.join(outDir, "next-dry-run-instructions.md"),
    [
      "# Next dry-run instructions",
      "",
      "After map enrichment (if any):",
      "",
      "```bash",
      "npm run dry-run:return-items-fbm-aware-v183 -- --run-id=<new_id>",
      "```",
      "",
      "Expect: `set_resolved_total` > 0 only if enrichable products were linked.",
      "",
      "Do **not** run:",
      "",
      "```bash",
      "# BLOCKED until dry-run shows eligible rows + separate return_items approval",
      "npm run ... return-items-resolver-backfill ... --execute",
      "```",
    ].join("\n"),
    "utf8",
  );

  fs.writeFileSync(path.join(outDir, "blockers.md"), blockers.map((b) => `- ${b}`).join("\n") + "\n", "utf8");

  const manifest = {
    prompt: "RETURN-ITEMS-IDENTIFIER-MAP-ENRICHMENT-V185",
    run_id: runId,
    v183_run_id: V183_RUN,
    staging_ref: STAGING_REF,
    unresolved_count: unresolved.length,
    enrichable_count: enrichable.length,
    non_enrichable_count: nonEnrichable.length,
    enrichment_candidates: allCandidates.length,
    approval_required: !approval.approved,
    enrichment_executed: executeResult.executed,
    map_rows_applied: executeResult.applied,
    classifications: Object.fromEntries(
      [...new Set(reviews.map((r) => r.classification))].map((k) => [
        k,
        reviews.filter((r) => r.classification === k).length,
      ]),
    ),
  };

  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(path.join(outDir, "enrichment-candidates.json"), JSON.stringify(allCandidates, null, 2));
  fs.writeFileSync(path.join(outDir, "row-reviews.json"), JSON.stringify(reviews, null, 2));

  console.log(JSON.stringify(manifest, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
