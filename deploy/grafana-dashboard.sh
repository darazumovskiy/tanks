#!/bin/bash
# Загружает deploy/grafana/tanks-dashboard.json в нашу Grafana Cloud (перезаписывает дашборд с тем же uid).
# Доступы — ~/.secrets-tank/grafana-cloud.env (GRAFANA_URL, GRAFANA_SERVICE_ACCOUNT_TOKEN).
set -euo pipefail
SECRETS=${TANKS_SECRETS:-$HOME/.secrets-tank/grafana-cloud.env}
set -a
# shellcheck source=/dev/null
. "$SECRETS"
set +a
DIR=$(cd "$(dirname "$0")" && pwd)
python3 "$DIR/grafana/build-dashboard.py"
python3 -c 'import json,sys; print(json.dumps({"dashboard": json.load(open(sys.argv[1])), "overwrite": True}))' \
  "$DIR/grafana/tanks-dashboard.json" \
  | curl -fsS -X POST "$GRAFANA_URL/api/dashboards/db" \
      -H "Authorization: Bearer $GRAFANA_SERVICE_ACCOUNT_TOKEN" -H 'Content-Type: application/json' --data-binary @-
echo
echo "дашборд: $GRAFANA_URL/d/tanks-main"
