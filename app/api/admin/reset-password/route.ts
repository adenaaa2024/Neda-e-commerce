import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createClient } from "@supabase/supabase-js";
import { createServerClient } from "@supabase/ssr";

import { isUuidString } from "@/lib/uuid";
import { normalizeRoleKeyForBranding } from "@/lib/tenant-branding-permissions";
const MIN_PASSWORD_LENGTH = 8;

type ResetPasswordBody = {
  userId?: unknown;
  newPassword?: unknown;
};

export async function POST(req: NextRequest) {
  try {
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabaseUrl || !supabaseAnonKey || !serviceRoleKey) {
      return NextResponse.json(
        { error: "Server auth configuration is missing." },
        { status: 500 },
      );
    }

    const cookieStore = await cookies();
    const sessionClient = createServerClient(supabaseUrl, supabaseAnonKey, {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) => {
              cookieStore.set(name, value, options);
            });
          } catch {
            /* route handler may be unable to mutate cookies in some contexts */
          }
        },
      },
    });

    const {
      data: { user },
      error: authError,
    } = await sessionClient.auth.getUser();

    if (authError || !user?.id) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    }

    const supabase = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false },
    });

    const { data: actorProfile, error: actorError } = await supabase
      .from("profiles")
      .select("role, organization_id, roles:role_id(key, name, scope)")
      .eq("id", user.id)
      .maybeSingle();

    if (actorError) {
      return NextResponse.json({ error: actorError.message }, { status: 500 });
    }

    const body = (await req.json()) as ResetPasswordBody;
    const userId = typeof body.userId === "string" ? body.userId.trim() : "";
    const newPassword = typeof body.newPassword === "string" ? body.newPassword : "";

    if (!isUuidString(userId)) {
      return NextResponse.json({ error: "Invalid userId." }, { status: 400 });
    }
    if (newPassword.length < MIN_PASSWORD_LENGTH) {
      return NextResponse.json(
        { error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.` },
        { status: 400 },
      );
    }

    const rawActorRole = String(
      (
        (actorProfile as { roles?: { key?: string | null } | null } | null)?.roles?.key
        ?? (actorProfile as { role?: string | null } | null)?.role
        ?? ""
      ),
    ).trim();
    const actorRoleNorm = normalizeRoleKeyForBranding(rawActorRole);
    if (!actorRoleNorm) {
      return NextResponse.json({ error: "Forbidden." }, { status: 403 });
    }

    /** Who may reset within the same `profiles.organization_id` (tenant scope). */
    const SAME_ORG_RESET_ROLES = new Set([
      "tenant_admin",
      "admin",
      "system_admin",
      "system_employee",
      "programmer",
      "customer_service",
    ]);

    if (actorRoleNorm !== "super_admin") {
      if (!SAME_ORG_RESET_ROLES.has(actorRoleNorm)) {
        return NextResponse.json({ error: "Forbidden." }, { status: 403 });
      }
      const actorOrg = String(
        (actorProfile as { organization_id?: string | null })?.organization_id ?? "",
      ).trim();
      if (!isUuidString(actorOrg)) {
        return NextResponse.json({ error: "Forbidden." }, { status: 403 });
      }
      const { data: targetProfile, error: tErr } = await supabase
        .from("profiles")
        .select("organization_id")
        .eq("id", userId)
        .maybeSingle();
      if (tErr) {
        return NextResponse.json({ error: tErr.message }, { status: 500 });
      }
      const targetOrg = String(
        (targetProfile as { organization_id?: string | null } | null)?.organization_id ?? "",
      ).trim();
      if (actorOrg !== targetOrg) {
        return NextResponse.json({ error: "Forbidden." }, { status: 403 });
      }
    }

    const { error: resetError } = await supabase.auth.admin.updateUserById(userId, {
      password: newPassword,
    });

    if (resetError) {
      return NextResponse.json({ error: resetError.message }, { status: 400 });
    }

    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Reset password failed." },
      { status: 500 },
    );
  }
}
