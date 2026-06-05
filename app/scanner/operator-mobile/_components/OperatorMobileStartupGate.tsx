"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Download, RefreshCw, Share } from "lucide-react";
import { useUserRole } from "@/components/UserRoleContext";
import { performMenorixPwaUpdate, clearMenorixPwaRuntimeCaches, reloadMenorixWithCacheBust } from "@/lib/pwa-cache-reset";
import { PWA_APP_NAME, PWA_APP_VERSION } from "@/lib/pwa-app-version";
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
import {
  checkPwaVersionPolicy,
  shouldHardBlockStaleInstalledPwa,
} from "@/lib/pwa-version-check";
import { useOperatorSessionStore } from "./OperatorSessionStoreProvider";
import { OperatorMobileBlockingOverlay } from "./OperatorMobileBlockingOverlay";

type GatePhase =
  | "loading"
  | "ready"
  | "blocked_pwa"
  | "blocked_version"
  | "blocked_version_fetch"
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
 * Startup validation — version hard-block applies only to stale installed PWA shells.
 * Browser tabs (desktop + mobile) always use the deployed build as current version.
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

  const [phase, setPhase] = useState<GatePhase>("loading");
  const [policy, setPolicy] = useState<PwaVersionEndpointPayload>(() =>
    buildPwaVersionEndpointPayload(DEFAULT_PLATFORM_PWA_SETTINGS),
  );
  const [standalone, setStandalone] = useState(false);
  const [canInstall, setCanInstall] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [clearingCache, setClearingCache] = useState(false);
  const [retryingVersion, setRetryingVersion] = useState(false);
  const [updateAttempted, setUpdateAttempted] = useState(false);

  const evaluateGate = useCallback(async () => {
    const installed = isStandalonePwa();
    setStandalone(installed);

    const versionResult = await checkPwaVersionPolicy();
    let payload: PwaVersionEndpointPayload;

    if (versionResult.status === "ok" || versionResult.status === "cache") {
      payload = versionResult.payload;
    } else if (installed) {
      if (versionResult.cacheExpired || !versionResult.cached) {
        setPolicy(versionResult.cached ?? buildPwaVersionEndpointPayload(DEFAULT_PLATFORM_PWA_SETTINGS));
        setPhase("blocked_version_fetch");
        return;
      }
      payload = versionResult.cached;
    } else {
      payload = buildPwaVersionEndpointPayload(DEFAULT_PLATFORM_PWA_SETTINGS);
    }

    setPolicy(payload);

    if (installed && shouldHardBlockStaleInstalledPwa(payload, true)) {
      setPhase("blocked_version");
      return;
    }

    if (!installed && shouldHardBlockPwaInstall(payload)) {
      setPhase("blocked_pwa");
      return;
    }

    if (!profileLoading && !actorUserId) {
      setPhase("blocked_session");
      return;
    }

    if (!operatorStoresLoading && !sessionStoreId) {
      setPhase("blocked_store");
      return;
    }

    if (profileLoading || operatorStoresLoading) {
      setPhase("loading");
      return;
    }

    setPhase("ready");
  }, [actorUserId, operatorStoresLoading, profileLoading, sessionStoreId]);

  useEffect(() => {
    void evaluateGate();
  }, [evaluateGate]);

  useEffect(() => {
    if (phase === "blocked_store" && sessionStoreId) {
      void evaluateGate();
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
      void evaluateGate();
    };
    window.addEventListener("appinstalled", onInstalled);
    return () => window.removeEventListener("appinstalled", onInstalled);
  }, [evaluateGate]);

  const handleInstall = useCallback(async () => {
    setInstalling(true);
    try {
      const outcome = await runDeferredInstallPrompt();
      if (outcome === "accepted") {
        await evaluateGate();
      }
    } finally {
      setInstalling(false);
    }
  }, [evaluateGate]);

  const handleUpdate = useCallback(async () => {
    setUpdating(true);
    setUpdateAttempted(true);
    try {
      await performMenorixPwaUpdate();
    } finally {
      setUpdating(false);
    }
  }, []);

  const handleClearCacheAndReload = useCallback(async () => {
    setClearingCache(true);
    try {
      await clearMenorixPwaRuntimeCaches();
      reloadMenorixWithCacheBust();
    } finally {
      setClearingCache(false);
    }
  }, []);

  const handleRetryVersion = useCallback(async () => {
    setRetryingVersion(true);
    try {
      await evaluateGate();
    } finally {
      setRetryingVersion(false);
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
  const secondaryButtonClass =
    "inline-flex w-full items-center justify-center gap-2 rounded-xl border px-4 py-3 text-[13px] font-bold transition active:scale-[0.98] disabled:opacity-60";
  const secondaryButtonStyle = {
    borderColor: "var(--scanner-border, #323c48)",
    color: "var(--scanner-text, #faf6ed)",
    background: "transparent",
  };

  const showLoadingOverlay = phase === "loading" && (standalone || profileLoading || operatorStoresLoading);

  if (showLoadingOverlay) {
    return (
      <div
        className="flex min-h-dvh items-center justify-center px-6 text-center text-[13px] font-semibold"
        style={{ color: "var(--op-text-secondary, #b9c2cc)" }}
      >
        {standalone ? "Checking Menorix app version…" : "Loading scanner…"}
      </div>
    );
  }

  if (phase === "blocked_version_fetch") {
    return (
      <OperatorMobileBlockingOverlay
          title="Unable to validate application version"
          ariaLabel="Version validation failed"
          message="Menorix could not reach the version server. Installed app requires validation before continuing."
        >
          <button
            type="button"
            onClick={() => void handleRetryVersion()}
            disabled={retryingVersion}
            className={actionButtonClass}
            style={actionButtonStyle}
          >
            <RefreshCw className="h-4 w-4 shrink-0" aria-hidden />
            {retryingVersion ? "Retrying…" : "Retry"}
          </button>
          <button
            type="button"
            onClick={() => void handleClearCacheAndReload()}
            disabled={clearingCache}
            className={secondaryButtonClass}
            style={secondaryButtonStyle}
          >
            {clearingCache ? "Clearing…" : "Clear app cache and reload"}
          </button>
        </OperatorMobileBlockingOverlay>
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

  if (phase === "blocked_version") {
    return (
      <OperatorMobileBlockingOverlay
          title="Update Required"
          ariaLabel="App update required"
          message={
            <>
              <p>A newer version of {PWA_APP_NAME} is available.</p>
              <p className="mt-2">You must update before continuing.</p>
              <p className="mt-2 text-[11px] font-medium opacity-80">
                Installed {PWA_APP_VERSION}
                {policy.minimum_supported_version
                  ? ` · Required ${policy.minimum_supported_version}`
                  : null}
              </p>
            </>
          }
        >
          <button
            type="button"
            onClick={() => void handleUpdate()}
            disabled={updating}
            className={actionButtonClass}
            style={actionButtonStyle}
          >
            <RefreshCw className="h-4 w-4 shrink-0" aria-hidden />
            {updating ? "Updating…" : "Update Now"}
          </button>
          <button
            type="button"
            onClick={() => void handleClearCacheAndReload()}
            disabled={clearingCache}
            className={secondaryButtonClass}
            style={secondaryButtonStyle}
          >
            {clearingCache ? "Clearing…" : "Clear app cache and reload"}
          </button>
          {updateAttempted ? (
            <p className="text-left text-[11px] font-medium leading-relaxed" style={{ color: "var(--op-text-secondary, #b9c2cc)" }}>
              If Update Now did not resolve the version mismatch, use Clear app cache and reload. Only remove the
              old shortcut if the problem persists after both steps.
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

  if (phase === "blocked_store") {
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
              onClick={() => void evaluateGate()}
              className={actionButtonClass}
              style={actionButtonStyle}
            >
              Continue
            </button>
          ) : null}
        </OperatorMobileBlockingOverlay>
    );
  }

  return children;
}
