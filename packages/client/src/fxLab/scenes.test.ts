import { DT, MUZZLE_OFFSET } from '@tanks/shared/engine';
import { describe, expect, it } from 'vitest';
import { buildSceneFrame, FX_SCENES, FX_SCREENS, LAB_FRAME_S } from './scenes.js';

function scene(id: string): (typeof FX_SCENES)[number] {
  const found = FX_SCENES.find((candidate) => candidate.id === id);
  if (found === undefined) {
    throw new Error(`нет сцены ${id}`);
  }
  return found;
}

describe('сцены лаборатории эффектов', () => {
  it('«в стену под углом»: два отрезка, состояние none, хвост не опасный', () => {
    const { aimLine } = buildSceneFrame(scene('wall-tail'));
    expect(aimLine.segments).toHaveLength(2);
    expect(aimLine.state).toBe('none');
    expect(aimLine.isReturning).toBe(false);
  });

  it('«на противнике»: один отрезок до корпуса и засечка', () => {
    const { aimLine, view } = buildSceneFrame(scene('on-target'));
    expect(aimLine.state).toBe('onTarget');
    expect(aimLine.segments).toHaveLength(1);
    expect(aimLine.mark).not.toBeNull();
    expect(view.tanks[1].isAlive).toBe(true);
  });

  it('«упреждаю»: состояние lead с засечкой впереди по ходу противника', () => {
    const { aimLine } = buildSceneFrame(scene('lead'));
    expect(aimLine.state).toBe('lead');
    expect(aimLine.mark?.y).toBeGreaterThan(300);
  });

  it('«упреждаю» без подсказки упреждения даёт none', () => {
    const { aimLine } = buildSceneFrame({ ...scene('lead'), hasLeadHint: false });
    expect(aimLine.state).toBe('none');
  });

  it('«в край в упор»: хвост вернётся в меня', () => {
    const { aimLine, view } = buildSceneFrame(scene('returning'));
    expect(aimLine.state).toBe('none');
    expect(aimLine.isReturning).toBe(true);
    expect(view.tanks[1].isAlive).toBe(false);
  });

  it('«рядом летит мой снаряд»: один снаряд владельца 0, сдвиг назад ведёт его по направлению полёта', () => {
    const at = buildSceneFrame(scene('with-bullet'));
    const back = buildSceneFrame(scene('with-bullet'), 5);
    expect(at.aimLine.state).toBe('onTarget');
    expect(at.view.bullets).toHaveLength(1);
    expect(at.view.bullets[0]?.owner).toBe(0);
    expect((back.view.bullets[0]?.x ?? 0) + 40).toBeCloseTo(at.view.bullets[0]?.x ?? 0);
  });

  it('M9 «выстрел на ходу вбок»: танк едет, выстрел — в своём кадре, снаряд — на пути выстрела с догоном', () => {
    const moving = scene('shot-moving');
    const shot = moving.shot;
    if (shot === null) {
      throw new Error('у сцены нет выстрела');
    }
    const now = buildSceneFrame(moving);
    expect(now.aimLine.state).toBe('none');
    expect(now.view.round.rules.shotInheritPercent).toBe(100);
    for (let framesBack = 0; framesBack < 12; framesBack++) {
      const frame = buildSceneFrame(moving, framesBack);
      const me = frame.view.round.tanks[0];
      expect(me.x).toBeCloseTo(moving.me.x - moving.me.speed * framesBack * LAB_FRAME_S, 9);
      expect(frame.shot !== null).toBe(framesBack === shot.framesBack);
      expect(frame.view.bullets).toHaveLength(framesBack <= shot.framesBack ? 1 : 0);
    }
    const fired = buildSceneFrame(moving, shot.framesBack);
    const shooter = fired.view.round.tanks[0];
    const muzzle = {
      x: shooter.x + Math.cos(shooter.turret) * MUZZLE_OFFSET,
      y: shooter.y + Math.sin(shooter.turret) * MUZZLE_OFFSET,
    };
    expect(fired.shot).toMatchObject({ kind: 'shot', side: 0, value: shooter.turret });
    expect(fired.shot?.x).toBeCloseTo(muzzle.x, 9);
    expect(fired.shot?.y).toBeCloseTo(muzzle.y, 9);
    const vx = Math.cos(shooter.turret) * shooter.stats.bulletSpeed + moving.me.speed;
    const vy = Math.sin(shooter.turret) * shooter.stats.bulletSpeed;
    const flightS = (1 + shot.leadTicks) * DT + shot.framesBack * LAB_FRAME_S;
    const [bullet] = now.view.bullets;
    expect(bullet?.x).toBeCloseTo(muzzle.x + vx * flightS, 6);
    expect(bullet?.y).toBeCloseTo(muzzle.y + vy * flightS, 6);
    expect(bullet?.owner).toBe(0);
  });

  it('экраны: телефон с касанием и компьютер без', () => {
    expect(FX_SCREENS.map((screen) => [screen.id, screen.isTouchDevice])).toEqual([
      ['phone', true],
      ['desktop', false],
    ]);
  });
});
