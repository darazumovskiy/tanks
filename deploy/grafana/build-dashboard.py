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
HEIGHT = 8
LOGS_HEIGHT = 10

CLIENT_SECONDS = '{app="tanks",stream="game",source=~"C."} |~ " sec "'


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
    return f'avg_over_time({CLIENT_SECONDS} | regexp "{field}=(?P<{field}>\\\\d+)" | unwrap {field} [1m]) by (game, source)'


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


PANELS = [
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
    timeseries("Задержка до игроков, мс", LOKI, [loki_metric(unwrap("rtt"), "{{game}} {{source}}")], unit="ms"),
    timeseries("Кадров в секунду у игроков", LOKI, [loki_metric(unwrap("fps"), "{{game}} {{source}}")]),
    logs("Ошибки и события клиента", '{app="tanks",stream="client"}'),
    logs("События игр", '{app="tanks",stream="game"} |~ "game start|round start|leave|loop late|net |vis "'),
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
    logs("Журнал сервера (systemd)", '{app="tanks",stream="server"}', width=THIRD),
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


DASHBOARD = {
    "uid": "tanks-main",
    "title": "Танки",
    "tags": ["tanks"],
    "timezone": "browser",
    "refresh": "30s",
    "time": {"from": "now-1h", "to": "now"},
    "schemaVersion": 39,
    "panels": place(PANELS),
}

Path(__file__).with_name("tanks-dashboard.json").write_text(
    json.dumps(DASHBOARD, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
)
