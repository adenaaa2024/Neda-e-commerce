import type { TaskCenterPriority, TaskCenterSourceModule, TaskCenterStatus } from "./task-center-schema-contract";
import {
  fetchTaskActivity,
  fetchTaskCenterGroups,
  fetchTaskCenterSourceSummary,
  fetchTaskCenterSummary,
  fetchTaskCenterTaskById,
  fetchTaskCenterTasks,
  fetchTaskComments,
  fetchTaskWatchers,
} from "./task-center-read-model";
import type {
  TaskCenterGroupsResponse,
  TaskCenterSourceSummaryResponse,
  TaskCenterSummaryResponse,
  TaskCenterTaskDetailResponse,
  TaskCenterTasksListResponse,
} from "./task-center-api-contract";
import { TASK_CENTER_SOURCE_MODULE_LABELS } from "./task-center-schema-contract";

export class TaskCenterApiError extends Error {
  constructor(
    message: string,
    readonly status: number = 400,
  ) {
    super(message);
    this.name = "TaskCenterApiError";
  }
}

export async function getTaskCenterSummaryPayload(args: {
  organizationId: string;
  storeId: string | null;
  userId: string;
}): Promise<TaskCenterSummaryResponse> {
  const { counts, attention_task_ids } = await fetchTaskCenterSummary(args);
  return {
    organization_id: args.organizationId,
    store_id: args.storeId,
    counts,
    attention_task_ids,
    read_only: true,
    schema_phase: "7a",
  };
}

export async function getTaskCenterTasksPayload(args: {
  organizationId: string;
  storeId: string | null;
  userId: string;
  url: URL;
  limit: number;
}): Promise<TaskCenterTasksListResponse> {
  const { url, limit, ...scope } = args;
  const statusParam = url.searchParams.get("status");
  let status: TaskCenterStatus | TaskCenterStatus[] | undefined;
  if (statusParam) {
    status = statusParam.split(",").map((s) => s.trim()) as TaskCenterStatus[];
  }

  const sourceRaw = url.searchParams.get("source_module");
  const source_module =
    sourceRaw && sourceRaw in TASK_CENTER_SOURCE_MODULE_LABELS
      ? (sourceRaw as TaskCenterSourceModule)
      : undefined;

  const items = await fetchTaskCenterTasks({
    organizationId: scope.organizationId,
    storeId: scope.storeId,
    userId: scope.userId,
    limit,
    assigned_user_id: url.searchParams.get("assigned_user_id") ?? undefined,
    assigned_group_id: url.searchParams.get("assigned_group_id") ?? undefined,
    my_groups: url.searchParams.get("my_groups") === "1",
    source_module,
    status,
    priority: (url.searchParams.get("priority") as TaskCenterPriority | null) ?? undefined,
    overdue: url.searchParams.get("overdue") === "1",
    due_soon: url.searchParams.get("due_soon") === "1",
    blocked: url.searchParams.get("blocked") === "1",
  });

  return {
    items,
    next_cursor: null,
    total_estimate: items.length,
    read_only: true,
  };
}

export async function getTaskCenterTaskDetailPayload(args: {
  organizationId: string;
  taskId: string;
}): Promise<TaskCenterTaskDetailResponse> {
  const task = await fetchTaskCenterTaskById(args.organizationId, args.taskId);
  if (!task) throw new TaskCenterApiError("Task not found.", 404);

  const [comments, watchers, activity] = await Promise.all([
    fetchTaskComments(args.taskId),
    fetchTaskWatchers(args.taskId),
    fetchTaskActivity(args.taskId),
  ]);

  const snapshot = task.source_snapshot ?? {};
  const deepLink =
    typeof snapshot.deep_link_href === "string" && snapshot.deep_link_href.trim()
      ? snapshot.deep_link_href.trim()
      : null;

  const status_timeline = activity
    .filter((a) =>
      ["status_changed", "blocked", "unblocked", "completed", "canceled", "archived", "created"].includes(
        String((a as { event_type: string }).event_type),
      ),
    )
    .map((a) => {
      const row = a as { event_type: string; created_at: string; payload?: { status?: string } };
      const statusFromPayload = row.payload?.status;
      return {
        status: (statusFromPayload ?? (row.event_type === "created" ? "open" : task.status)) as TaskCenterStatus,
        at: row.created_at,
        actor_name: null,
      };
    });

  if (status_timeline.length === 0) {
    status_timeline.push({ status: task.status, at: task.created_at, actor_name: null });
  }

  return {
    task,
    comments: comments as TaskCenterTaskDetailResponse["comments"],
    watchers: (watchers as { id: string; task_id: string; profile_id: string; created_at: string }[]).map(
      (w) => ({ ...w, profile_name: null }),
    ),
    activity: activity as TaskCenterTaskDetailResponse["activity"],
    source_link: deepLink
      ? {
          href: deepLink,
          label: "View source record",
          external: !deepLink.startsWith("/task-center"),
        }
      : task.source_module
        ? {
            href: null,
            label: `${TASK_CENTER_SOURCE_MODULE_LABELS[task.source_module] ?? task.source_module} source`,
            external: false,
          }
        : null,
    status_timeline,
    read_only: true,
    write_phase_required: true,
  };
}

export async function getTaskCenterGroupsPayload(args: {
  organizationId: string;
  userId: string;
}): Promise<TaskCenterGroupsResponse> {
  const { groups, tree, my_group_ids } = await fetchTaskCenterGroups(args);
  return { groups, tree, my_group_ids, read_only: true };
}

export async function getTaskCenterSourceSummaryPayload(args: {
  organizationId: string;
  storeId: string | null;
}): Promise<TaskCenterSourceSummaryResponse> {
  const rows = await fetchTaskCenterSourceSummary(args);
  return { rows, read_only: true };
}
