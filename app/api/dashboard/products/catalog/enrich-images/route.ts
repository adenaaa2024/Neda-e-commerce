import { NextResponse } from "next/server";

import {
  assertUserCanAccessOrganization,
  userCanViewPimEnrichmentDebug,
} from "../../../../../dashboard/products/pim-actions";
import {
  parsePimCatalogEnrichmentBatchParams,
  runPimCatalogEnrichmentBatch,
  type PimCatalogEnrichmentRequestBody,
} from "../../../../../../lib/pim-catalog-enrichment-batch";

export async function POST(req: Request) {
  let body: PimCatalogEnrichmentRequestBody;
  try {
    body = (await req.json()) as PimCatalogEnrichmentRequestBody;
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body." }, { status: 400 });
  }

  const params = parsePimCatalogEnrichmentBatchParams(body);

  const gate = await assertUserCanAccessOrganization(params.organizationId);
  if (!gate.ok) {
    return NextResponse.json(
      { ok: false, error: gate.error },
      { status: gate.error === "Not signed in." ? 401 : 403 },
    );
  }

  const allowEnrichmentDebug =
    params.allowEnrichmentDebug && (await userCanViewPimEnrichmentDebug(params.organizationId));

  const result = await runPimCatalogEnrichmentBatch({
    ...params,
    allowEnrichmentDebug,
  });

  if (!result.ok) {
    return NextResponse.json({ ok: false, error: result.error }, { status: result.status });
  }

  return NextResponse.json(result);
}
