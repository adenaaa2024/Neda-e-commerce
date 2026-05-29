import type { JobTickInput, JobTickResult } from "./types";

const SMOKE_TICKS = 3;

/** Resumable smoke worker — completes after 3 ticks without external I/O. */
export async function runSmokeTickWorker(input: JobTickInput): Promise<JobTickResult> {
  const prev = Number(input.step.cursor?.tick ?? 0);
  const tick = prev + 1;
  const progress = Math.min(100, Math.round((tick / SMOKE_TICKS) * 100));

  if (tick >= SMOKE_TICKS) {
    return {
      ok: true,
      needsTick: false,
      stepProgressPct: 100,
      cursor: { tick },
      output: { smoke: true, ticks: tick },
    };
  }

  return {
    ok: true,
    needsTick: true,
    stepProgressPct: progress,
    cursor: { tick },
    output: { smoke: true, ticks: tick },
  };
}
