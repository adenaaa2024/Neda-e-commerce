"use client";

import { useEffect, useState } from "react";

type UseCountUpOptions = {
  duration?: number;
  enabled?: boolean;
};

/** Eased count-up for dashboard metrics (respects reduced motion). */
export function useCountUp(target: number, options: UseCountUpOptions = {}): number {
  const { duration = 1800, enabled = true } = options;
  const [value, setValue] = useState(enabled ? 0 : target);

  useEffect(() => {
    if (!enabled || !Number.isFinite(target)) {
      setValue(target);
      return;
    }

    if (typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setValue(target);
      return;
    }

    let frame = 0;
    let start: number | null = null;
    const from = 0;

    const tick = (ts: number) => {
      if (start === null) start = ts;
      const progress = Math.min(1, (ts - start) / duration);
      const eased = 1 - (1 - progress) ** 3;
      setValue(Math.round(from + (target - from) * eased));
      if (progress < 1) frame = requestAnimationFrame(tick);
    };

    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [target, duration, enabled]);

  return value;
}

export function parseCountUpTarget(raw: string): number | null {
  const cleaned = raw.replace(/,/g, "").trim();
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}
