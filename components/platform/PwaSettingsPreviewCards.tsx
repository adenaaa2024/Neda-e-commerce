"use client";

import { Monitor, Smartphone } from "lucide-react";

import { PWA_MANIFEST_STATIC } from "@/lib/pwa-manifest-static";
import { PWA_APP_NAME, PWA_APP_VERSION } from "@/lib/pwa-app-version";

type Props = {
  platformAppName?: string | null;
  themeColor?: string;
};

export function PwaSettingsPreviewCards({ platformAppName, themeColor = PWA_MANIFEST_STATIC.theme_color }: Props) {
  const displayName = platformAppName?.trim() || PWA_MANIFEST_STATIC.name;
  const iconSrc = PWA_MANIFEST_STATIC.icons.find((i) => i.sizes === "192x192")?.src ?? "/icons/icon-192.png";

  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      <div className="rounded-2xl border border-border bg-card p-4 shadow-sm">
        <div className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          <Smartphone className="h-4 w-4" /> Mobile install preview
        </div>
        <div className="mx-auto max-w-[220px] rounded-[1.75rem] border-4 border-slate-800 bg-slate-950 p-3 shadow-inner dark:border-slate-600">
          <div className="rounded-2xl border border-white/10 bg-[#050607] p-4">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={iconSrc} alt="" className="mx-auto h-14 w-14 rounded-2xl" />
            <p className="mt-3 text-center text-sm font-semibold text-white">{displayName}</p>
            <p className="mt-1 text-center text-[10px] text-white/60">{PWA_MANIFEST_STATIC.short_name}</p>
            <div
              className="mt-4 rounded-lg px-3 py-2 text-center text-[11px] font-semibold text-white"
              style={{ backgroundColor: themeColor }}
            >
              Add to Home Screen
            </div>
          </div>
        </div>
      </div>

      <div className="rounded-2xl border border-border bg-card p-4 shadow-sm">
        <div className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          <Monitor className="h-4 w-4" /> Desktop app preview
        </div>
        <div className="rounded-xl border border-border bg-muted/30 p-3">
          <div className="flex items-center gap-2 border-b border-border pb-2">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={iconSrc} alt="" className="h-8 w-8 rounded-lg" />
            <div>
              <p className="text-sm font-semibold text-foreground">{displayName}</p>
              <p className="text-[10px] text-muted-foreground">Installed PWA · v{PWA_APP_VERSION}</p>
            </div>
          </div>
          <div className="mt-3 h-24 rounded-lg border border-dashed border-border bg-background/80" />
          <p className="mt-2 text-[10px] text-muted-foreground">Standalone window — not a browser tab</p>
        </div>
      </div>

      <div className="rounded-2xl border border-border bg-card p-4 shadow-sm sm:col-span-2 lg:col-span-1">
        <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Icon & theme</p>
        <div className="flex flex-wrap items-center gap-3">
          {PWA_MANIFEST_STATIC.icons.slice(0, 4).map((icon) => (
            <div key={icon.src} className="text-center">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={icon.src} alt="" className="mx-auto h-12 w-12 rounded-xl border border-border bg-background object-contain p-1" />
              <p className="mt-1 text-[9px] text-muted-foreground">{icon.sizes}</p>
            </div>
          ))}
          <div className="flex flex-col gap-1">
            <span className="text-[10px] text-muted-foreground">Theme</span>
            <span
              className="inline-block h-8 w-8 rounded-lg border border-border"
              style={{ backgroundColor: themeColor }}
              title={themeColor}
            />
            <code className="text-[10px]">{themeColor}</code>
          </div>
        </div>
      </div>
    </div>
  );
}
