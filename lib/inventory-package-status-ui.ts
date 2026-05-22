/**
 * v_inventory_status chip labels (package-level only — no product linkage).
 */

export const INVENTORY_PACKAGE_STATUS_LABEL: Record<string, string> = {
  complete: "Complete",
  expected: "Expected",
  in_progress: "In progress",
  in_progress_not: "Scanned (not expected)",
  unexpected: "Over scanned",
  not_registered: "Not registered",
};

export function inventoryPackageStatusLabel(status: string | null | undefined): string {
  if (!status?.trim()) return "Unknown";
  return INVENTORY_PACKAGE_STATUS_LABEL[status.trim()] ?? status.trim().replace(/_/g, " ");
}

export function inventoryPackageStatusChipClass(status: string | null | undefined): string {
  const s = status?.trim() ?? "";
  switch (s) {
    case "complete":
      return "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200";
    case "expected":
      return "bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-200";
    case "in_progress":
      return "bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-200";
    case "unexpected":
    case "in_progress_not":
      return "bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-200";
    default:
      return "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300";
  }
}
