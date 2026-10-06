import { availableParallelism } from 'node:os';
import { fileURLToPath } from 'node:url';
import { runCli } from './cli.js';

const REFERENCE_DIR = fileURLToPath(new URL('../reference/', import.meta.url));

process.exitCode = await runCli(process.argv.slice(2), {
  print: (line) => {
    console.log(line);
  },
  referenceDir: REFERENCE_DIR,
  threads: availableParallelism(),
  now: () => performance.now(),
});
