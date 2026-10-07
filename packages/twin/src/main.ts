import { availableParallelism } from 'node:os';
import { fileURLToPath } from 'node:url';
import { runCli } from './cli.js';

const REFERENCE_DIR = fileURLToPath(new URL('../reference/', import.meta.url));
const RIVAL_PATH = fileURLToPath(import.meta.resolve('@tanks/bots/twin-rival.json'));

process.exitCode = await runCli(process.argv.slice(2), {
  print: (line) => {
    console.log(line);
  },
  referenceDir: REFERENCE_DIR,
  rivalPath: RIVAL_PATH,
  threads: availableParallelism(),
  now: () => performance.now(),
});
