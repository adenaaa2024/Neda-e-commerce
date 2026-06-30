"use client";

import { useCallback, useEffect, useState } from "react";
import { ExternalLink, Users } from "lucide-react";

import type {
  TaskCenterOrgPeopleDetailResponse,
  TaskCenterOrgPeopleResponse,
} from "@/lib/task-center/task-center-api-contract";
import {
  TASK_CENTER_ORG_PEOPLE_EMPTY_DESCRIPTION,
  TASK_CENTER_ORG_PEOPLE_EMPTY_TITLE,
  TASK_CENTER_ORG_PEOPLE_SETTINGS_HREF,
} from "@/lib/task-center/task-center-people-org-display-contract";

import { useTaskCenter, TaskCenterLoading } from "./TaskCenterRootClient";
import { TaskCenterOrgPeopleDetailPanel } from "./TaskCenterOrgPeopleDetailPanel";
import { TaskCenterOrgPeopleTree } from "./TaskCenterOrgPeopleTree";
import {
  TASK_CENTER_CARD_CLASS,
  TASK_CENTER_CTA,
  TASK_CENTER_LINK,
  TASK_CENTER_MUTED,
  TASK_CENTER_STAT_PILL,
} from "./task-center-ui";

export function TaskCenterOrgPeopleView() {
  const { fetchJson, storeId } = useTaskCenter();
  const [data, setData] = useState<TaskCenterOrgPeopleResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(null);
  const [detail, setDetail] = useState<TaskCenterOrgPeopleDetailResponse | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setSelectedProfileId(null);
    setDetail(null);
    setDetailError(null);
    try {
      const response = await fetchJson<TaskCenterOrgPeopleResponse>("/api/task-center/org-people");
      setData(response);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load people org structure.");
    } finally {
      setLoading(false);
    }
  }, [fetchJson]);

  useEffect(() => {
    void load();
  }, [load, storeId]);

  useEffect(() => {
    if (!selectedProfileId) {
      setDetail(null);
      setDetailError(null);
      setDetailLoading(false);
      return;
    }

    let cancelled = false;
    setDetailLoading(true);
    setDetailError(null);

    void (async () => {
      try {
        const response = await fetchJson<TaskCenterOrgPeopleDetailResponse>(
          `/api/task-center/org-people/${selectedProfileId}`,
        );
        if (!cancelled) setDetail(response);
      } catch (e) {
        if (!cancelled) {
          setDetail(null);
          setDetailError(e instanceof Error ? e.message : "Failed to load person details.");
        }
      } finally {
        if (!cancelled) setDetailLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [fetchJson, selectedProfileId, storeId]);

  if (loading) return <TaskCenterLoading />;
  if (error) return <p className="text-sm text-red-500">{error}</p>;
  if (!data) return null;

  if (data.people.length === 0) {
    return (
      <div className="space-y-4">
        <div className={`${TASK_CENTER_CARD_CLASS} mx-auto max-w-lg p-6 text-center`}>
          <Users className={`mx-auto mb-3 h-8 w-8 ${TASK_CENTER_MUTED}`} aria-hidden />
          <h3 className="text-base font-semibold">{TASK_CENTER_ORG_PEOPLE_EMPTY_TITLE}</h3>
          <p className={`mt-2 text-sm task-center-text-secondary`}>{TASK_CENTER_ORG_PEOPLE_EMPTY_DESCRIPTION}</p>
          <a href={TASK_CENTER_ORG_PEOPLE_SETTINGS_HREF} className={`${TASK_CENTER_LINK} mt-4 inline-flex items-center gap-1`}>
            Open People assignments
            <ExternalLink className="h-3.5 w-3.5" aria-hidden />
          </a>
        </div>
        <a href={TASK_CENTER_ORG_PEOPLE_SETTINGS_HREF} className={TASK_CENTER_CTA}>
          <ExternalLink className="h-4 w-4" aria-hidden />
          Assign people in System Settings
        </a>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className={`${TASK_CENTER_CARD_CLASS} p-4 sm:p-5`}>
        <div className="flex items-center gap-2">
          <Users className={`h-5 w-5 shrink-0 ${TASK_CENTER_MUTED}`} aria-hidden />
          <div>
            <p className="text-base font-bold">People hierarchy</p>
            <p className={`text-xs task-center-text-secondary`}>
              All people in your organization; reporting lines from current assignments.
            </p>
          </div>
        </div>
        <div className="mt-4 grid grid-cols-2 gap-3 sm:max-w-xs">
          <div className={TASK_CENTER_STAT_PILL}>
            <p className={`text-[11px] font-semibold uppercase tracking-wide ${TASK_CENTER_MUTED}`}>People</p>
            <p className="mt-0.5 text-lg font-bold tabular-nums">{data.people.length}</p>
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-4 lg:grid lg:grid-cols-2 lg:items-start">
        <section className="min-w-0">
          <h2 className="task-center-text-secondary mb-2 text-sm font-semibold">Reporting tree</h2>
          {data.tree.length === 0 ? (
            <p className="task-center-text-secondary text-sm">No manager hierarchy to display.</p>
          ) : (
            <TaskCenterOrgPeopleTree
              tree={data.tree}
              selectedProfileId={selectedProfileId}
              onSelect={setSelectedProfileId}
            />
          )}
        </section>

        <section className="min-w-0">
          <h2 className="task-center-text-secondary mb-2 text-sm font-semibold">Person details</h2>
          <TaskCenterOrgPeopleDetailPanel
            detail={detail}
            loading={detailLoading}
            error={detailError}
            hasSelection={selectedProfileId != null}
          />
        </section>
      </div>
    </div>
  );
}
