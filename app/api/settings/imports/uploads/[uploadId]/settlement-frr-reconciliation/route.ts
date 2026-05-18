import { NextResponse } from "next/server";

import { computeSettlementFrrReconciliation } from "@/lib/amazon/settlement-frr-reconciliation";
import { supabaseServer } from "@/lib/supabase-server";
import { isUuidString } from "@/lib/uuid";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ uploadId: string }> };

/**
 * GET — read-only settlement ↔ FRR reconciliation for one upload.
 * Query: organization_id (required), sample_limit (optional, max 100).
 */
export async function GET(req: Request, context: RouteContext): Promise<Response> {
  const { uploadId } = await context.params;
  const url = new URL(req.url);
  const organizationId = url.searchParams.get("organization_id")?.trim() ?? "";
  const sampleRaw = url.searchParams.get("sample_limit")?.trim();
  const sampleLimit = sampleRaw ? Number.parseInt(sampleRaw, 10) : undefined;

  if (!isUuidString(uploadId) || !isUuidString(organizationId)) {
    return NextResponse.json(
      { ok: false, error: "uploadId and organization_id must be valid UUIDs." },
      { status: 400 },
    );
  }

  const result = await computeSettlementFrrReconciliation(
    supabaseServer,
    organizationId,
    uploadId,
    { sampleLimit: Number.isFinite(sampleLimit) ? sampleLimit : undefined },
  );

  if (!result.ok) {
    const status =
      result.code === "upload_not_found"
        ? 404
        : result.code === "not_settlement"
          ? 422
          : 500;
    return NextResponse.json(result, { status });
  }

  return NextResponse.json(result);
}
