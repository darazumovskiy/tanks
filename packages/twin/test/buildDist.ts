import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const TSC = fileURLToPath(new URL('../../../node_modules/typescript/bin/tsc', import.meta.url));

// Потоки стенда исполняют собранный dist: без сборки перед тестами они проверяли бы прошлый код.
export default function setup(): void {
  execFileSync(process.execPath, [TSC, '-b', 'packages/twin'], { cwd: ROOT, stdio: 'inherit' });
}
