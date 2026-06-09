import { operatorHapticTap } from "@/app/scanner/operator-mobile/_lib/operator-haptics";

export type ScannerFeedbackKind = "success" | "warning" | "error" | "complete";

/** User-toggle hook — wire to settings later; default on. */
let scannerFeedbackEnabled = true;

export function setScannerFeedbackEnabled(enabled: boolean): void {
  scannerFeedbackEnabled = enabled;
}

function playTone(
  frequency: number,
  durationSec: number,
  gainPeak: number,
  type: OscillatorType = "sine",
): void {
  if (!scannerFeedbackEnabled) return;
  try {
    const AC =
      typeof window !== "undefined"
        ? window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
        : undefined;
    if (!AC) return;
    const ctx = new AC();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.frequency.value = frequency;
    osc.type = type;
    const t0 = ctx.currentTime;
    gain.gain.setValueAtTime(gainPeak, t0);
    gain.gain.exponentialRampToValueAtTime(0.001, t0 + durationSec);
    osc.start(t0);
    osc.stop(t0 + durationSec);
    osc.onended = () => {
      try {
        void ctx.close();
      } catch {
        /* ignore */
      }
    };
  } catch {
    /* ignore — audio blocked or unavailable */
  }
}

/**
 * Lightweight scanner audio + haptic feedback (Web Audio oscillator; no external files).
 * Safe no-op when audio is blocked. Respect hardware scanner beeps by keeping gain low.
 */
export function playScannerFeedback(kind: ScannerFeedbackKind): void {
  if (!scannerFeedbackEnabled) return;
  switch (kind) {
    case "success":
      operatorHapticTap(12);
      playTone(880, 0.05, 0.035);
      break;
    case "warning":
      operatorHapticTap([10, 40, 10]);
      playTone(520, 0.07, 0.03);
      break;
    case "error":
      operatorHapticTap([18, 30, 18]);
      playTone(280, 0.09, 0.04, "square");
      break;
    case "complete":
      operatorHapticTap([12, 30, 12]);
      playTone(920, 0.045, 0.035);
      window.setTimeout(() => playTone(1040, 0.045, 0.03), 70);
      break;
    default:
      break;
  }
}
