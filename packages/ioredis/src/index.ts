import pkg from '../package.json' with { type: 'json' }
import { defineService } from '@hile/core';
import Redis, { RedisOptions } from 'ioredis';

export type { RedisOptions } from 'ioredis'

/**
 * 从环境变量读取 Redis 配置
 */
function envOptions(): RedisOptions {
  return {
    host: process.env.REDIS_HOST,
    port: typeof process.env.REDIS_PORT === 'string' ? Number(process.env.REDIS_PORT) : process.env.REDIS_PORT,
    username: process.env.REDIS_USERNAME,
    password: process.env.REDIS_PASSWORD,
    db: typeof process.env.REDIS_DB === 'string' ? Number(process.env.REDIS_DB) : process.env.REDIS_DB || 0,
  }
}

/**
 * 创建 Redis 客户端（手动模式）
 * @param options Redis 连接选项，不传则从环境变量读取
 * @returns 等待连接就绪后的 Redis 实例
 */
export async function createRedis(options?: RedisOptions): Promise<Redis> {
  const client = new Redis(options ?? envOptions())
  await new Promise<void>((resolve, reject) => {
    const onerror = (e: any) => reject(e)
    client.on('error', onerror)
    client.on('connect', () => {
      client.off('error', onerror)
      resolve()
    })
  })
  return client
}

/**
 * Redis 服务（容器模式）
 * 环境变量：
 * - REDIS_HOST
 * - REDIS_PORT
 * - REDIS_USERNAME
 * - REDIS_PASSWORD
 * - REDIS_DB
 */
export default defineService(Symbol.for(pkg.name), async (shutdown) => {
  const client = await createRedis()
  shutdown(() => client.disconnect())
  return client
})