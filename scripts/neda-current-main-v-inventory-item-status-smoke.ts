/**
 * Current-main Neda smoke: prove scanner lookup uses staging v_inventory_item_status rows.
 */
import {
  SAM_ORG_ID,
  SAM_STORE_ID,
  stagingSupabase,
} from "./lib/neda-read-model-smoke-v181";
import {
  aggregateInventoryStatus,
  fetchVInventoryItemStatusLinesExact,
  resolveInventoryGateVisualStatus,
  type InventoryViewMatchField,
} from "../lib/scanner/v-inventory-status";
import {
  isShipmentEntryOffManifest,
  lookupShipmentEntryScanCode,
} from "../lib/scanner/shipment-entry-lookup";

const CANDIDATE_FIELDS: InventoryViewMatchField[] = [
  "tracking_number",
  "fnsku",
  "sku",
  "id_slip_contents",
];

async function main() {
  const { client, detail } = stagingSupabase();
  if (!client) throw new Error(detail);

  const { data, error } = await client
    .from("v_inventory_item_status")
    .select("*")
    .eq("organization_id", SAM_ORG_ID)
    .eq("store_id", SAM_STORE_ID)
    .not("tracking_number", "is", null)
    .limit(10);
  if (error) throw error;

  const rows = Array.isArray(data) ? data : [];
  const sample = rows.find((row) =>
    CANDIDATE_FIELDS.some((field) => String((row as Record<string, unknown>)[field] ?? "").trim()),
  );
  if (!sample) throw new Error("No staging v_inventory_item_status sample found for Sam org/store.");

  const sampleRecord = sample as Record<string, unknown>;
  const field =
    CANDIDATE_FIELDS.find((candidate) => String(sampleRecord[candidate] ?? "").trim()) ?? "tracking_number";
  const code = String(sampleRecord[field] ?? "").trim();

  const exact = await fetchVInventoryItemStatusLinesExact(client, SAM_ORG_ID, SAM_STORE_ID, field, code);
  const agg = aggregateInventoryStatus(exact.rows);
  const exactVisual = resolveInventoryGateVisualStatus(exact.rows, agg);
  const gate = await lookupShipmentEntryScanCode(client, SAM_ORG_ID, SAM_STORE_ID, code);
  const gateOffManifest = isShipmentEntryOffManifest(gate);

  const result = {
    ok: exact.rows.length > 0 && gate.inventory_rows.length > 0 && !gateOffManifest,
    staging: detail,
    route: "/scanner/operator-mobile/scan",
    source_view: "v_inventory_item_status",
    sample: { field, code },
    exact_rows: exact.rows.length,
    exact_visual: exactVisual,
    gate_rows: gate.inventory_rows.length,
    gate_matched_field: gate.inventory_matched_field,
    gate_visual: gate.inventory_visual,
    gate_off_manifest: gateOffManifest,
  };

  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
