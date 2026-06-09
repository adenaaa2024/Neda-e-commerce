/**
 * Package-level missing expected units — persisted on `slip_contents.notes` JSON
 * (no schema migration). Physical received units stay on `return_items`.
 */

export const SLIP_MISSING_EXPECTED_TYPE = "missing_expected" as const;

export type SlipContentsMissingExpectedNotes = {
  type: typeof SLIP_MISSING_EXPECTED_TYPE;
  missing: true;
  missing_qty: number;
};

export type SlipLineExpectedVsReceived = {
  expected: number;
  received: number;
  /** Units recorded as missing expected (from notes). */
  recordedMissing: number;
  /** max(expected - received - recordedMissing, 0) */
  remainingMissing: number;
  /** received + recordedMissing >= expected */
  fullyAccounted: boolean;
  /** recordedMissing > max(0, expected - received) — received changed after mark */
  staleMissingReview: boolean;
};

function parseNotesObject(notes: unknown): Record<string, unknown> | null {
  if (notes == null) return null;
  if (typeof notes === "object" && !Array.isArray(notes)) {
    return notes as Record<string, unknown>;
  }
  if (typeof notes === "string") {
    const s = notes.trim();
    if (!s.startsWith("{")) return null;
    try {
      const o = JSON.parse(s) as unknown;
      return o && typeof o === "object" && !Array.isArray(o) ? (o as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }
  return null;
}

function truthyFlag(v: unknown): boolean {
  return v === true || v === 1 || String(v ?? "").trim().toLowerCase() === "true";
}

/** Whether notes carry any missing-expected marker (legacy `{ missing: true }` or typed). */
export function slipContentsNotesHasMissingExpected(notes: unknown): boolean {
  const o = parseNotesObject(notes);
  if (!o) return false;
  if (o.type === SLIP_MISSING_EXPECTED_TYPE) return true;
  return truthyFlag(o.missing);
}

/** Recorded missing qty from notes; legacy boolean-only → full expected when provided. */
export function slipContentsNotesRecordedMissingQty(
  notes: unknown,
  expectedQty: number,
): number {
  const o = parseNotesObject(notes);
  if (!o || !slipContentsNotesHasMissingExpected(notes)) return 0;
  const raw = o.missing_qty ?? o.missingQty ?? o.missing_quantity;
  if (raw != null && raw !== "") {
    const n = Math.floor(Number(raw));
    if (Number.isFinite(n) && n >= 0) return n;
  }
  // Legacy line-level flag from BOX intake — treat entire expected qty as missing.
  const exp = Math.max(0, Math.floor(expectedQty));
  return exp > 0 ? exp : 0;
}

export function computeSlipLineExpectedVsReceived(args: {
  expectedQty: number;
  receivedQty: number;
  notes?: unknown;
  /**
   * From `packages.manifest_data.operator_item_scan.missing_review` (preferred).
   * When defined, overrides legacy `slip_contents.notes` missing markers.
   */
  manifestRecordedMissingQty?: number;
}): SlipLineExpectedVsReceived {
  const expected = Math.max(0, Math.floor(args.expectedQty));
  const received = Math.max(0, Math.floor(args.receivedQty));
  const fromManifest = args.manifestRecordedMissingQty;
  const fromNotes = slipContentsNotesRecordedMissingQty(args.notes ?? null, expected);
  const recordedMissing = Math.min(
    expected,
    fromManifest != null ? Math.max(0, Math.floor(fromManifest)) : fromNotes,
  );
  const maxMissingAllowed = Math.max(0, expected - received);
  const staleMissingReview = recordedMissing > maxMissingAllowed;
  const effectiveRecorded = staleMissingReview ? maxMissingAllowed : recordedMissing;
  const remainingMissing = Math.max(0, expected - received - effectiveRecorded);
  const fullyAccounted = expected > 0 && received + effectiveRecorded >= expected;
  return {
    expected,
    received,
    recordedMissing: effectiveRecorded,
    remainingMissing,
    fullyAccounted,
    staleMissingReview,
  };
}

export function buildSlipContentsMissingExpectedNotes(missingQty: number): string {
  const qty = Math.max(0, Math.floor(missingQty));
  const payload: SlipContentsMissingExpectedNotes = {
    type: SLIP_MISSING_EXPECTED_TYPE,
    missing: true,
    missing_qty: qty,
  };
  return JSON.stringify(payload);
}

/** Merge additional missing units into existing notes (avoid duplicate rows). */
export function mergeSlipContentsMissingExpectedNotes(
  existingNotes: unknown,
  expectedQty: number,
  receivedQty: number,
  additionalMissingQty: number,
): { ok: true; notes: string } | { ok: false; message: string } {
  const line = computeSlipLineExpectedVsReceived({
    expectedQty,
    receivedQty,
    notes: existingNotes,
  });
  const add = Math.max(0, Math.floor(additionalMissingQty));
  if (add <= 0) {
    return { ok: false, message: "No missing units to record." };
  }
  if (add > line.remainingMissing) {
    return {
      ok: false,
      message: `Cannot mark ${add} missing — only ${line.remainingMissing} unit(s) remain unaccounted.`,
    };
  }
  const nextQty = line.recordedMissing + add;
  return { ok: true, notes: buildSlipContentsMissingExpectedNotes(nextQty) };
}

/** Human-readable counts: expected, received, missing (remaining or recorded). */
export function formatSlipLineQtySummary(line: SlipLineExpectedVsReceived): string {
  const missingDisplay =
    line.remainingMissing > 0 ? line.remainingMissing : line.recordedMissing;
  const suffix =
    line.remainingMissing === 0 && line.recordedMissing > 0 ? " (recorded)" : "";
  return `Expected ${line.expected} · Received ${line.received} · Missing ${missingDisplay}${suffix}`;
}
