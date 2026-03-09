import { dirname, relative, resolve } from 'node:path';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import ora from 'ora';
import { ensureDir, copy } from 'fs-extra';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export async function CreateHileHttpNextProject(projectName: string) {
  const cwd = '/Users/evioshen/code/pulian/shenyunjie/artuctor/test';
  const targetDir = resolve(cwd, projectName);

  if (existsSync(targetDir)) {
    throw new Error(`目录 ${projectName} 已存在`);
  }

  const spinner = ora('正在创建项目...').start();
  await ensureDir(targetDir);

  const templateDir = resolve(__dirname, '../template');
  await copy(templateDir, targetDir);

  const packageJson = resolve(targetDir, 'package.json');
  const packageJsonContent = readFileSync(packageJson, 'utf-8');
  const packageJsonData = JSON.parse(packageJsonContent);
  packageJsonData.name = projectName;
  writeFileSync(packageJson, JSON.stringify(packageJsonData, null, 2), 'utf-8');

  spinner.succeed('项目创建成功');
  console.log(`请在 ${relative(cwd, targetDir)} 目录下运行以下命令：`);
  console.log(`$ cd ${projectName}`);
  console.log(`$ pnpm install`);
  console.log(`$ pnpm run dev`);
}