# Задача: proto-duel — сетевая дуэль по ссылке

Проба связки «сервер — сеть — два клиента» на минимальном объёме: простейший игровой сервер с сокетом, браузерный клиент для компьютера и для Android-браузера, матч 1 на 1 по ссылке. Дима играет сам с собой с компьютера и телефона и оценивает отклик.

Правила боя — как в `tank-arena` (два танка, поле 1600×900 целиком на экране, четыре карты), движок берётся как есть. Без авторизации, лобби, итогов, мониторинга. Всё, что здесь появится — движок на сервере, протокол, предсказание на клиенте, сенсорный ввод, деплой, — основа следующих этапов.

## Вопрос → документ

| Вопрос | Документ |
|---|---|
| Что делаем и в каком порядке | [state.md](state.md) |
| Что решили | [decisions.md](decisions.md) |
| Как устроены сервер, протокол, компенсация задержки | [tech/base/backend.md](../../tech/base/backend.md) |
| Как устроен клиент, мобильный ввод | [tech/base/frontend.md](../../tech/base/frontend.md) |
| Правила сети: предсказание, интерполяция, один процесс | [adr/architecture.md](../../adr/architecture.md) |
| Какие тесты обязательны | [adr/tests.md](../../adr/tests.md) |
| Что в `tank-arena` берём, что меняем | [research/tank-arena-audit.md](../../research/tank-arena-audit.md) |
| Замеры хостинга | [research/hosting.md](../../research/hosting.md) |
| Как проверять на телефоне и эмуляторе, замеры на устройстве | [knowledge/device-testing.md](knowledge/device-testing.md) |
| Камера дуэли: стратегии, правила, настройки, инварианты, лаборатория, план тестирования | [tech/impl/frontend/duel-camera.md](../../tech/impl/frontend/duel-camera.md) |
| Приглашение по ссылке: «Копировать» и «Поделиться», ссылка открывает Android-приложение (App Links), плашка «Открыть в приложении» | [tech/impl/frontend/invite-link.md](../../tech/impl/frontend/invite-link.md) |
| Лестница ботов: уровни, код комнаты, бот как подключение, файл бота Астры, стенд «бот против бота» | [tech/impl/backend/bot-ladder.md](../../tech/impl/backend/bot-ladder.md) |
| Журнал игры: идентификатор и таймкод на экране, файлы `/opt/tanks-logs/<id>.log`, что пишут сервер и клиент, как читать | [tech/impl/backend/game-log.md](../../tech/impl/backend/game-log.md) |
| Разбор «дёргания» на телефоне по журналу DNE5: пачки команд и снимков, цифры, причина, лечение | [knowledge/jitter-dne5.md](knowledge/jitter-dne5.md) |
| Разбор заморозки на 2 с на стабильной сети по журналу MJTM: потеря пакетов и повторы TCP, отличие от джиттера, фикс | [knowledge/stall-mjtm.md](knowledge/stall-mjtm.md) |
| Камера и управление: передача 2026-10-03 (задел `camera-lab`, порядок работ по управлению) | [knowledge/camera-handoff.md](knowledge/camera-handoff.md) |
| Ревью камеры по коду: инварианты, контрпримеры, дыры | [knowledge/camera-review.md](knowledge/camera-review.md) |
| Ревью сенсорного управления: инварианты, непокрытые случаи, рекомендации | [knowledge/controls-review.md](knowledge/controls-review.md) |
| Как делают камеры в геймдеве и схема для дуэли | [research/camera-techniques.md](../../research/camera-techniques.md) |
| Телефон против компьютера по журналам: где проседает (башня брошена, самопопадания, нет «назад»), пороги для контрольных серий | [knowledge/phone-vs-pc-logs.md](knowledge/phone-vs-pc-logs.md) |
| Помощники прицела и управления: техники, прецеденты, наука о выравнивании, принципы честности | [research/mobile-aim-assist.md](../../research/mobile-aim-assist.md) |

## Ключевые файлы кода

Пока нет — репозиторий создаётся в этой задаче. Источник: `../tank-arena/kit/arena/engine.js`, `../tank-arena/viewer/render.js`, `../tank-arena/viewer/sfx.js`.
