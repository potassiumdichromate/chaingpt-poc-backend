import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Tests touch the file-backed store; keep them off the showcase data.
    env: { DATA_DIR: './data-test', INTELLIGENCE_PROVIDER: 'demo' },
    // The store is a single shared file, so parallel files would race on it.
    fileParallelism: false,
  },
});
