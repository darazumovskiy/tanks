import { ARENA, mapByIndex } from '@tanks/shared/engine';
import { makeCanvas, seededRandom } from './view.js';

const cache = new Map<number, HTMLCanvasElement>();

// Пол карты рисуется один раз: текстура, сетка, площадки появления, стены с тенью, фаской и полосой.
export function floorFor(mapIndex: number): HTMLCanvasElement {
  const cached = cache.get(mapIndex);
  if (cached !== undefined) {
    return cached;
  }
  const map = mapByIndex(mapIndex);
  const { canvas, ctx: g } = makeCanvas(ARENA.width, ARENA.height);
  const background = g.createRadialGradient(800, 450, 80, 800, 450, 950);
  background.addColorStop(0, '#262a30');
  background.addColorStop(1, '#131519');
  g.fillStyle = background;
  g.fillRect(0, 0, ARENA.width, ARENA.height);

  const random = seededRandom(1234 + mapIndex * 77);
  for (let i = 0; i < 14; i++) {
    const x = random() * ARENA.width;
    const y = random() * ARENA.height;
    const r = 80 + random() * 220;
    const blob = g.createRadialGradient(x, y, 0, x, y, r);
    blob.addColorStop(0, `rgba(0,0,0,${String(0.08 + random() * 0.1)})`);
    blob.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = blob;
    g.fillRect(x - r, y - r, r * 2, r * 2);
  }
  for (let i = 0; i < 9000; i++) {
    g.fillStyle = random() < 0.5 ? 'rgba(255,255,255,0.035)' : 'rgba(0,0,0,0.12)';
    g.fillRect(random() * ARENA.width, random() * ARENA.height, 1 + random() * 2, 1 + random() * 2);
  }
  g.lineWidth = 1;
  for (let x = 0; x <= ARENA.width; x += 50) {
    g.strokeStyle = x % 200 === 0 ? 'rgba(255,255,255,0.06)' : 'rgba(255,255,255,0.025)';
    g.beginPath();
    g.moveTo(x + 0.5, 0);
    g.lineTo(x + 0.5, ARENA.height);
    g.stroke();
  }
  for (let y = 0; y <= ARENA.height; y += 50) {
    g.strokeStyle = y % 200 === 0 ? 'rgba(255,255,255,0.06)' : 'rgba(255,255,255,0.025)';
    g.beginPath();
    g.moveTo(0, y + 0.5);
    g.lineTo(ARENA.width, y + 0.5);
    g.stroke();
  }
  for (const spawn of map.spawns) {
    g.strokeStyle = 'rgba(255,255,255,0.08)';
    g.setLineDash([8, 8]);
    g.lineWidth = 2;
    g.beginPath();
    g.arc(spawn.x, spawn.y, 44, 0, Math.PI * 2);
    g.stroke();
    g.setLineDash([]);
  }

  g.save();
  g.shadowColor = 'rgba(0,0,0,0.6)';
  g.shadowBlur = 18;
  g.shadowOffsetX = 7;
  g.shadowOffsetY = 10;
  g.fillStyle = '#30353c';
  for (const wall of map.walls) {
    g.fillRect(wall.x, wall.y, wall.w, wall.h);
  }
  g.restore();
  for (const wall of map.walls) {
    const gradient = g.createLinearGradient(wall.x, wall.y, wall.x + wall.w, wall.y + wall.h);
    gradient.addColorStop(0, '#4d545d');
    gradient.addColorStop(1, '#30353c');
    g.fillStyle = gradient;
    g.fillRect(wall.x, wall.y, wall.w, wall.h);
    g.fillStyle = 'rgba(255,255,255,0.07)';
    g.fillRect(wall.x + 4, wall.y + 4, wall.w - 8, wall.h - 8);
    g.strokeStyle = 'rgba(255,255,255,0.18)';
    g.lineWidth = 1.5;
    g.beginPath();
    g.moveTo(wall.x + 0.75, wall.y + wall.h);
    g.lineTo(wall.x + 0.75, wall.y + 0.75);
    g.lineTo(wall.x + wall.w, wall.y + 0.75);
    g.stroke();
    g.strokeStyle = 'rgba(0,0,0,0.5)';
    g.strokeRect(wall.x + 0.5, wall.y + 0.5, wall.w - 1, wall.h - 1);
    g.save();
    g.beginPath();
    if (wall.w >= wall.h) {
      g.rect(wall.x + 6, wall.y + wall.h / 2 - 3, wall.w - 12, 6);
    } else {
      g.rect(wall.x + wall.w / 2 - 3, wall.y + 6, 6, wall.h - 12);
    }
    g.clip();
    g.fillStyle = 'rgba(240,180,40,0.35)';
    for (let s = -900; s < 1800; s += 16) {
      g.beginPath();
      g.moveTo(wall.x + s, wall.y);
      g.lineTo(wall.x + s + 8, wall.y);
      g.lineTo(wall.x + s + 8 - 900, wall.y + 900);
      g.lineTo(wall.x + s - 900, wall.y + 900);
      g.fill();
    }
    g.restore();
  }
  g.strokeStyle = '#4a5059';
  g.lineWidth = 6;
  g.strokeRect(3, 3, ARENA.width - 6, ARENA.height - 6);
  cache.set(mapIndex, canvas);
  return canvas;
}
