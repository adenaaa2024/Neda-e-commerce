/** Demo-safe scan progress labels — UI only, no lookup/save behavior. */

export type OperatorScanProgressPhase =
  | "idle"
  | "reading"
  | "checking"
  | "loading_expected_lines"
  | "ready"
  | "needs_review"
  | "error";

export const OPERATOR_SCAN_PROGRESS_LABEL: Record<OperatorScanProgressPhase, string> = {
  idle: "",
  reading: "Reading code",
  checking: "Checking shipment",
  loading_expected_lines: "Loading expected lines",
  ready: "Ready",
  needs_review: "Needs review",
  error: "Error",
};

/**
 * Flow chips — the ordered intermediate steps shown as done/active/pending.
 * "ready" and "needs_review" are terminal states rendered explicitly in the strip,
 * NOT in this list, so they never duplicate.
 */
export const OPERATOR_SCAN_PROGRESS_ORDER: OperatorScanProgressPhase[] = [
  "reading",
  "checking",
  "loading_expected_lines",
];

const FLOW_PHASES = ["reading", "checking", "loading_expected_lines"] as const;
type FlowPhase = (typeof FLOW_PHASES)[number];

export function operatorScanProgressChipState(
  chip: OperatorScanProgressPhase,
  active: OperatorScanProgressPhase,
): "done" | "active" | "pending" | "hidden" {
  // Non-flow chips are always hidden in the loop; they are rendered explicitly.
  const chipIdx = FLOW_PHASES.indexOf(chip as FlowPhase);
  if (chipIdx < 0) return "hidden";

  if (active === "idle") return "hidden";

  if (active === "error") {
    // Show "Checking shipment" as active so there's visible feedback during an error.
    if (chip === "checking") return "active";
    return "hidden";
  }

  if (active === "needs_review" || active === "ready") {
    // All flow steps completed — show as done.
    return "done";
  }

  const activeIdx = FLOW_PHASES.indexOf(active as FlowPhase);
  if (activeIdx < 0) return "hidden";
  if (chipIdx < activeIdx) return "done";
  if (chipIdx === activeIdx) return "active";
  return "pending";
}

export type BoxSlipVisionProgressPhase =
  | "idle"
  | "preparing_image"
  | "reading_slip"
  | "validating_result"
  | "ready_to_save"
  | "error";

export const BOX_SLIP_VISION_PROGRESS_LABEL: Record<BoxSlipVisionProgressPhase, string> = {
  idle: "",
  preparing_image: "Preparing image",
  reading_slip: "Reading slip",
  validating_result: "Validating result",
  ready_to_save: "Ready to save",
  error: "Could not read slip",
};

export const BOX_SLIP_VISION_PROGRESS_ORDER: BoxSlipVisionProgressPhase[] = [
  "preparing_image",
  "reading_slip",
  "validating_result",
  "ready_to_save",
];

export function boxSlipVisionProgressChipState(
  chip: BoxSlipVisionProgressPhase,
  active: BoxSlipVisionProgressPhase,
): "done" | "active" | "pending" | "hidden" {
  if (active === "idle" || active === "error") {
    if (active === "error" && chip === "reading_slip") return "active";
    return "hidden";
  }
  const order = BOX_SLIP_VISION_PROGRESS_ORDER;
  const ci = order.indexOf(chip);
  const ai = order.indexOf(active as (typeof order)[number]);
  if (ci < 0 || ai < 0) return "hidden";
  if (ci < ai) return "done";
  if (ci === ai) return "active";
  return "pending";
}
