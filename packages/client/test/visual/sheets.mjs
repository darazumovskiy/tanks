// Снимает контактные листы лаборатории эффектов: сцена × экран → PNG полного разрешения, отдельные ячейки по
// вариантам и серые копии листов для проверки силуэта. Нужен запущенный Vite (`npm run dev -w @tanks/client`).
// Переменные: LAB_URL, ROUND, OUT_DIR (по умолчанию `lab-shots/round-<id>` — в .gitignore), SCENES, SCREENS, T.
// `window` и `document` — внутри `page.evaluate`, в браузере.
/* global window, document */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';

const BASE = process.env.LAB_URL ?? 'http://localhost:5173';
const ROUND = process.env.ROUND ?? '';
const OUT = process.env.OUT_DIR ?? `lab-shots/round-${ROUND === '' ? 'current' : ROUND}`;
const SCENES = (process.env.SCENES ?? 'on-target,wall-tail,returning,lead,with-bullet').split(',');
const SCREENS = (process.env.SCREENS ?? 'phone,desktop').split(',');
const TIME_S = Number(process.env.T ?? '1');
const GRAY_PROFILE = '/System/Library/ColorSync/Profiles/Generic Gray Profile.icc';

mkdirSync(`${OUT}/cells`, { recursive: true });
mkdirSync(`${OUT}/gray`, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
await page.goto(`${BASE}/?lab=fx&round=${ROUND}`);
await page.waitForFunction(() => 'tanksFxLab' in window);
// Спрайты танков грузятся асинхронно.
await page.waitForTimeout(600);
const variants = await page.evaluate(() => window.tanksFxLab.variants);

function savePng(file, dataUrl) {
  writeFileSync(file, Buffer.from(dataUrl.split(',')[1], 'base64'));
}

for (const scene of SCENES) {
  for (const screen of SCREENS) {
    const size = await page.evaluate(
      ([s, sc, t]) => window.tanksFxLab.sheet(s, sc, Number(t)),
      [scene, screen, String(TIME_S)],
    );
    const sheet = await page.evaluate(() => document.querySelector('.fx-sheet canvas').toDataURL('image/png'));
    const file = `${OUT}/${scene}-${screen}.png`;
    savePng(file, sheet);
    // Серая копия — через системный `sips` macOS; на другой машине листы остаются цветными.
    if (existsSync(GRAY_PROFILE)) {
      execFileSync('sips', ['--matchTo', GRAY_PROFILE, file, '--out', `${OUT}/gray/${scene}-${screen}.png`], {
        stdio: 'ignore',
      });
    }
    const cells = await page.evaluate((count) => {
      const source = document.querySelector('.fx-sheet canvas');
      const columns = Math.min(3, count);
      const rows = Math.ceil(count / columns);
      const width = source.width / columns;
      const height = source.height / rows;
      const out = [];
      for (let index = 0; index < count; index++) {
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const x = (index % columns) * width;
        const y = Math.floor(index / columns) * height;
        canvas.getContext('2d').drawImage(source, x, y, width, height, 0, 0, width, height);
        out.push(canvas.toDataURL('image/png'));
      }
      return out;
    }, variants.length);
    cells.forEach((cell, index) => {
      savePng(`${OUT}/cells/${scene}-${screen}-${variants[index]}.png`, cell);
    });
    console.log(file, size.width, 'x', size.height);
  }
}
await browser.close();
