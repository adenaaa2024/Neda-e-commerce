"use client";

import Link from "next/link";
import { CloudDownload } from "lucide-react";

export function ImportsApiAutomationNotice() {
  return (
    <section className="rounded-2xl border border-violet-500/30 bg-violet-500/5 px-4 py-4 shadow-sm sm:px-5">
      <div className="flex gap-3">
        <CloudDownload className="mt-0.5 h-5 w-5 shrink-0 text-violet-600 dark:text-violet-400" aria-hidden />
        <div className="min-w-0 space-y-1">
          <h2 className="text-sm font-semibold text-foreground">Amazon / API automation</h2>
          <p className="text-sm text-muted-foreground">
            Manual API pulls and scheduled Amazon report automation moved to{" "}
            <strong className="font-medium text-foreground">Platform Settings → Automation</strong>. This page is for
            file uploads only.
          </p>
          <p className="pt-1">
            <Link
              href="/platform/settings/automation"
              className="text-sm font-medium text-violet-600 underline-offset-2 hover:underline dark:text-violet-400"
            >
              Open Platform Settings → Automation
            </Link>
          </p>
        </div>
      </div>
    </section>
  );
}
