/**
 * Static PWA manifest contract — mirrors public/manifest.json for settings UI (read-only).
 * Edit manifest.json + app/layout.tsx to change install identity; not stored in DB today.
 */
export type PwaManifestStaticContract = {
  id: string;
  name: string;
  short_name: string;
  description: string;
  start_url: string;
  scope: string;
  display: string;
  background_color: string;
  theme_color: string;
  icons: Array<{ src: string; sizes: string; purpose?: string }>;
  manifest_path: string;
  layout_theme_color: string;
};

export const PWA_MANIFEST_STATIC: PwaManifestStaticContract = {
  id: "menorix-pwa",
  name: "Menorix",
  short_name: "Menorix",
  description: "Menorix warehouse mobile scanner — returns intake",
  start_url: "/scanner/operator-mobile?source=pwa",
  scope: "/",
  display: "standalone",
  background_color: "#050607",
  theme_color: "#050607",
  icons: [
    { src: "/favicon.png", sizes: "48x48", purpose: "any" },
    { src: "/icons/icon-192.png", sizes: "192x192", purpose: "any" },
    { src: "/icons/icon-512.png", sizes: "512x512", purpose: "any" },
    { src: "/icons/icon-512-maskable.png", sizes: "512x512", purpose: "maskable" },
    { src: "/apple-touch-icon.png", sizes: "180x180", purpose: "any" },
  ],
  manifest_path: "/manifest.json",
  layout_theme_color: "#050607",
};

/** Proposed additive JSONB keys — do not migrate in this phase. */
export const PROPOSED_PWA_MANIFEST_SETTINGS_KEYS = [
  "manifest_name",
  "manifest_short_name",
  "manifest_description",
  "manifest_start_url",
  "manifest_display",
  "manifest_theme_color",
  "manifest_background_color",
  "install_prompt_title",
  "install_prompt_body",
  "pwa_enabled",
] as const;
