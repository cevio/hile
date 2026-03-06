# @hile/http-rsc 实现详解

## 核心实现

### 1. 架构设计

```
┌─────────────────────────────────────────────────────────────┐
│                      浏览器请求                              │
└─────────────────────┬───────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────────┐
│                  @hile/http 路由系统                         │
│  - 文件系统路由 (*.controller.tsx)                           │
│  - 中间件链                                                  │
│  - 响应插件                                                  │
└─────────────────────┬───────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────────┐
│              RSC 中间件 (createRSCMiddleware)                │
│  1. Flight Middleware: 区分 SSR/RSC 请求                    │
│  2. Webpack Middleware: 开发模式实时编译                     │
└─────────────────────┬───────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────────┐
│                   控制器执行                                 │
│  - 返回 React 元素                                           │
│  - 可访问后端资源（数据库、服务等）                          │
└─────────────────────┬───────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────────┐
│              响应插件 (createRSCPlugin)                      │
│  - 检测是否为 React 元素                                     │
│  - ctx.rsc = true  → RSC Payload (流式)                     │
│  - ctx.rsc = false → SSR HTML (完整页面)                     │
└─────────────────────┬───────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────────┐
│                    客户端                                    │
│  1. 首次加载: 接收 SSR HTML + bundle.js                      │
│  2. Hydration: 从 __RSC_DATA__ 恢复状态                     │
│  3. 后续导航: fetch(/~/path) 获取 RSC payload               │
└─────────────────────────────────────────────────────────────┘
```

### 2. 关键组件

#### 2.1 Flight Middleware

负责区分 SSR 和 RSC 请求：

```typescript
const FlightMiddleware: Middleware = async (ctx, next) => {
  // 检查是否是 RSC 请求（以 /~ 开头）
  if (!ctx.path.startsWith(prefix)) {
    return await next() // 普通请求，走 SSR
  }
  
  // 重写 URL，去掉前缀
  const url = new URL(`${ctx.protocol}://${ctx.host}${ctx.url.substring(prefix.length)}`)
  ctx.url = url.pathname + url.search + url.hash
  
  // 标记为 RSC 请求
  ctx.rsc = true
  
  await next()
}
```

#### 2.2 Client Components Plugin

Webpack plugin，用于：
1. 扫描带有 `'use client'` 指令的文件
2. 收集这些模块的引用信息
3. 生成 module map 供 RSC 使用

```typescript
class ClientComponentsPlugin {
  apply(compiler) {
    // 在编译阶段扫描模块
    compilation.hooks.afterOptimizeModules.tap((modules) => {
      for (const module of modules) {
        if (hasUseClientDirective(module)) {
          // 记录 client component
          clientModules.set(resource, { id, chunks, name })
        }
      }
    })
    
    // 生成 module map
    compilation.hooks.processAssets.tap(() => {
      global.__RSC_MODULE_MAP__ = generateModuleMap()
    })
  }
}
```

#### 2.3 RSC 渲染

根据请求类型选择不同的渲染策略：

```typescript
// RSC 请求：流式返回 payload
function createRSCRender(ctx, result) {
  const moduleMap = getModuleMap()
  const { pipe } = renderToPipeableStream(result, moduleMap)
  ctx.type = 'text/x-component'
  pipe(ctx.res)
}

// SSR 请求：返回完整 HTML
async function createSSRRender(ctx, props, result) {
  const moduleMap = getModuleMap()
  
  // 渲染 RSC payload
  const { pipe } = renderToPipeableStream(result, moduleMap, {
    onShellReady() {
      // 收集 payload 并嵌入 HTML
      const rscPayload = collectPayload()
      
      const html = `
        <!doctype html>
        <html>
          <body>
            <div id="root"></div>
            <script id="__RSC_DATA__">${rscPayload}</script>
            <script src="/bundle.js"></script>
          </body>
        </html>
      `
      
      resolve(html)
    }
  })
}
```

#### 2.4 客户端 Hydration

```typescript
window.onload = () => {
  const container = document.getElementById('root')
  const ssrData = document.getElementById('__RSC_DATA__')
  
  if (ssrData) {
    // 使用 SSR 数据进行 hydration
    const payload = JSON.parse(ssrData.textContent)
    const stream = createStreamFromBase64(payload)
    const content = createFromReadableStream(stream)
    hydrateRoot(container, <Root content={content} />)
  } else {
    // 降级到客户端渲染
    const content = createFromReadableStream(
      fetch('/~' + location.pathname).then(r => r.body)
    )
    hydrateRoot(container, <Root content={content} />)
  }
}
```

### 3. 请求流程

#### 3.1 首次访问（SSR）

```
浏览器: GET /users
  ↓
@hile/http 路由匹配: /users
  ↓
Flight Middleware: ctx.rsc = false (无 /~ 前缀)
  ↓
执行控制器: users.controller.tsx
  ↓
返回 React 元素: <UserList users={data} />
  ↓
响应插件检测: isValidElement(result) = true
  ↓
SSR 渲染:
  - renderToPipeableStream(result, moduleMap)
  - 收集 RSC payload
  - 嵌入 HTML: <script id="__RSC_DATA__">...</script>
  ↓
返回完整 HTML
  ↓
浏览器:
  - 渲染 HTML
  - 加载 bundle.js
  - 执行 hydration
```

#### 3.2 客户端导航（RSC）

```
浏览器: fetch('/~/posts')
  ↓
@hile/http 路由匹配: /posts (URL 被重写)
  ↓
Flight Middleware: ctx.rsc = true (有 /~ 前缀)
  ↓
执行控制器: posts.controller.tsx
  ↓
返回 React 元素: <PostList posts={data} />
  ↓
响应插件检测: ctx.rsc = true
  ↓
RSC 渲染:
  - renderToPipeableStream(result, moduleMap)
  - 流式返回 RSC payload
  - Content-Type: text/x-component
  ↓
浏览器:
  - createFromReadableStream(response.body)
  - React 更新 UI（无需完整页面刷新）
```

### 4. Module Map 机制

Module map 用于告诉 RSC 如何引用 Client Components：

```typescript
{
  ssrModuleMapping: {
    '/path/to/button.tsx': {
      id: 'button-module-id',
      chunks: ['bundle.js'],
      name: '*'  // 导出所有
    }
  }
}
```

当 Server Component 引用 Client Component 时：

```typescript
// Server Component
import { Button } from '../client/button'  // 'use client'

export default defineController('GET', async () => {
  return <div><Button /></div>
})
```

RSC 渲染过程：
1. 检测到 `Button` 是 Client Component（通过 module map）
2. 不在服务端渲染 `Button` 的内容
3. 在 RSC payload 中插入引用：`{ $$typeof: Symbol.for('react.client.reference'), ... }`
4. 客户端接收 payload 后，从 bundle.js 加载实际的 `Button` 组件

### 5. 开发 vs 生产

#### 开发模式

```typescript
if (NODE_ENV === 'development') {
  // 启用 webpack-dev-middleware
  middlewares.push(createWebpackMiddleware())
  
  // 实时编译
  // - 监听文件变化
  // - 自动重新编译
  // - 热更新 module map
}
```

#### 生产模式

```bash
# 1. 预先构建客户端 bundle
webpack --mode production

# 2. 生成静态资源
# - bundle.[hash].js
# - vendors.[hash].js
# - module map (内存中)

# 3. 启动服务
NODE_ENV=production hile start

# 4. 服务静态文件
# - 通过 CDN 或静态文件服务器
# - 或使用 @hile/http 的静态文件中间件
```

### 6. 与 @hile/http 的集成

完全复用 `@hile/http` 的能力：

```typescript
// 1. 文件路由
await http.load('./controllers', { suffix: 'controller' })

// 2. 中间件
http.use(logger)
http.use(auth)
http.use(createRSCMiddleware())

// 3. 响应插件
defineResponsePlugin(wrapData)
defineResponsePlugin(createRSCPlugin())  // 自动注册

// 4. 路由参数
// controllers/users/[id].controller.tsx
export default defineController('GET', async (ctx) => {
  const userId = ctx.params.id  // 自动解析
  return <User id={userId} />
})
```

### 7. 性能优化

#### 7.1 流式渲染

RSC 天然支持流式渲染：

```typescript
renderToPipeableStream(result, moduleMap, {
  onShellReady() {
    // 立即发送 shell
    pipe(response)
  }
})

// 数据准备好后自动流式发送
```

#### 7.2 代码分割

```typescript
// webpack 配置
optimization: {
  splitChunks: {
    chunks: 'all',
    cacheGroups: {
      vendor: {
        test: /node_modules/,
        name: 'vendors',
      }
    }
  }
}
```

#### 7.3 缓存策略

```typescript
// 静态资源带 hash
output: {
  filename: 'bundle.[contenthash:8].js'
}

// HTTP 缓存头
ctx.set('Cache-Control', 'public, max-age=31536000, immutable')
```

## 总结

`@hile/http-rsc` 通过以下方式实现了 RSC：

1. **路由复用**：完全使用 `@hile/http` 的文件路由
2. **双重渲染**：SSR（首次）+ RSC（后续）
3. **Module Map**：通过 webpack plugin 自动生成
4. **流式传输**：利用 `renderToPipeableStream`
5. **轻量实现**：只依赖 React 官方的 `react-server-dom-webpack`

这是一个完全可控、轻量级的 RSC 实现，与 Hile 架构完美集成。
