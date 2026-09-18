import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Tests touch the file-backed store; keep them off the showcase data.
    // MONGODB_URI must be blanked, not just omitted: config.ts loads .env via dotenv,
    // which would otherwise select the Mongo driver and the suite's resets would wipe
    // the shared POC database. dotenv never overwrites a key that is already set.
    // The rest pin behaviour a developer's .env could otherwise change: tests stay
    // offline (no KULT API) and see the default auth and category settings.
    env: {
      DATA_DIR: './data-test', INTELLIGENCE_PROVIDER: 'demo', MONGODB_URI: '',
      KULT_API_BASE: '', AUTH_MODE: 'off', ADMIN_TOKEN: '', NEWS_CATEGORY_IDS: '',
    },
    // The store is a single shared file, so parallel files would race on it.
    fileParallelism: false,
  },
});
