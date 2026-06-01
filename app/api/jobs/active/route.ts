import { NextResponse } from "next/server";

import { assertUserCanAccessOrganization } from "@/app/dashboard/products/pim-actions";
import { jobApiBlocked, jobApiError, parseJobType, parseUuidField } from "@/lib/jobs/api-helpers";
import { findActiveBackgroundJob } from "@/lib/jobs/repository";
import { fetchJobForSession } from "@/lib/jobs/api-session";
import { buildProductEnrichmentJobUiStatus } from "@/lib/jobs/product-enrichment-job-status";
import type { JobType } from "@/lib/jobs/types";
import { supabaseServer } from "@/lib/supabase-server";

export const runtime = "nodejs";

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const organizationId = parseUuidField(url.searchParams.get("organization_id"), "organization_id");
  const storeId = parseUuidField(url.searchParams.get("store_id"), "store_id");
  const jobType = parseJobType(url.searchParams.get("job_type") ?? "product_enrichment");

  if (!organizationId) return jobApiError("organization_id must be a UUID.");
  if (!storeId) return jobApiError("store_id must be a UUID.");
  if (!jobType) return jobApiError("job_type is invalid.");

  const gate = await assertUserCanAccessOrganization(organizationId);
  if (!gate.ok) {
    return NextResponse.json(
      { ok: false, error: gate.error },
      { status: gate.error === "Not signed in." ? 401 : 403 },
    );
  }

  try {
    const job = await findActiveBackgroundJob(supabaseServer, {
      organizationId,
      storeId,
      jobType: jobType as JobType,
    });
    if (!job) {
      return NextResponse.json({ ok: true, job_id: null, status: null });
    }

    const loaded = await fetchJobForSession(job.id);
    if (!loaded.ok) {
      return NextResponse.json({ ok: false, error: loaded.error }, { status: loaded.status });
    }

    const status =
      jobType === "product_enrichment"
        ? buildProductEnrichmentJobUiStatus(loaded.job, loaded.step)
        : null;

    return NextResponse.json({
      ok: true,
      job_id: loaded.job.id,
      status,
    });
  } catch (e) {
    return jobApiBlocked(e);
  }
}
