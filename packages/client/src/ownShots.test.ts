import { describe, expect, it } from 'vitest';
import { OwnShots, type DueShot } from './ownShots.js';

interface Shot {
  name: string;
}

// Сервер исполняет команду в тик с тем же номером: тик выстрела в досчёте равен номеру его команды.
function shot(name: string, tick: number): DueShot<Shot> {
  return { event: { name }, tick };
}

function names(shots: readonly DueShot<Shot>[]): string[] {
  return shots.map(({ event }) => event.name);
}

// Снимок тика ackSeq с подтверждённой командой ackSeq и живым своим танком.
function settle(shots: OwnShots<Shot>, ackSeq: number, server: readonly Shot[] = []): Set<Shot> {
  return shots.settle(ackSeq, ackSeq, server, true);
}

describe('свой выстрел по предсказанию', () => {
  it('выстрел в шаге ввода — в ближайший кадр один раз; переигрывания не повторяют; снимок с выстрелом — сыгран', () => {
    const shots = new OwnShots<Shot>();
    shots.fired(4, shot('a', 4));
    shots.fired(5, null);
    expect(shots.takeDue()).toEqual([shot('a', 4)]);
    expect(shots.takeDue()).toEqual([]);
    shots.replayed(new Map([[4, shot('a2', 4)]]));
    shots.fired(4, shot('a3', 4));
    expect(shots.takeDue()).toEqual([]);
    const server: Shot = { name: 'server' };
    expect(settle(shots, 4, [server])).toEqual(new Set([server]));
    expect(shots.counts).toEqual({ played: 1, confirmed: 1, unconfirmed: 0 });
  });

  it('сервер подтвердил команду без выстрела — выстрел ждёт перезарядку, потом неподтверждённый; не дошедший до кадра — не играется', () => {
    const shots = new OwnShots<Shot>();
    shots.fired(4, shot('a', 4));
    shots.takeDue();
    shots.fired(9, shot('b', 9));
    expect(settle(shots, 9)).toEqual(new Set());
    expect(shots.takeDue()).toEqual([]);
    expect(shots.counts).toEqual({ played: 1, confirmed: 0, unconfirmed: 0 });
    settle(shots, 18);
    expect(shots.counts.unconfirmed).toBe(0);
    settle(shots, 19);
    expect(shots.counts).toEqual({ played: 1, confirmed: 0, unconfirmed: 1 });
    expect(settle(shots, 20, [{ name: 'late' }])).toEqual(new Set());
  });

  it('переигрывание перенесло выстрел на команду раньше, сервер подтвердил её без выстрела и выстрелил командой позже — вспышка одна', () => {
    const shots = new OwnShots<Shot>();
    shots.fired(393, shot('a', 393));
    shots.takeDue();
    shots.replayed(new Map([[391, shot('earlier', 391)]]));
    expect(settle(shots, 391)).toEqual(new Set());
    shots.replayed(new Map([[392, shot('again', 392)]]));
    expect(shots.takeDue()).toEqual([]);
    const server: Shot = { name: 'server' };
    expect(settle(shots, 392, [server])).toEqual(new Set([server]));
    expect(shots.counts).toEqual({ played: 1, confirmed: 1, unconfirmed: 0 });
  });

  it('переигрывание больше не видит сыгранный выстрел, а шаг ввода выстрелил — вспышка одна', () => {
    const shots = new OwnShots<Shot>();
    shots.replayed(new Map([[511, shot('a', 511)]]));
    shots.takeDue();
    shots.replayed(new Map());
    shots.fired(514, shot('again', 514));
    expect(shots.takeDue()).toEqual([]);
    const server: Shot = { name: 'server' };
    expect(settle(shots, 511)).toEqual(new Set());
    expect(settle(shots, 514, [server])).toEqual(new Set([server]));
    expect(shots.counts).toEqual({ played: 1, confirmed: 1, unconfirmed: 0 });
  });

  it('переигрывание перенесло выстрел на команду позже — вспышка одна; ждущий кадра — с местом нового шага', () => {
    const shots = new OwnShots<Shot>();
    shots.fired(4, shot('a', 4));
    shots.takeDue();
    shots.replayed(new Map([[6, shot('later', 6)]]));
    expect(shots.takeDue()).toEqual([]);
    const server: Shot = { name: 'server' };
    expect(settle(shots, 6, [server])).toEqual(new Set([server]));
    expect(shots.counts).toEqual({ played: 1, confirmed: 1, unconfirmed: 0 });

    shots.fired(20, shot('b', 20));
    shots.replayed(new Map([[22, shot('b-later', 22)]]));
    expect(names(shots.takeDue())).toEqual(['b-later']);
  });

  it('новый выстрел в переигрывании без пропавшего — играется; два выстрела — по порядку команд', () => {
    const shots = new OwnShots<Shot>();
    shots.replayed(
      new Map([
        [12, shot('c', 12)],
        [3, shot('a', 3)],
      ]),
    );
    expect(names(shots.takeDue())).toEqual(['a', 'c']);
    const first: Shot = { name: 's1' };
    const second: Shot = { name: 's2' };
    expect(settle(shots, 3, [first])).toEqual(new Set([first]));
    expect(settle(shots, 12, [second])).toEqual(new Set([second]));
    expect(shots.counts).toEqual({ played: 2, confirmed: 2, unconfirmed: 0 });
  });

  it('сервер выстрелил повтором прошлой команды до подтверждения сыгранной — выстрел снимка сыгран, позже ничего', () => {
    const shots = new OwnShots<Shot>();
    shots.fired(5, shot('a', 5));
    shots.takeDue();
    const early: Shot = { name: 'early' };
    expect(settle(shots, 3, [early])).toEqual(new Set([early]));
    shots.replayed(new Map([[5, shot('a-again', 5)]]));
    expect(shots.takeDue()).toEqual([]);
    expect(settle(shots, 5)).toEqual(new Set());
    expect(shots.counts).toEqual({ played: 1, confirmed: 1, unconfirmed: 0 });
  });

  it('фантомный выстрел ждёт подтверждения, сервер выстрелил позже — снимок забирает ближний, фантом неподтверждён, следующий выстрел со вспышкой', () => {
    const shots = new OwnShots<Shot>();
    shots.fired(10, shot('phantom', 10));
    shots.takeDue();
    settle(shots, 10);
    settle(shots, 24);
    shots.fired(26, shot('real', 26));
    expect(names(shots.takeDue())).toEqual(['real']);
    const server: Shot = { name: 'server' };
    expect(settle(shots, 26, [server])).toEqual(new Set([server]));
    expect(shots.counts).toEqual({ played: 2, confirmed: 1, unconfirmed: 1 });
    shots.replayed(new Map());
    shots.fired(40, shot('next', 40));
    expect(names(shots.takeDue())).toEqual(['next']);
  });

  it('фантом и новый выстрел одинаково далеко по командам — снимок забирает тот, чей тик ближе к тику снимка', () => {
    const shots = new OwnShots<Shot>();
    shots.fired(3, shot('phantom', 3));
    shots.fired(17, shot('real', 12));
    expect(names(shots.takeDue())).toEqual(['phantom', 'real']);
    const server: Shot = { name: 'server' };
    expect(shots.settle(10, 12, [server], true)).toEqual(new Set([server]));
    shots.settle(20, 20, [], true);
    expect(shots.counts).toEqual({ played: 2, confirmed: 1, unconfirmed: 1 });
  });

  it('сыгранный выстрел подбитого танка не забирает отметку первого выстрела после возрождения (дуэль и толпа)', () => {
    const shots = new OwnShots<Shot>();
    shots.fired(20, shot('before death', 100));
    expect(shots.takeDue()).toHaveLength(1);
    shots.settle(18, 99, [], false);
    for (let tick = 100; tick < 190; tick++) {
      shots.settle(22, tick, [], false);
    }
    shots.fired(23, null);
    shots.fired(25, shot('first after respawn', 300));
    expect(names(shots.takeDue())).toEqual(['first after respawn']);
    const server: Shot = { name: 'server' };
    expect(shots.settle(25, 300, [server], true)).toEqual(new Set([server]));
    expect(shots.counts).toEqual({ played: 2, confirmed: 1, unconfirmed: 1 });
  });

  it('танк выстрелил и погиб в одном снимке — выстрел подтверждён', () => {
    const shots = new OwnShots<Shot>();
    shots.fired(20, shot('last', 20));
    shots.takeDue();
    const server: Shot = { name: 'server' };
    expect(shots.settle(20, 20, [server], false)).toEqual(new Set([server]));
    expect(shots.counts).toEqual({ played: 1, confirmed: 1, unconfirmed: 0 });
  });

  it('сыгранный выстрел, пропавший из досчёта, не отдаёт отметку выстрелу дальше перезарядки', () => {
    const shots = new OwnShots<Shot>();
    shots.replayed(new Map([[40, shot('a', 40)]]));
    shots.takeDue();
    shots.replayed(new Map());
    shots.fired(60, shot('far', 60));
    expect(names(shots.takeDue())).toEqual(['far']);
  });

  it('выстрел снимка без сыгранного по предсказанию — не помечен', () => {
    const shots = new OwnShots<Shot>();
    expect(settle(shots, 7, [{ name: 'server' }])).toEqual(new Set());
    expect(shots.counts).toEqual({ played: 0, confirmed: 0, unconfirmed: 0 });
  });

  it('вкладка скрыта: ждущий кадра выстрел не играется, и выстрел снимка о нём — тоже', () => {
    const shots = new OwnShots<Shot>();
    shots.replayed(new Map([[8, shot('hidden', 8)]]));
    shots.discardDue();
    expect(shots.takeDue()).toEqual([]);
    const server: Shot = { name: 'server' };
    expect(settle(shots, 8, [server])).toEqual(new Set([server]));
    expect(shots.counts.played).toBe(0);
  });

  it('новое соединение: несверенное забыто, выстрелы снимков нового соединения играются', () => {
    const shots = new OwnShots<Shot>();
    shots.fired(30, shot('old', 30));
    shots.clear();
    expect(shots.takeDue()).toEqual([]);
    expect(settle(shots, 1, [{ name: 'server' }])).toEqual(new Set());
  });
});
