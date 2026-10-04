import { expect, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test';

export interface Point {
  x: number;
  y: number;
}

export interface TankState extends Point {
  heading: number;
  turret: number;
  speed: number;
  hp: number;
  isAlive: boolean;
}

// Срез `window.tanksGame.debugState()` в той части, которой пользуются сценарии.
export interface DebugState {
  side: 0 | 1;
  gameId: string;
  roundIndex: number;
  score: [number, number];
  rules: { wallSlidePercent: number };
  nicknames: [string, string];
  isFighting: boolean;
  isAutoFiring: boolean;
  isAutoAiming: boolean;
  isShotGuarded: boolean;
  isZoneFiring: boolean;
  isReversing: boolean;
  aimLine: { state: 'none' | 'onTarget' | 'lead'; isReturning: boolean } | null;
  aimLineStyle: string;
  me: TankState;
  enemy: Point & { heading: number; isAlive: boolean };
  bullets: number;
  correctionPx: number;
  camera: { x: number; y: number; height: number };
}

const NICKNAME_KEY = 'tanks.nickname';
const STATS_KEY = 'tanks.stats';
const SETTINGS_KEY = 'tanks.settings';
const AUTOFIRE_BUTTON = '#autofire';
const CREATE_BOT_BUTTON = '#create-bot';
const BOT_LEVEL_TOGGLE = '#bot-level-toggle';
const MENU_BUTTON = '#menu';
const ROUND_END_TITLE = '#round-end .round-end-title';
const ROUND_END_MENU = '#round-end .round-end-menu';
const SETTINGS_PANEL = '#settings';
const SETTINGS_CHECK_LABEL = '#settings label.settings-check .settings-head span';
const STYLE_TOGGLE = '#settings .style-toggle';
const styleOptionSelector = (id: string): string => `#settings .style-option[data-style="${id}"]`;
const SETTINGS_KEY_CODE = 'KeyO';
const levelCardSelector = (level: number): string => `#bot-levels .level[data-level="${String(level)}"]`;
const COPY_BUTTON = '#overlay .overlay-copy';
const OPEN_APP_BANNER = '#open-app';
const OPEN_APP_LINK = '#open-app-link';
const OPEN_APP_CLOSE = '#open-app-close';
// Экран телефона в альбомной ориентации; с эмуляцией касания клиент видит `pointer: coarse` и показывает кнопки.
const PHONE_VIEWPORT = { width: 844, height: 390 };
const POLL_MS = 50;
const HULL_TURN_TOLERANCE = 0.12;
const HULL_DRIVE_TOLERANCE = 0.3;
const TURRET_TOLERANCE = 0.05;
const KEY_FORWARD = 'KeyW';
const KEY_LEFT = 'KeyA';
const KEY_RIGHT = 'KeyD';

export function normalizeAngle(angle: number): number {
  return ((((angle + Math.PI) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) - Math.PI;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Ждёт, пока чтение не вернёт значение; null и undefined — «ещё нет».
export async function until<T>(read: () => Promise<T | null | undefined>, timeoutMs: number, what: string): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== null && value !== undefined) {
      return value;
    }
    await sleep(POLL_MS);
  }
  throw new Error(`не дождались: ${what}`);
}

// Игрок в настоящем браузере: отдельный контекст (свои cookie и localStorage), управление клавишами и мышью;
// с `isTouch` — экран телефона с эмуляцией касаний; `settings` — часть `tanks.settings`, записанная до загрузки;
// `query` — строка запроса ссылки на дуэль (например, `?admin=1`).
export class Player {
  private readonly held = new Set<string>();

  private constructor(
    private readonly context: BrowserContext,
    readonly page: Page,
    readonly name: string,
  ) {}

  static async open(
    browser: Browser,
    baseUrl: string,
    roomCode: string,
    name: string,
    stats: string,
    options: { isTouch?: boolean; userAgent?: string; settings?: Record<string, unknown>; query?: string } = {},
  ): Promise<Player> {
    const touchOptions = options.isTouch === true ? { hasTouch: true, isMobile: true, viewport: PHONE_VIEWPORT } : {};
    const agentOptions = options.userAgent === undefined ? {} : { userAgent: options.userAgent };
    const context = await browser.newContext({ ...touchOptions, ...agentOptions });
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    const entries: Record<string, string> = { [NICKNAME_KEY]: name, [STATS_KEY]: stats };
    if (options.settings !== undefined) {
      entries[SETTINGS_KEY] = JSON.stringify(options.settings);
    }
    await context.addInitScript((stored: Record<string, string>) => {
      for (const [key, value] of Object.entries(stored)) {
        localStorage.setItem(key, value);
      }
    }, entries);
    const page = await context.newPage();
    await page.goto(`${baseUrl}/d/${roomCode}${options.query ?? ''}`);
    return new Player(context, page, name);
  }

  // Игрок заходит с главной: выбирает уровень бота и жмёт «Против бота».
  static async openAgainstBot(browser: Browser, baseUrl: string, name: string, botLevel: number): Promise<Player> {
    const context = await browser.newContext();
    await context.addInitScript(
      (entries: Record<string, string>) => {
        for (const [key, value] of Object.entries(entries)) {
          localStorage.setItem(key, value);
        }
      },
      { [NICKNAME_KEY]: name },
    );
    const page = await context.newPage();
    await page.goto(`${baseUrl}/`);
    await page.locator(BOT_LEVEL_TOGGLE).click();
    await page.locator(levelCardSelector(botLevel)).click();
    await page.locator(CREATE_BOT_BUTTON).click();
    return new Player(context, page, name);
  }

  async close(): Promise<void> {
    await this.context.close();
  }

  state(): Promise<DebugState | null> {
    return this.page.evaluate(() => {
      const game = (window as unknown as { tanksGame?: { debugState(): unknown } }).tanksGame;
      return (game?.debugState() ?? null) as DebugState | null;
    });
  }

  waitForBattle(timeoutMs = 15_000): Promise<DebugState> {
    return until(() => this.state(), timeoutMs, `${this.name}: бой не начался`);
  }

  async waitForFight(timeoutMs = 15_000): Promise<DebugState> {
    return until(
      async () => {
        const state = await this.state();
        return state?.isFighting === true ? state : null;
      },
      timeoutMs,
      `${this.name}: отсчёт не закончился`,
    );
  }

  async waitForRound(roundIndex: number, timeoutMs: number): Promise<DebugState> {
    return until(
      async () => {
        const state = await this.state();
        return state?.roundIndex === roundIndex ? state : null;
      },
      timeoutMs,
      `${this.name}: раунд ${String(roundIndex)} не начался`,
    );
  }

  async expectOverlay(text: string, timeoutMs = 15_000): Promise<void> {
    await expect(this.page.locator('#overlay')).toContainText(text, { timeout: timeoutMs });
  }

  async expectNoBattle(): Promise<void> {
    expect(await this.state()).toBeNull();
  }

  copyButton(): Locator {
    return this.page.locator(COPY_BUTTON);
  }

  roundEndTitle(): Locator {
    return this.page.locator(ROUND_END_TITLE);
  }

  roundEndMenuHref(): Promise<string | null> {
    return this.page.locator(ROUND_END_MENU).getAttribute('href');
  }

  async clickMenu(): Promise<void> {
    await this.page.locator(MENU_BUTTON).click();
  }

  // Открывает панель настроек клавишей и возвращает подписи флажков.
  async settingsCheckLabels(): Promise<string[]> {
    await this.openSettings();
    return this.page.locator(SETTINGS_CHECK_LABEL).allTextContents();
  }

  async openSettings(): Promise<void> {
    await this.page.keyboard.press(SETTINGS_KEY_CODE);
    await expect(this.page.locator(SETTINGS_PANEL)).toBeVisible();
  }

  // Выбирает вид прицела в выпадающем списке панели настроек (панель должна быть открыта).
  async pickAimLineStyle(id: string): Promise<void> {
    await this.page.locator(STYLE_TOGGLE).click();
    await this.page.locator(styleOptionSelector(id)).click();
  }

  aimLineStyleToggleText(): Promise<string> {
    return this.page.locator(`${STYLE_TOGGLE} .style-name`).innerText();
  }

  clipboardText(): Promise<string> {
    return this.page.evaluate(() => navigator.clipboard.readText());
  }

  openAppBanner(): Locator {
    return this.page.locator(OPEN_APP_BANNER);
  }

  openAppHref(): Promise<string | null> {
    return this.page.locator(OPEN_APP_LINK).getAttribute('href');
  }

  async closeOpenAppBanner(): Promise<void> {
    await this.page.locator(OPEN_APP_CLOSE).click();
  }

  // Едет вперёд заданное время и возвращает, на сколько сдвинулся танк.
  async driveForward(ms: number): Promise<number> {
    const before = await this.waitForFight();
    await this.setKey(KEY_FORWARD, true);
    await sleep(ms);
    await this.setKey(KEY_FORWARD, false);
    const after = await this.waitForBattle();
    return Math.hypot(after.me.x - before.me.x, after.me.y - before.me.y);
  }

  // Ведёт танк к точке как человек: доворот корпуса клавишами, газ — когда курс сошёлся.
  async driveTo(target: Point, arriveDistance: number, timeoutMs = 30_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const { me } = await this.waitForBattle();
      const dx = target.x - me.x;
      const dy = target.y - me.y;
      if (Math.hypot(dx, dy) <= arriveDistance) {
        await this.releaseAll();
        return;
      }
      const diff = normalizeAngle(Math.atan2(dy, dx) - me.heading);
      await this.setKey(KEY_RIGHT, diff > HULL_TURN_TOLERANCE);
      await this.setKey(KEY_LEFT, diff < -HULL_TURN_TOLERANCE);
      await this.setKey(KEY_FORWARD, Math.abs(diff) < HULL_DRIVE_TOLERANCE);
      await sleep(POLL_MS);
    }
    await this.releaseAll();
    throw new Error(`${this.name}: не доехал до (${String(target.x)}, ${String(target.y)})`);
  }

  // Доворачивает корпус на курс клавишами и даёт газ; газ держится до `releaseAll`.
  async driveOnHeading(heading: number, timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const { me } = await this.waitForBattle();
      const diff = normalizeAngle(heading - me.heading);
      if (Math.abs(diff) <= HULL_TURN_TOLERANCE) {
        await this.releaseAll();
        await this.setKey(KEY_FORWARD, true);
        return;
      }
      await this.setKey(KEY_RIGHT, diff > 0);
      await this.setKey(KEY_LEFT, diff < 0);
      await sleep(POLL_MS);
    }
    await this.releaseAll();
    throw new Error(`${this.name}: не довернул на курс ${heading.toFixed(2)}`);
  }

  // Наводит башню мышью: точка поля → точка окна через камеру из debugState, затем ждёт, пока башня довернётся.
  async aimAt(target: Point, timeoutMs = 5_000): Promise<void> {
    const { camera } = await this.waitForBattle();
    const viewportHeight = this.page.viewportSize()?.height ?? 0;
    const scale = viewportHeight / camera.height;
    await this.page.mouse.move((target.x - camera.x) * scale, (target.y - camera.y) * scale);
    await this.waitForTurretAt(target, timeoutMs, 'башня не навелась');
  }

  async setFiring(isFiring: boolean): Promise<void> {
    if (isFiring) {
      await this.page.mouse.down();
      return;
    }
    await this.page.mouse.up();
  }

  // Как с клавиатуры кнопки нет, авто-огонь включается через точку доступа игры.
  async toggleAutoFire(): Promise<boolean> {
    return this.page.evaluate(() => {
      const game = (window as unknown as { tanksGame: { toggleAutoFire(): boolean } }).tanksGame;
      return game.toggleAutoFire();
    });
  }

  async tapAutoFire(): Promise<boolean> {
    await this.page.tap(AUTOFIRE_BUTTON);
    return (await this.waitForBattle()).isAutoFiring;
  }

  isAutoFireButtonVisible(): Promise<boolean> {
    return this.page.locator(AUTOFIRE_BUTTON).isVisible();
  }

  // Настоящее касание через протокол отладки: палец ложится в `from`, тянется в `to` и остаётся там, пока не
  // вызван `release`; Playwright сам умеет только тап.
  async touchDrag(from: Point, to: Point): Promise<{ release: () => Promise<void> }> {
    const touch = await this.touchBegin(from);
    await touch.move(to);
    return touch;
  }

  // Палец ложится в точку и дальше ведётся вызовами `move`, пока не вызван `release`.
  async touchBegin(at: Point): Promise<{ move: (to: Point) => Promise<void>; release: () => Promise<void> }> {
    const session = await this.context.newCDPSession(this.page);
    await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [at] });
    return {
      move: async (to: Point): Promise<void> => {
        await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [to] });
      },
      release: async (): Promise<void> => {
        await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        await session.detach();
      },
    };
  }

  // Ждёт, пока корпус не встанет на курс с допуском; `onSample` зовётся на каждой выборке.
  waitForHeading(
    heading: number,
    timeoutMs: number,
    what: string,
    onSample: (state: DebugState) => void = (): void => undefined,
  ): Promise<DebugState> {
    return until(
      async () => {
        const state = await this.state();
        if (state === null) {
          return null;
        }
        onSample(state);
        return Math.abs(normalizeAngle(heading - state.me.heading)) < HULL_TURN_TOLERANCE ? state : null;
      },
      timeoutMs,
      `${this.name}: ${what}`,
    );
  }

  // Ждёт, пока башня не смотрит на точку с допуском, и возвращает состояние в этот момент.
  waitForTurretAt(target: Point, timeoutMs: number, what: string): Promise<DebugState> {
    return this.waitForTurret((me) => Math.atan2(target.y - me.y, target.x - me.x), timeoutMs, what);
  }

  waitForTurretAngle(angle: number, timeoutMs: number, what: string): Promise<DebugState> {
    return this.waitForTurret(() => angle, timeoutMs, what);
  }

  private waitForTurret(wanted: (me: TankState) => number, timeoutMs: number, what: string): Promise<DebugState> {
    return until(
      async () => {
        const state = await this.state();
        if (state === null) {
          return null;
        }
        return Math.abs(normalizeAngle(wanted(state.me) - state.me.turret)) < TURRET_TOLERANCE ? state : null;
      },
      timeoutMs,
      `${this.name}: ${what}`,
    );
  }

  async releaseAll(): Promise<void> {
    for (const code of [...this.held]) {
      await this.setKey(code, false);
    }
  }

  private async setKey(code: string, isDown: boolean): Promise<void> {
    if (this.held.has(code) === isDown) {
      return;
    }
    if (isDown) {
      this.held.add(code);
      await this.page.keyboard.down(code);
      return;
    }
    this.held.delete(code);
    await this.page.keyboard.up(code);
  }
}
