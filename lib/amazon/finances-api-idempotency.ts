import { createHash } from "node:crypto";

export const FINANCES_API_VERSION_V0 = "v0" as const;
export const FINANCES_OPERATION_ARCHIVE = "finances.archive.v0" as const;

export function buildFinancesArchiveIdempotencyKey(parts: {
  organizationId: string;
  storeId: string | null;
  marketplaceId: string | null;
  windowStart: string;
  windowEnd: string;
  financesApiVersion?: string;
}): string {
  const payload = [
    parts.organizationId.trim(),
    `provider=amazon_sp_api`,
    `operation=${FINANCES_OPERATION_ARCHIVE}`,
    `finances_api_version=${parts.financesApiVersion ?? FINANCES_API_VERSION_V0}`,
    parts.windowStart.trim(),
    parts.windowEnd.trim(),
    (parts.marketplaceId ?? "").trim(),
    (parts.storeId ?? "").trim(),
  ].join("|");
  return createHash("sha256").update(payload, "utf8").digest("hex");
}

export function sha256HexUtf8(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function sha256CanonicalJson(value: unknown): string {
  return sha256HexUtf8(JSON.stringify(value ?? null));
}
