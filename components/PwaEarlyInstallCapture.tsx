/**
 * Synchronous inline script — must run before React hydration so we never miss
 * Chrome/Edge `beforeinstallprompt` (fires as soon as installability criteria pass).
 */
export function PwaEarlyInstallCapture() {
  const script = `
(function () {
  if (window.__mxPwaEarlyCapture) return;
  window.__mxPwaEarlyCapture = true;
  function stash(e) {
    e.preventDefault();
    window.__mxDeferredInstallPrompt = e;
    window.dispatchEvent(new Event("mx-pwa-install-ready"));
  }
  window.addEventListener("beforeinstallprompt", stash);
  window.addEventListener("appinstalled", function () {
    window.__mxDeferredInstallPrompt = null;
    window.dispatchEvent(new Event("mx-pwa-install-ready"));
  });
})();
`.trim();

  return <script dangerouslySetInnerHTML={{ __html: script }} />;
}
