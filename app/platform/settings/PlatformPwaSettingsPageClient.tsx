"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Loader2, Save, Smartphone } from "lucide-react";

import { PwaSettingsPreviewCards } from "@/components/platform/PwaSettingsPreviewCards";
import { PWA_APP_NAME, PWA_APP_VERSION } from "@/lib/pwa-app-version";
import {
  PWA_MANIFEST_STATIC,
  PROPOSED_PWA_MANIFEST_SETTINGS_KEYS,
} from "@/lib/pwa-manifest-static";
import type { PlatformPwaSettings } from "@/lib/pwa-settings-types";
import { DEFAULT_PLATFORM_PWA_SETTINGS } from "@/lib/pwa-settings-types";
import {
  responsiveFormInput,
  responsivePageInner,
  responsivePageOuter,
} from "@/lib/responsive-page-shell";

import { PageHeaderWithInfo } from "../components/page-header-with-info";
import {
  getPlatformPwaSettingsAction,
  savePlatformPwaSettingsAction,
} from "./pwa-settings-actions";
import { getPlatformSettingsAction } from "./platform-settings-actions";

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-3 rounded-2xl border border-border bg-card p-4 shadow-sm sm:p-6">
      <div>
        <h2 className="text-base font-semibold text-foreground">{title}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{description}</p>
      </div>
      {children}
    </section>
  );
}

function ReadOnlyRow({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div>
      <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 font-mono text-sm text-foreground">{value}</dd>
      {hint ? <p className="mt-1 text-[11px] text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

function DisabledInput({
  id,
  label,
  value,
  hint,
}: {
  id: string;
  label: string;
  value: string;
  hint: string;
}) {
  return (
    <div>
      <label htmlFor={id} className="mb-1.5 block text-sm font-medium text-foreground">
        {label}
      </label>
      <input id={id} type="text" value={value} disabled className={`${responsiveFormInput} opacity-60`} />
      <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">{hint}</p>
    </div>
  );
}

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

export function PlatformPwaSettingsPageClient() {
  const [loading, setLoading] = useState(true);
  const [accessDenied, setAccessDenied] = useState<"not_authenticated" | "forbidden" | null>(null);
  const [platformAppName, setPlatformAppName] = useState("");
  const [settings, setSettings] = useState<PlatformPwaSettings>(DEFAULT_PLATFORM_PWA_SETTINGS);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [pwaRes, brandRes] = await Promise.all([getPlatformPwaSettingsAction(), getPlatformSettingsAction()]);
      if (cancelled) return;
      setAccessDenied(pwaRes.accessDenied);
      if (!pwaRes.accessDenied) {
        const { accessDenied: _ad, ...rest } = pwaRes;
        setSettings(rest);
      }
      if (!brandRes.accessDenied) setPlatformAppName(brandRes.app_name);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function onSavePolicy(e: React.FormEvent) {
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
    setMessage("PWA policy saved.");
  }

  if (loading) {
    return (
      <div className={responsivePageOuter}>
        <div className={`${responsivePageInner} flex min-h-[40vh] items-center justify-center`}>
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      </div>
    );
  }

  if (accessDenied) {
    return (
      <div className={responsivePageOuter}>
        <div className={responsivePageInner}>
          <h1 className="text-lg font-semibold">PWA settings</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {accessDenied === "not_authenticated"
              ? "You must be signed in."
              : "Only super_admin can edit platform PWA settings."}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className={responsivePageOuter}>
      <div className={`${responsivePageInner} space-y-6`}>
        <PageHeaderWithInfo
          title="PWA / Installable app"
          titleClassName="text-2xl font-bold tracking-tight text-foreground sm:text-3xl"
          infoAriaLabel="About PWA settings"
        >
          <p>
            Controls how Menorix appears when installed as an app on mobile and desktop — install behavior,
            version policy, and orientation. This is separate from{" "}
            <Link href="/platform/access" className="font-medium text-violet-600 hover:underline dark:text-violet-400">
              access &amp; permissions
            </Link>
            .
          </p>
          <p className="mt-2">
            Product logo and platform display name live under{" "}
            <Link href="/platform/settings" className="font-medium text-violet-600 hover:underline dark:text-violet-400">
              Platform branding
            </Link>
            .
          </p>
        </PageHeaderWithInfo>

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

        <Section
          title="App identity"
          description="Install name and manifest metadata. Static files today — not editable in UI until wired to platform_settings."
        >
          <dl className="grid gap-4 sm:grid-cols-2">
            <ReadOnlyRow label="Manifest name" value={PWA_MANIFEST_STATIC.name} />
            <ReadOnlyRow label="Short name" value={PWA_MANIFEST_STATIC.short_name} />
            <ReadOnlyRow label="Description" value={PWA_MANIFEST_STATIC.description} />
            <ReadOnlyRow label="Platform app name (metadata title)" value={platformAppName || PWA_APP_NAME} hint="From platform_settings.app_name — used for browser tab title." />
            <ReadOnlyRow label="Deployed build version" value={PWA_APP_VERSION} />
          </dl>
          <div className="grid gap-4 sm:grid-cols-2">
            <DisabledInput
              id="pwa-manifest-name"
              label="App name (future)"
              value={PWA_MANIFEST_STATIC.name}
              hint="Not wired yet — edit public/manifest.json or future platform_settings.pwa_manifest."
            />
            <DisabledInput
              id="pwa-install-copy"
              label="Install prompt text (future)"
              value="Add Menorix to your home screen for faster warehouse scanning."
              hint="Not wired yet — proposed key: install_prompt_body"
            />
          </div>
        </Section>

        <Section
          title="Install experience"
          description="When operators must use an installed app vs browser tabs. Writable — saves to platform_settings.pwa_settings."
        >
          <form onSubmit={onSavePolicy} className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <ToggleRow
                id="pwa-enable-install"
                label="Require installed PWA for operators"
                description="Hard-block mobile browser unless bypass is enabled."
                checked={settings.ENABLE_PWA_REQUIRED}
                onChange={(v) => setSettings((s) => ({ ...s, ENABLE_PWA_REQUIRED: v }))}
              />
              <ToggleRow
                id="pwa-allow-bypass"
                label="Allow browser/testing bypass"
                description="Desktop and mobile browser tabs without installed PWA."
                checked={settings.ALLOW_BROWSER_BYPASS}
                onChange={(v) => setSettings((s) => ({ ...s, ALLOW_BROWSER_BYPASS: v }))}
              />
              <ToggleRow
                id="pwa-hard-mobile"
                label="Hard block mobile browser"
                description="Force install on mobile browser."
                checked={settings.HARD_BLOCK_MOBILE_BROWSER}
                onChange={(v) => setSettings((s) => ({ ...s, HARD_BLOCK_MOBILE_BROWSER: v }))}
              />
              <ToggleRow
                id="pwa-hard-desktop"
                label="Hard block desktop browser"
                description="Block desktop/laptop browser tabs."
                checked={settings.HARD_BLOCK_BROWSER}
                onChange={(v) => setSettings((s) => ({ ...s, HARD_BLOCK_BROWSER: v }))}
              />
            </div>
            <div className="flex justify-end border-t border-border pt-4">
              <button
                type="submit"
                disabled={saving}
                className="inline-flex items-center gap-2 rounded-lg bg-violet-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-violet-700 disabled:opacity-50"
              >
                {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                Save install policy
              </button>
            </div>
          </form>
        </Section>

        <Section
          title="Icons & splash"
          description="Static assets under /public — preview only in this phase."
        >
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {PWA_MANIFEST_STATIC.icons.map((icon) => (
              <div key={icon.src} className="rounded-xl border border-border bg-muted/20 p-3 text-center">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={icon.src} alt="" className="mx-auto h-16 w-16 object-contain" />
                <p className="mt-2 truncate font-mono text-[10px]">{icon.src}</p>
                <p className="text-[10px] text-muted-foreground">{icon.sizes}</p>
              </div>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">
            Sync brand icons: <code className="rounded bg-muted px-1 font-mono text-[10px]">scripts/sync-menorix-brand-pwa-icons.ts</code>
          </p>
        </Section>

        <Section
          title="Colors / theme"
          description="Manifest and layout theme colors — read-only until dynamic manifest generation is wired."
        >
          <dl className="grid gap-4 sm:grid-cols-2">
            <ReadOnlyRow label="Theme color" value={PWA_MANIFEST_STATIC.theme_color} />
            <ReadOnlyRow label="Background color" value={PWA_MANIFEST_STATIC.background_color} />
            <ReadOnlyRow label="Layout viewport themeColor" value={PWA_MANIFEST_STATIC.layout_theme_color} />
            <ReadOnlyRow label="Display mode" value={PWA_MANIFEST_STATIC.display} />
          </dl>
        </Section>

        <Section
          title="Mobile behavior"
          description="Version enforcement and orientation for installed operator shells."
        >
          <form onSubmit={onSavePolicy} className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <ToggleRow
                id="pwa-enable-version"
                label="Enable version enforcement"
                description="Hard-block stale installed PWA below minimum version."
                checked={settings.ENABLE_VERSION_ENFORCEMENT}
                onChange={(v) => setSettings((s) => ({ ...s, ENABLE_VERSION_ENFORCEMENT: v }))}
              />
              <ToggleRow
                id="pwa-enable-orientation"
                label="Enable orientation lock"
                description="Portrait lock on operator PWA devices only."
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
                  onChange={(e) => setSettings((s) => ({ ...s, MINIMUM_SUPPORTED_VERSION: e.target.value }))}
                  className={responsiveFormInput}
                  required
                />
              </div>
              <div>
                <label htmlFor="pwa-latest-version" className="mb-1.5 block text-sm font-medium text-foreground">
                  Latest available version
                </label>
                <input
                  id="pwa-latest-version"
                  type="text"
                  value={settings.LATEST_AVAILABLE_VERSION}
                  onChange={(e) => setSettings((s) => ({ ...s, LATEST_AVAILABLE_VERSION: e.target.value }))}
                  className={responsiveFormInput}
                  required
                />
              </div>
            </div>
            <div className="flex justify-end border-t border-border pt-4">
              <button
                type="submit"
                disabled={saving}
                className="inline-flex items-center gap-2 rounded-lg bg-violet-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-violet-700 disabled:opacity-50"
              >
                {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                Save mobile policy
              </button>
            </div>
          </form>
        </Section>

        <Section title="Preview" description="How install prompts and icons may appear — illustrative only.">
          <PwaSettingsPreviewCards platformAppName={platformAppName} />
        </Section>

        <Section
          title="Advanced / technical"
          description="Storage paths and proposed keys for future manifest UI. No schema changes in this phase."
        >
          <dl className="grid gap-3 text-sm sm:grid-cols-2">
            <ReadOnlyRow label="Writable JSONB" value="platform_settings.pwa_settings" />
            <ReadOnlyRow label="Policy schema" value={String(settings.POLICY_SCHEMA_VERSION ?? 2)} />
            <ReadOnlyRow label="Manifest file" value={PWA_MANIFEST_STATIC.manifest_path} />
            <ReadOnlyRow label="Start URL" value={PWA_MANIFEST_STATIC.start_url} />
            <ReadOnlyRow label="Service worker" value="/sw.js (via PwaServiceWorkerRegister)" hint="Global registration in root layout." />
          </dl>
          <div className="rounded-xl border border-dashed border-border bg-muted/10 p-3">
            <p className="text-xs font-semibold text-foreground">Proposed additive keys (not migrated)</p>
            <ul className="mt-2 flex flex-wrap gap-1.5">
              {PROPOSED_PWA_MANIFEST_SETTINGS_KEYS.map((k) => (
                <li key={k} className="rounded-md bg-muted px-2 py-0.5 font-mono text-[10px]">
                  {k}
                </li>
              ))}
            </ul>
          </div>
        </Section>

        <div className="flex items-center gap-2 rounded-xl border border-border bg-muted/20 px-4 py-3 text-xs text-muted-foreground">
          <Smartphone className="h-4 w-4 shrink-0" />
          <span>
            PWA policy affects installed app gates only. It does not change user roles, organization access, or RBAC.
          </span>
        </div>
      </div>
    </div>
  );
}
