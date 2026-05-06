/** Short vibration for premium handheld UI (no-op if unsupported). */
export function operatorHapticTap(ms: number | number[] = 14): void {
  if (typeof navigator === "undefined" || typeof navigator.vibrate !== "function") return;
  try {
    navigator.vibrate(ms);
  } catch {
    /* ignore */
  }
}

/** Subtle industrial “tick” + haptic for primary actions (sci‑fi handset feel, stays quiet). */
export function operatorUiAcknowledge(): void {
  operatorHapticTap(14);
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
    osc.frequency.value = 920;
    osc.type = "sine";
    const t0 = ctx.currentTime;
    gain.gain.setValueAtTime(0.04, t0);
    gain.gain.exponentialRampToValueAtTime(0.001, t0 + 0.045);
    osc.start(t0);
    osc.stop(t0 + 0.05);
    osc.onended = () => {
      try {
        void ctx.close();
      } catch {
        /* ignore */
      }
    };
  } catch {
    /* ignore */
  }
}
