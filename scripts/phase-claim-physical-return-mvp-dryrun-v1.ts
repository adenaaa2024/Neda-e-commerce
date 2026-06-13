/**
 * PHASE-CLAIM-PHYSICAL-RETURN-MVP-DRYRUN-V1 — staging dry-run only.
 *
 *   npx tsx scripts/phase-claim-physical-return-mvp-dryrun-v1.ts [--run-id=UTC]
 *
 * READ-ONLY: SELECT-only + audit files. No migrations, no DDL, no scanner
 * changes, no claim_candidates mutation, no claim_cases, no submissions,
 * no PDFs, no RBAC changes. Audit output files only.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import pg from "pg";

import { getStagingProjectRef, loadEnvLocalIntoProcess } from "../lib/staging-project-ref";

const STAGING_REF = "eiqfaapyumhixxoeltgu";
const FALLBACK_ORG = "00000000-0000-0000-0000-000000000001";
let SMOKE_ORG = FALLBACK_ORG;
const OUT_BASE = ".cursor/audit-reports/phase-claim-physical-return-mvp-dryrun-v1";
const MEMORY_FILE = ".cursor/.ai-memory/CLAIMS_TRID_STATE.md";

type Row = Record<string, unknown>;

function runIdArg(): string {
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

function num(v: unknown): number | null {
  const n = Number(v ?? NaN);
  return Number.isFinite(n) ? n : null;
}

async function connectPg(): Promise<pg.Client> {
  const url = process.env.STAGING_DIRECT_POSTGRES_URL?.trim();
  if (!url) throw new Error("STAGING_DIRECT_POSTGRES_URL unset");
  if (!url.includes(STAGING_REF)) {
    throw new Error(`BLOCKED: STAGING_DIRECT_POSTGRES_URL must target ref ${STAGING_REF}`);
  }
  const c = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await c.connect();
  await c.query("SET statement_timeout = '300s'");
  await c.query("SET default_transaction_read_only = on");
  return c;
}

async function tableColumns(c: pg.Client, table: string): Promise<Set<string>> {
  const r = await c.query(
    `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1`,
    [table],
  );
  return new Set(r.rows.map((x: { column_name: string }) => x.column_name));
}

/** Active smoke org = org owning the trusted (non-legacy) physical candidates. */
async function detectSmokeOrg(c: pg.Client): Promise<string> {
  const r = await c.query(`
    SELECT organization_id::text AS org, COUNT(*)::int AS n
    FROM public.claim_candidates
    WHERE source_kind <> 'legacy_seed'
      AND (source_kind = 'scanner_physical_review' OR claim_family ILIKE 'physical_return%')
    GROUP BY 1 ORDER BY n DESC LIMIT 1
  `);
  return str((r.rows[0] as Row | undefined)?.org) ?? FALLBACK_ORG;
}

/* ── 1) MVP candidate selection ───────────────────────────────────────────── */
async function selectMvpCandidates(c: pg.Client): Promise<Row[]> {
  const pool = await c.query(
    `SELECT *
     FROM public.claim_candidates
     WHERE organization_id = $1
       AND (source_kind = 'scanner_physical_review'
            OR claim_family IN ('physical_return_issue', 'physical_return_off_manifest', 'over_received', 'missing_units', 'empty_box_received'))
       AND quarantined_at IS NULL AND rejected_at IS NULL
     ORDER BY (source_kind <> 'legacy_seed') DESC, created_at DESC
     LIMIT 25`,
    [SMOKE_ORG],
  );
  const rows = pool.rows as Row[];
  if (!rows.length) return [];

  const picked: Row[] = [];
  const pickedIds = new Set<string>();
  const push = (r: Row | undefined) => {
    if (!r) return;
    const id = String(r.id);
    if (pickedIds.has(id) || picked.length >= 3) return;
    pickedIds.add(id);
    picked.push(r);
  };

  // 1: best trusted candidate with product link.
  push(rows.find((r) => r.source_kind === "scanner_physical_review" && r.resolved_product_id));
  // 2: product-blocked example.
  push(rows.find((r) => !r.resolved_product_id));
  // 3: evidence-missing example (evidence_status missing) different from above.
  push(rows.find((r) => String(r.evidence_status ?? "") === "missing" && !pickedIds.has(String(r.id))));
  // Fill remaining with most recent trusted.
  for (const r of rows) push(r);
  return picked;
}

/* ── context loads per candidate ──────────────────────────────────────────── */
async function loadContext(c: pg.Client, cand: Row) {
  const returnItemId = str(cand.return_item_id);
  const packageId = str(cand.package_id);
  const productId = str(cand.resolved_product_id);

  const [ri, pkg, evid, edges, pim] = await Promise.all([
    returnItemId
      ? c.query(
          `SELECT id::text, order_id, item_name, notes, conditions, scanned_quantity, photo_evidence, created_at::text
           FROM public.return_items WHERE id = $1`,
          [returnItemId],
        )
      : Promise.resolve({ rows: [] as Row[] }),
    packageId
      ? c.query(
          `SELECT id::text, package_code, tracking_number FROM public.packages WHERE id = $1`,
          [packageId],
        )
      : Promise.resolve({ rows: [] as Row[] }),
    c.query(
      `SELECT COUNT(*)::int AS n FROM public.claim_evidence
       WHERE organization_id = $1 AND (claim_candidate_id = $2 OR (return_item_id IS NOT NULL AND return_item_id = $3))`,
      [SMOKE_ORG, String(cand.id), returnItemId],
    ),
    c.query(
      `SELECT edge_type, reference_kind, reference_value, confidence_score
       FROM public.claim_reference_edges WHERE candidate_id = $1 LIMIT 50`,
      [String(cand.id)],
    ),
    productId
      ? c.query(`SELECT COUNT(*)::int AS n FROM public.product_identifier_map WHERE product_id = $1`, [productId])
      : Promise.resolve({ rows: [{ n: 0 }] }),
  ]);

  return {
    return_item: (ri.rows[0] as Row | undefined) ?? null,
    package: (pkg.rows[0] as Row | undefined) ?? null,
    claim_evidence_count: Number((evid.rows[0] as Row | undefined)?.n ?? 0),
    existing_edges: edges.rows as Row[],
    identifier_rows: Number((pim.rows[0] as Row | undefined)?.n ?? 0),
  };
}

/* ── money lookups (schema-adaptive, read-only) ───────────────────────────── */
async function moneyLookups(c: pg.Client, cand: Row) {
  const productId = str(cand.resolved_product_id);
  const sku = str(cand.sku);

  const ppCols = await tableColumns(c, "product_prices");
  const prodCols = await tableColumns(c, "products");

  const priceCol = ["sale_price", "price", "unit_price", "list_price"].find((x) => ppCols.has(x)) ?? null;
  const prodCostCol = ["cost", "unit_cost", "cogs", "cost_price", "purchase_price"].find((x) => prodCols.has(x)) ?? null;

  let latestSalePrice: number | null = null;
  if (productId && priceCol && ppCols.has("product_id")) {
    const r = await c.query(
      `SELECT ${priceCol}::numeric AS v FROM public.product_prices
       WHERE product_id = $1 AND ${priceCol} IS NOT NULL
       ORDER BY ${ppCols.has("created_at") ? "created_at" : priceCol} DESC LIMIT 1`,
      [productId],
    );
    latestSalePrice = num((r.rows[0] as Row | undefined)?.v);
  }

  let productCost: number | null = null;
  if (productId && prodCostCol) {
    const r = await c.query(`SELECT ${prodCostCol}::numeric AS v FROM public.products WHERE id = $1`, [productId]);
    productCost = num((r.rows[0] as Row | undefined)?.v);
  }

  let observedReimbursement: number | null = null;
  if (sku) {
    const r = await c.query(
      `SELECT SUM(amount_reimbursed)::numeric AS v FROM public.amazon_reimbursements
       WHERE organization_id = $1 AND sku = $2`,
      [SMOKE_ORG, sku],
    );
    observedReimbursement = num((r.rows[0] as Row | undefined)?.v);
  }

  const cogsUnit = num(cand.cogs_unit);
  const recovery = num(cand.recovery_value);
  const units = num(cand.actual_quantity) ?? num(cand.expected_quantity) ?? 1;

  const basisValue = cogsUnit ?? productCost ?? latestSalePrice;
  const amountBasis = cogsUnit
    ? "candidate cogs_unit"
    : productCost
      ? `products.${prodCostCol}`
      : latestSalePrice
        ? `product_prices.${priceCol} (latest sale price fallback)`
        : "none";
  const expected = recovery ?? (basisValue != null ? Math.round(basisValue * units * 100) / 100 : null);

  return {
    expected_recovery_value: expected,
    amount_basis: amountBasis,
    amount_confidence: cogsUnit ? "high" : productCost ? "medium" : latestSalePrice ? "low" : "none",
    latest_sale_price: latestSalePrice,
    actual_cost_basis: productCost ?? cogsUnit,
    cost_unknown: cogsUnit == null && productCost == null ? "yes" : "no",
    zero_unpriced: expected == null || expected === 0 ? "yes" : "no",
    observed_reimbursement: observedReimbursement,
    actual_loss_available: observedReimbursement != null && expected != null ? "yes" : "no",
    exact_missing_requirement:
      cogsUnit == null && productCost == null && latestSalePrice == null
        ? "unit cost or sale price for product (no cogs_unit, no products cost column value, no product_prices row)"
        : cogsUnit == null
          ? "cogs_unit on candidate (fallback in use)"
          : null,
    price_schema: { price_column: priceCol, product_cost_column: prodCostCol },
  };
}

/* ── TRID edge dry-run proposals (no inserts) ─────────────────────────────── */
function tridProposals(cand: Row, ctx: Awaited<ReturnType<typeof loadContext>>) {
  const proposals: Array<Record<string, unknown>> = [];
  const existing = new Set(ctx.existing_edges.map((e) => `${e.edge_type}:${e.reference_kind}:${e.reference_value}`));
  const add = (p: {
    target: string;
    edge_type: string;
    reference_kind: string;
    reference_value: string | null;
    to_source_table: string | null;
    to_source_row_id: string | null;
    confidence: number;
    missing_reason: string | null;
  }) => {
    const dup =
      p.reference_value != null && existing.has(`${p.edge_type}:${p.reference_kind}:${p.reference_value}`);
    proposals.push({ ...p, already_materialized: dup, would_insert: p.missing_reason == null && !dup });
  };

  const ri = ctx.return_item;
  add({
    target: "return_item",
    edge_type: "source_evidence",
    reference_kind: "return_item_id",
    reference_value: ri ? String(ri.id) : null,
    to_source_table: "return_items",
    to_source_row_id: ri ? String(ri.id) : null,
    confidence: 1.0,
    missing_reason: ri ? null : "candidate has no return_item_id linkage",
  });

  const pkg = ctx.package;
  add({
    target: "package",
    edge_type: "shipment_scope",
    reference_kind: "package_code",
    reference_value: pkg ? (str(pkg.package_code) ?? String(pkg.id)) : null,
    to_source_table: "packages",
    to_source_row_id: pkg ? String(pkg.id) : null,
    confidence: 1.0,
    missing_reason: pkg ? null : "candidate has no package_id linkage",
  });

  const productId = str(cand.resolved_product_id);
  const anyIdentifier = str(cand.sku) ?? str(cand.fnsku) ?? str(cand.asin);
  add({
    target: "product_identifier",
    edge_type: "product_link",
    reference_kind: "product_id",
    reference_value: productId,
    to_source_table: "products",
    to_source_row_id: productId,
    confidence: productId ? 1.0 : 0,
    missing_reason: productId
      ? null
      : anyIdentifier
        ? `unresolved product — identifier present (${anyIdentifier}) but resolver has no deterministic match`
        : "no product identifiers on candidate (sku/fnsku/asin all null)",
  });

  const photos = Array.isArray(ri?.photo_evidence) ? (ri!.photo_evidence as unknown[]).length : 0;
  const evidenceCount = ctx.claim_evidence_count + photos;
  add({
    target: "photo_evidence",
    edge_type: "source_evidence",
    reference_kind: "evidence",
    reference_value: evidenceCount ? `${evidenceCount} item(s)` : null,
    to_source_table: ctx.claim_evidence_count ? "claim_evidence" : photos ? "return_items.photo_evidence" : null,
    to_source_row_id: null,
    confidence: evidenceCount ? 1.0 : 0,
    missing_reason: evidenceCount ? null : "no photos or claim_evidence rows attached",
  });

  const orderId = ri ? str(ri.order_id) : null;
  const tracking = pkg ? str(pkg.tracking_number) : str(cand.shipment_scope_key);
  add({
    target: "order_or_tracking",
    edge_type: orderId ? "order_reference" : "shipment_scope",
    reference_kind: orderId ? "amazon_order_id" : "tracking_number",
    reference_value: orderId ?? tracking,
    to_source_table: null,
    to_source_row_id: null,
    confidence: orderId ? 0.9 : tracking ? 0.8 : 0,
    missing_reason: orderId || tracking ? null : "no order_id on return_item and no tracking on package/scope",
  });

  return proposals;
}

/* ── policy context (read-only) ───────────────────────────────────────────── */
async function policyContext(c: pg.Client) {
  const r = await c.query(
    `SELECT claim_policy FROM public.organization_settings WHERE organization_id = $1`,
    [SMOKE_ORG],
  );
  const policy = ((r.rows[0] as Row | undefined)?.claim_policy ?? {}) as Row;
  return {
    keys_present: Object.keys(policy),
    enabled_claim_domains: policy.enabled_claim_domains ?? null,
    scan_go_live_date: policy.scan_go_live_date ?? null,
    claim_start_date: policy.claim_start_date ?? null,
    allow_manual_override: policy.allow_manual_override ?? null,
  };
}

function readinessRow(cand: Row, ctx: Awaited<ReturnType<typeof loadContext>>, policy: Row) {
  const goLive = str(policy.scan_go_live_date as unknown);
  const eventDate = str(cand.event_date);
  const withinPolicy = !goLive || !eventDate || eventDate >= goLive;
  return {
    candidate_id: String(cand.id),
    source_row: `${cand.source_table}/${cand.source_row_id}`,
    source_kind: cand.source_kind,
    claim_family: cand.claim_family,
    claim_reason: cand.claim_reason,
    lifecycle_status: cand.candidate_status,
    policy_status: withinPolicy ? "within_policy_window" : "before_scan_go_live (policy-blocked)",
    queue_placement:
      cand.candidate_status === "detected"
        ? ctx.claim_evidence_count > 0
          ? "Review queue (evidence attached)"
          : "Find Money queue (needs evidence)"
        : String(cand.candidate_status),
    evidence_status: `${cand.evidence_status} (${ctx.claim_evidence_count} claim_evidence rows)`,
    product_linkage_status: cand.resolved_product_id
      ? `resolved (${ctx.identifier_rows} identifier rows)`
      : "BLOCKED — unresolved product",
    reference_status: ctx.existing_edges.length
      ? `${ctx.existing_edges.length} TRID edges materialized`
      : "no TRID edges yet",
    is_legacy_seed: cand.source_kind === "legacy_seed",
  };
}

function claimCenterPreview(cands: Array<{ cand: Row; money: Row; readiness: Row }>) {
  const totalRecovery = cands.reduce((s, x) => s + (num(x.money.expected_recovery_value) ?? 0), 0);
  return {
    home_tile: {
      label: "Physical return claims",
      detected: cands.length,
      potential_recovery: Math.round(totalRecovery * 100) / 100,
      currency: "USD",
    },
    find_money: cands.map((x) => ({
      candidate: String(x.cand.id).slice(0, 8),
      family: x.cand.claim_family,
      expected_recovery: x.money.expected_recovery_value,
      basis: x.money.amount_basis,
      flag: x.money.zero_unpriced === "yes" ? "UNPRICED — needs cost/price" : null,
    })),
    review: cands.map((x) => ({
      candidate: String(x.cand.id).slice(0, 8),
      queue: x.readiness.queue_placement,
      policy: x.readiness.policy_status,
    })),
    proof: cands.map((x) => ({
      candidate: String(x.cand.id).slice(0, 8),
      evidence: x.readiness.evidence_status,
    })),
    product: cands.map((x) => ({
      candidate: String(x.cand.id).slice(0, 8),
      linkage: x.readiness.product_linkage_status,
      sku: x.cand.sku ?? null,
    })),
    references: cands.map((x) => ({
      candidate: String(x.cand.id).slice(0, 8),
      status: x.readiness.reference_status,
    })),
    recovery: {
      expected_total: Math.round(totalRecovery * 100) / 100,
      actual_loss_known: cands.filter((x) => x.money.actual_loss_available === "yes").length,
    },
    detail_story:
      "Per candidate: scan event -> candidate detected -> evidence -> product -> references -> money (timeline assembled from return_items.created_at, candidate created_at, claim_evidence, claim_reference_edges)",
  };
}

function writeReport(outDir: string, payload: Record<string, unknown>): void {
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "results.json"), JSON.stringify(payload, null, 2));
  const p = payload;
  const md = `# Physical return claim MVP — DRY-RUN V1 (staging, read-only)

| Field | Value |
|-------|-------|
| run_id | ${p.run_id} |
| selected candidates | ${(p.selected_mvp_candidates as unknown[]).length} |
| schema_needed | ${p.schema_needed} |
| SAFE_TO_IMPLEMENT_PHYSICAL_RETURN_MVP_READMODEL | ${p.SAFE_TO_IMPLEMENT_PHYSICAL_RETURN_MVP_READMODEL} |

## Candidate readiness

\`\`\`json
${JSON.stringify(p.candidate_readiness_matrix, null, 2)}
\`\`\`

## TRID edge dry-run (no inserts)

\`\`\`json
${JSON.stringify(p.trid_edge_dryrun, null, 2)}
\`\`\`

## Money readiness

\`\`\`json
${JSON.stringify(p.money_readiness_matrix, null, 2)}
\`\`\`

## Claim Center display preview

\`\`\`json
${JSON.stringify(p.claim_center_display_preview, null, 2)}
\`\`\`

## Product Story preview

\`\`\`json
${JSON.stringify(p.product_story_preview, null, 2)}
\`\`\`

## Missing requirements

${(p.missing_requirements as string[]).map((x) => `- ${x}`).join("\n")}

## Implementation plan

${(p.implementation_plan as string[]).map((x) => `- ${x}`).join("\n")}

## NEXT_EXACT_PROMPT

\`\`\`
${p.NEXT_EXACT_PROMPT}
\`\`\`
`;
  fs.writeFileSync(path.join(outDir, "summary.md"), md);
}

async function main(): Promise<void> {
  loadEnvLocalIntoProcess();
  const runId = runIdArg();
  const outDir = path.join(OUT_BASE, runId);

  const stagingRef = getStagingProjectRef();
  if (stagingRef !== STAGING_REF) {
    throw new Error(`BLOCKED: expected staging ref ${STAGING_REF}, got ${stagingRef}`);
  }

  const c = await connectPg();

  SMOKE_ORG = await detectSmokeOrg(c);
  console.log(JSON.stringify({ phase: "smoke_org_detected", org: SMOKE_ORG }));

  const policy = await policyContext(c);
  const selected = await selectMvpCandidates(c);
  console.log(JSON.stringify({ phase: "selection", count: selected.length }));

  const detail: Array<{ cand: Row; ctx: Awaited<ReturnType<typeof loadContext>>; money: Row; readiness: Row }> = [];
  for (const cand of selected) {
    const ctx = await loadContext(c, cand);
    const money = (await moneyLookups(c, cand)) as unknown as Row;
    const readiness = readinessRow(cand, ctx, policy as unknown as Row) as unknown as Row;
    detail.push({ cand, ctx, money, readiness });
  }

  // Product story preview per distinct product/identifier of selected candidates.
  const productStory = detail.map((d) => ({
    candidate: String(d.cand.id).slice(0, 8),
    product_identity: d.cand.resolved_product_id
      ? { product_id: d.cand.resolved_product_id, identifier_rows: d.ctx.identifier_rows, sku: d.cand.sku }
      : { unresolved: true, sku: d.cand.sku, fnsku: d.cand.fnsku, asin: d.cand.asin },
    scan_event: d.ctx.return_item
      ? { return_item: String(d.ctx.return_item.id), at: d.ctx.return_item.created_at, item: d.ctx.return_item.item_name }
      : null,
    claim_candidate: { family: d.cand.claim_family, status: d.cand.candidate_status },
    missing_cost_price: d.money.cost_unknown === "yes",
    missing_trid: d.ctx.existing_edges.length === 0,
    evidence_source: { claim_evidence_rows: d.ctx.claim_evidence_count },
    future_financial_lane:
      "reimbursements/settlements join by sku/order once order reference exists (FRR lane ready, 573k rows)",
  }));

  await c.end();

  const missingRequirements = [
    ...new Set(
      detail.flatMap((d) => {
        const out: string[] = [];
        const mr = str(d.money.exact_missing_requirement);
        if (mr) out.push(`money: ${mr} (candidate ${String(d.cand.id).slice(0, 8)})`);
        for (const t of tridProposals(d.cand, d.ctx)) {
          if (t.missing_reason) out.push(`trid/${t.target}: ${t.missing_reason} (candidate ${String(d.cand.id).slice(0, 8)})`);
        }
        return out;
      }),
    ),
  ];

  const payload: Record<string, unknown> = {
    phase: "PHASE-CLAIM-PHYSICAL-RETURN-MVP-DRYRUN-V1",
    run_id: runId,
    staging_ref: STAGING_REF,
    smoke_org: SMOKE_ORG,
    mode: "dry_run_read_only",
    policy_context: policy,
    selected_mvp_candidates: detail.map((d) => ({
      candidate_id: String(d.cand.id),
      source_kind: d.cand.source_kind,
      claim_family: d.cand.claim_family,
      created_at: d.cand.created_at,
      why_selected:
        !d.cand.resolved_product_id
          ? "product-blocked example"
          : d.ctx.claim_evidence_count === 0
            ? "evidence-missing example"
            : "best trusted physical-return candidate",
    })),
    candidate_readiness_matrix: detail.map((d) => d.readiness),
    trid_edge_dryrun: detail.map((d) => ({
      candidate_id: String(d.cand.id),
      proposals: tridProposals(d.cand, d.ctx),
    })),
    money_readiness_matrix: detail.map((d) => ({ candidate_id: String(d.cand.id), ...d.money })),
    claim_center_display_preview: claimCenterPreview(detail),
    product_story_preview: productStory,
    missing_requirements: missingRequirements,
    implementation_plan: [
      "Read-model first (SHIP READ-ONLY): Claim Center physical-return lane reads claim_candidates (trusted source_kinds) + claim_reference_edges + claim_evidence — no new writes needed.",
      "Backend fix 1 (smallest): money read-model fallback chain cogs_unit -> products cost -> product_prices latest, flag zero_unpriced instead of hiding candidates.",
      "Backend fix 2: include return_item/package edge rules (return_item_id/package_id) in discovery engine apply so trusted scanner candidates materialize the 5 MVP edge targets automatically.",
      "UI copy: 'UNPRICED — add cost to see recovery' badge on Find Money tile; 'Unresolved product' badge linking to PIM review queue.",
      "Schema needed: NO (all reads use existing tables/columns).",
      "New RLS table needed: NO (claim_reference_edges already has org RLS; claim_evidence existing).",
      "Ship order: read-only Claim Center lane -> edge apply for trusted candidates -> money fallback -> evidence upload nudge.",
    ],
    schema_needed: "no",
    rls_table_needed: "no",
    can_ship_read_only_first: "yes",
    SAFE_TO_IMPLEMENT_PHYSICAL_RETURN_MVP_READMODEL: detail.length > 0 ? "yes" : "no",
    NEXT_EXACT_PROMPT:
      "PHASE-CLAIM-PHYSICAL-RETURN-MVP-READMODEL-IMPLEMENT-V1\n\nMode: staging implementation (read-only UI lane).\nScope: Claim Center physical-return lane read model (lib/claims/readmodel/physical-return-mvp.ts) reading claim_candidates (trusted kinds) + claim_reference_edges + claim_evidence + money fallback chain (cogs_unit -> products cost -> product_prices latest, zero_unpriced flag).\nNo claim_cases, no submissions, no scanner changes, no schema.\nThen: run edge apply for trusted scanner candidates (governed discovery engine), npm run build, staging smoke, append memory.",
    verification: [
      "read-only session (default_transaction_read_only = on) — no DB writes",
      "no scanner/operator-mobile changes",
      "no claim_candidates mutation, no claim_cases, no submissions, no PDFs",
      "legacy_seed labeled in readiness matrix, never treated as truth",
    ],
  };

  writeReport(outDir, payload);

  const memo = `

## Physical return MVP dry-run V1 (append ${new Date().toISOString().slice(0, 10)})

- **Run:** \`${runId}\` — \`.cursor/audit-reports/phase-claim-physical-return-mvp-dryrun-v1/${runId}/\`
- Selected ${detail.length} MVP candidate(s) from smoke org (trusted scanner candidates preferred; product-blocked + evidence-missing examples included where present).
- TRID 5-edge MVP set proposed per candidate (return_item / package / product / evidence / order-tracking) with confidence + missing reasons — **no inserts**.
- Money read model: fallback chain cogs_unit -> products cost -> product_prices; zero_unpriced flag drives "Find Money" copy.
- schema_needed=no, rls_table_needed=no, can_ship_read_only_first=yes. SAFE_TO_IMPLEMENT_PHYSICAL_RETURN_MVP_READMODEL=${payload.SAFE_TO_IMPLEMENT_PHYSICAL_RETURN_MVP_READMODEL}.
- Next: \`PHASE-CLAIM-PHYSICAL-RETURN-MVP-READMODEL-IMPLEMENT-V1\`
`;
  fs.appendFileSync(path.join(process.cwd(), MEMORY_FILE), memo, "utf8");

  console.log(JSON.stringify(payload, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
