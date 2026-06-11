import { loadClaimPolicy } from "@/lib/claim-eligibility-policy";
import type { SupabaseClient } from "@supabase/supabase-js";

import type { ClaimCenterCanonicalWindow, ClaimCenterWindowStatus } from "./claim-center-v1-types";

function str(v: unknown): string | null {
  const s = String(v ?? "").trim();
  return s || null;
}

function num(v: unknown): number | null {
  const n = Number(v ?? NaN);
  return Number.isFinite(n) ? n : null;
}

export function windowStatusFromDaysRemaining(days: number | null): ClaimCenterWindowStatus {
  if (days == null) return "unknown";
  if (days < 0) return "expired";
  if (days <= 14) return "closing_soon";
  return "open";
}

export function computeCanonicalWindow(args: {
  eventDate: string | null;
  disputeDeadline: string | null;
  daysRemainingSnapshot: number | null;
  claimEligibilityWindowDays: number;
}): ClaimCenterCanonicalWindow {
  let deadline = str(args.disputeDeadline);
  const eventDate = str(args.eventDate);

  if (!deadline && eventDate && args.claimEligibilityWindowDays > 0) {
    const d = new Date(`${eventDate}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + args.claimEligibilityWindowDays);
    deadline = d.toISOString().slice(0, 10);
  }

  let daysRemaining = args.daysRemainingSnapshot;
  if (daysRemaining == null && deadline) {
    const ms = new Date(`${deadline}T23:59:59Z`).getTime() - Date.now();
    daysRemaining = Math.floor(ms / 86_400_000);
  }

  return {
    status: windowStatusFromDaysRemaining(daysRemaining),
    days_remaining: daysRemaining,
    deadline,
  };
}

export function observedWindowFromMetadata(meta: Record<string, unknown>): ClaimCenterCanonicalWindow | null {
  const observed = meta.source_observed_window;
  if (!observed || typeof observed !== "object" || Array.isArray(observed)) {
    const ws = str(meta.window_status);
    const dr = num(meta.days_remaining);
    if (!ws && dr == null) return null;
    const status =
      ws === "expired" || ws === "closing_soon" || ws === "open"
        ? (ws as ClaimCenterWindowStatus)
        : windowStatusFromDaysRemaining(dr);
    return { status, days_remaining: dr, deadline: str(meta.dispute_deadline) };
  }
  const o = observed as Record<string, unknown>;
  const dr = num(o.days_remaining);
  const statusRaw = str(o.status);
  const status =
    statusRaw === "expired" || statusRaw === "closing_soon" || statusRaw === "open"
      ? statusRaw
      : windowStatusFromDaysRemaining(dr);
  return {
    status,
    days_remaining: dr,
    deadline: str(o.deadline),
  };
}

export async function loadClaimEligibilityWindowDays(
  client: SupabaseClient,
  organizationId: string,
): Promise<number> {
  const policy = await loadClaimPolicy(client, organizationId);
  return policy.claim_eligibility_window_days;
}
