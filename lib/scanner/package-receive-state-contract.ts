/**
 * Maysam 6D — package item-scan receive state (manifest-only; no schema migration).
 * `receive_state=finalized` when `operator_item_scan.finalized_at` is set.
 */

import { PACKAGE_EMPTY_BOX_MANIFEST_KEY } from "@/lib/scanner/package-empty-box-manifest";
import { readOperatorItemScanBlock } from "@/lib/scanner/package-missing-review-manifest";

export type PackageReceiveState = "open" | "finalized";

export function readPackageReceiveState(rawManifest: unknown): PackageReceiveState {
  const block = readOperatorItemScanBlock(rawManifest);
  const explicit = String(block.receive_state ?? "").trim().toLowerCase();
  if (explicit === "open" || explicit === "finalized") {
    return explicit;
  }
  const finalizedAt = String(block.finalized_at ?? "").trim();
  return finalizedAt ? "finalized" : "open";
}

export function packageReceiveStateIsFinalized(rawManifest: unknown): boolean {
  return readPackageReceiveState(rawManifest) === "finalized";
}

export function mergePackageManifestReceiveReopen(
  existingManifest: unknown,
  args: { reopenedAtIso: string; reopenedBy: string },
): Record<string, unknown> {
  const md =
    existingManifest && typeof existingManifest === "object" && !Array.isArray(existingManifest)
      ? { ...(existingManifest as Record<string, unknown>) }
      : {};
  const prior = readOperatorItemScanBlock(existingManifest);
  const { finalized_at: _dropFinalized, receive_state: _dropState, ...restBlock } = prior;
  return {
    ...md,
    [PACKAGE_EMPTY_BOX_MANIFEST_KEY]: {
      ...restBlock,
      receive_state: "open" satisfies PackageReceiveState,
      reopened_at: args.reopenedAtIso,
      reopened_by: args.reopenedBy,
    },
  };
}

export function mergePackageManifestReceiveFinalize(
  existingManifest: unknown,
  args: { finalizedAtIso: string },
): Record<string, unknown> {
  const md =
    existingManifest && typeof existingManifest === "object" && !Array.isArray(existingManifest)
      ? { ...(existingManifest as Record<string, unknown>) }
      : {};
  const prior = readOperatorItemScanBlock(existingManifest);
  return {
    ...md,
    [PACKAGE_EMPTY_BOX_MANIFEST_KEY]: {
      ...prior,
      receive_state: "finalized" satisfies PackageReceiveState,
      finalized_at: args.finalizedAtIso,
    },
  };
}
