import { NextResponse } from "next/server";

import {
  jobApiBlocked,
  jobApiError,
  parseIdempotencyKey,
  parseJobType,
  parseUuidField,
} from "@/lib/jobs/api-helpers";
import { assertUserCanAccessOrganization } from "@/app/dashboard/products/pim-actions";
import { enqueueJob } from "@/lib/jobs/orchestrator";
import type { EnqueueStepInput, JobType } from "@/lib/jobs/types";
import { supabaseServer } from "@/lib/supabase-server";

export const runtime = "nodejs";
export const maxDuration = 60;

type Body = {
  organization_id?: string;
  store_id?: string | null;
  job_type?: string;
  idempotency_key?: string;
  priority?: number;
  requested_by?: string | null;
  payload?: Record<string, unknown>;
  resource_refs?: Record<string, unknown>;
  steps?: EnqueueStepInput[];
  scheduled_at?: string | null;
};

export async function POST(req: Request): Promise<Response> {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return jobApiError("Invalid JSON body.");
  }

  const organizationId = parseUuidField(body.organization_id, "organization_id");
  const jobType = parseJobType(body.job_type);
  const idempotencyKey = parseIdempotencyKey(body.idempotency_key);

  if (!organizationId) return jobApiError("organization_id must be a UUID.");
  if (!jobType) return jobApiError("job_type is invalid.");
  if (!idempotencyKey) return jobApiError("idempotency_key is required (max 512 chars).");

  const storeId = body.store_id ? parseUuidField(body.store_id, "store_id") : null;
  if (body.store_id && !storeId) return jobApiError("store_id must be a UUID when provided.");

  const gate = await assertUserCanAccessOrganization(organizationId);
  if (!gate.ok) {
    return NextResponse.json(
      { ok: false, error: gate.error },
      { status: gate.error === "Not signed in." ? 401 : 403 },
    );
  }

  try {
    const result = await enqueueJob(supabaseServer, {
      organizationId,
      storeId,
      jobType: jobType as JobType,
      idempotencyKey,
      priority: typeof body.priority === "number" ? body.priority : 50,
      requestedBy: body.requested_by ?? null,
      payload: body.payload ?? {},
      resourceRefs: body.resource_refs ?? {},
      steps: body.steps,
      scheduledAt: body.scheduled_at ?? null,
    });

    return NextResponse.json({
      ok: true,
      job_id: result.jobId,
      inserted: result.inserted,
      status: result.status,
    });
  } catch (e) {
    return jobApiBlocked(e);
  }
}
