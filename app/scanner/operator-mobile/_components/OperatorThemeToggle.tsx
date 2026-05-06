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
      className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl transition hover:bg-black/[0.07] active:scale-95 dark:hover:bg-white/10 ${props.className ?? ""}`}
      style={{ color: "var(--scanner-text, #f1f5f9)" }}
      aria-label={isDark ? "Switch to light mode" : "Switch to dark mode"}
      title={isDark ? "Light mode" : "Dark mode"}
      onClick={() => setTheme(isDark ? "light" : "dark")}
    >
      {isDark ? <Sun className="h-5 w-5" strokeWidth={2} /> : <Moon className="h-5 w-5" strokeWidth={2} />}
    </button>
  );
}
