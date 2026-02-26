# Hile

Hile monorepo，使用 pnpm workspaces + Lerna 管理。

## 项目结构

```
├── packages/
│   └── core/          # @hile/core - 轻量级异步服务容器
├── package.json       # 根配置（workspaces）
├── pnpm-workspace.yaml
├── lerna.json
└── tsconfig.json      # 基础 TypeScript 配置
```

## 开发

```bash
pnpm install
```

### 编译所有包

```bash
pnpm run build
```

### 编译单个包

```bash
pnpm --filter @hile/core build
```

### 运行所有测试

```bash
pnpm run test
```

### 运行单个包的测试

```bash
pnpm --filter @hile/core test
```

### 监听模式开发

```bash
pnpm --filter @hile/core dev
```

## 添加新包

1. 在 `packages/` 下创建新目录：

```bash
mkdir -p packages/new-pkg/src
```

2. 创建 `packages/new-pkg/package.json`：

```json
{
  "name": "@hile/new-pkg",
  "version": "1.0.0",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "scripts": {
    "build": "tsc -b",
    "dev": "tsc -b --watch",
    "test": "vitest run"
  },
  "files": ["dist"],
  "license": "MIT",
  "devDependencies": {
    "vitest": "^4.0.18"
  }
}
```

3. 创建 `packages/new-pkg/tsconfig.json`：

```json
{
  "extends": "../../tsconfig.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "include": ["src"],
  "exclude": ["node_modules", "dist", "src/**/*.test.ts"]
}
```

4. 创建源码 `packages/new-pkg/src/index.ts`

5. 安装依赖：

```bash
pnpm install
```

### 包间依赖

如果新包依赖 `@hile/core`：

```bash
pnpm --filter @hile/new-pkg add @hile/core --workspace
```

## 发布

### 发布所有有变更的包

```bash
pnpm run publish
```

Lerna 使用 `independent` 版本模式，各包独立管理版本号。执行后 Lerna 会：
1. 检测自上次发布以来有变更的包
2. 提示选择各包的新版本号
3. 更新 `package.json` 中的版本
4. 创建 git tag
5. 发布到 npm registry

### 发布前预览变更

```bash
npx lerna changed
```

### 指定版本发布

```bash
npx lerna publish patch   # 补丁版本
npx lerna publish minor   # 次版本
npx lerna publish major   # 主版本
```

## License

MIT
