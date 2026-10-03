import { createReadStream, existsSync, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';

const MIME: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
};

const SPA_ROUTES = [/^\/$/, /^\/d\/[a-z0-9]+$/];

export const APK_ROUTE = '/app/tanks.apk';
const APK_MIME = 'application/vnd.android.package-archive';

// У запроса, пришедшего через http.Server, url задан всегда.
export function requestPath(request: IncomingMessage): string {
  return new URL(String(request.url), 'http://localhost').pathname;
}

// Установочный файл Android-приложения лежит вне dist и меняется редко, но без кэша: телефон должен получать свежий.
export function serveApk(apkPath: string, request: IncomingMessage, response: ServerResponse): boolean {
  if (!existsSync(apkPath) || !statSync(apkPath).isFile()) {
    return false;
  }
  response.writeHead(200, {
    'Content-Type': APK_MIME,
    'Content-Length': statSync(apkPath).size,
    'Content-Disposition': 'attachment; filename="tanks.apk"',
    'Cache-Control': 'no-cache',
  });
  if (request.method === 'HEAD') {
    response.end();
    return true;
  }
  createReadStream(apkPath).pipe(response);
  return true;
}

// Раздаёт собранный клиент: файлы из dist как есть, маршруты приложения — index.html.
export function serveStatic(root: string, request: IncomingMessage, response: ServerResponse): boolean {
  const pathname = requestPath(request);
  const isSpaRoute = SPA_ROUTES.some((pattern) => pattern.test(pathname));
  const relative = isSpaRoute ? 'index.html' : normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, '');
  const file = resolve(join(root, relative));
  if (!file.startsWith(resolve(root)) || !existsSync(file) || !statSync(file).isFile()) {
    return false;
  }
  const type = MIME[extname(file)] ?? 'application/octet-stream';
  response.writeHead(200, {
    'Content-Type': type,
    'Cache-Control': relative === 'index.html' ? 'no-cache' : 'public, max-age=31536000, immutable',
  });
  createReadStream(file).pipe(response);
  return true;
}
