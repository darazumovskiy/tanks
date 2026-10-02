// Общий сценарий для эталона и теста: детерминированный ввод обоих танков и хеш состояния.
// Файл на чистом JS, потому что его импортирует и генератор (оригинальный движок), и тест (новый движок).

export const SCENARIOS = [
  {
    mapIndex: 0,
    seed: 11,
    fireChance: 0.7,
    stats: [
      { armor: 0, engine: 0, gun: 5, reload: 5 },
      { armor: 3, engine: 3, gun: 2, reload: 2 },
    ],
  },
  {
    mapIndex: 1,
    seed: 23,
    fireChance: 0.7,
    stats: [
      { armor: 2, engine: 1, gun: 2, reload: 5 },
      { armor: 0, engine: 0, gun: 5, reload: 5 },
    ],
  },
  {
    mapIndex: 2,
    seed: 37,
    fireChance: 0.7,
    stats: [
      { armor: 5, engine: 0, gun: 0, reload: 5 },
      { armor: 0, engine: 5, gun: 5, reload: 0 },
    ],
  },
  {
    mapIndex: 3,
    seed: 41,
    fireChance: 0.7,
    stats: [
      { armor: 3, engine: 3, gun: 2, reload: 2 },
      { armor: 3, engine: 3, gun: 2, reload: 2 },
    ],
  },
  // Без стрельбы: раунд идёт до конца времени, работают аптечки и зона.
  {
    mapIndex: 0,
    seed: 53,
    fireChance: 0,
    stats: [
      { armor: 5, engine: 5, gun: 0, reload: 0 },
      { armor: 3, engine: 3, gun: 2, reload: 2 },
    ],
  },
  // Редкая стрельба: длинный бой с рикошетами и зоной.
  {
    mapIndex: 2,
    seed: 67,
    fireChance: 0.05,
    stats: [
      { armor: 5, engine: 2, gun: 3, reload: 0 },
      { armor: 5, engine: 0, gun: 2, reload: 3 },
    ],
  },
];

export const MAX_TICKS = 3600;
const HOLD_TICKS = 10;

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Расписание команд: каждые HOLD_TICKS тиков обе стороны получают новую случайную команду.
// Поле выстрела названо `fire` — так его понимает оригинальный движок; новый получает переименованную копию.
export function buildSchedule(seed, ticks, fireChance) {
  const rng = mulberry32(seed);
  const schedule = [];
  let current = null;
  for (let tick = 0; tick < ticks; tick++) {
    if (tick % HOLD_TICKS === 0) {
      current = [0, 1].map(() => ({
        throttle: rng() * 2 - 1,
        turn: rng() * 2 - 1,
        turretTurn: rng() * 2 - 1,
        fire: rng() < fireChance,
      }));
    }
    schedule.push(current);
  }
  return schedule;
}

function fnv1a(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

// Нормализованный снимок принимает уже переименованные поля: обе стороны приводят своё состояние к этой форме.
export function digest(snapshot, eventTypes) {
  return fnv1a(JSON.stringify([snapshot, eventTypes]));
}
