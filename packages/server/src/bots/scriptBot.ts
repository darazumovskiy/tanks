import { readFileSync } from 'node:fs';
import { Script } from 'node:vm';
import {
  sanitizeAction,
  type Action,
  type BotView,
  type BulletView,
  type Kit,
  type Side,
  type Stats,
  type TankView,
} from '@tanks/shared/engine';
import type { BotBrain } from './arenaBot.js';

// Вид участника в формате арены tank-arena: отличается от BotView только именами булевых полей.
type ArenaTankView = Omit<TankView, 'isAlive'> & { alive: boolean };
type ArenaBulletView = Omit<BulletView, 'isMine'> & { mine: boolean };
type ArenaKitView = Omit<Kit, 'isActive'> & { active: boolean };
type ArenaView = Omit<BotView, 'me' | 'enemy' | 'bullets' | 'repairKits'> & {
  me: ArenaTankView;
  enemy: ArenaTankView;
  bullets: ArenaBulletView[];
  repairKits: ArenaKitView[];
};

interface ArenaInitInfo {
  round: number;
  side: Side;
  mapName: string;
  view: ArenaView;
}

interface ArenaBotModule {
  name: string;
  stats: Stats;
  init(info: ArenaInitInfo): void;
  tick(view: ArenaView): { throttle: number; turn: number; turretTurn: number; fire: boolean };
}

const EXPORT_DEFAULT = /^export default /m;

// Файл бота арены — самодостаточный ES-модуль без импортов с одним `export default`. Тело модуля становится
// телом функции: каждый вызов даёт свежий экземпляр со своими переменными модуля, комнаты не делят состояние.
export function loadArenaBotScript(path: string | URL): () => ArenaBotModule {
  const source = readFileSync(path, 'utf8');
  const script = new Script(`(function () {\n${source.replace(EXPORT_DEFAULT, 'return ')}\n})`, {
    filename: String(path),
  });
  const factory: unknown = script.runInThisContext();
  return factory as () => ArenaBotModule;
}

function arenaTank(tank: TankView): ArenaTankView {
  const { isAlive, ...rest } = tank;
  return { ...rest, alive: isAlive };
}

function arenaView(view: BotView): ArenaView {
  return {
    ...view,
    me: arenaTank(view.me),
    enemy: arenaTank(view.enemy),
    bullets: view.bullets.map(({ isMine, ...rest }) => ({ ...rest, mine: isMine })),
    repairKits: view.repairKits.map(({ isActive, ...rest }) => ({ ...rest, active: isActive })),
  };
}

export class ScriptBrain implements BotBrain {
  readonly stats: Stats;
  private rounds = 0;

  constructor(private readonly module: ArenaBotModule) {
    this.stats = { ...module.stats };
  }

  init(view: BotView): void {
    this.module.init({ round: this.rounds, side: view.side, mapName: view.arena.mapName, view: arenaView(view) });
    this.rounds++;
  }

  tick(view: BotView): Action {
    const { fire: isFiring, ...rest } = this.module.tick(arenaView(view));
    return sanitizeAction({ ...rest, isFiring });
  }
}
