#!/usr/bin/env node

import { program } from 'commander';
import { readFileSync } from 'node:fs';
import { createHileProject } from './create.js';

const packageJson = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as { version: string };

program
  .version(packageJson.version)
  .command('create <project-name>')
  .option('--skip-install', '跳过安装依赖')
  .description('创建新项目')
  .action(async (projectName, options: { skipInstall: boolean }) => {
    await createHileProject(projectName, options);
  });

program.parseAsync(process.argv);
