/**
 * Minimal service worker — required for installable PWA (not just a home-screen shortcut).
 * Network-first; no aggressive caching of ERP pages.
 *
 * Version: 1.1.0 — keep in sync with lib/pwa-app-version.ts
 */

self.addEventListener("install", (event) => {
  event.waitUntil(Promise.resolve());
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  event.respondWith(fetch(event.request));
});
