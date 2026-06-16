"use client";

import type { ReimbursementTrackingUiPayload } from "@/lib/claims/submission/claim-reimbursement-tracking-ui-contract";
import { claimCenterBadgeTone } from "@/components/claim-center/claim-center-ui";

type Props = {
  payload: ReimbursementTrackingUiPayload;
};

export function ReimbursementTrackingHeader({ payload }: Props) {
  const updated = payload.generated_at ? new Date(payload.generated_at).toLocaleString() : "—";

  return (
    <header className="claim-center-card space-y-4 rounded-xl border p-5 sm:p-6">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0 space-y-2">
          <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">Reimbursement Tracking</h1>
          <p className="max-w-3xl text-sm opacity-80">
            Track claim submissions, reimbursement matches, open recovery gaps, and follow-up needs.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <span className={claimCenterBadgeTone("info")}>Pilot 10 cases</span>
          <span className={claimCenterBadgeTone("neutral")}>Read-only preview</span>
          <span className={claimCenterBadgeTone("success")}>Not submitted to Amazon</span>
        </div>
      </div>

      <dl className="grid gap-3 text-xs sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <dt className="font-semibold uppercase opacity-55">Preview run</dt>
          <dd className="mt-0.5 font-mono text-[10px] break-all">{payload.preview_run_reference}</dd>
        </div>
        <div>
          <dt className="font-semibold uppercase opacity-55">Pilot case run</dt>
          <dd className="mt-0.5 font-mono text-[10px] break-all">{payload.pilot_case_run_id}</dd>
        </div>
        <div>
          <dt className="font-semibold uppercase opacity-55">Intake run</dt>
          <dd className="mt-0.5 font-mono text-[10px] break-all">{payload.intake_run_id}</dd>
        </div>
        <div>
          <dt className="font-semibold uppercase opacity-55">Last updated</dt>
          <dd className="mt-0.5">{updated}</dd>
        </div>
      </dl>

      <p className="rounded-lg border border-sky-500/25 bg-sky-500/5 px-3 py-2 text-xs text-sky-950 dark:text-sky-100">
        This page tracks internal claim submissions and possible reimbursement matches. It does not submit
        anything to Amazon.
      </p>

      {payload.legacy_visibility.count > 0 ? (
        <p className="text-xs opacity-70">
          Legacy submissions excluded from this view: {payload.legacy_visibility.count} (
          {payload.legacy_visibility.note})
        </p>
      ) : null}
    </header>
  );
}
