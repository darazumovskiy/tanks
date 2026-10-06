import { EventFlag, type TankSnapshot } from '@tanks/shared/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DecalLayer } from './decals.js';
import { Effects, type FxAnnouncement, type FxEvent, type FxEventOptions } from './effects.js';

const COLORS: Readonly<Record<number, string>> = { 3: '#4fc3c9', 7: '#e8825a' };
const NAMES: Readonly<Record<number, string>> = { 3: 'Вася', 7: 'Петя' };
const QUIET: FxEventOptions = { shake: 0, flash: 0, announcement: null, hasParticles: true };
const FIRST_BLOOD: FxAnnouncement = { kind: 'firstBlood', size: 1, duration: 1 };
const SELF_HIT: FxAnnouncement = { kind: 'selfHit', size: 1, duration: 1 };
const ZONE_START: FxAnnouncement = { kind: 'zoneStart', size: 1, duration: 1 };
const ANNOUNCE_WIDTH = 1000;
const ANNOUNCE_Y = 200;

class FakeDecals implements DecalLayer {
  readonly calls: string[] = [];

  clear(): void {
    this.calls.push('clear');
  }

  tread(x: number, y: number, heading: number): void {
    this.calls.push(`tread ${String(x)} ${String(y)} ${String(heading)}`);
  }

  scorch(x: number, y: number, radius: number, alpha: number): void {
    this.calls.push(`scorch ${String(x)} ${String(y)} ${String(radius)} ${String(alpha)}`);
  }

  fade(): void {
    this.calls.push('fade');
  }

  draw(): void {
    this.calls.push('draw');
  }
}

interface DrawnText {
  text: string;
  fillStyle: string;
}

// Холст, который запоминает только надписи, их цвет и шрифт; остальные вызовы рисования ничего не делают.
function recordingContext(): { ctx: CanvasRenderingContext2D; texts: DrawnText[]; fonts: string[] } {
  const texts: DrawnText[] = [];
  const fonts: string[] = [];
  const state: Record<string | symbol, unknown> = {};
  const handler: ProxyHandler<Record<string | symbol, unknown>> = {
    get: (target, key) => {
      if (key === 'fillText') {
        return (text: string): void => {
          const { fillStyle, font } = target;
          texts.push({ text, fillStyle: typeof fillStyle === 'string' ? fillStyle : '' });
          fonts.push(typeof font === 'string' ? font : '');
        };
      }
      if (key in target) {
        return target[key];
      }
      return (): void => undefined;
    },
    set: (target, key, value) => {
      target[key] = value;
      return true;
    },
  };
  return { ctx: new Proxy(state, handler) as unknown as CanvasRenderingContext2D, texts, fonts };
}

function makeEffects(decals: DecalLayer = new FakeDecals()): Effects {
  return new Effects(
    decals,
    (id) => COLORS[id] ?? '#ffffff',
    (id) => NAMES[id] ?? '',
  );
}

function fxEvent(kind: FxEvent['kind'], overrides: Partial<FxEvent> = {}): FxEvent {
  return { kind, tank: 7, by: null, x: 400, y: 300, value: 28, dx: 1, dy: 0, flags: 0, ...overrides };
}

function announcementTexts(effects: Effects): DrawnText[] {
  const { ctx, texts } = recordingContext();
  effects.drawAnnouncements(ctx, ANNOUNCE_WIDTH, ANNOUNCE_Y);
  return texts;
}

function popupTexts(effects: Effects): DrawnText[] {
  const { ctx, texts } = recordingContext();
  effects.drawPopups(ctx);
  return texts;
}

function snapshotTank(overrides: Partial<TankSnapshot> = {}): TankSnapshot {
  return { x: 500, y: 400, heading: 0.5, turret: 0, speed: 120, hp: 100, reloadLeft: 0, isAlive: true, ...overrides };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('эффекты без своего холста', () => {
  it('создаются, принимают события и шагают в happy-dom, не создавая холста', () => {
    const createElement = vi.spyOn(document, 'createElement');
    const effects = makeEffects();
    effects.onEvent(fxEvent('death'), QUIET);
    effects.onEvent(fxEvent('impact'), QUIET);
    effects.update(0.016, [{ id: 7, x: 400, y: 300, hp: 0, maxHp: 140, isAlive: false }]);
    expect(createElement).not.toHaveBeenCalled();
  });
});

describe('тряска, вспышка и объявление — ровно из параметров onEvent', () => {
  it('гибель и начало зоны без параметров не трясут, не вспыхивают и не объявляют', () => {
    const effects = makeEffects();
    effects.onEvent(fxEvent('death'), QUIET);
    effects.onEvent(fxEvent('zoneStart', { tank: null }), QUIET);
    effects.onEvent(fxEvent('hit', { by: 3, flags: EventFlag.Self }), QUIET);
    expect(effects.shake).toBe(0);
    expect(effects.flashScreen).toBe(0);
    expect(announcementTexts(effects)).toEqual([]);
  });

  it('сила тряски и вспышка — из параметров, сильнее текущих', () => {
    const effects = makeEffects();
    effects.onEvent(fxEvent('shot'), { shake: 4, flash: 0.3, announcement: null, hasParticles: true });
    expect(effects.shake).toBe(4);
    expect(effects.flashScreen).toBe(0.3);
    effects.onEvent(fxEvent('fizzle'), { shake: 2, flash: 0.1, announcement: null, hasParticles: true });
    expect(effects.shake).toBe(4);
    expect(effects.flashScreen).toBe(0.3);
    effects.onEvent(fxEvent('bump'), { shake: 11, flash: 0.5, announcement: null, hasParticles: true });
    expect(effects.shake).toBe(11);
    expect(effects.flashScreen).toBe(0.5);
  });

  it('«ПЕРВАЯ КРОВЬ» — цветом и именем стрелка, кем бы ни был событийный танк', () => {
    const effects = makeEffects();
    effects.onEvent(fxEvent('death', { tank: 3, by: 7 }), { ...QUIET, announcement: FIRST_BLOOD });
    expect(announcementTexts(effects)).toEqual([
      { text: 'ПЕРВАЯ КРОВЬ', fillStyle: COLORS[7] },
      { text: 'Петя', fillStyle: 'rgba(255,255,255,0.8)' },
    ]);
  });

  it('«САМ СЕБЯ!» — цветом того, кто попал в себя; «ЗОНА СУЖАЕТСЯ» — своим цветом', () => {
    const effects = makeEffects();
    effects.onEvent(fxEvent('hit', { tank: 3, by: 3 }), { ...QUIET, announcement: SELF_HIT });
    expect(announcementTexts(effects)[0]).toEqual({ text: 'САМ СЕБЯ!', fillStyle: COLORS[3] });
    effects.onEvent(fxEvent('zoneStart', { tank: null }), { ...QUIET, announcement: ZONE_START });
    expect(announcementTexts(effects).map((drawn) => drawn.text)).toEqual(['ЗОНА СУЖАЕТСЯ', 'вне круга — урон']);
  });

  it('P3 длительность и размер объявления — доли базового: 0,5 гаснет за 0,9 с, 1 живёт 1,8 с; размер 1/1,5 — шрифт меньше', () => {
    const short = makeEffects();
    short.onEvent(fxEvent('death', { tank: 3, by: 7 }), { ...QUIET, announcement: { ...FIRST_BLOOD, duration: 0.5 } });
    short.update(0.85, []);
    expect(announcementTexts(short)).not.toEqual([]);
    short.update(0.1, []);
    expect(announcementTexts(short)).toEqual([]);

    const base = makeEffects();
    base.onEvent(fxEvent('death', { tank: 3, by: 7 }), { ...QUIET, announcement: FIRST_BLOOD });
    base.update(1.75, []);
    expect(announcementTexts(base)).not.toEqual([]);
    base.update(0.1, []);
    expect(announcementTexts(base)).toEqual([]);

    const fontsOf = (announcement: FxAnnouncement): string[] => {
      const effects = makeEffects();
      effects.onEvent(fxEvent('hit', { tank: 3, by: 3 }), { ...QUIET, announcement });
      effects.update(0.5, []);
      const { ctx, fonts } = recordingContext();
      effects.drawAnnouncements(ctx, ANNOUNCE_WIDTH, ANNOUNCE_Y);
      return fonts;
    };
    expect(fontsOf(SELF_HIT)).toEqual([expect.stringMatching(/^56px /), expect.stringMatching(/^600 20px /)]);
    expect(fontsOf({ ...SELF_HIT, size: 1 / 1.5 })).toEqual([
      expect.stringMatching(/^37px /),
      expect.stringMatching(/^600 13px /),
    ]);
  });

  it('без частиц: объявление, тряска и вспышка есть, а на месте события — ни подпалины, ни цифры, ни отдачи', () => {
    const decals = new FakeDecals();
    const effects = makeEffects(decals);
    effects.onEvent(fxEvent('death', { tank: 3, by: 7 }), {
      shake: 5,
      flash: 0.2,
      announcement: FIRST_BLOOD,
      hasParticles: false,
    });
    effects.onEvent(fxEvent('shot', { tank: 7 }), { ...QUIET, hasParticles: false });
    effects.onEvent(fxEvent('hit', { tank: 3, by: 7 }), { ...QUIET, hasParticles: false });
    expect(announcementTexts(effects).map((drawn) => drawn.text)).toEqual(['ПЕРВАЯ КРОВЬ', 'Петя']);
    expect(effects.shake).toBe(5);
    expect(effects.flashScreen).toBe(0.2);
    expect(decals.calls).toEqual([]);
    expect(popupTexts(effects)).toEqual([]);
    expect(effects.tankFx(7).recoil).toBe(0);
    expect(effects.tankFx(3).flash).toBe(0);
  });

  it('объявление без нужного танка не показывается', () => {
    const effects = makeEffects();
    effects.onEvent(fxEvent('hit', { tank: null }), { ...QUIET, announcement: SELF_HIT });
    effects.onEvent(fxEvent('hit', { by: null }), { ...QUIET, announcement: FIRST_BLOOD });
    expect(announcementTexts(effects)).toEqual([]);
  });
});

describe('эффекты по номерам танков', () => {
  it('отдача и вспышка — у танка с номером события, остальные не тронуты', () => {
    const effects = makeEffects();
    effects.onEvent(fxEvent('shot', { tank: 7 }), QUIET);
    effects.onEvent(fxEvent('hit', { tank: 42, by: 7 }), QUIET);
    expect(effects.tankFx(7)).toMatchObject({ recoil: 1, flash: 0 });
    expect(effects.tankFx(42)).toMatchObject({ recoil: 0, flash: 1 });
    expect(effects.tankFx(3)).toMatchObject({ recoil: 0, flash: 0, ghostHp: null });
    effects.update(0.1, [{ id: 42, x: 0, y: 0, hp: 80, maxHp: 140, isAlive: true }]);
    expect(effects.tankFx(42).flash).toBeCloseTo(0.3);
    expect(effects.tankFx(42).ghostHp).toBe(80);
    expect(effects.tankFx(7).recoil).toBe(1);
  });

  it('«РИКОШЕТ!» над попаданием — цветом стрелка; свой рикошет — без этой надписи', () => {
    const effects = makeEffects();
    effects.onEvent(fxEvent('hit', { tank: 7, by: 3, flags: EventFlag.Ricochet }), QUIET);
    expect(popupTexts(effects)).toContainEqual({ text: 'РИКОШЕТ!', fillStyle: COLORS[3] });
    const selfEffects = makeEffects();
    selfEffects.onEvent(fxEvent('hit', { tank: 7, by: 7, flags: EventFlag.Self | EventFlag.Ricochet }), QUIET);
    expect(popupTexts(selfEffects).map((drawn) => drawn.text)).toEqual(['-28']);
  });

  it('урон зоной подсвечивает танк вполсилы и не пишет цифру', () => {
    const effects = makeEffects();
    effects.onEvent(fxEvent('hit', { tank: 7, flags: EventFlag.Zone }), QUIET);
    expect(effects.tankFx(7).flash).toBe(0.25);
    expect(popupTexts(effects)).toEqual([]);
  });

  it('сброс забывает эффекты танков', () => {
    const effects = makeEffects();
    effects.onEvent(fxEvent('shot', { tank: 7 }), QUIET);
    effects.reset();
    expect(effects.tankFx(7).recoil).toBe(0);
  });
});

describe('слой следов снаружи', () => {
  it('следы — на чётных тиках за едущими живыми танками; выцветание — раз в 45 тиков', () => {
    const decals = new FakeDecals();
    const effects = makeEffects(decals);
    const tanks = [snapshotTank(), snapshotTank({ speed: 3 }), snapshotTank({ isAlive: false }), snapshotTank()];
    effects.onSnapshot(1, tanks);
    effects.onSnapshot(2, tanks);
    effects.onSnapshot(45, tanks);
    expect(decals.calls).toEqual(['tread 500 400 0.5', 'tread 500 400 0.5', 'fade']);
  });

  it('подпалины — от удара в стену и от гибели; сброс очищает слой', () => {
    const decals = new FakeDecals();
    const effects = makeEffects(decals);
    effects.onEvent(fxEvent('impact', { x: 10, y: 20 }), QUIET);
    effects.onEvent(fxEvent('death', { x: 30, y: 40 }), QUIET);
    effects.reset();
    expect(decals.calls).toEqual(['scorch 10 20 16 0.35', 'scorch 30 40 90 0.75', 'clear']);
  });

  it('рисуется тем слоем, что передан снаружи', () => {
    const decals = new FakeDecals();
    const effects = makeEffects(decals);
    const { ctx } = recordingContext();
    effects.drawDecals(ctx, { x: 0, y: 0, width: 1600, height: 900, scale: 1 });
    expect(decals.calls).toEqual(['draw']);
  });
});

describe('хвост снаряда', () => {
  // Холст, который считает отрезки хвоста; градиент свечения — заглушка.
  function strokeCounter(): { ctx: CanvasRenderingContext2D; strokes: () => number } {
    let strokes = 0;
    const state: Record<string | symbol, unknown> = {};
    const ctx = new Proxy(state, {
      get: (target, key) => {
        if (key === 'stroke') {
          return (): void => {
            strokes++;
          };
        }
        if (key === 'createRadialGradient') {
          return () => ({ addColorStop: (): void => undefined });
        }
        return key in target ? target[key] : (): void => undefined;
      },
      set: (target, key, value) => {
        target[key] = value;
        return true;
      },
    }) as unknown as CanvasRenderingContext2D;
    return { ctx, strokes: () => strokes };
  }

  function drawAt(effects: Effects, id: number, x: number): number {
    const { ctx, strokes } = strokeCounter();
    effects.drawBullets(ctx, [{ id, x, y: 0, color: '#ffffff' }]);
    return strokes();
  }

  it('смена номера переносит хвост: подтверждённый снаряд продолжает след предсказанного', () => {
    const effects = makeEffects();
    drawAt(effects, 900, 0);
    expect(drawAt(effects, 900, 10)).toBe(1);
    effects.renameTrail(900, 5);
    expect(drawAt(effects, 5, 20)).toBe(2);
  });

  it('без переноса снаряд с новым номером начинает хвост заново', () => {
    const effects = makeEffects();
    drawAt(effects, 900, 0);
    drawAt(effects, 900, 10);
    expect(drawAt(effects, 5, 20)).toBe(0);
  });
});
