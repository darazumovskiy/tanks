# Задача: multiplayer — бой каждый сам за себя на 10–50 игроков

Переход от дуэли к общему бою: одна общая игра на 10, 30 или 50 игроков, карты под каждый размер, матч по времени, возрождение после смерти, счёт убийств и смертей, таблица во время боя, мини-игра на время ожидания. Режим один — каждый сам за себя.

Проверка — честный онлайн: боты — отдельная программа, которая входит через сокет как обычный игрок, с компьютера Димы или с отдельной машины; Дима и агент играют в той же игре. Задача отвечает и на вопрос о нагрузке. Добор комнаты серверными ботами — отдельная работа после. Задача начинается с концепции; код — после её принятия.

## Вопрос → документ

| Вопрос | Документ |
|---|---|
| Что делаем и в каком порядке, открытые вопросы | [state.md](state.md) |
| Что решили | [decisions.md](decisions.md) |
| Правила боя: вход, матч, счёт, возрождение, зона и финал, бездействие, что видит игрок, карты, боты | [concept/ffa.md](../../concept/ffa.md) |
| Движок на N танков, матч, выбор точки возрождения, карты; план тестирования | [tech/impl/backend/ffa-engine.md](../../tech/impl/backend/ffa-engine.md) |
| Сервер общей игры: подбор, фазы, бездействие, обрыв и возврат; сообщения протокола; снаряды у клиента; план тестирования | [tech/impl/backend/ffa-server.md](../../tech/impl/backend/ffa-server.md) |
| Протокол дуэли и общие поля (`Join`, ошибки) | [tech/impl/backend/protocol.md](../../tech/impl/backend/protocol.md) |
| Где код рассчитан ровно на двоих | [knowledge/duel-assumptions.md](knowledge/duel-assumptions.md) |
| Как устроен снимок, сколько весит, прикидка трафика на 50 игроков | [knowledge/snapshot-traffic.md](knowledge/snapshot-traffic.md) |
| Проверка обмена данными свежим агентом: что найдено и исправлено, что надёжно (снаряды на Safari, нагрузка), что отложено | [knowledge/exchange-review.md](knowledge/exchange-review.md) |
| Комната по ссылке для офиса | [concept/office-match.md](../../concept/office-match.md) |
| Что в движке `tank-arena` дуэльное | [research/tank-arena-audit.md](../../research/tank-arena-audit.md) |
| Как устроены боты сейчас | [tech/impl/backend/bot-ladder.md](../../tech/impl/backend/bot-ladder.md) |
| Камера дуэли | [tech/impl/frontend/duel-camera.md](../../tech/impl/frontend/duel-camera.md) |
| История пробы дуэли | [proto-duel](../proto-duel/INDEX.md) |

## Ключевые файлы кода

| Где | Что |
|---|---|
| `shared/src/engine/round.ts` | Поле боя `World` на N танков, `stepWorld`, `flyBullets`; дуэль `Round`, `stepRound` |
| `shared/src/engine/ffa.ts`, `spawn.ts`, `ffaMaps.ts`, `random.ts` | Матч, выбор точки возрождения, карты 10/30/50, генератор с сидом |
| `shared/src/protocol/messages.ts`, `codec.ts`, `ffaRoom.ts`, `ffaEvents.ts`, `bullets.ts` | Сообщения и кодек v6, коды `ffa10/30/50`, события снимка, снаряды: разница на сервере и зеркало у клиента |
| `server/src/ffaGame.ts`, `roomManager.ts`, `inputs.ts`, `app.ts` | Общая игра, подбор, приём команд, маршрут кодов |
| `server/src/bots/` | Мозг «Охотник» и профили уровней — основа сетевых ботов |
| `server/test/ffa.test.ts`; `shared/src/engine/ffa.test.ts`, `spawn.test.ts`, `ffaMaps.test.ts`; `shared/src/protocol/bullets.test.ts` | Тесты общей игры, матча, карт и снарядов |
| `client/src/game.ts`, `prediction.ts`, `render/` | Клиент — пока только дуэль |
