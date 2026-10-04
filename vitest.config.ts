import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'node',
          include: ['packages/{shared,server}/src/**/*.test.ts', 'packages/{shared,server}/test/**/*.test.ts'],
        },
      },
      {
        define: { APP_VERSION: '"test"' },
        test: {
          name: 'client',
          include: ['packages/client/src/**/*.test.ts'],
          environment: 'happy-dom',
        },
      },
    ],
    coverage: {
      provider: 'v8',
      include: [
        'packages/server/src/**/*.ts',
        'packages/shared/src/protocol/**/*.ts',
        'packages/client/src/steering.ts',
        'packages/client/src/touch.ts',
        'packages/client/src/input.ts',
        'packages/client/src/clientInfo.ts',
        'packages/client/src/telemetry.ts',
      ],
      exclude: ['**/*.test.ts', 'packages/server/src/main.ts'],
      thresholds: {
        'packages/server/src/**': { statements: 100, branches: 100, functions: 100, lines: 100 },
        'packages/shared/src/protocol/**': { statements: 95, branches: 85, functions: 95, lines: 95 },
        'packages/client/src/{steering,touch,input,clientInfo,telemetry}.ts': {
          statements: 95,
          branches: 90,
          functions: 95,
          lines: 95,
        },
      },
    },
  },
});
