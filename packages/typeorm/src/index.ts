import pkg from '../package.json' with { type: 'json' }
import { defineService } from '@hile/core';
import { DataSource, DataSourceOptions, QueryRunner } from 'typeorm';

export type { DataSourceOptions } from 'typeorm'

/**
 * 从环境变量读取 TypeORM 配置
 * 环境变量：
 * - TYPEORM_TYPE: 数据库类型
 * - TYPEORM_HOST: 数据库主机
 * - TYPEORM_USERNAME: 数据库用户名
 * - TYPEORM_PASSWORD: 数据库密码
 * - TYPEORM_DATABASE: 数据库名称
 * - TYPEORM_PORT: 数据库端口
 * - TYPEORM_CHARSET: 数据库字符集
 * - TYPEORM_ENTITY_PREFIX: 实体前缀
 * - TYPEORM_ENTITIES: 实体目录
 * - TYPEORM_SYNCHRONIZE: 是否同步数据库结构（环境变量值为字符串 "true" 时开启，否则关闭）
 */
function envOptions(): DataSourceOptions {
  return {
    // @ts-ignore
    type: process.env.TYPEORM_TYPE,
    host: process.env.TYPEORM_HOST,
    username: process.env.TYPEORM_USERNAME,
    password: process.env.TYPEORM_PASSWORD,
    database: process.env.TYPEORM_DATABASE,
    charset: process.env.TYPEORM_CHARSET,
    entityPrefix: process.env.TYPEORM_ENTITY_PREFIX,
    entities: process.env.TYPEORM_ENTITIES ? [process.env.TYPEORM_ENTITIES] : [],
    port: typeof process.env.TYPEORM_PORT === 'string'
      ? Number(process.env.TYPEORM_PORT)
      : process.env.TYPEORM_PORT,
    synchronize: process.env.TYPEORM_SYNCHRONIZE === 'true',
    logging: process.env.NODE_ENV === 'development',
  }
}

/**
 * 创建数据源（手动模式）
 * @param options TypeORM 连接选项，不传则从环境变量读取
 * @returns 等待初始化完成后的 DataSource 实例
 */
export async function createDataSource(options?: DataSourceOptions): Promise<DataSource> {
  const connection = new DataSource(options ?? envOptions())
  await connection.initialize()
  return connection
}

/**
 * 数据源服务（容器模式）
 */
export default defineService(Symbol.for(pkg.name), async (shutdown) => {
  const connection = await createDataSource()
  shutdown(() => connection.destroy())
  return connection
});

/**
 * 事务处理
 * @param datasource - 数据源
 * @param callback - 回调函数
 * @returns - 返回值
 */
export async function transaction<T>(datasource: DataSource, callback: (
  runner: QueryRunner,
  rollback: (roll: () => unknown | Promise<unknown>) => number
) => Promise<T>) {
  const rollbacks: (() => unknown | Promise<unknown>)[] = [];
  const runner = datasource.createQueryRunner();
  await runner.connect();
  await runner.startTransaction();
  const push = (roll: () => unknown | Promise<unknown>) => rollbacks.push(roll);
  try {
    const res = await callback(runner, push);
    await runner.commitTransaction();
    return res;
  } catch (e) {
    await runner.rollbackTransaction();
    let i = rollbacks.length;
    while (i--) await Promise.resolve(rollbacks[i]());
    throw e;
  } finally {
    await runner.release();
  }
}