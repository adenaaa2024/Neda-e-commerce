/** @deprecated Moved to /platform/settings/pwa — use PlatformPwaSettingsPageClient. Kept for reference only. */
"use client";

import { useEffect, useState } from "react";
import { Loader2, Save, Smartphone } from "lucide-react";
import { PWA_APP_VERSION } from "@/lib/pwa-app-version";
import type { PlatformPwaSettings } from "@/lib/pwa-settings-types";
import { DEFAULT_PLATFORM_PWA_SETTINGS } from "@/lib/pwa-settings-types";
import {
  getPlatformPwaSettingsAction,
  savePlatformPwaSettingsAction,
} from "./pwa-settings-actions";
import { responsiveFormInput } from "../../../lib/responsive-page-shell";

function ToggleRow({
  id,
  label,
  description,
  checked,
  onChange,
}: {
  id: string;
  label: string;
  description: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label htmlFor={id} className="flex cursor-pointer items-start gap-3 rounded-xl border border-border bg-muted/20 p-3">
      <input
        id={id}
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-1 h-4 w-4 rounded border-border"
      />
      <span className="min-w-0">
        <span className="block text-sm font-medium text-foreground">{label}</span>
        <span className="mt-0.5 block text-xs text-muted-foreground">{description}</span>
      </span>
    </label>
  );
}

export function PlatformPwaSettingsPanel() {
  const [loading, setLoading] = useState(true);
  const [accessDenied, setAccessDenied] = useState<"not_authenticated" | "forbidden" | null>(null);
  const [settings, setSettings] = useState<PlatformPwaSettings>(DEFAULT_PLATFORM_PWA_SETTINGS);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const res = await getPlatformPwaSettingsAction();
      if (cancelled) return;
      setAccessDenied(res.accessDenied);
      if (!res.accessDenied) {
        const { accessDenied: _ad, ...rest } = res;
        setSettings(rest);
      }
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function onSave(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    setMessage(null);
    const res = await savePlatformPwaSettingsAction({
      ...settings,
      POLICY_SCHEMA_VERSION: 2,
    });
    setSaving(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setMessage("Menorix PWA policy saved.");
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading PWA policy…
      </div>
    );
  }

  if (accessDenied) return null;

  return (
    <form
      onSubmit={onSave}
      className="space-y-4 rounded-2xl border border-border bg-card p-4 shadow-sm sm:p-6"
    >
      <div className="flex items-center gap-2">
        <Smartphone className="h-5 w-5 text-violet-600 dark:text-violet-400" />
        <h2 className="text-lg font-semibold text-foreground">Menorix Mobile Scanner PWA</h2>
      </div>
      <p className="text-sm text-muted-foreground">
        Version hard-block applies only to <strong>installed</strong> Menorix PWA shells — browser tabs always use
        the deployed build ({PWA_APP_VERSION}). Save here writes{" "}
        <code className="rounded bg-muted px-1 font-mono text-[10px]">platform_settings.pwa_settings</code>.
      </p>

      {error ? (
        <div className="rounded-xl border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      ) : null}
      {message ? (
        <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-900 dark:text-emerald-100">
          {message}
        </div>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2">
        <ToggleRow
          id="pwa-enable-version"
          label="Enable version enforcement"
          description="Hard-block stale installed PWA below minimum version. Never blocks browser tabs."
          checked={settings.ENABLE_VERSION_ENFORCEMENT}
          onChange={(v) => setSettings((s) => ({ ...s, ENABLE_VERSION_ENFORCEMENT: v }))}
        />
        <ToggleRow
          id="pwa-enable-install"
          label="Require installed PWA for operators"
          description="Hard-block mobile browser unless bypass is enabled (hardRequireInstalledPwaForOperators)."
          checked={settings.ENABLE_PWA_REQUIRED}
          onChange={(v) => setSettings((s) => ({ ...s, ENABLE_PWA_REQUIRED: v }))}
        />
        <ToggleRow
          id="pwa-allow-bypass"
          label="Allow browser/testing bypass"
          description="Desktop and mobile browser tabs can continue without installed PWA."
          checked={settings.ALLOW_BROWSER_BYPASS}
          onChange={(v) => setSettings((s) => ({ ...s, ALLOW_BROWSER_BYPASS: v }))}
        />
        <ToggleRow
          id="pwa-hard-mobile"
          label="Hard block mobile browser"
          description="Force install on mobile browser even when PWA-not-required is off."
          checked={settings.HARD_BLOCK_MOBILE_BROWSER}
          onChange={(v) => setSettings((s) => ({ ...s, HARD_BLOCK_MOBILE_BROWSER: v }))}
        />
        <ToggleRow
          id="pwa-hard-desktop"
          label="Hard block desktop browser"
          description="Block desktop/laptop browser tabs (rare — testing usually keeps bypass on)."
          checked={settings.HARD_BLOCK_BROWSER}
          onChange={(v) => setSettings((s) => ({ ...s, HARD_BLOCK_BROWSER: v }))}
        />
        <ToggleRow
          id="pwa-enable-orientation"
          label="Enable orientation lock"
          description="Runtime portrait lock on operator-mobile scanner devices only (Zebra/Android/iPhone PWA). Never affects desktop ERP."
          checked={settings.ENABLE_ORIENTATION_LOCK}
          onChange={(v) => setSettings((s) => ({ ...s, ENABLE_ORIENTATION_LOCK: v }))}
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="pwa-min-version" className="mb-1.5 block text-sm font-medium text-foreground">
            Minimum supported version
          </label>
          <input
            id="pwa-min-version"
            type="text"
            value={settings.MINIMUM_SUPPORTED_VERSION}
            onChange={(e) =>
              setSettings((s) => ({ ...s, MINIMUM_SUPPORTED_VERSION: e.target.value }))
            }
            className={responsiveFormInput}
            placeholder={PWA_APP_VERSION}
            required
          />
          <p className="mt-1 text-xs text-muted-foreground">
            Defaults to deployed build {PWA_APP_VERSION}. Raise only when retiring old installed PWAs.
          </p>
        </div>
        <div>
          <label htmlFor="pwa-latest-version" className="mb-1.5 block text-sm font-medium text-foreground">
            Latest available version
          </label>
          <input
            id="pwa-latest-version"
            type="text"
            value={settings.LATEST_AVAILABLE_VERSION}
            onChange={(e) =>
              setSettings((s) => ({ ...s, LATEST_AVAILABLE_VERSION: e.target.value }))
            }
            className={responsiveFormInput}
            placeholder={PWA_APP_VERSION}
            required
          />
        </div>
      </div>

      <div className="rounded-xl border border-border bg-muted/20 px-4 py-3 text-xs text-muted-foreground">
        <p className="font-medium text-foreground">Version reset / operator recovery</p>
        <p className="mt-1">
          If operators see a stale version after deploy, the installed PWA blocking screen offers{" "}
          <strong>Clear app cache and reload</strong> (unregisters service worker, clears Menorix local caches,
          reloads with cache-bust). Set minimum version to {PWA_APP_VERSION} after each deploy unless intentionally
          blocking older installs.
        </p>
      </div>

      <div className="flex justify-end border-t border-border pt-4">
        <button
          type="submit"
          disabled={saving}
          className="inline-flex items-center gap-2 rounded-lg bg-violet-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-violet-700 disabled:opacity-50"
        >
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
          Save PWA policy
        </button>
      </div>
    </form>
  );
}
