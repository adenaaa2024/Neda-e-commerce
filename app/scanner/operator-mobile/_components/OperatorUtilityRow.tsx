"use client";

import { useEffect, useState } from "react";
import { Moon, RotateCcw, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { LogoMark } from "@/components/LogoMark";
import { usePlatformBranding } from "@/components/PlatformBrandingContext";

/**
 * Slim utility row pinned to the top of the operator-mobile shell.
 *
 *   ┌──────────────────────────────────────────────────────────┐
 *   │ [⌗] Cursor App                                  [↻] [☀] │
 *   └──────────────────────────────────────────────────────────┘
 *
 * Left:  platform / product brand from `platform_settings` (the SaaS provider).
 *        Kept distinct from the tenant brand below so operators can always tell
 *        which application they are on, even when a tenant logo is present.
 * Right: Refresh (soft reload of the current page) + light/dark theme toggle.
 *
 * Each control is small (h-7 / w-7) so the row stays ~26 px tall.
 */
export function OperatorUtilityRow({ className }: { className?: string }) {
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);
  const isDark = mounted ? resolvedTheme === "dark" : true;

  const { platformAppName, loading: platformLoading } = usePlatformBranding();
  const platformLabel = platformLoading ? "" : platformAppName.trim();

  const handleRefresh = () => {
    if (typeof window === "undefined") return;
    window.location.reload();
  };

  const btn =
    "flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-zinc-600 transition hover:bg-black/[0.06] active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/40 dark:text-zinc-400 dark:hover:bg-white/[0.06]";

  return (
    <div
      className={["flex w-full items-center justify-between gap-2", className].filter(Boolean).join(" ")}
    >
      {/* Left: platform / product brand — sized larger than the tenant brand below
          so the SaaS provider stays the dominant identity in the header. */}
      <div className="flex min-w-0 flex-1 items-center gap-1.5">
        <LogoMark className="h-6 w-6 shrink-0" />
        {platformLabel ? (
          <span
            className="operator-heading min-w-0 truncate text-[14px] font-bold tracking-tight"
            style={{ color: "var(--scanner-text)" }}
            title={platformLabel}
          >
            {platformLabel}
          </span>
        ) : null}
      </div>

      {/* Right: Refresh + Theme toggle. */}
      <div className="flex shrink-0 items-center gap-0.5">
        <button
          type="button"
          onClick={handleRefresh}
          aria-label="Refresh page"
          title="Refresh"
          className={btn}
        >
          <RotateCcw className="h-3.5 w-3.5" strokeWidth={2.25} />
        </button>
        <button
          type="button"
          onClick={() => setTheme(isDark ? "light" : "dark")}
          aria-label={isDark ? "Switch to light mode" : "Switch to dark mode"}
          title={isDark ? "Light mode" : "Dark mode"}
          className={btn}
        >
          {!mounted ? (
            <span className="h-3.5 w-3.5" aria-hidden />
          ) : isDark ? (
            <Sun className="h-3.5 w-3.5" strokeWidth={2.25} />
          ) : (
            <Moon className="h-3.5 w-3.5" strokeWidth={2.25} />
          )}
        </button>
      </div>
    </div>
  );
}
