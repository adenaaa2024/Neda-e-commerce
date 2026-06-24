/**
 * Task Center — DB-aligned schema contract (Phase 7A staging).
 * Source of truth: supabase/migrations/20260919120000_phase7a_task_center_schema_staging_rls_gated.sql
 * Read-only Phase 7A — no client writes.
 */

export const TASK_CENTER_ACTIVE_STATUSES = [
  "open",
  "in_progress",
  "blocked",
  "waiting",
] as const;

export const TASK_CENTER_TERMINAL_STATUSES = ["completed", "canceled", "archived"] as const;

export const TASK_CENTER_STATUSES = [
  ...TASK_CENTER_ACTIVE_STATUSES,
  ...TASK_CENTER_TERMINAL_STATUSES,
] as const;

export type TaskCenterStatus = (typeof TASK_CENTER_STATUSES)[number];

export const TASK_CENTER_PRIORITIES = ["low", "normal", "high", "urgent"] as const;

export type TaskCenterPriority = (typeof TASK_CENTER_PRIORITIES)[number];

/** DB CHECK constraint on task_items.source_module */
export const TASK_CENTER_SOURCE_MODULES = [
  "scanner",
  "claims",
  "product",
  "automation",
  "warehouse",
  "master_data",
  "platform",
] as const;

export type TaskCenterSourceModule = (typeof TASK_CENTER_SOURCE_MODULES)[number];

/** UI label "Admin" maps to DB value platform */
export const TASK_CENTER_SOURCE_MODULE_LABELS: Record<TaskCenterSourceModule, string> = {
  scanner: "Scanner",
  claims: "Claims",
  product: "Product / PIM",
  automation: "Automation",
  warehouse: "Warehouse",
  master_data: "Master data",
  platform: "Admin",
};

/**
 * UI/queue-facing module link discriminator (Phase 7A2 additive reconcile).
 * DB CHECK constraint on task_items.module_link_type — nullable.
 * Distinct from source_module: source_* is the low-level polymorphic identity,
 * module_link_type is the UI/queue contract surface.
 */
export const TASK_CENTER_MODULE_LINK_TYPES = [
  "claim_candidate",
  "claim_case",
  "claim_review_work_item",
  "scanner_review",
  "import_error",
  "automation_run",
  "manual_task",
] as const;

export type TaskCenterModuleLinkType = (typeof TASK_CENTER_MODULE_LINK_TYPES)[number];

/** The /task-center/claims queue reads task_items by these link types only — no claim-table joins. */
export const TASK_CENTER_CLAIMS_QUEUE_MODULE_LINK_TYPES = [
  "claim_candidate",
  "claim_case",
  "claim_review_work_item",
] as const satisfies readonly TaskCenterModuleLinkType[];

/** UI link-chip payload shape — assistive context, never source of truth. */
export type TaskCenterModuleContext = {
  deep_link?: string;
  entity_label?: string;
  source_module?: string;
  summary?: string;
  [key: string]: unknown;
};

/** Assistive AI summary — never authoritative. */
export type TaskCenterAiSummary = {
  summary?: string;
  confidence?: "low" | "medium" | "high";
  generated_at?: string;
  generated_by?: string;
  source_fields?: string[];
  [key: string]: unknown;
};

export const TASK_CENTER_GROUP_TYPES = [
  "access_group",
  "team",
  "department",
  "queue",
] as const;

export type TaskCenterGroupType = (typeof TASK_CENTER_GROUP_TYPES)[number];

export const TASK_CENTER_GROUP_TYPE_LABELS: Record<TaskCenterGroupType, string> = {
  access_group: "Access group",
  team: "Team",
  department: "Department",
  queue: "Queue",
};

export const TASK_CENTER_ACTIVITY_EVENT_TYPES = [
  "created",
  "status_changed",
  "priority_changed",
  "assigned",
  "unassigned",
  "group_assigned",
  "group_unassigned",
  "due_date_changed",
  "blocked",
  "unblocked",
  "comment_added",
  "watcher_added",
  "watcher_removed",
  "completed",
  "canceled",
  "archived",
  "source_linked",
] as const;

export type TaskCenterActivityEventType = (typeof TASK_CENTER_ACTIVITY_EVENT_TYPES)[number];

/** Row shape — mirrors public.task_items */
export type TaskCenterTaskItemRow = {
  id: string;
  organization_id: string;
  store_id: string | null;
  title: string;
  description: string | null;
  status: TaskCenterStatus;
  priority: TaskCenterPriority;
  source_module: TaskCenterSourceModule | null;
  source_entity_type: string | null;
  source_entity_id: string | null;
  source_snapshot: Record<string, unknown>;
  /** Phase 7A2 additive — UI/queue contract surface. Nullable. */
  module_link_type: TaskCenterModuleLinkType | null;
  module_context: TaskCenterModuleContext;
  ai_summary: TaskCenterAiSummary;
  assigned_user_id: string | null;
  assigned_group_id: string | null;
  created_by: string | null;
  due_at: string | null;
  completed_at: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
};

export type TaskCenterCommentRow = {
  id: string;
  task_id: string;
  author_user_id: string | null;
  body: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
};

export type TaskCenterWatcherRow = {
  id: string;
  task_id: string;
  profile_id: string;
  created_at: string;
};

export type TaskCenterActivityLogRow = {
  id: string;
  task_id: string;
  actor_user_id: string | null;
  event_type: TaskCenterActivityEventType;
  payload: Record<string, unknown>;
  created_at: string;
};

export type TaskCenterGroupRow = {
  id: string;
  organization_id: string;
  key: string;
  name: string;
  description: string | null;
  group_type: TaskCenterGroupType;
  parent_group_id: string | null;
  created_at: string | null;
};

/** Default list filter — active work only */
export const TASK_CENTER_DEFAULT_LIST_FILTER = {
  deleted_at: null as null,
  status_in: TASK_CENTER_ACTIVE_STATUSES,
} as const;
