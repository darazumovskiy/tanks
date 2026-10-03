import { createApp } from './app.js';

const port = Number(process.env.PORT ?? 8080);
const staticRoot = process.env.STATIC_ROOT;
const apkPath = process.env.APK_PATH;
const logDir = process.env.LOG_DIR;
const app = createApp({
  ...(staticRoot === undefined ? {} : { staticRoot }),
  ...(apkPath === undefined ? {} : { apkPath }),
  ...(logDir === undefined ? {} : { logDir }),
});

const boundPort = await app.listen(port);
console.log(`tanks server on :${String(boundPort)}${staticRoot === undefined ? '' : `, static ${staticRoot}`}`);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void app.close().then(() => {
      process.exit(0);
    });
  });
}
