/**
 * Static module / feature / meter catalogs (NEXT-PLATFORM-ENTITLEMENTS-02).
 * Pure data — no DB, env, or network. Not used for runtime enforcement yet.
 */

import type { FeatureCatalogEntry, MeterCatalogEntry, ModuleCatalogEntry } from "./types";

export const METER_CATALOG = {
  "seat.user": {
    displayName: "Billable user seat",
    unit: "boolean_slot",
    billable: true,
    aggregationWindow: "month",
    idempotencyScope: "per organization per user per billing period",
  },
  "store.active": {
    displayName: "Active connected store slot",
    unit: "boolean_slot",
    billable: true,
    aggregationWindow: "month",
    idempotencyScope: "per organization per store per billing period",
  },
  "ai.token": {
    displayName: "AI model tokens",
    unit: "token",
    billable: true,
    aggregationWindow: "day",
    idempotencyScope: "per organization per idempotency key",
  },
  "ai.credit": {
    displayName: "AI credits (normalized)",
    unit: "credit",
    billable: true,
    aggregationWindow: "billing_period",
    idempotencyScope: "per organization per idempotency key",
  },
  "ai.agent_run": {
    displayName: "Autonomous agent run",
    unit: "count",
    billable: true,
    aggregationWindow: "day",
    idempotencyScope: "per organization per agent run id",
  },
  "ocr.page": {
    displayName: "OCR page or slip image",
    unit: "page",
    billable: true,
    aggregationWindow: "day",
    idempotencyScope: "per store per document id",
  },
  "api.call": {
    displayName: "Outbound marketplace API call",
    unit: "call",
    billable: true,
    aggregationWindow: "day",
    idempotencyScope: "per store per provider request id",
  },
  "import.file": {
    displayName: "Import file processed",
    unit: "file",
    billable: true,
    aggregationWindow: "day",
    idempotencyScope: "per organization per file checksum",
  },
  "import.row": {
    displayName: "Import row committed",
    unit: "row",
    billable: true,
    aggregationWindow: "day",
    idempotencyScope: "per organization per import batch row id",
  },
  "claim.submission": {
    displayName: "Marketplace claim submission",
    unit: "count",
    billable: true,
    aggregationWindow: "month",
    idempotencyScope: "per store per marketplace submission id",
  },
  "claim.pdf": {
    displayName: "Claim PDF generated",
    unit: "count",
    billable: true,
    aggregationWindow: "day",
    idempotencyScope: "per organization per output artifact id",
  },
  "workflow.task": {
    displayName: "Workflow task mutation",
    unit: "count",
    billable: true,
    aggregationWindow: "day",
    idempotencyScope: "per organization per task transition id",
  },
  "workflow.repeat_task": {
    displayName: "Scheduled repeat / follow-up task",
    unit: "count",
    billable: true,
    aggregationWindow: "month",
    idempotencyScope: "per organization per recurrence instance id",
  },
  "report.run": {
    displayName: "Report or dashboard export run",
    unit: "count",
    billable: true,
    aggregationWindow: "day",
    idempotencyScope: "per organization per report run id",
  },
  "scanner.event": {
    displayName: "Scanner capture or decode event",
    unit: "count",
    billable: true,
    aggregationWindow: "day",
    idempotencyScope: "per store per scan session id",
  },
  "storage.gb_month": {
    displayName: "Storage gigabyte-months",
    unit: "gb_month",
    billable: true,
    aggregationWindow: "month",
    idempotencyScope: "per organization per monthly snapshot",
  },
  "sales.lookup": {
    displayName: "Sales intelligence lookup",
    unit: "count",
    billable: true,
    aggregationWindow: "day",
    idempotencyScope: "per store per lookup id",
  },
  "forecast.run": {
    displayName: "Inventory forecast model run",
    unit: "count",
    billable: true,
    aggregationWindow: "day",
    idempotencyScope: "per store per forecast job id",
  },
} as const satisfies Record<string, MeterCatalogEntry>;

export type MeterKey = keyof typeof METER_CATALOG;

export const MODULE_CATALOG = {
  core_platform: {
    displayName: "Core Platform",
    scope: "tenant",
    description:
      "Organizations, users, sessions, roles, audit, baseline settings, and cross-cutting APIs not owned by a vertical module.",
    dependencies: [],
    standaloneBehavior: "Always-on foundation; other modules assume it is present.",
  },
  pim_product_graph: {
    displayName: "PIM / Product graph",
    scope: "tenant",
    description: "Canonical product graph, identifiers, catalog structure, and PIM workflows.",
    dependencies: ["core_platform"],
    standaloneBehavior: "Exports and read-only snapshots when downstream sync features are off.",
  },
  imports_etl: {
    displayName: "Imports / ETL",
    scope: "tenant",
    description: "File and row ingest, staging, validation, and promotion into domain tables.",
    dependencies: ["core_platform"],
    standaloneBehavior: "Error reports and manual CSV download when target modules are disabled.",
  },
  marketplace_api_sync: {
    displayName: "Marketplace API sync",
    scope: "store",
    description: "Outbound marketplace REST/stream integrations for orders, inventory, reports, and claims feeds.",
    dependencies: ["core_platform"],
    standaloneBehavior: "Raw payload archive and manual replay instructions when PIM or warehouse writes are off.",
  },
  returns: {
    displayName: "Returns",
    scope: "store",
    description: "Return intake, disposition, and RMA alignment with marketplace events.",
    dependencies: ["core_platform"],
    standaloneBehavior: "Local queue and CSV export without AI triage or automated graph updates.",
  },
  smart_scanner: {
    displayName: "Smart scanner",
    scope: "store",
    description: "Device and camera capture, barcode/label decode, and scan session orchestration.",
    dependencies: ["core_platform"],
    standaloneBehavior: "Captured media and decode text with manual SKU mapping when graph features are off.",
  },
  ocr_slip_reader: {
    displayName: "OCR / slip reader",
    scope: "store",
    description: "Slip and receipt OCR, field extraction, and confidence scoring.",
    dependencies: ["core_platform", "smart_scanner"],
    standaloneBehavior: "Raw OCR JSON and human confirmation queue without auto-posting to claims or inventory.",
  },
  warehouse: {
    displayName: "Warehouse",
    scope: "store",
    description: "Locations, pallets, moves, and operational warehouse state.",
    dependencies: ["core_platform"],
    standaloneBehavior: "Paper-style pick lists and CSV move logs without FEFO automation.",
  },
  inventory_fefo: {
    displayName: "Inventory / FEFO",
    scope: "store",
    description: "Lots, expiry, allocation, and FEFO-aware availability.",
    dependencies: ["core_platform", "warehouse"],
    standaloneBehavior: "Static availability snapshot export when accounting or sync downstream is disabled.",
  },
  claims_inbox: {
    displayName: "Claims inbox",
    scope: "store",
    description: "Read-only claim candidate queues, lineage, and triage surfaces.",
    dependencies: ["core_platform"],
    standaloneBehavior: "CSV export of candidates and evidence pointers without workflow or submission.",
  },
  claims_workflow: {
    displayName: "Claims workflow",
    scope: "store",
    description: "Tasks, approvals, SLAs, PDFs, and internal claim operations before marketplace submit.",
    dependencies: ["core_platform", "claims_inbox"],
    standaloneBehavior: "Task list and evidence pack ZIP with manual marketplace upload instructions.",
  },
  marketplace_claim_submit: {
    displayName: "Marketplace claim submission",
    scope: "store",
    description: "Submitting claims and evidence packages to marketplace APIs.",
    dependencies: ["core_platform", "claims_workflow"],
    standaloneBehavior: "Packaged submission payload and operator checklist when API submit is disabled.",
  },
  reimbursements: {
    displayName: "Reimbursements",
    scope: "tenant",
    description: "Reimbursement tracking, payout linkage, and financial reconciliation for claims outcomes.",
    dependencies: ["core_platform", "claims_workflow"],
    standaloneBehavior: "Spreadsheet-style reimbursement tracker export without ledger postings.",
  },
  sales_intelligence: {
    displayName: "Sales intelligence",
    scope: "store",
    description: "Rank, share, competitive signals, and sales opportunity surfacing.",
    dependencies: ["core_platform", "marketplace_api_sync"],
    standaloneBehavior: "Last cached snapshot or stale-data banner with CSV export of last good run.",
  },
  inventory_forecasting: {
    displayName: "Inventory forecasting",
    scope: "store",
    description: "Demand, lead time, and inventory projection models.",
    dependencies: ["core_platform", "inventory_fefo", "marketplace_api_sync"],
    standaloneBehavior: "Heuristic forecast CSV from a static sales slice without auto PO suggestions.",
  },
  purchase_recommendations: {
    displayName: "Purchase recommendations",
    scope: "store",
    description: "Suggested purchase orders and reorder points from forecasts and rules.",
    dependencies: ["core_platform", "inventory_forecasting"],
    standaloneBehavior: "Rule-of-thumb recommendation list with disclaimers when automation is off.",
  },
  pricing_intelligence: {
    displayName: "Pricing intelligence",
    scope: "store",
    description: "Competitive pricing signals and elasticity hints tied to catalog and marketplace data.",
    dependencies: ["core_platform", "marketplace_api_sync"],
    standaloneBehavior: "Static price comparison table export without live repricing actions.",
  },
  ai_assistant: {
    displayName: "AI assistant",
    scope: "tenant",
    description: "Interactive copilot and assisted authoring across permitted surfaces.",
    dependencies: ["core_platform"],
    standaloneBehavior: "Static help content and templated responses when model calls are disabled.",
  },
  ai_agents: {
    displayName: "AI agents",
    scope: "tenant",
    description: "Tool-using and scheduled autonomous agents with guardrails.",
    dependencies: ["core_platform", "ai_assistant"],
    standaloneBehavior: "Manual runbooks and step checklists mirroring agent workflows without execution.",
  },
  reporting_dashboards: {
    displayName: "Reporting / dashboards",
    scope: "tenant",
    description: "Dashboards, scheduled reports, and export scheduling.",
    dependencies: ["core_platform"],
    standaloneBehavior: "Ad hoc CSV extracts from base tables without advanced scheduling.",
  },
  accounting_cost_basis: {
    displayName: "Accounting / cost basis",
    scope: "tenant",
    description: "COGS layers, adjustments, and GL-ready cost basis outputs.",
    dependencies: ["core_platform", "inventory_fefo"],
    standaloneBehavior: "GL-ready CSV without posting when downstream accounting is off.",
  },
  hr_operator_performance: {
    displayName: "HR / operator performance",
    scope: "tenant",
    description: "Labor metrics, throughput scorecards, and operator coaching signals.",
    dependencies: ["core_platform", "warehouse"],
    standaloneBehavior: "Aggregate CSV from clock and task events without scoring models.",
  },
  white_label_platform_admin: {
    displayName: "White-label / platform admin",
    scope: "platform",
    description: "Reseller branding, tenant provisioning, and cross-tenant platform administration.",
    dependencies: ["core_platform"],
    standaloneBehavior: "Standard platform admin only; reseller features remain off until entitled.",
  },
} as const satisfies Record<string, ModuleCatalogEntry>;

export type ModuleKey = keyof typeof MODULE_CATALOG;

export const FEATURE_CATALOG = {
  "claims.inbox.read": {
    moduleKey: "claims_inbox",
    scope: "store",
    risk: "low",
    requiresStore: true,
    meterKeys: ["report.run"],
    dependencies: [],
    disabledBehavior: "Inbox routes return entitlement denial; offer export-only or upgrade messaging.",
  },
  "claims.workflow.task_create": {
    moduleKey: "claims_workflow",
    scope: "store",
    risk: "medium",
    requiresStore: true,
    meterKeys: ["workflow.task"],
    dependencies: ["claims.inbox.read"],
    disabledBehavior: "Read-only inbox remains; task mutations blocked with manual checklist export.",
  },
  "claims.marketplace_submit": {
    moduleKey: "marketplace_claim_submit",
    scope: "store",
    risk: "high",
    requiresStore: true,
    meterKeys: ["claim.submission", "api.call"],
    dependencies: ["claims.workflow.task_create"],
    disabledBehavior: "Evidence package ZIP and operator instructions; no outbound marketplace submit.",
  },
  "claims.pdf_generation": {
    moduleKey: "claims_workflow",
    scope: "store",
    risk: "low",
    requiresStore: true,
    meterKeys: ["claim.pdf"],
    dependencies: ["claims.inbox.read"],
    disabledBehavior: "Inline HTML summary only; PDF artifact not created.",
  },
  "claims.repeat_followup": {
    moduleKey: "claims_workflow",
    scope: "store",
    risk: "medium",
    requiresStore: true,
    meterKeys: ["workflow.repeat_task"],
    dependencies: ["claims.workflow.task_create"],
    disabledBehavior: "One-off tasks only; no scheduled follow-ups.",
  },
  "claims.sla_escalation": {
    moduleKey: "claims_workflow",
    scope: "store",
    risk: "medium",
    requiresStore: true,
    meterKeys: ["workflow.task"],
    dependencies: ["claims.workflow.task_create"],
    disabledBehavior: "SLA timers visible but no auto-escalation actions.",
  },
  "claims.ai.draft": {
    moduleKey: "ai_assistant",
    scope: "store",
    risk: "medium",
    requiresStore: true,
    meterKeys: ["ai.token", "ai.credit"],
    dependencies: ["claims.inbox.read"],
    disabledBehavior: "Static templates only; no model-generated draft text.",
  },
  "claims.ai.autonomous_agent": {
    moduleKey: "ai_agents",
    scope: "store",
    risk: "high",
    requiresStore: true,
    meterKeys: ["ai.agent_run", "ai.credit"],
    dependencies: ["claims.ai.draft"],
    disabledBehavior: "Manual triage queue; agent runner not scheduled.",
  },
  "returns.scanner.capture": {
    moduleKey: "smart_scanner",
    scope: "store",
    risk: "low",
    requiresStore: true,
    meterKeys: ["scanner.event", "storage.gb_month"],
    dependencies: [],
    disabledBehavior: "Manual SKU entry path only; device capture disabled.",
  },
  "returns.ai.triage": {
    moduleKey: "returns",
    scope: "store",
    risk: "medium",
    requiresStore: true,
    meterKeys: ["ai.token", "ai.credit"],
    dependencies: ["returns.scanner.capture"],
    disabledBehavior: "Returns queue without AI classification; human triage only.",
  },
  "warehouse.pallets": {
    moduleKey: "warehouse",
    scope: "store",
    risk: "low",
    requiresStore: true,
    meterKeys: ["workflow.task"],
    dependencies: [],
    disabledBehavior: "Location-only operations; pallet entities read-only or hidden.",
  },
  "warehouse.locations": {
    moduleKey: "warehouse",
    scope: "store",
    risk: "low",
    requiresStore: true,
    meterKeys: [],
    dependencies: [],
    disabledBehavior: "Warehouse map read-only; no bin mutations.",
  },
  "warehouse.disposal": {
    moduleKey: "warehouse",
    scope: "store",
    risk: "medium",
    requiresStore: true,
    meterKeys: ["workflow.task"],
    dependencies: ["warehouse.locations"],
    disabledBehavior: "Disposal requests logged as CSV for manual processing.",
  },
  "inventory.fefo.allocate": {
    moduleKey: "inventory_fefo",
    scope: "store",
    risk: "medium",
    requiresStore: true,
    meterKeys: ["workflow.task"],
    dependencies: ["warehouse.locations"],
    disabledBehavior: "Manual FIFO list export without automated allocation.",
  },
  "inventory.forecasting.run": {
    moduleKey: "inventory_forecasting",
    scope: "store",
    risk: "low",
    requiresStore: true,
    meterKeys: ["forecast.run", "report.run"],
    dependencies: ["inventory.fefo.allocate"],
    disabledBehavior: "Last forecast snapshot read-only; run button disabled.",
  },
  "api.amazon.sync.orders": {
    moduleKey: "marketplace_api_sync",
    scope: "store",
    risk: "medium",
    requiresStore: true,
    meterKeys: ["api.call", "import.row"],
    dependencies: [],
    disabledBehavior: "Manual order CSV import path only.",
  },
  "api.walmart.sync.inventory": {
    moduleKey: "marketplace_api_sync",
    scope: "store",
    risk: "medium",
    requiresStore: true,
    meterKeys: ["api.call", "import.row"],
    dependencies: [],
    disabledBehavior: "Stale inventory banner with last sync timestamp.",
  },
  "ocr.slip_reader.page": {
    moduleKey: "ocr_slip_reader",
    scope: "store",
    risk: "low",
    requiresStore: true,
    meterKeys: ["ocr.page", "ai.credit"],
    dependencies: ["returns.scanner.capture"],
    disabledBehavior: "Upload retained; OCR not run until entitled.",
  },
  "reports.advanced.scheduled": {
    moduleKey: "reporting_dashboards",
    scope: "tenant",
    risk: "low",
    requiresStore: false,
    meterKeys: ["report.run", "storage.gb_month"],
    dependencies: [],
    disabledBehavior: "On-demand small CSV only; schedules not created.",
  },
  "sales.rank_tracking": {
    moduleKey: "sales_intelligence",
    scope: "store",
    risk: "low",
    requiresStore: true,
    meterKeys: ["sales.lookup", "api.call"],
    dependencies: ["api.amazon.sync.orders"],
    disabledBehavior: "Cached rank table with stale-at timestamp; no live refresh.",
  },
  "sales.opportunity_finder": {
    moduleKey: "sales_intelligence",
    scope: "store",
    risk: "medium",
    requiresStore: true,
    meterKeys: ["sales.lookup", "ai.credit"],
    dependencies: ["sales.rank_tracking"],
    disabledBehavior: "Rank table only; opportunity heuristics hidden.",
  },
} as const satisfies Record<string, FeatureCatalogEntry>;

export type FeatureKey = keyof typeof FEATURE_CATALOG;

const MODULE_KEYS = new Set<string>(Object.keys(MODULE_CATALOG));
const FEATURE_KEYS = new Set<string>(Object.keys(FEATURE_CATALOG));
const METER_KEYS = new Set<string>(Object.keys(METER_CATALOG));

export function isModuleKey(k: string): k is ModuleKey {
  return MODULE_KEYS.has(k);
}

export function isFeatureKey(k: string): k is FeatureKey {
  return FEATURE_KEYS.has(k);
}

export function isMeterKey(k: string): k is MeterKey {
  return METER_KEYS.has(k);
}

export function getModule(key: ModuleKey): ModuleCatalogEntry {
  return MODULE_CATALOG[key];
}

export function getFeature(key: FeatureKey): FeatureCatalogEntry {
  return FEATURE_CATALOG[key];
}

export function getMeter(key: MeterKey): MeterCatalogEntry {
  return METER_CATALOG[key];
}

export type {
  AggregationWindow,
  FeatureCatalogEntry,
  FeatureRisk,
  MeterCatalogEntry,
  MeterUnit,
  ModuleCatalogEntry,
  ModuleScope,
} from "./types";
