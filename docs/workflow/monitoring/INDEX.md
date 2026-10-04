# Задача: monitoring — метрики, логи и ошибки в Grafana Cloud

Научиться видеть, что происходит с боевым сервером и клиентами: длительность тика и опоздания цикла событий, комнаты и игроки, поток сообщений, отброшенные команды, память и процессор машины, задержка и кадры у игроков, ошибки браузера. История и графики — в Grafana Cloud (бесплатный тариф), сбор — отдельным процессом Vector на машине. К моменту массовых игр по этим графикам читается запас сервера.

Правило задачи: игровой процесс в облако ничего не отправляет и ни одного вызова наружу не ждёт — счётчики в памяти, строки на диск; Vector читает и отправляет сам. Нагрузочный стенд — отдельная работа этапа 2, сюда не входит.

## Вопрос → документ

| Вопрос | Документ |
|---|---|
| Что делаем и в каком порядке | [state.md](state.md) |
| Что решили | [decisions.md](decisions.md) |
| Схема, ряды `/metrics`, `/telemetry`, фильтр логов, лимиты Vector, план тестирования | [tech/impl/infra/monitoring.md](../../tech/impl/infra/monitoring.md) |
| Базовые требования к наблюдаемости и стек | [tech/base/requirements.md](../../tech/base/requirements.md), [tech/base/infra.md](../../tech/base/infra.md) |
| Подробный журнал игры на диске, что уже пишут сервер и клиент | [tech/impl/backend/game-log.md](../../tech/impl/backend/game-log.md) |
| Машина, Caddy, systemd, скрипты выкладки | [tech/impl/infra/deploy-proto.md](../../tech/impl/infra/deploy-proto.md) |
| Ничего сетевого в тике | [adr/architecture.md](../../adr/architecture.md) |

## Ключевые файлы кода

`packages/server/src/app.ts` (ручки `/healthz`, `/log`, цикл тика), `packages/server/src/gameLog.ts` (файлы журнала, сброс таймером), `packages/server/src/room.ts` (строки сервера, отброшенные команды), `packages/client/src/diag.ts` (буфер и отправка строк клиента), `deploy/` (Caddyfile, tanks.service, setup.sh, deploy-local.sh).
