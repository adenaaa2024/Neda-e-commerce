/**
 * Claim Discovery Engine — staging dry-run smoke.
 * Usage: npx tsx scripts/phase-claim-discovery-engine-staging-smoke.ts [--org UUID] [--apply]
 */
import { createClient } from "@supabase/supabase-js";

import { runClaimDiscovery } from "../lib/claims/discovery/claim-discovery-engine";
import { loadDiscoveryIndexState } from "../lib/claims/discovery/claim-discovery-index";
import { DEFAULT_CLAIM_DISCOVERY_SCHEDULE } from "../lib/platform-automation-settings-types";
import { loadEnvLocalIntoProcess } from "../lib/staging-project-ref";

loadEnvLocalIntoProcess();

const orgArg = process.argv.find((a) => a.startsWith("--org="))?.split("=")[1];
const apply = process.argv.includes("--apply");
const ORG = orgArg ?? process.env.DEFAULT_ORGANIZATION_ID ?? "00000000-0000-0000-0000-000000000001";

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error("Missing Supabase env");
    process.exit(1);
  }
  const client = createClient(url, key, { auth: { persistSession: false } });

  const { data: store } = await client
    .from("stores")
    .select("id")
    .eq("organization_id", ORG)
    .eq("is_active", true)
    .limit(1)
    .maybeSingle();
  const storeId = (store as { id?: string } | null)?.id;
  if (!storeId) {
    console.error("No active store for org", ORG);
    process.exit(1);
  }

  const beforeIndex = await loadDiscoveryIndexState(client, ORG);
  const outcome = await runClaimDiscovery({
    client,
    organizationId: ORG,
    storeId,
    schedule: { ...DEFAULT_CLAIM_DISCOVERY_SCHEDULE, enabled_source_kinds: [...DEFAULT_CLAIM_DISCOVERY_SCHEDULE.enabled_source_kinds] },
    apply,
    runKind: "manual",
  });

  const report = {
    candidate_queue: outcome.candidate_queue.length,
    indexed_sources: outcome.indexed_sources,
    incremental_strategy: outcome.indexed_sources.map((s) => ({
      source: s.source_kind,
      strategy: s.strategy,
      window: s.window,
      prior_watermark: s.prior_watermark,
    })),
    scheduled_run: "configured via claim_discovery schedule + /api/cron/claim-discovery",
    manual_run: "runClaimDiscoveryNowAction / ClaimDiscoveryCard",
    counts: outcome.counts,
    index_before: beforeIndex.sources,
    index_after: outcome.index_state.sources,
    SAFE_FOR_CLAIM_CENTER: outcome.ok && outcome.indexed_sources.length > 0 ? "yes" : "no",
    blockers: outcome.error,
  };

  console.log(JSON.stringify(report, null, 2));
  process.exit(outcome.ok ? 0 : 1);
}

void main();
