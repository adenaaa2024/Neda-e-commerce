import type { SupabaseClient } from "@supabase/supabase-js";

import { assertFinancesArchiveTable } from "./finances-api-allowed-tables";
import { sha256CanonicalJson } from "./finances-api-idempotency";

export const FINANCES_OP_LIST_EVENT_GROUPS = "finances.listFinancialEventGroups" as const;

export function financesOpListEventsByGroup(eventGroupId: string): string {
  return `finances.listFinancialEventsByGroup:${eventGroupId.trim()}`;
}

export type ArchiveFinancesPageInput = {
  organizationId: string;
  sourceRunId: string;
  operation: string;
  nextTokenIn: string | null;
  nextTokenOut: string | null;
  httpStatus: number;
  rawBody: Record<string, unknown>;
};

export type ArchiveFinancesPageResult =
  | { inserted: true; sequence: number; responseSha256: string }
  | { skipped: true; sequence: number; responseSha256: string; reason: "duplicate_sha" };

async function maxSequence(
  supabase: SupabaseClient,
  sourceRunId: string,
  operation: string,
): Promise<number> {
  const { data } = await supabase
    .from("amazon_finances_api_pages")
    .select("sequence")
    .eq("source_run_id", sourceRunId)
    .eq("operation", operation)
    .order("sequence", { ascending: false })
    .limit(1)
    .maybeSingle();
  const seq = data?.sequence;
  return typeof seq === "number" ? seq : -1;
}

/** Append one Finances API page (idempotent per sequence + sha). */
export async function archiveFinancesApiPage(
  supabase: SupabaseClient,
  input: ArchiveFinancesPageInput,
): Promise<ArchiveFinancesPageResult> {
  assertFinancesArchiveTable("amazon_finances_api_pages");

  const responseSha256 = sha256CanonicalJson(input.rawBody);
  const nextSeq = (await maxSequence(supabase, input.sourceRunId, input.operation)) + 1;

  const { data: existing } = await supabase
    .from("amazon_finances_api_pages")
    .select("id, response_sha256")
    .eq("source_run_id", input.sourceRunId)
    .eq("operation", input.operation)
    .eq("sequence", nextSeq)
    .maybeSingle();

  if (existing?.response_sha256 === responseSha256) {
    return { skipped: true, sequence: nextSeq, responseSha256, reason: "duplicate_sha" };
  }
  if (existing) {
    throw new Error(
      `Finances page sequence ${nextSeq} exists with different sha for run ${input.sourceRunId}`,
    );
  }

  const { error } = await supabase.from("amazon_finances_api_pages").insert({
    organization_id: input.organizationId,
    source_run_id: input.sourceRunId,
    sequence: nextSeq,
    operation: input.operation,
    next_token_in: input.nextTokenIn,
    next_token_out: input.nextTokenOut,
    http_status: input.httpStatus,
    response_sha256: responseSha256,
    raw_body: input.rawBody,
  });

  if (error) {
    if (error.code === "23505") {
      const { data: row } = await supabase
        .from("amazon_finances_api_pages")
        .select("response_sha256")
        .eq("source_run_id", input.sourceRunId)
        .eq("operation", input.operation)
        .eq("sequence", nextSeq)
        .maybeSingle();
      if (row?.response_sha256 === responseSha256) {
        return { skipped: true, sequence: nextSeq, responseSha256, reason: "duplicate_sha" };
      }
    }
    throw new Error(`archiveFinancesApiPage failed: ${error.message}`);
  }

  return { inserted: true, sequence: nextSeq, responseSha256 };
}

export async function loadFinancesApiPages(
  supabase: SupabaseClient,
  sourceRunId: string,
  operation: string,
): Promise<Array<{ sequence: number; raw_body: Record<string, unknown> }>> {
  const { data, error } = await supabase
    .from("amazon_finances_api_pages")
    .select("sequence, raw_body")
    .eq("source_run_id", sourceRunId)
    .eq("operation", operation)
    .order("sequence", { ascending: true });
  if (error) throw new Error(`loadFinancesApiPages failed: ${error.message}`);
  return (data ?? []).map((row) => ({
    sequence: row.sequence as number,
    raw_body: (row.raw_body ?? {}) as Record<string, unknown>,
  }));
}
