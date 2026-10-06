import { createRandom, isSegmentClear, normalizeAngle, TICK_RATE, type Wall } from '@tanks/shared/engine';
import { describe, expect, it } from 'vitest';
import { courseWith, craftView, profileWith, type ViewSpec } from '../fixture.js';
import { TwinBrain } from './brain.js';
import { freeCourse, Manoeuvre, type CourseDeciles, type ManoeuvreSettings } from './manoeuvre.js';
import { gridOf, type Grid } from './path.js';

const DECISION_DECILES_S = [0.03, 0.07, 0.1, 0.13, 0.17, 0.23, 0.3, 0.4, 0.53, 0.8, 2];
const WEAK_STICK = [0.1, 0.15, 0.2, 0.25, 0.3, 0.3, 0.35, 0.4, 0.4, 0.45, 0.45];
const TINY_INTERVAL = DECISION_DECILES_S.map(() => 0.001);
const LONG_INTERVAL = DECISION_DECILES_S.map((value) => value * 100);
const UNIFORM_COURSE = [0, 18, 36, 54, 72, 90, 108, 126, 144, 162, 180];
const DEG = Math.PI / 180;
const REACH = 150;
const BOX_SIZE = 600;
// Сид, при котором манёвр начинает раунд на положительной стороне линии.
const RIGHT_SIDE_SEED = 7;

function constant(value: number): number[] {
  return UNIFORM_COURSE.map(() => value);
}

function gridWith(walls: Wall[]): Grid {
  return gridOf({ name: 'box', width: BOX_SIZE, height: BOX_SIZE, walls, kits: [] });
}

const OPEN = gridWith([]);

function manoeuvreWith(settings: Partial<ManoeuvreSettings> = {}, seed = 1): Manoeuvre {
  const manoeuvre = new Manoeuvre(
    {
      control: 'sticks',
      pivotThrottle: 0.6,
      decisionDecilesS: DECISION_DECILES_S,
      stickDeciles: WEAK_STICK,
      courseDecilesDeg: courseWith(UNIFORM_COURSE),
      reverseChance: 0,
      ...settings,
    },
    createRandom(seed),
  );
  manoeuvre.reset();
  return manoeuvre;
}

// Танк в виде сдвигается на тик вперёд — стоящий вид иначе выглядел бы упором.
function drift(spec: ViewSpec, tick: number): ViewSpec {
  return { ...spec, me: { ...spec.me, x: spec.me.x + (tick % 2) * 20 }, tick };
}

function driveAt(manoeuvre: Manoeuvre, spec: ViewSpec, grid: Grid, hasSight: boolean): void {
  const view = craftView(spec);
  manoeuvre.drive(view, grid, hasSight, Math.hypot(view.enemy.x - view.me.x, view.enemy.y - view.me.y));
}

const MIDDLE: ViewSpec = { me: { x: 300, y: 300 }, enemy: { x: 680, y: 300 } };

describe('манёвр двойника', () => {
  it('между решениями угол к линии и сила стика не меняются; интервалы — по распределению профиля', () => {
    const manoeuvre = manoeuvreWith({ decisionDecilesS: DECISION_DECILES_S.map((value) => value * 2) });
    const intervals: number[] = [];
    let current = { angle: Math.abs(manoeuvre.intent.angle), strength: manoeuvre.intent.strength };
    let since = 0;
    for (let tick = 0; tick < 6000; tick++) {
      driveAt(manoeuvre, drift(MIDDLE, tick), OPEN, true);
      since++;
      const next = { angle: Math.abs(manoeuvre.intent.angle), strength: manoeuvre.intent.strength };
      if (Math.abs(next.angle - current.angle) < 1e-9 && next.strength === current.strength) {
        continue;
      }
      intervals.push(since);
      current = next;
      since = 0;
    }
    intervals.sort((a, b) => a - b);
    const median = intervals[Math.floor(intervals.length / 2)] ?? 0;

    const expected = 0.23 * 2 * TICK_RATE;
    expect(Math.abs(median - expected) / expected).toBeLessThan(0.1);
  });

  it('угол к линии — из распределения своей видимости и корзины дистанции', () => {
    const courses: CourseDeciles = {
      sight: { '<300': constant(150), '300–600': constant(90), '>600': constant(10) },
      hidden: { '<300': constant(120), '300–600': constant(30), '>600': constant(60) },
    };
    const angleAt = (distance: number, hasSight: boolean): number => {
      const manoeuvre = manoeuvreWith({ decisionDecilesS: TINY_INTERVAL, courseDecilesDeg: courses });
      driveAt(manoeuvre, { me: { x: 300, y: 300 }, enemy: { x: 300 + distance, y: 300 } }, OPEN, hasSight);
      return Math.abs(manoeuvre.intent.angle) / DEG;
    };

    expect(angleAt(200, true)).toBeCloseTo(150, 6);
    expect(angleAt(380, true)).toBeCloseTo(90, 6);
    expect(angleAt(450, false)).toBeCloseTo(30, 6);
    expect(angleAt(200, false)).toBeCloseTo(120, 6);
    expect(angleAt(480, false)).toBeCloseTo(30, 6);
    expect(angleAt(490, true)).toBeCloseTo(90, 6);
  });

  it('сила стика на решение — из распределения газа на прямой', () => {
    const manoeuvre = manoeuvreWith({ decisionDecilesS: TINY_INTERVAL });
    const strengths: number[] = [];
    for (let tick = 0; tick < 2000; tick++) {
      driveAt(manoeuvre, drift(MIDDLE, tick), OPEN, true);
      strengths.push(manoeuvre.intent.strength);
    }
    strengths.sort((a, b) => a - b);

    expect(strengths[0]).toBeGreaterThanOrEqual(WEAK_STICK[0] ?? 0);
    expect(strengths[strengths.length - 1]).toBeLessThanOrEqual(WEAK_STICK[10] ?? 1);
    expect(strengths[Math.floor(strengths.length / 2)]).toBeCloseTo(WEAK_STICK[5] ?? 0, 1);
  });

  it('смена видимости — новое решение сразу, не дожидаясь интервала', () => {
    const manoeuvre = manoeuvreWith({
      decisionDecilesS: LONG_INTERVAL,
      courseDecilesDeg: { sight: courseWith(constant(90)).sight, hidden: courseWith(constant(30)).hidden },
    });
    for (let tick = 0; tick < 5; tick++) {
      driveAt(manoeuvre, drift(MIDDLE, tick), OPEN, true);
    }
    expect(Math.abs(manoeuvre.intent.angle) / DEG).toBeCloseTo(90, 6);

    driveAt(manoeuvre, drift(MIDDLE, 5), OPEN, false);
    expect(Math.abs(manoeuvre.intent.angle) / DEG).toBeCloseTo(30, 6);
  });

  it('точка курса — на 150 вперёд под углом к пеленгу; сторона линии держится от решения к решению', () => {
    const manoeuvre = manoeuvreWith({ decisionDecilesS: TINY_INTERVAL });
    const signs = new Set<number>();
    for (let tick = 0; tick < 500; tick++) {
      driveAt(manoeuvre, drift(MIDDLE, tick), OPEN, true);
      const { goal, angle } = manoeuvre.intent;
      const me = craftView(drift(MIDDLE, tick)).me;
      const bearing = Math.atan2(MIDDLE.enemy.y - me.y, MIDDLE.enemy.x - me.x);
      expect(Math.hypot(goal.x - me.x, goal.y - me.y)).toBeCloseTo(REACH, 6);
      expect(normalizeAngle(Math.atan2(goal.y - me.y, goal.x - me.x) - bearing - angle)).toBeCloseTo(0, 6);
      if (Math.abs(angle) > DEG && Math.abs(angle) < Math.PI - DEG) {
        signs.add(Math.sign(angle));
      }
    }

    expect(signs.size).toBe(1);
  });

  describe('стены', () => {
    // Карман: стены справа, сверху и снизу от танка, слева — проход; противник сверху.
    const RIGHT: Wall = { x: 330, y: 100, w: 30, h: 400 };
    const TOP: Wall = { x: 200, y: 200, w: 160, h: 30 };
    const BOTTOM: Wall = { x: 200, y: 370, w: 160, h: 30 };
    const LEFT: Wall = { x: 230, y: 230, w: 30, h: 140 };
    const POCKET: ViewSpec = { me: { x: 300, y: 300 }, enemy: { x: 300, y: 60 } };

    it('курс занят стеной — ближайший свободный, хоть на другой стороне линии; сторона меняется на неё', () => {
      const pocket = gridWith([RIGHT, TOP, BOTTOM]);
      const bearing = -Math.PI / 2;
      const angle = freeCourse(pocket, POCKET.me, bearing, 90 * DEG) ?? 0;
      const manoeuvre = manoeuvreWith(
        { decisionDecilesS: LONG_INTERVAL, courseDecilesDeg: courseWith(constant(90)) },
        RIGHT_SIDE_SEED,
      );
      driveAt(manoeuvre, MIDDLE, OPEN, true);
      expect(manoeuvre.intent.angle).toBeCloseTo(90 * DEG, 9);

      driveAt(manoeuvre, POCKET, pocket, false);
      const inPocket = manoeuvre.intent.angle;
      driveAt(manoeuvre, MIDDLE, OPEN, true);

      expect(angle).toBeLessThan(0);
      const end = { x: 300 + Math.cos(bearing + angle) * REACH, y: 300 + Math.sin(bearing + angle) * REACH };
      expect(isSegmentClear([RIGHT, TOP, BOTTOM], 300, 300, end.x, end.y, 0)).toBe(true);
      expect(inPocket).toBeCloseTo(angle, 9);
      expect(manoeuvre.intent.angle).toBeCloseTo(-90 * DEG, 9);
    });

    it('отклонение ищется в обе стороны: стена справа от курса — первым свободным выходит шаг влево, при равных — вправо', () => {
      const rightShoulder = gridWith([{ x: 295, y: 120, w: 160, h: 60 }]);
      const leftShoulder = gridWith([{ x: 145, y: 120, w: 160, h: 60 }]);

      expect(freeCourse(rightShoulder, POCKET.me, -Math.PI / 2, 0)).toBeCloseTo(-15 * DEG, 9);
      expect(freeCourse(leftShoulder, POCKET.me, -Math.PI / 2, 0)).toBeCloseTo(15 * DEG, 9);
      expect(freeCourse(gridWith([{ x: 285, y: 120, w: 30, h: 60 }]), POCKET.me, -Math.PI / 2, 0)).toBeCloseTo(
        30 * DEG,
        9,
      );
    });

    it('сближение, загороженное стеной, — путём к противнику; отъезд там же — курсом', () => {
      const shield = gridWith([{ x: 350, y: 150, w: 30, h: 300 }]);
      const spec: ViewSpec = { me: { x: 300, y: 300 }, enemy: { x: 550, y: 300 } };
      const approach = manoeuvreWith({ decisionDecilesS: TINY_INTERVAL, courseDecilesDeg: courseWith(constant(0)) });
      const retreat = manoeuvreWith({ decisionDecilesS: TINY_INTERVAL, courseDecilesDeg: courseWith(constant(180)) });
      driveAt(approach, spec, shield, false);
      driveAt(retreat, spec, shield, false);

      expect(approach.intent.kind).toBe('chase');
      expect(approach.intent.goal).toEqual({ x: 550, y: 300 });
      expect(retreat.intent.kind).toBe('course');
      expect(retreat.intent.goal.x).toBeCloseTo(300 - REACH, 6);
    });

    it('сближение — любой угол меньше 90°: увод стеной на другую сторону — путь к противнику, при 120° — курс', () => {
      const pocket = gridWith([RIGHT, TOP, BOTTOM]);
      const kindAt = (angleDeg: number): string => {
        const manoeuvre = manoeuvreWith(
          { decisionDecilesS: TINY_INTERVAL, courseDecilesDeg: courseWith(constant(angleDeg)) },
          RIGHT_SIDE_SEED,
        );
        driveAt(manoeuvre, POCKET, pocket, false);
        return manoeuvre.intent.kind;
      };

      expect(kindAt(60)).toBe('chase');
      expect(kindAt(85)).toBe('chase');
      expect(kindAt(120)).toBe('course');
    });

    it('вокруг всё занято — путь к противнику', () => {
      const manoeuvre = manoeuvreWith({ decisionDecilesS: TINY_INTERVAL });
      driveAt(manoeuvre, POCKET, gridWith([RIGHT, TOP, BOTTOM, LEFT]), true);

      expect(freeCourse(gridWith([RIGHT, TOP, BOTTOM, LEFT]), POCKET.me, -Math.PI / 2, 0)).toBeNull();
      expect(manoeuvre.intent.kind).toBe('chase');
      expect(manoeuvre.intent.goal).toEqual({ x: POCKET.enemy.x, y: POCKET.enemy.y });
    });
  });

  it('газ 1 с без сдвига — отъезд назад от препятствия, потом курс на другой стороне линии', () => {
    const manoeuvre = manoeuvreWith({
      stickDeciles: WEAK_STICK.map(() => 1),
      decisionDecilesS: LONG_INTERVAL,
      courseDecilesDeg: courseWith(constant(90)),
    });
    const stuck: ViewSpec = { me: { x: 300, y: 300, heading: 0 }, enemy: { x: 680, y: 300 } };
    driveAt(manoeuvre, stuck, OPEN, true);
    const before = Math.sign(manoeuvre.intent.angle);
    for (let tick = 0; tick < TICK_RATE + 1; tick++) {
      driveAt(manoeuvre, stuck, OPEN, true);
    }

    expect(manoeuvre.intent.kind).toBe('unstick');
    expect(manoeuvre.intent.goal.x).toBeLessThan(300);

    driveAt(manoeuvre, { ...stuck, me: { x: 220, y: 300 } }, OPEN, true);
    expect(manoeuvre.intent.kind).toBe('course');
    expect(Math.sign(manoeuvre.intent.angle)).toBe(-before);
  });

  it('снаружи зоны — путь к центру зоны в любом режиме', () => {
    const spec: ViewSpec = { me: { x: 800, y: 150, heading: 0 }, enemy: { x: 1500, y: 150 } };
    const toward = profileWith({
      manoeuvre: { ...profileWith().manoeuvre, courseDecilesDeg: courseWith(constant(0)) },
    });
    const free = new TwinBrain(toward);
    const shrunk = new TwinBrain(toward);
    for (const brain of [free, shrunk]) {
      brain.init({ level: 8, roundIndex: 0, lossStreak: 0, mapIndex: 0, hasRicochetGuard: false, seed: 4 });
    }

    expect(Math.abs(free.tick(craftView(spec)).action.turn)).toBeLessThan(0.9);
    expect(shrunk.tick(craftView({ ...spec, zoneRadius: 200 })).action.turn).toBe(1);
  });

  it('компьютер: газ и поворот только −1, 0, 1; задний ход к точке сзади с частотой reverseChance', () => {
    const manoeuvre = manoeuvreWith({
      control: 'mouseKeys',
      reverseChance: 0.4,
      decisionDecilesS: TINY_INTERVAL,
      courseDecilesDeg: courseWith(constant(180)),
    });
    const spec: ViewSpec = { me: { x: 300, y: 300, heading: 0 }, enemy: { x: 480, y: 300 } };
    let reverse = 0;
    const ticks = 4000;
    for (let tick = 0; tick < ticks; tick++) {
      const view = craftView(drift(spec, tick));
      const drive = manoeuvre.drive(view, OPEN, true, 180);
      expect([-1, 0, 1]).toContain(drive.throttle);
      expect([-1, 0, 1]).toContain(drive.turn);
      reverse += manoeuvre.intent.isReverse ? 1 : 0;
    }

    expect(reverse / ticks).toBeCloseTo(0.4, 1);
  });
});
