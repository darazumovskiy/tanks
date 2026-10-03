# Android-приложение

Оболочка Capacitor вокруг браузерного клиента. Приложение не хранит игру внутри: при запуске открывает игровой сервер в системном WebView на весь экран; выкладка на сервер обновляет игру на всех телефонах без переустановки. Установка — APK с игрового сервера по QR-коду на главной странице, без магазина. Аргументы — [research/mobile-shell.md](../../../research/mobile-shell.md).

## Что внутри

| Файл | Роль |
|---|---|
| `packages/mobile/capacitor.config.ts` | `appId` `io.github.darazumovskiy.tanks`, имя «Танки», `server.url` — адрес игрового сервера (переопределяется `TANKS_SERVER_URL`), `webDir: www` — заглушка «нет связи» |
| `packages/mobile/android/` | Нативный проект: `AndroidManifest.xml` — `screenOrientation="sensorLandscape"`; `MainActivity.java` — скрытые системные панели (возвращаются свайпом от края), экран не гаснет; `app/build.gradle` — подпись из переменных окружения, `versionCode`/`versionName` |
| `packages/mobile/ios/` | Проект iOS, создан, не собирается (см. research) |
| `deploy/android/Dockerfile` | Образ сборки: JDK 21, Android SDK 36, build-tools 36 и 35. Всегда `linux/amd64` — инструменты SDK собраны под x86_64, на Apple Silicon идёт через Rosetta |
| `deploy/android/keystore.sh` | Один раз создаёт ключ подписи в `~/.secrets/tanks-android/` (`keystore.jks`, `env` с паролями). Ключ не в репозитории; потеря ключа = переустановка приложения у всех |
| `deploy/android/build.sh` | `cap sync` → Gradle `assembleRelease` в Docker с ключом → `packages/mobile/dist/tanks.apk` (~3 МБ). Кэш Gradle — том `tanks-gradle-cache`; первая сборка ~3,5 мин, дальше быстрее |
| `deploy/android/upload.sh user@host` | Копирует APK в `/opt/tanks-files/tanks.apk` на сервере; перезапуск сервера не нужен |
| `packages/server/src/static.ts` → `serveApk` | `GET`/`HEAD /app/tanks.apk`: `application/vnd.android.package-archive`, `Content-Disposition: attachment`, `Cache-Control: no-cache`; файл берётся из `APK_PATH` (`tanks.service`); нет файла — 404 |
| `packages/client/src/main.ts` → `showAndroidDownload` | На главной: `HEAD /app/tanks.apk` → если 200, блок «Приложение для Android» с QR-кодом (библиотека `qrcode`) на полный адрес APK и ссылкой |

## Как выпустить новую версию приложения

Нужно только при изменении самой оболочки (ориентация, панели, иконка, адрес сервера). Изменения игры доезжают без этого.

1. Поднять `versionCode` в `packages/mobile/android/app/build.gradle`.
2. `deploy/android/build.sh`, затем `deploy/android/upload.sh root@172.232.212.157`.
3. На телефоне — скачать по QR заново; Android поставит поверх старой версии, потому что подпись та же.

## Проверка на устройстве

Отладка WebView включена в `capacitor.config.ts` (проба). По кабелю: `adb install -r`, запуск, `packages/client/test/device/forward.sh <серийник>` пробрасывает разъём отладки, `packages/client/test/device/run.mjs <порт> <комната>` гоняет дуэль касаниями и печатает метрики. Подробности, эмулятор и замеры — `workflow/proto-duel/knowledge/device-testing.md`.

## План тестирования

### Сервер — интеграционные (`packages/server/test/app.test.ts`)

| Сценарий | Ожидание | Статус |
|---|---|---|
| `GET /app/tanks.apk` при настроенном `apkPath` | 200, MIME APK, `Content-Disposition` с `tanks.apk`, `Cache-Control: no-cache`, тело файла | автоматизирован |
| `HEAD /app/tanks.apk` | 200, `Content-Length` без тела | автоматизирован |
| Файл удалён | 404 | автоматизирован |
| `apkPath` не задан | 404 | автоматизирован |

### Сборка — проверка артефакта (вручную, в контейнере сборки)

| Сценарий | Ожидание | Результат 2026-10-03 |
|---|---|---|
| `apksigner verify --print-certs` | подпись одна, сертификат `CN=Tanks` | SHA-256 `7fd394e2…5dd2` |
| `aapt dump badging` | пакет `io.github.darazumovskiy.tanks`, метка «Танки», `minSdk` 24, `targetSdk` 36, единственное разрешение — INTERNET | совпало |
| Манифест | `screenOrientation` = `sensorLandscape` (0x6) | совпало |
| `assets/capacitor.config.json` в APK | `server.url` — адрес боевого сервера | совпало |

### Сквозная — главная страница и установка

| Сценарий | Ожидание | Статус |
|---|---|---|
| Главная на боевом сервере после загрузки APK | блок с QR-кодом виден, ссылка ведёт на `https://…/app/tanks.apk`, `HEAD` → 200 | агент, в браузере |
| Главная на локальном сервере без APK | блока нет | агент, в браузере |
| Скан QR телефоном → скачивание → установка | Android спрашивает разрешение один раз, ставит, иконка «Танки» | Дима, 2026-10-03: «всё отлично» |
| Обновление 0.1 → 0.2 поверх | ставится без удаления (одна подпись) | `adb install -r` на телефоне — Success |
| Запуск приложения | открывается главная игры на весь экран, без панелей, в альбомной ориентации; экран не гаснет | телефон и эмулятор: главная с сервера, альбомная, полный экран (скриншоты) |
| Дуэль из приложения на телефоне | ввод касаниями, 60+ к/с | 120 к/с, худший кадр 8 мс, задержка 56 мс (`knowledge/device-testing.md`) |
| Телефон без сети | заглушка «Нет связи с сервером игры» | **Дима, телефон** |
| Выкладка игры (`deploy.sh`) при установленном приложении | после перезапуска приложения — новая версия игры без переустановки | **Дима, телефон** |
