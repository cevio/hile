import { dirname, relative, resolve } from 'node:path';
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import ora from 'ora';
import { ensureDir, copy } from 'fs-extra';
import { fileURLToPath } from 'node:url';
import Enquirer from 'enquirer';
import which from 'which';
import { spawn } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const __templates = resolve(__dirname, '../templates');

export const PROJECT_TEMPLATES = Object.freeze([
  { name: 'default', message: '默认模板' },
  { name: 'next', message: 'Next.js 模板' },
  { name: 'micro-http', message: 'Micro + HTTP 模板' },
  { name: 'micro', message: 'Micro 独立服务模板' },
  { name: 'micro-http-next', message: 'Next.js + Micro + HTTP 模板' },
  { name: 'rsc-host', message: '单端口 Next.js RSC 插件宿主' },
  { name: 'rsc-plugin', message: '无 HTTP 的 RSC 插件服务' },
  { name: 'monorepo', message: 'Monorepo 模板（Lerna + pnpm workspace）' },
]);

export function resolveProjectTarget(cwd: string, projectName: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(projectName) || projectName === '.' || projectName === '..') {
    throw new Error(`项目名称无效: ${projectName}`);
  }
  const target = resolve(cwd, projectName);
  if (dirname(target) !== resolve(cwd)) {
    throw new Error(`项目名称不能超出当前目录: ${projectName}`);
  }
  return target;
}

export async function createHileProject(projectName: string, options: {
  skipInstall: boolean;
  template?: string;
  install?: boolean;
}) {
  const cwd = process.cwd();
  const targetDir = resolveProjectTarget(cwd, projectName);

  if (existsSync(targetDir)) {
    throw new Error(`目录 ${projectName} 已存在`);
  }

  const selection = options.template
    ? {
        template: resolveTemplate(options.template),
        install: options.skipInstall ? false : (options.install ?? true),
      }
    : await choose(options.skipInstall);
  const { template, install } = selection;
  if (!template) {
    throw new Error('未选择模板');
  }

  const spinner = ora('正在创建项目...').start();
  try {
    await ensureDir(targetDir);
    await copy(template, targetDir);
    promoteUnderscoreDotfiles(targetDir);

    const packageJson = resolve(targetDir, 'package.json');
    const packageJsonContent = readFileSync(packageJson, 'utf-8');
    const packageJsonData = JSON.parse(packageJsonContent);
    packageJsonData.name = projectName;
    writeFileSync(packageJson, `${JSON.stringify(packageJsonData, null, 2)}\n`, 'utf-8');
  } catch (error) {
    rmSync(targetDir, { recursive: true, force: true });
    spinner.fail('创建项目失败');
    throw error;
  }

  if (install) {
    if (!(await commandExists('pnpm'))) {
      spinner.fail('未安装 pnpm');
      throw new Error('create-hile 需要 pnpm');
    }
    const command = 'pnpm';
    spinner.info(`正在安装依赖...`);
    const result = await runCommand(command, ['install'], targetDir);
    if (!result) {
      spinner.fail(`安装依赖失败，请在 ${relative(cwd, targetDir)} 中运行 ${command} install`);
      throw new Error('安装依赖失败');
    }
  }

  spinner.succeed('项目创建成功');
  console.log(`\n请在 ${relative(cwd, targetDir)} 目录下运行以下命令：\n`);
  console.log(`  $ cd ${projectName}`);
  if (!install) {
    console.log(`  $ pnpm install`);
  }
  console.log(`  $ pnpm run dev\n`);
}

function resolveTemplate(template: string): string {
  if (!PROJECT_TEMPLATES.some((item) => item.name === template)) {
    throw new Error(`未知模板: ${template}`);
  }
  return resolve(__templates, template);
}

async function choose(skipInstall: boolean) {
  const { template } = await Enquirer.prompt<{ template: string }>({
    type: 'select',
    name: 'template',
    message: '请选择模板',
    choices: [...PROJECT_TEMPLATES],
  });
  if (skipInstall) {
    return { template: resolve(__templates, template), install: false };
  }
  const { install } = await Enquirer.prompt<{ install: boolean }>({
    type: 'confirm',
    name: 'install',
    message: '是否安装依赖',
  });
  return { template: resolveTemplate(template), install };
}

/** 模板中用 `_env`、`_env.prod`、`_gitignore` 避免工具链忽略；拷贝到目标目录后还原为点文件 */
function promoteUnderscoreDotfiles(dir: string) {
  const renames: [string, string][] = [
    ['_env', '.env'],
    ['_env.prod', '.env.prod'],
    ['_gitignore', '.gitignore'],
  ];
  for (const [from, to] of renames) {
    const src = resolve(dir, from);
    const dest = resolve(dir, to);
    if (existsSync(src)) {
      renameSync(src, dest);
    }
  }
}

function commandExists(command: string) {
  return which(command).then(() => true).catch(() => false);
}

function runCommand(command: string, args: string[], cwd: string) {
  return new Promise<boolean>((resolve) => {
    const child = spawn(command, args, {
      cwd,
      stdio: 'ignore',
    });
    child.on('close', (code) => {
      resolve(code === 0);
    });
    child.on('error', () => resolve(false));
  });
}
