#!/usr/bin/env node

import pkg from '../package.json' with { type: 'json' };
import exitHook from 'async-exit-hook';
import { program } from 'commander';
import { glob } from 'glob';
import { resolve } from 'node:path';
import { container, isService, loadService, ServiceRegisterProps, ContainerEvent } from '@hile/core';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/** 加载 env 文件到 process.env（Node 20.12+ 原生 process.loadEnvFile） */
function loadEnvFile(filePath: string): void {
  (process as NodeJS.Process & { loadEnvFile(path: string): void }).loadEnvFile(resolve(process.cwd(), filePath));
}

function logContainerEvent(event: ContainerEvent) {
  switch (event.type) {
    case 'service:init':
      console.info(`[hile] service#${event.id} init`);
      break;
    case 'service:ready':
      console.info(`[hile] service#${event.id} ready (${event.durationMs}ms)`);
      break;
    case 'service:error':
      console.error(`[hile] service#${event.id} failed (${event.durationMs}ms):`, event.error);
      break;
    case 'service:shutdown:start':
      console.info(`[hile] service#${event.id} stopping`);
      break;
    case 'service:shutdown:done':
      console.info(`[hile] service#${event.id} stopped (${event.durationMs}ms)`);
      break;
    case 'service:shutdown:error':
      console.error(`[hile] service#${event.id} shutdown error:`, event.error);
      break;
    case 'container:shutdown:start':
      console.info('[hile] container shutdown start');
      break;
    case 'container:shutdown:done':
      console.info(`[hile] container shutdown done (${event.durationMs}ms)`);
      break;
    case 'container:error':
      console.error('[hile] container error:', event.error);
      break;
  }
}

interface HilePackageJson {
  hile?: {
    auto_load_packages?: string[];
  };
}

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
  .option('-e, --env-file <path>', '加载指定 env 文件（兼容 Node --env-file 语义；可多次指定，先加载的不被后加载覆盖）', (v: string, acc: string[]) => (acc.push(v), acc), [] as string[])
  .description('启动服务，加载所有后缀为 boot.ts 或 boot.js 的服务，并注册退出钩子，在进程退出时销毁所有服务')
  .action(async (options: { dev: boolean; envFile?: string[] }) => {
    const offEvent = container.onEvent(logContainerEvent);

    // 先加载 --env-file（与 Node --env-file 行为一致：先加载的优先，已存在的 key 不被覆盖）
    const envFiles = options.envFile ?? [];
    for (const p of envFiles) {
      loadEnvFile(p);
    }

    // 开发模式下，使用 tsx 运行
    if (options.dev) {
      await import('tsx/esm');
      process.env.NODE_ENV = 'development';
    } else {
      process.env.NODE_ENV = 'production';
    }

    const cwd = process.cwd();
    const files: string[] = [];

    // 加载 package.json 文件
    // 如果 package.json 中存在 hile.auto_load_packages 属性，则加载该属性值中的所有服务
    // 该属性值中的每个元素必须是模块名称，不能是文件路径
    const packageJson: HilePackageJson = require(resolve(cwd, 'package.json'));
    if (packageJson.hile?.auto_load_packages && Array.isArray(packageJson.hile.auto_load_packages)) {
      for (let i = 0; i < packageJson.hile.auto_load_packages.length; i++) {
        files.push(packageJson.hile.auto_load_packages[i]);
      }
    }

    // 加载所有后缀为 boot.ts 或 boot.js 的服务
    const directory = resolve(cwd, process.env.HILE_RUNTIME_DIR || (options.dev ? 'src' : 'dist'));
    const _files = await glob(`**/*.boot.{ts,js}`, { cwd: directory });
    files.push(..._files.map(file => resolve(directory, file)));

    // 加载所有自启动服务
    // file: 文件路径或者模块名称
    await Promise.all(files.map(async (file) => {
      const target: { default: ServiceRegisterProps<any> } = await import(file);
      const fn = target?.default ?? target;
      if (!fn || !isService(fn)) throw new Error(`invalid service file: ${file}`);
      await loadService(fn);
    }))

    // 如果没有服务要加载，则提示
    if (!files.length) {
      console.warn('no services to load');
      offEvent();
      return;
    }

    // 注册退出钩子，在进程退出时销毁所有服务
    exitHook(exit => {
      container.shutdown()
        .catch(e => console.error(e))
        .finally(() => {
          offEvent();
          exit();
        });
    })
  })

program.parseAsync(process.argv);
