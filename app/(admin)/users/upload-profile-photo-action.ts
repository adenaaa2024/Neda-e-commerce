"use server";

import { supabaseServer } from "../../../lib/supabase-server";
import { getSessionUserIdFromCookies } from "../../../lib/supabase-server-auth";
import { isSuperAdminRole, loadTenantProfile } from "../../../lib/server-tenant";
import { resolveOrganizationId } from "../../../lib/organization";
import { isUuidString } from "../../../lib/uuid";
import { updateUserProfile } from "./users-actions";

const BUCKET = "profiles";

const ALLOWED = new Set(["image/png", "image/jpeg", "image/jpg", "image/webp", "image/gif"]);

/**
 * Uploads profile photo to public `profiles` bucket and sets `profiles.photo_url`.
 */
export async function uploadUserProfilePhotoAction(
  formData: FormData,
): Promise<{ ok: true; publicUrl: string } | { ok: false; error: string }> {
  const file = formData.get("file");
  const profileIdRaw = formData.get("profile_id");
  if (!(file instanceof File) || file.size === 0) {
    return { ok: false, error: "No file provided." };
  }
  if (typeof profileIdRaw !== "string" || !isUuidString(profileIdRaw)) {
    return { ok: false, error: "Invalid profile." };
  }
  if (file.size > 4 * 1024 * 1024) {
    return { ok: false, error: "Image too large (max 4 MB)." };
  }
  const ct = file.type || "";
  if (ct && !ALLOWED.has(ct)) {
    return { ok: false, error: "Use PNG, JPEG, WebP, or GIF." };
  }

  const organizationId = resolveOrganizationId();
  if (!isUuidString(organizationId)) {
    return { ok: false, error: "Invalid organization." };
  }

  const ext = file.name.split(".").pop()?.toLowerCase() ?? "jpg";
  const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const path = `${organizationId}/${profileIdRaw}/${unique}.${ext}`;

  const buf = Buffer.from(await file.arrayBuffer());
  const { error: upErr } = await supabaseServer.storage.from(BUCKET).upload(path, buf, {
    upsert: true,
    contentType: file.type || undefined,
  });
  if (upErr) {
    const m = upErr.message.toLowerCase();
    const hint =
      m.includes("bucket") && m.includes("not found")
        ? ` Create a public Storage bucket named "${BUCKET}" in Supabase.`
        : "";
    return { ok: false, error: `${upErr.message}${hint}` };
  }

  const { data: urlData } = supabaseServer.storage.from(BUCKET).getPublicUrl(path);
  const publicUrl = urlData.publicUrl;

  const sessionId = await getSessionUserIdFromCookies();
  const actor =
    sessionId && isUuidString(sessionId) ? await loadTenantProfile(sessionId) : null;
  const fromPlatform = formData.get("for_platform_directory") === "1";
  const forPlatform = fromPlatform && Boolean(actor && isSuperAdminRole(actor.role));
  const upd = await updateUserProfile(
    profileIdRaw,
    { photo_url: publicUrl },
    { forPlatformDirectory: forPlatform },
  );
  if (!upd.ok) {
    return { ok: false, error: upd.error ?? "Failed to save photo URL." };
  }

  return { ok: true, publicUrl };
}
