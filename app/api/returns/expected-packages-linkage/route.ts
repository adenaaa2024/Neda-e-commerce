import { NextResponse } from "next/server";

import { fetchExpectedPackagesNedaRead } from "@/app/returns/expected-packages-linkage-actions";
import { assertUserCanAccessOrganization } from "@/app/dashboard/products/pim-actions";
import { isUuidString } from "@/lib/uuid";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const organizationId = String(url.searchParams.get("organization_id") ?? "").trim();
  if (!isUuidString(organizationId)) {
    return NextResponse.json({ error: "organization_id must be a UUID." }, { status: 400 });
  }

  const gate = await assertUserCanAccessOrganization(organizationId);
  if (!gate.ok) {
    return NextResponse.json(
      { error: gate.error },
      { status: gate.error === "Not signed in." ? 401 : 403 },
    );
  }

  const storeId = url.searchParams.get("store_id")?.trim() || null;
  const orderId = url.searchParams.get("order_id")?.trim() || null;
  const trackingNumber = url.searchParams.get("tracking_number")?.trim() || null;
  const limitRaw = url.searchParams.get("limit");
  const limit = limitRaw ? Number(limitRaw) : undefined;

  const result = await fetchExpectedPackagesNedaRead({
    organizationId,
    storeId,
    orderId,
    trackingNumber,
    limit: Number.isFinite(limit) ? limit : undefined,
  });

  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 500 });
  }

  return NextResponse.json(result.data);
}
