import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@shared': path.resolve(__dirname, './shared'),
    },
  },
  test: {
    // The logic under test (run state, pipeline derivation, the PR watcher) is plain TypeScript and runs
    // in Node. A test of a screen says so in its first line - `// @vitest-environment jsdom` - and the
    // rest are not slowed down by a DOM.
    environment: 'node',
    include: ['test/**/*.test.{ts,tsx}'],
    setupFiles: ['test/setup.ts'],
    restoreMocks: true,
    unstubEnvs: true,
  },
});
