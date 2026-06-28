import { describe, expect, it, vi } from 'vitest';
import {
  MissingContextError,
  contextBindings,
  contextHttp,
  contextModel,
  getContext,
  hasContext,
  requireContext,
  requireContextModel,
  runWithContext,
  snapshotContext,
  withContextLogger,
} from './index';

type ShopContext = {
  shopId: string;
  memberId: string;
  channel: 'web' | 'wechat';
  featureFlag?: boolean;
  secret?: string;
};

describe('@hile/context core', () => {
  it('stores user-defined fields without requiring predefined business dimensions', async () => {
    await runWithContext<ShopContext>({
      shopId: 'shop-1',
      memberId: 'member-1',
      channel: 'wechat',
    }, async () => {
      await Promise.resolve();
      expect(getContext<ShopContext>()).toEqual({
        shopId: 'shop-1',
        memberId: 'member-1',
        channel: 'wechat',
      });
      expect(hasContext()).toBe(true);
    });

    expect(getContext<ShopContext>()).toEqual({});
    expect(hasContext()).toBe(false);
  });

  it('isolates concurrent async executions', async () => {
    const seen = await Promise.all([
      runWithContext<ShopContext>({ shopId: 'a', memberId: 'm1', channel: 'web' }, async () => {
        await new Promise(resolve => setTimeout(resolve, 10));
        return getContext<ShopContext>().shopId;
      }),
      runWithContext<ShopContext>({ shopId: 'b', memberId: 'm2', channel: 'wechat' }, async () => {
        await new Promise(resolve => setTimeout(resolve, 1));
        return getContext<ShopContext>().shopId;
      }),
    ]);

    expect(seen).toEqual(['a', 'b']);
  });

  it('merges nested context by default and restores the parent afterwards', async () => {
    await runWithContext<ShopContext>({ shopId: 'shop-1', memberId: 'member-1', channel: 'web' }, async () => {
      await runWithContext<ShopContext>({ channel: 'wechat' }, async () => {
        expect(getContext<ShopContext>()).toEqual({
          shopId: 'shop-1',
          memberId: 'member-1',
          channel: 'wechat',
        });
      });

      expect(getContext<ShopContext>()).toEqual({
        shopId: 'shop-1',
        memberId: 'member-1',
        channel: 'web',
      });
    });
  });

  it('can replace parent context when merge is disabled', async () => {
    await runWithContext<ShopContext>({ shopId: 'shop-1', memberId: 'member-1', channel: 'web' }, async () => {
      await runWithContext<ShopContext>({ channel: 'wechat' }, async () => {
        expect(getContext<ShopContext>()).toEqual({ channel: 'wechat' });
      }, { merge: false });
    });
  });

  it('returns readonly snapshots so callers cannot mutate the active store', async () => {
    await runWithContext<ShopContext>({ shopId: 'shop-1', memberId: 'member-1', channel: 'web' }, async () => {
      const snapshot = getContext<ShopContext>();
      expect(() => {
        (snapshot as Record<string, unknown>)['shopId'] = 'changed';
      }).toThrow(TypeError);
      expect(snapshotContext<ShopContext>()).toEqual({
        shopId: 'shop-1',
        memberId: 'member-1',
        channel: 'web',
      });
    });
  });

  it('requires only the fields selected by the application', async () => {
    await runWithContext<ShopContext>({ shopId: 'shop-1', memberId: 'member-1', channel: 'web' }, async () => {
      const context = requireContext<ShopContext>(['shopId', 'channel']);
      expect(context.shopId).toBe('shop-1');
      expect(context.channel).toBe('web');
    });

    await runWithContext<ShopContext>({ shopId: 'shop-1' }, async () => {
      expect(() => requireContext<ShopContext>(['shopId', 'memberId'])).toThrow(MissingContextError);
      try {
        requireContext<ShopContext>(['shopId', 'memberId']);
      } catch (err) {
        expect(err).toBeInstanceOf(MissingContextError);
        expect((err as MissingContextError).keys).toEqual(['memberId']);
      }
    });
  });
});

describe('@hile/context adapters', () => {
  it('builds HTTP middleware from caller-owned read and write mappings', async () => {
    const ctx = {
      requestHeaders: new Map([['x-shop', 'shop-1'], ['x-channel', 'wechat']]),
      responseHeaders: new Map<string, string>(),
      get(name: string) {
        return this.requestHeaders.get(name.toLowerCase());
      },
      set(name: string, value: string) {
        this.responseHeaders.set(name, value);
      },
    };

    const middleware = contextHttp<ShopContext, typeof ctx>({
      read: httpCtx => ({
        shopId: httpCtx.get('x-shop')!,
        channel: httpCtx.get('x-channel') as ShopContext['channel'],
      }),
      write: (context, httpCtx) => {
        httpCtx.set('x-current-shop', context.shopId ?? '');
      },
    });

    await middleware(ctx, async () => {
      expect(getContext<ShopContext>()).toMatchObject({
        shopId: 'shop-1',
        channel: 'wechat',
      });
    });

    expect(ctx.responseHeaders.get('x-current-shop')).toBe('shop-1');
  });

  it('does not mask the original HTTP middleware error when write also fails', async () => {
    const middleware = contextHttp<ShopContext, Record<string, never>>({
      read: () => ({ shopId: 'shop-1' }),
      write: () => {
        throw new Error('write failed');
      },
    });

    await expect(middleware({}, async () => {
      throw new Error('handler failed');
    })).rejects.toThrow('handler failed');
  });

  it('seeds model pipelines from caller-owned input mappings', async () => {
    const middleware = contextModel<{ store: string; source: 'web' | 'wechat' }, ShopContext>({
      read: input => ({
        shopId: input.store,
        channel: input.source,
      }),
    });

    await middleware({ args: { store: 'shop-1', source: 'web' }, state: {} }, async () => {
      expect(getContext<ShopContext>()).toMatchObject({
        shopId: 'shop-1',
        channel: 'web',
      });
    });
  });

  it('can enforce required context inside a model pipeline', async () => {
    const next = vi.fn();
    const middleware = requireContextModel<{ ok: boolean }, ShopContext>(['shopId']);

    await expect(middleware({ args: { ok: true }, state: {} }, next)).rejects.toThrow(MissingContextError);
    expect(next).not.toHaveBeenCalled();

    await runWithContext<ShopContext>({ shopId: 'shop-1' }, async () => {
      await middleware({ args: { ok: true }, state: {} }, next);
    });

    expect(next).toHaveBeenCalledOnce();
  });

  it('only exposes explicitly selected context fields to logger bindings', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const logger = {
      child(bindings: Record<string, unknown>) {
        return {
          info(data: Record<string, unknown>) {
            calls.push({ ...bindings, ...data });
          },
        };
      },
      info() {
        throw new Error('expected child logger to be used');
      },
    };

    const wrapped = withContextLogger<ShopContext, typeof logger>(logger, {
      pick: ['shopId', 'channel'],
    });

    await runWithContext<ShopContext>({
      shopId: 'shop-1',
      memberId: 'member-1',
      channel: 'wechat',
      secret: 'hidden',
    }, async () => {
      wrapped.info({ event: 'checkout' });
    });

    expect(calls).toEqual([{
      shopId: 'shop-1',
      channel: 'wechat',
      event: 'checkout',
    }]);
    expect(calls[0]).not.toHaveProperty('memberId');
    expect(calls[0]).not.toHaveProperty('secret');
  });

  it('does not create logger bindings until a picker or mapper is provided', async () => {
    await runWithContext<ShopContext>({ shopId: 'shop-1', memberId: 'member-1', channel: 'web' }, async () => {
      expect(contextBindings<ShopContext>()).toEqual({});
    });
  });
});
