import { leadPoint, normalizeAngle, TICK_RATE, type Point, type Random, type TankView } from '@tanks/shared/engine';
import { distanceBucketOf, type DistanceBucketLabel } from '@tanks/analysis';
import { fromDeciles, normalCdf, standardNormal } from './sampling.js';

export interface HandSettings {
  errorDecilesDeg: Readonly<Record<DistanceBucketLabel, readonly number[]>>;
  correlationTicks: number;
  lagTicks: number;
  leadShare: number;
}

const DEGREES_TO_RADIANS = Math.PI / 180;

// Цель в памяти руки: положение и скорость в один и тот же тик.
interface SeenTarget {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

function bearing(from: Point, to: Point): number {
  return Math.atan2(to.y - from.y, to.x - from.x);
}

// Рука на башне: желаемое направление — пеленг на цель с запаздыванием, доля упреждения и ошибка руки.
// Отрицательное запаздывание — рука ведёт впереди цели: положение продолжается по её скорости.
// Ошибка — гладкий гауссов процесс в копуле: шум ξ дважды сглаживается с ρ = 1 − 1/correlationTicks
// (y = ρ·y + √(1−ρ²)·ξ, s = ρ·s + (1−ρ)·y) и нормируется, w = s / σ; модуль ошибки — квантиль децилей для
// 2Φ(|w|) − 1 из корзины дистанции до цели, знак — знак w. Распределение модуля совпадает с децилями при любой
// памяти, а память задаёт, как долго ошибка держится по одну сторону цели. Сглаживание двойное, чтобы путь был
// гладким: у шершавого пути у нуля пачки пересечений, и медиана отрезков по одну сторону не растёт с памятью.
export class Hand {
  private smooth = 0;
  private drive = 0;
  private targets: SeenTarget[] = [];

  constructor(
    private readonly settings: HandSettings,
    private readonly random: Random,
  ) {}

  private get rho(): number {
    return 1 - 1 / Math.max(1, this.settings.correlationTicks);
  }

  // Стационарное σ сглаженного процесса: σ² = (1 + ρ²) / (1 + ρ)².
  private get sigma(): number {
    const rho = this.rho;
    return Math.sqrt(1 + rho * rho) / (1 + rho);
  }

  // Старт из стационарного состояния: corr(w, y) = 1 / √(1 + ρ²).
  reset(): void {
    const rho = this.rho;
    const link = 1 / Math.sqrt(1 + rho * rho);
    this.drive = standardNormal(this.random);
    this.smooth = this.sigma * (link * this.drive + Math.sqrt(1 - link * link) * standardNormal(this.random));
    this.targets = [];
  }

  // Вызывается каждый тик: процесс ошибки и память цели идут и тогда, когда башня стоит.
  wanted(me: TankView, target: Point, velocity: Point): number {
    const rho = this.rho;
    this.drive = rho * this.drive + Math.sqrt(1 - rho * rho) * standardNormal(this.random);
    this.smooth = rho * this.smooth + (1 - rho) * this.drive;
    this.targets.push({ x: target.x, y: target.y, vx: velocity.x, vy: velocity.y });
    const seen = this.laggedTarget();
    const toHull = bearing(me, seen);
    const toLead = bearing(me, leadPoint(me, seen, { x: seen.vx, y: seen.vy }, me.stats.bulletSpeed));
    const level = this.smooth / this.sigma;
    const deciles = this.settings.errorDecilesDeg[distanceBucketOf(Math.hypot(seen.x - me.x, seen.y - me.y))];
    const errorDeg = Math.sign(level) * fromDeciles(deciles, 2 * normalCdf(Math.abs(level)) - 1);
    return normalizeAngle(
      toHull + this.settings.leadShare * normalizeAngle(toLead - toHull) + errorDeg * DEGREES_TO_RADIANS,
    );
  }

  // Цель lagTicks назад с интерполяцией между соседними тиками; пока истории мало — самая старая.
  private laggedTarget(): SeenTarget {
    const last = this.targets.length - 1;
    const lag = this.settings.lagTicks;
    const latest = this.targets[last] ?? { x: 0, y: 0, vx: 0, vy: 0 };
    if (lag < 0) {
      this.targets.splice(0, last);
      const ahead = -lag / TICK_RATE;
      return { ...latest, x: latest.x + latest.vx * ahead, y: latest.y + latest.vy * ahead };
    }
    const position = last - Math.min(last, lag);
    const low = Math.floor(position);
    const fraction = position - low;
    const older = this.targets[low] ?? latest;
    const newer = this.targets[Math.min(last, low + 1)] ?? older;
    const keep = Math.ceil(lag) + 1;
    if (this.targets.length > keep) {
      this.targets.splice(0, this.targets.length - keep);
    }
    const mix = (from: number, to: number): number => from + (to - from) * fraction;
    return {
      x: mix(older.x, newer.x),
      y: mix(older.y, newer.y),
      vx: mix(older.vx, newer.vx),
      vy: mix(older.vy, newer.vy),
    };
  }
}
