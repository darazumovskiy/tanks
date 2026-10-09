# Выкладка пробы

Одна машина Akamai (Linode) G7 Dedicated 4x2 в Милане, `172.232.212.157`: 2 выделенных ядра AMD EPYC 7713, 4 ГБ памяти, диск 80 ГБ, 4000 ГБ трафика в месяц, $43 в месяц. Адрес игры — `https://tankbattle.io`: домен куплен у регистратора Porkbun, в его DNS записи `A` для `tankbattle.io` и `www` указывают на `172.232.212.157`. Тот же сервер отвечает и по старому имени `https://172-232-212-157.sslip.io` (sslip.io — бесплатный DNS, превращающий IP в имя): Android-приложения до версии 0.5 открывают только его. Сертификаты на все имена Caddy получает у Let's Encrypt сам. Код — `deploy/`.

| Файл | Роль |
|---|---|
| `setup.sh` | Первичная настройка машины от root: Node 22, Caddy, Vector, пользователь `tanks`, клон репозитория в `/opt/tanks`, systemd-юниты, первая выкладка |
| `deploy-local.sh` | На машине: `git reset --hard origin/main`, `npm ci`, `npm run build`, папка журналов `/opt/tanks-logs`, задачи по расписанию `tanks-logs-cleanup` и `geo-update`, базы гео при первой выкладке, установка `tanks.service`, `Caddyfile`, конфига и drop-in Vector, `systemctl restart tanks`, `reload caddy`, `restart vector`, проверка `/healthz` |
| `deploy.sh user@host` | С рабочей машины: запускает `deploy-local.sh` по SSH ключом `~/.ssh/tanks_probe_ed25519` |
| `vector-secrets.sh user@host` | С рабочей машины: кладёт доступы Grafana Cloud из `~/.secrets-tank/grafana-cloud.env` в `/etc/default/vector` |
| `grafana-dashboard.sh` | С рабочей машины: собирает и загружает дашборд в Grafana Cloud |
| `tanks.service` | systemd: `node packages/server/dist/main.js`, `127.0.0.1:8080`, статика из `packages/client/dist`, APK из `/opt/tanks-files/tanks.apk`, журналы игр и визитов в `/opt/tanks-logs`, базы гео из `/opt/tanks-files/geo` (`GEO_DIR`), автоперезапуск. `deploy-local.sh` переустанавливает юнит при каждой выкладке |

## Серверные ручки

Правила движка задаются переменными окружения сервиса в `deploy/tanks.service` рядом с `LOG_DIR` ([round-rules.md](../backend/round-rules.md)). Скольжение вдоль стен — `WALL_SLIDE=<0–100>`, на бою 30; 0 — залипание как в `tank-arena`, 100 — стены без трения. Поменять: исправить число в `Environment=WALL_SLIDE=…` в `deploy/tanks.service`, закоммитить, запушить в `main` и выложить `deploy/deploy.sh root@172.232.212.157` — `deploy-local.sh` переустановит юнит и перезапустит сервис. Проверить: `ssh … 'systemctl show tanks -p Environment'` и строка `game start … rules=<процент>` в новом файле `/opt/tanks-logs/<gameId>.log`. Протокол при этом не меняется: клиенты узнают правило из `RoundStart`. Лаг-компенсация (догон снаряда) — `SHOT_LEAD_TICKS=<0–6>` ([shot-lead.md](../backend/shot-lead.md)); на бою не задан — выключен. Снаряд со скоростью танка — `SHOT_INHERIT_PERCENT=<0–100>` ([shot-inherit.md](../backend/shot-inherit.md)); на бою не задан — выключен. Сглаживание дёрганой сети — `NET_SMOOTHING=<0|1>` ([net-smoothing.md](../frontend/net-smoothing.md)); на бою не задано — выключено; клиенты узнают его при входе, после смены — перезагрузка страницы.
| `vector/` | Конфиг Vector и drop-in с лимитами — [monitoring.md](monitoring.md) |
| `tanks-logs-cleanup` | Ежедневный cron (`/etc/cron.daily`): удаляет журналы игр старше 7 дней и визиты (`/opt/tanks-logs/visits/`) старше 90 |
| `geo-update` | Базы DB-IP Lite (страна, город, провайдер по IP) в `/opt/tanks-files/geo`; ежемесячный cron (`/etc/cron.monthly/tanks-geo-update`) перезапускает игру, если база обновилась — [visitors.md](../backend/visitors.md) |
| `Caddyfile` | HTTPS на `tankbattle.io` и старом имени sslip.io, `www.tankbattle.io` → постоянная переадресация на `tankbattle.io`; сжатие; `/metrics` → 404, `/telemetry` → Vector, остальное (включая WebSocket) → 8080 |
| `android/` | Сборка и загрузка Android-приложения — [android-app.md](android-app.md) |

Выкладка берёт код только из `origin/main` на GitHub: сначала коммит и пуш, потом `deploy/deploy.sh root@172.232.212.157`. Перезапуск рвёт активные дуэли.

После выкладки изменений сервера — бой под нагрузкой (игра на 50 мест: один клиент и серверные боты) и ряд «Сервер: ОК?» на дашборде: все плитки зелёные. Средний процессор и память машины паузы сервера не показывают ([infra.md](../../base/infra.md), «Мониторинг и логи»).

Логи процесса: `journalctl -u tanks`, `journalctl -u caddy`, `journalctl -u vector`. Журналы игр — `/opt/tanks-logs/<gameId>.log`, один файл на дуэль, около 1 МБ в минуту боя двух игроков ([game-log.md](../backend/game-log.md)); старше 7 дней удаляет ежедневный cron `tanks-logs-cleanup`. Визиты страниц — `/opt/tanks-logs/visits/<дата>.log`, хранятся 90 дней ([visitors.md](../backend/visitors.md)). Метрики, системный журнал и редкие события игр — в Grafana Cloud, дашборд `https://graylichen2028.grafana.net/d/tanks-main` ([monitoring.md](monitoring.md)).
