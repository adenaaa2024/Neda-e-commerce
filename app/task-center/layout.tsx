import type { ReactNode } from "react";
import { Suspense } from "react";

import { TaskCenterRootClient } from "@/components/task-center/TaskCenterRootClient";
import { resolveOrganizationId } from "@/lib/organization";
import { getSessionUserIdFromCookies } from "@/lib/supabase-server-auth";
import { isUuidString } from "@/lib/uuid";
import { supabaseServer } from "@/lib/supabase-server";

import "./task-center-theme.css";

export const dynamic = "force-dynamic";

export default async function TaskCenterLayout({ children }: { children: ReactNode }) {
  const organizationId = resolveOrganizationId();
  const userId = await getSessionUserIdFromCookies();

  const { data: osRow } = await supabaseServer
    .from("organization_settings")
    .select("default_store_id")
    .eq("organization_id", organizationId)
    .maybeSingle();

  const rawDefault = (osRow as { default_store_id?: string | null } | null)?.default_store_id;
  const defaultStoreId = typeof rawDefault === "string" && isUuidString(rawDefault) ? rawDefault : null;

  return (
    <Suspense fallback={<div className="p-6 text-sm opacity-70">Loading Task Center…</div>}>
      <TaskCenterRootClient organizationId={organizationId} userId={userId} defaultStoreId={defaultStoreId}>
        {children}
      </TaskCenterRootClient>
    </Suspense>
  );
}
