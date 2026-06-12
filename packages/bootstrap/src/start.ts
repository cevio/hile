import { registerExitHook } from './exitHook.js';
import { glob } from 'glob';
import { resolve } from 'node:path';
import { container, formatServiceKey, isService, loadService, ServiceRegisterProps, ContainerEvent } from '@hile/core';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { existsSync } from 'node:fs';

const require = createRequire(import.meta.url);

/** 加载 env 文件到 process.env（Node 20.12+ 原生 process.loadEnvFile） */
function loadEnvFile(filePath: string): void {
  (process as NodeJS.Process & { loadEnvFile(path: string): void }).loadEnvFile(resolve(process.cwd(), filePath));
}

const TAG = '[hile]';
const AUTO_TAG = '[auto]:';

const c = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
};

const colorize = process.stdout.isTTY;

function createLogContainerEvent(logger?: { info: (msg: string) => void; error: (msg: string) => void }) {
  const log = logger ?? console;
  return function logContainerEvent(event: ContainerEvent) {
    const tag = colorize ? `${c.dim}${c.cyan}${TAG}${c.reset}` : TAG;
    const target = (s: string) => (colorize ? `${c.cyan}${s}${c.reset}` : s);
    const ok = (s: string) => (colorize ? `${c.green}${s}${c.reset}` : s);
    const warn = (s: string) => (colorize ? `${c.yellow}${s}${c.reset}` : s);
    const err = (s: string) => (colorize ? `${c.red}${s}${c.reset}` : s);
    const dim = (s: string) => (colorize ? `${c.dim}${s}${c.reset}` : s);

    switch (event.type) {
      case 'service:init':
        log.info(`${tag} ${target(`service(${formatServiceKey(event.key)})`)} ${dim('init')}`);
        break;
      case 'service:ready':
        log.info(`${tag} ${target(`service(${formatServiceKey(event.key)})`)} ${ok('ready')} ${dim(`(${event.durationMs}ms)`)}`);
        break;
      case 'service:error':
        log.error(`${tag} ${target(`service(${formatServiceKey(event.key)})`)} ${err('failed')} ${dim(`(${event.durationMs}ms)`)}`);
        log.error(event.error);
        break;
      case 'service:shutdown:start':
        log.info(`${tag} ${target(`service(${formatServiceKey(event.key)})`)} ${warn('stopping')}`);
        break;
      case 'service:shutdown:done':
        log.info(`${tag} ${target(`service(${formatServiceKey(event.key)})`)} ${dim('stopped')} ${dim(`(${event.durationMs}ms)`)}`);
        break;
      case 'service:shutdown:error':
        log.error(`${tag} ${target(`service(${formatServiceKey(event.key)})`)} ${err('shutdown error')}`);
        log.error(event.error);
        break;
      case 'container:shutdown:start':
        log.info(`${tag} ${target('container')} ${dim('shutdown start')}`);
        break;
      case 'container:shutdown:done':
        log.info(`${tag} ${target('container')} ${ok('shutdown done')} ${dim(`(${event.durationMs}ms)`)}`);
        break;
      case 'container:error':
        log.error(`${tag} ${target('container')} ${err('error')}`);
        log.error(event.error);
        break;
    }
  };
}

interface HilePackageJson {
  hile?: {
    auto_load_packages?: string[];
  };
}

export async function start(options: {
  dev: boolean,
  cwd?: string,
  envFile?: string[],
  silent?: boolean,
  autoLoadPackages?: string[],
  logger?: any,
}) {
  // 先加载 --env-file（与 Node --env-file 行为一致：先加载的优先，已存在的 key 不被覆盖）
  const envFiles = options.envFile ?? [];
  for (const p of envFiles) {
    loadEnvFile(p);
  }

  // 开发模式下，使用 tsx 运行
  if (options.dev) {
    // await import('tsx/esm');
    process.env.NODE_ENV = 'development';
  } else {
    process.env.NODE_ENV = 'production';
  }

  const offEvent = !options.silent && process.env.NODE_ENV === 'development'
    ? container.on(createLogContainerEvent(options.logger))
    : () => { };

  const cwd = options.cwd ?? process.cwd();
  const files: string[] = [];

  // 加载 package.json 文件
  // 如果 package.json 中存在 hile.auto_load_packages 属性，则加载该属性值中的所有服务
  // 该属性值中的每个元素必须是模块名称，不能是文件路径
  if (options.autoLoadPackages) {
    for (const p of options.autoLoadPackages) {
      files.push(AUTO_TAG + p);
    }
  } else {
    const pkg_path = resolve(cwd, 'package.json');
    if (existsSync(pkg_path)) {
      const packageJson: HilePackageJson = require(pkg_path);
      if (packageJson.hile?.auto_load_packages && Array.isArray(packageJson.hile.auto_load_packages)) {
        for (let i = 0; i < packageJson.hile.auto_load_packages.length; i++) {
          files.push(AUTO_TAG + packageJson.hile.auto_load_packages[i]);
        }
      }
    }
  }

  // 加载所有后缀为 boot.ts 或 boot.js 的服务
  const directory = resolve(cwd, options.dev ? 'src' : 'dist');
  const _files = await glob(`**/*.boot.{ts,js}`, { cwd: directory });
  files.push(..._files.map(file => resolve(directory, file)));

  // 加载所有自启动服务
  // file: 文件路径或者模块名称
  await Promise.all(files.map(async (file) => {
    const _file = file.startsWith(AUTO_TAG)
      ? file.substring(AUTO_TAG.length)
      : pathToFileURL(file).href;
    const target = options.dev && _file.endsWith('.ts')
      ? await (await import('tsx/esm/api')).tsImport(_file, import.meta.url)
      : await import(_file);
    const fn = target?.default ?? target;
    if (!fn || !isService(fn)) throw new Error(`invalid service file: ${file}`);
    await loadService(fn);
  }))

  // 如果没有服务要加载，则提示
  if (!files.length) {
    offEvent();
    return;
  }

  // 注册退出钩子，在进程退出时销毁所有服务
  registerExitHook(offEvent);
}