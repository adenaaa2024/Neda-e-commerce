/**
 * Phase 6D — Pallet close / reopen state on existing `pallets.photo_evidence` JSONB (no new tables).
 * Missing quantities remain review metadata only — no claim records created here.
 */

import type { PalletCloseReviewSnapshot } from "@/lib/scanner/pallet-close-review";

export const PALLET_OPERATOR_CLOSE_MANIFEST_KEY = "operator_pallet_close" as const;

export type PalletCloseState = "open" | "finalized";

export type PalletOperatorCloseManifest = {
  close_state: PalletCloseState;
  finalized_at: string | null;
  finalized_by: string | null;
  reopened_at: string | null;
  reopened_by: string | null;
  close_revision: number;
  review_confirmed?: PalletCloseReviewSnapshot;
  [key: string]: unknown;
};

function parsePhotoEvidence(raw: unknown): Record<string, unknown> {
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

function readCloseBlock(raw: unknown): PalletOperatorCloseManifest | null {
  const pe = parsePhotoEvidence(raw);
  const block = pe[PALLET_OPERATOR_CLOSE_MANIFEST_KEY];
  if (!block || typeof block !== "object" || Array.isArray(block)) return null;
  const o = block as Record<string, unknown>;
  const close_state = o.close_state === "finalized" ? "finalized" : "open";
  return {
    close_state,
    finalized_at: typeof o.finalized_at === "string" ? o.finalized_at : null,
    finalized_by: typeof o.finalized_by === "string" ? o.finalized_by : null,
    reopened_at: typeof o.reopened_at === "string" ? o.reopened_at : null,
    reopened_by: typeof o.reopened_by === "string" ? o.reopened_by : null,
    close_revision: Math.max(0, Math.floor(Number(o.close_revision ?? 0))),
    review_confirmed:
      o.review_confirmed && typeof o.review_confirmed === "object" && !Array.isArray(o.review_confirmed)
        ? (o.review_confirmed as PalletCloseReviewSnapshot)
        : undefined,
  };
}

export function readPalletCloseState(rawPhotoEvidence: unknown, palletStatus: string | null | undefined): {
  close_state: PalletCloseState;
  status_closed: boolean;
  manifest: PalletOperatorCloseManifest | null;
} {
  const manifest = readCloseBlock(rawPhotoEvidence);
  const statusNorm = String(palletStatus ?? "").trim().toLowerCase();
  const status_closed = statusNorm === "closed" || statusNorm === "submitted";
  const close_state =
    manifest?.close_state === "finalized" || status_closed ? "finalized" : "open";
  return { close_state, status_closed, manifest };
}

export function palletCloseBlocksEdits(rawPhotoEvidence: unknown, palletStatus: string | null | undefined): boolean {
  return readPalletCloseState(rawPhotoEvidence, palletStatus).close_state === "finalized";
}

export function mergePalletPhotoEvidenceFinalize(
  existingPhotoEvidence: unknown,
  args: {
    finalizedAtIso: string;
    finalizedBy: string | null;
    reviewSnapshot: PalletCloseReviewSnapshot;
    priorRevision?: number;
  },
): Record<string, unknown> {
  const pe = parsePhotoEvidence(existingPhotoEvidence);
  const prior = readCloseBlock(existingPhotoEvidence);
  const revision = Math.max(0, Math.floor(args.priorRevision ?? prior?.close_revision ?? 0)) + 1;
  return {
    ...pe,
    [PALLET_OPERATOR_CLOSE_MANIFEST_KEY]: {
      close_state: "finalized",
      finalized_at: args.finalizedAtIso,
      finalized_by: args.finalizedBy,
      reopened_at: prior?.reopened_at ?? null,
      reopened_by: prior?.reopened_by ?? null,
      close_revision: revision,
      review_confirmed: args.reviewSnapshot,
    } satisfies PalletOperatorCloseManifest,
  };
}

export function mergePalletPhotoEvidenceReopen(
  existingPhotoEvidence: unknown,
  args: {
    reopenedAtIso: string;
    reopenedBy: string | null;
  },
): Record<string, unknown> {
  const pe = parsePhotoEvidence(existingPhotoEvidence);
  const prior = readCloseBlock(existingPhotoEvidence);
  return {
    ...pe,
    [PALLET_OPERATOR_CLOSE_MANIFEST_KEY]: {
      close_state: "open",
      finalized_at: prior?.finalized_at ?? null,
      finalized_by: prior?.finalized_by ?? null,
      reopened_at: args.reopenedAtIso,
      reopened_by: args.reopenedBy,
      close_revision: prior?.close_revision ?? 0,
      review_confirmed: prior?.review_confirmed,
    } satisfies PalletOperatorCloseManifest,
  };
}
