import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.test.ts', 'packages/*/test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['packages/server/src/**/*.ts', 'packages/shared/src/protocol/**/*.ts'],
      exclude: ['**/*.test.ts', 'packages/server/src/main.ts'],
      thresholds: {
        'packages/server/src/**': { statements: 90, branches: 78, functions: 90, lines: 90 },
        'packages/shared/src/protocol/**': { statements: 95, branches: 85, functions: 95, lines: 95 },
      },
    },
  },
});
