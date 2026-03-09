#!/usr/bin/env node

import { program } from 'commander';
import { CreateHileHttpNextProject } from './create.js';

program
  .version('1.0.0')
  .command('create <project-name>')
  .description('创建新项目')
  .action((projectName) => CreateHileHttpNextProject(projectName));

program.parseAsync(process.argv);