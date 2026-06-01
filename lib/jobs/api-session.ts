import { assertUserCanAccessOrganization } from "@/app/dashboard/products/pim-actions";
import { supabaseServer } from "@/lib/supabase-server";

import { fetchJob, fetchJobStep } from "./repository";
import type { BackgroundJobRow, JobStepRow } from "./types";

export async function fetchJobForSession(
  jobId: string,
): Promise<
  | { ok: true; job: BackgroundJobRow; step: JobStepRow | null }
  | { ok: false; error: string; status: number }
> {
  const job = await fetchJob(supabaseServer, jobId);
  if (!job) {
    return { ok: false, error: "Job not found.", status: 404 };
  }

  const gate = await assertUserCanAccessOrganization(job.organization_id);
  if (!gate.ok) {
    return {
      ok: false,
      error: gate.error,
      status: gate.error === "Not signed in." ? 401 : 403,
    };
  }

  const step = await fetchJobStep(supabaseServer, jobId, job.current_step_index);
  return { ok: true, job, step };
}
