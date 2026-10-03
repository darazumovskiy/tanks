# Выкладка пробы

Одна машина Akamai (Linode) Nanode 1 GB в Милане, `172.232.212.157`. Адрес игры — `https://172-232-212-157.sslip.io` (sslip.io — бесплатный DNS, превращающий IP в имя; Let's Encrypt выдал на него сертификат). Код — `deploy/`.

| Файл | Роль |
|---|---|
| `setup.sh` | Первичная настройка машины от root: Node 22, Caddy, пользователь `tanks`, клон репозитория в `/opt/tanks`, systemd-юнит, первая выкладка. Параметр `TANKS_HOST` — имя для сертификата |
| `deploy-local.sh` | На машине: `git reset --hard origin/main`, `npm ci`, `npm run build`, папка журналов `/opt/tanks-logs`, `systemctl restart tanks`, проверка `/healthz` |
| `deploy.sh user@host` | С рабочей машины: запускает `deploy-local.sh` по SSH ключом `~/.ssh/tanks_probe_ed25519` |
| `tanks.service` | systemd: `node packages/server/dist/main.js`, порт 8080, статика из `packages/client/dist`, APK из `/opt/tanks-files/tanks.apk`, журналы игр в `/opt/tanks-logs`, автоперезапуск. `deploy-local.sh` переустанавливает юнит при каждой выкладке |
| `Caddyfile` | HTTPS на `TANKS_HOST`, сжатие, проксирование на 8080 (включая WebSocket) |
| `android/` | Сборка и загрузка Android-приложения — [android-app.md](android-app.md) |

Выкладка берёт код только из `origin/main` на GitHub: сначала коммит и пуш, потом `deploy/deploy.sh root@172.232.212.157`. Перезапуск рвёт активные дуэли.

Логи процесса: `journalctl -u tanks`, `journalctl -u caddy`. Журналы игр — `/opt/tanks-logs/<gameId>.log`, один файл на дуэль, около 1 МБ в минуту боя двух игроков ([game-log.md](../backend/game-log.md)); чистятся вручную (`find /opt/tanks-logs -mtime +7 -delete`).
