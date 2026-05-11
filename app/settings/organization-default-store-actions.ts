"use server";

import { resolveTenantOrganizationId, type TenantWriteContext } from "../../lib/server-tenant";
import { supabaseServer } from "../../lib/supabase-server";
import { isUuidString } from "../../lib/uuid";

const ISO4217 = /^[A-Z]{3}$/;

function normalizeDisplayCurrency(raw: string | null | undefined): string {
  const c = String(raw ?? "USD").trim().toUpperCase();
  return ISO4217.test(c) ? c : "USD";
}

export async function getOrganizationDefaultStoreId(
  tenant?: TenantWriteContext | null,
): Promise<string | null> {
  const companyId = await resolveTenantOrganizationId(tenant);
  try {
    const { data, error } = await supabaseServer
      .from("organization_settings")
      .select("default_store_id")
      .eq("organization_id", companyId)
      .maybeSingle();
    if (error || !data) return null;
    const id = (data as { default_store_id?: string | null }).default_store_id;
    return typeof id === "string" && isUuidString(id) ? id : null;
  } catch {
    return null;
  }
}

/** Default store + catalog display currency (Settings → General). */
export async function getOrganizationOperationalPreferences(
  tenant?: TenantWriteContext | null,
): Promise<{ defaultStoreId: string | null; displayCurrencyCode: string }> {
  const companyId = await resolveTenantOrganizationId(tenant);
  try {
    const { data, error } = await supabaseServer
      .from("organization_settings")
      .select("default_store_id, display_currency_code")
      .eq("organization_id", companyId)
      .maybeSingle();
    if (error || !data) {
      return { defaultStoreId: null, displayCurrencyCode: "USD" };
    }
    const row = data as { default_store_id?: string | null; display_currency_code?: string | null };
    const id = row.default_store_id;
    return {
      defaultStoreId: typeof id === "string" && isUuidString(id) ? id : null,
      displayCurrencyCode: normalizeDisplayCurrency(row.display_currency_code),
    };
  } catch {
    return { defaultStoreId: null, displayCurrencyCode: "USD" };
  }
}

export async function saveOrganizationDefaultStoreId(
  storeId: string | null,
  tenant?: TenantWriteContext | null,
): Promise<{ ok: boolean; error?: string }> {
  const companyId = await resolveTenantOrganizationId(tenant);
  try {
    const trimmed = storeId?.trim() ?? "";
    if (trimmed && !isUuidString(trimmed)) {
      return { ok: false, error: "Invalid store id." };
    }
    const finalId = trimmed || null;

    if (finalId) {
      const { data: store, error: storeErr } = await supabaseServer
        .from("stores")
        .select("id, organization_id")
        .eq("id", finalId)
        .maybeSingle();
      if (storeErr || !store) {
        return { ok: false, error: "Store not found." };
      }
    }

    const { data: existing, error: selErr } = await supabaseServer
      .from("organization_settings")
      .select("organization_id")
      .eq("organization_id", companyId)
      .maybeSingle();

    if (selErr) return { ok: false, error: selErr.message };

    if (existing) {
      const { error: updErr } = await supabaseServer
        .from("organization_settings")
        .update({ default_store_id: finalId })
        .eq("organization_id", companyId);
      if (updErr) return { ok: false, error: updErr.message };
    } else {
      const { error: insErr } = await supabaseServer.from("organization_settings").insert({
        organization_id: companyId,
        is_ai_label_ocr_enabled: false,
        is_ai_packing_slip_ocr_enabled: false,
        default_claim_evidence: {},
        credentials: {},
        default_store_id: finalId,
        display_currency_code: "USD",
      });
      if (insErr) return { ok: false, error: insErr.message };
    }

    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Save failed." };
  }
}

export async function saveOrganizationDisplayCurrencyCode(
  currencyCode: string,
  tenant?: TenantWriteContext | null,
): Promise<{ ok: boolean; error?: string }> {
  const companyId = await resolveTenantOrganizationId(tenant);
  const raw = String(currencyCode ?? "").trim().toUpperCase();
  if (!ISO4217.test(raw)) {
    return { ok: false, error: "Use a 3-letter ISO 4217 currency code (e.g. USD, EUR)." };
  }
  const code = raw;
  try {
    const { data: existing, error: selErr } = await supabaseServer
      .from("organization_settings")
      .select("organization_id")
      .eq("organization_id", companyId)
      .maybeSingle();
    if (selErr) return { ok: false, error: selErr.message };

    if (existing) {
      const { error: updErr } = await supabaseServer
        .from("organization_settings")
        .update({ display_currency_code: code })
        .eq("organization_id", companyId);
      if (updErr) return { ok: false, error: updErr.message };
    } else {
      const { error: insErr } = await supabaseServer.from("organization_settings").insert({
        organization_id: companyId,
        is_ai_label_ocr_enabled: false,
        is_ai_packing_slip_ocr_enabled: false,
        default_claim_evidence: {},
        credentials: {},
        display_currency_code: code,
      });
      if (insErr) return { ok: false, error: insErr.message };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Save failed." };
  }
}
