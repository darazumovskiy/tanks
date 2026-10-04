import { runCli } from './cli.js';

process.exitCode = runCli(process.argv.slice(2), (line) => {
  console.log(line);
});
