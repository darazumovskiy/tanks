import { createApp } from './app.js';

const port = Number(process.env.PORT ?? 8080);
// На бою HOST=127.0.0.1: снаружи только Caddy.
const host = process.env.HOST ?? '0.0.0.0';
const staticRoot = process.env.STATIC_ROOT;
const apkPath = process.env.APK_PATH;
const logDir = process.env.LOG_DIR;
const app = createApp({
  ...(staticRoot === undefined ? {} : { staticRoot }),
  ...(apkPath === undefined ? {} : { apkPath }),
  ...(logDir === undefined ? {} : { logDir }),
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
