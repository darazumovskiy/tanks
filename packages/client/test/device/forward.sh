#!/bin/bash
# Пробрасывает отладочный разъём WebView приложения на локальный порт:  forward.sh <серийник adb> [порт]
# Приложение должно быть запущено; отладка WebView включена в capacitor.config.ts.
set -euo pipefail
SERIAL=${1:?серийник из adb devices}
PORT=${2:-9444}
PID=$(adb -s "$SERIAL" shell pidof io.github.darazumovskiy.tanks | tr -d '\r')
[ -n "$PID" ] || { echo "приложение не запущено" >&2; exit 1; }
adb -s "$SERIAL" forward "tcp:$PORT" "localabstract:webview_devtools_remote_$PID" >/dev/null
curl -s "localhost:$PORT/json" | python3 -c "import sys,json; [print(p['type'], p['url']) for p in json.load(sys.stdin)]"
echo "порт $PORT → WebView pid $PID"
