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
  install -m 644 /opt/tanks/deploy/tanks.service /etc/systemd/system/tanks.service
  systemctl daemon-reload
  systemctl restart tanks
  sleep 1
  systemctl is-active tanks
  curl -fsS http://127.0.0.1:8080/healthz
  echo
}

main "$@"
