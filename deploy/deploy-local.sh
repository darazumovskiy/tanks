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
  # Настройки боя — первый раз из репозитория, дальше их меняет админка.
  install -d -m 755 /etc/tanks
  [[ -f /etc/tanks/settings.env ]] || install -m 644 /opt/tanks/deploy/settings.env /etc/tanks/settings.env
  install -m 644 /opt/tanks/deploy/tanks.service /etc/systemd/system/tanks.service
  install -m 644 /opt/tanks/deploy/tanks-admin.service /etc/systemd/system/tanks-admin.service
  admin_auth >/etc/caddy/admin-auth.caddy
  install -m 644 /opt/tanks/deploy/Caddyfile /etc/caddy/Caddyfile
  caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null
  install -D -m 644 /opt/tanks/deploy/vector/vector.yaml /etc/vector/vector.yaml
  install -D -m 644 /opt/tanks/deploy/vector/vector.conf /etc/systemd/system/vector.service.d/tanks.conf
  systemctl daemon-reload
  systemctl enable tanks-admin >/dev/null
  systemctl restart tanks
  systemctl restart tanks-admin
  systemctl reload caddy
  # Vector без доступов (/etc/default/vector) не стартует; игра от этого не зависит.
  systemctl restart vector || true
  sleep 1
  systemctl is-active tanks
  curl -fsS http://127.0.0.1:8080/healthz
  echo
  systemctl is-active vector || echo "vector не запущен: journalctl -u vector"
  systemctl is-active tanks-admin
}

# Пароль админки: хэш кладётся на машину руками (deploy-proto.md, «Админка»); без него /admin/ отвечает 503.
admin_auth() {
  if [[ -s /etc/tanks/admin.hash ]]; then
    printf 'basic_auth {\n\tadmin %s\n}\n' "$(cat /etc/tanks/admin.hash)"
    return
  fi
  printf 'respond "Админка не настроена" 503\n'
}

main "$@"
