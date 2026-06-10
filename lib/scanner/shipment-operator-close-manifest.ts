/**
 * Phase 6E — Shipment receive close / reopen on existing JSONB (no new tables).
 * Primary: `pallets.photo_evidence.operator_shipment_receive_close`
 * Fallback (no pallet): `packages.manifest_data.operator_shipment_receive_close`
 * Missing quantities remain review metadata only — no claim records created here.
 */

import type { ShipmentCloseReviewSnapshot } from "@/lib/scanner/shipment-close-review";

export const SHIPMENT_OPERATOR_CLOSE_MANIFEST_KEY = "operator_shipment_receive_close" as const;

export type ShipmentCloseState = "open" | "finalized";

export type ShipmentCloseStorageKind = "pallet_photo_evidence" | "package_manifest_data";

export type ShipmentOperatorCloseManifest = {
  close_state: ShipmentCloseState;
  tracking_number: string;
  store_id: string;
  anchor_pallet_id: string | null;
  anchor_package_id: string | null;
  storage_kind: ShipmentCloseStorageKind;
  finalized_at: string | null;
  finalized_by: string | null;
  reopened_at: string | null;
  reopened_by: string | null;
  close_revision: number;
  review_confirmed?: ShipmentCloseReviewSnapshot;
  [key: string]: unknown;
};

function parseJsonObject(raw: unknown): Record<string, unknown> {
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

function readCloseBlock(raw: unknown): ShipmentOperatorCloseManifest | null {
  const root = parseJsonObject(raw);
  const block = root[SHIPMENT_OPERATOR_CLOSE_MANIFEST_KEY];
  if (!block || typeof block !== "object" || Array.isArray(block)) return null;
  const o = block as Record<string, unknown>;
  const close_state = o.close_state === "finalized" ? "finalized" : "open";
  const storage_kind =
    o.storage_kind === "package_manifest_data" ? "package_manifest_data" : "pallet_photo_evidence";
  return {
    close_state,
    tracking_number: typeof o.tracking_number === "string" ? o.tracking_number : "",
    store_id: typeof o.store_id === "string" ? o.store_id : "",
    anchor_pallet_id: typeof o.anchor_pallet_id === "string" ? o.anchor_pallet_id : null,
    anchor_package_id: typeof o.anchor_package_id === "string" ? o.anchor_package_id : null,
    storage_kind,
    finalized_at: typeof o.finalized_at === "string" ? o.finalized_at : null,
    finalized_by: typeof o.finalized_by === "string" ? o.finalized_by : null,
    reopened_at: typeof o.reopened_at === "string" ? o.reopened_at : null,
    reopened_by: typeof o.reopened_by === "string" ? o.reopened_by : null,
    close_revision: Math.max(0, Math.floor(Number(o.close_revision ?? 0))),
    review_confirmed:
      o.review_confirmed && typeof o.review_confirmed === "object" && !Array.isArray(o.review_confirmed)
        ? (o.review_confirmed as ShipmentCloseReviewSnapshot)
        : undefined,
  };
}

export function readShipmentCloseFromPalletPhotoEvidence(
  rawPhotoEvidence: unknown,
  trackingNumber: string,
): { close_state: ShipmentCloseState; manifest: ShipmentOperatorCloseManifest | null } {
  const manifest = readCloseBlock(rawPhotoEvidence);
  const tn = String(trackingNumber ?? "").trim();
  if (!manifest || !tn) return { close_state: "open", manifest: null };
  if (manifest.tracking_number.trim() !== tn) return { close_state: "open", manifest: null };
  return {
    close_state: manifest.close_state === "finalized" ? "finalized" : "open",
    manifest,
  };
}

export function readShipmentCloseFromPackageManifest(
  rawManifestData: unknown,
  trackingNumber: string,
): { close_state: ShipmentCloseState; manifest: ShipmentOperatorCloseManifest | null } {
  return readShipmentCloseFromPalletPhotoEvidence(rawManifestData, trackingNumber);
}

export function mergePalletPhotoEvidenceShipmentCloseFinalize(
  existingPhotoEvidence: unknown,
  args: {
    trackingNumber: string;
    storeId: string;
    anchorPalletId: string;
    anchorPackageId: string | null;
    finalizedAtIso: string;
    finalizedBy: string | null;
    reviewSnapshot: ShipmentCloseReviewSnapshot;
    priorRevision?: number;
  },
): Record<string, unknown> {
  const pe = parseJsonObject(existingPhotoEvidence);
  const prior = readCloseBlock(existingPhotoEvidence);
  const revision = Math.max(0, Math.floor(args.priorRevision ?? prior?.close_revision ?? 0)) + 1;
  return {
    ...pe,
    [SHIPMENT_OPERATOR_CLOSE_MANIFEST_KEY]: {
      close_state: "finalized",
      tracking_number: args.trackingNumber,
      store_id: args.storeId,
      anchor_pallet_id: args.anchorPalletId,
      anchor_package_id: args.anchorPackageId,
      storage_kind: "pallet_photo_evidence",
      finalized_at: args.finalizedAtIso,
      finalized_by: args.finalizedBy,
      reopened_at: prior?.reopened_at ?? null,
      reopened_by: prior?.reopened_by ?? null,
      close_revision: revision,
      review_confirmed: args.reviewSnapshot,
    } satisfies ShipmentOperatorCloseManifest,
  };
}

export function mergePalletPhotoEvidenceShipmentCloseReopen(
  existingPhotoEvidence: unknown,
  args: {
    reopenedAtIso: string;
    reopenedBy: string | null;
  },
): Record<string, unknown> {
  const pe = parseJsonObject(existingPhotoEvidence);
  const prior = readCloseBlock(existingPhotoEvidence);
  if (!prior) return pe;
  return {
    ...pe,
    [SHIPMENT_OPERATOR_CLOSE_MANIFEST_KEY]: {
      ...prior,
      close_state: "open",
      reopened_at: args.reopenedAtIso,
      reopened_by: args.reopenedBy,
    } satisfies ShipmentOperatorCloseManifest,
  };
}

export function mergePackageManifestShipmentCloseFinalize(
  existingManifestData: unknown,
  args: {
    trackingNumber: string;
    storeId: string;
    anchorPackageId: string;
    finalizedAtIso: string;
    finalizedBy: string | null;
    reviewSnapshot: ShipmentCloseReviewSnapshot;
    priorRevision?: number;
  },
): Record<string, unknown> {
  const md = parseJsonObject(existingManifestData);
  const prior = readCloseBlock(existingManifestData);
  const revision = Math.max(0, Math.floor(args.priorRevision ?? prior?.close_revision ?? 0)) + 1;
  return {
    ...md,
    [SHIPMENT_OPERATOR_CLOSE_MANIFEST_KEY]: {
      close_state: "finalized",
      tracking_number: args.trackingNumber,
      store_id: args.storeId,
      anchor_pallet_id: null,
      anchor_package_id: args.anchorPackageId,
      storage_kind: "package_manifest_data",
      finalized_at: args.finalizedAtIso,
      finalized_by: args.finalizedBy,
      reopened_at: prior?.reopened_at ?? null,
      reopened_by: prior?.reopened_by ?? null,
      close_revision: revision,
      review_confirmed: args.reviewSnapshot,
    } satisfies ShipmentOperatorCloseManifest,
  };
}

export function mergePackageManifestShipmentCloseReopen(
  existingManifestData: unknown,
  args: {
    reopenedAtIso: string;
    reopenedBy: string | null;
  },
): Record<string, unknown> {
  const md = parseJsonObject(existingManifestData);
  const prior = readCloseBlock(existingManifestData);
  if (!prior) return md;
  return {
    ...md,
    [SHIPMENT_OPERATOR_CLOSE_MANIFEST_KEY]: {
      ...prior,
      close_state: "open",
      reopened_at: args.reopenedAtIso,
      reopened_by: args.reopenedBy,
    } satisfies ShipmentOperatorCloseManifest,
  };
}
