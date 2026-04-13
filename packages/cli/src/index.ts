#!/usr/bin/env node

import pkg from '../package.json' with { type: 'json' };
import { program } from 'commander';
import { start } from './start.js';
import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';

type NodeRequire = ReturnType<typeof createRequire>;

const requireCli = createRequire(import.meta.url);

/** 从包入口文件路径向上找到 `package.json` 的 `name` 与 `packageName` 一致的目录 */
function packageDirFromResolvedMain(resolvedMain: string, packageName: string): string {
  let dir = dirname(resolvedMain);
  for (let depth = 0; depth < 50; depth++) {
    const parent = dirname(dir);
    const pkgPath = join(dir, 'package.json');
    if (existsSync(pkgPath)) {
      try {
        const { name: n } = JSON.parse(readFileSync(pkgPath, 'utf8')) as { name?: string };
        if (n === packageName) return dir;
      } catch {
        /* 忽略损坏的 package.json */
      }
    }
    if (dir === parent) break;
    dir = parent;
  }
  return dirname(resolvedMain);
}

function tryResolvePackageDir(packageName: string, req: NodeRequire): string | undefined {
  try {
    const main = req.resolve(packageName);
    return packageDirFromResolvedMain(main, packageName);
  } catch {
    return undefined;
  }
}

/** 全局 `npm install -g` 下的包根目录（存在 package.json 时） */
function tryGlobalPackageDir(packageName: string): string | undefined {
  try {
    const root = execSync('npm root -g', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).trim();
    let candidate: string;
    if (packageName.startsWith('@')) {
      const slash = packageName.indexOf('/');
      if (slash <= 0) return undefined;
      candidate = join(root, packageName.slice(0, slash), packageName.slice(slash + 1));
    } else {
      candidate = join(root, packageName);
    }
    return existsSync(join(candidate, 'package.json')) ? candidate : undefined;
  } catch {
    return undefined;
  }
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
  .command('start [name]')
  .option('-d, --dev', '开发模式', false)
  .option('-s, --silent', '静默模式', false)
  .option('-e, --env-file <path>', '加载指定 env 文件（兼容 Node --env-file 语义；可多次指定，先加载的不被后加载覆盖）', (v: string, acc: string[]) => (acc.push(v), acc), [] as string[])
  .description('启动服务，加载所有后缀为 boot.ts 或 boot.js 的服务，并注册退出钩子，在进程退出时销毁所有服务')
  .action((name: string, options: {
    dev: boolean;
    envFile?: string[],
    silent?: boolean
  }) => {
    let directory: string | undefined = process.cwd();
    if (name) {
      const filePath = resolve(directory, name);
      if (existsSync(filePath)) {
        directory = filePath;
      } else {
        const cwdPkg = resolve(directory, 'package.json');
        if (existsSync(cwdPkg)) {
          directory = tryResolvePackageDir(name, createRequire(cwdPkg));
        }
        if (!directory) {
          directory = tryResolvePackageDir(name, requireCli);
        }
        if (!directory) {
          directory = tryGlobalPackageDir(name);
        }
      }
    }

    if (!directory) {
      console.error('package not found');
      return;
    }

    return start({
      dev: options.dev,
      cwd: directory,
      envFile: options.envFile,
      silent: options.silent
    })
  });

program.parseAsync(process.argv);

export * from './start.js';
