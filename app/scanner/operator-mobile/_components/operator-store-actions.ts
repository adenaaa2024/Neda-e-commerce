"use server";

import { supabaseServer } from "@/lib/supabase-server";
import { getSessionUserIdFromCookies } from "@/lib/supabase-server-auth";
import { loadTenantProfile, resolveWriteOrganizationId } from "@/lib/server-tenant";
import { canPickWorkspaceOrganizationForTenantBranding } from "@/lib/tenant-branding-permissions";
import { isUuidString } from "@/lib/uuid";
import type { OperatorStoreOption } from "@/lib/scanner/operator-session";
import {
  findPalletByTrackingNormalized,
  type OperatorPalletTrackingRow,
} from "@/lib/scanner/operator-pallet-tracking";
import { normalizeTrackingKey } from "@/lib/scanner/tracking-normalize";
import { resolveAuditActorForSession, resolveDisplayLabelForUserId } from "@/lib/server-audit-actor";
import { sanitizePublicMediaUrlStrings } from "@/lib/entity-photo-evidence";
import { insertIntakeBoxPackage } from "@/lib/scanner/operator-box-intake";
import { insertUnknownPackageForTrackingCode } from "@/lib/scanner/operator-unknown-package";
import {
  fetchStoreDisplayNameForOrganization,
  formatUnauthorizedPackageInStoreMessage,
  formatUnauthorizedTrackingInStoreMessage,
} from "@/lib/scanner/operator-store-display";

export type OperatorStoreScopeSnapshot = {
  stores: OperatorStoreOption[];
  defaultStoreId: string | null;
};

function normalizeStoreRow(raw: unknown): OperatorStoreOption | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as { id?: unknown; name?: unknown; platform?: unknown };
  const id = typeof row.id === "string" ? row.id.trim() : "";
  if (!isUuidString(id)) return null;
  const name = typeof row.name === "string" && row.name.trim() ? row.name.trim() : "Store";
  const platform = typeof row.platform === "string" && row.platform.trim() ? row.platform.trim() : "unknown";
  return { id, name, platform };
}

/**
 * Server-side store scope resolver for operator scanner.
 * Uses service-role reads with explicit actor checks so super_admin workspace switch
 * can load selected org stores without being blocked by browser RLS policies.
 */
export async function getOperatorStoreScopeForOrganization(
  requestedOrganizationId: string | null | undefined,
): Promise<{ ok: true; snapshot: OperatorStoreScopeSnapshot } | { ok: false; error: string }> {
  const sessionUserId = await getSessionUserIdFromCookies();
  if (!sessionUserId || !isUuidString(sessionUserId)) {
    return { ok: false, error: "Not signed in." };
  }
  const profile = await loadTenantProfile(sessionUserId);
  if (!profile) {
    return { ok: false, error: "Profile not found." };
  }

  const req = String(requestedOrganizationId ?? "").trim();
  const reqOk = req && isUuidString(req) ? req : null;
  const canSwitchOrg = canPickWorkspaceOrganizationForTenantBranding(profile.role);
  const orgId = canSwitchOrg ? (reqOk ?? profile.organization_id) : profile.organization_id;

  const [storesRes, settingsRes] = await Promise.all([
    supabaseServer
      .from("stores")
      .select("id,name,platform")
      .eq("organization_id", orgId)
      .eq("is_active", true)
      .order("name", { ascending: true }),
    supabaseServer
      .from("organization_settings")
      .select("default_store_id")
      .eq("organization_id", orgId)
      .maybeSingle(),
  ]);

  if (storesRes.error) {
    return { ok: false, error: storesRes.error.message };
  }
  if (settingsRes.error) {
    return { ok: false, error: settingsRes.error.message };
  }

  const stores = (storesRes.data ?? [])
    .map(normalizeStoreRow)
    .filter((r): r is OperatorStoreOption => Boolean(r));
  const rawDefault = typeof settingsRes.data?.default_store_id === "string"
    ? settingsRes.data.default_store_id.trim()
    : "";
  const defaultStoreId = rawDefault && isUuidString(rawDefault) ? rawDefault : null;

  return {
    ok: true,
    snapshot: {
      stores,
      defaultStoreId,
    },
  };
}

export type OperatorPackageListRow = {
  id: string;
  package_code: string | null;
  tracking_number: string | null;
  id_slip_contents: string | null;
  notes?: string | null;
  outside_photo_urls?: unknown;
  inside_photo_urls?: unknown;
  slip_photo_urls?: unknown;
  expected_item_count?: number | null;
  actual_item_count?: number | null;
  created_at?: string | null;
  updated_at?: string | null;
  created_by?: string | null;
  updated_by?: string | null;
  /** Filled by {@link listOperatorPackagesForPalletAction} via profiles lookup. */
  created_by_display?: string | null;
  updated_by_display?: string | null;
};

async function enrichOperatorPackageRowsWithProfileLabels(
  rows: OperatorPackageListRow[],
): Promise<OperatorPackageListRow[]> {
  const ids = new Set<string>();
  for (const r of rows) {
    const cb = String(r.created_by ?? "").trim();
    const ub = String(r.updated_by ?? "").trim();
    if (isUuidString(cb)) ids.add(cb);
    if (isUuidString(ub)) ids.add(ub);
  }
  if (ids.size === 0) {
    return rows.map((r) => ({
      ...r,
      created_by_display: null,
      updated_by_display: null,
    }));
  }
  const idList = [...ids];
  const { data: profs, error } = await supabaseServer.from("profiles").select("id, full_name").in("id", idList);
  if (error) {
    console.warn("[enrichOperatorPackageRowsWithProfileLabels]", error.message);
    return rows.map((r) => ({
      ...r,
      created_by_display: null,
      updated_by_display: null,
    }));
  }
  const labelById = new Map<string, string>();
  for (const pr of profs ?? []) {
    const raw = pr as { id?: string; full_name?: string | null };
    const id = String(raw.id ?? "").trim();
    if (!isUuidString(id)) continue;
    const fn = String(raw.full_name ?? "").trim();
    labelById.set(id, fn || "Unknown");
  }
  return rows.map((r) => {
    const cb = String(r.created_by ?? "").trim();
    const ub = String(r.updated_by ?? "").trim();
    return {
      ...r,
      created_by_display: isUuidString(cb) ? (labelById.get(cb) ?? null) : null,
      updated_by_display: isUuidString(ub) ? (labelById.get(ub) ?? null) : null,
    };
  });
}

/**
 * BOX collaboration: list active packages on a pallet (service role + org resolution).
 * Scoped to `storeId` when provided so operators only see packages for the active store.
 */
export async function listOperatorPackagesForPalletAction(
  requestedOrganizationId: string,
  palletId: string,
  storeId?: string | null,
): Promise<{ ok: true; packages: OperatorPackageListRow[] } | { ok: false; message: string }> {
  const sessionUserId = await getSessionUserIdFromCookies();
  if (!sessionUserId || !isUuidString(sessionUserId)) {
    return { ok: false, message: "Not signed in." };
  }
  const pid = String(palletId ?? "").trim();
  if (!isUuidString(pid)) {
    return { ok: false, message: "Invalid pallet id." };
  }
  const organizationId = await resolveWriteOrganizationId(null, requestedOrganizationId);
  if (!organizationId || !isUuidString(organizationId)) {
    return { ok: false, message: "Could not resolve organization." };
  }
  const { data: pchk, error: perr } = await supabaseServer
    .from("pallets")
    .select("id, store_id")
    .eq("id", pid)
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (perr) return { ok: false, message: perr.message };
  if (!pchk) {
    return { ok: false, message: "Pallet not found for this organization." };
  }
  const storeScope = String(storeId ?? "").trim();
  const palletStore = String((pchk as { store_id?: string | null }).store_id ?? "").trim();
  if (storeScope && isUuidString(storeScope) && palletStore && isUuidString(palletStore) && palletStore !== storeScope) {
    return { ok: false, message: "This pallet belongs to another store — select the correct store." };
  }
  let pkgQuery = supabaseServer
    .from("packages")
    .select(
      // `notes` = packages.notes (plural). Do not use legacy discrepancy_note / operator_note column names.
      "id, package_code, tracking_number, id_slip_contents, notes, outside_photo_urls, inside_photo_urls, slip_photo_urls, expected_item_count, actual_item_count, created_at, updated_at, created_by, updated_by",
    )
    .eq("organization_id", organizationId)
    .eq("pallet_id", pid)
    .is("deleted_at", null);
  if (storeScope && isUuidString(storeScope)) {
    pkgQuery = pkgQuery.eq("store_id", storeScope);
  }
  const { data, error } = await pkgQuery.order("updated_at", { ascending: false });
  if (error) return { ok: false, message: error.message };
  const rawRows = (data ?? []) as OperatorPackageListRow[];
  const packages = await enrichOperatorPackageRowsWithProfileLabels(rawRows);
  return { ok: true, packages };
}

/** Row shape for hydrating BOX slip lines (matches `slip_contents` + client `mapSlipContentRowToVisionLine`). */
export type OperatorSlipContentsListRow = {
  /** `slip_contents.id` when loaded from DB — stable key for UI. */
  id: string | null;
  upc: string | null;
  fnsku: string | null;
  description: string | null;
  quantity: number;
  condition: string | null;
  /** Line-level JSON flags (e.g. `{ "missing": true }`) — not operator prose. */
  notes?: string | null;
  rma_number: string | null;
  sort_index: number;
  slip_code: string | null;
};

/**
 * Load `slip_contents` lines for a package (service role + org check).
 * Use this from the operator scan UI instead of browser Supabase, which may be blocked by RLS.
 */
export async function listOperatorSlipContentsForPackageAction(
  requestedOrganizationId: string,
  packageId: string,
  storeId?: string | null,
): Promise<{ ok: true; rows: OperatorSlipContentsListRow[] } | { ok: false; message: string }> {
  const sessionUserId = await getSessionUserIdFromCookies();
  if (!sessionUserId || !isUuidString(sessionUserId)) {
    return { ok: false, message: "Not signed in." };
  }
  const pkgId = String(packageId ?? "").trim();
  if (!isUuidString(pkgId)) {
    return { ok: false, message: "Invalid package id." };
  }
  const organizationId = await resolveWriteOrganizationId(null, requestedOrganizationId);
  if (!organizationId || !isUuidString(organizationId)) {
    return { ok: false, message: "Could not resolve organization." };
  }

  const { data: pkgRow, error: pkgSelErr } = await supabaseServer
    .from("packages")
    .select("id, store_id")
    .eq("id", pkgId)
    .eq("organization_id", organizationId)
    .is("deleted_at", null)
    .maybeSingle();
  if (pkgSelErr) return { ok: false, message: pkgSelErr.message };
  if (!pkgRow) {
    return { ok: false, message: "Package not found for this organization." };
  }
  const scope = String(storeId ?? "").trim();
  const pkgStore = String((pkgRow as { store_id?: string | null }).store_id ?? "").trim();
  if (scope && isUuidString(scope) && pkgStore && isUuidString(pkgStore) && pkgStore !== scope) {
    return { ok: false, message: "This package belongs to another store — select the correct store." };
  }

  const { data: rows, error } = await supabaseServer
    .from("slip_contents")
    .select("id, upc, fnsku, description, quantity, condition, rma_number, sort_index, slip_code")
    .eq("package_id", pkgId)
    .order("sort_index", { ascending: true });
  if (error) return { ok: false, message: error.message };

  const normalized: OperatorSlipContentsListRow[] = (rows ?? []).map((raw) => {
    const r = raw as Record<string, unknown>;
    const q = Number(r.quantity ?? 0);
    const idRaw = typeof r.id === "string" ? r.id.trim() : "";
    return {
      id: idRaw && isUuidString(idRaw) ? idRaw : null,
      upc: typeof r.upc === "string" && r.upc.trim() ? r.upc.trim() : null,
      fnsku: typeof r.fnsku === "string" && r.fnsku.trim() ? r.fnsku.trim() : null,
      description: typeof r.description === "string" && r.description.trim() ? r.description.trim() : null,
      quantity: Number.isFinite(q) && q >= 0 ? Math.floor(q) : 0,
      condition: typeof r.condition === "string" && r.condition.trim() ? r.condition.trim() : null,
      notes: typeof r.notes === "string" && r.notes.trim() ? r.notes.trim() : null,
      rma_number: typeof r.rma_number === "string" && r.rma_number.trim() ? r.rma_number.trim() : null,
      sort_index: Number.isFinite(Number(r.sort_index)) ? Math.floor(Number(r.sort_index)) : 0,
      slip_code: typeof r.slip_code === "string" && r.slip_code.trim() ? r.slip_code.trim() : null,
    };
  });

  return { ok: true, rows: normalized };
}

export type CreateOperatorPalletActionInput = {
  requestedOrganizationId: string;
  storeId: string;
  palletNumber: string;
  trackingNumber?: string | null;
  operatorPackageCount: number | null;
};

export type CreateOperatorPalletActionResult =
  | { ok: true; id: string; pallet_number: string }
  | { ok: false; error: string; duplicatePallet?: OperatorPalletTrackingRow; duplicateWrongStore?: boolean };

/** Save & Start (shipment commit) — service-role pallet update + audit columns. */
export type CommitOperatorPalletShipmentStepInput = {
  requestedOrganizationId: string;
  palletId: string;
  carrier_name: string | null;
  order_id: string | null;
  operator_package_count: number | null;
  tracking_number: string | null;
  /** Up to three shipping label images. */
  shipping_label_photo_urls: string[];
  /** Up to three pallet photos. */
  pallet_photo_urls: string[];
  /** Up to three BOL images. */
  bol_photo_urls: string[];
  /** Operator / collaboration notes (pallets.notes). */
  notes?: string | null;
};

export async function commitOperatorPalletShipmentStepAction(
  input: CommitOperatorPalletShipmentStepInput,
): Promise<
  | { ok: true; creatorDisplayLabel: string; createdByUserId: string | null }
  | { ok: false; message: string }
> {
  const palletId = String(input.palletId ?? "").trim();
  if (!isUuidString(palletId)) {
    return { ok: false, message: "Invalid pallet." };
  }

  const carrierTrimmed = String(input.carrier_name ?? "").trim();
  if (!carrierTrimmed) {
    return { ok: false, message: "Carrier is required — select or enter a carrier." };
  }

  const organizationId = await resolveWriteOrganizationId(null, input.requestedOrganizationId);
  if (!organizationId || !isUuidString(organizationId)) {
    return { ok: false, message: "Could not resolve organization." };
  }

  const actor = await resolveAuditActorForSession();

  const { data: existing, error: selErr } = await supabaseServer
    .from("pallets")
    .select("id, organization_id, created_by")
    .eq("id", palletId)
    .maybeSingle();

  if (selErr) return { ok: false, message: selErr.message };
  const ex = existing as {
    organization_id?: string | null;
    created_by?: string | null;
  } | null;
  if (!ex || String(ex.organization_id ?? "").trim() !== organizationId) {
    return { ok: false, message: "Pallet not found for this organization." };
  }

  const labelUrls = sanitizePublicMediaUrlStrings(input.shipping_label_photo_urls, 3);
  const palletUrls = sanitizePublicMediaUrlStrings(input.pallet_photo_urls, 3);
  const bolUrls = sanitizePublicMediaUrlStrings(input.bol_photo_urls, 3);

  if (!labelUrls.length) {
    return { ok: false, message: "At least one shipping label photo is required." };
  }

  const payload: Record<string, unknown> = {
    carrier_name: carrierTrimmed,
    order_id: input.order_id,
    operator_package_count: input.operator_package_count,
    tracking_number: input.tracking_number,
    shipping_label_urls: labelUrls,
    pallet_photo_urls: palletUrls,
    bol_photo_urls: bolUrls,
  };
  if (input.notes !== undefined) {
    const n = String(input.notes ?? "").trim();
    payload.notes = n.length ? n : null;
  }

  const creatorMissing = !(String(ex.created_by ?? "").trim());
  if (creatorMissing && actor.userId) {
    payload.created_by = actor.userId;
  }

  const { error: upErr } = await supabaseServer
    .from("pallets")
    .update(payload)
    .eq("id", palletId)
    .eq("organization_id", organizationId);

  if (upErr) return { ok: false, message: upErr.message };

  const { data: after } = await supabaseServer.from("pallets").select("created_by").eq("id", palletId).maybeSingle();
  const creatorId = String((after as { created_by?: string | null })?.created_by ?? "").trim();
  let creatorDisplayLabel = "Unknown";
  if (creatorId && isUuidString(creatorId)) {
    creatorDisplayLabel = (await resolveDisplayLabelForUserId(creatorId)) ?? "Unknown";
  }
  return {
    ok: true,
    creatorDisplayLabel,
    createdByUserId: creatorId && isUuidString(creatorId) ? creatorId : null,
  };
}

/**
 * Load an existing pallet in the org by inbound tracking (normalized match).
 * When `activeStoreId` is set, pallets registered to another store are hidden (`wrongStore`).
 */
const PALLET_TRACKING_DUP_SAME_STORE = "Tracking already exists in this store.";

async function palletDupResultFromExisting(
  existing: OperatorPalletTrackingRow,
  targetStoreId: string,
  organizationId: string,
): Promise<Extract<CreateOperatorPalletActionResult, { ok: false }>> {
  const es = String(existing.store_id ?? "").trim();
  const wrong = Boolean(es && isUuidString(es) && es !== targetStoreId);
  if (!wrong) {
    return {
      ok: false,
      error: PALLET_TRACKING_DUP_SAME_STORE,
      duplicatePallet: existing,
      duplicateWrongStore: false,
    };
  }
  const storeLabel =
    (await fetchStoreDisplayNameForOrganization(supabaseServer, organizationId, es)) ?? "";
  return {
    ok: false,
    error: formatUnauthorizedTrackingInStoreMessage(storeLabel),
    duplicateWrongStore: true,
  };
}

export async function findOperatorPalletByTrackingNumberAction(
  requestedOrganizationId: string,
  trackingNumber: string,
  activeStoreId?: string | null,
): Promise<
  | { ok: true; pallet: OperatorPalletTrackingRow | null; wrongStore?: boolean; wrongStoreMessage?: string }
  | { ok: false; error: string }
> {
  const sessionUserId = await getSessionUserIdFromCookies();
  if (!sessionUserId || !isUuidString(sessionUserId)) {
    return { ok: false, error: "Not signed in." };
  }

  const raw = String(trackingNumber ?? "").trim();
  if (!raw) {
    return { ok: true, pallet: null };
  }

  const organizationId = await resolveWriteOrganizationId(null, requestedOrganizationId);
  if (!organizationId || !isUuidString(organizationId)) {
    return { ok: false, error: "Could not resolve organization." };
  }

  try {
    const pallet = await findPalletByTrackingNormalized(supabaseServer, organizationId, raw);
    const active = String(activeStoreId ?? "").trim();
    if (pallet && active && isUuidString(active)) {
      const ps = String(pallet.store_id ?? "").trim();
      if (ps && isUuidString(ps) && ps !== active) {
        const storeLabel =
          (await fetchStoreDisplayNameForOrganization(supabaseServer, organizationId, ps)) ?? "";
        return {
          ok: true,
          pallet: null,
          wrongStore: true,
          wrongStoreMessage: formatUnauthorizedTrackingInStoreMessage(storeLabel),
        };
      }
    }
    return { ok: true, pallet };
  } catch (e) {
    const msg = formatSupabaseActionError(e, "Lookup failed.");
    console.error("[findOperatorPalletByTrackingNumberAction]", msg, e);
    return { ok: false, error: msg };
  }
}

function formatSupabaseActionError(e: unknown, fallback: string): string {
  if (e instanceof Error && e.message.trim()) return e.message.trim();
  if (e && typeof e === "object") {
    const o = e as { message?: unknown; details?: unknown; hint?: unknown; code?: unknown };
    const parts: string[] = [];
    if (typeof o.message === "string" && o.message.trim()) parts.push(o.message.trim());
    if (typeof o.details === "string" && o.details.trim()) parts.push(o.details.trim());
    if (typeof o.hint === "string" && o.hint.trim()) parts.push(o.hint.trim());
    if (typeof o.code === "string" && o.code.trim()) parts.push(`(${o.code})`);
    if (parts.length) return parts.join(" — ");
  }
  return fallback;
}

export async function createOperatorPalletAction(
  input: CreateOperatorPalletActionInput,
): Promise<CreateOperatorPalletActionResult> {
  const sessionUserId = await getSessionUserIdFromCookies();
  if (!sessionUserId || !isUuidString(sessionUserId)) {
    return { ok: false, error: "Not signed in." };
  }

  const palletNumber = String(input.palletNumber ?? "").trim();
  if (!palletNumber) {
    return { ok: false, error: "Pallet code is required." };
  }

  const storeId = String(input.storeId ?? "").trim();
  if (!isUuidString(storeId)) {
    return { ok: false, error: "Invalid store." };
  }

  const trackingRaw = input.trackingNumber != null ? String(input.trackingNumber).trim() : "";
  const tracking_number =
    normalizeTrackingKey(trackingRaw || palletNumber) || trackingRaw || palletNumber;

  const organizationId = await resolveWriteOrganizationId(null, input.requestedOrganizationId);
  if (!organizationId || !isUuidString(organizationId)) {
    return { ok: false, error: "Could not resolve organization." };
  }

  const { data: storeRow, error: storeErr } = await supabaseServer
    .from("stores")
    .select("id")
    .eq("id", storeId)
    .eq("organization_id", organizationId)
    .eq("is_active", true)
    .maybeSingle();
  if (storeErr) return { ok: false, error: storeErr.message };
  if (!storeRow) {
    return { ok: false, error: "Store not found for this organization." };
  }

  const pkgCount = input.operatorPackageCount;
  const operator_package_count =
    typeof pkgCount === "number" && Number.isFinite(pkgCount) ? pkgCount : null;

  const existing = await findPalletByTrackingNormalized(supabaseServer, organizationId, tracking_number);
  if (existing) {
    return palletDupResultFromExisting(existing, storeId, organizationId);
  }

  const actor = await resolveAuditActorForSession();
  const insertRow: Record<string, unknown> = {
    organization_id: organizationId,
    store_id: storeId,
    pallet_number: palletNumber,
    status: "open",
    tracking_number,
    operator_package_count,
  };
  if (actor.userId) insertRow.created_by = actor.userId;

  const { data, error } = await supabaseServer
    .from("pallets")
    .insert(insertRow)
    .select("id, pallet_number")
    .maybeSingle();

  if (error) {
    if (error.code === "23505") {
      const dup = await findPalletByTrackingNormalized(supabaseServer, organizationId, tracking_number);
      if (dup) {
        return palletDupResultFromExisting(dup, storeId, organizationId);
      }
      return { ok: false, error: PALLET_TRACKING_DUP_SAME_STORE };
    }
    return { ok: false, error: error.message };
  }
  const row = data as { id?: string; pallet_number?: string } | null;
  const id = typeof row?.id === "string" ? row.id.trim() : "";
  const pn = typeof row?.pallet_number === "string" ? row.pallet_number.trim() : "";
  if (!id || !pn) {
    return { ok: false, error: "Pallet insert returned no row." };
  }

  return { ok: true, id, pallet_number: pn };
}

export type InsertOperatorIntakeBoxPackageInput = {
  requestedOrganizationId: string;
  palletId: string | null;
  packageNumber: string;
  /** Parent shipment / pallet tracking — many boxes may share it; not used for upsert dedupe. */
  shipmentTrackingNumber?: string | null;
  storeId?: string | null;
};

export type InsertOperatorIntakeBoxPackageResult =
  | { ok: true; packageId: string; reusedExisting?: boolean }
  | { ok: false; message: string };

/**
 * BOX intake package insert — must run server-side with the service role so it still works when
 * the operator UI targets a workspace-selected org: browser RLS only allows
 * `packages.organization_id = profiles.organization_id` for the JWT user, not the switched tenant.
 */
export async function insertOperatorIntakeBoxPackageAction(
  input: InsertOperatorIntakeBoxPackageInput,
): Promise<InsertOperatorIntakeBoxPackageResult> {
  const sessionUserId = await getSessionUserIdFromCookies();
  if (!sessionUserId || !isUuidString(sessionUserId)) {
    return { ok: false, message: "Not signed in." };
  }

  const packageNumber = String(input.packageNumber ?? "").trim();
  if (!packageNumber) {
    return { ok: false, message: "Empty barcode." };
  }

  const organizationId = await resolveWriteOrganizationId(null, input.requestedOrganizationId);
  if (!organizationId || !isUuidString(organizationId)) {
    return { ok: false, message: "Could not resolve organization." };
  }

  const storeRaw = String(input.storeId ?? "").trim();
  if (storeRaw) {
    if (!isUuidString(storeRaw)) {
      return { ok: false, message: "Invalid store." };
    }
    const { data: storeRow, error: storeErr } = await supabaseServer
      .from("stores")
      .select("id")
      .eq("id", storeRaw)
      .eq("organization_id", organizationId)
      .eq("is_active", true)
      .maybeSingle();
    if (storeErr) return { ok: false, message: storeErr.message };
    if (!storeRow) {
      return { ok: false, message: "Store not found for this organization." };
    }
  }

  const palletRaw = input.palletId != null ? String(input.palletId).trim() : "";
  let palletIdFk: string | null = null;
  if (palletRaw && isUuidString(palletRaw)) {
    const { data: plt, error: pltErr } = await supabaseServer
      .from("pallets")
      .select("id")
      .eq("id", palletRaw)
      .eq("organization_id", organizationId)
      .maybeSingle();
    if (pltErr) return { ok: false, message: pltErr.message };
    if (!plt) {
      return { ok: false, message: "Pallet not found for this organization." };
    }
    palletIdFk = palletRaw;
  }

  let shipmentTracking =
    input.shipmentTrackingNumber != null ? String(input.shipmentTrackingNumber).trim() : "";
  if (!shipmentTracking && palletIdFk) {
    const { data: pltTn, error: pltTnErr } = await supabaseServer
      .from("pallets")
      .select("tracking_number")
      .eq("id", palletIdFk)
      .eq("organization_id", organizationId)
      .maybeSingle();
    if (!pltTnErr && pltTn) {
      shipmentTracking = String((pltTn as { tracking_number?: string | null }).tracking_number ?? "").trim();
    }
  }

  const actor = await resolveAuditActorForSession();
  return insertIntakeBoxPackage(supabaseServer, {
    organizationId,
    palletId: palletIdFk,
    packageNumber,
    shipmentTrackingNumber: shipmentTracking || null,
    storeId: storeRaw || null,
    created_by: actor.userId ?? null,
  });
}

export type InsertOperatorUnknownPackageInput = {
  requestedOrganizationId: string;
  storeId: string;
  scannedCode: string;
};

/**
 * Placeholder `packages` row for an unmatched tracking-style scan at identify gate.
 * Uses service role so workspace org selection still works (browser insert hits RLS).
 */
export async function insertOperatorUnknownPackageAction(
  input: InsertOperatorUnknownPackageInput,
): Promise<{ ok: true; packageId: string } | { ok: false; message: string }> {
  const sessionUserId = await getSessionUserIdFromCookies();
  if (!sessionUserId || !isUuidString(sessionUserId)) {
    return { ok: false, message: "Not signed in." };
  }

  const code = String(input.scannedCode ?? "").trim();
  if (!code) {
    return { ok: false, message: "Empty code." };
  }

  const organizationId = await resolveWriteOrganizationId(null, input.requestedOrganizationId);
  if (!organizationId || !isUuidString(organizationId)) {
    return { ok: false, message: "Could not resolve organization." };
  }

  const storeId = String(input.storeId ?? "").trim();
  if (!isUuidString(storeId)) {
    return { ok: false, message: "Invalid store." };
  }

  const { data: storeRow, error: storeErr } = await supabaseServer
    .from("stores")
    .select("id")
    .eq("id", storeId)
    .eq("organization_id", organizationId)
    .eq("is_active", true)
    .maybeSingle();
  if (storeErr) return { ok: false, message: storeErr.message };
  if (!storeRow) {
    return { ok: false, message: "Store not found for this organization." };
  }

  const actor = await resolveAuditActorForSession();
  return insertUnknownPackageForTrackingCode(supabaseServer, {
    organizationId,
    storeId,
    scannedCode: code,
    created_by: actor.userId ?? null,
  });
}

export type UpdateOperatorIntakeBoxPackageSlipLine = {
  upc: string | null;
  fnsku: string | null;
  description: string | null;
  expected_qty: number;
  condition: string | null;
  /** Line marked missing vs physical slip (persisted in manifest JSON + UI). */
  missing?: boolean;
};

/**
 * Secure BOX intake **update / upsert** (service role + `resolveWriteOrganizationId`).
 *
 * - **Package row**: only keys present on `packageUpdate` are written (partial patches supported).
 * - **Pallet** (optional): when `palletId` + `palletUpdate` are set, pallet must belong to the resolved org.
 * - **slip_contents**: `replace` **replaces** all rows for the package (delete where `package_id`, then insert `lines`).
 *   This avoids duplicate lines for the same package and matches a full “snapshot” of the current slip table.
 */
export type UpdateOperatorIntakeBoxPackageInput = {
  requestedOrganizationId: string;
  /** Session store — preferred for `slip_contents.store_id` when replacing lines. */
  storeId?: string | null;
  packageId: string;
  palletId?: string | null;
  palletUpdate?: {
    carrier_name: string;
    order_id: string | null;
    shipping_label_urls: string[];
  } | null;
  packageUpdate: {
    outside_photo_urls?: string[];
    inside_photo_urls?: string[];
    slip_photo_urls?: string[];
    package_code?: string | null;
    /** Parent shipment / pallet tracking — optional, not a unique key. */
    tracking_number?: string | null;
    id_slip_contents?: string | null;
    rma_number?: string | null;
    manifest_data?: Record<string, unknown>;
    /** packages.notes — collaboration / discrepancy text. */
    notes?: string | null;
  };
  slipContents:
    | { mode: "replace"; lines: UpdateOperatorIntakeBoxPackageSlipLine[]; slipCode: string | null }
    | { mode: "skip" };
};

/**
 * BOX intake package update (+ optional pallet + slip_contents replace).
 * Same workspace resolution as {@link insertOperatorIntakeBoxPackageAction}.
 */
export async function updateOperatorIntakeBoxPackageAction(
  input: UpdateOperatorIntakeBoxPackageInput,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const sessionUserId = await getSessionUserIdFromCookies();
  if (!sessionUserId || !isUuidString(sessionUserId)) {
    return { ok: false, message: "Not signed in." };
  }

  const packageId = String(input.packageId ?? "").trim();
  if (!isUuidString(packageId)) {
    return { ok: false, message: "Invalid package id." };
  }

  const organizationId = await resolveWriteOrganizationId(null, input.requestedOrganizationId);
  if (!organizationId || !isUuidString(organizationId)) {
    return { ok: false, message: "Could not resolve organization." };
  }

  const { data: pkgRow, error: pkgSelErr } = await supabaseServer
    .from("packages")
    .select("id, organization_id, store_id")
    .eq("id", packageId)
    .maybeSingle();
  if (pkgSelErr) return { ok: false, message: pkgSelErr.message };
  const pkgTyped = pkgRow as { organization_id?: string; store_id?: string | null } | null;
  const pkgOrg = String(pkgTyped?.organization_id ?? "").trim();
  if (!pkgRow || pkgOrg !== organizationId) {
    return { ok: false, message: "Package not found for this organization." };
  }

  const inputStoreRaw = input.storeId != null ? String(input.storeId).trim() : "";
  const pkgStoreRaw = String(pkgTyped?.store_id ?? "").trim();
  if (inputStoreRaw && isUuidString(inputStoreRaw) && pkgStoreRaw && isUuidString(pkgStoreRaw)) {
    if (pkgStoreRaw !== inputStoreRaw) {
      const storeLabel =
        (await fetchStoreDisplayNameForOrganization(supabaseServer, organizationId, pkgStoreRaw)) ?? "";
      return {
        ok: false,
        message: formatUnauthorizedPackageInStoreMessage(storeLabel),
      };
    }
  }
  const slipStoreId: string | null =
    inputStoreRaw && isUuidString(inputStoreRaw)
      ? inputStoreRaw
      : pkgStoreRaw && isUuidString(pkgStoreRaw)
        ? pkgStoreRaw
        : null;

  const actor = await resolveAuditActorForSession();
  const uid = actor.userId?.trim() || null;

  const palletRaw = input.palletId != null ? String(input.palletId).trim() : "";
  if (palletRaw && isUuidString(palletRaw) && input.palletUpdate) {
    const { data: plt, error: pltErr } = await supabaseServer
      .from("pallets")
      .select("id")
      .eq("id", palletRaw)
      .eq("organization_id", organizationId)
      .maybeSingle();
    if (pltErr) return { ok: false, message: pltErr.message };
    if (!plt) {
      return { ok: false, message: "Pallet not found for this organization." };
    }
    const labelUrls = sanitizePublicMediaUrlStrings(input.palletUpdate.shipping_label_urls, 3);
    const palletPatch: Record<string, unknown> = {
      carrier_name: input.palletUpdate.carrier_name,
      order_id: input.palletUpdate.order_id,
      shipping_label_urls: labelUrls,
      updated_at: new Date().toISOString(),
    };
    if (uid) palletPatch.updated_by = uid;
    const { error: pe } = await supabaseServer.from("pallets").update(palletPatch).eq("id", palletRaw);
    if (pe) return { ok: false, message: pe.message };
  }

  const pu = input.packageUpdate;
  const pkgPatch: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
  };
  if (pu.outside_photo_urls !== undefined) {
    pkgPatch.outside_photo_urls = sanitizePublicMediaUrlStrings(pu.outside_photo_urls, 3);
  }
  if (pu.inside_photo_urls !== undefined) {
    pkgPatch.inside_photo_urls = sanitizePublicMediaUrlStrings(pu.inside_photo_urls, 3);
  }
  if (pu.slip_photo_urls !== undefined) {
    pkgPatch.slip_photo_urls = sanitizePublicMediaUrlStrings(pu.slip_photo_urls, 3);
  }
  if (pu.package_code !== undefined) pkgPatch.package_code = pu.package_code;
  if (pu.tracking_number !== undefined) pkgPatch.tracking_number = pu.tracking_number;
  if (pu.id_slip_contents !== undefined) pkgPatch.id_slip_contents = pu.id_slip_contents;
  if (pu.rma_number !== undefined) pkgPatch.rma_number = pu.rma_number;
  if (pu.manifest_data !== undefined) pkgPatch.manifest_data = pu.manifest_data;
  if (pu.notes !== undefined) {
    const n = String(pu.notes ?? "").trim();
    pkgPatch.notes = n.length ? n : null;
  }
  if (uid) pkgPatch.updated_by = uid;

  const patchKeys = Object.keys(pkgPatch).filter((k) => k !== "updated_at" && k !== "updated_by");
  const didPalletUpdate = Boolean(palletRaw && isUuidString(palletRaw) && input.palletUpdate);
  const willReplaceSlipContents = input.slipContents.mode === "replace";
  if (!didPalletUpdate && !uid && patchKeys.length === 0 && !willReplaceSlipContents) {
    return { ok: false, message: "Nothing to update." };
  }

  if (patchKeys.length > 0 || uid) {
    const { error: pke } = await supabaseServer.from("packages").update(pkgPatch).eq("id", packageId);
    if (pke) return { ok: false, message: pke.message };
  }

  if (input.slipContents.mode === "replace") {
    const { error: delE } = await supabaseServer.from("slip_contents").delete().eq("package_id", packageId);
    if (delE) return { ok: false, message: delE.message };

    const lines = input.slipContents.lines;
    if (lines.length > 0) {
      const rmaPersist = pu.rma_number !== undefined ? pu.rma_number : null;
      const slipLineCode =
        input.slipContents.mode === "replace"
          ? String(input.slipContents.slipCode ?? "").trim() || null
          : null;
      const rows = lines.map((line, i) => ({
        organization_id: organizationId,
        package_id: packageId,
        store_id: slipStoreId,
        slip_code: slipLineCode,
        rma_number: rmaPersist,
        upc: line.upc?.trim() || null,
        fnsku: line.fnsku?.trim() || null,
        description: line.description?.trim() || null,
        quantity: line.expected_qty,
        condition: line.condition?.trim() || null,
        notes: line.missing ? JSON.stringify({ missing: true }) : null,
        sort_index: i,
        ...(uid ? { created_by: uid } : {}),
      }));
      const { error: insE } = await supabaseServer.from("slip_contents").insert(rows);
      if (insE) return { ok: false, message: insE.message };
    }
  }

  return { ok: true };
}
