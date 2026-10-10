import { describe, expect, it } from 'vitest';
import { createWorld, DEFAULT_RULES, DT, type Point } from '@tanks/shared/engine';
import {
  BulletPicture,
  BulletTracks,
  EVENT_MAX_WAIT_MS,
  EventSchedule,
  eventPlace,
  flightEndTick,
  ownBulletWeight,
  recordFlight,
  OwnTime,
  PICTURE_APPROACH_SPAN,
  PICTURE_CATCH_UP_RATE,
  PICTURE_MIN_TIME_RATE,
  PICTURE_NEAR,
  pictureDebug,
  pictureTickAt,
  pictureWeight,
  type PictureClock,
  type PictureEventKind,
  type TrackPoint,
} from './pictureTime.js';

const ME = { x: 0, y: 0 };
const ENEMY = { x: 1000, y: 0 };
const MY_OWNER = 1;
const MY_TANK = 1;

function point(id: number, x: number, y = 0, owner = 7): TrackPoint {
  return { id, owner, x, y };
}

function clock(myTick: number, othersTick: number, others = [ENEMY]): PictureClock {
  return { myTick, othersTick, me: ME, others };
}

describe('вес времени', () => {
  it('у своего танка — 1, у чужого — 0, между — по расстояниям за вычетом зоны «у танка»', () => {
    expect(pictureWeight(0, 500)).toBe(1);
    expect(pictureWeight(PICTURE_NEAR, 500)).toBe(1);
    expect(pictureWeight(500, PICTURE_NEAR)).toBe(0);
    expect(pictureWeight(500, 0)).toBe(0);
    expect(pictureWeight(PICTURE_NEAR + 100, PICTURE_NEAR + 300)).toBeCloseTo(0.75, 12);
  });

  it('оба танка рядом — время своего; чужих нет — время своего; своего нет — время чужих', () => {
    expect(pictureWeight(10, 10)).toBe(1);
    expect(pictureWeight(400, Infinity)).toBe(1);
    expect(pictureWeight(Infinity, 400)).toBe(0);
  });

  it('по прямой от чужого к своему вес растёт непрерывно и не убывает', () => {
    let previous = 0;
    for (let x = ENEMY.x; x >= ME.x; x -= 5) {
      const weight = pictureWeight(x - ME.x, ENEMY.x - x);
      expect(weight).toBeGreaterThanOrEqual(previous);
      expect(weight - previous).toBeLessThan(0.01);
      previous = weight;
    }
    expect(previous).toBe(1);
  });

  it('тик картинки в точке: у своего — его тик, у чужого — тик чужих', () => {
    const now = clock(20, 15);
    expect(pictureTickAt(now, ME)).toBe(20);
    expect(pictureTickAt(now, ENEMY)).toBe(15);
    expect(pictureTickAt({ ...now, me: null }, { x: 500, y: 0 })).toBe(15);
  });
});

describe('дорожки снарядов', () => {
  it('между тиками — линейно; погиб в следующем — не рисуется; родился в следующем — с места рождения', () => {
    const tracks = new BulletTracks();
    tracks.record(10, [point(1, 0), point(2, 50)]);
    tracks.record(11, [point(1, 20), point(3, 300)]);
    expect(tracks.at(1, 10.25)).toEqual(point(1, 5));
    expect(tracks.at(2, 10.25)).toBeNull();
    expect(tracks.at(2, 10)).toEqual(point(2, 50));
    expect(tracks.at(3, 10.5)).toEqual(point(3, 300));
    expect(tracks.at(1, 9)).toEqual(point(1, 0));
    expect(tracks.at(1, 12)).toEqual(point(1, 20));
    expect(tracks.at(9, 10.5)).toBeNull();
  });

  it('пропуск тика: снаряд ведётся линейно через пропуск', () => {
    const tracks = new BulletTracks();
    tracks.record(10, [point(1, 0)]);
    tracks.record(13, [point(1, 60)]);
    expect(tracks.at(1, 11)).toEqual(point(1, 20));
  });

  it('снимок поверх досчитанных тиков: досчёт после него заменяется, старое за буфером забывается', () => {
    const tracks = new BulletTracks();
    tracks.record(10, [point(1, 0)]);
    tracks.record(11, [point(1, 20)]);
    tracks.record(12, [point(1, 40)]);
    tracks.forgetFrom(11);
    tracks.record(11, [point(1, 25)]);
    expect(tracks.at(1, 12)).toEqual(point(1, 25));
    expect(tracks.at(1, 11)).toEqual(point(1, 25));
    tracks.forgetBefore(11);
    expect(tracks.idsBetween(0, 20)).toEqual(new Set([1]));
    expect(tracks.at(1, 10)).toEqual(point(1, 25));
    tracks.forgetFrom(0);
    expect(tracks.at(1, 11)).toBeNull();
  });

  it('тик гибели — первый записанный тик без снаряда после тиков с ним', () => {
    const tracks = new BulletTracks();
    tracks.record(10, [point(1, 0)]);
    tracks.record(11, [point(1, 20), point(2, 0)]);
    tracks.record(13, [point(2, 40)]);
    expect(tracks.deathTick(1)).toBe(13);
    expect(tracks.deathTick(2)).toBeNull();
    expect(tracks.deathTick(9)).toBeNull();
  });

  it('за последним местом — его скоростью, без скорости — ходом двух мест, не дальше предела; родился мёртвым — тик шага', () => {
    const tracks = new BulletTracks();
    tracks.record(10, [point(1, 0), point(2, 0)]);
    tracks.record(11, [point(1, 20), { ...point(2, 30), vx: 600, vy: 0 }]);
    expect(tracks.ahead(1, 12.5, 5)).toEqual({ x: 50, y: 0 });
    expect(tracks.ahead(2, 12, 5)?.x).toBeCloseTo(50, 9);
    expect(tracks.ahead(1, 17, 5)).toBeNull();
    tracks.record(12, [point(4, 0)]);
    expect(tracks.ahead(4, 13, 5)).toBeNull();
    expect(tracks.at(2, 11)).toEqual(point(2, 30));
    tracks.markBornDead(3, 12);
    expect(tracks.deathTick(3)).toBe(12);
    tracks.forgetFrom(12);
    expect(tracks.deathTick(3)).toBeNull();
  });

  it('последнее место не позже тика и первое не раньше', () => {
    const tracks = new BulletTracks();
    tracks.record(10, [point(1, 0)]);
    tracks.record(11, [point(1, 20)]);
    tracks.record(12, [point(2, 99)]);
    expect(tracks.lastAt(1, 12)).toEqual(point(1, 20));
    expect(tracks.firstAt(2, 10)).toEqual(point(2, 99));
    expect(tracks.lastAt(2, 11)).toBeNull();
    expect(tracks.firstAt(1, 12)).toBeNull();
  });
});

// Снаряд летит по оси x со скоростью speed за тик; тики 0…to.
function straightTrack(tracks: BulletTracks, id: number, from: number, speed: number, to: number): void {
  for (let tick = 0; tick <= to; tick++) {
    tracks.record(tick, [point(id, from + speed * tick)]);
  }
}

describe('тик картинки снаряда', () => {
  it('у своего танка — тик своего, у чужого — тик чужих', () => {
    const tracks = new BulletTracks();
    tracks.record(10, [point(1, 960), point(2, 30)]);
    tracks.record(15, [point(1, 960), point(2, 30)]);
    const bullets = new BulletPicture(tracks, MY_OWNER).frame(clock(15, 10));
    expect(bullets.find((bullet) => bullet.id === 1)?.tick).toBe(10);
    expect(bullets.find((bullet) => bullet.id === 2)?.tick).toBe(15);
  });

  it('свой выстрел к врагу: у ствола — тик своего, дальше τ убывает не быстрее доли хода часов и назад не летит', () => {
    const tracks = new BulletTracks();
    const myTick = 20;
    straightTrack(tracks, 1, -600, 20, myTick + 40);
    const picture = new BulletPicture(tracks, MY_OWNER);
    let previousX = -Infinity;
    let previousTick = Infinity;
    for (let frame = 0; frame <= 40; frame++) {
      const p = myTick + frame / 2;
      const [bullet] = picture.frame(clock(p, p - 5, [{ x: 400, y: 0 }]));
      if (bullet === undefined) {
        throw new Error('снаряд пропал');
      }
      if (frame > 0) {
        expect(bullet.tick - previousTick).toBeGreaterThanOrEqual(PICTURE_MIN_TIME_RATE / 2 - 1e-9);
        expect(bullet.x).toBeGreaterThan(previousX);
      }
      previousX = bullet.x;
      previousTick = bullet.tick;
    }
    expect(previousTick).toBeLessThan(myTick + 20);
  });

  it('снаряд подлетает к своему танку — тик картинки догоняет тик своего без ограничения', () => {
    const tracks = new BulletTracks();
    tracks.record(10, [point(1, 900)]);
    tracks.record(15, [point(1, 30)]);
    const picture = new BulletPicture(tracks, MY_OWNER);
    expect(picture.frame({ ...clock(15, 10), me: { x: 0, y: 0 } })[0]?.tick).toBe(15);
  });

  it('подтверждение своего выстрела переносит тик картинки на номер сервера', () => {
    const tracks = new BulletTracks();
    tracks.record(10, [point(100, 200)]);
    const picture = new BulletPicture(tracks, MY_OWNER);
    const first = picture.frame(clock(10, 8))[0]?.tick ?? NaN;
    picture.rename(100, 5);
    picture.rename(42, 6);
    tracks.forgetFrom(0);
    tracks.record(10, [point(5, 200)]);
    tracks.record(11, [point(5, 220)]);
    const [bullet] = picture.frame(clock(11, 9, [{ x: 220, y: 0 }]));
    expect(bullet?.tick).toBeCloseTo(first + PICTURE_MIN_TIME_RATE, 9);
    expect(new BulletPicture(tracks, MY_OWNER).frame(clock(11, 9, [{ x: 220, y: 0 }]))[0]?.tick).toBe(9);
  });

  it('тик чужих стоит — тик картинки снаряда у чужого не растёт', () => {
    const tracks = new BulletTracks();
    straightTrack(tracks, 1, 950, 1, 12);
    const picture = new BulletPicture(tracks, MY_OWNER);
    expect(picture.frame(clock(12, 9))[0]?.tick).toBe(9);
    expect(picture.frame(clock(12, 9))[0]?.tick).toBe(9);
  });

  it('снаряд, погибший к своему тику картинки, не рисуется', () => {
    const tracks = new BulletTracks();
    tracks.record(10, [point(1, 100)]);
    tracks.record(11, []);
    expect(new BulletPicture(tracks, MY_OWNER).frame(clock(11, 10.5))).toEqual([]);
  });

  it('свой снаряд к врагу виден до кадра, где картинка врага дошла до тика гибели снаряда', () => {
    const tracks = new BulletTracks();
    const enemy = { x: 200, y: 0 };
    for (let tick = 0; tick <= 8; tick++) {
      tracks.record(tick, [point(1, 20 * tick, 0, MY_OWNER)]);
    }
    tracks.record(9, []);
    tracks.record(10, []);
    const picture = new BulletPicture(tracks, MY_OWNER);
    const frames: { x: number | null; othersTick: number; tick: number }[] = [];
    for (let othersTick = 0; othersTick <= 9; othersTick += 0.5) {
      const [bullet] = picture.frame({ myTick: othersTick + 4, othersTick, me: ME, others: [enemy] });
      frames.push({ x: bullet?.x ?? null, othersTick, tick: bullet?.tick ?? NaN });
    }
    const shown = frames.filter((frame) => frame.x !== null);
    expect(shown.map((frame) => frame.othersTick)).toEqual(
      frames.filter((frame) => frame.othersTick <= 8).map((frame) => frame.othersTick),
    );
    expect(enemy.x - (shown.at(-1)?.x ?? NaN)).toBeLessThanOrEqual(2 * 24 + 5);
  });

  it('стоявший у корпуса снаряд: сервер решил «мимо» — летит дальше; чужой снаряд не встаёт', () => {
    const tracks = new BulletTracks();
    const enemy = { x: 100, y: 0 };
    for (let tick = 0; tick <= 4; tick++) {
      tracks.record(tick, [point(1, 20 * tick, 0, MY_OWNER), point(2, 20 * tick, 30, 7)]);
    }
    tracks.record(5, [point(2, 100, 30, 7)]);
    const picture = new BulletPicture(tracks, MY_OWNER);
    const atContact = picture.frame({ myTick: 5, othersTick: 3.6, me: null, others: [enemy] });
    expect(atContact.find((bullet) => bullet.id === 1)?.x).toBeCloseTo(71, 9);
    const stillHeld = picture.frame({ myTick: 5, othersTick: 3.9, me: null, others: [enemy] });
    expect(stillHeld.find((bullet) => bullet.id === 1)?.x).toBeCloseTo(71, 9);
    expect(stillHeld.find((bullet) => bullet.id === 2)?.x).toBeCloseTo(78, 9);
    tracks.forgetFrom(5);
    for (let tick = 5; tick <= 8; tick++) {
      tracks.record(tick, [point(1, 20 * tick, 0, MY_OWNER)]);
    }
    const released = picture.frame({ myTick: 7, othersTick: 6, me: null, others: [enemy] });
    const releasedX = released.find((bullet) => bullet.id === 1)?.x ?? NaN;
    expect(releasedX).toBeCloseTo(enemy.x + 24 + 5, 1);
    expect(released.find((bullet) => bullet.id === 2)).toBeUndefined();
    const flying = picture.frame({ myTick: 8, othersTick: 7.5, me: null, others: [enemy] });
    expect(flying.find((bullet) => bullet.id === 1)?.x).toBeGreaterThan(100);
  });

  it('свой снаряд на броне едет вместе с танком; досчёт за последним снимком «мимо» не отпускает его', () => {
    const tracks = new BulletTracks();
    for (let tick = 0; tick <= 10; tick++) {
      tracks.record(tick, [point(1, 20 * tick, 0, MY_OWNER)]);
    }
    const picture = new BulletPicture(tracks, MY_OWNER);
    const at = (othersTick: number, enemyX: number, confirmedTick: number): number | undefined =>
      picture.frame({ myTick: 8, othersTick, me: null, others: [{ x: enemyX, y: 0 }] }, confirmedTick)[0]?.x;
    expect(at(3.6, 100, 3)).toBeCloseTo(71, 9);
    expect(at(4, 110, 3)).toBeCloseTo(81, 9);
    expect(at(4.5, 104, 4)).toBeCloseTo(75, 9);
    expect(at(6, 108, 4)).toBeCloseTo(79, 9);
  });

  it('свой снаряд на броне: подъехавший другой танк его не уводит; «мимо» с местом позади брони — ждёт на броне', () => {
    const tracks = new BulletTracks();
    for (let tick = 0; tick <= 4; tick++) {
      tracks.record(tick, [point(1, 20 * tick, 0, MY_OWNER)]);
    }
    const picture = new BulletPicture(tracks, MY_OWNER);
    const enemy = { x: 100, y: 0 };
    const frame = (othersTick: number, others: Point[]): Point | undefined =>
      picture.frame({ myTick: 8, othersTick, me: null, others })[0];
    expect(frame(3.6, [enemy])).toMatchObject({ x: 71, y: 0 });
    expect(frame(3.8, [enemy, { x: 71, y: 20 }])).toMatchObject({ x: 71, y: 0 });
    tracks.forgetFrom(4);
    for (const [tick, x, y] of [
      [4, 60, 0],
      [5, 100, 40],
      [6, 140, 40],
      [7, 180, 40],
    ] as const) {
      tracks.record(tick, [point(1, x, y, MY_OWNER)]);
    }
    expect(frame(4.2, [enemy])).toMatchObject({ x: 71, y: 0 });
    const released = frame(5.5, [enemy]) ?? { x: 0, y: 0 };
    expect(released.x).toBeCloseTo(84.5, 0);
    expect(released.y).toBeCloseTo(24.5, 0);
    expect(Math.hypot(released.x - enemy.x, released.y - enemy.y)).toBeGreaterThan(CONTACT);
  });

  it('свой снаряд, погибший у корпуса врага впереди его картинки, стоит до вспышки, но не дольше предела ожидания', () => {
    const tracks = new BulletTracks();
    const enemy = { x: 200, y: 0 };
    for (let tick = 0; tick <= 60; tick++) {
      tracks.record(tick, tick >= 40 && tick <= 48 ? [point(1, 20 * (tick - 40), 0, MY_OWNER)] : []);
    }
    const picture = new BulletPicture(tracks, MY_OWNER);
    const maxTicks = EVENT_MAX_WAIT_MS / (1000 / 30);
    const shown: { othersTick: number; x: number }[] = [];
    let goneAt: number | null = null;
    for (let othersTick = 0; othersTick <= 50 && goneAt === null; othersTick += 0.5) {
      const [bullet] = picture.frame({ myTick: othersTick + 40, othersTick, me: ME, others: [enemy] });
      if (bullet === undefined) {
        goneAt = othersTick;
      } else {
        shown.push({ othersTick, x: bullet.x });
      }
    }
    const heldX = shown.at(-1)?.x ?? NaN;
    expect(enemy.x - heldX).toBeCloseTo(24 + 5, 9);
    const heldSince = shown.find((frame) => frame.x === heldX)?.othersTick ?? NaN;
    expect((goneAt ?? NaN) - heldSince).toBeCloseTo(maxTicks, 9);
    const flashFrame = 48.5;
    expect(goneAt).toBeLessThan(flashFrame);
  });

  it('отладка кадра — тики, нарисованный свой танк со смещением и снаряды', () => {
    const debug = pictureDebug(clock(5, 3), 4, [{ ...point(1, 2), tick: 4 }]);
    expect(debug).toEqual({
      myTick: 5,
      othersTick: 3,
      latestTick: 4,
      me: ME,
      ownShift: { x: 0, y: 0 },
      others: [ENEMY],
      bullets: [{ ...point(1, 2), tick: 4 }],
    });
    const shifted = pictureDebug({ ...clock(5, 3), ownShift: { x: 3, y: -4 } }, 4, []);
    expect(shifted).toMatchObject({ me: { x: 3, y: -4 }, ownShift: { x: 3, y: -4 } });
    expect(pictureDebug({ ...clock(5, 3), me: null }, 4, []).me).toBeNull();
  });
});

// Свой снаряд летит по прямой ходом step за тик; тики 0…to.
function ownTrack(tracks: BulletTracks, id: number, from: Point, step: Point, to: number): void {
  for (let tick = 0; tick <= to; tick++) {
    tracks.record(tick, [point(id, from.x + step.x * tick, from.y + step.y * tick, MY_OWNER)]);
  }
}

interface OwnFrame {
  othersTick: number;
  tick: number;
  x: number;
  y: number;
}

// Кадры по полтика хода тика чужих при разрыве gap; others — чужие танки в каждом кадре, me — свой танк в тике
// своего танка.
function ownFrames(
  tracks: BulletTracks,
  frames: number,
  gap: number,
  others: (frame: number) => Point[],
  start = 0,
  me: (myTick: number) => Point = () => ME,
): OwnFrame[] {
  const picture = new BulletPicture(tracks, MY_OWNER);
  const shown: OwnFrame[] = [];
  for (let frame = 0; frame < frames; frame++) {
    const othersTick = start + frame / 2;
    const myTick = othersTick + gap;
    const [bullet] = picture.frame({ myTick, othersTick, me: me(myTick), others: others(frame) });
    if (bullet !== undefined) {
      shown.push({ othersTick, tick: bullet.tick, x: bullet.x, y: bullet.y });
    }
  }
  return shown;
}

const CONTACT = 24 + 5;

// Свой снаряд стоит на броне танка: на окружности касания.
function isOnArmor(bullet: Point, tank: Point): boolean {
  return Math.hypot(bullet.x - tank.x, bullet.y - tank.y) <= CONTACT + 1e-9;
}

// Кадр, где свой снаряд ушёл с брони танка tank(кадр): в прошлом кадре на броне, в этом — нет; не уходил — за
// последним кадром.
function releaseIndex(frames: readonly OwnFrame[], tank: (frame: number) => Point): number {
  const index = frames.findIndex((frame, at) => {
    const previous = frames[at - 1];
    return previous !== undefined && isOnArmor(previous, tank(at - 1)) && !isOnArmor(frame, tank(at));
  });
  return index === -1 ? frames.length : index;
}

describe('время своего снаряда', () => {
  const GAP = 4;
  const STEP = 20;

  // Свой снаряд не заходит внутрь танка tank(кадр); ушёл с брони — по другую сторону танка, на окружности касания с
  // запасом двойного хода, и дальше за кадр сдвигается не больше двойного хода и хода танка tankStep.
  function expectReleasedBeyond(
    frames: readonly OwnFrame[],
    released: number,
    tank: (frame: number) => Point,
    tankStep: number,
  ): void {
    const doubleStep = STEP * PICTURE_CATCH_UP_RATE * 0.5;
    for (const [index, frame] of frames.entries()) {
      expect(Math.hypot(frame.x - tank(index).x, frame.y - tank(index).y)).toBeGreaterThanOrEqual(CONTACT - 1e-6);
      const previous = frames[index - 1];
      if (previous === undefined || index < released) {
        continue;
      }
      if (index === released) {
        const along = frame.x - tank(index).x;
        expect(along).toBeGreaterThan(0);
        expect(Math.hypot(frame.x - tank(index).x, frame.y - tank(index).y)).toBeLessThanOrEqual(CONTACT + doubleStep);
        continue;
      }
      const step = Math.hypot(frame.x - previous.x, frame.y - previous.y);
      expect(step).toBeLessThanOrEqual(doubleStep + tankStep + 1e-9);
    }
  }
  // Сближение снаряда с танком, стоящим на его пути: ход снаряда и ход самого быстрого танка за тик.
  const CLOSING = STEP + 220 / 30;
  const WINDOW = PICTURE_APPROACH_SPAN * GAP * CLOSING + PICTURE_NEAR;

  it('вдали от чужих — во времени своего танка: чужих нет, чужой сбоку, позади', () => {
    for (const others of [[], [{ x: 300, y: 700 }], [{ x: -700, y: 0 }]]) {
      const tracks = new BulletTracks();
      ownTrack(tracks, 1, { x: 100, y: 0 }, { x: STEP, y: 0 }, 60);
      const frames = ownFrames(tracks, 30, GAP, () => others, 10);
      expect(frames.every((frame) => frame.tick === frame.othersTick + GAP)).toBe(true);
    }
  });

  // Путь по прямой на окно подлёта при разрыве gap.
  function line(from: Point, step: Point, gap: number): Point[] {
    return Array.from({ length: PICTURE_APPROACH_SPAN * gap + 1 }, (_, tick) => ({
      x: from.x + step.x * tick,
      y: from.y + step.y * tick,
    }));
  }

  it('вес своего снаряда: у своего танка и без разрыва — 1, в зоне чужого — 0, на подлёте — по времени сближения', () => {
    const enemy = { x: 500, y: 0 };
    const step = { x: STEP, y: 0 };
    expect(ownBulletWeight(line({ x: 30, y: 0 }, step, GAP), ME, [{ x: 80, y: 0 }], GAP)).toBe(1);
    expect(ownBulletWeight(line({ x: 300, y: 0 }, step, GAP), ME, [enemy], 0)).toBe(1);
    expect(ownBulletWeight(line({ x: 450, y: 0 }, step, GAP), ME, [enemy], GAP)).toBe(0);
    const path = line({ x: 300, y: 0 }, step, GAP);
    expect(ownBulletWeight(path, ME, [enemy], GAP)).toBeCloseTo(
      (200 - PICTURE_NEAR) / CLOSING / (PICTURE_APPROACH_SPAN * GAP),
      12,
    );
    expect(ownBulletWeight(path, ME, [{ x: 0, y: 2000 }, enemy], GAP)).toBeLessThan(1);
    const back = line({ x: 150, y: 0 }, { x: -STEP, y: 0 }, GAP);
    expect(ownBulletWeight(back, ME, [{ x: 100, y: 0 }], GAP)).toBeCloseTo(
      1 - ((150 - PICTURE_NEAR) / CLOSING - 1) / (PICTURE_CATCH_UP_RATE * GAP),
      12,
    );
    expect(ownBulletWeight(back, null, [{ x: 100, y: 0 }], GAP)).toBe(0);
  });

  it('чужой впереди наискось, которого снаряд минует, даже если тот поедет навстречу, — вес 1 при любом разрыве', () => {
    const at = { x: 300, y: 0 };
    const path = line(at, { x: STEP, y: 0 }, 16);
    expect(ownBulletWeight(path, ME, [{ x: 700, y: 300 }], 16)).toBe(1);
    expect(ownBulletWeight(path, ME, [{ x: 700, y: 150 }], 16)).toBeLessThan(1);
    expect(ownBulletWeight(line(at, { x: 0, y: 0 }, 4), ME, [{ x: 400, y: 0 }], 4)).toBeCloseTo(
      (100 - PICTURE_NEAR) / (220 / 30) / (PICTURE_APPROACH_SPAN * 4),
      12,
    );
  });

  it('путь после отскока ведёт к чужому позади снаряда — вес меньше 1; путь кончился гибелью раньше — вес 1', () => {
    const enemy = { x: 300, y: 60 };
    const bounced = [
      ...Array.from({ length: 6 }, (_, tick) => ({ x: 400 + STEP * tick, y: 0 })),
      ...Array.from({ length: 7 }, (_, tick) => ({ x: 480 - STEP * tick, y: 0 })),
    ];
    expect(ownBulletWeight(line({ x: 400, y: 0 }, { x: STEP, y: 0 }, GAP), ME, [enemy], GAP)).toBe(1);
    expect(ownBulletWeight(bounced, ME, [enemy], GAP)).toBeLessThan(1);
    expect(ownBulletWeight(bounced.slice(0, 6), ME, [enemy], GAP)).toBe(1);
  });

  // В зоне чужого танка тик картинки — тик чужих либо сходит к нему с наибольшей скоростью.
  function expectAtOthersTime(frame: OwnFrame, previous: OwnFrame): void {
    const floor = previous.tick + PICTURE_MIN_TIME_RATE * (frame.othersTick - previous.othersTick);
    expect(frame.tick).toBeCloseTo(Math.max(frame.othersTick, floor), 9);
  }

  it('прямо на стоящий чужой танк: до окна подлёта — свой тик; на подлёте сходит не медленнее 2/3 хода; у зоны — тик чужих', () => {
    const enemy = { x: 1200, y: 0 };
    // Запас подлёта: за столько до касания снаряд рисуется впереди своей дорожки — и сходит быстрее.
    const leadReach = 24 + 5 + 6 * STEP;
    const tracks = new BulletTracks();
    ownTrack(tracks, 1, { x: 100, y: 0 }, { x: STEP, y: 0 }, 80);
    const frames = ownFrames(tracks, 120, GAP, () => [enemy]);
    const released = releaseIndex(frames, () => enemy);
    expect(released).toBeLessThan(frames.length);
    for (const [index, frame] of frames.entries()) {
      const previous = frames[index - 1];
      if (previous === undefined) {
        continue;
      }
      const step = frame.othersTick - previous.othersTick;
      const away = Math.abs(enemy.x - previous.x);
      if (away > WINDOW) {
        expect(frame.tick).toBe(frame.othersTick + GAP);
      }
      const slowest = away > leadReach ? 2 / 3 : PICTURE_MIN_TIME_RATE;
      if (index !== released) {
        expect(frame.tick - previous.tick).toBeGreaterThanOrEqual(slowest * step - 1e-9);
      }
      expect(frame.x).toBeGreaterThanOrEqual(previous.x);
      if (away <= PICTURE_NEAR && index < released) {
        expectAtOthersTime(frame, previous);
      }
    }
    expect(frames.some((frame) => enemy.x - frame.x <= PICTURE_NEAR)).toBe(true);
  });

  it('чужой едет навстречу на полном ходу: сход не быстрее половины хода, у зоны — тик чужих', () => {
    const tracks = new BulletTracks();
    ownTrack(tracks, 1, { x: 100, y: 0 }, { x: STEP, y: 0 }, 80);
    const enemyAt = (frame: number): Point => ({ x: 1400 - (220 / 30) * (frame / 2), y: 0 });
    const frames = ownFrames(tracks, 120, GAP, (frame) => [enemyAt(frame)]);
    const released = releaseIndex(frames, enemyAt);
    expect(released).toBeLessThan(frames.length);
    for (const [index, frame] of frames.entries()) {
      const previous = frames[index - 1];
      if (previous === undefined) {
        continue;
      }
      const step = frame.othersTick - previous.othersTick;
      if (index !== released) {
        expect(frame.tick - previous.tick).toBeGreaterThanOrEqual(PICTURE_MIN_TIME_RATE * step - 1e-9);
      }
      if (Math.abs(enemyAt(index - 1).x - previous.x) <= PICTURE_NEAR && index < released) {
        expectAtOthersTime(frame, previous);
      }
    }
  });

  it('пролетел мимо — возвращается к своему тику, по дорожке назад не идёт', () => {
    const tracks = new BulletTracks();
    ownTrack(tracks, 1, { x: 100, y: 0 }, { x: STEP, y: 0 }, 140);
    const frames = ownFrames(tracks, 240, GAP, () => [{ x: 900, y: 100 }]);
    const ticks = frames.map((frame) => frame.tick - frame.othersTick);
    expect(Math.min(...ticks)).toBeLessThan(GAP);
    expect(ticks.at(-1)).toBe(GAP);
    for (const [index, frame] of frames.entries()) {
      expect(frame.x).toBeGreaterThanOrEqual(frames[index - 1]?.x ?? -Infinity);
    }
  });

  it('пролетел впритирку мимо или чужой пропал — к своему тику догоняет не быстрее двойного хода, без рывка вперёд', () => {
    for (const gap of [GAP, 6, 16]) {
      const scenes: ((frame: number) => Point[])[] = [
        () => [{ x: 600, y: 70 }],
        (frame) => (frame < 20 ? [{ x: 700, y: 0 }] : []),
      ];
      for (const others of scenes) {
        const tracks = new BulletTracks();
        ownTrack(tracks, 1, { x: 40, y: 0 }, { x: STEP, y: 0 }, 120);
        const frames = ownFrames(tracks, 180, gap, others);
        for (const [index, frame] of frames.entries()) {
          const previous = frames[index - 1];
          if (previous === undefined) {
            continue;
          }
          expect(frame.tick - previous.tick).toBeLessThanOrEqual(PICTURE_CATCH_UP_RATE * 0.5 + 1e-9);
          expect(frame.x - previous.x).toBeLessThanOrEqual(STEP * PICTURE_CATCH_UP_RATE * 0.5 + 1e-9);
        }
        expect(frames.at(-1)?.tick).toBe((frames.at(-1)?.othersTick ?? NaN) + gap);
      }
    }
  });

  it('путь за дорожкой — полёт движка с отскоком: чужой позади, на пути после отскока, — снаряд сходит к его времени', () => {
    const map = { name: 'test', width: 1000, height: 600, walls: [], kits: [] };
    const zone = { startRadius: 9000, finalRadius: 9000, startShrink: 1000, endShrink: 1001 };
    const world = createWorld(map, [], DEFAULT_RULES, zone);
    world.tick = 10;
    const bullet = { id: 1, owner: MY_OWNER, x: 900, y: 300, vx: STEP / DT, vy: 0, damage: 0, age: 0 };
    world.bullets = [{ ...bullet, bouncesLeft: 1, hasBounced: false, isDead: false }];
    const tracks = new BulletTracks();
    tracks.record(10, world.bullets);
    const at = { myTick: 10, othersTick: 6, me: ME, others: [{ x: 870, y: 380 }] };
    expect(new BulletPicture(tracks, MY_OWNER).frame(at)[0]?.tick).toBe(10);
    const flight = new BulletTracks();
    recordFlight(flight, world, MY_OWNER, flightEndTick(at));
    expect(flight.lastTick()).toBe(flightEndTick(at));
    expect(flight.at(1, 15)?.x).toBeLessThan(1000);
    expect(new BulletPicture(tracks, MY_OWNER, flight).frame(at)[0]?.tick).toBeLessThan(10);

    world.bullets = [{ ...bullet, bouncesLeft: 0, hasBounced: true, isDead: false }];
    recordFlight(flight, world, MY_OWNER, flightEndTick(at));
    expect(flight.at(1, 15)).toBeNull();
    expect(new BulletPicture(tracks, MY_OWNER, flight).frame(at)[0]?.tick).toBe(10);
  });

  it('мимо чужого обратно к своему танку — входит в его тик заранее, через зону своего танка не перепрыгивает', () => {
    for (const gap of [GAP, 6, 16]) {
      for (const passBy of [0, 40, 70]) {
        const tracks = new BulletTracks();
        ownTrack(tracks, 1, { x: 1000, y: passBy }, { x: -STEP, y: 0 }, 100);
        const frames = ownFrames(tracks, 160, gap, () => [{ x: 300, y: passBy + 90 }]);
        for (const [index, frame] of frames.entries()) {
          const previous = frames[index - 1];
          if (previous !== undefined) {
            expect(previous.x - frame.x).toBeLessThanOrEqual(STEP * PICTURE_CATCH_UP_RATE * 0.5 + 1e-9);
          }
        }
        expect(frames.some((frame) => frame.tick < frame.othersTick + gap)).toBe(true);
      }
    }
  });

  it('промах сквозь нарисованного врага: на броне — время чужих, уходит с места на броне и догоняет своё без рывка', () => {
    const far = { x: -2000, y: 0 };
    for (const gap of [GAP, 6, 8]) {
      for (const enemy of [
        { x: 130, y: 0 },
        { x: 200, y: 0 },
        { x: 200, y: 20 },
      ]) {
        for (const me of [ME, far]) {
          const tracks = new BulletTracks();
          ownTrack(tracks, 1, { x: 40, y: 0 }, { x: STEP, y: 0 }, 100);
          const frames = ownFrames(
            tracks,
            140 + 2 * gap,
            gap,
            () => [enemy],
            -gap,
            () => me,
          );
          const released = releaseIndex(frames, () => enemy);
          expect(released).toBeLessThan(frames.length);
          expectReleasedBeyond(frames, released, () => enemy, 0);
          for (const [index, frame] of frames.entries()) {
            const previous = frames[index - 1];
            if (previous === undefined) {
              continue;
            }
            if (index < released && isOnArmor(previous, enemy)) {
              expectAtOthersTime(frame, previous);
            }
            if (index > released) {
              expect(frame.tick - previous.tick).toBeLessThanOrEqual(PICTURE_CATCH_UP_RATE * 0.5 + 1e-9);
            }
          }
          expect(frames.at(-1)?.tick).toBe((frames.at(-1)?.othersTick ?? NaN) + gap);
        }
      }
    }
  });

  it('промах в упор по врагу вплотную к своему танку: уходит с брони в зоне своего танка и догоняет своё без рывка', () => {
    for (const gap of [GAP, 6, 8]) {
      for (const enemy of [
        { x: 60, y: 15 },
        { x: 70, y: -20 },
      ]) {
        const tracks = new BulletTracks();
        ownTrack(tracks, 1, { x: 40, y: 0 }, { x: STEP, y: 0 }, 100);
        const frames = ownFrames(tracks, 80, gap, () => [enemy], -gap);
        const released = releaseIndex(frames, () => enemy);
        expect(released).toBeLessThan(frames.length);
        expectReleasedBeyond(frames, released, () => enemy, 0);
        expect(frames.at(-1)?.tick).toBe((frames.at(-1)?.othersTick ?? NaN) + gap);
      }
    }
  });

  it('промах сквозь врага, который везёт снаряд на броне навстречу выстрелу, — уходит с места на броне без рывка', () => {
    const tankStep = 220 / 30 / 2;
    for (const gap of [GAP, 6, 8]) {
      for (const y of [0, 15]) {
        const tracks = new BulletTracks();
        ownTrack(tracks, 1, { x: 40, y: 0 }, { x: STEP, y: 0 }, 100);
        const enemy = (frame: number): Point => ({ x: 260 - tankStep * frame, y });
        const frames = ownFrames(tracks, 140, gap, (frame) => [enemy(frame)], -gap);
        const released = releaseIndex(frames, enemy);
        expect(released).toBeLessThan(frames.length);
        expectReleasedBeyond(frames, released, enemy, tankStep);
      }
    }
  });

  it('промах сквозь врага, который увозит снаряд на броне поперёк пути, — уходит с брони, не проходя сквозь корпус', () => {
    const tankStep = 220 / 30 / 2;
    for (const gap of [GAP, 6, 8]) {
      for (const [y, direction] of [
        [20, -1],
        [-20, 1],
        [10, 1],
      ] as const) {
        const tracks = new BulletTracks();
        ownTrack(tracks, 1, { x: 40, y: 0 }, { x: STEP, y: 0 }, 100);
        const arrival = 2 * (7 + gap);
        const enemy = (frame: number): Point => ({ x: 200, y: y + direction * tankStep * (frame - arrival) });
        const frames = ownFrames(tracks, 140, gap, (frame) => [enemy(frame)], -gap);
        const released = releaseIndex(frames, enemy);
        expect(released).toBeLessThan(frames.length);
        expectReleasedBeyond(frames, released, enemy, tankStep);
      }
    }
  });

  it('ушедший с брони «мимо» снаряд летит во второй танк на пути — встаёт на его броню, а не в корпус', () => {
    const first = { x: 200, y: 0 };
    const second = { x: 400, y: 10 };
    for (const gap of [GAP, 6, 8]) {
      const tracks = new BulletTracks();
      ownTrack(tracks, 1, { x: 40, y: 0 }, { x: STEP, y: 0 }, 100);
      const frames = ownFrames(tracks, 140, gap, () => [first, second], -gap);
      for (const frame of frames) {
        expect(Math.hypot(frame.x - first.x, frame.y - first.y)).toBeGreaterThanOrEqual(CONTACT - 1e-6);
        expect(Math.hypot(frame.x - second.x, frame.y - second.y)).toBeGreaterThanOrEqual(CONTACT - 1e-6);
      }
      expect(frames.some((frame) => isOnArmor(frame, first))).toBe(true);
      expect(frames.some((frame) => isOnArmor(frame, second))).toBe(true);
      expect(frames.at(-1)?.x).toBeGreaterThan(second.x + CONTACT);
    }
  });

  it('промах в упор с отскоком назад сквозь врага — снаряд ни в одном кадре не внутри корпуса', () => {
    const enemy = { x: 80, y: 0 };
    for (const gap of [GAP, 6, 8]) {
      const tracks = new BulletTracks();
      for (let tick = 0; tick <= 60; tick++) {
        const x = 20 + STEP * tick;
        tracks.record(tick, [point(1, x <= 160 ? x : 320 - x, 0, MY_OWNER)]);
      }
      const frames = ownFrames(tracks, 140, gap, () => [enemy], -gap);
      expect(frames.some((frame) => isOnArmor(frame, enemy))).toBe(true);
      for (const frame of frames) {
        expect(Math.hypot(frame.x - enemy.x, frame.y - enemy.y)).toBeGreaterThanOrEqual(CONTACT - 1e-6);
      }
    }
  });

  it('«мимо» с отскоком от стены у самого врага — уходит с брони до половины предела ожидания и встаёт на броню второго врага', () => {
    const enemy = { x: 200, y: 0 };
    const wall = 185;
    const behind = { x: wall - 200, y: 400 };
    for (const gap of [GAP, 6, 8]) {
      const tracks = new BulletTracks();
      for (let tick = 0; tick <= 60; tick++) {
        const x = 15 + STEP * tick;
        tracks.record(tick, [point(1, x <= wall ? x : 2 * wall - x, x <= wall ? 0 : 2 * (x - wall), MY_OWNER)]);
      }
      const frames = ownFrames(tracks, 140, gap, () => [enemy, behind], -gap);
      const released = releaseIndex(frames, () => enemy);
      expect(released).toBeLessThan(frames.length);
      const held = frames.slice(0, released).filter((frame) => isOnArmor(frame, enemy));
      expect((held.length - 1) / 2).toBeLessThan(EVENT_MAX_WAIT_MS / 1000 / DT / 2);
      const leave = frames[released] ?? { x: 0, y: 0 };
      expect(Math.hypot(leave.x - enemy.x, leave.y - enemy.y)).toBeGreaterThan(CONTACT);
      for (const frame of frames) {
        expect(Math.hypot(frame.x - enemy.x, frame.y - enemy.y)).toBeGreaterThanOrEqual(CONTACT - 1e-6);
        expect(Math.hypot(frame.x - behind.x, frame.y - behind.y)).toBeGreaterThanOrEqual(CONTACT - 1e-6);
      }
      expect(frames.some((frame) => isOnArmor(frame, behind))).toBe(true);
    }
  });

  it('досчитанная у своего танка гибель на броне отменилась — снаряд не пролетает сквозь корпус', () => {
    const enemy = { x: 200, y: 0 };
    const me = { x: 200, y: 100 };
    const death = 10;
    const alive = (tick: number): TrackPoint[] => [point(1, 15 + STEP * tick, 0, MY_OWNER)];
    for (const gap of [GAP, 6, 8]) {
      const tracks = new BulletTracks();
      for (let tick = 0; tick <= 40; tick++) {
        tracks.record(tick, tick < death ? alive(tick) : []);
      }
      const picture = new BulletPicture(tracks, MY_OWNER);
      const revived: Point[] = [];
      let isHeld = false;
      let isRevived = false;
      for (let frame = 0; frame < 50; frame++) {
        const othersTick = frame / 2;
        const [bullet] = picture.frame({ myTick: othersTick + gap, othersTick, me, others: [enemy] });
        if (isRevived && bullet !== undefined) {
          revived.push(bullet);
        }
        isHeld ||= bullet !== undefined && isOnArmor(bullet, enemy);
        if (isHeld && !isRevived && bullet === undefined) {
          tracks.forgetFrom(death);
          for (let tick = death; tick <= 40; tick++) {
            tracks.record(tick, alive(tick));
          }
          isRevived = true;
        }
      }
      expect(revived.length).toBeGreaterThan(0);
      for (const bullet of revived) {
        expect(Math.hypot(bullet.x - enemy.x, bullet.y - enemy.y)).toBeGreaterThanOrEqual(CONTACT - 1e-6);
      }
    }
  });

  it('танк под снарядом на броне пропал с картинки — снаряд пропадает и на броню соседа не переходит', () => {
    const enemy = { x: 200, y: 0 };
    const neighbour = { x: 200, y: 60 };
    const tracks = new BulletTracks();
    for (let tick = 0; tick <= 40; tick++) {
      tracks.record(tick, tick < 8 ? [point(1, 40 + STEP * tick, 0, MY_OWNER)] : []);
    }
    const frames = ownFrames(tracks, 60, GAP, (frame) => (frame < 10 ? [enemy, neighbour] : [neighbour]));
    expect(frames.some((frame) => isOnArmor(frame, enemy))).toBe(true);
    expect(frames.every((frame) => frame.othersTick < 5)).toBe(true);
    expect(frames.some((frame) => isOnArmor(frame, neighbour))).toBe(false);
  });

  it('отставший у чужого снаряд отскочил к своему танку, который едет навстречу, — входит в его зону без рывка', () => {
    const wall = 400;
    for (const gap of [GAP, 6, 16]) {
      for (const enemyY of [40, 70]) {
        const tracks = new BulletTracks();
        let at = { x: 60, y: 0 };
        let vx = STEP;
        for (let tick = 0; tick <= 100; tick++) {
          tracks.record(tick, [point(1, at.x, at.y, MY_OWNER)]);
          const x = at.x + vx;
          vx = x > wall ? -vx : vx;
          at = { x: x > wall ? 2 * wall - x : x, y: at.y + STEP * 0.02 };
        }
        const me = (myTick: number): Point => ({ x: Math.min(250, (220 / 30) * myTick), y: 0 });
        const frames = ownFrames(tracks, 160, gap, () => [{ x: 330, y: enemyY }], 0, me);
        const entered = frames.findIndex((frame, index) => {
          const previous = frames[index - 1];
          const myTick = frame.othersTick + gap;
          const isInZone = (bullet: Point, tank: Point): boolean =>
            Math.hypot(bullet.x - tank.x, bullet.y - tank.y) <= PICTURE_NEAR;
          return previous !== undefined && isInZone(frame, me(myTick)) && !isInZone(previous, me(myTick - 0.5));
        });
        expect(entered).toBeGreaterThan(0);
        const [previous, frame] = [frames[entered - 1], frames[entered]];
        const step = Math.hypot((frame?.x ?? NaN) - (previous?.x ?? NaN), (frame?.y ?? NaN) - (previous?.y ?? NaN));
        expect(step).toBeLessThanOrEqual(STEP * PICTURE_CATCH_UP_RATE * 0.5 + 1e-9);
      }
    }
  });

  it('выстрел в чужого рядом со своим танком — выйдя из зоны своего танка, снаряд не отстаёт в неё обратно', () => {
    for (const gap of [GAP, 6, 16]) {
      for (const enemy of [
        { x: 230, y: 60 },
        { x: 200, y: 70 },
      ]) {
        const tracks = new BulletTracks();
        for (let tick = gap; tick <= gap + 60; tick++) {
          tracks.record(tick, [point(1, 30 + STEP * (tick - gap), 0, MY_OWNER)]);
        }
        const frames = ownFrames(tracks, 60, gap, () => [enemy]);
        for (const [index, frame] of frames.entries()) {
          const previous = frames[index - 1];
          if (previous !== undefined && Math.hypot(frame.x, frame.y) > PICTURE_NEAR) {
            expect(frame.tick - previous.tick).toBeLessThanOrEqual(PICTURE_CATCH_UP_RATE * 0.5 + 1e-9);
          }
        }
      }
    }
  });

  it('чужой появился у снаряда — сход с наибольшей скоростью', () => {
    const tracks = new BulletTracks();
    ownTrack(tracks, 1, { x: 100, y: 0 }, { x: STEP, y: 0 }, 80);
    const frames = ownFrames(tracks, 30, GAP, (frame) => (frame < 10 ? [] : [{ x: 100 + STEP * 20, y: 40 }]), 10);
    const appeared = frames.slice(11, 15);
    for (const [index, frame] of appeared.entries()) {
      const previous = frames[10 + index];
      expect(frame.tick - (previous?.tick ?? NaN)).toBeCloseTo(PICTURE_MIN_TIME_RATE * 0.5, 9);
    }
  });

  it('свой танк догоняет время предсказания, выстрел родился впереди его тика — снаряд вдали от чужих в своём тике', () => {
    const tracks = new BulletTracks();
    for (let tick = 21; tick <= 30; tick++) {
      tracks.record(tick, [point(1, 100 + STEP * (tick - 21), 0, MY_OWNER)]);
    }
    const picture = new BulletPicture(tracks, MY_OWNER);
    expect(picture.frame(clock(20.5, 17, [{ x: 100, y: 500 }]))[0]?.tick).toBe(20.5);
  });

  it('своего танка нет и разрыва нет — свой тик, без деления на ноль', () => {
    const tracks = new BulletTracks();
    ownTrack(tracks, 1, { x: 100, y: 0 }, { x: STEP, y: 0 }, 40);
    const picture = new BulletPicture(tracks, MY_OWNER);
    expect(picture.frame({ myTick: 20, othersTick: 20, me: null, others: [{ x: 600, y: 0 }] })[0]?.tick).toBe(20);
    expect(picture.frame({ myTick: 21, othersTick: 17, me: null, others: [] })[0]?.tick).toBe(21);
  });
});

interface TestEvent {
  kind: PictureEventKind;
  x: number;
  y: number;
}

describe('события на картинке', () => {
  it('о чужом танке — когда его картинка дошла до тика; точка — на нарисованном танке', () => {
    const schedule = new EventSchedule<TestEvent>();
    const hit: TestEvent = { kind: 'hit', x: 990, y: 5 };
    schedule.add(hit, 20, eventPlace('hit', { id: 2, x: 1000, y: 0 }, MY_TANK), 0);
    const drawn = (): { x: number; y: number } => ({ x: 980, y: 10 });
    expect(schedule.release(clock(23, 19), drawn, 10)).toEqual([]);
    expect(schedule.release(clock(23, 19.1), drawn, 20)).toEqual([{ event: { ...hit, x: 970, y: 15 }, tick: 20 }]);
    expect(schedule.release(clock(30, 25), drawn, 30)).toEqual([]);
  });

  it('о своём танке и у своего танка — сразу; без места — сразу; порядок прихода сохранён', () => {
    const schedule = new EventSchedule<TestEvent>();
    schedule.add({ kind: 'ricochet', x: 990, y: 0 }, 20, eventPlace('ricochet', null, MY_TANK), 0);
    schedule.add({ kind: 'hit', x: 5, y: 0 }, 20, eventPlace('hit', { id: MY_TANK, x: 0, y: 0 }, MY_TANK), 0);
    schedule.add({ kind: 'ricochet', x: 20, y: 0 }, 20, eventPlace('ricochet', null, MY_TANK), 0);
    schedule.add({ kind: 'zoneStart', x: 0, y: 0 }, 20, eventPlace('zoneStart', null, MY_TANK), 0);
    const due = schedule.release(clock(23, 18), () => ME, 0);
    expect(due.map(({ event }) => `${event.kind}@${String(event.x)}`)).toEqual(['hit@5', 'ricochet@20', 'zoneStart@0']);
    expect(schedule.release(clock(23, 19.5), () => null, 0).map(({ event }) => event.kind)).toEqual(['ricochet']);
  });

  it('точка в поле сдвинута у своего танка, как снаряд: у своего — на всё смещение, у чужого — нет', () => {
    const schedule = new EventSchedule<TestEvent>();
    const shifted: PictureClock = { ...clock(23, 20), ownShift: { x: 3, y: -4 } };
    schedule.add({ kind: 'ricochet', x: 20, y: 0 }, 20, eventPlace('ricochet', null, MY_TANK), 0);
    schedule.add({ kind: 'impact', x: 990, y: 0 }, 20, eventPlace('impact', null, MY_TANK), 0);
    schedule.add({ kind: 'hit', x: 5, y: 0 }, 20, eventPlace('hit', { id: MY_TANK, x: 0, y: 0 }, MY_TANK), 0);
    const due = schedule.release(shifted, () => ({ x: 3, y: -4 }), 0).map(({ event }) => event);
    expect(due).toEqual([
      { kind: 'ricochet', x: 23, y: -4 },
      { kind: 'impact', x: 990, y: 0 },
      { kind: 'hit', x: 8, y: -4 },
    ]);
  });

  it('смертельное попадание по себе — сразу на своём танке, даже когда своего танка на поле уже нет', () => {
    const schedule = new EventSchedule<TestEvent>();
    const death: TestEvent = { kind: 'death', x: 500, y: 0 };
    schedule.add(death, 20, eventPlace('death', { id: MY_TANK, x: 500, y: 0 }, MY_TANK), 0);
    const due = schedule.release({ ...clock(19, 17), me: null }, () => ({ x: 510, y: 0 }), 0);
    expect(due).toEqual([{ event: { ...death, x: 510 }, tick: 20 }]);
  });

  it('танк пропал с картинки — время по точке события; не дождалось предела — выброшено молча', () => {
    const schedule = new EventSchedule<TestEvent>();
    const death: TestEvent = { kind: 'death', x: 1000, y: 0 };
    schedule.add(death, 20, eventPlace('death', { id: 2, x: 1000, y: 0 }, MY_TANK), 100);
    expect(schedule.release(clock(23, 10), () => null, 100 + EVENT_MAX_WAIT_MS - 1)).toEqual([]);
    expect(schedule.release(clock(23, 10), () => null, 100 + EVENT_MAX_WAIT_MS)).toEqual([]);
    expect(schedule.release(clock(40, 40), () => null, 100 + EVENT_MAX_WAIT_MS + 1)).toEqual([]);
    schedule.add(death, 21, eventPlace('death', null, MY_TANK), 0);
    schedule.clear();
    expect(schedule.release(clock(40, 40), () => null, 10)).toEqual([]);
  });

  it('фоновая вкладка: просроченные события не копятся и после возврата не выходят разом', () => {
    const schedule = new EventSchedule<TestEvent>();
    for (let index = 0; index < 100; index++) {
      schedule.add(
        { kind: 'hit', x: 1000, y: 0 },
        index,
        eventPlace('hit', { id: 2, x: 1000, y: 0 }, MY_TANK),
        index * 33,
      );
    }
    const now = 99 * 33 + 1;
    const due = schedule.release(clock(200, 200), () => ENEMY, now);
    expect(due.length).toBeLessThanOrEqual(Math.ceil(EVENT_MAX_WAIT_MS / 33));
    expect(due.every(({ tick }) => now - tick * 33 < EVENT_MAX_WAIT_MS)).toBe(true);
  });

  it('место события по виду; о своём танке — сразу', () => {
    const tank = { id: 3, x: 1, y: 2 };
    expect(eventPlace('shot', tank, MY_TANK)).toEqual({ kind: 'tank', id: 3, x: 1, y: 2, isOwn: false });
    expect(eventPlace('shield', tank, 3)).toEqual({ kind: 'tank', id: 3, x: 1, y: 2, isOwn: true });
    expect(eventPlace('hit', tank, null)).toEqual({ kind: 'tank', id: 3, x: 1, y: 2, isOwn: false });
    expect(eventPlace('death', null, MY_TANK)).toEqual({ kind: 'point' });
    expect(eventPlace('impact', tank, MY_TANK)).toEqual({ kind: 'point' });
    expect(eventPlace('matchOver', null, MY_TANK)).toEqual({ kind: 'now' });
    expect(eventPlace('suddenDeath', null, MY_TANK)).toEqual({ kind: 'now' });
    expect(eventPlace('roundOver', null, MY_TANK)).toEqual({ kind: 'now' });
  });
});

describe('тик своего танка', () => {
  it('танк на поле — тик предсказания, без сглаживания', () => {
    const own = new OwnTime();
    expect(own.next(20, 15)).toBe(20);
    expect(own.next(21, 15.5)).toBe(21);
    expect(own.next(20, 16)).toBe(20);
  });

  it('гибель: не прыгает к тику чужих, идёт вдвое медленнее, пока не совпадёт', () => {
    const own = new OwnTime();
    own.next(20, 15);
    let previous = 20;
    let othersTick = 15;
    while (previous > othersTick) {
      othersTick += 0.5;
      const tick = own.next(null, othersTick);
      expect(tick).toBeCloseTo(Math.max(othersTick, previous + PICTURE_MIN_TIME_RATE * 0.5), 9);
      expect(tick).toBeGreaterThanOrEqual(previous);
      previous = tick;
    }
    expect(othersTick).toBe(25);
    expect(own.next(null, 26)).toBe(26);
    expect(own.next(null, 26)).toBe(26);
  });

  it('возрождение: догоняет тик предсказания вдвое быстрее тика чужих, дальше равен ему', () => {
    const own = new OwnTime();
    own.next(null, 30);
    expect(own.next(36, 30.5)).toBeCloseTo(30 + PICTURE_CATCH_UP_RATE * 0.5, 9);
    expect(own.next(36.5, 31)).toBeCloseTo(32, 9);
    let tick = 32;
    let othersTick = 31;
    for (let frame = 0; frame < 20 && tick < 36 + frame; frame++) {
      othersTick += 0.5;
      tick = own.next(36 + frame, othersTick);
    }
    expect(own.next(50, othersTick + 0.5)).toBe(50);
  });

  it('первый кадр без своего танка — тик чужих; танк появился — догоняет', () => {
    const own = new OwnTime();
    expect(own.next(null, 10)).toBe(10);
    expect(own.next(15, 10.5)).toBe(11);
  });
});

describe('исход стояния на броне', () => {
  const enemy = { x: 100, y: 0 };

  function straightOwn(tracks: BulletTracks, lastTick: number): void {
    for (let tick = 0; tick <= lastTick; tick++) {
      tracks.record(tick, [point(1, 20 * tick, 0, MY_OWNER), point(2, 20 * tick, 300, 7)]);
    }
  }

  it('картинка дошла до гибели на броне — взрыв, ожидание — ход тика чужих от касания', () => {
    const tracks = new BulletTracks();
    straightOwn(tracks, 4);
    tracks.record(5, []);
    const picture = new BulletPicture(tracks, MY_OWNER);
    picture.frame({ myTick: 8, othersTick: 3.6, me: null, others: [enemy] });
    expect(picture.takeHoldEnds()).toEqual([]);
    picture.frame({ myTick: 8, othersTick: 4, me: null, others: [enemy] });
    expect(picture.takeHoldEnds()).toEqual([]);
    picture.frame({ myTick: 9, othersTick: 4.5, me: null, others: [enemy] });
    const [end, ...rest] = picture.takeHoldEnds();
    expect(rest).toEqual([]);
    expect(end?.id).toBe(1);
    expect(end?.outcome).toBe('boom');
    expect(end?.ticks).toBeCloseTo(0.9, 9);
    expect(picture.takeHoldEnds()).toEqual([]);
  });

  it('сервер решил «мимо» — уход с брони', () => {
    const tracks = new BulletTracks();
    straightOwn(tracks, 4);
    const picture = new BulletPicture(tracks, MY_OWNER);
    picture.frame({ myTick: 5, othersTick: 3.6, me: null, others: [enemy] });
    tracks.forgetFrom(5);
    for (let tick = 5; tick <= 8; tick++) {
      tracks.record(tick, [point(1, 20 * tick, 0, MY_OWNER)]);
    }
    picture.frame({ myTick: 7, othersTick: 6, me: null, others: [enemy] });
    expect(picture.takeHoldEnds()).toEqual([{ id: 1, ticks: expect.closeTo(2.4, 9) as number, outcome: 'miss' }]);
  });

  it('танк под снарядом пропал с картинки — потерян; пропал вместе с погибшим снарядом — взрыв', () => {
    const tracks = new BulletTracks();
    straightOwn(tracks, 10);
    const picture = new BulletPicture(tracks, MY_OWNER);
    picture.frame({ myTick: 8, othersTick: 3.6, me: null, others: [enemy] }, 3);
    picture.frame({ myTick: 8, othersTick: 4, me: null, others: [] }, 3);
    expect(picture.takeHoldEnds().map((end) => end.outcome)).toEqual(['lost']);

    const killed = new BulletTracks();
    straightOwn(killed, 4);
    killed.record(5, []);
    const kill = new BulletPicture(killed, MY_OWNER);
    kill.frame({ myTick: 8, othersTick: 3.6, me: null, others: [enemy] });
    kill.frame({ myTick: 8, othersTick: 3.8, me: null, others: [] });
    expect(kill.takeHoldEnds().map((end) => end.outcome)).toEqual(['boom']);
  });

  it('ответа нет дольше предела ожидания — по пределу', () => {
    const tracks = new BulletTracks();
    straightOwn(tracks, 40);
    const picture = new BulletPicture(tracks, MY_OWNER);
    const waitTicks = EVENT_MAX_WAIT_MS / (DT * 1000);
    const frame = (othersTick: number): void => {
      picture.frame({ myTick: othersTick + 4, othersTick, me: null, others: [enemy] }, 3);
    };
    frame(3.6);
    frame(3.6 + waitTicks / 2);
    expect(picture.takeHoldEnds()).toEqual([]);
    frame(3.6 + waitTicks);
    expect(picture.takeHoldEnds()).toEqual([
      { id: 1, ticks: expect.closeTo(waitTicks, 9) as number, outcome: 'timeout' },
    ]);
  });

  it('чужой снаряд у чужого танка на броню не встаёт — исходов нет', () => {
    const tracks = new BulletTracks();
    for (let tick = 0; tick <= 4; tick++) {
      tracks.record(tick, [point(2, 20 * tick, 0, 7)]);
    }
    tracks.record(5, []);
    const picture = new BulletPicture(tracks, MY_OWNER);
    for (let othersTick = 3; othersTick <= 6; othersTick += 0.5) {
      picture.frame({ myTick: othersTick + 4, othersTick, me: null, others: [enemy] });
    }
    expect(picture.takeHoldEnds()).toEqual([]);
  });
});
