import type { FfaScoreboardModel } from '../session.js';
import { element, layer, placeText, setShown, setText } from './dom.js';

const SECONDS_PER_MINUTE = 60;
const FINAL_CLASS = 'is-final';
const ME_CLASS = 'is-me';

function clock(seconds: number): string {
  const minutes = Math.floor(seconds / SECONDS_PER_MINUTE);
  return `${String(minutes)}:${String(seconds % SECONDS_PER_MINUTE).padStart(2, '0')}`;
}

// Верхняя полоса боя: лидер слева у «⌂», таймер по центру, своё место и счёт справа.
export class ScoreboardView {
  readonly element: HTMLDivElement;
  private readonly leader: HTMLDivElement;
  private readonly leaderName: HTMLSpanElement;
  private readonly leaderKills: HTMLSpanElement;
  private readonly timer: HTMLDivElement;
  private readonly place: HTMLDivElement;
  private readonly rank: HTMLDivElement;
  private readonly tally: HTMLDivElement;

  constructor() {
    this.element = layer('ffa-scoreboard');
    this.leader = element('div', 'ffa-leader');
    this.leaderName = element('span', 'ffa-leader-name');
    this.leaderKills = element('span', 'ffa-leader-kills');
    this.leader.append(this.leaderName, this.leaderKills);
    this.timer = element('div', 'ffa-timer');
    this.place = element('div', 'ffa-place');
    this.rank = element('div', 'ffa-place-rank');
    this.tally = element('div', 'ffa-place-tally');
    this.place.append(this.rank, this.tally);
    this.element.append(this.leader, this.timer, this.place);
  }

  update(model: FfaScoreboardModel | null): void {
    setShown(this.element, model !== null);
    if (model === null) {
      return;
    }
    setText(this.timer, clock(model.timeLeftS));
    this.timer.classList.toggle(FINAL_CLASS, model.isFinal);
    const leader = model.leader;
    this.leader.hidden = leader === null;
    this.leader.classList.toggle(ME_CLASS, leader?.isMe === true);
    if (leader !== null) {
      setText(this.leaderName, leader.isMe ? 'Ты лидер!' : `Лидер: ${leader.name}`);
      setText(this.leaderKills, leader.isMe ? '' : ` · ${String(leader.kills)}`);
    }
    const score = model.score;
    this.place.hidden = score === null;
    if (score !== null) {
      setText(this.rank, placeText(score.place, score.total));
      setText(this.tally, `подбил ${String(score.kills)} · погиб ${String(score.deaths)}`);
    }
  }
}
