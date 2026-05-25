import { loadService } from '@hile/core';
import { transaction } from '@hile/typeorm';
import typeormService from '@hile/typeorm';
import redisService from '@hile/ioredis';

async function createUserWithLog(userData: Partial<User>) {
  const ds = await loadService(typeormService);
  const redis = await loadService(redisService);

  return transaction(ds, async (runner, rollback) => {
    // 1. 先插入用户
    const user = await runner.manager.save(User, userData);

    // 2. 注册补偿：事务失败时清除缓存中的用户数据
    rollback(async () => {
      await redis.del(`user:${user.id}`);
    });

    // 3. 再插入日志
    await runner.manager.save(Log, {
      action: 'create_user',
      userId: user.id,
      createdAt: new Date(),
    });

    return user;
  });
}
