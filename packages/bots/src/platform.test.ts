import { describe, expect, it } from 'vitest';

// Мозги исполняются и на сервере, и в браузере. Настоящая проверка — npm run typecheck: появись в типах пакета
// глобал браузера или Node, директива @ts-expect-error станет лишней и сборка упадёт.
describe('пакет не знает платформы', () => {
  it('глобалы браузера и Node не видны типам пакета', () => {
    const platformGlobals = [
      // @ts-expect-error: браузера в пакете нет
      typeof window,
      // @ts-expect-error: браузера в пакете нет
      typeof document,
      // @ts-expect-error: Node в пакете нет
      typeof process,
      // @ts-expect-error: Node в пакете нет
      typeof Buffer,
      // @ts-expect-error: таймеры — платформа
      typeof setTimeout,
    ];
    expect(platformGlobals).toHaveLength(5);
  });
});
