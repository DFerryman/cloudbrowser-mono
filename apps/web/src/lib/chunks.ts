const RELOAD_KEY = 'nevazu.chunk-reload';
/** One reload per failure; a second failure this soon after is shown instead, so a broken deployment cannot loop. */
const RELOAD_WINDOW_MS = 30_000;

/**
 * A lazily loaded page is gone: after a deployment the hashed files an already open page refers
 * to no longer exist, and the Worker answers with index.html or 404 in their place.
 */
export function isChunkLoadError(error: unknown): boolean {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : typeof error === 'string' ? error : '';
  return /dynamically imported module|Importing a module script failed|preload CSS|Loading (CSS )?chunk|module script failed|MIME type/i.test(message);
}

/**
 * Reloads the page once when a part of it fails to load after a deployment (Vite reports the
 * failed import or stylesheet as vite:preloadError): the reload fetches the current index.html
 * and with it the current files, landing on the page that was being opened rather than the one
 * left behind. The failure still reaches react-router, whose RouteError shows for the moment the
 * reload takes, and stays with a Reload button when the files are still missing afterwards.
 */
export function recoverStaleChunks(pendingLocation: () => string | null) {
  window.addEventListener('vite:preloadError', () => {
    let last = 0;
    try {
      last = Number(sessionStorage.getItem(RELOAD_KEY)) || 0;
    } catch { /* No storage: reload once per page load at most. */ }
    if (Date.now() - last < RELOAD_WINDOW_MS) return;
    try {
      sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
    } catch { /* Not remembered. */ }
    const target = pendingLocation();
    if (target) window.location.assign(target);
    else window.location.reload();
  });
}
