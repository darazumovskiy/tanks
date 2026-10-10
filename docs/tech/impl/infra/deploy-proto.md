# Выкладка пробы

Одна машина Akamai (Linode) G7 Dedicated 4x2 в Милане, `172.232.212.157`: 2 выделенных ядра AMD EPYC 7713, 4 ГБ памяти, диск 80 ГБ, 4000 ГБ трафика в месяц, $43 в месяц. Адрес игры — `https://tankbattle.io`: домен куплен у регистратора Porkbun, в его DNS записи `A` для `tankbattle.io` и `www` указывают на `172.232.212.157`. Тот же сервер отвечает и по старому имени `https://172-232-212-157.sslip.io` (sslip.io — бесплатный DNS, превращающий IP в имя): Android-приложения до версии 0.5 открывают только его. Сертификаты на все имена Caddy получает у Let's Encrypt сам. Код — `deploy/`.

| Файл | Роль |
|---|---|
| `setup.sh` | Первичная настройка машины от root: Node 22, Caddy, Vector, пользователь `tanks`, клон репозитория в `/opt/tanks`, systemd-юниты, первая выкладка |
| `deploy-local.sh` | На машине: `git reset --hard origin/main`, `npm ci`, `npm run build`, папка журналов `/opt/tanks-logs`, задачи по расписанию `tanks-logs-cleanup` и `geo-update`, базы гео при первой выкладке, первый `/etc/tanks/settings.env`, установка `tanks.service`, `tanks-admin.service`, блока пароля админки, `Caddyfile` с проверкой `caddy validate`, конфига и drop-in Vector, `systemctl restart tanks` и `tanks-admin`, `reload caddy`, `restart vector`, проверка `/healthz` |
| `deploy.sh user@host` | С рабочей машины: запускает `deploy-local.sh` по SSH ключом `~/.ssh/tanks_probe_ed25519` |
| `vector-secrets.sh user@host` | С рабочей машины: кладёт доступы Grafana Cloud из `~/.secrets-tank/grafana-cloud.env` в `/etc/default/vector` |
| `grafana-dashboard.sh` | С рабочей машины: собирает и загружает дашборд в Grafana Cloud |
| `tanks.service` | systemd: `node packages/server/dist/main.js`, `127.0.0.1:8080`, статика из `packages/client/dist`, APK из `/opt/tanks-files/tanks.apk`, журналы игр и визитов в `/opt/tanks-logs`, базы гео из `/opt/tanks-files/geo` (`GEO_DIR`), настройки боя из `/etc/tanks/settings.env` (`EnvironmentFile`), версия сервера `TANKS_BUILD` из `/etc/tanks/build.env` — перед каждым запуском его пишет [build-env](../../../../deploy/build-env), автоперезапуск. `deploy-local.sh` переустанавливает юнит при каждой выкладке |
| `tanks-admin.service` | systemd: админка настроек боя от root на `127.0.0.1:8090` — «Настройки боя и админка» |
| `build-env` | Перед запуском `tanks` от root, сбой не мешает запуску игры (`ExecStartPre=-+`): коммит из `/opt/tanks/COMMIT` (тестовая машина), иначе `git rev-parse --short HEAD` в `/opt/tanks`, иначе `dev` → `/etc/tanks/build.env`. Сервер пишет коммит в журнал каждой игры (`build server=`) и в `/healthz` ([game-log.md](../backend/game-log.md)). Версию ставит юнит, а не скрипт выкладки: `deploy.sh` исполняет прежнюю версию `deploy-local.sh`, а юнит берётся уже из нового кода |
| `settings.env` | Настройки боя для первой выкладки: лаг-компенсация 4, скорость танка у снаряда 0, сглаживание 1 |
| `test/` | Выкладка на тестовую машину — «Тестовая машина» |

## Серверные ручки

Правила движка задаются переменными окружения сервиса в `deploy/tanks.service` рядом с `LOG_DIR` ([round-rules.md](../backend/round-rules.md)). Скольжение вдоль стен — `WALL_SLIDE=<0–100>`, на бою 30; 0 — залипание как в `tank-arena`, 100 — стены без трения. Поменять: исправить число в `Environment=WALL_SLIDE=…` в `deploy/tanks.service`, закоммитить, запушить в `main` и выложить `deploy/deploy.sh root@172.232.212.157` — `deploy-local.sh` переустановит юнит и перезапустит сервис. Проверить: `ssh … 'systemctl show tanks -p Environment'` и строка `game start … rules=<процент>` в новом файле `/opt/tanks-logs/<gameId>.log`. Протокол при этом не меняется: клиенты узнают правило из `RoundStart`.
| `vector/` | Конфиг Vector и drop-in с лимитами — [monitoring.md](monitoring.md) |
| `tanks-logs-cleanup` | Ежедневный cron (`/etc/cron.daily`): удаляет журналы игр старше 7 дней и визиты (`/opt/tanks-logs/visits/`) старше 90 |
| `geo-update` | Базы DB-IP Lite (страна, город, провайдер по IP) в `/opt/tanks-files/geo`; ежемесячный cron (`/etc/cron.monthly/tanks-geo-update`) перезапускает игру, если база обновилась — [visitors.md](../backend/visitors.md) |
| `Caddyfile` | HTTPS на `tankbattle.io` и старом имени sslip.io, `www.tankbattle.io` → постоянная переадресация на `tankbattle.io`; сжатие; `/metrics` → 404, `/telemetry` → Vector, `/admin/` → админка под паролем, остальное (включая WebSocket) → 8080 |
| `android/` | Сборка и загрузка Android-приложения — [android-app.md](android-app.md) |

Выкладка берёт код только из `origin/main` на GitHub: сначала коммит и пуш, потом `deploy/deploy.sh root@172.232.212.157`. Перезапуск рвёт активные дуэли. Выкладка исполняет `deploy-local.sh` той версии, что лежала на машине до неё: новые шаги самого скрипта работают со следующей выкладки — после правки скрипта выкладку повторить.

После выкладки изменений сервера — бой под нагрузкой (игра на 50 мест: один клиент и серверные боты) и ряд «Сервер: ОК?» на дашборде: все плитки зелёные. Средний процессор и память машины паузы сервера не показывают ([infra.md](../../base/infra.md), «Мониторинг и логи»).


## Настройки боя и админка

Лаг-компенсация `SHOT_LEAD_TICKS` ([shot-lead.md](../backend/shot-lead.md)), снаряд со скоростью танка `SHOT_INHERIT_PERCENT` ([shot-inherit.md](../backend/shot-inherit.md)) и сглаживание сети `NET_SMOOTHING` ([net-smoothing.md](../frontend/net-smoothing.md)) — в `/etc/tanks/settings.env` на машине, `tanks.service` читает его через `EnvironmentFile`. Первую выкладку файл получает из [settings.env](../../../../deploy/settings.env) — 4, 0, 1; дальше выкладки его не трогают, его меняет админка.

Админка — `https://tankbattle.io/admin/`, логин `admin`: пульт стенда без посредника сети ([lag-lab.md](../frontend/lag-lab.md), «Админка тестовой машины»). Служба `tanks-admin` ([tanks-admin.service](../../../../deploy/tanks-admin.service)) от root на `127.0.0.1:8090`: пишет файл настроек, перезапускает `tanks` и ждёт `/healthz`; перезапуск рвёт текущие бои, открытые вкладки переподключаются сами уже с новыми правилами. Caddy пускает на `/admin/` по basic auth: `deploy-local.sh` пишет `/etc/caddy/admin-auth.caddy` из хэша пароля в `/etc/tanks/admin.hash`; хэша нет — `/admin/` отвечает 503. Пароль у оператора в `~/.secrets-tank/admin-password`; положить или сменить хэш:

```bash
ssh -i ~/.ssh/tanks_probe_ed25519 root@172.232.212.157 'install -d -m 755 /etc/tanks && PW=$(cat) && caddy hash-password --plaintext "$PW" > /etc/tanks/admin.hash && chmod 600 /etc/tanks/admin.hash' < ~/.secrets-tank/admin-password
```

После смены хэша — выкладка `deploy/deploy.sh root@172.232.212.157`: она пересобирает блок пароля и перезагружает Caddy.

## Тестовая машина

Временная машина для проверки игры на настоящем дальнем пинге: Akamai (Linode) Linode 4 GB в Сиэтле, `172.238.33.233`, $0,036 в час; пинг с Кипра около 200 мс. Адрес — `https://172-238-33-233.sslip.io`, админка — `/admin/` под логином `admin` и паролем (пароль у оператора, на машине — только хэш в `/etc/tanks/admin.hash`). После проверки машину удаляет оператор.

Выкладка — `deploy/test/deploy-test.sh root@172.238.33.233 <ветка или коммит>` с рабочей машины: архив коммита из локального репозитория уходит по SSH, без пуша в GitHub; на машине [remote.sh](../../../../deploy/test/remote.sh) ставит Node 22 и Caddy (из репозитория Ubuntu), собирает с `TANKS_BUILD=<коммит>` — клиент получает ту же версию, что и сервер (архив без `.git`, коммит пишется в `/opt/tanks/COMMIT`), ставит `tanks.service` из коммита с дополнением `EnvironmentFile=-/etc/tanks/settings.env`, пишет Caddyfile на имя sslip.io. Vector не ставится: метрики и журнал в Grafana не уходят, `/telemetry` отвечает 204. Есть в коммите юнит админки и хэш пароля на машине — служба `tanks-admin` и `/admin/` в Caddy под basic auth, как на боевой. Журналы игр — `/opt/tanks-logs`, как на боевой.

Логи процесса: `journalctl -u tanks`, `journalctl -u caddy`, `journalctl -u vector`. Журналы игр — `/opt/tanks-logs/<gameId>.log`, один файл на дуэль, около 1 МБ в минуту боя двух игроков ([game-log.md](../backend/game-log.md)); старше 7 дней удаляет ежедневный cron `tanks-logs-cleanup`. Визиты страниц — `/opt/tanks-logs/visits/<дата>.log`, хранятся 90 дней ([visitors.md](../backend/visitors.md)). Метрики, системный журнал и редкие события игр — в Grafana Cloud, дашборд `https://graylichen2028.grafana.net/d/tanks-main` ([monitoring.md](monitoring.md)).
