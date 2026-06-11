import { NextResponse } from "next/server";

import { getCenterModuleAccessPayload } from "@/lib/claims/center/claim-center-api-handlers";
import { gateOrgStoreFromUrl } from "@/lib/claims/center/claim-center-api-shared";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const gate = await gateOrgStoreFromUrl(new URL(req.url));
  if (!gate.ok) return gate.response;
  const access = await getCenterModuleAccessPayload(gate.organizationId);
  return NextResponse.json(access);
}
