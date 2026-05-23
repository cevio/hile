#!/usr/bin/env node

import { program } from 'commander';
import { CreateHileHttpNextProject } from './create.js';

program
  .version('1.0.0')
  .command('create <project-name>')
  .option('--skip-install', '跳过安装依赖')
  .description('创建新项目')
  .action(async (projectName, options: { skipInstall: boolean }) => {
    await CreateHileHttpNextProject(projectName, options);
  });

program.parseAsync(process.argv);
