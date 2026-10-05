import type { World } from './round.js';

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

function fnv1a(text: string): string {
  let hash = FNV_OFFSET;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, FNV_PRIME) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

// Хэш всего, что меняет шаг движка: танки, снаряды, аптечки, зона. Числа входят без округления — два прогона
// совпадают, только если совпали побитово.
export function worldDigest(world: World): string {
  const parts: string[] = [String(world.tick), String(world.nextBulletId), String(world.zone.radius)];
  for (const tank of world.tanks) {
    parts.push(
      [
        tank.id,
        tank.x,
        tank.y,
        tank.heading,
        tank.turret,
        tank.speed,
        tank.hp,
        tank.reloadLeft,
        tank.shieldLeft,
        tank.isAlive ? 1 : 0,
      ].join(','),
    );
  }
  for (const bullet of world.bullets) {
    parts.push([bullet.id, bullet.owner, bullet.x, bullet.y, bullet.vx, bullet.vy, bullet.bouncesLeft].join(','));
  }
  for (const kit of world.kits) {
    parts.push([kit.isActive ? 1 : 0, kit.respawnIn].join(','));
  }
  return fnv1a(parts.join(';'));
}
