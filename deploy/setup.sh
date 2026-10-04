#!/bin/bash
# Первичная настройка машины под игровой сервер: Node 22, Caddy с автоматическим HTTPS, systemd-юнит.
# Запускается на машине от root:  TANKS_HOST=172-232-212-157.sslip.io bash setup.sh
set -euo pipefail

: "${TANKS_HOST:?задай TANKS_HOST — имя, на которое Caddy выпустит сертификат}"
REPO=https://github.com/darazumovskiy/tanks.git

if ! command -v node >/dev/null; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y -qq nodejs
fi

if ! command -v caddy >/dev/null; then
  apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https curl
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq
  apt-get install -y -qq caddy
fi

if ! command -v vector >/dev/null; then
  bash -c "$(curl -fsSL https://setup.vector.dev)"
  apt-get install -y -qq vector
  usermod -aG systemd-journal vector
fi
[ -f /etc/default/vector ] || echo "нет /etc/default/vector — выполни deploy/vector-secrets.sh с рабочей машины" >&2

id -u tanks >/dev/null 2>&1 || useradd --system --home /opt/tanks --shell /usr/sbin/nologin tanks

if [ ! -d /opt/tanks/.git ]; then
  git clone --depth 1 "$REPO" /opt/tanks
fi
chown -R tanks:tanks /opt/tanks

install -m 644 /opt/tanks/deploy/tanks.service /etc/systemd/system/tanks.service
install -m 644 /opt/tanks/deploy/Caddyfile /etc/caddy/Caddyfile
mkdir -p /etc/systemd/system/caddy.service.d
printf '[Service]\nEnvironment=TANKS_HOST=%s\n' "$TANKS_HOST" > /etc/systemd/system/caddy.service.d/tanks.conf

systemctl daemon-reload
systemctl enable tanks caddy vector >/dev/null
bash /opt/tanks/deploy/deploy-local.sh
echo "готово: https://$TANKS_HOST"
