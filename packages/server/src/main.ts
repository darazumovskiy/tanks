import { WALL_SLIDE_MAX_PERCENT } from '@tanks/shared/engine';
import { createApp } from './app.js';

const DEFAULT_WALL_SLIDE_PERCENT = 50;

function wallSlidePercentFromEnv(raw: string | undefined): number {
  if (raw === undefined) {
    return DEFAULT_WALL_SLIDE_PERCENT;
  }
  const percent = Number(raw);
  const isValid = Number.isInteger(percent) && percent >= 0 && percent <= WALL_SLIDE_MAX_PERCENT;
  if (!isValid) {
    throw new Error(`WALL_SLIDE должен быть целым 0–${String(WALL_SLIDE_MAX_PERCENT)}, получено «${raw}»`);
  }
  return percent;
}

const port = Number(process.env.PORT ?? 8080);
// На бою HOST=127.0.0.1: снаружи только Caddy.
const host = process.env.HOST ?? '0.0.0.0';
const staticRoot = process.env.STATIC_ROOT;
const apkPath = process.env.APK_PATH;
const logDir = process.env.LOG_DIR;
const geoDir = process.env.GEO_DIR;
const wallSlidePercent = wallSlidePercentFromEnv(process.env.WALL_SLIDE);
const app = createApp({
  ...(staticRoot === undefined ? {} : { staticRoot }),
  ...(apkPath === undefined ? {} : { apkPath }),
  ...(logDir === undefined ? {} : { logDir }),
  ...(geoDir === undefined ? {} : { geoDir }),
  rules: { wallSlidePercent },
  ffaEnv: process.env,
});

const boundPort = await app.listen(port, host);
console.log(`tanks server on ${host}:${String(boundPort)}${staticRoot === undefined ? '' : `, static ${staticRoot}`}`);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void app.close().then(() => {
      process.exit(0);
    });
  });
}
