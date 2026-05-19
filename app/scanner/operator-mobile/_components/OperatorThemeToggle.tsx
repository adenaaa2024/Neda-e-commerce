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
      className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border shadow-sm outline-none transition hover:brightness-110 active:translate-y-px focus-visible:ring-2 focus-visible:ring-[var(--scanner-focus-ring)] ${props.className ?? ""}`}
      style={{
        color: "var(--op-gold-accent)",
        borderColor: "var(--scanner-border)",
        backgroundColor: "var(--scanner-card)",
        boxShadow: "inset 0 1px 0 rgba(255,255,255,0.1), 0 4px 14px rgba(0,0,0,0.18)",
        backdropFilter: "blur(10px)",
      }}
      aria-label={isDark ? "Switch to light mode" : "Switch to dark mode"}
      title={isDark ? "Light mode" : "Dark mode"}
      onClick={() => setTheme(isDark ? "light" : "dark")}
    >
      {isDark ? <Sun className="h-5 w-5 opacity-[0.9]" strokeWidth={2.5} /> : <Moon className="h-5 w-5 opacity-[0.9]" strokeWidth={2.5} />}
    </button>
  );
}
