"use client";

import { useEffect, useState } from "react";
import { Building2 } from "lucide-react";
import { LogoMark } from "@/components/LogoMark";
import { useBranding } from "@/components/BrandingContext";
import { usePlatformBranding } from "@/components/PlatformBrandingContext";

/**
 * Left: platform product from `platform_settings` (Platform Settings → product branding).
 * Right: tenant mark from `organization_settings` (Settings → Store & adapters → company branding).
 */
export function OperatorProductBrandingStrip({ className }: { className?: string }) {
  const { platformAppName, loading: platformLoading } = usePlatformBranding();
  const { companyName, logoUrl, loading: tenantLoading } = useBranding();
  const platformLabel = platformLoading ? "…" : platformAppName.trim();
  const tenantLabel = tenantLoading ? "" : companyName.trim();

  const [tenantImgBroken, setTenantImgBroken] = useState(false);
  useEffect(() => {
    setTenantImgBroken(false);
  }, [logoUrl]);
  const showTenantImg = Boolean(logoUrl) && !tenantImgBroken;

  const right = tenantLoading ? (
    <span
      className="text-xs font-semibold tabular-nums opacity-60"
      style={{ color: "var(--scanner-text)" }}
      aria-hidden
    >
      …
    </span>
  ) : showTenantImg || tenantLabel ? (
    <span className="flex max-w-[min(13rem,48vw)] min-w-0 items-center justify-end gap-1.5">
      {showTenantImg ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={logoUrl}
          alt=""
          aria-hidden
          className="h-8 w-auto max-w-[5.5rem] shrink-0 rounded-md object-contain"
          onError={() => setTenantImgBroken(true)}
        />
      ) : (
        <Building2
          className="h-4 w-4 shrink-0 opacity-70"
          style={{ color: "var(--scanner-muted)" }}
          aria-hidden
        />
      )}
      {tenantLabel ? (
        <span
          className="operator-heading min-w-0 truncate text-right text-xs font-semibold tracking-tight"
          style={{ color: "var(--scanner-text)" }}
          title={tenantLabel}
        >
          {tenantLabel}
        </span>
      ) : null}
    </span>
  ) : null;

  return (
    <div
      className={["flex w-full min-w-0 items-center justify-between gap-3", className].filter(Boolean).join(" ")}
    >
      <div className="flex min-w-0 flex-1 items-center justify-start gap-2">
        <LogoMark className="h-8 w-8 shrink-0" />
        {platformLabel ? (
          <span
            className="operator-heading max-w-[min(17rem,calc(100%-2.75rem))] truncate text-sm font-semibold tracking-tight"
            style={{ color: "var(--scanner-text)" }}
            title={platformLabel}
          >
            {platformLabel}
          </span>
        ) : null}
      </div>
      {right ? <div className="flex shrink-0 items-center justify-end">{right}</div> : null}
    </div>
  );
}
