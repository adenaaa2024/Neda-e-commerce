/**
 * Case-insensitive, whitespace-insensitive tracking comparison for scans vs DB values.
 */
export function normalizeTrackingKey(raw: string | null | undefined): string {
  return String(raw ?? "")
    .replace(/\s+/g, "")
    .trim()
    .toLowerCase();
}

export function trackingKeysEqual(a: string | null | undefined, b: string | null | undefined): boolean {
  return normalizeTrackingKey(a) === normalizeTrackingKey(b);
}

/**
 * Build deduped lookup strings for slip/shipment IDs (trim + whitespace collapsed).
 * Used when querying `expected_packages.tracking_number` so values like
 * `VRET 7623723875531` and `VRET7623723875531` both attempt a fetch; row matching
 * still uses {@link normalizeTrackingKey} for case-insensitive comparison.
 */
export function slipIdLookupCandidates(...parts: (string | null | undefined)[]): string[] {
  const set = new Set<string>();
  for (const p of parts) {
    const t = String(p ?? "").trim();
    if (!t) continue;
    set.add(t);
    const collapsed = t.replace(/\s+/g, "");
    if (collapsed) set.add(collapsed);
  }
  return [...set];
}
