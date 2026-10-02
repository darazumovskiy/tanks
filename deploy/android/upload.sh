#!/bin/bash
# Загружает собранный APK на игровой сервер:  deploy/android/upload.sh root@172.232.212.157
# Сервер отдаёт его по /app/tanks.apk (APK_PATH в tanks.service). Перезапуск не нужен.
set -euo pipefail
HOST=${1:?укажи user@host}
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
APK="$ROOT/packages/mobile/dist/tanks.apk"
KEY=~/.ssh/tanks_probe_ed25519
[ -f "$APK" ] || { echo "нет $APK, запусти deploy/android/build.sh" >&2; exit 1; }
ssh -i "$KEY" "$HOST" 'mkdir -p /opt/tanks-files'
scp -q -i "$KEY" "$APK" "$HOST:/opt/tanks-files/tanks.apk.new"
ssh -i "$KEY" "$HOST" 'mv /opt/tanks-files/tanks.apk.new /opt/tanks-files/tanks.apk && chown -R tanks:tanks /opt/tanks-files && ls -la /opt/tanks-files/tanks.apk'
