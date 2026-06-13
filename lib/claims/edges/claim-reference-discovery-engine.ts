/**
 * TRID-DISCOVERY-ENGINE — automatic reference discovery over the unified
 * claim_candidates pool.
 *
 * Reusable, deterministic, set-based discovery rules. Each rule scans one
 * source family and emits candidate-anchored rows into claim_reference_edges:
 *
 *   source                | edge_type              | reference_kind
 *   ----------------------|------------------------|----------------------
 *   amazon_order_id       | order_reference        | amazon_order_id
 *   removal orders        | claim_to_removal       | removal_order_id
 *   removal shipments     | claim_to_shipment      | tracking_number
 *   shipments (packages)  | shipment_scope         | tracking_number
 *   tracking (scope key)  | shipment_scope         | tracking_number
 *   package_code          | shipment_scope         | package_code
 *   inventory ledger      | ledger_reference       | ledger_reference_id
 *   reimbursements        | claim_to_reimbursement | reimbursement_id
 *   transactions          | claim_to_settlement    | transaction_id
 *   SAFET                 | safet_reference        | safet_claim_id
 *   delayed not received  | claim_to_shipment      | delayed_not_received
 *   shipment discrepancy  | claim_to_shipment      | shipment_discrepancy
 *   product_id            | product_link           | product_id
 *
 * Hard rules: claim_candidates anchor only; never writes claim_cases /
 * claim_lines; never files claims. Ambiguity preserved via
 * ambiguity_group_key (multi-match) — never auto-collapsed. Duplicate edges
 * impossible: every insert targets uq_claim_reference_edges_candidate_natural
 * with ON CONFLICT DO NOTHING.
 */

export type DiscoveryQueryExecutor = (sql: string) => Promise<{ rowCount: number | null; rows: Array<Record<string, unknown>> }>;

export type DiscoveryRule = {
  /** Source label from the discovery spec. */
  source: string;
  edge_type: string;
  /** SELECT body matching DISCOVERY_EDGE_INSERT_COLS order. */
  sql: string;
  /** Rule could not run because the source table/columns are absent. */
  unavailable?: string;
};

export const DISCOVERY_EDGE_INSERT_COLS =
  "(organization_id, candidate_id, edge_type, from_node_kind, from_source_table, from_source_row_id, to_node_kind, to_source_table, to_source_row_id, reference_kind, reference_value, confidence_score, ambiguity_group_key, ambiguity_rank, edge_reason, source_citations)";

export const DISCOVERY_CONFLICT_TARGET =
  "(organization_id, candidate_id, edge_type, COALESCE(to_source_table, ''), COALESCE(to_source_row_id, ''), COALESCE(reference_kind, ''), COALESCE(reference_value, '')) WHERE candidate_id IS NOT NULL";

/** Session-scoped candidate context + match tables used by every rule. */
export const DISCOVERY_SETUP_SQL: string[] = [
  `DROP TABLE IF EXISTS tmp_disc_cand`,
  `CREATE TEMP TABLE tmp_disc_cand AS
   SELECT
     c.id, c.organization_id, c.store_id, c.source_kind, c.source_table,
     c.source_row_id::text AS source_row_id,
     c.claim_family, c.sku, c.fnsku, c.asin, c.resolved_product_id,
     c.package_id, c.shipment_scope_key, c.delta_quantity,
     COALESCE(ar.order_id, rm.order_id, rs.order_id, ri.order_id) AS op_order,
     rm.id::text AS removal_row_id,
     rs.id::text AS ship_row_id,
     rs.tracking_number AS ship_tracking,
     rs.shipment_date AS ship_date,
     -- Physical-return lane (7H-PR): trusted scanner / return_items-backed candidates.
     (c.source_kind <> 'legacy_seed' AND (
        c.source_kind = 'scanner_physical_review'
        OR (c.source_kind = 'orbit_fra' AND c.source_table = 'return_items')
        OR c.claim_family IN ('physical_return_issue', 'physical_return_off_manifest', 'physical_return_damaged')
     )) AS is_physical,
     c.return_item_id::text AS return_item_id_col,
     ri_any.id::text AS phys_return_item_id,
     ri_any.order_id AS ri_order_id,
     ri_any.notes AS ri_notes,
     CASE WHEN jsonb_typeof(to_jsonb(ri_any.photo_evidence)) = 'array'
          THEN jsonb_array_length(to_jsonb(ri_any.photo_evidence)) ELSE 0 END AS ri_photos_n,
     pp.id::text AS phys_pkg_id,
     pp.package_code AS phys_pkg_code,
     pp.tracking_number AS phys_pkg_tracking
   FROM public.claim_candidates c
   LEFT JOIN public.amazon_returns ar ON c.source_table = 'amazon_returns' AND ar.id = c.source_row_id
   LEFT JOIN public.amazon_removals rm ON c.source_table = 'amazon_removals' AND rm.id = c.source_row_id
   LEFT JOIN public.amazon_removal_shipments rs ON c.source_table = 'amazon_removal_shipments' AND rs.id = c.source_row_id
   LEFT JOIN public.return_items ri ON c.source_table = 'return_items' AND ri.id = c.source_row_id
   LEFT JOIN public.return_items ri_any
     ON ri_any.id = COALESCE(c.return_item_id, CASE WHEN c.source_table = 'return_items' THEN c.source_row_id END)
   LEFT JOIN public.packages pp
     ON pp.id = COALESCE(c.package_id, ri_any.package_id) AND pp.deleted_at IS NULL`,
  `CREATE INDEX ON tmp_disc_cand (organization_id, op_order)`,
  `DROP TABLE IF EXISTS tmp_disc_orders`,
  `CREATE TEMP TABLE tmp_disc_orders AS
   SELECT DISTINCT organization_id, op_order AS order_id
   FROM tmp_disc_cand WHERE op_order IS NOT NULL`,
  `DROP TABLE IF EXISTS tmp_disc_frr_orders`,
  `CREATE TEMP TABLE tmp_disc_frr_orders AS
   SELECT DISTINCT f.organization_id, f.order_id
   FROM public.financial_reference_resolver f
   JOIN tmp_disc_orders o ON o.organization_id = f.organization_id AND o.order_id = f.order_id`,
];

export function buildDiscoveryRules(options: { safetHasOrderId: boolean }): DiscoveryRule[] {
  const rules: DiscoveryRule[] = [
    {
      source: "amazon_order_id",
      edge_type: "order_reference",
      sql: `
        SELECT
          t.organization_id, t.id, 'order_reference',
          'claim_candidate', 'claim_candidates', t.id::text,
          'order', t.source_table, t.source_row_id,
          'amazon_order_id', t.op_order,
          1.0, NULL, NULL,
          'amazon order id discovered from candidate source row',
          jsonb_build_array(jsonb_build_object('table', t.source_table, 'id', t.source_row_id))
        FROM tmp_disc_cand t
        WHERE t.op_order IS NOT NULL`,
    },
    {
      source: "removal_orders",
      edge_type: "claim_to_removal",
      sql: `
        WITH m AS (
          SELECT r.organization_id, r.order_id, MIN(r.id::text) AS rep_id, COUNT(*)::int AS n
          FROM public.amazon_removals r
          JOIN tmp_disc_orders o ON o.organization_id = r.organization_id AND o.order_id = r.order_id
          GROUP BY 1, 2
        )
        SELECT
          t.organization_id, t.id, 'claim_to_removal',
          'claim_candidate', 'claim_candidates', t.id::text,
          'removal_order', 'amazon_removals', m.rep_id,
          'removal_order_id', t.op_order,
          CASE WHEN m.n = 1 THEN 1.0 ELSE 0.7 END,
          CASE WHEN m.n > 1 THEN t.organization_id::text || ':removal:' || t.op_order END,
          NULL,
          'candidate order matches removal order (' || m.n || ' rows)',
          jsonb_build_array(jsonb_build_object('table', 'amazon_removals', 'match_rows', m.n))
        FROM tmp_disc_cand t
        JOIN m ON m.organization_id = t.organization_id AND m.order_id = t.op_order`,
    },
    {
      source: "removal_shipments",
      edge_type: "claim_to_shipment",
      // One aggregated edge per candidate-order (multi-shipment orders fan out to
      // hundreds of trackings — per-tracking edges exploded to ~1.08M in dry-run).
      sql: `
        WITH m AS (
          SELECT s.organization_id, s.order_id,
            MIN(s.id::text) AS rep_id,
            MIN(s.tracking_number) AS rep_tracking,
            COUNT(*)::int AS n,
            COUNT(DISTINCT s.tracking_number)::int AS trackings
          FROM public.amazon_removal_shipments s
          JOIN tmp_disc_orders o ON o.organization_id = s.organization_id AND o.order_id = s.order_id
          WHERE s.tracking_number IS NOT NULL
          GROUP BY 1, 2
        )
        SELECT
          t.organization_id, t.id, 'claim_to_shipment',
          'claim_candidate', 'claim_candidates', t.id::text,
          'shipment', 'amazon_removal_shipments', m.rep_id,
          'tracking_number', m.rep_tracking,
          CASE WHEN m.trackings = 1 THEN 1.0 ELSE 0.6 END,
          CASE WHEN m.trackings > 1 THEN t.organization_id::text || ':shipments:' || t.op_order END,
          NULL,
          'candidate order matches removal shipments (' || m.n || ' rows, ' || m.trackings || ' trackings)',
          jsonb_build_array(jsonb_build_object('table', 'amazon_removal_shipments', 'match_rows', m.n, 'distinct_trackings', m.trackings))
        FROM tmp_disc_cand t
        JOIN m ON m.organization_id = t.organization_id AND m.order_id = t.op_order`,
    },
    {
      source: "shipments",
      edge_type: "shipment_scope",
      sql: `
        WITH pkg AS (
          SELECT p.id::text AS pkg_id, p.organization_id, p.tracking_number, p.package_code
          FROM public.packages p
          WHERE p.deleted_at IS NULL AND p.tracking_number IS NOT NULL
        )
        SELECT DISTINCT ON (t.id, pkg.tracking_number)
          t.organization_id, t.id, 'shipment_scope',
          'claim_candidate', 'claim_candidates', t.id::text,
          'shipment', 'packages', pkg.pkg_id,
          'tracking_number', pkg.tracking_number,
          1.0, NULL, NULL,
          'candidate package links shipment tracking',
          jsonb_build_array(jsonb_build_object('table', 'packages', 'id', pkg.pkg_id))
        FROM tmp_disc_cand t
        JOIN pkg ON pkg.organization_id = t.organization_id AND pkg.pkg_id = t.package_id::text
        ORDER BY t.id, pkg.tracking_number, pkg.pkg_id`,
    },
    {
      source: "tracking",
      edge_type: "shipment_scope",
      sql: `
        SELECT
          t.organization_id, t.id, 'shipment_scope',
          'claim_candidate', 'claim_candidates', t.id::text,
          'shipment_scope', NULL, NULL,
          'tracking_number', COALESCE(t.shipment_scope_key, t.ship_tracking),
          0.9, NULL, NULL,
          'shipment scope key recorded on candidate',
          '[]'::jsonb
        FROM tmp_disc_cand t
        WHERE COALESCE(t.shipment_scope_key, t.ship_tracking) IS NOT NULL`,
    },
    {
      source: "package_code",
      edge_type: "shipment_scope",
      sql: `
        SELECT
          t.organization_id, t.id, 'shipment_scope',
          'claim_candidate', 'claim_candidates', t.id::text,
          'package', 'packages', p.id::text,
          'package_code', p.package_code,
          1.0, NULL, NULL,
          'candidate package code scope',
          jsonb_build_array(jsonb_build_object('table', 'packages', 'id', p.id::text))
        FROM tmp_disc_cand t
        JOIN public.packages p ON p.id::text = t.package_id::text AND p.organization_id = t.organization_id
        WHERE p.deleted_at IS NULL AND p.package_code IS NOT NULL`,
    },
    {
      source: "inventory_ledger",
      edge_type: "ledger_reference",
      sql: `
        WITH m AS (
          SELECT l.organization_id, l.reference_id, MIN(l.id::text) AS rep_id, COUNT(*)::int AS n
          FROM public.amazon_inventory_ledger l
          JOIN tmp_disc_orders o ON o.organization_id = l.organization_id AND o.order_id = l.reference_id
          GROUP BY 1, 2
        )
        SELECT
          t.organization_id, t.id, 'ledger_reference',
          'claim_candidate', 'claim_candidates', t.id::text,
          'ledger_event', 'amazon_inventory_ledger', m.rep_id,
          'ledger_reference_id', m.reference_id,
          CASE WHEN m.n = 1 THEN 1.0 ELSE 0.8 END,
          NULL, NULL,
          'inventory ledger rows reference candidate order (' || m.n || ' rows)',
          jsonb_build_array(jsonb_build_object('table', 'amazon_inventory_ledger', 'match_rows', m.n))
        FROM tmp_disc_cand t
        JOIN m ON m.organization_id = t.organization_id AND m.reference_id = t.op_order`,
    },
    {
      source: "reimbursements",
      edge_type: "claim_to_reimbursement",
      sql: `
        WITH m AS (
          SELECT r.organization_id, r.order_id, r.reimbursement_id,
            MIN(r.id::text) AS rep_id, COUNT(*)::int AS n
          FROM public.amazon_reimbursements r
          JOIN tmp_disc_orders o ON o.organization_id = r.organization_id AND o.order_id = r.order_id
          WHERE r.reimbursement_id IS NOT NULL
          GROUP BY 1, 2, 3
        )
        SELECT
          t.organization_id, t.id, 'claim_to_reimbursement',
          'claim_candidate', 'claim_candidates', t.id::text,
          'reimbursement', 'amazon_reimbursements', m.rep_id,
          'reimbursement_id', m.reimbursement_id,
          1.0, NULL, NULL,
          'reimbursement found for candidate order (' || m.n || ' rows)',
          jsonb_build_array(jsonb_build_object('table', 'amazon_reimbursements', 'match_rows', m.n))
        FROM tmp_disc_cand t
        JOIN m ON m.organization_id = t.organization_id AND m.order_id = t.op_order`,
    },
    {
      source: "transactions",
      edge_type: "claim_to_settlement",
      sql: `
        WITH m AS (
          SELECT x.organization_id, x.order_id, MIN(x.id::text) AS rep_id, COUNT(*)::int AS n
          FROM public.amazon_transactions x
          JOIN tmp_disc_orders o ON o.organization_id = x.organization_id AND o.order_id = x.order_id
          GROUP BY 1, 2
        )
        SELECT
          t.organization_id, t.id, 'claim_to_settlement',
          'claim_candidate', 'claim_candidates', t.id::text,
          'transaction', 'amazon_transactions', m.rep_id,
          'transaction_id', m.rep_id,
          CASE WHEN m.n = 1 THEN 1.0 ELSE 0.8 END,
          NULL, NULL,
          'transactions found for candidate order (' || m.n || ' rows)',
          jsonb_build_array(jsonb_build_object('table', 'amazon_transactions', 'match_rows', m.n))
        FROM tmp_disc_cand t
        JOIN m ON m.organization_id = t.organization_id AND m.order_id = t.op_order`,
    },
    options.safetHasOrderId
      ? {
          source: "safet",
          edge_type: "safet_reference",
          sql: `
            WITH m AS (
              SELECT s.organization_id, s.order_id, MIN(s.id::text) AS rep_id, COUNT(*)::int AS n
              FROM public.amazon_safet_claims s
              JOIN tmp_disc_orders o ON o.organization_id = s.organization_id AND o.order_id = s.order_id
              GROUP BY 1, 2
            )
            SELECT
              t.organization_id, t.id, 'safet_reference',
              'claim_candidate', 'claim_candidates', t.id::text,
              'safet_claim', 'amazon_safet_claims', m.rep_id,
              'safet_claim_id', m.rep_id,
              1.0, NULL, NULL,
              'SAFE-T claim found for candidate order (' || m.n || ' rows)',
              jsonb_build_array(jsonb_build_object('table', 'amazon_safet_claims', 'match_rows', m.n))
            FROM tmp_disc_cand t
            JOIN m ON m.organization_id = t.organization_id AND m.order_id = t.op_order`,
        }
      : {
          source: "safet",
          edge_type: "safet_reference",
          sql: `SELECT NULL::uuid, NULL::uuid, ''::text, ''::text, NULL::text, NULL::text, ''::text, NULL::text, NULL::text, NULL::text, NULL::text, NULL::numeric, NULL::text, NULL::int, ''::text, '[]'::jsonb WHERE false`,
          unavailable: "amazon_safet_claims lacks order_id column or table empty — connected, 0 rows",
        },
    {
      source: "delayed_not_received",
      edge_type: "claim_to_shipment",
      sql: `
        SELECT
          t.organization_id, t.id, 'claim_to_shipment',
          'claim_candidate', 'claim_candidates', t.id::text,
          'shipment', 'amazon_removal_shipments', t.ship_row_id,
          'delayed_not_received', COALESCE(t.ship_tracking, t.op_order),
          0.8, NULL, NULL,
          'shipment older than 30 days with no financial reference — delayed/not received signal',
          jsonb_build_array(jsonb_build_object('shipment_date', t.ship_date::text))
        FROM tmp_disc_cand t
        WHERE t.ship_row_id IS NOT NULL
          AND t.ship_date < CURRENT_DATE - INTERVAL '30 days'
          AND COALESCE(t.ship_tracking, t.op_order) IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM tmp_disc_frr_orders f
            WHERE f.organization_id = t.organization_id AND f.order_id = t.op_order
          )`,
    },
    {
      source: "shipment_discrepancy",
      edge_type: "claim_to_shipment",
      sql: `
        SELECT
          t.organization_id, t.id, 'claim_to_shipment',
          'claim_candidate', 'claim_candidates', t.id::text,
          'shipment', 'amazon_removal_shipments', t.ship_row_id,
          'shipment_discrepancy', COALESCE(t.ship_tracking, t.op_order),
          0.9, NULL, NULL,
          'candidate quantity delta on shipment — discrepancy signal',
          jsonb_build_array(jsonb_build_object('delta_quantity', t.delta_quantity))
        FROM tmp_disc_cand t
        WHERE t.ship_row_id IS NOT NULL
          AND t.delta_quantity IS NOT NULL AND t.delta_quantity <> 0
          AND COALESCE(t.ship_tracking, t.op_order) IS NOT NULL`,
    },
    {
      source: "product_id",
      edge_type: "product_link",
      sql: `
        SELECT
          t.organization_id, t.id, 'product_link',
          'claim_candidate', 'claim_candidates', t.id::text,
          'product', 'products', t.resolved_product_id::text,
          'product_id', t.resolved_product_id::text,
          1.0, NULL, NULL,
          'candidate resolved product link',
          jsonb_build_array(jsonb_build_object('table', 'products', 'id', t.resolved_product_id::text))
        FROM tmp_disc_cand t
        WHERE t.resolved_product_id IS NOT NULL`,
    },
    /* ── physical-return MVP lane (trusted scanner / return_items candidates) ── */
    {
      source: "physical_return_item",
      edge_type: "source_evidence",
      sql: `
        SELECT
          t.organization_id, t.id, 'source_evidence',
          'claim_candidate', 'claim_candidates', t.id::text,
          'return_item', 'return_items', t.phys_return_item_id,
          'return_item_id', t.phys_return_item_id,
          CASE WHEN t.return_item_id_col IS NOT NULL THEN 1.0 ELSE 0.95 END,
          NULL, NULL,
          'physical return candidate anchored to scanned return item' ||
            CASE WHEN t.return_item_id_col IS NULL THEN ' (source_row_id fallback)' ELSE '' END,
          jsonb_build_array(jsonb_build_object('table', 'return_items', 'id', t.phys_return_item_id))
        FROM tmp_disc_cand t
        WHERE t.is_physical AND t.phys_return_item_id IS NOT NULL`,
    },
    {
      source: "physical_package",
      edge_type: "shipment_scope",
      sql: `
        SELECT
          t.organization_id, t.id, 'shipment_scope',
          'claim_candidate', 'claim_candidates', t.id::text,
          'package', 'packages', t.phys_pkg_id,
          'package_code', COALESCE(t.phys_pkg_code, t.phys_pkg_id),
          CASE WHEN t.package_id IS NOT NULL THEN 1.0 ELSE 0.9 END,
          NULL, NULL,
          'physical return candidate package scope',
          jsonb_build_array(jsonb_build_object('table', 'packages', 'id', t.phys_pkg_id))
        FROM tmp_disc_cand t
        WHERE t.is_physical AND t.phys_pkg_id IS NOT NULL`,
    },
    {
      source: "physical_tracking",
      edge_type: "shipment_scope",
      sql: `
        SELECT
          t.organization_id, t.id, 'shipment_scope',
          'claim_candidate', 'claim_candidates', t.id::text,
          'shipment_tracking', CASE WHEN t.phys_pkg_id IS NOT NULL THEN 'packages' END, t.phys_pkg_id,
          'tracking_number', COALESCE(t.phys_pkg_tracking, t.shipment_scope_key),
          CASE WHEN t.phys_pkg_tracking IS NOT NULL THEN 1.0 ELSE 0.9 END,
          NULL, NULL,
          'physical return candidate shipment tracking',
          '[]'::jsonb
        FROM tmp_disc_cand t
        WHERE t.is_physical AND COALESCE(t.phys_pkg_tracking, t.shipment_scope_key) IS NOT NULL`,
    },
    {
      source: "physical_evidence_note",
      edge_type: "source_evidence",
      sql: `
        SELECT
          t.organization_id, t.id, 'source_evidence',
          'claim_candidate', 'claim_candidates', t.id::text,
          CASE WHEN t.ri_photos_n > 0 THEN 'evidence' ELSE 'source_note' END,
          'return_items', t.phys_return_item_id,
          CASE WHEN t.ri_photos_n > 0 THEN 'evidence' ELSE 'scan_note' END,
          CASE WHEN t.ri_photos_n > 0 THEN t.ri_photos_n || ' photo(s)' ELSE LEFT(t.ri_notes, 120) END,
          CASE WHEN t.ri_photos_n > 0 THEN 1.0 ELSE 0.5 END,
          NULL, NULL,
          CASE WHEN t.ri_photos_n > 0
               THEN 'photo evidence on scanned return item'
               ELSE 'operator scan note (low-confidence evidence)' END,
          jsonb_build_array(jsonb_build_object('table', 'return_items', 'id', t.phys_return_item_id, 'photos', t.ri_photos_n))
        FROM tmp_disc_cand t
        WHERE t.is_physical AND t.phys_return_item_id IS NOT NULL
          AND (t.ri_photos_n > 0 OR (t.ri_notes IS NOT NULL AND TRIM(t.ri_notes) <> ''))`,
    },
    {
      source: "physical_order",
      edge_type: "order_reference",
      sql: `
        SELECT
          t.organization_id, t.id, 'order_reference',
          'claim_candidate', 'claim_candidates', t.id::text,
          'order', 'return_items', t.phys_return_item_id,
          'amazon_order_id', t.ri_order_id,
          0.9, NULL, NULL,
          'order id recorded on scanned return item',
          jsonb_build_array(jsonb_build_object('table', 'return_items', 'id', t.phys_return_item_id))
        FROM tmp_disc_cand t
        WHERE t.is_physical AND t.ri_order_id IS NOT NULL AND TRIM(t.ri_order_id) <> ''`,
    },
  ];
  return rules;
}

export type DiscoveryRunResult = {
  source: string;
  edge_type: string;
  edges: number;
  unavailable: string | null;
};

/**
 * Run discovery over an executor (pg client / pool query). Dry-run counts
 * prospective edges; apply inserts with ON CONFLICT DO NOTHING (idempotent).
 */
export async function runReferenceDiscovery(
  query: DiscoveryQueryExecutor,
  options: { apply: boolean; safetHasOrderId: boolean },
): Promise<DiscoveryRunResult[]> {
  for (const sql of DISCOVERY_SETUP_SQL) await query(sql);

  const out: DiscoveryRunResult[] = [];
  for (const rule of buildDiscoveryRules({ safetHasOrderId: options.safetHasOrderId })) {
    if (rule.unavailable) {
      out.push({ source: rule.source, edge_type: rule.edge_type, edges: 0, unavailable: rule.unavailable });
      continue;
    }
    if (options.apply) {
      const res = await query(
        `INSERT INTO public.claim_reference_edges ${DISCOVERY_EDGE_INSERT_COLS}
         ${rule.sql}
         ON CONFLICT ${DISCOVERY_CONFLICT_TARGET} DO NOTHING`,
      );
      out.push({ source: rule.source, edge_type: rule.edge_type, edges: res.rowCount ?? 0, unavailable: null });
    } else {
      const res = await query(`SELECT COUNT(*)::int AS n FROM (${rule.sql}) q`);
      out.push({
        source: rule.source,
        edge_type: rule.edge_type,
        edges: Number(res.rows[0]?.n ?? 0),
        unavailable: null,
      });
    }
  }
  return out;
}
