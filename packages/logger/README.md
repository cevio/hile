# @hile/logger

Structured logging based on [pino](https://getpino.io/).

## Usage

```ts
import { createLogger } from '@hile/logger'

const logger = createLogger()
logger.info('hello')
logger.error({ err }, 'something went wrong')
```

### Options

```ts
createLogger({
  level?: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal'
  pretty?: boolean      // default: !production
  redact?: string[]     // paths to redact, e.g. ['password', 'secret']
})
```

- **level** — 日志级别，默认 `LOG_LEVEL` 环境变量，未设置时 `'info'`
- **pretty** — 开发环境默认启用 `pino-pretty` 美化输出，生产环境输出 JSON
- **redact** — 敏感字段过滤，如 `['password', 'req.headers.authorization']`

### Child logger

```ts
const child = logger.child({ module: 'payment' })
child.info('processing') // { "module": "payment", "msg": "processing" }
```

### Service integration

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `LOG_LEVEL` | `'info'` | 默认日志级别 |
| `NODE_ENV` | — | 控制 `pretty` 默认值 |

## License

MIT
