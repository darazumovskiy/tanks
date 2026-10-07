import type { IncomingMessage, ServerResponse } from 'node:http';

const HTTP_PAYLOAD_TOO_LARGE = 413;

// Тело сверх лимита — ответ 413; лишнее дочитывается впустую: разрыв соединения оставил бы клиента без ответа.
export function readBody(
  request: IncomingMessage,
  response: ServerResponse,
  limitBytes: number,
  onBody: (body: string) => void,
): void {
  const chunks: Buffer[] = [];
  let size = 0;
  let isRejected = false;
  request.on('data', (chunk: Buffer) => {
    if (isRejected) {
      return;
    }
    size += chunk.byteLength;
    if (size > limitBytes) {
      isRejected = true;
      chunks.length = 0;
      response.writeHead(HTTP_PAYLOAD_TOO_LARGE);
      response.end();
      return;
    }
    chunks.push(chunk);
  });
  request.on('end', () => {
    if (isRejected) {
      return;
    }
    onBody(Buffer.concat(chunks).toString('utf8'));
  });
}
