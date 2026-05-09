import { NextResponse } from "next/server";

import { deletePimImportUploads } from "@/app/dashboard/products/pim-import-actions";
import { isUuidString } from "@/lib/uuid";

export const runtime = "nodejs";
export const maxDuration = 60;

type Body = { organization_id?: string; job_ids?: string[] };

export async function POST(req: Request) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON." }, { status: 400 });
  }
  const organizationId = String(body.organization_id ?? "").trim();
  const jobIds = Array.isArray(body.job_ids) ? body.job_ids.map((x) => String(x).trim()).filter(isUuidString) : [];

  if (!isUuidString(organizationId) || !jobIds.length) {
    return NextResponse.json({ ok: false, error: "organization_id and job_ids required." }, { status: 400 });
  }

  const res = await deletePimImportUploads({ organizationId, uploadIds: jobIds });
  if (!res.ok) {
    return NextResponse.json({ ok: false, error: res.error }, { status: 400 });
  }
  return NextResponse.json({ ok: true, deleted: jobIds.length });
}
