#!/usr/bin/env node
import { runCli } from './cli.js';

process.exitCode = await runCli(process.argv.slice(2), {
  stdout: process.stdout,
  stderr: process.stderr,
  env: process.env,
  signals: process,
  forceExit: (code) => {
    process.exit(code);
  },
});
