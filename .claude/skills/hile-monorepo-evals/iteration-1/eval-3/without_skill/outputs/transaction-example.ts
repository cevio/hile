import { loadService } from '@hile/core';
import typeormService, { transaction } from '@hile/typeorm';
import redisService from '@hile/ioredis';

async function createUserWithLog(name: string, email: string) {
  const ds = await loadService(typeormService);
  const redis = await loadService(redisService);

  return transaction(ds, async (runner, rollback) => {
    const user = await runner.manager.save(User, { name, email });

    rollback(async () => {
      await redis.del(`user:${user.id}`);
    });

    await runner.manager.save(Log, {
      action: 'create_user',
      userId: user.id,
    });

    return user;
  });
}
