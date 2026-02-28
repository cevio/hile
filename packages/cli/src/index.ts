#!/usr/bin/env node

import pkg from '../package.json' with { type: 'json' };
import exitHook from 'async-exit-hook';
import { program } from 'commander';
import { glob } from 'glob';
import { resolve } from 'node:path';
import { container, isService, loadService, ServiceRegisterProps } from '@hile/core';

program.version(pkg.version, '-v, --version', '当前版本号');

/**
 * 启动服务
 * 1. 加载所有后缀为 boot.ts 或 boot.js 的服务
 * 2. 注册退出钩子，在进程退出时销毁所有服务
 * 3. 如果 HILE_RUNTIME_DIR 环境变量存在，则使用该目录作为运行时目录，否则使用 src 或 dist 目录
 * @param options - 选项
 * @param options.dev - 开发模式
 * @returns - 启动服务
 */
program
  .command('start')
  .option('-d, --dev', '开发模式', false)
  .description('启动服务，加载所有后缀为 boot.ts 或 boot.js 的服务，并注册退出钩子，在进程退出时销毁所有服务')
  .action(async (options: { dev: boolean }) => {
    // 开发模式下，使用 tsx 运行
    if (options.dev) await import('tsx/esm');

    // 加载所有后缀为 boot.ts 或 boot.js 的服务
    const directory = resolve(process.cwd(), process.env.HILE_RUNTIME_DIR || (options.dev ? 'src' : 'dist'));
    const files = await glob(`**/*.boot.{ts,js}`, { cwd: directory });

    // 加载所有自启动服务
    await Promise.all(files.map(async (file) => {
      const filepath = resolve(directory, file);
      const target: { default: ServiceRegisterProps<any> } = await import(filepath);
      const fn = target.default;
      if (!fn || !isService(fn)) throw new Error(`missing default export in ${file}`);
      if (!fn.id) throw new Error(`invalid service file: ${file}`);
      await loadService(fn);
    }))

    // 注册退出钩子，在进程退出时销毁所有服务
    exitHook(exit => {
      container.shutdown()
        .catch(e => console.error(e))
        .finally(exit);
    })
  })

program.parseAsync(process.argv);