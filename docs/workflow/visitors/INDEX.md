# Задача: visitors — знаем, кто играет

Понимать, кто заходит в игру: сколько разных людей, кто вернулся, откуда пришёл, где живёт, с какого устройства и какой связи. Повод — 2026-10-05 в игру впервые зашли незнакомые люди после рассказа автора `tank-arena` на своём канале, и по журналам их можно было различить только по нику и строке браузера.

Каждое открытие страницы оставляет одну запись визита: номер устройства, IP, гео, данные браузера, источник. В бою — только номер устройства в строке `device`. Анализатор склеивает игры с визитами. Игроку под иконкой подсказки на главной показывается, что собирает игра.

## Вопрос → документ

| Вопрос | Документ |
|---|---|
| Что делаем и где стоим | [state.md](state.md) |
| Что решили | [decisions.md](decisions.md) |
| Профиль визита, ручка `/visit`, гео, анализатор, выкладка, план тестирования | [tech/impl/backend/visitors.md](../../tech/impl/backend/visitors.md) |
| Формат журнала игры, строка `device` | [tech/impl/backend/game-log.md](../../tech/impl/backend/game-log.md) |
| Анализатор журналов | [tech/impl/backend/log-analysis.md](../../tech/impl/backend/log-analysis.md) |
| Поток в Grafana, Vector | [tech/impl/infra/monitoring.md](../../tech/impl/infra/monitoring.md) |

## Ключевые файлы кода

[visitor.ts](../../../packages/client/src/visitor.ts) (клиент), [visits.ts](../../../packages/server/src/visits.ts) и [geo.ts](../../../packages/server/src/geo.ts) (сервер), [visitors.ts](../../../packages/analysis/src/visitors.ts) (анализатор), [geo-update](../../../deploy/geo-update), [tanks-logs-cleanup](../../../deploy/tanks-logs-cleanup), [vector.yaml](../../../deploy/vector/vector.yaml).
