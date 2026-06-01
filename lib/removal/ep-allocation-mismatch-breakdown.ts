import type pg from "pg";

export type EpAllocationMismatchBreakdown = {
  total: number;
  overflow: number;
  non_overflow: number;
};

export async function queryEpAllocationMismatchBreakdown(
  client: pg.Client,
  organizationId: string,
  storeId: string,
): Promise<EpAllocationMismatchBreakdown> {
  const colQ = await client.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema='public' AND table_name='amazon_removal_shipments'`,
  );
  const shipmentHasDisposition = (colQ.rows as Array<{ column_name: string }>).some(
    (x) => x.column_name === "disposition",
  );
  const shipDispositionSel = shipmentHasDisposition
    ? "nullif(btrim(s.disposition), '') AS disposition"
    : "NULL::text AS disposition";
  const dispositionJoin = shipmentHasDisposition
    ? "AND s.disposition IS NOT DISTINCT FROM d.disposition"
    : "";

  const r = await client.query(
    `
    WITH detail AS (
      SELECT d.id AS detail_id, COALESCE(d.shipped_quantity,0) AS detail_shipped_qty,
        d.organization_id, d.store_id, d.order_id, d.order_type, d.order_date,
        nullif(btrim(d.sku),'') AS sku, nullif(btrim(d.fnsku),'') AS fnsku, nullif(btrim(d.disposition),'') AS disposition
      FROM public.amazon_removals d
      WHERE d.organization_id=$1::uuid AND d.store_id=$2::uuid AND d.order_id IS NOT NULL
    ),
    shipment AS (
      SELECT s.id AS shipment_id, s.organization_id, s.store_id, s.order_id, s.order_type, s.order_date,
        nullif(btrim(s.sku),'') AS sku, nullif(btrim(s.fnsku),'') AS fnsku, ${shipDispositionSel},
        COALESCE(s.shipped_quantity,0) AS shipment_shipped_qty
      FROM public.amazon_removal_shipments s
      WHERE s.organization_id=$1::uuid AND s.store_id=$2::uuid
    ),
    pair AS (
      SELECT d.detail_id, d.detail_shipped_qty, s.shipment_id, s.shipment_shipped_qty
      FROM detail d LEFT JOIN shipment s
        ON s.organization_id=d.organization_id AND s.store_id IS NOT DISTINCT FROM d.store_id
       AND s.order_id IS NOT DISTINCT FROM d.order_id AND s.order_type IS NOT DISTINCT FROM d.order_type
       AND s.order_date IS NOT DISTINCT FROM d.order_date AND s.sku IS NOT DISTINCT FROM d.sku
       AND s.fnsku IS NOT DISTINCT FROM d.fnsku ${dispositionJoin}
    ),
    agg AS (
      SELECT detail_id, max(detail_shipped_qty) AS detail_total,
        sum(COALESCE(shipment_shipped_qty,0)) FILTER (WHERE shipment_id IS NOT NULL) AS shipment_total,
        count(*) FILTER (WHERE shipment_id IS NOT NULL) AS shipment_count
      FROM pair GROUP BY detail_id
    ),
    matched_emitted AS (
      SELECT p.detail_id, p.shipment_shipped_qty AS qty FROM pair p JOIN agg a USING (detail_id) WHERE p.shipment_id IS NOT NULL
    ),
    remainder_emitted AS (
      SELECT DISTINCT ON (p.detail_id) p.detail_id,
        GREATEST(a.detail_total - COALESCE(a.shipment_total,0),0)::int AS qty
      FROM pair p JOIN agg a USING (detail_id)
      WHERE COALESCE(a.shipment_count,0)=0 OR a.detail_total > COALESCE(a.shipment_total,0)
      ORDER BY p.detail_id
    ),
    emitted AS (
      SELECT detail_id, qty FROM matched_emitted
      UNION ALL SELECT detail_id, qty FROM remainder_emitted
    ),
    sim AS (SELECT detail_id, sum(qty)::int AS sim_sum FROM emitted GROUP BY 1),
    live AS (
      SELECT source_detail_row_id AS detail_id, sum(expected_scan_quantity)::int AS live_sum
      FROM public.expected_packages
      WHERE organization_id=$1::uuid AND store_id=$2::uuid
        AND build_source IN ('detail_shipment','detail_remainder')
      GROUP BY 1
    )
    SELECT count(*)::int AS total_mismatch,
      count(*) FILTER (WHERE a.shipment_total > a.detail_total)::int AS overflow_mismatch,
      count(*) FILTER (WHERE NOT (a.shipment_total > a.detail_total))::int AS non_overflow_mismatch
    FROM sim FULL OUTER JOIN live USING (detail_id)
    JOIN agg a ON a.detail_id = COALESCE(sim.detail_id, live.detail_id)
    WHERE COALESCE(sim_sum,-1) <> COALESCE(live_sum,-2)
    `,
    [organizationId, storeId],
  );

  const row = r.rows[0] as {
    total_mismatch: number;
    overflow_mismatch: number;
    non_overflow_mismatch: number;
  };
  return {
    total: row.total_mismatch,
    overflow: row.overflow_mismatch,
    non_overflow: row.non_overflow_mismatch,
  };
}

/** Gate: rebuild_valid when non-overflow mismatches are zero (overflow drift allowed). */
export function rebuildValidFromBreakdown(breakdown: EpAllocationMismatchBreakdown): boolean {
  return breakdown.non_overflow === 0;
}
