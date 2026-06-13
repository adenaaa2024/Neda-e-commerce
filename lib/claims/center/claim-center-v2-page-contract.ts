/**
 * Claim Center V2 — page heading and explanation contract (read-only UI).
 */

export type ClaimCenterV2PageId =
  | "home"
  | "opportunities"
  | "review"
  | "evidence"
  | "product_match"
  | "references"
  | "recovery"
  | "sources"
  | "pool"
  | "cases"
  | "submissions"
  | "policies";

export type ClaimCenterV2PageContract = {
  id: ClaimCenterV2PageId;
  route: string;
  navLabel: string;
  question: string;
  dataSource: string;
  appearsHere: string;
  whatToDoNext: string;
  whyEmpty: string;
  /** @deprecated use appearsHere — kept for smoke compatibility */
  helper: string;
};

export const CLAIM_CENTER_V2_PAGES: Record<ClaimCenterV2PageId, ClaimCenterV2PageContract> = {
  home: {
    id: "home",
    route: "/claim-center",
    navLabel: "Home",
    question: "What money and recovery need attention now?",
    dataSource: "Active opportunity pool · dashboard counts · automation health",
    appearsHere: "Quick actions, key metrics, top opportunities, and source health for your store scope.",
    whatToDoNext: "Use the four action tiles to jump to money, review, proof, or product blockers.",
    whyEmpty: "When the pool is empty, a banner explains that generators have not produced rows yet — not demo data.",
    helper: "Scan exposure, blockers, and top opportunities. Filing actions stay disabled until the bridge phase.",
  },
  opportunities: {
    id: "opportunities",
    route: "/claim-center/opportunities",
    navLabel: "Opportunities",
    question: "What money can we recover?",
    dataSource: "Active pool filtered to new, ready-to-file, and closing-soon rows",
    appearsHere: "Recoverable events sorted by value and deadline.",
    whatToDoNext: "Open a row to inspect the full story. Resolve blockers before filing becomes available.",
    whyEmpty: "Queue clear means no rows match money filters; pool empty means generators have not run.",
    helper: "Sort by recovery value and deadline. Open a row to inspect the full event story.",
  },
  review: {
    id: "review",
    route: "/claim-center/candidates?filter=needs_review",
    navLabel: "Review",
    question: "What needs a human decision before filing?",
    dataSource: "Active pool with product, reference, or proof blockers",
    appearsHere: "Rows blocked by product match, reference conflict, or incomplete proof.",
    whatToDoNext: "Inspect each row, then fix blockers in Product Match or References.",
    whyEmpty: "Queue clear means no blockers need review; pool empty means nothing was generated yet.",
    helper: "Resolve blockers in Product Match or References before filing — read-only in V2.",
  },
  evidence: {
    id: "evidence",
    route: "/claim-center/evidence",
    navLabel: "Evidence",
    question: "What proof is missing?",
    dataSource: "Proof status and HTML packet preview per opportunity",
    appearsHere: "Rows with missing or partial photos, notes, and report attachments.",
    whatToDoNext: "Select a row to preview the proof packet. Uploads unlock after the filing bridge.",
    whyEmpty: "Proof is complete for rows in scope, or the pool has no matching items.",
    helper: "HTML packet preview is inspection only — not a filed PDF.",
  },
  product_match: {
    id: "product_match",
    route: "/claim-center/product-linkage",
    navLabel: "Product Match",
    question: "Which recoveries are blocked by product match?",
    dataSource: "Catalog linkage status per opportunity",
    appearsHere: "Unresolved ASIN, FNSKU, or SKU linkage blocking recovery.",
    whatToDoNext: "Open row details and search Product Hub by identifier. Linkage edits stay in PIM.",
    whyEmpty: "All products are matched in scope, or the pool has no linkage blockers.",
    helper: "Unresolved rows need catalog linkage before recovery can be filed.",
  },
  references: {
    id: "references",
    route: "/claim-center/references",
    navLabel: "References",
    question: "Which Amazon references connect this event?",
    dataSource: "Reference IDs and conflict groups per opportunity",
    appearsHere: "Amazon reference links — including ambiguous or conflicting matches.",
    whatToDoNext: "Review conflict badges in row details. Resolution for filing opens after the bridge.",
    whyEmpty: "No reference blockers in scope, or edges have not been materialized yet.",
    helper: "Ambiguity groups need operator review before filing.",
  },
  recovery: {
    id: "recovery",
    route: "/claim-center/recovery",
    navLabel: "Recovery",
    question: "What reimbursement has been observed?",
    dataSource: "Financial imports and carry-forward reimbursement signals",
    appearsHere: "Observed filed and reimbursed status from external sources.",
    whatToDoNext: "Use this view to confirm what Amazon or imports reported — not Menorix filing state.",
    whyEmpty: "No financial-source rows in scope, or imports have not been linked yet.",
    helper: "Observed status reflects imports — not Menorix filing workflow state.",
  },
  sources: {
    id: "sources",
    route: "/claim-center/sources",
    navLabel: "Sources",
    question: "Where did this data come from?",
    dataSource: "Generator runs · discovery watermarks · automation health",
    appearsHere: "Human-readable cards per source: last run, rows produced, warnings, and next step.",
    whatToDoNext: "Confirm generators ran for your store before expecting rows in other queues.",
    whyEmpty: "No intake runs or discovery activity recorded for this workspace yet.",
    helper: "Confirm generators ran for your store before expecting opportunities in other queues.",
  },
  pool: {
    id: "pool",
    route: "/claim-center/candidates",
    navLabel: "Full pool",
    question: "What is the full active opportunity pool?",
    dataSource: "All active opportunities (hidden seed rows excluded)",
    appearsHere: "Complete inbox for power users — same rows as workflow queues with broader filters.",
    whatToDoNext: "Filter and search here when a workflow queue looks unexpectedly empty.",
    whyEmpty: "Pool empty means generators have not produced rows; queue clear means filters exclude all rows.",
    helper: "Complete inbox for power users — same rows as workflow queues with broader filters.",
  },
  cases: {
    id: "cases",
    route: "/claim-center/cases",
    navLabel: "Cases (legacy)",
    question: "What internal claim cases exist on the legacy path?",
    dataSource: "Legacy cases from scanner and returns workflow",
    appearsHere: "Cases promoted outside the event pool — legacy path only.",
    whatToDoNext: "Use Legacy tools → Claim Engine for case management until bridge ships.",
    whyEmpty: "No legacy cases for this scope, or promote-from-opportunity is not built yet.",
    helper: "Case promotion from opportunities is not built in Claim Center V2 yet.",
  },
  submissions: {
    id: "submissions",
    route: "/claim-center/submissions",
    navLabel: "Legacy filings",
    question: "What has been filed on the legacy return-linked path?",
    dataSource: "Legacy submission records linked to return items",
    appearsHere: "Historical filings from the returns workflow — not event-pool opportunities.",
    whatToDoNext: "Use Legacy tools for submission history. Event-pool filing ships with the bridge.",
    whyEmpty: "No legacy submissions in scope, or event opportunities are not in this queue yet.",
    helper: "Event-based opportunities are not in this queue until the bridge phase.",
  },
  policies: {
    id: "policies",
    route: "/claim-center/policies",
    navLabel: "Policy snapshot",
    question: "What rules apply to claim intake and filing?",
    dataSource: "Workspace claim policy and workflow settings (read-only mirror)",
    appearsHere: "Effective intake rules, filing windows, and module gates — read-only.",
    whatToDoNext: "Edit rules in workspace or Platform settings — not inside Claim Center.",
    whyEmpty: "Settings could not be loaded for this session.",
    helper: "Edit rules in workspace or platform settings — not inside Claim Center.",
  },
};

export function getClaimCenterV2Page(id: ClaimCenterV2PageId): ClaimCenterV2PageContract {
  return CLAIM_CENTER_V2_PAGES[id];
}
