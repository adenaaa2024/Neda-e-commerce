/** User-facing copy and limits for Claim Center read-only UI. */

export const CLAIM_CENTER_BRIDGE_PHASE_COPY =
  "Filing, promote, and approve actions are locked in this release. You can review opportunities and blockers now; filing will open in a later update.";

export const CLAIM_CENTER_LEGACY_HIDDEN_COPY =
  "Older seed and quarantined rows are hidden by default. Use Legacy tools → Claim Engine if you need those rows.";

export const CLAIM_CENTER_DASHBOARD_SAMPLE_LIMIT = 500;
export const CLAIM_CENTER_OPPORTUNITIES_SCAN_LIMIT = 800;
export const CLAIM_CENTER_REFERENCES_SCAN_LIMIT = 400;
export const CLAIM_CENTER_LINKAGE_SCAN_LIMIT = 600;

export type ClaimCenterEmptyVariant = "pool_empty" | "queue_clear";

export type ClaimCenterSectionEmptyConfig = {
  id: string;
  variant: ClaimCenterEmptyVariant;
  title: string;
  appearsHere: string;
  whyEmpty: string;
  nextSteps: string[];
};

/** A — No opportunities exist yet; intake or source generation needed. */
export const CLAIM_CENTER_POOL_EMPTY_TEMPLATE: Omit<ClaimCenterSectionEmptyConfig, "id"> = {
  variant: "pool_empty",
  title: "No claim opportunities yet",
  appearsHere:
    "Recoverable events from store scans, returns review, and import jobs will show here after generators run.",
  whyEmpty:
    "Nothing has been generated for this workspace in the active pool. This is not demo data — the pool is genuinely empty.",
  nextSteps: [
    "Open Sources to see which generators ran and which are enabled.",
    "Confirm store scope in the bar above matches the store you expect.",
    "Ask an admin to run pool generation from Platform Automation if sources are enabled but empty.",
  ],
};

/** B — Pool has data but this queue filter has no matching rows. */
export const CLAIM_CENTER_QUEUE_CLEAR_TEMPLATE: Omit<ClaimCenterSectionEmptyConfig, "id"> = {
  variant: "queue_clear",
  title: "Queue is clear",
  appearsHere: "Rows that match this queue’s filters would appear here.",
  whyEmpty:
    "The operational pool may still have opportunities — they are either resolved, not applicable to this queue, or filtered out.",
  nextSteps: [
    "Check Home or the full pool if you expected rows here.",
    "Open another workflow queue (Money, Proof, Product Match) for remaining blockers.",
  ],
};

export function buildPoolEmptyState(id: string, overrides?: Partial<ClaimCenterSectionEmptyConfig>): ClaimCenterSectionEmptyConfig {
  return { id, ...CLAIM_CENTER_POOL_EMPTY_TEMPLATE, ...overrides };
}

export function buildQueueClearState(
  id: string,
  overrides?: Partial<ClaimCenterSectionEmptyConfig>,
): ClaimCenterSectionEmptyConfig {
  return { id, ...CLAIM_CENTER_QUEUE_CLEAR_TEMPLATE, ...overrides, variant: "queue_clear" };
}

export function resolveSectionEmptyState(
  pageConfig: ClaimCenterSectionEmptyConfig,
  opts: { poolEmpty: boolean },
): ClaimCenterSectionEmptyConfig {
  if (opts.poolEmpty) {
    return buildPoolEmptyState(pageConfig.id, {
      nextSteps: pageConfig.nextSteps.length ? pageConfig.nextSteps : CLAIM_CENTER_POOL_EMPTY_TEMPLATE.nextSteps,
    });
  }
  return { ...pageConfig, variant: "queue_clear" };
}

export const CLAIM_CENTER_SECTION_EMPTY: Record<string, ClaimCenterSectionEmptyConfig> = {
  dashboard_opportunities: buildQueueClearState("dashboard_opportunities", {
    title: "No high-priority items in this sample",
    appearsHere: "Top opportunities by recovery value for your current store scope.",
    whyEmpty: "Either the pool is empty, or nothing in scope ranks as high priority right now.",
    nextSteps: [
      "Open Find money if you expect recoverable events.",
      "Check Sources if generators have not run recently.",
    ],
  }),
  opportunities: buildQueueClearState("opportunities", {
    title: "No recoverable events in this queue",
    appearsHere:
      "Active recoverable opportunities from your pool — including rows blocked by product or reference (shown in a separate bucket when applicable).",
    whyEmpty: "The pool is empty, or every row is expired or closed.",
    nextSteps: [
      "Open Review if blockers are hiding filing readiness.",
      "Check Sources if you expected new rows from a recent scan.",
    ],
  }),
  candidates: buildQueueClearState("candidates", {
    title: "No opportunities in the full pool",
    appearsHere: "Every active opportunity from scheduled scans and live triggers (hidden seed rows excluded).",
    whyEmpty: "The operational pool has no generated rows for this store scope.",
    nextSteps: [
      "Open Sources to verify generators and intake runs.",
      "Adjust store scope if this store has no imports yet.",
    ],
  }),
  review: buildQueueClearState("review", {
    title: "Review queue is clear",
    appearsHere: "Opportunities that need a human decision — product match, reference conflict, or proof gaps.",
    whyEmpty: "No blockers need review right now. Items may be resolved or not in this filter.",
    nextSteps: [
      "Check Home for remaining proof or product blockers.",
      "Open Find money for rows ready to inspect.",
    ],
  }),
  evidence: buildQueueClearState("evidence", {
    title: "No proof gaps in this queue",
    appearsHere: "Physical return opportunities with Proof missing — separate from Review (human decision blockers).",
    whyEmpty: "Proof is complete for rows in scope, or the pool has no matching items.",
    nextSteps: [
      "Open Review for product or reference blockers that are not proof-only.",
      "Proof upload will be available after the filing bridge opens.",
    ],
  }),
  references: buildQueueClearState("references", {
    title: "References not materialized yet",
    appearsHere: "Only candidates with materialized reference edges and ambiguity or conflict.",
    whyEmpty:
      "Reference edges have not been materialized yet, or no ambiguity/conflict exists in scope.",
    nextSteps: [
      "Run reference edge discovery when configured for your workspace.",
      "Reference IDs on rows without edges are not listed here.",
    ],
  }),
  product_linkage: buildQueueClearState("product_linkage", {
    title: "No product match blockers in scope",
    appearsHere: "Opportunities blocked because catalog linkage is unresolved.",
    whyEmpty: "Products are matched for rows in scope, or the pool has no linkage blockers.",
    nextSteps: [
      "Search PIM by ASIN or FNSKU from a row detail drawer when a blocker appears.",
      "Deep catalog edits stay in Product Hub — not Claim Center.",
    ],
  }),
  cases: buildQueueClearState("cases", {
    title: "No claim cases yet",
    appearsHere: "Internal cases promoted from the legacy scanner and returns path.",
    whyEmpty: "Event-pool promote is not built in Claim Center V2.",
    nextSteps: [
      "Use Legacy tools → Claim Engine cases for existing cases.",
      "Promote from opportunities ships with the write bridge.",
    ],
  }),
  submissions: buildQueueClearState("submissions", {
    title: "No legacy filings",
    appearsHere: "Submissions filed on the return-linked legacy path.",
    whyEmpty: "Event-based opportunities are not in this queue until the bridge phase.",
    nextSteps: ["Use Legacy tools → Claim Engine for submission history."],
  }),
  recovery: buildQueueClearState("recovery", {
    title: "No observed reimbursements linked yet",
    appearsHere: "Observed filed and reimbursed status only — not blocked intake candidates.",
    whyEmpty: "No reimbursement, FRR, or external case status has been linked to opportunities in this scope.",
    nextSteps: [
      "Import reimbursement or settlement reports via workspace imports.",
      "Blocked candidates appear under Find Money or Review — not Recovery.",
    ],
  }),
  runs: buildPoolEmptyState("runs", {
    title: "No source activity recorded",
    appearsHere: "Generator runs, discovery watermarks, and intake job results for this workspace.",
    whyEmpty: "No scans or intake runs have produced rows visible to Claim Center yet.",
    nextSteps: [
      "Enable sources in workspace claim settings (Policy snapshot shows effective values).",
      "Run pool generation from Platform Automation when configured.",
    ],
  }),
  policy_snapshot: buildQueueClearState("policy_snapshot", {
    title: "Policy snapshot unavailable",
    appearsHere: "Effective claim intake rules, filing windows, and module gates for this workspace.",
    whyEmpty: "Settings could not be loaded for this session.",
    nextSteps: [
      "Open workspace settings to configure claim domains.",
      "Review automation schedules under Platform → Automation.",
    ],
  }),
};

/** Product story link only when linkage is resolved and identifiers are present. */
export function isSafeForProductStory(row: {
  product_linkage?: { is_resolved?: boolean } | null;
  asin?: string | null;
  fnsku?: string | null;
  sku?: string | null;
}): boolean {
  if (!row.product_linkage?.is_resolved) return false;
  return Boolean(String(row.asin ?? row.fnsku ?? row.sku ?? "").trim());
}

export function productLinkageQueueHref(row: {
  asin?: string | null;
  fnsku?: string | null;
  sku?: string | null;
}): string {
  const id = String(row.asin ?? row.fnsku ?? row.sku ?? "").trim();
  if (id) return `/dashboard/products?search=${encodeURIComponent(id)}`;
  return "/claim-center/product-linkage";
}
