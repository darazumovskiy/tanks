import { createApp } from './app.js';

const port = Number(process.env.PORT ?? 8080);
const staticRoot = process.env.STATIC_ROOT;
const app = createApp(staticRoot === undefined ? {} : { staticRoot });

const boundPort = await app.listen(port);
console.log(`tanks server on :${String(boundPort)}${staticRoot === undefined ? '' : `, static ${staticRoot}`}`);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void app.close().then(() => {
      process.exit(0);
    });
  });
}
