"use client";

import { isMenorixPlatformName } from "@/lib/platform-branding";
import { MenorixWordmark, type MenorixWordmarkSize } from "@/components/MenorixWordmark";

type PlatformAppWordmarkProps = {
  name: string;
  loading?: boolean;
  size?: MenorixWordmarkSize;
  animated?: boolean;
  className?: string;
  /** Plain-text fallback when platform name is not Menorix. */
  fallbackClassName?: string;
};

/**
 * Platform product label — stylized Menorix wordmark when `app_name` is Menorix
 * (or unset), otherwise the configured name as plain text.
 */
export function PlatformAppWordmark({
  name,
  loading = false,
  size = "sidebar",
  animated = false,
  className,
  fallbackClassName,
}: PlatformAppWordmarkProps) {
  if (loading && !name.trim()) {
    return (
      <span className={fallbackClassName ?? "text-sm font-bold text-muted-foreground"} aria-hidden>
        …
      </span>
    );
  }

  if (isMenorixPlatformName(name)) {
    return <MenorixWordmark size={size} animated={animated} className={className} />;
  }

  const label = name.trim() || "·";
  return (
    <span className={fallbackClassName} title={label}>
      {label}
    </span>
  );
}
