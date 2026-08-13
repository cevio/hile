#!/usr/bin/env node

import { runRscCli } from './cli';

process.exitCode = await runRscCli(process.argv.slice(2), {
  stdout: (value) => process.stdout.write(value),
  stderr: (value) => process.stderr.write(value),
});
