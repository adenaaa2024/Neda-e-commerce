/**
 * Known Amazon **retail** marketplace identifiers (SP-API Catalog / Pricing).
 * Used to avoid querying bogus marketplace strings and to align store ↔ credentials.
 *
 * @see https://developer-docs.amazon.com/sp-api/docs/marketplace-ids
 */
export const AMAZON_RETAIL_MARKETPLACE_IDS = new Set<string>([
  "A2EUQ1WTGCTBG2", // CA
  "ATVPDKIKX0DER", // US
  "A1AM78C64UM0Y8", // MX
  "A1F83G8C2ARU7P", // UK
  "A1PA6795UKMFR9", // DE
  "A1RKKUPIHCS9HS", // ES
  "A13V1IB3VIYZZH", // FR
  "APJ6JRA9NG5V4", // IT
  "A1805IZSGTT6HS", // NL
  "A2NODRKZQL88X9", // SE
  "A1C3SOZRARQ6R2", // PL
  "AMEN7PMS3EDWL", // BE
  "A33AVAJ2PDY3EV", // TR
  "A17E79C6D8DWN8", // SA
  "A2VIGQ35RCS4UG", // AE
  "A1VC38T7YXB528", // JP
  "A39IBJ37TRP1C6", // AU
  "A19VAU5U5O7RUS", // SG
  "A21TJRUUN4KGV", // IN
  "A2Q3Y263D00KWC", // BR
]);

export function isAmazonRetailMarketplaceId(id: string): boolean {
  const s = id.trim().toUpperCase();
  return s.length > 0 && AMAZON_RETAIL_MARKETPLACE_IDS.has(s);
}

/** Keep order; drop unknown / empty strings. */
export function filterValidAmazonRetailMarketplaceIds(ids: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of ids) {
    const id = String(raw ?? "").trim().toUpperCase();
    if (!id || seen.has(id)) continue;
    if (!isAmazonRetailMarketplaceId(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * Prefer the store's marketplace when it appears in the credential list; otherwise first valid id.
 * Returns null when there is no safe marketplace (caller should skip pricing / avoid invalid queries).
 */
export function pickPrimaryAmazonRetailMarketplaceId(params: {
  storeMarketplaceId: string | null | undefined;
  credentialMarketplaceIds: string[];
}): string | null {
  const credValid = filterValidAmazonRetailMarketplaceIds(params.credentialMarketplaceIds);
  const store = String(params.storeMarketplaceId ?? "").trim().toUpperCase();
  if (store && isAmazonRetailMarketplaceId(store) && credValid.includes(store)) return store;
  if (credValid.length) return credValid[0]!;
  if (store && isAmazonRetailMarketplaceId(store)) return store;
  return null;
}
