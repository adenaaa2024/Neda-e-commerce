/** Automation card selector on Platform Automation (UI-only, not persisted settings). */

export type AutomationApiReportType =
  | "product_data_update"
  | "removal_shipment"
  | "reimbursements"
  | "settlement"
  | "finances_archive"
  | "older_backfill";

export const AUTOMATION_API_REPORT_TYPE_OPTIONS: {
  value: AutomationApiReportType;
  label: string;
}[] = [
  { value: "product_data_update", label: "Product Data Update" },
  { value: "removal_shipment", label: "Removal / Shipment Sync" },
  { value: "reimbursements", label: "Reimbursements API" },
  { value: "settlement", label: "Settlement API" },
  { value: "finances_archive", label: "Finances Archive API" },
  { value: "older_backfill", label: "Older Data Backfill" },
];

export const AUTOMATION_API_REPORT_TYPE_STORAGE_KEY = "platform-automation-report-type-v1";

export const AUTOMATION_SCOPE_STORAGE_KEY = "platform-automation-scope-v1";

export function readAutomationScopeStorage(): { orgId: string; storeId: string } {
  if (typeof window === "undefined") return { orgId: "", storeId: "" };
  try {
    const raw = window.localStorage.getItem(AUTOMATION_SCOPE_STORAGE_KEY);
    if (!raw) return { orgId: "", storeId: "" };
    const p = JSON.parse(raw) as { orgId?: string; storeId?: string };
    return { orgId: p.orgId ?? "", storeId: p.storeId ?? "" };
  } catch {
    return { orgId: "", storeId: "" };
  }
}

export function writeAutomationScopeStorage(orgId: string, storeId: string): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(
    AUTOMATION_SCOPE_STORAGE_KEY,
    JSON.stringify({ orgId, storeId }),
  );
}

export function readAutomationApiReportType(): AutomationApiReportType {
  if (typeof window === "undefined") return "product_data_update";
  try {
    const raw = window.localStorage.getItem(AUTOMATION_API_REPORT_TYPE_STORAGE_KEY);
    const match = AUTOMATION_API_REPORT_TYPE_OPTIONS.find((o) => o.value === raw);
    return match?.value ?? "product_data_update";
  } catch {
    return "product_data_update";
  }
}

export function writeAutomationApiReportType(value: AutomationApiReportType): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(AUTOMATION_API_REPORT_TYPE_STORAGE_KEY, value);
}
