/**
 * Task Center read API contract (Phase 7A — routes proposed, not yet implemented).
 * All handlers: server-only supabaseServer (service_role), org assert, no client writes.
 */

import type {
  TaskCenterActivityLogRow,
  TaskCenterCommentRow,
  TaskCenterGroupRow,
  TaskCenterPriority,
  TaskCenterSourceModule,
  TaskCenterStatus,
  TaskCenterTaskItemRow,
  TaskCenterWatcherRow,
} from "./task-center-schema-contract";
import type { TaskCenterOrgGroupDetail, TaskCenterOrgTreeNode } from "./task-center-org-display-contract";

/** Shared query params for list endpoints */
export type TaskCenterTasksQuery = {
  store_id?: string;
  status?: TaskCenterStatus | TaskCenterStatus[];
  priority?: TaskCenterPriority;
  source_module?: TaskCenterSourceModule;
  source_entity_type?: string;
  assigned_user_id?: string;
  assigned_group_id?: string;
  my_groups?: "1";
  overdue?: "1";
  due_soon?: "1";
  blocked?: "1";
  watched?: "1";
  q?: string;
  limit?: number;
  cursor?: string;
};

export type TaskCenterSummaryCounts = {
  open: number;
  assigned_to_me: number;
  assigned_to_my_groups: number;
  overdue: number;
  due_soon: number;
  blocked: number;
  waiting: number;
  by_source_module: Partial<Record<TaskCenterSourceModule, number>>;
};

export type TaskCenterSummaryResponse = {
  organization_id: string;
  store_id: string | null;
  counts: TaskCenterSummaryCounts;
  attention_task_ids: string[];
  read_only: true;
  schema_phase: "7a";
};

export type TaskCenterTaskListItem = TaskCenterTaskItemRow & {
  assigned_user_name: string | null;
  assigned_group_name: string | null;
  assigned_group_type: TaskCenterGroupRow["group_type"] | null;
  store_label: string | null;
  is_overdue: boolean;
  is_due_soon: boolean;
  comment_count: number;
  watcher_count: number;
};

export type TaskCenterTasksListResponse = {
  items: TaskCenterTaskListItem[];
  next_cursor: string | null;
  total_estimate: number | null;
  read_only: true;
};

export type TaskCenterTaskDetailResponse = {
  task: TaskCenterTaskListItem;
  comments: TaskCenterCommentRow[];
  watchers: (TaskCenterWatcherRow & { profile_name: string | null })[];
  activity: TaskCenterActivityLogRow[];
  source_link: {
    href: string | null;
    label: string;
    external: boolean;
  } | null;
  status_timeline: Array<{
    status: TaskCenterStatus;
    at: string;
    actor_name: string | null;
  }>;
  read_only: true;
  write_phase_required: true;
};

export type TaskCenterGroupsResponse = {
  groups: TaskCenterGroupRow[];
  tree: TaskCenterOrgTreeNode[];
  my_group_ids: string[];
  read_only: true;
};

export type TaskCenterGroupDetailResponse = TaskCenterOrgGroupDetail & {
  read_only: true;
};

export type TaskCenterSourceSummaryRow = {
  source_module: TaskCenterSourceModule;
  label: string;
  open_count: number;
  overdue_count: number;
  blocked_count: number;
};

export type TaskCenterSourceSummaryResponse = {
  rows: TaskCenterSourceSummaryRow[];
  read_only: true;
};

/** Proposed route map — implement in app/api/task-center/** */
export const TASK_CENTER_API_ROUTES = {
  summary: "GET /api/task-center/summary",
  tasks: "GET /api/task-center/tasks",
  taskById: "GET /api/task-center/tasks/[id]",
  groups: "GET /api/task-center/groups",
  groupById: "GET /api/task-center/groups/[id]",
  sourceSummary: "GET /api/task-center/source-summary",
} as const;

/** Due-soon window for summary + list filters (configurable later via module_configs) */
export const TASK_CENTER_DUE_SOON_DAYS = 7;

/** Deferred write actions — Phase 7B approval required */
export const TASK_CENTER_DEFERRED_WRITE_ACTIONS = [
  "create_task",
  "assign_task",
  "assign_group",
  "update_status",
  "update_priority",
  "set_due_date",
  "add_comment",
  "add_watcher",
  "remove_watcher",
  "complete_task",
  "cancel_task",
  "archive_task",
] as const;

export type TaskCenterDeferredWriteAction = (typeof TASK_CENTER_DEFERRED_WRITE_ACTIONS)[number];

export const TASK_CENTER_WRITE_PHASE_NOTICE =
  "Task write phase required — schema is read-only. Server actions deferred to Phase 7B approval.";
