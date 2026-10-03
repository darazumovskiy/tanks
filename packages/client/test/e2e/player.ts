import { expect, type Browser, type BrowserContext, type Page } from '@playwright/test';

export interface Point {
  x: number;
  y: number;
}

export interface TankState extends Point {
  heading: number;
  turret: number;
  hp: number;
  isAlive: boolean;
}

// Срез `window.tanksGame.debugState()` в той части, которой пользуются сценарии.
export interface DebugState {
  side: 0 | 1;
  gameId: string;
  roundIndex: number;
  score: [number, number];
  isFighting: boolean;
  me: TankState;
  enemy: Point & { heading: number; isAlive: boolean };
  camera: { x: number; y: number; height: number };
}

const NICKNAME_KEY = 'tanks.nickname';
const STATS_KEY = 'tanks.stats';
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

// Игрок в настоящем браузере: отдельный контекст (свои cookie и localStorage), управление клавишами и мышью.
export class Player {
  private readonly held = new Set<string>();

  private constructor(
    private readonly context: BrowserContext,
    readonly page: Page,
    readonly name: string,
  ) {}

  static async open(browser: Browser, baseUrl: string, roomCode: string, name: string, stats: string): Promise<Player> {
    const context = await browser.newContext();
    await context.addInitScript(
      (entries: Record<string, string>) => {
        for (const [key, value] of Object.entries(entries)) {
          localStorage.setItem(key, value);
        }
      },
      { [NICKNAME_KEY]: name, [STATS_KEY]: stats },
    );
    const page = await context.newPage();
    await page.goto(`${baseUrl}/d/${roomCode}`);
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

  // Наводит башню мышью: точка поля → точка окна через камеру из debugState, затем ждёт, пока башня довернётся.
  async aimAt(target: Point, timeoutMs = 5_000): Promise<void> {
    const { camera } = await this.waitForBattle();
    const viewportHeight = this.page.viewportSize()?.height ?? 0;
    const scale = viewportHeight / camera.height;
    await this.page.mouse.move((target.x - camera.x) * scale, (target.y - camera.y) * scale);
    await until(
      async () => {
        const state = await this.state();
        if (state === null) {
          return null;
        }
        const wanted = Math.atan2(target.y - state.me.y, target.x - state.me.x);
        return Math.abs(normalizeAngle(wanted - state.me.turret)) < TURRET_TOLERANCE ? true : null;
      },
      timeoutMs,
      `${this.name}: башня не навелась`,
    );
  }

  async setFiring(isFiring: boolean): Promise<void> {
    if (isFiring) {
      await this.page.mouse.down();
      return;
    }
    await this.page.mouse.up();
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
