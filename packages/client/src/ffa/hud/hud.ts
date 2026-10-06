import type { FfaHudLayout, FfaHudModel } from '../session.js';
import { ConnectionBannerView } from './connectionBanner.js';
import { CountdownView } from './countdown.js';
import { DeathCardView } from './deathCard.js';
import { element, layer, setShown } from './dom.js';
import { FatalScreenView, type FatalActions } from './fatalScreen.js';
import { FinalWarningView } from './finalWarning.js';
import { IdleWarningView } from './idleWarning.js';
import { InviteBannerView } from './inviteBanner.js';
import { KillFeedView } from './killFeed.js';
import { LobbyView, type LobbyActions } from './lobby.js';
import { ResultsView } from './results.js';
import { ScoreboardView } from './scoreboard.js';
import { SpectatorBarView } from './spectatorBar.js';

export type FfaHudActions = LobbyActions & FatalActions;

const TOUCH_CLASS = 'is-touch';
// Телефон: лента до 3 строк — не заходит на «АВТО» у правого края; в итогах — пятёрка лучших.
const TOUCH_LAYOUT: FfaHudLayout = { feedRows: 3, resultsTop: 5 };
const DESKTOP_LAYOUT: FfaHudLayout = { feedRows: 4, resultsTop: 10 };

// Интерфейс матча поверх холста: корень и карточки нажатия пропускают к полю, ловят только кнопки. Показ — по
// модели сессии; под таймером одно место на баннер связи, «Ты тут?», финал и приглашение мимо — в этом порядке
// важности.
export class FfaHud {
  readonly layout: FfaHudLayout;
  private readonly connecting: HTMLDivElement;
  private readonly scoreboard = new ScoreboardView();
  private readonly feed = new KillFeedView();
  private readonly countdown = new CountdownView();
  private readonly death = new DeathCardView();
  private readonly spectator: SpectatorBarView;
  private readonly final = new FinalWarningView();
  private readonly idle = new IdleWarningView();
  private readonly connection = new ConnectionBannerView();
  private readonly invite = new InviteBannerView();
  private readonly results: ResultsView;
  private readonly lobby: LobbyView;
  private readonly fatal: FatalScreenView;

  constructor(
    private readonly root: HTMLElement,
    actions: FfaHudActions,
    isTouch: boolean,
  ) {
    this.layout = isTouch ? TOUCH_LAYOUT : DESKTOP_LAYOUT;
    this.connecting = layer('ffa-screen ffa-connecting');
    this.connecting.append(element('span', 'ffa-spinner'), element('p', 'ffa-connecting-text', 'Подключаемся…'));
    this.spectator = new SpectatorBarView(isTouch);
    this.results = new ResultsView(() => {
      actions.leave();
    });
    this.lobby = new LobbyView(actions);
    this.fatal = new FatalScreenView(actions);
    root.classList.toggle(TOUCH_CLASS, isTouch);
    root.replaceChildren(
      this.connecting,
      this.scoreboard.element,
      this.feed.element,
      this.countdown.element,
      this.death.element,
      this.spectator.element,
      this.final.element,
      this.idle.element,
      this.results.element,
      this.lobby.element,
      this.fatal.element,
      this.invite.element,
      this.connection.element,
    );
    root.hidden = false;
  }

  render(model: FfaHudModel, now: number): void {
    if (this.root.dataset.screen !== model.screen) {
      this.root.dataset.screen = model.screen;
    }
    setShown(this.connecting, model.screen === 'connecting');
    this.scoreboard.update(model.scoreboard);
    this.feed.update(model.feed);
    this.countdown.update(model.countdown);
    this.death.update(model.death);
    this.spectator.update(model.spectator);
    this.connection.update(model.connection);
    const idleInS = model.connection === null ? model.idleInS : null;
    this.idle.update(idleInS);
    const final = model.connection === null && idleInS === null ? model.final : null;
    this.final.update(final);
    this.invite.update(model.connection === null && idleInS === null && final === null ? model.invite : null);
    this.results.update(model.results);
    this.lobby.update(model.lobby, now);
    this.fatal.update(model.screen);
  }
}
