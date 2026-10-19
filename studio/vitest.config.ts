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
    // The logic under test (run state, pipeline derivation, the PR watcher) is plain TypeScript.
    // Components get a DOM environment when the first component test is written.
    environment: 'node',
    include: ['test/**/*.test.ts'],
    restoreMocks: true,
    unstubEnvs: true,
  },
});
