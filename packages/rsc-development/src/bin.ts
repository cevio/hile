#!/usr/bin/env node
import { runRscDevelopmentCli } from './cli';
process.exitCode = await runRscDevelopmentCli(process.argv.slice(2));
