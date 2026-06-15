/** Format helpers for Claim Group Builder read-only UI. */

export function formatNullableUsd(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(value);
}

export function formatNullableUnits(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${value} unit${value === 1 ? "" : "s"}`;
}

export function shortId(value: string | null | undefined): string {
  const s = String(value ?? "").trim();
  if (!s) return "—";
  if (s.length <= 12) return s;
  return `${s.slice(0, 6)}…${s.slice(-4)}`;
}
