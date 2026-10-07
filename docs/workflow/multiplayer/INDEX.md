# Задача: multiplayer — бой каждый сам за себя на 10–50 игроков

Переход от дуэли к общему бою: одна общая игра на 10, 30 или 50 игроков, карты под каждый размер, матч по времени, возрождение после смерти, счёт убийств и смертей, таблица во время боя, мини-игра на время ожидания. Режим один — каждый сам за себя.

Боты двух видов. Серверные живут внутри игрового процесса и добирают игру до минимума, чтобы матч стартовал; пришедший человек вытесняет бота. Рой — отдельная программа, которая входит через сокет как обычный игрок с компьютера оператора или с отдельной машины, — только для нагрузочного теста: сколько игр сервер держит без лагов и где падает. Задача начинается с концепции; код — после её принятия.

## Вопрос → документ

| Вопрос | Документ |
|---|---|
| Что делаем и в каком порядке, открытые вопросы | [state.md](state.md) |
| Что решили | [decisions.md](decisions.md) |
| Что агент решил сам и ждёт подтверждения | [knowledge/pending-decisions.md](knowledge/pending-decisions.md) |
| Замечания после игры: причины и требования к правкам | [knowledge/playtest-findings.md](knowledge/playtest-findings.md) |
| Бой ботов `/watch`: два бойца лестницы в браузере без сервера, скорость, пауза, итог; план тестирования | [tech/impl/frontend/bot-watch.md](../../tech/impl/frontend/bot-watch.md) |
| Почему игра RWV3 лагала: приступ потерь пакетов на пути от Mac, рой на том же Mac его усиливает; сервер и журнал каждого тика ни при чём | [knowledge/incident-rwv3.md](knowledge/incident-rwv3.md) |
| Почему свёрнутый айфон заводил новую дуэль каждые 20 секунд и как это повторено тестом | [knowledge/incident-yct4.md](knowledge/incident-yct4.md) |
| Почему в игре ZBF9 после возврата связи танк 13 секунд не слушался управления | [knowledge/incident-zbf9.md](knowledge/incident-zbf9.md) |
| Правила боя: вход, матч, счёт, возрождение, зона и финал, бездействие, что видит игрок, карты, боты | [concept/ffa.md](../../concept/ffa.md) |
| Движок на N танков, матч, выбор точки возрождения, карты; план тестирования | [tech/impl/backend/ffa-engine.md](../../tech/impl/backend/ffa-engine.md) |
| Сервер общей игры: подбор, фазы, бездействие, обрыв и возврат; сообщения протокола; снаряды у клиента; план тестирования | [tech/impl/backend/ffa-server.md](../../tech/impl/backend/ffa-server.md) |
| Боты толпы: уровни, что видит бот, окно обзора, выбор цели, уклонение, застревание; стенд толпы; план тестирования | [tech/impl/backend/crowd-bots.md](../../tech/impl/backend/crowd-bots.md) |
| Сетевой рой ботов: запуск, отчёт (трафик, тик, шум выстрелов), связь и обрывы; план тестирования | [tech/impl/backend/swarm.md](../../tech/impl/backend/swarm.md) |
| Клиент боя толпы: вход `/ffa`, экраны и тексты, предсказание среди N танков, камера и окно обзора, пол кусками, интерфейс матча, звук; план тестирования | [tech/impl/frontend/ffa-client.md](../../tech/impl/frontend/ffa-client.md) |
| Части шага 7: файлы, пункты плана тестирования, готовность, что передаётся дальше | [knowledge/step7-parts.md](knowledge/step7-parts.md) |
| Протокол дуэли и общие поля (`Join`, ошибки) | [tech/impl/backend/protocol.md](../../tech/impl/backend/protocol.md) |
| Видимые элементы боя толпы: что сообщают, состояния для лаборатории, полоса яркости, порядок визуальных сессий | [knowledge/visual-elements.md](knowledge/visual-elements.md) |
| Профиль игры оператора для бота-двойника: реакция, прицел, стрельба, уклонение, движение, исходы по уровням — телефон и компьютер | [knowledge/player-profile.md](knowledge/player-profile.md) |
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
| [round.ts](../../../packages/shared/src/engine/round.ts) | Поле боя `World` на N танков, `stepWorld`, `flyBullets`; дуэль `Round`, `stepRound` |
| [ffa.ts](../../../packages/shared/src/engine/ffa.ts), [spawn.ts](../../../packages/shared/src/engine/spawn.ts), [ffaMaps.ts](../../../packages/shared/src/engine/ffaMaps.ts), [random.ts](../../../packages/shared/src/engine/random.ts) | Матч, выбор точки возрождения, расстановка на старте, карты 10/30/50, генератор с сидом |
| [messages.ts](../../../packages/shared/src/protocol/messages.ts), [codec.ts](../../../packages/shared/src/protocol/codec.ts), [ffaRoom.ts](../../../packages/shared/src/protocol/ffaRoom.ts), [ffaEvents.ts](../../../packages/shared/src/protocol/ffaEvents.ts), [bullets.ts](../../../packages/shared/src/protocol/bullets.ts) | Сообщения и кодек v6, коды `ffa10/30/50`, события снимка, снаряды: разница на сервере и зеркало у клиента |
| [ffaGame.ts](../../../packages/server/src/ffaGame.ts), [roomManager.ts](../../../packages/server/src/roomManager.ts), [inputs.ts](../../../packages/server/src/inputs.ts), [app.ts](../../../packages/server/src/app.ts) | Общая игра, подбор, очередь команд, маршрут кодов |
| [bots/src/](../../../packages/bots/src/), [server/src/bots/](../../../packages/server/src/bots/) | Лестница дуэли: мозги — общий пакет, связь с комнатой — сервер; заморожена, отпечаток в [ladder.test.ts](../../../packages/server/test/ladder.test.ts) |
| [server/src/crowd/](../../../packages/server/src/crowd/) | Боты толпы: профили и пирамида, мозг, выбор цели, вид, бот без транспорта |
| [server/src/swarm/](../../../packages/server/src/swarm/) | Сетевой рой: [swarm.ts](../../../packages/server/src/swarm/swarm.ts), точка входа [main.ts](../../../packages/server/src/swarm/main.ts) (`npm run swarm`) |
| [crowdBrain.test.ts](../../../packages/server/test/crowdBrain.test.ts), [crowdStand.test.ts](../../../packages/server/test/crowdStand.test.ts), [swarm.test.ts](../../../packages/server/test/swarm.test.ts) | Мозг на крафтовых видах, стенд толпы на 30 ботов, рой через сокет |
| [server/test/ffa.test.ts](../../../packages/server/test/ffa.test.ts); [ffa.test.ts](../../../packages/shared/src/engine/ffa.test.ts), [spawn.test.ts](../../../packages/shared/src/engine/spawn.test.ts), [ffaMaps.test.ts](../../../packages/shared/src/engine/ffaMaps.test.ts); [bullets.test.ts](../../../packages/shared/src/protocol/bullets.test.ts) | Тесты общей игры, матча, карт и снарядов |
| [client/src/ffa/](../../../packages/client/src/ffa/) | Клиент боя толпы: [ffaGame.ts](../../../packages/client/src/ffa/ffaGame.ts), сессия [session.ts](../../../packages/client/src/ffa/session.ts), предсказание [ffaPrediction.ts](../../../packages/client/src/ffa/ffaPrediction.ts), камера [ffaCamera.ts](../../../packages/client/src/ffa/ffaCamera.ts), эффекты [fxPolicy.ts](../../../packages/client/src/ffa/fxPolicy.ts), стрелки [arrows.ts](../../../packages/client/src/ffa/arrows.ts), интерфейс матча [hud/](../../../packages/client/src/ffa/hud/) |
| [field.ts](../../../packages/client/src/render/field.ts), [ffaRenderer.ts](../../../packages/client/src/render/ffaRenderer.ts), [floorChunks.ts](../../../packages/client/src/render/floorChunks.ts), [tiledFloor.ts](../../../packages/client/src/render/tiledFloor.ts) | Рендер поля, общий с дуэлью; рендер толпы; пол большой карты кусками |
| [game.ts](../../../packages/client/src/game.ts), [prediction.ts](../../../packages/client/src/prediction.ts), [duelPresenter.ts](../../../packages/client/src/duelPresenter.ts) | Клиент дуэли |
