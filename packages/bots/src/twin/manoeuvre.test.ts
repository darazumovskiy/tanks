import {
  createRandom,
  isSegmentClear,
  normalizeAngle,
  TICK_RATE,
  type BotView,
  type Kit,
  type Wall,
} from '@tanks/shared/engine';
import { describe, expect, it } from 'vitest';
import { COURSE_BAND_LABELS } from '@tanks/analysis/ruler';
import { byCourseBand, courseWith, craftView, profileWith, type ViewSpec } from './fixture.js';
import { TwinBrain } from './brain.js';
import {
  courseAngleAt,
  freeCourse,
  Manoeuvre,
  nearestKit,
  type CourseDeciles,
  type ManoeuvreSettings,
} from './manoeuvre.js';
import { gridOf, type Grid } from './path.js';

const DECISION_MEAN_S = 0.4;
const WEAK_STICK = [0.1, 0.15, 0.2, 0.25, 0.3, 0.3, 0.35, 0.4, 0.4, 0.45, 0.45];
const TINY_INTERVAL = 0.001;
const LONG_INTERVAL = 1000;
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
      decisionMeanS: DECISION_MEAN_S,
      courseReach: REACH,
      stickDeciles: WEAK_STICK,
      courseDecilesDeg: courseWith(UNIFORM_COURSE),
      reverseChance: 0,
      kitShare: { closer: 0, farther: 0 },
      kitFollowShare: 0,
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
  it('интервалы решений — показательные со средним decisionMeanS; между решениями сила стика не меняется', () => {
    const manoeuvre = manoeuvreWith();
    const intervals: number[] = [];
    let decisions = manoeuvre.decisions;
    let strength = manoeuvre.intent.strength;
    let since = 0;
    for (let tick = 0; tick < 20000; tick++) {
      driveAt(manoeuvre, drift(MIDDLE, tick), OPEN, true);
      since++;
      if (manoeuvre.decisions === decisions) {
        expect(manoeuvre.intent.strength).toBe(strength);
        continue;
      }
      intervals.push(since);
      decisions = manoeuvre.decisions;
      strength = manoeuvre.intent.strength;
      since = 0;
    }
    const meanTicks = DECISION_MEAN_S * TICK_RATE;
    const mean = intervals.reduce((total, value) => total + value, 0) / intervals.length;
    const long = intervals.filter((value) => value > 2 * meanTicks).length / intervals.length;

    expect(Math.abs(mean - meanTicks) / meanTicks).toBeLessThan(0.1);
    expect(long).toBeCloseTo(Math.exp(-2), 1);
  });

  it('угол — значение доли в распределении корзины дистанции; между серединами корзин — линейно', () => {
    const deciles = byCourseBand(constant(0));
    COURSE_BAND_LABELS.forEach((label, index) => {
      deciles[label] = constant(10 * index);
    });
    const uniform = byCourseBand(UNIFORM_COURSE);

    expect(courseAngleAt(deciles, 100, 0.5) / DEG).toBeCloseTo(0, 9);
    expect(courseAngleAt(deciles, 0, 0.5) / DEG).toBeCloseTo(0, 9);
    expect(courseAngleAt(deciles, 175, 0.5) / DEG).toBeCloseTo(5, 9);
    expect(courseAngleAt(deciles, 250, 0.5) / DEG).toBeCloseTo(10, 9);
    expect(courseAngleAt(deciles, 300, 0.5) / DEG).toBeCloseTo(15, 9);
    expect(courseAngleAt(deciles, 650, 0.5) / DEG).toBeCloseTo(50, 9);
    expect(courseAngleAt(deciles, 2000, 0.5) / DEG).toBeCloseTo(70, 9);
    expect(courseAngleAt(uniform, 400, 0.3) / DEG).toBeCloseTo(54, 9);
  });

  it('доля распределения держится между решениями: угол идёт за дистанцией и видимостью своей корзины', () => {
    const courses: CourseDeciles = {
      sight: { ...byCourseBand(constant(90)), '<200': constant(150), '600–700': constant(10), '700–800': constant(10) },
      hidden: { ...byCourseBand(constant(30)), '<200': constant(120) },
    };
    const angleAt = (distance: number, hasSight: boolean, held: Manoeuvre): number => {
      driveAt(held, { me: { x: 300, y: 300 }, enemy: { x: 300 + distance, y: 300 } }, OPEN, hasSight);
      return Math.abs(held.intent.angle) / DEG;
    };
    const uniform = manoeuvreWith({ decisionMeanS: LONG_INTERVAL });
    const near = angleAt(250, true, uniform);
    const decisions = uniform.decisions;
    const far = angleAt(450, true, uniform);

    expect(uniform.decisions).toBe(decisions);
    expect(far).toBeCloseTo(near, 9);
    const byBand = manoeuvreWith({ decisionMeanS: LONG_INTERVAL, courseDecilesDeg: courses });
    expect(angleAt(100, true, byBand)).toBeCloseTo(150, 6);
    expect(angleAt(380, true, byBand)).toBeCloseTo(90, 6);
    expect(angleAt(700, true, byBand)).toBeCloseTo(10, 6);
    expect(angleAt(100, false, byBand)).toBeCloseTo(120, 6);
    expect(angleAt(450, false, byBand)).toBeCloseTo(30, 6);
  });

  it('сила стика на решение — из распределения газа на прямой', () => {
    const manoeuvre = manoeuvreWith({ decisionMeanS: TINY_INTERVAL });
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
    const manoeuvre = manoeuvreWith({ decisionMeanS: LONG_INTERVAL });
    for (let tick = 0; tick < 5; tick++) {
      driveAt(manoeuvre, drift(MIDDLE, tick), OPEN, true);
    }
    const decisions = manoeuvre.decisions;

    driveAt(manoeuvre, drift(MIDDLE, 5), OPEN, false);
    expect(manoeuvre.decisions).toBe(decisions + 1);
  });

  it('точка курса — на courseReach вперёд под углом к пеленгу; сторона линии держится от решения к решению', () => {
    const reach = 220;
    const manoeuvre = manoeuvreWith({ decisionMeanS: TINY_INTERVAL, courseReach: reach });
    const signs = new Set<number>();
    for (let tick = 0; tick < 500; tick++) {
      driveAt(manoeuvre, drift(MIDDLE, tick), OPEN, true);
      const { goal, angle } = manoeuvre.intent;
      const me = craftView(drift(MIDDLE, tick)).me;
      const bearing = Math.atan2(MIDDLE.enemy.y - me.y, MIDDLE.enemy.x - me.x);
      expect(Math.hypot(goal.x - me.x, goal.y - me.y)).toBeCloseTo(reach, 6);
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
      const angle = freeCourse(pocket, POCKET.me, bearing, 90 * DEG, REACH) ?? 0;
      const manoeuvre = manoeuvreWith(
        { decisionMeanS: LONG_INTERVAL, courseDecilesDeg: courseWith(constant(90)) },
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
      const rightShoulder = gridWith([{ x: 310, y: 120, w: 160, h: 60 }]);
      const leftShoulder = gridWith([{ x: 130, y: 120, w: 160, h: 60 }]);

      expect(freeCourse(rightShoulder, POCKET.me, -Math.PI / 2, 0, REACH)).toBeCloseTo(-15 * DEG, 9);
      expect(freeCourse(leftShoulder, POCKET.me, -Math.PI / 2, 0, REACH)).toBeCloseTo(15 * DEG, 9);
      expect(freeCourse(gridWith([{ x: 285, y: 120, w: 30, h: 60 }]), POCKET.me, -Math.PI / 2, 0, REACH)).toBeCloseTo(
        30 * DEG,
        9,
      );
    });

    it('сближение, загороженное стеной, — ближайший свободный курс вдоль неё, а не путь к противнику', () => {
      const shield = gridWith([{ x: 350, y: 150, w: 30, h: 300 }]);
      const spec: ViewSpec = { me: { x: 300, y: 300 }, enemy: { x: 550, y: 300 } };
      const approach = manoeuvreWith({ decisionMeanS: TINY_INTERVAL, courseDecilesDeg: courseWith(constant(0)) });
      const retreat = manoeuvreWith({ decisionMeanS: TINY_INTERVAL, courseDecilesDeg: courseWith(constant(180)) });
      driveAt(approach, spec, shield, false);
      driveAt(retreat, spec, shield, false);

      expect(approach.intent.kind).toBe('course');
      expect(Math.abs(approach.intent.angle)).toBeGreaterThan(45 * DEG);
      expect(retreat.intent.kind).toBe('course');
      expect(retreat.intent.goal.x).toBeCloseTo(300 - REACH, 6);
    });

    it('курс вдоль стены ближе радиуса корпуса занят — отклонение от стены; прижатый к стене находит курс от неё', () => {
      // Стена кончается раньше конца курса: клетка в конце свободна, мешает только запас корпуса.
      const below = gridWith([{ x: 100, y: 328, w: 200, h: 40 }]);
      const me = { x: 200, y: 306 };

      expect(freeCourse(below, me, 0, 0, REACH)).toBeCloseTo(-15 * DEG, 9);
      expect(freeCourse(below, me, 0, -90 * DEG, REACH)).toBeCloseTo(-90 * DEG, 9);
      expect(freeCourse(below, { x: 200, y: 290 }, 0, 0, REACH)).toBeCloseTo(0, 9);
    });

    it('стена впереди дальше courseReach курса не занимает', () => {
      const ahead = gridWith([{ x: 500, y: 100, w: 40, h: 400 }]);

      expect(freeCourse(ahead, { x: 300, y: 300 }, 0, 0, REACH)).toBeCloseTo(0, 9);
      expect(Math.abs(freeCourse(ahead, { x: 300, y: 300 }, 0, 0, 250) ?? 0)).toBeGreaterThan(0);
    });

    it('вокруг всё занято — путь к противнику', () => {
      const manoeuvre = manoeuvreWith({ decisionMeanS: TINY_INTERVAL });
      driveAt(manoeuvre, POCKET, gridWith([RIGHT, TOP, BOTTOM, LEFT]), true);

      expect(freeCourse(gridWith([RIGHT, TOP, BOTTOM, LEFT]), POCKET.me, -Math.PI / 2, 0, REACH)).toBeNull();
      expect(manoeuvre.intent.kind).toBe('chase');
      expect(manoeuvre.intent.goal).toEqual({ x: POCKET.enemy.x, y: POCKET.enemy.y });
    });
  });

  describe('аптечка', () => {
    const NEAR_ME: ViewSpec = { me: { x: 100, y: 300 }, enemy: { x: 500, y: 300 } };
    const kit = (x: number, y: number, isActive = true): Kit => ({ x, y, isActive, respawnIn: 0 });
    // Аптечка в глухой коробке: пути к ней нет.
    const BOXED = gridWith([
      { x: 380, y: 380, w: 140, h: 20 },
      { x: 380, y: 500, w: 140, h: 20 },
      { x: 380, y: 380, w: 20, h: 140 },
      { x: 500, y: 380, w: 20, h: 140 },
    ]);

    function kitShareOf(manoeuvre: Manoeuvre, spec: ViewSpec): number {
      let kitTicks = 0;
      for (let tick = 0; tick < 2000; tick++) {
        driveAt(manoeuvre, drift(spec, tick), OPEN, true);
        kitTicks += manoeuvre.intent.kind === 'kit' ? 1 : 0;
      }
      return kitTicks / 2000;
    }

    it('ближайшая по пути активная аптечка и кому она ближе; нет активных или до них не доехать — нет', () => {
      const view = (kits: Kit[]): BotView => craftView({ ...NEAR_ME, kits });

      expect(nearestKit(view([kit(110, 300, false), kit(160, 300), kit(450, 300)]), OPEN)).toEqual({
        point: { x: 160, y: 300 },
        side: 'closer',
      });
      expect(nearestKit(view([kit(450, 300)]), OPEN)).toEqual({ point: { x: 450, y: 300 }, side: 'farther' });
      expect(nearestKit(view([kit(160, 300, false)]), OPEN)).toBeNull();
      expect(nearestKit(view([kit(450, 450)]), BOXED)).toBeNull();
    });

    it('на решении едет к аптечке с долей своей стороны; к аптечке — по пути, угол хода не нужен', () => {
      const closer = manoeuvreWith({ decisionMeanS: TINY_INTERVAL, kitShare: { closer: 0.5, farther: 0 } });
      const closerSpec: ViewSpec = { ...NEAR_ME, kits: [kit(200, 300)] };
      const fartherSpec: ViewSpec = { ...NEAR_ME, kits: [kit(450, 300)] };
      const always = manoeuvreWith({ decisionMeanS: LONG_INTERVAL, kitShare: { closer: 1, farther: 1 } });
      driveAt(always, closerSpec, OPEN, true);

      expect(kitShareOf(closer, closerSpec)).toBeCloseTo(0.5, 1);
      expect(kitShareOf(manoeuvreWith({ kitShare: { closer: 0.5, farther: 0 } }), fartherSpec)).toBe(0);
      expect(kitShareOf(manoeuvreWith({ kitShare: { closer: 0, farther: 1 } }), fartherSpec)).toBeGreaterThan(0.9);
      expect(always.intent).toMatchObject({ kind: 'kit', goal: { x: 200, y: 300 }, angle: 0 });
    });

    it('аптечку забрали — новое решение сразу; пока лежит — держится до решения', () => {
      const manoeuvre = manoeuvreWith({ decisionMeanS: LONG_INTERVAL, kitShare: { closer: 1, farther: 1 } });
      const spec: ViewSpec = { ...NEAR_ME, kits: [kit(200, 300)] };
      for (let tick = 0; tick < 5; tick++) {
        driveAt(manoeuvre, drift(spec, tick), OPEN, true);
      }
      const decisions = manoeuvre.decisions;

      expect(manoeuvre.intent.kind).toBe('kit');
      driveAt(manoeuvre, drift({ ...spec, kits: [kit(200, 300, false)] }, 5), OPEN, true);
      expect(manoeuvre.decisions).toBe(decisions + 1);
      expect(manoeuvre.intent.kind).toBe('course');
    });

    describe('поездка, которую танк доводит', () => {
      const KIT_SPEC: ViewSpec = { ...NEAR_ME, kits: [kit(200, 300)] };
      // Противник встал у аптечки: она теперь ближе ему, а к такой аптечке танк с долей 0 не едет.
      const ENEMY_AT_KIT: ViewSpec = { ...KIT_SPEC, enemy: { x: 210, y: 300 } };
      const ONLY_CLOSER = { closer: 1, farther: 0 };
      // Полный стик: танк, который не сдвигается, упирается — так проверяется отъезд от препятствия.
      const FULL_STICK = WEAK_STICK.map(() => 1);

      function startTrip(kitFollowShare: number, seed = 1): Manoeuvre {
        const settings = {
          decisionMeanS: TINY_INTERVAL,
          stickDeciles: FULL_STICK,
          kitShare: ONLY_CLOSER,
          kitFollowShare,
        };
        const manoeuvre = manoeuvreWith(settings, seed);
        driveAt(manoeuvre, drift(KIT_SPEC, 0), OPEN, true);
        return manoeuvre;
      }

      it('держится через истёкшие интервалы и смену видимости, пока аптечка лежит; забрали — решение сразу', () => {
        const followed = startTrip(1);
        const dropped = startTrip(0);
        const decisions = followed.decisions;
        for (let tick = 1; tick < 100; tick++) {
          driveAt(followed, drift(ENEMY_AT_KIT, tick), OPEN, tick % 2 === 0);
          driveAt(dropped, drift(ENEMY_AT_KIT, tick), OPEN, tick % 2 === 0);
        }

        expect(followed.decisions).toBe(decisions);
        expect(followed.intent).toMatchObject({ kind: 'kit', goal: { x: 200, y: 300 } });
        expect(dropped.intent.kind).toBe('course');
        driveAt(followed, drift({ ...ENEMY_AT_KIT, kits: [kit(200, 300, false)] }, 100), OPEN, true);
        expect(followed.decisions).toBe(decisions + 1);
        expect(followed.intent.kind).toBe('course');
      });

      it('доводится доля kitFollowShare новых поездок; новое решение к той же аптечке поездку не начинает', () => {
        // Ход к аптечке — на каждом решении: поездка, которую танк не решил довести, продолжается к той же
        // аптечке, но решения довести её на продолжении нет.
        const seeds = Array.from({ length: 400 }, (_, index) => index + 1);
        const followedShare =
          seeds.filter((seed) => {
            const manoeuvre = startTrip(0.5, seed);
            for (let tick = 1; tick < 50; tick++) {
              driveAt(manoeuvre, drift(KIT_SPEC, tick), OPEN, true);
            }
            const decisions = manoeuvre.decisions;
            driveAt(manoeuvre, drift(KIT_SPEC, 50), OPEN, true);
            return manoeuvre.decisions === decisions;
          }).length / seeds.length;

        expect(followedShare).toBeGreaterThan(0.43);
        expect(followedShare).toBeLessThan(0.57);
      });

      it('после отъезда от препятствия поездка продолжается', () => {
        const followed = startTrip(1);
        const dropped = startTrip(0);
        const kinds: string[] = [];
        for (let tick = 0; tick <= TICK_RATE + 1; tick++) {
          driveAt(followed, ENEMY_AT_KIT, OPEN, true);
          driveAt(dropped, ENEMY_AT_KIT, OPEN, true);
          kinds.push(followed.intent.kind);
        }

        expect(kinds).toContain('unstick');
        expect(followed.intent).toMatchObject({ kind: 'kit', goal: { x: 200, y: 300 } });
        expect(dropped.intent.kind).not.toBe('kit');
      });

      it('выезд на место засады бросает поездку', () => {
        const manoeuvre = startTrip(1);
        manoeuvre.travel(craftView(drift(ENEMY_AT_KIT, 1)), OPEN, { x: 400, y: 100 });
        driveAt(manoeuvre, drift(ENEMY_AT_KIT, 2), OPEN, true);

        expect(manoeuvre.intent.kind).toBe('course');
      });
    });
  });

  it('газ 1 с без сдвига — отъезд назад от препятствия, потом курс на другой стороне линии', () => {
    const manoeuvre = manoeuvreWith({
      stickDeciles: WEAK_STICK.map(() => 1),
      decisionMeanS: LONG_INTERVAL,
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
      decisionMeanS: TINY_INTERVAL,
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
