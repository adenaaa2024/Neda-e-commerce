/**
 * Box-level empty flag — stored in `packages.manifest_data.operator_item_scan.empty_box`.
 * No schema migration; physical items remain on `return_items`.
 */

export const PACKAGE_EMPTY_BOX_MANIFEST_KEY = "operator_item_scan" as const;

export type PackageItemScanEvidenceRefs = {
  outside_photo_urls?: string[];
  inside_photo_urls?: string[];
  slip_photo_urls?: string[];
};

export type PackageEmptyBoxManifest = {
  empty_box: {
    value: true;
    marked_by: string;
    marked_at: string;
    expected_qty: number;
    scanned_qty: number;
    note?: string | null;
  };
};

export type PackageEmptyBoxValue = PackageEmptyBoxManifest["empty_box"];

export type PackageItemScanFinalizeManifest = {
  empty_box?: PackageEmptyBoxValue | true;
  receive_state?: "open" | "finalized";
  finalized_at: string;
  evidence_refs?: PackageItemScanEvidenceRefs;
  box_review_confirmed?: {
    confirmed_at: string;
    confirmed_by: string | null;
    bucket_counts: Record<string, number>;
    critical_issues_acknowledged: boolean;
    audit_note: string | null;
    totals: {
      slip_units: number;
      shipment_expected_units: number;
      scanned_units: number;
      off_manifest_units: number;
    };
  };
  [key: string]: unknown;
};

function parseManifestObject(raw: unknown): Record<string, unknown> {
  if (raw == null) return {};
  if (typeof raw === "object" && !Array.isArray(raw)) return { ...(raw as Record<string, unknown>) };
  if (typeof raw === "string") {
    const s = raw.trim();
    if (!s.startsWith("{")) return {};
    try {
      const o = JSON.parse(s) as unknown;
      return o && typeof o === "object" && !Array.isArray(o) ? (o as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  return {};
}

function emptyBoxTruthy(raw: unknown): boolean {
  if (raw === true || raw === 1 || String(raw ?? "").trim().toLowerCase() === "true") return true;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const o = raw as Record<string, unknown>;
    return (
      o.value === true ||
      o.value === 1 ||
      String(o.value ?? "").trim().toLowerCase() === "true"
    );
  }
  return false;
}

export function packageManifestHasEmptyBox(raw: unknown): boolean {
  const md = parseManifestObject(raw);
  const block = md[PACKAGE_EMPTY_BOX_MANIFEST_KEY];
  if (!block || typeof block !== "object" || Array.isArray(block)) return false;
  const o = block as Record<string, unknown>;
  return emptyBoxTruthy(o.empty_box);
}

/** Box intake — operator marked no packing slip (stored on `manifest_data.no_packing_slip`). */
export function packageManifestHasNoPackingSlip(raw: unknown): boolean {
  const md = parseManifestObject(raw);
  return md.no_packing_slip === true;
}

export type BoxIntakeManifestFlags = {
  empty_box: boolean;
  no_packing_slip: boolean;
};

export function readBoxIntakeManifestFlags(raw: unknown): BoxIntakeManifestFlags {
  return {
    empty_box: packageManifestHasEmptyBox(raw),
    no_packing_slip: packageManifestHasNoPackingSlip(raw),
  };
}

function priorOperatorItemScanBlock(existingManifest: unknown): Record<string, unknown> {
  const md = parseManifestObject(existingManifest);
  const block = md[PACKAGE_EMPTY_BOX_MANIFEST_KEY];
  if (block && typeof block === "object" && !Array.isArray(block)) {
    return { ...(block as Record<string, unknown>) };
  }
  return {};
}

export function mergePackageManifestEmptyBox(
  existingManifest: unknown,
  args: {
    markedAtIso: string;
    markedBy: string;
    expectedQty: number;
    scannedQty: number;
    note?: string | null;
  },
): Record<string, unknown> {
  const md = parseManifestObject(existingManifest);
  const prior = priorOperatorItemScanBlock(existingManifest);
  return {
    ...md,
    [PACKAGE_EMPTY_BOX_MANIFEST_KEY]: {
      ...prior,
      empty_box: {
        value: true,
        marked_by: args.markedBy,
        marked_at: args.markedAtIso,
        expected_qty: Math.max(0, Math.floor(args.expectedQty)),
        scanned_qty: Math.max(0, Math.floor(args.scannedQty)),
        note: args.note ?? null,
      },
    } satisfies PackageEmptyBoxManifest,
  };
}

/** Item-scan finalize — records close timestamp, optional empty_box, evidence URL refs, box review snapshot. */
export function mergePackageManifestItemScanFinalize(
  existingManifest: unknown,
  args: {
    finalizedAtIso: string;
    emptyBox?: boolean;
    emptyBoxMarkedAtIso?: string | null;
    evidenceRefs?: PackageItemScanEvidenceRefs | null;
    boxReviewConfirmed?: PackageItemScanFinalizeManifest["box_review_confirmed"];
  },
): Record<string, unknown> {
  const md = parseManifestObject(existingManifest);
  const prior = priorOperatorItemScanBlock(existingManifest);
  const hadEmptyBox = packageManifestHasEmptyBox(existingManifest);
  const emptyBox = Boolean(args.emptyBox) || hadEmptyBox;

  const block: PackageItemScanFinalizeManifest = {
    ...prior,
    receive_state: "finalized",
    finalized_at: args.finalizedAtIso,
  };

  if (emptyBox) {
    const priorEmpty = prior.empty_box;
    const markedAt =
      String(args.emptyBoxMarkedAtIso ?? "").trim() ||
      (priorEmpty && typeof priorEmpty === "object" && !Array.isArray(priorEmpty)
        ? String((priorEmpty as Record<string, unknown>).marked_at ?? "").trim()
        : "") ||
      args.finalizedAtIso;
    const markedBy =
      priorEmpty && typeof priorEmpty === "object" && !Array.isArray(priorEmpty)
        ? String((priorEmpty as Record<string, unknown>).marked_by ?? "").trim()
        : "";
    block.empty_box = {
      value: true,
      marked_by: markedBy || "system",
      marked_at: markedAt,
      expected_qty: Math.max(
        0,
        Math.floor(
          Number(
            priorEmpty && typeof priorEmpty === "object" && !Array.isArray(priorEmpty)
              ? (priorEmpty as Record<string, unknown>).expected_qty ?? 0
              : 0,
          ),
        ),
      ),
      scanned_qty: Math.max(
        0,
        Math.floor(
          Number(
            priorEmpty && typeof priorEmpty === "object" && !Array.isArray(priorEmpty)
              ? (priorEmpty as Record<string, unknown>).scanned_qty ?? 0
              : 0,
          ),
        ),
      ),
      note:
        priorEmpty && typeof priorEmpty === "object" && !Array.isArray(priorEmpty)
          ? String((priorEmpty as Record<string, unknown>).note ?? "").trim() || null
          : null,
    };
  }

  const refs = args.evidenceRefs;
  if (refs) {
    const evidence_refs: PackageItemScanEvidenceRefs = {};
    const outside = (refs.outside_photo_urls ?? []).map((u) => String(u ?? "").trim()).filter(Boolean);
    const inside = (refs.inside_photo_urls ?? []).map((u) => String(u ?? "").trim()).filter(Boolean);
    const slip = (refs.slip_photo_urls ?? []).map((u) => String(u ?? "").trim()).filter(Boolean);
    if (outside.length) evidence_refs.outside_photo_urls = outside;
    if (inside.length) evidence_refs.inside_photo_urls = inside;
    if (slip.length) evidence_refs.slip_photo_urls = slip;
    if (Object.keys(evidence_refs).length > 0) block.evidence_refs = evidence_refs;
  }

  if (args.boxReviewConfirmed) {
    block.box_review_confirmed = args.boxReviewConfirmed;
  }

  return {
    ...md,
    [PACKAGE_EMPTY_BOX_MANIFEST_KEY]: block,
  };
}
