# Задача: bootstrap

Запустить проект онлайн-танков на основе `tank-arena`: собрать базу знаний, зафиксировать продуктовые намерения, провести пристрелку по технологическим вопросам и принять стартовые решения, после которых можно начинать код MVP.

Результат этапа — набор ADR по стеку и площадке, концепт режима боя MVP, репозиторий с каркасом. Дальше заводится задача MVP по [плану-карте](../roadmap.md).

## Вопрос → документ

| Вопрос | Документ |
|---|---|
| Что за продукт, три направления, приоритет | [concept/vision.md](../../concept/vision.md) |
| Сценарий MVP, что наследуется, что переосмысляется | [concept/office-match.md](../../concept/office-match.md) |
| Что есть в `tank-arena`, что переносится | [research/tank-arena-audit.md](../../research/tank-arena-audit.md) |
| Где хостить: география, кандидаты, план замеров | [research/hosting.md](../../research/hosting.md) |
| Транспорт: WebSocket / WebTransport, гарантии доставки, план замеров | [research/transport.md](../../research/transport.md) |
| Сервер (Node и его масштабирование), протокол, клиент — сравнение | [research/realtime-stack.md](../../research/realtime-stack.md) |
| Как тестируем | [adr/tests.md](../../adr/tests.md) |
| Что уже сделано в мире (технически) | [research/prior-art.md](../../research/prior-art.md) |
| Конкуренты: рынок 2D-танков, живость, глубина, выводы для концептов | [research/competitors.md](../../research/competitors.md) |
| Конкуренты: аудитория, глубина, платформы | [research/competitors.md](../../research/competitors.md) |
| Устройство сервера, протокола, компенсации задержки | [tech/base/backend.md](../../tech/base/backend.md) |
| Устройство клиента | [tech/base/frontend.md](../../tech/base/frontend.md) |
| Хостинг, деплой, мониторинг | [tech/base/infra.md](../../tech/base/infra.md) |
| Нефункциональные требования | [tech/base/requirements.md](../../tech/base/requirements.md) |
| План этапов | [workflow/roadmap.md](../roadmap.md) |

## Ключевые файлы вне проекта

- `../tank-arena/kit/arena/engine.js` — движок-источник
- `../tank-arena/kit/ARENA.md` — спецификация правил боя
- `../tank-arena/docs/research.md` — выводы о физике и о человеке против ботов
- `../nx/hw-all/local/compose.yaml`, `local/vector/`, `local/clickhouse/init/` — образец стека мониторинга
- `../alp-finder/analysis/viewer/wrangler.toml` — образец деплоя на Cloudflare
