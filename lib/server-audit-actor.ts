import "server-only";

import { supabaseServer } from "@/lib/supabase-server";
import { getSessionUserIdFromCookies } from "@/lib/supabase-server-auth";
import { loadTenantProfile } from "@/lib/server-tenant";
import {
  auditUserDisplayLabel,
  MVP_ACTOR_UUID,
  profileDisplayNameFromParts,
} from "@/lib/operator-audit-display";
import { isUuidString } from "@/lib/uuid";

export { auditUserDisplayLabel, MVP_ACTOR_UUID };

export type ResolvedAuditActor = {
  /** `profiles.id` / `auth.users.id` when session exists; otherwise null */
  userId: string | null;
  /** Resolved display string (profiles / auth email); used when UI needs a label, not persisted on rows */
  displayName: string;
};

const FALLBACK_LABEL = "Unknown";

const UNKNOWN_USER_LABEL = "Unknown user";

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

function fallbackLabelForAuditUserId(userId: string): string {
  if (userId === MVP_ACTOR_UUID) return UNKNOWN_USER_LABEL;
  return `${userId.slice(0, 8)}…`;
}

function labelFromAuthEmail(email: string): string {
  return profileDisplayNameFromParts({ email }) ?? email;
}

/** Bulk profile labels for audit UI: full_name → auth email → short id / Unknown (never raw UUID or role tier). */
export async function resolveDisplayLabelsForUserIds(
  ids: (string | null | undefined)[],
): Promise<Map<string, string>> {
  const wanted = new Set<string>();
  for (const raw of ids) {
    const id = String(raw ?? "").trim();
    if (isUuidString(id)) wanted.add(id);
  }
  const map = new Map<string, string>();
  if (wanted.size === 0) return map;

  const idList = [...wanted];
  const { data: profs, error } = await supabaseServer
    .from("profiles")
    .select("id, full_name")
    .in("id", idList);
  if (error) {
    console.warn("[resolveDisplayLabelsForUserIds]", error.message);
  }
  const missing: string[] = [];
  for (const id of idList) {
    const row = (profs ?? []).find((p) => String((p as { id?: string }).id ?? "").trim() === id);
    const fn = profileDisplayNameFromParts({
      full_name: (row as { full_name?: string | null })?.full_name ?? null,
    });
    if (fn) map.set(id, fn);
    else missing.push(id);
  }
  await Promise.all(
    missing.map(async (id) => {
      if (id === MVP_ACTOR_UUID) {
        map.set(id, UNKNOWN_USER_LABEL);
        return;
      }
      const profile = await loadTenantProfile(id);
      const fromProfile = profileDisplayNameFromParts({ full_name: profile?.full_name ?? null });
      if (fromProfile) {
        map.set(id, fromProfile);
        return;
      }
      const email = await fetchAuthEmail(id);
      if (email) {
        map.set(id, labelFromAuthEmail(email));
        return;
      }
      map.set(id, fallbackLabelForAuditUserId(id));
    }),
  );
  return map;
}

