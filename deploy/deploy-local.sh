#!/bin/bash
# Выкладка на самой машине: обновить код, собрать, перезапустить сервис. Вызывается setup.sh и deploy.sh.
set -euo pipefail

# Тело в функции: bash разбирает её целиком до запуска, и подмена этого файла при git reset
# не оставляет выполняться старую версию скрипта.
main() {
  cd /opt/tanks
  sudo -u tanks git fetch -q --depth 1 origin main
  sudo -u tanks git reset -q --hard origin/main
  sudo -u tanks npm ci --no-audit --no-fund --silent
  sudo -u tanks npm run -s build
  install -d -o tanks -g tanks -m 755 /opt/tanks-logs
  install -m 755 /opt/tanks/deploy/tanks-logs-cleanup /etc/cron.daily/tanks-logs-cleanup
  install -D -m 755 /opt/tanks/deploy/geo-update /etc/cron.monthly/tanks-geo-update
  # Без баз гео игра работает, у визитов просто нет страны и города.
  if [[ ! -f /opt/tanks-files/geo/dbip-city-lite.mmdb ]]; then
    bash /opt/tanks/deploy/geo-update --no-restart || echo "базы гео не скачаны: bash /opt/tanks/deploy/geo-update"
  fi
  install -m 644 /opt/tanks/deploy/tanks.service /etc/systemd/system/tanks.service
  install -m 644 /opt/tanks/deploy/Caddyfile /etc/caddy/Caddyfile
  install -D -m 644 /opt/tanks/deploy/vector/vector.yaml /etc/vector/vector.yaml
  install -D -m 644 /opt/tanks/deploy/vector/vector.conf /etc/systemd/system/vector.service.d/tanks.conf
  systemctl daemon-reload
  systemctl restart tanks
  systemctl reload caddy
  # Vector без доступов (/etc/default/vector) не стартует; игра от этого не зависит.
  systemctl restart vector || true
  sleep 1
  systemctl is-active tanks
  curl -fsS http://127.0.0.1:8080/healthz
  echo
  systemctl is-active vector || echo "vector не запущен: journalctl -u vector"
}

main "$@"
