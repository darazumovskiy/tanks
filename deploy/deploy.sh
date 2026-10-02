#!/bin/bash
# Выкладка с рабочей машины:  deploy/deploy.sh root@172.232.212.157
# Машина должна быть подготовлена setup.sh; код берётся из origin/main на GitHub, локальные правки не уезжают.
set -euo pipefail
HOST=${1:?укажи user@host}
ssh -i ~/.ssh/tanks_probe_ed25519 "$HOST" 'bash /opt/tanks/deploy/deploy-local.sh'
