/**
 * Task Center read model — server-only queries against Phase 7A schema.
 */

import { supabaseServer } from "@/lib/supabase-server";

import {
  TASK_CENTER_ACTIVE_STATUSES,
  TASK_CENTER_SOURCE_MODULE_LABELS,
  TASK_CENTER_SOURCE_MODULES,
  type TaskCenterGroupRow,
  type TaskCenterGroupType,
  type TaskCenterPriority,
  type TaskCenterSourceModule,
  type TaskCenterStatus,
  type TaskCenterTaskItemRow,
} from "./task-center-schema-contract";
import {
  TASK_CENTER_DUE_SOON_DAYS,
  type TaskCenterSummaryCounts,
  type TaskCenterTaskListItem,
} from "./task-center-api-contract";
import { buildTaskCenterOrgTree, type TaskCenterOrgTreeNode } from "./task-center-org-display-contract";

const ACTIVE = [...TASK_CENTER_ACTIVE_STATUSES];

function nowIso(): string {
  return new Date().toISOString();
}

function dueSoonEndIso(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + TASK_CENTER_DUE_SOON_DAYS);
  return d.toISOString();
}

function mapTaskRow(raw: Record<string, unknown>): TaskCenterTaskItemRow {
  return {
    id: String(raw.id ?? ""),
    organization_id: String(raw.organization_id ?? ""),
    store_id: raw.store_id != null ? String(raw.store_id) : null,
    title: String(raw.title ?? ""),
    description: raw.description != null ? String(raw.description) : null,
    status: String(raw.status ?? "open") as TaskCenterStatus,
    priority: String(raw.priority ?? "normal") as TaskCenterPriority,
    source_module: raw.source_module != null ? (String(raw.source_module) as TaskCenterSourceModule) : null,
    source_entity_type: raw.source_entity_type != null ? String(raw.source_entity_type) : null,
    source_entity_id: raw.source_entity_id != null ? String(raw.source_entity_id) : null,
    source_snapshot:
      raw.source_snapshot && typeof raw.source_snapshot === "object" && !Array.isArray(raw.source_snapshot)
        ? (raw.source_snapshot as Record<string, unknown>)
        : {},
    assigned_user_id: raw.assigned_user_id != null ? String(raw.assigned_user_id) : null,
    assigned_group_id: raw.assigned_group_id != null ? String(raw.assigned_group_id) : null,
    created_by: raw.created_by != null ? String(raw.created_by) : null,
    due_at: raw.due_at != null ? String(raw.due_at) : null,
    completed_at: raw.completed_at != null ? String(raw.completed_at) : null,
    metadata:
      raw.metadata && typeof raw.metadata === "object" && !Array.isArray(raw.metadata)
        ? (raw.metadata as Record<string, unknown>)
        : {},
    created_at: String(raw.created_at ?? ""),
    updated_at: String(raw.updated_at ?? ""),
    deleted_at: raw.deleted_at != null ? String(raw.deleted_at) : null,
  };
}

function mapGroupRow(raw: Record<string, unknown>): TaskCenterGroupRow {
  return {
    id: String(raw.id ?? ""),
    organization_id: String(raw.organization_id ?? ""),
    key: String(raw.key ?? ""),
    name: String(raw.name ?? ""),
    description: raw.description != null ? String(raw.description) : null,
    group_type: (String(raw.group_type ?? "access_group") as TaskCenterGroupType),
    parent_group_id: raw.parent_group_id != null ? String(raw.parent_group_id) : null,
    created_at: raw.created_at != null ? String(raw.created_at) : null,
  };
}

function baseActiveQuery(organizationId: string, storeId: string | null) {
  let q = supabaseServer
    .from("task_items")
    .select("*")
    .eq("organization_id", organizationId)
    .is("deleted_at", null)
    .in("status", ACTIVE);
  if (storeId) q = q.eq("store_id", storeId);
  return q;
}

async function countActive(
  organizationId: string,
  storeId: string | null,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  extra?: (q: any) => any,
): Promise<number> {
  let q = supabaseServer
    .from("task_items")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", organizationId)
    .is("deleted_at", null)
    .in("status", ACTIVE);
  if (storeId) q = q.eq("store_id", storeId);
  if (extra) q = extra(q);
  const { count, error } = await q;
  if (error) throw new Error(error.message);
  return count ?? 0;
}

export async function getMyGroupIds(organizationId: string, userId: string): Promise<string[]> {
  const { data, error } = await supabaseServer
    .from("user_groups")
    .select("group_id")
    .eq("profile_id", userId);
  if (error) throw new Error(error.message);
  const candidateIds = (data ?? []).map((r) => String((r as { group_id: string }).group_id)).filter(Boolean);
  if (candidateIds.length === 0) return [];

  const { data: groups, error: gErr } = await supabaseServer
    .from("groups")
    .select("id")
    .eq("organization_id", organizationId)
    .in("id", candidateIds);
  if (gErr) throw new Error(gErr.message);
  return (groups ?? []).map((g) => String((g as { id: string }).id));
}

export async function enrichTaskListItems(rows: TaskCenterTaskItemRow[]): Promise<TaskCenterTaskListItem[]> {
  if (rows.length === 0) return [];

  const userIds = [...new Set(rows.map((r) => r.assigned_user_id).filter(Boolean))] as string[];
  const groupIds = [...new Set(rows.map((r) => r.assigned_group_id).filter(Boolean))] as string[];
  const storeIds = [...new Set(rows.map((r) => r.store_id).filter(Boolean))] as string[];
  const taskIds = rows.map((r) => r.id);

  const [profiles, groups, stores, comments, watchers] = await Promise.all([
    userIds.length
      ? supabaseServer.from("profiles").select("id, full_name").in("id", userIds)
      : Promise.resolve({ data: [] as { id: string; full_name: string | null }[] }),
    groupIds.length
      ? supabaseServer.from("groups").select("id, name, group_type").in("id", groupIds)
      : Promise.resolve({ data: [] as { id: string; name: string; group_type: string }[] }),
    storeIds.length
      ? supabaseServer.from("stores").select("id, name").in("id", storeIds)
      : Promise.resolve({ data: [] as { id: string; name: string }[] }),
    supabaseServer.from("task_comments").select("task_id").in("task_id", taskIds).is("deleted_at", null),
    supabaseServer.from("task_watchers").select("task_id").in("task_id", taskIds),
  ]);

  const profileMap = new Map((profiles.data ?? []).map((p) => [p.id, p.full_name]));
  const groupMap = new Map(
    (groups.data ?? []).map((g) => [g.id, { name: g.name, group_type: g.group_type as TaskCenterGroupType }]),
  );
  const storeMap = new Map((stores.data ?? []).map((s) => [s.id, s.name]));

  const commentCounts = new Map<string, number>();
  for (const c of comments.data ?? []) {
    const tid = String((c as { task_id: string }).task_id);
    commentCounts.set(tid, (commentCounts.get(tid) ?? 0) + 1);
  }
  const watcherCounts = new Map<string, number>();
  for (const w of watchers.data ?? []) {
    const tid = String((w as { task_id: string }).task_id);
    watcherCounts.set(tid, (watcherCounts.get(tid) ?? 0) + 1);
  }

  const now = nowIso();
  const dueSoonEnd = dueSoonEndIso();

  return rows.map((row) => {
    const isOverdue = !!row.due_at && row.due_at < now;
    const isDueSoon = !!row.due_at && row.due_at >= now && row.due_at <= dueSoonEnd;
    const g = row.assigned_group_id ? groupMap.get(row.assigned_group_id) : null;
    return {
      ...row,
      assigned_user_name: row.assigned_user_id ? profileMap.get(row.assigned_user_id) ?? null : null,
      assigned_group_name: g?.name ?? null,
      assigned_group_type: g?.group_type ?? null,
      store_label: row.store_id ? storeMap.get(row.store_id) ?? null : null,
      is_overdue: isOverdue,
      is_due_soon: isDueSoon,
      comment_count: commentCounts.get(row.id) ?? 0,
      watcher_count: watcherCounts.get(row.id) ?? 0,
    };
  });
}

export async function fetchTaskCenterSummary(args: {
  organizationId: string;
  storeId: string | null;
  userId: string;
}): Promise<{ counts: TaskCenterSummaryCounts; attention_task_ids: string[] }> {
  const { organizationId, storeId, userId } = args;
  const myGroupIds = await getMyGroupIds(organizationId, userId);
  const now = nowIso();
  const dueSoonEnd = dueSoonEndIso();

  const [open, assignedToMe, blocked, waiting, overdue, dueSoon, myGroups] = await Promise.all([
    countActive(organizationId, storeId),
    countActive(organizationId, storeId, (q) => q.eq("assigned_user_id", userId)),
    countActive(organizationId, storeId, (q) => q.eq("status", "blocked")),
    countActive(organizationId, storeId, (q) => q.eq("status", "waiting")),
    countActive(organizationId, storeId, (q) => q.lt("due_at", now).not("due_at", "is", null)),
    countActive(organizationId, storeId, (q) =>
      q.gte("due_at", now).lte("due_at", dueSoonEnd),
    ),
    myGroupIds.length
      ? countActive(organizationId, storeId, (q) => q.in("assigned_group_id", myGroupIds))
      : Promise.resolve(0),
  ]);

  const by_source_module: Partial<Record<TaskCenterSourceModule, number>> = {};
  await Promise.all(
    TASK_CENTER_SOURCE_MODULES.map(async (mod) => {
      by_source_module[mod] = await countActive(organizationId, storeId, (q) =>
        q.eq("source_module", mod),
      );
    }),
  );

  const attentionQ = baseActiveQuery(organizationId, storeId)
    .order("priority", { ascending: false })
    .order("due_at", { ascending: true, nullsFirst: false })
    .limit(10);
  const { data: attentionRows } = await attentionQ;
  const attention_task_ids = (attentionRows ?? []).map((r) => String((r as { id: string }).id));

  return {
    counts: {
      open,
      assigned_to_me: assignedToMe,
      assigned_to_my_groups: myGroups,
      overdue,
      due_soon: dueSoon,
      blocked,
      waiting,
      by_source_module,
    },
    attention_task_ids,
  };
}

export type TaskListFilters = {
  organizationId: string;
  storeId: string | null;
  userId: string;
  assigned_user_id?: string;
  assigned_group_id?: string;
  my_groups?: boolean;
  source_module?: TaskCenterSourceModule;
  status?: TaskCenterStatus | TaskCenterStatus[];
  priority?: TaskCenterPriority;
  overdue?: boolean;
  due_soon?: boolean;
  blocked?: boolean;
  limit?: number;
};

export async function fetchTaskCenterTasks(filters: TaskListFilters): Promise<TaskCenterTaskListItem[]> {
  const limit = filters.limit ?? 50;
  let q = supabaseServer
    .from("task_items")
    .select("*")
    .eq("organization_id", filters.organizationId)
    .is("deleted_at", null);

  if (filters.storeId) q = q.eq("store_id", filters.storeId);

  if (filters.status) {
    const statuses = Array.isArray(filters.status) ? filters.status : [filters.status];
    q = q.in("status", statuses);
  } else {
    q = q.in("status", ACTIVE);
  }

  if (filters.assigned_user_id) q = q.eq("assigned_user_id", filters.assigned_user_id);
  if (filters.assigned_group_id) q = q.eq("assigned_group_id", filters.assigned_group_id);
  if (filters.my_groups) {
    const gids = await getMyGroupIds(filters.organizationId, filters.userId);
    if (gids.length === 0) return [];
    q = q.in("assigned_group_id", gids);
  }
  if (filters.source_module) q = q.eq("source_module", filters.source_module);
  if (filters.priority) q = q.eq("priority", filters.priority);
  if (filters.blocked) q = q.eq("status", "blocked");
  if (filters.overdue) {
    q = q.lt("due_at", nowIso()).not("due_at", "is", null);
  }
  if (filters.due_soon) {
    q = q.gte("due_at", nowIso()).lte("due_at", dueSoonEndIso());
  }

  q = q.order("due_at", { ascending: true, nullsFirst: false }).order("created_at", { ascending: false }).limit(limit);

  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return enrichTaskListItems((data ?? []).map((r) => mapTaskRow(r as Record<string, unknown>)));
}

export async function fetchTaskCenterTaskById(
  organizationId: string,
  taskId: string,
): Promise<TaskCenterTaskListItem | null> {
  const { data, error } = await supabaseServer
    .from("task_items")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("id", taskId)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return null;
  const [item] = await enrichTaskListItems([mapTaskRow(data as Record<string, unknown>)]);
  return item ?? null;
}

export async function fetchTaskCenterGroups(args: {
  organizationId: string;
  userId: string;
}): Promise<{
  groups: TaskCenterGroupRow[];
  tree: ReturnType<typeof buildTaskCenterOrgTree>;
  my_group_ids: string[];
  member_counts: Record<string, number>;
  open_task_counts: Record<string, number>;
}> {
  const { organizationId, userId } = args;
  const { data: groupRows, error } = await supabaseServer
    .from("groups")
    .select("id, organization_id, key, name, description, group_type, parent_group_id, created_at")
    .eq("organization_id", organizationId)
    .order("name", { ascending: true });
  if (error) throw new Error(error.message);

  const groups = (groupRows ?? []).map((r) => mapGroupRow(r as Record<string, unknown>));
  const my_group_ids = await getMyGroupIds(organizationId, userId);

  const member_counts: Record<string, number> = {};
  if (groups.length) {
    const { data: ugRows } = await supabaseServer
      .from("user_groups")
      .select("group_id")
      .in(
        "group_id",
        groups.map((g) => g.id),
      );
    for (const row of ugRows ?? []) {
      const gid = String((row as { group_id: string }).group_id);
      member_counts[gid] = (member_counts[gid] ?? 0) + 1;
    }
  }

  const open_task_counts: Record<string, number> = {};
  for (const g of groups) {
    open_task_counts[g.id] = await countActive(organizationId, null, (q) =>
      q.eq("assigned_group_id", g.id),
    );
  }

  function annotate(node: TaskCenterOrgTreeNode): TaskCenterOrgTreeNode {
    return {
      ...node,
      member_count: member_counts[node.id] ?? 0,
      open_task_count: open_task_counts[node.id] ?? 0,
      children: node.children.map(annotate),
    };
  }

  const tree = buildTaskCenterOrgTree(groups).map(annotate);

  return { groups, tree, my_group_ids, member_counts, open_task_counts };
}

export async function fetchTaskCenterSourceSummary(args: {
  organizationId: string;
  storeId: string | null;
}): Promise<
  Array<{
    source_module: TaskCenterSourceModule;
    label: string;
    open_count: number;
    overdue_count: number;
    blocked_count: number;
  }>
> {
  const { organizationId, storeId } = args;
  const now = nowIso();
  const rows = await Promise.all(
    TASK_CENTER_SOURCE_MODULES.map(async (source_module) => {
      const [open_count, overdue_count, blocked_count] = await Promise.all([
        countActive(organizationId, storeId, (q) => q.eq("source_module", source_module)),
        countActive(organizationId, storeId, (q) =>
          q.eq("source_module", source_module).lt("due_at", now).not("due_at", "is", null),
        ),
        countActive(organizationId, storeId, (q) =>
          q.eq("source_module", source_module).eq("status", "blocked"),
        ),
      ]);
      return {
        source_module,
        label: TASK_CENTER_SOURCE_MODULE_LABELS[source_module],
        open_count,
        overdue_count,
        blocked_count,
      };
    }),
  );
  return rows;
}

export async function fetchTaskComments(taskId: string) {
  const { data, error } = await supabaseServer
    .from("task_comments")
    .select("id, task_id, author_user_id, body, created_at, updated_at, deleted_at")
    .eq("task_id", taskId)
    .is("deleted_at", null)
    .order("created_at", { ascending: true });
  if (error) throw new Error(error.message);
  return data ?? [];
}

export async function fetchTaskWatchers(taskId: string) {
  const { data, error } = await supabaseServer
    .from("task_watchers")
    .select("id, task_id, profile_id, created_at")
    .eq("task_id", taskId);
  if (error) throw new Error(error.message);
  return data ?? [];
}

export async function fetchTaskActivity(taskId: string) {
  const { data, error } = await supabaseServer
    .from("task_activity_log")
    .select("id, task_id, actor_user_id, event_type, payload, created_at")
    .eq("task_id", taskId)
    .order("created_at", { ascending: true });
  if (error) throw new Error(error.message);
  return data ?? [];
}
