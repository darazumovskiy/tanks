// Прогон дуэли на устройстве через проброшенный DevTools WebView (test/device/forward.sh): node run.mjs <порт> <комната>.
// Второй игрок открывает ту же комнату в браузере. Печатает JSON с метриками из debugState().
const [port, room] = process.argv.slice(2);

const pages = await (await fetch(`http://localhost:${port}/json`)).json();
const target = pages.find((p) => p.type === 'page');
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = reject;
});
let nextId = 1;
const pending = new Map();
ws.onmessage = (event) => {
  const message = JSON.parse(event.data);
  if (message.id !== undefined && pending.has(message.id)) {
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(message.error.message));
    else resolve(message.result);
  }
};
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
const evaluate = async (expression) => {
  const { result, exceptionDetails } = await send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (exceptionDetails) throw new Error(exceptionDetails.text + ' ' + JSON.stringify(exceptionDetails.exception));
  return result.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const touch = (type, points) =>
  send('Input.dispatchTouchEvent', {
    type,
    touchPoints: points.map((p) => ({ x: p.x, y: p.y, id: p.id, radiusX: 8, radiusY: 8, force: 1 })),
  });
const read = () =>
  evaluate(
    `(() => { const s = window.tanksGame && window.tanksGame.debugState(); return s ? { x: +s.me.x.toFixed(0), heading: +s.me.heading.toFixed(2), speed: +s.me.speed.toFixed(0), bullets: s.bullets, fps: +s.fps.toFixed(0), worst: +s.worstFrameMs.toFixed(0), rtt: +s.rttMs.toFixed(0), pending: s.pending, correction: s.correctionPx } : null; })()`,
  );

const log = { appUrl: target.url };
try {
  await send('Page.enable');
  await send('Page.navigate', { url: new URL('/d/' + room, target.url).href });
  await sleep(1500);
  for (let i = 0; i < 120; i++) {
    const s = await read();
    if (s !== null && s.pending > 0) break;
    await sleep(250);
  }
  await sleep(4500);
  log.viewport = await evaluate(
    `({ w: innerWidth, h: innerHeight, dpr: devicePixelRatio, touch: matchMedia('(pointer: coarse)').matches, ua: navigator.userAgent.slice(0, 90) })`,
  );
  const { w, h } = log.viewport;
  log.idle = await read();
  const samples = [];
  await touch('touchStart', [
    { id: 1, x: w * 0.25, y: h * 0.6 },
    { id: 2, x: w * 0.75, y: h * 0.6 },
  ]);
  await touch('touchMove', [
    { id: 1, x: w * 0.25 - 60, y: h * 0.6 },
    { id: 2, x: w * 0.75, y: h * 0.6 - 60 },
  ]);
  for (let i = 0; i < 6; i++) {
    await sleep(1000);
    samples.push(await read());
  }
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  await touch('touchEnd', []);
  log.fighting = samples.map((s) => ({
    fps: s.fps,
    worst: s.worst,
    bullets: s.bullets,
    speed: s.speed,
    correction: s.correction,
    rtt: s.rtt,
  }));
  await sleep(500);
  log.after = await read();
  const { writeFileSync } = await import('node:fs');
  writeFileSync('/tmp/device-shot.png', Buffer.from(shot.data, 'base64'));
} catch (e) {
  log.error = String(e);
}
ws.close();
console.log(JSON.stringify(log, null, 1));
