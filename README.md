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

使用脚手架脚本一键创建：

```bash
pnpm run create <包名>
```

例如创建一个 `utils` 包：

```bash
pnpm run create utils
```

脚本会自动完成以下步骤：
1. 创建 `packages/utils/` 目录和 `src/index.ts` 入口文件
2. 生成 `package.json`（包名为 `@hile/utils`，含 build/dev/test 脚本）
3. 生成 `tsconfig.json`（继承根配置）
4. 运行 `pnpm install` 安装依赖

创建完成后即可使用：

```bash
pnpm --filter @hile/utils build    # 编译
pnpm --filter @hile/utils test     # 测试
pnpm --filter @hile/utils dev      # 监听开发
```

### 包间依赖

如果新包依赖 `@hile/core`：

```bash
pnpm --filter @hile/utils add @hile/core --workspace
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
