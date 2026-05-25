import { defineService, loadService } from '@hile/core';
import { transaction } from '@hile/typeorm';
import typeormService from '@hile/typeorm';
import redisService from '@hile/ioredis';

export default defineService('user', async (shutdown) => {
  const ds = await loadService(typeormService);
  const redis = await loadService(redisService);

  return {
    async createUser(name: string) {
      return transaction(ds, async (runner, rollback) => {
        const user = await runner.manager.save(User, { name });

        rollback(async () => {
          await redis.del(`user:${user.id}`);
        });

        await runner.manager.save(Log, {
          action: 'create_user',
          userId: user.id,
          detail: `创建用户: ${name}`,
        });

        return user;
      });
    },
  };
});
