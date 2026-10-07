import { describe, expect, it } from 'vitest';
import { CountdownBeeper } from './countdownBeeper.js';

const TOTAL_S = 3;
const FRAME_S = 1 / 60;

function recordingBeeper(played: string[]): CountdownBeeper {
  return new CountdownBeeper({
    play: (sound) => {
      played.push(sound);
      return null;
    },
  });
}

function showCountdown(beeper: CountdownBeeper, fromS: number, toS: number): void {
  for (let elapsedS = fromS; elapsedS < toS; elapsedS += FRAME_S) {
    beeper.update({ kind: 'countdown', elapsedS, totalS: TOTAL_S });
  }
}

describe('писк отсчёта', () => {
  it('три цифры — три писка, затем «БОЙ!» один раз', () => {
    const played: string[] = [];
    const beeper = recordingBeeper(played);
    showCountdown(beeper, 0, TOTAL_S + 0.5);
    beeper.update(null);
    expect(played).toEqual(['beep', 'beep', 'beep', 'go']);
  });

  it('новый отсчёт после сброса пищит заново', () => {
    const played: string[] = [];
    const beeper = recordingBeeper(played);
    showCountdown(beeper, TOTAL_S - 0.5, TOTAL_S + 0.1);
    beeper.reset();
    showCountdown(beeper, TOTAL_S - 0.5, TOTAL_S + 0.1);
    expect(played).toEqual(['beep', 'go', 'beep', 'go']);
  });
});
