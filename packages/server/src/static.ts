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

// Раздаёт собранный клиент: файлы из dist как есть, маршруты приложения — index.html.
export function serveStatic(root: string, request: IncomingMessage, response: ServerResponse): boolean {
  const url = new URL(request.url ?? '/', 'http://localhost');
  const isSpaRoute = SPA_ROUTES.some((pattern) => pattern.test(url.pathname));
  const relative = isSpaRoute ? 'index.html' : normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
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
