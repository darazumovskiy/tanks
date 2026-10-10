import { execSync } from 'node:child_process';
import { defineConfig } from 'vite';

// Версия клиента для телеметрии и журнала — короткий хеш коммита: от выкладки (TANKS_BUILD), иначе из git, вне git — dev.
function appVersion(): string {
  const fromDeploy = process.env.TANKS_BUILD;
  if (fromDeploy !== undefined && fromDeploy !== '') {
    return fromDeploy;
  }
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
      '/visit': 'http://localhost:8080',
    },
  },
});
