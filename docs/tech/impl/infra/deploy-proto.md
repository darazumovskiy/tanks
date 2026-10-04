# Выкладка пробы

Одна машина Akamai (Linode) Nanode 1 GB в Милане, `172.232.212.157`. Адрес игры — `https://172-232-212-157.sslip.io` (sslip.io — бесплатный DNS, превращающий IP в имя; Let's Encrypt выдал на него сертификат). Код — `deploy/`.

| Файл | Роль |
|---|---|
| `setup.sh` | Первичная настройка машины от root: Node 22, Caddy, Vector, пользователь `tanks`, клон репозитория в `/opt/tanks`, systemd-юниты, первая выкладка. Параметр `TANKS_HOST` — имя для сертификата |
| `deploy-local.sh` | На машине: `git reset --hard origin/main`, `npm ci`, `npm run build`, папка журналов `/opt/tanks-logs`, установка `tanks.service`, `Caddyfile`, конфига и drop-in Vector, `systemctl restart tanks`, `reload caddy`, `restart vector`, проверка `/healthz` |
| `deploy.sh user@host` | С рабочей машины: запускает `deploy-local.sh` по SSH ключом `~/.ssh/tanks_probe_ed25519` |
| `vector-secrets.sh user@host` | С рабочей машины: кладёт доступы Grafana Cloud из `~/.secrets-tank/grafana-cloud.env` в `/etc/default/vector` |
| `grafana-dashboard.sh` | С рабочей машины: собирает и загружает дашборд в Grafana Cloud |
| `tanks.service` | systemd: `node packages/server/dist/main.js`, `127.0.0.1:8080`, статика из `packages/client/dist`, APK из `/opt/tanks-files/tanks.apk`, журналы игр в `/opt/tanks-logs`, автоперезапуск. `deploy-local.sh` переустанавливает юнит при каждой выкладке |

## Серверные ручки

Правила движка задаются переменными окружения сервиса в `deploy/tanks.service` рядом с `LOG_DIR` ([round-rules.md](../backend/round-rules.md)). Скольжение вдоль стен — `WALL_SLIDE=<0–100>`, на бою 50; 0 — залипание как в `tank-arena`, 100 — стены без трения. Поменять: исправить число в `Environment=WALL_SLIDE=…` в `deploy/tanks.service`, закоммитить, запушить в `main` и выложить `deploy/deploy.sh root@172.232.212.157` — `deploy-local.sh` переустановит юнит и перезапустит сервис. Проверить: `ssh … 'systemctl show tanks -p Environment'` и строка `game start … rules=<процент>` в новом файле `/opt/tanks-logs/<gameId>.log`. Протокол при этом не меняется: клиенты узнают правило из `RoundStart`.
| `vector/` | Конфиг Vector и drop-in с лимитами — [monitoring.md](monitoring.md) |
| `tanks-logs-cleanup` | Ежедневный cron (`/etc/cron.daily`): удаляет журналы игр старше 7 дней |
| `Caddyfile` | HTTPS на `TANKS_HOST`, сжатие; `/metrics` → 404, `/telemetry` → Vector, остальное (включая WebSocket) → 8080 |
| `android/` | Сборка и загрузка Android-приложения — [android-app.md](android-app.md) |

Выкладка берёт код только из `origin/main` на GitHub: сначала коммит и пуш, потом `deploy/deploy.sh root@172.232.212.157`. Перезапуск рвёт активные дуэли.

Логи процесса: `journalctl -u tanks`, `journalctl -u caddy`, `journalctl -u vector`. Журналы игр — `/opt/tanks-logs/<gameId>.log`, один файл на дуэль, около 1 МБ в минуту боя двух игроков ([game-log.md](../backend/game-log.md)); старше 7 дней удаляет ежедневный cron `tanks-logs-cleanup`. Метрики, системный журнал и редкие события игр — в Grafana Cloud, дашборд `https://graylichen2028.grafana.net/d/tanks-main` ([monitoring.md](monitoring.md)).
