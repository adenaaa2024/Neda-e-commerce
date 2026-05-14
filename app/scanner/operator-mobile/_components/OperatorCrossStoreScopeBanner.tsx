"use client";

import { useRouter } from "next/navigation";
import { Lock, ShieldAlert } from "lucide-react";
import { parseCrossStoreUnauthorizedMessage } from "@/lib/scanner/operator-store-display";
import { useOperatorSessionStore } from "./OperatorSessionStoreProvider";

const OPERATOR_HOME_ROUTE = "/scanner/operator-mobile";

function sanitizeStoreDisplayName(name: string): string {
  return (name ?? "").trim().replace(/"/g, "'");
}

/**
 * Sleek security-scope alert for cross-store tracking / package conflicts (premium dark theme).
 */
export function OperatorCrossStoreScopeBanner({
  message,
  className = "",
}: {
  message: string;
  className?: string;
}) {
  const router = useRouter();
  const { operatorStores, kioskStoreLocked } = useOperatorSessionStore();
  const parsed = parseCrossStoreUnauthorizedMessage(message.trim());
  const isScopeLock = Boolean(parsed);
  const canOfferStoreSwitch = operatorStores.length > 1 && !kioskStoreLocked;

  if (isScopeLock && parsed) {
    const headline = parsed.kind === "package" ? "Package Conflict" : "Tracking Conflict";
    return (
      <div
        role="alert"
        aria-live="polite"
        className={[
          "scroll-mt-4 rounded-xl border border-red-500/45 bg-red-950/30 px-2.5 py-2 shadow-sm backdrop-blur-[2px]",
          "dark:border-red-500/40 dark:bg-red-950/30",
          className,
        ]
          .filter(Boolean)
          .join(" ")}
      >
        <div className="flex items-start gap-2">
          <span className="sr-only">{message}</span>
          <ShieldAlert
            className="mt-0.5 h-4 w-4 shrink-0 text-red-400/90"
            strokeWidth={2.25}
            aria-hidden
          />
          <div className="flex min-w-0 flex-1 items-start justify-between gap-2">
            <div className="min-w-0 flex-1">
              <p className="text-[11px] font-bold leading-tight tracking-tight text-red-50/95">
                {headline}
              </p>
              <p className="mt-0.5 min-w-0 truncate text-[10px] font-medium leading-snug text-red-200/55">
                Found in:{" "}
                <span className="text-red-200/50" aria-hidden>
                  {"\""}
                </span>
                <span className="font-bold text-amber-300 dark:text-amber-200" title={parsed.storeName}>
                  {sanitizeStoreDisplayName(parsed.storeName)}
                </span>
                <span className="text-red-200/50" aria-hidden>
                  {"\""}
                </span>
              </p>
            </div>
            {canOfferStoreSwitch ? (
              <button
                type="button"
                onClick={() => {
                  router.push(OPERATOR_HOME_ROUTE);
                }}
                className="shrink-0 rounded-full border border-red-400/50 bg-transparent px-3 py-1 text-[10px] font-semibold text-red-100/95 transition hover:border-red-300/60 hover:bg-red-500/10 active:scale-[0.98]"
              >
                Switch store
              </button>
            ) : null}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      role="alert"
      className={[
        "scroll-mt-4 rounded-xl border border-slate-600/35 bg-slate-950/40 px-2.5 py-2 shadow-sm backdrop-blur-[2px]",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <div className="flex items-start gap-2">
        <Lock
          className="mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-500"
          strokeWidth={2.25}
          aria-hidden
        />
        <p className="text-[10px] font-medium leading-snug text-slate-300/95">{message}</p>
      </div>
    </div>
  );
}
