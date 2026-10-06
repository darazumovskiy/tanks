import { describe, expect, it } from 'vitest';
import type { Point } from '@tanks/shared/engine';
import {
  BulletPicture,
  BulletTracks,
  EVENT_MAX_WAIT_MS,
  EventSchedule,
  eventPlace,
  OwnTime,
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
    const flying = picture.frame({ myTick: 7, othersTick: 6, me: null, others: [enemy] });
    expect(flying.find((bullet) => bullet.id === 1)?.x).toBeGreaterThan(100);
    expect(flying.find((bullet) => bullet.id === 2)).toBeUndefined();
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
    const released = frame(5.5, [enemy]);
    expect(released?.x).toBeCloseTo(120, 9);
    expect(released?.y).toBeCloseTo(40, 9);
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

  it('отладка кадра — тики, свой танк и снаряды', () => {
    const debug = pictureDebug(clock(5, 3), 4, [{ ...point(1, 2), tick: 4 }]);
    expect(debug).toEqual({
      myTick: 5,
      othersTick: 3,
      latestTick: 4,
      me: ME,
      others: [ENEMY],
      bullets: [{ ...point(1, 2), tick: 4 }],
    });
    expect(pictureDebug({ ...clock(5, 3), me: null }, 4, []).me).toBeNull();
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
