# Каталог эффектов

Видимые элементы боя с их токенами: где лежит объект стиля, какая полоса яркости, какие сцены в лаборатории (`/?lab=fx`, [impl/frontend/fx-lab.md](../impl/frontend/fx-lab.md)). Правила — [visual-language.md](visual-language.md), порядок изменения — [adr/visual.md](../../adr/visual.md). Эффекты, перенесённые из `tank-arena` (снаряды, искры, взрывы, подпалины, объявления), пока живут числами в `render/effects.ts`; в каталог они попадают по мере прохождения визуального цикла.

| Элемент | Полоса | Токен | Сцены лаборатории | Состояние |
|---|---|---|---|---|
| Линия выстрела ([aim-line.md](../impl/frontend/aim-line.md)) | телеграф | семь стилей игрока в `packages/client/src/render/aimLineStyles.ts` (`AIM_LINE_STYLES`: `soft-tracer` — умолчание, `tracer`, `dots`, `hairline`, `tapered`, `grain`, `neon`); форма токена — `aimLineStyle.ts`: цвета состояний, ядро, слои ореола, штрихи, пульс, точки, сужение, зерно, хвост, засечка, появление | `wall-tail`, `on-target`, `lead`, `returning`, `with-bullet`; просмотр `/?lab=fx&view=review&round=2` | зафиксировано 2026-10-04; эталоны — `packages/client/test/e2e/visual/aimLine.spec.ts` |
