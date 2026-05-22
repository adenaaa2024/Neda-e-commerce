import { NextResponse } from "next/server";

import { getMyStoresForUser } from "../../../../lib/claim-my-stores";
import { assertUserCanAccessOrganization } from "../../../dashboard/products/pim-actions";
import { isUuidString } from "../../../../lib/uuid";

/**
 * GET /api/claims/my-stores?organization_id=<uuid>&include_inactive=0|1
 * Read-only: assignments + virtual admin/platform store coverage for Claim Inbox selector.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const organizationId = String(url.searchParams.get("organization_id") ?? "").trim();
  if (!isUuidString(organizationId)) {
    return NextResponse.json({ error: "organization_id must be a UUID." }, { status: 400 });
  }

  const includeInactiveRaw = String(url.searchParams.get("include_inactive") ?? "").trim().toLowerCase();
  const includeInactive = includeInactiveRaw === "1" || includeInactiveRaw === "true";

  const gate = await assertUserCanAccessOrganization(organizationId);
  if (!gate.ok) {
    return NextResponse.json(
      { error: gate.error },
      { status: gate.error === "Not signed in." ? 401 : 403 },
    );
  }

  const result = await getMyStoresForUser(gate.userId, organizationId, { includeInactive });
  if (!result.ok) {
    return NextResponse.json({ error: result.message }, { status: result.status });
  }

  return NextResponse.json(result.payload, { status: 200 });
}
