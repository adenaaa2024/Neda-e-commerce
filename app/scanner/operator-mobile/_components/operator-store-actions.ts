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
import { mergeOperatorPalletShipmentPhotoEvidence, sanitizePublicMediaUrlStrings } from "@/lib/entity-photo-evidence";

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

export type CreateOperatorPalletActionInput = {
  requestedOrganizationId: string;
  storeId: string;
  palletNumber: string;
  trackingNumber?: string | null;
  operatorPackageCount: number | null;
};

export type CreateOperatorPalletActionResult =
  | { ok: true; id: string; pallet_number: string }
  | { ok: false; error: string; duplicatePallet?: OperatorPalletTrackingRow };

/** Save & Start (shipment commit) — service-role pallet update + audit columns. */
export type CommitOperatorPalletShipmentStepInput = {
  requestedOrganizationId: string;
  palletId: string;
  carrier_name: string | null;
  order_id: string | null;
  operator_package_count: number | null;
  tracking_number: string | null;
  /** Up to three label images — `[0]` mirrors `manifest_photo_url`; full list stored in `photo_evidence.label_urls`. */
  shipping_label_photo_urls: string[];
  /** Up to three pallet photos — `[0]` mirrors `photo_url`; full list in `photo_evidence.pallet_urls`. */
  pallet_photo_urls: string[];
  /** Up to three BOL images — `[0]` mirrors `bol_photo_url`; full list in `photo_evidence.bol_urls`. */
  bol_photo_urls: string[];
};

export async function commitOperatorPalletShipmentStepAction(
  input: CommitOperatorPalletShipmentStepInput,
): Promise<
  | { ok: true; creatorDisplayLabel: string }
  | { ok: false; message: string }
> {
  const palletId = String(input.palletId ?? "").trim();
  if (!isUuidString(palletId)) {
    return { ok: false, message: "Invalid pallet." };
  }

  const organizationId = await resolveWriteOrganizationId(null, input.requestedOrganizationId);
  if (!organizationId || !isUuidString(organizationId)) {
    return { ok: false, message: "Could not resolve organization." };
  }

  const actor = await resolveAuditActorForSession();

  const { data: existing, error: selErr } = await supabaseServer
    .from("pallets")
    .select("id, organization_id, created_by, photo_evidence")
    .eq("id", palletId)
    .maybeSingle();

  if (selErr) return { ok: false, message: selErr.message };
  const ex = existing as {
    organization_id?: string | null;
    created_by?: string | null;
    photo_evidence?: unknown;
  } | null;
  if (!ex || String(ex.organization_id ?? "").trim() !== organizationId) {
    return { ok: false, message: "Pallet not found for this organization." };
  }

  const labelUrls = sanitizePublicMediaUrlStrings(input.shipping_label_photo_urls, 3);
  const palletUrls = sanitizePublicMediaUrlStrings(input.pallet_photo_urls, 3);
  const bolUrls = sanitizePublicMediaUrlStrings(input.bol_photo_urls, 3);

  const nextPhotoEvidence = mergeOperatorPalletShipmentPhotoEvidence(ex.photo_evidence ?? null, {
    label_urls: labelUrls,
    pallet_urls: palletUrls,
    bol_urls: bolUrls,
  });

  const payload: Record<string, unknown> = {
    carrier_name: input.carrier_name,
    order_id: input.order_id,
    operator_package_count: input.operator_package_count,
    tracking_number: input.tracking_number,
    manifest_photo_url: labelUrls[0] ?? null,
    photo_url: palletUrls[0] ?? null,
    bol_photo_url: bolUrls[0] ?? null,
    photo_evidence: nextPhotoEvidence,
  };

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
  return { ok: true, creatorDisplayLabel };
}

/**
 * Creates an off-manifest / operator pallet using the service-role client.
 * Browser inserts fail RLS when internal staff use the workspace org picker —
 * their JWT `profiles.organization_id` does not match the selected tenant.
 */
/**
 * Load an existing pallet anywhere in the tenant by carrier / inbound tracking (normalized match).
 */
export async function findOperatorPalletByTrackingNumberAction(
  requestedOrganizationId: string,
  trackingNumber: string,
): Promise<
  { ok: true; pallet: OperatorPalletTrackingRow | null } | { ok: false; error: string }
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
    return {
      ok: false,
      error: "This Tracking Number already exists.",
      duplicatePallet: existing,
    };
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
        return {
          ok: false,
          error: "This Tracking Number already exists.",
          duplicatePallet: dup,
        };
      }
      return { ok: false, error: "This Tracking Number already exists." };
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

