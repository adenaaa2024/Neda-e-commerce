import { NextResponse } from "next/server";

import { gateOrgStoreFromUrl } from "@/lib/claims/center/claim-center-api-shared";
import {
  parseCogsImportCsvTextV1,
} from "@/lib/claims/submission/product-cogs-source-import-v1";
import { attemptGuardedCogsWriteV1 } from "@/lib/claims/submission/product-cogs-source-write-v1";
import {
  buildManualCogsDryRunResultV1,
  loadProductCogsManualEntryUiPayloadV1,
  runImportDryRunV1,
  type ImportRowInputV1,
  type ManualCogsEntryInputV1,
} from "@/lib/claims/submission/product-cogs-manual-entry-ui-v1";
import { supabaseServer } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const storeId = String(url.searchParams.get("store_id") ?? "").trim();
  if (!storeId) {
    return NextResponse.json({ error: "store_id is required." }, { status: 400 });
  }

  const gate = await gateOrgStoreFromUrl(url);
  if (!gate.ok) return gate.response;

  try {
    const payload = await loadProductCogsManualEntryUiPayloadV1({
      organizationId: gate.organizationId,
      storeId: gate.storeId!,
      supabase: supabaseServer,
    });
    return NextResponse.json(payload);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Request failed.";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

type PostBody =
  | { mode: "manual"; entry: ManualCogsEntryInputV1 }
  | { mode: "import"; csvText?: string; rows?: ImportRowInputV1[]; approvedBy?: string }
  | { mode: "write"; entry: ManualCogsEntryInputV1; executeRunId?: string };

export async function POST(req: Request) {
  const url = new URL(req.url);
  const storeId = String(url.searchParams.get("store_id") ?? "").trim();
  if (!storeId) {
    return NextResponse.json({ error: "store_id is required." }, { status: 400 });
  }

  const gate = await gateOrgStoreFromUrl(url);
  if (!gate.ok) return gate.response;

  let body: PostBody;
  try {
    body = (await req.json()) as PostBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  try {
    const payload = await loadProductCogsManualEntryUiPayloadV1({
      organizationId: gate.organizationId,
      storeId: gate.storeId!,
      supabase: supabaseServer,
    });
    const pilotProducts = payload.pilotProducts;

    if (body.mode === "write") {
      const entry = body.entry;
      const pilot = pilotProducts.find((p) => p.fnsku === entry.fnsku);
      if (!pilot) {
        return NextResponse.json({ error: "FNSKU not in pilot scope." }, { status: 400 });
      }
      const result = await attemptGuardedCogsWriteV1({
        client: supabaseServer,
        organizationId: gate.organizationId,
        entry,
        pilot,
        executeRunId: body.executeRunId ?? `ui-${Date.now()}`,
        actorId: gate.userId,
      });
      return NextResponse.json(result, { status: result.blocked ? 403 : result.ok ? 200 : 400 });
    }

    if (body.mode === "manual") {
      const entry = body.entry;
      const pilot = pilotProducts.find((p) => p.fnsku === entry.fnsku);
      if (!pilot) {
        return NextResponse.json({ error: "FNSKU not in pilot scope." }, { status: 400 });
      }
      const result = buildManualCogsDryRunResultV1(entry, {
        latestSoldPrice: pilot.latestSoldPrice,
        cleanQuantityTotal: pilot.cleanQuantityTotal,
        perSubmission: pilot.affectedSubmissions.map((s) => ({
          claimSubmissionId: s.claimSubmissionId,
          claimCaseId: s.claimCaseId,
          cleanQuantity: s.cleanQuantity,
        })),
      });
      return NextResponse.json(result);
    }

    if (body.mode === "import") {
      let rows = body.rows ?? [];
      let rejectedHeaders: string[] = [];
      if (body.csvText) {
        const parsed = parseCogsImportCsvTextV1(body.csvText);
        rows = parsed.rows;
        rejectedHeaders = parsed.rejectedHeaders;
      }
      if (rejectedHeaders.length > 0) {
        return NextResponse.json(
          {
            ok: false,
            dryRun: true,
            noDbWrite: true,
            error: "Forbidden sale/list price columns detected in import header.",
            rejectedHeaders,
            rejectedSourceFields: payload.rejectedSourceFields,
          },
          { status: 400 },
        );
      }
      const approvedBy = body.approvedBy?.trim() || gate.userId;
      const result = runImportDryRunV1(rows, pilotProducts, approvedBy);
      return NextResponse.json(result);
    }

    return NextResponse.json({ error: "mode must be manual, import, or write." }, { status: 400 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Request failed.";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
