import { describe, expect, it } from 'vitest';
import { buildSceneFrame, FX_SCENES, FX_SCREENS } from './scenes.js';

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
    const back = buildSceneFrame(scene('with-bullet'), 40);
    expect(at.aimLine.state).toBe('onTarget');
    expect(at.view.bullets).toHaveLength(1);
    expect(at.view.bullets[0]?.owner).toBe(0);
    expect((back.view.bullets[0]?.x ?? 0) + 40).toBeCloseTo(at.view.bullets[0]?.x ?? 0);
  });

  it('экраны: телефон с касанием и компьютер без', () => {
    expect(FX_SCREENS.map((screen) => [screen.id, screen.isTouchDevice])).toEqual([
      ['phone', true],
      ['desktop', false],
    ]);
  });
});
