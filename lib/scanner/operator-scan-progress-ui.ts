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

export const OPERATOR_SCAN_PROGRESS_ORDER: OperatorScanProgressPhase[] = [
  "reading",
  "checking",
  "loading_expected_lines",
  "ready",
];

export function operatorScanProgressChipState(
  chip: OperatorScanProgressPhase,
  active: OperatorScanProgressPhase,
): "done" | "active" | "pending" | "hidden" {
  if (active === "idle" || active === "error") {
    if (active === "error" && chip === "checking") return "active";
    return "hidden";
  }
  if (active === "needs_review") {
    if (chip === "loading_expected_lines") return "done";
    if (chip === "ready") return "active";
    return chip === "reading" || chip === "checking" ? "done" : "pending";
  }
  if (active === "ready") {
    const order = [...OPERATOR_SCAN_PROGRESS_ORDER, "ready" as const];
    const ai = order.indexOf(chip as (typeof order)[number]);
    const aa = order.indexOf("ready");
    if (ai < 0) return "hidden";
    return ai <= aa ? "done" : "pending";
  }
  const flow = ["reading", "checking", "loading_expected_lines"] as const;
  const idx = flow.indexOf(chip as (typeof flow)[number]);
  const activeIdx =
    active === "reading" ? 0 : active === "checking" ? 1 : active === "loading_expected_lines" ? 2 : -1;
  if (idx < 0) return "hidden";
  if (idx < activeIdx) return "done";
  if (idx === activeIdx) return "active";
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
