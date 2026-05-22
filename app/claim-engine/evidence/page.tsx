import { notFound } from "next/navigation";

import { resolveOrganizationId } from "../../../lib/organization";
import { isUuidString } from "../../../lib/uuid";
import { ClaimDraftEvidenceClient } from "./ClaimDraftEvidenceClient";

export const dynamic = "force-dynamic";

type PageProps = {
  searchParams: Promise<{ draft_id?: string }>;
};

export default async function ClaimDraftEvidencePage({ searchParams }: PageProps) {
  const sp = await searchParams;
  const draftId = String(sp.draft_id ?? "").trim();
  if (!isUuidString(draftId)) {
    notFound();
  }

  const organizationId = resolveOrganizationId();
  return <ClaimDraftEvidenceClient organizationId={organizationId} draftId={draftId} />;
}
