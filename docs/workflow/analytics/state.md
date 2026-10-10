# Состояние: analytics

Задача заведена 2026-10-10, работа не начата — начинается с шага 1 плана ([INDEX.md](INDEX.md)) в новой сессии.

## Что есть на старте

- Тестовая машина в Сиэтле `172.238.33.233` (Linode 4 GB, Ubuntu 24.04, ключ `~/.ssh/tanks_probe_ed25519`): Node 22, Caddy из репозитория Ubuntu, тестовый сервер игры и админка, Vector нет; выкладка — `deploy/test/deploy-test.sh` ([deploy-proto.md](../../tech/impl/infra/deploy-proto.md), «Тестовая машина»).
- Боевая машина `172.232.212.157`: журналы игр — файлы в `/opt/tanks-logs`, чистятся через 7 дней; Vector шлёт в Grafana Cloud метрики, системный журнал, редкие события игр, события клиента и визиты ([monitoring.md](../../tech/impl/infra/monitoring.md)).
- Объём журналов — [knowledge/volume.md](knowledge/volume.md).

## Блокеры и открытые вопросы

Блокеров нет.
