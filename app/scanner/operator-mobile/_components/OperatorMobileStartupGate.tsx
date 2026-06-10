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
import { readCachedPwaVersionPolicy } from "@/lib/pwa-version-cache";
import { checkPwaVersionPolicy, type PwaVersionCheckResult } from "@/lib/pwa-version-check";
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

function resolveSyncPwaPolicyPayload(): PwaVersionEndpointPayload {
  const cached = readCachedPwaVersionPolicy();
  if (cached?.payload) return cached.payload;
  return buildPwaVersionEndpointPayload(DEFAULT_PLATFORM_PWA_SETTINGS);
}

function payloadFromVersionCheckResult(result: PwaVersionCheckResult): PwaVersionEndpointPayload {
  if (result.status === "ok" || result.status === "cache") return result.payload;
  return result.cached ?? buildPwaVersionEndpointPayload(DEFAULT_PLATFORM_PWA_SETTINGS);
}

type OperatorMobileStartupGateProps = {
  children: ReactNode;
};

function OperatorGateInlineBanner({ message }: { message: string }) {
  return (
    <div
      className="pointer-events-none absolute inset-x-0 top-0 z-[450] flex justify-center px-3 pt-[max(0.25rem,env(safe-area-inset-top))]"
      aria-live="polite"
    >
      <div
        className="flex items-center gap-2 rounded-lg border px-3 py-1.5 text-[11px] font-semibold shadow-lg"
        style={{
          borderColor: "var(--scanner-border, #323c48)",
          background: "var(--scanner-card, #0f1419)",
          color: "var(--scanner-text, #faf6ed)",
        }}
      >
        <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" style={{ color: "var(--op-accent-gold, #d6b76e)" }} />
        {message}
      </div>
    </div>
  );
}

/**
 * Startup validation — session, store, and optional PWA-install policy only.
 * Version updates are handled by the global soft banner (non-blocking).
 *
 * Once the gate reaches `ready`, scanner children stay mounted; background profile/store
 * refresh shows a small inline banner instead of replacing the whole screen.
 */
export function OperatorMobileStartupGate({ children }: OperatorMobileStartupGateProps) {
  const { actorUserId, profileLoading } = useUserRole();
  const {
    sessionStoreId,
    sessionStoreValidated,
    operatorStores,
    operatorStoresLoading,
    operatorStoresRefreshing,
    kioskStoreLocked,
    selectSessionStoreId,
  } = useOperatorSessionStore();

  const [phase, setPhase] = useState<GatePhase>("loading");
  const [readyLatched, setReadyLatched] = useState(false);
  const [standalone, setStandalone] = useState(false);
  const [canInstall, setCanInstall] = useState(false);
  const [installing, setInstalling] = useState(false);

  /** Session/store gate — synchronous; never awaits version policy. */
  const evaluateSessionStoreGate = useCallback(() => {
    const installed = isStandalonePwa();
    setStandalone(installed);

    if (!profileLoading && !actorUserId) {
      setPhase("blocked_session");
      return;
    }

    if (readyLatched) {
      setPhase("ready");
      return;
    }

    const storeScopePending =
      operatorStoresLoading || operatorStoresRefreshing || !sessionStoreValidated;

    if (!operatorStoresLoading && !sessionStoreId && !storeScopePending) {
      setPhase("blocked_store");
      return;
    }

    if (profileLoading || storeScopePending) {
      setPhase("loading");
      return;
    }

    setPhase("ready");
    setReadyLatched(true);
  }, [
    actorUserId,
    operatorStoresLoading,
    operatorStoresRefreshing,
    profileLoading,
    readyLatched,
    sessionStoreId,
    sessionStoreValidated,
  ]);

  const applyPwaInstallPolicy = useCallback(
    (payload: PwaVersionEndpointPayload) => {
      const installed = isStandalonePwa();
      setStandalone(installed);
      if (readyLatched || installed || !shouldHardBlockPwaInstall(payload)) {
        evaluateSessionStoreGate();
        return;
      }
      setPhase("blocked_pwa");
    },
    [evaluateSessionStoreGate, readyLatched],
  );

  useEffect(() => {
    const installed = isStandalonePwa();
    setStandalone(installed);
    if (installed) {
      evaluateSessionStoreGate();
      return;
    }
    applyPwaInstallPolicy(resolveSyncPwaPolicyPayload());
  }, [applyPwaInstallPolicy, evaluateSessionStoreGate]);

  useEffect(() => {
    if (isStandalonePwa() || readyLatched) return;
    void checkPwaVersionPolicy().then((result) => {
      applyPwaInstallPolicy(payloadFromVersionCheckResult(result));
    });
  }, [applyPwaInstallPolicy, readyLatched]);

  useEffect(() => {
    if (phase === "blocked_store" && sessionStoreId) {
      evaluateSessionStoreGate();
    }
  }, [phase, sessionStoreId, evaluateSessionStoreGate]);

  useEffect(() => {
    if (phase !== "loading" || readyLatched) return;
    if (profileLoading || operatorStoresLoading) return;
    evaluateSessionStoreGate();
  }, [phase, profileLoading, operatorStoresLoading, readyLatched, evaluateSessionStoreGate]);

  useEffect(() => {
    if (readyLatched) {
      evaluateSessionStoreGate();
    }
  }, [readyLatched, sessionStoreId, sessionStoreValidated, operatorStoresLoading, operatorStoresRefreshing, actorUserId, evaluateSessionStoreGate]);

  useEffect(() => {
    if (phase !== "blocked_pwa") return;
    const sync = () => setCanInstall(Boolean(getDeferredInstallPrompt()));
    sync();
    return subscribeInstallPrompt(sync);
  }, [phase]);

  useEffect(() => {
    const onInstalled = () => {
      evaluateSessionStoreGate();
    };
    window.addEventListener("appinstalled", onInstalled);
    return () => window.removeEventListener("appinstalled", onInstalled);
  }, [evaluateSessionStoreGate]);

  const handleInstall = useCallback(async () => {
    setInstalling(true);
    try {
      const outcome = await runDeferredInstallPrompt();
      if (outcome === "accepted") {
        evaluateSessionStoreGate();
      }
    } finally {
      setInstalling(false);
    }
  }, [evaluateSessionStoreGate]);

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

  const storeScopeUnstable =
    operatorStoresLoading || operatorStoresRefreshing || !sessionStoreValidated;
  const backgroundRefreshing = readyLatched && storeScopeUnstable;
  const initialBooting = !readyLatched && phase === "loading";

  const [showRefreshBanner, setShowRefreshBanner] = useState(false);
  const refreshBannerTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (refreshBannerTimerRef.current) {
      clearTimeout(refreshBannerTimerRef.current);
      refreshBannerTimerRef.current = null;
    }
    if (backgroundRefreshing) {
      refreshBannerTimerRef.current = setTimeout(() => setShowRefreshBanner(true), 400);
      return () => {
        if (refreshBannerTimerRef.current) clearTimeout(refreshBannerTimerRef.current);
      };
    }
    setShowRefreshBanner(false);
    return undefined;
  }, [backgroundRefreshing]);

  const inlineBannerMessage = useMemo(() => {
    if (showRefreshBanner && backgroundRefreshing) return "Checking store…";
    if (initialBooting) return "Starting scanner…";
    return "";
  }, [showRefreshBanner, backgroundRefreshing, initialBooting]);

  useEffect(() => {
    if (process.env.NODE_ENV !== "production" && (backgroundRefreshing || initialBooting)) {
      console.log("[scanner gate]", {
        phase,
        readyLatched,
        profileLoading,
        operatorStoresLoading,
        operatorStoresRefreshing,
        actorUserIdExists: Boolean(actorUserId),
        sessionStoreId,
        operatorStoresCount: operatorStores.length,
      });
    }
  }, [
    backgroundRefreshing,
    initialBooting,
    phase,
    readyLatched,
    profileLoading,
    operatorStoresLoading,
    operatorStoresRefreshing,
    actorUserId,
    sessionStoreId,
    operatorStores.length,
  ]);

  const showBlockedPwa = phase === "blocked_pwa" && !readyLatched;
  const showBlockedSession = phase === "blocked_session";
  const showBlockedStore = phase === "blocked_store" && !readyLatched;


  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="min-h-0 min-w-0 flex-1 flex flex-col">{children}</div>
      {inlineBannerMessage ? <OperatorGateInlineBanner message={inlineBannerMessage} /> : null}
      {showBlockedPwa ? (
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
      ) : null}
      {showBlockedSession ? (
        <OperatorMobileBlockingOverlay
          title="Sign in required"
          ariaLabel="Session required"
          message="You must sign in before using the Menorix scanner."
        >
          <Link href="/login" className={actionButtonClass} style={actionButtonStyle}>
            Sign in
          </Link>
        </OperatorMobileBlockingOverlay>
      ) : null}
      {showBlockedStore ? (
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
              onClick={evaluateSessionStoreGate}
              className={actionButtonClass}
              style={actionButtonStyle}
            >
              Continue
            </button>
          ) : null}
        </OperatorMobileBlockingOverlay>
      ) : null}
    </div>
  );
}
