/**
 * Normalize BOX slip vision line identifiers for resolver + `slip_contents.parsed_*` persistence.
 * Keeps FNSKU and B0… ASIN separate (no cross-fallback between columns).
 */

const AMAZON_ASIN_RE = /^B0[0-9A-Z]{8}$/i;

function trimOrNull(v: unknown): string | null {
  const s = String(v ?? "").trim();
  return s || null;
}

export type SlipVisionLineIdentifierFields = {
  resolverFnsku: string | null;
  resolverAsin: string | null;
  resolverUpc: string | null;
  parsed_fnsku: string | null;
  parsed_asin: string | null;
  parsed_upc: string | null;
};

export function slipVisionLineIdentifierFields(line: {
  upc?: string | null;
  fnsku?: string | null;
  printed_asin?: string | null;
}): SlipVisionLineIdentifierFields {
  const upc = trimOrNull(line.upc);
  const rawFnsku = trimOrNull(line.fnsku);
  const rawPrinted = trimOrNull(line.printed_asin);

  const fnskuIsAsin = rawFnsku ? AMAZON_ASIN_RE.test(rawFnsku) : false;
  const printedIsAsin = rawPrinted ? AMAZON_ASIN_RE.test(rawPrinted) : false;

  const parsed_asin =
    (rawPrinted && printedIsAsin ? rawPrinted.toUpperCase() : null) ??
    (rawFnsku && fnskuIsAsin ? rawFnsku.toUpperCase() : null);

  const parsed_fnsku = rawFnsku && !fnskuIsAsin ? rawFnsku : null;
  const parsed_upc = upc;

  return {
    resolverFnsku: parsed_fnsku,
    resolverAsin: parsed_asin,
    resolverUpc: parsed_upc,
    parsed_fnsku,
    parsed_asin,
    parsed_upc,
  };
}
