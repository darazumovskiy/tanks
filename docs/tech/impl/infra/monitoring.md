# Мониторинг и логи

Метрики сервера, системный журнал, редкие события игры и ошибки клиента собираются в Grafana Cloud (бесплатный тариф: 10 000 рядов метрик, 50 ГБ логов в месяц, 14 дней хранения). Игровой процесс в облако ничего не отправляет: он только увеличивает счётчики в памяти и дописывает строки в файлы на диске; отправкой занимается отдельный процесс Vector на той же машине. Падение, зависание или отсутствие Vector и облака не меняет ни тик, ни задержку до клиента — между игрой и сбором нет ни одного вызова, который мог бы ждать.

Код: `packages/server/src/metrics.ts` (счётчики и текст `/metrics`), `packages/server/src/app.ts` (ручка, подсчёт сообщений), `packages/server/src/main.ts` (адрес прослушивания), `packages/client/src/clientInfo.ts` (описание клиента), `packages/client/src/telemetry.ts` (очередь событий клиента), `packages/client/src/game.ts` и `main.ts` (откуда события), `packages/client/vite.config.ts` (`APP_VERSION` — хеш коммита), `deploy/vector/`, `deploy/Caddyfile`, `deploy/grafana/build-dashboard.py`.

## Схема

```
игра (node)  --счётчики в памяти-->  GET /metrics  <--раз в 15 с--  Vector  --> Grafana Cloud Metrics
игра (node)  --appendFile-->  /opt/tanks-logs/*.log, journald  <--tail--  Vector  --> Grafana Cloud Logs
браузер  --sendBeacon-->  Caddy /telemetry  -->  Vector :8094  --> Grafana Cloud Logs
```

Vector держит очереди на диске (по 256 МБ на приёмник, при переполнении выбрасывает новое) и ограничен в systemd: `MemoryMax=150M`, `CPUWeight=20` против 100 у игры — при нехватке ядра процессор достаётся игре, при нехватке памяти система убивает Vector, а не игру. В покое Vector занимает ~90 МБ.

## Сервер

### Адрес прослушивания

Игра слушает `HOST` (на бою `127.0.0.1`, умолчание `0.0.0.0` для локальной разработки и тестов). Снаружи доступен только Caddy; `/metrics` Caddy не проксирует (отвечает 404), ручка достижима только с машины.

### `GET /metrics`

Текст в формате Prometheus. Счётчики — монотонные, окно для квантилей — с прошлого запроса ручки (после ответа гистограммы сбрасываются).

| Ряд | Тип | Смысл |
|---|---|---|
| `tanks_tick_duration_ms{quantile="0.5"\|"0.99"\|"max"}` | gauge | длительность `rooms.step` за окно |
| `tanks_event_loop_delay_ms{quantile="0.5"\|"0.99"\|"max"}` | gauge | опоздание цикла событий Node: на сколько таймер с шагом 10 мс сработал позже срока — первый признак перегрузки |
| `tanks_ticks_total` | counter | тиков с запуска |
| `tanks_ticks_late_total` | counter | тиков, начавшихся позже расписания больше чем на тик |
| `tanks_rooms`, `tanks_connections` | gauge | комнат и сокетов сейчас |
| `tanks_messages_total{direction="in"\|"out"}` | counter | сообщений по сокетам |
| `tanks_bytes_total{direction="in"\|"out"}` | counter | байт по сокетам |
| `tanks_inputs_dropped_total{reason="stale"\|"limit"}` | counter | команд отброшено как устаревшие или сверх лимита за тик |
| `process_resident_memory_bytes`, `process_cpu_seconds_total`, `process_start_time_seconds` | gauge/counter | процесс |

Подсчёт — инкремент числа или запись в гистограмму `perf_hooks.createHistogram` (микросекунды); аллокаций и вызовов наружу внутри тика нет. Текст собирается только при запросе ручки. Сообщения и байты считаются только по сокетам: подключения ботов внутри процесса сетью не являются.

### Логи в облако

Vector читает `journalctl` юнитов `tanks`, `caddy` и `vector` целиком и файлы `/opt/tanks-logs/*.log` с фильтром по ключевому слову после `gt= tc=` (у строк клиента перед ним ещё `now=`). Подробный журнал игры (строки `tick`, `snap`, `in`, `cam`) остаётся на диске по [game-log.md](../backend/game-log.md); в облако уходят только:

| Префикс | Источник | Зачем |
|---|---|---|
| `game start`, `round start`, `leave` | сервер | число и длительность игр |
| `loop late` | сервер | опоздания тика |
| `device`, `net `, `vis ` | клиент | соединения, переподключения, устройства |
| `sec ` | клиент, раз в секунду | задержка до клиента (`rtt=`), кадры (`fps=`) — до появления секундной сводки в `/telemetry` |

Метки Loki: `app=tanks`, `stream=server|game|client`; у `server` — `unit`, у `game` — `game=<gameId или room-код>` и `source=S|C0|C1`, у `client` — `kind`, `game`, `side`, `platform`, `shell`.

## Измерения (фильтры)

Любая цифра про игроков режется по признакам клиента: телефон или компьютер, Android или iOS, версия системы, браузер или наше приложение, версия клиента. Набор признаков открытый — новый добавляется полем, а не новой метрикой.

Описание клиента (`ClientInfo`) собирается один раз при старте и едет в каждой пачке событий:

| Поле | Значения | Откуда |
|---|---|---|
| `platform` | `android`, `ios`, `desktop` | `navigator.userAgentData` / `userAgent` |
| `shell` | `app` (Capacitor), `browser`, `pwa` | `Capacitor.isNativePlatform()`, `display-mode: standalone` |
| `os`, `osVersion` | `Android 14`, `iOS 17.5`, `macOS 14`, `Windows 11` | `userAgent` |
| `browser`, `browserVersion` | `Chrome 130`, `Safari 17` | `userAgent` |
| `appVersion` | версия клиента — короткий хеш коммита (`APP_VERSION` через `define` Vite; в тестах `test`, вне git `dev`) | сборка |
| `screen`, `dpr`, `touch` | `1080x2400`, `2.75`, `1` | `window`, `navigator` |

Где какой признак живёт: метками Loki (по ним индекс, их мало) — `platform`, `shell`, `kind`, `game`, `side`; остальные — полями события в теле строки (JSON), фильтруются и группируются в LogQL (`| json | os="Android 14"`). Правило: метка — только признак с десятком значений и меньше; версии, модели, размеры — поля. Это держит число потоков Loki в рамках бесплатного тарифа при любом росте признаков.

Серверные метрики `/metrics` по платформам не делятся: сервер не знает клиента. Когда понадобится (`tanks_connections{platform=…}`, отброшенные команды по платформам) — в `Join` добавляется поле с `ClientInfo`, сервер держит счётчики по платформе; это изменение протокола и отдельный шаг.

## Клиент

### `POST /telemetry`

События браузера, которые нужны с фильтрами по клиенту: ошибки (`window.onerror`, `unhandledrejection`, ошибка сокета, невозможность переподключиться), сетевые события и секундная сводка (`fps`, `worst`, `rtt`, `pend`, `snaps`, `ins` — та же, что строка `sec` в журнале игры). Caddy проксирует маршрут во Vector (`127.0.0.1:8094`, источник `http_server`), игровой процесс запросов не видит. Тело — JSON-строки через `\n`, в каждой — событие и описание клиента: `{"t":<мс>,"kind":"error|net|sec","msg":"...","game":"K7MF","side":0,"client":{"platform":"android","shell":"app","os":"Android 14",…},"fps":58,"rtt":51,…}`; лимит тела в Caddy 64 КБ.

Клиент складывает события в очередь не длиннее 50 (старое выбрасывается), раз в 5 секунд отправляет пачкой `navigator.sendBeacon`; ответ не читается, ошибка отправки глотается, в кадровом цикле — только добавление в очередь. Подробный журнал игры (`diag.ts`, `/log`) не меняется. С появлением секундной сводки в `/telemetry` строки `sec` из файлов журнала в облако не отправляются — графики игроков строятся по событиям с измерениями.

## Деплой

Стек Grafana Cloud — `graylichen2028` (регион `prod-eu-west-2`), Grafana `https://graylichen2028.grafana.net`, источники данных `grafanacloud-prom` и `grafanacloud-logs`.

- `deploy/vector/vector.yaml` — источники (`prometheus_scrape` на `127.0.0.1:8080/metrics`, `host_metrics`, `journald` юнитов `tanks`, `caddy`, `vector`, `file` по `/opt/tanks-logs/*.log` не старше часа, `http_server` на `127.0.0.1:8094/telemetry`), фильтр строк журнала, метки Loki объектом `.labels` на каждый поток, приёмники `prometheus_remote_write` (проверка здоровья выключена: на GET приёмник отвечает 405) и `loki`, очереди на диске по 256 МБ с выбрасыванием нового при переполнении.
- `deploy/vector/vector.conf` — drop-in `/etc/systemd/system/vector.service.d/tanks.conf` к юниту из пакета: `MemoryMax=150M`, `CPUWeight=20`, `Nice=5`, включение подстановки `${…}` из окружения (`VECTOR_DANGEROUSLY_ALLOW_ENV_VAR_INTERPOLATION`).
- Доступы — `/etc/default/vector` (root, 600; юнит пакета читает его как `EnvironmentFile`), кладутся с рабочей машины: `deploy/vector-secrets.sh root@<машина>` берёт строки `GRAFANA_CLOUD_*` из `~/.secrets-tank/grafana-cloud.env`. Адрес Loki в файле — без пути (`https://logs-prod-012.grafana.net`), адрес Prometheus — полный до `/api/prom/push`.
- `deploy/setup.sh` ставит Vector из репозитория `setup.vector.dev` и добавляет пользователя `vector` в группу `systemd-journal`; `deploy-local.sh` при каждой выкладке переустанавливает `vector.yaml`, drop-in и `Caddyfile`, перезагружает Caddy и перезапускает Vector (без доступов Vector не стартует, игра от этого не зависит).
- `deploy/Caddyfile` — `/metrics` → 404, `/telemetry` → Vector с лимитом тела 64 КБ, остальное → игра.
- `deploy/grafana/build-dashboard.py` собирает `tanks-dashboard.json` (uid `tanks-main`: тик и цикл событий, опоздавшие тики, комнаты и сокеты, сообщения и байты, отброшенные команды, процесс игры, задержка и кадры игроков из строк `sec`, события клиента и игр, процессор, память, нагрузка, сеть и диск машины, журнал systemd); `deploy/grafana-dashboard.sh` загружает его по API сервисным аккаунтом из `grafana-cloud.env`.
- MCP проекта — `.cursor/mcp.json` → `.cursor/bin/mcp-grafana.sh`: читает `GRAFANA_URL` и `GRAFANA_SERVICE_ACCOUNT_TOKEN` из `grafana-cloud.env`, запускает `mcp-grafana`; агент читает дашборды и делает запросы к метрикам и логам без браузера.

## План тестирования

Сервер — через HTTP и сокет (`packages/server/test/metrics.test.ts`):

| Сценарий | Ожидание | Статус |
|---|---|---|
| `GET /metrics` на пустом сервере | 200, `text/plain; version=0.0.4`, ровно ряды из таблицы в порядке таблицы, `tanks_rooms 0`, память и старт процесса заполнены | авто |
| Два клиента отыгрывают тики с вводом | `tanks_ticks_total` растёт, `tanks_rooms 1`, `tanks_connections 2`, `messages_total{in}` = входы + команды, `messages_total{out}` > 0, `bytes_total{out}` > `messages_total{out}`, квантили тика > 0 | авто |
| Устаревший `seq` и сверх лимита | `inputs_dropped_total{reason="stale"}` и `{reason="limit"}` увеличились ровно на число отброшенных | авто |
| Комната без счётчика (стенд бот против бота строит `Room` напрямую) | устаревшая команда отбрасывается без ошибки | авто |
| Два запроса `/metrics` подряд (тик 300 мс) | до первого тика `ticks_total 0` и `max 0`; после тика `ticks_total 1`, `max` > 0; следующий запрос сразу — `max 0`, `ticks_total` не уменьшился | авто |
| Поток заблокирован на 25 тиков (`Atomics.wait`) | `ticks_late_total` ≥ 1, `event_loop_delay_ms{max}` ≥ 80 % времени блокировки | авто |
| `HOST=127.0.0.1` в `tanks.service` | `ss -ltnp` показывает 8080 только на `127.0.0.1`; снаружи порт закрыт | вручную на боевом сервере — выполнено 2026-10-04 |
| `/metrics` через Caddy снаружи | 404 | вручную на боевом сервере — выполнено 2026-10-04 |
| `POST /telemetry` снаружи: строка JSON; тело 100 КБ | 200, строка видна в Loki с метками `stream=client`, `kind`, `game`, `side`; 413 | вручную на боевом сервере — выполнено 2026-10-04 |
| Строки `sec`, `round start` и `snap` дописаны в файл журнала | первые две в Loki с `game` и `source`, `snap` отфильтрована | вручную на боевом сервере — выполнено 2026-10-04 |
| Vector остановлен (`systemctl stop vector`) во время дуэли | `tick_duration` и `rtt` в журнале игры не меняются; соединения живы | вручную на боевом сервере — выполнено 2026-10-04: дуэль с манекеном из браузера, 15 с без Vector — rtt 50–53 мс, 30 тиков/с, поправок 0 |
| Доступы Grafana Cloud неверные | Vector пишет ошибку в свой журнал, очередь на диске не растёт выше лимита, игра не замечает | вручную на боевом сервере |

Клиент (`packages/client/src/clientInfo.test.ts`, `telemetry.test.ts`, happy-dom):

| Сценарий | Ожидание | Статус |
|---|---|---|
| Ошибка `window.onerror` и отклонённый промис | события `kind=error` с текстом (файл и строка, имя и текст исключения), `game`/`side`, описанием клиента; после `close` обработчики сняты | авто |
| Описание клиента на десяти агентах: Android Chrome и Samsung, iPhone Safari и Chrome, iPad в режиме компьютера (Mac + касание → iPadOS), macOS Chrome, Windows Firefox и Edge, Linux Chrome, `curl` | `platform`, `os`, `osVersion`, `browser`, `browserVersion` разобраны верно; неизвестный агент — `unknown`, без исключения; Windows NT 6.1 → 7, незнакомый NT — номером | авто |
| Оболочка | Capacitor → `app`, standalone → `pwa`, иначе `browser` | авто |
| `readClientInfo` в happy-dom | `appVersion` из `APP_VERSION`, экран `WxH`, оболочка из трёх допустимых | авто |
| Событие | несёт `t`, `kind`, `msg`, `game`, `side`, `client` и поля; до входа в игру `game=""`, `side=-1`; после `leaveGame` — снова | авто |
| Таймер отправки | пустая очередь не отправляется; непустая уходит одной пачкой JSON-строк через `sendBeacon` на `/telemetry` и очищается; `pagehide` отправляет сразу | авто |
| `sendBeacon` вернул `false`, бросил исключение или отсутствует | исключения нет, очередь очищена | авто |
| 60 событий без отправки | в очереди 50 последних | авто |
| Бой в браузере на боевом сервере | в Loki события `kind=sec` раз в секунду с `platform=desktop`, `client.os`, `client.browser`, `appVersion` = хеш выкладки; панели игроков на дашборде фильтруются по платформе | вручную агентом после выкладки |

Сквозной прогон (`npm run test:e2e`):

| Сценарий | Ожидание | Статус |
|---|---|---|
| Два браузера играют | `/metrics` локального сервера показывает `tanks_rooms 1`, `connections 2`, растущие `messages_total` | авто |
| Дашборд `tanks-main` | панели машины, логов и игры заполнены (рендер панелей «Память машины» и «Тик» 2026-10-04 во время дуэли с манекеном); панели игроков — после секундной сводки шага 2 | вручную агентом через MCP и в браузере |
