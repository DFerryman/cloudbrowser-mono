/** Configure an exact host (including the port) to serve the console in local development. */
export const ADMIN_URL = new URL(import.meta.env.VITE_ADMIN_URL || 'https://admin.console.nevazu.com');
export const APP_URL = 'https://nevazu.com';
/** A full-page visit lets Access handle authentication for the protected application. */
export const ACCESS_LOGIN_URL = ADMIN_URL.href;
export const ACCESS_LOGOUT_URL = '/cdn-cgi/access/logout';

export function isAdminHost(location: Pick<Location, 'host'> = window.location): boolean {
  return location.host === ADMIN_URL.host;
}

/** Old links can include /admin/console; the dedicated host serves the console at its root. */
export function adminRedirectUrl(location: Pick<Location, 'pathname' | 'search' | 'hash'>): string {
  const path = location.pathname.replace(/^\/admin(?:\/console)?(?=\/|$)/, '') || '/';
  const target = new URL(ADMIN_URL.origin);
  target.pathname = path;
  target.search = location.search;
  target.hash = location.hash;
  return target.href;
}
