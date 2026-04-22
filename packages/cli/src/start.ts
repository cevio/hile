import { registerExitHook } from './exitHook.js';
import { glob } from 'glob';
import { resolve } from 'node:path';
import { container, formatServiceKey, isService, loadService, ServiceRegisterProps, ContainerEvent } from '@hile/core';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

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

function logContainerEvent(event: ContainerEvent) {
  const tag = colorize ? `${c.dim}${c.cyan}${TAG}${c.reset}` : TAG;
  const target = (s: string) => (colorize ? `${c.cyan}${s}${c.reset}` : s);
  const ok = (s: string) => (colorize ? `${c.green}${s}${c.reset}` : s);
  const warn = (s: string) => (colorize ? `${c.yellow}${s}${c.reset}` : s);
  const err = (s: string) => (colorize ? `${c.red}${s}${c.reset}` : s);
  const dim = (s: string) => (colorize ? `${c.dim}${s}${c.reset}` : s);

  switch (event.type) {
    case 'service:init':
      console.info(`${tag} ${target(`service(${formatServiceKey(event.key)})`)} ${dim('init')}`);
      break;
    case 'service:ready':
      console.info(`${tag} ${target(`service(${formatServiceKey(event.key)})`)} ${ok('ready')} ${dim(`(${event.durationMs}ms)`)}`);
      break;
    case 'service:error':
      console.error(`${tag} ${target(`service(${formatServiceKey(event.key)})`)} ${err('failed')} ${dim(`(${event.durationMs}ms)`)}`);
      console.error(event.error);
      break;
    case 'service:shutdown:start':
      console.info(`${tag} ${target(`service(${formatServiceKey(event.key)})`)} ${warn('stopping')}`);
      break;
    case 'service:shutdown:done':
      console.info(`${tag} ${target(`service(${formatServiceKey(event.key)})`)} ${dim('stopped')} ${dim(`(${event.durationMs}ms)`)}`);
      break;
    case 'service:shutdown:error':
      console.error(`${tag} ${target(`service(${formatServiceKey(event.key)})`)} ${err('shutdown error')}`);
      console.error(event.error);
      break;
    case 'container:shutdown:start':
      console.info(`${tag} ${target('container')} ${dim('shutdown start')}`);
      break;
    case 'container:shutdown:done':
      console.info(`${tag} ${target('container')} ${ok('shutdown done')} ${dim(`(${event.durationMs}ms)`)}`);
      break;
    case 'container:error':
      console.error(`${tag} ${target('container')} ${err('error')}`);
      console.error(event.error);
      break;
  }
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
  autoLoadPackages?: string[]
}) {
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

  const offEvent = !options.silent && process.env.NODE_ENV === 'development'
    ? container.on(logContainerEvent)
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
    const packageJson: HilePackageJson = require(resolve(cwd, 'package.json'));
    if (packageJson.hile?.auto_load_packages && Array.isArray(packageJson.hile.auto_load_packages)) {
      for (let i = 0; i < packageJson.hile.auto_load_packages.length; i++) {
        files.push(AUTO_TAG + packageJson.hile.auto_load_packages[i]);
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
    const target: { default: ServiceRegisterProps<any> } = await import(_file);
    const fn = target?.default ?? target;
    if (!fn || !isService(fn)) throw new Error(`invalid service file: ${file}`);
    await loadService(fn);
    if (!options.silent) {
      console.info(`+ [bootstrap] ${file}`);
    }
  }))

  // 如果没有服务要加载，则提示
  if (!files.length) {
    console.warn('no services to load');
    offEvent();
    return;
  }

  // 注册退出钩子，在进程退出时销毁所有服务
  registerExitHook(offEvent);
}