import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'node',
          include: ['packages/{shared,server,analysis}/src/**/*.test.ts', 'packages/{shared,server}/test/**/*.test.ts'],
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
        'packages/shared/src/engine/{trajectory,lead,ffa,ffaMaps,spawn,random}.ts',
        'packages/client/src/steering.ts',
        'packages/client/src/flick.ts',
        'packages/client/src/touch.ts',
        'packages/client/src/input.ts',
        'packages/client/src/aimLine.ts',
        'packages/client/src/zoneFire.ts',
        'packages/client/src/admin.ts',
        'packages/client/src/render/aimLineStyle.ts',
        'packages/client/src/render/fxEvent.ts',
        'packages/client/src/duelPresenter.ts',
        'packages/client/src/fxLab/{scenes,styleParams,paramPanel,contactSheet}.ts',
        'packages/client/src/clientInfo.ts',
        'packages/client/src/telemetry.ts',
        'packages/analysis/src/**/*.ts',
      ],
      exclude: [
        '**/*.test.ts',
        'packages/server/src/main.ts',
        'packages/server/src/swarm/main.ts',
        'packages/analysis/src/main.ts',
        'packages/analysis/src/logFixture.ts',
      ],
      thresholds: {
        'packages/server/src/**': { statements: 100, branches: 100, functions: 100, lines: 100 },
        'packages/analysis/src/**': { statements: 90, branches: 90, functions: 90, lines: 90 },
        'packages/shared/src/protocol/**': { statements: 95, branches: 85, functions: 95, lines: 95 },
        'packages/shared/src/engine/{trajectory,lead,ffa,ffaMaps,spawn,random}.ts': {
          statements: 95,
          branches: 90,
          functions: 95,
          lines: 95,
        },
        'packages/client/src/{steering,flick,touch,input,clientInfo,telemetry,aimLine,zoneFire,admin}.ts': {
          statements: 95,
          branches: 90,
          functions: 95,
          lines: 95,
        },
        'packages/client/src/{render/fxEvent,duelPresenter}.ts': {
          statements: 95,
          branches: 90,
          functions: 95,
          lines: 95,
        },
        'packages/client/src/{render/aimLineStyle,fxLab/scenes,fxLab/styleParams,fxLab/paramPanel,fxLab/contactSheet}.ts':
          {
            statements: 90,
            branches: 85,
            functions: 90,
            lines: 90,
          },
      },
    },
  },
});
