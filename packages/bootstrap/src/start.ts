import { registerExitHook } from './exitHook.js';
import { glob } from 'glob';
import { resolve } from 'node:path';
import { container, formatServiceKey, isService, loadService, ContainerEvent, type ServiceKey } from '@hile/core';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { existsSync } from 'node:fs';
import { createLogger, type Logger } from '@hile/logger';

const require = createRequire(import.meta.url);

/** 加载 env 文件到 process.env（Node 20.12+ 原生 process.loadEnvFile） */
function loadEnvFile(filePath: string): void {
  (process as NodeJS.Process & { loadEnvFile(path: string): void }).loadEnvFile(resolve(process.cwd(), filePath));
}

const TAG = '[hile]';
const AUTO_TAG = '[auto]:';

function createLogContainerEvent(logger: Logger) {
  const service = (key: ServiceKey) => `service(${formatServiceKey(key)})`;

  return function logContainerEvent(event: ContainerEvent) {
    switch (event.type) {
      case 'service:init':
        logger.info(`${TAG} ${service(event.key)} init`);
        break;
      case 'service:ready':
        logger.info(`${TAG} ${service(event.key)} ready (${event.durationMs}ms)`);
        break;
      case 'service:error':
        logger.error({ err: event.error }, `${TAG} ${service(event.key)} failed (${event.durationMs}ms)`);
        break;
      case 'service:shutdown:start':
        logger.info(`${TAG} ${service(event.key)} stopping`);
        break;
      case 'service:shutdown:done':
        logger.info(`${TAG} ${service(event.key)} stopped (${event.durationMs}ms)`);
        break;
      case 'service:shutdown:error':
        logger.error({ err: event.error }, `${TAG} ${service(event.key)} shutdown error`);
        break;
      case 'container:shutdown:start':
        logger.info(`${TAG} container shutdown start`);
        break;
      case 'container:shutdown:done':
        logger.info(`${TAG} container shutdown done (${event.durationMs}ms)`);
        break;
      case 'container:error':
        logger.error({ err: event.error }, `${TAG} container error`);
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

  const { logger, teardown } = createLogger({
    pretty: options.dev,
    level: options.dev ? 'debug' : 'info',
  })

  const offEvent = !options.silent && process.env.NODE_ENV === 'development'
    ? container.on(createLogContainerEvent(logger))
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

  // 注册退出钩子：先 shutdown 服务，再取消事件监听并关闭 logger stream，最后 exit
  registerExitHook(() => {
    offEvent();
    teardown();
  });
}