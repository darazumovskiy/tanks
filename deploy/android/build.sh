#!/bin/bash
# Собирает подписанный APK в Docker:  deploy/android/build.sh  →  packages/mobile/dist/tanks.apk
# Ключ — из ~/.secrets/tanks-android (создаётся keystore.sh). Кэш Gradle живёт в томе tanks-gradle-cache.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
SECRETS=${TANKS_ANDROID_SECRETS:-$HOME/.secrets/tanks-android}
IMAGE=tanks-android-build

: "${TANKS_SERVER_URL:=https://172-232-212-157.sslip.io}"
[ -f "$SECRETS/keystore.jks" ] || { echo "нет ключа подписи, запусти deploy/android/keystore.sh" >&2; exit 1; }
# shellcheck disable=SC1091
source "$SECRETS/env"
export TANKS_KEYSTORE_PASSWORD TANKS_KEY_ALIAS TANKS_KEY_PASSWORD

(cd "$ROOT/packages/mobile" && TANKS_SERVER_URL="$TANKS_SERVER_URL" npx cap sync android >/dev/null)
docker build --platform linux/amd64 -q -t "$IMAGE" "$ROOT/deploy/android" >/dev/null
docker run --rm --platform linux/amd64 \
  -v "$ROOT":/work \
  -v tanks-gradle-cache:/root/.gradle \
  -v "$SECRETS/keystore.jks":/secrets/keystore.jks:ro \
  -e TANKS_KEYSTORE=/secrets/keystore.jks -e TANKS_KEYSTORE_PASSWORD -e TANKS_KEY_ALIAS -e TANKS_KEY_PASSWORD \
  -w /work/packages/mobile/android "$IMAGE" ./gradlew --no-daemon --no-watch-fs -q assembleRelease

mkdir -p "$ROOT/packages/mobile/dist"
cp "$ROOT/packages/mobile/android/app/build/outputs/apk/release/app-release.apk" "$ROOT/packages/mobile/dist/tanks.apk"
ls -la "$ROOT/packages/mobile/dist/tanks.apk"
