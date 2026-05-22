/**
 * Pure helpers for PIM Product Master import history UI.
 * Kept outside `"use server"` modules — Next.js requires server action files to export only async actions.
 */

/** Minimal row shape — compatible with `PimImportSessionListRow` from pim-import-actions. */
export type PimImportHistoryRowLike = {
  metadata?: Record<string, unknown> | null;
  preview_status?: string | null;
  lifecycle?: string | null;
  session_status?: string | null;
};

/** Terminal = completed import, user reset, or soft-deleted upload — excluded from active-import pick. */
export function pimHistoryRowIsTerminal(row: PimImportHistoryRowLike): boolean {
  const meta = row.metadata ?? {};
  const p = String(row.preview_status ?? "").toLowerCase();
  const life = String(row.lifecycle ?? "").toLowerCase();
  if (life === "completed" || p === "completed") return true;
  if (p === "reset") return true;
  if (meta.pim_upload_deleted === true || meta.deleted === true) return true;
  return false;
}

/** Successful Product Master apply finished (for history ordering — excludes reset/deleted). */
export function pimHistoryRowIsCompleted(row: PimImportHistoryRowLike): boolean {
  const meta = row.metadata && typeof row.metadata === "object" ? row.metadata : {};
  const job = (meta as { pim_import_job?: Record<string, unknown> }).pim_import_job ?? {};
  const life = String(job.lifecycle ?? "").toLowerCase();
  const pstat = String((meta as { preview_status?: string }).preview_status ?? "").toLowerCase();
  const ss = String(row.session_status ?? "").toLowerCase();
  return life === "completed" || pstat === "completed" || ss === "completed";
}

/** Mirrors server `userCanRunPimPriceBackfill` role keys — UI hint only; API still enforces. */
const PIM_PRICE_BACKFILL_ROLE_KEYS = new Set([
  "admin",
  "super_admin",
  "system_admin",
  "system_employee",
  "tenant_admin",
]);

export function pimUiMayRunPriceBackfill(canonicalRoleKey: string | null | undefined): boolean {
  const k = String(canonicalRoleKey ?? "").trim().toLowerCase();
  return PIM_PRICE_BACKFILL_ROLE_KEYS.has(k);
}
