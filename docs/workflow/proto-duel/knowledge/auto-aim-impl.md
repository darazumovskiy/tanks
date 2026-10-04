# Автоведение башни: сохранённая реализация

Настройка `hasAutoAim` жила в клиенте с 2026-10-04 ~09:20 до ~22:00 и удалена из кода целиком: в паре с авто-огнём она ощущалась аимботом, а боевая сборка клиента читаема — лежать выключенной в коде она не должна. Принятый на замену концепт — «башня на поводке» (`roadmap.md`, «Идеи»): прилипание прицела у противника плюс доворот башни в сектор вокруг него, последние градусы — игрок. Здесь — поведение, код, тесты и результаты проверки прежней реализации, чтобы при реализации концепта не искать их по истории git.

## Поведение

Пока правый стик не ведёт башню — отпущен или палец лежит в мёртвой зоне (`StickState.isActive === false`), — башня сама доворачивается на противника и держит его на корпус без упреждения, через тот же `aimTurret`: предел скорости башни остаётся в движке. Цель — интерполированный противник текущего кадра, если идёт бой, он жив и его центр в кадре камеры (на компьютере кадр — всё поле); за кадром цели нет — помощник не добывает информацию, которой игрок не видит. Отклонение стика за мёртвую зону — направление игрока главнее; после того как стик перестал быть активным, ведение возобновляется через `AUTO_AIM_RESUME_MS` = 500 мс, чтобы осознанный выстрел в стену на рикошет не перебивался. Мышь — ручной источник: пока есть позиция мыши, автоведение не включается. Без цели или с выключенной настройкой `turretTurn = 0`, как без ввода. Порядок источников башни: активный правый стик → мышь → автоведение → 0. Огонь, тап, авто-огонь и кольцо не меняются: палец в мёртвой зоне стреляет, а башню ведёт автоматика. Пока ведение активно, вокруг противника в координатах поля рисуются тонкие угловые скобки акцентного цвета, появляются и гаснут плавно (без фильтров холста). Настройка читается каждый тик — смена в панели действует сразу.

Умолчание: сначала включено на касании и выключено на компьютере (`defaultSettings(isTouchDevice)`), с ~21:45 — выключено везде по журналам боевых игр.

Проба Димы (~16:10): автоведение в упор вместе с авто-огнём — «аимбот, остаётся только кататься», пропадает радость попадания; линия выстрела без автоведения «очень сильно помогает».

## Код

### `settings.ts`

```ts
export interface Settings {
  // …
  hasAutoAim: boolean;
  // …
}

export type BooleanSettingKey =
  'hasFireRing' | 'hasAutoAim' | 'hasRicochetGuard' | 'hasAimLine' | 'hasLeadHint' | 'hasZoneFire' | 'showFrameGraph';

// Поле в BOOLEAN_FIELDS, между «Кольцо огня» и «Предохранитель»:
{
  key: 'hasAutoAim',
  label: 'Башня сама держит противника',
  hint: 'пока не тянешь правый стик, башня смотрит на противника; потянул — рулишь сам',
},
```

### `input.ts`

```ts
// После того как игрок отпустил стик башни, автоведение ждёт: осознанный выстрел в стену на рикошет не должен
// перебиваться доворотом на противника.
export const AUTO_AIM_RESUME_MS = 500;

export type InputSettings = StickSettings &
  Pick<Settings, 'pivotThrottle' | 'hasAutoAim' | 'hasRicochetGuard' | 'hasZoneFire'>;

export interface AimTarget {
  x: number;
  y: number;
}

// Что известно о выстреле с текущего угла башни: цель автоведения, вернётся ли снаряд в свой корпус,
// проходит ли линия через зону противника.
export interface ShotContext {
  target: AimTarget | null;
  isReturning: boolean;
  isInZone: boolean;
}

export class InputReader {
  // …
  private isAutoAimingNow = false;
  private lastManualAimAt: number | null = null;

  get isAutoAiming(): boolean {
    return this.isAutoAimingNow;
  }

  read(me: SteeredTank, shot: ShotContext): Action {
    const hull = this.readHull(me);
    const turretTurn = this.readTurretTurn(me, shot.target);
    const isFiring = this.readFire(shot);
    return { throttle: hull.throttle, turn: hull.turn, turretTurn, isFiring };
  }

  // Палец в мёртвой зоне стика башни — не ручное направление, но и не мышь: башню ведёт автоматика.
  private readTurretTurn(me: SteeredTank, target: AimTarget | null): number {
    this.isAutoAimingNow = false;
    const stick = this.sticks.stick('aim');
    if (stick?.isActive === true) {
      this.lastManualAimAt = this.now();
      return aimTurret(Math.atan2(stick.dy, stick.dx), me.turret);
    }
    const mouse = this.mouse;
    const isMouseAiming = stick === null && mouse !== null;
    if (isMouseAiming) {
      return aimTurret(Math.atan2(mouse.y - me.y, mouse.x - me.x), me.turret);
    }
    return this.readAutoAim(me, target);
  }

  private readAutoAim(me: SteeredTank, target: AimTarget | null): number {
    if (!this.settings.hasAutoAim || target === null || this.mouse !== null) {
      return 0;
    }
    const isResting = this.lastManualAimAt !== null && this.now() - this.lastManualAimAt < AUTO_AIM_RESUME_MS;
    if (isResting) {
      return 0;
    }
    this.isAutoAimingNow = true;
    return aimTurret(Math.atan2(target.y - me.y, target.x - me.x), me.turret);
  }
}
```

### `game.ts`

```ts
// Видимый противник — общая цель автоведения, предохранителя, линии выстрела и огня по цели.
private shotContextFor(prediction: Prediction, walls: readonly Wall[], enemy: InterpolatedTank | null): ShotContext {
  const me = prediction.me;
  const bulletSpeed = me.stats.bulletSpeed;
  const isInZone =
    this.options.settings.hasZoneFire &&
    isShotInZone({ walls, shooter: { x: me.x, y: me.y, turret: me.turret }, bulletSpeed, enemy });
  return {
    target: enemy === null ? null : { x: enemy.x, y: enemy.y },
    isReturning: isShotReturning(walls, me, me.turret, bulletSpeed, enemy),
    isInZone,
  };
}

// Строка флагов журнала начиналась с autoaim=:
const autoaim = formatFlag(settings.hasAutoAim);
return `flags autoaim=${autoaim} guard=${guard} aimline=${aimLine} leadhint=${leadHint} zonefire=${zoneFire} aimstyle=${settings.aimLineStyle}`;

// debugState() и HudInfo получали isAutoAiming: this.input.isAutoAiming
```

### `render/renderer.ts`

```ts
export interface HudInfo {
  // …
  isAutoAiming: boolean;
  // …
}

// Скобки автоведения вокруг противника в единицах поля: появляются, сжимаясь к танку, и гаснут плавно.
const AUTO_AIM_COLOR = '#e8825a';
const AUTO_AIM_FADE_MS = 160;
const AUTO_AIM_HALF_SIZE = 44;
const AUTO_AIM_CORNER = 13;
const AUTO_AIM_LINE_WIDTH = 2.5;
const AUTO_AIM_ALPHA = 0.9;
const AUTO_AIM_SPREAD = 0.35;

export class Renderer {
  private autoAimGlow = 0;

  // В drawWorld после подписей танков, перед штрихом предохранителя:
  //   this.drawAutoAimBrackets(view, hud);

  private drawAutoAimBrackets(view: WorldView, hud: HudInfo): void {
    const step = hud.frameMs / AUTO_AIM_FADE_MS;
    this.autoAimGlow = clamp(this.autoAimGlow + (hud.isAutoAiming ? step : -step), 0, 1);
    const enemy = view.tanks[hud.mySide === 0 ? 1 : 0];
    if (this.autoAimGlow <= 0 || !enemy.isAlive) {
      return;
    }
    const { ctx } = this;
    const eased = easeOut(this.autoAimGlow);
    const half = AUTO_AIM_HALF_SIZE * (1 + AUTO_AIM_SPREAD * (1 - eased));
    ctx.save();
    ctx.translate(enemy.x, enemy.y);
    ctx.strokeStyle = rgba(AUTO_AIM_COLOR, AUTO_AIM_ALPHA * eased);
    ctx.lineWidth = AUTO_AIM_LINE_WIDTH;
    ctx.lineCap = 'round';
    ctx.beginPath();
    for (const sx of [-1, 1]) {
      for (const sy of [-1, 1]) {
        ctx.moveTo(sx * half, sy * (half - AUTO_AIM_CORNER));
        ctx.lineTo(sx * half, sy * half);
        ctx.lineTo(sx * (half - AUTO_AIM_CORNER), sy * half);
      }
    }
    ctx.stroke();
    ctx.restore();
  }
}
```

## Тесты

`input.test.ts`, блок «автоведение башни» (`settings.hasAutoAim = true`, цель `FAR_TARGET = { x: 400, y: 400 }` — доворот за тик не успевает, `turretTurn` упирается в 1):

| Сценарий | Ожидание |
|---|---|
| Без стика и мыши, цель справа-снизу | `turretTurn` = 1, `isAutoAiming` = true; цель справа-сверху — −1 |
| Цель в пределах тика (0,01 рад) | дробный `turretTurn` в (0; 0,2) |
| Активный правый стик | `turretTurn` по стику, `isAutoAiming` = false |
| Стик отпущен | 499 мс после последнего активного чтения — `turretTurn` = 0; 500 мс — к цели |
| Палец в мёртвой зоне правой половины (без кольца) | `isFiring` = true и `turretTurn` к цели, `isAutoAiming` = true |
| Цель `null` | `turretTurn` = 0, `isAutoAiming` = false |
| Флаг выключен в объекте настроек между чтениями | `turretTurn` = 0; включён обратно — снова к цели |
| Без внедрённых часов | пауза отсчитывается по `performance.now()` |
| Мышь есть, стика нет | башня по мыши, `isAutoAiming` = false; палец в мёртвой зоне при позиции мыши — 0 |

```ts
describe('автоведение башни', () => {
  beforeEach(() => {
    settings.hasAutoAim = true;
  });

  it('без стика и мыши башня доворачивает к цели', () => {
    expect(read(FAR_TARGET)).toEqual({ throttle: 0, turn: 0, turretTurn: 1, isFiring: false });
    expect(input.isAutoAiming).toBe(true);
    expect(read({ x: 400, y: -400 }).turretTurn).toBe(-1);
  });

  it('после отпускания стика ведение возобновляется через паузу', () => {
    target.dispatchEvent(pointer('pointerdown', 2, RIGHT_X, Y));
    target.dispatchEvent(pointer('pointermove', 2, RIGHT_X, Y - 64));
    time = 1000;
    expect(read(FAR_TARGET).turretTurn).toBe(-1);
    target.dispatchEvent(pointer('pointerup', 2, RIGHT_X, Y - 64));
    time = 1000 + AUTO_AIM_RESUME_MS - 1;
    expect(read(FAR_TARGET).turretTurn).toBe(0);
    expect(input.isAutoAiming).toBe(false);
    time = 1000 + AUTO_AIM_RESUME_MS;
    expect(read(FAR_TARGET).turretTurn).toBe(1);
    expect(input.isAutoAiming).toBe(true);
  });

  it('мышь — ручной источник: пока есть её позиция, автоведение не включается', () => {
    target.dispatchEvent(pointer('pointermove', 5, 0, -100, 'mouse'));
    expect(read(FAR_TARGET).turretTurn).toBe(-1);
    expect(input.isAutoAiming).toBe(false);
    target.dispatchEvent(pointer('pointerdown', 2, RIGHT_X, Y));
    target.dispatchEvent(pointer('pointermove', 2, RIGHT_X + 4, Y));
    expect(read(FAR_TARGET).turretTurn).toBe(0);
    expect(input.isAutoAiming).toBe(false);
  });
});
```

`settings.test.ts` / `settingsPanel.test.ts`: флажок «Башня сама держит противника» на телефоне и компьютере, умолчание по устройству, отметка пишет `hasAutoAim` в хранилище, сброс возвращает умолчание.

Стенд `test:e2e`, сценарий «телефон: башня сама держит противника в кадре, стик перебивает, после отпускания ведение возвращается»: компьютер едет через проход «Полигона» (1150, 450) → (1100, 250) — вне оси появления, в кадре телефона (окно камеры у своего края кончается на x ≈ 1285); `phone.waitForTurretAt(desktopPost)` → `isAutoAiming` true, башня компьютера не сдвинулась; протяжка правой половины (650, 200) → (650, 300) уводит башню к π/2, через 250 мс после отпускания она ещё там (допуск 0,1), затем `waitForTurretAt(desktopPost)` снова. Сценарии линии выстрела и зонного огня использовали автоведение как способ навести башню телефона; после удаления башня наводится мышью (`aimAt`) и стиком.

## Сквозная проверка (исполнена 2026-10-04, эмуляция телефона, бот уровня 3)

| Сценарий | Результат |
|---|---|
| Телефон ничего не трогает | пока бот за кадром (окно x 315–1775, бот на x 140–259) — `isAutoAiming` false, башня стоит; бот въехал в кадр — `isAutoAiming` true в 21 выборке из 21 за 10,5 с, ошибка башни 0,000–0,009 рад (`turret` 3,100 → 2,765 → −2,977 вслед за ботом) |
| Протяжка правой половины вниз, отпускание | держу: `turret` 1,571, `isAutoAiming` false; +252 мс: 1,571, false; +703 мс: 2,224, true; +1004 мс: 3,064 (ошибка к противнику 0,307, доворот 1,8 рад ограничен скоростью башни) |
| Компьютерный клиент без флага | `isAutoAiming` false, `turret` −3,142 → −3,142 за 3 с, бот сдвинулся на 422 |
| Панель на телефоне | флажок отмечен (умолчание касания на тот момент); снят — `isAutoAiming` false, `turret` 3,095 → 3,095 за 2 с при сдвиге бота на 211, `"hasAutoAim":false` в хранилище; отмечен снова — `isAutoAiming` true, ошибка 0,000 через 1,2 с |
| Визуально | скобки акцентного цвета вокруг противника при ведении; нет скобок при активном стике; флажок в панели — `/tmp/autoaim-shots/01-brackets-on-enemy.png`, `02-manual-stick-no-brackets.png`, `03-settings-autoaim-checkbox.png` |
| Линия выстрела при ведении (бот уровня 3) | `onTarget` в 10 выборках из 10 за 1 с при ошибке башни ≤ 0,003 рад; пока бот шёл за стеной (840, 556) — `none`: автоведение стен не знает, линия показывает, что выстрел не дойдёт |

Зонный огонь в паре с автоведением (20 с, 4 прогона): выстрелов 56, с прямой видимостью 93 %, попаданий 30 %, самопопаданий 0, но темп огня на 40 % ниже контрольного — подробности в `tech/impl/frontend/touch-controls.md`, «Огонь по цели».
