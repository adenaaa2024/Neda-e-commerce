/**
 * PHASE-CLAIM-REMOVAL-ORIGIN-REASON-UI-SURFACE-V1 — server-side, READ-ONLY.
 *
 * Resolves the "why this claim exists" inputs (origin sources, event age, expected
 * vs received/scanned qty, scanner-receipt status, build_status) for the pilot
 * removal claims, batched across expected_packages / amazon_removals /
 * amazon_removal_shipments / packages / return_items. SELECT-only; no DB writes,
 * no claim mutation, no Amazon, no scanner change, no claim math.
 *
 * The presentation (validity, compact reason, badges) is computed by the pure
 * client-safe `computeRemovalOriginReason` in the UI contract from these inputs.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import type {
  ReadyToFileRow,
  RemovalOriginInputs,
} from "./claim-ready-to-file-queue-ui-contract";

type Row = Record<string, unknown>;

function str(v: unknown): string | null {
  const s = String(v ?? "").trim();
  return s || null;
}
function intOrNull(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? n : null;
}
function ageDays(iso: string | null): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return Math.floor((Date.now() - t) / (24 * 60 * 60 * 1000));
}
function uniq(values: Array<string | null>): string[] {
  return [...new Set(values.filter((v): v is string => !!v))];
}

/**
 * Batch-resolve removal-origin inputs for all rows. Returns a Map keyed by
 * claim_submission_id. Only removal-family rows are populated.
 */
export async function loadRemovalOriginInputsForRows(
  client: SupabaseClient,
  organizationId: string,
  rows: ReadyToFileRow[],
  thresholdDays: number,
  thresholdSource: string,
): Promise<Map<string, RemovalOriginInputs>> {
  const out = new Map<string, RemovalOriginInputs>();
  const removalRows = rows.filter(
    (r) => r.claim_family === "removal_shipment_missing" || r.claim_family === "removal_order_discrepancy",
  );
  if (removalRows.length === 0) return out;

  const epIdByRow = new Map<string, string | null>();
  for (const r of removalRows) {
    epIdByRow.set(r.claim_submission_id, r.reference_health.expected_package_id ?? r.packet.expected_package_id ?? null);
  }

  // 1) expected_packages by id.
  const epIds = uniq([...epIdByRow.values()]);
  const epById = new Map<string, Row>();
  if (epIds.length > 0) {
    const { data } = await client
      .from("expected_packages")
      .select(
        "id, order_id, sku, fnsku, tracking_number, expected_scan_quantity, actual_scanned_count, discrepancy_found, shipment_date, build_status, source_detail_row_id, source_shipment_row_id, allocated_package_id",
      )
      .eq("organization_id", organizationId)
      .in("id", epIds);
    for (const row of ((data ?? []) as Row[])) epById.set(String(row.id), row);
  }

  // Resolve per-row order id + tracking from row/EP.
  const orderIdByRow = new Map<string, string | null>();
  const trackingByRow = new Map<string, string | null>();
  for (const r of removalRows) {
    const ep = epById.get(epIdByRow.get(r.claim_submission_id) ?? "") ?? null;
    orderIdByRow.set(r.claim_submission_id, r.removal_order_id ?? (ep ? str(ep.order_id) : null));
    trackingByRow.set(
      r.claim_submission_id,
      (ep ? str(ep.tracking_number) : null) ?? r.removal_shipment_id ?? null,
    );
  }

  // 2) amazon_removals by order_id (grouped).
  const orderIds = uniq([...orderIdByRow.values()]);
  const removalsByOrder = new Map<string, Row[]>();
  const shipmentsByOrder = new Map<string, Row[]>();
  if (orderIds.length > 0) {
    const [{ data: rem }, { data: ship }] = await Promise.all([
      client
        .from("amazon_removals")
        .select(
          "id, order_id, sku, fnsku, requested_quantity, shipped_quantity, disposed_quantity, cancelled_quantity, in_process_quantity, status, order_date, tracking_number",
        )
        .eq("organization_id", organizationId)
        .in("order_id", orderIds),
      client
        .from("amazon_removal_shipments")
        .select("id, order_id, sku, fnsku, shipment_date, shipped_quantity, tracking_number, carrier")
        .eq("organization_id", organizationId)
        .in("order_id", orderIds),
    ]);
    for (const row of ((rem ?? []) as Row[])) {
      const k = str(row.order_id) ?? "";
      const arr = removalsByOrder.get(k) ?? [];
      arr.push(row);
      removalsByOrder.set(k, arr);
    }
    for (const row of ((ship ?? []) as Row[])) {
      const k = str(row.order_id) ?? "";
      const arr = shipmentsByOrder.get(k) ?? [];
      arr.push(row);
      shipmentsByOrder.set(k, arr);
    }
  }

  // 3) packages by tracking (received evidence) + allocated package ids.
  const trackings = uniq([...trackingByRow.values()]);
  const receivedTracking = new Set<string>();
  const packageIdByTracking = new Map<string, string>();
  if (trackings.length > 0) {
    for (let i = 0; i < trackings.length; i += 100) {
      const chunk = trackings.slice(i, i + 100);
      const { data } = await client
        .from("packages")
        .select("id, tracking_number")
        .eq("organization_id", organizationId)
        .in("tracking_number", chunk)
        .is("deleted_at", null);
      for (const row of ((data ?? []) as Row[])) {
        const t = str(row.tracking_number);
        if (t) {
          receivedTracking.add(t);
          if (!packageIdByTracking.has(t)) packageIdByTracking.set(t, String(row.id));
        }
      }
    }
  }

  // 4) return_items scanned units by package_id (allocated EP package + tracking-matched package).
  const packageIds = uniq([
    ...removalRows.map((r) => {
      const ep = epById.get(epIdByRow.get(r.claim_submission_id) ?? "") ?? null;
      return ep ? str(ep.allocated_package_id) : null;
    }),
    ...[...trackingByRow.values()].map((t) => (t ? packageIdByTracking.get(t) ?? null : null)),
  ]);
  const scannedByPackage = new Map<string, number>();
  if (packageIds.length > 0) {
    for (let i = 0; i < packageIds.length; i += 100) {
      const chunk = packageIds.slice(i, i + 100);
      const { data } = await client
        .from("return_items")
        .select("package_id, scanned_quantity")
        .eq("organization_id", organizationId)
        .in("package_id", chunk)
        .is("deleted_at", null);
      for (const row of ((data ?? []) as Row[])) {
        const pid = str(row.package_id);
        if (!pid) continue;
        scannedByPackage.set(pid, (scannedByPackage.get(pid) ?? 0) + (intOrNull(row.scanned_quantity) ?? 0));
      }
    }
  }

  // ---- Assemble per row ----
  for (const r of removalRows) {
    const subId = r.claim_submission_id;
    const epId = epIdByRow.get(subId) ?? null;
    const ep = epId ? (epById.get(epId) ?? null) : null;
    const orderId = orderIdByRow.get(subId) ?? null;
    const tracking = trackingByRow.get(subId) ?? null;

    const pickByProduct = (list: Row[] | undefined): Row | null => {
      if (!list || list.length === 0) return null;
      if (r.fnsku) {
        const m = list.find((x) => str(x.fnsku) === r.fnsku);
        if (m) return m;
      }
      if (r.sku) {
        const m = list.find((x) => str(x.sku) === r.sku);
        if (m) return m;
      }
      return list[0];
    };
    const removal = pickByProduct(removalsByOrder.get(orderId ?? ""));
    const shipmentList = shipmentsByOrder.get(orderId ?? "");
    const shipment =
      (tracking && shipmentList ? shipmentList.find((x) => str(x.tracking_number) === tracking) : null) ??
      pickByProduct(shipmentList);

    const shipmentDate =
      (ep ? str(ep.shipment_date) : null) ?? (shipment ? str(shipment.shipment_date) : null);
    const removalOrderDate = removal ? str(removal.order_date) : null;
    const eventDate = shipmentDate ?? removalOrderDate ?? null;

    const epExpected = ep ? intOrNull(ep.expected_scan_quantity) : null;
    const epScanned = ep ? intOrNull(ep.actual_scanned_count) : null;
    const allocatedPackageId = ep ? str(ep.allocated_package_id) : null;
    const trackingPackageId = tracking ? packageIdByTracking.get(tracking) ?? null : null;
    const scannedUnits =
      (allocatedPackageId ? scannedByPackage.get(allocatedPackageId) ?? 0 : 0) +
      (trackingPackageId && trackingPackageId !== allocatedPackageId
        ? scannedByPackage.get(trackingPackageId) ?? 0
        : 0);
    const packageReceived = (tracking != null && receivedTracking.has(tracking)) || scannedUnits > 0;
    const receivedQty = epScanned != null ? epScanned : scannedUnits;

    out.set(subId, {
      from_removal_shipment_detail:
        Boolean(r.removal_shipment_id) || Boolean(ep && str(ep.source_shipment_row_id)) || Boolean(shipment),
      from_removal_order_detail:
        Boolean(r.removal_order_id) || Boolean(ep && str(ep.source_detail_row_id)) || Boolean(removal),
      from_expected_packages: Boolean(ep) || epId != null,
      tracking,
      removal_order_id: r.removal_order_id ?? orderId,
      removal_shipment_id: r.removal_shipment_id,
      expected_package_id: epId,
      event_date: eventDate,
      event_age_days: ageDays(eventDate),
      threshold_days: thresholdDays,
      threshold_source: thresholdSource,
      expected_qty: epExpected ?? r.clean_quantity ?? null,
      received_qty: receivedQty,
      build_status: ep ? str(ep.build_status) : null,
      package_received: packageReceived,
      scanned_units: scannedUnits,
    });
  }

  return out;
}
