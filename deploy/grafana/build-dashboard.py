#!/usr/bin/env python3
"""Собирает deploy/grafana/tanks-dashboard.json: панели дашборда «Танки» для Grafana Cloud.

Запуск: python3 deploy/grafana/build-dashboard.py — файл рядом перезаписывается.
Источники данных — стандартные для стека Grafana Cloud: grafanacloud-prom и grafanacloud-logs.
"""

import json
from pathlib import Path

PROM = {"type": "prometheus", "uid": "grafanacloud-prom"}
LOKI = {"type": "loki", "uid": "grafanacloud-logs"}
WIDTH = 24
HALF = 12
THIRD = 8
QUARTER = 6
HEIGHT = 8
STAT_HEIGHT = 5
LOGS_HEIGHT = 10

# Секундные сводки клиентов с фильтрами дашборда по платформе и оболочке.
CLIENT_SECONDS = '{app="tanks",stream="client",kind="sec",platform=~"$platform",shell=~"$shell"} | json'
CLIENT_EVENTS = '{app="tanks",stream="client",platform=~"$platform",shell=~"$shell"}'
CLIENT_ERRORS = '{app="tanks",stream="client",kind="error",platform=~"$platform",shell=~"$shell"}'
CLIENT_EVENT_LINE = (
    "{{.client_os}} {{.client_osVersion}} {{.client_browser}} {{.client_browserVersion}} {{.client_appVersion}} · {{.kind}}: {{.msg}}"
)


def timeseries(title, datasource, targets, unit="short", width=HALF, height=HEIGHT, overrides=None):
    return {
        "type": "timeseries",
        "title": title,
        "datasource": datasource,
        "gridPos": {"w": width, "h": height},
        "fieldConfig": {
            "defaults": {"unit": unit, "custom": {"lineWidth": 1, "fillOpacity": 8, "showPoints": "never"}},
            "overrides": overrides or [],
        },
        "options": {"legend": {"displayMode": "list", "placement": "bottom"}, "tooltip": {"mode": "multi"}},
        "targets": targets,
    }


def prom(expr, legend):
    return {"datasource": PROM, "expr": expr, "legendFormat": legend, "refId": legend}


def loki_metric(expr, legend):
    return {"datasource": LOKI, "expr": expr, "legendFormat": legend, "refId": legend, "queryType": "range"}


def unwrap(field):
    return f"avg_over_time({CLIENT_SECONDS} | unwrap {field} [1m]) by (game, side, platform)"


def logs(title, expr, width=HALF):
    return {
        "type": "logs",
        "title": title,
        "datasource": LOKI,
        "gridPos": {"w": width, "h": LOGS_HEIGHT},
        "options": {"showTime": True, "wrapLogMessage": True, "sortOrder": "Descending", "dedupStrategy": "none"},
        "targets": [{"datasource": LOKI, "expr": expr, "refId": "A"}],
    }


def row(title):
    return {"type": "row", "title": title, "collapsed": False, "gridPos": {"w": WIDTH, "h": 1}}


GREEN = "green"
YELLOW = "yellow"
RED = "red"
# Здоровье сервера — это отклик: паузы в сотни миллисекунд ломают игру, но в минутном среднем процессора их не видно.
HEALTH_WINDOW = "5m"


def stat(title, expr, description, unit="short", steps=None):
    thresholds = [{"color": GREEN, "value": None}] + [{"color": color, "value": value} for value, color in steps or []]
    return {
        "type": "stat",
        "title": title,
        "description": description,
        "datasource": PROM,
        "gridPos": {"w": QUARTER, "h": STAT_HEIGHT},
        "fieldConfig": {
            "defaults": {
                "unit": unit,
                "decimals": 0,
                "color": {"mode": "thresholds"},
                "thresholds": {"mode": "absolute", "steps": thresholds},
            },
            "overrides": [],
        },
        "options": {
            "colorMode": "background",
            "graphMode": "area",
            "reduceOptions": {"calcs": ["lastNotNull"], "fields": "", "values": False},
            "textMode": "value",
        },
        "targets": [{"datasource": PROM, "expr": expr, "refId": "A", "instant": False}],
    }


PANELS = [
    row("Сервер: ОК?"),
    stat(
        "Опоздавших тиков за 5 мин",
        f"sum(increase(tanks_ticks_late_total[{HEALTH_WINDOW}])) or vector(0)",
        "Тик начался позже расписания больше чем на тик. Зелёный — игра идёт ровно, красный — игроки видят рывки.",
        steps=[(10, YELLOW), (30, RED)],
    ),
    stat(
        "Самая длинная пауза сервера за 5 мин",
        f'max(max_over_time(tanks_event_loop_delay_ms{{quantile="max"}}[{HEALTH_WINDOW}]))',
        "Сколько сервер не успевал ни на что отвечать. Тик — 33 мс: пауза длиннее — тики опаздывают.",
        unit="ms",
        steps=[(33, YELLOW), (100, RED)],
    ),
    stat(
        "Худший ход ботов за 5 мин",
        f'max(max_over_time(tanks_bot_think_ms{{quantile="max"}}[{HEALTH_WINDOW}])) or vector(0)',
        "Сколько ботам понадобилось после тика в худший момент. Бюджет — 6 мс; больше тика (33 мс) — тики опаздывают.",
        unit="ms",
        steps=[(15, YELLOW), (33, RED)],
    ),
    stat(
        "Людей в игре",
        'sum(tanks_players{kind="human"}) or vector(0)',
        "Людей в играх сейчас по данным сервера; ботов — на панели «Онлайн: люди и боты».",
    ),
    row("Игра"),
    timeseries(
        "Тик, мс",
        PROM,
        [
            prom('tanks_tick_duration_ms{quantile="0.5"}', "медиана"),
            prom('tanks_tick_duration_ms{quantile="0.99"}', "p99"),
            prom('tanks_tick_duration_ms{quantile="max"}', "максимум"),
        ],
        unit="ms",
        width=THIRD,
    ),
    timeseries(
        "Задержка цикла событий, мс",
        PROM,
        [
            prom('tanks_event_loop_delay_ms{quantile="0.99"}', "p99"),
            prom('tanks_event_loop_delay_ms{quantile="max"}', "максимум"),
        ],
        unit="ms",
        width=THIRD,
    ),
    timeseries(
        "Опоздавшие тики за минуту",
        PROM,
        [prom("increase(tanks_ticks_late_total[1m])", "опоздавших")],
        width=THIRD,
    ),
    timeseries(
        "Ход серверных ботов после тика, мс",
        PROM,
        [
            prom('tanks_bot_think_ms{quantile="0.5"}', "медиана"),
            prom('tanks_bot_think_ms{quantile="0.99"}', "p99"),
            prom('tanks_bot_think_ms{quantile="max"}', "максимум"),
        ],
        unit="ms",
        width=THIRD,
    ),
    timeseries(
        "Боты: пропуски из-за бюджета и ожидание решения",
        PROM,
        [
            prom("increase(tanks_bot_skipped_total[1m])", "пропусков за минуту"),
            prom('tanks_bot_wait_ticks{quantile="max"}', "дольше всех ждал, тиков"),
        ],
        width=THIRD,
        overrides=[
            {
                "matcher": {"id": "byName", "options": "дольше всех ждал, тиков"},
                "properties": [{"id": "custom.axisPlacement", "value": "right"}],
            },
        ],
    ),
    timeseries(
        "Комнаты и сокеты",
        PROM,
        [prom("tanks_rooms", "комнат"), prom("tanks_connections", "сокетов")],
        width=THIRD,
    ),
    timeseries(
        "Сообщений в секунду",
        PROM,
        [prom("rate(tanks_messages_total[1m])", "{{direction}}")],
        unit="reqps",
        width=THIRD,
    ),
    timeseries(
        "Байт в секунду по сокетам",
        PROM,
        [prom("rate(tanks_bytes_total[1m])", "{{direction}}")],
        unit="Bps",
        width=THIRD,
    ),
    timeseries(
        "Отброшенные команды в секунду",
        PROM,
        [prom("rate(tanks_inputs_dropped_total[1m])", "{{reason}}")],
        width=HALF,
    ),
    timeseries(
        "Процесс игры: память и процессор",
        PROM,
        [
            prom("process_resident_memory_bytes", "память"),
            prom("rate(process_cpu_seconds_total[1m]) * 100", "процессор, %"),
        ],
        width=HALF,
        overrides=[
            {"matcher": {"id": "byName", "options": "память"}, "properties": [{"id": "unit", "value": "bytes"}]},
            {
                "matcher": {"id": "byName", "options": "процессор, %"},
                "properties": [{"id": "unit", "value": "percent"}, {"id": "custom.axisPlacement", "value": "right"}],
            },
        ],
    ),
    row("Игроки"),
    timeseries(
        "Онлайн: люди и боты",
        PROM,
        [
            prom('sum(tanks_players{kind="human"})', "люди"),
            prom('sum(tanks_players{kind="bot"})', "серверные боты"),
            prom('sum(tanks_players{kind="swarm"})', "рой"),
        ],
    ),
    timeseries(
        "Люди по играм",
        PROM,
        [prom('sum by (mode) (tanks_players{kind="human"})', "{{mode}}")],
    ),
    timeseries("Задержка до игроков, мс", LOKI, [loki_metric(unwrap("rtt"), "{{game}} {{side}} {{platform}}")], unit="ms"),
    timeseries("Кадров в секунду у игроков", LOKI, [loki_metric(unwrap("fps"), "{{game}} {{side}} {{platform}}")]),
    timeseries(
        "Худший кадр у игроков, мс",
        LOKI,
        [loki_metric(unwrap("worst"), "{{game}} {{side}} {{platform}}")],
        unit="ms",
        width=THIRD,
    ),
    timeseries(
        "Устройства людей по платформам",
        LOKI,
        [loki_metric(f"count by (platform) (sum by (game, side, platform) (count_over_time({CLIENT_SECONDS} [1m])))", "{{platform}}")],
        width=THIRD,
    ),
    timeseries(
        "Ошибок клиента в минуту",
        LOKI,
        [loki_metric(f"sum(count_over_time({CLIENT_ERRORS} [1m])) by (platform)", "{{platform}}")],
        width=THIRD,
    ),
    logs("Ошибки и события клиента", f'{CLIENT_EVENTS} | json | line_format "{CLIENT_EVENT_LINE}"'),
    logs("События игр", '{app="tanks",stream="game"}'),
    row("Машина"),
    timeseries(
        "Процессор машины, %",
        PROM,
        [
            prom('100 - rate(host_cpu_seconds_total{mode="idle"}[1m]) * 100', "занято"),
            prom('rate(host_cpu_seconds_total{mode="io_wait"}[1m]) * 100', "ожидание диска"),
        ],
        unit="percent",
        width=THIRD,
    ),
    timeseries(
        "Ожидание процессора, мс в секунду",
        PROM,
        [
            prom('rate(tanks_cpu_pressure_seconds_total{scope="game"}[1m]) * 1000', "игра ждала ядро"),
            prom('rate(tanks_cpu_pressure_seconds_total{scope="machine"}[1m]) * 1000', "кто-то на машине ждал ядро"),
            prom("rate(tanks_cpu_steal_seconds_total[1m]) * 1000", "забрали соседи по железу"),
        ],
        unit="ms",
        width=THIRD,
    ),
    timeseries(
        "Память машины",
        PROM,
        [
            prom("host_memory_used_bytes", "занято"),
            prom("host_memory_available_bytes", "доступно"),
            prom("host_memory_swap_used_bytes", "своп"),
        ],
        unit="bytes",
        width=THIRD,
    ),
    timeseries("Средняя нагрузка", PROM, [prom("host_load1", "1 мин"), prom("host_load5", "5 мин")], width=THIRD),
    timeseries(
        "Сеть машины",
        PROM,
        [
            prom("rate(host_network_receive_bytes_total[1m])", "приём"),
            prom("rate(host_network_transmit_bytes_total[1m])", "отдача"),
        ],
        unit="Bps",
        width=THIRD,
    ),
    timeseries(
        "Диск занят, %",
        PROM,
        [prom('host_filesystem_used_ratio{mountpoint="/"} * 100', "/")],
        unit="percent",
        width=THIRD,
    ),
    logs("Журнал сервера (systemd)", '{app="tanks",stream="server"}', width=WIDTH),
]


def place(panels):
    x = 0
    y = 0
    row_height = 0
    for panel_id, panel in enumerate(panels, start=1):
        panel["id"] = panel_id
        width = panel["gridPos"]["w"]
        height = panel["gridPos"]["h"]
        if panel["type"] == "row" or x + width > WIDTH:
            x = 0
            y += row_height
            row_height = 0
        panel["gridPos"].update({"x": x, "y": y})
        x += width
        row_height = max(row_height, height)
        if panel["type"] == "row":
            x = 0
            y += 1
            row_height = 0
    return panels


def label_variable(name, label):
    return {
        "type": "query",
        "name": name,
        "label": label,
        "datasource": LOKI,
        "query": {"label": name, "refId": "LokiVariableQueryEditor-VariableQuery", "stream": '{app="tanks",stream="client"}', "type": 1},
        "includeAll": True,
        "multi": True,
        "allValue": ".*",
        "current": {"text": "All", "value": "$__all"},
        "refresh": 2,
        "sort": 1,
    }


DASHBOARD = {
    "uid": "tanks-main",
    "title": "Танки",
    "tags": ["tanks"],
    "timezone": "browser",
    "refresh": "30s",
    "time": {"from": "now-1h", "to": "now"},
    "schemaVersion": 39,
    "templating": {"list": [label_variable("platform", "Платформа"), label_variable("shell", "Оболочка")]},
    "panels": place(PANELS),
}

Path(__file__).with_name("tanks-dashboard.json").write_text(
    json.dumps(DASHBOARD, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
)
