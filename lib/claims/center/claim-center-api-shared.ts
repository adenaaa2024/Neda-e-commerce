import { NextResponse } from "next/server";

import { assertUserCanAccessOrganization } from "@/app/dashboard/products/pim-actions";
import { assertStoreBelongsToOrganization } from "@/lib/claim-org-scope";
import { isUuidString } from "@/lib/uuid";
import type { SupabaseClient } from "@supabase/supabase-js";

export type OrgStoreGateResult =
  | {
      ok: true;
      organizationId: string;
      storeId: string | null;
      userId: string;
    }
  | { ok: false; response: NextResponse };

export async function gateOrgStoreFromUrl(url: URL): Promise<OrgStoreGateResult> {
  const organizationId = String(url.searchParams.get("organization_id") ?? "").trim();
  if (!isUuidString(organizationId)) {
    return {
      ok: false,
      response: NextResponse.json({ error: "organization_id must be a UUID." }, { status: 400 }),
    };
  }

  const gate = await assertUserCanAccessOrganization(organizationId);
  if (!gate.ok) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: gate.error },
        { status: gate.error === "Not signed in." ? 401 : 403 },
      ),
    };
  }

  const storeIdParam = String(url.searchParams.get("store_id") ?? "").trim();
  if (storeIdParam) {
    if (!isUuidString(storeIdParam)) {
      return {
        ok: false,
        response: NextResponse.json({ error: "store_id must be a UUID when provided." }, { status: 400 }),
      };
    }
    const storeOk = await assertStoreBelongsToOrganization(organizationId, storeIdParam);
    if (!storeOk.ok) {
      return { ok: false, response: NextResponse.json({ error: storeOk.error }, { status: storeOk.status }) };
    }
    return { ok: true, organizationId, storeId: storeIdParam, userId: gate.userId };
  }

  return { ok: true, organizationId, storeId: null, userId: gate.userId };
}

export function parseBoolParam(url: URL, key: string, defaultValue: boolean): boolean {
  const raw = String(url.searchParams.get(key) ?? "").trim().toLowerCase();
  if (!raw) return defaultValue;
  return raw === "1" || raw === "true" || raw === "yes";
}

export function clampLimit(url: URL, key: string, fallback: number, max: number): number {
  const n = Number.parseInt(url.searchParams.get(key) ?? String(fallback), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(1, n));
}

// Pool filters applied inline in route handlers via .is/.neq on claim_candidates queries.
