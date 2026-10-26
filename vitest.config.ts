import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const domain = fileURLToPath(new URL('./supabase/functions/_shared/domain', import.meta.url));

export default defineConfig({
  resolve: { alias: { '@domain': domain, '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          environment: 'jsdom',
          include: ['src/**/*.test.{ts,tsx}', 'supabase/functions/**/*.test.ts'],
          setupFiles: ['./src/test/setup.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'db',
          environment: 'node',
          include: ['tests/db/**/*.test.ts'],
          globalSetup: ['./tests/db/setup.ts'],
          testTimeout: 30000,
        },
      },
    ],
  },
});
