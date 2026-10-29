#!/usr/bin/env bash
# Gera o APK (Capacitor) com a tela de chat apontando para o gateway publicado.
# Roda no GitHub Actions; precisa de Node 20 e Java 17. Saída: ./ai-gateway.apk
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="${RUNNER_TEMP:-/tmp}/apk-build"
rm -rf "$WORK" && mkdir -p "$WORK/www" && cd "$WORK"

cp "$ROOT/public/index.html" www/index.html
printf "window.GATEWAY_URL = '%s';\n" "${GATEWAY_URL:-}" > www/config.js

npm init -y >/dev/null
npm install --silent @capacitor/core@6 @capacitor/cli@6 @capacitor/android@6 @capacitor/browser@6

npx cap init "AI Gateway" "com.helioangelis.aigateway" --web-dir www
npx cap add android
npx cap sync android

# aceita as licenças do SDK (o runner já traz o SDK instalado)
if [ -n "${ANDROID_HOME:-}" ] && [ -x "$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager" ]; then
  yes | "$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager" --licenses >/dev/null 2>&1 || true
fi

cd android
./gradlew assembleDebug --no-daemon --console=plain

cp app/build/outputs/apk/debug/app-debug.apk "$ROOT/ai-gateway.apk"
ls -la "$ROOT/ai-gateway.apk"
