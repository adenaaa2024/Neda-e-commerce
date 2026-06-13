"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";

import {
  CLAIM_CENTER_MOBILE_MORE_GROUPS,
  isClaimCenterNavActive,
} from "./claim-center-nav-config";

export function ClaimCenterMoreMenu({ trigger }: { trigger: ReactNode }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const pathname = usePathname();
  const searchParams = useSearchParams();

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  return (
    <div className="relative shrink-0" ref={ref}>
      <div onClick={() => setOpen((v) => !v)}>{trigger}</div>
      {open ? (
        <div className="claim-center-card absolute right-0 top-full z-30 mt-2 w-56 rounded-xl border p-2 shadow-lg sm:w-64">
          {CLAIM_CENTER_MOBILE_MORE_GROUPS.map((group) => (
            <div key={group.id} className="mb-2 last:mb-0">
              <p className="mb-1 px-2 text-[10px] font-bold uppercase tracking-wider opacity-50">{group.label}</p>
              <ul className="space-y-0.5">
                {group.items.map((item) => {
                  const active = isClaimCenterNavActive(pathname, searchParams, item);
                  return (
                    <li key={item.href}>
                      <Link
                        href={item.href}
                        onClick={() => setOpen(false)}
                        className={`flex min-h-[40px] items-center rounded-lg px-2 py-2 text-sm font-medium transition-colors ${
                          active ? "bg-black/5 dark:bg-white/5" : "opacity-85 hover:opacity-100"
                        }`}
                      >
                        <span className="flex-1">{item.label}</span>
                        {item.legacy ? (
                          <span className="rounded bg-amber-500/20 px-1.5 py-0.5 text-[9px] font-bold uppercase text-amber-800 dark:text-amber-200">
                            Legacy
                          </span>
                        ) : null}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
