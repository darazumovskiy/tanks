#!/bin/bash
# Выкладка на тестовую машину из коммита этого репозитория, без пуша в GitHub:
#   deploy/test/deploy-test.sh root@<ip> <ветка или коммит>
# Адрес игры — https://<ip через дефисы>.sslip.io; первый запуск ставит Node и Caddy.
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "использование: $0 root@<ip> <ветка или коммит>" >&2
  exit 1
fi
HOST=$1
REF=$2
KEY=$HOME/.ssh/tanks_probe_ed25519
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../.." && pwd)
IP=${HOST#*@}
NAME="${IP//./-}.sslip.io"
COMMIT=$(git -C "$REPO" rev-parse --short "$REF")

ssh_test() {
  ssh -i "$KEY" -o IdentitiesOnly=yes -o BatchMode=yes "$HOST" "$@"
}

git -C "$REPO" archive --format=tar "$REF" |
  ssh_test 'rm -rf /opt/tanks.next && mkdir -p /opt/tanks.next && tar -x -C /opt/tanks.next'
ssh_test "bash -s -- $NAME $COMMIT" <"$HERE/remote.sh"
echo "готово: https://$NAME ($REF, $COMMIT)"
