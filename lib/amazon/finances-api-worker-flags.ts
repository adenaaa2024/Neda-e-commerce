/**
 * Feature flags for Amazon Finances API archive ingest (ARCHIVE-03).
 * Defaults off — never expose via NEXT_PUBLIC_*.
 */

function envFlag(name: string): boolean {
  const v = process.env[name]?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

export function isAmazonFinancesApiWorkerEnabled(): boolean {
  return envFlag("ENABLE_AMAZON_FINANCES_API_WORKER");
}

export function isAmazonFinancesApiIngestEnabled(): boolean {
  return isAmazonFinancesApiWorkerEnabled() && envFlag("ENABLE_AMAZON_FINANCES_API_INGEST");
}

export type FinancesApiDisabledReason = "worker_disabled" | "ingest_disabled";

export function financesApiDisabledReason(): FinancesApiDisabledReason | null {
  if (!isAmazonFinancesApiWorkerEnabled()) return "worker_disabled";
  if (!isAmazonFinancesApiIngestEnabled()) return "ingest_disabled";
  return null;
}
