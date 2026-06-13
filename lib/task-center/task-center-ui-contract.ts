/**
 * Task Center UI routes, screens, and component map (read-only scaffold contract).
 */

import type { MenorixModuleNavItem } from "@/components/menorix";

export const TASK_CENTER_ROUTE_PREFIX = "/task-center";

export const TASK_CENTER_MODULE_LABEL = "Task Center";
export const TASK_CENTER_MODULE_TAGLINE = "Operations tasks";

export const TASK_CENTER_ROUTES = {
  home: "/task-center",
  my: "/task-center/my",
  queues: "/task-center/queues",
  team: "/task-center/queues",
  teamGroup: (groupKey: string) => `/task-center/team/${encodeURIComponent(groupKey)}`,
  sources: "/task-center/sources",
  sourcesScanner: "/task-center/sources/scanner",
  sourcesClaims: "/task-center/sources/claims",
  sourcesProduct: "/task-center/sources/product",
  sourcesAutomation: "/task-center/sources/automation",
  sourcesWarehouse: "/task-center/sources/warehouse",
  sourcesAdmin: "/task-center/sources/admin",
  overdue: "/task-center/overdue",
  blocked: "/task-center/blocked",
  done: "/task-center/done",
  org: "/task-center/org",
  detail: (taskId: string) => `/task-center/${encodeURIComponent(taskId)}`,
} as const;

export const TASK_CENTER_COMMAND_NAV: MenorixModuleNavItem[] = [
  { href: TASK_CENTER_ROUTES.home, label: "Home", shortLabel: "Home", exact: true },
  { href: TASK_CENTER_ROUTES.my, label: "My Tasks", shortLabel: "My" },
  { href: TASK_CENTER_ROUTES.queues, label: "Team / Queue", shortLabel: "Team" },
  { href: TASK_CENTER_ROUTES.sources, label: "Source Work", shortLabel: "Sources" },
  { href: TASK_CENTER_ROUTES.org, label: "Org Structure", shortLabel: "Org" },
];

export const TASK_CENTER_MOBILE_BOTTOM: MenorixModuleNavItem[] = [
  { href: TASK_CENTER_ROUTES.home, label: "Home", shortLabel: "Home", exact: true },
  { href: TASK_CENTER_ROUTES.my, label: "My", shortLabel: "My" },
  { href: TASK_CENTER_ROUTES.queues, label: "Team", shortLabel: "Team" },
];

export type TaskCenterScreenId =
  | "home"
  | "my_tasks"
  | "team_queue"
  | "team_group"
  | "source_hub"
  | "source_module"
  | "overdue"
  | "blocked"
  | "done"
  | "org_structure"
  | "task_detail";

/** Component map — file paths for Neda scaffold */
export const TASK_CENTER_COMPONENT_MAP = {
  shell: {
    TaskCenterAppShell: "components/task-center/TaskCenterAppShell.tsx",
    TaskCenterCommandBar: "components/task-center/TaskCenterCommandBar.tsx",
    TaskCenterMobileNav: "components/task-center/TaskCenterMobileNav.tsx",
    TaskCenterPhaseNotice: "components/task-center/TaskCenterPhaseNotice.tsx",
    TaskCenterScopeBar: "components/task-center/TaskCenterScopeBar.tsx",
  },
  home: {
    TaskCenterAttentionBoard: "components/task-center/TaskCenterAttentionBoard.tsx",
    TaskCenterKpiTile: "components/task-center/TaskCenterKpiTile.tsx",
    TaskCenterAttentionList: "components/task-center/TaskCenterAttentionList.tsx",
  },
  list: {
    TaskCenterTaskTable: "components/task-center/TaskCenterTaskTable.tsx",
    TaskCenterTaskCard: "components/task-center/TaskCenterTaskCard.tsx",
    TaskCenterFilterBar: "components/task-center/TaskCenterFilterBar.tsx",
    TaskCenterQueueTabs: "components/task-center/TaskCenterQueueTabs.tsx",
    TaskCenterSectionEmptyState: "components/task-center/TaskCenterSectionEmptyState.tsx",
  },
  detail: {
    TaskCenterDetailDrawer: "components/task-center/TaskCenterDetailDrawer.tsx",
    TaskCenterDetailPage: "components/task-center/TaskCenterDetailPage.tsx",
    TaskCenterSourceSnapshotPanel: "components/task-center/TaskCenterSourceSnapshotPanel.tsx",
    TaskCenterActivityTimeline: "components/task-center/TaskCenterActivityTimeline.tsx",
    TaskCenterCommentsThread: "components/task-center/TaskCenterCommentsThread.tsx",
    TaskCenterWatchersList: "components/task-center/TaskCenterWatchersList.tsx",
    TaskCenterStatusTimeline: "components/task-center/TaskCenterStatusTimeline.tsx",
    TaskCenterWriteGateFooter: "components/task-center/TaskCenterWriteGateFooter.tsx",
  },
  org: {
    TaskCenterOrgTree: "components/task-center/TaskCenterOrgTree.tsx",
    TaskCenterOrgGroupDetail: "components/task-center/TaskCenterOrgGroupDetail.tsx",
  },
  badges: {
    TaskCenterStatusBadge: "components/task-center/TaskCenterStatusBadge.tsx",
    TaskCenterPriorityBadge: "components/task-center/TaskCenterPriorityBadge.tsx",
    TaskCenterSourceBadge: "components/task-center/TaskCenterSourceBadge.tsx",
    TaskCenterDueBadge: "components/task-center/TaskCenterDueBadge.tsx",
  },
} as const;

export const TASK_CENTER_PAGE_FILES = {
  layout: "app/task-center/layout.tsx",
  home: "app/task-center/page.tsx",
  my: "app/task-center/my/page.tsx",
  team: "app/task-center/team/page.tsx",
  teamGroup: "app/task-center/team/[groupKey]/page.tsx",
  sources: "app/task-center/sources/page.tsx",
  sourcesScanner: "app/task-center/sources/scanner/page.tsx",
  sourcesClaims: "app/task-center/sources/claims/page.tsx",
  sourcesProduct: "app/task-center/sources/product/page.tsx",
  sourcesAutomation: "app/task-center/sources/automation/page.tsx",
  sourcesWarehouse: "app/task-center/sources/warehouse/page.tsx",
  sourcesAdmin: "app/task-center/sources/admin/page.tsx",
  overdue: "app/task-center/overdue/page.tsx",
  blocked: "app/task-center/blocked/page.tsx",
  done: "app/task-center/done/page.tsx",
  org: "app/task-center/org/page.tsx",
  detail: "app/task-center/[taskId]/page.tsx",
  theme: "app/task-center/task-center-theme.css",
} as const;

export const TASK_CENTER_NO_TOUCH_FILES = [
  "app/scanner/operator-mobile/**",
  "lib/scanner/**",
  "app/platform/access/**",
  "app/returns/actions.ts",
  "lib/product-resolver/**",
  "supabase/migrations/**",
] as const;

export const TASK_CENTER_PHASE_NOTICE_COPY = {
  schemaReady: "Task Center schema is live on staging — read-only UI phase.",
  writeDeferred: "Task write phase required (Phase 7B approval).",
  emptyPool: "No tasks yet — emitters and write bridge not connected.",
  scannerDeferred: "Scanner tasks display as future source filters only.",
} as const;
