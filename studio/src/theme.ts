export type ThemeSetting = 'light' | 'dark' | 'system';

const DARK_QUERY = '(prefers-color-scheme: dark)';

export function systemPrefersDark(): boolean {
  return typeof window !== 'undefined' && window.matchMedia(DARK_QUERY).matches;
}

/** Apply a theme setting by toggling the `dark` class on the document root. */
export function applyTheme(theme: ThemeSetting, prefersDark = systemPrefersDark()): void {
  const isDark = theme === 'dark' || (theme === 'system' && prefersDark);
  const root = document.documentElement;
  root.classList.toggle('dark', isDark);
  root.style.colorScheme = isDark ? 'dark' : 'light';
}

/** Subscribe to OS light/dark changes. Returns an unsubscribe function. */
export function watchSystemTheme(onChange: (prefersDark: boolean) => void): () => void {
  if (typeof window === 'undefined') return () => {};
  const media = window.matchMedia(DARK_QUERY);
  const handler = (event: MediaQueryListEvent) => onChange(event.matches);
  media.addEventListener('change', handler);
  return () => media.removeEventListener('change', handler);
}
