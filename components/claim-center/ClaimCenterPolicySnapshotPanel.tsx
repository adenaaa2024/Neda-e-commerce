"use client";

import Link from "next/link";

import {
  POLICY_SNAPSHOT_INTRO,
  type PolicyOwnershipGroup,
} from "@/lib/claims/center/claim-center-policy-ownership";

import type { ClaimSettingsOverviewRow } from "./ClaimSettingsOverviewPanel";

type GroupWithRows = PolicyOwnershipGroup & { rows: ClaimSettingsOverviewRow[] };

export function ClaimCenterPolicySnapshotPanel({ groups }: { groups: GroupWithRows[] }) {
  return (
    <div className="space-y-6">
      <p className="rounded-xl border border-slate-500/20 bg-slate-500/5 px-4 py-3 text-sm leading-relaxed opacity-90">
        {POLICY_SNAPSHOT_INTRO}
      </p>

      {groups.map((group) => (
        <section key={`${group.id}-${group.title}`} className="claim-center-card rounded-xl p-4">
          <div className="mb-4 flex flex-wrap items-start justify-between gap-3 border-b pb-3">
            <div className="min-w-0">
              <h3 className="text-sm font-semibold">{group.title}</h3>
              <p className="mt-1 text-xs opacity-70">{group.description}</p>
            </div>
            <div className="shrink-0 text-right text-xs">
              <p className="font-medium opacity-60">Owner</p>
              {group.ownerHref ? (
                <Link href={group.ownerHref} className="font-semibold underline opacity-90 hover:opacity-100">
                  {group.ownerLabel} →
                </Link>
              ) : (
                <p className="opacity-70">{group.ownerFallback ?? group.ownerLabel}</p>
              )}
            </div>
          </div>

          {group.rows.length === 0 ? (
            <p className="text-xs opacity-60">No effective values loaded for this group.</p>
          ) : (
            <dl className="divide-y text-sm">
              {group.rows.map((r) => (
                <div key={r.id} className="grid gap-1 py-3 sm:grid-cols-[minmax(140px,200px)_1fr] sm:gap-4">
                  <dt className="text-xs font-medium opacity-70">{r.label}</dt>
                  <dd>
                    <p>{r.effective}</p>
                    {r.warning ? (
                      <p className="mt-1 text-[11px] text-amber-600 dark:text-amber-400">{r.warning}</p>
                    ) : null}
                    <p className="mt-0.5 text-[10px] capitalize opacity-45">
                      {r.source} · {r.editability.replace(/-/g, " ")}
                    </p>
                  </dd>
                </div>
              ))}
            </dl>
          )}
        </section>
      ))}
    </div>
  );
}
