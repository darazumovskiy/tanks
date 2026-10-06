import { fileURLToPath } from 'node:url';
import { runCli } from './cli.js';

const REFERENCE_DIR = fileURLToPath(new URL('../reference/', import.meta.url));

process.exitCode = runCli(
  process.argv.slice(2),
  (line) => {
    console.log(line);
  },
  REFERENCE_DIR,
);
