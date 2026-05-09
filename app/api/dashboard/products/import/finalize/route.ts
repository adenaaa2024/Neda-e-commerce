import { NextResponse } from "next/server";

import { finalizePimImportUploadSession } from "@/app/dashboard/products/pim-import-actions";
import { isUuidString } from "@/lib/uuid";

export const runtime = "nodejs";
export const maxDuration = 30;

type Body = { organization_id?: string; job_id?: string; total_parts?: number };

export async function POST(req: Request) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON." }, { status: 400 });
  }
  const organizationId = String(body.organization_id ?? "").trim();
  const jobId = String(body.job_id ?? "").trim();
  const totalParts = Math.max(1, Math.floor(Number(body.total_parts ?? 1)));

  if (!isUuidString(organizationId) || !isUuidString(jobId)) {
    return NextResponse.json({ ok: false, error: "Invalid ids." }, { status: 400 });
  }

  const fin = await finalizePimImportUploadSession({
    organizationId,
    uploadId: jobId,
    totalParts,
  });
  if (!fin.ok) {
    return NextResponse.json({ ok: false, error: fin.error }, { status: 400 });
  }
  return NextResponse.json({ ok: true, job_id: jobId, job_status: "preview_queued" });
}
