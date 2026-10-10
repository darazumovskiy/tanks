#!/bin/bash
# На тестовой машине от root, вызывается deploy-test.sh: код уже распакован в /opt/tanks.next.
#   bash remote.sh <имя сайта> <коммит>
# Без Vector: метрики и журнал тестовой машины в Grafana не уходят.
set -euo pipefail

NAME=$1
COMMIT=$2
SETTINGS=/etc/tanks/settings.env
# Хэш пароля админки (caddy hash-password) кладётся на машину руками; без него или без админки в коммите /admin нет.
ADMIN_HASH_FILE=/etc/tanks/admin.hash
ADMIN_UNIT=deploy/tanks-admin.service
ADMIN_USER=admin
ADMIN_PORT=8090

main() {
  if ! command -v node >/dev/null; then
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
    apt-get install -y -qq nodejs
  fi
  # Caddy — из репозитория Ubuntu: репозиторий Caddy на cloudsmith отвечает 402.
  if ! command -v caddy >/dev/null; then
    apt-get update -qq
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq caddy
  fi
  id -u tanks >/dev/null 2>&1 || useradd --system --home /opt/tanks --shell /usr/sbin/nologin tanks

  rm -rf /opt/tanks
  mv /opt/tanks.next /opt/tanks
  echo "$COMMIT" >/opt/tanks/COMMIT
  chown -R tanks:tanks /opt/tanks
  cd /opt/tanks
  sudo -u tanks npm ci --no-audit --no-fund --silent
  sudo -u tanks TANKS_BUILD="$COMMIT" npm run -s build
  install -d -o tanks -g tanks -m 755 /opt/tanks-logs

  install -d -m 755 /etc/tanks
  if [[ ! -f $SETTINGS ]]; then
    cp /opt/tanks/deploy/settings.env "$SETTINGS" 2>/dev/null || : >"$SETTINGS"
  fi
  install -m 644 /opt/tanks/deploy/tanks.service /etc/systemd/system/tanks.service
  install -d -m 755 /etc/systemd/system/tanks.service.d
  printf '[Service]\nEnvironmentFile=-%s\n' "$SETTINGS" >/etc/systemd/system/tanks.service.d/settings.conf

  local has_admin=0
  if [[ -f /opt/tanks/$ADMIN_UNIT && -s $ADMIN_HASH_FILE ]]; then
    has_admin=1
    install -m 644 "/opt/tanks/$ADMIN_UNIT" /etc/systemd/system/tanks-admin.service
    install -d -m 755 /etc/systemd/system/tanks-admin.service.d
    printf '[Service]\nEnvironment="SERVER_NAME=test · %s"\n' "$NAME" >/etc/systemd/system/tanks-admin.service.d/name.conf
  fi
  write_caddyfile "$has_admin"
  systemctl daemon-reload
  systemctl enable tanks caddy >/dev/null
  systemctl restart tanks
  if [[ $has_admin == 1 ]]; then
    systemctl enable tanks-admin >/dev/null
    systemctl restart tanks-admin
  elif systemctl list-unit-files tanks-admin.service >/dev/null 2>&1; then
    systemctl disable --now tanks-admin >/dev/null 2>&1 || true
  fi
  systemctl reload caddy || systemctl restart caddy
  sleep 1
  systemctl is-active tanks
  curl -fsS http://127.0.0.1:8080/healthz
  echo
  if [[ $has_admin == 1 ]]; then
    systemctl is-active tanks-admin
  fi
}

write_caddyfile() {
  local admin_block=''
  if [[ $1 == 1 ]]; then
    admin_block="
	redir /admin /admin/
	handle_path /admin/* {
		basicauth {
			$ADMIN_USER $(cat "$ADMIN_HASH_FILE")
		}
		reverse_proxy 127.0.0.1:$ADMIN_PORT
	}
"
  fi
  cat >/etc/caddy/Caddyfile <<EOF
$NAME {
	encode zstd gzip

	handle /metrics {
		respond 404
	}

	# Vector на тестовой машине нет: события клиента принимаются и выбрасываются.
	handle /telemetry {
		respond 204
	}
$admin_block
	handle {
		reverse_proxy 127.0.0.1:8080
	}
}
EOF
}

main "$@"
