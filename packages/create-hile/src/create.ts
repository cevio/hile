import { dirname, relative, resolve } from 'node:path';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import ora from 'ora';
import { ensureDir, copy } from 'fs-extra';
import { fileURLToPath } from 'node:url';
import Enquirer from 'enquirer';
import which from 'which';
import { spawn } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const __templates = resolve(__dirname, '../templates');

export async function CreateHileHttpNextProject(projectName: string, options: {
  skipInstall: boolean
}) {
  const cwd = process.cwd();
  const targetDir = resolve(cwd, projectName);

  if (existsSync(targetDir)) {
    throw new Error(`目录 ${projectName} 已存在`);
  }

  const { template, install } = await choose(options.skipInstall);
  if (!template) {
    throw new Error('未选择模板');
  }

  const spinner = ora('正在创建项目...').start();
  await ensureDir(targetDir);
  await copy(template, targetDir);
  promoteUnderscoreDotfiles(targetDir);

  const packageJson = resolve(targetDir, 'package.json');
  const packageJsonContent = readFileSync(packageJson, 'utf-8');
  const packageJsonData = JSON.parse(packageJsonContent);
  packageJsonData.name = projectName;
  writeFileSync(packageJson, JSON.stringify(packageJsonData, null, 2), 'utf-8');

  if (install) {
    const [pnpmexists, yarnexists, npmexists] = await Promise.all([
      commandExists('pnpm'),
      commandExists('yarn'),
      commandExists('npm'),
    ]);
    if (!pnpmexists && !yarnexists && !npmexists) {
      return spinner.fail('未安装 pnpm、yarn 或 npm');
    }
    const command = pnpmexists ? 'pnpm' : yarnexists ? 'yarn' : npmexists ? 'npm' : null;
    spinner.info(`正在安装依赖...`);
    const result = await runCommand(command!, ['install'], targetDir);
    if (!result) {
      return spinner.fail('安装依赖失败，请手动安装！');
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

async function choose(skipInstall: boolean) {
  const templates = [
    { name: 'default', message: '默认模板' },
    { name: 'next', message: 'Next.js 模板' },
    { name: 'micro-http', message: 'Micro + HTTP 模板' },
    { name: 'micro', message: 'Micro 独立服务模板' },
    { name: 'micro-http-next', message: 'Next.js + Micro + HTTP 模板' },
  ];
  const { template } = await Enquirer.prompt<{ template: string }>({
    type: 'select',
    name: 'template',
    message: '请选择模板',
    choices: templates,
  });
  if (skipInstall) {
    return { template: resolve(__templates, template), install: false };
  }
  const { install } = await Enquirer.prompt<{ install: boolean }>({
    type: 'confirm',
    name: 'install',
    message: '是否安装依赖',
  });
  return { template: resolve(__templates, template), install };
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
  });
}
