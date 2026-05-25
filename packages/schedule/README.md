# @hile/schedule

Declarative job scheduler based on [node-schedule](https://github.com/node-schedule/node-schedule).

## Usage

### Code-defined jobs

```ts
import { Scheduler, defineJob } from '@hile/schedule'
import { second } from '@hile/schedule'

const scheduler = new Scheduler()

// Cron expression
scheduler.add('daily-report', '0 8 * * *', () => {
  console.log('generating daily report...')
})

// Delay (毫秒)
scheduler.add('delayed-task', { delay: 5000 }, () => {
  console.log('ran after 5 seconds')
})

scheduler.stop() // cancel all jobs
```

### Auto-load from directory

Create files with `{name}.schedule.ts`:

```ts
// tasks/daily-report.schedule.ts
import { defineJob } from '@hile/schedule'

export default defineJob('0 8 * * *', () => {
  console.log('daily report generated')
})
```

Load them:

```ts
const scheduler = new Scheduler()
const off = await scheduler.load(join(__dirname, 'tasks'))
// off() to unregister all loaded jobs
```

Custom suffix via `suffix` option:

```ts
await scheduler.load('./jobs', { suffix: 'job' })
// loads *.job.ts, *.job.js, etc.
```

### API

#### `defineJob(expression, handler)`

- `expression: string | { delay: number }` — cron 表达式或延迟毫秒数
- Returns `{ id: number, type: 'job', expression, handler }`

#### `scheduler.add(id, expression | { delay }, handler)`

- `id: string | number` — 任务唯一标识，重复添加抛异常

#### `scheduler.remove(id)`

#### `scheduler.stop()`

取消所有任务

#### `scheduler.getJobs(): JobInfo[]`

返回已注册任务列表

#### `scheduler.load(directory, options?)`

自动发现并注册任务文件，返回注销函数

## License

MIT
