"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { ExternalLink, Link2, LinkIcon, Sparkles } from "lucide-react";

import type { TaskCenterTaskListItem } from "@/lib/task-center/task-center-api-contract";
import { TASK_CENTER_ROUTES } from "@/lib/task-center/task-center-ui-contract";

import { useTaskCenter, TaskCenterLoading } from "./TaskCenterRootClient";
import { TaskCenterEmptyState } from "./TaskCenterEmptyState";
import { TaskCenterPhaseNotice } from "./TaskCenterPhaseNotice";
import { TaskCenterDueBadge } from "./TaskCenterDueBadge";
import { TaskCenterPriorityBadge } from "./TaskCenterPriorityBadge";
import { TaskCenterStatusBadge } from "./TaskCenterStatusBadge";
import { TASK_CENTER_CARD_CLASS, TASK_CENTER_PAGE_CLASS } from "./task-center-ui";

const EMPTY_TITLE = "No claim tasks yet";
const EMPTY_DESCRIPTION =
  "Claim task generation is not enabled yet. Once claim review tasks are created, they will appear here.";
const AI_DISCLAIMER = "AI summary is assistive only and may be incomplete.";

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

type LinkChip = { label: string; href: string | null };

/** Prefer module_context (deep_link/entity_label); fall back to source_snapshot; else null. */
function resolveLinkChip(task: TaskCenterTaskListItem): LinkChip | null {
  const ctx = task.module_context ?? {};
  const ctxLabel = nonEmptyString(ctx.entity_label);
  const ctxHref = nonEmptyString(ctx.deep_link);
  if (ctxLabel || ctxHref) return { label: ctxLabel ?? "Linked entity", href: ctxHref };

  const snap = (task.source_snapshot ?? {}) as Record<string, unknown>;
  const snapLabel = nonEmptyString(snap.entity_label);
  const snapHref = nonEmptyString(snap.deep_link_href) ?? nonEmptyString(snap.deep_link);
  if (snapLabel || snapHref) return { label: snapLabel ?? "Linked entity", href: snapHref };

  return null;
}

function ClaimLinkChip({ chip }: { chip: LinkChip | null }) {
  if (!chip) {
    return (
      <span
        className="inline-flex items-center gap-1 rounded-md border border-dashed px-2 py-0.5 text-[11px] font-medium opacity-50"
        title="This task has no linked entity context."
      >
        <Link2 className="h-3 w-3" aria-hidden /> No linked entity
      </span>
    );
  }

  const chipClass =
    "inline-flex max-w-full items-center gap-1 rounded-md bg-teal-500/10 px-2 py-0.5 text-[11px] font-semibold";

  if (!chip.href) {
    return (
      <span className={`${chipClass} opacity-80`}>
        <LinkIcon className="h-3 w-3 shrink-0" aria-hidden />
        <span className="truncate">{chip.label}</span>
      </span>
    );
  }

  const isExternal = /^https?:\/\//i.test(chip.href);
  if (isExternal) {
    return (
      <a
        href={chip.href}
        target="_blank"
        rel="noopener noreferrer"
        className={`${chipClass} hover:bg-teal-500/20`}
      >
        <ExternalLink className="h-3 w-3 shrink-0" aria-hidden />
        <span className="truncate">{chip.label}</span>
      </a>
    );
  }

  return (
    <Link href={chip.href} className={`${chipClass} hover:bg-teal-500/20`}>
      <LinkIcon className="h-3 w-3 shrink-0" aria-hidden />
      <span className="truncate">{chip.label}</span>
    </Link>
  );
}

function ClaimTaskCard({ task }: { task: TaskCenterTaskListItem }) {
  const chip = resolveLinkChip(task);
  const aiSummary = nonEmptyString((task.ai_summary ?? {}).summary);
  const assignee = task.assigned_user_name ?? task.assigned_group_name ?? "Unassigned";

  return (
    <div className={`${TASK_CENTER_CARD_CLASS} task-center-mobile-card p-4`}>
      <div className="flex flex-wrap items-center gap-2">
        <TaskCenterPriorityBadge priority={task.priority} />
        <TaskCenterStatusBadge status={task.status} />
        <TaskCenterDueBadge isOverdue={task.is_overdue} isDueSoon={task.is_due_soon} dueAt={task.due_at} />
      </div>

      <Link
        href={TASK_CENTER_ROUTES.detail(task.id)}
        className="mt-2 block font-semibold leading-snug hover:underline"
      >
        {task.title}
      </Link>

      <p className="mt-1 text-xs opacity-60">
        {assignee}
        {task.store_label ? ` · ${task.store_label}` : ""}
      </p>

      <div className="mt-3">
        <ClaimLinkChip chip={chip} />
      </div>

      {aiSummary ? (
        <div className="mt-3 rounded-lg border border-violet-400/30 bg-violet-500/5 p-3">
          <div className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide text-violet-600 dark:text-violet-300">
            <Sparkles className="h-3.5 w-3.5" aria-hidden /> AI Summary
          </div>
          <p className="mt-1.5 text-sm opacity-90">{aiSummary}</p>
          <p className="mt-1.5 text-[11px] italic opacity-55">{AI_DISCLAIMER}</p>
        </div>
      ) : null}
    </div>
  );
}

export function TaskCenterClaimsQueueView() {
  const { fetchJson, storeId } = useTaskCenter();
  const [tasks, setTasks] = useState<TaskCenterTaskListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchJson<{ items: TaskCenterTaskListItem[] }>("/api/task-center/claims", {
        limit: "100",
      });
      setTasks(data.items ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load claim tasks.");
    } finally {
      setLoading(false);
    }
  }, [fetchJson]);

  useEffect(() => {
    void load();
  }, [load, storeId]);

  return (
    <div className={TASK_CENTER_PAGE_CLASS}>
      <header>
        <h1 className="text-xl font-bold tracking-tight">Claims Queue</h1>
        <p className="mt-1 text-sm opacity-70">Claim review work linked from the Claims module.</p>
      </header>

      {loading ? <TaskCenterLoading /> : null}
      {error ? <p className="text-sm text-red-500">{error}</p> : null}

      {!loading && !error && tasks.length === 0 ? (
        <TaskCenterEmptyState title={EMPTY_TITLE} description={EMPTY_DESCRIPTION} />
      ) : null}

      {!loading && !error && tasks.length > 0 ? (
        <div className="space-y-3">
          {tasks.map((task) => (
            <ClaimTaskCard key={task.id} task={task} />
          ))}
        </div>
      ) : null}

      <TaskCenterPhaseNotice variant="write" />
    </div>
  );
}
