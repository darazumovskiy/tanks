import { execSync } from 'node:child_process';
import { defineConfig } from 'vite';

// Версия клиента для телеметрии — короткий хеш коммита; вне git (архив, тесты) — dev.
function appVersion(): string {
  try {
    return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    return 'dev';
  }
}

export default defineConfig({
  define: {
    APP_VERSION: JSON.stringify(appVersion()),
  },
  server: {
    port: 5173,
    proxy: {
      '/ws': { target: 'ws://localhost:8080', ws: true },
    },
  },
});
