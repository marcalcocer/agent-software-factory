/**
 * Sends links that leave the app to the operating system's browser.
 *
 * Without this, a link such as the pull-request URL in the Delivery report opened in a second
 * Electron window: a bare browser with none of the user's sessions, so GitHub asked them to log
 * in again. Routing it through the OS (`xdg-open` on Linux, so whatever is set as the default
 * browser - Brave, here) opens it where the user is already signed in.
 *
 * Only the *decision* lives here; the caller supplies `openExternal` (Electron's
 * `shell.openExternal`), which keeps this testable without Electron.
 */
import type { WebContents } from 'electron';

/**
 * Schemes that may be handed to the OS. Anything else (`file:`, `javascript:`, custom protocol
 * handlers) is refused: a link in rendered content must never be able to launch arbitrary
 * programs or read local files.
 */
const OPENABLE_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);

/** Returns the URL when it is safe to hand to the OS, otherwise `null`. */
export function parseOpenableUrl(raw: string): URL | null {
  try {
    const url = new URL(raw);
    return OPENABLE_PROTOCOLS.has(url.protocol) ? url : null;
  } catch {
    return null;
  }
}

/**
 * Is `url` one of the app's own pages? Those must keep navigating inside the window - the Vite
 * dev server reloads itself, and a packaged build loads `file:` pages. Everything else leaves.
 *
 * @param appUrl the dev-server URL in development, `undefined` for a packaged build.
 */
export function isInternalNavigation(url: string, appUrl: string | undefined): boolean {
  try {
    const target = new URL(url);
    if (target.protocol === 'file:') return true;
    if (appUrl) return target.origin === new URL(appUrl).origin;
    return false;
  } catch {
    // Not a parseable URL: let the renderer deal with it rather than guess.
    return true;
  }
}

/**
 * Makes a window open external links in the OS browser instead of in Electron.
 *
 * - `window.open(...)` and `<a target="_blank">` never create an in-app window.
 * - A plain `<a href="https://...">` is stopped from navigating the app away and opened outside.
 */
export function installExternalLinkHandlers(
  webContents: WebContents,
  appUrl: string | undefined,
  openExternal: (url: string) => unknown,
): void {
  const open = (raw: string): void => {
    const url = parseOpenableUrl(raw);
    if (!url) {
      console.warn('[external-links] refused to open a non-web link:', raw);
      return;
    }
    // `shell.openExternal` returns a promise; a missing handler must not become an unhandled rejection.
    Promise.resolve(openExternal(url.toString())).catch((error: unknown) => {
      console.error('[external-links] could not open', url.toString(), error);
    });
  };

  webContents.setWindowOpenHandler(({ url }) => {
    open(url);
    return { action: 'deny' };
  });

  webContents.on('will-navigate', (event, url) => {
    if (isInternalNavigation(url, appUrl)) return;
    event.preventDefault();
    open(url);
  });
}
