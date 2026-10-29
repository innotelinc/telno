import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    env: {
      // Keep test runs off the development database.
      TELNO_DB: '.data/vitest.db',
      TELNO_PROVISIONING_KEY: 'test-key-for-signature-stability',
    },
  },
});
