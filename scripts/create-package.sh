#!/usr/bin/env bash
set -euo pipefail

SCOPE="@hile"
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PACKAGES_DIR="$ROOT_DIR/packages"

if [ -z "${1:-}" ]; then
  echo "用法: pnpm run create <包名>"
  echo "示例: pnpm run create utils"
  echo "      将创建 packages/utils 作为 $SCOPE/utils"
  exit 1
fi

PKG_NAME="$1"
PKG_DIR="$PACKAGES_DIR/$PKG_NAME"

if [ -d "$PKG_DIR" ]; then
  echo "错误: packages/$PKG_NAME 已存在"
  exit 1
fi

echo "正在创建 $SCOPE/$PKG_NAME ..."

mkdir -p "$PKG_DIR/src"

cat > "$PKG_DIR/package.json" <<EOF
{
  "name": "$SCOPE/$PKG_NAME",
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
EOF

cat > "$PKG_DIR/tsconfig.json" <<EOF
{
  "extends": "../../tsconfig.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "include": ["src"],
  "exclude": ["node_modules", "dist", "src/**/*.test.ts"]
}
EOF

cat > "$PKG_DIR/src/index.ts" <<EOF
export {}
EOF

echo "✓ 已创建 packages/$PKG_NAME"
echo "  - packages/$PKG_NAME/package.json"
echo "  - packages/$PKG_NAME/tsconfig.json"
echo "  - packages/$PKG_NAME/src/index.ts"
echo ""
echo "正在安装依赖 ..."

cd "$ROOT_DIR" && pnpm install --no-frozen-lockfile

echo ""
echo "✓ $SCOPE/$PKG_NAME 创建完成！"
echo ""
echo "常用命令:"
echo "  pnpm --filter $SCOPE/$PKG_NAME build    # 编译"
echo "  pnpm --filter $SCOPE/$PKG_NAME test     # 测试"
echo "  pnpm --filter $SCOPE/$PKG_NAME dev      # 监听开发"
