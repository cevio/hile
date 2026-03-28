#!/usr/bin/env node

import pkg from '../package.json' with { type: 'json' };
import { program } from 'commander';
import { start } from './start.js';

program.version(pkg.version, '-v, --version', '当前版本号');

/**
 * 启动服务
 * 1. 加载所有后缀为 boot.ts 或 boot.js 的服务
 * 2. 注册退出钩子，在进程退出时销毁所有服务
 * 3. 如果 HILE_RUNTIME_DIR 环境变量存在，则使用该目录作为运行时目录，否则使用 src 或 dist 目录
 * 4. 如果 package.json 中存在 hile.auto_load_packages 属性，则加载该属性值中的所有服务
 * @param options - 选项
 * @param options.dev - 开发模式
 * @returns - 启动服务
 */
program
  .command('start')
  .option('-d, --dev', '开发模式', false)
  .option('-s, --silent', '静默模式', false)
  .option('-e, --env-file <path>', '加载指定 env 文件（兼容 Node --env-file 语义；可多次指定，先加载的不被后加载覆盖）', (v: string, acc: string[]) => (acc.push(v), acc), [] as string[])
  .description('启动服务，加载所有后缀为 boot.ts 或 boot.js 的服务，并注册退出钩子，在进程退出时销毁所有服务')
  .action((options: {
    dev: boolean;
    envFile?: string[],
    silent?: boolean
  }) => start({
    dev: options.dev,
    envFile: options.envFile,
    silent: options.silent
  }));

program.parseAsync(process.argv);

export * from './start.js';
