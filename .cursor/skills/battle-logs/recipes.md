# Команды разбора боя

Запуск из корня репозитория. Тип строки сервера — 5-е поле, клиента — 6-е (после `now=`).

```bash
KEY=~/.ssh/tanks_probe_ed25519
HOST=root@172.232.212.157
F=../tanks-logs/prod/K7MF.log
```

## Найти и скачать

```bash
ssh -i $KEY -o BatchMode=yes $HOST 'ls -lt /opt/tanks-logs | head -15'
ssh -i $KEY -o BatchMode=yes $HOST 'cd /opt/tanks-logs && grep -lE "(nick|p0|p1)=<ник>( |$)" $(ls -t *.log | head -30)'
rsync -az -e "ssh -i $KEY" $HOST:/opt/tanks-logs/ ../tanks-logs/prod/
ssh -i $KEY -o BatchMode=yes $HOST 'journalctl -u tanks --since "-2h" --no-pager | tail -30; git -c safe.directory=/opt/tanks -C /opt/tanks log -1 --format="%h %ad" --date=iso'
```

## Паспорт

```bash
awk '{print $2}' $F | sort | uniq -c
awk '$2=="S" {print $5}' $F | sort | uniq -c | sort -rn
awk '$2!="S" {print $2, $6}' $F | sort | uniq -c | sort -rn
grep -E ' S .* (game start|round start|match start|fight start|match over|join|rejoin|offline|leave) ' $F | grep -v 'bot=1' | cut -c1-200
grep -E ' (device|net welcome|net roundstart) ' $F ../tanks-logs/prod/room-*.log | cut -c1-220 | tail -20
```

## Окно строк по тикам

```bash
awk -v a=17360 -v b=17400 '{ g = $3; sub(/^gt=/, "", g); g += 0 } g >= a && g <= b' $F | cut -c1-220
```

Поля стороны 0 в строке `tick` убирает `sed -E 's/ a0=[^ ]+ ack0=[0-9]+ in0=[0-9]+ sil0=[0-9]+ p0=[^ ]+//'`.

## Проход по секундам — дуэль

Аргументы: файл и сторона человека. Печатает секунды игры с паузой снимков, поправкой, опозданием тика, тиками без команд и молчанием.

```bash
python3 - $F 1 <<'EOF'
import re, sys
from collections import defaultdict
path, side = sys.argv[1], sys.argv[2]
line_re = re.compile(r'^(\S+) (\S+) gt=(\d+) tc=\S+ (?:now=\d+ )?(\S+)(.*)$')
field = lambda rest, k: (m.group(1) if (m := re.search(rf'\b{k}=(\S+)', rest)) else None)
sec = defaultdict(lambda: dict(gap=0, corr=0.0, late=0.0, in0=0, in2=0, sil=0))
for line in open(path):
    m = line_re.match(line)
    if not m: continue
    _, src, gt, kind, rest = m.groups(); s = sec[int(gt) // 30]
    if src == 'C' + side and kind == 'snap':
        s['gap'] = max(s['gap'], int(field(rest, 'gap') or 0)); s['corr'] = max(s['corr'], float(field(rest, 'corr') or 0))
    elif src == 'S' and kind == 'tick':
        s['late'] = max(s['late'], float(field(rest, 'late') or 0))
        n = int(field(rest, 'in' + side) or 0); s['in0'] += n == 0; s['in2'] += n >= 2; s['sil'] += field(rest, 'sil' + side) == '1'
for k in sorted(sec):
    s = sec[k]
    if s['gap'] >= 150 or s['corr'] >= 20 or s['late'] >= 20 or s['in0'] >= 10 or s['sil'] > 0:
        print(f"{k // 60:02d}:{k % 60:02d}", s)
EOF
```

## Сеть и устройство

```bash
awk '$2 ~ /^C/ && $6=="sec" && $1 >= "22:45:00" && $1 <= "22:47:00"' $F | cut -c1-140
awk '$2 ~ /^C/ && ($6=="net" || $6=="vis" || $6=="frame" || $6=="close")' $F | cut -c1-160
awk '$2=="S" && $5=="input" {print substr($1, 1, 7) "0", $6}' $F | sort | uniq -c | sort -k2
```

Паузы сервера в бою толпы — строки `S` по времени отстают от хода `gt` больше чем на 0,15 с:

```bash
awk '$2=="S" { split($1, t, ":"); s = t[1]*3600 + t[2]*60 + t[3]; g = $3; sub(/^gt=/, "", g); if (pg != "" && g > pg && (s - ps) - (g - pg)/30 > 0.15) printf "%s пауза %.2f с при %.2f с тиков\n", $1, s - ps, (g - pg)/30; ps = s; pg = g }' $F
```

Соединения сервера сейчас — задержка, повторные отправки, окно:

```bash
ssh -i $KEY -o BatchMode=yes $HOST 'ss -tin state established "( sport = :443 )"' | grep -oE 'rtt:[0-9.]+/[0-9.]+|retrans:[0-9]+/[0-9]+|cwnd:[0-9]+' | paste - - - | head -40
```

Grafana — MCP `project-0-tanks-grafana-tanks`, источник `grafanacloud-prom`, окно разбора в UTC: `tanks_event_loop_delay_ms`, `tanks_tick_duration_ms`, `rate(tanks_ticks_late_total[1m])`, `rate(host_network_transmit_bytes_total[30s])`, `rate(tanks_inputs_dropped_total[1m])`, `tanks_connections`.

## Прогон боя толпы вокруг тика

Скрипт печатает живые танки, снаряды и события шага на тиках `from`–`to` и итог сверок по матчам; `0 -1` — только итог.

```bash
cat > /tmp/ffa-window.mjs <<'EOF'
import { readFileSync } from 'node:fs';
const [repo, log, from, to] = process.argv.slice(2);
const { replayFfaJournal } = await import(`${repo}/packages/shared/dist/protocol/index.js`);
const round = (v) => Math.round(v * 10) / 10;
const replay = replayFfaJournal(readFileSync(log, 'utf8').split('\n'), {
  onTick: (match, gt, events) => {
    if (gt < Number(from) || gt > Number(to)) return;
    const w = match.world;
    const tanks = w.tanks.filter((t) => t.isAlive).map((t) => `${t.id}:${round(t.x)},${round(t.y)} hp=${t.hp}`);
    const bullets = w.bullets.map((b) => `${b.owner}:${round(b.x)},${round(b.y)}`);
    console.log(`gt=${gt}`, events.length > 0 ? JSON.stringify(events) : '', '\n  tanks', tanks.join(' '), '\n  bullets', bullets.join(' '));
  },
});
for (const m of replay.matches) console.error(`матч ${m.index}: тиков ${m.ticks}, сверок ${m.sums}, расхождений ${m.mismatches.length}`);
EOF
npm run typecheck >/dev/null && node /tmp/ffa-window.mjs $PWD $F 3000 3030
ssh -i $KEY -o BatchMode=yes $HOST 'node --input-type=module - /opt/tanks /opt/tanks-logs/K7MF.log 0 -1' < /tmp/ffa-window.mjs
```

## Анализатор

```bash
npm run build && npm run analyze-logs -- ../tanks-logs/prod --out ../tanks-logs/analysis-$(date +%F)
npm run analyze-logs -- ../tanks-logs/prod --only K7MF,MJTM --out /tmp/tanks-analysis
```
