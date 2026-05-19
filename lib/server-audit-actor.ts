import "server-only";

import { supabaseServer } from "@/lib/supabase-server";
import { getSessionUserIdFromCookies } from "@/lib/supabase-server-auth";
import { loadTenantProfile } from "@/lib/server-tenant";
import { isUuidString } from "@/lib/uuid";

export type ResolvedAuditActor = {
  /** `profiles.id` / `auth.users.id` when session exists; otherwise null */
  userId: string | null;
  /** Resolved display string (profiles / auth email); used when UI needs a label, not persisted on rows */
  displayName: string;
};

const FALLBACK_LABEL = "Unknown";

function pickTrimmed(...parts: (string | null | undefined)[]): string | null {
  for (const p of parts) {
    const t = typeof p === "string" ? p.trim() : "";
    if (t) return t;
  }
  return null;
}

async function fetchAuthEmail(userId: string): Promise<string | null> {
  try {
    const { data, error } = await supabaseServer.auth.admin.getUserById(userId);
    if (error || !data.user) return null;
    return pickTrimmed(data.user.email ?? null);
  } catch {
    return null;
  }
}

/** Session user → UUID + stable display string (never empty for writes). */
export async function resolveAuditActorForSession(): Promise<ResolvedAuditActor> {
  const userIdRaw = await getSessionUserIdFromCookies();
  const userId = userIdRaw && isUuidString(userIdRaw) ? userIdRaw : null;
  if (!userId) {
    return { userId: null, displayName: FALLBACK_LABEL };
  }

  const profile = await loadTenantProfile(userId);
  const fromProfile = pickTrimmed(profile?.full_name ?? null);
  if (fromProfile) return { userId, displayName: fromProfile };

  const email = await fetchAuthEmail(userId);
  const label = pickTrimmed(email) ?? FALLBACK_LABEL;
  return { userId, displayName: label };
}

/** Resolve an existing FK into a display label without requiring a browser session match. */
export async function resolveDisplayLabelForUserId(profileId: string | null | undefined): Promise<string | null> {
  const id = profileId?.trim();
  if (!id || !isUuidString(id)) return null;

  const profile = await loadTenantProfile(id);
  const fromProfile = pickTrimmed(profile?.full_name ?? null);
  if (fromProfile) return fromProfile;

  return fetchAuthEmail(id);
}
