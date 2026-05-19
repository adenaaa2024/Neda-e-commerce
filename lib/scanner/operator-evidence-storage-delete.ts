"use server";

import { supabaseServer } from "@/lib/supabase-server";
import { getSessionUserIdFromCookies } from "@/lib/supabase-server-auth";
import { resolveWriteOrganizationId } from "@/lib/server-tenant";
import { isUuidString } from "@/lib/uuid";

/** Match Supabase public object URLs (`…/storage/v1/object/public/{bucket}/{path}`). */
const STORAGE_PUBLIC_OBJECT_RE = /\/storage\/v1\/object\/public\/([^/]+)\/(.+)$/i;

/**
 * Deletes storage objects by public URL after evidence was removed from the DB in the same session.
 * Only paths under `{organizationId}/…` in allowed buckets are removed (tenant scope).
 */
export async function deleteOperatorEvidenceStorageByPublicUrlsAction(
  requestedOrganizationId: string,
  publicUrls: readonly string[],
): Promise<{ ok: true; removed: number } | { ok: false; error: string }> {
  const sessionUserId = await getSessionUserIdFromCookies();
  if (!sessionUserId || !isUuidString(sessionUserId)) {
    return { ok: false, error: "Not signed in." };
  }
  const organizationId = await resolveWriteOrganizationId(null, requestedOrganizationId);
  if (!organizationId || !isUuidString(organizationId)) {
    return { ok: false, error: "Could not resolve organization." };
  }
  const prefix = `${organizationId}/`;
  const byBucket = new Map<string, Set<string>>();
  for (const raw of publicUrls) {
    const u = String(raw ?? "").trim();
    if (!/^https?:\/\//i.test(u)) continue;
    const m = u.match(STORAGE_PUBLIC_OBJECT_RE);
    if (!m) continue;
    const bucket = m[1]?.trim();
    const path = m[2]?.trim();
    if (!bucket || !path || !path.startsWith(prefix)) continue;
    if (bucket !== "media" && bucket !== "manifests") continue;
    let set = byBucket.get(bucket);
    if (!set) {
      set = new Set();
      byBucket.set(bucket, set);
    }
    set.add(path);
  }

  let removed = 0;
  for (const [bucket, paths] of byBucket) {
    const uniq = [...paths];
    if (!uniq.length) continue;
    const { error } = await supabaseServer.storage.from(bucket).remove(uniq);
    if (error) return { ok: false, error: error.message };
    removed += uniq.length;
  }
  return { ok: true, removed };
}
