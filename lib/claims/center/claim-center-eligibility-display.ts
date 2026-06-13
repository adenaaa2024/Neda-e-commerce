import type { ClaimCenterCanonicalWindow } from "./claim-center-v1-types";

export type ClaimCenterEligibilityStatus =
  | "not_yet_claimable"
  | "claimable"
  | "expiring_soon"
  | "expired"
  | "unknown_expiry";

export type ClaimCenterEligibilityDisplay = {
  status: ClaimCenterEligibilityStatus;
  label: string;
  detail: string | null;
  scanner_expiration_date: string | null;
  derived_from_scanner_expiration: boolean;
};

function parseIsoDate(v: unknown): string | null {
  const s = String(v ?? "").trim();
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null;
}

function daysUntil(iso: string): number | null {
  const ms = new Date(`${iso}T23:59:59Z`).getTime() - Date.now();
  if (!Number.isFinite(ms)) return null;
  return Math.floor(ms / 86_400_000);
}

export function deriveEligibilityDisplay(args: {
  canonical_window: ClaimCenterCanonicalWindow;
  scanner_expiration_date?: string | null;
  event_date?: string | null;
  expiration_warning_days?: number;
}): ClaimCenterEligibilityDisplay {
  const warningDays = args.expiration_warning_days ?? 14;
  const scannerDate = parseIsoDate(args.scanner_expiration_date);
  let derivedFromScanner = false;

  if (scannerDate) {
    const remaining = daysUntil(scannerDate);
    if (remaining != null && remaining < 0) {
      return {
        status: "expired",
        label: "Expired",
        detail: `Scanner expiration date ${scannerDate} has passed.`,
        scanner_expiration_date: scannerDate,
        derived_from_scanner_expiration: true,
      };
    }
    if (remaining != null && remaining <= warningDays) {
      derivedFromScanner = true;
      return {
        status: "expiring_soon",
        label: "Expiring soon",
        detail: `Scanner expiration ${scannerDate} — ${remaining} day(s) remaining.`,
        scanner_expiration_date: scannerDate,
        derived_from_scanner_expiration: true,
      };
    }
    if (remaining != null) {
      return {
        status: "claimable",
        label: "Claimable",
        detail: `Scanner expiration ${scannerDate} — ${remaining} day(s) remaining.`,
        scanner_expiration_date: scannerDate,
        derived_from_scanner_expiration: true,
      };
    }
  }

  const ws = args.canonical_window.status;
  const days = args.canonical_window.days_remaining;
  const deadline = args.canonical_window.deadline;

  if (ws === "expired") {
    return {
      status: "expired",
      label: "Expired",
      detail: deadline ? `Filing window ended ${deadline}.` : "Policy window has passed.",
      scanner_expiration_date: scannerDate,
      derived_from_scanner_expiration: derivedFromScanner,
    };
  }

  if (ws === "closing_soon") {
    return {
      status: "expiring_soon",
      label: "Expiring soon",
      detail:
        days != null && deadline
          ? `${days} day(s) until ${deadline}.`
          : "Filing window is closing soon per policy.",
      scanner_expiration_date: scannerDate,
      derived_from_scanner_expiration: derivedFromScanner,
    };
  }

  if (ws === "unknown") {
    return {
      status: "unknown_expiry",
      label: "Unknown expiry",
      detail: "No dispute deadline or policy window could be derived.",
      scanner_expiration_date: scannerDate,
      derived_from_scanner_expiration: false,
    };
  }

  if (ws === "open") {
    return {
      status: "claimable",
      label: "Claimable",
      detail:
        days != null && deadline
          ? `${days} day(s) until ${deadline}.`
          : "Within policy filing window.",
      scanner_expiration_date: scannerDate,
      derived_from_scanner_expiration: derivedFromScanner,
    };
  }

  return {
    status: "unknown_expiry",
    label: "Unknown expiry",
    detail: null,
    scanner_expiration_date: scannerDate,
    derived_from_scanner_expiration: false,
  };
}
