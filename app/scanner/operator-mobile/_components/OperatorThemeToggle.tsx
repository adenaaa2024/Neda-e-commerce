"use client";

import { useEffect, useState } from "react";
import { Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";

/**
 * Day / night toggle for operator mobile routes. Uses next-themes (`html.dark` / `html.light`).
 */
export function OperatorThemeToggle(props: { className?: string }) {
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) {
    return (
      <div
        className={`h-10 w-10 shrink-0 rounded-xl ${props.className ?? ""}`}
        aria-hidden
      />
    );
  }

  const isDark = resolvedTheme === "dark";

  return (
    <button
      type="button"
      className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border shadow-sm outline-none transition hover:brightness-110 active:scale-95 focus-visible:ring-2 focus-visible:ring-cyan-400/50 dark:shadow-[0_0_20px_rgba(56,189,248,0.12)] ${props.className ?? ""}`}
      style={{
        color: "var(--scanner-text, #f1f5f9)",
        borderColor: isDark ? "rgba(34,211,238,0.28)" : "rgba(228,228,231,0.95)",
        backgroundColor: isDark ? "rgba(255,255,255,0.06)" : "rgba(255,255,255,0.82)",
        boxShadow: isDark
          ? "inset 0 1px 0 rgba(255,255,255,0.07), 0 1px 0 rgba(0,0,0,0.2)"
          : "0 4px 14px rgba(0,0,0,0.06), inset 0 1px 0 rgba(255,255,255,0.9)",
        backdropFilter: "blur(10px)",
      }}
      aria-label={isDark ? "Switch to light mode" : "Switch to dark mode"}
      title={isDark ? "Light mode" : "Dark mode"}
      onClick={() => setTheme(isDark ? "light" : "dark")}
    >
      {isDark ? <Sun className="h-5 w-5" strokeWidth={2} /> : <Moon className="h-5 w-5" strokeWidth={2} />}
    </button>
  );
}
