import { NextResponse } from "next/server";

import { PRODUCTION_ORG_ID } from "@/lib/production-removal-sync-run";
import { runProductionRemovalSync, syncWindowThroughToday } from "@/lib/production-removal-sync-run";
import { REMOVAL_NIGHTLY_CRON_UTC } from "@/lib/production-sync-health";
import { PRODUCTION_REF } from "@/lib/production-db-bind";

export const runtime = "nodejs";
export const maxDuration = 300;

function authorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) return false;
  const auth = req.headers.get("authorization") ?? "";
  return auth === `Bearer ${secret}`;
}

/**
 * Nightly removal shipment sync — production only.
 * Schedule: vercel.json `30 6 * * *` (~11:30 PM America/Los_Angeles PDT).
 */
export async function GET(req: Request): Promise<Response> {
  if (!authorized(req)) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  const urlRef = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  if (!urlRef.includes(PRODUCTION_REF)) {
    return NextResponse.json(
      {
        ok: false,
        error: `Cron refused: NEXT_PUBLIC_SUPABASE_URL must target production ${PRODUCTION_REF}`,
        code: "wrong_db_ref",
      },
      { status: 503 },
    );
  }

  if (process.env.ENABLE_PRODUCTION_REMOVAL_NIGHTLY_CRON !== "true") {
    return NextResponse.json(
      {
        ok: false,
        error: "ENABLE_PRODUCTION_REMOVAL_NIGHTLY_CRON is not true",
        code: "cron_disabled",
      },
      { status: 503 },
    );
  }

  try {
    const result = await runProductionRemovalSync({
      window: syncWindowThroughToday(14),
    });
    return NextResponse.json({
      ok: result.errors.length === 0,
      organization_id: PRODUCTION_ORG_ID,
      target_ref: PRODUCTION_REF,
      cron_schedule: REMOVAL_NIGHTLY_CRON_UTC,
      window: result.window,
      counts_before: result.counts_before,
      counts_after: result.counts_after,
      latest_shipment_date: result.latest_shipment_date,
      rebuild_valid: result.rebuild_valid,
      errors: result.errors,
      order_upload_id: result.order_fetch.upload_id,
      shipment_upload_id: result.shipment_fetch.upload_id,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
