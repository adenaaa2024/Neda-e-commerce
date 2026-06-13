/**
 * Menorix Module App Pattern — design contracts for standalone sellable modules.
 * Implementation varies by module; Claim Center is the reference implementation.
 */

export type MenorixModuleId =
  | "claim_center"
  | "returns_center"
  | "product_center"
  | "inventory_center"
  | "task_center"
  | "automation_center"
  | "ai_center"
  | "settings_center"
  | "reporting_center";

export type MenorixModuleTileContract = {
  id: string;
  title: string;
  description: string;
  route: string;
  nextAction: string;
};

export type MenorixModuleAppContract = {
  module_id: MenorixModuleId;
  route_prefix: string;
  display_name: string;
  home_purpose: string;
  main_tiles: MenorixModuleTileContract[];
  primary_queues: string[];
  detail_sections: string[];
  settings_route: string;
  ai_assist_slot: string;
  mobile_pattern: string;
  desktop_pattern: string;
  feature_gate: string;
  /** Only settings keys exposed by platform admin are customer-editable. */
  settings_policy: string;
};

export const CLAIM_CENTER_MODULE_CONTRACT: MenorixModuleAppContract = {
  module_id: "claim_center",
  route_prefix: "/claim-center",
  display_name: "Claim Center",
  home_purpose: "Recovery command dashboard — triage opportunities before case or filing actions.",
  main_tiles: [
    { id: "find_money", title: "Find money", description: "Highest recoverable opportunities.", route: "/claim-center/opportunities", nextAction: "Review top rows" },
    { id: "review", title: "Review blockers", description: "Blocked or ambiguous items needing review.", route: "/claim-center/candidates?filter=needs_review", nextAction: "Open review queue" },
    { id: "evidence", title: "Build evidence", description: "Missing photos, notes, or snapshots.", route: "/claim-center/evidence", nextAction: "Check evidence gaps" },
    { id: "pim", title: "Fix product links", description: "Unresolved catalog linkage.", route: "/claim-center/product-linkage", nextAction: "Open product match" },
  ],
  primary_queues: ["opportunities", "review", "evidence", "product-linkage"],
  detail_sections: ["timeline", "product", "shipment", "source snapshot", "evidence", "TRID graph", "policy result", "corroboration"],
  settings_route: "/claim-center/policies",
  ai_assist_slot: "Insight, evidence gap, draft claim, product image QA, reference explanation — assistive only",
  mobile_pattern: "Bottom nav (4 workflow) + More sheet + full-screen detail + Legacy tools menu",
  desktop_pattern: "Workflow rail + blockers secondary + Legacy tools menu + detail drawer",
  feature_gate: "claim_recovery module OR any enabled claim domain",
  settings_policy: "Hidden admin utility at settings_route — not primary nav; Rules used mini-panel in detail only",
};

export const RETURNS_CENTER_MODULE_CONTRACT: MenorixModuleAppContract = {
  module_id: "returns_center",
  route_prefix: "/returns-center",
  display_name: "Returns Center",
  home_purpose: "Return operations command — physical units, customer return analysis, issue detection (planning only).",
  main_tiles: [
    { id: "dashboard", title: "Return Dashboard", description: "Volume, SLA, and exception KPIs.", route: "/returns-center", nextAction: "View summary" },
    { id: "queues", title: "Return Queues", description: "Awaiting receive, QC, disposition.", route: "/returns-center/queues", nextAction: "Triage queue" },
    { id: "issues", title: "Product Issues", description: "Detected damage, wrong item, missing.", route: "/returns-center/issues", nextAction: "Review issues" },
    { id: "customer", title: "Customer Analysis", description: "Return reason patterns by customer/channel.", route: "/returns-center/customers", nextAction: "Analyze" },
    { id: "claims", title: "Return → Claim", description: "Eligible return_items linked to claim pool.", route: "/returns-center/claims-bridge", nextAction: "View bridge" },
    { id: "story", title: "Product Story", description: "Return → product identity narrative.", route: "/returns-center/product-story", nextAction: "Open story" },
  ],
  primary_queues: ["receive_queue", "qc_queue", "disposition_queue", "claim_eligible"],
  detail_sections: ["return identifiers", "physical anchor", "customer context", "issue tags", "claim eligibility", "product linkage"],
  settings_route: "/returns-center/settings",
  ai_assist_slot: "Return reason clustering, disposition suggestion — assistive only",
  mobile_pattern: "Card queues + bottom nav + detail sheet (does NOT replace scanner mobile)",
  desktop_pattern: "Command home + queue tables secondary",
  feature_gate: "returns module + warehouse scope",
  settings_policy: "Returns policy JSONB — platform-exposed keys only",
};

export const PRODUCT_CENTER_MODULE_CONTRACT: MenorixModuleAppContract = {
  module_id: "product_center",
  route_prefix: "/product-center",
  display_name: "Product Center",
  home_purpose: "Catalog command — PIM health, linkage, identifiers (contract only).",
  main_tiles: [
    { id: "catalog", title: "Catalog Hub", description: "Products and identifier map.", route: "/product-center", nextAction: "Browse catalog" },
    { id: "linkage", title: "Linkage Health", description: "Unresolved operational rows.", route: "/product-center/linkage", nextAction: "Fix links" },
    { id: "conflicts", title: "Identifier Conflicts", description: "Ambiguous map groups.", route: "/product-center/conflicts", nextAction: "Resolve" },
  ],
  primary_queues: ["unresolved", "conflicts", "draft_products"],
  detail_sections: ["identifiers", "catalog spine", "store map", "linkage contract", "audit trail"],
  settings_route: "/product-center/settings",
  ai_assist_slot: "Title enrichment suggestion — assistive only",
  mobile_pattern: "Card catalog browse + detail sheet",
  desktop_pattern: "Command + PIM table power view",
  feature_gate: "product_core / pim module",
  settings_policy: "PIM policy from platform admin",
};

export const INVENTORY_CENTER_MODULE_CONTRACT: MenorixModuleAppContract = {
  module_id: "inventory_center",
  route_prefix: "/inventory-center",
  display_name: "Inventory Center",
  home_purpose: "Stock command — FEFO, locations, adjustments (contract only).",
  main_tiles: [
    { id: "overview", title: "Stock Overview", description: "On-hand and reserved.", route: "/inventory-center", nextAction: "View KPIs" },
    { id: "fefo", title: "FEFO Queues", description: "Expiry and rotation alerts.", route: "/inventory-center/fefo", nextAction: "Review lots" },
  ],
  primary_queues: ["low_stock", "fefo_expiring", "adjustment_pending"],
  detail_sections: ["product", "location", "lot", "movement history"],
  settings_route: "/inventory-center/settings",
  ai_assist_slot: "Reorder hint — assistive only",
  mobile_pattern: "Location cards + scan-friendly sheets",
  desktop_pattern: "Command + warehouse table views",
  feature_gate: "inventory_fefo module",
  settings_policy: "FEFO thresholds in module_configs",
};

export const TASK_CENTER_MODULE_CONTRACT: MenorixModuleAppContract = {
  module_id: "task_center",
  route_prefix: "/task-center",
  display_name: "Task Center",
  home_purpose: "Operations tasks — assignment, queues, and module-linked work (read-only phase).",
  main_tiles: [
    { id: "my_tasks", title: "My Tasks", description: "Assigned to current user.", route: "/task-center/my", nextAction: "Start work" },
    { id: "team", title: "Team Queues", description: "Department and group workload.", route: "/task-center/queues", nextAction: "View queues" },
    { id: "claims", title: "Claims sources", description: "Work linked from claim modules.", route: "/task-center/sources/claims", nextAction: "View linked" },
    { id: "automation", title: "Automation sources", description: "Failed jobs needing human follow-up.", route: "/task-center/sources/automation", nextAction: "Triage errors" },
  ],
  primary_queues: ["open", "overdue", "unassigned", "module_linked"],
  detail_sections: ["assignee", "activity", "comments", "linked record", "due date", "priority"],
  settings_route: "/task-center/settings",
  ai_assist_slot: "Task summary and next-step suggestion — assistive only",
  mobile_pattern: "Task cards + swipe priorities + detail sheet",
  desktop_pattern: "Board + table + command home",
  feature_gate: "task_center module (future)",
  settings_policy: "Org structure and role permissions — admin configured",
};

export const AUTOMATION_CENTER_MODULE_CONTRACT: MenorixModuleAppContract = {
  module_id: "automation_center",
  route_prefix: "/platform/settings/automation",
  display_name: "Automation Center",
  home_purpose: "Schedules, API sync, generator health (existing platform surface).",
  main_tiles: [],
  primary_queues: ["schedules", "runs", "failures"],
  detail_sections: ["schedule", "last run", "source enablement"],
  settings_route: "/platform/settings/automation",
  ai_assist_slot: "Run failure explanation — assistive only",
  mobile_pattern: "Status cards + run detail sheets",
  desktop_pattern: "Platform command panels",
  feature_gate: "platform admin / automation module",
  settings_policy: "Platform workspace_settings.module_configs",
};

export const AI_CENTER_MODULE_CONTRACT: MenorixModuleAppContract = {
  module_id: "ai_center",
  route_prefix: "/ai-center",
  display_name: "AI Center",
  home_purpose: "Assistive AI configuration and usage — never source of truth (contract only).",
  main_tiles: [],
  primary_queues: ["assist_sessions", "agent_runs"],
  detail_sections: ["model config", "permissions", "audit log"],
  settings_route: "/ai-center/settings",
  ai_assist_slot: "N/A — this is the AI module itself",
  mobile_pattern: "Setup cards + locked states",
  desktop_pattern: "Admin command + policy tables",
  feature_gate: "ai_assistant + ai_agents entitlements",
  settings_policy: "Platform admin exposes AI keys and permitted surfaces",
};

export const SETTINGS_CENTER_MODULE_CONTRACT: MenorixModuleAppContract = {
  module_id: "settings_center",
  route_prefix: "/settings",
  display_name: "Settings Center",
  home_purpose: "Workspace, company, store configuration hub (existing).",
  main_tiles: [],
  primary_queues: [],
  detail_sections: ["tier", "effective value", "source", "editability"],
  settings_route: "/settings",
  ai_assist_slot: "Settings search helper — assistive only",
  mobile_pattern: "Section cards + drill-down sheets",
  desktop_pattern: "Three-tier settings navigation",
  feature_gate: "role-based settings RBAC",
  settings_policy: "Customer sees only platform-exposed settings keys",
};

export const REPORTING_CENTER_MODULE_CONTRACT: MenorixModuleAppContract = {
  module_id: "reporting_center",
  route_prefix: "/reporting",
  display_name: "Reporting Center",
  home_purpose: "Dashboards and exports (contract only).",
  main_tiles: [],
  primary_queues: ["scheduled_reports", "exports"],
  detail_sections: ["report definition", "schedule", "last run"],
  settings_route: "/reporting/settings",
  ai_assist_slot: "Report narrative summary — assistive only",
  mobile_pattern: "KPI cards + drill-down charts",
  desktop_pattern: "Command + chart grid",
  feature_gate: "reporting_dashboards module",
  settings_policy: "Report templates from platform admin",
};

export const MENORIX_MODULE_APP_CONTRACTS: Record<MenorixModuleId, MenorixModuleAppContract> = {
  claim_center: CLAIM_CENTER_MODULE_CONTRACT,
  returns_center: RETURNS_CENTER_MODULE_CONTRACT,
  product_center: PRODUCT_CENTER_MODULE_CONTRACT,
  inventory_center: INVENTORY_CENTER_MODULE_CONTRACT,
  task_center: TASK_CENTER_MODULE_CONTRACT,
  automation_center: AUTOMATION_CENTER_MODULE_CONTRACT,
  ai_center: AI_CENTER_MODULE_CONTRACT,
  settings_center: SETTINGS_CENTER_MODULE_CONTRACT,
  reporting_center: REPORTING_CENTER_MODULE_CONTRACT,
};
