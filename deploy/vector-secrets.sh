#!/bin/bash
# Кладёт доступы Grafana Cloud на машину:  deploy/vector-secrets.sh root@172.232.212.157
# Источник — ~/.secrets-tank/grafana-cloud.env; на машине — /etc/default/vector, читается только systemd.
set -euo pipefail
HOST=${1:?укажи user@host}
SECRETS=${TANKS_SECRETS:-$HOME/.secrets-tank/grafana-cloud.env}
grep -E '^GRAFANA_CLOUD_' "$SECRETS" | ssh -i ~/.ssh/tanks_probe_ed25519 "$HOST" \
  'install -m 600 -o root -g root /dev/stdin /etc/default/vector && systemctl try-restart vector 2>/dev/null; echo "доступы Vector обновлены"'
