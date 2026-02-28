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
  "scripts": {
    "build": "tsc -b",
    "dev": "tsc -b --watch",
    "test": "vitest run"
  },
  "files": ["dist", "README.md", "SKILL.md"],
  "license": "MIT",
  "publishConfig": {
    "access": "public"
  },
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

# SKILL.md（参考 packages/core/SKILL.md：frontmatter + 最小正文）
cat > "$PKG_DIR/SKILL.md" <<SKILLEOF
---
name: $PKG_NAME
description: Code generation and contribution rules for $SCOPE/$PKG_NAME. Use when editing this package or when the user asks about $SCOPE/$PKG_NAME patterns or API.
---

# $SCOPE/$PKG_NAME

本文档是面向 AI 编码模型和人类开发者的 **代码生成规范**，阅读后应能正确地使用本库编写符合架构规则的代码。

---

## 1. 架构总览

（在此描述本模块的职责与核心抽象。）

---

## 2. 类型签名

（在此列出生成代码时必须遵循的类型定义。）

---

## 3. 代码生成模板与规则

（在此补充模板、强制规则与反模式。）
SKILLEOF

echo "✓ 已创建 packages/$PKG_NAME"
echo "  - packages/$PKG_NAME/package.json"
echo "  - packages/$PKG_NAME/tsconfig.json"
echo "  - packages/$PKG_NAME/src/index.ts"
echo "  - packages/$PKG_NAME/SKILL.md"
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
