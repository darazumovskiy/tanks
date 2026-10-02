#!/bin/bash
# Создаёт ключ подписи APK в ~/.secrets/tanks-android (вне репозитория). Запускается один раз;
# Android ставит новую версию поверх старой только при той же подписи — ключ не терять.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
SECRETS=${TANKS_ANDROID_SECRETS:-$HOME/.secrets/tanks-android}
IMAGE=tanks-android-build

if [ -f "$SECRETS/keystore.jks" ]; then
  echo "ключ уже есть: $SECRETS/keystore.jks"
  exit 0
fi

mkdir -p "$SECRETS"
chmod 700 "$SECRETS"
PASSWORD=$(openssl rand -base64 24 | tr -d '/+=')
docker build --platform linux/amd64 -q -t "$IMAGE" "$ROOT/deploy/android" >/dev/null
docker run --rm --platform linux/amd64 -v "$SECRETS":/secrets "$IMAGE" \
  keytool -genkeypair -keystore /secrets/keystore.jks -alias tanks -keyalg RSA -keysize 2048 -validity 10000 \
  -storepass "$PASSWORD" -keypass "$PASSWORD" -dname "CN=Tanks, O=Tanks" >/dev/null
cat > "$SECRETS/env" <<EOF
TANKS_KEYSTORE_PASSWORD=$PASSWORD
TANKS_KEY_ALIAS=tanks
TANKS_KEY_PASSWORD=$PASSWORD
EOF
chmod 600 "$SECRETS/env" "$SECRETS/keystore.jks"
echo "ключ создан: $SECRETS/keystore.jks"
