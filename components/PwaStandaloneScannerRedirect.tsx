"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";
import {
  isScannerPwaEntryPath,
  isStandaloneDisplay,
  SCANNER_PWA_ENTRY_PATH,
} from "@/lib/pwa-standalone";

const PUBLIC_PREFIXES = ["/login", "/auth/"];

/**
 * Installed PWA should open the warehouse scanner — not the ERP dashboard.
 * Handles legacy installs whose cached manifest still uses start_url "/".
 */
export function PwaStandaloneScannerRedirect() {
  const pathname = usePathname();
  const router = useRouter();

  useEffect(() => {
    if (!isStandaloneDisplay()) return;
    if (PUBLIC_PREFIXES.some((p) => pathname.startsWith(p))) return;
    if (isScannerPwaEntryPath(pathname)) return;
    router.replace(SCANNER_PWA_ENTRY_PATH);
  }, [pathname, router]);

  return null;
}
