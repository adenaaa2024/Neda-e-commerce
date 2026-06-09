/**
 * Dev-only scanner focus/visibility instrumentation.
 * Logs structured events to the console — never in production builds.
 */

type ScannerFocusLogPayload = Record<string, unknown>;

function isDevScannerInstrumentationEnabled(): boolean {
  return process.env.NODE_ENV === "development";
}

function logScannerDev(event: string, payload: ScannerFocusLogPayload = {}): void {
  if (!isDevScannerInstrumentationEnabled()) return;
  console.info(`[scanner-dev] ${event}`, payload);
}

export function logScannerFocusEvent(source: string, detail?: ScannerFocusLogPayload): void {
  logScannerDev("scanner_focus_event", { source, ...detail });
}

export function logScannerVisibilityEvent(
  visibilityState: DocumentVisibilityState,
  detail?: ScannerFocusLogPayload,
): void {
  logScannerDev("scanner_visibility_event", { visibilityState, ...detail });
}

export function logScannerGateRerunReason(reason: string, detail?: ScannerFocusLogPayload): void {
  logScannerDev("scanner_gate_rerun_reason", { reason, ...detail });
}

export function logScannerFullscreenLoadingReason(reason: string, detail?: ScannerFocusLogPayload): void {
  logScannerDev("scanner_fullscreen_loading_reason", { reason, ...detail });
}

export const SCANNER_GATE_BOOT_SESSION_KEY = "operatorMobile:gateBootComplete:v1";

export function readScannerGateBootCompleteFromSession(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return sessionStorage.getItem(SCANNER_GATE_BOOT_SESSION_KEY) === "1";
  } catch {
    return false;
  }
}

export function markScannerGateBootCompleteInSession(): void {
  if (typeof window === "undefined") return;
  try {
    sessionStorage.setItem(SCANNER_GATE_BOOT_SESSION_KEY, "1");
  } catch {
    /* ignore */
  }
}

export function clearScannerGateBootCompleteInSession(): void {
  if (typeof window === "undefined") return;
  try {
    sessionStorage.removeItem(SCANNER_GATE_BOOT_SESSION_KEY);
  } catch {
    /* ignore */
  }
}
