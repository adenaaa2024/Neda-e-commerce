"use client";

import { AlertCircle, Loader2, UserCircle2 } from "lucide-react";

import type { TaskCenterOrgPeopleDetailResponse } from "@/lib/task-center/task-center-api-contract";
import {
  formatTaskCenterOrgPeopleDate,
  formatTaskCenterOrgPeopleDisplayName,
  formatTaskCenterOrgPeopleGroupLabel,
  formatTaskCenterOrgPeopleManagerLabel,
  formatTaskCenterOrgPeoplePositionLabel,
} from "@/lib/task-center/task-center-people-org-display-contract";

import { TASK_CENTER_CARD_CLASS, TASK_CENTER_MUTED } from "./task-center-ui";

function DetailField({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className={`text-[11px] font-semibold uppercase tracking-wide ${TASK_CENTER_MUTED}`}>{label}</p>
      <p className="mt-0.5 break-words text-sm">{value}</p>
    </div>
  );
}

export function TaskCenterOrgPeopleDetailPanel({
  detail,
  loading,
  error,
  hasSelection,
}: {
  detail: TaskCenterOrgPeopleDetailResponse | null;
  loading: boolean;
  error: string | null;
  hasSelection: boolean;
}) {
  if (!hasSelection) {
    return (
      <div className={`${TASK_CENTER_CARD_CLASS} flex min-h-[12rem] flex-col items-center justify-center p-6 text-center`}>
        <UserCircle2 className={`mb-3 h-8 w-8 ${TASK_CENTER_MUTED}`} aria-hidden />
        <p className="text-sm font-semibold">Select a person</p>
        <p className={`mt-1 text-xs task-center-text-secondary`}>
          Choose someone in the org tree to view their current assignment and history.
        </p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className={`${TASK_CENTER_CARD_CLASS} flex min-h-[12rem] items-center justify-center p-6`}>
        <Loader2 className={`h-6 w-6 animate-spin ${TASK_CENTER_MUTED}`} aria-label="Loading person details" />
      </div>
    );
  }

  const displayName = detail
    ? formatTaskCenterOrgPeopleDisplayName(detail.full_name, detail.email)
    : "Unknown person";
  const current = detail?.current ?? null;

  return (
    <div className={`${TASK_CENTER_CARD_CLASS} min-w-0 p-4 sm:p-5`}>
      {error ? (
        <div className="mb-4 flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-900/40 dark:bg-red-950/30 dark:text-red-300">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <p>{error}</p>
        </div>
      ) : null}

      <div className="flex items-start gap-3">
        <UserCircle2 className={`h-8 w-8 shrink-0 ${TASK_CENTER_MUTED}`} aria-hidden />
        <div className="min-w-0">
          <h3 className="break-words text-base font-bold">{displayName}</h3>
          <p className={`mt-0.5 break-all text-xs ${TASK_CENTER_MUTED}`}>{detail?.email ?? "—"}</p>
        </div>
      </div>

      {current ? (
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <DetailField
            label="Position"
            value={formatTaskCenterOrgPeoplePositionLabel(current.position_title, current.position_code)}
          />
          <DetailField
            label="Group / Team"
            value={
              formatTaskCenterOrgPeopleGroupLabel(current.group_name, current.group_type) ?? "—"
            }
          />
          <DetailField
            label="Manager"
            value={formatTaskCenterOrgPeopleManagerLabel(
              current.manager_full_name,
              current.manager_email,
            )}
          />
          <DetailField label="Starts" value={formatTaskCenterOrgPeopleDate(current.starts_at)} />
        </div>
      ) : (
        <p className={`mt-4 text-sm task-center-text-secondary`}>No current assignment on record.</p>
      )}

      <div className="mt-6">
        <h4 className="text-sm font-semibold">Assignment history</h4>
        {!detail || detail.history.length === 0 ? (
          <p className={`mt-2 text-sm task-center-text-secondary`}>No assignment history yet.</p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[640px] text-left text-xs sm:text-sm">
              <thead className="border-b text-[11px] uppercase">
                <tr>
                  <th className="px-2 py-2 sm:px-3">Position</th>
                  <th className="px-2 py-2 sm:px-3">Group / Team</th>
                  <th className="px-2 py-2 sm:px-3">Manager</th>
                  <th className="px-2 py-2 sm:px-3">From</th>
                  <th className="px-2 py-2 sm:px-3">To</th>
                  <th className="px-2 py-2 sm:px-3">Notes</th>
                  <th className="px-2 py-2 sm:px-3">Assigned by</th>
                </tr>
              </thead>
              <tbody>
                {detail.history.map((row) => (
                  <tr key={row.id} className="border-b last:border-0">
                    <td className="px-2 py-2 sm:px-3">
                      {formatTaskCenterOrgPeoplePositionLabel(row.position_title, row.position_code)}
                    </td>
                    <td className="px-2 py-2 sm:px-3">
                      {formatTaskCenterOrgPeopleGroupLabel(row.group_name, row.group_type) ?? "—"}
                    </td>
                    <td className="px-2 py-2 sm:px-3">
                      {formatTaskCenterOrgPeopleManagerLabel(row.manager_full_name, row.manager_email)}
                    </td>
                    <td className="px-2 py-2 sm:px-3 tabular-nums">
                      {formatTaskCenterOrgPeopleDate(row.starts_at)}
                    </td>
                    <td className="px-2 py-2 sm:px-3 tabular-nums">
                      {formatTaskCenterOrgPeopleDate(row.ends_at)}
                    </td>
                    <td className="px-2 py-2 sm:px-3">{row.notes?.trim() || "—"}</td>
                    <td className="px-2 py-2 sm:px-3">
                      {formatTaskCenterOrgPeopleManagerLabel(
                        row.assigned_by_full_name,
                        row.assigned_by_email,
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
