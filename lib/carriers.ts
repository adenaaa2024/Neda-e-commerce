/**
 * Shared shipping-carrier list — keep in sync with the Returns CreatePalletModal combobox.
 * Use this list anywhere the operator picks a carrier so options stay consistent across surfaces.
 *
 * SCAC = Standard Carrier Alpha Code (4-letter NMFTA code) — operators commonly identify LTL
 * shipments by SCAC printed on the BOL, so we surface it for searchability.
 */
export type CarrierEntry = {
  /** Persisted display name — what we save into `pallets.carrier_name` / `packages.carrier_name`. */
  name: string;
  /** Optional SCAC code; null for parcel carriers without a single canonical SCAC. */
  scac: string | null;
};

/** Sentinel name for the "I'll type a custom carrier" option. Operators see this label
 *  in the dropdown; when chosen, the form requires a manual text entry, and that typed
 *  value is what actually gets persisted into `pallets.carrier_name`. */
export const OTHER_CARRIER_NAME = "Other / Not Listed";

export const CARRIER_ENTRIES: CarrierEntry[] = [
  // Parcel
  { name: "UPS", scac: "UPSN" },
  { name: "FedEx", scac: "FDXG" },
  { name: "USPS", scac: "USPS" },
  { name: "DHL", scac: "DHLC" },
  { name: "OnTrac", scac: "OTNL" },
  { name: "Amazon Logistics", scac: null },
  // Major US LTL carriers (added per operator request).
  // SCAC codes are surfaced so the operator can search by the 4-letter code printed on the BOL.
  { name: "Estes", scac: "EXLA" },
  { name: "Old Dominion", scac: "ODFL" },
  { name: "Saia", scac: "SAIA" },
  { name: "XPO", scac: "XPO" },
  { name: "FedEx Freight", scac: "FXFE" },
  { name: "TForce", scac: "THTE" },
  { name: "ABF", scac: "ABFS" },
  { name: "Yellow", scac: "YRCW" },
  // Catch-all — selecting this prompts the operator for a manual carrier name.
  { name: OTHER_CARRIER_NAME, scac: null },
];

/** Carriers that the user can search for by name/SCAC (excludes the catch-all). */
export const KNOWN_CARRIER_ENTRIES = CARRIER_ENTRIES.filter((e) => e.name !== OTHER_CARRIER_NAME);

/** Display-name list (for plain `<select>` dropdowns). */
export const CARRIERS = CARRIER_ENTRIES.map((e) => e.name);

export type CarrierName = (typeof CARRIER_ENTRIES)[number]["name"];

/**
 * Map a free-form OCR string (or operator-typed value, including a SCAC code) to a known carrier
 * name when possible. Recognizes:
 *   • exact / substring match on the canonical name (case-insensitive)
 *   • exact match on the SCAC code (case-insensitive)
 * Returns {@link OTHER_CARRIER_NAME} for non-empty strings that don't match any known carrier,
 * and null for empty input.
 */
export function normalizeCarrierLabel(raw: string | null | undefined): string | null {
  const t = String(raw ?? "").trim();
  if (!t) return null;
  const lower = t.toLowerCase();
  // SCAC match wins over substring name match (more specific signal from BOL/OCR).
  for (const entry of CARRIER_ENTRIES) {
    if (entry.scac && entry.scac.toLowerCase() === lower) return entry.name;
  }
  for (const entry of CARRIER_ENTRIES) {
    if (entry.name === OTHER_CARRIER_NAME) continue;
    if (lower.includes(entry.name.toLowerCase())) return entry.name;
  }
  return OTHER_CARRIER_NAME;
}

/** Returns true when the value is a known canonical carrier (i.e. lives in the list and is not the catch-all). */
export function isKnownCarrierName(value: string | null | undefined): boolean {
  const t = String(value ?? "").trim();
  if (!t) return false;
  return KNOWN_CARRIER_ENTRIES.some((e) => e.name === t);
}
