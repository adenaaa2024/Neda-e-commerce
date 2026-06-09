"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Download, Loader2, Share } from "lucide-react";
import { useUserRole } from "@/components/UserRoleContext";
import { PWA_APP_NAME } from "@/lib/pwa-app-version";
import {
  getDeferredInstallPrompt,
  runDeferredInstallPrompt,
  subscribeInstallPrompt,
} from "@/lib/pwa-install-prompt";
import {
  isDesktopBrowser,
  isMobileBrowser,
  isStandalonePwa,
} from "@/lib/pwa-runtime-detection";
import type { PwaVersionEndpointPayload } from "@/lib/pwa-settings-types";
import { DEFAULT_PLATFORM_PWA_SETTINGS } from "@/lib/pwa-settings-types";
import { buildPwaVersionEndpointPayload } from "@/lib/pwa-settings-payload";
import { runPwaVersionBootCheckOnce } from "@/lib/pwa-version-boot";
import {
  clearScannerGateBootCompleteInSession,
  logScannerFullscreenLoadingReason,
  logScannerGateRerunReason,
  markScannerGateBootCompleteInSession,
  readScannerGateBootCompleteFromSession,
} from "@/lib/scanner/scanner-focus-instrumentation";
import { useOperatorSessionStore } from "./OperatorSessionStoreProvider";
import { OperatorMobileBlockingOverlay } from "./OperatorMobileBlockingOverlay";

type GatePhase =
  | "loading"
  | "ready"
  | "blocked_pwa"
  | "blocked_session"
  | "blocked_store";

function isIosSafari(): boolean {
  if (typeof navigator === "undefined") return false;
  return /iPhone|iPad|iPod/i.test(navigator.userAgent);
}

function isAndroidChrome(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Android/i.test(navigator.userAgent);
}

function shouldHardBlockPwaInstall(payload: PwaVersionEndpointPayload): boolean {
  if (payload.allow_browser_bypass) return false;
  if (isDesktopBrowser() && payload.hard_block_browser) return true;
  if (isMobileBrowser() && (payload.enable_pwa_required || payload.hard_block_mobile_browser)) {
    return true;
  }
  return false;
}

type OperatorMobileStartupGateProps = {
  children: ReactNode;
};

/**
 * Session + store startup gate for operator mobile.
 * Version updates use the global soft banner — never hard-block scanning here.
 * After first successful boot, focus/visibility/store revalidation must not unmount scanner UI.
 */
export function OperatorMobileStartupGate({ children }: OperatorMobileStartupGateProps) {
  const { actorUserId, profileLoading } = useUserRole();
  const {
    sessionStoreId,
    operatorStores,
    operatorStoresLoading,
    kioskStoreLocked,
    selectSessionStoreId,
  } = useOperatorSessionStore();

  const bootCompleteRef = useRef(readScannerGateBootCompleteFromSession());
  const [initialBootComplete, setInitialBootComplete] = useState(bootCompleteRef.current);
  const pwaPolicyCheckedRef = useRef(false);

  const [phase, setPhase] = useState<GatePhase>(() => (bootCompleteRef.current ? "ready" : "loading"));
  const [, setPolicy] = useState<PwaVersionEndpointPayload>(() =>
    buildPwaVersionEndpointPayload(DEFAULT_PLATFORM_PWA_SETTINGS),
  );
  const [standalone, setStandalone] = useState(false);
  const [canInstall, setCanInstall] = useState(false);
  const [installing, setInstalling] = useState(false);

  const profileLoadingRef = useRef(profileLoading);
  profileLoadingRef.current = profileLoading;
  const operatorStoresLoadingRef = useRef(operatorStoresLoading);
  operatorStoresLoadingRef.current = operatorStoresLoading;
  const actorUserIdRef = useRef(actorUserId);
  actorUserIdRef.current = actorUserId;
  const sessionStoreIdRef = useRef(sessionStoreId);
  sessionStoreIdRef.current = sessionStoreId;

  const markBootComplete = useCallback(() => {
    if (bootCompleteRef.current) return;
    bootCompleteRef.current = true;
    markScannerGateBootCompleteInSession();
    setInitialBootComplete(true);
  }, []);

  const evaluateGate = useCallback(
    async (reason: string) => {
      logScannerGateRerunReason(reason, {
        profileLoading: profileLoadingRef.current,
        operatorStoresLoading: operatorStoresLoadingRef.current,
        actorUserId: actorUserIdRef.current,
        sessionStoreId: sessionStoreIdRef.current,
        initialBootComplete: bootCompleteRef.current,
      });

      const installed = isStandalonePwa();
      setStandalone(installed);

      if (!pwaPolicyCheckedRef.current) {
        pwaPolicyCheckedRef.current = true;
        const boot = await runPwaVersionBootCheckOnce();
        setPolicy(boot.payload);
        if (!installed && shouldHardBlockPwaInstall(boot.payload)) {
          setPhase("blocked_pwa");
          return;
        }
      }

      if (!profileLoadingRef.current && !actorUserIdRef.current) {
        clearScannerGateBootCompleteInSession();
        bootCompleteRef.current = false;
        setInitialBootComplete(false);
        setPhase("blocked_session");
        return;
      }

      if (!operatorStoresLoadingRef.current && !sessionStoreIdRef.current) {
        if (!bootCompleteRef.current) {
          setPhase("blocked_store");
        }
        return;
      }

      if (!bootCompleteRef.current && (profileLoadingRef.current || operatorStoresLoadingRef.current)) {
        logScannerFullscreenLoadingReason("initial_boot_wait", {
          profileLoading: profileLoadingRef.current,
          operatorStoresLoading: operatorStoresLoadingRef.current,
        });
        setPhase("loading");
        return;
      }

      markBootComplete();
      setPhase("ready");
    },
    [markBootComplete],
  );

  useEffect(() => {
    void evaluateGate("mount_or_identity_change");
  }, [actorUserId, sessionStoreId, evaluateGate]);

  useEffect(() => {
    if (bootCompleteRef.current) return;
    if (!profileLoading && !operatorStoresLoading) {
      void evaluateGate("initial_loading_cleared");
    }
  }, [profileLoading, operatorStoresLoading, evaluateGate]);

  useEffect(() => {
    if (phase === "blocked_store" && sessionStoreId) {
      void evaluateGate("store_selected");
    }
  }, [phase, sessionStoreId, evaluateGate]);

  useEffect(() => {
    if (phase !== "blocked_pwa") return;
    const sync = () => setCanInstall(Boolean(getDeferredInstallPrompt()));
    sync();
    return subscribeInstallPrompt(sync);
  }, [phase]);

  useEffect(() => {
    const onInstalled = () => {
      void evaluateGate("pwa_installed");
    };
    window.addEventListener("appinstalled", onInstalled);
    return () => window.removeEventListener("appinstalled", onInstalled);
  }, [evaluateGate]);

  const handleInstall = useCallback(async () => {
    setInstalling(true);
    try {
      const outcome = await runDeferredInstallPrompt();
      if (outcome === "accepted") {
        await evaluateGate("install_accepted");
      }
    } finally {
      setInstalling(false);
    }
  }, [evaluateGate]);

  const iosManual = useMemo(() => !standalone && isIosSafari(), [standalone]);
  const androidMenu = useMemo(
    () => !standalone && isAndroidChrome() && !canInstall && !iosManual,
    [canInstall, standalone, iosManual],
  );

  const actionButtonClass =
    "inline-flex w-full items-center justify-center gap-2 rounded-xl px-4 py-3 text-[14px] font-black transition active:scale-[0.98] disabled:opacity-60";
  const actionButtonStyle = {
    color: "var(--op-app-bg, #050607)",
    background: "var(--op-accent-gold, #d6b76e)",
  };

  const showBlockingLoading =
    !initialBootComplete && phase === "loading" && (profileLoading || operatorStoresLoading);
  const showSilentRevalidation =
    initialBootComplete && phase === "ready" && (profileLoading || operatorStoresLoading);

  if (showBlockingLoading) {
    return (
      <div
        className="flex min-h-dvh items-center justify-center px-6 text-center text-[13px] font-semibold"
        style={{ color: "var(--op-text-secondary, #b9c2cc)" }}
      >
        Loading scanner…
      </div>
    );
  }

  if (phase === "blocked_pwa") {
    return (
      <OperatorMobileBlockingOverlay
          title="Install Menorix to continue"
          ariaLabel="PWA install required"
          message={
            iosManual
              ? "Install Menorix on your Home Screen for full-screen scanner access. Tap Share, then Add to Home Screen."
              : canInstall
                ? "Menorix must be installed as an app — not opened in a browser tab."
                : androidMenu
                  ? "Use Chrome Menu ⋮ → Install app (not Shortcut) to install Menorix."
                  : "Install Menorix from your browser as a standalone app to continue."
          }
        >
          {canInstall ? (
            <button
              type="button"
              onClick={() => void handleInstall()}
              disabled={installing}
              className={actionButtonClass}
              style={actionButtonStyle}
            >
              <Download className="h-4 w-4 shrink-0" aria-hidden />
              {installing ? "Installing…" : `Install ${PWA_APP_NAME}`}
            </button>
          ) : iosManual ? (
            <p
              className="inline-flex items-center justify-center gap-1 text-[12px] font-semibold"
              style={{ color: "var(--op-accent-gold, #d6b76e)" }}
            >
              <Share className="h-4 w-4 shrink-0" aria-hidden />
              Share → Add to Home Screen
            </p>
          ) : null}
        </OperatorMobileBlockingOverlay>
    );
  }

  if (phase === "blocked_session") {
    return (
      <OperatorMobileBlockingOverlay
          title="Sign in required"
          ariaLabel="Session required"
          message="You must sign in before using the Menorix scanner."
        >
          <Link href="/login" className={actionButtonClass} style={actionButtonStyle}>
            Sign in
          </Link>
        </OperatorMobileBlockingOverlay>
    );
  }

  if (phase === "blocked_store" && !initialBootComplete) {
    return (
      <OperatorMobileBlockingOverlay
          title="Select a store"
          ariaLabel="Store selection required"
          message={
            kioskStoreLocked
              ? "Store context is missing. Configure NEXT_PUBLIC_STORE_ID for this kiosk device."
              : operatorStores.length > 1
                ? "Choose the active store before entering the scanner."
                : "No store is available for your account. Contact an administrator."
          }
        >
          {!kioskStoreLocked && operatorStores.length > 1 ? (
            <select
              value={sessionStoreId ?? ""}
              onChange={(e) => selectSessionStoreId(e.target.value)}
              className="w-full rounded-xl border px-3 py-2.5 text-[13px] font-semibold"
              style={{
                borderColor: "var(--scanner-border, #323c48)",
                background: "var(--scanner-bg, #0a0e14)",
                color: "var(--scanner-text, #faf6ed)",
              }}
              aria-label="Select active store"
            >
              <option value="">Select store…</option>
              {operatorStores.map((store) => (
                <option key={store.id} value={store.id}>
                  {store.name}
                </option>
              ))}
            </select>
          ) : null}
          {sessionStoreId ? (
            <button
              type="button"
              onClick={() => void evaluateGate("store_continue")}
              className={actionButtonClass}
              style={actionButtonStyle}
            >
              Continue
            </button>
          ) : null}
        </OperatorMobileBlockingOverlay>
    );
  }

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
      {showSilentRevalidation ? (
        <div
          className="pointer-events-none absolute inset-x-0 top-[max(0.25rem,env(safe-area-inset-top))] z-[500] flex justify-center px-3"
          aria-live="polite"
        >
          <span
            className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[10px] font-semibold shadow-sm"
            style={{
              background: "rgba(10, 14, 20, 0.92)",
              color: "var(--op-text-secondary, #b9c2cc)",
              border: "1px solid var(--scanner-border, #323c48)",
            }}
          >
            <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
            Reconnecting…
          </span>
        </div>
      ) : null}
      {children}
    </div>
  );
}
