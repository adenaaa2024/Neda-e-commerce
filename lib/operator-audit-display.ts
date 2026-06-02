import { isUuidString } from "@/lib/uuid";

/**
 * Legacy seeded UUID when the UI passed a display name instead of `profiles.id`.
 * Rows still carrying this id cannot be attributed to a real person — do not map to role "Admin".
 */
export const MVP_ACTOR_UUID = "00000000-0000-0000-0000-0000000000fe";

const UNKNOWN_USER_LABEL = "Unknown user";

function pickTrimmed(...parts: (string | null | undefined)[]): string | null {
  for (const p of parts) {
    const t = typeof p === "string" ? p.trim() : "";
    if (t) return t;
  }
  return null;
}

/** Same source as app header: `profiles.full_name` (server-resolved into *_display fields). */
export function profileDisplayNameFromParts(parts: {
  full_name?: string | null;
  display_name?: string | null;
  email?: string | null;
}): string | null {
  const direct = pickTrimmed(parts.display_name, parts.full_name);
  if (direct) return direct;
  const email = pickTrimmed(parts.email);
  if (!email) return null;
  const local = email.split("@")[0]?.trim();
  if (!local) return email;
  return local.charAt(0).toUpperCase() + local.slice(1);
}

function isUnusableResolvedLabel(resolved: string): boolean {
  const t = resolved.trim();
  if (!t) return true;
  if (isUuidString(t)) return true;
  if (/^[0-9a-f]{8}(…|\.\.\.)?$/i.test(t)) return true;
  return false;
}

/** Readable audit actor label — never shows a full UUID or role tier as the person name. */
export function auditUserDisplayLabel(
  userId: string | null | undefined,
  resolvedDisplay: string | null | undefined,
): string {
  const id = String(userId ?? "").trim();
  const resolved = String(resolvedDisplay ?? "").trim();
  if (resolved && !isUnusableResolvedLabel(resolved)) {
    return resolved;
  }
  if (id && !isUuidString(id)) return id;
  if (id === MVP_ACTOR_UUID) return UNKNOWN_USER_LABEL;
  if (resolved && resolved.includes("@")) return resolved;
  if (id && isUuidString(id)) return `${id.slice(0, 8)}…`;
  return UNKNOWN_USER_LABEL;
}