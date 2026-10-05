import { isInView, type Camera } from './camera.js';
import { drawScorch, drawTread, type DecalLayer } from './decals.js';

// Холст на большую карту дорог по памяти: следы — список отметок, на поле их не больше этого числа.
const STAMP_LIMIT = 400;
// Выцветание как у холста дуэли: стирание с альфой 0,05 оставляет 95 % следа.
const STAMP_FADE = 0.95;
// Отметка бледнее этого уже не видна и удаляется.
const STAMP_MIN_STRENGTH = 0.02;
// След гусениц лежит не дальше этого от точки танка: бока и корма корпуса.
const TREAD_REACH = 24;

type StampKind = 'tread' | 'scorch';

// reach — как далеко от точки отметки она рисуется; strength — сколько осталось после выцветания.
interface Stamp {
  kind: StampKind;
  x: number;
  y: number;
  heading: number;
  reach: number;
  alpha: number;
  strength: number;
}

// Следы и подпалины толпы отметками: старые гаснут и уходят первыми, в кадре рисуются только видимые.
export class StampDecals implements DecalLayer {
  private stamps: Stamp[] = [];

  clear(): void {
    this.stamps = [];
  }

  tread(x: number, y: number, heading: number): void {
    this.push({ kind: 'tread', x, y, heading, reach: TREAD_REACH, alpha: 1, strength: 1 });
  }

  scorch(x: number, y: number, radius: number, alpha: number): void {
    this.push({ kind: 'scorch', x, y, heading: 0, reach: radius, alpha, strength: 1 });
  }

  fade(): void {
    for (const stamp of this.stamps) {
      stamp.strength *= STAMP_FADE;
    }
    this.stamps = this.stamps.filter((stamp) => stamp.strength >= STAMP_MIN_STRENGTH);
  }

  draw(ctx: CanvasRenderingContext2D, camera: Camera): void {
    ctx.save();
    for (const stamp of this.stamps) {
      if (!isInView(camera, stamp, stamp.reach)) {
        continue;
      }
      ctx.globalAlpha = stamp.strength;
      if (stamp.kind === 'tread') {
        drawTread(ctx, stamp.x, stamp.y, stamp.heading);
      } else {
        drawScorch(ctx, stamp.x, stamp.y, stamp.reach, stamp.alpha);
      }
    }
    ctx.restore();
  }

  private push(stamp: Stamp): void {
    this.stamps.push(stamp);
    if (this.stamps.length > STAMP_LIMIT) {
      this.stamps.shift();
    }
  }
}
