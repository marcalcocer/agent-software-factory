import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// Only in a test that has a DOM.
if (typeof window !== 'undefined') {
  afterEach(() => cleanup());

  // jsdom has no matchMedia; the app follows the operating system's colour scheme through it.
  if (!window.matchMedia) {
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })) as typeof window.matchMedia;
  }
}
