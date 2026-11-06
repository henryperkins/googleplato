// End-to-end + accessibility suite. Starts a fresh dev-sqlite server with the
// deterministic mock AI provider (server/src/lib/ai-mock.js) on its own port
// and throwaway db, serving the built client (run `npm run build` in client/
// first; CI does). See e2e/README.md.
import { defineConfig, devices } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = Number(process.env.E2E_PORT || 3490);
export const BASE_URL = `http://localhost:${PORT}`;
// Publish the unique path to workers/global setup as well. Never delete a caller's
// database, and keep paths out of the shell command (spaces/metacharacters are valid).
export const DB_PATH = process.env.E2E_DB ||= join(mkdtempSync(join(tmpdir(), 'plato-e2e-')), 'plato.db');

export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  globalSetup: './global-setup.js',
  use: {
    baseURL: BASE_URL,
    // Tailwind's animate-in classes respect reduced motion; without it axe can
    // sample a card mid-fade and report false color-contrast failures.
    reducedMotion: 'reduce',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } } },
    { name: 'mobile', use: { ...devices['Pixel 7'] }, testMatch: /a11y\.spec\.js/ },
  ],
  webServer: {
    command: 'node dev-sqlite.js',
    cwd: '../server',
    url: `${BASE_URL}/v1/health`,
    reuseExistingServer: false,
    timeout: 60_000,
    env: {
      PORT: String(PORT),
      SQLITE_PATH: DB_PATH,
      AI_PROVIDER: 'mock',
      SKIP_EMAIL: 'true',
      ADMIN_EMAIL: 'admin@plato.dev',
      ADMIN_PASSWORD: 'admin123',
      JWT_SECRET: 'e2e-secret',
    },
  },
});
