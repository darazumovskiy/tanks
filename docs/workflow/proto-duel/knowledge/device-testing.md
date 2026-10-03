# Проверка на телефоне и эмуляторе

Проверено 2026-10-03 на Xiaomi 14T Pro (HyperOS 3, Android 16, WebView 153) и эмуляторе Android 15.

## Инструменты на Mac

- `adb` — `brew install --cask android-platform-tools`, без Java и SDK.
- Эмулятор — `brew install openjdk@21` + `brew install --cask android-commandlinetools`, затем `sdkmanager "emulator" "platforms;android-35" "system-images;android-35;google_apis;arm64-v8a"`. Окружение: `JAVA_HOME=/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home`, `ANDROID_HOME=/opt/homebrew/share/android-commandlinetools`. Виртуальное устройство `tanks` (экран 2712×1220, плотность 440 — как у 14T Pro) создано `avdmanager create avd -n tanks -k … -d pixel_7`.
- Запуск эмулятора без окна: `emulator -avd tanks -no-window -no-audio -no-boot-anim -gpu swiftshader_indirect` (как фоновая задача, иначе умирает вместе с оболочкой). Загружается ~17 с. Видеочип программный — цифры производительности не показательны, только логика и установка.

## Телефон

На телефоне один раз: Настройки → О телефоне → 7 раз по версии ОС → «Для разработчиков» → «Отладка по USB». При подключении — окно «Разрешить отладку» с галочкой «всегда». Xiaomi: `adb install` работает без включения «Установка по USB» и без Mi-аккаунта. Серийник 14T Pro — `6LZX7XPVK769Q8GA`.

## Конвейер

1. `curl -sO https://172-232-212-157.sslip.io/app/tanks.apk && adb -s <серийник> install -r tanks.apk` — ставится поверх (подпись одна).
2. `adb -s <серийник> shell am start -n io.github.darazumovskiy.tanks/.MainActivity`.
3. `packages/client/test/device/forward.sh <серийник> 9444` — пробрасывает разъём WebView (`webview_devtools_remote_<pid>`) на порт; показывает страницы.
4. Второй игрок — браузер на комнату; `node packages/client/test/device/run.mjs 9444 <комната>` — заходит приложением в комнату, ждёт боя, шлёт касания через `Input.dispatchTouchEvent`, печатает `debugState()` раз в секунду.
5. Скриншот — `adb exec-out screencap -p > shot.png` (через протокол отладки холст WebView выходит чёрным).
6. Системная статистика кадров — `adb shell dumpsys gfxinfo io.github.darazumovskiy.tanks`.

Playwright `connectOverCDP` к WebView не подключается («Browser context management is not supported») — поэтому `run.mjs` говорит по протоколу напрямую через WebSocket.

## Замеры 2026-10-03

Приложение 0.2, клиент с камерой и панелью настроек, бой «едем и стреляем» 6 с:

| Плотность отрисовки | к/с | худший кадр | задержка | поправка |
|---|---|---|---|---|
| 2 (потолок) | 120 | 8 мс | 56–61 мс | 0, один раз 5,5 px |
| 3,25 (полная) | 120 | 8 мс | 55–59 мс | 0 |

`gfxinfo` при полной плотности: медиана 8 мс, 90-й 11 мс, 99-й 15 мс, видеочип 2–6 мс, рваных кадров 0,02 %. Эмулятор (программный видеочип): 24–32 к/с, худший 50–200 мс — не показатель.
