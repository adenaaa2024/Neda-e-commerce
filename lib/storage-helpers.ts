import { isUuidString } from "./uuid";

/**
 * Safe, tenant-scoped object prefixes **after** the organization UUID in Storage
 * (`media` / `manifests` buckets). Used only for **new** operator uploads so legacy
 * `{org_id}/{folder}/{file}` URLs keep working unchanged.
 *
 * Layout (object key = `{org_id}/{relativePathUnderOrg}/{unique}.ext`):
 * - Pallet photos:     `{store_id}/pallets/{pallet_id}/photos`
 * - Pallet BOL:        `{store_id}/pallets/{pallet_id}/bol`
 * - Pallet labels:     `{store_id}/pallets/{pallet_id}/shipping-labels`
 * - Package photos:    `{store_id}/packages/{package_id}/photos`
 * - Package manifest:  `{store_id}/packages/{package_id}/manifest`
 */

export function normalizeStorageRelativePathUnderOrg(raw: string): string {
  const t = raw.trim().replace(/^\/+/, "").replace(/\/+$/, "");
  if (!t || t.includes("..")) return "";
  return t.split("/").filter(Boolean).join("/");
}

export function isAlignedStorageRelativePath(value: string): boolean {
  const v = normalizeStorageRelativePathUnderOrg(value);
  if (!v) return false;
  const segs = v.split("/");
  if (segs.length !== 4) return false;
  const [storeId, kind, recordId, leaf] = segs;
  if (!isUuidString(storeId) || !isUuidString(recordId)) return false;
  if (kind === "pallets") {
    return ["photos", "bol", "shipping-labels"].includes(leaf);
  }
  if (kind === "packages") {
    return ["photos", "manifest"].includes(leaf);
  }
  return false;
}

function assertUuidPair(storeId: string, recordId: string, label: string): void {
  if (!isUuidString(storeId) || !isUuidString(recordId)) {
    throw new Error(`${label}: storeId and recordId must be UUIDs.`);
  }
}

export function buildPalletPhotosRelativePath(storeId: string, palletId: string): string {
  assertUuidPair(storeId, palletId, "buildPalletPhotosRelativePath");
  return `${storeId}/pallets/${palletId}/photos`;
}

export function buildPalletBolRelativePath(storeId: string, palletId: string): string {
  assertUuidPair(storeId, palletId, "buildPalletBolRelativePath");
  return `${storeId}/pallets/${palletId}/bol`;
}

export function buildPalletShippingLabelsRelativePath(storeId: string, palletId: string): string {
  assertUuidPair(storeId, palletId, "buildPalletShippingLabelsRelativePath");
  return `${storeId}/pallets/${palletId}/shipping-labels`;
}

export function buildPackagePhotosRelativePath(storeId: string, packageId: string): string {
  assertUuidPair(storeId, packageId, "buildPackagePhotosRelativePath");
  return `${storeId}/packages/${packageId}/photos`;
}

export function buildPackageManifestRelativePath(storeId: string, packageId: string): string {
  assertUuidPair(storeId, packageId, "buildPackageManifestRelativePath");
  return `${storeId}/packages/${packageId}/manifest`;
}
