import { defineService } from '@hile/core';
import Redis, { RedisOptions } from 'ioredis';

/**
 * 创建 Redis 服务
 * 数据从环境变量中获取
 * 环境变量：
 * - REDIS_HOST: Redis 主机
 * - REDIS_PORT: Redis 端口
 * - REDIS_USERNAME: Redis 用户名
 * - REDIS_PASSWORD: Redis 密码
 * - REDIS_DB: Redis 数据库
 */
export default defineService(async (shutdown) => {
  const options: RedisOptions = {
    host: process.env.REDIS_HOST,
    port: typeof process.env.REDIS_PORT === 'string' ? Number(process.env.REDIS_PORT) : process.env.REDIS_PORT,
    username: process.env.REDIS_USERNAME,
    password: process.env.REDIS_PASSWORD,
    db: typeof process.env.REDIS_DB === 'string' ? Number(process.env.REDIS_DB) : process.env.REDIS_DB || 0,
  };

  const client = new Redis(options);
  await new Promise<void>((resolve, reject) => {
    const onerror = (e: any) => reject(e);
    client.on('error', onerror);
    client.on('connect', () => {
      client.off('error', onerror);
      resolve();
    })
  });

  shutdown(() => client.disconnect());

  return client;
});