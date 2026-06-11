import type { SupabaseClient } from "@supabase/supabase-js";

import { getClaimInboxListSelect } from "@/lib/claim-inbox-schema";

const CENTER_OPTIONAL = [
  "source_kind",
  "reference_id",
  "reference_type",
  "dispute_deadline",
  "days_remaining",
  "recovery_value",
  "cogs_unit",
  "currency",
  "event_date",
  "intake_run_id",
  "quarantined_at",
  "rejected_at",
  "metadata",
  "updated_at",
] as const;

async function probe(client: SupabaseClient, col: string): Promise<boolean> {
  const { error } = await client.from("claim_candidates").select(`id,${col}`).limit(1);
  return !error;
}

let centerSelectCache: string | null = null;

export async function getClaimCenterListSelect(client: SupabaseClient): Promise<string> {
  if (centerSelectCache) return centerSelectCache;
  const base = await getClaimInboxListSelect(client);
  const extras: string[] = [];
  for (const c of CENTER_OPTIONAL) {
    if (await probe(client, c)) extras.push(c);
  }
  centerSelectCache = extras.length ? `${base}, ${extras.join(", ")}` : base;
  return centerSelectCache;
}

export function resetClaimCenterSelectCacheForTests(): void {
  centerSelectCache = null;
}
