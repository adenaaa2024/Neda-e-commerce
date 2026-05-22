import { NextResponse } from "next/server";

import { createPimImportUploadSession } from "@/app/dashboard/products/pim-import-actions";
import { isUuidString } from "@/lib/uuid";

export const runtime = "nodejs";
export const maxDuration = 30;

type Body = {
  organization_id?: string;
  store_id?: string;
  file_name?: string;
  total_bytes?: number;
  file_extension?: string;
  /** Lowercase hex SHA-256 (64 chars) for Product Master session dedupe. */
  content_sha256?: string;
};

export async function POST(req: Request) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON." }, { status: 400 });
  }
  const organizationId = String(body.organization_id ?? "").trim();
  const storeId = String(body.store_id ?? "").trim();
  const fileName = String(body.file_name ?? "upload").trim() || "upload";
  const totalBytes = Number(body.total_bytes ?? 0);
  const fileExtension = String(body.file_extension ?? "csv").trim().replace(/^\./, "") || "csv";
  const contentSha256 = String(body.content_sha256 ?? "").trim().toLowerCase() || null;

  if (!isUuidString(organizationId)) {
    return NextResponse.json({ ok: false, error: "Invalid organization_id." }, { status: 400 });
  }
  if (!isUuidString(storeId)) {
    return NextResponse.json({ ok: false, error: "Invalid store_id." }, { status: 400 });
  }
  if (!Number.isFinite(totalBytes) || totalBytes < 1) {
    return NextResponse.json({ ok: false, error: "total_bytes is required." }, { status: 400 });
  }

  const session = await createPimImportUploadSession({
    organizationId,
    storeId,
    fileName,
    totalBytes,
    fileExtension,
  });
  if (!session.ok) {
    return NextResponse.json({ ok: false, error: session.error }, { status: 400 });
  }

  return NextResponse.json({
    ok: true,
    job_id: session.uploadId,
    import_session_id: session.importSessionId ?? null,
    storage_prefix: session.storagePrefix,
    resumed: Boolean(session.resumed),
    skip_upload: Boolean(session.skipUpload),
    message: "Upload file parts to /api/settings/imports/chunk, then POST …/import/finalize.",
  });
}
