/**
 * Unit checks for workspace URL deep-link helpers (V173).
 */
import {
  buildPimCatalogDeepLink,
  OPERABLE_SAM_AM_STORE_ID,
  OPERABLE_SAM_DISTRIBUTION_ORG_ID,
  readWorkspaceOrganizationIdFromSearch,
} from "../lib/workspace-url-context";

function eq(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

eq(
  readWorkspaceOrganizationIdFromSearch(`?workspace_org=${OPERABLE_SAM_DISTRIBUTION_ORG_ID}`) ===
    OPERABLE_SAM_DISTRIBUTION_ORG_ID,
  "workspace_org",
);
eq(
  readWorkspaceOrganizationIdFromSearch(`?organization_id=${OPERABLE_SAM_DISTRIBUTION_ORG_ID}&foo=1`) ===
    OPERABLE_SAM_DISTRIBUTION_ORG_ID,
  "organization_id alias",
);
eq(readWorkspaceOrganizationIdFromSearch("?workspace_org=not-a-uuid") === null, "invalid uuid");

const link = buildPimCatalogDeepLink();
eq(link.includes("workspace_org="), "deep link has workspace_org");
eq(link.includes(OPERABLE_SAM_AM_STORE_ID), "deep link has store");
eq(link.includes(OPERABLE_SAM_DISTRIBUTION_ORG_ID), "deep link has org");

console.log("test-workspace-url-context: all checks passed");
